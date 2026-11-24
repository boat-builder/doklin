// The renderer: marked with
// the app's own reading CSS, light and dark, column widths from the meta
// sidecar as a <colgroup>, links between public notes rewritten, the folder
// table of contents, the MD/HTML pill, the "back to the folder" crumb, and
// the tag that names the flowchart module. Pure string work: what feeds it
// (pages.ts) does the reading.
//
// Everything renders without JavaScript, and no page carries a script of its
// own: the policy a page is served under (public.ts) runs the flowchart
// module and nothing written into a page. A ```svg drawing is drawn here,
// through the app's own sanitizer (src/drawingSvg.ts); a ```mermaid flowchart
// keeps its source as a code block until that module swaps the picture in,
// and stays a code block for a reader with scripts off. Any other kind of
// Mermaid diagram is a code block and nothing else. A callout (`> [!NOTE]`,
// GitHub's alert) is drawn as the app draws it, from the app's own kinds
// (src/calloutTypes.ts).

import { Marked, Renderer, type Token, type Tokens } from "marked";
import { escapeHtml } from "./http";
import { deriveId, type TableCols } from "../../src/metaFile";
import { isDrawingLanguage, sanitizeDrawing } from "../../src/drawingSvg";
import { CALLOUTS, calloutIconSvg, parseCalloutMarker, type CalloutKind } from "../../src/calloutTypes";
import { isFlowchart } from "../../src/flowchart/kind";
import { FONT_PRELOAD, PAGE_THEME } from "./theme";

/* ---------- Words ---------- */

/** First ~200 visible characters of a document, markdown syntax removed — the description meta. */
export function deriveDescription(md: string): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[ \t]*>[ \t]*\[![A-Za-z]+\][ \t]*$/gm, " ")
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
export function decodeEntities(s: string): string {
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

/** What becomes of a link: kept as written, rewritten to a public URL, or
 *  dropped to its words. `words`, when given, are the ones it shows instead
 *  of its own: a named link's are its document's name now (src/docLinks.ts). */
export type LinkOutcome = { kind: "keep" } | { kind: "rewrite"; href: string; words?: string } | { kind: "text" };
/** What becomes of the link to `href` whose words read `words`. */
export type LinkResolver = (href: string, words: string) => LinkOutcome;

/* ---------- The markdown ---------- */

export type MarkdownInputs = {
  /** Stored column widths for this note's tables. */
  tcols: TableCols[];
  links: LinkResolver;
};

/* ---------- Callouts ----------

   A top-level quote whose first line is a marker (`[!NOTE]` alone, any
   case) is a callout, as in the app (src/callout.ts): only top level, as
   GitHub requires. Found before rendering — a renderer can't tell a quote's
   depth — and its body lexed again without the marker line. */

type CalloutToken = Tokens.Blockquote & { callout?: { kind: CalloutKind; body: Token[] } };

function markCallouts(tokens: Token[], lex: (md: string) => Token[]): void {
  for (const token of tokens) {
    if (token.type !== "blockquote") continue;
    const text = (token as Tokens.Blockquote).text;
    const nl = text.indexOf("\n");
    const found = parseCalloutMarker(nl === -1 ? text : text.slice(0, nl));
    if (!found) continue;
    (token as CalloutToken).callout = { kind: found.kind, body: nl === -1 ? [] : lex(text.slice(nl + 1)) };
  }
}

/** The app's callout markup (App.css restated in PAGE_CSS): the title, then the body. */
function calloutHtml(kind: CalloutKind, body: string): string {
  return `<div class="callout callout-${kind}" role="note"><p class="callout-title">${calloutIconSvg(kind)}${CALLOUTS[kind].name}</p><div class="callout-body">${body}</div></div>\n`;
}

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
  let drawings = 0;
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
        // A drawing: the app's sanitizer, with a namespace per drawing so two
        // on one page never share a marker. One that doesn't parse stays its
        // source, as the app shows it.
        const lang = String(token.lang ?? "");
        // A flowchart: its code block, marked so the page asks for the module that draws it.
        if (/^(mermaid|mmd)$/i.test(lang.trim()) && isFlowchart(token.text)) {
          return base.code({ ...token, lang: "mermaid" }).replace("<pre>", `<pre ${FLOWCHART_MARK}>`);
        }
        if (!isDrawingLanguage(lang)) return base.code(token);
        const drawn = sanitizeDrawing(token.text, `dg${++drawings}-`);
        if (!drawn.ok) return base.code(token);
        return `<figure class="dk-drawing">${drawn.svg}</figure>\n`;
      },
      link(this: Renderer, token: Tokens.Link): string {
        borrow(this);
        const words = decodeEntities(this.parser.parseInline(token.tokens, this.parser.textRenderer));
        const outcome = inputs.links(token.href, words);
        if (outcome.kind === "keep") return base.link(token);
        if (outcome.kind === "text") return this.parser.parseInline(token.tokens);
        if (outcome.words === undefined || outcome.words === words) return base.link({ ...token, href: outcome.href });
        const said: Tokens.Text = { type: "text", raw: outcome.words, text: outcome.words, escaped: false };
        return base.link({ ...token, href: outcome.href, tokens: [said] });
      },
      blockquote(this: Renderer, token: Tokens.Blockquote): string {
        borrow(this);
        const callout = (token as CalloutToken).callout;
        if (!callout) return base.blockquote(token);
        return calloutHtml(callout.kind, this.parser.parse(callout.body));
      },
      image(this: Renderer, token: Tokens.Image): string {
        borrow(this);
        // A picture on the web is shown. One in the workspace is its alt
        // text: pictures stay on the device that has them (`syncs`,
        // layout.ts), so there is none to serve.
        if (inputs.links(token.href, token.text).kind === "keep") return base.image(token);
        return escapeHtml(token.text);
      },
    },
  });
  const tokens = instance.lexer(md);
  markCallouts(tokens, (body) => instance.lexer(body));
  return instance.parser(tokens);
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
  bodyHtml: string;
  /** The tag the flowchart module is served under (/__web/<tag>/flowchart.js). */
  webTag: string;
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
${p.bodyHtml}
</main>
${footerHtml(p.meta.hostname)}
${p.bodyHtml.includes(FLOWCHART_MARK) ? flowchartScript(p.webTag) : ""}
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

/* ---------- Flowcharts ---------- */

/** Where a domain serves the flowchart module of the web directory tagged `tag`. */
export const flowchartModulePath = (tag: string): string => `/__web/${tag}/flowchart.js`;

/** On the code block of a ```mermaid flowchart: what tells a page it has one. */
const FLOWCHART_MARK = "data-dk-flowchart";

/**
 * The flowchart script, on pages whose markdown carries a ```mermaid
 * flowchart and on no other: the module the domain serves
 * (cloud-worker/web/flowchart-entry.ts), which swaps each code block for its
 * drawn SVG. A tag that names an address, never a script written into the
 * page — a page's policy (public.ts) runs that one address and nothing else.
 */
const flowchartScript = (tag: string): string => `<script type="module" src="${flowchartModulePath(tag)}"></script>`;

/* ---------- Styles ---------- */

// The reading page, in the app's own theme (theme.ts: tokens.css and the
// bundled faces, light and dark from the visitor's preference). The rules
// below restate the app's DOCUMENT rules (App.css: the editor's type, rhythm,
// links, quotes, code, tables and figures) for
// marked's plain HTML, so a published note and the note in the app read as
// one document. The chrome around the document — the crumb, the MD/HTML
// pill, the footer — is the app's UI face at its UI sizes.
const PAGE_CSS = `${PAGE_THEME}
* { box-sizing: border-box; }
/* The document flows vertically and never scrolls sideways — like the app's
   editor canvas. Wide blocks (code, tables) scroll within themselves. */
html, body { margin: 0; padding: 0; background: var(--sheet); overflow-x: hidden; }
/* Sticky footer: the body fills the viewport and the footer rides its bottom
   edge. */
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
/* The document: the app's 680px column plus its side padding, sans text at
   the text size, headings at fixed sizes. */
main.doc {
  width: 100%;
  max-width: calc(var(--doc-measure) + 128px);
  margin: 0 auto;
  padding: 64px 64px 96px;
  font-family: var(--font-text);
  font-size: var(--doc-size);
  line-height: var(--doc-leading);
}
@media (max-width: 720px) {
  main.doc { padding: 40px 24px 72px; }
}
.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
  margin: 0;
  padding: 0;
  font-family: var(--font-heading);
  font-weight: var(--doc-heading-weight);
  color: var(--text-1);
}
.doc h1 { font-size: var(--doc-h1); line-height: 1.15; letter-spacing: var(--doc-h1-track); margin: 1.5em 0 0.45em; }
.doc h2 { font-size: var(--doc-h2); line-height: 1.25; letter-spacing: var(--doc-h2-track); margin: 2.1em 0 0.4em; }
.doc h3, .doc h4, .doc h5, .doc h6 { font-family: var(--font-text); font-weight: 600; }
.doc h3 { font-size: var(--doc-h3); line-height: 1.35; letter-spacing: var(--doc-h3-track); margin: 1.9em 0 0.35em; }
.doc h4 { font-size: var(--doc-h4); line-height: 1.45; margin: 1.6em 0 0.25em; }
.doc h5, .doc h6 { font-size: var(--doc-h5); line-height: 1.45; margin: 1.4em 0 0.2em; }
.doc h6 { font-weight: 500; color: var(--text-2); }
.doc :is(h1, h2, h3) code { font-size: 0.8em; }
.doc > :first-child, .doc > :is(h1, h2, h3, h4, h5, h6) + * { margin-top: 0; }
.doc p { margin: 1.15em 0; padding: 0; }
.doc strong { font-weight: 600; }
.doc ul, .doc ol { margin: 1.15em 0; padding-left: 1.855em; }
.doc li ul, .doc li ol { margin: 0; }
.doc li + li, .doc li > ul, .doc li > ol { margin-top: 0.5em; }
.doc li > p { margin: 0; }
.doc input[type="checkbox"] { accent-color: var(--accent); margin: 0 0.45em 0 0; }
.doc li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.2em; }
/* Quotes: a quiet 3px bar; the words stay in the body ink. */
.doc blockquote {
  margin: 0.8em 0;
  padding: 0.1em 1em;
  border-left: 3px solid var(--quote-bar);
}
.doc blockquote p { margin: 0.3em 0; }
/* Callouts: the app's box (App.css "Callouts") — a tint with a hairline
   edge in the kind's colour, the title in the UI face and the kind's ink,
   the body in the text's own size and ink. */
.callout-note { --co: var(--callout-note); --co-tint: var(--callout-note-tint); }
.callout-tip { --co: var(--callout-tip); --co-tint: var(--callout-tip-tint); }
.callout-important { --co: var(--callout-important); --co-tint: var(--callout-important-tint); }
.callout-warning { --co: var(--callout-warning); --co-tint: var(--callout-warning-tint); }
.callout-caution { --co: var(--callout-caution); --co-tint: var(--callout-caution-tint); }
.doc .callout {
  margin: 1.4em 0;
  padding: 0.8em 1.1em 0.9em 1.05em;
  border-radius: var(--r-lg);
  background: var(--co-tint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--co) 13%, transparent);
}
.doc .callout-title {
  display: flex;
  align-items: center;
  gap: 0.42em;
  margin: 0 0 0.4em;
  color: var(--co);
  font-family: var(--font-ui);
  font-size: 0.9em;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.005em;
}
.doc .callout-icon { width: 1.12em; height: 1.12em; flex: none; }
.doc .callout-body > p { margin: 0.55em 0; }
.doc .callout-body > :first-child { margin-top: 0; }
.doc .callout-body > :last-child { margin-bottom: 0; }
.doc .callout code { background: color-mix(in srgb, var(--co) 11%, transparent); }
.doc .callout pre { background: color-mix(in srgb, var(--sheet) 70%, transparent); }
.doc .callout pre code { background: none; }
@media (max-width: 720px) {
  .doc .callout { padding: 0.7em 0.9em 0.8em; }
}
/* Links: the accent as text, underlined on hover only. */
.doc a {
  color: var(--link);
  text-decoration: none;
  text-underline-offset: 0.2em;
  text-decoration-thickness: 1px;
}
.doc a:hover { text-decoration-line: underline; }
/* Code: a small warm pill inline; a plain tinted box for a block. */
.doc code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0.1em 0.3em;
  border-radius: 3px;
  color: var(--code-ink);
  background: var(--code-inline-bg);
}
.doc pre {
  margin: 0.6em 0;
  padding: 0.75rem 0.9rem;
  border-radius: 6px;
  background: var(--code-bg);
  overflow-x: auto;
}
.doc pre code { padding: 0; border-radius: 0; background: none; font-size: 0.875em; line-height: 1.5; }
.doc img { max-width: 100%; vertical-align: bottom; border-radius: 4px; }
.doc hr { border: none; border-top: 1px solid var(--border-strong); margin: 1.4em 0; }
/* Figures: a drawing or a flowchart (the page's module swaps it in for its
   fenced code block) fills the column: its 760 frame scales to fit. Their
   words are the UI face, as in the app. */
.doc .dk-drawing, .doc .dk-flowchart { margin: 0.6em 0; }
.doc .dk-drawing > svg, .doc .dk-flowchart > svg { display: block; width: 100%; height: auto; font-family: var(--font-ui); }
/* Tables: as wide as their content, a step smaller than the text, warm
   hairlines and a tinted header row in the body weight; a cell wraps past
   42ch. */
.doc table {
  border-collapse: collapse;
  margin: calc(0.6em + 16px) 0 calc(0.6em + 10px);
  display: block;
  overflow-x: auto;
  width: max-content;
  max-width: 100%;
  font-size: 0.94em;
  line-height: 1.45;
}
/* A table WITH stored column widths: the widths come from a colgroup, which
   only takes effect on a real table box — so the horizontal scroll that
   display:block gives every other table moves out to a wrapper. */
.doc .dk-table-scroll { overflow-x: auto; margin: calc(0.6em + 16px) 0 calc(0.6em + 10px); font-size: 0.94em; line-height: 1.45; }
.doc table.dk-cols { display: table; table-layout: fixed; margin: 0; font-size: 1em; }
.doc th, .doc td { border: 1px solid var(--table-rule); padding: 6px 10px; text-align: left; vertical-align: top; }
.doc table:not(.dk-cols) :is(th, td) { max-width: 42ch; overflow-wrap: anywhere; }
.doc th { background: var(--table-head); font-weight: inherit; }
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
  font-family: var(--font-heading);
  font-size: clamp(30px, 5.4vw, 40px);
  line-height: 1.15;
  font-weight: var(--doc-heading-weight);
  letter-spacing: var(--doc-h1-track);
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
