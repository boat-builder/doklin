// A small synced workspace with something of everything a public page can
// show, and a way to load it through the worker's own API (bind, blobs, the
// manifest) — so the renderer tests in run.mjs and the browser harness in
// verify-harness/serve-worker.mjs walk the same site.
//
//   Home.md                          the root page; links to public, unpublished and external
//                                    targets, and pictures, which are their alt text
//   Projects/plan.md + plan.html     a note with an html rendition (the MD/HTML pill)
//   Projects/status.md               a note inside the published folder that links out of it
//   Projects/Roadmap/…               notes a folder deeper — one opens with a frontmatter
//                                    block, one with a plain rule
//   Ideas.md                         a note outside the folder, linked with ../; callouts,
//                                    and quotes that only look like them
//   Sizes.md + Sizes.meta.jsonl      a table with stored column widths
//   Comments.md + Comments.meta.jsonl  comment markers in the text, bodies in the sidecar
//   Diagram.md                       a ```mermaid flowchart, a ```mermaid diagram of
//                                    another kind, and ```svg drawings (two
//                                    sharing a marker id, one that doesn't parse),
//                                    then HTML written into the markdown that would
//                                    act if its page let it: a script, a handler, a
//                                    javascript: link, a form and a <base>
//   Scratch.md                       synced, never published
import { createHash } from "node:crypto";

export const sha256 = (input) => createHash("sha256").update(input).digest("hex");
/** A content address: the first 16 hex characters of the sha256, the way the engine addresses blobs. */
export const blobHash = (bytes) => sha256(bytes).slice(0, 16);
/** A stable file id for a seeded path. */
export const fidOf = (path) => `f-${sha256(path).slice(0, 10)}`;

/** A 1×1 transparent PNG — what a workspace no longer syncs. */
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

/** path → content (a string, or bytes). */
export const SEED_FILES = {
  "Home.md": `# Home

Welcome. Read [the plan](./Projects/plan.md), the [status](./Projects/status.md) or a [scratch note](./Scratch.md); the [source](https://github.com/boat-builder/doklin) is public and [this page](#home) links to itself.

![a picture](./Projects/assets/pic.png) ![a missing picture](./Nope/none.png) ![a picture on the web](https://example.com/sky.png)
`,
  "Projects/plan.md": `# The plan

Ship it by June. See the [status](./status.md) and the [ideas](../Ideas.md).
`,
  "Projects/plan.html": `<!doctype html><html><head><meta charset="utf-8"><title>The plan</title></head><body><h1>The plan</h1><p id="rendered">Rendered by hand.</p><script>document.body.dataset.ran = "yes";</script></body></html>`,
  "Projects/status.md": `# Status

Where things stand. See [the plan](./plan.md) and [home](../Home.md).
`,
  "Projects/Roadmap/Ship the boat.md": `---
status: In progress
owner: Ada
tags: [hull]
---
The hull is done.
`,
  "Projects/Roadmap/Paint it.md": `After the hull.
`,
  "Projects/Roadmap/Launch.md": `---

We launched.
`,
  "Ideas.md": `# Ideas

A teleporter, or a jetpack.

> [!WARNING]
> Both need *fuel*.

> [!note]
> A marker in lowercase.

> [!NOTE] A title after the marker

- In a list:

  > [!TIP]
  > a quote in a list stays a quote
`,
  "Sizes.md": WIDE_TABLE,
  "Sizes.meta.jsonl": '{"doklin":"meta","v":1}\n{"t":"tcols","id":"yh4epk11","cols":[260,0,140]}\n',
  "Comments.md": `# Comments

A sentence with {==a highlighted phrase==}{>>#plain1<<} and more after it.
`,
  "Comments.meta.jsonl":
    '{"doklin":"meta","v":1}\n{"t":"mthread","id":"plain1","comments":[{"author":"Ada","at":1757000000000,"body":"Say it plainer."}]}\n',
  "Diagram.md": `# Flow

\`\`\`mermaid
flowchart LR
  A[Write] --> B[Publish]
\`\`\`

Words after the diagram.

\`\`\`mermaid
sequenceDiagram
  Ada->>Ben: A kind Doklin does not draw
\`\`\`

\`\`\`svg
<svg viewBox="0 0 760 80" role="img" aria-label="One drawing">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"><path d="M0 0L10 5L0 10z" fill="var(--dg-rule)"/></marker></defs>
<script>alert(1)</script>
<line x1="24" y1="40" x2="200" y2="40" stroke="var(--dg-rule)" marker-end="url(#arrow)" onclick="alert(2)"/>
</svg>
\`\`\`

\`\`\`svg
<svg viewBox="0 0 760 80" role="img" aria-label="Another drawing">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"><path d="M0 0L10 5L0 10z" fill="var(--dg-accent)"/></marker></defs>
<line x1="24" y1="40" x2="200" y2="40" stroke="var(--dg-accent)" marker-end="url(#arrow)"/>
</svg>
\`\`\`

\`\`\`svg
<svg viewBox="0 0 760 80"><g></svg>
\`\`\`

<div id="written-in">
<script>document.documentElement.dataset.ran = "a script";</script>
<img src="/written-in.png" alt="" onerror="document.documentElement.dataset.ran = 'a handler'">
<a id="written-link" href="javascript:void(document.documentElement.dataset.ran = 'a link')">a link</a>
<form id="written-form" action="/written-in" method="post"><button>Send</button></form>
<base href="https://example.com/">
</div>
`,
  "Scratch.md": `# Scratch

Not public.
`,
};

/** Who wrote and published the seed: a member id, as every `by` is. */
export const SEED_BY = "m-5eed0001";

/** The public map over those files. */
export const SEED_PUBLIC = {
  home: { kind: "file", file: fidOf("Home.md"), path: "Home.md", root: true, by: SEED_BY, at: 1757000000000 },
  plan: { kind: "file", file: fidOf("Projects/plan.md"), path: "Projects/plan.md", by: SEED_BY, at: 1757000001000 },
  projects: {
    kind: "dir",
    path: "Projects",
    title: "Projects",
    desc: "Everything we're building",
    by: SEED_BY,
    at: 1757000002000,
  },
  ship: { kind: "file", file: fidOf("Projects/Roadmap/Ship the boat.md"), path: "Projects/Roadmap/Ship the boat.md", by: SEED_BY, at: 1757000003000 },
  ideas: { kind: "file", file: fidOf("Ideas.md"), path: "Ideas.md", by: SEED_BY, at: 1757000003000 },
  sizes: { kind: "file", file: fidOf("Sizes.md"), path: "Sizes.md", by: SEED_BY, at: 1757000003000 },
  comments: { kind: "file", file: fidOf("Comments.md"), path: "Comments.md", by: SEED_BY, at: 1757000003000 },
  diagram: { kind: "file", file: fidOf("Diagram.md"), path: "Diagram.md", by: SEED_BY, at: 1757000003000 },
  // Deleted last week; the page 404s until the file is back. Kept on purpose.
  ghost: { kind: "file", file: "f-gone", path: "Old.md", by: SEED_BY, at: 1757000003000 },
};

const contentTypeOf = (path) =>
  path.endsWith(".html") ? "text/html" : path.endsWith(".jsonl") ? "application/jsonl" : "text/markdown";

/** The manifest's file entries plus the blobs to upload for them. */
export function seedManifestFiles(files = SEED_FILES) {
  const entries = {};
  const blobs = [];
  let i = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const fid = fidOf(path);
    const hash = blobHash(bytes);
    entries[fid] = { path, rev: 1, hash, size: bytes.length, mtime: 1757000000000 + i * 60000, by: SEED_BY };
    blobs.push({ fid, hash, bytes, contentType: contentTypeOf(path) });
    i += 1;
  }
  return { entries, blobs };
}

/**
 * Load the seed through the worker's API, as the engine would: bind the
 * domain if it is free, upload every blob, then compare-and-swap the manifest
 * on top of whatever it holds. `token` is a superadmin's device sign-in — a
 * bind is theirs. Answers the manifest etag.
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
    body: JSON.stringify({ version: 4, name, seq, files: entries, tombstones: {}, public: publicMap }),
  });
  if (put.status !== 200) throw new Error(`manifest failed: ${put.status} ${await put.text()}`);
  return (await put.json()).etag;
}
