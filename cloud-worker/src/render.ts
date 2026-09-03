// The renderer — today's, ported (docs/cloud.md §5.6): marked with
// the app's own reading CSS, light and dark, boards and tables drawn as
// static HTML from a datastore's snapshot, a note's properties above its
// body, column widths from the meta sidecar as a <colgroup>, links between
// public notes rewritten, the folder table of contents, the MD/HTML pill,
// the "back to the folder" crumb, and the mermaid hydration script. Pure
// string work: what feeds it (pages.ts) does the reading.
//
// Everything renders without JavaScript. A board on a public page is
// something to read, not to drag; a diagram keeps its source as a code
// block until the hydrator swaps the SVG in, and stays a code block for a
// reader with scripts off.

import { Marked, Renderer, type Tokens } from "marked";
import { escapeHtml } from "./http";
import { deriveId, type TableCols } from "../../src/metaFile";
import { KANBAN_LANG, TABLE_LANG } from "../../src/store/embedConfig";
import {
  snapKeyOf,
  type BoardChip,
  type BoardSnap,
  type KanbanSnap,
  type PageProp,
  type TableSnap,
} from "../../src/store/board";

/* ---------- Words ---------- */

/** First ~200 visible characters of a document, markdown syntax removed — the description meta. */
export function deriveDescription(md: string): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#|-]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** A document that opens with an H1 names itself. Null: no lead heading. */
export function leadTitle(md: string): string | null {
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  const m = lines[i]?.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/);
  if (!m) return null;
  const text = m[1]
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  return text ? text.slice(0, 256) : null;
}

/* ---------- Boards and properties ----------

   A note can embed a datastore with a ```kanban fence (columns of cards) or
   a ```table one (rows of the same cards). The fence's body only NAMES the
   store (`store: ./Projects`); the store itself is a folder of card files —
   synced, so the worker reads it (workspace.ts) and derives the picture
   with the very code the app's tab and embed use (src/store/board.ts).
   `boardsRenderer` swaps that picture in for the fence. A fence whose store
   isn't there keeps marked's own code block: the fence is content, the
   board is presentation. */

/** A drawn snapshot plus what the read left out (workspace.ts MAX_STORE_CARDS). */
export type DrawnBoard = { snap: BoardSnap; unread: number };

// Every chip names a palette colour, grey when it has none — the same
// `dk-color-${color ?? "grey"}` the app writes, so the two markups match.
const chipHtml = (chip: BoardChip): string =>
  `<span class="dk-chip dk-color-${chip.color ?? "grey"}">${escapeHtml(chip.text)}</span>`;

const boardFoot = (unread: number): string =>
  unread > 0
    ? `<div class="dk-board-foot">${unread} more ${unread === 1 ? "card isn't" : "cards aren't"} shown here</div>`
    : "";

/** One board, as the page shows it — class for class the app's own markup, with nothing interactive. */
export function boardHtml(board: KanbanSnap, unread = 0): string {
  const total = board.columns.reduce((n, c) => n + c.cards.length + (c.more ?? 0), 0) + unread;
  const cols = board.columns
    .map((col) => {
      const cards = col.cards
        .map((card) => {
          const title = escapeHtml(card.title);
          // A card links to its own page exactly when it has one; otherwise
          // it is a title, not a dead link.
          const face = card.page
            ? `<a class="dk-card-title" href="${escapeHtml(card.page)}">${title}</a>`
            : `<span class="dk-card-title">${title}</span>`;
          const chips = card.chips ? `<div class="dk-card-chips">${card.chips.map(chipHtml).join("")}</div>` : "";
          return `<li class="dk-card">${face}${chips}</li>`;
        })
        .join("");
      // A div, not a <p>: `.doc p` is the document's paragraph styling.
      const more = col.more ? `<div class="dk-col-more">+${col.more} more</div>` : "";
      return `<section class="dk-col"><header class="dk-col-head"><span class="dk-col-dot dk-color-${
        col.color ?? "grey"
      }"></span><span class="dk-col-name">${escapeHtml(col.name)}</span><span class="dk-col-count">${
        col.cards.length + (col.more ?? 0)
      }</span></header><ul class="dk-col-list">${cards}</ul>${more}</section>`;
    })
    .join("");
  const name = board.name ? `<span class="dk-board-name">${escapeHtml(board.name)}</span>` : "";
  return `<div class="dk-board"><div class="dk-board-head"><span class="dk-board-kind">Board</span>${name}<span class="dk-board-sub">${total} ${
    total === 1 ? "card" : "cards"
  }</span></div><div class="dk-board-cols">${cols}</div>${boardFoot(unread)}</div>`;
}

/** One table, as the page shows it. Its own classes, not a markdown table's: a picture of a store, not a table someone wrote. */
export function tableHtml(board: TableSnap, unread = 0): string {
  const total = board.rows.length + (board.more ?? 0) + unread;
  const head = `<tr><th class="dk-th is-title">Title</th>${board.fields
    .map((f) => `<th class="dk-th">${escapeHtml(f)}</th>`)
    .join("")}</tr>`;
  const rows = board.rows
    .map((row) => {
      const title = escapeHtml(row.title);
      const face = row.page
        ? `<a class="dk-row-title" href="${escapeHtml(row.page)}">${title}</a>`
        : `<span class="dk-row-title">${title}</span>`;
      const cells = board.fields
        .map((_, i) => `<td class="dk-td">${(row.cells[i] ?? []).map(chipHtml).join("")}</td>`)
        .join("");
      return `<tr class="dk-tr"><td class="dk-td is-title">${face}</td>${cells}</tr>`;
    })
    .join("");
  const more = board.more ? `<div class="dk-col-more">+${board.more} more</div>` : "";
  const name = board.name ? `<span class="dk-board-name">${escapeHtml(board.name)}</span>` : "";
  return `<div class="dk-board"><div class="dk-board-head"><span class="dk-board-kind">Table</span>${name}<span class="dk-board-sub">${total} ${
    total === 1 ? "card" : "cards"
  }</span></div><div class="dk-table-wrap"><table class="dk-table"><thead>${head}</thead><tbody>${rows}</tbody></table>${more}</div>${boardFoot(unread)}</div>`;
}

/** A document's properties, above its body. Empty rows never reach here. */
export function propsHtml(props: PageProp[]): string {
  if (props.length === 0) return "";
  const rows = props
    .map(
      (p) =>
        `<div class="dk-prop-row"><div class="dk-prop-label">${escapeHtml(p.name)}</div><div class="dk-prop-value">${p.values
          .map(chipHtml)
          .join("")}</div></div>`,
    )
    .join("");
  return `<div class="dk-props">${rows}</div>`;
}

/* ---------- Table column widths ----------

   The desktop keeps a table's column widths in <stem>.meta.jsonl as `tcols`
   records (src/tableWidths.ts, metaFile.ts). They can't live in markdown,
   so the public page re-attaches them at render time — which means the
   identity function has a second implementation here. A table is identified
   by its column count plus its header row's PLAIN text, chosen so both sides
   can compute it: ProseMirror reads `cell.textContent`, and marked's
   TextRenderer flattens the header cell's inline tokens to the same string
   (`| **Q3** |` and `| Q3 |` are one header on both sides). The id itself
   comes from the app's own `deriveId`, imported. test/run.mjs checks the
   signature against src/tableWidths.ts, so a change there fails a test
   instead of quietly dropping widths from published pages. */

const normalizeHeaderText = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Mirror of src/tableWidths.ts `tableSignature` — byte-compatible; the worker test asserts it. */
export function tableSignature(colCount: number, headerTexts: string[]): string {
  return [String(colCount), ...headerTexts.map(normalizeHeaderText)].join("\n");
}

// remark (the app's parser) resolves character references while building the
// document, so ProseMirror's textContent for `R&amp;D` is "R&D". marked
// leaves them alone and escapes on output instead — decode here so a header
// written with an entity still matches its record.
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/* ---------- Links between notes ---------- */

/** What becomes of a link's href: kept as written, rewritten to a public URL, or the link dropped to its text. */
export type LinkOutcome = { kind: "keep" } | { kind: "rewrite"; href: string } | { kind: "text" };
export type LinkResolver = (href: string) => LinkOutcome;

/* ---------- The markdown ---------- */

export type MarkdownInputs = {
  /** Stored column widths for this note's tables. */
  tcols: TableCols[];
  /** The boards this note's fences resolved to, keyed by snapKeyOf. */
  boards: Map<string, DrawnBoard>;
  links: LinkResolver;
};

/**
 * A note's body as HTML. The overrides are a plain object, not a Renderer
 * subclass: marked merges overrides with `for (const prop in renderer)`, and
 * a class's methods are non-enumerable — a subclass silently never runs.
 * The stock output comes from our own base Renderer, borrowing the live
 * parser.
 */
export function markdownHtml(md: string, inputs: MarkdownInputs): string {
  const byId = new Map(inputs.tcols.map((r) => [r.id, r.cols]));
  const seenSignatures = new Map<string, number>();
  const base = new Renderer();
  const borrow = (self: Renderer) => {
    base.parser = self.parser;
    base.options = self.options;
  };
  const instance = new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      table(this: Renderer, token: Tokens.Table): string {
        borrow(this);
        const html = base.table(token);
        if (byId.size === 0) return html;
        // TextRenderer flattens the cell's inline tokens to plain text — the
        // same string ProseMirror's cell.textContent yields on the desktop.
        const headerTexts = token.header.map((cell) =>
          decodeEntities(this.parser.parseInline(cell.tokens, this.parser.textRenderer)),
        );
        const signature = tableSignature(token.header.length, headerTexts);
        const nth = seenSignatures.get(signature) ?? 0;
        seenSignatures.set(signature, nth + 1);
        const cols = byId.get(deriveId(signature, nth));
        if (!cols || !cols.some((w) => w > 0)) return html;
        const group = cols
          .slice(0, token.header.length)
          .map((w) => (w > 0 ? `<col style="width:${w}px">` : "<col>"))
          .join("");
        return `<div class="dk-table-scroll">${html.replace(
          "<table>",
          `<table class="dk-cols"><colgroup>${group}</colgroup>`,
        )}</div>`;
      },
      code(this: Renderer, token: Tokens.Code): string {
        borrow(this);
        const lang = String(token.lang ?? "").trim();
        if (lang !== KANBAN_LANG && lang !== TABLE_LANG) return base.code(token);
        const drawn = inputs.boards.get(snapKeyOf(lang, token.text));
        if (!drawn) return base.code(token);
        return drawn.snap.kind === "table"
          ? tableHtml(drawn.snap, drawn.unread)
          : boardHtml(drawn.snap, drawn.unread);
      },
      link(this: Renderer, token: Tokens.Link): string {
        borrow(this);
        const outcome = inputs.links(token.href);
        if (outcome.kind === "keep") return base.link(token);
        if (outcome.kind === "rewrite") return base.link({ ...token, href: outcome.href });
        return this.parser.parseInline(token.tokens);
      },
      image(this: Renderer, token: Tokens.Image): string {
        borrow(this);
        const outcome = inputs.links(token.href);
        if (outcome.kind === "keep") return base.image(token);
        if (outcome.kind === "rewrite") return base.image({ ...token, href: outcome.href });
        return escapeHtml(token.text);
      },
    },
  });
  return instance.parse(md, { async: false }) as string;
}

/* ---------- Page chrome ---------- */

export type PageMeta = {
  title: string;
  description: string;
  hostname: string;
  /** Absolute URL of the page — og:url and the pill's links. */
  pageUrl: string;
  ogType: "article" | "website";
};

const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

export function headHtml(m: PageMeta): string {
  const origin = new URL(m.pageUrl).origin;
  return `<meta charset="utf-8">
${FAVICON_LINKS}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(m.title)}</title>
<meta name="description" content="${escapeHtml(m.description)}">
<meta property="og:type" content="${m.ogType}">
<meta property="og:site_name" content="${escapeHtml(m.hostname)}">
<meta property="og:title" content="${escapeHtml(m.title)}">
<meta property="og:description" content="${escapeHtml(m.description)}">
<meta property="og:url" content="${escapeHtml(m.pageUrl)}">
<meta property="og:image" content="${origin}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${origin}/og.png">`;
}

export type Crumb = { href: string; label: string };

/** "← Folder", pinned top-left on a note reached through a published folder. */
export const crumbHtml = (crumb: Crumb | null): string =>
  crumb
    ? `<a class="home-crumb" href="${escapeHtml(crumb.href)}"><span class="home-crumb-arrow">←</span><span class="home-crumb-label">${escapeHtml(crumb.label)}</span></a>`
    : "";

/**
 * The MD/HTML pill, when a note has both versions: the html rendition is the
 * default (the polished, human-facing document) at the page's own URL, the
 * markdown at ?v=md.
 */
export function pillHtml(pageUrl: string, active: "md" | "html"): string {
  const md = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}v=md`;
  return `<div class="page-top"><nav class="view-pill" aria-label="Document version">
<a class="view-seg ${active === "md" ? "is-active" : ""}" href="${escapeHtml(md)}">MD</a>
<a class="view-seg ${active === "html" ? "is-active" : ""}" href="${escapeHtml(pageUrl)}">HTML</a>
</nav></div>`;
}

const footerHtml = (hostname: string): string =>
  `<footer>published via <a href="/">${escapeHtml(hostname)}</a></footer>`;

export type NotePageInputs = {
  meta: PageMeta;
  crumb: Crumb | null;
  /** Whether the note has an html rendition — the pill shows when it does. */
  hasHtml: boolean;
  propsHtml: string;
  bodyHtml: string;
  /** The tag the mermaid module is served under (/__web/<tag>/mermaid.js). */
  mermaidTag: string;
};

export function notePageHtml(p: NotePageInputs): string {
  return `<!doctype html>
<html lang="en">
<head>
${headHtml(p.meta)}
<style>${PAGE_CSS}</style>
</head>
<body>
${crumbHtml(p.crumb)}
${p.hasHtml ? pillHtml(p.meta.pageUrl, "md") : ""}
<main class="doc">
${p.propsHtml}${p.bodyHtml}
</main>
${footerHtml(p.meta.hostname)}
${p.bodyHtml.includes('class="language-mermaid"') ? mermaidHydrator(p.mermaidTag) : ""}
</body>
</html>`;
}

/**
 * The html rendition, framed: serving it at the page's own URL directly would
 * lose the meta tags, the pill and the sandbox — its scripts run under an
 * opaque origin inside the iframe.
 */
export function framedPageHtml(p: { meta: PageMeta; crumb: Crumb | null; hasMd: boolean; rawUrl: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
${headHtml(p.meta)}
<style>${PAGE_CSS}${FRAME_CSS}</style>
</head>
<body>
${crumbHtml(p.crumb)}
${p.hasMd ? pillHtml(p.meta.pageUrl, "html") : ""}
<iframe class="raw-frame" src="${escapeHtml(p.rawUrl)}" sandbox="allow-scripts allow-popups" title="${escapeHtml(p.meta.title)}"></iframe>
</body>
</html>`;
}

/* ---------- The folder table of contents ---------- */

export type TocItem = { title: string; path: string; href: string };

type TocNode = { dirs: Map<string, TocNode>; files: TocItem[] };

/** Pages per folder before the table of contents becomes a tree instead of cards. */
export const TOC_CARDS_MAX = 8;

function buildTree(items: TocItem[]): TocNode {
  const root: TocNode = { dirs: new Map(), files: [] };
  for (const it of items) {
    const segs = it.path.split("/").filter(Boolean);
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg)!;
    }
    node.files.push(it);
  }
  return root;
}

const countTreePages = (node: TocNode): number =>
  node.files.length + [...node.dirs.values()].reduce((n, d) => n + countTreePages(d), 0);
const countTreeDirs = (node: TocNode): number =>
  node.dirs.size + [...node.dirs.values()].reduce((n, d) => n + countTreeDirs(d), 0);

// Stroke-only glyphs matching the desktop sidebar's icons.
const TOC_PAGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;
const TOC_DIR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const TOC_CHEVRON = `<svg class="toc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;
const TOC_ARROW = `<svg class="toc-page-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

// Directories first, then pages, both alphabetical — the sidebar's order.
// Top-level folders start open, deeper ones closed (native <details>, so
// large trees stay scannable without any script).
function renderTocLevel(node: TocNode, depth: number): string {
  const dirs = [...node.dirs.entries()].sort((a, b) => byName(a[0], b[0]));
  const files = [...node.files].sort((a, b) => byName(a.title, b.title));
  const parts: string[] = [];
  for (const [name, child] of dirs) {
    parts.push(`<details class="toc-dir"${depth === 0 ? " open" : ""}>
<summary><span class="toc-icon">${TOC_DIR_ICON}</span><span class="toc-dir-name">${escapeHtml(name)}</span><span class="toc-count">${countTreePages(child)}</span>${TOC_CHEVRON}</summary>
<div class="toc-children">${renderTocLevel(child, depth + 1)}</div>
</details>`);
  }
  for (const f of files) {
    parts.push(
      `<a class="toc-page" href="${escapeHtml(f.href)}"><span class="toc-icon">${TOC_PAGE_ICON}</span><span class="toc-page-title">${escapeHtml(f.title)}</span>${TOC_ARROW}</a>`,
    );
  }
  return parts.join("\n");
}

// The small-folder TOC: every page as one card, flat, sorted by where it
// lives and then by name; each card wears its folder path as a subtitle.
function renderTocCards(items: TocItem[]): string {
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  const sorted = [...items].sort((a, b) => byName(dirOf(a.path), dirOf(b.path)) || byName(a.title, b.title));
  return sorted
    .map((it) => {
      const dir = dirOf(it.path).split("/").filter(Boolean).join(" / ");
      return `<a class="toc-card" href="${escapeHtml(it.href)}"><span class="toc-icon">${TOC_PAGE_ICON}</span><span class="toc-card-text"><span class="toc-card-title">${escapeHtml(it.title)}</span>${
        dir ? `<span class="toc-card-path">${escapeHtml(dir)}</span>` : ""
      }</span>${TOC_ARROW}</a>`;
    })
    .join("\n");
}

export type TocPageInputs = {
  meta: PageMeta;
  title: string;
  /** The owner's description, or nothing. */
  description: string;
  items: TocItem[];
  /** "Updated Sep 2, 2026", when the folder's newest note carries a time. */
  updatedLabel: string | null;
};

export function tocPageHtml(p: TocPageInputs): string {
  const count = p.items.length;
  const tree = buildTree(p.items);
  const useCards = count > 0 && count <= TOC_CARDS_MAX;
  const toc =
    count === 0
      ? `<div class="toc-empty">Nothing here yet.</div>`
      : useCards
        ? renderTocCards(p.items)
        : renderTocLevel(tree, 0);
  const dirCount = useCards ? 0 : countTreeDirs(tree);
  const sep = `<span class="toc-meta-sep" aria-hidden="true"></span>`;
  const metaLine = [
    `${count} ${count === 1 ? "page" : "pages"}`,
    ...(dirCount > 0 ? [`${dirCount} ${dirCount === 1 ? "folder" : "folders"}`] : []),
    ...(p.updatedLabel ? [`Updated ${escapeHtml(p.updatedLabel)}`] : []),
  ].join(sep);
  return `<!doctype html>
<html lang="en">
<head>
${headHtml(p.meta)}
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="doc toc">
<header class="toc-head">
<h1 class="toc-title">${escapeHtml(p.title)}</h1>
${p.description ? `<p class="toc-desc">${escapeHtml(p.description)}</p>` : ""}
<p class="toc-meta">${metaLine}</p>
</header>
<nav class="toc-tree${useCards ? " toc-cards" : ""}" aria-label="Pages">
${toc}
</nav>
</main>
${footerHtml(p.meta.hostname)}
</body>
</html>`;
}

/* ---------- Mermaid ---------- */

/**
 * The diagram renderer, injected only into pages whose markdown carries a
 * ```mermaid block. It imports the mermaid module the worker serves
 * (mermaidThemeVariables rides along in it, so diagrams take the page
 * palette — light and dark) and swaps each code block for its rendered SVG.
 * A source that doesn't parse keeps its plain code block, and without
 * JavaScript the page still shows every source.
 */
export function mermaidHydrator(tag: string): string {
  const moduleUrl = `/__web/${tag}/mermaid.js`;
  return `<script type="module">
(async () => {
  const codes = [...document.querySelectorAll("pre > code.language-mermaid")];
  if (codes.length === 0) return;
  let mod;
  try { mod = await import(${JSON.stringify(moduleUrl)}); } catch { return; }
  const mermaid = mod.default;
  const spots = codes.map((code) => ({
    source: code.textContent,
    pre: code.parentElement,
    holder: Object.assign(document.createElement("div"), { className: "dk-mermaid" }),
  }));
  let seq = 0;
  const renderAll = async () => {
    // Re-initialized per pass: the palette derives from the page's current
    // colors, and the prefers-color-scheme listener below re-renders on flips.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: mod.mermaidThemeVariables(),
    });
    for (const spot of spots) {
      try {
        const { svg } = await mermaid.render("dk-mermaid-" + ++seq, spot.source);
        spot.holder.innerHTML = svg;
        if (!spot.holder.isConnected) spot.pre.replaceWith(spot.holder);
      } catch {
        if (spot.holder.isConnected) spot.holder.replaceWith(spot.pre);
      }
    }
    document.documentElement.dataset.mermaid = String(spots.filter((s) => s.holder.isConnected).length);
  };
  await renderAll();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
})();
</script>`;
}

/* ---------- Styles ---------- */

// The reading page. The same tokens the app's reading view uses, so a
// published note and the note in the app read as one document; light and
// dark from the visitor's own preference.
export const PAGE_CSS = `
:root {
  --bg: #ffffff;
  --text: #37352f;
  --muted: rgba(55, 53, 47, 0.5);
  --border: rgba(55, 53, 47, 0.09);
  --surface: #f7f6f3;
  --inline-code: #b45309;
  --link: #2383e2;
  --selection: rgba(35, 131, 226, 0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #191919;
    --text: #ebebeb;
    --muted: rgba(255, 255, 255, 0.45);
    --border: rgba(255, 255, 255, 0.08);
    --surface: #1f1f1f;
    --inline-code: #f59e9e;
    --link: #529cca;
    --selection: rgba(255, 255, 255, 0.12);
  }
}
* { box-sizing: border-box; }
/* The document flows vertically and never scrolls sideways — mirrors the app's
   editor canvas. Wide blocks (code, tables, boards) scroll within themselves. */
html, body { margin: 0; padding: 0; background: var(--bg); overflow-x: hidden; }
/* Sticky footer: the body fills the viewport and the footer rides its bottom edge. */
body {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.6;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--selection); }
main.doc {
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: 48px 64px 96px;
}
@media (max-width: 720px) {
  main.doc { padding: 32px 24px 72px; }
}
.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
  font-family: inherit;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 4px;
}
.doc h1 { font-size: 32px; line-height: 1.25; margin-top: 28px; }
.doc h2 { font-size: 24px; line-height: 1.3; margin-top: 24px; }
.doc h3 { font-size: 19px; line-height: 1.35; margin-top: 20px; }
.doc h4, .doc h5, .doc h6 { font-size: 16px; margin-top: 16px; }
.doc > :first-child { margin-top: 0; }
.doc p { font-size: 16px; line-height: 1.6; margin: 0; padding: 3px 0; }
.doc ul, .doc ol { margin: 4px 0; padding-left: 26px; }
.doc li { padding: 2px 0; }
.doc li > p { padding: 0; }
.doc blockquote {
  margin: 6px 0;
  padding: 2px 0 2px 14px;
  border-left: 3px solid var(--text);
}
.doc a { color: var(--link); text-decoration: none; }
.doc a:hover { text-decoration: underline; }
.doc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 85%;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: var(--surface);
  color: var(--inline-code);
}
.doc pre {
  margin: 8px 0;
  padding: 16px 20px;
  border-radius: 8px;
  background: var(--surface);
  overflow-x: auto;
}
.doc pre code {
  padding: 0;
  background: none;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.55;
}
.doc img { max-width: 100%; border-radius: 4px; }
/* Rendered mermaid diagrams (the hydrator swaps them in for their fenced
   code blocks). Colors live inside the SVG, derived from this page's palette
   — this is layout only: a centered figure, wide charts scroll within it. */
.doc .dk-mermaid {
  display: flex;
  justify-content: safe center;
  margin: 8px 0;
  padding: 12px 0;
  overflow-x: auto;
}
.doc .dk-mermaid svg { max-width: 100%; flex: none; }
/* The page's paragraph styling (.doc p) must not restyle the HTML labels
   inside a diagram — mermaid measures them outside .doc, and a mismatch
   clips the label boxes. */
.doc .dk-mermaid p { font-size: inherit; line-height: inherit; padding: 0; }
.doc hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
.doc table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; }
/* A table WITH stored column widths: the widths come from a colgroup, which
   only takes effect on a real table box — so the horizontal scroll that
   display:block gives every other table moves out to a wrapper. */
.doc .dk-table-scroll { overflow-x: auto; margin: 8px 0; }
.doc table.dk-cols { display: table; table-layout: fixed; margin: 0; }
.doc th, .doc td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.doc th { background: var(--surface); font-weight: 600; }
/* ---- Boards and properties ----
   The app's own board (src/App.css) rendered for a reader: same class names,
   same named palette, no drag affordances and no scroll traps. Colours are
   one hue/saturation pair per name with the ink and wash swapped for dark,
   exactly as the app does it, so "green" means the same green on both. */
.dk-color-grey { --dk-h: 220; --dk-s: 6%; }
.dk-color-brown { --dk-h: 25; --dk-s: 35%; }
.dk-color-orange { --dk-h: 32; --dk-s: 80%; }
.dk-color-yellow { --dk-h: 45; --dk-s: 80%; }
.dk-color-green { --dk-h: 145; --dk-s: 50%; }
.dk-color-blue { --dk-h: 214; --dk-s: 72%; }
.dk-color-purple { --dk-h: 268; --dk-s: 50%; }
.dk-color-pink { --dk-h: 330; --dk-s: 62%; }
.dk-color-red { --dk-h: 2; --dk-s: 68%; }
:root { --dk-ink: 30%; --dk-wash: 0.15; }
@media (prefers-color-scheme: dark) {
  :root { --dk-ink: 76%; --dk-wash: 0.24; }
}
.dk-chip {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: hsl(var(--dk-h, 220) var(--dk-s, 6%) 50% / var(--dk-wash));
  color: hsl(var(--dk-h, 220) var(--dk-s, 6%) var(--dk-ink));
}
/* The document's own frontmatter, above the body and ruled off from it. */
.doc .dk-props {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.doc .dk-prop-row { display: flex; align-items: baseline; gap: 8px; min-height: 24px; }
.doc .dk-prop-label {
  flex: 0 0 130px;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc .dk-prop-value { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; }
/* A board embedded in the document. It sits in the text flow (it is a block
   of the document, not a pane), and scrolls sideways within itself. */
.doc .dk-board {
  margin: 16px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}
.doc .dk-board-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px 6px;
  font-size: 12px;
  color: var(--muted);
}
.doc .dk-board-kind { text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; }
.doc .dk-board-name { color: var(--text); font-weight: 600; font-size: 13px; }
.doc .dk-board-sub { margin-left: auto; }
.doc .dk-board-foot { padding: 0 12px 10px; font-size: 11.5px; color: var(--muted); }
.doc .dk-board-cols {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 0 12px 12px;
  overflow-x: auto;
}
.doc .dk-col {
  flex: 0 0 220px;
  border-radius: 8px;
  padding: 6px;
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
}
.doc .dk-col-head { display: flex; align-items: center; gap: 6px; padding: 4px 4px 8px; }
.doc .dk-col-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: hsl(var(--dk-h, 220) var(--dk-s, 6%) 50%);
}
.doc .dk-col-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc .dk-col-count { font-size: 11px; color: var(--muted); margin-left: auto; }
.doc .dk-col-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.doc .dk-col-list li { margin: 0; }
.doc .dk-card {
  border-radius: 6px;
  background: var(--bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.09), 0 0 0 1px var(--border);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.doc .dk-card-title { font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.doc a.dk-card-title { color: var(--link); text-decoration: none; }
.doc a.dk-card-title:hover { text-decoration: underline; }
.doc .dk-card-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.doc .dk-col-more { margin: 6px 4px 2px; font-size: 11px; color: var(--muted); }
/* A store shown as a table. Its own rules, not the document table's: this is
   a picture of a store, not a table someone wrote in the note. */
.doc .dk-table-wrap { padding: 0 12px 12px; overflow-x: auto; }
.doc table.dk-table { border-collapse: collapse; width: 100%; margin: 0; font-size: 13px; display: table; }
.doc .dk-th {
  text-align: left;
  font-weight: 500;
  font-size: 12px;
  color: var(--muted);
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 6px 8px;
  white-space: nowrap;
  background: none;
}
.doc .dk-th.is-title { min-width: 160px; }
.doc .dk-td { border: none; border-bottom: 1px solid var(--border); padding: 6px 8px; vertical-align: middle; }
.doc .dk-td .dk-chip { margin-right: 4px; }
.doc .dk-row-title { font-size: 13px; overflow-wrap: anywhere; }
.doc a.dk-row-title { color: var(--link); text-decoration: none; }
.doc a.dk-row-title:hover { text-decoration: underline; }
.doc input[type="checkbox"] { margin-right: 6px; }
.doc li:has(> input[type="checkbox"]) { list-style: none; margin-left: -20px; }
.muted { color: var(--muted); }
/* MD/HTML version pill (only rendered when a page has both versions),
   pinned top-right. */
.page-top {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
}
.view-pill {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.view-seg {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-decoration: none;
}
.view-seg:hover { color: var(--text); }
.view-seg.is-active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 0 0 1px var(--border);
}
footer {
  width: 100%;
  max-width: 1080px;
  margin: auto auto 0;
  padding: 24px 64px 48px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
footer a { color: var(--muted); }
/* "Back to the folder" crumb on notes reached through a published folder —
   the view pill's mirror image, pinned top-left. */
.home-crumb {
  position: fixed;
  top: 14px;
  left: 14px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 40vw;
  padding: 4px 12px 4px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-decoration: none;
}
.home-crumb:hover { color: var(--text); }
.home-crumb-arrow { font-weight: 400; flex: none; }
.home-crumb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The folder page: a quiet editorial cover — title, optional description, a
   hairline rule — over a list of tappable rows. Directories are native
   <details> rows with a count and a rotating chevron. */
main.toc { max-width: 680px; }
.toc-head { padding: 34px 0 24px; border-bottom: 1px solid var(--border); }
.toc-title {
  margin: 0;
  font-size: clamp(28px, 5.4vw, 36px);
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.toc-desc {
  margin: 12px 0 0;
  max-width: 40rem;
  font-size: 16.5px;
  line-height: 1.55;
  color: var(--muted);
}
.toc-meta {
  margin: 16px 0 0;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.toc-meta-sep {
  display: inline-block;
  width: 3px;
  height: 3px;
  margin: 0 8px;
  vertical-align: 2.5px;
  border-radius: 50%;
  background: var(--muted);
}
.toc-tree { margin-top: 20px; display: flex; flex-direction: column; gap: 2px; }
.toc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  transition: color 0.12s;
}
.toc-icon svg { width: 16px; height: 16px; }
.doc .toc-page {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  color: var(--text);
  text-decoration: none;
  font-size: 15px;
  font-weight: 500;
  transition: background 0.12s;
}
.doc .toc-page:hover { background: var(--surface); text-decoration: none; }
.doc .toc-page:hover .toc-icon { background: var(--bg); color: var(--text); }
.toc-page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-page-arrow {
  width: 15px;
  height: 15px;
  flex: none;
  margin-left: auto;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 0.12s, transform 0.12s;
}
.doc .toc-page:hover .toc-page-arrow { opacity: 1; transform: none; }
.toc-dir { margin: 0; }
.toc-dir > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  cursor: pointer;
  list-style: none;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  user-select: none;
  -webkit-user-select: none;
  transition: background 0.12s;
}
.toc-dir > summary::-webkit-details-marker { display: none; }
.toc-dir > summary:hover { background: var(--surface); }
.toc-dir > summary:hover .toc-icon { background: var(--bg); color: var(--text); }
.toc-dir-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-count {
  margin-left: auto;
  flex: none;
  min-width: 20px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 500;
  text-align: center;
  color: var(--muted);
}
.toc-dir > summary .toc-chevron {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--muted);
  transition: transform 0.15s;
}
.toc-dir[open] > summary .toc-chevron { transform: rotate(90deg); }
.toc-children {
  margin: 2px 0 6px 27px;
  padding-left: 13px;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toc-empty {
  margin-top: 20px;
  padding: 44px 24px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  text-align: center;
  font-size: 14px;
  color: var(--muted);
}
/* Small folders (≤ TOC_CARDS_MAX pages) list every page as a card. */
.toc-cards { gap: 10px; }
.doc .toc-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  text-decoration: none;
  transition: background 0.12s, border-color 0.12s;
}
.doc .toc-card:hover { background: var(--surface); text-decoration: none; }
.doc .toc-card:hover .toc-icon { background: var(--bg); color: var(--text); }
.toc-card .toc-icon { width: 36px; height: 36px; border-radius: 10px; }
.toc-card .toc-icon svg { width: 17px; height: 17px; }
.toc-card-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.toc-card-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc-card-path {
  font-size: 12.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A quiet staggered rise on load. Top-level rows only, delays capped. */
@media (prefers-reduced-motion: no-preference) {
  .toc-head, .toc-tree > * { animation: toc-enter 0.4s cubic-bezier(0.16, 1, 0.3, 1) both; }
  .toc-tree > *:nth-child(1) { animation-delay: 60ms; }
  .toc-tree > *:nth-child(2) { animation-delay: 95ms; }
  .toc-tree > *:nth-child(3) { animation-delay: 130ms; }
  .toc-tree > *:nth-child(4) { animation-delay: 165ms; }
  .toc-tree > *:nth-child(5) { animation-delay: 200ms; }
  .toc-tree > *:nth-child(6) { animation-delay: 235ms; }
  .toc-tree > *:nth-child(7) { animation-delay: 270ms; }
  .toc-tree > *:nth-child(n + 8) { animation-delay: 300ms; }
}
@keyframes toc-enter {
  from { opacity: 0; transform: translateY(7px); }
}
`;

/* The framed rendition: it owns the whole viewport; only the pill and the crumb float above it. */
export const FRAME_CSS = `
html, body { height: 100%; overflow: hidden; }
.raw-frame {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: #ffffff;
}
`;
