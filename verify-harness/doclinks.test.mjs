// Unit tests for resolving a link written inside a note to a path on disk
// (src/docLinks.ts) — the "internal link opens in the app" half of the click
// behavior. What resolves, what deliberately doesn't, and what a ".." may not
// be allowed to reach. Run:
//
//   node verify-harness/doclinks.test.mjs
//
// (Compiles the module through vite, mirroring metafile.test.mjs.)
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
    lib: { entry: path.join(repoRoot, "src", "docLinks.ts"), formats: ["es"], fileName: "dl" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const { linkTargetPath, normalizePath } = await import(
  `data:text/javascript,${encodeURIComponent(chunk.code)}`
);

const NOTE = "/Users/me/notes/projects/plan.md";

/* ---------- relative links resolve against the note ---------- */
{
  assert.equal(
    linkTargetPath("./other.md", NOTE),
    "/Users/me/notes/projects/other.md",
  );
  assert.equal(linkTargetPath("other.md", NOTE), "/Users/me/notes/projects/other.md");
  assert.equal(linkTargetPath("../inbox/x.md", NOTE), "/Users/me/notes/inbox/x.md");
  assert.equal(
    linkTargetPath("sub/deep/../x.md", NOTE),
    "/Users/me/notes/projects/sub/x.md",
  );
  // An absolute target ignores the note's location.
  assert.equal(linkTargetPath("/tmp/scratch.md", NOTE), "/tmp/scratch.md");
  // file:// urls are paths in disguise.
  assert.equal(linkTargetPath("file:///tmp/scratch.md", NOTE), "/tmp/scratch.md");
}

/* ---------- percent escapes, fragments, queries ---------- */
{
  assert.equal(
    linkTargetPath("./my%20note.md", NOTE),
    "/Users/me/notes/projects/my note.md",
  );
  // The document is as far as we go — the fragment inside it is dropped.
  assert.equal(
    linkTargetPath("./other.md#a-section", NOTE),
    "/Users/me/notes/projects/other.md",
  );
  assert.equal(linkTargetPath("./other.md?v=2", NOTE), "/Users/me/notes/projects/other.md");
  // A stray percent must not throw — take the path as written.
  assert.equal(linkTargetPath("./100%.md", NOTE), "/Users/me/notes/projects/100%.md");
}

/* ---------- what is deliberately not a path ---------- */
{
  for (const href of [
    "https://example.com/docs",
    "http://example.com",
    "mailto:hi@example.com",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "doklin://open",
  ]) {
    assert.equal(linkTargetPath(href, NOTE), null, href);
  }
  // Nothing to resolve against: a relative link inside an unsaved draft.
  assert.equal(linkTargetPath("./other.md", null), null);
  // Empty / fragment-only hrefs (in-document anchors never get here anyway).
  assert.equal(linkTargetPath("", NOTE), null);
  assert.equal(linkTargetPath("#section", NOTE), null);
}

/* ---------- normalizePath: "." and ".." fold like the filesystem ---------- */
{
  assert.equal(normalizePath("/a/b/../c"), "/a/c");
  assert.equal(normalizePath("/a/./b//c/"), "/a/b/c");
  // ".." can't climb out of an absolute root — it stops there rather than
  // producing a path that means something else.
  assert.equal(normalizePath("/a/../../b"), "/b");
  // On a relative path there's nothing to stop at, so a leading ".." is kept
  // (an honestly unopenable path, not a wrong one).
  assert.equal(normalizePath("../../b"), "../../b");
  assert.equal(normalizePath("a/../../b"), "../b");
}

console.log("PASS doclinks.test.mjs");
