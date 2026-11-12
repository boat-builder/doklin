// The paths with a page of their own on the open workspace's domain, as
// absolute paths: what a tab and a board's card mark with the broadcast
// glyph. App publishes the set whenever the workspace's status changes.
//
// A module store rather than a prop, because a board inside a note (a
// ```kanban embed, src/storeEmbed.ts) renders in a React root of its own
// that nothing in App can hand a prop to.

import { useSyncExternalStore } from "react";
import { publishedByPath, type CloudStatus } from "./cloud";

let live: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

/** The absolute paths with a page of their own in this status (none when the
 *  workspace isn't connected). */
export function livePathsOf(s: CloudStatus | null): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  for (const rel of publishedByPath(s).keys()) out.add(rel ? `${s.root}/${rel}` : s.root);
  return out;
}

export function setLivePages(next: ReadonlySet<string>) {
  if (next.size === live.size && [...next].every((p) => live.has(p))) return;
  live = next;
  for (const f of listeners) f();
}

export function useLivePages(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => live);
}

/** The broadcast mark a live page carries on its tab and its card. */
export function LiveGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <path d="M5.4 5.4a3.7 3.7 0 0 0 0 5.2M10.6 5.4a3.7 3.7 0 0 1 0 5.2M3.3 3.3a6.6 6.6 0 0 0 0 9.4M12.7 3.3a6.6 6.6 0 0 1 0 9.4" />
    </svg>
  );
}
