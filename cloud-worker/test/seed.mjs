// A small synced workspace with something of everything a public page can
// show, and a way to load it through the worker's own API (bind, blobs, the
// manifest) — so the renderer tests in run.mjs and the browser harness in
// verify-harness/serve-worker.mjs walk the same site.
//
//   Home.md                          the root page; links to public, unpublished and external targets
//   Projects/plan.md + plan.html     a note with an html rendition (the MD/HTML pill)
//   Projects/board.md                a ```kanban and a ```table fence over the Roadmap store
//   Projects/Roadmap/store.jsonl     a datastore, three cards with properties
//   Projects/assets/pic.png          a picture a note shows, inside the published folder
//   Ideas.md + Ideas/…               a board whose cards are NOT public (titles, not links)
//   Sizes.md + Sizes.meta.jsonl      a table with stored column widths
//   Comments.md + Comments.meta.jsonl  comment markers in the text, bodies in the sidecar
//   Diagram.md                       a ```mermaid block
//   Scratch.md                       synced, never published
import { createHash } from "node:crypto";

export const sha256 = (input) => createHash("sha256").update(input).digest("hex");
/** A content address: the first 16 hex characters of the sha256, the way the engine addresses blobs. */
export const blobHash = (bytes) => sha256(bytes).slice(0, 16);
/** A stable file id for a seeded path. */
export const fidOf = (path) => `f-${sha256(path).slice(0, 10)}`;

/** A 1×1 transparent PNG. */
export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// The ids below are what src/tableWidths.ts's tableSignature + metaFile.ts's
// deriveId produce for this exact table (pinned in
// verify-harness/tablewidths.test.mjs too). The worker re-derives them from
// marked's tokens, so a drift on either side drops the widths — and fails
// the test.
export const WIDE_TABLE = `# Sizes

| Name | Role | Location |
| --- | --- | --- |
| Ada | Engineer | London |
`;

const ROADMAP_STORE = [
  '{"doklin":"store","v":1,"name":"Roadmap"}',
  '{"t":"field","id":"status","name":"Status","type":"select"}',
  '{"t":"field","id":"owner","name":"Owner","type":"select"}',
  '{"t":"field","id":"tags","name":"Tags","type":"multi_select"}',
  '{"t":"option","field":"status","name":"Backlog","rank":"a0","color":"grey"}',
  '{"t":"option","field":"status","name":"In progress","rank":"a1","color":"blue"}',
  '{"t":"option","field":"status","name":"Done","rank":"a2","color":"green"}',
  '{"t":"option","field":"owner","name":"Ada","rank":"a0","color":"green"}',
  '{"t":"option","field":"tags","name":"hull","rank":"a0"}',
  '{"t":"option","field":"tags","name":"paint","rank":"a1","color":"red"}',
  '{"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}',
  '{"t":"view","id":"table","kind":"table","name":"Table"}',
  "",
].join("\n");

const IDEAS_STORE = [
  '{"doklin":"store","v":1,"name":"Ideas"}',
  '{"t":"field","id":"status","name":"Status","type":"select"}',
  '{"t":"option","field":"status","name":"New","rank":"a0","color":"yellow"}',
  '{"t":"option","field":"status","name":"Maybe","rank":"a1"}',
  '{"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}',
  "",
].join("\n");

/** path → content (a string, or bytes). */
export const SEED_FILES = {
  "Home.md": `# Home

Welcome. Read [the plan](./Projects/plan.md), the [board](./Projects/board.md) or a [scratch note](./Scratch.md); the [source](https://github.com/boat-builder/doklin) is public and [this page](#home) links to itself.

![a picture](./Projects/assets/pic.png) ![a missing picture](./Nope/none.png)
`,
  "Projects/plan.md": `# The plan

Ship it by June. See the [board](./board.md) and the [ideas](../Ideas.md).
`,
  "Projects/plan.html": `<!doctype html><html><head><meta charset="utf-8"><title>The plan</title></head><body><h1>The plan</h1><p id="rendered">Rendered by hand.</p><script>document.body.dataset.ran = "yes";</script></body></html>`,
  "Projects/board.md": `# Board

The roadmap as a board:

\`\`\`kanban
store: ./Roadmap
\`\`\`

And as a table:

\`\`\`table
store: ./Roadmap
\`\`\`

Everything after the board is ordinary prose. See [the plan](./plan.md) and [home](../Home.md).
`,
  "Projects/Roadmap/store.jsonl": ROADMAP_STORE,
  "Projects/Roadmap/Ship the boat.md": `---
status: In progress
owner: Ada
tags: [hull]
rank: a0
---
The hull is done.
`,
  "Projects/Roadmap/Paint it.md": `---
status: Backlog
tags: [paint, hull]
rank: a1
---
After the hull.
`,
  "Projects/Roadmap/Launch.md": `---
status: Done
rank: a2
---
We launched.
`,
  "Projects/assets/pic.png": PIXEL_PNG,
  "Ideas.md": `# Ideas

\`\`\`kanban
store: ./Ideas
\`\`\`
`,
  "Ideas/store.jsonl": IDEAS_STORE,
  "Ideas/Teleporter.md": `---
status: New
rank: a0
---
Beam me up.
`,
  "Ideas/Jetpack.md": `Just a note in a board folder, no frontmatter at all.
`,
  "Sizes.md": WIDE_TABLE,
  "Sizes.meta.jsonl": '{"doklin":"meta","v":1}\n{"t":"tcols","id":"yh4epk11","cols":[260,0,140]}\n',
  "Comments.md": `# Comments

A sentence with {==a highlighted phrase==}{>>c-1<<} and more after it.
`,
  "Comments.meta.jsonl":
    '{"doklin":"meta","v":1}\n{"t":"mthread","id":"c-1","comments":[{"author":"Ada","at":1757000000000,"body":"Say it plainer."}]}\n',
  "Diagram.md": `# Flow

\`\`\`mermaid
flowchart LR
  A[Write] --> B[Publish]
\`\`\`

Words after the diagram.
`,
  "Scratch.md": `# Scratch

Not public.
`,
};

/** The public map over those files. */
export const SEED_PUBLIC = {
  home: { kind: "file", file: fidOf("Home.md"), path: "Home.md", root: true, by: "Sherin's MacBook Pro", at: 1757000000000 },
  plan: { kind: "file", file: fidOf("Projects/plan.md"), path: "Projects/plan.md", by: "Sherin's MacBook Pro", at: 1757000001000 },
  projects: {
    kind: "dir",
    path: "Projects",
    title: "Projects",
    desc: "Everything we're building",
    by: "Sherin's MacBook Pro",
    at: 1757000002000,
  },
  ship: { kind: "file", file: fidOf("Projects/Roadmap/Ship the boat.md"), path: "Projects/Roadmap/Ship the boat.md" },
  ideas: { kind: "file", file: fidOf("Ideas.md"), path: "Ideas.md" },
  sizes: { kind: "file", file: fidOf("Sizes.md"), path: "Sizes.md" },
  comments: { kind: "file", file: fidOf("Comments.md"), path: "Comments.md" },
  diagram: { kind: "file", file: fidOf("Diagram.md"), path: "Diagram.md" },
  // Deleted last week; the page 404s until the file is back. Kept on purpose.
  ghost: { kind: "file", file: "f-gone", path: "Old.md" },
};

const contentTypeOf = (path) =>
  path.endsWith(".png") ? "image/png" : path.endsWith(".html") ? "text/html" : path.endsWith(".jsonl") ? "application/jsonl" : "text/markdown";

/** The manifest's file entries plus the blobs to upload for them. */
export function seedManifestFiles(files = SEED_FILES) {
  const entries = {};
  const blobs = [];
  let i = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const fid = fidOf(path);
    const hash = blobHash(bytes);
    entries[fid] = { path, rev: 1, hash, size: bytes.length, mtime: 1757000000000 + i * 60000, by: "Sherin's MacBook Pro" };
    blobs.push({ fid, hash, bytes, contentType: contentTypeOf(path) });
    i += 1;
  }
  return { entries, blobs };
}

/**
 * Load the seed through the worker's API, as the engine would: bind the
 * domain if it is free, upload every blob, then compare-and-swap the manifest
 * on top of whatever it holds. Answers the manifest etag.
 */
export async function seedThroughApi(worker, env, { token, files = SEED_FILES, publicMap = SEED_PUBLIC, name = "Notes" } = {}) {
  const base = "https://notes.example.com";
  const call = (path, init = {}) =>
    worker.fetch(
      new Request(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "x-doklin-device": "d-seed", "x-doklin-client": "0.0.0-seed", ...(init.headers ?? {}) },
      }),
      env,
    );
  const meta = await (await call("/api/meta")).json();
  if (!meta.workspace) {
    const bound = await call("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, deviceName: "Sherin's MacBook Pro" }),
    });
    if (bound.status !== 201) throw new Error(`bind failed: ${bound.status} ${await bound.text()}`);
  }
  const { entries, blobs } = seedManifestFiles(files);
  for (const b of blobs) {
    const res = await call(`/api/blobs/${b.fid}/${b.hash}`, { method: "PUT", headers: { "content-type": b.contentType }, body: b.bytes });
    if (res.status !== 200) throw new Error(`blob ${b.fid} failed: ${res.status}`);
  }
  const current = await call("/api/manifest");
  const etag = current.headers.get("x-manifest-etag");
  const seq = (await current.json()).seq + 1;
  const put = await call("/api/manifest", {
    method: "PUT",
    headers: { "x-base-etag": etag, "content-type": "application/json" },
    body: JSON.stringify({ version: 2, name, seq, files: entries, tombstones: {}, public: publicMap }),
  });
  if (put.status !== 200) throw new Error(`manifest failed: ${put.status} ${await put.text()}`);
  return (await put.json()).etag;
}
