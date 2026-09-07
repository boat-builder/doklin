// A card, looked at without leaving the board.
//
// Clicking a card used to open a tab, which is a heavy answer to a light
// question: most of the time you want to see what a card says, change a
// property, add a line, and go back to the board you were reading. So a click
// peeks — the card slides in beside the board, with its properties above its
// body — and "Open in a tab" is one click away for the times it really is the
// document you came for.
//
// Two writers, two halves, no clobbering. Properties go through the store
// model's guarded frontmatter splice (write_frontmatter); the body goes
// through its mirror image (write_body), which keeps the frontmatter block on
// disk byte for byte. So a drag on the board behind this panel and a sentence
// typed into it cannot lose each other, and only two writers of the SAME half
// ever race — which the snapshot guard turns into an honest conflict.
//
// A card already open in a tab is never peeked: the tab is the better answer
// and it is already there. App.tsx makes that call before mounting this.
//
// The title in the header is the third writer, and the odd one out: a card's
// title IS its file name, so clicking it renames the FILE. That goes through
// the app's move (movePath) rather than the store model, because a note's
// html rendition, its comment sidecar, its open tabs and its published
// address all have to follow it.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Editor, { type EditorHandle } from "./Editor";
import PropertiesHeader from "./PropertiesHeader";
import { useStore } from "./store/useStore";
import { parseFrontmatter, type PropValue } from "./store/frontmatter";
import { CARD_EXT_RE, renamedCardPath, sanitizeTitle, type FileSnapshot } from "./store/board";
import type { FieldType } from "./store/storeFile";
import {
  expandMarkdown,
  extractMarkdown,
  metaFileOf,
  parseEntityMeta,
  type MdThread,
} from "./metaFile";

const AUTOSAVE_MS = 700;

type ReadFileResult = { contents: string; snapshot: FileSnapshot };

type Props = {
  /** The card's note. */
  path: string;
  /** The store folder the card lives in. */
  dir: string;
  onClose: () => void;
  onOpenTab: (path: string) => void;
  /**
   * Rename through the app, so shares and the sidecar follow. Resolves to an
   * error message, or null when the file moved — `movePath`'s contract.
   */
  onRename?: (from: string, to: string) => Promise<string | null>;
  /** Write the note's comment threads to its sidecar — the app owns that file. */
  onWriteThreads?: (target: string, hybridMd: string, threads: MdThread[]) => Promise<void>;
};

export default function CardPeek({
  path,
  dir,
  onClose,
  onOpenTab,
  onRename,
  onWriteThreads,
}: Props) {
  const { state, model } = useStore(dir);
  const card = state.cards.find((c) => c.path === path) ?? null;

  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The title in the header is the card's FILE NAME; clicking it edits that.
  const [renaming, setRenaming] = useState(false);
  const snapshotRef = useRef<FileSnapshot | null>(null);
  const threadsRef = useRef<MdThread[]>([]);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const savingRef = useRef(false);

  /* ---------- load ---------- */

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setError(null);
    setRenaming(false);
    pendingRef.current = null;
    void (async () => {
      try {
        // The threads first: the editor is handed the EXPANDED document, the
        // same one a tab gets, so a comment written on this card in a tab is
        // visible here and survives a save from here.
        let threads: MdThread[] = [];
        try {
          const meta = await invoke<ReadFileResult>("read_file", {
            path: metaFileOf(path),
          });
          threads = parseEntityMeta(meta.contents).mthreads;
        } catch {
          // no sidecar: a card with no comments
        }
        const read = await invoke<ReadFileResult>("read_file", { path });
        if (cancelled) return;
        snapshotRef.current = read.snapshot;
        threadsRef.current = threads;
        setBody(expandMarkdown(parseFrontmatter(read.contents).body, threads).md);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  /* ---------- save ---------- */

  const flush = useCallback(async () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = pendingRef.current;
    if (next === null || savingRef.current) return;
    pendingRef.current = null;
    savingRef.current = true;
    try {
      const { md: hybrid, mthreads } = extractMarkdown(next);
      const snapshot = await invoke<FileSnapshot>("write_body", {
        path,
        body: hybrid,
        expected: snapshotRef.current,
      });
      snapshotRef.current = snapshot;
      threadsRef.current = mthreads;
      if (onWriteThreads) await onWriteThreads(path, hybrid, mthreads);
      setError(null);
    } catch (e) {
      // A guarded write that lost: someone else has this note open. Say so
      // rather than overwriting them — the tab is where a conflict is resolved.
      const conflict =
        typeof e === "object" && e !== null && "kind" in e &&
        (e as { kind?: string }).kind === "conflict";
      setError(
        conflict
          ? "This note changed somewhere else while you were typing. Open it in a tab to sort it out."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      savingRef.current = false;
    }
  }, [path, onWriteThreads]);

  // Land whatever is pending when the panel goes away — closing is not a
  // reason to lose a sentence.
  useEffect(() => {
    return () => {
      void flush();
    };
  }, [flush]);

  const onMarkdownChange = useCallback(
    (md: string) => {
      pendingRef.current = md;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  /* ---------- chrome ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = path.replace(/^.*\//, "").replace(CARD_EXT_RE, "");

  const setProp = (key: string, value: PropValue) => {
    if (model) void model.setCardProp(path, key, value);
  };

  // Renaming a card is renaming its file, so it goes through the app's move
  // (movePath) rather than the store model: an open tab, the html rendition,
  // the comment sidecar and a published address all follow the note.
  const rename = async (next: string) => {
    const clean = sanitizeTitle(next);
    if (!onRename || !clean || clean === title) return;
    // Land whatever is pending at the OLD path before it moves.
    await flush();
    const failed = await onRename(path, renamedCardPath(path, clean));
    if (failed) setError(failed);
  };

  return (
    <aside className="dk-peek" aria-label={`Card: ${title}`}>
      <header className="dk-peek-head">
        {renaming && onRename ? (
          <TitleInput
            initial={title}
            onCommit={(next) => {
              setRenaming(false);
              void rename(next);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            className="dk-peek-title"
            title={onRename ? "Rename this card" : path}
            disabled={!onRename}
            onClick={() => setRenaming(true)}
          >
            {title}
          </button>
        )}
        <button className="dk-peek-tab" onClick={() => {
          void flush();
          onOpenTab(path);
          onClose();
        }}>
          Open in a tab
        </button>
        <button className="dk-peek-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {error && <div className="dk-peek-warn">{error}</div>}
      <div className="dk-peek-body">
        {state.def && card && (
          <PropertiesHeader
            def={state.def}
            props={card.props}
            opaqueCount={card.opaque.length}
            onChange={setProp}
            onAddField={(name: string, type: FieldType) => void model?.addField(name, type)}
            onRenameField={(id, name) => void model?.renameField(id, name)}
            onRetypeField={(id, type) => void model?.retypeField(id, type)}
            onDeleteField={(id) => void model?.deleteField(id)}
            onAddOption={(field, name) => void model?.addOption(field, name)}
          />
        )}
        {body === null ? (
          <div className="dk-board-empty">{error ? "" : "Loading…"}</div>
        ) : (
          <Editor
            key={path}
            ref={editorRef}
            initialMarkdown={body}
            onChange={onMarkdownChange}
            commentsVisible={false}
          />
        )}
      </div>
    </aside>
  );
}

/**
 * The card's title, while it is being edited.
 *
 * Same contract as the sidebar's inline rename (NameRow), because it is the
 * same act — renaming a file: Enter commits, Escape abandons, and clicking
 * away COMMITS rather than throwing the name away. That last one matters
 * here: the panel stays open behind this input, so "click into the body and
 * carry on" must not be the gesture that silently loses the retitle.
 */
function TitleInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  // Enter commits AND blurs; without this the blur would commit a second time.
  const doneRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const done = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit && value.trim()) onCommit(value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="dk-peek-title-input"
      aria-label="Rename card"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done(false);
        }
        // The panel closes on Escape and the app has its own shortcuts; while
        // a name is being typed, neither is what the key means.
        e.stopPropagation();
      }}
      onBlur={() => done(true)}
    />
  );
}
