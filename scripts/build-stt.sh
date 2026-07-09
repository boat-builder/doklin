#!/bin/bash
# Build the doklin-stt dictation sidecar and stage it for Tauri.
#
# Built with xcodebuild, NOT `swift build`: the SwiftPM CLI can't compile
# Metal shaders, and MLX's GPU kernels ship as .metal sources that must become
# mlx-swift_Cmlx.bundle/default.metallib. Xcode's build system does that
# automatically for SPM packages; a plain swift-build binary dies at runtime
# with "Failed to load the default metallib".
#
# Output goes to src-tauri/binaries/:
#   doklin-stt-<target-triple>   the executable (Tauri externalBin naming; the
#                                bundler strips the triple inside the .app)
#   *.bundle                     SPM resource bundles. mlx-swift_Cmlx.bundle
#                                holds the Metal kernels — the sidecar finds
#                                them next to itself in dev, and in
#                                Contents/Resources via Bundle.main when bundled.
#
# Run this once before `cargo check` / `tauri dev` / `tauri build`: tauri-build
# fails fast if the externalBin file is missing.
set -euo pipefail

cd "$(dirname "$0")/../src-tauri/stt-helper"

# Xcode 26+ ships the Metal compiler as a separate downloadable component.
if ! xcrun metal --version >/dev/null 2>&1; then
    echo "Metal Toolchain missing — run: xcodebuild -downloadComponent MetalToolchain" >&2
    exit 1
fi

TRIPLE=$(rustc --print host-tuple 2>/dev/null || rustc -vV | sed -n 's/^host: //p')
CONFIG=${1:-Release}

echo "building doklin-stt ($CONFIG) for $TRIPLE via xcodebuild…"
xcodebuild \
    -scheme doklin-stt \
    -configuration "$CONFIG" \
    -destination "generic/platform=macOS" \
    -derivedDataPath .xcbuild \
    -skipPackagePluginValidation \
    build | grep -E "error|warning: .*doklin|BUILD" || true

PRODUCTS=".xcbuild/Build/Products/$CONFIG"
if [[ ! -f "$PRODUCTS/doklin-stt" ]]; then
    echo "build failed: $PRODUCTS/doklin-stt missing" >&2
    exit 1
fi

DEST="../binaries"
mkdir -p "$DEST"

cp -f "$PRODUCTS/doklin-stt" "$DEST/doklin-stt-$TRIPLE"
# Resource bundles (Metal kernels etc.) must travel with the binary. Remove
# old copies first — `cp -R` MERGES directories, which leaves stale (and
# sometimes read-only) files behind and later breaks tauri-build's resource
# copying with EPERM.
find "$DEST" -maxdepth 1 -name '*.bundle' -exec rm -rf {} +
find "$PRODUCTS" -maxdepth 1 -name '*.bundle' -exec cp -R {} "$DEST/" \;

echo "staged:"
ls -la "$DEST"
