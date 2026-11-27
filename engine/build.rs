// Numbers whose one source is the worker's or the app's TypeScript ride into
// the binary from there, never mirrored by hand: the cloud worker's versions,
// from cloud-worker/src/version.ts (the engine writes manifests of
// MANIFEST_VERSION and the app compares a domain's worker against
// WORKER_VERSION), and the tag list's limits, from src/tags.ts (the engine
// never puts up a list the worker would refuse).

use std::path::{Path, PathBuf};

fn constant(file: &Path, src: &str, name: &str) -> u32 {
    let prefix = format!("export const {} = ", name);
    src.lines()
        .find_map(|line| line.strip_prefix(&prefix)?.trim().strip_suffix(';')?.trim().parse::<u32>().ok())
        .unwrap_or_else(|| panic!("{} has no `export const {} = <integer>;` line", file.display(), name))
}

fn read(file: &Path) -> String {
    println!("cargo:rerun-if-changed={}", file.display());
    std::fs::read_to_string(file).unwrap_or_else(|e| panic!("read {}: {}", file.display(), e))
}

fn main() {
    let repo = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("..");
    let version_ts = repo.join("cloud-worker").join("src").join("version.ts");
    let src = read(&version_ts);
    for name in ["WORKER_VERSION", "MANIFEST_VERSION"] {
        println!("cargo:rustc-env=DOKLIN_{}={}", name, constant(&version_ts, &src, name));
    }
    let tags_ts = repo.join("src").join("tags.ts");
    let src = read(&tags_ts);
    for name in ["NAME_MAX", "VALUE_MAX", "DESC_MAX", "TAGS_MAX", "VALUES_MAX"] {
        println!("cargo:rustc-env=DOKLIN_TAG_{}={}", name, constant(&tags_ts, &src, name));
    }
}
