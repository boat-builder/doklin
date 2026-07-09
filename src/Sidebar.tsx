import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TreeNode =
  // `paired` marks a markdown row that also has an html rendition folded into
  // it (a same-stem .html sibling), so the tree can icon md-only, html-only,
  // and bundled md+html rows distinctly. Absent/false for standalone html.
  | { kind: "file"; name: string; path: string; paired?: boolean }
  | { kind: "dir"; name: string; path: string; children: TreeNode[] };

// The explorer's selection (VS Code-style): the row last clicked or
// right-clicked, file or folder. Owned by App — it doubles as the creation
// context for saving drafts (the save dialog defaults into the selected
// folder / next to the selected file).
export type SidebarSelection = { path: string; kind: "file" | "dir" };

// Where an in-progress "New File…" / "New Folder…" will land. The input row is
// rendered inline inside `parentDir`, like VS Code's explorer.
type PendingCreate = { parentDir: string; kind: "file" | "dir" };

// An in-progress inline rename: the row at `path` is replaced by a name input.
type PendingRename = { path: string; kind: "file" | "dir" };

// A context-menu invocation: where it was opened and what it targets. "root"
// is a right-click on empty sidebar space (creation lands at the workspace root).
type MenuState = { x: number; y: number; target: { path: string; kind: "file" | "dir" | "root" } };

// The row being dragged (pointer-based move, VS Code-style). HTML5 drag events
// are intercepted by Tauri's native drag-drop handling, so — like the tab bar's
// reorder — this is built on pointer capture instead.
type DragEntry = { path: string; kind: "file" | "dir" };

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
  currentPath: string | null;
  selection: SidebarSelection | null;
  refreshToken: number;
  onSelect: (sel: SidebarSelection | null) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onOpenFilePicker: () => void;
  onRevealInFinder: (path: string) => void;
  onDelete: (path: string, kind: "file" | "dir") => void;
  // Move/rename `from` to `to` on disk and repoint app state (tabs, watcher…).
  // Resolves to an error message to surface, or null on success.
  onMovePath: (from: string, to: string, kind: "file" | "dir") => Promise<string | null>;
  onSwitchToSearch: () => void;
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

export default function Sidebar({
  root,
  currentPath,
  selection,
  refreshToken,
  onSelect,
  onOpenFile,
  onOpenFolder,
  onOpenFilePicker,
  onRevealInFinder,
  onDelete,
  onMovePath,
  onSwitchToSearch,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const node = await invoke<TreeNode>("list_md_tree", { path: root });
      setTree(node);
    } catch (e) {
      setError(String(e));
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, [root]);

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

  /* ---------- Drag-to-move ---------- */

  // Render state: the dragged entry (dims its row, shows the ghost pill) and
  // the currently valid destination folder (highlights it; root = empty space).
  const [dragging, setDragging] = useState<DragEntry | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  // Pointer tracking lives in refs — pointermove is high-frequency, and the
  // capturing row's handlers must read fresh values without re-registering.
  const dragRef = useRef<{
    entry: DragEntry;
    startX: number;
    startY: number;
    moved: boolean;
    cancelled: boolean;
  } | null>(null);
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

  // A drop is valid when it actually moves something: not into the folder the
  // entry is already in, and never a folder into itself or its own subtree.
  const canDrop = useCallback((entry: DragEntry, toDir: string | null): boolean => {
    if (!toDir) return false;
    if (dirname(entry.path) === toDir) return false;
    if (entry.kind === "dir" && (toDir === entry.path || toDir.startsWith(entry.path + "/"))) {
      return false;
    }
    return true;
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
      const valid = canDrop(drag.entry, toDir);
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
    async (entry: DragEntry, toDir: string) => {
      const to = `${toDir}/${basename(entry.path)}`;
      const err = await onMovePath(entry.path, to, entry.kind);
      if (err) {
        window.alert(`Could not move "${basename(entry.path)}"\n${err}`);
        return;
      }
      onSelect({ path: to, kind: entry.kind });
      // Open the destination folder so the moved row is visible where it landed.
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
      dragRef.current = {
        entry,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        cancelled: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [],
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
        setDragging(drag.entry);
        document.body.classList.add("tree-dragging");
        startAutoScroll();
      }
      lastPointRef.current = { x: e.clientX, y: e.clientY };
      positionGhost(e.clientX, e.clientY);
      updateDropTarget(e.clientX, e.clientY);
    },
    [startAutoScroll, positionGhost, updateDropTarget],
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
    if (!drag.cancelled && canDrop(drag.entry, toDir)) {
      void performDrop(drag.entry, toDir!);
    }
  }, [clearDragVisuals, canDrop, performDrop]);

  const onRowPointerCancel = useCallback(() => {
    dragRef.current = null;
    clearDragVisuals();
  }, [clearDragVisuals]);

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
      clearDragVisuals();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dragging, clearDragVisuals]);

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
    (kind: "file" | "dir", parentDir: string) => {
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
      setPendingCreate(null);
      await refresh();
      onSelect({ path, kind: pc.kind });
      if (pc.kind === "file") onOpenFile(path);
      return null;
    },
    [pendingCreate, refresh, onSelect, onOpenFile],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const startRename = useCallback((target: { path: string; kind: "file" | "dir" }) => {
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
      if (pr.kind === "file" && !DOC_EXT_RE.test(name)) {
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
      onSelect({ path: to, kind: pr.kind });
      return null;
    },
    [pendingRename, onMovePath, onSelect],
  );

  const cancelRename = useCallback(() => setPendingRename(null), []);

  const openRowMenu = useCallback(
    (e: React.MouseEvent, target: { path: string; kind: "file" | "dir" }) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(target); // right-click selects, like VS Code
      setCtxMenu({ x: e.clientX, y: e.clientY, target });
    },
    [onSelect],
  );

  const rootName = useMemo(() => basename(root), [root]);
  const showCreateAtRoot = pendingCreate?.parentDir === root;

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const { target } = ctxMenu;
    const items: ContextMenuItem[] = [
      { label: "New File…", onClick: () => startCreate("file", createDirFor(target)) },
      { label: "New Folder…", onClick: () => startCreate("dir", createDirFor(target)) },
      {
        label: "Reveal in Finder",
        onClick: () => onRevealInFinder(target.kind === "root" ? root : target.path),
      },
    ];
    if (target.kind !== "root") {
      items.push({
        label: "Rename…",
        onClick: () => startRename({ path: target.path, kind: target.kind as "file" | "dir" }),
      });
      items.push({
        label: "Delete",
        danger: true,
        onClick: () => onDelete(target.path, target.kind as "file" | "dir"),
      });
    }
    return items;
  }, [ctxMenu, startCreate, startRename, createDirFor, onRevealInFinder, onDelete, root]);

  return (
    <aside className="sidebar" aria-label="File browser">
      <SidebarHeader
        name={rootName}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onOpenFolder={onOpenFolder}
        onOpenFile={onOpenFilePicker}
        onRevealInFinder={() => onRevealInFinder(root)}
        onRefresh={() => void refresh()}
        onSwitchToSearch={onSwitchToSearch}
        onNewFile={() => startCreate("file", createDirFor(selection))}
        onNewFolder={() => startCreate("dir", createDirFor(selection))}
      />
      <div
        ref={bodyRef}
        className={`sidebar-body ${dropDir === root ? "is-drop-root" : ""}`}
        onClick={(e) => {
          // Clicking empty space clears the selection (root becomes the
          // creation context again).
          if (e.target === e.currentTarget) onSelect(null);
        }}
        onContextMenu={(e) => {
          // Right-click on empty space targets the workspace root. Row-level
          // handlers stopPropagation, so reaching here means no row was hit.
          e.preventDefault();
          onSelect(null);
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
                icon={pendingCreate.kind === "dir" ? <NewFolderIcon /> : <FileIcon />}
                placeholder={pendingCreate.kind === "dir" ? "Folder name" : "File name"}
                ariaLabel={pendingCreate.kind === "dir" ? "New folder name" : "New file name"}
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
                collapsed={collapsed}
                pendingCreate={pendingCreate}
                pendingRename={pendingRename}
                dragPath={dragging?.path ?? null}
                dropDir={dropDir === root ? null : dropDir}
                dnd={dnd}
                onToggle={toggleCollapsed}
                onOpenFile={onOpenFile}
                onSelect={onSelect}
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
      {dragging && (
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
          {dragging.kind === "dir" ? <FolderIcon /> : <FileIcon />}
          <span className="tree-drag-ghost-label">
            {dragging.kind === "file"
              ? stripDocExt(basename(dragging.path))
              : basename(dragging.path)}
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
  menuOpen,
  setMenuOpen,
  onOpenFolder,
  onOpenFile,
  onRevealInFinder,
  onRefresh,
  onSwitchToSearch,
  onNewFile,
  onNewFolder,
}: {
  name: string;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onRevealInFinder: () => void;
  onRefresh: () => void;
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
  collapsed,
  pendingCreate,
  pendingRename,
  dragPath,
  dropDir,
  dnd,
  onToggle,
  onOpenFile,
  onSelect,
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
  selection: SidebarSelection | null;
  collapsed: Set<string>;
  pendingCreate: PendingCreate | null;
  pendingRename: PendingRename | null;
  // The dragged row's path (dimmed) and the highlighted destination folder.
  // dropDir is null when the target is the workspace root — the tree container
  // carries that highlight instead of any row.
  dragPath: string | null;
  dropDir: string | null;
  dnd: TreeDnd;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelect: (sel: SidebarSelection) => void;
  onRowMenu: (e: React.MouseEvent, target: { path: string; kind: "file" | "dir" }) => void;
  onCommitCreate: (name: string) => Promise<string | null>;
  onCancelCreate: () => void;
  onCommitRename: (name: string) => Promise<string | null>;
  onCancelRename: () => void;
}) {
  const isSelected = selection?.path === node.path;
  const isDragSource = dragPath === node.path;
  // Rows inside the destination folder get a soft wash, so the whole drop
  // container reads as one region (the folder row itself gets the strong ring).
  const inDropDir = dropDir != null && node.path.startsWith(dropDir + "/");
  const renamingHere = pendingRename?.path === node.path;

  if (node.kind === "file") {
    if (renamingHere) {
      return (
        <NameRow
          depth={depth}
          icon={<FileIcon />}
          placeholder="File name"
          ariaLabel={`Rename ${node.name}`}
          initialValue={stripDocExt(node.name)}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      );
    }
    const active = node.path === currentPath;
    return (
      <li role="treeitem" aria-selected={active || isSelected}>
        <button
          className={`tree-row tree-file ${active ? "is-active" : ""} ${isSelected ? "is-selected" : ""} ${isDragSource ? "is-drag-source" : ""} ${inDropDir ? "is-drop-within" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tree-path={node.path}
          data-tree-kind="file"
          data-tree-parent={parentDir}
          onClick={() => {
            if (dnd.suppressClick()) return;
            onSelect({ path: node.path, kind: "file" });
            onOpenFile(node.path);
          }}
          onPointerDown={(e) => dnd.onPointerDown(e, { path: node.path, kind: "file" })}
          onPointerMove={dnd.onPointerMove}
          onPointerUp={dnd.onPointerUp}
          onPointerCancel={dnd.onPointerCancel}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "file" })}
          title={node.path}
        >
          <DocTypeIcon node={node} />
          <span className="tree-label">{stripDocExt(node.name)}</span>
        </button>
      </li>
    );
  }

  const isCollapsed = collapsed.has(node.path);
  const creatingHere = pendingCreate?.parentDir === node.path;
  const isDropTarget = dropDir === node.path;
  return (
    <li role="treeitem" aria-expanded={!isCollapsed} aria-selected={isSelected}>
      {renamingHere ? (
        <NameRow
          depth={depth}
          icon={<FolderIcon />}
          placeholder="Folder name"
          ariaLabel={`Rename ${node.name}`}
          initialValue={node.name}
          asListItem={false}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          className={`tree-row tree-dir ${isSelected ? "is-selected" : ""} ${isDragSource ? "is-drag-source" : ""} ${isDropTarget ? "is-drop-target" : ""} ${inDropDir ? "is-drop-within" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tree-path={node.path}
          data-tree-kind="dir"
          data-tree-parent={parentDir}
          onClick={() => {
            if (dnd.suppressClick()) return;
            onSelect({ path: node.path, kind: "dir" });
            onToggle(node.path);
          }}
          onPointerDown={(e) => dnd.onPointerDown(e, { path: node.path, kind: "dir" })}
          onPointerMove={dnd.onPointerMove}
          onPointerUp={dnd.onPointerUp}
          onPointerCancel={dnd.onPointerCancel}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "dir" })}
          title={node.path}
        >
          <span className={`tree-chevron ${isCollapsed ? "is-collapsed" : ""}`}>
            <ChevronRightIcon />
          </span>
          <span className="tree-label tree-dir-label">{node.name}</span>
        </button>
      )}
      {!isCollapsed && (
        <ul role="group">
          {creatingHere && pendingCreate && (
            <NameRow
              depth={depth + 1}
              icon={pendingCreate.kind === "dir" ? <NewFolderIcon /> : <FileIcon />}
              placeholder={pendingCreate.kind === "dir" ? "Folder name" : "File name"}
              ariaLabel={pendingCreate.kind === "dir" ? "New folder name" : "New file name"}
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
              collapsed={collapsed}
              pendingCreate={pendingCreate}
              pendingRename={pendingRename}
              dragPath={dragPath}
              dropDir={dropDir}
              dnd={dnd}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onSelect={onSelect}
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

type ContextMenuItem = { label: string; danger?: boolean; onClick: () => void };

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
