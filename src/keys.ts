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
