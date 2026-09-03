# Feature spec: "Download PDF" on public pages

Status: **proposed** (follow-up to [pdf-export.md](pdf-export.md), which is
implemented). Written 2026-08-19 against the previous cloud, where a page
was pushed; re-shaped 2026-09-03 for the one-domain-per-workspace design
([cloud.md](cloud.md)), where a public page is rendered from synced files
and nothing is pushed.

## Goal

A visitor to a published note gets a **Download PDF** button that serves
the exact validated artifact — byte-identical to what a local export
produces — with zero server-side rendering.

## Why this shape

The PDF must come from the pinned engine or it isn't the deterministic
artifact the export contract promises. Cloudflare Browser Rendering can't
pin a Chromium version, and server-side rendering would push document
content through another rendering service for no benefit. The desktop app
already owns the pinned engine, and its export already writes `<stem>.pdf`
beside the document — a file, which a connected workspace syncs like any
other. So the PDF is **a synced file the worker serves**, exactly like the
html rendition it is derived from.

## Non-goals

- Rendering PDFs the app never exported (no on-demand worker rendering,
  ever).
- A PDF for a note with no html rendition. The PDF is a rendition *of the
  html rendition*; no html, no PDF.
- Any per-page configuration.

## Mechanics

### The file is the artifact

- The export writes `<stem>.pdf` next to the document (today's behaviour).
  The engine syncs it; the manifest lists it beside `<stem>.md` and
  `<stem>.html`.
- The worker already serves a PDF inside a published folder by its exact
  path (`/<dirSlug>/<rel>.pdf`). What is new: a published note answers at
  `/<slug>/pdf` when the workspace holds `<stem>.pdf` beside it, with
  `Content-Disposition: attachment; filename="<stem>.pdf"`, and the note's
  page shows the button. Both fall out of the manifest — no state of their
  own, cached by etag like every render.

### Never serve a stale PDF

The invariant, in the same spirit as the exporter's "refuse rather than
emit wrong bytes": **absence over wrongness.** A PDF exported from an older
rendition must not be offered as the current one.

- The export records the sha256 of the html it rendered from in the entity
  meta sidecar (`<stem>.meta.jsonl`, one `pdf` record — the sidecar already
  holds per-document records that sync line by line, the `tcols` widths
  among them).
- The worker shows the button, and answers `/<slug>/pdf`, only when that
  record's hash equals the html blob's hash in the manifest. A page whose
  html moved on shows no button rather than yesterday's PDF; the next
  export catches it up.
- Nothing is deleted on the app's side: the stale file is a stale file
  beside the note, exactly as it is today after an html edit.

### Keeping it fresh

- The export button stays manual (today). A follow-up could re-export on
  the html rendition's autosave when the engine is installed — the same
  gate, the same refusal surfacing in-app — but that is a decision about
  the desktop's export, not about publishing, and a PDF that lags is
  simply absent on the page.
- A machine without the engine (~93 MB) or pdfium (~3 MB) never exports;
  nothing on the sync path downloads silently.

### Worker contract

- `GET /<slug>/pdf` and the button. `WORKER_FEATURES` gains `"pdf"`; the
  version integer bumps as usual so an older worker is offered the update.
- The meta sidecar's `pdf` record: `{"t":"pdf","html":"<sha256>","at":…}`,
  read with the same `metaFile.ts` the widths come from.

## Failure modes

| Situation | Behaviour |
|---|---|
| Gate refuses at export time | no PDF is written; the refusal surfaces in-app; the page has no button |
| Html edited after the export | hashes differ → no button until the next export |
| Engine missing | no export, no button |
| The PDF is deleted or the sidecar record lost | no button; the file's absence is the truth |

## Effort

The worker side is a route, a hash comparison and a button. The app side is
one record written by the export. A small fraction of the exporter itself.
