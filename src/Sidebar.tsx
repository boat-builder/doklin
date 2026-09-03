import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeCloud, type CloudStatus } from "./cloud";
import { invoke } from "@tauri-apps/api/core";

export type TreeNode =
  // `paired` marks a markdown row that also has an html rendition folded into
  // it (a same-stem .html sibling), so the tree can icon md-only, html-only,
  // and bundled md+html rows distinctly. Absent/false for standalone html.
  // `supported: false` marks a file the app can't open — only ever present in
  // "show every file" mode, where those rows are listed greyed out so their
  // existence is visible. Absent means openable (the documents-only tree).
  | { kind: "file"; name: string; path: string; paired?: boolean; supported?: boolean }
  // `store: true` marks a DATASTORE folder — a board. The backend returns no
  // children for one (a board can hold hundreds of cards, and the tree is not
  // where they belong), so the row has no disclosure triangle: clicking it
  // opens the board.
  | { kind: "dir"; name: string; path: string; children: TreeNode[]; store?: boolean };

// A file row the app can open (markdown, html, or a bundled pair). Folders and
// documents-only trees are always openable; only "show every file" rows differ.
const isOpenable = (node: TreeNode) => node.kind !== "file" || node.supported !== false;

// One selected explorer row (VS Code-style), file or folder. The selection is
// a list — ⌘-click toggles rows in and out, ⇧-click extends over the visible
// range — whose LAST entry is the primary one (the row acted on most
// recently). Owned by App — the primary entry doubles as the creation context
// for saving drafts (the save dialog defaults into the selected folder / next
// to the selected file).
export type SidebarSelection = { path: string; kind: "file" | "dir" };

// Mirror of the app-wide file clipboard (it lives in the Rust backend — see
// FileClipboard in lib.rs — so every workspace window shares it). The sidebar
// only reads it: to enable Paste and to dim rows a Cut is about to move.
export type FileClipboardPayload = { items: SidebarSelection[]; cut: boolean };

// Nested entries collapse into their selected ancestor: moving, pasting, or
// trashing a folder already takes everything inside it, so acting on a
// selected child again would double-move or double-trash it.
export const pruneNestedSelection = (sels: SidebarSelection[]): SidebarSelection[] =>
  sels.filter(
    (s) =>
      !sels.some(
        (o) => o.kind === "dir" && o.path !== s.path && s.path.startsWith(o.path + "/"),
      ),
  );

// Where an in-progress "New File…" / "New Folder…" will land. The input row is
// rendered inline inside `parentDir`, like VS Code's explorer.
type PendingCreate = { parentDir: string; kind: "file" | "dir" | "board" };

// An in-progress inline rename: the row at `path` is replaced by a name input.
// `openable: false` (an unsupported file in show-all mode) keeps the row's own
// extension out of the document-extension rules — its name is edited whole.
type PendingRename = { path: string; kind: "file" | "dir"; openable?: boolean };

// A context-menu invocation: where it was opened and what it targets. "root"
// is a right-click on empty sidebar space (creation lands at the workspace root).
type MenuTarget = { path: string; kind: "file" | "dir" | "root"; openable?: boolean };
type MenuState = { x: number; y: number; target: MenuTarget };

// One row in a drag (pointer-based move, VS Code-style). HTML5 drag events
// are intercepted by Tauri's native drag-drop handling, so — like the tab bar's
// reorder — this is built on pointer capture instead. A drag carries a SET of
// entries: grabbing a row that's part of the multi-selection drags the whole
// selection; grabbing any other row drags just that row. `openable: false`
// rows still move within the tree, but never tear out into an editor pane.
type DragEntry = { path: string; kind: "file" | "dir"; openable?: boolean };

// The pointer-drag plumbing every row needs, bundled so TreeItem's prop list
// stays readable. `suppressClick` swallows the click that trails a finished
// drag (pointer capture retargets it onto the source row).
type TreeDnd = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>, entry: DragEntry) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  suppressClick: () => boolean;
};

type Props = {
  root: string;
  // The workspace's cloud status when it is connected (the dot beside its
  // name); null or absent when it is purely local.
  cloud?: CloudStatus | null;
  currentPath: string | null;
  selection: SidebarSelection[];
  // The shared file clipboard (null/empty = nothing to paste).
  clipboard: FileClipboardPayload | null;
  refreshToken: number;
  onSelect: (sels: SidebarSelection[]) => void;
  onOpenFile: (path: string) => void;
  // Open a datastore folder as a board tab.
  onOpenBoard: (dirPath: string) => void;
  // Write `store.jsonl` into an (already created) folder and open it as a
  // board. Backs both "New Board…" and "Turn into Board" — the second adds
  // the definition file to a folder of notes, touching no note's content.
  onMakeBoard: (dirPath: string) => Promise<string | null>;
  onOpenFolder: () => void;
  onOpenFilePicker: () => void;
  onRevealInFinder: (path: string) => void;
  onDelete: (entries: SidebarSelection[]) => void;
  // Park entries on the app-wide file clipboard (Cut when `cut`), and paste
  // the clipboard's contents into a destination folder.
  onCopyEntries: (entries: SidebarSelection[], cut: boolean) => void;
  onPasteEntries: (destDir: string) => void;
  // Move/rename `from` to `to` on disk and repoint app state (tabs, watcher…).
  // Resolves to an error message to surface, or null on success.
  onMovePath: (from: string, to: string, kind: "file" | "dir") => Promise<string | null>;
  onSwitchToSearch: () => void;
  // Dragging a FILE row past the tree and over the editor area (the app
  // shows its split drop zones): stream pointer positions, commit the drop,
  // or cancel when the pointer comes back / the drag dies. Folder rows never
  // tear out — only files open in panes.
  onDragFileToEditor?: (path: string, x: number, y: number) => void;
  onDropFileToEditor?: (path: string, x: number, y: number) => void;
  onDragFileCancel?: () => void;
  // Drag-resize of the sidebar itself (right-edge handle); the app owns the
  // width (a CSS variable on the grid) and persists it.
  onResizeWidth?: (w: number) => void;
};

// A press becomes a drag only after moving this far, so plain clicks are untouched.
const DRAG_THRESHOLD_PX = 5;
// Hovering a collapsed folder this long during a drag springs it open.
const AUTO_EXPAND_MS = 550;
// Dragging within this band of the tree's top/bottom edge scrolls it.
const AUTO_SCROLL_ZONE_PX = 28;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
// Extensions the tree shows (and hides in labels): markdown documents and
// standalone html renditions. A tree row can also be an md+html pair — the
// backend folds those into one row on the markdown path.
const DOC_EXT_RE = /\.(md|markdown|mdown|mkd|html)$/i;
const HTML_EXT_RE = /\.html$/i;

// "Show all files" — whether the tree lists the whole filesystem (with
// non-documents greyed out) or only openable documents. A view preference, so
// it lives in localStorage and applies to every workspace.
const SHOW_ALL_STORAGE_KEY = "doklin:sidebar-show-all";
const readShowAll = () => {
  try {
    return localStorage.getItem(SHOW_ALL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

export default function Sidebar({
  root,
  cloud = null,
  currentPath,
  selection,
  clipboard,
  refreshToken,
  onSelect,
  onOpenFile,
  onOpenBoard,
  onMakeBoard,
  onOpenFolder,
  onOpenFilePicker,
  onRevealInFinder,
  onDelete,
  onCopyEntries,
  onPasteEntries,
  onMovePath,
  onSwitchToSearch,
  onDragFileToEditor,
  onDropFileToEditor,
  onDragFileCancel,
  onResizeWidth,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [showAll, setShowAll] = useState<boolean>(readShowAll);

  const toggleShowAll = useCallback(() => {
    setShowAll((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_ALL_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* private mode / quota — the toggle still works for this session */
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const node = await invoke<TreeNode>("list_md_tree", { path: root, all: showAll });
      setTree(node);
    } catch (e) {
      setError(String(e));
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, [root, showAll]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Every board in the tree, by path — the context menu asks whether a folder
  // is already a board, and the row asks whether to draw a disclosure.
  const storeDirs = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: TreeNode) => {
      if (n.kind !== "dir") return;
      if (n.store) out.add(n.path);
      for (const c of n.children) walk(c);
    };
    if (tree) walk(tree);
    return out;
  }, [tree]);

  /* ---------- Selection (single, ⌘-toggle, ⇧-range) ---------- */

  // The rows in on-screen order, respecting collapsed folders — the universe
  // a ⇧-click range spans.
  const visibleEntries = useMemo(() => {
    const out: SidebarSelection[] = [];
    const walk = (n: TreeNode) => {
      if (n.kind !== "dir") return;
      for (const c of n.children) {
        out.push({ path: c.path, kind: c.kind });
        if (c.kind === "dir" && !collapsed.has(c.path)) walk(c);
      }
    };
    if (tree) walk(tree);
    return out;
  }, [tree, collapsed]);

  // The fixed end of a ⇧-click range: the row last plain- or ⌘-clicked.
  const selectionAnchorRef = useRef<string | null>(null);

  // Modifier-aware row selection (VS Code's explorer): plain click selects
  // just this row (and the row goes on to open/toggle); ⌘-click toggles
  // membership; ⇧-click selects the visible range from the anchor. Returns
  // true when the click was a multi-select gesture the row must NOT also act
  // on (multi-selecting shouldn't open files or fold folders).
  const handleRowSelect = useCallback(
    (e: React.MouseEvent, entry: SidebarSelection): boolean => {
      if (e.shiftKey) {
        const anchor = selectionAnchorRef.current;
        const ai = anchor ? visibleEntries.findIndex((v) => v.path === anchor) : -1;
        const bi = visibleEntries.findIndex((v) => v.path === entry.path);
        if (ai !== -1 && bi !== -1) {
          const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
          // Clicked end last = primary, whichever direction the range ran.
          const range = visibleEntries.slice(lo, hi + 1);
          const ordered = ai <= bi ? range : range.reverse();
          onSelect(ordered);
          return true;
        }
        // Anchor (or target) vanished from view — fall through to plain click.
      }
      if (e.metaKey || e.ctrlKey) {
        const rest = selection.filter((s) => s.path !== entry.path);
        onSelect(rest.length === selection.length ? [...selection, entry] : rest);
        selectionAnchorRef.current = entry.path;
        return true;
      }
      selectionAnchorRef.current = entry.path;
      onSelect([entry]);
      return false;
    },
    [visibleEntries, selection, onSelect],
  );

  // The primary selection — the creation context for the header's New File /
  // New Folder buttons.
  const primarySelection = selection[selection.length - 1] ?? null;

  // Rows a pending Cut would move away: dimmed. Only cut ROOTS dim — children
  // ride along implicitly, VS Code-style.
  const cutPaths = useMemo(
    () =>
      clipboard?.cut
        ? new Set(clipboard.items.map((i) => i.path))
        : new Set<string>(),
    [clipboard],
  );
  const clipboardHasFiles = (clipboard?.items.length ?? 0) > 0;

  /* ---------- Drag-to-move ---------- */

  // Render state: the dragged entries (dim their rows; the grabbed one leads
  // the ghost pill) and the currently valid destination folder (highlights
  // it; root = empty space).
  const [dragging, setDragging] = useState<DragEntry[] | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  // Rows riding the in-flight drag (dimmed in place while the ghost moves).
  const dragPaths = useMemo(
    () => new Set((dragging ?? []).map((en) => en.path)),
    [dragging],
  );
  // Pointer tracking lives in refs — pointermove is high-frequency, and the
  // capturing row's handlers must read fresh values without re-registering.
  const dragRef = useRef<{
    // The grabbed row, then the rest of the dragged set (nested-pruned).
    entry: DragEntry;
    entries: DragEntry[];
    startX: number;
    startY: number;
    moved: boolean;
    cancelled: boolean;
    // True while the pointer is beyond the sidebar over the editor area —
    // the drag belongs to the app's split drop zones, not the tree.
    out: boolean;
  } | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const dropDirRef = useRef<string | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const autoScrollRafRef = useRef<number | null>(null);
  const autoExpandRef = useRef<{ path: string; timer: number } | null>(null);
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  // A drop is valid when it actually moves something: at least one entry
  // isn't already in the destination, and the destination is never inside a
  // dragged folder (a folder can't move into itself or its own subtree).
  const canDrop = useCallback((entries: DragEntry[], toDir: string | null): boolean => {
    if (!toDir) return false;
    if (entries.every((en) => dirname(en.path) === toDir)) return false;
    return !entries.some(
      (en) =>
        en.kind === "dir" && (toDir === en.path || toDir.startsWith(en.path + "/")),
    );
  }, []);

  const setDropState = useCallback((dir: string | null) => {
    dropDirRef.current = dir;
    setDropDir(dir);
  }, []);

  const positionGhost = useCallback((x: number, y: number) => {
    const g = ghostRef.current;
    if (g) g.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
  }, []);

  // Hit-test the pointer against the tree: a folder row targets that folder, a
  // file row targets its parent, empty tree space targets the workspace root.
  const updateDropTarget = useCallback(
    (x: number, y: number) => {
      const drag = dragRef.current;
      if (!drag || !drag.moved || drag.cancelled) return;
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const row = el?.closest<HTMLElement>("[data-tree-path]") ?? null;
      let toDir: string | null = null;
      let hoveredDir: string | null = null;
      if (row) {
        const p = row.dataset.treePath!;
        if (row.dataset.treeKind === "dir") {
          toDir = p;
          hoveredDir = p;
        } else {
          toDir = row.dataset.treeParent ?? null;
        }
      } else if (el && bodyRef.current?.contains(el)) {
        toDir = root;
      }
      const valid = canDrop(drag.entries, toDir);
      setDropState(valid ? toDir : null);
      document.body.classList.toggle("tree-drag-invalid", !valid);

      // Hovering a collapsed folder springs it open after a beat (VS Code-
      // style), so a drag can descend into subtrees closed when it started.
      const pending = autoExpandRef.current;
      if (pending && pending.path !== hoveredDir) {
        window.clearTimeout(pending.timer);
        autoExpandRef.current = null;
      }
      if (hoveredDir && collapsedRef.current.has(hoveredDir) && !autoExpandRef.current) {
        const path = hoveredDir;
        autoExpandRef.current = {
          path,
          timer: window.setTimeout(() => {
            autoExpandRef.current = null;
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          }, AUTO_EXPAND_MS),
        };
      }
    },
    [root, canDrop, setDropState],
  );

  // Dragging near the tree's top/bottom edge scrolls it (rAF loop, so the
  // scroll keeps going while the pointer rests in the zone). The drop target is
  // re-hit-tested after each scroll step — the row under the pointer changed.
  const startAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current != null) return;
    const step = () => {
      autoScrollRafRef.current = requestAnimationFrame(step);
      const body = bodyRef.current;
      const pt = lastPointRef.current;
      if (!body || !pt) return;
      const r = body.getBoundingClientRect();
      if (pt.x < r.left || pt.x > r.right) return;
      let dy = 0;
      if (pt.y < r.top + AUTO_SCROLL_ZONE_PX) {
        dy = -Math.ceil((r.top + AUTO_SCROLL_ZONE_PX - pt.y) / 6);
      } else if (pt.y > r.bottom - AUTO_SCROLL_ZONE_PX) {
        dy = Math.ceil((pt.y - (r.bottom - AUTO_SCROLL_ZONE_PX)) / 6);
      }
      if (dy !== 0) {
        const before = body.scrollTop;
        body.scrollTop += dy;
        if (body.scrollTop !== before) updateDropTarget(pt.x, pt.y);
      }
    };
    autoScrollRafRef.current = requestAnimationFrame(step);
  }, [updateDropTarget]);

  const clearDragVisuals = useCallback(() => {
    setDragging(null);
    setDropState(null);
    document.body.classList.remove("tree-dragging", "tree-drag-invalid");
    if (autoScrollRafRef.current != null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    const pending = autoExpandRef.current;
    if (pending) {
      window.clearTimeout(pending.timer);
      autoExpandRef.current = null;
    }
  }, [setDropState]);

  const performDrop = useCallback(
    async (entries: DragEntry[], toDir: string) => {
      const moved: SidebarSelection[] = [];
      const errors: string[] = [];
      for (const entry of entries) {
        if (dirname(entry.path) === toDir) continue; // already lives here
        const to = `${toDir}/${basename(entry.path)}`;
        const err = await onMovePath(entry.path, to, entry.kind);
        if (err) errors.push(`"${basename(entry.path)}": ${err}`);
        else moved.push({ path: to, kind: entry.kind });
      }
      if (errors.length === 1) {
        window.alert(`Could not move ${errors[0]}`);
      } else if (errors.length > 1) {
        window.alert(`Could not move:\n${errors.join("\n")}`);
      }
      if (moved.length === 0) return;
      onSelect(moved);
      // Open the destination folder so the moved rows are visible where they landed.
      setCollapsed((prev) => {
        if (!prev.has(toDir)) return prev;
        const next = new Set(prev);
        next.delete(toDir);
        return next;
      });
    },
    [onMovePath, onSelect],
  );

  const onRowPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, entry: DragEntry) => {
      if (e.button !== 0) return; // right-click stays the context menu
      // Grabbing a row inside the multi-selection drags the whole selection
      // (VS Code); any other row drags alone. The grabbed row leads the set —
      // it's the ghost pill's face.
      const inSelection = selection.some((s) => s.path === entry.path);
      const entries =
        inSelection && selection.length > 1
          ? pruneNestedSelection([entry, ...selection.filter((s) => s.path !== entry.path)])
          : [entry];
      dragRef.current = {
        entry,
        entries,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        cancelled: false,
        out: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [selection],
  );

  const onRowPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.cancelled) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        drag.moved = true;
        setDragging(drag.entries);
        document.body.classList.add("tree-dragging");
        startAutoScroll();
      }
      lastPointRef.current = { x: e.clientX, y: e.clientY };
      positionGhost(e.clientX, e.clientY);
      // A single FILE dragged past the sidebar's right edge tears out toward
      // the editor area — the app's split drop zones take over; coming back
      // resumes the tree move. (Multi-drags stay tree moves: only one document
      // can open in a pane.)
      const aside = asideRef.current;
      const isOut =
        drag.entries.length === 1 &&
        drag.entries[0].kind === "file" &&
        // A file the app can't open has no pane to tear out into.
        drag.entry.openable !== false &&
        onDragFileToEditor != null &&
        aside != null &&
        e.clientX > aside.getBoundingClientRect().right;
      if (isOut !== drag.out) {
        drag.out = isOut;
        if (!isOut) onDragFileCancel?.();
        else {
          setDropState(null); // no tree target while out
          document.body.classList.remove("tree-drag-invalid");
        }
      }
      if (isOut) {
        onDragFileToEditor?.(drag.entry.path, e.clientX, e.clientY);
        return;
      }
      updateDropTarget(e.clientX, e.clientY);
    },
    [startAutoScroll, positionGhost, updateDropTarget, onDragFileToEditor, onDragFileCancel, setDropState],
  );

  const onRowPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    const toDir = dropDirRef.current;
    clearDragVisuals();
    // The click that trails a completed drag must not open/toggle the row.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (drag.out) {
      const pt = lastPointRef.current;
      if (!drag.cancelled && pt) onDropFileToEditor?.(drag.entry.path, pt.x, pt.y);
      else onDragFileCancel?.();
      return;
    }
    if (!drag.cancelled && canDrop(drag.entries, toDir)) {
      void performDrop(drag.entries, toDir!);
    }
  }, [clearDragVisuals, canDrop, performDrop, onDropFileToEditor, onDragFileCancel]);

  const onRowPointerCancel = useCallback(() => {
    const wasOut = dragRef.current?.out === true;
    dragRef.current = null;
    clearDragVisuals();
    if (wasOut) onDragFileCancel?.();
  }, [clearDragVisuals, onDragFileCancel]);

  const suppressRowClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return true;
    }
    return false;
  }, []);

  const dnd = useMemo<TreeDnd>(
    () => ({
      onPointerDown: onRowPointerDown,
      onPointerMove: onRowPointerMove,
      onPointerUp: onRowPointerUp,
      onPointerCancel: onRowPointerCancel,
      suppressClick: suppressRowClick,
    }),
    [onRowPointerDown, onRowPointerMove, onRowPointerUp, onRowPointerCancel, suppressRowClick],
  );

  // Esc abandons an in-flight drag; the pointerup that follows is inert.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const drag = dragRef.current;
      if (drag) drag.cancelled = true;
      if (drag?.out) onDragFileCancel?.();
      clearDragVisuals();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dragging, clearDragVisuals, onDragFileCancel]);

  // If the sidebar unmounts mid-drag (mode switch), don't leave the document
  // stuck with drag cursor classes.
  useEffect(
    () => () => {
      document.body.classList.remove("tree-dragging", "tree-drag-invalid");
      if (autoScrollRafRef.current != null) cancelAnimationFrame(autoScrollRafRef.current);
      if (autoExpandRef.current) window.clearTimeout(autoExpandRef.current.timer);
    },
    [],
  );

  /* ---------- Create & rename ---------- */

  // Begin inline creation inside `parentDir`, expanding it (and any collapsed
  // ancestors) so the input row is actually visible.
  const startCreate = useCallback(
    (kind: "file" | "dir" | "board", parentDir: string) => {
      setCtxMenu(null);
      setMenuOpen(false);
      setPendingRename(null); // one inline input at a time
      setCollapsed((prev) => {
        const next = new Set(prev);
        let p = parentDir;
        while (p.length >= root.length) {
          next.delete(p);
          if (p === root) break;
          p = dirname(p);
        }
        return next;
      });
      setPendingCreate({ parentDir, kind });
    },
    [root],
  );

  // Where "New File" / "New Folder" should land for a given target: inside a
  // folder, next to a file, at the root for empty-space actions.
  const createDirFor = useCallback(
    (target: { path: string; kind: "file" | "dir" | "root" } | null) => {
      if (!target || target.kind === "root") return root;
      return target.kind === "dir" ? target.path : dirname(target.path);
    },
    [root],
  );

  // Commit the pending inline creation. Returns an error message to show under
  // the input, or null on success (the row closes; new files open in a tab).
  const commitCreate = useCallback(
    async (rawName: string): Promise<string | null> => {
      const pc = pendingCreate;
      if (!pc) return null;
      const name = rawName.trim();
      if (!name) return "A name is required.";
      if (/[/\\:]/.test(name)) return "Names can't contain /, \\ or :";
      if (name.startsWith(".")) return "Names can't start with a dot.";
      // Bare names become markdown; an explicit .html (or md) extension is kept.
      const fileName = pc.kind === "file" && !DOC_EXT_RE.test(name) ? `${name}.md` : name;
      const path = `${pc.parentDir}/${fileName}`;
      try {
        await invoke(pc.kind === "file" ? "create_file" : "create_dir", { path });
      } catch (e) {
        return String(e);
      }
      // A board is a folder plus its definition file. If the definition can't
      // be written the folder stays — an empty folder, not a broken board.
      if (pc.kind === "board") {
        const err = await onMakeBoard(path);
        if (err) return err;
      }
      setPendingCreate(null);
      await refresh();
      onSelect([{ path, kind: pc.kind === "file" ? "file" : "dir" }]);
      if (pc.kind === "file") onOpenFile(path);
      if (pc.kind === "board") onOpenBoard(path);
      return null;
    },
    [pendingCreate, refresh, onSelect, onOpenFile, onOpenBoard, onMakeBoard],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const startRename = useCallback((target: PendingRename) => {
    setCtxMenu(null);
    setMenuOpen(false);
    setPendingCreate(null); // one inline input at a time
    setPendingRename(target);
  }, []);

  // Commit the inline rename. Same contract as commitCreate: an error message
  // keeps the input open with the message under it, null closes it. The tree
  // hides document extensions, so the input edits the stem and the original
  // extension is carried over unless a document extension was typed.
  const commitRename = useCallback(
    async (rawName: string): Promise<string | null> => {
      const pr = pendingRename;
      if (!pr) return null;
      const name = rawName.trim();
      if (!name) return "A name is required.";
      if (/[/\\:]/.test(name)) return "Names can't contain /, \\ or :";
      if (name.startsWith(".")) return "Names can't start with a dot.";
      const oldName = basename(pr.path);
      let newName = name;
      // Unsupported files show (and rename) their full name, extension
      // included — the document-extension rules would turn "photo.png" into
      // "photo.png.md".
      if (pr.openable !== false && pr.kind === "file" && !DOC_EXT_RE.test(name)) {
        newName = `${name}${oldName.match(DOC_EXT_RE)?.[0] ?? ".md"}`;
      }
      if (newName === oldName) {
        setPendingRename(null); // nothing changed
        return null;
      }
      const to = `${dirname(pr.path)}/${newName}`;
      const err = await onMovePath(pr.path, to, pr.kind);
      if (err) return err;
      setPendingRename(null);
      onSelect([{ path: to, kind: pr.kind }]);
      return null;
    },
    [pendingRename, onMovePath, onSelect],
  );

  const cancelRename = useCallback(() => setPendingRename(null), []);

  const openRowMenu = useCallback(
    (e: React.MouseEvent, target: { path: string; kind: "file" | "dir"; openable?: boolean }) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-click selects, like VS Code — but keeps a multi-selection when
      // the target is already part of it (the menu then acts on the whole set).
      if (!selection.some((s) => s.path === target.path)) {
        selectionAnchorRef.current = target.path;
        onSelect([target]);
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, target });
    },
    [selection, onSelect],
  );

  const rootName = useMemo(() => basename(root), [root]);
  const showCreateAtRoot = pendingCreate?.parentDir === root;

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const { target } = ctxMenu;
    // A right-click on a row that's part of a multi-selection acts on the
    // whole set, with only the operations that make sense for many rows at
    // once (per-document items like Rename need a single target).
    if (
      target.kind !== "root" &&
      selection.length > 1 &&
      selection.some((s) => s.path === target.path)
    ) {
      const entries = [...selection];
      return [
        { label: "Cut", onClick: () => onCopyEntries(entries, true) },
        { label: "Copy", onClick: () => onCopyEntries(entries, false) },
        { label: "Delete", danger: true, onClick: () => onDelete(entries) },
      ];
    }
    // Cards are created from the board itself, so a board offers no inline
    // New File / New Folder — its folder is the board's own storage.
    const insideBoard = storeDirs.has(createDirFor(target));
    const items: ContextMenuItem[] = [];
    if (!insideBoard) {
      items.push(
        { label: "New File…", onClick: () => startCreate("file", createDirFor(target)) },
        { label: "New Folder…", onClick: () => startCreate("dir", createDirFor(target)) },
        { label: "New Board…", onClick: () => startCreate("board", createDirFor(target)) },
      );
    }
    // An existing folder of notes becomes a board by gaining a definition
    // file; not one note's content is touched.
    if (target.kind === "dir" && !storeDirs.has(target.path)) {
      items.push({
        label: "Turn into Board",
        onClick: () => {
          void (async () => {
            const err = await onMakeBoard(target.path);
            if (err) window.alert(err);
            else {
              await refresh();
              onOpenBoard(target.path);
            }
          })();
        },
      });
    }
    if (target.kind === "dir" && storeDirs.has(target.path)) {
      items.push({ label: "Open Board", onClick: () => onOpenBoard(target.path) });
    }
    items.push({
      label: "Reveal in Finder",
      onClick: () => onRevealInFinder(target.kind === "root" ? root : target.path),
    });
    // Cut/Copy/Paste, VS Code's explorer trio. Paste lands inside a folder
    // target, next to a file target, at the root for empty space — and stays
    // visible-but-disabled while the clipboard is empty.
    if (target.kind !== "root") {
      const entry: SidebarSelection = { path: target.path, kind: target.kind };
      items.push(
        { label: "Cut", onClick: () => onCopyEntries([entry], true) },
        { label: "Copy", onClick: () => onCopyEntries([entry], false) },
      );
    }
    items.push({
      label: "Paste",
      disabled: !clipboardHasFiles,
      onClick: () =>
        onPasteEntries(
          target.kind === "dir"
            ? target.path
            : target.kind === "root"
              ? root
              : dirname(target.path),
        ),
    });
    if (target.kind !== "root") {
      items.push({
        label: "Rename…",
        onClick: () =>
          startRename({
            path: target.path,
            kind: target.kind as "file" | "dir",
            openable: target.openable,
          }),
      });
      items.push({
        label: "Delete",
        danger: true,
        onClick: () => onDelete([{ path: target.path, kind: target.kind as "file" | "dir" }]),
      });
    }
    return items;
  }, [
    ctxMenu,
    selection,
    clipboardHasFiles,
    storeDirs,
    refresh,
    onOpenBoard,
    onMakeBoard,
    startCreate,
    startRename,
    createDirFor,
    onRevealInFinder,
    onDelete,
    onCopyEntries,
    onPasteEntries,
    root,
  ]);

  // Right-edge drag handle: the app owns the width (grid CSS variable);
  // this just streams clamped pointer positions while the handle is held.
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !onResizeWidth) return;
      e.preventDefault();
      const aside = asideRef.current;
      if (!aside) return;
      const left = aside.getBoundingClientRect().left;
      const onMove = (ev: PointerEvent) => onResizeWidth(ev.clientX - left);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("sidebar-resizing");
      };
      document.body.classList.add("sidebar-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onResizeWidth],
  );

  return (
    <aside className="sidebar" aria-label="File browser" ref={asideRef}>
      {onResizeWidth && (
        <div
          className="sidebar-resize"
          title="Drag to resize"
          onPointerDown={onResizePointerDown}
        />
      )}
      <SidebarHeader
        name={rootName}
        cloud={cloud}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onOpenFolder={onOpenFolder}
        onOpenFile={onOpenFilePicker}
        onRevealInFinder={() => onRevealInFinder(root)}
        onRefresh={() => void refresh()}
        showAll={showAll}
        onToggleShowAll={toggleShowAll}
        onSwitchToSearch={onSwitchToSearch}
        onNewFile={() => startCreate("file", createDirFor(primarySelection))}
        onNewFolder={() => startCreate("dir", createDirFor(primarySelection))}
      />
      <div
        ref={bodyRef}
        className={`sidebar-body ${dropDir === root ? "is-drop-root" : ""}`}
        onClick={(e) => {
          // Clicking empty space clears the selection (root becomes the
          // creation context again).
          if (e.target === e.currentTarget) onSelect([]);
        }}
        onContextMenu={(e) => {
          // Right-click on empty space targets the workspace root. Row-level
          // handlers stopPropagation, so reaching here means no row was hit.
          e.preventDefault();
          onSelect([]);
          setCtxMenu({ x: e.clientX, y: e.clientY, target: { path: root, kind: "root" } });
        }}
      >
        {error && <div className="sidebar-message sidebar-message-error">{error}</div>}
        {!error && loading && !tree && (
          <div className="sidebar-message">Loading…</div>
        )}
        {!error && tree && tree.kind === "dir" && tree.children.length === 0 && !showCreateAtRoot && (
          <div className="sidebar-message">No files yet</div>
        )}
        {!error && tree && tree.kind === "dir" && (tree.children.length > 0 || showCreateAtRoot) && (
          <ul className="tree" role="tree">
            {showCreateAtRoot && pendingCreate && (
              <NameRow
                depth={0}
                icon={createRowIcon(pendingCreate.kind)}
                placeholder={createRowLabel(pendingCreate.kind)}
                ariaLabel={`New ${createRowLabel(pendingCreate.kind).toLowerCase()}`}
                onCommit={commitCreate}
                onCancel={cancelCreate}
              />
            )}
            {tree.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={0}
                parentDir={root}
                currentPath={currentPath}
                selection={selection}
                cutPaths={cutPaths}
                collapsed={collapsed}
                pendingCreate={pendingCreate}
                pendingRename={pendingRename}
                dragPaths={dragPaths}
                dropDir={dropDir === root ? null : dropDir}
                dnd={dnd}
                onToggle={toggleCollapsed}
                onOpenFile={onOpenFile}
                onOpenBoard={onOpenBoard}
                onRowClick={handleRowSelect}
                onRowMenu={openRowMenu}
                onCommitCreate={commitCreate}
                onCancelCreate={cancelCreate}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
              />
            ))}
          </ul>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {dragging && dragging.length > 0 && (
        <div
          ref={ghostRef}
          className={`tree-drag-ghost ${dropDir == null ? "is-invalid" : ""}`}
          style={{
            transform: lastPointRef.current
              ? `translate(${lastPointRef.current.x + 14}px, ${lastPointRef.current.y + 16}px)`
              : undefined,
          }}
          aria-hidden
        >
          {dragging[0].kind === "dir" ? <FolderIcon /> : <FileIcon />}
          <span className="tree-drag-ghost-label">
            {dragging.length > 1
              ? `${dragging.length} items`
              : dragging[0].kind === "file"
                ? stripDocExt(basename(dragging[0].path))
                : basename(dragging[0].path)}
          </span>
          {dropDir != null && (
            <span className="tree-drag-ghost-dest">→ {basename(dropDir)}</span>
          )}
        </div>
      )}
    </aside>
  );
}

function SidebarHeader({
  name,
  cloud,
  menuOpen,
  setMenuOpen,
  onOpenFolder,
  onOpenFile,
  onRevealInFinder,
  onRefresh,
  showAll,
  onToggleShowAll,
  onSwitchToSearch,
  onNewFile,
  onNewFolder,
}: {
  name: string;
  cloud: CloudStatus | null;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onRevealInFinder: () => void;
  onRefresh: () => void;
  // Whether the tree lists every file (non-documents greyed out) or documents
  // only, and the toggle for it.
  showAll: boolean;
  onToggleShowAll: () => void;
  onSwitchToSearch: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, setMenuOpen]);

  return (
    <div ref={wrapRef} className="sidebar-header">
      <button
        className="sidebar-header-button"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title="Workspace menu"
      >
        <span className="sidebar-header-name">{name}</span>
        {cloud && (
          <span
            className={`sidebar-cloud-dot phase-${cloud.phase}`}
            role="img"
            aria-label={describeCloud(cloud)}
            title={describeCloud(cloud)}
          />
        )}
        <ChevronDownIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onNewFile}
        title="New file"
        aria-label="New file"
      >
        <NewFileIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onNewFolder}
        title="New folder"
        aria-label="New folder"
      >
        <NewFolderIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onSwitchToSearch}
        title="Search in folder (⌘⇧F)"
        aria-label="Search in folder"
      >
        <SearchIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh file list"
      >
        <RefreshIcon />
      </button>
      {menuOpen && (
        <div className="sidebar-menu" role="menu">
          <button
            role="menuitem"
            className="sidebar-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onOpenFolder();
            }}
          >
            Open folder…
          </button>
          <button
            role="menuitem"
            className="sidebar-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onOpenFile();
            }}
          >
            Open file…
          </button>
          <button
            role="menuitem"
            className="sidebar-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onRevealInFinder();
            }}
          >
            Reveal in Finder
          </button>
          <button
            role="menuitemcheckbox"
            aria-checked={showAll}
            className="sidebar-menu-item sidebar-menu-item-check"
            onClick={() => {
              setMenuOpen(false);
              onToggleShowAll();
            }}
          >
            <span>Show all files</span>
            {showAll && <MenuCheckIcon />}
          </button>
        </div>
      )}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  parentDir,
  currentPath,
  selection,
  cutPaths,
  collapsed,
  pendingCreate,
  pendingRename,
  dragPaths,
  dropDir,
  dnd,
  onToggle,
  onOpenFile,
  onOpenBoard,
  onRowClick,
  onRowMenu,
  onCommitCreate,
  onCancelCreate,
  onCommitRename,
  onCancelRename,
}: {
  node: TreeNode;
  depth: number;
  parentDir: string;
  currentPath: string | null;
  selection: SidebarSelection[];
  // Roots of a pending Cut (dimmed until pasted or replaced).
  cutPaths: Set<string>;
  collapsed: Set<string>;
  pendingCreate: PendingCreate | null;
  pendingRename: PendingRename | null;
  // The dragged rows' paths (dimmed) and the highlighted destination folder.
  // dropDir is null when the target is the workspace root — the tree container
  // carries that highlight instead of any row.
  dragPaths: Set<string>;
  dropDir: string | null;
  dnd: TreeDnd;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenBoard: (path: string) => void;
  // Modifier-aware selection; true = a multi-select gesture the row must not
  // also act on (no open/toggle).
  onRowClick: (e: React.MouseEvent, entry: SidebarSelection) => boolean;
  onRowMenu: (
    e: React.MouseEvent,
    target: { path: string; kind: "file" | "dir"; openable?: boolean },
  ) => void;
  onCommitCreate: (name: string) => Promise<string | null>;
  onCancelCreate: () => void;
  onCommitRename: (name: string) => Promise<string | null>;
  onCancelRename: () => void;
}) {
  const isSelected = selection.some((s) => s.path === node.path);
  const isCut = cutPaths.has(node.path);
  const isDragSource = dragPaths.has(node.path);
  // Rows inside the destination folder get a soft wash, so the whole drop
  // container reads as one region (the folder row itself gets the strong ring).
  const inDropDir = dropDir != null && node.path.startsWith(dropDir + "/");
  const renamingHere = pendingRename?.path === node.path;

  if (node.kind === "file") {
    // A file the app can't open (only ever listed in "Show all files"): the
    // row exists so its presence is visible, greyed out and inert to clicks.
    // Everything filesystem-level — select, move, rename, delete — still works.
    const openable = isOpenable(node);
    if (renamingHere) {
      return (
        <NameRow
          depth={depth}
          icon={<FileIcon />}
          placeholder="File name"
          ariaLabel={`Rename ${node.name}`}
          initialValue={openable ? stripDocExt(node.name) : node.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      );
    }
    const active = node.path === currentPath;
    return (
      <li role="treeitem" aria-selected={active || isSelected}>
        <button
          className={`tree-row tree-file ${active ? "is-active" : ""} ${isSelected ? "is-selected" : ""} ${isCut ? "is-cut" : ""} ${isDragSource ? "is-drag-source" : ""} ${inDropDir ? "is-drop-within" : ""} ${openable ? "" : "is-unsupported"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tree-path={node.path}
          data-tree-kind="file"
          data-tree-parent={parentDir}
          onClick={(e) => {
            if (dnd.suppressClick()) return;
            if (onRowClick(e, { path: node.path, kind: "file" })) return;
            if (openable) onOpenFile(node.path);
          }}
          onPointerDown={(e) =>
            dnd.onPointerDown(e, { path: node.path, kind: "file", openable })
          }
          onPointerMove={dnd.onPointerMove}
          onPointerUp={dnd.onPointerUp}
          onPointerCancel={dnd.onPointerCancel}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "file", openable })}
          title={openable ? node.path : `${node.path} — Doklin can’t open this file type`}
        >
          {openable ? <DocTypeIcon node={node} /> : <FileIcon />}
          <span className="tree-label">{openable ? stripDocExt(node.name) : node.name}</span>
        </button>
      </li>
    );
  }

  const isBoard = node.store === true;
  // A board never expands: the backend hands it no children, and its cards are
  // reached from the board, from search, and from links.
  const isCollapsed = isBoard || collapsed.has(node.path);
  const creatingHere = pendingCreate?.parentDir === node.path;
  const isDropTarget = dropDir === node.path;
  // With no row of their own, a board's cards borrow the board's: the row
  // reads as active while a card inside it is the focused tab.
  const boardActive =
    isBoard &&
    currentPath != null &&
    (currentPath === node.path || currentPath.startsWith(node.path + "/"));
  return (
    <li role="treeitem" aria-expanded={!isCollapsed} aria-selected={isSelected}>
      {renamingHere ? (
        <NameRow
          depth={depth}
          icon={isBoard ? <BoardIcon /> : <FolderIcon />}
          placeholder={isBoard ? "Board name" : "Folder name"}
          ariaLabel={`Rename ${node.name}`}
          initialValue={node.name}
          asListItem={false}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          className={`tree-row tree-dir ${isBoard ? "tree-board" : ""} ${boardActive ? "is-active" : ""} ${isSelected ? "is-selected" : ""} ${isCut ? "is-cut" : ""} ${isDragSource ? "is-drag-source" : ""} ${isDropTarget ? "is-drop-target" : ""} ${inDropDir ? "is-drop-within" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tree-path={node.path}
          data-tree-kind="dir"
          data-tree-parent={parentDir}
          onClick={(e) => {
            if (dnd.suppressClick()) return;
            if (onRowClick(e, { path: node.path, kind: "dir" })) return;
            if (isBoard) onOpenBoard(node.path);
            else onToggle(node.path);
          }}
          onPointerDown={(e) => dnd.onPointerDown(e, { path: node.path, kind: "dir" })}
          onPointerMove={dnd.onPointerMove}
          onPointerUp={dnd.onPointerUp}
          onPointerCancel={dnd.onPointerCancel}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "dir" })}
          title={node.path}
        >
          {isBoard ? (
            <BoardIcon />
          ) : (
            <span className={`tree-chevron ${isCollapsed ? "is-collapsed" : ""}`}>
              <ChevronRightIcon />
            </span>
          )}
          <span className="tree-label tree-dir-label">{node.name}</span>
        </button>
      )}
      {!isCollapsed && (
        <ul role="group">
          {creatingHere && pendingCreate && (
            <NameRow
              depth={depth + 1}
              icon={createRowIcon(pendingCreate.kind)}
              placeholder={createRowLabel(pendingCreate.kind)}
              ariaLabel={`New ${createRowLabel(pendingCreate.kind).toLowerCase()}`}
              onCommit={onCommitCreate}
              onCancel={onCancelCreate}
            />
          )}
          {node.children.map((c) => (
            <TreeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              parentDir={node.path}
              currentPath={currentPath}
              selection={selection}
              cutPaths={cutPaths}
              collapsed={collapsed}
              pendingCreate={pendingCreate}
              pendingRename={pendingRename}
              dragPaths={dragPaths}
              dropDir={dropDir}
              dnd={dnd}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onOpenBoard={onOpenBoard}
              onRowClick={onRowClick}
              onRowMenu={onRowMenu}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// The inline name input for New File / New Folder / Rename, rendered in place
// in the tree (VS Code-style). Enter commits — a validation or backend error
// keeps the row open with the message under it; Esc cancels; clicking away
// commits a valid name and otherwise abandons the row. A pre-filled value
// (rename) starts fully selected so typing replaces it wholesale.
function NameRow({
  depth,
  icon,
  placeholder,
  ariaLabel,
  initialValue = "",
  asListItem = true,
  onCommit,
  onCancel,
}: {
  depth: number;
  icon: React.ReactNode;
  placeholder: string;
  ariaLabel: string;
  initialValue?: string;
  // false when the row replaces a folder row INSIDE that folder's <li> (its
  // children stay rendered below) — an <li> may only sit directly in a list.
  asListItem?: boolean;
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards double-submit: Enter triggers commit AND blurs focus-follow-ups.
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = useCallback(
    async (viaBlur: boolean) => {
      if (doneRef.current) return;
      if (!value.trim()) {
        if (viaBlur) {
          doneRef.current = true;
          onCancel();
        }
        return;
      }
      doneRef.current = true;
      const err = await onCommit(value);
      if (err) {
        doneRef.current = false;
        if (viaBlur) {
          onCancel(); // click-away abandons an invalid name instead of fighting focus
        } else {
          setError(err);
          inputRef.current?.focus();
        }
      }
    },
    [value, onCommit, onCancel],
  );

  const Wrapper = asListItem ? "li" : "div";
  return (
    <Wrapper role={asListItem ? "treeitem" : undefined} className="tree-create">
      <div className="tree-create-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {icon}
        <input
          ref={inputRef}
          className="tree-create-input"
          type="text"
          value={value}
          placeholder={placeholder}
          autoFocus
          spellCheck={false}
          aria-label={ariaLabel}
          aria-invalid={error != null}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              doneRef.current = true;
              onCancel();
            }
            e.stopPropagation(); // keep app-level shortcuts (⌘N, ⌘⌫…) out of the input
          }}
          onBlur={() => void submit(true)}
        />
      </div>
      {error && (
        <div className="tree-create-error" style={{ marginLeft: 8 + depth * 14 }} role="alert">
          {error}
        </div>
      )}
    </Wrapper>
  );
}

type ContextMenuItem = {
  label: string;
  danger?: boolean;
  // Visible but inert (greyed out) — e.g. Paste with an empty clipboard.
  disabled?: boolean;
  onClick: () => void;
};

// A fixed-position right-click menu. Reuses the sidebar dropdown's visual
// language; closes on outside click, Esc, or after running an item.
function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the menu on-screen when invoked near the bottom/right edges.
  const estHeight = items.length * 30 + 12;
  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - estHeight - 8);

  return (
    <div ref={menuRef} className="tree-context-menu" role="menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`sidebar-menu-item ${item.danger ? "is-danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function stripDocExt(name: string): string {
  return name.replace(DOC_EXT_RE, "");
}

/* ---------- Icons ---------- */

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

// The tick on a checked workspace-menu item ("Show all files").
function MenuCheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

// The row glyph for a file, chosen by document type. Shape-only — all three
// keep the same muted stroke as FolderIcon, so the type reads without any
// color. A standalone .html gets the code-page mark; a markdown row with a
// folded html rendition gets the stacked "pair" mark; plain markdown gets the
// text-page mark.
function DocTypeIcon({ node }: { node: Extract<TreeNode, { kind: "file" }> }) {
  if (HTML_EXT_RE.test(node.name)) return <HtmlDocIcon />;
  if (node.paired) return <BundledDocIcon />;
  return <MarkdownDocIcon />;
}

function MarkdownDocIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function HtmlDocIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <polyline points="10 12 8 15 10 18" />
      <polyline points="14 12 16 15 14 18" />
    </svg>
  );
}

function BundledDocIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6z" />
      <polyline points="15 2 15 6 19 6" />
      <path d="M4 7v12a2 2 0 0 0 2 2h9" />
    </svg>
  );
}

function NewFileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

const createRowLabel = (kind: "file" | "dir" | "board") =>
  kind === "dir" ? "Folder name" : kind === "board" ? "Board name" : "File name";

const createRowIcon = (kind: "file" | "dir" | "board") =>
  kind === "dir" ? <NewFolderIcon /> : kind === "board" ? <BoardIcon /> : <FileIcon />;

// A board: three columns, the shape of the thing the row opens.
function BoardIcon() {
  return (
    <svg
      className="tree-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <rect x="2" y="3" width="3.2" height="10" rx="1" />
      <rect x="6.4" y="3" width="3.2" height="7" rx="1" />
      <rect x="10.8" y="3" width="3.2" height="8.5" rx="1" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <line x1="12" y1="10" x2="12" y2="16" />
      <line x1="9" y1="13" x2="15" y2="13" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
