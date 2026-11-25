// What the title above a note is: the document's name, edited in place —
// on the Mac (src/DocTitle.tsx) and in the iPhone's editor (src/ios-editor/)
// alike.

/** How long typing pauses before the file is renamed. */
export const RENAME_PAUSE_MS = 700;

// A name the app gave a document nobody has named: its title shows empty,
// with the name as the placeholder, so typing starts the title. The
// iPhone's reader and its New note know it too (`DocTitle`, ios/DoklinKit):
// change both.
const UNNAMED_RE = /^Untitled(?: \d+)?$/;

/** What the title field holds for a document called `name`. */
export const shownTitle = (name: string) => (UNNAMED_RE.test(name) ? "" : name);

/** A title is one line: whatever breaks it (a paste, a drop) is a space. */
export const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ");

/** Why a title can never be a file's name, or null when it can. A name
 *  another document has is the host's to say: only it knows the folder. */
export function titleProblem(title: string): string | null {
  if (/[/\\:]/.test(title)) return "A title can’t contain /, \\ or :.";
  if (title.startsWith(".")) return "A title can’t start with a dot.";
  return null;
}
