// Unit tests for the entity meta file (src/metaFile.ts) — the disk⇄editor
// boundary of the hybrid comment layout: extract (full CriticMarkup → bare
// markers + records), expand (markers + records → full), the tolerant
// parse/serialize pair. Run:
//
//   node verify-harness/metafile.test.mjs
//
// (Compiles the module through vite, mirroring merge.test.mjs.)
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
    lib: { entry: path.join(repoRoot, "src", "metaFile.ts"), formats: ["es"], fileName: "mf" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const mod = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
const {
  parseEntityMeta,
  serializeEntityMeta,
  expandMarkdown,
  extractMarkdown,
  metaFileOf,
  stemOf,
  metaIsEmpty,
  emptyMeta,
  sidecarWhileWriting,
} = mod;

const entry = (author, at, body, extra = {}) => ({ author, at, body, ...extra });

/* ---------- naming ---------- */
assert.equal(stemOf("/a/notes.md"), "/a/notes");
assert.equal(stemOf("/a/notes.html"), "/a/notes");
assert.equal(metaFileOf("/a/notes.md"), "/a/notes.meta.jsonl");
assert.equal(metaFileOf("/a/notes.html"), "/a/notes.meta.jsonl");
assert.equal(metaFileOf("/a/n.markdown"), "/a/n.meta.jsonl");

/* ---------- extract: full inline → hybrid + records ---------- */
{
  const full =
    "# Doc\n\nSome {==anchor text==}{>>#abc123 Alice · 2026-07-14T09:12:33Z: first<<}{>>Bob · 2026-07-14T10:00:00Z: reply<<} here.\n";
  const { md, mthreads } = extractMarkdown(full);
  assert.equal(md, "# Doc\n\nSome {==anchor text==}{>>#abc123<<} here.\n");
  assert.equal(mthreads.length, 1);
  assert.equal(mthreads[0].id, "abc123");
  assert.equal(mthreads[0].comments.length, 2);
  assert.equal(mthreads[0].comments[0].body, "first");
  assert.equal(mthreads[0].comments[1].author, "Bob");

  // Roundtrip: expanding the hybrid with the records restores the original.
  const back = expandMarkdown(md, mthreads);
  assert.equal(back.md, full);
  assert.deepEqual(back.orphanIds, []);
}

/* ---------- extract: multi-run threads (first run wins, all runs flatten) ---------- */
{
  const full =
    "{==part one==}{>>#tt1x A · 2026-01-01T00:00:00Z: hi<<}\n\n{==part two==}{>>#tt1x A · 2026-01-01T00:00:00Z: hi<<}\n";
  const { md, mthreads } = extractMarkdown(full);
  assert.equal(md, "{==part one==}{>>#tt1x<<}\n\n{==part two==}{>>#tt1x<<}\n");
  assert.equal(mthreads.length, 1);
  // Expansion re-inlines onto the FIRST run only; the second stays a ref.
  const back = expandMarkdown(md, mthreads);
  assert.equal(
    back.md,
    "{==part one==}{>>#tt1x A · 2026-01-01T00:00:00Z: hi<<}\n\n{==part two==}{>>#tt1x<<}\n",
  );
}

/* ---------- extract: hand-written spans get deterministic ids ---------- */
{
  const handWritten = "x {==a==}{>>note one<<} y {==a==}{>>note one<<} z\n";
  const one = extractMarkdown(handWritten);
  const two = extractMarkdown(handWritten);
  assert.equal(one.md, two.md); // same input → same bytes, on any machine
  assert.equal(one.mthreads.length, 2); // identical duplicates stay distinct
  assert.notEqual(one.mthreads[0].id, one.mthreads[1].id);
  for (const t of one.mthreads) assert.match(t.id, /^[a-z0-9]{4,16}$/);
  // Hand-written entries parse authorless; bodies survive.
  assert.equal(one.mthreads[0].comments[0].body, "note one");
  assert.equal(one.mthreads[0].comments[0].author, "");
}

/* ---------- expand: no body in meta → marker untouched; unknown ref untouched ---------- */
{
  const hybrid = "a {==x==}{>>#nope11<<} b\n";
  const r = expandMarkdown(hybrid, []);
  assert.equal(r.md, hybrid);
}

/* ---------- expand: inline + meta for the same id union (inline wins bodies) ---------- */
{
  const inline =
    "{==x==}{>>#dd1x Alice · 2026-01-01T00:00:00Z: edited local<<}\n";
  const meta = [
    {
      id: "dd1x",
      comments: [
        entry("Alice", 1767225600000, "old body"), // same author+at → inline wins
        entry("Carol", 1767312000000, "meta-only reply"),
      ],
    },
  ];
  const r = expandMarkdown(inline, meta);
  assert.ok(r.md.includes("edited local"));
  assert.ok(!r.md.includes("old body"));
  assert.ok(r.md.includes("meta-only reply"));
}

/* ---------- expand: orphans reported, never dropped ---------- */
{
  const r = expandMarkdown("no markers here\n", [{ id: "gone12", comments: [entry("A", 5, "x")] }]);
  assert.equal(r.md, "no markers here\n");
  assert.deepEqual(r.orphanIds, ["gone12"]);
}

/* ---------- parse/serialize: tolerant, deterministic, foreign preserved ---------- */
{
  const anc = { path: "p", tag: "h2", text: "lead" };
  const lines = [
    `{"doklin":"meta","v":1}`,
    `{"t":"mthread","id":"m1","comments":[{"author":"A","at":1,"body":"x"}]}`,
    `not json at all`,
    `{"t":"hthread","id":"h1","anchor":${JSON.stringify(anc)},"comments":[]}`,
    `{"t":"prop","id":"color","value":"blue"}`, // a future record type
    `{"t":"mthread","id":"m1","comments":[{"author":"B","at":2,"body":"dup"}]}`, // dup: first wins
    `{"t":"mthread","comments":[]}`, // no id: invalid
    `{"t":"tcols","id":"t2","cols":[180,0]}`,
    `{"t":"tcols","id":"t1","cols":[220.4,140]}`, // px are rounded on the way in
    `{"t":"tcols","id":"bad","cols":[220,-3]}`, // a negative width: drop the record
    `{"t":"tcols","id":"nan","cols":["220"]}`, // not numbers: drop the record
    `{"t":"tcols","cols":[220]}`, // no id: invalid
  ].join("\n");
  const meta = parseEntityMeta(lines);
  assert.equal(meta.mthreads.length, 1);
  assert.equal(meta.mthreads[0].comments[0].author, "A");
  assert.equal(meta.hthreads.length, 1);
  assert.equal(meta.foreign.length, 1);
  assert.equal(meta.foreign[0].t, "prop");
  assert.equal(meta.tcols.length, 2);
  assert.deepEqual(meta.tcols.find((t) => t.id === "t1").cols, [220, 140]);

  const ser = serializeEntityMeta(meta);
  assert.ok(ser.includes(`{"t":"prop","id":"color","value":"blue"}`)); // verbatim
  assert.ok(ser.includes(`{"t":"tcols","id":"t1","cols":[220,140]}`));
  // Records sort by (type, id), so the two tcols lines are adjacent and in
  // id order however they arrived.
  assert.ok(ser.indexOf(`"id":"t1"`) < ser.indexOf(`"id":"t2"`));
  // Shuffled input state serializes to identical bytes.
  const shuffled = {
    mthreads: [...meta.mthreads].reverse(),
    hthreads: [...meta.hthreads].reverse(),
    tcols: [...meta.tcols].reverse(),
    foreign: [...meta.foreign].reverse(),
  };
  assert.equal(serializeEntityMeta(shuffled), ser);
  // And a parse of the serialization is stable (fixpoint).
  assert.equal(serializeEntityMeta(parseEntityMeta(ser)), ser);
}

/* ---------- table widths alone are worth a file ---------- */
{
  const widths = { ...emptyMeta(), tcols: [{ id: "tw1", cols: [220, 0] }] };
  assert.equal(metaIsEmpty(widths), false);
  assert.ok(metaIsEmpty(emptyMeta()));
}

/* ---------- a hand edit: one thread inline, one a bare marker ---------- */
{
  const mixed =
    "{==a==}{>>#in1x A · 2026-01-01T00:00:00Z: inline<<} and {==b==}{>>#hy1x<<}\n";
  const meta = [{ id: "hy1x", comments: [entry("B", 9, "from meta")] }];
  const expanded = expandMarkdown(mixed, meta);
  assert.ok(expanded.md.includes("inline"));
  assert.ok(expanded.md.includes("from meta"));
  const { md, mthreads } = extractMarkdown(expanded.md);
  assert.equal(md, "{==a==}{>>#in1x<<} and {==b==}{>>#hy1x<<}\n");
  assert.equal(mthreads.length, 2);
}

/* ---------- add before, drop after: the sidecar while a save writes the text ---------- */
{
  const thread = (id, body) => ({ id, comments: [entry("A", 1, body)] });
  const disk = serializeEntityMeta({
    ...emptyMeta(),
    mthreads: [thread("gone1", "dropped by this save"), thread("kept1", "as it was")],
    tcols: [{ id: "old", cols: [100] }],
    foreign: [{ t: "link", sortId: "../a.md", raw: '{"t":"link","id":"../a.md","file":"f-111111111111"}' }],
  });
  const next = serializeEntityMeta({ ...emptyMeta(), mthreads: [thread("kept1", "edited"), thread("new1", "added")] });
  const meanwhile = parseEntityMeta(sidecarWhileWriting(disk, next));
  assert.deepEqual(
    meanwhile.mthreads.map((t) => [t.id, t.comments[0].body]),
    [["gone1", "dropped by this save"], ["kept1", "edited"], ["new1", "added"]],
    "every record either text uses, the new one's where both have it",
  );
  assert.deepEqual(meanwhile.tcols.map((c) => c.id), ["old"]);
  assert.deepEqual(meanwhile.foreign.map((f) => f.sortId), ["../a.md"], "records it doesn't know too");
  assert.equal(sidecarWhileWriting(null, next), next, "no sidecar on disk: the new one");
  assert.equal(sidecarWhileWriting(next, next), next, "nothing dropped: the new one, byte for byte");
}

console.log("metafile.test.mjs: all assertions passed");
