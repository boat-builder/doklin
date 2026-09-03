// An embed's config — the little text inside the fence that says which store
// a note is showing, and which way.
//
//   ```kanban
//   store: ./Projects
//   view: board
//   group: status
//   hide: [Done]
//   ```
//
// One fenced language per view kind: ` ```kanban ` for a board, ` ```table `
// for a table. The language is what every other markdown renderer sees, so it
// is what decides the kind — the config's `view:` only picks WHICH saved view
// of that kind.
//
// Two things make a fenced code block the right carrier. It is the one
// construct every markdown tool agrees to leave alone — GitHub and Obsidian
// show it as a small block that says what it is (a published page, which
// knows the fence, draws the board), so a note with a board in it is never
// mangled by a tool that has never heard of Doklin. And it is the precedent the app already has: a mermaid
// diagram rides a ` ```mermaid ` fence.
//
// The config grammar is deliberately the SAME one a card's frontmatter uses
// (parseProps in frontmatter.ts) rather than a second dialect to learn: `key:
// value`, a flow list for `hide`, and anything unreadable simply ignored.
//
// Pure string work — no editor, no filesystem — so the round trip can be
// tested on its own (verify-harness/store.test.mjs). The milkdown plumbing
// that turns a fence into a node lives in kanbanEmbed.ts.

import { parseProps, propLine, propList } from "./frontmatter";
import type { ViewKind } from "./storeFile";

// One fenced language per view kind. The LANGUAGE is what every other
// markdown tool sees, so it — not the config's `view:` key — is what decides
// which way a store is shown.
/** The fence's info string. Exact, lowercase: what other renderers read. */
export const KANBAN_LANG = "kanban";
export const TABLE_LANG = "table";

const LANG_KIND: Record<string, ViewKind> = {
  [KANBAN_LANG]: "kanban",
  [TABLE_LANG]: "table",
};

/** The fence language a view kind writes. */
export const langOf = (kind: ViewKind): string =>
  kind === "table" ? TABLE_LANG : KANBAN_LANG;

export type EmbedConfig = {
  /** The store's folder, as written — resolved against the note by the host. */
  store: string | null;
  /** A saved view id; null means the store's first view of the fence's kind. */
  view: string | null;
  /** Group by this field instead of the view's, for this embed only. */
  group: string | null;
  /** Column values this embed leaves out, overriding the view's own. */
  hide: string[];
};

export const emptyEmbedConfig = (): EmbedConfig => ({
  store: null,
  view: null,
  group: null,
  hide: [],
});

/**
 * Read a fence body. Never throws and never rejects: a config the dialect
 * can't read is a config with nothing set, which the embed reports in place
 * rather than turning into an error.
 */
export function parseEmbedConfig(text: string): EmbedConfig {
  const { props } = parseProps(text.split("\n"));
  const str = (key: string): string | null => {
    const v = props[key];
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
  };
  return {
    store: str("store"),
    view: str("view"),
    group: str("group"),
    hide: propList(props.hide).filter((s) => s.trim() !== ""),
  };
}

/**
 * The canonical config text for a config — only the keys that carry
 * something, in a fixed order, so the picker and the source editor agree on
 * what the same embed looks like.
 */
export function serializeEmbedConfig(config: EmbedConfig): string {
  const lines: string[] = [];
  if (config.store) lines.push(propLine("store", config.store));
  if (config.view) lines.push(propLine("view", config.view));
  if (config.group) lines.push(propLine("group", config.group));
  if (config.hide.length > 0) lines.push(propLine("hide", config.hide));
  return lines.join("\n");
}

/**
 * The markdown for an embed: the config wrapped in a fence of that view's
 * language. The fence grows past any backtick run in the config, the way a
 * markdown serializer does, so a config carrying backticks can't break out
 * of it.
 */
export function fenceEmbed(kind: ViewKind, config: string): string {
  const longest = (config.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const body = config === "" ? "" : `${config}\n`;
  return `${fence}${langOf(kind)}\n${body}${fence}`;
}

/**
 * The view kind a fenced code block embeds, or null when it embeds nothing.
 * Strict on purpose: exactly `kanban` or `table`, and no meta after it. A
 * fence the app doesn't claim stays an ordinary code block, which round-trips
 * byte for byte — a better outcome than guessing at ` ```Kanban tight ` and
 * rewriting someone's file.
 */
export function embedKind(lang: unknown, meta: unknown): ViewKind | null {
  if (typeof lang !== "string") return null;
  if (meta !== null && meta !== undefined && meta !== "") return null;
  return LANG_KIND[lang] ?? null;
}

const stripIndent = (line: string, n: number) => {
  let i = 0;
  while (i < n && line[i] === " ") i++;
  return line.slice(i);
};

export type EmbedFence = { kind: ViewKind; text: string };

/**
 * Every embed fence in a markdown document, in order, as its view kind and
 * its config text (the block's body, no trailing newline).
 *
 * The editor finds embeds through the parsed document; a share push has only
 * the file's bytes, so it scans for fences itself. The scan tracks OPEN
 * fences the way CommonMark does — an opener's character and run length, a
 * closer of at least that length — so a ` ```kanban ` written INSIDE a
 * ` ````markdown ` example is what it looks like: text, not a board.
 */
export function storeFences(md: string): EmbedFence[] {
  const out: EmbedFence[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let open: {
    char: string;
    len: number;
    indent: number;
    kind: ViewKind | null;
    body: string[];
  } | null = null;
  for (const line of lines) {
    if (open) {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        if (open.kind) out.push({ kind: open.kind, text: open.body.join("\n") });
        open = null;
        continue;
      }
      // CommonMark strips as much leading space as the opener carried.
      if (open.kind) open.body.push(stripIndent(line, open.indent));
      continue;
    }
    const m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    const info = m[3].trim();
    // An info string on a backtick fence may not itself contain a backtick.
    if (m[2][0] === "`" && info.includes("`")) continue;
    open = {
      char: m[2][0],
      len: m[2].length,
      indent: m[1].length,
      kind: embedKind(info, ""),
      body: [],
    };
  }
  // An unclosed fence still ends at the end of the document. The file's
  // final newline is a line terminator, not a line of the block.
  if (open?.kind) {
    if (open.body[open.body.length - 1] === "") open.body.pop();
    out.push({ kind: open.kind, text: open.body.join("\n") });
  }
  return out;
}
