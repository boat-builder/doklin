// One tab of a browser asks the worker whether anything moved, and the rest
// hear what it was told: every poll is a request against the account's day,
// and ten tabs of one workspace are one device.
//
// The tab that asks is the one in use. It holds a lock no other tab of this
// origin can hold with it (Web Locks); a tab that comes into use takes the
// lock from whichever had it, and a tab that closes lets the next one have
// it. What the worker answered goes to the others over a BroadcastChannel.
// A browser with neither is one tab on its own.

import type { PollAnswer } from "../../cloud-worker/src/wire";

const LOCK = "doklin:web:lead";
const CHANNEL = "doklin:web";

export type Tabs = {
  /** Whether this tab is the one that asks. */
  leading(): boolean;
  /** This tab is in use: it asks from now on. */
  claim(): void;
  /** What the worker answered, for the other tabs. */
  tell(poll: PollAnswer): void;
};

export function tabs(on: {
  /** This tab asks from now on. */
  lead(): void;
  /** Another tab does. */
  follow(): void;
  /** What the tab that asks was answered. */
  heard(poll: PollAnswer): void;
}): Tabs {
  const locks = typeof navigator.locks === "object" ? navigator.locks : null;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  let leading = false;
  let claiming = false;
  let queued: AbortController | null = null;

  channel?.addEventListener("message", (e: MessageEvent<{ poll?: PollAnswer }>) => {
    if (!leading && e.data?.poll) on.heard(e.data.poll);
  });

  // Held for as long as the page lives, or until another tab takes it.
  const held = () => {
    leading = true;
    claiming = false;
    queued = null;
    on.lead();
    return new Promise<never>(() => {});
  };
  // The request ended without this tab letting go: taken by the tab now in
  // use — or, for a request still waiting, withdrawn by `claim` below.
  const ended = () => {
    claiming = false;
    if (!leading) return;
    leading = false;
    on.follow();
    wait();
  };
  const wait = () => {
    if (!locks) return;
    queued = new AbortController();
    locks.request(LOCK, { signal: queued.signal }, held).catch(ended);
  };

  if (!locks) {
    leading = true;
    queueMicrotask(on.lead);
  } else if (document.hasFocus()) {
    claiming = true;
    locks.request(LOCK, { steal: true }, held).catch(ended);
  } else {
    wait();
  }

  return {
    leading: () => leading,
    claim() {
      if (!locks || leading || claiming) return;
      claiming = true;
      queued?.abort();
      queued = null;
      locks.request(LOCK, { steal: true }, held).catch(ended);
    },
    tell(poll) {
      channel?.postMessage({ poll });
    },
  };
}
