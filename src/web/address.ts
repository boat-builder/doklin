// A page's link, in a browser: made here, followed here, and read out of
// the page's own address.
//
//   https://doklin.cc/open#d=<domain>&w=<workspace>&s=<space>&f=<file>
//
// is the link as it is copied and sent: the address, and the key names, of
// engine/src/cloud/link.rs, `s` absent for the shared workspace — change
// both. The link page (site/public/open.html) sends a browser here with
// what the link carries after its `#`:
//
//   /app#w=<workspace>&s=<space>&f=<file>
//
// A link is resolved in the manifests already held, so following one asks
// the worker nothing, and like every link it is an address, never access:
// what opens a page is being in its section.

import type { Show } from "../backend";
import type { CloudPageLink } from "../cloud";
import type { Workspace } from "./workspace";

/** The address every link has, before its `#`. */
const PAGE = "https://doklin.cc/open";

/** The link to the stored file at `path`, and who can open it, as the engine
 *  says it (`linked`, engine/src/cloud/engine.rs — change both). Null when
 *  the workspace holds no file there. */
export function linkTo(ws: Workspace, path: string): CloudPageLink | null {
  const file = ws.stored(path);
  if (!file) return null;
  const link = new URLSearchParams({ d: location.host, w: ws.wsId });
  if (file.space !== "") link.set("s", file.space);
  link.set("f", file.fid);
  const space = ws.status().spaces.find((s) => s.id === file.space);
  const who = !space
    ? `Everyone in ${ws.name} can open it.`
    : space.kind === "private"
      ? "Only you can open it, on any device of yours."
      : `Only the people in “${space.name}” can open it.`;
  return { url: `${PAGE}#${link}`, who };
}

/** What a link to a page of this domain carries after its `#`, less the
 *  domain: what this page's own address takes. Null for any other address. */
export function ownLink(url: string): string | null {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return null;
  }
  const page = new URL(PAGE);
  if (!/^https?:$/.test(at.protocol) || at.hostname !== page.hostname || at.port !== "") return null;
  if (at.pathname !== page.pathname && at.pathname !== `${page.pathname}/`) return null;
  const link = new URLSearchParams(at.hash.slice(1));
  if ((link.get("d") ?? "").trim().toLowerCase() !== location.host) return null;
  link.delete("d");
  return link.toString();
}

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
