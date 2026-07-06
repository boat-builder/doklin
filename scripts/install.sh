#!/bin/sh
# Builds Doklin from source and installs both the .app bundle and the `doklin` CLI
# shim. Safe to re-run after code changes — the previous bundle is removed
# before the new one is copied so LaunchServices doesn't cache stale
# associations.
#
# Defaults:
#   - .app installs to /Applications (falls back to sudo when needed)
#   - doklin shim installs to /usr/local/bin (or ~/.local/bin if not writable)
#
# Env overrides (rarely needed):
#   APP_DIR=~/Applications  ./scripts/install.sh
#   CLI_DIR=~/.local/bin    ./scripts/install.sh
#   SKIP_BUILD=1            ./scripts/install.sh   # re-install without rebuilding
#   SKIP_CLI=1              ./scripts/install.sh   # only the .app

set -e

APP_NAME="Doklin.app"
SHIM_NAME="doklin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"

APP_DIR="${APP_DIR:-/Applications}"
CLI_DIR="${CLI_DIR:-/usr/local/bin}"

# ---------- 0. Make cargo / rustc available ----------
#
# rustup's installer wires up ~/.bash_profile and ~/.profile, neither of which
# zsh (the macOS default) reads. If cargo isn't already on PATH, source
# ~/.cargo/env to pick it up for this script's invocation.
if ! command -v cargo >/dev/null 2>&1; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found on PATH and ~/.cargo/env doesn't exist." >&2
    echo "       install Rust via https://rustup.rs and re-run." >&2
    exit 1
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found on PATH. install with: npm i -g pnpm" >&2
  exit 1
fi

# ---------- 1. Build ----------
if [ -z "$SKIP_BUILD" ]; then
  cd "$REPO_ROOT"
  if [ ! -d node_modules ]; then
    echo "==> installing JS deps"
    pnpm install
  fi
  echo "==> building release bundle"
  pnpm tauri build
fi

if [ ! -d "$SRC_APP" ]; then
  echo "error: $SRC_APP not found after build." >&2
  exit 1
fi

# ---------- 2. Install the .app ----------
if [ ! -d "$APP_DIR" ]; then
  echo "error: install directory $APP_DIR does not exist." >&2
  exit 1
fi

DEST_APP="$APP_DIR/$APP_NAME"
APP_SUDO=""
if [ ! -w "$APP_DIR" ]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "==> $APP_DIR needs elevated permissions"
    APP_SUDO="sudo"
  else
    echo "error: $APP_DIR is not writable and sudo is unavailable." >&2
    exit 1
  fi
fi

echo "==> installing $APP_NAME to $APP_DIR"
$APP_SUDO rm -rf "$DEST_APP"
$APP_SUDO cp -R "$SRC_APP" "$DEST_APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$DEST_APP" >/dev/null 2>&1 || true
fi

# `pnpm tauri build` leaves a fully-formed Doklin.app in target/, which Spotlight
# and "Open With" index as a SECOND app alongside the one we just installed.
# Unregister that build artifact from LaunchServices and mark target/ as
# non-indexable so it stops surfacing. (cargo clean removes the marker; this
# script re-adds it on every run.)
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -u "$SRC_APP" >/dev/null 2>&1 || true
fi
touch "$REPO_ROOT/src-tauri/target/.metadata_never_index" 2>/dev/null || true

# ---------- 3. Install the CLI shim ----------
if [ -z "$SKIP_CLI" ]; then
  if [ ! -d "$CLI_DIR" ] || [ ! -w "$CLI_DIR" ]; then
    if [ "$CLI_DIR" = "/usr/local/bin" ]; then
      FALLBACK="$HOME/.local/bin"
      echo "==> $CLI_DIR is not writable — using $FALLBACK"
      CLI_DIR="$FALLBACK"
      mkdir -p "$CLI_DIR"
    else
      echo "error: $CLI_DIR is not writable." >&2
      exit 1
    fi
  fi

  SHIM="$CLI_DIR/$SHIM_NAME"
  echo "==> installing $SHIM_NAME shim to $CLI_DIR"
  cat > "$SHIM" <<'EOS'
#!/bin/sh
# doklin — open markdown files (or a folder) in the Doklin editor.
if [ $# -eq 0 ]; then
  open -a "Doklin"
  exit $?
fi
args=""
for f in "$@"; do
  case "$f" in
    /*) abs="$f" ;;
    *)  abs="$PWD/$f" ;;
  esac
  args="$args \"$abs\""
done
# -n forces a new instance to launch so the file is delivered as argv; the
# single-instance plugin forwards it to the running app, which opens it in a
# new window (or focuses an existing window already showing it). Without -n,
# `open -a` on a running app just activates it and drops --args.
eval open -n -a \"Doklin\" --args $args
EOS
  chmod +x "$SHIM"

  case ":$PATH:" in
    *":$CLI_DIR:"*) ;;
    *) echo "note: $CLI_DIR is not on \$PATH — add it to your shell profile." ;;
  esac
fi

echo
echo "done."
echo "  app: $DEST_APP"
if [ -z "$SKIP_CLI" ]; then
  echo "  cli: $SHIM"
fi
