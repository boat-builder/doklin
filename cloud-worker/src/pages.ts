// What a public URL resolves to, read from the synced tree and handed to the
// renderer: a note (its blob, frontmatter left off, comments stripped, widths
// from its sidecar, links resolved against the public map), its html
// rendition framed or raw, a folder's table of contents, or an html document
// inside a published folder served by exact path. Nothing else is served:
// a workspace holds only documents (`syncs`, layout.ts). public.ts decides
// which of these a request means; render.ts turns the result into HTML.

import { WEB_ASSETS } from "./assets";
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
import { normalizePath } from "../../src/docLinks";
import { splitFrontmatter } from "../../src/frontmatter";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-robots-tag": "noindex",
};

const html = (body: string, status = 200): Response => new Response(body, { status, headers: HTML_HEADERS });

/** The tag the mermaid module serves under: the bundle's content hash, or "dev" in a source-compiled worker. */
const mermaidTag = (): string => WEB_ASSETS?.tag ?? "dev";

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
export async function notePage(ws: Workspace, pub: PublicMap, loc: Located, o: NoteOptions): Promise<Response> {
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

  const tcols = (await ws.meta(stemOf(path)))?.tcols ?? [];
  const bodyHtml = markdownHtml(body, { tcols, links: linkResolver(ws, pub, dirOf(path), o.dirSlug) });
  return html(notePageHtml({ meta, crumb: o.crumb, hasHtml, bodyHtml, mermaidTag: mermaidTag() }));
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

/**
 * A relative link in a public page is rewritten to the target's public URL
 * when the target is public — inside this published folder, on its own slug, or
 * inside another — and dropped to plain text otherwise. Anything that isn't
 * a path is left alone.
 */
function linkResolver(ws: Workspace, pub: PublicMap, fromDir: string, dirSlug: string | null) {
  return (href: string): LinkOutcome => {
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
