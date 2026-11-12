// The renderer (docs/cloud.md §5.6): marked with
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
  type BoardCardSnap,
  type BoardChip,
  type BoardColumnSnap,
  type BoardSnap,
  type KanbanSnap,
  type PageProp,
  type Stage,
  type TableSnap,
} from "../../src/store/board";
import { FONT_PRELOAD, PAGE_THEME } from "./theme";

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

// The board's marks, as strings: the same 16-unit line drawings the app's
// React icons are (src/storeChrome.tsx — BoardIcon, TableIcon, CalendarIcon,
// StatusGlyph), so a published board wears the app's glyphs.
const glyph = (size: number, body: string): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const BOARD_ICON = glyph(
  13,
  '<rect x="1.75" y="2.25" width="3.5" height="11.5" rx="1"/><rect x="6.25" y="2.25" width="3.5" height="7.5" rx="1"/><rect x="10.75" y="2.25" width="3.5" height="9.5" rx="1"/>',
);
const TABLE_ICON = glyph(13, '<rect x="1.75" y="2.5" width="12.5" height="11" rx="2"/><path d="M1.75 6.25h12.5M6 6.25v7.25"/>');
const CALENDAR_ICON = glyph(12, '<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/>');

/** A column's stage of work (StatusGlyph): dashed ring, filling ring, check, slashed ring — or a dot on a board that tracks none. */
function stageGlyph(stage: Stage | undefined, size = 15): string {
  const ring = '<circle cx="8" cy="8" r="6" stroke-width="1.6"/>';
  if (!stage) return glyph(size, '<circle cx="8" cy="8" r="3.75" fill="currentColor" stroke="none"/>');
  if (stage.kind === "todo") return glyph(size, '<circle cx="8" cy="8" r="6" stroke-width="1.6" stroke-dasharray="2.3 2.1"/>');
  if (stage.kind === "done") {
    return glyph(
      size,
      '<circle cx="8" cy="8" r="6.75" fill="currentColor" stroke="none"/><path class="dk-glyph-check" d="M5.25 8.25l1.9 1.9 3.6-4" stroke-width="1.7"/>',
    );
  }
  if (stage.kind === "closed") return glyph(size, `${ring}<path d="M4.5 11.5l7-7" stroke-width="1.6"/>`);
  // The pie grows clockwise from twelve o'clock.
  const r = 3.5;
  const a = stage.fill * 2 * Math.PI;
  const x = (8 + r * Math.sin(a)).toFixed(2);
  const y = (8 - r * Math.cos(a)).toFixed(2);
  return glyph(
    size,
    `${ring}<path d="M8 8V${8 - r}A${r} ${r} 0 ${stage.fill > 0.5 ? 1 : 0} 1 ${x} ${y}Z" fill="currentColor" stroke="none"/>`,
  );
}

// Every chip names a palette colour, grey when it has none — the same
// `dk-color-${color ?? "grey"}` the app writes, so the two markups match.
const chipHtml = (chip: BoardChip): string =>
  `<span class="dk-chip dk-color-${chip.color ?? "grey"}">${escapeHtml(chip.text)}</span>`;

const boardFoot = (unread: number): string =>
  unread > 0
    ? `<div class="dk-board-foot">${unread} more ${unread === 1 ? "card isn't" : "cards aren't"} shown here</div>`
    : "";

const cardCount = (n: number): string => `<span class="dk-board-sub">${n} ${n === 1 ? "card" : "cards"}</span>`;

/**
 * The frame a board or table sits in, as a note's embed sits in the app: a
 * bar naming the kind, then the board's own head — its name, and either its
 * progress or its count.
 */
function embedHtml(kind: "Board" | "Table", name: string, summary: string, body: string, unread: number): string {
  const title = name ? `<span class="dk-board-title">${escapeHtml(name)}</span>` : "";
  return `<div class="dk-embed"><div class="dk-embed-bar"><span class="dk-embed-kind">${
    kind === "Board" ? BOARD_ICON : TABLE_ICON
  }${kind}</span></div><div class="dk-board"><div class="dk-board-head"><div class="dk-board-titlerow">${title}<span class="dk-board-spacer"></span>${summary}</div></div>${body}${boardFoot(
    unread,
  )}</div></div>`;
}

function cardHtml(card: BoardCardSnap): string {
  const check = card.done ? `<span class="dk-card-check">${stageGlyph({ kind: "done", fill: 1 }, 14)}</span>` : "";
  const title = `${check}${escapeHtml(card.title)}`;
  // A card links to its own page exactly when it has one (the link covers
  // the whole card, as a click on a card does in the app); otherwise it is a
  // title, not a dead link.
  const face = card.page
    ? `<a class="dk-card-title" href="${escapeHtml(card.page)}">${title}</a>`
    : `<span class="dk-card-title">${title}</span>`;
  const excerpt = card.excerpt ? `<div class="dk-card-excerpt">${escapeHtml(card.excerpt)}</div>` : "";
  const chips = card.chips ? `<div class="dk-card-chips">${card.chips.map(chipHtml).join("")}</div>` : "";
  const dates = card.dates
    ? `<div class="dk-card-meta">${card.dates
        .map(
          (d) =>
            `<span class="dk-card-date${d.soon ? " is-soon" : ""}" title="${escapeHtml(d.name)}">${CALENDAR_ICON}${escapeHtml(d.text)}</span>`,
        )
        .join("")}</div>`
    : "";
  return `<li class="dk-card${card.done ? " is-done" : ""}">${face}${excerpt}${chips}${dates}</li>`;
}

/** One board, as the page shows it — class for class the app's own markup, with nothing interactive. */
function boardHtml(board: KanbanSnap, unread = 0): string {
  const count = (c: BoardColumnSnap) => c.cards.length + (c.more ?? 0);
  const total = board.columns.reduce((n, c) => n + count(c), 0) + unread;
  const cols = board.columns
    .map((col) => {
      // A div, not a <p>: `.doc p` is the document's paragraph styling.
      const more = col.more ? `<div class="dk-col-more">+${col.more} more</div>` : "";
      return `<section class="dk-col dk-color-${col.color ?? "grey"}"><header class="dk-col-head"><span class="dk-col-glyph">${stageGlyph(
        col.stage,
      )}</span><span class="dk-col-name">${escapeHtml(col.name)}</span><span class="dk-col-count">${count(
        col,
      )}</span></header><ul class="dk-col-list">${col.cards.map(cardHtml).join("")}</ul>${more}</section>`;
    })
    .join("");
  // How far the work has got, on a board whose finished column is showing
  // and whose every card was read; otherwise how many cards it holds.
  const finished = board.columns.filter((c) => c.stage?.kind === "done");
  let summary = cardCount(total);
  if (finished.length > 0 && unread === 0) {
    const done = finished.reduce((n, c) => n + count(c), 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    summary = `<span class="dk-progress" title="${done} of ${total} in ${escapeHtml(finished[0].name)}"><span class="dk-progress-track" aria-hidden="true"><span class="dk-progress-fill" style="width:${pct}%"></span></span>${done} of ${total} done</span>`;
  }
  return embedHtml("Board", board.name, summary, `<div class="dk-board-cols">${cols}</div>`, unread);
}

/** One table, as the page shows it. Its own classes, not a markdown table's: a picture of a store, not a table someone wrote. */
function tableHtml(board: TableSnap, unread = 0): string {
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
  return embedHtml(
    "Table",
    board.name,
    cardCount(total),
    `<div class="dk-table-wrap"><table class="dk-table"><thead>${head}</thead><tbody>${rows}</tbody></table>${more}</div>`,
    unread,
  );
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

function headHtml(m: PageMeta): string {
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
const crumbHtml = (crumb: Crumb | null): string =>
  crumb
    ? `<a class="home-crumb" href="${escapeHtml(crumb.href)}"><span class="home-crumb-arrow">←</span><span class="home-crumb-label">${escapeHtml(crumb.label)}</span></a>`
    : "";

/**
 * The MD/HTML pill, when a note has both versions: the html rendition is the
 * default (the polished, human-facing document) at the page's own URL, the
 * markdown at ?v=md.
 */
function pillHtml(pageUrl: string, active: "md" | "html"): string {
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
${FONT_PRELOAD}
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
const TOC_CARDS_MAX = 8;

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
${FONT_PRELOAD}
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
function mermaidHydrator(tag: string): string {
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

// The reading page, in the app's own theme (theme.ts: tokens.css and the
// Newsreader face, light and dark from the visitor's preference). The rules
// below restate the app's DOCUMENT rules (App.css: the editor's type, links,
// quotes, code, tables, and the board an embed draws) for marked's plain
// HTML, so a published note and the note in the app read as one document.
// The chrome around the document — the crumb, the MD/HTML pill, the footer —
// is the app's UI face at its UI sizes.
const PAGE_CSS = `${PAGE_THEME}
* { box-sizing: border-box; }
/* The document flows vertically and never scrolls sideways — like the app's
   editor canvas. Wide blocks (code, tables, boards) scroll within themselves. */
html, body { margin: 0; padding: 0; background: var(--sheet); overflow-x: hidden; }
/* Sticky footer: the body fills the viewport and the footer rides its bottom
   edge. The body is the UI face: mermaid measures its labels against it. */
body {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  color: var(--text-1);
  font-family: var(--font-ui);
  font-size: var(--fs-md);
  line-height: 1.5;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--selection); }
/* The document: the app's reading measure (68ch of the document font) plus
   its side padding, set in the document font at the document size. */
main.doc {
  width: 100%;
  max-width: calc(var(--doc-measure) + 128px);
  margin: 0 auto;
  padding: 56px 64px 96px;
  font-family: var(--doc-font);
  font-size: var(--doc-size);
  line-height: var(--doc-leading);
}
@media (max-width: 720px) {
  main.doc { padding: 40px 24px 72px; }
}
.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
  margin: 0;
  padding: 2px 0;
  font-family: inherit;
  font-weight: 650;
  letter-spacing: -0.012em;
  color: var(--text-1);
}
.doc h1 { font-size: 2em; line-height: 1.18; letter-spacing: -0.02em; margin-top: 28px; }
.doc h2 { font-size: 1.389em; line-height: 1.28; margin-top: 26px; }
.doc h3 { font-size: 1.111em; line-height: 1.35; margin-top: 20px; }
.doc h4, .doc h5, .doc h6 { font-size: 1em; margin-top: 16px; }
.doc > :first-child { margin-top: 0; }
.doc p { margin: 0; padding: 3px 0; }
.doc ul, .doc ol { margin: 2px 0; padding-left: 1.4em; }
.doc li { padding: 2px 0; }
.doc li::marker { color: var(--text-3); }
.doc li > p { padding: 0; }
.doc input[type="checkbox"] { accent-color: var(--accent); margin: 0 0.45em 0 0; }
.doc li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.2em; }
/* Quotes: a quiet bar and the secondary ink, not a tinted slab. */
.doc blockquote {
  position: relative;
  margin: 4px 0;
  padding: 0 0 0 22px;
  color: var(--text-2);
}
.doc blockquote::before {
  content: "";
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 100px;
  background: var(--quote-bar);
}
.doc a {
  color: var(--accent);
  text-decoration-line: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
  text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent);
  transition: text-decoration-color var(--dur-fast) var(--ease);
}
.doc a:hover { text-decoration-color: var(--accent); }
/* Code: the mono face, a step down from the prose; inline code a neutral pill. */
.doc code {
  font-family: var(--font-mono);
  font-size: 87.5%;
  line-height: 1.4286;
  padding: 0 2px;
  border-radius: 4px;
  color: var(--code-ink);
  background: color-mix(in srgb, var(--code-bg), transparent 40%);
}
.doc pre {
  margin: 8px 0;
  padding: 14px 18px;
  border-radius: var(--r-md);
  background: var(--code-bg);
  overflow-x: auto;
}
.doc pre code { padding: 0; background: none; font-size: 0.85em; line-height: 1.5; }
.doc img { max-width: 100%; vertical-align: bottom; border-radius: var(--r-xs); }
/* Rendered mermaid diagrams (the hydrator swaps them in for their fenced
   code blocks). Colors live inside the SVG, derived from this page's palette
   — this is layout only: a centered figure, wide charts scroll within it.
   Mermaid measures its labels against the body, so a diagram is set in the
   body's face and size, never the document's: a mismatch clips the label
   boxes. The same goes for the page's paragraph styling (.doc p). */
.doc .dk-mermaid {
  display: flex;
  justify-content: safe center;
  margin: 8px 0;
  padding: 12px 0;
  overflow-x: auto;
  font-family: var(--font-ui);
  font-size: var(--fs-md);
  line-height: 1.5;
}
.doc .dk-mermaid svg { max-width: 100%; flex: none; }
.doc .dk-mermaid p { font-size: inherit; line-height: inherit; padding: 0; }
.doc hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
/* Tables: hairlines from the theme, a sunken header row. */
.doc table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; }
/* A table WITH stored column widths: the widths come from a colgroup, which
   only takes effect on a real table box — so the horizontal scroll that
   display:block gives every other table moves out to a wrapper. */
.doc .dk-table-scroll { overflow-x: auto; margin: 8px 0; }
.doc table.dk-cols { display: table; table-layout: fixed; margin: 0; }
.doc th, .doc td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; vertical-align: top; }
.doc th { background: var(--sunken); font-weight: 600; }
/* ---- Boards and properties ----
   The app's own board (App.css) as a note's embed draws it, rendered for a
   reader: the same class names, the same named palette, no drag affordances
   and no scroll traps. Each option name sets a hue; the theme sets how dark
   a pill's ink, how strong its wash, how tinted a column and how bright a
   glyph (--dk-ink, --dk-wash, --dk-col-wash, --dk-dot), so "green" means the
   same green here as there. Board chrome is the UI face, not the document's. */
.dk-color-grey { --dk-h: 220; --dk-s: 6%; }
.dk-color-brown { --dk-h: 25; --dk-s: 35%; }
.dk-color-orange { --dk-h: 32; --dk-s: 80%; }
.dk-color-yellow { --dk-h: 45; --dk-s: 80%; }
.dk-color-green { --dk-h: 145; --dk-s: 50%; }
.dk-color-blue { --dk-h: 214; --dk-s: 72%; }
.dk-color-purple { --dk-h: 268; --dk-s: 50%; }
.dk-color-pink { --dk-h: 330; --dk-s: 62%; }
.dk-color-red { --dk-h: 2; --dk-s: 68%; }
.dk-chip {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 20px;
  padding: 0 7px;
  border-radius: var(--r-xs);
  background: hsl(var(--dk-h) var(--dk-s) 50% / var(--dk-wash));
  color: hsl(var(--dk-h) var(--dk-s) var(--dk-ink));
}
/* The document's own frontmatter, above the body and ruled off from it. */
.doc .dk-props {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-ui);
  font-size: var(--fs-md);
  line-height: 1.4;
}
.doc .dk-prop-row { display: flex; align-items: flex-start; gap: 8px; min-height: 26px; }
.doc .dk-prop-label {
  flex: 0 0 130px;
  padding: 4px 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc .dk-prop-value { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 3px 0; }
/* A board embedded in the document: a block of the note, framed and barred
   like the app's embed, scrolling sideways within itself. */
.doc .dk-embed {
  margin: 18px 0;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--sheet);
  overflow: hidden;
  font-family: var(--font-ui);
  font-size: var(--fs-md);
  line-height: 1.4;
}
.doc .dk-embed-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--sunken);
}
.doc .dk-embed-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-3);
}
.doc .dk-embed-kind > svg { color: var(--board); }
.doc .dk-board-head { padding: 12px 14px 0; }
.doc .dk-board-titlerow { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 22px; }
.doc .dk-board-title {
  font-size: var(--fs-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc .dk-board-spacer { flex: 1 1 auto; }
.doc .dk-board-sub { font-size: var(--fs-sm); color: var(--text-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* "1 of 3 done", over a bar in the finished colour. */
.doc .dk-progress {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.doc .dk-progress-track { width: 84px; height: 6px; border-radius: 3px; background: var(--hover); overflow: hidden; }
.doc .dk-progress-fill { display: block; height: 100%; border-radius: 3px; background: var(--live); }
.doc .dk-board-foot { padding: 0 14px 12px; font-size: var(--fs-xs); color: var(--text-3); }
.doc .dk-board-cols {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px 14px;
  overflow-x: auto;
}
/* A column is washed in its own hue, so the board reads by colour before a
   single word of it is read. */
.doc .dk-col {
  flex: 0 0 248px;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-lg);
  padding: 4px 6px 6px;
  background: hsl(var(--dk-h) var(--dk-s) 50% / var(--dk-col-wash));
}
.doc .dk-col-head { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 4px 0 6px; min-width: 0; }
.doc .dk-col-glyph { flex: none; display: grid; place-items: center; color: hsl(var(--dk-h) var(--dk-s) var(--dk-dot)); }
.doc .dk-glyph-check { stroke: var(--on-fill); }
.doc .dk-col-name {
  min-width: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc .dk-col-count {
  flex: none;
  padding: 0 6px;
  border-radius: 9px;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: hsl(var(--dk-h) var(--dk-s) var(--dk-ink));
  background: hsl(var(--dk-h) var(--dk-s) 50% / var(--dk-wash));
}
.doc .dk-col-list { list-style: none; margin: 0; padding: 1px 1px 2px; display: flex; flex-direction: column; gap: 8px; }
.doc .dk-col-more { margin: 6px 6px 2px; font-size: var(--fs-xs); color: var(--text-3); }
/* A card: raised off its column. One with a page of its own is a link over
   the whole card, and lifts a pixel under the pointer (a translate, never a
   scale — the app's rule, for the same blur). */
.doc .dk-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--raised);
  box-shadow: var(--shadow-card), 0 0 0 1px var(--border);
  transition: box-shadow var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.doc .dk-card:has(> a.dk-card-title):hover {
  box-shadow: var(--shadow-card-hover), 0 0 0 1px var(--border-strong);
  transform: translateY(-1px);
}
.doc .dk-card-title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--fs-md);
  font-weight: 500;
  line-height: 1.38;
  color: var(--text-1);
  overflow-wrap: anywhere;
  text-decoration: none;
}
.doc a.dk-card-title::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
.doc a.dk-card-title:focus-visible { outline: none; }
.doc a.dk-card-title:focus-visible::after { box-shadow: 0 0 0 2px var(--accent-ring); border-radius: var(--r-md); }
/* A finished card: checked, and stepped back. */
.doc .dk-card.is-done .dk-card-title { color: var(--text-2); }
.doc .dk-card-check { flex: none; display: grid; margin-top: 1px; color: hsl(var(--dk-h) var(--dk-s) var(--dk-dot)); }
.doc .dk-card-excerpt {
  font-size: var(--fs-sm);
  line-height: 1.45;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.doc .dk-card.is-done .dk-card-excerpt { color: var(--text-3); }
.doc .dk-card-chips { display: flex; flex-wrap: wrap; gap: 4px; }
/* The card's foot: its dates. A deadline that is close reads amber. */
.doc .dk-card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-xs);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.doc .dk-card-date { display: inline-flex; align-items: center; gap: 4px; }
.doc .dk-card-date.is-soon { color: var(--warn-ink); }
/* A store shown as a table: the app's table view, not a markdown table. */
.doc .dk-table-wrap { padding: 4px 14px 14px; overflow-x: auto; }
.doc table.dk-table { display: table; width: 100%; margin: 0; border-collapse: collapse; font-size: var(--fs-md); }
.doc .dk-th {
  height: 34px;
  padding: 0 8px;
  border: none;
  background: none;
  box-shadow: inset 0 -1px 0 var(--border);
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-3);
  text-align: left;
  white-space: nowrap;
}
.doc .dk-th.is-title { min-width: 220px; }
.doc .dk-td { border: none; border-bottom: 1px solid var(--border); padding: 6px 8px; vertical-align: middle; }
.doc .dk-tr:hover .dk-td { background: color-mix(in srgb, var(--hover) 60%, transparent); }
.doc .dk-td .dk-chip { margin-right: 4px; }
.doc .dk-row-title { font-weight: 500; color: var(--text-1); text-decoration: none; overflow-wrap: anywhere; }
.doc a.dk-row-title:hover { color: var(--accent); }
/* ---- The page's own chrome, floating over the document ---- */
/* MD/HTML version pill (only rendered when a page has both versions), pinned
   top-right: the app's segmented control — a tinted track, the chosen side
   lifted — on a frosted float. */
.page-top {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
}
.view-pill, .home-crumb {
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--raised) 82%, transparent);
  box-shadow: var(--shadow-card), 0 0 0 1px var(--border);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.view-pill { display: flex; gap: 2px; padding: 3px; }
.view-seg {
  padding: 4px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
  text-decoration: none;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.view-seg:hover { color: var(--text-1); }
.view-seg.is-active { background: var(--hover); color: var(--text-1); }
/* "Back to the folder" crumb on notes reached through a published folder —
   the pill's mirror image, pinned top-left. */
.home-crumb {
  position: fixed;
  top: 14px;
  left: 14px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 40vw;
  height: 32px;
  padding: 0 12px 0 10px;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
  text-decoration: none;
  transition: color var(--dur-fast);
}
.home-crumb:hover { color: var(--text-1); }
.home-crumb-arrow { font-weight: 400; flex: none; }
.home-crumb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
footer {
  width: 100%;
  max-width: 1080px;
  margin: auto auto 0;
  padding: 24px 64px 44px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  text-align: center;
}
footer a { color: var(--text-2); text-decoration: none; }
footer a:hover { color: var(--accent); }
/* ---- The folder page ----
   A quiet editorial cover — the title in the document serif, an optional
   description, a hairline rule — over a list of rows in the UI face.
   Directories are native <details> rows with a count and a turning chevron. */
main.doc.toc { max-width: 680px; font-family: var(--font-ui); font-size: var(--fs-lg); line-height: 1.5; }
.toc-head { padding: 34px 0 24px; border-bottom: 1px solid var(--border); }
.doc h1.toc-title {
  margin: 0;
  padding: 0;
  font-family: var(--font-serif);
  font-size: clamp(30px, 5.4vw, 40px);
  line-height: 1.15;
  font-weight: 650;
  letter-spacing: -0.02em;
}
.doc p.toc-desc {
  margin: 12px 0 0;
  padding: 0;
  max-width: 40rem;
  font-family: var(--font-serif);
  font-size: 19px;
  line-height: 1.5;
  color: var(--text-2);
}
.doc p.toc-meta {
  margin: 16px 0 0;
  padding: 0;
  font-size: var(--fs-sm);
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.toc-meta-sep {
  display: inline-block;
  width: 3px;
  height: 3px;
  margin: 0 8px;
  vertical-align: 2.5px;
  border-radius: 50%;
  background: var(--text-3);
}
.toc-tree { margin-top: 20px; display: flex; flex-direction: column; gap: 2px; }
.toc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--r-sm);
  background: var(--sunken);
  border: 1px solid var(--border);
  color: var(--text-3);
  transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
}
.toc-icon svg { width: 16px; height: 16px; }
.doc .toc-page, .toc-dir > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--r-md);
  color: var(--text-1);
  text-decoration: none;
  font-size: var(--fs-lg);
  transition: background var(--dur-fast);
}
.doc .toc-page { font-weight: 500; }
.doc .toc-page:hover, .toc-dir > summary:hover { background: var(--hover); }
.doc .toc-page:hover .toc-icon, .toc-dir > summary:hover .toc-icon { background: var(--raised); color: var(--text-1); }
.toc-page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-page-arrow {
  width: 15px;
  height: 15px;
  flex: none;
  margin-left: auto;
  color: var(--text-3);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-fast), transform var(--dur-fast), color var(--dur-fast);
}
.doc .toc-page:hover .toc-page-arrow, .doc .toc-card:hover .toc-page-arrow { opacity: 1; transform: none; color: var(--accent); }
.toc-dir { margin: 0; }
.toc-dir > summary {
  cursor: pointer;
  list-style: none;
  font-weight: 600;
  user-select: none;
  -webkit-user-select: none;
}
.toc-dir > summary::-webkit-details-marker { display: none; }
.toc-dir-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-count {
  margin-left: auto;
  flex: none;
  min-width: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--sunken);
  border: 1px solid var(--border);
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.toc-dir > summary .toc-chevron {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--text-3);
  transition: transform var(--dur);
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
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg);
  text-align: center;
  font-size: var(--fs-md);
  color: var(--text-3);
}
/* Small folders (≤ TOC_CARDS_MAX pages) list every page as a raised card. */
.toc-cards { gap: 10px; }
.doc .toc-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-radius: var(--r-lg);
  background: var(--raised);
  box-shadow: var(--shadow-card), 0 0 0 1px var(--border);
  color: var(--text-1);
  text-decoration: none;
  transition: box-shadow var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.doc .toc-card:hover {
  box-shadow: var(--shadow-card-hover), 0 0 0 1px var(--border-strong);
  transform: translateY(-1px);
}
.doc .toc-card:hover .toc-icon { background: var(--accent-wash); border-color: transparent; color: var(--accent); }
.toc-card .toc-icon { width: 36px; height: 36px; border-radius: var(--r-md); }
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
  font-size: var(--fs-sm);
  color: var(--text-3);
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

/* The framed rendition: it owns the whole viewport; only the pill and the
   crumb float above it. A rendition paints its own page on white, as it
   does in the app. */
const FRAME_CSS = `
html, body { height: 100%; overflow: hidden; }
.raw-frame {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--html-page);
}
`;
