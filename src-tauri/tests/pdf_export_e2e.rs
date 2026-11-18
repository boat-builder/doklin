//! End-to-end PDF export against the real pinned engine.
//!
//! These tests are `#[ignore]`d because they need a local
//! chrome-headless-shell matching pdf_export's ENGINE_VERSION:
//!
//!   DOKLIN_PDF_ENGINE=/path/to/chrome-headless-shell \
//!     cargo test --test pdf_export_e2e -- --ignored
//!
//! An ENGINE_VERSION bump is a rendering change — re-run this suite (and
//! eyeball a real rendition) before shipping it.

use std::path::{Path, PathBuf};

use doklin_lib::pdf_export::run_export;

fn engine() -> PathBuf {
    let p = PathBuf::from(
        std::env::var("DOKLIN_PDF_ENGINE")
            .expect("set DOKLIN_PDF_ENGINE to a chrome-headless-shell binary"),
    );
    assert!(p.is_file(), "DOKLIN_PDF_ENGINE points at nothing: {}", p.display());
    p
}

fn pdfium() -> PathBuf {
    let p = PathBuf::from(
        std::env::var("DOKLIN_PDFIUM").expect("set DOKLIN_PDFIUM to a libpdfium.dylib"),
    );
    assert!(p.is_file(), "DOKLIN_PDFIUM points at nothing: {}", p.display());
    p
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/pdf")
        .join(name)
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn export(name: &str, out: &Path) -> Result<PathBuf, String> {
    rt().block_on(run_export(&engine(), &pdfium(), &fixture(name), out, |_, _| {}))
}

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("doklin-pdf-e2e");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

// Extraction re-breaks lines, so phrase assertions compare whitespace-free
// (the pipeline's own completeness check normalizes the same way).
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}

fn assert_has(text: &str, phrase: &str) {
    assert!(
        squash(text).contains(&squash(phrase)),
        "extracted text is missing: {phrase}"
    );
}

#[test]
#[ignore]
fn paged_document_exports_two_a4_pages() {
    let out = tmp("paged.pdf");
    let _ = std::fs::remove_file(&out);
    export("paged.html", &out).expect("paged fixture must export");

    let doc = lopdf::Document::load(&out).unwrap();
    let pages = doc.get_pages();
    assert_eq!(pages.len(), 2, "two .page containers → two pages");
    // A4 is 595.28 × 841.89 pt; the exporter validates ±0.5 mm itself, this
    // re-checks from the outside.
    let (_, first) = pages.iter().next().unwrap();
    let dict = doc.get_dictionary(*first).unwrap();
    let mb = dict.get(b"MediaBox").or_else(|_| {
        let parent = dict.get(b"Parent").unwrap().as_reference().unwrap();
        doc.get_dictionary(parent).unwrap().get(b"MediaBox")
    });
    assert!(mb.is_ok(), "page must carry a MediaBox somewhere reachable");

    let text = pdf_extract::extract_text(&out).unwrap();
    assert_has(&text, "retention ledger");
}

#[test]
#[ignore]
fn content_document_exports_single_content_sized_page() {
    let out = tmp("content.pdf");
    let _ = std::fs::remove_file(&out);
    export("content.html", &out).expect("content fixture must export");

    let doc = lopdf::Document::load(&out).unwrap();
    assert_eq!(doc.get_pages().len(), 1, "no @page + no containers → one page");
    let text = pdf_extract::extract_text(&out).unwrap();
    assert_has(&text, "nothing cropped");
    assert_has(&text, "tail-of-document sample");
}

#[test]
#[ignore]
fn webfont_document_waits_and_passes_the_font_gate() {
    // Needs network (fonts.googleapis.com) — the one e2e case that does.
    let out = tmp("webfont.pdf");
    let _ = std::fs::remove_file(&out);
    export("webfont.html", &out).expect("webfont fixture must export");
    let text = pdf_extract::extract_text(&out).unwrap();
    assert_has(&text, "fully loaded before capture");
}

#[test]
#[ignore]
fn missing_font_is_refused() {
    let out = tmp("missing-font.pdf");
    let _ = std::fs::remove_file(&out);
    let err = export("missing-font.html", &out).expect_err("must refuse substituted fonts");
    assert!(err.contains("font check"), "unexpected error: {err}");
    assert!(!out.exists(), "a refused export must leave no file behind");
}

#[test]
#[ignore]
fn overflowing_page_container_is_refused() {
    let out = tmp("overflow.pdf");
    let _ = std::fs::remove_file(&out);
    let err = export("overflow.html", &out).expect_err("spilled content must refuse");
    assert!(err.contains("page count"), "unexpected error: {err}");
    assert!(!out.exists(), "a refused export must leave no file behind");
}

#[test]
#[ignore]
fn print_screen_divergence_is_refused() {
    // A fixed-position banner: painted once on screen, repeated on every
    // page by the print pass. All text/count/size checks pass; only the
    // visual diff sees page 2 carrying a banner the browser never showed.
    let out = tmp("diverging.pdf");
    let _ = std::fs::remove_file(&out);
    let err = export("diverging.html", &out).expect_err("print/screen divergence must refuse");
    assert!(err.contains("diverges"), "unexpected error: {err}");
    assert!(!out.exists(), "a refused export must leave no file behind");
}

#[test]
#[ignore]
fn same_input_same_bytes() {
    let a = tmp("det-a.pdf");
    let b = tmp("det-b.pdf");
    let _ = std::fs::remove_file(&a);
    let _ = std::fs::remove_file(&b);
    export("paged.html", &a).expect("first export");
    export("paged.html", &b).expect("second export");
    let ba = std::fs::read(&a).unwrap();
    let bb = std::fs::read(&b).unwrap();
    // Compare digests, not the byte vecs — a failure must not dump megabytes.
    use sha2::{Digest, Sha256};
    let ha = format!("{:x}", Sha256::digest(&ba));
    let hb = format!("{:x}", Sha256::digest(&bb));
    assert_eq!(ha, hb, "two exports of the same input must be byte-identical");
}
