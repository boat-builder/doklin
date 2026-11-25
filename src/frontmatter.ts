// A note's frontmatter: the block at its very top, between two `---` lines.
//
// The editor never sees it. Milkdown would read `---` / `title: x` / `---` as
// a rule and a heading, and write that back. So the block is split off on
// load and put back verbatim on save. Inside it Doklin reads and writes a
// note's tag lines alone (src/tags.ts); the rest belongs to agents and other
// tools, and is shown as it is. The cloud worker splits it the same way to
// leave it off a published page.
//
// A file has a block only when its first line is `---` (trailing whitespace
// tolerated) and a later line is `---`: the rule other tools apply, so a note
// that merely starts with a horizontal rule is left alone.

export type Frontmatter = {
  /** The block, both fences and its final newline included — "" for none. */
  head: string;
  /** The lines between the fences, as the file has them. */
  inner: string;
  /** Everything after the block: what the editor is handed. */
  body: string;
};

const isFence = (line: string) => line.replace(/[ \t\r]+$/, "") === "---";

export function splitFrontmatter(text: string): Frontmatter {
  const none = { head: "", inner: "", body: text };
  const first = text.indexOf("\n");
  if (first === -1 || !isFence(text.slice(0, first))) return none;
  let at = first + 1;
  while (at <= text.length) {
    const end = text.indexOf("\n", at);
    const line = end === -1 ? text.slice(at) : text.slice(at, end);
    if (isFence(line)) {
      const close = end === -1 ? text.length : end + 1;
      return { head: text.slice(0, close), inner: text.slice(first + 1, at).replace(/\r?\n$/, ""), body: text.slice(close) };
    }
    if (end === -1) return none;
    at = end + 1;
  }
  return none;
}
