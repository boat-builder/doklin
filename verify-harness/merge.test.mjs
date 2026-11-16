// Unit test for the comment-thread three-way merge (src/htmlComments.ts
// mergeHtmlThreads) — how the live rail and a meta file changed from outside
// (another device's edit landing) fold together — exercised here against the
// interleavings that make it subtle: deletions must stick (not resurrect),
// and additions on either side land on both. Run:
//
//   node verify-harness/merge.test.mjs
//
// (Compiles the pure module through vite — a declared dependency — so no
// separate frontend test runner is needed.)
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
const e = (author, at, body) => ({ author, at, body });
const t = (id, comments) => ({ id, anchor: anc, comments });

let n = 0;
const ok = (name) => {
  n += 1;
  console.log("PASS", name);
};

// 1. Theirs adds a thread, local unchanged → their thread lands locally.
{
  const base = [t("a", [e("Me", 1, "hi")])];
  const local = [t("a", [e("Me", 1, "hi")])];
  const theirs = [t("a", [e("Me", 1, "hi")]), t("b", [e("They", 2, "new")])];
  const m = mergeHtmlThreads(base, local, theirs);
  assert.deepEqual(m.map((x) => x.id), ["a", "b"]);
  ok("their addition lands locally");
}

// 2. Local deletes a thread still present on their side → the deletion sticks.
{
  const base = [t("a", [e("Me", 1, "hi")]), t("b", [e("W", 2, "x")])];
  const local = [t("a", [e("Me", 1, "hi")])];
  const theirs = [t("a", [e("Me", 1, "hi")]), t("b", [e("W", 2, "x")])];
  const m = mergeHtmlThreads(base, local, theirs);
  assert.deepEqual(m.map((x) => x.id), ["a"], "b stays deleted, not resurrected");
  ok("local deletion sticks against an unchanged other side");
}

// 3. Theirs deletes an entry local hasn't touched → the entry is removed.
{
  const base = [t("a", [e("Me", 1, "op"), e("W", 2, "reply")])];
  const local = [t("a", [e("Me", 1, "op"), e("W", 2, "reply")])];
  const theirs = [t("a", [e("Me", 1, "op")])];
  const m = mergeHtmlThreads(base, local, theirs);
  assert.equal(m[0].comments.length, 1, "their deleted reply removed");
  ok("their entry deletion sticks");
}

// 4. Both sides add a different reply to one thread → both survive.
{
  const base = [t("a", [e("Me", 1, "op")])];
  const local = [t("a", [e("Me", 1, "op"), e("Me", 2, "mine")])];
  const theirs = [t("a", [e("Me", 1, "op"), e("W", 3, "theirs")])];
  const m = mergeHtmlThreads(base, local, theirs);
  assert.equal(m[0].comments.length, 3, "both concurrent replies kept");
  ok("concurrent replies both survive");
}

// 5. Local edits a body their side hasn't touched → the local edit wins.
{
  const base = [t("a", [e("Me", 1, "old")])];
  const local = [t("a", [e("Me", 1, "edited")])];
  const theirs = [t("a", [e("Me", 1, "old")])];
  const m = mergeHtmlThreads(base, local, theirs);
  assert.equal(m[0].comments[0].body, "edited");
  ok("local body edit wins over an unchanged other side");
}

console.log(`\n${n}/5 merge cases passed`);
