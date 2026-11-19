import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDismiss } from "./dismiss";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { Facepile } from "./Avatar";
import {
  LIBRARY_DIR,
  pageUrl,
  placeOf,
  publishedByPath,
  toLibraryLayout,
  type CloudSpace,
  type CloudStatus,
  type PublicPage,
} from "./cloud";
import { backend, type FileClipboardPayload, type TreeNode } from "./backend";
import { keys } from "./keys";

// A file row the app can open (markdown, html, or a bundled pair). Folders and
// documents-only trees are always openable; only "show every file" rows differ.
const isOpenable = (node: TreeNode) => node.kind !== "file" || node.supported !== false;

// One selected explorer row (VS Code-style), file or folder. The selection is
// a list — ⌘-click toggles rows in and out, ⇧-click extends over the visible
// range — whose LAST entry is the primary one (the row acted on most
// recently). Owned by App — the primary entry doubles as the creation context
// for saving an untitled note (it defaults into the selected folder / next to
// the selected file).
export type SidebarSelection = { path: string; kind: "file" | "dir" };

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
type PendingCreate = { parentDir: string; kind: "file" | "dir" };

// An in-progress inline rename: the row at `path` is replaced by a name input.
// `openable: false` (an unsupported file in show-all mode) keeps the row's own
// extension out of the document-extension rules — its name is edited whole.
type PendingRename = { path: string; kind: "file" | "dir"; openable?: boolean };

// A context-menu invocation: where it was opened and what it targets. "root"
// is a right-click on empty sidebar space (creation lands in the first list's
// folder); "section" is a connected workspace's heading or the empty space
// under it, whose folder `path` names. `space` marks a restricted folder's
// own row.
type MenuTarget = {
  path: string;
  kind: "file" | "dir" | "root" | "section";
  openable?: boolean;
  space?: CloudSpace;
  section?: SectionId;
};
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
  // A folder to bring into view — asked for from outside the app
  // (`doklin open <folder>`); a new `seq` asks again.
  reveal?: { path: string; seq: number } | null;
  // The shared file clipboard (null/empty = nothing to paste).
  clipboard: FileClipboardPayload | null;
  refreshToken: number;
  onSelect: (sels: SidebarSelection[]) => void;
  onOpenFile: (path: string) => void;
  // This computer's own files and folders: absent where the platform has no
  // way to them, and then their rows are not shown.
  onOpenFolder?: () => void;
  onOpenFilePicker?: () => void;
  onRevealInFinder?: (path: string) => void;
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
  // Open the Cloud panel — "Cloud…" in the workspace menu. (The footer's
  // sync line is the other way in; App owns the footer.)
  onOpenCloud?: () => void;
  // Who is in the workspace, and its agents — the workspace menu's own
  // doors. Each is offered only when it is passed.
  onOpenPeople?: () => void;
  onOpenDevices?: () => void;
  onOpenAgents?: () => void;
  // Sections (a connected workspace whose status says `sections`): making a
  // restricted folder — empty, or out of a folder that is there (`from`) —
  // seeing and changing who is in one, and putting a private note in a new
  // folder with somebody.
  onNewRestricted?: (from?: string) => void;
  onManageAccess?: (space: CloudSpace) => void;
  onShareWith?: (path: string) => void;
  // Asked once before a drag moves anything: false leaves everything where
  // it is. Where a move would let more people see something, this is where
  // the user is told.
  onConfirmMove?: (entries: SidebarSelection[], toDir: string) => Promise<boolean>;
  // The workspaces this Mac belongs to — the
  // menu lists them, so switching is one click — and the two things the menu
  // does with them: open one, and join another with an invite.
  workspaces?: SidebarWorkspace[];
  onOpenWorkspace?: (root: string) => void;
  onJoinWorkspace?: () => void;
  // Version history for a document — the rail, for any workspace, cloud or
  // not.
  onHistory?: (path: string) => void;
  // The first list's whole timeline (Library's, in a connected workspace),
  // a modal — or, with a folder, that section's: each has a history of its
  // own.
  onWorkspaceHistory?: (dir?: string) => void;
  // Files the first list's history holds and its folder does not (Library's
  // in a connected workspace): its menu offers them when there are any. The
  // footer bar's count (App.tsx) is the main way in; this is the second.
  // With a folder, that section's.
  deletedCount?: number;
  onRecentlyDeleted?: (dir?: string) => void;
  // Publishing: the folder dialog for a folder (Library's own, for the whole
  // shared section), stopping a page, and copying a page's public link.
  // Offered only in a connected workspace.
  onPublishFolder?: (dir: string) => void;
  onStopPublishing?: (page: PublicPage) => void;
  onCopyLink?: (url: string) => void;
  // *Copy link*: a link that opens a file in Doklin, for anybody who can see
  // it — published or not. Offered only in a connected workspace.
  onCopyPageLink?: (path: string) => void;
};

/** A workspace this Mac belongs to, as the menu lists it: where its copy is
 *  on this Mac, and what it is called. */
export type SidebarWorkspace = { root: string; name: string; domain: string };

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

// The three lists of a connected workspace, one per section. A folder that is
// not connected is one list, `library`'s.
type SectionId = "library" | "restricted" | "private";
const SECTION_IDS: readonly string[] = ["library", "restricted", "private"] satisfies SectionId[];

// Why a row syncs nowhere, on its "not synced" mark.
const STRAY_LINE = "In no section, so it stays on this Mac — move it into Library or Private";
const UNFOLDERED_LINE = "In no restricted folder, so it stays on this Mac — move it into one";

// How the tree was left, per workspace — a view preference kept on this Mac:
// the folders open in it, and the sections folded away. A folder is closed
// until it is opened, so a big workspace starts folded and a folder that
// turns up later (synced, made in Finder) arrives closed; a section shows
// until it is folded. Folders are stored as paths inside the workspace, the
// record keyed by the workspace's.
const TREE_VIEW_STORAGE_KEY = "doklin:sidebar-tree";
type StoredTreeView = { open: string[]; folded: SectionId[] };
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : [];
const readAllTreeViews = (): Record<string, StoredTreeView> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TREE_VIEW_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, StoredTreeView> = {};
    for (const [root, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object") continue;
      const { open, folded } = v as { open?: unknown; folded?: unknown };
      out[root] = {
        open: strings(open),
        folded: strings(folded).filter((s): s is SectionId => SECTION_IDS.includes(s)),
      };
    }
    return out;
  } catch {
    return {};
  }
};
const writeAllTreeViews = (all: Record<string, StoredTreeView>) => {
  try {
    localStorage.setItem(TREE_VIEW_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — the tree still opens and folds for this session */
  }
};
const readTreeView = (root: string) => {
  const v = readAllTreeViews()[root];
  return {
    open: new Set((v?.open ?? []).map((rel) => `${root}/${rel}`)),
    folded: new Set<SectionId>(v?.folded ?? []),
  };
};
const writeTreeView = (root: string, open: Set<string>, folded: Set<SectionId>) => {
  const all = readAllTreeViews();
  const prefix = `${root}/`;
  const rels = [...open].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  if (rels.length === 0 && folded.size === 0) delete all[root];
  else all[root] = { open: rels, folded: [...folded] };
  writeAllTreeViews(all);
};
// Drop how a workspace's tree was left: the workspace is gone from this Mac.
export const forgetTreeView = (root: string) => {
  const all = readAllTreeViews();
  delete all[root];
  writeAllTreeViews(all);
};
// One-time stored-data migration (the Library layout, App.tsx): how a
// connected workspace's tree was left before its folder moved — each open
// folder where the move put it, and the shared list's fold under the id it
// has now. Read raw, as the id it had is no longer one `readAllTreeViews`
// keeps.
export const moveTreeViewIntoLibrary = (root: string) => {
  try {
    const all = JSON.parse(localStorage.getItem(TREE_VIEW_STORAGE_KEY) || "{}") as Record<string, unknown>;
    const v = all[root] as { open?: unknown; folded?: unknown } | undefined;
    if (!v || typeof v !== "object") return;
    all[root] = {
      open: strings(v.open).map(toLibraryLayout),
      folded: strings(v.folded).map((id) => (id === "workspace" ? "library" : id)),
    };
    localStorage.setItem(TREE_VIEW_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* nothing kept, or nothing to keep it in */
  }
};

// The folders from just under `root` down to `dir`, `dir` included: what has
// to be open for a row inside `dir` to show.
const foldersDownTo = (root: string, dir: string) => {
  const out: string[] = [];
  for (let p = dir; p.startsWith(`${root}/`); ) {
    out.push(p);
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return out;
};

// The open set with the folder at `from` (and the open folders inside it) now
// at `to`: a folder renamed or moved from the tree stays as open as it was.
const movedOpen = (open: Set<string>, from: string, to: string) => {
  const next = new Set<string>();
  for (const p of open) {
    if (p === from) next.add(to);
    else if (p.startsWith(`${from}/`)) next.add(to + p.slice(from.length));
    else next.add(p);
  }
  return next;
};

export default function Sidebar({
  root,
  cloud = null,
  currentPath,
  selection,
  reveal = null,
  clipboard,
  refreshToken,
  onSelect,
  onOpenFile,
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
  onOpenCloud,
  onOpenPeople,
  onOpenDevices,
  onOpenAgents,
  onNewRestricted,
  onManageAccess,
  onShareWith,
  onConfirmMove,
  workspaces,
  onOpenWorkspace,
  onJoinWorkspace,
  onHistory,
  onWorkspaceHistory,
  deletedCount = 0,
  onRecentlyDeleted,
  onPublishFolder,
  onStopPublishing,
  onCopyLink,
  onCopyPageLink,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The open folders and folded sections, for the workspace they were read
  // for: another root in this window reads its own.
  const [initialView] = useState(() => readTreeView(root));
  const [openDirs, setOpenDirs] = useState<Set<string>>(initialView.open);
  const [folded, setFolded] = useState<Set<SectionId>>(initialView.folded);
  const [viewRoot, setViewRoot] = useState(root);
  if (viewRoot !== root) {
    const view = readTreeView(root);
    setViewRoot(root);
    setOpenDirs(view.open);
    setFolded(view.folded);
  }
  useEffect(() => writeTreeView(viewRoot, openDirs, folded), [viewRoot, openDirs, folded]);
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
      const node = await backend.documents.tree(root, showAll);
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

  const openFolders = useCallback((dirs: string[]) => {
    setOpenDirs((prev) => (dirs.every((d) => prev.has(d)) ? prev : new Set([...prev, ...dirs])));
  }, []);

  const toggleOpen = useCallback((path: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /* ---------- Sections ---------- */

  // A connected workspace draws three lists instead of one: Library, what
  // everyone has; the restricted folders this person is in; and their
  // Private. On disk they are the folders `Library`, `Restricted` and
  // `Private` at the top, found however the disk spells them; here they are
  // headings, and those folders have no row of their own. Anything else at
  // the top is in no section — only Finder or an agent puts it there — and is
  // listed after them, while there is any. A folder that is not connected is
  // one list, of everything in it: its `libraryDir` is the folder itself.
  const sectioned = cloud != null;
  const layout = useMemo(() => {
    if (!tree || tree.kind !== "dir") return null;
    if (!sectioned) {
      return {
        shared: tree.children,
        restricted: [],
        private: [],
        strays: [],
        libraryDir: root,
        restrictedDir: `${root}/Restricted`,
        privateDir: `${root}/Private`,
      };
    }
    const top = (name: string) =>
      tree.children.find(
        (c): c is Extract<TreeNode, { kind: "dir" }> => c.kind === "dir" && c.name.toLowerCase() === name,
      ) ?? null;
    const library = top(LIBRARY_DIR.toLowerCase());
    const restricted = top("restricted");
    const mine = top("private");
    return {
      shared: library?.children ?? [],
      restricted: restricted?.children ?? [],
      private: mine?.children ?? [],
      strays: tree.children.filter((c) => c !== library && c !== restricted && c !== mine && !c.name.startsWith(".")),
      libraryDir: library?.path ?? `${root}/${LIBRARY_DIR}`,
      restrictedDir: restricted?.path ?? `${root}/Restricted`,
      privateDir: mine?.path ?? `${root}/Private`,
    };
  }, [tree, sectioned, root]);
  const libraryDir = layout?.libraryDir ?? (sectioned ? `${root}/${LIBRARY_DIR}` : root);
  const restrictedDir = layout?.restrictedDir ?? `${root}/Restricted`;
  const privateDir = layout?.privateDir ?? `${root}/Private`;
  // The restricted folders, by where each is on this Mac.
  const spacesByAbs = useMemo(() => {
    const out = new Map<string, CloudSpace>();
    for (const sp of cloud?.spaces ?? []) if (sp.kind === "restricted") out.set(`${root}/${sp.path}`, sp);
    return out;
  }, [cloud, root]);
  const hasPrivate = (cloud?.spaces ?? []).some((sp) => sp.kind === "private");

  // Which list a path is in; null for one in no section, whose list does not
  // fold. A folder that is not connected is one list.
  const sectionOf = useCallback(
    (path: string): SectionId | null => {
      const within = (dir: string) => path === dir || path.startsWith(`${dir}/`);
      if (!sectioned || within(libraryDir)) return "library";
      if (within(privateDir)) return "private";
      if (within(restrictedDir)) return "restricted";
      return null;
    },
    [sectioned, libraryDir, privateDir, restrictedDir],
  );
  const toggleSection = useCallback((id: SectionId) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Unfold the list `path` is in, so a row about to show there does.
  const unfoldSectionOf = useCallback(
    (path: string) => {
      const id = sectionOf(path);
      setFolded((prev) => (id && prev.has(id) ? new Set([...prev].filter((s) => s !== id)) : prev));
    },
    [sectionOf],
  );

  // Bring the folder an open from outside asked for into view: unfold its
  // list, open the folders above it (and it), then scroll to its row once the
  // tree has drawn it. A folder the tree never shows (a hidden one) simply
  // never scrolls.
  const revealedRef = useRef(0);
  useEffect(() => {
    if (!reveal || revealedRef.current === reveal.seq || !tree) return;
    const target = reveal.path;
    // A section's own folder has no row to open.
    const shut = foldersDownTo(root, target).filter(
      (dir) => !openDirs.has(dir) && !(sectioned && [libraryDir, restrictedDir, privateDir].includes(dir)),
    );
    const list = sectionOf(target);
    if (shut.length > 0 || (list && folded.has(list))) {
      openFolders(shut);
      unfoldSectionOf(target);
      return; // this runs again once they are open
    }
    const row = document.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(target)}"]`);
    if (!row) return;
    revealedRef.current = reveal.seq;
    row.scrollIntoView({ block: "nearest" });
  }, [
    reveal,
    tree,
    openDirs,
    folded,
    root,
    sectioned,
    libraryDir,
    restrictedDir,
    privateDir,
    openFolders,
    sectionOf,
    unfoldSectionOf,
  ]);

  /* ---------- Selection (single, ⌘-toggle, ⇧-range) ---------- */

  // The rows in on-screen order, inside open folders and unfolded lists only
  // — the universe a ⇧-click range spans.
  const visibleEntries = useMemo(() => {
    const out: SidebarSelection[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const c of nodes) {
        out.push({ path: c.path, kind: c.kind });
        if (c.kind === "dir" && openDirs.has(c.path)) walk(c.children);
      }
    };
    if (layout) {
      if (!folded.has("library")) walk(layout.shared);
      if (!folded.has("restricted")) walk(layout.restricted);
      if (!folded.has("private")) walk(layout.private);
      walk(layout.strays);
    }
    return out;
  }, [layout, openDirs, folded]);

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
  const openDirsRef = useRef(openDirs);
  useEffect(() => {
    openDirsRef.current = openDirs;
  }, [openDirs]);

  // A drop is valid when it actually moves something: at least one entry
  // isn't already in the destination, and the destination is never inside a
  // dragged folder (a folder can't move into itself or its own subtree).
  const canDrop = useCallback(
    (entries: DragEntry[], toDir: string | null): boolean => {
      if (!toDir) return false;
      // A connected workspace's top holds its sections: nothing is dropped
      // there to be in none.
      if (sectioned && toDir === root) return false;
      if (entries.every((en) => dirname(en.path) === toDir)) return false;
      // Straight under Restricted is where the restricted folders are: a
      // folder dropped there becomes one — where one can be made at all —
      // and a note there would be in none.
      if (sectioned && toDir === restrictedDir && (!onNewRestricted || entries.some((en) => en.kind === "file"))) {
        return false;
      }
      return !entries.some(
        (en) =>
          en.kind === "dir" && (toDir === en.path || toDir.startsWith(en.path + "/")),
      );
    },
    [sectioned, root, restrictedDir, onNewRestricted],
  );

  const setDropState = useCallback((dir: string | null) => {
    dropDirRef.current = dir;
    setDropDir(dir);
  }, []);

  const positionGhost = useCallback((x: number, y: number) => {
    const g = ghostRef.current;
    if (g) g.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
  }, []);

  // Hit-test the pointer against the tree: a folder row targets that folder, a
  // file row targets its parent, empty tree space targets the first list's
  // folder (Library, in a connected workspace).
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
        // Empty space under a heading is that section's own folder.
        toDir = el.closest<HTMLElement>("[data-section-dir]")?.dataset.sectionDir ?? libraryDir;
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
      if (hoveredDir && !openDirsRef.current.has(hoveredDir) && !autoExpandRef.current) {
        const path = hoveredDir;
        autoExpandRef.current = {
          path,
          timer: window.setTimeout(() => {
            autoExpandRef.current = null;
            openFolders([path]);
          }, AUTO_EXPAND_MS),
        };
      }
    },
    [libraryDir, canDrop, setDropState, openFolders],
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
      const leaving = entries.filter((en) => dirname(en.path) !== toDir);
      if (onConfirmMove && !(await onConfirmMove(leaving, toDir))) return;
      const moved: SidebarSelection[] = [];
      const movedDirs: [from: string, to: string][] = [];
      const errors: string[] = [];
      for (const entry of entries) {
        if (dirname(entry.path) === toDir) continue; // already lives here
        const to = `${toDir}/${basename(entry.path)}`;
        const err = await onMovePath(entry.path, to, entry.kind);
        if (err) errors.push(`"${basename(entry.path)}": ${err}`);
        else {
          moved.push({ path: to, kind: entry.kind });
          if (entry.kind === "dir") movedDirs.push([entry.path, to]);
        }
      }
      if (errors.length === 1) {
        window.alert(`Could not move ${errors[0]}`);
      } else if (errors.length > 1) {
        window.alert(`Could not move:\n${errors.join("\n")}`);
      }
      if (moved.length === 0) return;
      onSelect(moved);
      // Moved folders stay as open as they were, and the destination opens
      // (its list unfolds) so the moved rows are visible where they landed.
      // A list's own folder has no row to open.
      const listDir = toDir === libraryDir || toDir === restrictedDir || toDir === privateDir;
      setOpenDirs((prev) => {
        let next = prev;
        for (const [from, to] of movedDirs) next = movedOpen(next, from, to);
        return listDir || next.has(toDir) ? next : new Set([...next, toDir]);
      });
      unfoldSectionOf(toDir);
    },
    [onMovePath, onSelect, onConfirmMove, libraryDir, restrictedDir, privateDir, unfoldSectionOf],
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
        // A file the app can't open has no document to split beside another.
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

  // Begin inline creation inside `parentDir`, opening it (and the folders
  // above it, and its list) so the input row is actually visible.
  const startCreate = useCallback(
    (kind: "file" | "dir", wantedDir: string) => {
      // Nothing is made straight under Restricted from here: a note there
      // would be in no folder, and a folder there is made with its people.
      const parentDir = sectioned && wantedDir === restrictedDir ? libraryDir : wantedDir;
      setCtxMenu(null);
      setMenuOpen(false);
      setPendingRename(null); // one inline input at a time
      openFolders(
        foldersDownTo(root, parentDir).filter((d) => d !== libraryDir && d !== restrictedDir && d !== privateDir),
      );
      unfoldSectionOf(parentDir);
      setPendingCreate({ parentDir, kind });
    },
    [root, sectioned, libraryDir, restrictedDir, privateDir, openFolders, unfoldSectionOf],
  );

  // Where "New File" / "New Folder" (and Paste) land for a given target:
  // inside a folder, next to a file, in the first list's folder for
  // empty-space actions — and in Library for anything that would land at a
  // connected workspace's top, where it would be in no section.
  const createDirFor = useCallback(
    (target: { path: string; kind: "file" | "dir" | "root" | "section" } | null) => {
      const dir =
        !target || target.kind === "root" ? libraryDir : target.kind === "file" ? dirname(target.path) : target.path;
      return dir === root ? libraryDir : dir;
    },
    [root, libraryDir],
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
        await backend.documents.create(path, pc.kind);
      } catch (e) {
        return String(e);
      }
      setPendingCreate(null);
      await refresh();
      onSelect([{ path, kind: pc.kind }]);
      if (pc.kind === "file") onOpenFile(path);
      return null;
    },
    [pendingCreate, refresh, onSelect, onOpenFile],
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
      if (pr.kind === "dir") setOpenDirs((prev) => movedOpen(prev, pr.path, to));
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
        onSelect([{ path: target.path, kind: target.kind }]);
      }
      const space = target.kind === "dir" ? spacesByAbs.get(target.path) : undefined;
      setCtxMenu({ x: e.clientX, y: e.clientY, target: { ...target, space } });
    },
    [selection, onSelect, spacesByAbs],
  );

  const rootName = useMemo(() => basename(root), [root]);

  // Who else is editing what, by absolute path — the faces on a file's row.
  const presenceByPath = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const p of cloud?.presence ?? []) {
      if (!p.path) continue;
      const abs = `${root}/${p.path}`;
      out.set(abs, [...(out.get(abs) ?? []), p.name]);
    }
    return out;
  }, [cloud, root]);
  // Rows with a page of their own, by absolute path (Library's folder when
  // the whole shared section is a folder page).
  const publishedByAbs = useMemo(() => {
    const out = new Map<string, PublicPage>();
    for (const [rel, page] of publishedByPath(cloud)) out.set(`${root}/${rel}`, page);
    return out;
  }, [cloud, root]);
  const showCreateInLibrary = pendingCreate?.parentDir === libraryDir;
  const libraryFolded = sectioned && folded.has("library");
  const showCreateInPrivate = sectioned && pendingCreate?.parentDir === privateDir;

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const { target } = ctxMenu;
    const isRow = target.kind === "file" || target.kind === "dir";
    // A right-click on a row that's part of a multi-selection acts on the
    // whole set, with only the operations that make sense for many rows at
    // once (per-document items like Rename need a single target).
    if (isRow && selection.length > 1 && selection.some((s) => s.path === target.path)) {
      // A restricted folder is not cut or trashed like the rows beside it:
      // it is left, or deleted for everyone, from its own dialog.
      const movable = selection.filter((s) => !spacesByAbs.has(s.path));
      return [
        { label: "Cut", disabled: movable.length === 0, onClick: () => onCopyEntries(movable, true) },
        { label: "Copy", onClick: () => onCopyEntries([...selection], false) },
        { label: "Delete", danger: true, disabled: movable.length === 0, onClick: () => onDelete(movable) },
      ];
    }
    // Empty space under Restricted: the one thing made there is a folder
    // with people in it.
    if (target.kind === "section" && target.section === "restricted") {
      return onNewRestricted ? [{ label: "New restricted folder…", onClick: () => onNewRestricted() }] : [];
    }
    // A row straight under Restricted offers no New File / New Folder: see
    // `startCreate`.
    const underRestricted = sectioned && createDirFor(target) === restrictedDir;
    const items: ContextMenuItem[] = [];
    if (!underRestricted) {
      items.push(
        { label: "New File…", onClick: () => startCreate("file", createDirFor(target)) },
        { label: "New Folder…", onClick: () => startCreate("dir", createDirFor(target)) },
      );
    }
    if (onRevealInFinder) {
      items.push({
        label: "Reveal in Finder",
        onClick: () => onRevealInFinder(target.kind === "root" ? root : target.path),
      });
    }
    // A file in one of the workspace's sections has a link of its own: it
    // opens in Doklin for whoever can see it, wherever it is clicked. One in
    // no section has none.
    if (
      target.kind === "file" &&
      target.openable !== false &&
      cloud &&
      onCopyPageLink &&
      target.path.startsWith(`${root}/`) &&
      placeOf(cloud, target.path.slice(root.length + 1)).kind !== "nowhere"
    ) {
      items.push({ label: "Copy link", onClick: () => onCopyPageLink(target.path) });
    }
    // Every document has a history, connected or not.
    if (target.kind === "file" && target.openable !== false && onHistory) {
      items.push({ label: "Version history…", onClick: () => onHistory(target.path) });
    }
    // Who can open it: a restricted folder's people; a folder everyone has,
    // or a private one, made into one; a private note put in a new folder
    // with somebody.
    if (sectioned && isRow && target.path.startsWith(`${root}/`)) {
      const place = placeOf(cloud, target.path.slice(root.length + 1));
      if (target.space && onManageAccess) {
        const space = target.space;
        items.push({ label: "Manage access…", onClick: () => onManageAccess(space) });
      } else if (target.kind === "dir" && onNewRestricted && (place.kind === "shared" || place.kind === "private")) {
        items.push({ label: "Restrict access…", onClick: () => onNewRestricted(target.path) });
      } else if (target.kind === "file" && onShareWith && place.kind === "private" && target.openable !== false) {
        items.push({ label: "Share with…", onClick: () => onShareWith(target.path) });
      }
    }
    // The first list's whole history — where "put it back to Tuesday" is
    // asked from: on Library's heading in a connected workspace, on the
    // empty space of a folder that is not. Each other section has a history
    // of its own, asked for on it.
    const libraryTarget = sectioned
      ? target.kind === "section" && target.section === "library"
      : target.kind === "root";
    const ownHistory = target.space != null || (target.kind === "section" && target.section === "private");
    if (libraryTarget && onWorkspaceHistory) {
      items.push({ label: sectioned ? "Library history…" : "Folder history…", onClick: () => onWorkspaceHistory() });
    }
    if (ownHistory && onWorkspaceHistory) {
      items.push({
        label: target.space ? "Folder history…" : "Private history…",
        onClick: () => onWorkspaceHistory(target.path),
      });
    }
    if (libraryTarget && onRecentlyDeleted && deletedCount > 0) {
      items.push({ label: `Recently deleted (${deletedCount})`, onClick: () => onRecentlyDeleted() });
    }
    if (ownHistory && onRecentlyDeleted) {
      items.push({ label: "Recently deleted…", onClick: () => onRecentlyDeleted(target.path) });
    }
    // Publishing: a folder (Library's own, for the whole shared section)
    // publishes every note in it; a note published on its own offers its
    // link and its stop here — publishing one is the pill's job. The
    // workspace's top is in no section, and publishes nothing.
    if (cloud && target.kind !== "root") {
      const targetPath = target.path;
      const page = publishedByAbs.get(targetPath) ?? null;
      if (target.kind !== "file") {
        const folderPage = page?.kind === "dir" ? page : null;
        if (onPublishFolder) {
          items.push({
            label: folderPage ? "Edit publishing…" : libraryTarget ? "Publish Library…" : "Publish folder…",
            onClick: () => onPublishFolder(targetPath),
          });
        }
        if (folderPage && onCopyLink) {
          items.push({ label: "Copy public link", onClick: () => onCopyLink(pageUrl(cloud, folderPage)) });
        }
        if (folderPage && onStopPublishing) {
          items.push({ label: "Stop publishing", danger: true, onClick: () => onStopPublishing(folderPage) });
        }
      } else if (page?.kind === "file") {
        if (onCopyLink) items.push({ label: "Copy public link", onClick: () => onCopyLink(pageUrl(cloud, page)) });
        if (onStopPublishing) {
          items.push({ label: "Stop publishing", danger: true, onClick: () => onStopPublishing(page) });
        }
      }
    }
    // Cut/Copy/Paste, VS Code's explorer trio. Paste lands where New File
    // would (`createDirFor`) — and stays visible-but-disabled while the
    // clipboard is empty. A restricted folder is copied, never cut: it leaves
    // by its own dialog.
    if (target.kind === "file" || target.kind === "dir") {
      const entry: SidebarSelection = { path: target.path, kind: target.kind };
      if (!target.space) items.push({ label: "Cut", onClick: () => onCopyEntries([entry], true) });
      items.push({ label: "Copy", onClick: () => onCopyEntries([entry], false) });
    }
    items.push({
      label: "Paste",
      disabled: !clipboardHasFiles,
      onClick: () => onPasteEntries(createDirFor(target)),
    });
    if (target.kind === "file" || target.kind === "dir") {
      const kind = target.kind;
      items.push({
        label: "Rename…",
        onClick: () => startRename({ path: target.path, kind, openable: target.openable }),
      });
      if (!target.space) {
        items.push({
          label: "Delete",
          danger: true,
          onClick: () => onDelete([{ path: target.path, kind }]),
        });
      }
    }
    return items;
  }, [
    ctxMenu,
    selection,
    clipboardHasFiles,
    spacesByAbs,
    sectioned,
    restrictedDir,
    startCreate,
    startRename,
    createDirFor,
    onRevealInFinder,
    onDelete,
    onCopyEntries,
    onPasteEntries,
    root,
    cloud,
    onHistory,
    onWorkspaceHistory,
    onRecentlyDeleted,
    deletedCount,
    publishedByAbs,
    onPublishFolder,
    onStopPublishing,
    onCopyLink,
    onCopyPageLink,
    onNewRestricted,
    onManageAccess,
    onShareWith,
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

  // The inline name input at the top of a section's list.
  const createRow = pendingCreate && (
    <NameRow
      depth={0}
      icon={createRowIcon(pendingCreate.kind)}
      placeholder={createRowLabel(pendingCreate.kind)}
      ariaLabel={`New ${createRowLabel(pendingCreate.kind).toLowerCase()}`}
      onCommit={commitCreate}
      onCancel={cancelCreate}
    />
  );
  // A top-level row of one of the lists. `loose` is why the row is in no
  // section and so syncs nowhere — a note straight under Restricted, anything
  // at the workspace's top — or null when it is in one.
  const sectionDirs = [libraryDir, restrictedDir, privateDir];
  const renderItem = (child: TreeNode, parentDir: string, loose: string | null) => (
    <TreeItem
      key={child.path}
      node={child}
      depth={0}
      parentDir={parentDir}
      currentPath={currentPath}
      selection={selection}
      cutPaths={cutPaths}
      openDirs={openDirs}
      pendingCreate={pendingCreate}
      pendingRename={pendingRename}
      dragPaths={dragPaths}
      dropDir={dropDir != null && sectionDirs.includes(dropDir) ? null : dropDir}
      dnd={dnd}
      presence={presenceByPath}
      published={publishedByAbs}
      spaces={spacesByAbs}
      loose={loose}
      synced={sectioned}
      onToggle={toggleOpen}
      onOpenFile={onOpenFile}
      onRowClick={handleRowSelect}
      onRowMenu={openRowMenu}
      onCommitCreate={commitCreate}
      onCancelCreate={cancelCreate}
      onCommitRename={commitRename}
      onCancelRename={cancelRename}
    />
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
        // A workspace goes by its own name; a plain folder by the folder's.
        name={workspaces?.find((w) => w.root === root)?.name ?? rootName}
        root={root}
        workspaces={workspaces ?? []}
        onOpenWorkspace={onOpenWorkspace}
        onJoinWorkspace={onJoinWorkspace}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onOpenFolder={onOpenFolder}
        onOpenFile={onOpenFilePicker}
        onRevealInFinder={onRevealInFinder ? () => onRevealInFinder(root) : undefined}
        showAll={showAll}
        onToggleShowAll={toggleShowAll}
        onSwitchToSearch={onSwitchToSearch}
        onNewFile={() => startCreate("file", createDirFor(primarySelection))}
        onOpenCloud={onOpenCloud}
        onOpenPeople={onOpenPeople}
        onOpenDevices={onOpenDevices}
        onOpenAgents={onOpenAgents}
      />
      <div
        ref={bodyRef}
        className={`sidebar-body ${!sectioned && dropDir === root ? "is-drop-root" : ""}`}
        onClick={(e) => {
          // Clicking empty space clears the selection (the first list's
          // folder becomes the creation context again).
          if (e.target === e.currentTarget) onSelect([]);
        }}
        onContextMenu={(e) => {
          // Right-click on empty space targets the workspace's folder: what
          // it makes lands in the first list's (`createDirFor`). Row-level
          // handlers stopPropagation, so reaching here means no row was hit.
          e.preventDefault();
          onSelect([]);
          setCtxMenu({ x: e.clientX, y: e.clientY, target: { path: root, kind: "root" } });
        }}
      >
        <div
          className={`tree-section ${sectioned && dropDir === libraryDir ? "is-drop-section" : ""}`}
          data-section-dir={libraryDir}
          data-testid={sectioned ? "section-library" : "section-files"}
          onContextMenu={
            sectioned
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect([]);
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    target: { path: libraryDir, kind: "section", section: "library" },
                  });
                }
              : undefined
          }
        >
          {/* A folder tree is one list, and its heading only names it; in
              sections, each heading folds its list away. */}
          <SectionHead
            icon={sectioned ? <LibraryIcon /> : null}
            label={sectioned ? "Library" : "Files"}
            folded={libraryFolded}
            count={layout?.shared.length ?? 0}
            onToggle={sectioned ? () => toggleSection("library") : undefined}
            testid={sectioned ? "library" : "files"}
          >
            <button
              className="sidebar-section-btn"
              onClick={() => startCreate("dir", createDirFor(primarySelection))}
              title="New folder"
              aria-label="New folder"
            >
              <NewFolderIcon />
            </button>
            <button
              className="sidebar-section-btn"
              onClick={() => void refresh()}
              title="Refresh"
              aria-label="Refresh file list"
            >
              <RefreshIcon />
            </button>
          </SectionHead>
          {error && <div className="sidebar-message sidebar-message-error">{error}</div>}
          {!error && loading && !tree && <div className="sidebar-message">Loading…</div>}
          {!error && layout && !libraryFolded && (
            <>
              {layout.shared.length === 0 && !showCreateInLibrary && <div className="sidebar-message">No files yet</div>}
              {(layout.shared.length > 0 || showCreateInLibrary) && (
                <ul className="tree" role="tree">
                  {showCreateInLibrary && pendingCreate && createRow}
                  {layout.shared.map((child) => renderItem(child, libraryDir, null))}
                </ul>
              )}
            </>
          )}
        </div>
        {!error && layout && sectioned && (
          <>
            <div
              className={`tree-section ${dropDir === restrictedDir ? "is-drop-section" : ""}`}
              data-section-dir={restrictedDir}
              data-testid="section-restricted"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect([]);
                if (!onNewRestricted) return;
                setCtxMenu({
                  x: e.clientX,
                  y: e.clientY,
                  target: { path: restrictedDir, kind: "section", section: "restricted" },
                });
              }}
            >
              <SectionHead
                icon={<RestrictedIcon />}
                label="Restricted"
                folded={folded.has("restricted")}
                count={layout.restricted.length}
                onToggle={() => toggleSection("restricted")}
                testid="restricted"
              >
                {onNewRestricted && (
                  <button
                    className="sidebar-section-btn"
                    data-testid="new-restricted"
                    onClick={() => onNewRestricted()}
                    title="New restricted folder"
                    aria-label="New restricted folder"
                  >
                    <PlusIcon />
                  </button>
                )}
              </SectionHead>
              {!folded.has("restricted") &&
                (layout.restricted.length === 0 ? (
                  <div className="sidebar-message tree-section-hint">Folders only the people you choose can open.</div>
                ) : (
                  <ul className="tree" role="tree">
                    {/* Straight under Restricted a note is in no folder, so nobody else has it. */}
                    {layout.restricted.map((child) =>
                      renderItem(child, restrictedDir, child.kind === "file" ? UNFOLDERED_LINE : null),
                    )}
                  </ul>
                ))}
            </div>
            <div
              className={`tree-section ${hasPrivate && dropDir === privateDir ? "is-drop-section" : ""}`}
              data-section-dir={hasPrivate ? privateDir : ""}
              data-testid="section-private"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect([]);
                if (!hasPrivate) return;
                setCtxMenu({
                  x: e.clientX,
                  y: e.clientY,
                  target: { path: privateDir, kind: "section", section: "private" },
                });
              }}
            >
              <SectionHead
                icon={<PrivateIcon />}
                label="Private"
                folded={folded.has("private")}
                count={layout.private.length}
                onToggle={() => toggleSection("private")}
                testid="private"
              >
                {hasPrivate && (
                  <button
                    className="sidebar-section-btn"
                    data-testid="new-private"
                    onClick={() => startCreate("file", privateDir)}
                    title="New private note"
                    aria-label="New private note"
                  >
                    <PlusIcon />
                  </button>
                )}
              </SectionHead>
              {!folded.has("private") && (
                <>
                  {hasPrivate && layout.private.length === 0 && !showCreateInPrivate && (
                    <div className="sidebar-message tree-section-hint">Only you can see what you put here.</div>
                  )}
                  {(layout.private.length > 0 || showCreateInPrivate) && (
                    <ul className="tree" role="tree">
                      {showCreateInPrivate && createRow}
                      {layout.private.map((child) =>
                        renderItem(child, privateDir, !hasPrivate && child.kind === "file" ? UNFOLDERED_LINE : null),
                      )}
                    </ul>
                  )}
                </>
              )}
            </div>
            {/* What Finder or an agent put at the workspace's top: in no
                section, so it stays on this Mac. Nothing is dropped here. */}
            {layout.strays.length > 0 && (
              <div className="tree-section" data-section-dir="" data-testid="section-strays">
                <SectionHead icon={<NowhereIcon />} label="In no section" folded={false} count={0} testid="strays" />
                <ul className="tree" role="tree">
                  {layout.strays.map((child) => renderItem(child, root, STRAY_LINE))}
                </ul>
              </div>
            )}
          </>
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
  root,
  workspaces,
  onOpenWorkspace,
  onJoinWorkspace,
  menuOpen,
  setMenuOpen,
  onOpenFolder,
  onOpenFile,
  onRevealInFinder,
  showAll,
  onToggleShowAll,
  onSwitchToSearch,
  onNewFile,
  onOpenCloud,
  onOpenPeople,
  onOpenDevices,
  onOpenAgents,
}: {
  name: string;
  /** The folder this window has open — which of `workspaces` is this one. */
  root: string;
  workspaces: SidebarWorkspace[];
  onOpenWorkspace?: (root: string) => void;
  onJoinWorkspace?: () => void;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onOpenFolder?: () => void;
  onOpenFile?: () => void;
  onRevealInFinder?: () => void;
  // Whether the tree lists every file (non-documents greyed out) or documents
  // only, and the toggle for it.
  showAll: boolean;
  onToggleShowAll: () => void;
  onSwitchToSearch: () => void;
  onNewFile: () => void;
  onOpenCloud?: () => void;
  onOpenPeople?: () => void;
  onOpenDevices?: () => void;
  onOpenAgents?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(() => setMenuOpen(false), wrapRef, menuOpen);

  return (
    <div className="sidebar-head">
      {/* The workspace switcher: the folder's initial on a tile, its name,
          and the menu of what else this window can open. */}
      <div ref={wrapRef} className="sidebar-header">
        <button
          className="sidebar-header-button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="Workspace menu"
        >
          <span className="ws-tile" aria-hidden>
            {workspaceInitial(name)}
          </span>
          <span className="sidebar-header-name">{name}</span>
          <ChevronDownIcon />
        </button>
        {menuOpen && (
          <div className="sidebar-menu" role="menu">
            {/* The workspaces this Mac belongs to, the open one ticked: what
                makes this a switcher rather than a folder's menu. */}
            {workspaces.length > 0 && (
              <>
                <div className="sidebar-menu-label">Workspaces</div>
                {workspaces.map((w) => (
                  <button
                    key={w.root}
                    role="menuitemradio"
                    aria-checked={w.root === root}
                    className="sidebar-menu-item sidebar-menu-item-check"
                    data-testid="sidebar-menu-workspace"
                    title={`${w.domain} — ${w.root}`}
                    onClick={() => {
                      setMenuOpen(false);
                      if (w.root !== root) onOpenWorkspace?.(w.root);
                    }}
                  >
                    <span className="sidebar-menu-ws">
                      <span className="ws-tile ws-tile--menu" aria-hidden>
                        {workspaceInitial(w.name)}
                      </span>
                      <span className="sidebar-menu-ws-name">{w.name}</span>
                    </span>
                    {w.root === root && <MenuCheckIcon />}
                  </button>
                ))}
              </>
            )}
            {onJoinWorkspace && (
              <button
                role="menuitem"
                className="sidebar-menu-item"
                data-testid="sidebar-menu-join"
                onClick={() => {
                  setMenuOpen(false);
                  onJoinWorkspace();
                }}
              >
                Join a workspace…
              </button>
            )}
            {(workspaces.length > 0 || onJoinWorkspace) && <div className="sidebar-menu-sep" role="separator" />}
            {/* Who is in this workspace, their devices, and its agents: the
                workspace's own, so they are here rather than behind the sync
                panel. */}
            {onOpenPeople && (
              <button
                role="menuitem"
                className="sidebar-menu-item"
                data-testid="sidebar-menu-people"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenPeople();
                }}
              >
                People…
              </button>
            )}
            {onOpenDevices && (
              <button
                role="menuitem"
                className="sidebar-menu-item"
                data-testid="sidebar-menu-devices"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenDevices();
                }}
              >
                Devices…
              </button>
            )}
            {onOpenAgents && (
              <button
                role="menuitem"
                className="sidebar-menu-item"
                data-testid="sidebar-menu-agents"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenAgents();
                }}
              >
                Agents…
              </button>
            )}
            {(onOpenPeople || onOpenAgents) && <div className="sidebar-menu-sep" role="separator" />}
            {onOpenFolder && (
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
            )}
            {onOpenFile && (
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
            )}
            {onRevealInFinder && (
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
            )}
            <button
              role="menuitem"
              className="sidebar-menu-item"
              data-testid="sidebar-menu-cloud"
              onClick={() => {
                setMenuOpen(false);
                onOpenCloud?.();
              }}
            >
              Cloud…
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
      <div className="sidebar-tools">
        <button
          className="sidebar-search"
          onClick={onSwitchToSearch}
          title={`Search in folder (${keys("⌘⇧F")})`}
          aria-label="Search in folder"
        >
          <SearchIcon />
          <span className="sidebar-search-label">Search</span>
          <kbd>{keys("⌘⇧F")}</kbd>
        </button>
        <button
          className="sidebar-new"
          onClick={onNewFile}
          title="New file"
          aria-label="New file"
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  );
}

// A list's heading: its icon and name — which fold the list away, where it
// can be folded — how many rows it holds while folded, and the list's own
// actions. It pins to the top of the tree while the list's rows scroll under
// it, so the list in view is always named.
function SectionHead({
  icon,
  label,
  folded,
  count,
  onToggle,
  testid,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  folded: boolean;
  // The rows at the top of the list, shown while it is folded.
  count: number;
  onToggle?: () => void;
  testid: string;
  children?: React.ReactNode;
}) {
  const name = (
    <>
      {icon}
      <span className="sidebar-section-label">{label}</span>
    </>
  );
  return (
    <div className="sidebar-section tree-section-head">
      {onToggle ? (
        <button
          className={`tree-section-toggle ${folded ? "is-folded" : ""}`}
          onClick={onToggle}
          aria-expanded={!folded}
          title={folded ? `Show ${label}` : `Hide ${label}`}
          data-testid={`section-${testid}-toggle`}
        >
          {name}
          <span className="tree-section-chevron">
            <ChevronRightIcon />
          </span>
          {folded && count > 0 && (
            <span className="tree-section-count" data-testid={`section-${testid}-count`}>
              {count}
            </span>
          )}
        </button>
      ) : (
        <span className="tree-section-toggle">{name}</span>
      )}
      <span className="sidebar-section-actions">{children}</span>
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
  openDirs,
  pendingCreate,
  pendingRename,
  dragPaths,
  dropDir,
  dnd,
  presence,
  published,
  spaces,
  loose = null,
  synced,
  onToggle,
  onOpenFile,
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
  // The folders showing their contents.
  openDirs: Set<string>;
  pendingCreate: PendingCreate | null;
  pendingRename: PendingRename | null;
  // The dragged rows' paths (dimmed) and the highlighted destination folder.
  // dropDir is null when the target is a list's own folder — its section (or,
  // for a folder that is not connected, the tree container) carries that
  // highlight instead of any row.
  dragPaths: Set<string>;
  dropDir: string | null;
  dnd: TreeDnd;
  // Names of the people editing a file right now, by absolute path.
  presence: Map<string, string[]>;
  // Rows with a public page of their own, by absolute path.
  published: Map<string, PublicPage>;
  // The restricted folders, by absolute path: such a row says how many
  // people are in it, and is not dragged away.
  spaces: Map<string, CloudSpace>;
  // Why the row at this level is in no section, so syncs nowhere; null when
  // it is in one.
  loose?: string | null;
  // The workspace is connected: what it holds besides markdown and html stays
  // on this Mac, and its row says so.
  synced: boolean;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
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
    // row exists so its presence is visible, greyed out. A click opens it
    // like any file — its tab says it isn't a document — and everything
    // filesystem-level (select, move, rename, delete) works as usual.
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
    const editors = presence.get(node.path);
    const page = published.get(node.path);
    return (
      <li role="treeitem" aria-selected={active || isSelected}>
        <button
          className={`tree-row tree-file ${active ? "is-active" : ""} ${isSelected ? "is-selected" : ""} ${isCut ? "is-cut" : ""} ${isDragSource ? "is-drag-source" : ""} ${inDropDir ? "is-drop-within" : ""} ${openable ? "" : "is-unsupported"} ${loose ? "is-nowhere" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tree-path={node.path}
          data-tree-kind="file"
          data-tree-parent={parentDir}
          onClick={(e) => {
            if (dnd.suppressClick()) return;
            if (onRowClick(e, { path: node.path, kind: "file" })) return;
            onOpenFile(node.path);
          }}
          onPointerDown={(e) =>
            dnd.onPointerDown(e, { path: node.path, kind: "file", openable })
          }
          onPointerMove={dnd.onPointerMove}
          onPointerUp={dnd.onPointerUp}
          onPointerCancel={dnd.onPointerCancel}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "file", openable })}
          title={
            openable
              ? node.path
              : synced
                ? "Stays on this Mac — Doklin syncs markdown and html"
                : `${node.path} — Doklin can’t open this file type`
          }
        >
          {openable ? <DocTypeIcon node={node} /> : <FileIcon />}
          <span className="tree-label">{openable ? stripDocExt(node.name) : node.name}</span>
          {loose && <NowhereMark line={loose} />}
          {page?.kind === "file" && (
            <span className="tree-published" title={`Published at /${page.slug}`} data-testid="tree-published" />
          )}
          {editors && (
            <Facepile
              names={editors}
              size={16}
              max={2}
              title={`${[...new Set(editors)].join(", ")} — editing now`}
              testid="tree-presence"
            />
          )}
        </button>
      </li>
    );
  }

  const space = spaces.get(node.path) ?? null;
  const isOpen = openDirs.has(node.path);
  const creatingHere = pendingCreate?.parentDir === node.path;
  const isDropTarget = dropDir === node.path;
  return (
    <li role="treeitem" aria-expanded={isOpen} aria-selected={isSelected}>
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
          className={`tree-row tree-dir ${isSelected ? "is-selected" : ""} ${isCut ? "is-cut" : ""} ${isDragSource ? "is-drag-source" : ""} ${isDropTarget ? "is-drop-target" : ""} ${inDropDir ? "is-drop-within" : ""} ${loose ? "is-nowhere" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tree-path={node.path}
          data-tree-kind="dir"
          data-tree-parent={parentDir}
          onClick={(e) => {
            if (dnd.suppressClick()) return;
            if (onRowClick(e, { path: node.path, kind: "dir" })) return;
            onToggle(node.path);
          }}
          // A restricted folder stays where it is: it is left, or deleted
          // for everyone, never dragged into another section.
          onPointerDown={space ? undefined : (e) => dnd.onPointerDown(e, { path: node.path, kind: "dir" })}
          onPointerMove={dnd.onPointerMove}
          onPointerUp={dnd.onPointerUp}
          onPointerCancel={dnd.onPointerCancel}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "dir" })}
          title={node.path}
        >
          <span className={`tree-chevron ${isOpen ? "" : "is-collapsed"}`}>
            <ChevronRightIcon />
          </span>
          <span className="tree-label tree-dir-label">{node.name}</span>
          {loose && <NowhereMark line={loose} />}
          {space && space.members.length > 0 && (
            <span
              className="tree-space-count"
              data-testid="space-count"
              title={`${space.members.length} ${space.members.length === 1 ? "person" : "people"} can open this folder`}
            >
              · {space.members.length}
            </span>
          )}
          {published.get(node.path)?.kind === "dir" && (
            <span
              className="tree-published"
              title={`Published folder at /${published.get(node.path)!.slug}`}
              data-testid="tree-published"
            />
          )}
        </button>
      )}
      {isOpen && (
        // --depth places the folder's indent guide under its chevron.
        <ul role="group" style={{ "--depth": depth } as React.CSSProperties}>
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
              openDirs={openDirs}
              pendingCreate={pendingCreate}
              pendingRename={pendingRename}
              dragPaths={dragPaths}
              dropDir={dropDir}
              dnd={dnd}
              presence={presence}
              published={published}
              spaces={spaces}
              synced={synced}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
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

// A row's "not synced" mark, with why on hover.
function NowhereMark({ line }: { line: string }) {
  return (
    <span className="tree-nowhere" data-testid="tree-nowhere" title={line}>
      not synced
    </span>
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

function stripDocExt(name: string): string {
  return name.replace(DOC_EXT_RE, "");
}

/* ---------- Icons ---------- */

// The workspace tile's letter: the folder name's first letter or digit,
// skipping a leading dot or underscore.
function workspaceInitial(name: string): string {
  const m = name.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : "·";
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

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
      width="15"
      height="15"
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
      width="15"
      height="15"
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
      width="15"
      height="15"
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
      width="15"
      height="15"
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

const createRowLabel = (kind: "file" | "dir") => (kind === "dir" ? "Folder name" : "File name");

const createRowIcon = (kind: "file" | "dir") => (kind === "dir" ? <NewFolderIcon /> : <FileIcon />);

function FolderIcon() {
  return (
    <svg
      width="15"
      height="15"
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

// The lists' icons: Library (books on a shelf), the people you choose, you,
// and what is in no section.
function LibraryIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 4v16" />
      <path d="M8 7v13" />
      <path d="M12 5v15" />
      <path d="m16 6 4 14" />
    </svg>
  );
}

function RestrictedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <circle cx="12" cy="9.5" r="2.5" />
      <path d="M8 16.5a4 4 0 0 1 8 0" />
    </svg>
  );
}

function PrivateIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function NowhereIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 0 1 2.5 8.24" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg
      width="14"
      height="14"
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
      width="14"
      height="14"
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
      width="13"
      height="13"
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
