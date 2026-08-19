# Feature spec: "Download PDF" on share pages

Status: **proposed** (follow-up to [pdf-export.md](pdf-export.md), which is
implemented). Written 2026-08-19.

## Goal

A viewer of a doklin.cc share page gets a **Download PDF** button that serves
the exact validated artifact — byte-identical to what a local export
produces — with zero server-side rendering.

## Why this shape

The PDF must come from the pinned engine or it isn't the deterministic
artifact the export contract promises. Cloudflare Browser Rendering can't pin
a Chromium version, and server-side rendering would push document content
through another rendering service for no benefit. The desktop app already
owns the pinned engine, so the PDF becomes a **third rendition pushed at
share time**, exactly like the md and html renditions it derives from.

## Non-goals

- Rendering PDFs for documents the app never pushed (no on-demand worker
  rendering, ever).
- PDF for markdown-only shares. The PDF is a rendition *of the html
  rendition*; no html, no PDF.
- Any per-share configuration beyond the single attach-PDFs decision below.

## Mechanics

### Render at push, not at view

The push path already fingerprints what it uploaded per rendition
(`share.ts` `pushed: { md, html }`). Add `pdf`, keyed on the **html hash it
was rendered from** — not the pdf bytes — so reconciliation can answer "is
the remote PDF stale?" without re-rendering:

- Push sees html fingerprint changed → run the local export pipeline
  (`pdf_export::run_export` is already a library call).
- Gate passes → upload the PDF as rendition kind `pdf` in the same push
  cycle, record `pushed.pdf = { htmlHash }`.
- Gate refuses → html pushes anyway; the refusal surfaces in the app (the
  same error card the export button uses); the share page simply has no
  button.

### Never serve a stale PDF

The invariant, in the same spirit as the exporter's "refuse rather than emit
wrong bytes": **absence over wrongness.**

- The push that uploads changed html **deletes the remote pdf rendition
  first** (or atomically in the same worker call — see worker contract),
  then re-attaches a fresh one only after the gate passes.
- The share page's button is manifest-driven: no pdf rendition listed, no
  button. A page mid-update shows no button rather than yesterday's PDF.

### Worker contract

- One more R2 object per shared entity (`<id>/pdf`), served with
  `Content-Disposition: attachment; filename="<stem>.pdf"` and the html
  rendition's cache story.
- Manifest entries gain an optional `pdf` marker the shell reads to render
  the button.
- `WORKER_FEATURES` gains `"pdf-rendition"`. The app withholds pdf pushes
  from workers that don't advertise it (self-hosted instances update through
  the existing WorkerUpdate flow), so old backends keep working untouched.
- `WORKER_VERSION` bump for the shell change (the button) — the usual rule.

### Engine availability (decision to confirm)

Pushing from a machine that has never exported a PDF has no engine
(~93 MB) or pdfium (~3 MB) installed. Recommended behaviour:

- If the engine is already installed: attach PDFs automatically. No setting.
- If not: the first push of a shareable html rendition offers the one-time
  engine download once ("Shares can include a validated PDF — download the
  export engine?"), remembered either way. Never download silently on the
  sync path.

### Interactions with existing machinery

- **Subrequest budget**: one more upload per changed entity per sync cycle;
  the worker-side budget guard from the cloud-sync work must count it.
- **Unshare/delete**: remote mirrors disk — deleting or unsharing the
  document removes the pdf rendition with everything else. No special case.
- **Comments/meta**: PDFs render from the *pristine* rendition; comment
  markers never appear (the export pipeline reads the disk file, which keeps
  bare markers only, and the bridge instrumentation never touches it).
- **Multi-device**: a second device pushing an html change without an engine
  follows the availability rule above; the delete-then-attach ordering means
  it can safely strip the stale pdf even when it can't produce a new one.

## Failure modes

| Situation | Behaviour |
|---|---|
| Gate refuses at push time | html pushes; refusal surfaces in-app; page has no button |
| Engine missing | per the availability decision; stale pdf still stripped |
| Upload fails after html push | pdf fingerprint stays unset → next cycle retries render+upload |
| Worker lacks `pdf-rendition` | app never attempts pdf uploads |

## Effort

Worker changes (serve + manifest flag + feature advertisement) are small.
The app-side push plumbing — `pushed.pdf` fingerprint, delete-then-attach
ordering, the render hook and its error surfacing — is the bulk. UI is a
button. Roughly a third of the exporter itself, since render/validate is a
library call now.
