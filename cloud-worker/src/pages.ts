// What a public URL resolves to, read from the synced tree and handed to the
// renderer: a note (its blob, comments stripped, frontmatter split off into
// properties, its boards derived from the folder's datastore, widths from
// its sidecar, links resolved against the public map), its html rendition
// framed or raw, a folder's table of contents, or a plain file inside a
// published folder served by exact path. public.ts decides which of these a
// request means; render.ts turns the result into HTML.

import { WEB_ASSETS } from "./assets";
import { notFoundPage } from "./static";
import { nestedUrl, type DirPage, type PublicMap } from "./publicMap";
import {
  deriveDescription,
  framedPageHtml,
  leadTitle,
  markdownHtml,
  notePageHtml,
  propsHtml,
  tocPageHtml,
  type Crumb,
  type DrawnBoard,
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
import { boardSnapshot, clipText, snapKeyOf, type PageProp, type PagePropValue } from "../../src/store/board";
import { parseEmbedConfig, storeFences } from "../../src/store/embedConfig";
import { parseFrontmatter, propList, propText, type Props } from "../../src/store/frontmatter";
import { RANK_KEY, type StoreDef } from "../../src/store/storeFile";

/** A page is a document, not a database export: this many boards, at most. */
const MAX_BOARDS = 20;

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
  if (!isMarkdownPath(path)) return fileResponse(ws, loc);

  const text = await ws.text(loc);
  if (text === null) return notFoundPage();
  const sibling = ws.fileAt(htmlSiblingOf(path));
  const hasHtml = sibling !== null;

  // Comments never leave the sidecar: only their markers are in the file,
  // and those go too. The frontmatter is the properties table, not prose.
  const clean = stripComments(text);
  const fm = parseFrontmatter(clean);
  const body = fm.present ? fm.body : clean;
  const title = o.title?.trim() || leadTitle(body) || stemName;
  const description = o.desc?.trim() || deriveDescription(body) || `${title} on ${o.url.hostname}`;
  const meta: PageMeta = { title, description, hostname: o.url.hostname, pageUrl, ogType: "article" };

  if (hasHtml && o.view !== "md") {
    return html(framedPageHtml({ meta, crumb: o.crumb, hasMd: true, rawUrl }));
  }

  const dir = dirOf(path);
  const [props, tcols, boards] = await Promise.all([
    fm.present && fm.order.length > 0 ? pageProps(ws, dir, fm.props, fm.order) : Promise.resolve([]),
    ws.meta(stemOf(path)).then((m) => m?.tcols ?? []),
    drawBoards(ws, pub, body, dir, o.dirSlug),
  ]);
  const bodyHtml = markdownHtml(body, { tcols, boards, links: linkResolver(ws, pub, dir, o.dirSlug) });
  return html(
    notePageHtml({
      meta,
      crumb: o.crumb,
      hasHtml,
      propsHtml: propsHtml(props),
      bodyHtml,
      mermaidTag: mermaidTag(),
    }),
  );
}

/**
 * The properties a published note shows above its body. A CARD's rows are
 * its board's declared fields, in the board's order, named and coloured the
 * way the desktop's properties header names and colours them; any other
 * note with frontmatter falls back to its own keys in file order,
 * uncoloured. Unset values are left out, and `rank` (a card's position on
 * its board, not a property) never shows.
 */
async function pageProps(ws: Workspace, dir: string, props: Props, order: string[]): Promise<PageProp[]> {
  const store = await ws.storeAt(dir);
  const def: StoreDef | null = store?.def ?? null;
  const values = (key: string): PagePropValue[] => {
    const raw = props[key];
    const field = def?.fields.find((f) => f.id === key) ?? null;
    const list = field?.type === "multi_select" || Array.isArray(raw) ? propList(raw) : [propText(raw)];
    return list
      .filter((text) => text !== "")
      .map((text) => {
        const opt = def?.options.find((o) => o.field === key && o.name === text);
        return { text: clipText(text), ...(opt?.color ? { color: opt.color } : {}) };
      });
  };
  const keys = def ? def.fields.map((f) => f.id) : order.filter((k) => k !== RANK_KEY);
  const rows: PageProp[] = [];
  for (const key of keys) {
    const vs = values(key);
    if (vs.length === 0) continue;
    rows.push({ name: clipText(def?.fields.find((f) => f.id === key)?.name ?? key), values: vs });
  }
  return rows;
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
 * when the target is public — inside this folder share, on its own slug, or
 * inside another — and dropped to plain text otherwise (the same rule a
 * board's card links follow). Anything that isn't a path is left alone.
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

/** Every board and table the note embeds, derived from the synced datastores its fences name. */
async function drawBoards(
  ws: Workspace,
  pub: PublicMap,
  body: string,
  fromDir: string,
  dirSlug: string | null,
): Promise<Map<string, DrawnBoard>> {
  const out = new Map<string, DrawnBoard>();
  const fences = storeFences(body);
  if (fences.length === 0) return out;
  const stores = new Map<string, ReturnType<Workspace["storeAt"]>>();
  for (const { kind, text } of fences) {
    const key = snapKeyOf(kind, text);
    if (out.has(key)) continue; // one picture serves every embed writing this config
    if (out.size >= MAX_BOARDS) break;
    const cfg = parseEmbedConfig(text);
    if (!cfg.store) continue; // a fence still waiting for its picker
    const target = relativeTarget(cfg.store, fromDir);
    if (!target) continue;
    const dir = target.path === "." ? "" : target.path;
    if (!stores.has(dir)) stores.set(dir, ws.storeAt(dir));
    const read = await stores.get(dir)!;
    if (!read) continue; // no board there — the fence stays a code block
    const snap = boardSnapshot(text, kind, read.def, read.cards, (cardPath) => pub.urlFor(cardPath, dirSlug) ?? undefined);
    if (snap) out.set(key, { snap, unread: read.unread });
  }
  return out;
}

/* ---------- Renditions and plain files ---------- */

/** The html rendition a note keeps beside it (or an html file itself), byte for byte, sandboxed. */
export async function rawRendition(ws: Workspace, loc: Located): Promise<Response> {
  const path = loc.file.path;
  const rendition = isHtmlPath(path) ? loc : ws.fileAt(htmlSiblingOf(path));
  if (!rendition) return notFoundPage();
  return fileResponse(ws, rendition);
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** Files that may run script when served as a document: they get an opaque origin. */
const SANDBOXED = new Set(["html", "svg"]);

/**
 * A synced file served as itself — an image a note shows, a PDF beside it,
 * an html rendition. Only what a note can usefully link to: anything else
 * in a published folder is not reachable. An html document is served under
 * a sandbox so its scripts run under an opaque origin whether it is framed
 * by the note's page or opened directly.
 */
export async function fileResponse(ws: Workspace, loc: Located): Promise<Response> {
  const ext = loc.file.path.slice(loc.file.path.lastIndexOf(".") + 1).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type || ext === loc.file.path.toLowerCase()) return notFoundPage();
  const obj = await ws.bytes(loc);
  if (!obj) return notFoundPage();
  return new Response(obj.body, {
    headers: {
      "content-type": type,
      "content-length": String(obj.size),
      "cache-control": "no-cache",
      "x-robots-tag": "noindex",
      ...(SANDBOXED.has(ext) ? { "content-security-policy": "sandbox allow-scripts allow-popups" } : {}),
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
