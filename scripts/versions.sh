#!/bin/sh
# What a folder's version history holds right now (docs/versioning.md).
#
# The store is deliberately invisible in the app until phase 2 puts a surface
# on it, so this is how you watch it work — and how the manual pass in
# docs/versioning-plan.md §4.8 is run.
#
#   scripts/versions.sh ~/Notes        print the history once
#   scripts/versions.sh -w ~/Notes     print it every 5 s, until ^C
#   scripts/versions.sh drafts         the drafts store
#
# macOS-only: the app-data path and `shasum` are the Mac's.
set -eu

WATCH=0
if [ "${1:-}" = "-w" ]; then
    WATCH=1
    shift
fi

APP="$HOME/Library/Application Support/com.sherin.doklin"
TARGET="${1:-.}"
if [ "$TARGET" = "drafts" ]; then
    ROOT="$APP/drafts"
    KEY="drafts"
else
    # The store key the app derives: "r-" and the first 16 hex characters of
    # the sha256 of the folder's canonical path (`pwd -P` resolves the
    # symlinks `std::fs::canonicalize` does).
    ROOT=$(cd "$TARGET" && pwd -P)
    if [ "$ROOT" = "$APP/drafts" ]; then
        KEY="drafts"
    else
        KEY="r-$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-16)"
    fi
fi
DIR="$APP/versions/$KEY"

show() {
    echo "$ROOT"
    echo "$DIR"
    if [ ! -f "$DIR/index.json" ]; then
        echo "  no store here yet — a folder gets one when a window opens it,"
        echo "  drafts when the app starts"
        return
    fi
    python3 - "$DIR" <<'PY'
import datetime, json, os, sys

store = sys.argv[1]
index = json.load(open(os.path.join(store, "index.json")))
for s in index["snapshots"]:
    when = datetime.datetime.fromtimestamp(s["ts"] / 1000).strftime("%a %H:%M:%S")
    pin = " *" if s["pinned"] else ""
    name = "  " + s["label"] if s.get("label") else ""
    came_from = "  ← %d" % s["restoredFrom"] if s.get("restoredFrom") else ""
    print("  %s  %-11s %5d files %9.1f KB%s%s%s" % (when, s["reason"], s["files"], s["bytes"] / 1024, came_from, pin, name))

blobs = sum(len(files) for _, _, files in os.walk(os.path.join(store, "blobs")))
# cloud-cache/ holds snapshots other Macs mirrored, pulled down once and kept
# (docs/versioning.md §6.3). A cache, not the store: it is safe to delete.
cached = len(next(os.walk(os.path.join(store, "cloud-cache")), (None, None, []))[2])
disk = sum(os.path.getsize(os.path.join(root, f)) for root, _, files in os.walk(store) for f in files)
mirrored = "  + %d from other Macs" % cached if cached else ""
print("  %d snapshot(s), %d blob(s), %.1f KB on disk%s" % (len(index["snapshots"]), blobs, disk / 1024, mirrored))
PY
}

if [ "$WATCH" = "1" ]; then
    while true; do
        clear
        date "+%H:%M:%S"
        show
        sleep 5
    done
else
    show
fi
