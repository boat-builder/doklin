// The title above the note in the iPhone's editor: the document's name,
// edited in place, as on the Mac (src/DocTitle.tsx). Making a title the
// name is the app's: a moment after typing stops, and when the title is
// left, the page hands it over (`rename`); the app renames the file and
// answers with the name it has now, and why not when it could not
// (`named`). What a file name can never hold is said here, as it is typed.
import { oneLine, RENAME_PAUSE_MS, shownTitle, titleProblem } from "../titleText";

type Hooks = {
  /** Make `title` (trimmed, not empty, not the name) the name; `left` when
   *  the title was left that way. */
  rename: (title: string, left: boolean) => void;
  /** Leave the title for the start of the note. */
  enterBody: () => void;
  /** Say why a title that was left went back to the name. */
  putBack: (sentence: string) => void;
};

export type Title = {
  /** A note opened: what it is called. */
  load: (name: string) => void;
  /** What the app answered a rename with: the name now, the title it was
   *  asked for, and why that could not be the name (null when it is). */
  named: (name: string, title: string, problem: string | null) => void;
  editable: (on: boolean) => void;
  /** The caret into the title: its text selected, or at its end. */
  focus: (select: boolean) => void;
};

export function makeTitle(root: HTMLElement, hooks: Hooks): Title {
  root.className = "doc-title";
  // The field grows with its words: a hidden copy of them in the same grid
  // cell gives the cell its height (`::after`, editor.css).
  const wrap = document.createElement("div");
  wrap.className = "doc-title-field";
  const field = document.createElement("textarea");
  field.rows = 1;
  field.spellcheck = false;
  field.setAttribute("aria-label", "Title");
  field.setAttribute("enterkeyhint", "next");
  field.setAttribute("autocapitalize", "sentences");
  const line = document.createElement("div");
  line.className = "doc-title-problem";
  line.setAttribute("role", "alert");
  line.hidden = true;
  wrap.append(field);
  root.replaceChildren(wrap, line);

  let name = "";
  let timer: number | null = null;

  const show = (text: string) => {
    field.value = text;
    wrap.dataset.value = text;
  };
  const say = (problem: string | null) => {
    line.textContent = problem ?? "";
    line.hidden = problem === null;
  };
  const typed = () => field.value.trim();
  const stop = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const wanted = (title: string) => title !== "" && title !== name;

  field.addEventListener("input", () => {
    const one = oneLine(field.value);
    if (one !== field.value) field.value = one;
    wrap.dataset.value = field.value;
    const title = typed();
    say(titleProblem(title));
    stop();
    timer = window.setTimeout(() => {
      timer = null;
      if (wanted(title) && typed() === title && !titleProblem(title)) hooks.rename(title, false);
    }, RENAME_PAUSE_MS);
  });

  field.addEventListener("blur", () => {
    stop();
    const title = typed();
    const problem = titleProblem(title);
    say(null);
    if (wanted(title) && !problem) {
      hooks.rename(title, true);
      return;
    }
    show(shownTitle(name));
    if (wanted(title) && problem) hooks.putBack(problem);
  });

  field.addEventListener("keydown", (e) => {
    if (e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
    if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey) || (e.key === "ArrowDown" && atEnd)) {
      e.preventDefault();
      hooks.enterBody();
    }
  });

  // A paste is one line, put in as typing is, so undo takes it back.
  field.addEventListener("paste", (e) => {
    const pasted = e.clipboardData?.getData("text/plain");
    if (!pasted || !/[\r\n]/.test(pasted)) return;
    e.preventDefault();
    document.execCommand("insertText", false, oneLine(pasted).trim());
  });

  return {
    load(next) {
      stop();
      name = next;
      field.placeholder = next || "Untitled";
      show(shownTitle(next));
      say(null);
    },
    named(next, title, problem) {
      name = next;
      field.placeholder = next || "Untitled";
      if (document.activeElement !== field) {
        show(shownTitle(next));
        say(null);
      } else if (typed() === title) {
        say(problem ?? titleProblem(title));
      }
    },
    editable(on) {
      field.readOnly = !on;
    },
    focus(select) {
      field.focus();
      if (select) field.select();
      else field.setSelectionRange(field.value.length, field.value.length);
    },
  };
}
