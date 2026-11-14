// Unit tests for the frontmatter boundary (src/frontmatter.ts): what counts as
// a block, and that head + body is always the file, byte for byte — the
// editor is handed the body and every save puts the head back in front. Run:
//
//   node verify-harness/frontmatter.test.mjs
//
// (Compiles the module through vite, mirroring doclinks.test.mjs.)
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
    lib: { entry: path.join(repoRoot, "src", "frontmatter.ts"), formats: ["es"], fileName: "fm" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const { splitFrontmatter } = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);

const split = (text) => {
  const fm = splitFrontmatter(text);
  assert.equal(fm.head + fm.body, text, `head + body is the file: ${JSON.stringify(text)}`);
  return fm;
};

/* ---------- a block ---------- */
{
  const fm = split("---\ntitle: Plan\ntags: [a, b]\n---\n# Plan\n\nBody.\n");
  assert.equal(fm.head, "---\ntitle: Plan\ntags: [a, b]\n---\n");
  assert.equal(fm.inner, "title: Plan\ntags: [a, b]");
  assert.equal(fm.body, "# Plan\n\nBody.\n");
}
{
  // Whatever is inside is kept as written: nesting, comments, odd keys.
  const fm = split("---\nmeta:\n  owner: ada\n# a comment\nx: |\n  two\n  lines\n---\nBody\n");
  assert.equal(fm.inner, "meta:\n  owner: ada\n# a comment\nx: |\n  two\n  lines");
  assert.equal(fm.body, "Body\n");
}
{
  // Trailing whitespace on a fence, CRLF line ends.
  const fm = split("--- \r\nk: v\r\n---\t\r\nBody\r\n");
  assert.equal(fm.inner, "k: v");
  assert.equal(fm.body, "Body\r\n");
}
{
  // An empty block, and a block that ends the file with no newline.
  assert.equal(split("---\n---\nBody").inner, "");
  assert.equal(split("---\n---\nBody").body, "Body");
  const eof = split("---\nk: v\n---");
  assert.equal(eof.inner, "k: v");
  assert.equal(eof.body, "");
}

/* ---------- not a block ---------- */
for (const text of [
  "",
  "# Plan\n\n---\n\nk: v\n---\n", // a rule further down
  "---\nk: v\n", // no closing fence: an opening rule, then prose
  "---", // one line
  " ---\nk: v\n---\n", // not at the very start
  "----\nk: v\n----\n", // four dashes
  "Text\n---\n",
]) {
  const fm = split(text);
  assert.equal(fm.head, "", JSON.stringify(text));
  assert.equal(fm.body, text, JSON.stringify(text));
}

console.log("PASS frontmatter.test.mjs");
