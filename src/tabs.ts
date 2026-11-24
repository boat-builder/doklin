// What a tab is. The tab strip (TabBar.tsx), the window session and the
// document machinery (App.tsx) all read tabs through here.
//
// A tab is a descriptor; its document's content is on disk at `path` and
// autosaves there, so disk — not memory — is the source of truth across
// tabs. The kind says whose file that is:
//
//   file      a document of the user's, at its real path.
//   untitled  a note that has not been saved to a file yet. Its path is a
//             buffer of the app's own (src-tauri/src/untitled.rs): the note
//             belongs to its tab, is unsaved for as long as it has text, and
//             is gone when the tab closes. Saving it turns the tab into a
//             `file` tab, in place.

import { stripComments } from "./criticMarkup";

export type TabKind = "file" | "untitled";

/** What is persisted of a tab — in the window session, and in the backend's
 *  window registry. Everything else about one is found again when it loads. */
export type StoredTab = { id: string; kind: TabKind; path: string };

/** A document a tab showed, and how far down it was read. */
export type Step = { path: string; scroll: number };

/** Where a tab can go Back and Forward to, nearest last in both. A link
 *  followed in the tab adds a step; they last as long as the window and are
 *  never stored. */
export type Steps = { back: Step[]; forward: Step[] };

/** `missing` marks a file whose path failed to read — the drive is
 *  unmounted, the file moved — kept visible as a "ghost" tab instead of being
 *  silently dropped. Every activation re-checks, so the flag heals itself. */
export type DocTab = StoredTab & {
  kind: "file";
  missing?: boolean;
  steps?: Steps;
  title?: never;
  unsaved?: never;
};

/** `title` is the note's first line ("" until it has one) and `unsaved`
 *  whether it has any text: both follow the text as it is typed, and are read
 *  back out of the buffer when a session is restored. An untitled note never
 *  follows a link in its own tab, so it has no steps: it would be gone. */
export type UntitledTab = StoredTab & {
  kind: "untitled";
  title: string;
  unsaved: boolean;
  missing?: never;
  steps?: never;
};

export type Tab = DocTab | UntitledTab;

export const toStoredTab = ({ id, kind, path }: Tab): StoredTab => ({ id, kind, path });

export const isUntitled = (t: Tab): t is UntitledTab => t.kind === "untitled";

/** How many steps each way a tab keeps. */
const STEPS_KEPT = 100;

/** `steps` with `step` added to the end of one side, the oldest dropped past
 *  what a tab keeps. */
export function stepOnto(steps: Step[], step: Step): Step[] {
  return [...steps, step].slice(-STEPS_KEPT);
}

/** A tab's steps with every path passed through `remap`: a file renamed or
 *  moved is still where Back goes. The same object when nothing moved. */
export function remapSteps(steps: Steps | undefined, remap: (path: string) => string): Steps | undefined {
  if (!steps) return steps;
  let moved = false;
  const side = (list: Step[]) =>
    list.map((s) => {
      const path = remap(s.path);
      if (path === s.path) return s;
      moved = true;
      return { ...s, path };
    });
  const next = { back: side(steps.back), forward: side(steps.forward) };
  return moved ? next : steps;
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const DOC_EXT_RE = /\.(md|markdown|mdown|mkd|html)$/i;

/** Whether a file tab holds a file that is not a document — opened from the
 *  tree, where every file can be clicked. Its tab says so instead of showing
 *  it: nothing reads it, watches it or autosaves it, and it can't be split.
 *  It is still a file tab, so ⌘⌫ trashes it like any other. */
export const isUnsupportedTab = (t: Pick<Tab, "kind" | "path">): boolean =>
  t.kind === "file" && !DOC_EXT_RE.test(t.path);

/** The name a tab goes by: a document's file name without its extension, an
 *  untitled note's first line. */
export const tabLabel = (t: Tab): string =>
  t.kind === "untitled" ? t.title || "Untitled" : basename(t.path).replace(DOC_EXT_RE, "");

/** Whether a tab is holding work that exists nowhere else: an untitled note
 *  with text in it. Files autosave, so a file tab never is. */
export const isUnsaved = (t: Tab): boolean => t.kind === "untitled" && t.unsaved;

// A line the editor writes for an empty paragraph says nothing.
const BLANK_RE = /^(?:\s|<br\s*\/?>)*$/;

/** Whether a note's markdown has anything in it. An untitled note that does
 *  not is not unsaved: it closes without a question and is not restored. */
export const noteHasText = (md: string): boolean => !BLANK_RE.test(md);

const TITLE_MAX = 60;

// One line of markdown as plain words: comment markers, link targets and
// block / inline syntax taken off.
const plainLine = (line: string): string =>
  stripComments(line)
    .replace(/<br\s*\/?>/gi, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images: their text
    .replace(/^[#>\s*+-]+/, "") // heading, quote and bullet markers
    .replace(/^(?:\d+[.)]|\[[ xX]\])\s+/, "") // "1." and task boxes
    .replace(/[*_`~[\]]/g, "") // inline emphasis and code
    .trim();

/** What an untitled note is called: its first line that says anything, as
 *  plain words — "" when there is none. It is also the name the Save prompt
 *  offers, so a note that opens with a heading saves as ⌘S, Enter. Scans
 *  line by line because it runs on every keystroke. */
export function noteTitle(md: string): string {
  for (let start = 0; start < md.length; ) {
    let end = md.indexOf("\n", start);
    if (end < 0) end = md.length;
    const title = plainLine(md.slice(start, end));
    if (title) return title.slice(0, TITLE_MAX).trim();
    start = end + 1;
  }
  return "";
}
