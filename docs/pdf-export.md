# PDF export

HTML rendition → `<stem>.pdf` beside it: `src-tauri/src/pdf_export.rs`
(`export_pdf`). A PDF the gate can tell is wrong is refused, never repaired.

## Engine

- Pinned `chrome-headless-shell` (Chrome for Testing) over a hand-rolled CDP
  client. Not WKWebView: its engine rides macOS and it has no `printToPDF`.
- Engine and pdfium download on first export, sha256-verified, into
  `<app data>/pdf-engine/`. Overrides: `DOKLIN_PDF_ENGINE`, `DOKLIN_PDFIUM`.
- Bundled Carlito is injected under `Carlito` and `Calibri`.
- Page size: a source `@page { size }` (inline or same-folder CSS) is used
  verbatim; otherwise one page sized to the print-media content box.
- pdfium binds once per process (`pdfium_instance`). `lopdf` needs
  `default-features = false`.

## Wait conditions

Load event → fidelity CSS → network idle (500 ms quiet, 30 s cap) →
`document.fonts.ready` → every `img.decode()` → every same-document SVG
`<use>` target → two rAF ticks. A failed decode or missing `<use>` target
refuses.

## Validation gate

Runs on the normalized bytes; the temp file is renamed into place only after
every check passes. Each refusal names its check (and page):

- **font**: each stack's first concrete family must be what rendered
  (`CSS.getPlatformFontsForNode`); generic-only stacks pass.
- **page count**: `.page, .pdf-page, [data-pdf-page]` containers, or 1
  without `@page`; skipped for `@page` without containers.
- **size**: every MediaBox within ±0.5 mm.
- **blank**: every page draws something.
- **text / content**: visible text is extractable, and DOM text samples
  survive into it.
- **visual**: each page rasterized by pinned pdfium vs the browser's
  screenshot of that region; fails past `DIFF_FAIL_FRACTION` (0.5%) of
  pixels. Skipped for flowing `@page` documents.

## Determinism

`normalize_pdf` drops CreationDate/ModDate, zeroes the document ID, and
renumbers Chromium's run-varying `nodeNNNNNNNN` structure IDs from 1. They
are referenced (table headers, IDTree): renumber, never strip.

## Tests

```bash
cargo test --lib pdf_export
DOKLIN_PDF_ENGINE=/path/to/chrome-headless-shell \
DOKLIN_PDFIUM=/path/to/libpdfium.dylib \
  cargo test --test pdf_export_e2e -- --ignored --test-threads=1
```

The webfont test needs network. `DOKLIN_PDF_DIFF_DEBUG=1` with
`--nocapture` prints per-page diff fractions.

## Upgrading the engine or pdfium

A bump is a rendering change.

1. Engine: a Chrome for Testing version → `ENGINE_VERSION`, `ENGINE_URL`,
   `ENGINE_SHA256` (of `chrome-headless-shell-mac-arm64.zip`),
   `ENGINE_ZIP_BYTES`. pdfium: a bblanchon/pdfium-binaries release →
   `PDFIUM_URL`, `PDFIUM_DIR`, `PDFIUM_SHA256`, `PDFIUM_TGZ_BYTES`.
2. Re-run e2e with `DOKLIN_PDF_DIFF_DEBUG=1`; noise must stay well under
   `DIFF_FAIL_FRACTION`.
3. Eyeball a real export.
