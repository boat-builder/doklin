// The browser's own Back and Forward, for the tab in front (`BrowserHistory`,
// src/backend.ts). Every step a tab takes by a link followed in it pushes an
// entry onto the browser's history, numbered; the browser moving between two
// of them is a step back or forward for whichever tab is in front then. The
// app's own Back and Forward go through the browser while it has an entry of
// the app's that way, so the two never drift apart by a step.
//
// The entries stay at the page's own address: what is open is the app's to
// say (its session), and a reload opens that, not an entry.

import type { BrowserHistory } from "../backend";

/** The number an entry of the app's carries in its state; 0 for any other. */
const numberOf = (state: unknown): number => {
  const n = (state as { doklinStep?: unknown } | null)?.doklinStep;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

export function browserHistory(): BrowserHistory {
  let at = numberOf(history.state);
  // The furthest entry of the app's ahead; after a reload, none is known.
  let last = at;
  const heard = new Set<(by: -1 | 1) => void>();
  addEventListener("popstate", (e) => {
    const now = numberOf(e.state);
    const by = now < at ? -1 : now > at ? 1 : 0;
    at = now;
    if (by !== 0) for (const cb of heard) cb(by);
  });
  return {
    took() {
      at += 1;
      last = at;
      history.pushState({ ...(history.state ?? {}), doklinStep: at }, "");
    },
    go(by) {
      if (by < 0 ? at <= 0 : at >= last) return false;
      history.go(by);
      return true;
    },
    onStep(cb) {
      heard.add(cb);
      return () => {
        heard.delete(cb);
      };
    },
  };
}
