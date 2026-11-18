// A link in the page's address. The link page (site/public/open.html) sends
// a browser here with what a page link carries after its `#`:
//
//   /app#w=<workspace>&s=<space>&f=<file>
//
// the key names of engine/src/cloud/link.rs, `s` absent for the shared
// workspace — change both. It is resolved in the manifests already held, so
// following one asks the worker nothing, and like every link it is an
// address, never access: what opens a page is being in its section.

import type { Show } from "../backend";
import type { Workspace } from "./workspace";

/** The document the address asks for, taken out of the address: a reload
 *  opens what was open, not the link again. None when the address carries no
 *  link. Throws the reason, as a sentence, for a link that opens nothing —
 *  and says the same of a page that was deleted, one in a section this
 *  person is not in and one that never was. */
export function takeLink(ws: Workspace): Show[] {
  const link = new URLSearchParams(location.hash.slice(1));
  const file = link.get("f");
  const workspace = link.get("w");
  if (!file && !workspace) return [];
  history.replaceState(history.state, "", location.pathname + location.search);
  if (!file || !workspace) throw new Error("That link is cut short. Ask whoever sent it to copy it again.");
  if (workspace !== ws.wsId) {
    throw new Error(`That link is from before ${location.host} was set up again, and its page is gone.`);
  }
  const path = ws.pathOfFile(link.get("s") ?? "", file);
  if (!path) {
    throw new Error(
      `That page isn't one you can open in ${ws.name}: it may have been deleted, or moved where you can't see it.`,
    );
  }
  return [{ path, kind: "file" }];
}
