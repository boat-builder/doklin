// The cloud worker's versions ride into the binary from their one source,
// cloud-worker/src/version.ts (docs/cloud.md §5.7): the engine
// writes manifests of MANIFEST_VERSION and the app compares a domain's
// worker against WORKER_VERSION. Parsed here, never mirrored by hand.

use std::path::PathBuf;

fn version_of(src: &str, name: &str) -> u32 {
    let prefix = format!("export const {} = ", name);
    src.lines()
        .find_map(|line| line.strip_prefix(&prefix)?.trim().strip_suffix(';')?.trim().parse::<u32>().ok())
        .unwrap_or_else(|| panic!("cloud-worker/src/version.ts has no `export const {} = <integer>;` line", name))
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let version_ts = manifest_dir.join("..").join("cloud-worker").join("src").join("version.ts");
    println!("cargo:rerun-if-changed={}", version_ts.display());
    let src = std::fs::read_to_string(&version_ts)
        .unwrap_or_else(|e| panic!("read {}: {}", version_ts.display(), e));
    println!("cargo:rustc-env=DOKLIN_WORKER_VERSION={}", version_of(&src, "WORKER_VERSION"));
    println!("cargo:rustc-env=DOKLIN_MANIFEST_VERSION={}", version_of(&src, "MANIFEST_VERSION"));
    tauri_build::build()
}
