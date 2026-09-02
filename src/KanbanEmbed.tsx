// The frame a ` ```kanban ` fence turns into inside a note.
//
// Everything here is what surrounds the board, not the board: which store the
// fence names, what to do when it names none (a picker), what to say when the
// name can't be resolved, and the Source chip that flips the frame back to
// the config text. The board itself is the same <KanbanBoard> a board tab
// mounts — one component, two hosts, so a drag in a note and a drag in a tab
// are the same code writing the same files.
//
// The frame is mounted by the ProseMirror node view in kanbanEmbed.ts, inside
// a contenteditable=false element whose stopEvent() answers true for
// everything: typing a card title in here never reaches the document.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import KanbanBoard from "./KanbanBoard";
import BoardSnapshot from "./BoardSnapshot";
import type { BoardSnap } from "./store/board";
import { linkTargetPath, relativeLinkPath } from "./docLinks";
import {
  parseEmbedConfig,
  serializeEmbedConfig,
  type EmbedConfig,
} from "./store/embedConfig";

/** A board in the workspace, as the picker lists it. */
export type StoreChoice = { path: string; name: string };

/**
 * What the embed needs from the app around it. The web shell has none of
 * this (its pages carry no workspace), so a host is optional everywhere and
 * its absence is a state the frame draws rather than a crash.
 */
export type KanbanEmbedHost = {
  /** The note this editor is showing — what a relative `store:` resolves against. */
  docPath: string | null;
  /** Every board in the workspace, for the picker. */
  listStores: () => Promise<StoreChoice[]>;
  /** Create a board of this name beside the note; resolves to its folder. */
  createStore: (name: string) => Promise<string>;
  /** Open a card's note in a tab, the way following a link does. */
  openCard: (path: string) => void;
  renameCard?: (from: string, to: string) => Promise<string | null>;
  deleteCard?: (path: string) => void;
  revealCard?: (path: string) => void;
};

type Props = {
  /** The fence's body, verbatim. */
  config: string;
  /**
   * The host, read through a GETTER rather than handed over as an object.
   * The app rebuilds its host on every render; a captured copy would go
   * stale between the frame's renders, and depending on its identity would
   * re-render the whole board for nothing. The getter is stable for the life
   * of the node view, so callbacks always reach the current app.
   */
  getHost: () => KanbanEmbedHost | null;
  /**
   * The board as a PUBLISHED page carries it — a picture, not a folder. Set
   * only where there is no host to read a real one from (the app shell); a
   * fence the page carries no snapshot for still says so rather than
   * pretending.
   */
  getSnapshot?: (config: string) => BoardSnap | null;
  readOnly: boolean;
  /** The node is selected in the document (⌫ would delete it). */
  selected: boolean;
  /** Rewrite the fence's body — one transaction on the note. */
  onConfigChange: (next: string) => void;
};

export default function KanbanEmbedFrame({
  config,
  getHost,
  getSnapshot,
  readOnly,
  selected,
  onConfigChange,
}: Props) {
  const host = getHost();
  const snapshot = host ? null : (getSnapshot?.(config) ?? null);
  const cfg = useMemo(() => parseEmbedConfig(config), [config]);
  const [editingSource, setEditingSource] = useState(false);
  // A fence with nothing in it is what the slash menu inserts: the picker is
  // the first thing the writer sees, not an error.
  const blank = cfg.store === null;

  const target = useMemo(
    () => (cfg.store ? linkTargetPath(cfg.store, host?.docPath ?? null) : null),
    [cfg.store, host?.docPath],
  );

  const setConfig = useCallback(
    (next: EmbedConfig) => onConfigChange(serializeEmbedConfig(next)),
    [onConfigChange],
  );

  return (
    <div
      className={`dk-embed-frame ${selected ? "is-selected" : ""}`}
      data-dk-embed=""
    >
      <div className="dk-embed-bar">
        <span className="dk-embed-kind">Board</span>
        {cfg.store && <span className="dk-embed-ref">{cfg.store}</span>}
        {!readOnly && (
          <button
            type="button"
            className={`dk-embed-source ${editingSource ? "is-on" : ""}`}
            onClick={() => setEditingSource((v) => !v)}
            title="Edit this embed's source"
          >
            Source
          </button>
        )}
      </div>
      {editingSource ? (
        <ConfigEditor
          config={config}
          onCommit={(next) => {
            setEditingSource(false);
            if (next !== config) onConfigChange(next);
          }}
          onCancel={() => setEditingSource(false)}
        />
      ) : snapshot ? (
        // A shared page: no workspace behind us, but the page was published
        // with a picture of this board. Read-only by construction — there is
        // no folder here to write to.
        <BoardSnapshot snap={snapshot} />
      ) : !host ? (
        // No workspace and no snapshot — an older page, or a fence whose
        // board had already been deleted when the page was published. The
        // fence still says what it is.
        <div className="dk-embed-note">
          <p>This board isn’t available on this page.</p>
          {config.trim() !== "" && <pre className="dk-embed-src">{config}</pre>}
        </div>
      ) : blank ? (
        <StorePicker
          getHost={getHost}
          docPath={host.docPath}
          readOnly={readOnly}
          onPick={(path) => {
            const ref = host.docPath ? relativeLinkPath(host.docPath, path) : path;
            setConfig({ ...cfg, store: ref });
          }}
        />
      ) : !target ? (
        <div className="dk-embed-note">
          <p>
            <code>{cfg.store}</code> is written relative to this note, and this
            note hasn’t been saved anywhere yet. Save it, or point the embed at
            a full path.
          </p>
        </div>
      ) : (
        <KanbanBoard
          dir={target}
          viewId={cfg.view}
          group={cfg.group}
          hide={cfg.hide}
          embedded
          readOnly={readOnly}
          // Every callback goes back through the getter, so a card opened
          // ten minutes from now reaches the app as it is then.
          onOpenCard={(p) => getHost()?.openCard(p)}
          onRenameCard={
            host.renameCard
              ? (from, to) => getHost()?.renameCard?.(from, to) ?? Promise.resolve(null)
              : undefined
          }
          onDeleteCard={host.deleteCard ? (p) => getHost()?.deleteCard?.(p) : undefined}
          onRevealInFinder={host.revealCard ? (p) => getHost()?.revealCard?.(p) : undefined}
        />
      )}
    </div>
  );
}

/* ---------- the source view ---------- */

// The config text, editable in place — the same switch the diagram block
// makes. A plain textarea rather than a nested CodeMirror: four keys of
// `key: value` do not need a language server.
function ConfigEditor({
  config,
  onCommit,
  onCancel,
}: {
  config: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="dk-embed-editor"
      defaultValue={config}
      spellCheck={false}
      rows={Math.max(3, config.split("\n").length + 1)}
      onBlur={(e) => onCommit(e.target.value.replace(/\s+$/, ""))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit((e.target as HTMLTextAreaElement).value.replace(/\s+$/, ""));
        }
      }}
    />
  );
}

/* ---------- the picker ---------- */

// An embed that names no store. Rather than a modal, the choice is made in
// the block itself: the workspace's boards, or a new one beside this note.
function StorePicker({
  getHost,
  docPath,
  readOnly,
  onPick,
}: {
  getHost: () => KanbanEmbedHost | null;
  docPath: string | null;
  readOnly: boolean;
  onPick: (path: string) => void;
}) {
  const [stores, setStores] = useState<StoreChoice[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getHost()
      ?.listStores()
      .then((list) => {
        if (!cancelled) setStores(list);
      })
      .catch(() => {
        if (!cancelled) setStores([]);
      });
    return () => {
      cancelled = true;
    };
  }, [getHost]);

  if (readOnly) {
    return (
      <div className="dk-embed-note">
        <p>This embed doesn’t name a board yet.</p>
      </div>
    );
  }

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A name is required.");
      return;
    }
    const host = getHost();
    if (!host) return;
    setBusy(true);
    setError(null);
    try {
      onPick(await host.createStore(trimmed));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dk-embed-pick">
      <p className="dk-embed-pick-head">Which board?</p>
      {stores === null ? (
        <p className="dk-embed-pick-none">Looking…</p>
      ) : stores.length === 0 ? (
        <p className="dk-embed-pick-none">
          No boards in this workspace yet — make one below.
        </p>
      ) : (
        <div className="dk-embed-pick-list">
          {stores.map((s) => (
            <button
              key={s.path}
              type="button"
              className="dk-embed-pick-item"
              onClick={() => onPick(s.path)}
              title={s.path}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {creating ? (
        <div className="dk-embed-pick-new">
          <input
            className="dk-inline-input"
            autoFocus
            placeholder="Board name"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setCreating(false);
              }
            }}
          />
          <button type="button" className="dk-embed-pick-go" disabled={busy} onClick={() => void create()}>
            Create
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="dk-embed-pick-item is-new"
          onClick={() => setCreating(true)}
          disabled={docPath === null}
          title={
            docPath === null
              ? "Save this note first — a new board is created beside it."
              : "Create a board beside this note"
          }
        >
          New board…
        </button>
      )}
      {error && <p className="dk-embed-pick-error">{error}</p>}
    </div>
  );
}
