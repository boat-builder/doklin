// The tag rules (src/tags.ts) against the shared cases
// (verify-harness/tags-fixture.json), which the iPhone's port and the Mac's
// search in Rust answer too, plus what holds for every case: a write
// touches the block alone, and a tag set and then cleared leaves the file
// as it was. Run:
//
//   node verify-harness/tags.test.mjs
//
// (Compiles the module through vite, mirroring frontmatter.test.mjs.)
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    target: "es2022",
    lib: { entry: path.join(repoRoot, "src", "tags.ts"), formats: ["es"], fileName: "tags" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const tags = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
const fm = await (async () => {
  const o = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      target: "es2022",
      lib: { entry: path.join(repoRoot, "src", "frontmatter.ts"), formats: ["es"], fileName: "fm" },
    },
  });
  const c = (Array.isArray(o) ? o[0] : o).output.find((x) => x.type === "chunk");
  return import(`data:text/javascript,${encodeURIComponent(c.code)}`);
})();

const fx = JSON.parse(readFileSync(path.join(repoRoot, "verify-harness/tags-fixture.json"), "utf8"));
const show = (s) => JSON.stringify(s);
let n = 0;

for (const c of fx.lines) {
  assert.deepStrictEqual(tags.keyedLines(c.text), c.lines, `lines of ${show(c.text)}`);
  n += 1;
}
for (const c of fx.match) {
  assert.equal(tags.matchesTags(c.text, c.filters), c.matches, `match ${show(c.filters)} in ${show(c.text)}`);
  n += 1;
}
for (const c of fx.tags) {
  assert.deepStrictEqual(tags.noteTags(c.text, c.list), c.tags, `tags of ${show(c.text)}`);
  assert.equal(tags.hasOtherFrontmatter(c.text, c.list), c.other, `other frontmatter in ${show(c.text)}`);
  n += 1;
}
for (const c of fx.write) {
  const got = tags.writeTag(c.text, c.at, c.tag);
  assert.equal(got, c.out, `write ${show(c.at)} = ${show(c.tag)} in ${show(c.text)}`);
  // The body is never touched.
  assert.equal(fm.splitFrontmatter(got).body.endsWith(fm.splitFrontmatter(c.text).body), true, `body kept: ${show(c.text)}`);
  n += 1;
}
for (const c of fx.quote) {
  assert.equal(tags.quoteValue(c.value), c.line, `quote ${show(c.value)}`);
  // What is written reads back as the value.
  assert.deepStrictEqual(tags.keyedLines(`---\nk: ${c.line}\n---\n`), [{ key: "k", value: c.value }], `read back ${show(c.line)}`);
  assert.deepStrictEqual(tags.parseTagList(`---\nk: [${c.line}]\n---\n`), [{ name: "k", values: [c.value] }], `list read back ${show(c.line)}`);
  n += 1;
}
for (const c of fx.list) {
  assert.deepStrictEqual(tags.parseTagList(c.text), c.tags, `list of ${show(c.text)}`);
  n += 1;
}
for (const c of fx.writeList) {
  const got = tags.writeTagList(c.text, c.at, c.def, c.after);
  assert.equal(got, c.out, `list write ${show(c.at)} = ${show(c.def)} in ${show(c.text)}`);
  if (c.def) {
    const listed = tags.parseTagList(got).find((d) => d.name === c.def.name);
    assert.deepStrictEqual(listed, c.def, `list reads back ${show(c.def)}`);
  }
  n += 1;
}
for (const c of fx.names) {
  assert.equal(tags.nameProblem(c.name, []) === null, c.ok, `name ${show(c.name)}`);
  n += 1;
}
for (const c of fx.values) {
  assert.equal(tags.valueProblem(c.value, []) === null, c.ok, `value ${show(c.value)}`);
  n += 1;
}
for (const c of fx.query) {
  assert.deepStrictEqual(tags.searchQuery(c.q, c.list), { text: c.text, tags: c.tags }, `query ${show(c.q)}`);
  n += 1;
}

/* ---------- What holds for every case ---------- */
{
  // A tag a note didn't have, set and then cleared: the file as it was. (A
  // block that was empty goes with the tag: a block left with no lines does.)
  const texts = [...fx.lines.map((c) => c.text), ...fx.write.map((c) => c.text), "", "Body", "Body\r\n"];
  for (const text of texts) {
    if (tags.keyedLines(text).some((l) => l.key.toLowerCase() === "zone")) continue;
    const head = fm.splitFrontmatter(text);
    if (head.head && head.inner === "") continue;
    const set = tags.writeTag(text, "Zone", { name: "Zone", value: "North: east" });
    assert.deepStrictEqual(
      tags.noteTags(set, [{ name: "zone", values: ["North: east"] }]),
      [{ name: "zone", value: "North: east", known: true }],
      `set reads back in ${show(text)}`,
    );
    assert.equal(tags.writeTag(set, "zone", null), text, `set then clear in ${show(text)}`);
    n += 1;
  }
}
{
  // Names and values that are taken, said as sentences.
  const list = [{ name: "Status", values: ["Todo"] }];
  assert.equal(tags.nameProblem("status", list), "There's already a tag called Status.");
  assert.equal(tags.nameProblem("status", list, "STATUS"), null);
  assert.equal(tags.valueProblem("todo", ["Todo"]), "Todo is there twice.");
  n += 3;
}

console.log(`tags: ${n} checks passed`);
