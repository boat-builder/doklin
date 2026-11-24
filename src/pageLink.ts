// A *Copy link*: the link to a page of a workspace, as it is copied and sent,
//
//   https://doklin.cc/open#d=<domain>&w=<workspace>&s=<space>&f=<file>
//
// with `s` absent for the shared workspace. The address and the key names
// are engine/src/cloud/link.rs's, whose tests hold this file to them: change
// both. Made and read here for the browser version (src/web/address.ts) and
// the worker's public pages (cloud-worker/src/pages.ts). Pure string work, so
// both can.

/** The address every link has, before its `#`. */
const PAGE = "https://doklin.cc/open";

/** What a link names: the domain its workspace answers on, lower-cased, and
 *  the ids of the workspace, the space its file is in ("" the shared one) and
 *  the file. An id the link leaves out is "". */
export type PageLink = { domain: string; workspace: string; space: string; file: string };

/** The link to a page. */
export function pageLinkUrl(link: PageLink): string {
  const params = new URLSearchParams({ d: link.domain, w: link.workspace });
  if (link.space !== "") params.set("s", link.space);
  params.set("f", link.file);
  return `${PAGE}#${params}`;
}

/** What a link to a page names; null for any other address, and for one that
 *  names no domain. */
export function pageLinkOf(url: string): PageLink | null {
  let at: URL;
  try {
    at = new URL(url.trim());
  } catch {
    return null;
  }
  const page = new URL(PAGE);
  if (!/^https?:$/.test(at.protocol) || at.hostname !== page.hostname || at.port !== "") return null;
  if (at.pathname !== page.pathname && at.pathname !== `${page.pathname}/`) return null;
  const link = new URLSearchParams(at.hash.slice(1));
  const domain = (link.get("d") ?? "").trim().toLowerCase();
  if (domain === "") return null;
  return { domain, workspace: link.get("w") ?? "", space: link.get("s") ?? "", file: link.get("f") ?? "" };
}
