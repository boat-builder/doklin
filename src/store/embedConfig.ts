// The ` ```kanban ` embed's config — the little text inside the fence that
// says which board a note is showing.
//
//   ```kanban
//   store: ./Projects
//   view: board
//   group: status
//   hide: [Done]
//   ```
//
// Two things make a fenced code block the right carrier. It is the one
// construct every markdown tool agrees to leave alone — GitHub, Obsidian and
// the shared page's `marked` all show it as a small block that says what it
// is, so a note with a board in it is never mangled by a tool that has never
// heard of Doklin. And it is the precedent the app already has: a mermaid
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

/** The fence's info string. Exact, lowercase: what other renderers read. */
export const KANBAN_LANG = "kanban";

export type EmbedConfig = {
  /** The store's folder, as written — resolved against the note by the host. */
  store: string | null;
  /** A saved view id; null means the store's first kanban view. */
  view: string | null;
  /** Group by this field instead of the view's, for this embed only. */
  group: string | null;
  /** Column values this embed leaves out. */
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
 * The markdown for an embed: the config wrapped in a ```kanban fence. The
 * fence grows past any backtick run in the config, the way a markdown
 * serializer does, so a config carrying backticks can't break out of it.
 */
export function fenceKanban(config: string): string {
  const longest = (config.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const body = config === "" ? "" : `${config}\n`;
  return `${fence}${KANBAN_LANG}\n${body}${fence}`;
}

/**
 * Whether a fenced code block is an embed. Strict on purpose: exactly
 * `kanban`, and no meta after it. A fence the app doesn't claim stays an
 * ordinary code block, which round-trips byte for byte — that is a better
 * outcome than guessing at ` ```Kanban tight ` and rewriting someone's file.
 */
export function isKanbanFence(lang: unknown, meta: unknown): boolean {
  return lang === KANBAN_LANG && (meta === null || meta === undefined || meta === "");
}
