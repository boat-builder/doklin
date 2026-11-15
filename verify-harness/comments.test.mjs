// The comment code of the Mac and of the iPhone, held to one set of cases:
// verify-harness/comments-fixture.json. This side checks the TypeScript —
// src/criticMarkup.ts, src/metaFile.ts, and the worker's reading and placing
// of threads (cloud-worker/src/agentComments.ts) — and
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
for (const c of fx.migrate) {
  const r = mf.migrateEntity({ diskMd: c.md, meta: metaOf(c.meta) });
  same(r.md, c.outMd, `migrate ${JSON.stringify(c.md)}`);
  same(mf.serializeEntityMeta(r.meta), c.outMeta, `migrate, meta ${JSON.stringify(c.md)}`);
  same([r.mdChanged, r.metaChanged], [c.mdChanged, c.metaChanged], `migrate, changed ${JSON.stringify(c.md)}`);
  // Once is enough — unless an entry is stamped finer than the second,
  // which the markdown form cannot carry: then every pass writes again.
  const again = mf.migrateEntity({ diskMd: r.md, meta: r.meta });
  same(again.mdChanged || again.metaChanged, c.againChanged, `migrate, again ${JSON.stringify(c.md)}`);
}

for (const c of fx.threads) same(ac.threadsOf(c.md, c.html, metaOf(c.meta)), c.threads, `threads: ${c.about}`);

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
  const read = metaOf(c.meta);
  const open = c.md === null ? { md: null, meta: read } : mf.migrateEntity({ diskMd: c.md, meta: read });
  const m = open.meta;
  let md = open.md;
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
    const { id, index } = op.deleteReply;
    const found = m.mthreads.find((t) => t.id === id) ?? m.hthreads.find((t) => t.id === id);
    if (!found || !(index > 0 && index < found.comments.length)) return { refusal: { kind: "gone" } };
    found.comments = found.comments.filter((_, i) => i !== index);
  }
  // The Mac never makes a meta file for nothing, and empties one it has.
  return { outMd: md, outMeta: mf.metaIsEmpty(m) && c.meta === null ? null : mf.serializeEntityMeta(m) };
}

for (const c of fx.operations) {
  const { about: _about, md: _md, meta: _meta, do: _do, ...expected } = c;
  const done = operate(c);
  same(done, expected, `operation: ${c.about}`);
  if (done.outMeta !== undefined && done.outMeta !== null) {
    // What the phone leaves is what a Mac opening it would leave.
    const settled = mf.migrateEntity({ diskMd: done.outMd, meta: mf.parseEntityMeta(done.outMeta) });
    same([settled.mdChanged, settled.metaChanged], [false, false], `operation, settled: ${c.about}`);
  }
}

console.log(`comments.test.mjs: ${checked} checks passed`);
