// Callouts: GitHub's alerts (`> [!NOTE]` and four more), as Doklin draws
// them. Pure — the editor (callout.ts), the iPhone's editor, the worker's
// public pages (cloud-worker/src/render.ts) and the harness all read the five
// kinds from here, so a name, a meaning or an icon has one source.
//
// The meanings are the type picker's and `doklin help writing`'s
// (cli/src/help.rs WRITING): change both. The iPhone's reader draws the same
// kinds with SF Symbols of the same shapes (ios/Doklin/MarkdownView.swift).

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export type CalloutInfo = {
  /** What the title says. */
  name: string;
  /** One line on when to use it: the picker's second line. */
  meaning: string;
  /** The icon's inner SVG, on a 24 grid, drawn with currentColor strokes. */
  icon: string;
};

export const CALLOUTS: Record<CalloutKind, CalloutInfo> = {
  note: {
    name: "Note",
    meaning: "Worth knowing, even when skimming",
    icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="7.6" x2="12.01" y2="7.6"/>',
  },
  tip: {
    name: "Tip",
    meaning: "A better or easier way to do it",
    icon: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  },
  important: {
    name: "Important",
    meaning: "Needed to get it right",
    icon: '<path d="M20 15.5a2 2 0 0 1-2 2H8.5L4 21V5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><line x1="12" y1="7.5" x2="12" y2="11"/><line x1="12" y1="14" x2="12.01" y2="14"/>',
  },
  warning: {
    name: "Warning",
    meaning: "Needs attention to avoid a problem",
    icon: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  },
  caution: {
    name: "Caution",
    meaning: "A risk: what could go wrong",
    icon: '<polygon points="7.86 2.5 16.14 2.5 21.5 7.86 21.5 16.14 16.14 21.5 7.86 21.5 2.5 16.14 2.5 7.86"/><line x1="12" y1="8" x2="12" y2="12.5"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  },
};

/** The icon as a whole SVG element, sized by CSS. */
export function calloutIconSvg(kind: CalloutKind, className = "callout-icon"): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CALLOUTS[kind].icon}</svg>`;
}

/**
 * A callout's marker: `[!NOTE]` alone on its line, any case (Obsidian writes
 * `[!note]`). Returns the kind and the marker word as written, or null. A
 * title or a fold flag after it (`[!NOTE] Title`, `[!note]-`) is not GitHub's
 * syntax, so such a quote stays a quote, as GitHub shows it.
 */
export function parseCalloutMarker(line: string): { kind: CalloutKind; marker: string } | null {
  const m = /^\[!([A-Za-z]+)\][ \t]*$/.exec(line);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(kind) ? { kind: kind as CalloutKind, marker: m[1] } : null;
}

/** The marker line a callout writes: the word as it was read, or uppercase for a new one. */
export function calloutMarkerLine(kind: CalloutKind, marker?: string): string {
  const word = marker && marker.toLowerCase() === kind ? marker : kind.toUpperCase();
  return `[!${word}]`;
}
