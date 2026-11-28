// A page's link, in a browser: made here, followed here, and read out of
// the page's own address. The link as it is copied and sent is
// src/pageLink.ts's. The link page (site/public/open.html) sends a browser
// here with what the link carries after its `#`:
//
//   /app#w=<workspace>&s=<space>&f=<file>
//
// A link is resolved in the manifests already held, so following one asks
// the worker nothing, and like every link it is an address, never access:
// what opens a page is being in its section.

import type { Show } from "../backend";
import type { CloudPageLink } from "../cloud";
import { pageLinkOf, pageLinkUrl } from "../pageLink";
import type { Workspace } from "./workspace";

/** The link to the stored file at `path`, and who can open it, as the engine
 *  says it (`linked`, engine/src/cloud/engine.rs) and the `@` list does
 *  (`whoCanOpen`, src/docLinks.ts) — change all three. Null when the
 *  workspace holds no file there. */
export function linkTo(ws: Workspace, path: string): CloudPageLink | null {
  const file = ws.stored(path);
  if (!file) return null;
  const url = pageLinkUrl({ domain: location.host, workspace: ws.wsId, space: file.space, file: file.fid });
  const space = ws.status().spaces.find((s) => s.id === file.space);
  const alone = space ? [...space.members, ...space.above].every((person) => person === ws.me) : false;
  const who = !space
    ? `Everyone in ${ws.name} can open it.`
    : space.kind === "private" || alone
      ? "Only you can open it, on any device of yours."
      : `Only the people “${space.name}” is shared with can open it.`;
  return { url, who };
}

/** What a link to a page of this domain carries after its `#`, less the
 *  domain: what this page's own address takes. Null for any other address. */
export function ownLink(url: string): string | null {
  const link = pageLinkOf(url);
  if (link === null || link.domain !== location.host) return null;
  const own = new URLSearchParams();
  if (link.workspace !== "") own.set("w", link.workspace);
  if (link.space !== "") own.set("s", link.space);
  if (link.file !== "") own.set("f", link.file);
  return own.toString();
}

/** The document the address asks for, taken out of the address: a reload
 *  opens what was open, not the link again. None when the address carries no
 *  link. Throws the reason, as a sentence, for a link that opens nothing. */
export function takeLink(ws: Workspace): Show[] {
  const link = new URLSearchParams(location.hash.slice(1));
  if (!link.get("f") && !link.get("w")) return [];
  history.replaceState(history.state, "", location.pathname + location.search);
  return [{ path: pathOfLink(ws, link), kind: "file" }];
}

/** Where a link to a page of this domain leads, a click in a note's own way
 *  there (`Cloud.follow`): the file's path. Null for any other address.
 *  Throws the reason, as a sentence, for one that opens nothing. */
export function followLink(ws: Workspace, url: string): string | null {
  const own = ownLink(url);
  return own === null ? null : pathOfLink(ws, new URLSearchParams(own));
}

/** The file a link's `w`, `s` and `f` name. Says the same of a page that was
 *  deleted, one in a section this person is not in and one that never was. */
function pathOfLink(ws: Workspace, link: URLSearchParams): string {
  const file = link.get("f");
  const workspace = link.get("w");
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
  return path;
}
