//! Faithful, deterministic HTML → PDF export for the rendition view.
//!
//! The app's own webview (WKWebView) can't do this: its engine version is
//! tied to the user's macOS (no pinning, so no cross-machine determinism)
//! and it exposes no printToPDF-style API with background/scale/@page
//! control. So exports render in a PINNED headless Chromium
//! (chrome-headless-shell, the Chrome-for-Testing build made for exactly
//! this), downloaded once on first export — like the WhisperKit models —
//! sha256-verified, and driven from here over the DevTools protocol. No
//! Node/Playwright ships with the app; the CDP client below is the ~10
//! methods we need, hand-rolled over a websocket.
//!
//! The contract (docs/pdf-export.md): reproduce the document exactly —
//! same page size, same fonts and wrapping, backgrounds intact, nothing
//! scaled — and REFUSE to emit a PDF we can detect is wrong. The exporter
//! never repairs a broken document; it renders faithfully and validates
//! mechanically. On any failed check the temp file is discarded and the
//! error names the check (and page) that failed. A silently-wrong PDF is
//! worse than no PDF.
//!
//! Determinism levers: pinned engine version + hash; fixed flags, viewport,
//! locale, timezone, color profile; software GL (--disable-gpu) so canvas
//! content rasterizes identically on every machine; a bundled Carlito pack
//! injected as @font-face (Calibri-aliased — metric-identical) so text
//! metrics never depend on which fonts a host happens to have; and PDF
//! metadata (creation dates, doc ID) normalized after render so the same
//! input produces byte-comparable output.
//!
//! Upgrading ENGINE_VERSION changes layout in ways Chromium doesn't promise
//! to keep stable — treat a bump like a rendering change and re-verify the
//! fixture corpus (`DOKLIN_PDF_ENGINE=... cargo test -- --ignored pdf_e2e`).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use lopdf::{Document, Object, ObjectId};
use pdfium_render::prelude::{PdfColor, PdfRenderConfig, Pdfium};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

// ---------------------------------------------------------------------------
// Pinned engine. The zip is fetched from Chrome for Testing (immutable,
// versioned artifacts) and verified against this hash before unpacking, so
// every machine renders with byte-identical engine code. Bump = re-verify.
// ---------------------------------------------------------------------------
const ENGINE_VERSION: &str = "152.0.7977.42";
const ENGINE_URL: &str = "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.42/mac-arm64/chrome-headless-shell-mac-arm64.zip";
const ENGINE_SHA256: &str = "4cca5044201c5472469d26bef44a24aa2ec2e0ce2d1ef4959b8dae3fa662cec1";
const ENGINE_ZIP_BYTES: u64 = 97_949_765; // progress fallback if no Content-Length

// Pinned PDF rasterizer for the visual-diff check (spec §6.6): pdfium — the
// same PDF library Chrome ships — prebuilt at bblanchon/pdfium-binaries.
// Pinned and hash-verified like the engine; the yardstick must not drift
// under us either. Upgrade alongside ENGINE_VERSION and re-verify.
const PDFIUM_URL: &str = "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8009/pdfium-mac-arm64.tgz";
const PDFIUM_DIR: &str = "pdfium-8009"; // pdfium 153.0.8009.0
const PDFIUM_SHA256: &str = "b1f2f17c7432a9942514dda5094ee9822c743bdfd07e7187725efbd34fde941f";
const PDFIUM_TGZ_BYTES: u64 = 3_459_591;

// The corpus convention for "how many pages should this document print as":
// documents that paginate carry explicit page containers. No containers +
// no @page rule = a single content-sized page.
const PAGE_CONTAINER_SELECTOR: &str = ".page, .pdf-page, [data-pdf-page]";

// Validation tolerance for page dimensions: ±0.5 mm, in PDF points.
const SIZE_TOLERANCE_PT: f64 = 0.5 * 72.0 / 25.4;

// Visual-diff tunables. Chromium's screenshot path and pdfium antialias the
// same embedded fonts differently, so pages are compared as grayscale,
// downscaled 2× (subpixel glyph halos melt; real content keeps its area
// fraction), blurred 3×3, and a pixel only counts past a solid luminance
// gap. Measured on the fixtures: good documents 0.00–0.12% differing
// pixels; a genuinely divergent page (print-repeated fixed banner) 8.7%.
// The fail line sits ~4× above the worst noise and ~17× below that signal.
// DIFF_MIN_PIXELS keeps postcard-sized pages from failing on a handful of
// noisy pixels. Re-measure (DOKLIN_PDF_DIFF_DEBUG=1) when bumping the
// engine or pdfium.
const DIFF_LUMA_THRESHOLD: f32 = 32.0; // of 255
const DIFF_FAIL_FRACTION: f64 = 0.005; // 0.5% of compared (downscaled) pixels
const DIFF_MIN_PIXELS: usize = 100; // at the downscaled resolution

// Bundled font pack (OFL — see fonts/carlito/OFL.txt). Carlito is the
// metric-identical open substitute for Calibri; injecting it under BOTH
// names means "font-family: Calibri" wraps identically on every machine,
// Office installed or not. A document that ships its own face for one of
// these families keeps it — injection skips families the document declares.
static CARLITO_REGULAR: &[u8] = include_bytes!("../fonts/carlito/Carlito-Regular.ttf");
static CARLITO_BOLD: &[u8] = include_bytes!("../fonts/carlito/Carlito-Bold.ttf");
static CARLITO_ITALIC: &[u8] = include_bytes!("../fonts/carlito/Carlito-Italic.ttf");
static CARLITO_BOLD_ITALIC: &[u8] = include_bytes!("../fonts/carlito/Carlito-BoldItalic.ttf");

// ---------------------------------------------------------------------------
// Tauri surface
// ---------------------------------------------------------------------------

/// One export at a time, process-wide: the engine launch, the render, and
/// the validation are all heavyweight, and two exports of the same document
/// would race on the output file.
#[derive(Default)]
pub struct PdfExportLock(pub tokio::sync::Mutex<()>);

#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    lock: State<'_, PdfExportLock>,
    path: String,
) -> Result<String, String> {
    let _guard = lock
        .0
        .try_lock()
        .map_err(|_| "A PDF export is already running.".to_string())?;

    let html = PathBuf::from(&path);
    if !html.is_absolute() || html.extension().map_or(true, |e| !e.eq_ignore_ascii_case("html")) {
        return Err("PDF export needs the absolute path of an .html rendition.".to_string());
    }
    if !html.is_file() {
        return Err(format!("rendition not found on disk: {}", html.display()));
    }

    let engine = ensure_engine(&app).await?;
    let pdfium = ensure_pdfium(&app).await?;

    let out = html.with_extension("pdf");
    let emitter = app.clone();
    let progress = move |stage: &str, pct: Option<u8>| {
        let _ = emitter.emit("pdf-export-progress", json!({ "stage": stage, "pct": pct }));
    };

    // Overall watchdog: a wedged engine must not hold the lock forever.
    let report = tokio::time::timeout(
        Duration::from_secs(240),
        run_export(&engine, &pdfium, &html, &out, progress),
    )
    .await
    .map_err(|_| "export timed out after 240s".to_string())??;

    Ok(report.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Engine manager: ~/Library/Application Support/<app>/pdf-engine/<version>/…
// Download → sha256 verify → unpack into a staging dir → atomic rename, so a
// crashed download never leaves a half-engine at the final path. The env
// override DOKLIN_PDF_ENGINE (path to the binary) serves dev and the e2e
// tests, which point at a locally unpacked copy.
// ---------------------------------------------------------------------------

async fn ensure_engine(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("DOKLIN_PDF_ENGINE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("DOKLIN_PDF_ENGINE points at nothing: {}", p.display()));
    }

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("pdf-engine");
    let version_dir = base.join(ENGINE_VERSION);
    let bin = version_dir
        .join("chrome-headless-shell-mac-arm64")
        .join("chrome-headless-shell");
    if bin.is_file() {
        return Ok(bin);
    }

    std::fs::create_dir_all(&base).map_err(|e| format!("cannot create {}: {e}", base.display()))?;
    let emit = |stage: &str, pct: Option<u8>| {
        let _ = app.emit("pdf-export-progress", json!({ "stage": stage, "pct": pct }));
    };

    let zip_path = base.join(format!("download-{}.zip.part", rand_suffix()));
    download_verified(
        app,
        "engine-download",
        ENGINE_URL,
        ENGINE_SHA256,
        ENGINE_ZIP_BYTES,
        &zip_path,
    )
    .await?;

    emit("engine-unpack", None);
    let staging = base.join(format!("staging-{}", rand_suffix()));
    let zip2 = zip_path.clone();
    let staging2 = staging.clone();
    // ditto preserves permission bits and symlinks the way Apple tools expect;
    // the zip was fetched by us (no quarantine xattr), so the binary just runs.
    let unpack = tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("ditto")
            .arg("-xk")
            .arg(&zip2)
            .arg(&staging2)
            .output()
            .map_err(|e| format!("ditto failed to start: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ditto failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("unpack task died: {e}"))?;
    let _ = std::fs::remove_file(&zip_path);
    unpack.map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        e
    })?;

    let staged_bin = staging
        .join("chrome-headless-shell-mac-arm64")
        .join("chrome-headless-shell");
    if !staged_bin.is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("engine zip did not contain chrome-headless-shell".to_string());
    }
    match std::fs::rename(&staging, &version_dir) {
        Ok(()) => {}
        Err(_) if bin.is_file() => {
            // Lost a race with another install (second window); theirs works.
            let _ = std::fs::remove_dir_all(&staging);
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("cannot install engine: {e}"));
        }
    }
    Ok(bin)
}

/// The pinned pdfium dylib for the visual-diff check, managed exactly like
/// the engine (env override: DOKLIN_PDFIUM, path to libpdfium.dylib).
async fn ensure_pdfium(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("DOKLIN_PDFIUM") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("DOKLIN_PDFIUM points at nothing: {}", p.display()));
    }

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("pdf-engine");
    let lib = base.join(PDFIUM_DIR).join("lib").join("libpdfium.dylib");
    if lib.is_file() {
        return Ok(lib);
    }

    std::fs::create_dir_all(&base).map_err(|e| format!("cannot create {}: {e}", base.display()))?;
    let tgz = base.join(format!("download-{}.tgz.part", rand_suffix()));
    download_verified(app, "pdfium-download", PDFIUM_URL, PDFIUM_SHA256, PDFIUM_TGZ_BYTES, &tgz)
        .await?;

    let staging = base.join(format!("staging-{}", rand_suffix()));
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("cannot create {}: {e}", staging.display()))?;
    let (tgz2, staging2) = (tgz.clone(), staging.clone());
    let unpack = tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("tar")
            .arg("-xzf")
            .arg(&tgz2)
            .arg("-C")
            .arg(&staging2)
            .output()
            .map_err(|e| format!("tar failed to start: {e}"))?;
        if !out.status.success() {
            return Err(format!("tar failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("unpack task died: {e}"))?;
    let _ = std::fs::remove_file(&tgz);
    unpack.map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        e
    })?;

    if !staging.join("lib").join("libpdfium.dylib").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("pdfium archive did not contain lib/libpdfium.dylib".to_string());
    }
    match std::fs::rename(&staging, base.join(PDFIUM_DIR)) {
        Ok(()) => {}
        Err(_) if lib.is_file() => {
            let _ = std::fs::remove_dir_all(&staging);
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("cannot install pdfium: {e}"));
        }
    }
    Ok(lib)
}

/// Stream a pinned artifact to `dest`, hashing as it lands; a hash mismatch
/// deletes the file and refuses. Progress rides the export event stream.
async fn download_verified(
    app: &AppHandle,
    stage: &str,
    url: &str,
    expected_sha: &str,
    size_hint: u64,
    dest: &Path,
) -> Result<(), String> {
    let emit = |pct: Option<u8>| {
        let _ = app.emit("pdf-export-progress", json!({ "stage": stage, "pct": pct }));
    };
    emit(Some(0));
    let client = reqwest::Client::new();
    let mut resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    let total = resp.content_length().unwrap_or(size_hint);
    let mut file =
        std::fs::File::create(dest).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    let mut last_pct: u8 = 0;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("download failed ({url}): {e}"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
        got += chunk.len() as u64;
        let pct = ((got.saturating_mul(100)) / total.max(1)).min(100) as u8;
        if pct != last_pct {
            last_pct = pct;
            emit(Some(pct));
        }
    }
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if digest != expected_sha {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "download hash mismatch for {url} (got {digest}, want {expected_sha}) — refusing to install"
        ));
    }
    Ok(())
}

fn rand_suffix() -> String {
    let mut b = [0u8; 4];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Export pipeline
// ---------------------------------------------------------------------------

/// What the render pass learned about the document — the validation gate
/// checks the emitted PDF against exactly this.
struct RenderFacts {
    /// Expected page size in PDF points (w, h).
    expected_pt: (f64, f64),
    /// Some(n) when the DOM predicts the page count (explicit containers, or
    /// the single content-sized page); None when @page paginates flowing
    /// content and the count can't be known from the DOM.
    expected_pages: Option<usize>,
    /// Visible text samples pulled from the print-media DOM, document order.
    samples: Vec<String>,
    /// PNG reference captures for the visual diff, one per expected PDF page
    /// in page order — empty when the document has no DOM-predictable page
    /// regions (flowing @page content, or containers that aren't page-sized).
    screenshots: Vec<Vec<u8>>,
}

/// Render `html` and write a validated PDF to `out`. Public (and
/// tauri-free apart from the runtime) so the e2e tests can drive it
/// against a local engine.
pub async fn run_export(
    engine_bin: &Path,
    pdfium_lib: &Path,
    html: &Path,
    out: &Path,
    progress: impl Fn(&str, Option<u8>),
) -> Result<PathBuf, String> {
    progress("rendering", None);
    let (pdf, facts) = render(engine_bin, html).await?;

    progress("validating", None);
    // Normalize BEFORE validating so the gate judges the exact bytes we ship.
    let pdf = normalize_pdf(&pdf)?;
    validate(&pdf, &facts, pdfium_lib)?;

    // Never leave a partial file at the destination: temp in the same dir
    // (same filesystem → atomic rename), promoted only after every check.
    let dir = out.parent().ok_or("output path has no parent directory")?;
    let tmp = dir.join(format!(
        ".{}.pdf-export-{}",
        out.file_stem().and_then(|s| s.to_str()).unwrap_or("export"),
        rand_suffix()
    ));
    std::fs::write(&tmp, &pdf).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot move export into place: {e}")
    })?;
    Ok(out.to_path_buf())
}

async fn render(engine_bin: &Path, html: &Path) -> Result<(Vec<u8>, RenderFacts), String> {
    // The @page decision (spec §2) comes from the source, not the engine:
    // declared size → use it verbatim; none → content-sized custom page.
    let at_page_pt = at_page_size(html)?;

    let engine = Engine::launch(engine_bin)?;
    let mut cdp = Cdp::connect(&engine).await?;

    cdp.call("Page.enable", json!({})).await?;
    cdp.call("Network.enable", json!({})).await?;
    cdp.call("DOM.enable", json!({})).await?;
    cdp.call("CSS.enable", json!({})).await?;
    // Print media BEFORE any measurement — print stylesheets change layout.
    // Motion off and a fixed color scheme keep capture deterministic.
    cdp.call(
        "Emulation.setEmulatedMedia",
        json!({ "media": "print", "features": [
            { "name": "prefers-reduced-motion", "value": "reduce" },
            { "name": "prefers-color-scheme", "value": "light" },
        ]}),
    )
    .await?;
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": false }),
    )
    .await?;

    let url = url::Url::from_file_path(html)
        .map_err(|_| format!("not a valid file path: {}", html.display()))?;
    cdp.call("Page.navigate", json!({ "url": url.as_str() })).await?;
    cdp.wait_event("Page.loadEventFired", Duration::from_secs(30))
        .await
        .map_err(|_| "document never finished loading (30s)".to_string())?;

    // Inject the fidelity CSS (print-color-adjust, animations off) and the
    // font pack, then let the network settle — the injection itself can kick
    // off no fetches (data: URIs), but the document's own webfonts/images may
    // still be streaming.
    let inject = INJECT_JS.replace("__DK_FACES__", &font_faces_json());
    cdp.eval(&inject, false).await?;
    cdp.wait_network_idle(Duration::from_millis(500), Duration::from_secs(30))
        .await?;

    // Spec §4: fonts ready, every image decoded, every same-document SVG
    // <use> resolved, then two rAF ticks. Decode failures and dangling
    // references are refusals, not warnings.
    let settled: Value = parse_json_result(cdp.eval(SETTLE_JS, true).await?)?;
    let bad_images: Vec<String> = string_vec(&settled["badImages"]);
    if !bad_images.is_empty() {
        return Err(format!(
            "image check: {} image(s) failed to decode, first is '{}'",
            bad_images.len(),
            bad_images[0]
        ));
    }
    let bad_uses: Vec<String> = string_vec(&settled["badUses"]);
    if !bad_uses.is_empty() {
        return Err(format!(
            "svg check: {} <use> reference(s) point at nothing, first is '{}'",
            bad_uses.len(),
            bad_uses[0]
        ));
    }

    // Measure to a fixed point: growing the viewport to the content can
    // reflow the content (width-responsive layouts), so re-measure until
    // stable. The final pass leaves the viewport at least content-sized —
    // nothing lazy-renders or collapses (spec §2).
    let measure = measure_js();
    let mut measured: Value = parse_json_result(cdp.eval(&measure, false).await?)?;
    for _ in 0..3 {
        let w = measured["w"].as_f64().unwrap_or(0.0);
        let h = measured["h"].as_f64().unwrap_or(0.0);
        cdp.call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": (w.ceil() as u64).clamp(1, 16000),
                "height": (h.ceil() as u64).clamp(1, 16000),
                "deviceScaleFactor": 1, "mobile": false
            }),
        )
        .await?;
        cdp.eval(RAF_JS, true).await?;
        let again: Value = parse_json_result(cdp.eval(&measure, false).await?)?;
        let stable = again["w"] == measured["w"] && again["h"] == measured["h"];
        measured = again;
        if stable {
            break;
        }
    }
    let content_px = (
        measured["w"].as_f64().unwrap_or(0.0).ceil(),
        measured["h"].as_f64().unwrap_or(0.0).ceil(),
    );
    if content_px.0 < 1.0 || content_px.1 < 1.0 {
        return Err("document has no measurable content in print media".to_string());
    }
    let containers = measured["containers"].as_u64().unwrap_or(0) as usize;
    let samples = string_vec(&measured["samples"]);

    // The font gate (spec §3): every sampled element's dominant rendered
    // font must be a family the document actually asked for (bundled pack
    // and Calibri↔Carlito aliasing included). Substituted metrics = wrong
    // wrapping = refuse.
    check_fonts(&mut cdp, &measured["fonts"]).await?;

    // Page geometry (spec §2). @page wins verbatim; otherwise the measured
    // content box becomes the page, with 2px of height slack so float→layout
    // rounding can't spill a final empty page.
    let (paper_pt, expected_pages) = match at_page_pt {
        Some(size) => (size, (containers > 0).then_some(containers)),
        None => {
            let size = (content_px.0 * 0.75, (content_px.1 + 2.0) * 0.75); // px → pt at 96dpi
            (size, Some(if containers > 0 { containers } else { 1 }))
        }
    };

    // Reference captures for the visual diff (spec §6.6): the browser's own
    // painting of each page region, from the same settled DOM the PDF prints
    // from. Regions are DOM-predictable in exactly the cases the page-count
    // check covers — page-sized containers, or the whole content box of a
    // content-sized export. Flowing @page documents (and containers that
    // aren't page-sized) have no mappable regions; the diff is skipped there
    // and the other five checks stand alone.
    let mut regions: Vec<(f64, f64, f64, f64)> = Vec::new();
    match at_page_pt {
        None => regions.push((0.0, 0.0, content_px.0, content_px.1)),
        Some((w_pt, h_pt)) if containers > 0 => {
            let (w_px, h_px) = (w_pt / 0.75, h_pt / 0.75);
            let rects: Vec<Value> = measured["containerRects"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let page_sized = rects.len() == containers
                && rects.iter().all(|r| {
                    (r["w"].as_f64().unwrap_or(0.0) - w_px).abs() <= 3.0
                        && (r["h"].as_f64().unwrap_or(0.0) - h_px).abs() <= 3.0
                });
            if page_sized {
                for r in &rects {
                    regions.push((
                        r["x"].as_f64().unwrap_or(0.0),
                        r["y"].as_f64().unwrap_or(0.0),
                        r["w"].as_f64().unwrap_or(0.0),
                        r["h"].as_f64().unwrap_or(0.0),
                    ));
                }
            }
        }
        Some(_) => {}
    }
    if regions.iter().any(|r| r.2 > 12000.0 || r.3 > 12000.0) {
        regions.clear(); // beyond safe capture dimensions — diff degrades to skipped
    }
    let mut screenshots: Vec<Vec<u8>> = Vec::new();
    for (x, y, w, h) in &regions {
        let shot = cdp
            .call(
                "Page.captureScreenshot",
                json!({
                    "format": "png",
                    "captureBeyondViewport": true,
                    "clip": { "x": x, "y": y, "width": w, "height": h, "scale": 1 }
                }),
            )
            .await?;
        let png = shot["data"]
            .as_str()
            .ok_or("captureScreenshot returned no data")?;
        screenshots.push(
            B64.decode(png)
                .map_err(|e| format!("captureScreenshot returned undecodable data: {e}"))?,
        );
    }

    let result = cdp
        .call(
            "Page.printToPDF",
            json!({
                "landscape": false,
                "displayHeaderFooter": false,
                "printBackground": true,           // §3: fills, tints, coloured blocks
                "scale": 1,                          // §2: never shrink-to-fit
                "paperWidth": paper_pt.0 / 72.0,
                "paperHeight": paper_pt.1 / 72.0,
                "marginTop": 0, "marginBottom": 0, "marginLeft": 0, "marginRight": 0,
                "preferCSSPageSize": true,           // §2: a declared @page size wins
                "generateTaggedPDF": true,           // §3: accessibility structure
                "transferMode": "ReturnAsBase64"
            }),
        )
        .await?;
    let b64 = result["data"]
        .as_str()
        .ok_or("printToPDF returned no data")?;
    let pdf = B64
        .decode(b64)
        .map_err(|e| format!("printToPDF returned undecodable data: {e}"))?;

    Ok((
        pdf,
        RenderFacts {
            expected_pt: paper_pt,
            expected_pages,
            samples,
            screenshots,
        },
    ))
}

fn parse_json_result(v: Value) -> Result<Value, String> {
    let s = v.as_str().ok_or("in-page script returned a non-string")?;
    serde_json::from_str(s).map_err(|e| format!("in-page script returned invalid JSON: {e}"))
}

fn string_vec(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Font gate
// ---------------------------------------------------------------------------

/// CSS generics and system aliases: a document ending its stack with one of
/// these has sanctioned whatever the platform resolves it to.
const GENERIC_FAMILIES: &[&str] = &[
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji",
    "fangsong", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system",
    "blinkmacsystemfont",
];

fn norm_family(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_lowercase()
}

/// The first family in a computed font-family list that isn't a generic —
/// the one the author actually cares about. None = generics only.
fn first_concrete_family(list: &str) -> Option<String> {
    list.split(',')
        .map(norm_family)
        .find(|f| !f.is_empty() && !GENERIC_FAMILIES.contains(&f.as_str()))
}

/// Calibri and Carlito are metric-identical by design; either satisfies a
/// request for the other.
fn family_matches(requested: &str, rendered: &str) -> bool {
    if requested == rendered {
        return true;
    }
    matches!(
        (requested, rendered),
        ("calibri", "carlito") | ("carlito", "calibri")
    )
}

async fn check_fonts(cdp: &mut Cdp, fonts_meta: &Value) -> Result<(), String> {
    let entries = match fonts_meta.as_array() {
        Some(a) if !a.is_empty() => a.clone(),
        _ => return Ok(()), // no visible text — nothing to gate
    };
    // getPlatformFontsForNode needs the DOM agent to know the document.
    cdp.call("DOM.getDocument", json!({ "depth": 0 })).await?;

    for entry in entries {
        let idx = entry["i"].as_u64().unwrap_or(0);
        let requested = match entry["ff"].as_str().and_then(first_concrete_family) {
            Some(f) => f,
            None => continue, // generics only — platform choice is sanctioned
        };
        let obj = cdp
            .call(
                "Runtime.evaluate",
                json!({ "expression": format!("window.__dkFontEls[{idx}].el"), "returnByValue": false }),
            )
            .await?;
        let object_id = match obj["result"]["objectId"].as_str() {
            Some(o) => o.to_string(),
            None => continue,
        };
        let node = cdp
            .call("DOM.requestNode", json!({ "objectId": object_id }))
            .await?;
        let node_id = match node["nodeId"].as_u64() {
            Some(n) if n > 0 => n,
            _ => continue,
        };
        let used = cdp
            .call("CSS.getPlatformFontsForNode", json!({ "nodeId": node_id }))
            .await?;
        // The dominant face is the one that shaped the text; emoji/symbol
        // fallbacks legitimately contribute a few glyphs on the side.
        let dominant = used["fonts"]
            .as_array()
            .into_iter()
            .flatten()
            .max_by_key(|f| f["glyphCount"].as_u64().unwrap_or(0));
        let Some(dominant) = dominant else { continue };
        if dominant["glyphCount"].as_u64().unwrap_or(0) == 0 {
            continue;
        }
        let rendered = norm_family(dominant["familyName"].as_str().unwrap_or(""));
        if rendered.is_empty() || family_matches(&requested, &rendered) {
            continue;
        }
        let tag = entry["tag"].as_str().unwrap_or("element");
        let snippet = entry["snippet"].as_str().unwrap_or("");
        return Err(format!(
            "font check: '{requested}' is not available on the render host — text rendered with \
             '{rendered}' (<{tag}> \"{snippet}\"). Substituted metrics change wrapping, so the \
             export is refused; embed the font in the document or add it to the bundled pack."
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation gate (spec §6): mechanical checks on the exact bytes we ship.
// ---------------------------------------------------------------------------

fn validate(pdf: &[u8], facts: &RenderFacts, pdfium_lib: &Path) -> Result<(), String> {
    let doc = Document::load_mem(pdf).map_err(|e| format!("emitted PDF is unreadable: {e}"))?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if pages.is_empty() {
        return Err("emitted PDF has no pages".to_string());
    }

    // 1. Page count matches the DOM's prediction.
    if let Some(expected) = facts.expected_pages {
        if pages.len() != expected {
            return Err(format!(
                "page count: PDF has {} page(s), source DOM predicts {} (page containers / content-sized single page)",
                pages.len(),
                expected
            ));
        }
    }

    // 2. Every page at the expected size, ±0.5 mm.
    let (ew, eh) = facts.expected_pt;
    for (i, page) in pages.iter().enumerate() {
        let (w, h) = media_box(&doc, *page)
            .ok_or_else(|| format!("page {}: no readable MediaBox", i + 1))?;
        if (w - ew).abs() > SIZE_TOLERANCE_PT || (h - eh).abs() > SIZE_TOLERANCE_PT {
            return Err(format!(
                "page {}: size {:.1}×{:.1} mm, expected {:.1}×{:.1} mm (±0.5)",
                i + 1,
                w * 25.4 / 72.0,
                h * 25.4 / 72.0,
                ew * 25.4 / 72.0,
                eh * 25.4 / 72.0
            ));
        }
    }

    // 3. No blank pages: every page's content stream must draw something —
    // text, a filled/stroked path, an image/form XObject, or a shading.
    for (i, page) in pages.iter().enumerate() {
        if !page_has_ink(&doc, *page) {
            return Err(format!("page {}: blank (no text or drawing operations)", i + 1));
        }
    }

    // 4 + 5. Vector text present, and the print-DOM samples all survive into
    // the extractable text. This is what catches content dropped off a page
    // edge or lost by the print pass.
    if !facts.samples.is_empty() {
        let per_page = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(pdf))
            .map_err(|_| "text extraction crashed on the emitted PDF".to_string())?
            .map_err(|e| format!("text extraction failed on the emitted PDF: {e}"))?;
        let haystack: String = per_page.iter().map(|p| normalize_text(p)).collect();
        if haystack.is_empty() {
            return Err(
                "text check: the document has visible text but the PDF has none extractable (raster output?)"
                    .to_string(),
            );
        }
        let missing: Vec<&String> = facts
            .samples
            .iter()
            .filter(|s| !haystack.contains(&normalize_text(s)))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "content check: {} DOM string(s) missing from extracted text, first is '{}'",
                missing.len(),
                missing[0].chars().take(80).collect::<String>()
            ));
        }
    }

    // 6. Visual diff: rasterize each emitted page via pinned pdfium and
    // compare against the browser's own painting of that page region. This
    // is the one check that sees print-pipeline divergence — content that
    // straddled a page boundary and got silently cut, fixed elements the
    // print pass repeats on every page, print-relayout shifts, rendering
    // omissions — none of which text extraction can catch (a document-
    // internal overlap reproduces identically in both renderings and is
    // faithful output, not a divergence).
    if !facts.screenshots.is_empty() {
        if facts.screenshots.len() != pages.len() {
            return Err(format!(
                "visual check: {} reference region(s) but the PDF has {} page(s)",
                facts.screenshots.len(),
                pages.len()
            ));
        }
        let pdfium = pdfium_instance(pdfium_lib)?;
        let rendered = pdfium
            .load_pdf_from_byte_slice(pdf, None)
            .map_err(|e| format!("visual check: pdfium cannot read the emitted PDF: {e}"))?;
        for (i, page) in rendered.pages().iter().enumerate() {
            // Rasterize at CSS-pixel parity (96 dpi) so the raster and the
            // screenshot land on the same grid, ± a rounding pixel.
            let w_px = (page.width().value as f64 / 0.75).round() as i32;
            let h_px = (page.height().value as f64 / 0.75).round() as i32;
            let config = PdfRenderConfig::new()
                .set_target_size(w_px, h_px)
                .clear_before_rendering(true)
                .set_clear_color(PdfColor::WHITE);
            let bitmap = page
                .render_with_config(&config)
                .map_err(|e| format!("visual check: page {} failed to rasterize: {e}", i + 1))?;
            let (bw, bh) = (bitmap.width() as usize, bitmap.height() as usize);
            let pdf_rgba = bitmap.as_rgba_bytes();
            let (sw, sh, shot_rgba) = decode_png_rgba(&facts.screenshots[i])
                .map_err(|e| format!("visual check: page {} reference unreadable: {e}", i + 1))?;
            let (differing, total) = diff_pixels(&pdf_rgba, bw, bh, &shot_rgba, sw, sh);
            let fraction = differing as f64 / total.max(1) as f64;
            if std::env::var("DOKLIN_PDF_DIFF_DEBUG").is_ok() {
                eprintln!(
                    "visual diff page {}: {:.4}% ({differing}/{total} px)",
                    i + 1,
                    fraction * 100.0
                );
            }
            if differing > DIFF_MIN_PIXELS && fraction > DIFF_FAIL_FRACTION {
                return Err(format!(
                    "page {}: rendered output diverges from the browser rendering \
                     ({:.2}% of pixels differ, threshold {:.2}%)",
                    i + 1,
                    fraction * 100.0,
                    DIFF_FAIL_FRACTION * 100.0
                ));
            }
        }
    }

    Ok(())
}

/// pdfium can be bound only once per process (a second bind_to_library
/// returns PdfiumLibraryBindingsAlreadyInitialized), so the instance lives in
/// a process-wide cell. The crate's default `thread_safe` feature serializes
/// the FFI underneath; exports are serialized by the command lock anyway. A
/// failed first bind stays cached until restart — acceptable, since the lib
/// path is hash-verified before we ever get here.
fn pdfium_instance(lib: &Path) -> Result<&'static Pdfium, String> {
    static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();
    PDFIUM
        .get_or_init(|| {
            Pdfium::bind_to_library(lib)
                .map(Pdfium::new)
                .map_err(|e| format!("visual check unavailable — pdfium failed to load: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Decode a Chromium screenshot PNG into 8-bit RGBA.
fn decode_png_rgba(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| format!("png: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size().ok_or("png: absurd dimensions")?];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("png: {e}"))?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err(format!("png: unexpected bit depth {:?}", info.bit_depth));
    }
    let (w, h) = (info.width as usize, info.height as usize);
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(w * h * 4);
            for px in buf.chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(w * h * 4);
            for g in buf {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        other => return Err(format!("png: unsupported color type {other:?}")),
    };
    Ok((w, h, rgba))
}

/// Comparison over the overlapping area (the two renderers can disagree by a
/// rounding pixel on dimensions): grayscale, 2× downscale, 3×3 blur, then a
/// thresholded absolute difference. The downscale is what separates signal
/// from noise — subpixel glyph-positioning halos are 1–2 px wide and melt
/// when averaged, while genuinely missing content keeps its area fraction at
/// any resolution. Returns (differing pixels, compared pixels) at the
/// downscaled resolution.
fn diff_pixels(
    a: &[u8],
    aw: usize,
    ah: usize,
    b: &[u8],
    bw: usize,
    bh: usize,
) -> (usize, usize) {
    let w = aw.min(bw);
    let h = ah.min(bh);
    if w < 2 || h < 2 {
        return (0, 0);
    }
    let (ga, gw, gh) = downscale2(&gray(a, aw, w, h), w, h);
    let (gb, _, _) = downscale2(&gray(b, bw, w, h), w, h);
    let ba = blur3(&ga, gw, gh);
    let bb = blur3(&gb, gw, gh);
    let differing = ba
        .iter()
        .zip(&bb)
        .filter(|(x, y)| (**x - **y).abs() > DIFF_LUMA_THRESHOLD)
        .count();
    (differing, gw * gh)
}

/// Average 2×2 blocks — half resolution, quarter pixels.
fn downscale2(g: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let (ow, oh) = (w / 2, h / 2);
    let mut out = vec![0f32; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            let (sx, sy) = (x * 2, y * 2);
            out[y * ow + x] = (g[sy * w + sx]
                + g[sy * w + sx + 1]
                + g[(sy + 1) * w + sx]
                + g[(sy + 1) * w + sx + 1])
                / 4.0;
        }
    }
    (out, ow, oh)
}

fn gray(rgba: &[u8], stride_w: usize, w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let p = (y * stride_w + x) * 4;
            out[y * w + x] =
                0.299 * rgba[p] as f32 + 0.587 * rgba[p + 1] as f32 + 0.114 * rgba[p + 2] as f32;
        }
    }
    out
}

/// 3×3 box blur, separable, clamped edges — enough to melt antialiasing
/// differences without hiding real content.
fn blur3(g: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut rows = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let l = x.saturating_sub(1);
            let r = (x + 1).min(w - 1);
            rows[y * w + x] = (g[y * w + l] + g[y * w + x] + g[y * w + r]) / 3.0;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let u = y.saturating_sub(1);
        let d = (y + 1).min(h - 1);
        for x in 0..w {
            out[y * w + x] = (rows[u * w + x] + rows[y * w + x] + rows[d * w + x]) / 3.0;
        }
    }
    out
}

fn media_box(doc: &Document, page: ObjectId) -> Option<(f64, f64)> {
    // MediaBox inherits through the page tree; walk Parent until found.
    let mut dict = doc.get_dictionary(page).ok()?;
    for _ in 0..32 {
        if let Ok(obj) = dict.get(b"MediaBox") {
            let arr = match obj {
                Object::Reference(r) => doc.get_object(*r).ok()?.as_array().ok()?,
                other => other.as_array().ok()?,
            };
            if arr.len() != 4 {
                return None;
            }
            let n = |o: &Object| -> Option<f64> {
                match o {
                    Object::Integer(i) => Some(*i as f64),
                    Object::Real(f) => Some(*f as f64),
                    Object::Reference(r) => match doc.get_object(*r).ok()? {
                        Object::Integer(i) => Some(*i as f64),
                        Object::Real(f) => Some(*f as f64),
                        _ => None,
                    },
                    _ => None,
                }
            };
            let (x0, y0, x1, y1) = (n(&arr[0])?, n(&arr[1])?, n(&arr[2])?, n(&arr[3])?);
            return Some(((x1 - x0).abs(), (y1 - y0).abs()));
        }
        let parent = dict.get(b"Parent").ok()?.as_reference().ok()?;
        dict = doc.get_dictionary(parent).ok()?;
    }
    None
}

fn page_has_ink(doc: &Document, page: ObjectId) -> bool {
    let content = doc.get_page_content(page);
    let Ok(ops) = lopdf::content::Content::decode(&content) else {
        // Undecodable content is suspicious, not proof of ink — fail closed.
        return false;
    };
    const INK: &[&str] = &[
        "Tj", "TJ", "'", "\"", // text showing
        "f", "F", "f*", "B", "B*", "b", "b*", "S", "s", // path painting
        "Do", "sh", "BI", // xobjects, shadings, inline images
    ];
    ops.operations.iter().any(|op| INK.contains(&op.operator.as_str()))
}

/// Text normalization applied to BOTH the DOM samples and the extracted PDF
/// text before the containment check: whitespace-free, lowercase, ligatures
/// folded, soft hyphens dropped — so shaping differences can't fake a miss.
fn normalize_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\u{FB00}' => out.push_str("ff"),
            '\u{FB01}' => out.push_str("fi"),
            '\u{FB02}' => out.push_str("fl"),
            '\u{FB03}' => out.push_str("ffi"),
            '\u{FB04}' => out.push_str("ffl"),
            '\u{FB05}' | '\u{FB06}' => out.push_str("st"),
            '\u{00AD}' => {}
            c if c.is_whitespace() => {}
            c => out.extend(c.to_lowercase()),
        }
    }
    out
}

/// Strip the nondeterministic metadata Chromium stamps (creation/mod dates,
/// random document ID, run-varying structure-element node IDs) so the same
/// input yields byte-comparable output.
fn normalize_pdf(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("emitted PDF is unreadable: {e}"))?;
    if let Ok(info_ref) = doc.trailer.get(b"Info").and_then(Object::as_reference) {
        if let Ok(info) = doc.get_dictionary_mut(info_ref) {
            info.remove(b"CreationDate");
            info.remove(b"ModDate");
        }
    }
    // Tagged-PDF structure elements carry `/ID (nodeNNNNNNNN)` strings from a
    // global Chromium counter whose start varies per run — and they're load-
    // bearing (table cells name their header cells through `/A Table
    // /Headers`, the IDTree indexes them), so they can't just be dropped.
    // Renumber instead: same document → same structure → same relative order,
    // so mapping the sorted set onto 1..n is stable across runs. Fixed-width
    // ids keep lexicographic == numeric order, so the (sorted) IDTree stays
    // sorted after the rewrite.
    renumber_struct_ids(&mut doc);
    doc.trailer.set(
        "ID",
        Object::Array(vec![
            Object::String(vec![0u8; 16], lopdf::StringFormat::Hexadecimal),
            Object::String(vec![0u8; 16], lopdf::StringFormat::Hexadecimal),
        ]),
    );
    let mut out = Vec::with_capacity(bytes.len());
    doc.save_to(&mut out)
        .map_err(|e| format!("PDF normalization failed: {e}"))?;
    Ok(out)
}

fn is_node_id(s: &[u8]) -> bool {
    s.len() == 12 && s.starts_with(b"node") && s[4..].iter().all(u8::is_ascii_digit)
}

fn renumber_struct_ids(doc: &mut Document) {
    fn collect(o: &Object, out: &mut std::collections::BTreeSet<Vec<u8>>) {
        match o {
            Object::String(s, _) if is_node_id(s) => {
                out.insert(s.clone());
            }
            Object::Array(items) => items.iter().for_each(|x| collect(x, out)),
            Object::Dictionary(d) => d.iter().for_each(|(_, v)| collect(v, out)),
            Object::Stream(st) => st.dict.iter().for_each(|(_, v)| collect(v, out)),
            _ => {}
        }
    }
    fn rewrite(o: &mut Object, map: &HashMap<Vec<u8>, Vec<u8>>) {
        match o {
            Object::String(s, _) => {
                if let Some(new) = map.get(s.as_slice()) {
                    *s = new.clone();
                }
            }
            Object::Array(items) => items.iter_mut().for_each(|x| rewrite(x, map)),
            Object::Dictionary(d) => d.iter_mut().for_each(|(_, v)| rewrite(v, map)),
            Object::Stream(st) => st.dict.iter_mut().for_each(|(_, v)| rewrite(v, map)),
            _ => {}
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for (_, o) in doc.objects.iter() {
        collect(o, &mut seen);
    }
    if seen.is_empty() {
        return;
    }
    let map: HashMap<Vec<u8>, Vec<u8>> = seen
        .iter()
        .enumerate()
        .map(|(i, old)| (old.clone(), format!("node{:08}", i + 1).into_bytes()))
        .collect();
    for (_, o) in doc.objects.iter_mut() {
        rewrite(o, &map);
    }
}

// ---------------------------------------------------------------------------
// @page detection: the print size decision must match what Chromium will do,
// so read the source (inline <style> + same-directory linked stylesheets —
// the renditions are self-contained or nearly so). Returns (w, h) in points.
// ---------------------------------------------------------------------------

fn at_page_size(html: &Path) -> Result<Option<(f64, f64)>, String> {
    let text = std::fs::read_to_string(html)
        .map_err(|e| format!("cannot read {}: {e}", html.display()))?;
    if let Some(size) = find_at_page_size(&text) {
        return Ok(Some(size));
    }
    // Linked local stylesheets (relative hrefs only; remote CSS with @page
    // would be exotic for this corpus — revisit if it ever appears).
    let dir = html.parent().unwrap_or(Path::new("."));
    for href in linked_stylesheets(&text) {
        if href.contains("://") || href.starts_with("data:") {
            continue;
        }
        let candidate = dir.join(href.trim_start_matches("./"));
        if let Ok(css) = std::fs::read_to_string(&candidate) {
            if let Some(size) = find_at_page_size(&css) {
                return Ok(Some(size));
            }
        }
    }
    Ok(None)
}

fn linked_stylesheets(html: &str) -> Vec<String> {
    let lower = html.to_lowercase();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = lower[i..].find("<link") {
        let start = i + p;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        let tag = &html[start..end];
        let tag_l = &lower[start..end];
        if tag_l.contains("stylesheet") {
            if let Some(href) = attr_value(tag, tag_l, "href") {
                out.push(href);
            }
        }
        i = end;
    }
    out
}

fn attr_value(tag: &str, tag_lower: &str, name: &str) -> Option<String> {
    let p = tag_lower.find(&format!("{name}="))?;
    let rest = &tag[p + name.len() + 1..];
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if quote == '"' || quote == '\'' {
        let inner: String = chars.take_while(|&c| c != quote).collect();
        Some(inner)
    } else {
        Some(
            rest.chars()
                .take_while(|c| !c.is_whitespace() && *c != '>')
                .collect(),
        )
    }
}

/// First `size:` declaration in any `@page` block. Depth-aware because page
/// blocks may nest margin boxes (`@top-center { … }`); only depth-1
/// declarations count.
fn find_at_page_size(css: &str) -> Option<(f64, f64)> {
    let bytes = css.as_bytes();
    let mut i = 0;
    while let Some(p) = css[i..].find("@page") {
        let at = i + p;
        let open = css[at..].find('{')? + at;
        let mut depth = 1usize;
        let mut j = open + 1;
        let mut decl_start = j;
        while j < bytes.len() && depth > 0 {
            match bytes[j] {
                b'{' => {
                    depth += 1;
                }
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(sz) = size_from_decl(&css[decl_start..j]) {
                            return Some(sz);
                        }
                    }
                    decl_start = j + 1;
                }
                b';' if depth == 1 => {
                    if let Some(sz) = size_from_decl(&css[decl_start..j]) {
                        return Some(sz);
                    }
                    decl_start = j + 1;
                }
                _ => {}
            }
            j += 1;
        }
        i = open + 1;
    }
    None
}

fn size_from_decl(decl: &str) -> Option<(f64, f64)> {
    let decl = decl.trim();
    let rest = decl.strip_prefix("size")?.trim_start();
    let value = rest.strip_prefix(':')?.trim();
    parse_page_size_value(value)
}

/// CSS `@page size` values: keywords (a4, letter, …), one or two lengths,
/// optional portrait/landscape. Points out.
fn parse_page_size_value(value: &str) -> Option<(f64, f64)> {
    const MM: f64 = 72.0 / 25.4;
    const IN: f64 = 72.0;
    let mut dims: Vec<f64> = Vec::new();
    let mut keyword: Option<(f64, f64)> = None;
    let mut landscape = false;
    for tok in value.split_whitespace() {
        let t = tok.trim_end_matches(';').to_lowercase();
        match t.as_str() {
            "portrait" => {}
            "landscape" => landscape = true,
            "auto" => return None,
            "a3" => keyword = Some((297.0 * MM, 420.0 * MM)),
            "a4" => keyword = Some((210.0 * MM, 297.0 * MM)),
            "a5" => keyword = Some((148.0 * MM, 210.0 * MM)),
            "b4" => keyword = Some((250.0 * MM, 353.0 * MM)),
            "b5" => keyword = Some((176.0 * MM, 250.0 * MM)),
            "jis-b4" => keyword = Some((257.0 * MM, 364.0 * MM)),
            "jis-b5" => keyword = Some((182.0 * MM, 257.0 * MM)),
            "letter" => keyword = Some((8.5 * IN, 11.0 * IN)),
            "legal" => keyword = Some((8.5 * IN, 14.0 * IN)),
            "ledger" => keyword = Some((17.0 * IN, 11.0 * IN)),
            "tabloid" => keyword = Some((11.0 * IN, 17.0 * IN)),
            _ => {
                if let Some(pt) = parse_length_pt(&t) {
                    dims.push(pt);
                } else {
                    return None; // unknown token — don't guess
                }
            }
        }
    }
    let (w, h) = match (dims.len(), keyword) {
        (0, Some(k)) => k,
        (1, None) => (dims[0], dims[0]),
        (2, None) => (dims[0], dims[1]),
        _ => return None,
    };
    Some(if landscape && h > w { (h, w) } else { (w, h) })
}

fn parse_length_pt(t: &str) -> Option<f64> {
    let units: &[(&str, f64)] = &[
        ("mm", 72.0 / 25.4),
        ("cm", 720.0 / 25.4),
        ("in", 72.0),
        ("px", 0.75),
        ("pt", 1.0),
        ("pc", 12.0),
        ("q", 72.0 / 25.4 / 4.0),
    ];
    for (u, f) in units {
        if let Some(num) = t.strip_suffix(u) {
            return num.trim().parse::<f64>().ok().map(|n| n * f);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Engine process + minimal CDP client
// ---------------------------------------------------------------------------

/// The headless engine process. Fresh profile per export (no cached state
/// can leak between runs), killed and cleaned on drop — including every
/// error path out of the pipeline.
struct Engine {
    child: Child,
    profile: PathBuf,
    port: u16,
}

impl Engine {
    fn launch(bin: &Path) -> Result<Engine, String> {
        let profile = std::env::temp_dir().join(format!("doklin-pdf-profile-{}", rand_suffix()));
        std::fs::create_dir_all(&profile)
            .map_err(|e| format!("cannot create engine profile dir: {e}"))?;
        let mut child = Command::new(bin)
            .args([
                "--remote-debugging-port=0",
                &format!("--user-data-dir={}", profile.display()),
                "--no-first-run",
                // Software GL: canvas/WebGL content rasterizes identically on
                // every machine instead of per-GPU.
                "--disable-gpu",
                "--force-color-profile=srgb",
                "--hide-scrollbars",
                "--mute-audio",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-breakpad",
                "--disable-sync",
                "--lang=en-US",
                "--window-size=1280,800",
                "about:blank",
            ])
            .env("TZ", "UTC")
            .env("LC_ALL", "en_US.UTF-8")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("engine failed to start: {e}"))?;

        // The engine announces its DevTools endpoint on stderr; scan for it
        // off-thread so a wedged launch can't hang the app.
        let stderr = child.stderr.take().ok_or("engine stderr unavailable")?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut tail: Vec<String> = Vec::new();
        let port = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&profile);
                return Err(format!(
                    "engine did not announce DevTools within 20s (stderr tail: {})",
                    tail.join(" | ")
                ));
            }
            match rx.recv_timeout(remaining) {
                Ok(line) => {
                    if let Some(rest) = line.strip_prefix("DevTools listening on ws://127.0.0.1:") {
                        if let Some(port) = rest.split('/').next().and_then(|p| p.parse::<u16>().ok())
                        {
                            break port;
                        }
                    }
                    tail.push(line);
                    if tail.len() > 5 {
                        tail.remove(0);
                    }
                }
                Err(_) => continue,
            }
        };
        Ok(Engine { child, profile, port })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsSource = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

/// Just enough CDP: sequential calls matched by id, events buffered on a
/// channel, and in-flight network bookkeeping updated as events pass through
/// (so idle detection can't miss activity that arrived while we were busy).
struct Cdp {
    sink: WsSink,
    pending: Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>>,
    events: mpsc::UnboundedReceiver<(String, Value)>,
    next_id: AtomicU64,
    inflight: HashSet<String>,
}

impl Cdp {
    async fn connect(engine: &Engine) -> Result<Cdp, String> {
        // The page target opened by the about:blank launch arg; its websocket
        // is the only session we need.
        let list: Value = reqwest::get(format!("http://127.0.0.1:{}/json/list", engine.port))
            .await
            .map_err(|e| format!("engine DevTools unreachable: {e}"))?
            .json()
            .await
            .map_err(|e| format!("engine DevTools list unreadable: {e}"))?;
        let ws_url = list
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["type"] == "page")
            .and_then(|t| t["webSocketDebuggerUrl"].as_str())
            .ok_or("engine exposed no page target")?
            .to_string();

        let config = WebSocketConfig::default()
            .max_message_size(None) // printToPDF result rides one text frame
            .max_frame_size(None);
        let (ws, _) = tokio_tungstenite::connect_async_with_config(&ws_url, Some(config), false)
            .await
            .map_err(|e| format!("engine websocket connect failed: {e}"))?;
        let (sink, mut source): (WsSink, WsSource) = ws.split();

        let pending: Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(StdMutex::new(HashMap::new()));
        let (evt_tx, events) = mpsc::unbounded_channel();
        let pending2 = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                let Message::Text(text) = msg else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = pending2.lock().unwrap().remove(&id) {
                        let _ = tx.send(v);
                    }
                } else if let Some(method) = v.get("method").and_then(Value::as_str) {
                    let _ = evt_tx.send((method.to_string(), v["params"].clone()));
                }
            }
            // Socket gone: wake every caller with an error instead of a hang.
            pending2.lock().unwrap().clear();
        });

        Ok(Cdp {
            sink,
            pending,
            events,
            next_id: AtomicU64::new(1),
            inflight: HashSet::new(),
        })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let msg = json!({ "id": id, "method": method, "params": params }).to_string();
        self.sink
            .send(Message::Text(msg.into()))
            .await
            .map_err(|e| format!("{method} send failed: {e}"))?;
        let resp = tokio::time::timeout(Duration::from_secs(60), rx)
            .await
            .map_err(|_| format!("{method} timed out"))?
            .map_err(|_| format!("{method}: engine connection lost"))?;
        if let Some(err) = resp.get("error") {
            return Err(format!(
                "{method} failed: {}",
                err["message"].as_str().unwrap_or("unknown CDP error")
            ));
        }
        Ok(resp["result"].clone())
    }

    async fn eval(&mut self, expression: &str, await_promise: bool) -> Result<Value, String> {
        let r = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "awaitPromise": await_promise, "returnByValue": true }),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            let msg = ex["exception"]["description"]
                .as_str()
                .or_else(|| ex["text"].as_str())
                .unwrap_or("unknown exception");
            return Err(format!("in-page script failed: {msg}"));
        }
        Ok(r["result"]["value"].clone())
    }

    fn track(&mut self, method: &str, params: &Value) {
        let id = || params["requestId"].as_str().map(str::to_string);
        match method {
            "Network.requestWillBeSent" => {
                // data: URLs never emit loadingFinished; counting them would
                // wedge idle detection.
                let url = params["request"]["url"].as_str().unwrap_or("");
                if !url.starts_with("data:") {
                    if let Some(id) = id() {
                        self.inflight.insert(id);
                    }
                }
            }
            "Network.loadingFinished" | "Network.loadingFailed" | "Network.requestServedFromCache" => {
                if let Some(id) = id() {
                    self.inflight.remove(&id);
                }
            }
            _ => {}
        }
    }

    async fn recv_event(&mut self, wait: Duration) -> Option<(String, Value)> {
        match tokio::time::timeout(wait, self.events.recv()).await {
            Ok(Some((method, params))) => {
                self.track(&method, &params);
                Some((method, params))
            }
            _ => None,
        }
    }

    async fn wait_event(&mut self, wanted: &str, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("timed out waiting for {wanted}"));
            }
            if let Some((method, params)) = self.recv_event(remaining).await {
                if method == wanted {
                    return Ok(params);
                }
            }
        }
    }

    /// Idle = a quiet window with zero in-flight requests. A document that
    /// never settles (long-polling, streaming) fails loudly instead of
    /// exporting mid-load.
    async fn wait_network_idle(&mut self, quiet: Duration, cap: Duration) -> Result<(), String> {
        let deadline = Instant::now() + cap;
        let mut quiet_since = Instant::now();
        loop {
            if Instant::now() > deadline {
                return Err(format!(
                    "network never settled within {}s ({} request(s) still in flight)",
                    cap.as_secs(),
                    self.inflight.len()
                ));
            }
            let had_event = self.recv_event(Duration::from_millis(60)).await.is_some();
            if had_event || !self.inflight.is_empty() {
                quiet_since = Instant::now();
            } else if quiet_since.elapsed() >= quiet {
                return Ok(());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// In-page scripts. Raw strings; every string literal inside uses single
// quotes so a `"#` sequence can never terminate the Rust raw string.
// ---------------------------------------------------------------------------

/// Fidelity CSS + bundled font pack. Backgrounds must survive print
/// (`print-color-adjust`), nothing may be captured mid-animation, and the
/// pack loads via data: URIs so no host font (and no network) is involved.
/// Families the document declares itself are left alone.
const INJECT_JS: &str = r#"(() => {
  const have = new Set();
  document.fonts.forEach((f) => have.add(f.family.replace(/^['"]|['"]$/g, '').toLowerCase()));
  const css = [
    '* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }',
    '*, *::before, *::after { animation: none !important; transition: none !important; }',
  ];
  const faces = __DK_FACES__;
  for (const f of faces) {
    if (have.has(f.fam.toLowerCase())) continue;
    css.push('@font-face { font-family: "' + f.fam + '"; font-weight: ' + f.w +
      '; font-style: ' + f.s + '; src: url(data:font/ttf;base64,' + f.d + ') format("truetype"); }');
  }
  const st = document.createElement('style');
  st.textContent = css.join('\n');
  (document.head || document.documentElement).appendChild(st);
  return 'ok';
})()"#;

/// Spec §4 wait conditions, reported rather than assumed: fonts ready, every
/// image decoded (`decode()` forces lazy ones), same-document <use> targets
/// present, two rAF ticks for final layout.
const SETTLE_JS: &str = r#"(async () => {
  const out = { badImages: [], badUses: [] };
  try { await document.fonts.ready; } catch (e) {}
  await Promise.all([...document.images].map((img) =>
    img.decode().catch(() => { out.badImages.push(img.currentSrc || img.src || '(unknown image)'); })
  ));
  for (const u of document.querySelectorAll('use')) {
    const href = u.getAttribute('href') || u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (href.startsWith('#') && !document.getElementById(href.slice(1))) out.badUses.push(href);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return JSON.stringify(out);
})()"#;

const RAF_JS: &str =
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r('ok'))))";

/// One pass over the print-media DOM: content box, page-container count,
/// spread text samples for the completeness check, and one representative
/// element per distinct font-family stack (stashed on `window` for the font
/// gate to resolve into DOM nodes).
const MEASURE_JS: &str = r#"JSON.stringify((() => {
  const root = document.body || document.documentElement;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length < 12) continue;
    const el = node.parentElement;
    if (!el || el.closest('script,style,noscript,template,title')) continue;
    if (!visible(el)) continue;
    texts.push({ t, el });
  }
  const samples = [];
  if (texts.length) {
    const N = 24;
    const bucket = Math.max(1, Math.ceil(texts.length / N));
    for (let b = 0; b < texts.length; b += bucket) {
      let best = null;
      for (let j = b; j < Math.min(b + bucket, texts.length); j++) {
        if (!best || texts[j].t.length > best.t.length) best = texts[j];
      }
      if (best) samples.push(best.t.slice(0, 200));
    }
    const last = texts[texts.length - 1].t.slice(0, 200);
    if (!samples.includes(last)) samples.push(last);
  }
  const byFamily = new Map();
  for (const { el } of texts) {
    const ff = getComputedStyle(el).fontFamily;
    if (!byFamily.has(ff)) byFamily.set(ff, el);
  }
  window.__dkFontEls = [...byFamily.entries()].slice(0, 40).map(([ff, el]) => ({ ff, el }));
  const fonts = window.__dkFontEls.map((x, i) => ({
    i, ff: x.ff,
    tag: x.el.tagName.toLowerCase(),
    snippet: (x.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
  }));
  const de = document.documentElement;
  const w = Math.max(de.scrollWidth, root.scrollWidth || 0);
  const h = Math.max(de.scrollHeight, root.scrollHeight || 0);
  const cels = [...document.querySelectorAll('__DK_CONTAINERS__')];
  const containerRects = cels.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  });
  return { w, h, containers: cels.length, containerRects, samples, fonts };
})())"#;

fn font_faces_json() -> String {
    let faces = [
        (CARLITO_REGULAR, 400, "normal"),
        (CARLITO_BOLD, 700, "normal"),
        (CARLITO_ITALIC, 400, "italic"),
        (CARLITO_BOLD_ITALIC, 700, "italic"),
    ];
    let mut out: Vec<Value> = Vec::new();
    for (bytes, weight, style) in faces {
        let data = B64.encode(bytes);
        for fam in ["Carlito", "Calibri"] {
            out.push(json!({ "fam": fam, "w": weight, "s": style, "d": data }));
        }
    }
    Value::Array(out).to_string()
}

// MEASURE_JS carries the container selector so the corpus convention lives in
// one Rust constant.
fn measure_js() -> String {
    MEASURE_JS.replace("__DK_CONTAINERS__", PAGE_CONTAINER_SELECTOR)
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_page_keywords_and_lengths() {
        let a4 = find_at_page_size("@page { size: A4; margin: 0 }").unwrap();
        assert!((a4.0 - 595.27).abs() < 0.1 && (a4.1 - 841.88).abs() < 0.1);
        let mm = find_at_page_size("body{} @page { size: 210mm 297mm }").unwrap();
        assert!((mm.0 - 595.27).abs() < 0.1 && (mm.1 - 841.88).abs() < 0.1);
        let ls = find_at_page_size("@page { size: a4 landscape }").unwrap();
        assert!(ls.0 > ls.1);
        let px = find_at_page_size("@page{size:800px 600px}").unwrap();
        assert!((px.0 - 600.0).abs() < 0.01 && (px.1 - 450.0).abs() < 0.01);
        assert_eq!(find_at_page_size("@page { margin: 1cm }"), None);
        assert_eq!(find_at_page_size("@page { size: auto }"), None);
        assert_eq!(find_at_page_size("div { width: 10px }"), None);
    }

    #[test]
    fn at_page_skips_margin_boxes() {
        // size inside a nested margin box must not count; the real one must.
        let css = "@page { @top-center { content: 'x' } margin: 0 } @page x { size: 4in 4in }";
        let got = find_at_page_size(css).unwrap();
        assert!((got.0 - 288.0).abs() < 0.01 && (got.1 - 288.0).abs() < 0.01);
    }

    #[test]
    fn text_normalization_folds_shaping() {
        assert_eq!(normalize_text("Ef\u{FB01}cient  Layout"), "efficientlayout");
        assert_eq!(normalize_text("soft\u{00AD}hyphen"), "softhyphen");
        assert_eq!(normalize_text("A\u{00A0}B\nC"), "abc");
    }

    #[test]
    fn concrete_family_and_aliasing() {
        assert_eq!(
            first_concrete_family("-apple-system, 'Segoe UI', sans-serif"),
            Some("segoe ui".to_string())
        );
        assert_eq!(first_concrete_family("system-ui, sans-serif"), None);
        assert!(family_matches("calibri", "carlito"));
        assert!(family_matches("carlito", "carlito"));
        assert!(!family_matches("segoe ui", "helvetica"));
    }

    #[test]
    fn comparator_ignores_dither_and_catches_blobs() {
        let n = 200usize;
        let white = vec![255u8; n * n * 4];
        assert_eq!(diff_pixels(&white, n, n, &white, n, n).0, 0);

        // Antialiasing-scale luminance dither (±12) must melt away.
        let mut dithered = white.clone();
        for (i, px) in dithered.chunks_exact_mut(4).enumerate() {
            let d = if i % 2 == 0 { 12 } else { 0 };
            px[0] -= d;
            px[1] -= d;
            px[2] -= d;
        }
        assert_eq!(diff_pixels(&white, n, n, &dithered, n, n).0, 0);

        // A missing 40×40 block is a divergence, loudly (20×20 = 400 px on
        // the downscaled 100×100 grid → 4%).
        let mut blob = white.clone();
        for y in 80..120 {
            for x in 80..120 {
                let p = (y * n + x) * 4;
                blob[p] = 0;
                blob[p + 1] = 0;
                blob[p + 2] = 0;
            }
        }
        let (diff, total) = diff_pixels(&white, n, n, &blob, n, n);
        assert!(diff > 300, "blob barely registered: {diff}");
        assert!(diff > DIFF_MIN_PIXELS);
        assert!(diff as f64 / total as f64 > DIFF_FAIL_FRACTION);
    }

    #[test]
    fn stylesheet_links_extract() {
        let html = "<head><LINK rel='stylesheet' href='a.css'><link href=\"b.css\" rel=stylesheet><link rel=icon href=c.ico></head>";
        assert_eq!(linked_stylesheets(html), vec!["a.css".to_string(), "b.css".to_string()]);
    }
}
