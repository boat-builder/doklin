// The title above a note: the document's name, edited in place. A file's
// name is its title, so a new title renames the file — a moment after typing
// stops, and when the title is left. Until then the host shows the title as
// typed wherever the name shows (`onDraft`).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { oneLine, RENAME_PAUSE_MS, shownTitle } from "./titleText";


export type DocTitleHandle = {
  /** The caret into the title, at its end. */
  focus: () => void;
};

type Props = {
  /** What the document is called now: its file's name without the
   *  extension, or an untitled note's title ("" for none). */
  name: string;
  readOnly: boolean;
  /** Put the caret in the title, its text selected; `onFocused` says it is. */
  focusNow?: boolean;
  onFocused?: () => void;
  /** The title as it stands (trimmed), on each keystroke and once it is left. */
  onDraft?: (title: string) => void;
  /** Why a title can never be the name, said as it is typed. */
  problemOf?: (title: string) => string | null;
  /** Make `title` (trimmed, not empty, not the name) the name. A sentence
   *  when it can't be. */
  onRename?: (title: string) => Promise<string | null>;
  /** Leave the title for the start of the note. */
  onEnterBody?: () => void;
  /** Say why a title that was left went back to the name. */
  onPutBack?: (sentence: string) => void;
};

const DocTitle = forwardRef<DocTitleHandle, Props>(function DocTitle(
  { name, readOnly, focusNow, onFocused, onDraft, problemOf, onRename, onEnterBody, onPutBack },
  ref,
) {
  const [text, setText] = useState(() => shownTitle(name));
  const [problem, setProblem] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  const nameRef = useRef(name);
  nameRef.current = name;
  const focusedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // Renames run one after another, each over the name the last one left.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const callbacks = useRef({ onDraft, problemOf, onRename, onPutBack, onFocused });
  callbacks.current = { onDraft, problemOf, onRename, onPutBack, onFocused };

  // A new name from elsewhere (the sidebar, another device, the rename this
  // field asked for) shows, unless it is being typed over.
  useEffect(() => {
    if (focusedRef.current) return;
    textRef.current = shownTitle(name);
    setText(textRef.current);
    setProblem(null);
  }, [name]);

  useEffect(() => {
    if (!focusNow || readOnly) return;
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.select();
    callbacks.current.onFocused?.();
  }, [focusNow, readOnly]);

  useImperativeHandle(ref, () => ({
    focus() {
      const field = fieldRef.current;
      if (!field || readOnly) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    },
  }), [readOnly]);

  // The note under the title starts a viewport below the window's top: the
  // wrap is told how tall the title is, so a short note doesn't scroll.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const wrap = root?.parentElement;
    if (!root || !wrap) return;
    const observer = new ResizeObserver(() =>
      wrap.style.setProperty("--doc-title-h", `${root.offsetHeight}px`),
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
      wrap.style.removeProperty("--doc-title-h");
    };
  }, []);

  // Rename to what was typed, once the renames before it are done. Resolves
  // to why it couldn't be, or null.
  const commit = useCallback((typed: string): Promise<string | null> => {
    const run = chainRef.current.then(async () => {
      const title = typed.trim();
      if (!title || title === nameRef.current) return null;
      const { problemOf: check, onRename: rename } = callbacks.current;
      return check?.(title) ?? (await rename?.(title)) ?? null;
    });
    chainRef.current = run.catch(() => null);
    return run.catch((e) => String(e));
  }, []);

  const stopTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => stopTimer, []);

  const typed = (value: string) => {
    textRef.current = value;
    setText(value);
    const title = value.trim();
    callbacks.current.onDraft?.(title);
    // What a name can never be is said at once; a name that is taken, once
    // the rename is tried.
    setProblem(title ? (callbacks.current.problemOf?.(title) ?? null) : null);
    stopTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void commit(value).then((p) => {
        if (textRef.current === value) setProblem(p);
      });
    }, RENAME_PAUSE_MS);
  };

  const left = () => {
    focusedRef.current = false;
    stopTimer();
    const value = textRef.current;
    void commit(value).then((p) => {
      if (focusedRef.current) return;
      setProblem(null);
      if (p || !value.trim()) {
        // Left as a title that can't be a name: the name comes back.
        textRef.current = shownTitle(nameRef.current);
        setText(textRef.current);
        if (p) callbacks.current.onPutBack?.(p);
      }
      callbacks.current.onDraft?.(textRef.current.trim());
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    const field = e.currentTarget;
    const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
    if (
      e.key === "Enter" ||
      (e.key === "Tab" && !e.shiftKey) ||
      (e.key === "ArrowDown" && !e.shiftKey && atEnd)
    ) {
      e.preventDefault();
      onEnterBody?.();
    }
  };

  // A paste of several lines is one line here; through the editing command,
  // so ⌘Z takes it back.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (!/[\r\n]/.test(pasted)) return;
    e.preventDefault();
    document.execCommand("insertText", false, oneLine(pasted).trim());
  };

  return (
    <div className="doc-title" ref={rootRef}>
      <div className="doc-title-field" data-value={text}>
        <textarea
          ref={fieldRef}
          rows={1}
          value={text}
          placeholder={name || "Untitled"}
          readOnly={readOnly}
          aria-label="Title"
          spellCheck={false}
          onChange={(e) => typed(oneLine(e.target.value))}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={left}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      {problem && (
        <div className="doc-title-problem" role="alert">
          {problem}
        </div>
      )}
    </div>
  );
});

export default DocTitle;
