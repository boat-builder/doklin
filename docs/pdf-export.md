# PDF export (HTML renditions)

One button on the HTML view. It reproduces the rendition exactly — same page
dimensions, same fonts and wrapping, backgrounds intact, text as selectable
vectors, nothing scaled — and **refuses to emit a PDF it can detect is
wrong**. Same input, same bytes, on any machine. The exporter never repairs a
broken document; a document that overflows in the browser fails the export
with a specific error instead of shipping with content missing.

Implementation: `src-tauri/src/pdf_export.rs`. UI: the `PDF` button in
`src/HtmlView.tsx` (desktop only — web share hosts don't get the prop),
which docks into the host's chrome next to the MD/HTML switcher — the tab
bar with one pane open, the pane's own header when split — rather than
standing on the rendition (see `controlsSlot`).
Output lands as `<stem>.pdf` next to the document, replacing a previous
export of the same document.

## Why not the app's own webview

WKWebView's engine version rides the user's macOS (unpinnable → not
deterministic across machines) and exposes no `printToPDF`-style API with
background/scale/`@page` control. So exports render in a **pinned
`chrome-headless-shell`** (Chrome for Testing), driven from Rust over the
DevTools protocol — no Node or Playwright ships with the app.

- Downloaded on first export (like the WhisperKit models): ~93 MB zip from
  the immutable Chrome-for-Testing bucket, sha256-verified, unpacked to
  `~/Library/Application Support/com.sherin.doklin/pdf-engine/<version>/`.
- Fresh browser profile per export, killed and cleaned afterwards. Network is
  allowed (documents may pull webfonts); everything else is pinned: flags,
  viewport, srgb, software GL, `TZ=UTC`, `--lang=en-US`.
- `DOKLIN_PDF_ENGINE=/path/to/chrome-headless-shell` overrides the managed
  engine (dev + tests).

## Page sizing

| Case | Behaviour |
|---|---|
| Document declares `@page { size: … }` | Used verbatim (`preferCSSPageSize`). Detected from inline `<style>` and same-directory linked stylesheets; remote CSS is not scanned. |
| No `@page` size | Content bounding box measured in **print media**, emitted as a single custom-size page (px → pt at 96 dpi, +2 px height slack so rounding can't spill a blank page). |

Margins 0, `scale: 1`, `printBackground: true`, viewport grown to content
(measured to a fixed point, since growing the viewport can reflow
width-responsive layouts).

## Fonts

- The app bundles **Carlito** (OFL, `src-tauri/fonts/carlito/`) and injects
  it as data-URI `@font-face` under both `Carlito` and `Calibri`
  (metric-identical), skipping families the document declares itself. Text
  asking for Calibri wraps identically on every machine.
- **Font gate**: after layout, `CSS.getPlatformFontsForNode` reports the
  actual rendered font for one element per distinct font-family stack. If the
  first concrete (non-generic) requested family didn't win, the export is
  refused, naming the family, the substitute, and the element. Documents
  whose stacks are generics-only (`system-ui, sans-serif`) pass — the author
  sanctioned the platform's choice.
- Webfonts the document loads itself (e.g. Google Fonts) count as the
  requested family. Offline, such a document fails loudly instead of
  exporting with substituted metrics.

## Wait conditions (all must hold before capture)

Load event → fidelity CSS injected (`print-color-adjust: exact`, animations
and transitions killed, `prefers-reduced-motion: reduce`,
`prefers-color-scheme: light`) → network idle (500 ms quiet, 30 s cap) →
`document.fonts.ready` → every `img.decode()` (a failing decode refuses the
export, naming the image) → every same-document SVG `<use>` target present →
two rAF ticks.

## Validation gate (after render, before the file appears)

1. **Page count** — documents with explicit page containers (`.page`,
   `.pdf-page`, `[data-pdf-page]` — the corpus convention) must produce
   exactly that many pages; a no-`@page` document must produce exactly one.
   (`@page` without containers: count isn't DOM-predictable, check skipped.)
2. **Page dimensions** — every page's MediaBox within ±0.5 mm of expected.
3. **No blank pages** — every page's content stream draws something.
4. **Vector text** — a document with visible text must yield extractable text.
5. **Content completeness** — ~24 text samples spread across the print DOM
   (always including the tail) must survive into the extracted text,
   whitespace/ligature-normalized. Catches content dropped off a page edge.
6. **Visual diff** — every PDF page rasterized at 96 dpi through **pinned
   pdfium** (153.0.8009.0, ~3.4 MB, downloaded and hash-verified like the
   engine) and compared against the browser's own painting of that page
   region: grayscale → 2× downscale → 3×3 blur → |Δluma| > 32, failing past
   0.5% differing pixels. This is the check that sees **print-pipeline
   divergence** nothing text-based can: fixed-position elements the print
   pass repeats on every page, content silently cut at a page boundary,
   print-relayout shifts, rendering omissions. Measured margins: good
   documents show 0.00–0.12% noise; a genuinely divergent page measures
   ~8.7% (`DOKLIN_PDF_DIFF_DEBUG=1` prints per-page fractions). Regions are
   DOM-predictable exactly where the page-count check is: page-sized
   containers, or the whole content box; a flowing `@page` document skips
   this check (the others still run). Note what it deliberately does *not*
   flag: a document-internal overlap renders identically in both — that's
   faithful reproduction of a broken document, which is the contract.

On any failure the temp file is discarded and the error names the check (and
page): `page 2: rendered output diverges from the browser rendering (8.68%
of pixels differ, threshold 0.50%)`. The destination is written only by
atomic rename after every check passes.

## Determinism

Pinned engine + pinned flags + bundled fonts + fresh profile, then the PDF is
normalized: creation/mod dates dropped, document ID zeroed, and Chromium's
run-varying tagged-PDF `node…` structure IDs renumbered from 1 (they're
load-bearing — table headers reference them — so they're renumbered, not
stripped). Verified: two exports byte-compare in CI-able tests. Documents
that render wall-clock time via JS are different input by definition.

## Tests

```bash
# fast unit tests (parsers, normalizers, the diff comparator)
cargo test --lib pdf_export

# the real thing: pinned engine + pdfium, 7 scenarios incl. byte-determinism
# and all three refusal paths (font, page count, visual divergence)
DOKLIN_PDF_ENGINE=/path/to/chrome-headless-shell \
DOKLIN_PDFIUM=/path/to/libpdfium.dylib \
  cargo test --test pdf_export_e2e -- --ignored --test-threads=1
```

`webfont_document_waits_and_passes_the_font_gate` needs network. Add
`DOKLIN_PDF_DIFF_DEBUG=1 … --nocapture` to print per-page diff fractions.

## Upgrading the engine (or pdfium)

Chromium does not promise stable pagination across versions, and the diff
yardstick must not drift either. Treat a bump of either as a rendering
change:

1. Engine: pick a version from
   https://googlechromelabs.github.io/chrome-for-testing/ and update
   `ENGINE_VERSION`, `ENGINE_URL`, `ENGINE_SHA256` (sha256 of the downloaded
   `chrome-headless-shell-mac-arm64.zip`), `ENGINE_ZIP_BYTES`. pdfium: pick a
   release from bblanchon/pdfium-binaries and update the `PDFIUM_*`
   constants the same way.
2. Re-run the e2e suite against the new binaries, with
   `DOKLIN_PDF_DIFF_DEBUG=1` — the noise floor must stay well under
   `DIFF_FAIL_FRACTION`.
3. Eyeball a real rendition export before shipping.

Old versions stay on disk under `pdf-engine/`; stale ones can be deleted
manually (they're only ever addressed by pinned version).
