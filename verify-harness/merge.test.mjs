// Unit test for the desktop⇄web comment-thread three-way merge
// (src/htmlComments.ts mergeHtmlThreads) — the correctness core of pool sync,
// exercised here against the interleavings that make it subtle: deletions
// must stick (not resurrect), and an entry whose worker-stamped `eid` arrives
// on one side but not the other must dedupe to a single copy. Run:
//
//   node verify-harness/merge.test.mjs
//
// (Compiles the pure module through vite — a declared dependency — so no
// separate frontend test runner is needed, mirroring scripts/bundle-worker.)
import { build } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    target: "es2022",
    lib: { entry: path.join(repoRoot, "src", "htmlComments.ts"), formats: ["es"], fileName: "hc" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const mod = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
const { mergeHtmlThreads } = mod;

const anc = { path: "p", tag: "p", text: "x" };
const e = (author, at, body, extra = {}) => ({ author, at, body, ...extra });
const t = (id, comments) => ({ id, anchor: anc, comments });

let n = 0;
const ok = (name) => {
  n += 1;
  console.log("PASS", name);
};

// 1. Web adds a thread, local unchanged → the web thread lands locally.
{
  const base = [t("a", [e("Me", 1, "hi")])];
  const local = [t("a", [e("Me", 1, "hi")])];
  const web = [t("a", [e("Me", 1, "hi")]), t("b", [e("Web", 2, "new", { eid: "e-1" })])];
  const m = mergeHtmlThreads(base, local, web);
  assert.deepEqual(m.map((x) => x.id), ["a", "b"]);
  ok("web addition lands locally");
}

// 2. Local deletes a thread still present in web → the deletion sticks.
{
  const base = [t("a", [e("Me", 1, "hi")]), t("b", [e("W", 2, "x", { eid: "e-2" })])];
  const local = [t("a", [e("Me", 1, "hi")])];
  const web = [t("a", [e("Me", 1, "hi")]), t("b", [e("W", 2, "x", { eid: "e-2" })])];
  const m = mergeHtmlThreads(base, local, web);
  assert.deepEqual(m.map((x) => x.id), ["a"], "b stays deleted, not resurrected");
  ok("local deletion sticks against unchanged web");
}

// 3. Web deletes an entry local hasn't touched → the entry is removed.
{
  const base = [t("a", [e("Me", 1, "op"), e("W", 2, "reply", { eid: "e-3" })])];
  const local = [t("a", [e("Me", 1, "op"), e("W", 2, "reply", { eid: "e-3" })])];
  const web = [t("a", [e("Me", 1, "op")])];
  const m = mergeHtmlThreads(base, local, web);
  assert.equal(m[0].comments.length, 1, "web-deleted reply removed");
  ok("web entry deletion sticks");
}

// 4. eid identity migration: the same entry is unstamped locally but stamped
//    in the pool → ONE entry (the stamped copy), never a duplicate.
{
  const local = [t("a", [e("Me", 5, "draft")])];
  const web = [t("a", [e("Me", 5, "draft", { eid: "e-9", codeId: "a-1" })])];
  const m = mergeHtmlThreads([], local, web);
  assert.equal(m.length, 1);
  assert.equal(m[0].comments.length, 1, "not duplicated across the provenance stamp");
  assert.equal(m[0].comments[0].eid, "e-9", "keeps the stamped copy");
  ok("eid-stamped pool copy dedupes against unstamped local");
}

// 5. Both sides add a different reply to one thread → both survive.
{
  const base = [t("a", [e("Me", 1, "op", { eid: "e-op" })])];
  const local = [t("a", [e("Me", 1, "op", { eid: "e-op" }), e("Me", 2, "mine")])];
  const web = [t("a", [e("Me", 1, "op", { eid: "e-op" }), e("W", 3, "theirs", { eid: "e-w" })])];
  const m = mergeHtmlThreads(base, local, web);
  assert.equal(m[0].comments.length, 3, "both concurrent replies kept");
  ok("concurrent replies both survive");
}

// 6. Local edits a body web hasn't touched → the local edit wins.
{
  const base = [t("a", [e("Me", 1, "old", { eid: "e-b" })])];
  const local = [t("a", [e("Me", 1, "edited", { eid: "e-b" })])];
  const web = [t("a", [e("Me", 1, "old", { eid: "e-b" })])];
  const m = mergeHtmlThreads(base, local, web);
  assert.equal(m[0].comments[0].body, "edited");
  ok("local body edit wins over unchanged web");
}

console.log(`\n${n}/6 merge cases passed`);
