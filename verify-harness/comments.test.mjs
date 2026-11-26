// The comment code of the Mac and of the iPhone, held to one set of cases:
// verify-harness/comments-fixture.json. This side checks the TypeScript —
// src/criticMarkup.ts, src/metaFile.ts, the worker's reading and placing of
// threads (cloud-worker/src/agentComments.ts), its reading of a page and of
// how much of a thread's place the file has (cloud-worker/src/htmlText.ts)
// and the merge of a sidecar (src/web/merge.ts, which the engine's must
// answer alike) — and
// ios/DoklinKit/Tests/DoklinKitTests/CommentsTests.swift checks the Swift
// port against the same file. A change to either side's rule fails here or
// there until both say the same again. Run:
//
//   node verify-harness/comments.test.mjs
//
// (Compiles the modules through vite, as metafile.test.mjs does.)
import { build } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(rel) {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    build: { write: false, target: "es2022", lib: { entry: path.join(repoRoot, rel), formats: ["es"], fileName: "m" } },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  return import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
}

const cm = await load("src/criticMarkup.ts");
const mf = await load("src/metaFile.ts");
const ac = await load("cloud-worker/src/agentComments.ts");
const mg = await load("src/web/merge.ts");
const ht = await load("cloud-worker/src/htmlText.ts");
const fx = JSON.parse(readFileSync(path.join(repoRoot, "verify-harness/comments-fixture.json"), "utf8"));

let checked = 0;
const same = (actual, expected, what) => {
  assert.deepStrictEqual(actual, expected, what);
  checked += 1;
};

for (const c of fx.metaFile) same(mf.metaFileOf(c.path), c.meta, `metaFileOf ${c.path}`);
for (const c of fx.parseSpans) same(cm.parseSpans(c.spans), c.parsed, `parseSpans ${JSON.stringify(c.spans)}`);
for (const c of fx.sanitizeBody) same(cm.sanitizeBody(c.in), c.out, `sanitizeBody ${JSON.stringify(c.in)}`);
for (const c of fx.sanitizeAuthor) same(cm.sanitizeAuthor(c.in), c.out, `sanitizeAuthor ${JSON.stringify(c.in)}`);
for (const c of fx.formatThreadSpans) same(cm.formatThreadSpans(c.id, c.comments), c.out, `formatThreadSpans ${c.id}`);
for (const c of fx.stripComments) same(cm.stripComments(c.in), c.out, `stripComments ${JSON.stringify(c.in)}`);
for (const c of fx.deriveId) same(mf.deriveId(c.material, c.index), c.id, `deriveId ${JSON.stringify(c.material)}`);

for (const c of fx.meta) {
  const parsed = mf.parseEntityMeta(c.raw);
  same(mf.serializeEntityMeta(parsed), c.serialized, `meta: ${c.about}`);
  same(mf.metaIsEmpty(parsed), c.empty, `meta, empty: ${c.about}`);
  // What was written reads back to itself.
  same(mf.serializeEntityMeta(mf.parseEntityMeta(c.serialized)), c.serialized, `meta, again: ${c.about}`);
}

for (const c of fx.expand) {
  const r = mf.expandMarkdown(c.md, c.mthreads);
  same(r.md, c.out, `expand ${JSON.stringify(c.md)}`);
  same(r.orphanIds, c.orphanIds, `expand, orphans ${JSON.stringify(c.md)}`);
}
for (const c of fx.extract) {
  const r = mf.extractMarkdown(c.md);
  same(r.md, c.out, `extract ${JSON.stringify(c.md)}`);
  same(r.mthreads, c.mthreads, `extract, records ${JSON.stringify(c.md)}`);
}

const metaOf = (raw) => (raw === null ? mf.emptyMeta() : mf.parseEntityMeta(raw));

for (const c of fx.threads) same(ac.threadsOf(c.md, c.html, metaOf(c.meta)), c.threads, `threads: ${c.about}`);

// A page read from its file: what it says as one run of text, and each
// element's tag, id and the start of what it says. Then how much of a
// thread's place a file has (`level`), and whether a 0 says it is gone
// (`known`). A case's `state` is the app's script's, in the page as drawn:
// drive.mjs checks it.
for (const c of fx.pages) {
  const page = ht.readPage(c.html);
  same(page.text, c.text, `page, text: ${c.about}`);
  same(page.runsScript, c.runsScript, `page, script: ${c.about}`);
  same(page.elements.map((el) => [el.tag, el.id, el.text]), c.elements, `page, elements: ${c.about}`);
}
for (const c of fx.places) {
  const place = ht.placeOf(ht.readPage(c.html), c.anchor);
  same([place.level, place.known], [c.level, c.known], `place: ${c.about}`);
}

/* ---------- What the phone does to a document, done the worker's way ---------- */

const WHY = {
  "the frontmatter at the top": "frontmatter",
  "a code block": "code block",
  code: "code",
  "a link's address": "link",
  "an html tag": "html tag",
  "an existing comment": "comment",
  "a heading or list mark — quote the words after it": "mark",
};

function operate(c) {
  const m = metaOf(c.meta);
  let md = c.md;
  const op = c.do;
  // To the second, as the worker stamps an agent's comment.
  const stamp = (author, at, body) => ({ author: cm.sanitizeAuthor(author), at: Math.floor(at / 1000) * 1000, body });
  if (op.start) {
    if (md === null) return { refusal: { kind: "noMarkdown" } };
    const said = cm.sanitizeBody(op.start.body);
    if (!said) return { refusal: { kind: "nothingSaid" } };
    const on = op.start.on.trim();
    if (ac.anchorProblem(on) !== null) {
      return { refusal: { kind: on === "" ? "noWords" : /[\r\n]/.test(on) ? "oneLine" : "formatting" } };
    }
    const at = ac.placeForMarker(md, on, "the note");
    if (typeof at !== "number") {
      if (at.status === 404) return { refusal: { kind: "missing" } };
      const many = /occurs (\d+) times/.exec(at.error);
      if (many) return { refusal: { kind: "many", count: Number(many[1]) } };
      return { refusal: { kind: "inside", why: WHY[at.extra.occurrences.find((o) => o.inside).inside] } };
    }
    md = `${md.slice(0, at)}{==${on}==}{>>#${op.start.id}<<}${md.slice(at + on.length)}`;
    m.mthreads = [...m.mthreads, { id: op.start.id, comments: [stamp(op.start.author, op.start.at, said)] }];
  } else if (op.reply) {
    const said = cm.sanitizeBody(op.reply.body);
    if (!said) return { refusal: { kind: "nothingSaid" } };
    const found = m.mthreads.find((t) => t.id === op.reply.id) ?? m.hthreads.find((t) => t.id === op.reply.id);
    if (!found) return { refusal: { kind: "gone" } };
    found.comments = [...found.comments, stamp(op.reply.author, op.reply.at, said)];
  } else if (op.remove) {
    const id = op.remove.id;
    if (m.mthreads.some((t) => t.id === id)) {
      m.mthreads = m.mthreads.filter((t) => t.id !== id);
      if (md !== null) {
        md = md.replace(new RegExp(cm.CRITIC_BLOCK_RE.source, "g"), (whole, anchor, spans) => (cm.parseSpans(spans).id === id ? anchor : whole));
      }
    } else if (m.hthreads.some((t) => t.id === id)) {
      m.hthreads = m.hthreads.filter((t) => t.id !== id);
    } else {
      return { refusal: { kind: "gone" } };
    }
  } else if (op.deleteReply) {
    // The reply shown at `index`, found again by who wrote it and when (the
    // fold key of metaFile.ts): sync may have moved the thread on since.
    const { id, entry, index } = op.deleteReply;
    const found = m.mthreads.find((t) => t.id === id) ?? m.hthreads.find((t) => t.id === id);
    if (!found) return { refusal: { kind: "gone" } };
    const key = (e) => `${e.author}|${e.at}`;
    const matching = found.comments.flatMap((e, i) => (i > 0 && key(e) === key(entry) ? [i] : []));
    const at = matching.includes(index) ? index : matching[0];
    if (at === undefined) return { refusal: { kind: "gone" } };
    found.comments = found.comments.filter((_, i) => i !== at);
  }
  // The Mac never makes a meta file for nothing, and empties one it has.
  return { outMd: md, outMeta: mf.metaIsEmpty(m) && c.meta === null ? null : mf.serializeEntityMeta(m) };
}

for (const c of fx.operations) {
  const { about: _about, md: _md, meta: _meta, do: _do, ...expected } = c;
  const done = operate(c);
  same(done, expected, `operation: ${c.about}`);
  if (done.outMeta !== undefined && done.outMeta !== null && done.outMd !== null) {
    // What the phone leaves is what a Mac opening and saving it would write:
    // expanded into the editor and extracted back, the same bytes.
    const meta = mf.parseEntityMeta(done.outMeta);
    const back = mf.extractMarkdown(mf.expandMarkdown(done.outMd, meta.mthreads).md);
    const orphans = meta.mthreads.filter((t) => !back.mthreads.some((r) => r.id === t.id));
    const resaved = mf.serializeEntityMeta({ ...meta, mthreads: [...back.mthreads, ...orphans] });
    same([back.md, resaved], [done.outMd, done.outMeta], `operation, settled: ${c.about}`);
  }
}

// A sidecar changed in two places, merged by its records: the browser's
// merge here, the engine's in engine/src/sidecar.rs's tests. `files` are
// the file ids the workspace holds, where a case asks which link's exists.
for (const c of fx.mergeMeta) {
  const files = new Set(c.files ?? []);
  same(mg.mergeMeta(c.base, c.ours, c.theirs, (fid) => files.has(fid)), c.out, `mergeMeta: ${c.about}`);
}

console.log(`comments.test.mjs: ${checked} checks passed`);
