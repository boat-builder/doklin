// What a public URL resolves to, read from the synced tree and handed to the
// renderer: a note (its blob, frontmatter left off, comments stripped, widths
// and link records from its sidecar, links resolved against the public
// map), its html
// rendition framed or raw, a folder's table of contents, or an html document
// inside a published folder served by exact path. Nothing else is served:
// a workspace holds only documents (`syncs`, layout.ts). public.ts decides
// which of these a request means; render.ts turns the result into HTML.

import { WEB_TAG } from "./assets";
import { notFoundPage } from "./static";
import { nestedUrl, type DirPage, type PublicMap } from "./publicMap";
import {
  deriveDescription,
  framedPageHtml,
  leadTitle,
  markdownHtml,
  notePageHtml,
  tocPageHtml,
  type Crumb,
  type LinkOutcome,
  type PageMeta,
  type TocItem,
} from "./render";
import {
  basename,
  dirOf,
  htmlSiblingOf,
  isHtmlPath,
  isMarkdownPath,
  stemOf,
  type Located,
  type Workspace,
} from "./workspace";
import { stripComments } from "../../src/criticMarkup";
import { documentName, isNamedLink, linkKey, normalizePath } from "../../src/docLinks";
import { splitFrontmatter } from "../../src/frontmatter";
import type { LinkRecord } from "../../src/metaFile";
import { pageLinkOf } from "../../src/pageLink";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-robots-tag": "noindex",
};

const html = (body: string, status = 200): Response => new Response(body, { status, headers: HTML_HEADERS });

/** What a page's links can lead to: the pages of its own section and of
 *  Library. A page is drawn from those two trees, and kept in the cache
 *  under their two manifests (public.ts), so a document in any other section
 *  is a link's words, as an unpublished one is. */
export type Linked = {
  ws: Workspace;
  pub: PublicMap;
  /** Library's tree and map, for a page in another section; null for a page in Library. */
  library: { ws: Workspace; pub: PublicMap } | null;
  /** This workspace's id and the domain it answers on: a *Copy link* to one
   *  of its pages is followed like a link with a record. */
  workspace: string | null;
  host: string;
};

export type NoteOptions = {
  url: URL;
  /** The canonical path of this page ("/", "/<slug>", "/<dirSlug>/<rel>"). */
  pagePath: string;
  /** The folder page this note was reached through, if any: links prefer staying inside it. */
  dirSlug: string | null;
  crumb: Crumb | null;
  /** The public entry's own title and description, when the note has an entry of its own. */
  title?: string;
  desc?: string;
  /** "md" forces the markdown rendering of a note that has an html rendition. */
  view: "auto" | "md";
};

/**
 * A published note. Leads with the html rendition when the workspace holds
 * one beside it (`<stem>.html`), the markdown otherwise or on ?v=md; an html
 * file published on its own is framed the same way, with no pill.
 */
export async function notePage(linked: Linked, loc: Located, o: NoteOptions): Promise<Response> {
  const { ws } = linked;
  const path = loc.file.path;
  const pageUrl = `${o.url.origin}${o.pagePath}`;
  const rawUrl = o.pagePath.endsWith("/") ? `${o.pagePath}raw` : `${o.pagePath}/raw`;
  const stemName = stemOf(basename(path)).replace(/\.html$/i, "");

  if (isHtmlPath(path)) {
    const meta: PageMeta = {
      title: o.title?.trim() || stemName,
      description: o.desc?.trim() || `${stemName} on ${o.url.hostname}`,
      hostname: o.url.hostname,
      pageUrl,
      ogType: "article",
    };
    return html(framedPageHtml({ meta, crumb: o.crumb, hasMd: false, rawUrl }));
  }
  if (!isMarkdownPath(path)) return notFoundPage();

  const text = await ws.text(loc);
  if (text === null) return notFoundPage();
  const sibling = ws.fileAt(htmlSiblingOf(path));
  const hasHtml = sibling !== null;

  // The frontmatter is the business of agents and other tools, not of a
  // reader: a page leaves it off. Comments never leave the sidecar: only
  // their markers are in the file, and those go too.
  const body = stripComments(splitFrontmatter(text).body);
  const title = o.title?.trim() || leadTitle(body) || stemName;
  const description = o.desc?.trim() || deriveDescription(body) || `${title} on ${o.url.hostname}`;
  const meta: PageMeta = { title, description, hostname: o.url.hostname, pageUrl, ogType: "article" };

  if (hasHtml && o.view !== "md") {
    return html(framedPageHtml({ meta, crumb: o.crumb, hasMd: true, rawUrl }));
  }

  const sidecar = await ws.meta(stemOf(path));
  const links = linkResolver(linked, dirOf(path), o.dirSlug, sidecar?.links ?? []);
  const bodyHtml = markdownHtml(body, { tcols: sidecar?.tcols ?? [], links });
  return html(notePageHtml({ meta, crumb: o.crumb, hasHtml, bodyHtml, mermaidTag: WEB_TAG }));
}

/** Resolve a link written inside a note (`./plan.md`, `../x/y.md`) to a workspace path, or null when it isn't one. */
function relativeTarget(href: string, fromDir: string): { path: string; fragment: string } | null {
  let raw = href.trim();
  // Another scheme, a same-page anchor, a protocol-relative or a root-relative
  // URL: not a path in the workspace, left exactly as written.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/")) return null;
  const hash = raw.indexOf("#");
  const fragment = hash >= 0 ? raw.slice(hash) : "";
  if (hash >= 0) raw = raw.slice(0, hash);
  raw = raw.split("?")[0];
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // a malformed escape — take the path as written
  }
  const path = normalizePath(fromDir ? `${fromDir}/${raw}` : raw);
  if (path === "" || path === ".." || path.startsWith("../")) return null; // walks out of the workspace
  return { path, fragment };
}

/** The document a file id names in a tree, when it is one. */
function documentOf(ws: Workspace, fid: string): Located | null {
  const loc = ws.file(fid);
  return loc && (isMarkdownPath(loc.file.path) || isHtmlPath(loc.file.path)) ? loc : null;
}

/**
 * A link in a public page is rewritten to its document's public URL when
 * that is public — inside this published folder, on its own slug, or inside
 * another — and dropped to its words otherwise. Anything that isn't a link
 * to a document is left alone.
 *
 * A link with a record (`link`, src/metaFile.ts) goes by its file id, never
 * by its path, and a named one shows its document's name now. So does a
 * *Copy link* to a page of this workspace, by the ids it carries: an
 * outsider is taken to the page, not to doklin.cc. A link without a record
 * goes by its path, inside this page's own section.
 */
function linkResolver(linked: Linked, fromDir: string, dirSlug: string | null, records: LinkRecord[]) {
  const { ws, pub, library } = linked;
  const byId = (fid: string): { path: string; url: string | null } | null => {
    const own = documentOf(ws, fid);
    if (own) return { path: own.file.path, url: pub.urlFor(own.file.path, dirSlug) };
    const shared = library ? documentOf(library.ws, fid) : null;
    return shared && library ? { path: shared.file.path, url: library.pub.urlFor(shared.file.path) } : null;
  };
  return (href: string, words: string): LinkOutcome => {
    const page = pageLinkOf(href);
    if (page) {
      if (page.domain !== linked.host || page.workspace === "" || page.workspace !== linked.workspace) return { kind: "keep" };
      const url = byId(page.file)?.url;
      return url ? { kind: "rewrite", href: url } : { kind: "text" };
    }
    const key = linkKey(href);
    const record = key === null ? undefined : records.find((r) => r.id === key);
    if (key !== null && record) {
      const found = byId(record.file);
      if (!found?.url) return { kind: "text" };
      const hash = href.indexOf("#");
      const named = isNamedLink(words, key) ? { words: documentName(found.path) } : {};
      return { kind: "rewrite", href: `${found.url}${hash >= 0 ? href.slice(hash) : ""}`, ...named };
    }
    const target = relativeTarget(href, fromDir);
    if (!target) return { kind: "keep" };
    // A note linked without its extension, the way a wiki does.
    const file = ws.fileAt(target.path) ?? ws.noteAt(target.path);
    if (file) {
      const url = pub.urlFor(file.file.path, dirSlug);
      return url ? { kind: "rewrite", href: `${url}${target.fragment}` } : { kind: "text" };
    }
    const folder = pub.dirPage(target.path);
    if (folder) return { kind: "rewrite", href: `/${folder.slug}${target.fragment}` };
    return { kind: "text" };
  };
}

/* ---------- Renditions ---------- */

/** The html rendition a note keeps beside it (or an html file itself), byte for byte, sandboxed. */
export async function rawRendition(ws: Workspace, loc: Located): Promise<Response> {
  const path = loc.file.path;
  const rendition = isHtmlPath(path) ? loc : ws.fileAt(htmlSiblingOf(path));
  if (!rendition) return notFoundPage();
  return htmlFile(ws, rendition);
}

/**
 * An html document served as itself: a note's rendition, or an html page in
 * a published folder by its exact path. Under a sandbox, so its scripts run
 * under an opaque origin whether it is framed by the note's page or opened
 * directly. Any other file is not served: a note's picture is its alt text
 * (render.ts), because pictures stay on the device that has them.
 */
export async function htmlFile(ws: Workspace, loc: Located): Promise<Response> {
  if (!isHtmlPath(loc.file.path)) return notFoundPage();
  const obj = await ws.bytes(loc);
  if (!obj) return notFoundPage();
  return new Response(obj.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(obj.size),
      "cache-control": "no-cache",
      "x-robots-tag": "noindex",
      "content-security-policy": "sandbox allow-scripts allow-popups",
    },
  });
}

/* ---------- Folders ---------- */

/** A folder page's heading: the owner's title, else the folder's name, else the workspace's. */
export const dirTitle = (ws: Workspace, dir: DirPage): string =>
  dir.entry.title?.trim() || basename(dir.entry.path) || ws.name;

/** A published folder: every note under it, as a table of contents at Notion-style nested URLs. */
export function tocPage(ws: Workspace, dir: DirPage, o: { url: URL; pagePath: string }): Response {
  const notes = ws.children(dir.entry.path);
  const prefix = dir.entry.path ? `${dir.entry.path}/` : "";
  const items: TocItem[] = notes.map((loc) => {
    const rel = loc.file.path.slice(prefix.length);
    return { title: stemOf(basename(rel)), path: rel, href: nestedUrl(dir, loc.file.path) };
  });
  const newest = notes.reduce((n, loc) => Math.max(n, loc.file.mtime ?? 0), 0);
  const updatedLabel =
    newest > 0
      ? new Date(newest).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
      : null;
  const title = dirTitle(ws, dir);
  const description = dir.entry.desc?.trim() ?? "";
  const meta: PageMeta = {
    title,
    description: description || `${items.length} ${items.length === 1 ? "page" : "pages"} on ${o.url.hostname}`,
    hostname: o.url.hostname,
    pageUrl: `${o.url.origin}${o.pagePath}`,
    ogType: "website",
  };
  return html(tocPageHtml({ meta, title, description, items, updatedLabel }));
}
