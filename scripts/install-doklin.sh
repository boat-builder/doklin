#!/bin/sh
# Installs `doklin`, the command-line tool an agent uses to work with a Doklin
# workspace through its domain. One static binary and
# nothing else — no runtime, no background process, no copy of any workspace.
#
#   curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh
#
# It is attached to every release, verbatim, beside the binaries it fetches:
#
#   doklin-linux-x64      Linux, x86_64    (static, musl — any distribution)
#   doklin-linux-arm64    Linux, aarch64   (static, musl)
#   doklin-macos-arm64    macOS, Apple Silicon
#   SHA256SUMS            what each of them must hash to
#
# Where it goes: $DOKLIN_INSTALL_DIR when set; otherwise /usr/local/bin when
# this user may write there (a container's root can), otherwise ~/.local/bin.
# It never asks for a password. Running it again replaces the binary with the
# newest one — that is the whole update story.
#
# The macOS binary is not notarized, which is fine for a file this script
# fetches (curl sets no quarantine flag) and not for one saved from a browser.
set -eu

BASE="https://github.com/boat-builder/doklin/releases/latest/download"

say() { printf '%s\n' "$*"; }
die() {
  printf 'install-doklin: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "doklin runs on Linux and macOS — this is $(uname -s). On Windows, use WSL." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "there is no doklin for $(uname -m) — it is built for x86_64 and arm64." ;;
esac
[ "$os-$arch" != "macos-x64" ] || die "there is no doklin for Intel Macs — Apple Silicon only."
ASSET="doklin-$os-$arch"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "this needs curl or wget, and neither is installed."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "this needs sha256sum or shasum to check the download, and neither is installed."
fi

DIR="${DOKLIN_INSTALL_DIR:-}"
if [ -z "$DIR" ]; then
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    DIR=/usr/local/bin
  else
    DIR="$HOME/.local/bin"
  fi
fi
mkdir -p "$DIR" || die "could not create $DIR — set DOKLIN_INSTALL_DIR to a directory you may write to."
[ -w "$DIR" ] || die "$DIR is not writable — set DOKLIN_INSTALL_DIR to a directory you may write to."

# Downloaded beside where it will live, so the last step is a rename: the
# command is never half-written, and a running `doklin` keeps its own file.
TMP="$(mktemp -d "$DIR/.doklin-install.XXXXXX")" || die "could not write in $DIR."
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "could not download the checksums from $BASE — is this machine online?"
fetch "$BASE/$ASSET" "$TMP/doklin" || die "could not download $ASSET from $BASE."

WANT="$(awk -v name="$ASSET" '$2 == name || $2 == "*" name { print $1 }' "$TMP/SHA256SUMS")"
[ -n "$WANT" ] || die "the release's checksums do not list $ASSET."
GOT="$(sha256 "$TMP/doklin")"
[ "$WANT" = "$GOT" ] ||
  die "the download does not match its checksum — a release may have been published while this ran. Run it again."

chmod 755 "$TMP/doklin"
VERSION="$("$TMP/doklin" --version)" || die "the downloaded binary does not run on this machine."
mv -f "$TMP/doklin" "$DIR/doklin"

say "$VERSION installed: $DIR/doklin"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) say "$DIR is not on this shell's PATH — run it as $DIR/doklin, or add that directory to PATH." ;;
esac
say
say "Next, with the line the workspace's owner gave you:"
say "  doklin login <domain> <code>"
say "  doklin help agent"
