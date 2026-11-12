import { getCurrentWindow } from "@tauri-apps/api/window";
import type React from "react";

// The title row has no drag strip of its own: every gap in it — the lead
// beside the traffic lights, the tab bar's empty stretch — moves the window,
// and a double-click there zooms, as a native title bar would.
//
// Bound as onMouseDown on each gap container, and acts only when the press
// lands on the container itself (target === currentTarget), so the tabs and
// buttons inside keep their own clicks and drags.
//
// The drag is driven here rather than through the passive
// `data-tauri-drag-region` attribute: on macOS/WKWebView its injected
// mousedown handler intermittently fails to start the native drag, and a
// missed drag falls through to a normal content interaction (selecting text
// instead of moving the window). Starting it from mousedown, with the default
// prevented, is reliable and never selects text.
export function dragWindowFromGap(e: React.MouseEvent) {
  if (e.button !== 0 || e.target !== e.currentTarget) return;
  e.preventDefault();
  const win = getCurrentWindow();
  if (e.detail === 2) void win.toggleMaximize();
  else void win.startDragging();
}
