#!/bin/sh
# Builds what the iPhone app runs of the Mac's own frontend into ios/Editor/
# (ignored), and, run by Xcode as the app target's build phase, copies it
# into the app as Editor/:
#   - the note editor (src/ios-editor/: the Mac's own Milkdown set-up,
#     vite.ios-editor.config.ts), which ios/Doklin/NoteEditor.swift serves to
#     its web view
#   - flowchart.js, the flowchart renderer as one script
#     (src/flowchart/phone.ts, vite.ios-flowchart.config.ts), which the
#     reader runs to draw a note's flowcharts (ios/Doklin/FlowchartView.swift)
#
#   scripts/ios-editor.sh          build ios/Editor/
#
# Needs node and the frontend's dependencies (`pnpm install`). Xcode's PATH
# has neither nvm's nor Homebrew's bin, so both are looked for. Without node,
# what was built before is used, and said so.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/ios/Editor"

PATH="$HOME/.local/share/pnpm:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  for bin in "$HOME"/.nvm/versions/node/*/bin; do PATH="$bin:$PATH"; done
fi
export PATH

if command -v node >/dev/null 2>&1 && [ -d "$ROOT/node_modules/vite" ]; then
  echo "building the note editor…"
  (cd "$ROOT" && node node_modules/vite/bin/vite.js build --config vite.ios-editor.config.ts)
  echo "building the flowchart renderer…"
  (cd "$ROOT" && node node_modules/vite/bin/vite.js build --config vite.ios-flowchart.config.ts)
elif [ -f "$OUT/index.html" ] && [ -f "$OUT/flowchart.js" ]; then
  echo "warning: node or the frontend's dependencies are missing — using the note editor and the flowchart renderer built before (ios/Editor)" >&2
else
  echo "error: the note editor and the flowchart renderer need node and the frontend's dependencies: install node, then run pnpm install in $ROOT" >&2
  exit 1
fi

# Run by Xcode: into the app.
if [ -n "${TARGET_BUILD_DIR:-}" ] && [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
  dest="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Editor"
  rm -rf "$dest"
  cp -R "$OUT" "$dest"
fi
