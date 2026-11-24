// Unit tests for what the browser version does when a document it is saving
// changed somewhere else first (src/web/merge.ts): the three-way text merge,
// the sidecar's merge by its records, and the names a conflict copy takes.
// Run:
//
//   node verify-harness/webmerge.test.mjs
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
    lib: { entry: path.join(repoRoot, "src", "web", "merge.ts"), formats: ["es"], fileName: "wm" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const { mergeText, mergeMeta, conflictCopyNames } = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
/** No file is any section's: these cases have no links. */
const none = () => false;

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${name}`);
};

const BASE = "# Plan\n\nThe first paragraph.\n\nThe second paragraph.\n\nThe third paragraph.\n";

test("one side changed: the text is that side's", () => {
  const edited = BASE.replace("first", "1st");
  assert.equal(mergeText(BASE, edited, BASE), edited);
  assert.equal(mergeText(BASE, BASE, edited), edited);
  assert.equal(mergeText(BASE, edited, edited), edited, "the same change on both sides is one change");
  assert.equal(mergeText(BASE, BASE, BASE), BASE);
});

test("changes to different paragraphs are both kept", () => {
  const ours = BASE.replace("first", "1st");
  const theirs = BASE.replace("third", "3rd");
  assert.equal(mergeText(BASE, ours, theirs), BASE.replace("first", "1st").replace("third", "3rd"));
  assert.equal(mergeText(BASE, theirs, ours), mergeText(BASE, ours, theirs), "whichever side is whose");
});

test("lines put in at the top and at the end, a paragraph taken out between", () => {
  const ours = `Draft.\n\n${BASE}`;
  const theirs = `${BASE.replace("The second paragraph.\n\n", "")}\nA fourth.\n`;
  assert.equal(mergeText(BASE, ours, theirs), `Draft.\n\n${theirs}`);
});

test("the same line changed two ways is an overlap: nothing is merged", () => {
  assert.equal(mergeText(BASE, BASE.replace("second", "2nd"), BASE.replace("second", "other")), null);
});

test("changes that touch are an overlap, as diff3 has it", () => {
  const ours = BASE.replace("The third paragraph.\n", "The third paragraph, longer.\n");
  const theirs = `${BASE}A line right after it.\n`;
  assert.equal(mergeText(BASE, ours, theirs), null);
  assert.equal(mergeText("a\nb\n", "a\nx\nb\n", "a\ny\nb\n"), null, "two things put in at one place");
  assert.equal(mergeText("a\nb\n", "a\nx\nb\n", "a\nx\nb\n"), "a\nx\nb\n");
});

test("a text with no line ending at its end, and an empty one", () => {
  assert.equal(mergeText("a\nb\nc", "A\nb\nc", "a\nb\nC"), "A\nb\nC");
  assert.equal(mergeText("", "mine\n", ""), "mine\n");
  assert.equal(mergeText("", "mine\n", "theirs\n"), null);
  assert.equal(mergeText("a\n", "", "a\nb\n"), null, "all of it deleted here, added to there");
});

test("a repeated line: each side's own change survives a merge with one far from it", () => {
  // A small alphabet, so the diff has many equal lines to choose between;
  // whatever it chooses, applying it must give the side back.
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 400; round += 1) {
    const body = Array.from({ length: 5 + rand(40) }, () => `line ${rand(4)}\n`);
    const base = [...body, "KEPT\n", "END\n"].join("");
    const edited = [...body];
    for (let n = 1 + rand(6); n > 0; n -= 1) {
      const at = rand(edited.length + 1);
      if (rand(2) === 0) edited.splice(at, rand(3));
      else edited.splice(at, 0, `line ${rand(4)}\n`);
    }
    const ours = [...edited, "KEPT\n", "END\n"].join("");
    const theirs = `${base}after\n`;
    assert.equal(mergeText(base, ours, theirs), `${ours}after\n`, `round ${round}`);
    assert.equal(mergeText(base, theirs, ours), `${ours}after\n`, `round ${round}, the other way`);
  }
});

test("two long texts far apart are not compared at all", () => {
  const long = (word) => Array.from({ length: 4000 }, (_, i) => `${word} ${i}\n`).join("");
  assert.equal(mergeText("x\n", long("ours"), long("theirs")), null);
});

const HEADER = '{"doklin":"meta","v":1}';
const thread = (id, ...bodies) =>
  JSON.stringify({ t: "mthread", id, comments: bodies.map((body, i) => ({ author: body.split(":")[0], at: 1782900000000 + i, body })) });
const meta = (...lines) => [HEADER, ...lines].join("\n") + "\n";

test("a sidecar: a reply on each side of one thread is kept, where a line merge would call it an overlap", () => {
  const base = meta(thread("m1", "Ada: first"));
  const ours = meta(JSON.stringify({ t: "mthread", id: "m1", comments: [{ author: "Ada", at: 1782900000000, body: "Ada: first" }, { author: "Bob", at: 1782900000500, body: "Bob: mine" }] }));
  const theirs = meta(JSON.stringify({ t: "mthread", id: "m1", comments: [{ author: "Ada", at: 1782900000000, body: "Ada: first" }, { author: "Cy", at: 1782900000700, body: "Cy: theirs" }] }));
  const merged = mergeMeta(base, ours, theirs, none);
  const bodies = JSON.parse(merged.split("\n")[1]).comments.map((c) => c.body);
  assert.deepEqual(bodies.sort(), ["Ada: first", "Bob: mine", "Cy: theirs"]);
});

test("a sidecar: a thread made on each side, a thread deleted on one, and a document that had none", () => {
  const base = meta(thread("m1", "Ada: one"), thread("m2", "Ada: two"));
  const ours = meta(thread("m1", "Ada: one"), thread("m2", "Ada: two"), thread("m3", "Bob: mine"));
  const theirs = meta(thread("m2", "Ada: two"), thread("m4", "Cy: theirs"));
  const ids = mergeMeta(base, ours, theirs, none).split("\n").slice(1, -1).map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, ["m2", "m3", "m4"], "m1 was deleted there, and stays deleted");
  const fresh = mergeMeta(null, meta(thread("m3", "Bob: mine")), meta(thread("m4", "Cy: theirs")), none);
  assert.deepEqual(fresh.split("\n").slice(1, -1).map((l) => JSON.parse(l).id), ["m3", "m4"]);
  assert.equal(mergeMeta(base, ours, ours, none), ours);
});

test("a sidecar: table widths and records this version does not know follow the side that changed them", () => {
  const cols = (id, ...widths) => JSON.stringify({ t: "tcols", id, cols: widths });
  const base = meta(cols("t1", 100, 200), '{"t":"future","id":"x","n":1}');
  const ours = meta(cols("t1", 100, 200), '{"t":"future","id":"x","n":1}', cols("t2", 50, 0));
  const theirs = meta(cols("t1", 120, 200));
  const lines = mergeMeta(base, ours, theirs, none).split("\n").slice(1, -1);
  assert.deepEqual(lines, [cols("t1", 120, 200), cols("t2", 50, 0)], "their width, our new table, and the record they removed is gone");
});

test("a conflict copy is named as the engine names one", () => {
  const at = new Date(2026, 6, 11, 14, 5);
  const names = conflictCopyNames("Meeting notes.md", "Alice", at);
  assert.equal(names[0], "Meeting notes (conflict — Alice, Jul 11 14.05).md");
  assert.equal(names[1], "Meeting notes (conflict — Alice, Jul 11 14.05 2).md");
  assert.equal(names.length, 101);
  assert.equal(names[100], `Meeting notes (conflict ${at.getTime()}).md`);
  assert.equal(conflictCopyNames("v1.2.md", "A/B: C\\D", at)[0], "v1.2 (conflict — A-B- C-D, Jul 11 14.05).md", "what a name can't carry");
  assert.equal(conflictCopyNames("notes.md", "", at)[0], "notes (conflict — someone, Jul 11 14.05).md");
  assert.equal(conflictCopyNames("notes.md", "x".repeat(60), at)[0], `notes (conflict — ${"x".repeat(40)}, Jul 11 14.05).md`);
});

console.log(`\n${passed} passed`);
