// One-time stored-data migration: what this browser kept from before the
// Library layout, renamed into it.
//
// A browser named a shared document `/<Name>/<path>` until the shared
// section moved into its own folder, and names it `/<Name>/Library/<path>`
// now (workspace.ts). What it kept under the old names is renamed by the
// rule the engine's move follows (`toLibraryLayout`, src/cloud.ts), applied
// to the path after `/<Name>/`:
//
//   doklin:web:draft:<ws>:<person>:<tab>:<path>   what a tab had yet to send (saving.ts):
//                                                 unsent work, so never dropped
//   doklin:session, doklin:sidebar-tree           the app's own (App.tsx, Sidebar.tsx)
//
// It runs once a browser, before anything reads them, and `DONE` records
// that it has. A draft whose new name cannot be written keeps its old one,
// and the record waits: the next load tries again.

import { toLibraryLayout } from "../cloud";
import { DRAFTS } from "./saving";

const DONE = "doklin:web:library-layout";

/** `path`, an absolute path of the browser's (`/<Name>/…`), in the Library layout. */
function inLibrary(path: string): string {
  const cut = path.indexOf("/", 1);
  if (!path.startsWith("/") || cut === -1) return path;
  return `${path.slice(0, cut)}/${toLibraryLayout(path.slice(cut + 1))}`;
}

/** Rename each draft's key into the Library layout: the new key is written
 *  before the old one goes. False when one could not be. */
function moveDrafts(): boolean {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(DRAFTS)) keys.push(key);
  }
  let whole = true;
  for (const key of keys) {
    // `<ws>:<person>:<tab>:` — ids, none of which holds a colon — then the path.
    const head = key.slice(DRAFTS.length).split(":", 3);
    const prefix = `${DRAFTS}${head.join(":")}:`;
    const path = key.slice(prefix.length);
    const moved = inLibrary(path);
    const draft = localStorage.getItem(key);
    if (head.length < 3 || moved === path || draft === null) continue;
    try {
      localStorage.setItem(`${prefix}${moved}`, draft);
      localStorage.removeItem(key);
    } catch {
      whole = false;
    }
  }
  return whole;
}

/** Move what this browser kept into the Library layout, once: its drafts,
 *  and with `app` what the app keeps for the workspace at `root`. */
export function moveIntoLibrary(root: string, app: (root: string) => void): void {
  try {
    if (localStorage.getItem(DONE) !== null) return;
    if (!moveDrafts()) return;
    app(root);
    localStorage.setItem(DONE, "1");
  } catch {
    // A browser that keeps nothing has nothing to move.
  }
}
