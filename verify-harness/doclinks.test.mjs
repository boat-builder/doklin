// Unit tests for links written inside a note (src/docLinks.ts): resolving
// one to a path on disk, what deliberately doesn't resolve and what a ".."
// may not reach; and in a workspace, the record a link to a document is
// filed under, the path between two notes, resolving by id or by path, the
// words a named link shows, and what a save writes. Run:
//
//   node verify-harness/doclinks.test.mjs
//
// (Compiles the module through vite, mirroring metafile.test.mjs.)
import { build } from "vite";
import { readFileSync } from "node:fs";
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
const {
  linkTargetPath,
  normalizePath,
  linkKey,
  keyTarget,
  relativePath,
  markdownDestination,
  documentName,
  linkWords,
  indexDocuments,
  resolveLink,
  shownWords,
  linksToSave,
  shownLink,
  recordsLine,
  splitLinkRecords,
  sectionOf,
  sectionName,
  whoCanOpen,
  pickNotice,
  documentsFor,
} = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);

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
  // Nothing to resolve against: a relative link inside an untitled note.
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

/* ---------- The cases the iPhone's port answers too (links-fixture.json) ---------- */
{
  const fx = JSON.parse(readFileSync(path.join(repoRoot, "verify-harness/links-fixture.json"), "utf8"));
  for (const c of fx.key) assert.equal(linkKey(c.href), c.key, `linkKey ${JSON.stringify(c.href)}`);
  for (const c of fx.relativePath) {
    assert.equal(relativePath(c.from, c.to), c.path, `relativePath ${c.from} → ${c.to}`);
    assert.equal(keyTarget(c.path, c.from), c.to, `and back: ${c.path} from ${c.from}`);
  }
  const index = indexDocuments(fx.documents);
  for (const c of fx.resolve) {
    const r = resolveLink(c.href, c.note, c.records, index);
    assert.equal(r?.by ?? null, c.by, `resolve, by: ${c.about}`);
    assert.equal(r?.doc?.path ?? null, c.opens, `resolve, opens: ${c.about}`);
    assert.equal(r ? shownWords(c.words, r) : c.words, c.shown, `resolve, shown: ${c.about}`);
  }
}

/* ---------- linkKey: the destination a record is filed under ---------- */
{
  assert.equal(linkKey("./a.md"), "a.md", "./ is folded away");
  assert.equal(linkKey("a.md"), "a.md");
  assert.equal(linkKey("sub/../a.md"), "a.md");
  assert.equal(linkKey("../GTM/launch-plan.md#friday"), "../GTM/launch-plan.md", "a fragment is not the document");
  assert.equal(linkKey("my%20notes/a.md"), "my notes/a.md", "decoded");
  assert.equal(linkKey("my notes/a.md"), "my notes/a.md", "as the parser hands over <my notes/a.md>");
  assert.equal(linkKey(" page.HTML "), "page.HTML");
  for (const href of [
    "https://example.com/a.md",
    "https://doklin.cc/open#w=x&f=f-1",
    "file:///tmp/a.md",
    "//example.com/a.md",
    "#heading",
    "/Users/me/a.md",
    "picture.png",
    "",
  ]) {
    assert.equal(linkKey(href), null, `not a link to a document: ${JSON.stringify(href)}`);
  }
}

/* ---------- paths between notes ---------- */
{
  const q1 = "Library/Roadmap/q1.md";
  assert.equal(keyTarget("../../Restricted/Board/board-plan.md", q1), "Restricted/Board/board-plan.md");
  assert.equal(keyTarget("plan.md", q1), "Library/Roadmap/plan.md");
  assert.equal(keyTarget("../../../out.md", q1), null, "out of the workspace");
  assert.equal(relativePath(q1, "Restricted/Board/board-plan.md"), "../../Restricted/Board/board-plan.md");
  assert.equal(relativePath(q1, "Library/Roadmap/plan.md"), "plan.md");
  assert.equal(relativePath(q1, "Library/Roadmap/old/plan.md"), "old/plan.md");
  assert.equal(relativePath(q1, "Library/GTM/launch-plan.md"), "../GTM/launch-plan.md");
  assert.equal(relativePath("Library/q1.md", "Library/Roadmap/x.md"), "Roadmap/x.md");
  for (const [from, to] of [
    [q1, "Private/todo.md"],
    ["Private/a/b/c.md", "Library/x.md"],
    ["Library/Roadmap/q1.md", "Library/Roadmap/q1.md"],
  ]) {
    assert.equal(keyTarget(relativePath(from, to), from), to, `there and back: ${from} → ${to}`);
  }
  assert.equal(markdownDestination("../GTM/launch-plan.md"), "../GTM/launch-plan.md");
  assert.equal(markdownDestination("../My notes/a.md"), "<../My notes/a.md>");
  assert.equal(markdownDestination("a (draft).md"), "<a (draft).md>");
  assert.equal(documentName("Library/GTM/launch-plan.md"), "launch-plan");
  assert.equal(documentName("page.html"), "page");
  assert.equal(linkWords("Q1 [draft]"), "Q1 \\[draft\\]");
}

/* ---------- resolving: the record's id decides, else the path ---------- */
const docs = indexDocuments([
  { path: "Library/GTM/launch-plan-v2.md", fileId: "f-launch", section: null },
  { path: "Library/Roadmap/plan.md", fileId: "f-plan", section: null },
  { path: "Library/Roadmap/new.md", fileId: null, section: null },
  { path: "Private/todo.md", fileId: "f-todo", section: "p-me" },
  { path: "Restricted/Board/board-plan.md", fileId: "f-board", section: "s-board" },
  // Half moved: one id in two sections. The shared section's is the one.
  { path: "Restricted/Board/moving.md", fileId: "f-moving", section: "s-board" },
  { path: "Library/moving.md", fileId: "f-moving", section: null },
]);
const NOTE_IN = "Library/Roadmap/q1.md";
{
  assert.equal(docs.byId.get("f-moving").path, "Library/moving.md");
  const records = [
    { id: "../GTM/launch-plan.md", file: "f-launch" },
    { id: "plan.md", file: "f-gone" },
  ];
  const renamed = resolveLink("../GTM/launch-plan.md", NOTE_IN, records, docs);
  assert.deepEqual([renamed.by, renamed.doc.path], ["record", "Library/GTM/launch-plan-v2.md"], "renamed: found by its id");
  const gone = resolveLink("./plan.md", NOTE_IN, records, docs);
  assert.deepEqual([gone.by, gone.doc], ["record", null], "a record whose file is gone opens nothing, never the file now at its path");
  const plain = resolveLink("new.md", NOTE_IN, records, docs);
  assert.deepEqual([plain.by, plain.path, plain.doc.path], ["path", "Library/Roadmap/new.md", "Library/Roadmap/new.md"]);
  const nowhere = resolveLink("missing.md", NOTE_IN, records, docs);
  assert.deepEqual([nowhere.by, nowhere.doc], ["path", null]);
  assert.equal(resolveLink("https://example.com", NOTE_IN, records, docs), null);

  assert.equal(shownWords("launch-plan", renamed), "launch-plan-v2", "a named link shows the name now");
  assert.equal(shownWords("the plan", renamed), "the plan", "the author's words stay");
  assert.equal(shownWords("plan", gone), "plan", "opens nothing: its words as saved");
}

/* ---------- what a save writes ---------- */
{
  const library = { path: NOTE_IN, section: null };
  const save = (note, links, records = []) => linksToSave(note, links, records, docs);

  // 1. Made in this editor: a record from the id, written from where it is.
  {
    const r = save(library, [{ href: "Restricted/Board/board-plan.md", words: "board-plan", made: "f-board" }]);
    assert.deepEqual(r.links, [{ href: "../../Restricted/Board/board-plan.md", words: "board-plan" }]);
    assert.deepEqual(r.records, [{ id: "../../Restricted/Board/board-plan.md", file: "f-board" }]);
    const pasted = save(library, [{ href: "../x/launch-plan.md#friday", words: "see this", made: "f-launch" }]);
    assert.deepEqual(pasted.links, [{ href: "../GTM/launch-plan-v2.md#friday", words: "see this" }], "a pasted link, made from this note, its fragment kept");
  }
  // 2. A record: kept, and written from where its document is now.
  {
    const r = save(library, [{ href: "../GTM/launch-plan.md", words: "launch-plan" }], [{ id: "../GTM/launch-plan.md", file: "f-launch" }]);
    assert.deepEqual(r.links, [{ href: "../GTM/launch-plan-v2.md", words: "launch-plan-v2" }]);
    assert.deepEqual(r.records, [{ id: "../GTM/launch-plan-v2.md", file: "f-launch" }]);
    const same = save(library, [{ href: "./plan.md", words: "Plan" }], [{ id: "plan.md", file: "f-plan" }]);
    assert.deepEqual(same.links, [{ href: "./plan.md", words: "Plan" }], "nothing moved: written as it was");
    const gone = save(library, [{ href: "plan.md", words: "plan" }], [{ id: "plan.md", file: "f-gone" }]);
    assert.deepEqual([gone.links, gone.records], [[{ href: "plan.md", words: "plan" }], [{ id: "plan.md", file: "f-gone" }]], "a file it can't find: as it was, record kept");
  }
  // 3. No record: one by its path, only into the note's own section or Library.
  {
    const r = save(library, [
      { href: "plan.md", words: "plan" },
      { href: "new.md", words: "new" },
      { href: "../../Private/todo.md", words: "todo" },
      { href: "../../Restricted/Board/board-plan.md", words: "board" },
      { href: "https://example.com", words: "web" },
    ]);
    assert.deepEqual(r.records, [{ id: "plan.md", file: "f-plan" }], "Library only; none for a file with no id yet");
    assert.deepEqual(r.links.map((l) => l.href), ["plan.md", "new.md", "../../Private/todo.md", "../../Restricted/Board/board-plan.md", "https://example.com"]);
    const inBoard = save({ path: "Restricted/Board/notes.md", section: "s-board" }, [
      { href: "board-plan.md", words: "board-plan" },
      { href: "../../Library/Roadmap/plan.md", words: "plan" },
      { href: "../../Private/todo.md", words: "todo" },
    ]);
    assert.deepEqual(inBoard.records, [{ id: "board-plan.md", file: "f-board" }, { id: "../../Library/Roadmap/plan.md", file: "f-plan" }], "its own section, and Library");
  }
  // 4. Writing back never reveals: a target in another section stays as written.
  {
    const r = save(library, [{ href: "../Old/board-plan.md", words: "board-plan" }], [{ id: "../Old/board-plan.md", file: "f-board" }]);
    assert.deepEqual(r.links, [{ href: "../Old/board-plan.md", words: "board-plan" }], "moved into a restricted folder: not written back");
    assert.deepEqual(r.records, [{ id: "../Old/board-plan.md", file: "f-board" }]);
    const own = save({ path: "Restricted/Board/notes.md", section: "s-board" }, [{ href: "old.md", words: "old" }], [{ id: "old.md", file: "f-board" }]);
    assert.deepEqual(own.links, [{ href: "board-plan.md", words: "board-plan" }], "its own section: written from where it is");
  }
  // One record per destination; a record no link uses is gone.
  {
    const r = save(library, [{ href: "plan.md", words: "a" }, { href: "./plan.md", words: "b" }], [{ id: "unused.md", file: "f-todo" }]);
    assert.deepEqual(r.records, [{ id: "plan.md", file: "f-plan" }]);
  }
}

/* ---------- How a link with a record reads ---------- */
{
  const doc = { path: "Library/GTM/launch-final.md", fileId: "f-launch", section: null };
  const from = "Library/Roadmap/q1.md";
  assert.deepEqual(shownLink(from, { href: "../GTM/launch-plan.md", words: "launch-plan" }, doc), {
    href: "../GTM/launch-final.md",
    words: "launch-final",
  }, "a named link takes the name the file has now");
  assert.deepEqual(shownLink(from, { href: "../GTM/launch-plan.md#risks", words: "the plan" }, doc), {
    href: "../GTM/launch-final.md#risks",
    words: "the plan",
  }, "other words are the author's; the #… stays");
  assert.deepEqual(shownLink(from, { href: "./../GTM/launch-final.md", words: "x" }, doc), {
    href: "./../GTM/launch-final.md",
    words: "x",
  }, "a destination that already leads there is kept as written");
}

/* ---------- The editor's records line ---------- */
{
  const records = [{ id: "../GTM/a-->b.md", file: "f-a" }, { id: "plan.md", file: "f-plan" }];
  const line = recordsLine(records);
  assert.ok(!line.slice(4, -3).includes("-->"), "nothing in it ends the comment early");
  const editor = `# Note\n\nSee [a](plan.md).\n\n${line}\n`;
  assert.deepEqual(splitLinkRecords(editor), { md: "# Note\n\nSee [a](plan.md).\n", records });
  assert.equal(recordsLine([]), "", "no records, no line");
  assert.deepEqual(splitLinkRecords("# Note\n"), { md: "# Note\n", records: [] });
  const typed = "# Note\n\n<!--doklin-links [[\"a.md\",\"f-x\"]]-->\n";
  assert.deepEqual(splitLinkRecords(typed), { md: typed, records: [] }, "a comment a person wrote is theirs");
}

/* ---------- Sections ---------- */
{
  const docs = indexDocuments([
    { path: "Library/plan.md", fileId: "f-plan", section: null },
    { path: "Restricted/Board/board-plan.md", fileId: "f-board", section: "s-board" },
    { path: "Private/todo.md", fileId: "f-todo", section: "p-me" },
  ]);
  assert.equal(sectionOf("Restricted/Board/board-plan.md", docs), "s-board");
  assert.equal(sectionOf("Restricted/Board/new.md", docs), "s-board", "a note not listed yet: its folder's section");
  assert.equal(sectionOf("Private/new.md", docs), "p-me");
  assert.equal(sectionOf("Library/new.md", docs), null);
  assert.equal(sectionOf("notes/x.md", docs), null, "a folder that doesn't sync");
  assert.equal(sectionName("Restricted/Board/x/y.md"), "Board");
  assert.equal(sectionName("Private/y.md"), "Private");
  const board = docs.byId.get("f-board");
  const todo = docs.byId.get("f-todo");
  const plan = docs.byId.get("f-plan");
  assert.equal(whoCanOpen(board, "Acme"), "Only the people in “Board” can open it.");
  assert.equal(whoCanOpen(todo, "Acme"), "Only you can open it, on any device of yours.");
  assert.equal(whoCanOpen(plan, "Acme"), "Everyone in Acme can open it.");
  assert.equal(
    pickNotice(board, null),
    "Everyone who can read this note can see “board-plan” and its folder “Board”, but only the people in “Board” can open it.",
  );
  assert.equal(pickNotice(todo, null), "Everyone who can read this note can see “todo”, but only you can open it.");
  assert.equal(pickNotice(plan, "s-board"), null, "Library opens for everyone");
  assert.equal(pickNotice(board, "s-board"), null, "its own section");
  assert.equal(pickNotice(board, "p-me"), null, "nobody else reads a Private note");
}

/* ---------- The list `@` opens ---------- */
{
  const docs = indexDocuments(
    [
      "Library/Roadmap/q1.md",
      "Library/Roadmap/q2.md",
      "Library/GTM/launch-plan.md",
      "Library/GTM/plan-b.md",
      "Library/Plans/budget.md",
      "Library/Ops/the plan for ops.md",
      "Library/Ops/explanation.md",
    ].map((path, i) => ({ path, fileId: `f-${i}`, section: null })),
  );
  const names = (q, recent = []) => documentsFor(q, "Library/Roadmap/q1.md", docs, recent).map((d) => documentName(d.path));
  assert.deepEqual(
    names("plan"),
    ["plan-b", "launch-plan", "the plan for ops", "explanation", "budget"],
    "starts with it, a word starts with it, holds it, its folder holds it",
  );
  assert.deepEqual(names("PLAN", ["Library/Ops/the plan for ops.md"]).slice(0, 3), ["plan-b", "the plan for ops", "launch-plan"], "what changed lately first within each");
  assert.deepEqual(names("").slice(0, 1), ["q2"], "with nothing typed, the note's own folder first, never the note itself");
  assert.deepEqual(names("", ["Library/Plans/budget.md"])[1], "budget", "then what changed lately");
  assert.deepEqual(names("zzz"), []);
}

console.log("PASS doclinks.test.mjs");
