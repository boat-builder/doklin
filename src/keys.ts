// How a shortcut is written for the keyboard in front of the person: "⌘⇧F"
// on an Apple keyboard, "Ctrl+Shift+F" on any other. The shortcuts
// themselves take either key (App.tsx); this is only what a hint says.
//
// Which keyboard it is is the browser's to say, not the backend's: the Mac
// app is always on one with a ⌘, a browser may be on either.

const APPLE = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

const NAMES: Record<string, string> = { "⌘": "Ctrl", "⇧": "Shift", "⌥": "Alt", "⌫": "Backspace" };

/** A shortcut written with the Mac's glyphs, as this keyboard has it. */
export function keys(mac: string): string {
  return APPLE ? mac : [...mac].map((key) => NAMES[key] ?? key).join("+");
}

// The shortcuts that work wherever focus is, an html page included, by name.
// The window's key handlers run them (`runShortcut`, App.tsx); keys pressed
// in an html view's frame never reach the window, so the frame passes these
// out by name (htmlBridge.ts). Only shortcuts that are harmless if a page
// fakes one belong here: the page's own scripts can post whatever the frame
// can. The page keeps the rest (⌘F, ⌘S, ⌘⌫, ⌘C/⌘X/⌘V, ⌘Z).
export const APP_SHORTCUTS = [
  "back",
  "forward",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "close-tab",
  "new-tab",
  "search",
  "open-file",
  "open-folder",
  "open-file-window",
  "open-folder-window",
  "next-tab",
  "previous-tab",
  "next-window",
  "previous-window",
  "split",
  "sidebar",
  "history",
] as const;
export type AppShortcut = (typeof APP_SHORTCUTS)[number];

export function isAppShortcut(name: unknown): name is AppShortcut {
  return (APP_SHORTCUTS as readonly unknown[]).includes(name);
}
