#!/bin/sh
# Builds the engine's C interface (engine/ffi) as the static library the
# iPhone app links, into ios/Engine/<platform>/libdoklin_engine_ffi.a:
#
#   scripts/ios-engine.sh                 the simulator and the device
#   scripts/ios-engine.sh iphonesimulator just the simulator (Apple Silicon only:
#                                         the project excludes x86_64 there)
#   scripts/ios-engine.sh iphoneos        just the device
#   scripts/ios-engine.sh host            this machine: what `swift test` links
#
# Xcode runs it before it compiles (the app target's first build phase), with
# PLATFORM_NAME saying which; `swift test` needs `host` built first and
# `-Xlinker -L<repo>/ios/Engine/host` (verify-harness/drive-ios.mjs does both).
# ios/Engine/ is build output: ignored, never committed.
#
# DOKLIN_ENGINE_PROFILE=debug builds faster and runs slower; the default is
# release, which is what a simulator run wants too (the first sync hashes and
# gunzips every file).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/ios/Engine"
PROFILE="${DOKLIN_ENGINE_PROFILE:-release}"

# The oldest iOS the app runs on, read from the project: what the engine's C
# and assembly (ring, under rustls) is compiled for too. Left to itself, cc
# takes the SDK's own version, and the app links code marked for a newer iOS.
IOS_MIN="$(sed -n 's/.*IPHONEOS_DEPLOYMENT_TARGET = \([0-9.]*\);/\1/p' "$ROOT/ios/Doklin.xcodeproj/project.pbxproj" | sort -u)"
case "$IOS_MIN" in
  "" | *[!0-9.]*)
    echo "error: ios/Doklin.xcodeproj does not name one IPHONEOS_DEPLOYMENT_TARGET" >&2
    exit 1
    ;;
esac

# Xcode's PATH leaves out where rustup puts cargo.
PATH="$HOME/.cargo/bin:$PATH"
export PATH

command -v cargo >/dev/null 2>&1 || {
  echo "error: cargo is not installed — https://rustup.rs, then: rustup target add aarch64-apple-ios aarch64-apple-ios-sim" >&2
  exit 1
}

# <platform> [<rust target>]: build, and put the library where Xcode looks.
build() {
  platform="$1"
  target="${2:-}"
  if [ -n "$target" ]; then
    rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target"
    set -- --target "$target"
    built="$ROOT/engine/target/$target/$PROFILE"
  else
    set --
    built="$ROOT/engine/target/$PROFILE"
  fi
  [ "$PROFILE" = release ] && set -- "$@" --release
  echo "building the engine for $platform ($PROFILE)…"
  # Xcode's SDKROOT and macOS deployment target would misdirect the compiler
  # cargo starts for build scripts, which run on the Mac.
  env -u SDKROOT -u MACOSX_DEPLOYMENT_TARGET IPHONEOS_DEPLOYMENT_TARGET="$IOS_MIN" \
    cargo build --locked --manifest-path "$ROOT/engine/Cargo.toml" -p doklin-engine-ffi "$@"
  mkdir -p "$OUT/$platform"
  cp "$built/libdoklin_engine_ffi.a" "$OUT/$platform/libdoklin_engine_ffi.a"
}

case "${1:-all}" in
  host) build host ;;
  iphonesimulator) build iphonesimulator aarch64-apple-ios-sim ;;
  iphoneos) build iphoneos aarch64-apple-ios ;;
  all)
    build iphonesimulator aarch64-apple-ios-sim
    build iphoneos aarch64-apple-ios
    ;;
  *)
    echo "usage: scripts/ios-engine.sh [host|iphonesimulator|iphoneos]" >&2
    exit 2
    ;;
esac
