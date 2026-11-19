import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addsQuestion,
  cloudForWorkspace,
  cloudNeedsAttention,
  leaseFor,
  livePathsOf,
  mayOn,
  placeOf,
  relPathIn,
  widerAudience,
  type CloudPendingAddsEvent,
  type CloudPendingDeletesEvent,
  type CloudRemovedEvent,
  type CloudSpace,
  type CloudSpaceLeftEvent,
  type CloudStatus,
  type PublicPage,
} from "./cloud";
import CloudPanel from "./CloudPanel";
import type { AccessTab } from "./CloudPeople";
import PeopleDialog from "./PeopleDialog";
import RestrictedFolder, { type RestrictedSource } from "./RestrictedFolder";
import SpaceAccess from "./SpaceAccess";
import { LeaseBanner } from "./LeaseBanner";
import type {
  DeletedFile,
  FileVersion,
  RestoreOutcome,
  RestoreReport,
  VersionsStatus,
} from "./versions";
import CloudSetup, { type CloudSetupMode } from "./CloudSetup";
import Toasts, { type Toast, type ToastAction, type ToastTone } from "./Toasts";
import LiveChip from "./LiveChip";
import SyncStatus from "./SyncStatus";
import { Facepile } from "./Avatar";
import PublishFolder from "./PublishFolder";
import PublishedPages from "./PublishedPages";
import WorkerUpdate from "./WorkerUpdate";
import HistoryRail from "./HistoryRail";
import VersionPreview, { momentLabel } from "./VersionPreview";
import WorkspaceHistory from "./WorkspaceHistory";
import VersionsSettings from "./VersionsSettings";
import RecentlyDeleted from "./RecentlyDeleted";
import { dragWindowFromGap } from "./windowDrag";
import { keys } from "./keys";
import Editor, { type EditorHandle } from "./Editor";
import type { SearchInfo } from "./searchPlugin";
import Sidebar, {
  forgetTreeView,
  pruneNestedSelection,
  type SidebarSelection,
} from "./Sidebar";
import TabBar from "./TabBar";
import {
  isUnsaved,
  isUnsupportedTab,
  isUntitled,
  noteHasText,
  noteTitle,
  tabLabel,
  toStoredTab,
  type StoredTab,
  type Tab,
  type TabKind,
  type UntitledTab,
} from "./tabs";
import FindBar from "./FindBar";
import WorkspaceSearch from "./WorkspaceSearch";
import MermaidModal from "./MermaidModal";
import {
  THEMES,
  THEME_STORAGE_KEY,
  applyTheme,
  darkSchemeQuery,
  readStoredTheme,
  type ResolvedTheme,
  type Theme,
} from "./theme";
import { useUpdateCheck, RELEASES_PAGE, type UpdateController } from "./updater";
import HtmlView, { type HtmlViewHandle } from "./HtmlView";
import { mergeHtmlThreads, type HtmlThread } from "./htmlComments";
import { sanitizeAuthor, sanitizeBody } from "./criticMarkup";
import {
  MD_EXT_RE,
  HTML_EXT_RE,
  isHtmlPath,
  htmlSiblingOf,
  mdSiblingOf,
  parseEntityMeta,
  serializeEntityMeta,
  metaIsEmpty,
  emptyMeta,
  expandMarkdown,
  extractMarkdown,
  markerIds,
  type EntityMeta,
  type MdThread,
  type ForeignRecord,
  type TableCols,
} from "./metaFile";
import { tableWidthsKey } from "./tableWidths";
import { linkTargetPath } from "./docLinks";
import { useDismiss } from "./dismiss";
import { splitFrontmatter } from "./frontmatter";
import {
  backend,
  SaveConflict,
  type DocumentChange,
  type DocumentPart,
  type DocumentText,
  type FileClipboardPayload,
  type LeftBehind,
  type OpenedDocument,
  type Removed,
  type Restored,
  type Rev,
  type WatchedDocument,
  type WindowInit,
} from "./backend";

// The text changed somewhere else while this window had edits of its own:
// `theirs` is what it is at now, and what a save over it would be made over.
type Conflict = { theirs: Rev };

const AUTOSAVE_DEBOUNCE_MS = 600;

// What a window opens with where the platform keeps no windows of its own:
// the one window there is, with nothing handed to it.
const ONLY_WINDOW: WindowInit = {
  isMain: true,
  folder: null,
  file: null,
  tabs: [],
  activeId: null,
  restored: false,
};

// Whether this window owns the shared tab session (doklin:session). The backend is
// the authority (take_window_init keys off the real window label); we default to
// true and flip it false for spawned windows once init resolves, so a spawned
// window never clobbers the main window's session. Shared prefs (the theme)
// stay shared across all windows.
let isMainWindow = true;

// The main window's workspace root, mirrored module-level (like isMainWindow)
// so writeStoredSession can include it without threading it through every call
// site. Deliberately kept even while the folder is unreadable (unmounted
// drive), so the workspace self-heals on a later launch like ghost tabs do.
let sessionWorkspaceRoot: string | null = null;

// The current split (descriptor only), mirrored module-level for the same
// reason: every writeStoredSession call site persists it without threading.
let sessionSplit: StoredSplit | null = null;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};

// A markdown file and the html file beside it are ONE document (see
// metaFile.ts): the pair opens as one tab keyed on the markdown path, with an
// in-editor MD/HTML view toggle.

// What a document's parts are called when one could not follow it.
const PART_LABEL: Record<DocumentPart, string> = { rendition: "HTML version", meta: "comments" };

// A sidecar's text as the records it holds; null (the document has none yet)
// is no records.
const metaOf = (text: string | null): { meta: EntityMeta; metaExists: boolean } =>
  text === null
    ? { meta: emptyMeta(), metaExists: false }
    : { meta: parseEntityMeta(text), metaExists: true };

// Three-way merge for markdown thread bodies (externally-changed meta vs the
// open editor's marks): reuses the html merge — which carries the deletion-
// sticks and entry-dedup semantics — under a placeholder anchor.
const MD_MERGE_ANCHOR = { path: "", tag: "", text: "" };
const mergeMdThreads = (
  base: MdThread[],
  mine: MdThread[],
  theirs: MdThread[],
): MdThread[] =>
  mergeHtmlThreads(
    base.map((t) => ({ id: t.id, anchor: MD_MERGE_ANCHOR, comments: t.comments })),
    mine.map((t) => ({ id: t.id, anchor: MD_MERGE_ANCHOR, comments: t.comments })),
    theirs.map((t) => ({ id: t.id, anchor: MD_MERGE_ANCHOR, comments: t.comments })),
  ).map(({ id, comments }) => ({ id, comments }));

// Pick a collision-free paste target inside `destDir`: "name.md", then
// "name copy.md", then "name copy 2.md" (VS Code's convention). Document
// files also keep their sibling stem free — pasting "notes.md" where only
// "notes.html" exists would otherwise fold two unrelated documents into one
// paired tree row.
const uniquePastePath = async (
  destDir: string,
  name: string,
  kind: "file" | "dir",
): Promise<string> => {
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const isDoc = kind === "file" && (MD_EXT_RE.test(name) || HTML_EXT_RE.test(name));
  const taken = async (p: string): Promise<boolean> => {
    if (await backend.documents.exists(p)) return true;
    if (!isDoc) return false;
    const sibling = HTML_EXT_RE.test(p) ? mdSiblingOf(p) : htmlSiblingOf(p);
    return backend.documents.exists(sibling);
  };
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    const full = `${destDir}/${candidate}`;
    if (!(await taken(full))) return full;
  }
};

type DocView = "md" | "html";

/* ---------- Split view ----------
   The editor area can split into two side-by-side panes. The app's whole
   document machinery (autosave, watcher, conflicts, comments, find)
   stays bound to ONE document — the FOCUSED pane's — and
   `SplitPane` describes the other pane:

   - Same-document split (`doc === null`): the active document open in both
     panes, each with its own MD/HTML pick (VS Code-style "same file
     twice"). Everything is the active document's own state, so html panes
     stay fully live (comment layer included). When exactly one pane shows
     markdown, THAT pane is the live editor (the machinery normalizes sides
     to keep it focused); when both show markdown, the non-focused pane is a
     read-only MIRROR that refreshes from each autosave — two Milkdown
     instances of one document must never both accept edits.
   - Two-document split (`doc` loaded): the other pane shows a second
     document read-only, kept fresh by the shared file watcher. Interacting
     with it (click, comment) promotes it to the focused document — a pure
     role swap, no editor remount, so caret/scroll/undo survive.

   By construction the focused pane is always the OPPOSITE side of
   `split.side`; there is no separate focus state to drift. */
type PaneSide = "left" | "right";
const otherSide = (s: PaneSide): PaneSide => (s === "left" ? "right" : "left");

// Where a split pane's scroll offset lives. Two-document companions share
// the per-tab key — the doc restores at the same place when it later opens
// focused. A same-document MIRROR pane gets its own key: the live pane's
// offset for that tab must not be clobbered by the mirror's.
const companionScrollKey = (s: SplitPane) => (s.doc ? s.tabId : `mirror:${s.tabId}`);

// The demoted document's full state, stashed so promoting it back is instant
// and lossless. `contents` is the markdown as this pane's editor last knew it
// (used only for remounts — the mounted editor keeps its own state).
type CompanionDoc = {
  path: string;
  kind: TabKind;
  missing: boolean;
  contents: string;
  snapshot: Rev | null;
  htmlPath: string | null;
  hasHtml: boolean;
  htmlContent: string | null;
  threads: HtmlThread[];
  sidecarExists: boolean;
  // The entity meta's markdown-side sections ride the stash too, so a swap
  // never has a window where a meta write could drop them (see metaFile.ts).
  mdThreads: MdThread[];
  mdOrphans: MdThread[];
  tcols: TableCols[];
  metaForeign: ForeignRecord[];
  // The pane document's frontmatter block, split off the same way the active
  // document's is: `contents` above is the BODY, so promoting this pane must
  // hand the block back to the writers or the next save would prepend the
  // other document's block.
  head: string;
  conflict: Conflict | null;
  dirty: boolean;
};

type SplitPane = {
  side: PaneSide; // which side this (non-focused) pane renders on
  tabId: string;
  view: DocView;
  doc: CompanionDoc | null; // null = same-document split
};

const SYNC_SCROLL_STORAGE_KEY = "doklin:split-sync-scroll";
const SPLIT_RATIO_STORAGE_KEY = "doklin:split-ratio";

// Sync scroll is opt-in: independent panes (each scrolls on its own, under
// the pointer) are what most people expect from a split.
function readStoredSyncScroll(): boolean {
  try {
    return localStorage.getItem(SYNC_SCROLL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const SIDEBAR_WIDTH_STORAGE_KEY = "doklin:sidebar-width";
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 440;

function readStoredSidebarWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || "", 10);
    if (Number.isFinite(v)) return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, v));
  } catch {
    // ignore
  }
  return 240;
}

function readStoredSplitRatio(): number {
  try {
    const v = parseFloat(localStorage.getItem(SPLIT_RATIO_STORAGE_KEY) || "");
    if (Number.isFinite(v)) return Math.min(0.8, Math.max(0.2, v));
  } catch {
    // ignore
  }
  return 0.5;
}

// The file name (no extension) the Save prompt offers for an untitled note:
// what the note is called — its first line — with the characters a file name
// can't hold swapped out.
const suggestedFileName = (title: string) =>
  title.replace(/[/\\:]/g, "-").trim() || "Untitled";

const COMMENTS_VISIBLE_STORAGE_KEY = "doklin:comments-visible";
const SIDEBAR_OPEN_STORAGE_KEY = "doklin:sidebar-open";
const SESSION_STORAGE_KEY = "doklin:session";
const DOC_ZOOM_STORAGE_KEY = "doklin:doc-zoom";
const FULL_WIDTH_STORAGE_KEY = "doklin:full-width";

/* ---------- Full width (Settings → Appearance) ----------
   The note reads in a 672px column (--doc-measure); full width lifts that
   cap so the note spans its pane, side padding kept — Notion's "Full width",
   Obsidian's readable line length turned off. Per app, like zoom: it's about
   the reader's screen, not the file. Applied as data-full-width on <html>,
   which App.css keys on. */
function readStoredFullWidth(): boolean {
  try {
    return localStorage.getItem(FULL_WIDTH_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function applyFullWidth(on: boolean) {
  document.documentElement.toggleAttribute("data-full-width", on);
}

/* ---------- Document zoom (⌘+ / ⌘- / ⌘0) ----------
   One factor scales BOTH versions of a document, so switching MD↔HTML never
   changes the reading size: the markdown editor's typography derives from
   --doc-zoom on <html> (App.css), and the html rendition is zoomed inside its
   sandboxed frame by the comment bridge (htmlBridge.ts). App chrome doesn't
   scale — this is a reading control, not a window zoom.

   The setting is per app, not per document, and persists across launches —
   font size is about the reader's eyes, not about the file. Discrete rungs
   (browser-style) keep every step meaningful and reversible. */
const DOC_ZOOM_STEPS = [0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
const DOC_ZOOM_DEFAULT = 1;

function nearestZoomStep(z: number): number {
  return DOC_ZOOM_STEPS.reduce(
    (best, s) => (Math.abs(s - z) < Math.abs(best - z) ? s : best),
    DOC_ZOOM_DEFAULT,
  );
}

// Snapped to a rung on the way in: a stale or hand-edited value would
// otherwise strand ⌘+/⌘- off the ladder.
function readStoredDocZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(DOC_ZOOM_STORAGE_KEY) || "");
    if (Number.isFinite(v)) return nearestZoomStep(v);
  } catch {
    // ignore
  }
  return DOC_ZOOM_DEFAULT;
}

function stepDocZoom(current: number, dir: 1 | -1): number {
  const i = DOC_ZOOM_STEPS.indexOf(nearestZoomStep(current));
  return DOC_ZOOM_STEPS[Math.min(DOC_ZOOM_STEPS.length - 1, Math.max(0, i + dir))];
}

const uuid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

// Where untitled notes' buffers live (src-tauri/src/untitled.rs), asked for
// once before this window builds its first tab. A new note's buffer is named
// after its tab; the file itself appears with the note's first autosave.
let untitledDir = "";
const untitledPathFor = (id: string) => `${untitledDir}/${id}.md`;

// What a tab's document is loaded from. `rev` is null for a note that has
// never been written.
type LoadedDoc = Omit<OpenedDocument, "rev"> & { rev: Rev | null };

// Open a tab's document. An untitled note nothing has been typed into has no
// buffer yet — that is an empty note, not a missing file.
const openTabDoc = async (tab: StoredTab): Promise<LoadedDoc> => {
  try {
    return await backend.documents.open(tab.path);
  } catch (e) {
    if (tab.kind === "untitled") return { text: "", rev: null, meta: null, rendition: null };
    throw e;
  }
};

// An untitled note's tab, read back out of its buffer — or null when the
// buffer has no text in it: then it is not a note any more, and what is left
// of it is deleted. (A buffer that fails to read is left alone; if it does
// hold a note, the next launch finds it.)
const restoreUntitled = async (id: string, path: string): Promise<UntitledTab | null> => {
  let md: string;
  try {
    md = (await backend.documents.read(path)).text;
  } catch {
    return null;
  }
  if (!noteHasText(md)) {
    void backend.untitled?.discard(path).catch(() => {});
    return null;
  }
  return { id, kind: "untitled", path, title: noteTitle(md), unsaved: true };
};

// What can be done with an untitled note whose tab is about to close.
type UnsavedChoice = "save" | "discard" | "cancel";

// A yes-or-no put to the user before something that lets more people see a
// document, or takes a folder off other people's Macs.
type Question = { title: string; body: string; confirm: string; answer: (yes: boolean) => void };

// One in-app delete, as undo needs to see it — see deletedStackRef.
type DeletedRecord = {
  undo: () => Promise<Restored>;
  openPaths: string[];
};
const THEME_LABEL: Record<Theme, string> = {
  system: "System",
  light: "Light",
  paper: "Paper",
  dark: "Dark",
};

// Paint the stored theme and width before the first render, not after it.
if (typeof document !== "undefined") {
  applyTheme(readStoredTheme());
  applyFullWidth(readStoredFullWidth());
}

function readStoredSidebarOpen(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    // ignore
  }
  return true;
}

function writeStoredSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

// The persisted session is keyed by workspace root so each directory remembers
// its OWN open tabs: opening directory B never shows directory A's tabs, and
// reopening A brings A's tabs back. Tabs opened with no folder (a bare launch)
// live under a sentinel key. `lastRoot` records which workspace to restore on a
// bare launch, where the command line names no folder.
type StoredSplit = { tabId: string; view: DocView; side: PaneSide };
type SessionEntry = { tabs: StoredTab[]; activeId: string | null; split?: StoredSplit | null };
type StoredSessions = { lastRoot: string | null; sessions: Record<string, SessionEntry> };
const NO_WORKSPACE_KEY = "<no-workspace>";
const sessionKeyFor = (root: string | null) => root ?? NO_WORKSPACE_KEY;

function sanitizeSplit(raw: unknown): StoredSplit | null {
  const s = raw as StoredSplit | null | undefined;
  return s &&
    typeof s.tabId === "string" &&
    (s.view === "md" || s.view === "html") &&
    (s.side === "left" || s.side === "right")
    ? { tabId: s.tabId, view: s.view, side: s.side }
    : null;
}

function sanitizeTabs(raw: unknown): StoredTab[] {
  return Array.isArray(raw)
    ? raw
        .filter(
          (t: unknown): t is StoredTab =>
            !!t &&
            typeof (t as StoredTab).id === "string" &&
            typeof (t as StoredTab).path === "string" &&
            ((t as StoredTab).kind === "file" || (t as StoredTab).kind === "untitled"),
        )
        .map(({ id, kind, path }) => ({ id, kind, path }))
    : [];
}

// Read the whole keyed-session map. Anything that is not a version-2 map
// reads as no saved session.
function readAllSessions(): StoredSessions {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return { lastRoot: null, sessions: {} };
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 2 || !parsed?.sessions || typeof parsed.sessions !== "object") {
      return { lastRoot: null, sessions: {} };
    }
    const sessions: Record<string, SessionEntry> = {};
    for (const [key, val] of Object.entries(parsed.sessions as Record<string, unknown>)) {
      const v = val as { tabs?: unknown; activeId?: unknown; split?: unknown };
      sessions[key] = {
        tabs: sanitizeTabs(v?.tabs),
        activeId: typeof v?.activeId === "string" ? v.activeId : null,
        split: sanitizeSplit(v?.split),
      };
    }
    const lastRoot = typeof parsed.lastRoot === "string" ? parsed.lastRoot : null;
    return { lastRoot, sessions };
  } catch {
    return { lastRoot: null, sessions: {} };
  }
}

// The saved tabs/active for one workspace (empty if that directory was never
// opened, or had no tabs when last left).
function readStoredSession(root: string | null): SessionEntry {
  return readAllSessions().sessions[sessionKeyFor(root)] ?? { tabs: [], activeId: null };
}

function writeStoredSession(tabs: Tab[], activeId: string | null) {
  // Only the main window owns the persisted session; spawned windows are driven
  // by take_window_init, so they must not clobber the shared session key.
  if (!isMainWindow) return;
  try {
    const all = readAllSessions();
    const key = sessionKeyFor(sessionWorkspaceRoot);
    // An empty workspace stores no entry (rather than a stub for every directory
    // ever opened); it reads back as "no tabs" either way. `lastRoot` still
    // points here so a later bare launch reopens this folder.
    if (tabs.length === 0) delete all.sessions[key];
    else all.sessions[key] = { tabs: tabs.map(toStoredTab), activeId, split: sessionSplit };
    all.lastRoot = sessionWorkspaceRoot;
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ version: 2, lastRoot: all.lastRoot, sessions: all.sessions }),
    );
  } catch {
    // ignore
  }
}

// The removals this window has already acted on (`root@at`): each is told
// twice — as an event, and in the list a window asks for once it is up — and
// must be shown once.
const shownRemovals = new Set<string>();

// Drop one folder's saved tabs: the folder is gone from this Mac (a workspace
// this Mac lost access to), so there is nothing left to come back to.
function forgetStoredSession(root: string) {
  if (!isMainWindow) return;
  try {
    const all = readAllSessions();
    delete all.sessions[sessionKeyFor(root)];
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        lastRoot: all.lastRoot === root ? null : all.lastRoot,
        sessions: all.sessions,
      }),
    );
  } catch {
    // ignore
  }
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // `path` (open file) and `workspaceRoot` (folder) are independent, not two
  // modes. Opening a file vs a folder must differ ONLY in UI: `workspaceRoot`
  // gates the sidebar and nothing else. The file lifecycle (load/edit/autosave/
  // watch/conflict) keys off `path` alone — keep it that way; never branch file
  // handling on whether a workspace is open.
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  // The sidebar's selected rows (files or folders; ⌘/⇧-click multi-selects).
  // Lives here — not in Sidebar — because the PRIMARY selection (the last
  // entry, the row clicked most recently) is the creation context: saving an
  // untitled note defaults into the selected folder (or next to the selected
  // file), falling back to the workspace root. Mirrored in a ref for async
  // readers.
  const [sidebarSelection, setSidebarSelection] = useState<SidebarSelection[]>([]);
  const sidebarSelectionRef = useRef<SidebarSelection[]>([]);
  // The in-app Save As prompt (shown instead of the native save panel when a
  // workspace decides the destination): the folder is fixed, only the name is
  // asked for. null = closed. Whoever opened it is waiting on the answer —
  // `savePromptDoneRef` resolves true once the note is a file, false when the
  // prompt is dismissed.
  const [savePrompt, setSavePrompt] = useState<{ dir: string; suggested: string } | null>(null);
  const savePromptDoneRef = useRef<((saved: boolean) => void) | null>(null);
  // The question an untitled note with text in it raises before its tab
  // closes (see closeTab): which note, and the resolver for the answer.
  const [unsavedPrompt, setUnsavedPrompt] = useState<{ title: string } | null>(null);
  const unsavedAnswerRef = useRef<((choice: UnsavedChoice) => void) | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readStoredSidebarOpen());
  // The comment layer: visible by default, hideable app-wide (persisted) so a
  // marked-up document can be read clean. The count comes from the editor and
  // drives the tab-bar toggle (which only shows when there's something to hide).
  const [commentsVisible, setCommentsVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMMENTS_VISIBLE_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [commentCount, setCommentCount] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  // Undo stack for trashed entries. `files` is everything one delete moved to
  // the Trash (a markdown file's html rendition rides along); `openPaths` are
  // the file tabs the delete closed (the entry itself for a file, everything
  // under it for a folder) so ⌘Z can reopen them after restoring.
  const deletedStackRef = useRef<DeletedRecord[]>([]);
  const currentMarkdownRef = useRef<string>("");
  const lastSavedRef = useRef<string>("");
  const baselineCapturedRef = useRef<boolean>(false);
  const pathRef = useRef<string | null>(null);
  const snapshotRef = useRef<Rev | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const conflictRef = useRef<Conflict | null>(null);
  // Imperative mirrors of the tab list + active id, so async operations read the
  // latest value without stale closures (same pattern as pathRef/dirtyRef).
  const tabsRef = useRef<Tab[]>([]);
  const activeIdRef = useRef<string | null>(null);
  // Per-tab scroll offsets, captured before the editor remounts on a switch and
  // restored once the incoming editor is ready. DOM-level (.editor-wrap), so it
  // needs no editor internals. In-memory only — a fresh launch starts at top.
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [fullWidth, setFullWidth] = useState<boolean>(() => readStoredFullWidth());
  const [docZoom, setDocZoom] = useState<number>(() => readStoredDocZoom());

  // md/html rendition state for the ACTIVE document. `hasHtml` = an html
  // rendition exists on disk; `docView` = which version the editor area shows;
  // `htmlContent` = the rendition's markup (fed to a sandboxed iframe).
  // htmlPathRef mirrors the rendition path for async readers (watcher events,
  // debounced writes). The markdown editor stays mounted (hidden) in html view so
  // toggling back keeps cursor, undo history, and unsaved state.
  const [docView, setDocViewState] = useState<DocView>("md");
  const docViewRef = useRef<DocView>("md");
  const [hasHtml, setHasHtml] = useState(false);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  // Mirror for stash-time readers (the split view's focus swap packs the
  // whole active-doc state into a CompanionDoc synchronously).
  const htmlContentRef = useRef<string | null>(null);
  const htmlPathRef = useRef<string | null>(null);
  // Comment threads on the ACTIVE document's html rendition, mirrored from
  // the entity META file (see metaFile.ts). The ref
  // mirrors state for async readers (watcher events, debounced writes) —
  // same pattern as pathRef. `htmlSidecarExistsRef` remembers whether the
  // meta file is on disk: an empty thread list never CREATES a file, and the
  // first write re-arms the watcher (a file that didn't exist at watch time
  // couldn't be watched).
  const [htmlThreads, setHtmlThreads] = useState<HtmlThread[]>([]);
  const htmlThreadsRef = useRef<HtmlThread[]>([]);
  const htmlSidecarExistsRef = useRef(false);
  const sidecarWriteTimerRef = useRef<number | null>(null);
  // The rest of the ACTIVE entity's meta file: markdown thread bodies (live =
  // rooted by a marker in the doc; orphans = marker gone, kept + railed),
  // plus records a newer app version owns (carried through rewrites). The
  // markdown on DISK is the hybrid form — markers only; expandMarkdown /
  // extractMarkdown convert at every read/write, so the editor (whose
  // comment layer parses CriticMarkup) always sees the full form.
  const mdThreadsRef = useRef<MdThread[]>([]);
  const [mdOrphans, setMdOrphans] = useState<MdThread[]>([]);
  const mdOrphansRef = useRef<MdThread[]>([]);
  // The active document's persisted table column widths. State because the
  // editor takes them as a mount-time prop (they're applied to the parsed
  // doc before the first paint); ref for the async writers, as everywhere
  // else here. See tableWidths.ts for how a record finds its table.
  const [tableWidths, setTableWidths] = useState<TableCols[]>([]);
  const tableWidthsRef = useRef<TableCols[]>([]);
  const metaForeignRef = useRef<ForeignRecord[]>([]);
  // The hybrid markdown as last read from / written to disk — lets a
  // body-only comment edit skip the (byte-identical) markdown write. This is
  // the BODY: a leading frontmatter block never reaches it (see below).
  const lastDiskMdRef = useRef<string>("");
  /* ---------- The frontmatter boundary ----------
     Milkdown never sees frontmatter (src/frontmatter.ts). Like
     expandMarkdown / extractMarkdown for comment bodies, the split happens
     at the IO boundary: a load splits the block off the top and hands the
     editor the body; a save prepends the block back, byte for byte, so an
     edit to the prose can't rewrite an agent's `tags:` line, and a change to
     the block alone (an agent, another device) leaves the body untouched.

     `frontmatterRef` is the exact block as last seen on disk — what the next
     write re-attaches. `frontmatter` is the text between its fences, shown
     read-only above the note. */
  const frontmatterRef = useRef<string>("");
  const [frontmatter, setFrontmatter] = useState<string>("");
  // Adopt a document's frontmatter block: the ref the writers read and the
  // state the note shows, in one place so the two can't drift.
  const adoptFrontmatter = useCallback((fullText: string) => {
    const fm = splitFrontmatter(fullText);
    frontmatterRef.current = fm.head;
    setFrontmatter(fm.inner);
    return fm;
  }, []);
  // Remembered view per document path (session-scoped): a tab you left on HTML
  // comes back on HTML; an html file opened explicitly starts on HTML.
  const viewPrefsRef = useRef<Map<string, DocView>>(new Map());

  const applyDocView = useCallback((v: DocView) => {
    docViewRef.current = v;
    setDocViewState(v);
  }, []);

  /* ---------- Split view state ---------- */

  // The non-focused pane (see the SplitPane comment above). All mutations go
  // through setSplitState so the ref, the session mirror, and persistence
  // stay in lockstep.
  const [split, setSplit] = useState<SplitPane | null>(null);
  const splitRef = useRef<SplitPane | null>(null);
  const [syncScroll, setSyncScroll] = useState<boolean>(() => readStoredSyncScroll());
  const syncScrollRef = useRef(syncScroll);
  syncScrollRef.current = syncScroll;
  const [splitRatio, setSplitRatio] = useState<number>(() => readStoredSplitRatio());
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredSidebarWidth());
  // The same-document split's read-only markdown MIRROR (both panes on md):
  // content snapshots of the live editor, re-seeded on every autosave
  // commit/reload. Keyed remounts (`mirror:tabId:seq`) keep it cheap.
  const [mirror, setMirror] = useState<{ content: string; seq: number }>({
    content: "",
    seq: 0,
  });
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  // The companion pane's markdown editor handle + its serialized-content
  // tracking: `md` is the editor's latest serialization, `baseline` the
  // serialization matching what's saved on disk, `baselined` whether the
  // mount-time serialization arrived yet. An edit landing in the companion
  // (its comment rail works read-only) promotes the pane — see
  // onCompanionMarkdownChange.
  const companionEditorRef = useRef<EditorHandle>(null);
  const companionMdRef = useRef<{ md: string; baseline: string; baselined: boolean }>({
    md: "",
    baseline: "",
    baselined: false,
  });
  // Per-document editor remount counter. An editor instance is keyed by
  // `tabId:seq` — stable across focus swaps (no remount), bumped whenever
  // that document's content is (re)loaded from disk.
  const editorSeqRef = useRef<Map<string, number>>(new Map());
  const bumpEditorSeq = useCallback((tabId: string) => {
    const m = editorSeqRef.current;
    m.set(tabId, (m.get(tabId) ?? 0) + 1);
  }, []);
  // Which tab the document machinery's refs (path, baseline, snapshot…)
  // describe right now: set when a load has installed them and bumped the
  // tab's editor seq, or when a focus swap hands the machinery to an editor
  // that is already mounted; null while a load is in flight or nothing is
  // open. With the seq it names the ONE editor instance whose changes are
  // the active document's — see onMarkdownChange.
  const loadedIdRef = useRef<string | null>(null);
  // Loads are asynchronous and can overlap — close a tab, then ⌘N before its
  // neighbour has finished loading — while the machinery is ONE set of refs.
  // Only the latest may install into it: whatever is about to (a load, the
  // reset to no document, a focus swap) takes a ticket, and a load that
  // wakes from an await to find a newer one stops where it is.
  const loadTicketRef = useRef(0);
  // The two panes' scroll containers and (when a pane shows html) their
  // HtmlView handles, by side — the scroll-sync plumbing.
  const wrapElsRef = useRef<Record<PaneSide, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const htmlHandlesRef = useRef<Record<PaneSide, HtmlViewHandle | null>>({
    left: null,
    right: null,
  });
  // Where an html pane docks its own controls (Comment mode, PDF export):
  // the tab bar when a single pane is open, that pane's header when split —
  // the same rule the MD/HTML switcher follows. HtmlView portals its button
  // row into the node, so these are STATE, not refs: the portal has to
  // re-render once the node exists. Until then HtmlView renders no row at
  // all rather than flashing one over the document (see controlsSlot).
  const [barToolSlot, setBarToolSlot] = useState<HTMLDivElement | null>(null);
  const [leftToolSlot, setLeftToolSlot] = useState<HTMLDivElement | null>(null);
  const [rightToolSlot, setRightToolSlot] = useState<HTMLDivElement | null>(null);
  // Which pane the pointer is over — the scroll-sync publisher. Only the
  // hovered pane broadcasts its scrolls; the other only follows, so the two
  // can never feed back.
  const hoverSideRef = useRef<PaneSide | null>(null);
  // Echo suppression for programmatic wrap scrolls (html panes suppress
  // bridge-side): a pane whose scrollTop we just set ignores its own scroll
  // events for a beat.
  const scrollMuteRef = useRef<Record<PaneSide, number>>({ left: 0, right: 0 });
  const editorAreaRef = useRef<HTMLDivElement | null>(null);
  // Live tab-drag drop target (dragging a tab out of the bar over the editor
  // area): which half is armed. null = no drag in progress.
  const [tabDrop, setTabDrop] = useState<{ tabId: string; side: PaneSide | null } | null>(
    null,
  );

  const setSplitState = useCallback((next: SplitPane | null) => {
    splitRef.current = next;
    setSplit(next);
    sessionSplit = next ? { tabId: next.tabId, view: next.view, side: next.side } : null;
    writeStoredSession(tabsRef.current, activeIdRef.current);
  }, []);

  // Re-seed the same-doc mirror pane from `content` (autosave commits,
  // reloads, view flips): capture where the reader was, remount at the new
  // content, land back at the same offset via the editor's onReady. Lives up
  // here (state-block dependencies only) so writeToDisk can depend on it.
  const refreshMirror = useCallback((content: string) => {
    if (mirrorRef.current.content === content) return;
    const s = splitRef.current;
    if (s && !s.doc && s.view === "md") {
      const wrap = wrapElsRef.current[s.side];
      if (wrap) scrollPositionsRef.current.set(companionScrollKey(s), wrap.scrollTop);
    }
    setMirror((m) => ({ content, seq: m.seq + 1 }));
  }, []);

  // The split operations live below (they need the whole document
  // machinery); earlier callers (switchTab, openWorkspace) reach them
  // through these refs — the reloadFromDiskRef pattern.
  const swapFocusRef = useRef<(toFocusSide?: PaneSide) => Promise<void>>(
    () => Promise.resolve(),
  );
  const splitSameDocRef = useRef<(side?: PaneSide, view?: DocView) => Promise<void>>(
    () => Promise.resolve(),
  );
  const openInPaneRef = useRef<(tabId: string, side: PaneSide, view?: DocView) => Promise<void>>(
    () => Promise.resolve(),
  );

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // ignore
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, syncScroll ? "1" : "0");
    } catch {
      // ignore
    }
  }, [syncScroll]);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(splitRatio));
    } catch {
      // ignore
    }
  }, [splitRatio]);

  // Defensive janitor: a split whose tab vanished (bulk tab mutations that
  // bypass closeTab) renders as no split; drop the record too.
  useEffect(() => {
    if (split && !tabs.some((t) => t.id === split.tabId)) setSplitState(null);
  }, [split, tabs, setSplitState]);

  // In-app auto-update: quiet check on launch, plus manual re-check / one-click
  // install from the Settings menu. See updater.ts.
  const update = useUpdateCheck();

  // The name comments written here are signed with: the backend's to say
  // (on a Mac, the Mac's own name). Seeded once; the fallback holds until
  // then.
  const [deviceName, setDeviceName] = useState("This Mac");
  useEffect(() => {
    void backend
      .authorName()
      .then(setDeviceName)
      .catch(() => {});
  }, []);

  // The cloud: every connected workspace's status, as the engine reports it
  // — one array, replaced whole on every `cloud-status` event (src/cloud.ts).
  // Everything cloud-shaped in the UI derives from this and nothing else.
  const [cloudStatuses, setCloudStatuses] = useState<CloudStatus[]>([]);
  useEffect(() => {
    let live = true;
    void backend.cloud.status()
      .then((s) => {
        if (live) setCloudStatuses(s);
      })
      .catch(() => {});
    const un = backend.cloud.onStatus((s) => {
      if (live) setCloudStatuses(s);
    });
    return () => {
      live = false;
      un();
    };
  }, []);
  const cloudForRoot = useMemo(
    () => cloudForWorkspace(cloudStatuses, workspaceRoot),
    [cloudStatuses, workspaceRoot],
  );
  // The workspaces this Mac belongs to — every connected one has an engine,
  // so the statuses are the list. What the sidebar's switcher shows.
  const myWorkspaces = useMemo(
    () => cloudStatuses.map((s) => ({ root: s.root, name: s.name, domain: s.domain })),
    [cloudStatuses],
  );
  // The pages of the open workspace, for the glyph on a live page's tab.
  const livePaths = useMemo(() => livePathsOf(cloudForRoot), [cloudForRoot]);
  // The cloud surfaces: the panel, the setup
  // wizard (connect this folder, or open a workspace from a domain), the
  // worker update card, and the transient notices. The held mass-deletion's paths ride the event that
  // announced it; the panel lists them.
  const [cloudPanelOpen, setCloudPanelOpen] = useState(false);
  const [cloudSetup, setCloudSetup] = useState<CloudSetupMode | null>(null);
  const [workerUpdateOpen, setWorkerUpdateOpen] = useState(false);
  // The workspace's own surfaces, reached from its menu and its sections:
  // who is in it and its agents (one window, a tab each); the dialog that
  // makes a restricted folder, and what it is being made from; and whose
  // access is being managed — by id, so the dialog follows the status.
  const [accessTab, setAccessTab] = useState<AccessTab | null>(null);
  const [restrictedSource, setRestrictedSource] = useState<RestrictedSource | null>(null);
  const [accessSpaceId, setAccessSpaceId] = useState<string | null>(null);
  // A question with one safe answer, asked in the app's own chrome and
  // answered once (`askUser`).
  const [question, setQuestion] = useState<Question | null>(null);
  const askUser = useCallback(
    (q: Omit<Question, "answer">) => new Promise<boolean>((answer) => setQuestion({ ...q, answer })),
    [],
  );
  // Version history: which document's rail is
  // open, and which of its versions is showing in the document area instead
  // of the live editor. `historyToken` re-reads the rail after a restore
  // adds rows to it.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // `docPath` is the document the version belongs to — normally the one the
  // rail is open on, but *Recently deleted* previews a file that has no tab
  // to stand in, and that one is `detached`: it shows over whatever pane is
  // focused, because there is nowhere else for it to be.
  const [versionPreview, setVersionPreview] = useState<
    { version: FileVersion; newer: FileVersion | null; root: string; docPath: string; detached?: boolean } | null
  >(null);
  const [historyToken, setHistoryToken] = useState(0);
  // The workspace timeline (a modal) and the deleted files (a sidebar
  // column). The app owns the deleted list: the sidebar's row needs the
  // same count, and reading it costs a walk of the retained snapshots.
  // Each is for one folder with a history of its own: the workspace, or a
  // section of it — its folder is what `historyRoot` and `deletedFor` hold.
  const [historyRoot, setHistoryRoot] = useState<string | null>(null);
  const [deletedFiles, setDeletedFiles] = useState<DeletedFile[]>([]);
  const [deletedFor, setDeletedFor] = useState<string | null>(null);
  const [sectionDeleted, setSectionDeleted] = useState<DeletedFile[]>([]);
  // Every store's status — the settings surface's whole model, the same way
  // the cloud statuses are the Cloud panel's.
  const [versionStatuses, setVersionStatuses] = useState<VersionsStatus[]>([]);
  const [versionsSettingsOpen, setVersionsSettingsOpen] = useState(false);
  const historyForRef = useRef<string | null>(null);
  // What ⌘⌥H opens history for: the active tab's file. An untitled note has
  // no history.
  const historyTargetRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<CloudPendingDeletesEvent | null>(null);
  // The last many-new-documents question, and the notice asking it while it
  // is up — one at a time, gone once it is answered anywhere.
  const [pendingAdds, setPendingAdds] = useState<CloudPendingAddsEvent | null>(null);
  const addsToastRef = useRef<number | null>(null);
  const toastSeq = useRef(0);
  const pushToast = useCallback((tone: ToastTone, text: string, ...actions: ToastAction[]): number => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((ts) => [...ts.slice(-3), { id, tone, text, actions } satisfies Toast]);
    return id;
  }, []);
  const dismissToast = useCallback(
    (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)),
    [],
  );
  // Publishing: the folder dialog (a folder,
  // or the root for the whole workspace) and the list of every published
  // page. The Live chip lives in the title row (LiveChip).
  const [publishFolder, setPublishFolder] = useState<string | null>(null);
  const [publishedOpen, setPublishedOpen] = useState(false);
  // Stopping from the sidebar is immediate and undoable: the toast's Undo
  // publishes the same path again under the same slug.
  const stopPublishing = useCallback(
    (page: PublicPage) => {
      const root = workspaceRoot;
      if (!root) return;
      const abs = page.path ? `${root}/${page.path}` : root;
      void backend.cloud.unpublish(root, page.slug)
        .then(() =>
          pushToast("info", `Stopped publishing ${page.path ? basename(page.path) : "the workspace"}.`, {
            label: "Undo",
            run: () =>
              void backend.cloud.publish(abs, {
                slug: page.slug,
                title: page.title ?? undefined,
                desc: page.desc ?? undefined,
              }).catch((e) => pushToast("error", `Couldn't publish again: ${errText(e)}`)),
          }),
        )
        .catch((e) => pushToast("error", `Couldn't stop publishing: ${errText(e)}`));
    },
    [workspaceRoot, pushToast],
  );


  // The SVG of a rendered figure (a mermaid diagram or an svg drawing) opened
  // in the zoom/pan canvas; null when closed. Set by the `dk-figure-expand`
  // event a figure's expand chip fires (src/figureBlock.ts).
  const [zoomDiagramSvg, setZoomDiagramSvg] = useState<string | null>(null);

  // A rendered figure's expand chip fires this with its SVG; open the
  // zoom/pan canvas on it.
  useEffect(() => {
    const onExpand = (e: Event) => {
      const detail = (e as CustomEvent<{ svg?: string }>).detail;
      if (detail && typeof detail.svg === "string") setZoomDiagramSvg(detail.svg);
    };
    window.addEventListener("dk-figure-expand", onExpand);
    return () => window.removeEventListener("dk-figure-expand", onExpand);
  }, []);

  // Land a markdown save's thread bodies in the entity meta of a document
  // that is NOT the active one (a background flush after a focus swap, a
  // web-edit pull): a guarded read-modify-write preserving the sections this
  // write doesn't own — html threads, table widths, foreign records — and
  // any orphaned bodies whose marker is still missing from the given hybrid
  // markdown.
  const writeMdThreadsToMeta = useCallback(
    async (target: string, hybridMd: string, mthreads: MdThread[]) => {
      const { meta: base, metaExists: exists } = metaOf(
        await backend.documents.meta(target).catch(() => null),
      );
      const rooted = new Set(mthreads.map((t) => t.id));
      const ids = markerIds(hybridMd);
      const out: EntityMeta = {
        hthreads: base.hthreads,
        mthreads: [
          ...mthreads,
          ...base.mthreads.filter((t) => !rooted.has(t.id) && !ids.has(t.id)),
        ],
        tcols: base.tcols,
        foreign: base.foreign,
      };
      if (metaIsEmpty(out) && !exists) return;
      await backend.documents
        .save(target, { meta: serializeEntityMeta(out) }, null)
        .catch((e) => console.error("meta save failed", target, e));
    },
    [],
  );


  // In-file find (⌘F): a bar over the editor that drives the ProseMirror search
  // plugin through the editor ref. `findInfo` mirrors the plugin's match count +
  // current index for the "3/12" readout.
  const editorRef = useRef<EditorHandle>(null);
  // Bring the app's copy of the active document up to the editor's. The
  // editor reports its text on a short debounce of its own, so for a moment
  // after a keystroke the app is behind; anything about to write that copy,
  // or to decide something on it — whether a note has text, what to call it
  // — asks the editor to report now. The report arrives through the editor's
  // own onChange, so it is held to the same rule as any other: only the
  // instance the document was loaded for is heard (see onMarkdownChange).
  const catchUpWithEditor = useCallback(() => {
    editorRef.current?.flushMarkdown();
  }, []);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findInfo, setFindInfo] = useState<SearchInfo>({ count: 0, current: 0 });
  const [findFocusToken, setFindFocusToken] = useState(0);
  // Mirror of findQuery so the global keydown handler can read it (to clear an
  // active highlight on Esc) without re-registering the listener every keystroke.
  const findQueryRef = useRef("");
  useEffect(() => {
    findQueryRef.current = findQuery;
  }, [findQuery]);

  // Workspace search (⌘⇧F): the left sidebar toggles between the file tree
  // ("files") and a folder-wide search view ("search").
  const [sidebarMode, setSidebarMode] = useState<"files" | "search" | "deleted">("files");
  const [wsQuery, setWsQuery] = useState("");
  const [wsCase, setWsCase] = useState(false);
  const [wsFocusToken, setWsFocusToken] = useState(0);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  useEffect(() => {
    htmlContentRef.current = htmlContent;
  }, [htmlContent]);

  useEffect(() => {
    applyTheme(theme);
    // Native chrome (context menus, dialogs, tooltips) follows the window's
    // appearance, so it matches the theme rather than the OS. A chosen theme
    // pins it; "system" hands it back to the OS, because a pinned appearance
    // also pins prefers-color-scheme, which is what resolves "system".
    backend.windows?.setTheme(theme === "system" ? null : theme === "dark" ? "dark" : "light");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
    // "System" follows a live OS appearance change.
    const query = darkSchemeQuery;
    if (theme !== "system" || !query) return;
    const onScheme = () => applyTheme("system");
    query.addEventListener("change", onScheme);
    return () => query.removeEventListener("change", onScheme);
  }, [theme]);

  useEffect(() => {
    applyFullWidth(fullWidth);
    try {
      localStorage.setItem(FULL_WIDTH_STORAGE_KEY, fullWidth ? "1" : "0");
    } catch {
      // ignore
    }
  }, [fullWidth]);

  // The markdown editor reads the factor straight off <html> (App.css); the
  // html rendition gets it as a prop, since only the bridge can reach inside
  // the sandboxed frame.
  useEffect(() => {
    document.documentElement.style.setProperty("--doc-zoom", String(docZoom));
    try {
      localStorage.setItem(DOC_ZOOM_STORAGE_KEY, String(docZoom));
    } catch {
      // ignore
    }
  }, [docZoom]);

  useEffect(() => {
    writeStoredSidebarOpen(sidebarOpen);
  }, [sidebarOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(COMMENTS_VISIBLE_STORAGE_KEY, commentsVisible ? "1" : "0");
    } catch {
      // ignore
    }
  }, [commentsVisible]);

  // The count belongs to the mounted document; zero it on each editor remount
  // so a tab with no editor (HTML doc, welcome screen) can't keep showing the
  // previous doc's toggle.
  useEffect(() => {
    setCommentCount(0);
  }, [loadKey]);

  // Tell the backend which documents are on screen: the active one and the
  // split pane's. It answers with `onChange` when one of them, its sidecar
  // or its rendition changes somewhere else, and the change handler routes
  // that by document. Told again whenever the set changes — and after a
  // document's FIRST sidecar write, which a backend watching files could
  // not have been watching for.
  const refreshWatchSet = useCallback(async () => {
    const docs: WatchedDocument[] = [];
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (active?.kind === "file" && !active.missing) {
      if (pathRef.current) {
        docs.push({ path: pathRef.current, rendition: htmlPathRef.current });
      } else if (htmlPathRef.current) {
        // html-only document: the html is its text.
        docs.push({ path: htmlPathRef.current, rendition: null });
      }
    }
    const sd = splitRef.current?.doc;
    if (sd && sd.kind === "file" && !sd.missing && !isUnsupportedTab(sd)) {
      docs.push({ path: sd.path, rendition: sd.htmlPath === sd.path ? null : sd.htmlPath });
    }
    try {
      await backend.documents.watch(docs);
    } catch (e) {
      console.error("watch failed", e);
    }
  }, []);

  // Compose the ACTIVE entity's full meta from the app refs. Every meta
  // write goes through this one composer — the html rail and the markdown
  // save path both mutate sections of the same file, and independent writers
  // would clobber each other's records.
  const composeActiveMeta = useCallback(
    (): EntityMeta => ({
      hthreads: htmlThreadsRef.current,
      mthreads: [...mdThreadsRef.current, ...mdOrphansRef.current],
      tcols: tableWidthsRef.current,
      foreign: metaForeignRef.current,
    }),
    [],
  );


  // `contents` is the editor's serialization — FULL CriticMarkup. What is
  // saved is the hybrid split: markers-only markdown plus thread-body records
  // in the entity meta (see metaFile.ts), the two as ONE save. A body-only
  // edit (a reply typed in the rail) leaves the hybrid markdown
  // byte-identical and its text is not sent at all — only the meta moves.
  const writeToDisk = useCallback(async (target: string, contents: string): Promise<void> => {
    const { md: hybrid, mthreads } = extractMarkdown(contents);
    const isActive = pathRef.current === target;
    // The editor never saw the document's frontmatter block; put it back,
    // byte for byte, in front of what it did see. Captured now, because the
    // active document can change while the write is in flight.
    const head = isActive ? frontmatterRef.current : "";
    // Never skip a document's FIRST write (no snapshot = nothing saved yet:
    // an untitled note's buffer only exists once something is typed).
    const mdUnchanged =
      isActive && snapshotRef.current !== null && hybrid === lastDiskMdRef.current;
    // This save's extraction is the live thread-body set; an orphan whose
    // marker came back (undo, paste) is live again and leaves the orphan
    // list.
    const rooted = new Set(mthreads.map((t) => t.id));
    const ids = markerIds(hybrid);
    const stillOrphan = (t: MdThread) => !rooted.has(t.id) && !ids.has(t.id);
    // The meta as it stands once this text is down, composed now: the other
    // sections are the active document's, and only while it IS the active
    // one are they in the app's refs. Deleting the last thread empties the
    // meta rather than leaving it stale; a document that never had one never
    // gets one.
    let meta: string | undefined;
    if (isActive) {
      const next: EntityMeta = {
        ...composeActiveMeta(),
        mthreads: [...mthreads, ...mdOrphansRef.current.filter(stillOrphan)],
      };
      if (!metaIsEmpty(next) || htmlSidecarExistsRef.current) meta = serializeEntityMeta(next);
    }
    try {
      const saved =
        mdUnchanged && meta === undefined
          ? null
          : await backend.documents.save(
              target,
              { text: mdUnchanged ? undefined : head + hybrid, meta },
              snapshotRef.current,
            );
      const newSnapshot = saved?.rev ?? null;
      // The active tab may have switched while this write was in flight (e.g. a
      // flush of the previous doc resolving after switching tabs). Only commit
      // baseline state if `target` is still the active path — but if the doc
      // was DEMOTED to the split pane meanwhile (focus swap), its stashed
      // record must adopt the write, or promoting it back would carry a stale
      // snapshot and the next autosave would false-conflict.
      if ((pathRef.current) !== target) {
        const s = splitRef.current;
        if (s?.doc && s.doc.path === target && newSnapshot) {
          companionMdRef.current.baseline = contents;
          setSplitState({
            ...s,
            doc: { ...s.doc, snapshot: newSnapshot, contents, dirty: false },
          });
        }
        // A document that was not the active one when this began had no meta
        // composed for it: its thread bodies still land in ITS meta — a
        // guarded read-modify-write that preserves the sections this save
        // doesn't own (html threads, foreign records) and any orphaned
        // bodies.
        if (!isActive) await writeMdThreadsToMeta(target, hybrid, mthreads);
        return;
      }
      if (newSnapshot) {
        snapshotRef.current = newSnapshot;
        lastDiskMdRef.current = hybrid;
      }
      lastSavedRef.current = contents;
      mdThreadsRef.current = mthreads;
      // Read again, not kept from above: the rail may have changed the
      // orphans while the save was in flight.
      if (mdOrphansRef.current.some((t) => !stillOrphan(t))) {
        const remaining = mdOrphansRef.current.filter(stillOrphan);
        mdOrphansRef.current = remaining;
        setMdOrphans(remaining);
      }
      if (meta !== undefined && saved?.meta) {
        const isNew = !htmlSidecarExistsRef.current;
        htmlSidecarExistsRef.current = true;
        if (isNew) await refreshWatchSet();
      }
      if (currentMarkdownRef.current === contents) setDirty(false);
      // A same-document mirror pane tracks the live editor through its
      // autosaves — the cheapest safe point to sync two Milkdown instances.
      {
        const s = splitRef.current;
        if (s && !s.doc && s.tabId === activeIdRef.current && s.view === "md") {
          refreshMirror(contents);
        }
      }
    } catch (e) {
      if ((pathRef.current) !== target) {
        const s = splitRef.current;
        if (s?.doc && s.doc.path === target && e instanceof SaveConflict) {
          setSplitState({
            ...s,
            doc: { ...s.doc, conflict: { theirs: e.current }, dirty: true },
          });
        }
        return;
      }
      if (e instanceof SaveConflict) {
        setConflict({ theirs: e.current });
      } else {
        console.error("autosave failed", e);
      }
    }
  }, [setSplitState, refreshMirror, writeMdThreadsToMeta, composeActiveMeta, refreshWatchSet]);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      if (conflictRef.current) return; // pause autosave while a conflict is unresolved
      const target = pathRef.current;
      if (!target) return;
      const snapshot = currentMarkdownRef.current;
      if (snapshot === lastSavedRef.current) return;
      void writeToDisk(target, snapshot);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [writeToDisk]);

  // Returns the write promise so callers that must not outrun the write (the
  // quit flush) can await it; fire-and-forget callers just ignore the result.
  // The editor's latest text is taken first (see catchUpWithEditor): a flush
  // that wrote the app's copy as it stood could miss the last keystrokes.
  const flushPendingAutosave = useCallback((): Promise<void> => {
    catchUpWithEditor();
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const target = pathRef.current;
    if (!target) return Promise.resolve();
    const snapshot = currentMarkdownRef.current;
    if (snapshot === lastSavedRef.current) return Promise.resolve();
    return writeToDisk(target, snapshot);
  }, [catchUpWithEditor, writeToDisk]);

  /* ---------- HTML rendition comments: meta load/save ----------
     The rendition's threads live in the entity meta file beside the document
     (hthread records — see htmlComments.ts and metaFile.ts) and follow the
     autosave pattern: HtmlView hands the app a new thread list, the app
     debounces a write. Writes are unconditional (last write wins) — the meta
     is append-mostly and low-stakes, and the watcher covers concurrent
     external edits by reloading whenever the file changes under us with no
     local write pending. */

  const applyHtmlThreads = useCallback((threads: HtmlThread[]) => {
    htmlThreadsRef.current = threads;
    setHtmlThreads(threads);
  }, []);

  // Adopt a width set as the active document's. The state half only matters
  // at the next editor MOUNT (the prop is read once); the ref half is what
  // every meta write composes from.
  const adoptTableWidths = useCallback((cols: TableCols[]) => {
    tableWidthsRef.current = cols;
    setTableWidths(cols);
  }, []);

  // Read an entity's meta from disk WITHOUT touching the active-doc refs
  // (missing file = no comments yet). Never writes.
  const readEntityMeta = useCallback(
    async (docPath: string): Promise<{ meta: EntityMeta; metaExists: boolean }> =>
      metaOf(await backend.documents.meta(docPath).catch(() => null)),
    [],
  );

  // Install a meta as the ACTIVE entity's, into the app refs. The
  // markdown-side split into live threads vs orphans needs the markdown text
  // — callers that have it pass it; an html-only document parks every mthread
  // record as a hidden orphan (unreachable without a markdown side, but never
  // dropped). Synchronous, so a caller can check it is still the one loading
  // between reading the meta and installing it.
  const adoptEntityMeta = useCallback(
    (meta: EntityMeta, metaExists: boolean, md: string | null) => {
      htmlSidecarExistsRef.current = metaExists;
      applyHtmlThreads(meta.hthreads);
      adoptTableWidths(meta.tcols);
      metaForeignRef.current = meta.foreign;
      if (md !== null) {
        const ids = markerIds(md);
        mdThreadsRef.current = meta.mthreads.filter((t) => ids.has(t.id));
        const orphans = meta.mthreads.filter((t) => !ids.has(t.id));
        mdOrphansRef.current = orphans;
        setMdOrphans(orphans);
      } else {
        mdThreadsRef.current = [];
        mdOrphansRef.current = meta.mthreads;
        setMdOrphans([]);
      }
    },
    [applyHtmlThreads, adoptTableWidths],
  );

  // Read an entity's meta and install it as the active one's (no document =
  // no meta).
  const loadEntityMeta = useCallback(
    async (docPath: string | null, md: string | null): Promise<EntityMeta> => {
      if (!docPath) {
        adoptEntityMeta(emptyMeta(), false, null);
        return emptyMeta();
      }
      const { meta, metaExists } = await readEntityMeta(docPath);
      adoptEntityMeta(meta, metaExists, md);
      return meta;
    },
    [adoptEntityMeta, readEntityMeta],
  );

  const writeSidecarNow = useCallback(async () => {
    const docPath = pathRef.current ?? htmlPathRef.current;
    if (!docPath) return;
    const meta = composeActiveMeta();
    // Deleting the last thread empties the file rather than deleting it (the
    // only remover the app has is the Trash — too loud for a sidecar); a doc
    // that never had comments never gets one.
    if (metaIsEmpty(meta) && !htmlSidecarExistsRef.current) return;
    try {
      await backend.documents.save(docPath, { meta: serializeEntityMeta(meta) }, null);
      const isNew = !htmlSidecarExistsRef.current;
      htmlSidecarExistsRef.current = true;
      if (isNew) await refreshWatchSet();
    } catch (e) {
      console.error("comment save failed", e);
    }
  }, [refreshWatchSet, composeActiveMeta]);

  const scheduleSidecarWrite = useCallback(() => {
    if (sidecarWriteTimerRef.current != null) {
      window.clearTimeout(sidecarWriteTimerRef.current);
    }
    sidecarWriteTimerRef.current = window.setTimeout(() => {
      sidecarWriteTimerRef.current = null;
      void writeSidecarNow();
    }, 400);
  }, [writeSidecarNow]);

  // Land a pending sidecar write before anything that retargets
  // htmlPathRef (tab switch, close, quit) — mirrors flushPendingAutosave.
  const flushSidecarWrite = useCallback((): Promise<void> => {
    if (sidecarWriteTimerRef.current == null) return Promise.resolve();
    window.clearTimeout(sidecarWriteTimerRef.current);
    sidecarWriteTimerRef.current = null;
    return writeSidecarNow();
  }, [writeSidecarNow]);



  // HtmlView reports every thread mutation here; disk follows.
  const onHtmlThreadsChange = useCallback(
    (next: HtmlThread[]) => {
      applyHtmlThreads(next);
      scheduleSidecarWrite();
    },
    [applyHtmlThreads, scheduleSidecarWrite],
  );

  // Orphaned markdown threads (meta records whose marker left the document)
  // live outside the editor; the rail's mutations on them land here and go
  // straight to the entity meta.
  const mutateMdOrphans = useCallback(
    (fn: (prev: MdThread[]) => MdThread[]) => {
      const next = fn(mdOrphansRef.current);
      mdOrphansRef.current = next;
      setMdOrphans(next);
      scheduleSidecarWrite();
    },
    [scheduleSidecarWrite],
  );

  const mdOrphanOps = useMemo(
    () => ({
      threads: mdOrphans,
      onReply: (id: string, author: string, body: string) => {
        const clean = sanitizeBody(body);
        if (!clean) return;
        mutateMdOrphans((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  comments: [
                    ...t.comments,
                    { author: sanitizeAuthor(author), at: Date.now(), body: clean },
                  ],
                }
              : t,
          ),
        );
      },
      onDeleteThread: (id: string) =>
        mutateMdOrphans((prev) => prev.filter((t) => t.id !== id)),
      onDeleteReply: (id: string, index: number) =>
        mutateMdOrphans((prev) =>
          prev.map((t) =>
            t.id === id && index > 0 && index < t.comments.length
              ? { ...t, comments: t.comments.filter((_, i) => i !== index) }
              : t,
          ),
        ),
      onUpdateBody: (id: string, index: number, body: string) =>
        mutateMdOrphans((prev) =>
          prev.map((t) => {
            const entry = t.comments[index];
            if (t.id !== id || !entry) return t;
            const next = t.comments.slice();
            next[index] = { ...entry, body: sanitizeBody(body) };
            return { ...t, comments: next };
          }),
        ),
    }),
    [mdOrphans, mutateMdOrphans],
  );

  // The focused pane's side: always opposite the split pane; left otherwise.
  const focusedSideOf = (s: SplitPane | null): PaneSide =>
    s ? otherSide(s.side) : "left";

  // Snapshot the active tab's scroll offset — call this synchronously BEFORE
  // anything that remounts the editor (tab switch, external reload). In html
  // view the editor is hidden and the wrap doesn't scroll (the iframe scrolls
  // internally) — capturing would clobber the saved markdown offset with 0.
  const captureActiveScroll = useCallback(() => {
    const id = activeIdRef.current;
    if (!id || docViewRef.current === "html") return;
    const wrap = wrapElsRef.current[focusedSideOf(splitRef.current)];
    if (wrap) scrollPositionsRef.current.set(id, wrap.scrollTop);
  }, []);

  // Restore the active tab's scroll offset. Runs from the editor's onReady; the
  // rAF re-apply covers Crepe finishing layout a frame after mount (a too-early
  // set gets clamped to 0 by a document that has no height yet).
  const restoreActiveScroll = useCallback(() => {
    const id = activeIdRef.current;
    const wrap = wrapElsRef.current[focusedSideOf(splitRef.current)];
    if (!wrap) return;
    const saved = (id ? scrollPositionsRef.current.get(id) : 0) ?? 0;
    wrap.scrollTop = saved;
    requestAnimationFrame(() => {
      wrap.scrollTop = saved;
    });
  }, []);

  // Same pair for the companion pane (its editor remounts on external
  // reloads, view flips, and mirror refreshes); offsets live under
  // companionScrollKey.
  const captureCompanionScroll = useCallback(() => {
    const s = splitRef.current;
    if (!s || s.view !== "md") return;
    const wrap = wrapElsRef.current[s.side];
    if (wrap) scrollPositionsRef.current.set(companionScrollKey(s), wrap.scrollTop);
  }, []);

  const restoreCompanionScroll = useCallback(() => {
    const s = splitRef.current;
    if (!s) return;
    const wrap = wrapElsRef.current[s.side];
    if (!wrap) return;
    const saved = scrollPositionsRef.current.get(companionScrollKey(s)) ?? 0;
    wrap.scrollTop = saved;
    requestAnimationFrame(() => {
      wrap.scrollTop = saved;
    });
  }, []);

  // Remount the FOCUSED pane's editor from the live machinery content.
  // Required with any layout change that moves the focused editor to the
  // other pane (React remounts it there): mounting from the stale
  // `initialMarkdown` state would resurrect the last LOADED content — and
  // the mount-time serialization would then autosave that stale text over
  // real edits. Callers MUST flushPendingAutosave() first: the remount
  // re-baselines on its mount serialization, so unflushed edits would
  // otherwise silently drop out of the save flow.
  const remountFocusedEditor = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    setInitialMarkdown(currentMarkdownRef.current);
    baselineCapturedRef.current = false;
    bumpEditorSeq(id);
    setLoadKey((k) => k + 1); // re-applies find highlights, zeroes the comment count
  }, [bumpEditorSeq]);

  // Flip a tab's `missing` flag (in place) and persist the session.
  const setTabMissing = useCallback((id: string, missing: boolean) => {
    const cur = tabsRef.current;
    if (!cur.some((t) => t.id === id && !!t.missing !== missing)) return;
    const next = cur.map((t) =>
      t.id === id && t.kind !== "untitled" ? { ...t, missing: missing || undefined } : t,
    );
    tabsRef.current = next;
    setTabs(next);
    writeStoredSession(next, activeIdRef.current);
  }, []);

  // Pack the whole active-document state into a CompanionDoc — the demote
  // half of a focus swap, and the materializer that turns a same-document
  // split into a two-document one when the focused side moves on. Reads refs
  // only, so it's safe from any event handler.
  const stashActiveDoc = useCallback((): CompanionDoc => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    return {
      path: tab?.path ?? "",
      kind: tab?.kind ?? "file",
      missing: tab?.missing === true,
      contents: currentMarkdownRef.current,
      snapshot: snapshotRef.current,
      htmlPath: htmlPathRef.current,
      hasHtml: htmlPathRef.current != null,
      htmlContent: htmlContentRef.current,
      threads: htmlThreadsRef.current,
      sidecarExists: htmlSidecarExistsRef.current,
      mdThreads: mdThreadsRef.current,
      mdOrphans: mdOrphansRef.current,
      tcols: tableWidthsRef.current,
      metaForeign: metaForeignRef.current,
      head: frontmatterRef.current,
      conflict: conflictRef.current,
      dirty: dirtyRef.current,
    };
  }, []);

  // Read a document from disk into a CompanionDoc for the split pane. A
  // failed read yields a missing record (the pane shows the ghost state and
  // retry re-runs this).
  const loadCompanionDoc = useCallback(
    async (tab: Tab, viewPref?: DocView): Promise<{ doc: CompanionDoc; view: DocView }> => {
      const htmlOnly = tab.kind === "file" && isHtmlPath(tab.path);
      // No document in this pane: the file is gone (the ghost state), or it
      // is not a document and is never read (see isUnsupportedTab).
      const noDocument = (missing: boolean): { doc: CompanionDoc; view: DocView } => ({
        doc: {
          path: tab.path,
          kind: tab.kind,
          missing,
          contents: "",
          snapshot: null,
          htmlPath: null,
          hasHtml: false,
          htmlContent: null,
          threads: [],
          sidecarExists: false,
          mdThreads: [],
          mdOrphans: [],
          tcols: [],
          metaForeign: [],
          head: "",
          conflict: null,
          dirty: false,
        },
        view: "md",
      });
      if (isUnsupportedTab(tab)) {
        return noDocument(!(await backend.documents.exists(tab.path).catch(() => false)));
      }
      let opened: LoadedDoc;
      try {
        opened = await openTabDoc(tab);
      } catch (e) {
        console.error("read failed", tab.path, e);
        return noDocument(true);
      }
      const contents = opened.text;
      const snapshot = opened.rev;
      const htmlPath = htmlOnly ? tab.path : tab.kind === "file" ? opened.rendition : null;
      const view: DocView =
        htmlOnly ||
        (htmlPath != null &&
          (viewPref === "html" ||
            (viewPref === undefined && viewPrefsRef.current.get(tab.path) === "html")))
          ? "html"
          : "md";
      let htmlContentValue: string | null = null;
      if (view === "html" && htmlPath) {
        htmlContentValue = htmlOnly
          ? contents
          : await backend.documents
              .read(htmlPath)
              .then((r) => r.text)
              .catch(() => null);
      }
      // The pane's threads and thread bodies come from the entity meta; the
      // pane editor gets EXPANDED markdown — same read boundary as the
      // active document.
      const { meta, metaExists } = metaOf(opened.meta);
      // The frontmatter boundary again: this pane's editor is handed the body,
      // and the block rides along in the record.
      const fm = splitFrontmatter(htmlOnly ? "" : contents);
      const full = htmlOnly ? "" : expandMarkdown(fm.body, meta.mthreads).md;
      const ids = htmlOnly ? new Set<string>() : markerIds(fm.body);
      return {
        doc: {
          path: tab.path,
          kind: tab.kind,
          missing: false,
          contents: full,
          snapshot: htmlOnly ? null : snapshot,
          htmlPath,
          hasHtml: htmlPath != null,
          htmlContent: view === "html" ? htmlContentValue : null,
          threads: meta.hthreads,
          sidecarExists: metaExists,
          mdThreads: meta.mthreads.filter((t) => ids.has(t.id)),
          mdOrphans: htmlOnly
            ? meta.mthreads
            : meta.mthreads.filter((t) => !ids.has(t.id)),
          tcols: meta.tcols,
          metaForeign: meta.foreign,
          head: htmlOnly ? "" : fm.head,
          conflict: null,
          dirty: false,
        },
        view: view === "html" && htmlContentValue === null && !htmlOnly ? "md" : view,
      };
    },
    [],
  );

  // A same-document split whose focused side is moving to ANOTHER tab: the
  // remaining pane keeps showing the outgoing document, so it needs its own
  // record from here on (a two-document companion). A markdown pane keeps
  // its place: its offset moves onto the tab key the companion editor
  // restores from.
  const materializeSameDocSplit = useCallback(() => {
    const s = splitRef.current;
    if (!s || s.doc || s.tabId !== activeIdRef.current) return;
    if (s.view === "md") {
      const wrap = wrapElsRef.current[s.side];
      if (wrap) scrollPositionsRef.current.set(s.tabId, wrap.scrollTop);
    }
    setSplitState({ ...s, doc: stashActiveDoc() });
    companionMdRef.current = {
      md: currentMarkdownRef.current,
      baseline: lastSavedRef.current,
      baselined: true,
    };
  }, [setSplitState, stashActiveDoc]);

  // Make `tab` the active document in the (single) editor: read its content from
  // disk, reset the per-doc refs, and remount the editor. Watch only real files.
  // A failed read doesn't drop the tab — it becomes a "ghost" (missing) tab with
  // no document loaded; a later activation retries and recovers automatically.
  const loadActiveContent = useCallback(async (tab: Tab) => {
    const ticket = ++loadTicketRef.current;
    const superseded = () => ticket !== loadTicketRef.current;
    loadedIdRef.current = null; // nobody's changes count until this load lands
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    // A pending comment write still targets the PREVIOUS document's sidecar
    // (htmlPathRef switches below) — land it first.
    await flushSidecarWrite();
    if (superseded()) return;
    // An html-only document: rendered read-only, never loaded into the
    // markdown editor and never an autosave target (pathRef stays null).
    const htmlOnly = tab.kind === "file" && isHtmlPath(tab.path);
    // A file that is not a document is never read: its tab only says so
    // (or, once it is gone, is a ghost like any other).
    const unsupported = isUnsupportedTab(tab);

    let opened: LoadedDoc | null = null;
    let failed = false;
    if (unsupported) {
      failed = !(await backend.documents.exists(tab.path).catch(() => false));
    } else {
      try {
        opened = await openTabDoc(tab);
      } catch (e) {
        failed = true;
        console.error("read failed", tab.path, e);
      }
    }
    // Everything is read; from here to the editor's key the document is
    // installed in one go — unless a newer load has started meanwhile.
    if (superseded()) return;
    if (opened === null) {
      // No document: pathRef stays null so autosave can't write (or recreate)
      // the file, and nothing is watched. The editor is not rendered — the
      // pane shows the ghost state, or that the file isn't a document.
      setTabMissing(tab.id, failed);
      adoptFrontmatter("");
      baselineCapturedRef.current = false;
      pathRef.current = null;
      currentMarkdownRef.current = "";
      lastSavedRef.current = "";
      snapshotRef.current = null;
      lastDiskMdRef.current = "";
      setInitialMarkdown("");
      setDirty(false);
      setConflict(null);
      htmlPathRef.current = null;
      setHtmlContent(null);
      setHasHtml(false);
      adoptEntityMeta(emptyMeta(), false, null);
      applyDocView("md");
      await refreshWatchSet(); // nothing active to watch (a split pane may remain)
      return;
    }
    setTabMissing(tab.id, false); // the file is back (or was never gone)

    const contents = opened.text;
    const snapshot = opened.rev;
    // The document's html rendition: the MD/HTML toggle and the watch set
    // both need it.
    const htmlPath = htmlOnly ? tab.path : tab.kind === "file" ? opened.rendition : null;
    const { meta, metaExists } = metaOf(opened.meta);
    // The frontmatter boundary: split the leading block off the top and keep
    // it in the refs. Everything below — the meta layer, the editor, the disk
    // baseline — works on the BODY alone, so prose edits can never rewrite
    // properties and property edits never touch the prose.
    const body = adoptFrontmatter(htmlOnly ? "" : contents).body;
    adoptEntityMeta(meta, metaExists, htmlOnly ? null : body);
    // The editor speaks full CriticMarkup; the disk keeps the hybrid form
    // (markers only). Expand thread bodies from the meta records here, at the
    // read boundary — see metaFile.ts.
    const full = htmlOnly ? "" : expandMarkdown(body, meta.mthreads).md;
    baselineCapturedRef.current = false;
    pathRef.current = htmlOnly ? null : tab.path;
    currentMarkdownRef.current = full;
    lastSavedRef.current = full;
    snapshotRef.current = htmlOnly ? null : snapshot;
    lastDiskMdRef.current = body;
    setInitialMarkdown(full);
    setDirty(false);
    setConflict(null);
    htmlPathRef.current = htmlPath;
    setHasHtml(htmlPath != null);
    const view: DocView =
      htmlOnly || (htmlPath != null && viewPrefsRef.current.get(tab.path) === "html")
        ? "html"
        : "md";
    applyDocView(view);
    if (view === "html" && htmlPath) {
      if (htmlOnly) {
        setHtmlContent(contents);
      } else {
        const rendition = await backend.documents.read(htmlPath).then(
          (r) => r.text,
          (e) => {
            console.error("read failed", htmlPath, e);
            return null;
          },
        );
        if (superseded()) return;
        setHtmlContent(rendition);
        if (rendition === null) applyDocView("md");
      }
    } else {
      setHtmlContent(null);
    }
    bumpEditorSeq(tab.id); // remount the focused pane's editor with the fresh content
    loadedIdRef.current = tab.id; // …and that instance is the one to listen to
    setLoadKey((k) => k + 1);

    // Watch the document set: the markdown for the edit/conflict flow, the
    // rendition so external regeneration re-renders live, the entity meta so
    // threads delivered from outside pop in — plus the
    // split pane's set. An untitled note's buffer has no other writer, so it
    // isn't watched.
    await refreshWatchSet();
  }, [
    setTabMissing,
    adoptFrontmatter,
    applyDocView,
    flushSidecarWrite,
    adoptEntityMeta,
    refreshWatchSet,
    bumpEditorSeq,
  ]);

  // Re-materialize stored tab descriptors against disk: a readable file
  // keeps its tab, an unreadable one becomes a visible ghost, and an
  // untitled note comes back — titled, and unsaved — if its buffer still has
  // text in it. Shared by the startup restore and in-app workspace switches.
  const rebuildTabs = useCallback(async (stored: StoredTab[]): Promise<Tab[]> => {
    const out: Tab[] = [];
    for (const { id, kind, path } of stored) {
      if (kind === "untitled") {
        const note = await restoreUntitled(id, path);
        if (note) out.push(note);
        continue;
      }
      const readable = isUnsupportedTab({ kind, path })
        ? await backend.documents.exists(path).catch(() => false)
        : await backend.documents.read(path).then(
            () => true,
            () => false,
          );
      out.push({ id, kind, path, missing: readable ? undefined : true });
    }
    return out;
  }, []);

  // Reset to the "no document open" state (welcome screen). Clears the per-doc
  // refs so autosave is a no-op and unmounts the editor.
  const clearActiveDoc = useCallback(async () => {
    const ticket = ++loadTicketRef.current;
    loadedIdRef.current = null;
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await flushSidecarWrite();
    if (ticket !== loadTicketRef.current) return; // a document started loading meanwhile
    pathRef.current = null;
    currentMarkdownRef.current = "";
    lastSavedRef.current = "";
    snapshotRef.current = null;
    lastDiskMdRef.current = "";
    adoptFrontmatter("");
    baselineCapturedRef.current = false;
    setInitialMarkdown("");
    setDirty(false);
    setConflict(null);
    htmlPathRef.current = null;
    setHtmlContent(null);
    setHasHtml(false);
    adoptEntityMeta(emptyMeta(), false, null);
    applyDocView("md");
    await refreshWatchSet(); // drops the active set; keeps a split pane's watch alive
  }, [adoptFrontmatter, applyDocView, flushSidecarWrite, adoptEntityMeta, refreshWatchSet]);

  const switchTab = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      const s = splitRef.current;
      // The tab is already open in the split pane: reveal = move focus there
      // (never load the same document into both panes).
      if (s && s.tabId === id && s.doc) {
        await swapFocusRef.current();
        return;
      }
      const target = tabsRef.current.find((t) => t.id === id);
      if (!target) return;
      captureActiveScroll(); // remember where the outgoing doc was scrolled
      flushPendingAutosave(); // persist the outgoing doc before switching
      // A same-document split whose focused side is moving on: the other
      // pane stays behind showing the outgoing document — give it its own
      // record.
      materializeSameDocSplit();
      activeIdRef.current = id;
      setActiveId(id);
      writeStoredSession(tabsRef.current, id);
      await loadActiveContent(target);
    },
    [captureActiveScroll, flushPendingAutosave, loadActiveContent, materializeSameDocSplit],
  );

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle to the next/previous tab in this window,
  // wrapping around (linear tab-bar order). No-op with fewer than two tabs.
  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      const list = tabsRef.current;
      if (list.length < 2) return;
      const idx = list.findIndex((t) => t.id === activeIdRef.current);
      const start = idx < 0 ? 0 : idx;
      const next = (start + dir + list.length) % list.length;
      void switchTab(list[next].id);
    },
    [switchTab],
  );

  // Drag-to-reorder from the tab bar: adopt the new order (same tabs, same
  // active doc — nothing to load or flush) and persist it.
  const reorderTabs = useCallback((nextOrder: Tab[]) => {
    tabsRef.current = nextOrder;
    setTabs(nextOrder);
    writeStoredSession(nextOrder, activeIdRef.current);
  }, []);

  // Append a freshly-built tab and make it active.
  const appendAndActivate = useCallback(
    async (tab: Tab) => {
      captureActiveScroll(); // remember where the outgoing doc was scrolled
      flushPendingAutosave(); // persist the outgoing doc before switching
      // Same-document split: the other pane keeps the outgoing document —
      // give it its own record (see switchTab).
      materializeSameDocSplit();
      const nextTabs = [...tabsRef.current, tab];
      tabsRef.current = nextTabs;
      activeIdRef.current = tab.id;
      setTabs(nextTabs);
      setActiveId(tab.id);
      writeStoredSession(nextTabs, tab.id);
      await loadActiveContent(tab);
    },
    [captureActiveScroll, flushPendingAutosave, loadActiveContent, materializeSameDocSplit],
  );

  // Open a file in a tab (dedupe by path): from the picker, the sidebar, a
  // link, the CLI.
  const openTab = useCallback(
    async (p: string) => {
      // An html file whose markdown sibling exists is a rendition of THAT
      // document — open the pair as one tab keyed on the markdown path,
      // starting on the view the user actually asked for.
      if (isHtmlPath(p)) {
        const md = mdSiblingOf(p);
        const paired = await backend.documents.exists(md).catch(() => false);
        if (paired) {
          viewPrefsRef.current.set(md, "html");
          p = md;
        }
      }
      const existing = tabsRef.current.find((t) => t.path === p);
      if (existing) {
        if (existing.id === activeIdRef.current) {
          // Re-opening the already-active tab is a no-op — unless it's a ghost,
          // where it doubles as "the file might be back, try reading again".
          if (existing.missing) await loadActiveContent(existing);
        } else {
          await switchTab(existing.id);
        }
        return;
      }
      await appendAndActivate({ id: uuid(), kind: "file", path: p });
    },
    [switchTab, appendAndActivate, loadActiveContent],
  );

  // ⌘N: a new untitled note, in a new tab. Nothing is written for it until
  // something is typed into it. An untitled note that is still empty IS a new
  // note, so asking for another while on one changes nothing.
  const newUntitled = useCallback(async () => {
    if (!backend.untitled) return;
    catchUpWithEditor();
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (active?.kind === "untitled" && !noteHasText(currentMarkdownRef.current)) return;
    const id = uuid();
    await appendAndActivate({
      id,
      kind: "untitled",
      path: untitledPathFor(id),
      title: "",
      unsaved: false,
    });
  }, [catchUpWithEditor, appendAndActivate]);

  const selectSidebarEntries = useCallback((sels: SidebarSelection[]) => {
    sidebarSelectionRef.current = sels;
    setSidebarSelection(sels);
  }, []);

  // Opens from outside the app (`doklin open`, Finder, a link in a browser's
  // address) that the backend placed in this window: a file as its tab, a
  // folder of this workspace shown in the sidebar. Taken once the window is
  // ready and again each time something arrives. One that cannot be shown is
  // said in the backend's own sentence.
  const [revealRequest, setRevealRequest] = useState<{ path: string; seq: number } | null>(null);
  const openTabRef = useRef(openTab);
  useEffect(() => {
    openTabRef.current = openTab;
  }, [openTab]);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const outside = backend.shows;
    if (!outside) return;
    const take = async () => {
      const shows = await outside.take().catch((e) => {
        pushToast("warn", errText(e));
        return [];
      });
      for (const show of shows) {
        if (!live) return;
        if (show.kind === "folder") {
          setSidebarOpen(true);
          setSidebarMode("files");
          selectSidebarEntries([{ path: show.path, kind: "dir" }]);
          setRevealRequest((r) => ({ path: show.path, seq: (r?.seq ?? 0) + 1 }));
        } else {
          await openTabRef.current(show.path);
        }
      }
    };
    void take();
    const un = outside.onArrive(() => void take());
    return () => {
      live = false;
      un();
    };
  }, [ready, selectSidebarEntries, pushToast]);

  const setWorkspace = useCallback((root: string) => {
    sessionWorkspaceRoot = root;
    setWorkspaceRoot(root);
    setSidebarOpen(true);
    selectSidebarEntries([]); // a selection from the previous workspace is meaningless
    writeStoredSession(tabsRef.current, activeIdRef.current); // the root is part of the session
  }, [selectSidebarEntries]);

  // Switch this window to a different workspace folder (File ▸ Open Folder,
  // the sidebar). Because tabs are keyed by folder, we persist the
  // outgoing folder's tabs under its own key, then load and install the incoming
  // folder's — the same directory-scoped model a `doklin <dir>` launch uses.
  // Document content lives on disk and autosaves, so swapping the tab set never
  // loses edits. Untitled notes are the exception to "keyed by folder": a note
  // with no file belongs to the window, not to a folder, so it stays open
  // across the switch rather than vanishing into the outgoing folder's tabs.
  const openWorkspace = useCallback(
    async (root: string) => {
      if (root === sessionWorkspaceRoot) {
        setWorkspace(root); // already here — just resurface the sidebar
        return;
      }
      flushPendingAutosave(); // land the outgoing doc before we swap tabs
      captureActiveScroll();
      // Persist the outgoing workspace under its own key before switching, so
      // returning to it later restores exactly these tabs (split included —
      // the module mirror still holds the outgoing one). Its untitled notes
      // are not among them: they stay with the window.
      writeStoredSession(
        tabsRef.current.filter((t) => !isUntitled(t)),
        activeIdRef.current,
      );
      // From here session writes target the incoming folder. Drop the split
      // WITHOUT persisting (tabsRef still holds the outgoing tabs; a write
      // now would stamp them into the incoming key).
      splitRef.current = null;
      setSplit(null);
      sessionSplit = null;
      const session = readStoredSession(root);
      sessionWorkspaceRoot = root;
      // The incoming folder's own tabs, then the notes that stayed. (A stored
      // session read here never brings untitled notes of its own: any it
      // names are either among the ones staying or long gone.) The notes are
      // taken from the tabs as they stand once the folder's have been read —
      // one of them may have been typed in meanwhile.
      const incoming = await rebuildTabs(session.tabs.filter((t) => t.kind !== "untitled"));
      const staying = tabsRef.current.filter(isUntitled);
      const stayingActive = staying.find((t) => t.id === activeIdRef.current)?.id ?? null;
      const restored = [...incoming, ...staying];
      // A note being written stays in front; otherwise the folder comes back
      // on the tab it was left on.
      const activeId =
        restored.length === 0
          ? null
          : stayingActive ??
            (session.activeId && restored.some((t) => t.id === session.activeId)
              ? session.activeId
              : restored[restored.length - 1].id);
      tabsRef.current = restored;
      activeIdRef.current = activeId;
      setTabs(restored);
      setActiveId(activeId);
      setWorkspace(root); // adopt root, open sidebar, persist session
      const active = restored.find((t) => t.id === activeId);
      if (active) await loadActiveContent(active);
      else await clearActiveDoc(); // incoming folder has no tabs → welcome screen
      // Reinstate the incoming folder's split, if its tabs survived.
      const sp = session.split ?? null;
      if (sp && restored.some((t) => t.id === sp.tabId)) {
        if (sp.tabId === activeId) {
          await splitSameDocRef.current(sp.side, sp.view);
        } else {
          await openInPaneRef.current(sp.tabId, sp.side, sp.view);
        }
      }
    },
    [
      flushPendingAutosave,
      captureActiveScroll,
      rebuildTabs,
      setWorkspace,
      loadActiveContent,
      clearActiveDoc,
    ],
  );

  const openFolderPicker = useCallback(async () => {
    try {
      const chosen = await backend.localFiles?.pickFolder();
      if (chosen) await openWorkspace(chosen);
    } catch (e) {
      console.error("open folder failed", e);
    }
  }, [openWorkspace]);

  const openFilePicker = useCallback(async () => {
    try {
      const chosen = await backend.localFiles?.pickDocument();
      if (chosen) await openTab(chosen);
    } catch (e) {
      console.error("open file failed", e);
    }
  }, [openTab]);

  // Open in a NEW window (⌘⌥O / ⌘⌥⇧O). The backend focuses an existing window
  // already showing the path, or spawns a fresh one — so the same file/folder is
  // never opened twice.
  const openFileInNewWindow = useCallback(async () => {
    if (!backend.windows) return;
    try {
      const chosen = await backend.localFiles?.pickDocument();
      if (chosen) await backend.windows.openInNew({ file: chosen });
    } catch (e) {
      console.error("open file in new window failed", e);
    }
  }, []);

  const openFolderInNewWindow = useCallback(async () => {
    if (!backend.windows) return;
    try {
      const chosen = await backend.localFiles?.pickFolder();
      if (chosen) await backend.windows.openInNew({ folder: chosen });
    } catch (e) {
      console.error("open folder in new window failed", e);
    }
  }, []);

  // Copy the document verbatim — CriticMarkup markers and comments intact (the
  // "full" working format for collaborators using the same tool). Plain ⌘C, by
  // contrast, always copies clean (markers stripped) via the editor's copy hook.
  const copyWithComments = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentMarkdownRef.current);
    } catch (e) {
      console.error("copy with comments failed", e);
    }
  }, []);

  const revealInFinder = useCallback(async (target: string) => {
    try {
      await backend.localFiles?.reveal(target);
    } catch (e) {
      console.error("reveal failed", e);
    }
  }, []);

  const openExternal = useCallback((url: string) => {
    void backend.openExternal(url).catch((e) => console.error("open external failed", e));
  }, []);

  // *Copy link* on a file: the link that opens it in Doklin, and who that is
  // for. A file made a moment ago is synced first, so this can take a beat.
  // The clipboard write starts inside the click, handed the link still on its
  // way: WebKit refuses a write that starts only once the link is back ("The
  // request is not allowed by the user agent…"), as the click no longer
  // counts by then. Nothing may be awaited before `clipboard.write`.
  const copyPageLink = useCallback(
    async (path: string) => {
      const link = backend.cloud.link(path);
      const written = navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": link.then((l) => new Blob([l.url], { type: "text/plain" })),
        }),
      ]);
      try {
        // A refused link refuses the write too, but only after it, so the
        // toast gives the link's own reason.
        const [{ who }] = await Promise.all([link, written]);
        pushToast("done", `Link copied. ${who}`);
      } catch (e) {
        pushToast("error", `Couldn't copy a link to ${basename(path)}: ${errText(e)}.`);
      }
    },
    [pushToast],
  );

  // A link the reader clicked inside a note (see linkOpen.ts for which clicks
  // count as following one). Notion's split, applied to files: an external URL
  // leaves for the browser or mail client, an internal one — a markdown/html
  // file next to the note — opens in a tab right here. Anything else is left
  // alone: a link to a .png or a missing file does nothing rather than
  // guessing, and a foreign scheme (javascript:, data:, a custom app scheme)
  // is never handed to the OS.
  const followDocLink = useCallback(
    async (href: string, fromPath: string | null) => {
      const url = href.trim();
      if (/^(https?:|mailto:)/i.test(url)) {
        openExternal(url);
        return;
      }
      const target = linkTargetPath(url, fromPath);
      if (!target || !(MD_EXT_RE.test(target) || HTML_EXT_RE.test(target))) return;
      try {
        if (await backend.documents.exists(target)) {
          await openTab(target);
        }
      } catch (e) {
        console.error("open linked document failed", e);
      }
    },
    [openExternal, openTab],
  );


  const reloadFromDisk = useCallback(async () => {
    const target = pathRef.current;
    if (!target) return;
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    // The reload remounts the editor; re-capture first so the reader stays at
    // the same place in the externally-changed document instead of jumping up.
    captureActiveScroll();
    try {
      const result = await backend.documents.read(target);
      // What is stored is hybrid markdown; refresh the meta alongside it and
      // hand the editor the expanded form (same boundary as the first load).
      const body = adoptFrontmatter(result.text).body;
      const meta = await loadEntityMeta(target, body);
      const full = expandMarkdown(body, meta.mthreads).md;
      baselineCapturedRef.current = false;
      setInitialMarkdown(full);
      currentMarkdownRef.current = full;
      lastSavedRef.current = full;
      snapshotRef.current = result.rev;
      lastDiskMdRef.current = body;
      setDirty(false);
      setConflict(null);
      if (activeIdRef.current) bumpEditorSeq(activeIdRef.current);
      setLoadKey((k) => k + 1);
      // A same-document mirror shows the same file — follow the reload.
      {
        const s = splitRef.current;
        if (s && !s.doc && s.tabId === activeIdRef.current && s.view === "md") {
          refreshMirror(full);
        }
      }
    } catch (e) {
      console.error("reload failed", e);
    }
  }, [
    captureActiveScroll,
    bumpEditorSeq,
    refreshMirror,
    loadEntityMeta,
    adoptFrontmatter,
  ]);

  /* ---------- Version history ---------- */

  // The rail, for a file reached from the sidebar, a tab or ⌘⌥H. It always
  // opens on the list: a rail is somewhere to look, not a jump to a version.
  const openHistory = useCallback(
    async (path: string) => {
      if (!backend.versions) return;
      setVersionPreview(null);
      // A version shows in the document area, so the document has to be the
      // one standing in it: opening history for a file in the tree opens the
      // file too.
      if (historyTargetRef.current !== path) await openTab(path);
      setHistoryFor(path);
      setHistoryToken((t) => t + 1);
    },
    [openTab],
  );

  const closeHistory = useCallback(() => {
    setHistoryFor(null);
    setVersionPreview(null);
  }, []);

  // ⌘⌥H, the third way in: a toggle for the file that is open.
  const toggleHistory = useCallback(() => {
    if (historyForRef.current) {
      closeHistory();
      return;
    }
    const target = historyTargetRef.current;
    if (target) void openHistory(target);
  }, [closeHistory, openHistory]);

  // Selecting a version shows it where the document is. The live editor's
  // pending autosave lands FIRST: what has been typed since the last
  // capture has to be on disk before a restore can promise to bring it back.
  const previewVersion = useCallback(
    (version: FileVersion, root: string, newer: FileVersion | null) => {
      void flushPendingAutosave();
      const docPath = historyForRef.current;
      if (!docPath) return;
      setVersionPreview({ version, newer, root, docPath });
    },
    [flushPendingAutosave],
  );

  // Undoing a restore is another restore — of the state the first one left.
  // The timeline is the undo; ⌘Z is not
  // promised for it.
  const undoRestore = useCallback(
    async (docPath: string, root: string, outcome: RestoreOutcome) => {
      if (outcome.preRestoreHash == null) return;
      try {
        await backend.versions?.restoreFile(root, docPath, {
          ts: outcome.preRestoreTs,
          hash: outcome.preRestoreHash,
        });
        setHistoryToken((t) => t + 1);
      } catch (e) {
        pushToast("error", `Couldn't undo that restore: ${errText(e)}`);
      }
    },
    [pushToast],
  );

  // One Rust command does all three steps — capture what is here, write the
  // old bytes, capture what that made — because the cadence must not get
  // between them.
  const restoreVersion = useCallback(
    async (docPath: string, root: string, version: FileVersion, text: string | null) => {
      const versions = backend.versions;
      if (!versions) return;
      try {
        const outcome = await versions.restoreFile(root, docPath, {
          ts: version.ts,
          // Only a version this Mac's own store holds can be named by its
          // hash; a mirrored one and a manifest revision arrive as text.
          hash: version.source === "local" ? version.hash : null,
          text,
        });
        setVersionPreview(null);
        setHistoryToken((t) => t + 1);
        pushToast("done", `Restored the version from ${momentLabel(version.ts)}.`, {
          label: "Undo",
          run: () => void undoRestore(docPath, root, outcome),
        });
      } catch (e) {
        pushToast("error", `Couldn't restore that version: ${errText(e)}`);
      }
    },
    [pushToast, undoRestore],
  );

  /* ---------- The workspace, as it was ------ */

  // Read once, for both surfaces: the sidebar's row wants the count and the
  // column wants the list, and working it out is a walk of the retained
  // snapshots. Re-read whenever the tree does — a restore, a delete and a
  // sync all bump that token.
  useEffect(() => {
    const versions = backend.versions;
    if (!workspaceRoot || !versions) {
      setDeletedFiles([]);
      return;
    }
    let cancelled = false;
    void versions
      .deleted(workspaceRoot)
      .then((files) => {
        if (!cancelled) setDeletedFiles(files);
      })
      // A folder whose versioner hasn't started yet simply has no row.
      .catch(() => {
        if (!cancelled) setDeletedFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, treeRefreshToken]);
  // A section's own deleted files, read while its column is showing.
  useEffect(() => {
    const versions = backend.versions;
    if (!deletedFor || !versions) {
      setSectionDeleted([]);
      return;
    }
    let cancelled = false;
    void versions
      .deleted(deletedFor)
      .then((files) => {
        if (!cancelled) setSectionDeleted(files);
      })
      .catch(() => {
        if (!cancelled) setSectionDeleted([]);
      });
    return () => {
      cancelled = true;
    };
  }, [deletedFor, treeRefreshToken]);

  // The stores' statuses, read when the settings surface opens. The event
  // keeps them current while it is open, and asking at boot would only race
  // the manager's own init.
  useEffect(() => {
    const versions = backend.versions;
    if (!versionsSettingsOpen || !versions) return;
    let cancelled = false;
    void versions
      .status()
      .then((s) => {
        if (!cancelled) setVersionStatuses(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [versionsSettingsOpen]);

  // The last content of a deleted file, read-only — the same preview a
  // version gets, over the focused pane because the file has no tab.
  const previewDeleted = useCallback(
    (file: DeletedFile, root: string) => {
      void flushPendingAutosave();
      setVersionPreview({
        root,
        docPath: `${root}/${file.path}`,
        detached: true,
        newer: null,
        version: {
          ts: file.lastSeenMs,
          hash: file.hash,
          size: file.size,
          by: "",
          reason: "",
          label: null,
          pinned: false,
          restoredFrom: null,
          path: file.path,
          source: "local",
          current: false,
        },
      });
    },
    [flushPendingAutosave],
  );

  // Undoing a workspace restore is another workspace restore — of the
  // snapshot the first one left, with the same paths.
  const undoSnapshotRestore = useCallback(
    async (root: string, report: RestoreReport, paths: string[] | null) => {
      if (report.preRestoreTs == null) return;
      try {
        await backend.versions?.restoreSnapshot(root, report.preRestoreTs, paths);
      } catch (e) {
        pushToast("error", `Couldn't undo that restore: ${errText(e)}`);
      }
    },
    [pushToast],
  );

  const snapshotRestored = useCallback(
    (root: string, report: RestoreReport, paths: string[] | null) => {
      const moved = [
        report.written > 0 && `${report.written} file${report.written === 1 ? "" : "s"} written`,
        report.trashed > 0 && `${report.trashed} moved to the Trash`,
      ].filter(Boolean) as string[];
      pushToast(moved.length ? "done" : "info", moved.length ? `Restored — ${moved.join(", ")}.` : "Nothing needed changing.", {
        label: "Undo",
        run: () => void undoSnapshotRestore(root, report, paths),
      });
    },
    [pushToast, undoSnapshotRestore],
  );

  const keepMyVersion = useCallback(() => {
    const c = conflictRef.current;
    if (c) snapshotRef.current = c.theirs;
    setConflict(null);
    if (currentMarkdownRef.current !== lastSavedRef.current) {
      scheduleAutosave();
    }
  }, [scheduleAutosave]);


  // The MD/HTML view toggle for the active document. Switching to HTML
  // re-reads the rendition (freshest copy) and hides — not unmounts — the
  // markdown editor, so switching back is instant and keeps cursor, undo
  // history, and any unsaved state.
  const selectDocView = useCallback(
    async (v: DocView) => {
      if (v === docViewRef.current) return;
      // Same-document split, focused pane switching to html while the OTHER
      // pane shows markdown: the live editor must stay with the markdown
      // view (two editable Milkdown instances of one doc can't coexist), so
      // the panes swap ROLES instead — the markdown pane becomes the
      // focused/live side, this pane becomes the html split pane. Visually
      // each pane keeps showing exactly what the user chose.
      const sp = splitRef.current;
      if (sp && !sp.doc && sp.tabId === activeIdRef.current && v === "html") {
        if (sp.view === "md") {
          const htmlPath = htmlPathRef.current;
          if (!htmlPath) return;
          // Awaited: the meta reload below re-reads the entity from disk,
          // and a still-in-flight autosave (markdown + thread bodies) must
          // land first or the reload adopts a stale thread set.
          await flushPendingAutosave();
          let contents: string;
          try {
            contents = (await backend.documents.read(htmlPath)).text;
          } catch (e) {
            console.error("read failed", htmlPath, e);
            return;
          }
          await flushSidecarWrite();
          await loadEntityMeta(
            pathRef.current ?? htmlPath,
            pathRef.current ? currentMarkdownRef.current : null,
          );
          setHtmlContent(contents);
          // The surviving markdown pane keeps ITS reading position: the live
          // editor remounts over there and restores from the tab key.
          const mirrorWrap = wrapElsRef.current[sp.side];
          if (mirrorWrap) {
            scrollPositionsRef.current.set(sp.tabId, mirrorWrap.scrollTop);
          }
          remountFocusedEditor();
          setSplitState({
            side: otherSide(sp.side),
            tabId: sp.tabId,
            view: "html",
            doc: null,
          });
          return;
        }
        // Other pane already shows html → fall through to the normal html
        // switch (both panes on html renders two live previews).
      }
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!tab) return;
      if (v === "html") {
        const htmlPath = htmlPathRef.current;
        if (!htmlPath) return; // no rendition — the toggle side is disabled
        captureActiveScroll(); // remember the markdown offset before hiding it
        // Awaited for the same reason as the pane-swap branch above: the
        // meta reload must see this document's landed thread bodies.
        await flushPendingAutosave();
        setFindOpen(false);
        setFindQuery(""); // find targets the markdown editor only
        let contents: string;
        try {
          contents = (await backend.documents.read(htmlPath)).text;
        } catch (e) {
          console.error("read failed", htmlPath, e);
          return; // the rendition is gone; stay on markdown
        }
        // Freshen the comment threads along with the rendition (same doc, so
        // land any pending write first — the reload round-trips it).
        await flushSidecarWrite();
        await loadEntityMeta(
          pathRef.current ?? htmlPath,
          pathRef.current ? currentMarkdownRef.current : null,
        );
        setHtmlContent(contents);
        applyDocView("html");
        viewPrefsRef.current.set(tab.path, "html");
      } else {
        if (tab.kind === "file" && isHtmlPath(tab.path)) return; // html-only doc
        applyDocView("md");
        viewPrefsRef.current.set(tab.path, "md");
        restoreActiveScroll(); // the wrap regained height; put the reader back
      }
    },
    [
      captureActiveScroll,
      flushPendingAutosave,
      applyDocView,
      restoreActiveScroll,
      flushSidecarWrite,
      loadEntityMeta,
      remountFocusedEditor,
      setSplitState,
    ],
  );

  /* ---------- Split view operations ---------- */

  // Swap which pane holds the FOCUSED document (two-document splits only —
  // a same-document split has one machinery and nothing to swap). A pure
  // role exchange: neither editor remounts (keys are per-document), so
  // caret, scroll, and undo history survive in both panes. By default the
  // panes stay physically put (split.side flips); `toFocusSide` pins the
  // promoted document to a specific side instead (drag-and-drop placement).
  const swapFocus = useCallback(
    async (toFocusSide?: PaneSide) => {
      const s = splitRef.current;
      if (!s || !s.doc) return;
      const incoming = s.doc;
      const incomingTabId = s.tabId;
      const incomingView = s.view;
      const incomingMd = companionMdRef.current;
      // Outgoing flushes read their targets synchronously; the writes land
      // later and commit into the stashed record (see writeToDisk).
      flushPendingAutosave();
      void flushSidecarWrite();
      captureActiveScroll();
      editorRef.current?.clearSearch(); // highlights follow focus, not the pane
      // Stash the outgoing document, hydrate the machinery from the incoming.
      const outgoing = stashActiveDoc();
      const outgoingTabId = activeIdRef.current;
      const outgoingView = docViewRef.current;
      companionMdRef.current = {
        md: currentMarkdownRef.current,
        baseline: lastSavedRef.current,
        baselined: baselineCapturedRef.current,
      };
      const incomingHtmlOnly = incoming.kind === "file" && isHtmlPath(incoming.path);
      pathRef.current =
        incoming.missing || incomingHtmlOnly || isUnsupportedTab(incoming) ? null : incoming.path;
      snapshotRef.current = incoming.snapshot;
      currentMarkdownRef.current = incomingMd.baselined ? incomingMd.md : incoming.contents;
      lastSavedRef.current = incomingMd.baselined ? incomingMd.baseline : incoming.contents;
      baselineCapturedRef.current = incomingMd.baselined;
      setInitialMarkdown(incoming.contents);
      htmlPathRef.current = incoming.htmlPath;
      setHasHtml(incoming.hasHtml);
      setHtmlContent(incoming.htmlContent);
      htmlContentRef.current = incoming.htmlContent;
      htmlThreadsRef.current = incoming.threads;
      setHtmlThreads(incoming.threads);
      htmlSidecarExistsRef.current = incoming.sidecarExists;
      mdThreadsRef.current = incoming.mdThreads;
      mdOrphansRef.current = incoming.mdOrphans;
      setMdOrphans(incoming.mdOrphans);
      // The promoted document's frontmatter block becomes the one the writers
      // re-attach; without this the next save would prepend the demoted
      // document's block to this one.
      frontmatterRef.current = incoming.head;
      setFrontmatter(splitFrontmatter(incoming.head).inner);
      // The promoted pane keeps its mounted editor (no remount on a swap), so
      // this only re-points the meta writer at the incoming document's
      // records — the widths on screen are already the ones it mounted with.
      adoptTableWidths(incoming.tcols);
      metaForeignRef.current = incoming.metaForeign;
      setConflict(incoming.conflict);
      applyDocView(incomingView);
      setCommentCount(0); // the promoted editor re-reports on its readOnly flip
      const dirtyNow = currentMarkdownRef.current !== lastSavedRef.current;
      setDirty(dirtyNow && !incoming.missing);
      if (dirtyNow && pathRef.current && !incoming.conflict) scheduleAutosave();
      setSplitState({
        side: toFocusSide ? otherSide(toFocusSide) : otherSide(s.side),
        tabId: outgoingTabId ?? "",
        view: outgoingView,
        doc: outgoing,
      });
      activeIdRef.current = incomingTabId;
      loadTicketRef.current += 1; // a load still in flight is for a document that just lost focus
      loadedIdRef.current = incomingTabId; // its editor is mounted; the machinery is its now
      setActiveId(incomingTabId);
      writeStoredSession(tabsRef.current, incomingTabId);
      // Same watch set, roles flipped — no re-arm needed.
    },
    [
      flushPendingAutosave,
      flushSidecarWrite,
      captureActiveScroll,
      stashActiveDoc,
      adoptTableWidths,
      applyDocView,
      scheduleAutosave,
      setSplitState,
    ],
  );
  swapFocusRef.current = swapFocus;

  // Open the ACTIVE document in the other pane too (VS Code's "split
  // editor"): the new pane duplicates the current view by default — the
  // user then picks MD/HTML per pane from the headers. A duplicated
  // markdown view makes the new pane a read-only mirror; a rendition view
  // makes it a second live preview. `view` overrides for session restore.
  const splitSameDoc = useCallback(
    async (side: PaneSide = "right", view?: DocView) => {
      const id = activeIdRef.current;
      if (!id) return;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || tab.missing || isUnsupportedTab(tab)) return;
      const htmlOnly = tab.kind === "file" && isHtmlPath(tab.path);
      let v: DocView = view ?? docViewRef.current;
      if (htmlOnly) v = "html";
      if (v === "html" && !htmlPathRef.current) v = "md"; // no rendition on disk
      if (v === "html" && htmlContentRef.current == null) {
        // Restoring an md|html arrangement: the rendition isn't loaded yet.
        const htmlPath = htmlPathRef.current!;
        try {
          const r = await backend.documents.read(htmlPath);
          setHtmlContent(r.text);
          htmlContentRef.current = r.text;
        } catch (e) {
          console.error("read failed", htmlPath, e);
          v = "md"; // rendition vanished; fall back to a markdown mirror
        }
      }
      if (v === "md") {
        if (docViewRef.current === "html") {
          // Normalize: a markdown pane is always the live side. Bring the
          // hidden editor forward here; the new pane shows the rendition.
          applyDocView("md");
          restoreActiveScroll();
          v = "html";
          if (htmlContentRef.current == null) return; // nothing loaded to show
        } else {
          setMirror((m) => ({ content: currentMarkdownRef.current, seq: m.seq + 1 }));
        }
      }
      setSplitState({ side, tabId: id, view: v, doc: null });
    },
    [applyDocView, restoreActiveScroll, setSplitState],
  );
  splitSameDocRef.current = splitSameDoc;

  // Open a tab in the split pane (two-document split), or re-side an
  // existing one. Opening the ACTIVE tab routes to the same-document split.
  const openInPane = useCallback(
    async (tabId: string, side: PaneSide, view?: DocView) => {
      const s = splitRef.current;
      if (tabId === activeIdRef.current) {
        if (s && !s.doc) {
          if (s.side !== side) setSplitState({ ...s, side });
          return;
        }
        await splitSameDoc(side, view);
        return;
      }
      if (s && s.tabId === tabId && s.doc) {
        if (s.side !== side) setSplitState({ ...s, side });
        return;
      }
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const { doc, view: resolvedView } = await loadCompanionDoc(tab, view);
      companionMdRef.current = { md: "", baseline: "", baselined: false };
      bumpEditorSeq(tabId);
      setSplitState({ side, tabId, view: resolvedView, doc });
      await refreshWatchSet();
    },
    [splitSameDoc, loadCompanionDoc, setSplitState, refreshWatchSet, bumpEditorSeq],
  );
  openInPaneRef.current = openInPane;

  // Retry a split pane whose document failed to read (ghost pane): re-run
  // the load in place.
  const retryCompanion = useCallback(async () => {
    const s = splitRef.current;
    if (!s || !s.doc) return;
    const tab = tabsRef.current.find((t) => t.id === s.tabId);
    if (!tab) return;
    const { doc, view } = await loadCompanionDoc(tab, s.view);
    companionMdRef.current = { md: "", baseline: "", baselined: false };
    bumpEditorSeq(s.tabId);
    setSplitState({ ...s, view, doc });
    await refreshWatchSet();
  }, [loadCompanionDoc, bumpEditorSeq, setSplitState, refreshWatchSet]);

  // The unfocused pane's HtmlView gets an inert threads sink (its comment
  // layer is disabled; mutations only flow once promoted), and the mirror
  // editor an inert markdown sink (read-only snapshot; nothing to track).
  const noopThreadsChange = useCallback(() => {}, []);
  const noopMarkdownChange = useCallback((_md: string) => {}, []);

  // Close the split (the focused document takes the whole area again; the
  // other pane's tab stays open in the strip).
  const closeSplit = useCallback(async () => {
    if (!splitRef.current) return;
    captureCompanionScroll();
    setSplitState(null);
    await refreshWatchSet();
  }, [captureCompanionScroll, setSplitState, refreshWatchSet]);

  // A pane header's ✕. Closing the FOCUSED pane of a two-document split
  // promotes the other document first (VS Code group semantics); closing the
  // focused pane of a same-document split keeps the surviving pane's view.
  const closePane = useCallback(
    async (side: PaneSide) => {
      const s = splitRef.current;
      if (!s) return;
      if (side === s.side) {
        await closeSplit();
        return;
      }
      // Closing the focused pane.
      if (s.doc) {
        await swapFocus();
        await closeSplit();
      } else {
        setSplitState(null);
        if (s.view === "html" && docViewRef.current !== "html") {
          await selectDocView("html"); // keep showing what the user kept
        }
        // Both-markdown: the mirror pane closes into the live editor —
        // nothing to switch.
      }
    },
    [closeSplit, swapFocus, setSplitState, selectDocView],
  );

  // The split pane's MD/HTML toggle.
  const setCompanionView = useCallback(
    async (v: DocView) => {
      const s = splitRef.current;
      if (!s || v === s.view) return;
      if (!s.doc) {
        // Same-document split pane.
        const tab = tabsRef.current.find((t) => t.id === s.tabId);
        if (!tab) return;
        if (v === "html") {
          // Mirror → rendition (the classic md | html arrangement).
          const htmlPath = htmlPathRef.current;
          if (!htmlPath) return;
          if (htmlContentRef.current == null) {
            try {
              const r = await backend.documents.read(htmlPath);
              setHtmlContent(r.text);
              htmlContentRef.current = r.text;
            } catch (e) {
              console.error("read failed", htmlPath, e);
              return;
            }
          }
          captureCompanionScroll(); // the mirror is about to unmount
          setSplitState({ ...s, view: "html" });
        } else if (!(tab.kind === "file" && isHtmlPath(tab.path))) {
          if (docViewRef.current === "md") {
            // Both panes on markdown: this one becomes the read-only mirror.
            setMirror((m) => ({ content: currentMarkdownRef.current, seq: m.seq + 1 }));
            setSplitState({ ...s, view: "md" });
          } else {
            // Focused pane shows html; the user wants markdown HERE. The
            // live editor follows the markdown view: this pane becomes the
            // focused side, the html preview keeps the other pane.
            flushPendingAutosave();
            remountFocusedEditor();
            applyDocView("md");
            setSplitState({
              side: otherSide(s.side),
              tabId: s.tabId,
              view: "html",
              doc: null,
            });
          }
        }
        return;
      }
      if (v === "html") {
        if (!s.doc.htmlPath) return;
        let contents = s.doc.htmlContent;
        if (contents == null) {
          try {
            contents = (await backend.documents.read(s.doc.htmlPath)).text;
          } catch (e) {
            console.error("read failed", s.doc.htmlPath, e);
            return;
          }
        }
        captureCompanionScroll(); // the markdown pane is about to unmount
        viewPrefsRef.current.set(s.doc.path, "html");
        setSplitState({ ...s, view: "html", doc: { ...s.doc, htmlContent: contents } });
      } else {
        if (s.doc.kind === "file" && isHtmlPath(s.doc.path)) return; // html-only doc
        viewPrefsRef.current.set(s.doc.path, "md");
        companionMdRef.current = { md: "", baseline: "", baselined: false };
        setSplitState({ ...s, view: "md" });
      }
    },
    [
      captureCompanionScroll,
      setSplitState,
      flushPendingAutosave,
      remountFocusedEditor,
      applyDocView,
    ],
  );

  // The split pane's markdown editor reports every serialization here. It is
  // read-only, so the only "edits" that can originate there are comment-rail
  // mutations — and any real edit PROMOTES the pane, so the autosave
  // machinery picks it up (the swap hydration compares the edited content
  // against the stashed baseline and schedules the save). The mount-time
  // serialization is the baseline.
  const onCompanionMarkdownChange = useCallback((md: string) => {
    const t = companionMdRef.current;
    if (!t.baselined) {
      companionMdRef.current = { md, baseline: md, baselined: true };
      return;
    }
    if (md === t.md) return;
    t.md = md;
    const s = splitRef.current;
    if (!s || !s.doc) return;
    void swapFocusRef.current();
  }, []);

  // Promote the split pane to focused. Fired by pointerdown on the pane (and
  // by the bridge's gesture report for html panes — the iframe swallows
  // clicks). Same-document splits have nothing to promote.
  const promotePane = useCallback((side: PaneSide) => {
    const s = splitRef.current;
    if (!s || s.side !== side || !s.doc) return;
    void swapFocusRef.current();
  }, []);

  /* ---------- Split scroll sync ---------- */

  // Proportional sync: the hovered pane publishes its scroll fraction, the
  // other follows. Programmatic follows are muted (wrap scrolls: a
  // timestamp; iframe scrolls: bridge-side), so the panes can never feed
  // back into each other.
  const applyRatioToSide = useCallback((side: PaneSide, ratio: number) => {
    const html = htmlHandlesRef.current[side];
    if (html) {
      html.scrollToRatio(ratio);
      return;
    }
    const wrap = wrapElsRef.current[side];
    if (!wrap) return;
    const range = wrap.scrollHeight - wrap.clientHeight;
    if (range <= 0) return;
    scrollMuteRef.current[side] = performance.now();
    wrap.scrollTop = ratio * range;
  }, []);

  const publishPaneScroll = useCallback(
    (side: PaneSide, ratio: number) => {
      if (!splitRef.current || !syncScrollRef.current) return;
      if (hoverSideRef.current !== null && hoverSideRef.current !== side) return;
      applyRatioToSide(otherSide(side), ratio);
    },
    [applyRatioToSide],
  );

  const handleWrapScroll = useCallback(
    (side: PaneSide) => {
      const wrap = wrapElsRef.current[side];
      if (!wrap || !splitRef.current || !syncScrollRef.current) return;
      if (performance.now() - scrollMuteRef.current[side] < 200) return; // our own set
      const range = wrap.scrollHeight - wrap.clientHeight;
      if (range <= 0) return;
      publishPaneScroll(side, wrap.scrollTop / range);
    },
    [publishPaneScroll],
  );

  /* ---------- Tab drag-out → split drop zones ---------- */

  const dropSideForPointer = useCallback((x: number, y: number): PaneSide | null => {
    const area = editorAreaRef.current;
    if (!area) return null;
    const r = area.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    return x < r.left + r.width / 2 ? "left" : "right";
  }, []);

  const handleTabDragOut = useCallback(
    (tabId: string, x: number, y: number) => {
      setTabDrop({ tabId, side: dropSideForPointer(x, y) });
    },
    [dropSideForPointer],
  );

  const handleTabDragCancel = useCallback(() => setTabDrop(null), []);

  // Land a tab on a pane half. Shared by the tab-bar drag and (through the
  // path resolver below) the sidebar's file drag.
  const commitTabDrop = useCallback(
    async (tabId: string, side: PaneSide) => {
      const s = splitRef.current;
      const focusedSide = focusedSideOf(s);
      if (tabId === activeIdRef.current) {
        if (s) {
          // Dropping the active tab moves the FOCUSED pane to that half
          // (the other pane takes the opposite side). React remounts the
          // focused editor in its new parent — refresh it from live content
          // first, or the remount would resurrect (and then autosave) the
          // last-loaded text over real edits.
          if (focusedSide !== side) {
            flushPendingAutosave();
            captureActiveScroll();
            captureCompanionScroll(); // the other pane's editor re-parents too
            if (docViewRef.current === "md") remountFocusedEditor();
            setSplitState({ ...s, side: otherSide(side) });
          }
        } else {
          // No split yet: duplicate the active doc; the new pane lands on
          // the half it was dropped on.
          await splitSameDoc(side);
        }
        return;
      }
      if (s && s.tabId === tabId && s.doc) {
        if (side === focusedSide) {
          await swapFocus(side); // promote INTO the half it was dropped on
        } else if (s.side !== side) {
          setSplitState({ ...s, side });
        }
        return;
      }
      if (side === focusedSide && s) {
        await switchTab(tabId); // replace the focused pane's document
      } else {
        await openInPane(tabId, side);
      }
    },
    [
      setSplitState,
      splitSameDoc,
      swapFocus,
      openInPane,
      switchTab,
      flushPendingAutosave,
      remountFocusedEditor,
      captureActiveScroll,
      captureCompanionScroll,
    ],
  );

  const handleTabDragEnd = useCallback(
    (tabId: string, x: number, y: number) => {
      setTabDrop(null);
      const side = dropSideForPointer(x, y);
      if (!side) return;
      void commitTabDrop(tabId, side);
    },
    [dropSideForPointer, commitTabDrop],
  );

  /* ---------- Sidebar file drag → panes ---------- */

  // The sidebar streams file-row drags that leave the tree; the same drop
  // overlay lights up and dropping opens the file in that pane — as a new
  // tab when it isn't open yet.
  const handleTreeDragToEditor = useCallback(
    (_path: string, x: number, y: number) => {
      setTabDrop({ tabId: "", side: dropSideForPointer(x, y) });
    },
    [dropSideForPointer],
  );

  const handleTreeDragCancel = useCallback(() => setTabDrop(null), []);

  const handleTreeDropToEditor = useCallback(
    (path: string, x: number, y: number) => {
      setTabDrop(null);
      const side = dropSideForPointer(x, y);
      if (!side) return;
      void (async () => {
        // An html file whose markdown sibling exists opens as that document
        // (same pairing rule as openTab).
        let target = path;
        if (isHtmlPath(target)) {
          const md = mdSiblingOf(target);
          const paired = await backend.documents.exists(md).catch(() => false);
          if (paired) {
            viewPrefsRef.current.set(md, "html");
            target = md;
          }
        }
        const existing = tabsRef.current.find((t) => t.path === target);
        if (existing) {
          await commitTabDrop(existing.id, side);
          return;
        }
        const tab: Tab = { id: uuid(), kind: "file", path: target };
        if (side === focusedSideOf(splitRef.current)) {
          // Focused half (or no split yet, left half): a normal open.
          await appendAndActivate(tab);
          return;
        }
        // The other half: add the tab WITHOUT activating, open it there.
        const nextTabs = [...tabsRef.current, tab];
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        writeStoredSession(nextTabs, activeIdRef.current);
        await openInPane(tab.id, side);
      })();
    },
    [dropSideForPointer, commitTabDrop, appendAndActivate, openInPane],
  );

  // The tab-bar split button / ⌘⇧\: open the active document in a second
  // pane (VS Code's split-editor semantics — pick per-pane views from the
  // headers afterwards); toggle off when already split.
  const toggleSplit = useCallback(async () => {
    if (splitRef.current) {
      await closeSplit();
      return;
    }
    await splitSameDoc("right");
  }, [closeSplit, splitSameDoc]);

  /* ---------- Untitled notes: saving and closing ----------
     An untitled note is unsaved for as long as it has text (tabs.ts), and it
     stops being one in exactly two ways: it is saved to a file — its tab
     becomes that file's tab, in place — or its tab closes, and the note is
     gone. So closing one that has text is asked, never assumed (closeTab).
     Quitting is not closing: the window session and the buffers bring every
     note back, still unsaved, at the next launch. */

  // Move the active untitled note into the real file `chosen`. Every Save As
  // path ends here — the in-app prompt (a workspace is open) and the native
  // dialog (none is). Resolves false, with the note exactly as it was, if the
  // file could not be written.
  const saveUntitledTo = useCallback(
    async (note: UntitledTab, chosen: string): Promise<boolean> => {
      if (activeIdRef.current !== note.id) return false;
      catchUpWithEditor();
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      const contents = currentMarkdownRef.current;
      const hybrid = extractMarkdown(contents).md;
      // The rendition beside the chosen name, if one is already there — probed
      // before the write, because its meta is adopted below.
      const sibling = htmlSiblingOf(chosen);
      const siblingExists = await backend.documents.exists(sibling).catch(() => false);
      // The file first, and on its own: if it cannot be written, nothing has
      // changed, and the note is still an untitled note with all of its text.
      let snapshot: Rev | null;
      try {
        // Save As: over whatever the chosen name holds.
        snapshot = (
          await backend.documents.save(chosen, { text: frontmatterRef.current + hybrid }, null)
        ).rev;
      } catch (e) {
        console.error("save failed", chosen, e);
        pushToast("error", `Couldn't save ${basename(chosen)}. The note is still unsaved.`);
        if (currentMarkdownRef.current !== lastSavedRef.current) scheduleAutosave();
        return false;
      }
      // From here the document IS the file. The chosen stem may already have
      // an entity meta (an existing rendition with comments): adopt it before
      // composing ours — writeToDisk builds the meta from the app refs, and
      // the note's own would clobber it. The note's unanchored bodies and its
      // table widths ride along; where both have a record, the file's wins.
      const noteOrphans = mdOrphansRef.current;
      const noteTableWidths = tableWidthsRef.current;
      await loadEntityMeta(chosen, contents);
      if (noteOrphans.length > 0) {
        const have = new Set(mdOrphansRef.current.map((t) => t.id));
        const merged = [...mdOrphansRef.current, ...noteOrphans.filter((t) => !have.has(t.id))];
        mdOrphansRef.current = merged;
        setMdOrphans(merged);
      }
      if (noteTableWidths.length > 0) {
        const have = new Set(tableWidthsRef.current.map((t) => t.id));
        adoptTableWidths([
          ...tableWidthsRef.current,
          ...noteTableWidths.filter((t) => !have.has(t.id)),
        ]);
      }
      pathRef.current = chosen;
      snapshotRef.current = snapshot;
      lastDiskMdRef.current = hybrid;
      // The markdown is on disk already, so this lands what is left: the
      // thread bodies in the file's meta, and the saved baseline.
      await writeToDisk(chosen, contents);
      // The buffer is finished with — before the tab changes, so a crash in
      // between leaves a saved file and nothing to "recover" beside it.
      await backend.untitled
        ?.discard(note.path)
        .catch((e) => console.error("discard untitled failed", e));
      // The tab becomes the file's, in place.
      const nextTabs = tabsRef.current.map(
        (t): Tab => (t.id === note.id ? { id: t.id, kind: "file", path: chosen } : t),
      );
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      writeStoredSession(nextTabs, activeIdRef.current);
      // The rendition enables the view toggle and joins the watch set.
      htmlPathRef.current = siblingExists ? sibling : null;
      setHasHtml(siblingExists);
      await refreshWatchSet();
      setTreeRefreshToken((t) => t + 1); // the new file may have landed in the workspace tree
      return true;
    },
    [
      catchUpWithEditor,
      writeToDisk,
      scheduleAutosave,
      pushToast,
      loadEntityMeta,
      adoptTableWidths,
      refreshWatchSet,
    ],
  );

  // Save the active untitled note: decide where, then move it there. Resolves
  // true once the note is a file, false if the question was dismissed. With a
  // workspace open there is no Finder navigation (VS Code-style): the
  // destination is already decided by context — the sidebar's selected
  // folder, the selected file's folder, or the workspace root — so the in-app
  // prompt only asks for a name. With none, the native Save dialog is the
  // only way to pick a location.
  const saveUntitled = useCallback(async (): Promise<boolean> => {
    catchUpWithEditor();
    const note = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!note || note.kind !== "untitled") return false;
    const suggested = suggestedFileName(noteTitle(currentMarkdownRef.current));
    const sels = sidebarSelectionRef.current;
    const sel = sels[sels.length - 1] ?? null; // primary selection
    const contextDir = sel
      ? sel.kind === "dir"
        ? sel.path
        : dirname(sel.path)
      : workspaceRoot;
    if (contextDir) {
      savePromptDoneRef.current?.(false); // a prompt already up is superseded
      return new Promise<boolean>((resolve) => {
        savePromptDoneRef.current = resolve;
        setSavePrompt({ dir: contextDir, suggested });
      });
    }
    const chosen = await backend.localFiles?.pickSaveAs(`${suggested}.md`);
    if (!chosen) return false;
    return saveUntitledTo(note, chosen);
  }, [catchUpWithEditor, saveUntitledTo, workspaceRoot]);

  // Close the in-app Save As prompt and tell whoever opened it how it went.
  const settleSavePrompt = useCallback((saved: boolean) => {
    const done = savePromptDoneRef.current;
    savePromptDoneRef.current = null;
    setSavePrompt(null);
    done?.(saved);
  }, []);

  // Commit the in-app Save As prompt. Returns an error message to show under
  // the input (bad name, collision), or null once the prompt is done with.
  const commitSavePrompt = useCallback(
    async (name: string): Promise<string | null> => {
      const sp = savePrompt;
      const note = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!sp || note?.kind !== "untitled") {
        settleSavePrompt(false); // the note went away under the prompt; nothing to save
        return null;
      }
      const trimmed = name.trim();
      if (!trimmed) return "A name is required.";
      if (/[/\\:]/.test(trimmed)) return "Names can't contain /, \\ or :";
      if (trimmed.startsWith(".")) return "Names can't start with a dot.";
      const fileName = MD_EXT_RE.test(trimmed) ? trimmed : `${trimmed}.md`;
      const target = `${sp.dir}/${fileName}`;
      let exists = false;
      try {
        exists = await backend.documents.exists(target);
      } catch {
        // If the check itself fails, fall through — the write will surface it.
      }
      if (exists) return `"${fileName}" already exists in this folder.`;
      setSavePrompt(null);
      settleSavePrompt(await saveUntitledTo(note, target));
      return null;
    },
    [savePrompt, saveUntitledTo, settleSavePrompt],
  );

  // The prompt's escape hatch: hand off to the native dialog (pre-filled with
  // the typed name) for saving somewhere outside the workspace.
  const browseSavePrompt = useCallback(
    async (name: string) => {
      const sp = savePrompt;
      const note = tabsRef.current.find((t) => t.id === activeIdRef.current);
      setSavePrompt(null);
      if (!sp || note?.kind !== "untitled") {
        settleSavePrompt(false);
        return;
      }
      const base = name.trim() || sp.suggested;
      const fileName = MD_EXT_RE.test(base) ? base : `${base}.md`;
      const chosen = await backend.localFiles?.pickSaveAs(`${sp.dir}/${fileName}`);
      settleSavePrompt(chosen ? await saveUntitledTo(note, chosen) : false);
    },
    [savePrompt, saveUntitledTo, settleSavePrompt],
  );

  // Ask what becomes of an untitled note that is about to close. One question
  // at a time: asking again answers the one already up with "cancel".
  const askUnsaved = useCallback((note: Tab): Promise<UnsavedChoice> => {
    unsavedAnswerRef.current?.("cancel");
    return new Promise<UnsavedChoice>((resolve) => {
      unsavedAnswerRef.current = resolve;
      setUnsavedPrompt({ title: tabLabel(note) });
    });
  }, []);

  const answerUnsaved = useCallback((choice: UnsavedChoice) => {
    const answer = unsavedAnswerRef.current;
    unsavedAnswerRef.current = null;
    setUnsavedPrompt(null);
    answer?.(choice);
  }, []);

  // Close a tab. Resolves false if it stayed open — which only an untitled
  // note with text in it can make happen: closing that is the end of the
  // note, so it is brought to the front and asked about first (Save… /
  // Don't Save / Cancel). A file's tab just closes: its content is on disk.
  const closeTab = useCallback(
    async (id: string): Promise<boolean> => {
      // Whether a note has text is the tab's to say — once the editor has
      // been heard: characters typed a moment ago may not have reached it.
      if (id === activeIdRef.current) catchUpWithEditor();
      const asked = tabsRef.current.find((t) => t.id === id);
      if (!asked) return true;
      if (isUnsaved(asked)) {
        if (id !== activeIdRef.current) await switchTab(id);
        if (activeIdRef.current !== id) return false;
        const choice = await askUnsaved(asked);
        if (choice === "cancel") return false;
        if (choice === "save" && !(await saveUntitled())) return false;
      }
      // Re-read: a note that was just saved is a file tab now.
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return true;
      // An untitled note closing — discarded, or never typed in — ends here.
      // Its writers stand down first: an autosave or a meta write landing
      // after the delete below would put the buffer back.
      if (tab.kind === "untitled" && id === activeIdRef.current) {
        if (autosaveTimerRef.current != null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        if (sidecarWriteTimerRef.current != null) {
          window.clearTimeout(sidecarWriteTimerRef.current);
          sidecarWriteTimerRef.current = null;
        }
        lastSavedRef.current = currentMarkdownRef.current; // nothing left to flush
      }
      // Split bookkeeping next, so the close below never leaves a pane
      // pointing at a closed tab — and closing the focused half of a
      // two-document split hands the area to the OTHER document instead of
      // loading a neighbor over it.
      const s = splitRef.current;
      if (s) {
        if (id === activeIdRef.current && s.doc && s.tabId !== id) {
          await swapFocus();
          await closeSplit();
        } else if (s.tabId === id || id === activeIdRef.current) {
          await closeSplit();
        }
      }
      const isActive = id === activeIdRef.current;
      if (tab.kind === "untitled") {
        await backend.untitled
          ?.discard(tab.path)
          .catch((e) => console.error("discard untitled failed", e));
      } else if (isActive) {
        flushPendingAutosave();
      }

      scrollPositionsRef.current.delete(id);
      editorSeqRef.current.delete(id);
      const idx = tabsRef.current.findIndex((t) => t.id === id);
      const remaining = tabsRef.current.filter((t) => t.id !== id);
      const nextActive =
        remaining.length === 0
          ? null
          : isActive
            ? remaining[Math.min(idx, remaining.length - 1)].id
            : activeIdRef.current;
      tabsRef.current = remaining;
      activeIdRef.current = nextActive;
      setTabs(remaining);
      setActiveId(nextActive);
      writeStoredSession(remaining, nextActive);
      if (nextActive === null) {
        await clearActiveDoc();
      } else if (isActive) {
        const target = remaining.find((t) => t.id === nextActive);
        if (target) await loadActiveContent(target);
      }
      return true;
    },
    [
      catchUpWithEditor,
      switchTab,
      askUnsaved,
      saveUntitled,
      flushPendingAutosave,
      clearActiveDoc,
      loadActiveContent,
      swapFocus,
      closeSplit,
    ],
  );

  // Delete a file or folder (⌘⌫ / the sidebar's context menu). Where a
  // delete can be taken back the backend hands over how (on a Mac: straight
  // back out of the Trash, leaving no stale copy), and undoDelete keeps it.
  // Any tabs on the entry (or inside it, for a folder) are closed first.
  const deleteEntry = useCallback(
    async (target: string, kind: "file" | "dir") => {
      // Close affected tabs first (flushing their content while the files still
      // exist), so the trash that follows can't be resurrected by a late
      // autosave write and the watcher has already moved to a neighbor tab.
      const affected = tabsRef.current.filter(
        (t) =>
          t.kind === "file" &&
          (t.path === target || (kind === "dir" && t.path.startsWith(target + "/"))),
      );
      for (const t of affected) await closeTab(t.id);
      let removed: Removed;
      try {
        removed = await backend.documents.remove(target, kind);
      } catch (e) {
        console.error("delete failed", e);
        alert(`Could not delete ${target}\n${e}`);
        return;
      }
      // A document's html rendition and comments go with it; one that could
      // not is said, the document itself being gone already.
      for (const left of removed.left) {
        console.error("delete failed", left.error);
        alert(`Deleted ${basename(target)} but not its ${PART_LABEL[left.part]}.\n${left.error}`);
      }
      if (removed.undo) {
        deletedStackRef.current.push({ undo: removed.undo, openPaths: affected.map((t) => t.path) });
      }
      const sels = sidebarSelectionRef.current;
      const kept = sels.filter(
        (s) => s.path !== target && !s.path.startsWith(target + "/"),
      );
      if (kept.length !== sels.length) selectSidebarEntries(kept);
      setTreeRefreshToken((t) => t + 1);
    },
    [closeTab, selectSidebarEntries],
  );

  // Undo the most recent delete (⌘Z outside the editor): put the entry, and
  // what was deleted with it, back where it was, and reopen the tabs it
  // closed.
  const undoDelete = useCallback(async () => {
    const entry = deletedStackRef.current.pop();
    if (!entry) return;
    const { restored, failed } = await entry.undo();
    for (const f of failed) {
      console.error("undo delete failed", f.error);
      alert(`Could not restore ${f.path}\n${f.error}`);
    }
    if (!restored) return;
    setTreeRefreshToken((t) => t + 1);
    for (const p of entry.openPaths) await openTab(p);
  }, [openTab]);

  // Something moved on disk from `from` to `to`: repoint every piece of state
  // that keys off the old path — open tabs (including everything inside a
  // moved folder), the active document's autosave target and watcher, the
  // split pane, and the sidebar selection.
  const repointMoved = useCallback(
    async (from: string, to: string, kind: "file" | "dir") => {
      const remap = (p: string) =>
        p === from
          ? to
          : kind === "dir" && p.startsWith(from + "/")
            ? to + p.slice(from.length)
            : p;

      const activeBefore = tabsRef.current.find((t) => t.id === activeIdRef.current);
      let tabsChanged = false;
      const nextTabs = tabsRef.current.map((t) => {
        const np = remap(t.path);
        if (np === t.path) return t;
        tabsChanged = true;
        return { ...t, path: np };
      });
      if (tabsChanged) {
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        writeStoredSession(nextTabs, activeIdRef.current);
      }

      // The active document moved: retarget autosave and re-watch the new path
      // (the old watch died with the old path). The snapshot stays valid — a
      // rename doesn't touch mtime or size.
      let rewatch = false;
      if (pathRef.current) {
        const np = remap(pathRef.current);
        if (np !== pathRef.current) {
          pathRef.current = np;
          // The rendition rode along (moved above) — follow it.
          if (htmlPathRef.current) htmlPathRef.current = htmlSiblingOf(np);
          rewatch = true;
        }
      } else if (htmlPathRef.current) {
        // Active html-only document: keep the rendition path current.
        const np = remap(htmlPathRef.current);
        if (np !== htmlPathRef.current) {
          htmlPathRef.current = np;
          rewatch = true;
        }
      }

      // The split pane's document moved: follow it the same way (its tab
      // path was remapped with the tab list above; the rendition rode along
      // with the file move, so re-derive its path from the new stem).
      {
        const s = splitRef.current;
        if (s?.doc) {
          const np = remap(s.doc.path);
          if (np !== s.doc.path) {
            setSplitState({
              ...s,
              doc: {
                ...s.doc,
                path: np,
                htmlPath:
                  s.doc.htmlPath === null
                    ? null
                    : isHtmlPath(np)
                      ? np
                      : htmlSiblingOf(np),
              },
            });
            rewatch = true;
          }
        }
      }
      if (rewatch) await refreshWatchSet();

      const sels = sidebarSelectionRef.current;
      const remapped = sels.map((s) => {
        const np = remap(s.path);
        return np === s.path ? s : { ...s, path: np };
      });
      if (remapped.some((s, i) => s !== sels[i])) selectSidebarEntries(remapped);

      setTreeRefreshToken((t) => t + 1);

      // Renamed into or out of being a document (notes.txt → notes.md): the
      // open tab loads again as what it is now.
      const activeNow = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (activeBefore && activeNow && isUnsupportedTab(activeBefore) !== isUnsupportedTab(activeNow)) {
        await loadActiveContent(activeNow);
      }
    },
    [selectSidebarEntries, refreshWatchSet, setSplitState, loadActiveContent],
  );

  // Move or rename a file/folder on disk (the sidebar's drag-and-drop and
  // inline Rename both end here), then repoint the state that keyed off the
  // old path (`repointMoved`). Returns an error message for the caller to
  // surface (inline under the rename input, alert for a drop), or null on
  // success.
  const movePath = useCallback(
    async (from: string, to: string, kind: "file" | "dir"): Promise<string | null> => {
      // If the active document is about to move, land any pending autosave at
      // the OLD path first — a debounced write firing mid-rename would
      // otherwise recreate the file at the path it just left.
      if (
        pathRef.current &&
        (pathRef.current === from || (kind === "dir" && pathRef.current.startsWith(from + "/")))
      ) {
        await flushPendingAutosave();
      }
      // Same for a pending comment write: land it before its sidecar (or the
      // rendition it belongs to) moves out from under it.
      await flushSidecarWrite();
      // A document's html rendition and comments move with it: the three
      // are one document, and leaving one behind would silently split it.
      let left: LeftBehind[];
      try {
        left = await backend.documents.move(from, to, kind);
      } catch (e) {
        return String(e);
      }
      for (const l of left) {
        window.alert(`Moved "${basename(from)}" but not its ${PART_LABEL[l.part]}.\n${l.error}`);
      }
      await repointMoved(from, to, kind);
      return null;
    },
    [flushPendingAutosave, flushSidecarWrite, repointMoved],
  );

  /* ---------- Sections: who can open what ---------- */

  const cloudForRootRef = useRef(cloudForRoot);
  cloudForRootRef.current = cloudForRoot;

  // Asked once before anything moves between folders. Two moves change who
  // can open a thing, and say so first: one that lets more people see it,
  // and a folder put straight under Restricted, which becomes a restricted
  // folder and leaves everyone else's devices. Every other move just happens.
  const confirmMove = useCallback(
    async (entries: SidebarSelection[], toDir: string): Promise<boolean> => {
      const cloud = cloudForRootRef.current;
      const toRel = cloud ? relPathIn(cloud.root, toDir) : null;
      if (!cloud || toRel === null || entries.length === 0) return true;
      const one = entries.length === 1;
      const label = (en: SidebarSelection) =>
        en.kind === "file" ? basename(en.path).replace(/\.(md|markdown|mdown|mkd|html)$/i, "") : basename(en.path);
      const what = one ? `“${label(entries[0])}”` : `${entries.length} items`;
      const to = placeOf(cloud, toRel);
      if (to.kind === "nowhere") {
        // Where no restricted folder can be made, the move is refused in its
        // own words and there is nothing to ask first.
        if (toRel.toLowerCase() !== "restricted" || !backend.spaces) return true;
        return askUser({
          title: `Restrict ${what}?`,
          body: `${one ? "It becomes a restricted folder" : "Each becomes a restricted folder"} only you can open until you add people, and is removed from everyone else’s devices.`,
          confirm: "Restrict",
        });
      }
      const gains = new Set<string>();
      for (const en of entries) {
        const rel = relPathIn(cloud.root, en.path);
        const who = rel === null ? null : widerAudience(cloud, placeOf(cloud, rel), to);
        if (who) gains.add(who);
      }
      if (gains.size === 0) return true;
      return askUser({
        title: `Move ${what} to ${to.kind === "shared" ? "the workspace" : `“${to.space.name}”`}?`,
        body: `${[...gains][0]} will be able to see ${one ? "it" : "them"}.`,
        confirm: "Move",
      });
    },
    [askUser],
  );

  // Make the restricted folder its dialog asked for, and put in it what the
  // dialog was opened on: a folder becomes it (the backend moves it: on a
  // Mac the engine, so the people in it keep their copies in place); a note
  // is moved into it.
  // Resolves to a sentence when it could not be done.
  const makeRestricted = useCallback(
    async (source: RestrictedSource, name: string, members: string[]): Promise<string | null> => {
      const cloud = cloudForRootRef.current;
      const spaces = backend.spaces;
      if (!cloud || !spaces) return "This workspace isn’t connected.";
      try {
        if (source.kind === "folder") {
          // Land what is being typed inside it before the folder moves.
          if (pathRef.current?.startsWith(`${source.path}/`)) await flushPendingAutosave();
          await flushSidecarWrite();
          const made = await spaces.spaceCreate(cloud.root, name, members, source.path);
          await repointMoved(source.path, `${cloud.root}/${made.path}`, "dir");
        } else {
          const made = await spaces.spaceCreate(cloud.root, name, members);
          if (source.kind === "note") {
            const to = `${cloud.root}/${made.path}/${basename(source.path)}`;
            const failed = await movePath(source.path, to, "file");
            if (failed) return `The folder was made, but the note could not be moved into it: ${failed}`;
          }
          setTreeRefreshToken((t) => t + 1);
        }
        setRestrictedSource(null);
        return null;
      } catch (e) {
        return errText(e);
      }
    },
    [flushPendingAutosave, flushSidecarWrite, movePath, repointMoved],
  );

  /* ---------- File clipboard (sidebar Cut/Copy/Paste) ---------- */

  // Local mirror of the backend clipboard, for the UI only: enabling Paste
  // and dimming rows a Cut is about to move. The backend copy is the truth —
  // paste re-reads it — so a stale mirror can't misfile anything.
  const [fileClipboard, setFileClipboard] = useState<FileClipboardPayload | null>(null);
  useEffect(() => {
    backend.fileClipboard
      .get()
      .then(setFileClipboard)
      .catch(() => {});
    return backend.fileClipboard.onChange(setFileClipboard);
  }, []);

  // Cut/Copy: park the selection on the app-wide clipboard. The files aren't
  // touched until paste (a cut that's never pasted moves nothing).
  const copyEntries = useCallback(async (entries: SidebarSelection[], cut: boolean) => {
    const items = pruneNestedSelection(entries);
    if (items.length === 0) return;
    try {
      await backend.fileClipboard.set(items, cut);
    } catch (e) {
      console.error("file clipboard set failed", e);
    }
  }, []);

  // Paste into `destDir`: copy → duplicate on disk (companions ride along,
  // like delete/move); cut → a real move through movePath, which repoints
  // tabs and watchers. Collisions get a fresh "name copy.md"-style
  // target instead of a prompt, so paste never clobbers.
  const pasteEntries = useCallback(
    async (destDir: string) => {
      let clip: FileClipboardPayload | null = null;
      try {
        clip = await backend.fileClipboard.get();
      } catch {
        return;
      }
      if (!clip || clip.items.length === 0) return;
      // A cut is a move, and a move can change who sees what.
      if (clip.cut) {
        const leaving = clip.items.filter((item) => dirname(item.path) !== destDir);
        if (!(await confirmMove(leaving, destDir))) return;
      }
      const pasted: SidebarSelection[] = [];
      let copiedAny = false;
      for (const item of clip.items) {
        const name = basename(item.path);
        if (
          item.kind === "dir" &&
          (destDir === item.path || destDir.startsWith(item.path + "/"))
        ) {
          window.alert(
            `Can't ${clip.cut ? "move" : "copy"} "${name}" into itself`,
          );
          continue;
        }
        if (clip.cut) {
          if (dirname(item.path) === destDir) continue; // cut+paste in place: nothing to move
          const to = await uniquePastePath(destDir, name, item.kind);
          const err = await movePath(item.path, to, item.kind);
          if (err) {
            window.alert(`Could not move ${name}\n${err}`);
            continue;
          }
          pasted.push({ path: to, kind: item.kind });
        } else {
          const to = await uniquePastePath(destDir, name, item.kind);
          // The document's html rendition and comments are copied with it,
          // as delete and move take them along.
          let left: LeftBehind[];
          try {
            left = await backend.documents.copy(item.path, to, item.kind);
          } catch (e) {
            window.alert(`Could not copy ${name}\n${e}`);
            continue;
          }
          copiedAny = true;
          for (const l of left) {
            window.alert(`Copied ${name} but not its ${PART_LABEL[l.part]}.\n${l.error}`);
          }
          pasted.push({ path: to, kind: item.kind });
        }
      }
      if (clip.cut && pasted.length > 0) {
        // A cut is consumed by its paste (VS Code): a second ⌘V must not try
        // to move files that already left.
        backend.fileClipboard.clear().catch(() => {});
      }
      if (copiedAny) setTreeRefreshToken((t) => t + 1); // moves refresh on their own
      if (pasted.length > 0) selectSidebarEntries(pasted);
    },
    [movePath, selectSidebarEntries, confirmMove],
  );

  // Trash a whole selection, outermost entries only — deleting a folder
  // already takes its selected children with it.
  const deleteEntries = useCallback(
    async (entries: SidebarSelection[]) => {
      const outer = pruneNestedSelection(entries);
      if (outer.length === 0) return;
      // Where a delete cannot be taken back, it is asked first.
      if (!backend.documents.removeUndoes) {
        const [first] = outer;
        const one = outer.length === 1;
        const name = first.kind === "file" ? basename(first.path).replace(/\.(md|markdown|mdown|mkd|html)$/i, "") : basename(first.path);
        const sure = await askUser({
          title: one ? `Delete “${name}”?` : `Delete ${outer.length} items?`,
          body: `${
            !one ? "They are" : first.kind === "dir" ? "The folder and everything in it are" : "It is"
          } deleted for everyone who can open ${one ? "it" : "them"}, and this ${backend.device} can’t bring ${
            one ? "it" : "them"
          } back.`,
          confirm: "Delete",
        });
        if (!sure) return;
      }
      for (const s of outer) await deleteEntry(s.path, s.kind);
    },
    [deleteEntry, askUser],
  );

  useEffect(() => {
    (async () => {
      if (backend.untitled) untitledDir = await backend.untitled.dir();

      // Ask the backend who we are and what to open (the window label is the
      // authority). A spawned window initializes from its stashed file/folder
      // or its saved tabs, and skips the stored-session restore and
      // pending-open consumption — those belong to the main window.
      const init = backend.windows ? await backend.windows.init() : ONLY_WINDOW;
      if (!init.isMain) {
        isMainWindow = false;
        if (init.restored) {
          // A window brought back by quit-time session restore: re-adopt its
          // folder and rebuild its tabs directly — restoring isn't an "open"
          // (openTab/setWorkspace would activate each tab in turn and force the
          // sidebar open). Unreadable paths stay visible as ghost tabs and
          // untitled notes come back unsaved, same as the main window's restore.
          if (init.folder) setWorkspaceRoot(init.folder);
          const restored = await rebuildTabs(sanitizeTabs(init.tabs));
          if (restored.length > 0) {
            const active =
              restored.find((t) => t.id === init.activeId) ?? restored[restored.length - 1];
            tabsRef.current = restored;
            activeIdRef.current = active.id;
            setTabs(restored);
            setActiveId(active.id);
            await loadActiveContent(active);
          }
        } else {
          if (init.folder) setWorkspace(init.folder);
          if (init.file) await openTab(init.file);
        }
        setReady(true);
        return;
      }

      // Which workspace are we opening? A CLI / Finder folder launch
      // (pendingFolder) targets that folder; a backend that is for one
      // workspace opens that one; otherwise reopen the last-active
      // workspace. Tabs are keyed by workspace, so we restore ONLY the target
      // directory's own tabs — a different directory's tabs never leak in.
      // (Files never arrive as a pending folder: an externally opened file
      // always gets its own spawned window, so it can't attach to this session.)
      const pendingFolder = (await backend.windows?.pendingFolder()) ?? null;
      const all = readAllSessions();
      const targetRoot = pendingFolder ?? backend.home ?? all.lastRoot;
      // Adopt the target root into the module mirror BEFORE any
      // writeStoredSession below, so re-persisting keys tabs under the right
      // folder rather than wiping the map.
      sessionWorkspaceRoot = targetRoot;

      // Restore that folder's persisted tabs. A file tab whose path no longer
      // reads is kept as a visible "ghost" (missing) tab rather than silently
      // dropped — the disk may just be unmounted, and the user decides whether
      // to close it. An untitled note comes back unsaved, with its text.
      const session = all.sessions[sessionKeyFor(targetRoot)] ?? {
        tabs: [],
        activeId: null,
      };
      const restored = await rebuildTabs(session.tabs);

      // Then every untitled note that no window has open. Normally there are
      // none — a note's buffer is deleted with its tab — but one outlives its
      // tab when the app dies between the two, when this launch opens a
      // different folder than the one the note was last seen in, or when a
      // session is lost. It is still unsaved work, so it is opened here
      // rather than left where nothing shows it. (Its tab id is its buffer's
      // name, so a note that was the active tab is the active tab again.)
      const orphans = backend.untitled
        ? await backend.untitled.orphans(restored.filter(isUntitled).map((t) => t.path)).catch((e) => {
            console.error("orphaned untitled failed", e);
            return [] as string[];
          })
        : [];
      for (const path of orphans) {
        const note = await restoreUntitled(basename(path).replace(MD_EXT_RE, ""), path);
        if (note && !restored.some((t) => t.id === note.id)) restored.push(note);
      }

      if (restored.length > 0) {
        const activeId =
          session.activeId && restored.some((t) => t.id === session.activeId)
            ? session.activeId
            : restored[restored.length - 1].id;
        tabsRef.current = restored;
        activeIdRef.current = activeId;
        setTabs(restored);
        setActiveId(activeId);
        writeStoredSession(restored, activeId);
        const active = restored.find((t) => t.id === activeId);
        if (active) await loadActiveContent(active);
        // Reinstate the persisted split, when its tab survived the restore.
        const sp = session.split ?? null;
        if (sp && restored.some((t) => t.id === sp.tabId)) {
          if (sp.tabId === activeId) {
            await splitSameDocRef.current(sp.side, sp.view);
          } else {
            await openInPaneRef.current(sp.tabId, sp.side, sp.view);
          }
        }
      }
      // Nothing to restore → no tab open (welcome screen).

      if (pendingFolder) {
        setWorkspace(pendingFolder);
      } else if (targetRoot) {
        // Reopen the last workspace — via setWorkspaceRoot, not setWorkspace:
        // restoring shouldn't force the sidebar open (its state is persisted
        // separately). A root that doesn't read right now
        // stays in the stored session (see sessionWorkspaceRoot) but isn't
        // shown, so an unmounted drive self-heals on a later launch.
        const exists = await backend.documents.exists(targetRoot).catch(() => false);
        if (exists) setWorkspaceRoot(targetRoot);
      }
      setReady(true);
    })();
  }, [openTab, setWorkspace, loadActiveContent, rebuildTabs]);

  // Report this window's content (workspace folder + tabs + active tab) to the
  // backend whenever it changes, so folder opens and the in-app "open in new
  // window" actions can focus the window that already shows a path instead of
  // opening a duplicate, and so the backend's persisted session (session.json)
  // can respawn this window after a quit — untitled notes included. (External
  // file opens always spawn a new window and never consult this registry.)
  //
  // Not before the window is ready: until then the registry holds what this
  // window is ABOUT to restore, and that is what keeps another window from
  // taking its untitled notes for ones nobody has open. And keyed on the
  // serialized report, so the tab state that isn't part of it — a note's title
  // changing as it is typed — doesn't cross the bridge on every keystroke.
  const windowReport = useMemo(
    () => JSON.stringify({ folder: workspaceRoot, tabs: tabs.map(toStoredTab), activeId }),
    [workspaceRoot, tabs, activeId],
  );
  useEffect(() => {
    if (ready) backend.windows?.report(JSON.parse(windowReport));
  }, [ready, windowReport]);

  useEffect(() => {
    return backend.documents.onChange(({ path, part }: DocumentChange) => {
      // The split pane's document changed somewhere else: refresh that pane.
      // It is never the active document (a same-document split has no record
      // and falls through to the active branches below).
      const sd = splitRef.current?.doc;
      if (sd && path === sd.path) {
        if (part === "text") {
          void (async () => {
            try {
              const r = await backend.documents.read(sd.path);
              const cur = splitRef.current;
              if (!cur?.doc || cur.doc.path !== sd.path) return;
              captureCompanionScroll(); // the pane's editor remounts on new content
              companionMdRef.current = { md: "", baseline: "", baselined: false };
              bumpEditorSeq(cur.tabId);
              const htmlOnly = cur.doc.kind === "file" && isHtmlPath(cur.doc.path);
              const { meta } = await readEntityMeta(sd.path);
              const fm = splitFrontmatter(htmlOnly ? "" : r.text);
              const full = htmlOnly ? "" : expandMarkdown(fm.body, meta.mthreads).md;
              setSplitState({
                ...cur,
                doc: {
                  ...cur.doc,
                  missing: false,
                  head: htmlOnly ? cur.doc.head : fm.head,
                  contents: full,
                  snapshot: htmlOnly ? null : r.rev,
                  htmlContent: htmlOnly ? r.text : cur.doc.htmlContent,
                  dirty: false,
                  conflict: null,
                },
              });
            } catch {
              // mid-rewrite; the next change covers it
            }
          })();
        } else if (part === "rendition") {
          const htmlPath = sd.htmlPath;
          if (!htmlPath) return;
          void (async () => {
            try {
              const r = await backend.documents.read(htmlPath);
              const cur = splitRef.current;
              if (!cur?.doc || cur.doc.htmlPath !== htmlPath) return;
              setSplitState({
                ...cur,
                doc: { ...cur.doc, htmlContent: cur.view === "html" ? r.text : null },
              });
            } catch {
              // mid-rewrite; the next change covers it
            }
          })();
        } else {
          // The pane entity's META changed (sync delivered a teammate's
          // thread or reply): refresh the pane's threads and re-expand its
          // markdown.
          void (async () => {
            try {
              const { meta, metaExists } = await readEntityMeta(sd.path);
              const cur = splitRef.current;
              if (!cur?.doc || cur.doc.path !== sd.path) return;
              const htmlOnly = cur.doc.kind === "file" && isHtmlPath(cur.doc.path);
              let contents = cur.doc.contents;
              let ids = new Set<string>();
              if (!htmlOnly) {
                const r = await backend.documents.read(sd.path);
                const body = splitFrontmatter(r.text).body;
                ids = markerIds(body);
                contents = expandMarkdown(body, meta.mthreads).md;
                if (contents !== cur.doc.contents) {
                  captureCompanionScroll();
                  companionMdRef.current = { md: "", baseline: "", baselined: false };
                  bumpEditorSeq(cur.tabId);
                }
              }
              setSplitState({
                ...cur,
                doc: {
                  ...cur.doc,
                  contents,
                  threads: meta.hthreads,
                  sidecarExists: metaExists,
                  mdThreads: meta.mthreads.filter((t) => ids.has(t.id)),
                  mdOrphans: meta.mthreads.filter((t) => !ids.has(t.id)),
                  metaForeign: meta.foreign,
                },
              });
            } catch {
              // mid-rewrite; the next change covers it
            }
          })();
        }
        return;
      }
      const activeDocPath = pathRef.current ?? htmlPathRef.current;
      if (activeDocPath === null || path !== activeDocPath) return;
      // The active entity's META changed (cloud sync delivered a teammate's
      // thread, another window wrote): fold it in — unless a local write is
      // pending, which would clobber a comment mid-typing; that write lands
      // in a moment and last-write-wins. Html threads land on the rail;
      // markdown thread bodies land IN PLACE on the open editor's marks
      // (three-way against the last saved state, so a reply typed here while
      // the change was in flight survives).
      if (part === "meta") {
        if (sidecarWriteTimerRef.current != null) return;
        void (async () => {
          try {
            const text = await backend.documents.meta(activeDocPath);
            if (text === null) return; // mid-rewrite; the next change covers it
            const meta = parseEntityMeta(text);
            htmlSidecarExistsRef.current = true;
            applyHtmlThreads(meta.hthreads);
            // Table widths adopt the incoming set for the NEXT open, but the
            // mounted editor is left alone: re-laying out a table under the
            // reader (possibly mid-drag) to match another device is worse
            // than the columns being one session out of date. Taking the
            // records now also means our next meta write echoes them back
            // rather than resurrecting what we loaded.
            adoptTableWidths(meta.tcols);
            metaForeignRef.current = meta.foreign;
            if (pathRef.current) {
              const ids = markerIds(currentMarkdownRef.current);
              const theirs = meta.mthreads.filter((t) => ids.has(t.id));
              const mine = extractMarkdown(currentMarkdownRef.current).mthreads;
              const mergedLive = mergeMdThreads(mdThreadsRef.current, mine, theirs);
              mdThreadsRef.current = mergedLive;
              editorRef.current?.refreshThreadBodies(
                new Map(mergedLive.map((t) => [t.id, t.comments])),
              );
              const orphans = meta.mthreads.filter((t) => !ids.has(t.id));
              mdOrphansRef.current = orphans;
              setMdOrphans(orphans);
            } else {
              mdOrphansRef.current = meta.mthreads;
              setMdOrphans([]);
            }
          } catch {
            // mid-rewrite; the next change covers it
          }
        })();
        return;
      }
      // The active document's html changed (e.g. regenerated by an AI tool):
      // its rendition, or the text of a document that is html alone.
      // Re-render it. The markdown editor — and its dirty/conflict flow — is
      // untouched.
      if (part === "rendition" || pathRef.current === null) {
        const htmlPath = htmlPathRef.current;
        if (!htmlPath) return;
        void (async () => {
          try {
            const r = await backend.documents.read(htmlPath);
            setHtmlContent(r.text);
          } catch {
            // mid-rewrite; the next change covers it
          }
        })();
        return;
      }
      // The active document's text changed somewhere else. A change to the
      // frontmatter block alone — an agent tagged the note, a teammate's Mac
      // synced one — leaves the body exactly as we last saved it, so there is
      // nothing to reload: adopt the new block, take the new rev, and leave
      // the editor and its caret alone. Only a body change from outside still
      // goes through reload / conflict.
      void (async () => {
        const target = path;
        let r: DocumentText;
        try {
          r = await backend.documents.read(target);
        } catch {
          return; // mid-rewrite; the next change covers it
        }
        if (pathRef.current !== target) return;
        const fm = splitFrontmatter(r.text);
        if (fm.body === lastDiskMdRef.current) {
          adoptFrontmatter(r.text);
          snapshotRef.current = r.rev;
          return;
        }
        if (dirtyRef.current || conflictRef.current) {
          setConflict({ theirs: r.rev });
        } else {
          await reloadFromDisk();
        }
      })();
    });
  }, [
    reloadFromDisk,
    applyHtmlThreads,
    adoptTableWidths,
    captureCompanionScroll,
    bumpEditorSeq,
    setSplitState,
    readEntityMeta,
    adoptFrontmatter,
  ]);


  // Closing the window. Two things have to happen before it goes.
  //
  // Its untitled notes are settled — if this window is not coming back. The
  // main window always does: the next launch restores its tabs, notes and
  // all, so closing it asks nothing. Any other window is gone for good once
  // closed (only a quit keeps it for the next launch), so each of its notes
  // closes the way a tab does — asking about the ones with text — and a
  // Cancel keeps the window open.
  //
  // Then the flush: type-then-close within the autosave debounce would lose
  // the last keystrokes if the window went before the fire-and-forget
  // save resolved. Intercept the close, await the pending write, then
  // destroy the window for real. A second close request while the flush is in
  // flight is let through untouched — the escape hatch if the write ever
  // hangs; one that arrives while a question is up is simply held.
  const closingRef = useRef<"asking" | "flushing" | null>(null);
  useEffect(() => {
    const win = backend.windows;
    if (!win) return;
    return win.onCloseRequested(async (event) => {
      if (closingRef.current === "flushing") return;
      event.preventDefault();
      if (closingRef.current === "asking") return;
      if (!isMainWindow) {
        closingRef.current = "asking";
        for (const note of tabsRef.current.filter(isUntitled)) {
          if (!(await closeTab(note.id))) {
            closingRef.current = null;
            return;
          }
        }
      }
      closingRef.current = "flushing";
      try {
        await Promise.all([flushPendingAutosave(), flushSidecarWrite()]);
      } finally {
        win.destroy();
      }
    });
  }, [closeTab, flushPendingAutosave, flushSidecarWrite]);

  // The close-requested flush above never fires on a quit, which closes no
  // window: the backend asks every window to flush instead, and goes once
  // each has (or after about a second). Quitting asks nothing about untitled
  // notes: with their buffers flushed here and their tabs in the session, the
  // next launch brings each one back as it was — unsaved.
  useEffect(
    () => backend.windows?.onQuit(() => Promise.all([flushPendingAutosave(), flushSidecarWrite()])),
    [flushPendingAutosave, flushSidecarWrite],
  );

  // Where the page itself can go with no window to ask first, the same
  // flush is handed over whenever it may be about to. Both writes are begun
  // before either is waited for: the backend has them by the time this
  // returns.
  useEffect(
    () => backend.leaving?.onLeave(() => Promise.all([flushPendingAutosave(), flushSidecarWrite()])),
    [flushPendingAutosave, flushSidecarWrite],
  );


  // An untitled note is known by its first line and is unsaved for as long
  // as it has text: keep its tab saying both as the text changes. Neither is
  // persisted — a restore reads them back out of the buffer — so this is tab
  // state only.
  const syncUntitledTab = useCallback((md: string) => {
    const id = activeIdRef.current;
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.kind !== "untitled") return;
    const title = noteTitle(md);
    const unsaved = noteHasText(md);
    if (tab.title === title && tab.unsaved === unsaved) return;
    const next = tabsRef.current.map(
      (t): Tab => (t.id === id && t.kind === "untitled" ? { ...t, title, unsaved } : t),
    );
    tabsRef.current = next;
    setTabs(next);
  }, []);

  // A change from the focused pane's editor — the instance keyed `editorKey`.
  // Only the instance the machinery was loaded for is listened to. A tab
  // switch re-renders (new active tab → a new editor key) before the
  // incoming document has been read, so for a moment an editor is mounted
  // under the incoming tab that still holds the OUTGOING document's text; its
  // mount-time serialization must not become the incoming document's
  // baseline, content or title. The load replaces that instance by bumping
  // the tab's seq, and from then on only the replacement's key matches.
  const onMarkdownChange = useCallback(
    (editorKey: string, md: string) => {
      const loaded = loadedIdRef.current;
      if (
        loaded === null ||
        editorKey !== `${loaded}:${editorSeqRef.current.get(loaded) ?? 0}`
      ) {
        return;
      }
      currentMarkdownRef.current = md;
      syncUntitledTab(md);
      // The first onChange after a (re)mount is the editor's own mount-time
      // serialization of the loaded doc (Editor emits it explicitly). Re-baseline
      // on it so Milkdown's markdown normalization alone never counts as an edit.
      if (!baselineCapturedRef.current) {
        lastSavedRef.current = md;
        baselineCapturedRef.current = true;
        return;
      }
      const changed = md !== lastSavedRef.current;
      setDirty(changed);
      if (changed) scheduleAutosave();
    },
    [scheduleAutosave, syncUntitledTab],
  );

  // The focused editor's table columns were resized (or a header edit moved a
  // record to a new id — see tableWidths.ts). Widths never reach the markdown,
  // so this is their only save path: straight into the entity meta, on the
  // same debounce the comment rail uses. The document is NOT marked dirty —
  // its text is byte-for-byte what it was.
  const onTableWidthsChange = useCallback(
    (records: TableCols[]) => {
      if (tableWidthsKey(records) === tableWidthsKey(tableWidthsRef.current)) return;
      adoptTableWidths(records);
      scheduleSidecarWrite();
    },
    [adoptTableWidths, scheduleSidecarWrite],
  );

  // ⌘S. Files autosave continuously, so for one it only lands a pending
  // write; an untitled note is the one thing ⌘S actually saves.
  const handleSave = useCallback(() => {
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!active) return;
    if (active.kind === "untitled") void saveUntitled();
    else void flushPendingAutosave();
  }, [flushPendingAutosave, saveUntitled]);

  // Highlights are driven by the query alone, NOT by whether the find bar is
  // visible — so opening a workspace-search result can highlight the match
  // without showing the bar. An empty query clears the highlights. Re-applies
  // after the editor remounts for a new doc (keyed by loadKey) and after a
  // split focus swap retargets editorRef (keyed by activeId; the swap clears
  // the demoted editor's highlights itself); calls before mount are buffered
  // inside Editor.
  useEffect(() => {
    if (findQuery) {
      editorRef.current?.setSearch(findQuery, findCase);
    } else {
      editorRef.current?.clearSearch();
    }
  }, [findQuery, findCase, loadKey, activeId]);

  // Closing the bar ends the find session: clear the query (which clears the
  // highlights via the effect above).
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);

  // ⌘⇧F: reveal the sidebar in Search mode and focus its input. With no
  // workspace open yet, pick a folder first, then drop into search.
  const openWorkspaceSearch = useCallback(async () => {
    if (workspaceRoot) {
      setSidebarOpen(true);
      setSidebarMode("search");
      setWsFocusToken((t) => t + 1);
      return;
    }
    try {
      const chosen = await backend.localFiles?.pickFolder();
      if (chosen) {
        await openWorkspace(chosen);
        setSidebarMode("search");
        setWsFocusToken((t) => t + 1);
      }
    } catch (e) {
      console.error("open folder failed", e);
    }
  }, [workspaceRoot, openWorkspace]);

  // Open a workspace-search result: load the file, then seed the search query
  // so the match is highlighted and scrolled into view (WYSIWYG has no line to
  // jump to). We deliberately do NOT open the find bar — the highlight alone is
  // the "you landed here" cue; Esc clears it (see the keydown handler). A
  // document found by its name alone (null) just opens, as from the tree.
  const openResult = useCallback(
    async (p: string, query: string | null) => {
      if (query === null) {
        await openTab(p);
        return;
      }
      viewPrefsRef.current.set(p, "md"); // the match lives in the markdown
      await openTab(p);
      if (docViewRef.current === "html") await selectDocView("md");
      setFindCase(wsCase);
      setFindQuery(query);
    },
    [openTab, selectDocView, wsCase],
  );

  // The one place document zoom moves: the window key handler below and the
  // rendition frame's forwarded chords (it swallows keys of its own — see
  // HtmlView) both land here. 1 = in, -1 = out, 0 = reset.
  const nudgeDocZoom = useCallback((dir: number) => {
    setDocZoom((z) => (dir === 0 ? DOC_ZOOM_DEFAULT : stepDocZoom(z, dir > 0 ? 1 : -1)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc dismisses an active in-file highlight even when the find bar isn't
      // shown (e.g. after landing on a workspace-search result). When the bar IS
      // open and its input is focused, FindBar handles Esc itself; this is the
      // fallback for when focus is elsewhere.
      if (e.key === "Escape") {
        if (findQueryRef.current) {
          setFindOpen(false);
          setFindQuery("");
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "f" && e.shiftKey) {
        e.preventDefault();
        void openWorkspaceSearch();
      } else if (k === "f" && !e.shiftKey) {
        e.preventDefault();
        const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
        // Find drives the markdown editor; there's nothing to search in the
        // rendered html view.
        if (active && !active.missing && !isUnsupportedTab(active) && docViewRef.current === "md") {
          setFindOpen(true);
          setFindFocusToken((t) => t + 1);
        }
      } else if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      } else if ((k === "n" || k === "t") && !e.shiftKey) {
        // ⌘N and ⌘T both open a new untitled tab (⌘T is the macOS/VS Code
        // "new tab" convention; the tab-per-document model makes them the same).
        e.preventDefault();
        void newUntitled();
      } else if (k === "w" && !e.shiftKey) {
        // ⌘W closes the active tab — asking first if it is an untitled note
        // with text; with none left it closes the window (see
        // onCloseRequested). ⌘⇧W always closes the window (native menu item).
        // VS Code / Chrome convention.
        e.preventDefault();
        if (activeIdRef.current) void closeTab(activeIdRef.current);
        else backend.windows?.close();
      } else if (k === "backspace") {
        // ⌘⌫ moves the selected entries to the Trash — but only when focus is
        // outside the editor, so it stays Milkdown's delete-to-line-start while
        // typing. (A sidebar-row handler can't be relied on: WebKit doesn't
        // focus buttons on click, so the row never holds focus to receive the
        // key.)
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.closest(".editor-wrap")) return;
        // In a text field it is the field's own: delete to the line's start,
        // or the word before the caret.
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        const sels = sidebarSelectionRef.current;
        if (
          workspaceRoot != null &&
          sidebarOpen &&
          (sels.length > 1 || sels[0]?.kind === "dir")
        ) {
          // A multi-selection (or a folder — never an open tab) can only be
          // targeted while its highlight is visible in the tree. A single
          // selected FILE falls through to the active tab below: tree rows
          // never hold focus (see above), so the tab is the safer read of
          // what "the selected file" means.
          e.preventDefault();
          void deleteEntries(sels);
        } else {
          const active = tabsRef.current.find((tb) => tb.id === activeIdRef.current);
          if (active?.kind === "file") {
            e.preventDefault();
            void deleteEntries([{ path: active.path, kind: "file" }]);
          }
        }
      } else if ((k === "c" || k === "x" || k === "v") && !e.shiftKey && !e.altKey) {
        // ⌘C/⌘X/⌘V on sidebar entries (VS Code's explorer clipboard) — only
        // when focus is outside the editor and any text field, and no text is
        // selected anywhere, so the native text clipboard keeps working
        // everywhere it does today.
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.closest(".editor-wrap")) return;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        if (workspaceRoot == null || !sidebarOpen) return;
        if (k === "v") {
          const sels = sidebarSelectionRef.current;
          const primary = sels[sels.length - 1];
          const destDir = primary
            ? primary.kind === "dir"
              ? primary.path
              : dirname(primary.path)
            : workspaceRoot;
          e.preventDefault();
          void pasteEntries(destDir);
        } else {
          const sels = sidebarSelectionRef.current;
          if (sels.length === 0) return;
          e.preventDefault();
          void copyEntries(sels, k === "x");
        }
      } else if (e.code === "KeyO") {
        // Use e.code, not e.key: on macOS holding ⌥ remaps e.key (⌥O → "ø").
        // ⌥ → open in a NEW window; ⇧ → folder instead of file.
        e.preventDefault();
        if (e.altKey && e.shiftKey) void openFolderInNewWindow();
        else if (e.altKey) void openFileInNewWindow();
        else if (e.shiftKey) void openFolderPicker();
        else void openFilePicker();
      } else if (e.code === "Tab" && e.ctrlKey) {
        // Ctrl+Tab / Ctrl+⇧Tab: cycle tabs within this window (VS Code style).
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.code === "Backquote" && e.metaKey) {
        // ⌘` / ⌘⇧`: cycle between this app's windows (Safari style).
        e.preventDefault();
        backend.windows?.focusNext(e.shiftKey);
      } else if (e.code === "Backslash" && e.shiftKey) {
        // ⌘⇧\ (reads as "|" in e.key, hence e.code): toggle the split view.
        e.preventDefault();
        void toggleSplit();
      } else if (k === "\\") {
        e.preventDefault();
        if (workspaceRoot) setSidebarOpen((v) => !v);
      } else if (e.code === "KeyH" && e.altKey) {
        // ⌘⌥H: the version rail for the open document. e.code, not e.key:
        // on macOS ⌥ remaps e.key (⌥H → "˙").
        e.preventDefault();
        toggleHistory();
      } else if (e.code === "Equal" || e.code === "NumpadAdd") {
        // ⌘+ / ⌘- / ⌘0: document zoom, both versions (see DOC_ZOOM_STEPS).
        // e.code, not e.key: on most layouts ⌘+ arrives as ⌘⇧= — matching the
        // physical key accepts it with or without shift, like every browser.
        // It fires wherever focus is (typing included): resizing the text you
        // are reading is never ambiguous.
        e.preventDefault();
        nudgeDocZoom(1);
      } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        nudgeDocZoom(-1);
      } else if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        nudgeDocZoom(0);
      } else if (k === "z" && !e.shiftKey) {
        // ⌘Z restores a trashed file — but only when focus is outside the
        // editor, so it stays as Milkdown's text-undo while typing.
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.closest(".editor-wrap")) return;
        if (deletedStackRef.current.length) {
          e.preventDefault();
          void undoDelete();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    handleSave,
    newUntitled,
    toggleHistory,
    closeTab,
    deleteEntry,
    deleteEntries,
    copyEntries,
    pasteEntries,
    openFolderPicker,
    openFilePicker,
    openFileInNewWindow,
    openFolderInNewWindow,
    cycleTab,
    workspaceRoot,
    sidebarOpen,
    undoDelete,
    openWorkspaceSearch,
    selectDocView,
    toggleSplit,
    nudgeDocZoom,
  ]);

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    // A file goes by its full name here; an untitled note by its first line.
    const name = !active
      ? "Doklin"
      : active.kind === "untitled"
        ? tabLabel(active)
        : basename(active.path);
    const edited = active != null && (dirty || isUnsaved(active));
    backend.setTitle(`${edited ? "● " : ""}${name}`);
  }, [tabs, activeId, dirty]);

  // Stable element/handle sinks for the two panes (inline arrows would
  // re-fire ref callbacks every render).
  const setLeftWrapEl = useCallback((el: HTMLElement | null) => {
    wrapElsRef.current.left = el;
  }, []);
  const setRightWrapEl = useCallback((el: HTMLElement | null) => {
    wrapElsRef.current.right = el;
  }, []);
  const setLeftHtmlHandle = useCallback((h: HtmlViewHandle | null) => {
    htmlHandlesRef.current.left = h;
  }, []);
  const setRightHtmlHandle = useCallback((h: HtmlViewHandle | null) => {
    htmlHandlesRef.current.right = h;
  }, []);
  const hoverLeft = useCallback(() => {
    hoverSideRef.current = "left";
  }, []);
  const hoverRight = useCallback(() => {
    hoverSideRef.current = "right";
  }, []);
  const hoverNone = useCallback(() => {
    hoverSideRef.current = null;
  }, []);
  const scrollLeftWrap = useCallback(() => handleWrapScroll("left"), [handleWrapScroll]);
  const scrollRightWrap = useCallback(() => handleWrapScroll("right"), [handleWrapScroll]);
  const htmlRatioLeft = useCallback(
    (r: number) => publishPaneScroll("left", r),
    [publishPaneScroll],
  );
  const htmlRatioRight = useCallback(
    (r: number) => publishPaneScroll("right", r),
    [publishPaneScroll],
  );
  const promoteLeft = useCallback(() => promotePane("left"), [promotePane]);
  const promoteRight = useCallback(() => promotePane("right"), [promotePane]);
  // Pane-level pointerdown (capture): promote the unfocused pane — except
  // for header interactions, whose controls target the pane BY SIDE and must
  // act on the un-promoted wiring (promoting first would retarget their
  // click to the wrong document).
  const panePointerDownLeft = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".pane-header")) return;
      promotePane("left");
    },
    [promotePane],
  );
  const panePointerDownRight = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".pane-header")) return;
      promotePane("right");
    },
    [promotePane],
  );

  const resizeSidebar = useCallback((w: number) => {
    setSidebarWidth(Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(w))));
  }, []);

  // Divider drag: live ratio while the pointer moves, clamped so neither
  // pane collapses.
  const onDividerPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const area = editorAreaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      setSplitRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeMissing = activeTab?.missing === true;
  // A file that is not a document: its tab says so, with no document loaded.
  const activeUnsupported = activeTab != null && isUnsupportedTab(activeTab);
  // Nothing to edit, find in, publish or split: a ghost, or not a document.
  const activeNoDoc = activeMissing || activeUnsupported;
  const showSidebar = workspaceRoot != null && sidebarOpen;

  // Which ways in this platform has. One left undefined is a button or a
  // menu row that is not shown; the surfaces behind it are rendered only
  // with the group they call.
  const versionStore = backend.versions;
  const { setup, sync, domain, access } = backend;
  // A restricted folder is offered where one can be made and where there is
  // a list of people to put in it.
  const restricted = access && backend.spaces ? { access, spaces: backend.spaces } : undefined;
  const onJoinWorkspace = setup ? () => setCloudSetup("redeem") : undefined;
  const onNewNote = backend.untitled ? () => void newUntitled() : undefined;
  const onPickFile = backend.localFiles ? openFilePicker : undefined;
  const onPickFolder = backend.localFiles ? openFolderPicker : undefined;
  const ownWindows = backend.localFiles != null && backend.windows != null;
  const onHistory = versionStore ? (path: string) => void openHistory(path) : undefined;
  const activeFilePath = activeTab?.kind === "file" ? activeTab.path : null;
  // The document this window is editing — never a file that isn't one.
  const activeDocPath = activeUnsupported ? null : activeFilePath;
  // Presence: tell the engines which document this window is editing (a
  // file, or nothing) so other devices see "editing Projects/plan.md". The
  // Rust side decides which connected workspace, if any, it concerns.
  useEffect(() => {
    void backend.cloud.setActivity(activeDocPath).catch(() => {});
  }, [activeDocPath]);
  // Leases: the same report is this Mac's claim on the
  // document, and the status says which documents another Mac holds. One of
  // those opens view-only under a banner with *Take over*; it is advisory, so
  // nothing here refuses a write — the editor simply stops taking input, and
  // goes live again the moment the status says the lease moved.
  const activeLease = useMemo(() => leaseFor(cloudStatuses, activeDocPath), [cloudStatuses, activeDocPath]);
  const activeLeaseRef = useRef(activeLease);
  activeLeaseRef.current = activeLease;
  const leased = activeLease != null;
  const takeOverActive = useCallback(() => {
    const held = activeLeaseRef.current;
    if (held && activeDocPath) void backend.cloud.takeOver(held.status.root, activeDocPath).catch(() => {});
  }, [activeDocPath]);
  // An owner took this Mac's access to a workspace away. The engine has
  // already deleted the copy here — the folder, and
  // what Doklin kept for it — so this window lets go of it: its tabs close,
  // the folder stops being this window's, and a notice says what happened.
  // Every window hears the event; one that has nothing of that workspace
  // open stays quiet, except the main window, so the notice is always seen.
  const [removedNotice, setRemovedNotice] = useState<CloudRemovedEvent | null>(null);
  const readyRef = useRef(false);
  readyRef.current = ready;
  // Close the tabs of files that are gone from this Mac. There is nothing to
  // save, so the open document's writers stand down before its tab closes:
  // closing flushes, and a flush into a folder that no longer exists is an
  // error about a file nobody has any more.
  const closeGoneTabs = useCallback(
    async (under: (path: string) => boolean) => {
      if (pathRef.current && under(pathRef.current)) {
        catchUpWithEditor();
        if (autosaveTimerRef.current != null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        if (sidecarWriteTimerRef.current != null) {
          window.clearTimeout(sidecarWriteTimerRef.current);
          sidecarWriteTimerRef.current = null;
        }
        lastSavedRef.current = currentMarkdownRef.current;
      }
      if (historyForRef.current && under(historyForRef.current)) {
        setHistoryFor(null);
        setVersionPreview(null);
      }
      const doomed = tabsRef.current.filter((t) => t.kind !== "untitled" && under(t.path));
      for (const t of doomed) await closeTab(t.id);
    },
    [catchUpWithEditor, closeTab],
  );
  const leaveRemovedWorkspace = useCallback(
    async (e: CloudRemovedEvent) => {
      const key = `${e.root}@${e.at}`;
      if (shownRemovals.has(key)) return;
      shownRemovals.add(key);
      const under = (p: string) => p === e.root || p.startsWith(`${e.root}/`);
      const here = sessionWorkspaceRoot === e.root;
      const open = tabsRef.current.some((t) => t.kind !== "untitled" && under(t.path));
      if (!here && !open && !isMainWindow) return;
      setHistoryFor(null);
      setVersionPreview(null);
      await closeGoneTabs(under);
      if (here) {
        setCloudPanelOpen(false);
        setPublishedOpen(false);
        setPublishFolder(null);
        setAccessTab(null);
        setRestrictedSource(null);
        setAccessSpaceId(null);
        setHistoryRoot(null);
        setDeletedFor(null);
        forgetStoredSession(e.root);
        forgetTreeView(e.root);
        sessionWorkspaceRoot = null;
        setWorkspaceRoot(null);
        selectSidebarEntries([]);
        // What is left — untitled notes, files from elsewhere — is the
        // window's own now, with no folder behind it.
        writeStoredSession(tabsRef.current, activeIdRef.current);
      }
      setRemovedNotice(e);
    },
    [closeGoneTabs, selectSidebarEntries],
  );
  // A restricted folder left this Mac: this person was taken out of it, or
  // it was deleted — the engine has already removed its copy. The tabs of
  // what was in it close; and unless giving it up was done here, a line says
  // why it is gone.
  const givenUpRef = useRef<Set<string>>(new Set());
  const leaveSpaceFolder = useCallback(
    async (e: CloudSpaceLeftEvent) => {
      const dir = `${e.root}/${e.path}`;
      const under = (p: string) => p === dir || p.startsWith(`${dir}/`);
      await closeGoneTabs(under);
      const mine = givenUpRef.current.delete(dir);
      if (e.root !== sessionWorkspaceRoot) return;
      setHistoryRoot((r) => (r && under(r) ? null : r));
      setDeletedFor((d) => (d && under(d) ? null : d));
      setTreeRefreshToken((t) => t + 1);
      if (!mine) {
        pushToast(
          "info",
          `“${e.name}” is no longer on this ${backend.device} — you were taken out of it, or it was deleted.`,
        );
      }
    },
    [closeGoneTabs, pushToast],
  );
  // Sync wrote files: the tree refreshes (open tabs already reload through
  // the file watcher). A merge that left a conflict copy, or a mass
  // deletion the engine is holding, becomes a notice carrying the one
  // action that matters.
  // A removal can land before this window is listening, or before its tabs
  // are back: an engine hears it on first contact, at launch. So the event is
  // only acted on once the session is restored, and the list of everything
  // removed since the app started is read at that moment — whichever tells
  // this window first, it acts once.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void backend.sync
      ?.removed()
      .then(async (removed) => {
        for (const e of removed) if (live) await leaveRemovedWorkspace(e);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ready, leaveRemovedWorkspace]);
  useEffect(() => {
    const sync = backend.sync;
    const uns = [
      backend.cloud.onApplied((e) => {
        if (e.root === sessionWorkspaceRoot) setTreeRefreshToken((t) => t + 1);
      }),
      backend.cloud.onConflict((e) => {
        pushToast("warn", `${e.by} and this ${backend.device} both changed ${e.path} — both versions are kept.`, {
          label: "Open the copy",
          run: () => void openTab(`${e.root}/${e.conflictPath}`),
        });
      }),
      backend.cloud.onSpaceLeft((e) => {
        if (readyRef.current) void leaveSpaceFolder(e);
      }),
    ];
    // What only a device with a copy of its own hears.
    if (sync) {
      uns.push(
        sync.onRemoved((e) => {
          if (readyRef.current) void leaveRemovedWorkspace(e);
        }),
        sync.onAddressTaken((e) => {
          pushToast(
            "warn",
            `The address "${e.slug}" is already taken on this domain, so ${basename(e.path)} was not published.`,
          );
        }),
        sync.onPendingDeletes((e) => {
          setPendingDeletes(e);
          if (e.count > 0) {
            pushToast(
              "warn",
              `${e.count} files disappeared from ${basename(e.root)} — sync is holding the deletion.`,
              { label: "Review…", run: () => setCloudPanelOpen(true) },
            );
          }
        }),
        // Many new documents at once: the notice asks, with both answers on it.
        sync.onPendingAdds((e) => {
          setPendingAdds(e);
          if (e.root !== sessionWorkspaceRoot || e.count === 0) return;
          const open = cloudForRootRef.current;
          const name = open?.root === e.root ? open.name : basename(e.root);
          const answer = (yes: boolean) => () => {
            addsToastRef.current = null;
            sync.confirmAdds(e.root, yes).catch((err) => pushToast("error", errText(err)));
          };
          if (addsToastRef.current != null) dismissToast(addsToastRef.current);
          addsToastRef.current = pushToast(
            "warn",
            addsQuestion(e.count, e.folders, name),
            { label: e.count === 1 ? "Sync it" : "Sync them", run: answer(true) },
            { label: "Not now", run: answer(false) },
          );
        }),
      );
    }
    const versions = backend.versions;
    if (versions) {
      uns.push(
        // A restore wrote a document: the tree refreshes like sync's, and the
        // open editor reloads — the watcher stays quiet for our own writes.
        versions.onApplied((e) => {
          if (e.root === sessionWorkspaceRoot) setTreeRefreshToken((t) => t + 1);
          if (pathRef.current && e.paths.includes(pathRef.current)) void reloadFromDisk();
        }),
        // Every store's size, horizon and count, on every capture and sweep —
        // what the Versions settings reads.
        versions.onStatus((s) => setVersionStatuses(s)),
      );
    }
    return () => {
      for (const un of uns) un();
    };
  }, [openTab, pushToast, dismissToast, reloadFromDisk, leaveRemovedWorkspace, leaveSpaceFolder]);
  // Answered somewhere else — the Cloud panel, another window — the question
  // leaves the notice too. A pass runs through "syncing" while it waits.
  const cloudPhase = cloudForRoot?.phase;
  useEffect(() => {
    if (addsToastRef.current == null || cloudPhase === "pending-adds" || cloudPhase === "syncing") return;
    dismissToast(addsToastRef.current);
    addsToastRef.current = null;
  }, [cloudPhase, dismissToast]);
  // The version rail follows the document: switching tabs while it is open
  // shows the new one's history and drops the old one's preview.
  useEffect(() => {
    historyForRef.current = historyFor;
    historyTargetRef.current = activeDocPath;
    const open = historyTargetRef.current;
    if (historyFor && open && open !== historyFor) {
      setHistoryFor(open);
      setVersionPreview(null);
      setHistoryToken((t) => t + 1);
    }
  }, [activeDocPath, historyFor]);

  // The open note relative to the workspace: what the Live chip publishes
  // and whose presence the facepile shows. Null for an untitled note or a
  // file from outside the workspace.
  const activeRel =
    activeTab?.kind === "file" && workspaceRoot ? relPathIn(workspaceRoot, activeTab.path) : null;
  const hereNow = [
    ...new Set((cloudForRoot?.presence ?? []).filter((p) => p.path === activeRel).map((p) => p.name)),
  ];
  // The restricted folder whose people are being managed, as the status
  // lists it now — gone from the list (left, deleted, taken away), the
  // dialog has nothing to show and closes.
  const accessSpace: CloudSpace | null =
    (accessSpaceId && cloudForRoot?.spaces.find((sp) => sp.id === accessSpaceId)) || null;
  // html-only documents render in the iframe alone; there is no markdown
  // version to edit, so the editor never mounts and the MD side is disabled.
  const activeIsHtmlDoc = activeTab?.kind === "file" && isHtmlPath(activeTab.path);
  const showHtmlView = docView === "html" && !activeNoDoc;
  // The active document's rendition path, derived the way loadActiveContent
  // derives htmlPathRef (an html tab is its own rendition; an md tab uses the
  // existing sibling). The PDF export button needs it at render time, and
  // refs don't re-render.
  const activeHtmlPath =
    activeTab?.kind === "file"
      ? isHtmlPath(activeTab.path)
        ? activeTab.path
        : hasHtml
          ? htmlSiblingOf(activeTab.path)
          : null
      : null;
  // Split-view render model. `effectiveSplit` guards against a transient
  // record whose tab is mid-close (the janitor effect prunes it right after).
  const splitTab = split ? tabs.find((t) => t.id === split.tabId) ?? null : null;
  const effectiveSplit = split && splitTab ? split : null;
  const focusedSide: PaneSide = effectiveSplit ? otherSide(effectiveSplit.side) : "left";
  const canSplit = activeTab != null && !activeNoDoc;
  // No hooks below this line: a hook after the early return crashes React
  // ("rendered more hooks than during the previous render") the moment
  // `ready` flips, unmounting the whole app.
  if (!ready) return null;

  // One editor pane (either side, either role). BOTH roles render the same
  // slot structure — header?, [FindBar?, Editor?, HtmlView?, Missing?,
  // Scratch?, Hud?] — so a focus swap only changes props: the editors are
  // keyed per document and never remount across a swap.
  const renderPane = (side: PaneSide) => {
    if (!effectiveSplit && side === "right") return null;
    const focused = side === focusedSide;
    const s = effectiveSplit;
    const doc = s?.doc ?? null;
    const paneTab = focused ? activeTab : splitTab;
    const paneView: DocView = focused ? docView : s!.view;
    const paneMissing = focused ? activeMissing : doc ? doc.missing : activeMissing;
    // A file that is not a document: no editor, no rendition — the pane says so.
    const paneUnsupported = paneTab != null && isUnsupportedTab(paneTab);

    // A same-document split pane on markdown is a read-only MIRROR of the
    // live editor (see the SplitPane comment).
    const isMirror = !focused && s != null && !s.doc && s.view === "md";
    const showEditorHere =
      !paneUnsupported &&
      (focused
        ? activeTab != null && !activeMissing && !activeIsHtmlDoc
        : isMirror
          ? !activeMissing
          : doc != null &&
            s!.view === "md" &&
            !doc.missing &&
            !(doc.kind === "file" && isHtmlPath(doc.path)));
    const editorKey = focused
      ? `${activeTab?.id}:${editorSeqRef.current.get(activeTab?.id ?? "") ?? 0}`
      : isMirror
        ? `mirror:${s!.tabId}:${mirror.seq}`
        : `${s!.tabId}:${editorSeqRef.current.get(s!.tabId) ?? 0}`;

    const paneHtmlContent = focused
      ? showHtmlView
        ? htmlContent
        : null
      : doc
        ? s!.view === "html"
          ? doc.htmlContent
          : null
        : htmlContent; // same-document split: the active doc's rendition
    const showHtmlHere =
      paneTab != null && !paneMissing && paneView === "html" && paneHtmlContent != null;

    // Header facts (split mode only): which toggle sides exist.
    const paneIsHtmlOnlyDoc = focused
      ? activeIsHtmlDoc
      : doc != null ? doc.kind === "file" && isHtmlPath(doc.path) : activeIsHtmlDoc;
    const paneHasHtml = focused ? hasHtml : doc ? doc.hasHtml : hasHtml;

    // An old version shows in the document area itself, read-only, with the
    // live editor hidden behind it — so nothing typed here can ever be
    // autosaved over the newer text.
    const previewHere =
      focused &&
      versionPreview != null &&
      (versionPreview.docPath === paneTab?.path || versionPreview.detached === true);
    // Another Mac holds this document: view-only, under the banner. Only the
    // focused pane can be held against — an unfocused one is read-only
    // already, and promoting it makes it the document this Mac claims.
    const leasedHere = focused && leased && paneTab?.kind === "file";

    const wrapClass = focused
      ? `editor-wrap ${showHtmlView ? "is-html-view" : ""} ${
          previewHere ? "is-version-preview" : ""
        }`
      : `editor-wrap ${paneView === "html" ? "is-html-view" : ""}`;

    return (
      <section
        className={`editor-pane ${focused ? "is-focused" : ""} ${
          effectiveSplit ? "is-split" : ""
        }`}
        style={
          effectiveSplit
            ? side === "left"
              ? { flexBasis: `${splitRatio * 100}%` }
              : undefined
            : undefined
        }
        data-side={side}
        onMouseEnter={side === "left" ? hoverLeft : hoverRight}
        onPointerDownCapture={
          side === effectiveSplit?.side && !focused
            ? side === "left"
              ? panePointerDownLeft
              : panePointerDownRight
            : undefined
        }
      >
        {effectiveSplit && paneTab && (
          <PaneHeader
            title={tabLabel(paneTab)}
            focused={focused}
            missing={paneMissing}
            view={paneView}
            hasMd={!paneIsHtmlOnlyDoc}
            hasHtml={paneHasHtml}
            toolSlotRef={side === "left" ? setLeftToolSlot : setRightToolSlot}
            onSelectView={(v) =>
              focused ? void selectDocView(v) : void setCompanionView(v)
            }
            onClose={() => void closePane(side)}
          />
        )}
        <div
          className={wrapClass}
          ref={side === "left" ? setLeftWrapEl : setRightWrapEl}
          onScroll={side === "left" ? scrollLeftWrap : scrollRightWrap}
        >
          {focused && findOpen && activeTab && !activeNoDoc && docView === "md" && (
            <FindBar
              query={findQuery}
              onQueryChange={setFindQuery}
              count={findInfo.count}
              current={findInfo.current}
              caseSensitive={findCase}
              onToggleCase={() => setFindCase((v) => !v)}
              onNext={() => editorRef.current?.searchNext()}
              onPrev={() => editorRef.current?.searchPrev()}
              onClose={closeFind}
              focusToken={findFocusToken}
            />
          )}
          {focused && conflict && (
            // The open document changed on disk under unsaved edits: the
            // question sits over the document it is about.
            <ConflictBanner
              onReload={() => void reloadFromDisk()}
              onKeep={keepMyVersion}
            />
          )}
          {leasedHere && activeLease && showEditorHere && paneView === "md" && !previewHere && (
            <LeaseBanner lease={activeLease.lease} onTakeOver={takeOverActive} />
          )}
          {focused && showEditorHere && frontmatter && (
            // The note's frontmatter, as the file has it. Read-only: the
            // editor never sees the block, and agents and other tools own it
            // (src/frontmatter.ts).
            <div className="doc-frontmatter">
              <pre aria-label="Frontmatter">{frontmatter}</pre>
            </div>
          )}
          {showEditorHere && (
            // Three wirings, one slot: the live machinery editor (focused),
            // a two-document companion (read-only, promotes on edit), or a
            // same-document mirror (read-only snapshot of the live editor;
            // comment layer off — its rail would accept edits that the next
            // refresh silently discards).
            <Editor
              key={editorKey}
              ref={focused ? editorRef : isMirror ? undefined : companionEditorRef}
              initialMarkdown={
                focused ? initialMarkdown : isMirror ? mirror.content : doc!.contents
              }
              onChange={
                focused
                  ? (md) => onMarkdownChange(editorKey, md)
                  : isMirror
                    ? noopMarkdownChange
                    : onCompanionMarkdownChange
              }
              onSearchState={focused ? setFindInfo : undefined}
              onReady={focused ? restoreActiveScroll : restoreCompanionScroll}
              commentAuthor={deviceName}
              commentsVisible={commentsVisible && !isMirror}
              onCommentsCount={focused ? setCommentCount : undefined}
              onRequestShowComments={focused ? () => setCommentsVisible(true) : undefined}
              readOnly={!focused || leasedHere}
              orphans={focused ? mdOrphanOps : undefined}
              // A mirror shows the active document, so it renders the active
              // widths; a two-document companion carries its own. Only the
              // focused pane writes them back — see tableWidths.ts.
              tableWidths={focused || isMirror ? tableWidths : doc!.tcols}
              onTableWidths={focused ? onTableWidthsChange : undefined}
              // Relative links resolve against the document this pane is
              // showing, so a note in another folder links to its own
              // neighbours correctly.
              onOpenLink={(href) => void followDocLink(href, paneTab?.path ?? null)}
            />
          )}
          {previewHere && versionPreview && versionStore && (
            <VersionPreview
              store={versionStore}
              docPath={versionPreview.docPath}
              root={versionPreview.root}
              version={versionPreview.version}
              newer={versionPreview.newer}
              onBack={() => setVersionPreview(null)}
              onRestore={(version, text) =>
                void restoreVersion(versionPreview.docPath, versionPreview.root, version, text)
              }
              onOpenFile={(path) => void openTab(path)}
              onError={(message) => pushToast("error", message)}
            />
          )}
          {showHtmlHere && (
            // The sandboxed rendition preview plus its comment layer — see
            // HtmlView. Keyed on the tab so switching documents resets
            // transient comment UI state, while an external regeneration of
            // the SAME rendition just reloads the frame in place. The
            // unfocused pane of a two-document split disables the comment
            // layer; promoting the pane enables it (same-document splits are
            // the active document everywhere, so both panes stay fully live).
            <HtmlView
              key={`${paneTab!.id}`}
              ref={side === "left" ? setLeftHtmlHandle : setRightHtmlHandle}
              htmlContent={paneHtmlContent!}
              threads={focused || !doc ? htmlThreads : doc.threads}
              onThreadsChange={focused || !doc ? onHtmlThreadsChange : noopThreadsChange}
              commentAuthor={deviceName}
              commentsEnabled={focused || !doc}
              // Validated PDF export (a host that omits the prop hides the
              // button). Panes showing the ACTIVE
              // document get it; a two-document split's unfocused pane has
              // its comment layer disabled anyway.
              pdfExportPath={focused || !doc ? activeHtmlPath : undefined}
              controlsSlot={
                effectiveSplit
                  ? side === "left"
                    ? leftToolSlot
                    : rightToolSlot
                  : barToolSlot
              }
              zoom={docZoom}
              onZoomKey={nudgeDocZoom}
              onScrollRatio={side === "left" ? htmlRatioLeft : htmlRatioRight}
              onGesture={
                side === effectiveSplit?.side && !focused
                  ? side === "left"
                    ? promoteLeft
                    : promoteRight
                  : undefined
              }
            />
          )}
          {paneTab && paneMissing && (
            <MissingFileState
              path={paneTab.path}
              onRetry={
                focused || !doc
                  ? () => void loadActiveContent(paneTab)
                  : () => void retryCompanion()
              }
              onCloseTab={() => void closeTab(paneTab.id)}
            />
          )}
          {paneTab && paneUnsupported && !paneMissing && (
            <UnsupportedFileState
              path={paneTab.path}
              onReveal={() => void revealInFinder(paneTab.path)}
              onTrash={() => void deleteEntry(paneTab.path, "file")}
            />
          )}
          {/* Only when NO document is open (the welcome screen). An open note —
              even an empty untitled one — shows the bare editor, like an
              untitled tab in VS Code. */}
          {focused && !activeTab && (
            <ScratchEmptyState
              onNewNote={onNewNote}
              onOpenFile={onPickFile}
              onOpenFolder={onPickFolder}
              onJoinWorkspace={onJoinWorkspace}
            />
          )}
        </div>
      </section>
    );
  };

  // The gear lives in the sidebar's footer whenever the sidebar is showing,
  // so it never sits over the file tree; otherwise it floats bottom-left.
  const settingsMenu = (
    <Settings
      docked={showSidebar}
      theme={theme}
      onTheme={setTheme}
      fullWidth={fullWidth}
      onToggleFullWidth={() => setFullWidth((w) => !w)}
      onNewNote={onNewNote}
      onOpenFile={onPickFile}
      onOpenFolder={onPickFolder}
      onOpenFileNewWindow={ownWindows ? () => void openFileInNewWindow() : undefined}
      onOpenFolderNewWindow={ownWindows ? () => void openFolderInNewWindow() : undefined}
      canCopyWithComments={activeTab != null && !activeNoDoc}
      onCopyWithComments={() => void copyWithComments()}
      update={update}
      onOpenExternal={openExternal}
      onOpenCloud={() => setCloudPanelOpen(true)}
      cloudAttention={cloudNeedsAttention(cloudStatuses)}
      onOpenVersions={versionStore ? () => setVersionsSettingsOpen(true) : undefined}
    />
  );

  // The title row's left end: the traffic lights' clearance and the toggles.
  // Over the sidebar it is that column's top row; with no sidebar showing it
  // rides at the start of the tab bar, so the tabs begin after it and the
  // toggles never move. Its gaps drag the window.
  const titleLead = (
    <div
      className={`title-lead${backend.windows ? " clears-window-buttons" : ""}`}
      onMouseDown={dragWindowFromGap}
    >
      {workspaceRoot && (
        <button
          className="title-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${keys("⌘\\")})`}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarOpen}
        >
          <SidebarIcon />
        </button>
      )}
    </div>
  );

  return (
    <div
      className={`app ${showSidebar ? "with-sidebar" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {showSidebar && titleLead}
      {zoomDiagramSvg && (
        <MermaidModal svg={zoomDiagramSvg} onClose={() => setZoomDiagramSvg(null)} />
      )}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        dirty={dirty}
        onSwitch={(id) => void switchTab(id)}
        onClose={(id) => void closeTab(id)}
        onNewNote={onNewNote}
        onReorder={reorderTabs}
        onDragOut={handleTabDragOut}
        onDragOutEnd={handleTabDragEnd}
        onDragOutCancel={handleTabDragCancel}
        onHistory={onHistory}
        live={livePaths}
        leading={showSidebar ? undefined : titleLead}
        trailing={
          activeTab && !activeNoDoc ? (
            <>
              {/* Who else is in this note: their faces, from the
                  workspace's presence. */}
              <Facepile
                names={hereNow}
                size={22}
                title={`In this note: ${hereNow.join(", ")}`}
                testid="note-facepile"
              />
              {/* Publishing: a file inside the open workspace only — not an
                  untitled note, not a file from outside. */}
              {activeRel !== null && (cloudForRoot || setup) && (
                <LiveChip
                  cloud={cloudForRoot}
                  absPath={activeTab.path}
                  rel={activeRel}
                  dirty={dirty}
                  onConnect={() => setCloudSetup("connect")}
                  onOpenExternal={openExternal}
                  onOpenPublished={() => setPublishedOpen(true)}
                />
              )}
              {/* Markdown only: an html view docks its own comment-mode
                  toggle (and PDF export) into the slot below instead —
                  comment mode itself lives inside HtmlView. */}
              {docView === "md" && commentCount > 0 && (
                <CommentsToggle
                  count={commentCount}
                  visible={commentsVisible}
                  onToggle={() => setCommentsVisible((v) => !v)}
                />
              )}
              {/* The unsplit html view's controls dock here; split mode moves
                  them into each pane's header, like the MD/HTML switcher. */}
              {!effectiveSplit && <div className="html-tool-slot" ref={setBarToolSlot} />}
              {/* Split mode moves the MD/HTML switcher into each pane's
                  header; the bar keeps the split-wide controls. */}
              {!effectiveSplit && (
                <ViewToggle
                  view={docView}
                  hasMd={!activeIsHtmlDoc}
                  hasHtml={hasHtml}
                  onSelect={(v) => void selectDocView(v)}
                />
              )}
              {effectiveSplit && (
                <SyncScrollToggle
                  on={syncScroll}
                  onToggle={() => setSyncScroll((v) => !v)}
                />
              )}
              <SplitToggle
                active={effectiveSplit != null}
                disabled={!effectiveSplit && !canSplit}
                onToggle={() => void toggleSplit()}
              />
            </>
          ) : null
        }
      />
      {showSidebar && workspaceRoot && sidebarMode === "search" && (
        <WorkspaceSearch
          root={workspaceRoot}
          query={wsQuery}
          onQueryChange={setWsQuery}
          caseSensitive={wsCase}
          onToggleCase={() => setWsCase((v) => !v)}
          onOpenResult={(p, q) => void openResult(p, q)}
          onBackToFiles={() => setSidebarMode("files")}
          focusToken={wsFocusToken}
        />
      )}
      {showSidebar && workspaceRoot && sidebarMode === "deleted" && versionStore && (
        <RecentlyDeleted
          store={versionStore}
          // The workspace's own, or one section's: each folder with a
          // history has its own list.
          root={deletedFor ?? workspaceRoot}
          files={deletedFor ? sectionDeleted : deletedFiles}
          onBackToFiles={() => {
            setSidebarMode("files");
            setDeletedFor(null);
          }}
          onOpen={(file) => previewDeleted(file, deletedFor ?? workspaceRoot)}
          onRestored={(path) => {
            setTreeRefreshToken((t) => t + 1);
            pushToast("done", `${basename(path)} is back.`, {
              label: "Open",
              run: () => void openTab(path),
            });
          }}
          onError={(message) => pushToast("error", message)}
        />
      )}
      {showSidebar && workspaceRoot && sidebarMode === "files" && (
        <Sidebar
          root={workspaceRoot}
          cloud={cloudForRoot}
          currentPath={activeFilePath}
          selection={sidebarSelection}
          reveal={revealRequest}
          clipboard={fileClipboard}
          refreshToken={treeRefreshToken}
          onSelect={selectSidebarEntries}
          onOpenFile={(p) => void openTab(p)}
          onOpenFolder={onPickFolder}
          onOpenFilePicker={onPickFile}
          onRevealInFinder={backend.localFiles ? revealInFinder : undefined}
          onDelete={(entries) => void deleteEntries(entries)}
          onMovePath={movePath}
          onCopyEntries={(entries, cut) => void copyEntries(entries, cut)}
          onPasteEntries={(dir) => void pasteEntries(dir)}
          onSwitchToSearch={() => {
            setSidebarMode("search");
            setWsFocusToken((t) => t + 1);
          }}
          onDragFileToEditor={handleTreeDragToEditor}
          onDropFileToEditor={handleTreeDropToEditor}
          onDragFileCancel={handleTreeDragCancel}
          onResizeWidth={resizeSidebar}
          onOpenCloud={() => setCloudPanelOpen(true)}
          onOpenPeople={access && cloudForRoot ? () => setAccessTab("people") : undefined}
          onOpenDevices={access && mayOn(cloudForRoot, "devices.own") ? () => setAccessTab("devices") : undefined}
          onOpenAgents={access && mayOn(cloudForRoot, "agents.own") ? () => setAccessTab("agents") : undefined}
          onNewRestricted={
            restricted && cloudForRoot
              ? (from) => setRestrictedSource(from ? { kind: "folder", path: from } : { kind: "new" })
              : undefined
          }
          onManageAccess={restricted ? (space) => setAccessSpaceId(space.id) : undefined}
          onShareWith={restricted ? (path) => setRestrictedSource({ kind: "note", path }) : undefined}
          onConfirmMove={confirmMove}
          workspaces={myWorkspaces}
          onOpenWorkspace={(root) => void openWorkspace(root)}
          onJoinWorkspace={onJoinWorkspace}
          onPublishFolder={cloudForRoot ? (dir) => setPublishFolder(dir) : undefined}
          onStopPublishing={cloudForRoot ? stopPublishing : undefined}
          onCopyLink={(url) => void navigator.clipboard.writeText(url).catch(() => {})}
          onCopyPageLink={cloudForRoot ? (path) => void copyPageLink(path) : undefined}
          onHistory={onHistory}
          onWorkspaceHistory={versionStore ? (dir) => setHistoryRoot(dir ?? workspaceRoot) : undefined}
          deletedCount={deletedFiles.length}
          onRecentlyDeleted={
            versionStore
              ? (dir) => {
                  setDeletedFor(dir ?? null);
                  setSidebarMode("deleted");
                }
              : undefined
          }
        />
      )}
      {historyRoot && workspaceRoot && versionStore && (
        <WorkspaceHistory
          store={versionStore}
          root={historyRoot}
          onClose={() => setHistoryRoot(null)}
          onRestored={(report, paths) => snapshotRestored(historyRoot, report, paths)}
          onError={(message) => pushToast("error", message)}
        />
      )}
      {accessTab && cloudForRoot && access && (
        <PeopleDialog
          access={access}
          cloud={cloudForRoot}
          tab={accessTab}
          onTab={setAccessTab}
          onClose={() => setAccessTab(null)}
        />
      )}
      {restrictedSource && cloudForRoot && restricted && (
        <RestrictedFolder
          access={restricted.access}
          cloud={cloudForRoot}
          source={restrictedSource}
          onSubmit={(name, members) => makeRestricted(restrictedSource, name, members)}
          onClose={() => setRestrictedSource(null)}
        />
      )}
      {accessSpace && cloudForRoot && restricted && (
        <SpaceAccess
          access={restricted.access}
          spaces={restricted.spaces}
          cloud={cloudForRoot}
          space={accessSpace}
          onLeaving={(space) => givenUpRef.current.add(`${cloudForRoot.root}/${space.path}`)}
          onClose={() => setAccessSpaceId(null)}
        />
      )}
      {question && (
        <QuestionPrompt
          question={question}
          onAnswer={(yes) => {
            question.answer(yes);
            setQuestion(null);
          }}
        />
      )}
      {versionsSettingsOpen && versionStore && (
        <VersionsSettings
          store={versionStore}
          root={workspaceRoot}
          statuses={versionStatuses}
          cloud={cloudForRoot}
          onClose={() => setVersionsSettingsOpen(false)}
        />
      )}
      {savePrompt && (
        <SaveAsPrompt
          dirLabel={
            workspaceRoot && savePrompt.dir.startsWith(workspaceRoot)
              ? `${basename(workspaceRoot)}${savePrompt.dir.slice(workspaceRoot.length)}`
              : savePrompt.dir
          }
          suggested={savePrompt.suggested}
          onCommit={commitSavePrompt}
          onBrowse={(name) => void browseSavePrompt(name)}
          onCancel={() => settleSavePrompt(false)}
        />
      )}
      {unsavedPrompt && <UnsavedPrompt title={unsavedPrompt.title} onAnswer={answerUnsaved} />}
      <main
        className="editor-area"
        ref={editorAreaRef}
        onMouseLeave={hoverNone}
      >
        {renderPane("left")}
        {effectiveSplit && (
          <div
            className="split-divider"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onPointerDown={onDividerPointerDown}
          />
        )}
        {renderPane("right")}
        {historyFor && versionStore && (
          // A right rail beside the document, never over it.
          <HistoryRail
            store={versionStore}
            docPath={historyFor}
            selected={versionPreview?.version.ts ?? null}
            onSelect={previewVersion}
            onClose={closeHistory}
            reloadToken={historyToken}
            onError={(message) => pushToast("error", message)}
          />
        )}
        {tabDrop && (
          <div className="split-drop-overlay" aria-hidden>
            <div
              className={`split-drop-half is-left ${
                tabDrop.side === "left" ? "is-active" : ""
              }`}
            />
            <div
              className={`split-drop-half is-right ${
                tabDrop.side === "right" ? "is-active" : ""
              }`}
            />
          </div>
        )}
      </main>
      {cloudPanelOpen && (cloudForRoot || setup) && (
        <CloudPanel
          root={workspaceRoot}
          cloud={cloudForRoot}
          pendingDeletePaths={
            pendingDeletes && pendingDeletes.root === workspaceRoot ? pendingDeletes.paths : []
          }
          pendingAdds={pendingAdds && pendingAdds.root === workspaceRoot ? pendingAdds : null}
          onClose={() => setCloudPanelOpen(false)}
          onConnect={() => {
            setCloudPanelOpen(false);
            setCloudSetup("connect");
          }}
          onRecover={() => {
            setCloudPanelOpen(false);
            setCloudSetup("recover");
          }}
          onRedeem={() => {
            setCloudPanelOpen(false);
            setCloudSetup("redeem");
          }}
          onAddDevice={
            access
              ? () => {
                  setCloudPanelOpen(false);
                  setAccessTab("devices");
                }
              : undefined
          }
          onUpdateWorker={
            domain
              ? () => {
                  setCloudPanelOpen(false);
                  setWorkerUpdateOpen(true);
                }
              : undefined
          }
          onWorkspaceHistory={
            versionStore
              ? () => {
                  setCloudPanelOpen(false);
                  setHistoryRoot(workspaceRoot);
                }
              : undefined
          }
          onOpenVersions={
            versionStore
              ? () => {
                  setCloudPanelOpen(false);
                  setVersionsSettingsOpen(true);
                }
              : undefined
          }
          onOpenPublished={() => {
            setCloudPanelOpen(false);
            setPublishedOpen(true);
          }}
          onOpenExternal={openExternal}
        />
      )}
      {publishFolder && cloudForRoot && (
        <PublishFolder
          cloud={cloudForRoot}
          dir={publishFolder}
          onClose={() => setPublishFolder(null)}
          onOpenExternal={openExternal}
        />
      )}
      {publishedOpen && cloudForRoot && (
        <PublishedPages
          cloud={cloudForRoot}
          onClose={() => setPublishedOpen(false)}
          onOpenExternal={openExternal}
          onOpenFile={(p) => {
            setPublishedOpen(false);
            void openTab(p);
          }}
          onEditFolder={(dir) => {
            setPublishedOpen(false);
            setPublishFolder(dir);
          }}
        />
      )}
      {cloudSetup && setup && sync && (
        <CloudSetup
          setup={setup}
          sync={sync}
          mode={cloudSetup}
          root={workspaceRoot}
          onClose={() => setCloudSetup(null)}
          onConnected={(root, how) => {
            setCloudSetup(null);
            if (how === "join") void openWorkspace(root);
          }}
          onOpen={(root) => {
            setCloudSetup(null);
            void openWorkspace(root);
          }}
        />
      )}
      {workerUpdateOpen && cloudForRoot && domain && (
        <WorkerUpdate
          domain={domain}
          cloud={cloudForRoot}
          onClose={() => setWorkerUpdateOpen(false)}
          onOpenExternal={openExternal}
        />
      )}
      {removedNotice && (
        <div className="modal-overlay">
          <div
            className="modal cloud-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Access removed"
            data-testid="access-removed"
          >
            <div className="modal-header">
              <div className="modal-title">You no longer have access to {removedNotice.name}</div>
            </div>
            <div className="cloud-body">
              <p className="cloud-hint">
                An owner removed this Mac from {removedNotice.name} ({removedNotice.domain}).{" "}
                {removedNotice.deleted
                  ? "Its copy has been deleted from this Mac: the folder, and the history Doklin kept for it."
                  : `It no longer syncs, but Doklin could not delete its folder — ${removedNotice.root}.`}{" "}
                Nothing was deleted in the cloud. To come back, ask an owner for a new invite.
              </p>
              <div className="modal-buttons">
                <button
                  className="modal-btn is-primary"
                  data-testid="access-removed-ok"
                  onClick={() => setRemovedNotice(null)}
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {showSidebar ? (
        // The sidebar's footer bar: settings, the folder's deleted
        // files — a count that is here only when there is something in it,
        // which toggles the column between
        // the tree and the list — and, for a connected workspace, its sync
        // in words.
        <div className="side-footer">
          {settingsMenu}
          {showSidebar && workspaceRoot && deletedFiles.length > 0 && (
            <button
              className="side-footer-btn"
              data-testid="recently-deleted-button"
              aria-pressed={sidebarMode === "deleted"}
              aria-label={`Recently deleted (${deletedFiles.length})`}
              title="Recently deleted — files this folder's history still holds"
              onClick={() => {
                setDeletedFor(null);
                setSidebarMode((m) => (m === "deleted" && !deletedFor ? "files" : "deleted"));
              }}
            >
              <TrashIcon />
              <span className="side-footer-count">{deletedFiles.length}</span>
            </button>
          )}
          {showSidebar && cloudForRoot && (
            <SyncStatus cloud={cloudForRoot} onOpen={() => setCloudPanelOpen(true)} />
          )}
        </div>
      ) : (
        settingsMenu
      )}
    </div>
  );
}

/* ---------- Subviews ---------- */

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

// The MD/HTML segmented toggle (right end of the tab bar, and each pane
// header in split mode). Both sides always render so the control reads the
// same for every document; a side whose version doesn't exist on disk is
// disabled. The optional hints re-title a disabled side when it's PINNED by
// a same-document split rather than missing.
function ViewToggle({
  view,
  hasMd,
  hasHtml,
  onSelect,
  mdHint,
  htmlHint,
}: {
  view: DocView;
  hasMd: boolean;
  hasHtml: boolean;
  onSelect: (v: DocView) => void;
  mdHint?: string;
  htmlHint?: string;
}) {
  return (
    <div className="view-toggle" role="tablist" aria-label="Document view">
      <button
        role="tab"
        aria-selected={view === "md"}
        className={`view-toggle-seg ${view === "md" ? "is-active" : ""}`}
        disabled={!hasMd}
        title={hasMd ? "Markdown" : mdHint ?? "No markdown version"}
        onClick={() => onSelect("md")}
      >
        MD
      </button>
      <button
        role="tab"
        aria-selected={view === "html"}
        className={`view-toggle-seg ${view === "html" ? "is-active" : ""}`}
        disabled={!hasHtml}
        title={hasHtml ? "HTML" : htmlHint ?? "No HTML version"}
        onClick={() => onSelect("html")}
      >
        HTML
      </button>
    </div>
  );
}

// Slim header atop each pane in split mode: the document name, its MD/HTML
// switcher, and a close-pane ✕. The focused pane is tinted — that's where
// typing and find act.
function PaneHeader({
  title,
  focused,
  missing,
  view,
  hasMd,
  hasHtml,
  mdHint,
  htmlHint,
  toolSlotRef,
  onSelectView,
  onClose,
}: {
  title: string;
  focused: boolean;
  missing: boolean;
  view: DocView;
  hasMd: boolean;
  hasHtml: boolean;
  mdHint?: string;
  htmlHint?: string;
  toolSlotRef?: (el: HTMLDivElement | null) => void;
  onSelectView: (v: DocView) => void;
  onClose: () => void;
}) {
  return (
    <div className={`pane-header ${focused ? "is-focused" : ""}`}>
      <span className={`pane-header-title ${missing ? "is-missing" : ""}`} title={title}>
        {title}
      </span>
      {/* An html pane's own controls land here (empty otherwise). */}
      <div className="html-tool-slot" ref={toolSlotRef} />
      <ViewToggle
        view={view}
        hasMd={hasMd}
        hasHtml={hasHtml}
        onSelect={onSelectView}
        mdHint={mdHint}
        htmlHint={htmlHint}
      />
      <button
        className="pane-header-close"
        aria-label="Close pane"
        title="Close pane"
        onClick={onClose}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// Tab-bar button that opens/closes the split view: the active document
// opens in a second pane (each pane then picks its own MD/HTML view from
// its header) — VS Code's split-editor semantics.
function SplitToggle({
  active,
  disabled,
  onToggle,
}: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`split-toggle ${active ? "is-active" : ""}`}
      aria-pressed={active}
      disabled={disabled}
      title={`${active ? "Close split" : "Split editor right"} (${keys("⌘⇧\\")})`}
      onClick={onToggle}
    >
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
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    </button>
  );
}

// Split-mode chain toggle: scroll both panes together (proportionally), or
// let each pane scroll on its own (the pane under the pointer).
function SyncScrollToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      className={`sync-scroll-toggle ${on ? "is-on" : ""}`}
      aria-pressed={on}
      title={on ? "Sync scroll: on — panes scroll together" : "Sync scroll: off — panes scroll independently"}
      onClick={onToggle}
    >
      {on ? (
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
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      ) : (
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
          <path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          <line x1="8" y1="2" x2="8" y2="5" />
          <line x1="2" y1="8" x2="5" y2="8" />
          <line x1="16" y1="19" x2="16" y2="22" />
          <line x1="19" y1="16" x2="22" y2="16" />
        </svg>
      )}
    </button>
  );
}

// Tab-bar control that shows the open document's comment count and toggles
// the whole comment layer (rail, highlights, gutter) on and off. Only
// rendered when the document actually has comments.
function CommentsToggle({
  count,
  visible,
  onToggle,
}: {
  count: number;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`comments-toggle ${visible ? "" : "is-off"}`}
      aria-pressed={visible}
      title={visible ? "Hide comments" : `Show comments (${count})`}
      onClick={onToggle}
    >
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
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      <span className="comments-toggle-count">{count}</span>
    </button>
  );
}

// The in-app Save As prompt (vscode.dev-style quick input), shown instead of
// the native save panel when a workspace fixes the destination folder. Enter
// saves, Esc (or clicking away) cancels; "Choose location…" falls back to the
// native dialog for saving outside the workspace. `.md` is appended
// automatically unless the typed name already has a markdown extension.
function SaveAsPrompt({
  dirLabel,
  suggested,
  onCommit,
  onBrowse,
  onCancel,
}: {
  dirLabel: string;
  suggested: string;
  onCommit: (name: string) => Promise<string | null>;
  onBrowse: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(suggested);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards double-submit while an async commit is in flight.
  const busyRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select(); // pre-filled name: typing replaces it wholesale
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(onCancel, panelRef);

  const submit = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const err = await onCommit(value);
    busyRef.current = false;
    if (err) {
      setError(err);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="saveas-backdrop">
      <div ref={panelRef} className="saveas-panel" role="dialog" aria-label="Save note">
        <div className="saveas-head">
          <div className="saveas-title">
            Save to <span className="saveas-dir">{dirLabel}</span>
          </div>
          <button className="saveas-close" onClick={onCancel} aria-label="Cancel" title="Cancel">
            <CloseIcon />
          </button>
        </div>
        <div className="saveas-inputwrap">
          <input
            ref={inputRef}
            className="saveas-input"
            type="text"
            value={value}
            autoFocus
            spellCheck={false}
            aria-label="File name"
            aria-invalid={error != null}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
              // App-level shortcuts stay out of the prompt; Esc goes on to
              // close it.
              if (e.key !== "Escape") e.stopPropagation();
            }}
          />
          {!MD_EXT_RE.test(value) && <span className="saveas-ext">.md</span>}
        </div>
        {error && (
          <div className="saveas-error" role="alert">
            {error}
          </div>
        )}
        <div className="saveas-footer">
          <span className="saveas-hint">↩ Save &nbsp;·&nbsp; esc Cancel</span>
          <button className="saveas-browse" onClick={() => onBrowse(value)}>
            Choose location…
          </button>
        </div>
      </div>
    </div>
  );
}

// A yes-or-no before something that changes who can open a document. Enter
// is yes — the user just asked for the move — and Esc or a press outside
// leaves everything as it is. While it is up it owns the keyboard, like the
// save question below.
function QuestionPrompt({ question, onAnswer }: { question: Question; onAnswer: (yes: boolean) => void }) {
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    yesRef.current?.focus();
  }, []);

  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(() => onAnswer(false), cardRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onAnswer]);

  return (
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal unsaved-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="question-prompt-title"
        aria-describedby="question-prompt-body"
        data-testid="question-prompt"
      >
        <div className="unsaved-prompt-title" id="question-prompt-title">
          {question.title}
        </div>
        <div className="unsaved-prompt-body" id="question-prompt-body">
          {question.body}
        </div>
        <div className="modal-buttons unsaved-prompt-buttons">
          <span className="unsaved-prompt-gap" />
          <button className="modal-btn" data-testid="question-no" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button ref={yesRef} className="modal-btn is-primary" data-testid="question-yes" onClick={() => onAnswer(true)}>
            {question.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// The question an untitled note raises before its tab closes. The note
// exists nowhere else, so closing is the end of it unless it is saved first.
// Enter saves — the answer that can't lose anything — Esc keeps the note
// open, and ⌘D is Don't Save, as on a macOS save sheet. While it is up it
// owns the keyboard: no app shortcut reaches the note behind it.
function UnsavedPrompt({
  title,
  onAnswer,
}: {
  title: string;
  onAnswer: (choice: UnsavedChoice) => void;
}) {
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  // Esc and a press outside are Cancel: the note stays open, nothing lost.
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(() => onAnswer("cancel"), cardRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onAnswer("discard");
      } else if (e.metaKey || e.ctrlKey) {
        e.preventDefault(); // ⌘W, ⌘S, ⌘N…: nothing while the question is open
      }
    };
    // Capture phase, on the window: ahead of the app's own key handler and
    // of the editor's.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onAnswer]);

  return (
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal unsaved-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-prompt-title"
        aria-describedby="unsaved-prompt-body"
      >
        <div className="unsaved-prompt-title" id="unsaved-prompt-title">
          Save “{title}” before closing?
        </div>
        <div className="unsaved-prompt-body" id="unsaved-prompt-body">
          This note hasn’t been saved to a file. If you don’t save it, it’s gone once the tab
          closes.
        </div>
        <div className="modal-buttons unsaved-prompt-buttons">
          <button className="modal-btn is-danger-outline" onClick={() => onAnswer("discard")}>
            Don’t Save
          </button>
          <span className="unsaved-prompt-gap" />
          <button className="modal-btn" onClick={() => onAnswer("cancel")}>
            Cancel
          </button>
          <button ref={saveRef} className="modal-btn is-primary" onClick={() => onAnswer("save")}>
            Save…
          </button>
        </div>
      </div>
    </div>
  );
}

// Shown in place of the editor when the active tab's file can't be read.
// Deliberately read-only: typing here could recreate the file at a path that
// may be a momentarily-unmounted drive. Re-activating the tab retries the read.
function MissingFileState({
  path,
  onRetry,
  onCloseTab,
}: {
  path: string;
  onRetry: () => void;
  onCloseTab: () => void;
}) {
  return (
    <div className="missing-file">
      <div className="missing-file-card">
        <div className="missing-file-title">File not found</div>
        <div className="missing-file-path">{path}</div>
        <div className="missing-file-hint">
          It may have been moved, renamed, or be on a disk that isn't mounted.
          Switching back to this tab checks again.
        </div>
        <div className="missing-file-actions">
          <button className="missing-file-btn" onClick={onRetry}>
            Try again
          </button>
          <button className="missing-file-btn" onClick={onCloseTab}>
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}

// Shown in place of the editor when the active tab's file is not a document
// (a click on a greyed row in the tree opens one). Nothing reads it; it can
// still be found in Finder, or trashed here or with ⌘⌫ like any file.
function UnsupportedFileState({
  path,
  onReveal,
  onTrash,
}: {
  path: string;
  onReveal: () => void;
  onTrash: () => void;
}) {
  return (
    <div className="missing-file" data-testid="unsupported-file">
      <div className="missing-file-card">
        <div className="missing-file-title">Unsupported file format</div>
        <div className="missing-file-path">{path}</div>
        <div className="missing-file-hint">
          Doklin opens markdown and HTML files. You can still rename, move or delete this one.
        </div>
        <div className="missing-file-actions">
          <button className="missing-file-btn" onClick={onReveal}>
            Reveal in Finder
          </button>
          <button className="missing-file-btn" onClick={onTrash} data-testid="unsupported-trash">
            Move to Trash
          </button>
        </div>
      </div>
    </div>
  );
}

function ConflictBanner({
  onReload,
  onKeep,
}: {
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="conflict-banner" role="alert">
      {/* Where documents are files on this computer the other version is
          the one on disk; anywhere else it is whatever the workspace now has. */}
      <span className="conflict-banner-text">
        {backend.localFiles ? "This file has changed on disk." : "This document was changed somewhere else."}
      </span>
      <div className="conflict-banner-actions">
        <button className="conflict-banner-btn" onClick={onReload}>
          {backend.localFiles ? "Reload from disk" : "Show that version"}
        </button>
        <button
          className="conflict-banner-btn is-primary"
          onClick={onKeep}
        >
          Keep my version
        </button>
      </div>
    </div>
  );
}

/** A theme in miniature: its canvas, its sheet with two lines of text, and
 *  the accent — painted from that theme's own tokens. */
function ThemeSwatch({ theme }: { theme: ResolvedTheme }) {
  return (
    <span className="settings-swatch-face" data-theme={theme}>
      <span className="settings-swatch-sheet">
        <span className="settings-swatch-line" />
        <span className="settings-swatch-line is-short" />
        <span className="settings-swatch-accent" />
      </span>
    </span>
  );
}

function Settings({
  docked,
  theme,
  onTheme,
  fullWidth,
  onToggleFullWidth,
  onNewNote,
  onOpenFile,
  onOpenFolder,
  onOpenFileNewWindow,
  onOpenFolderNewWindow,
  canCopyWithComments,
  onCopyWithComments,
  update,
  onOpenExternal,
  onOpenCloud,
  cloudAttention,
  onOpenVersions,
}: {
  /** In the left column's footer (true) or floating bottom-left. */
  docked: boolean;
  theme: Theme;
  onTheme: (t: Theme) => void;
  fullWidth: boolean;
  onToggleFullWidth: () => void;
  // The File rows: each is shown only where the platform has what it opens
  // (a handler that is not passed is a row that is not there).
  onNewNote?: () => void;
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  onOpenFileNewWindow?: () => void;
  onOpenFolderNewWindow?: () => void;
  canCopyWithComments: boolean;
  onCopyWithComments: () => void;
  /** Null where the app does not update itself. */
  update: UpdateController | null;
  onOpenExternal: (url: string) => void;
  // Open the Cloud panel; `cloudAttention` lights the item (and the gear)
  // when a connected domain's worker is behind this app.
  onOpenCloud: () => void;
  cloudAttention: boolean;
  /** Open the Versions settings: the two horizons, the space each store
   *  uses, the export, and the folders whose history outlived them. */
  onOpenVersions?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(() => setOpen(false), wrapRef, open);

  const updateAvailable = update?.phase === "available";
  const hasFileRows =
    onNewNote != null ||
    onOpenFile != null ||
    onOpenFolder != null ||
    onOpenFileNewWindow != null ||
    onOpenFolderNewWindow != null;

  // One badge, two reasons: an app update, or a cloud worker behind it.
  const fabLabel = updateAvailable
    ? "Settings — update available"
    : cloudAttention
      ? "Settings — the cloud worker needs an update"
      : "Settings";

  return (
    <div ref={wrapRef} className={`settings-wrap${docked ? " is-docked" : ""}`}>
      {open && (
        <div className="settings-popover" role="menu" aria-label="Settings">
          {hasFileRows && <div className="settings-section-label">File</div>}
          {onNewNote && (
            <button
              role="menuitem"
              className="settings-option"
              onClick={() => {
                setOpen(false);
                onNewNote();
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">New note</span>
              <span className="settings-option-kbd">{keys("⌘N")}</span>
            </button>
          )}
          {onOpenFile && (
            <button
              role="menuitem"
              className="settings-option"
              onClick={() => {
                setOpen(false);
                onOpenFile();
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">Open file…</span>
              <span className="settings-option-kbd">{keys("⌘O")}</span>
            </button>
          )}
          {onOpenFolder && (
            <button
              role="menuitem"
              className="settings-option"
              onClick={() => {
                setOpen(false);
                onOpenFolder();
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">Open folder…</span>
              <span className="settings-option-kbd">{keys("⌘⇧O")}</span>
            </button>
          )}
          {onOpenFileNewWindow && (
            <button
              role="menuitem"
              className="settings-option"
              onClick={() => {
                setOpen(false);
                onOpenFileNewWindow();
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">Open file in new window…</span>
              <span className="settings-option-kbd">{keys("⌘⌥O")}</span>
            </button>
          )}
          {onOpenFolderNewWindow && (
            <button
              role="menuitem"
              className="settings-option"
              onClick={() => {
                setOpen(false);
                onOpenFolderNewWindow();
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">Open folder in new window…</span>
              <span className="settings-option-kbd">{keys("⌘⌥⇧O")}</span>
            </button>
          )}
          {canCopyWithComments && (
            <>
              {hasFileRows && <div className="settings-divider" />}
              <div className="settings-section-label">Document</div>
              <button
                role="menuitem"
                className="settings-option"
                onClick={() => {
                  setOpen(false);
                  onCopyWithComments();
                }}
                title="Copy the whole document with CriticMarkup comments intact"
              >
                <span className="settings-option-check" />
                <span className="settings-option-label">Copy with comments</span>
              </button>
            </>
          )}
          {(hasFileRows || canCopyWithComments) && <div className="settings-divider" />}
          <div className="settings-section-label">Cloud</div>
          <button
            role="menuitem"
            className="settings-option"
            data-testid="settings-cloud"
            onClick={() => {
              setOpen(false);
              onOpenCloud();
            }}
          >
            <span className="settings-option-check">
              {cloudAttention ? <span className="settings-option-dot" aria-hidden /> : null}
            </span>
            <span className="settings-option-label">Cloud…</span>
          </button>
          {onOpenVersions && (
            <>
              <div className="settings-divider" />
              <div className="settings-section-label">Versions</div>
              <button
                role="menuitem"
                className="settings-option"
                data-testid="settings-versions"
                onClick={() => {
                  setOpen(false);
                  onOpenVersions();
                }}
              >
                <span className="settings-option-check" />
                <span className="settings-option-label">Version history…</span>
              </button>
            </>
          )}
          <div className="settings-divider" />
          <div className="settings-section-label">Appearance</div>
          {/* Live choices: the menu stays open so the note behind it can be
              read in each one. A swatch is drawn from its own theme's
              tokens: data-theme scopes a palette to any element. */}
          <div className="settings-tiles" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t}
                role="menuitemradio"
                aria-checked={theme === t}
                className={`settings-tile ${theme === t ? "is-active" : ""}`}
                data-testid={`settings-theme-${t}`}
                onClick={() => onTheme(t)}
              >
                <span className="settings-tile-face" aria-hidden>
                  {t === "system" ? (
                    <>
                      <ThemeSwatch theme="light" />
                      <ThemeSwatch theme="dark" />
                    </>
                  ) : (
                    <ThemeSwatch theme={t} />
                  )}
                </span>
                <span className="settings-tile-name">{THEME_LABEL[t]}</span>
              </button>
            ))}
          </div>
          <button
            role="menuitemcheckbox"
            aria-checked={fullWidth}
            className="settings-option"
            data-testid="settings-full-width"
            title="Let the note fill the window instead of a reading column"
            onClick={onToggleFullWidth}
          >
            <span className="settings-option-check">{fullWidth ? <CheckIcon /> : null}</span>
            <span className="settings-option-label">Full width</span>
          </button>
          {update && <UpdateRows update={update} onOpenExternal={onOpenExternal} onDone={() => setOpen(false)} />}
        </div>
      )}
      <button
        className="settings-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label={fabLabel}
        aria-expanded={open}
        title={fabLabel}
      >
        <GearIcon />
        {(updateAvailable || cloudAttention) && (
          <span className="settings-fab-badge" aria-hidden />
        )}
      </button>
    </div>
  );
}

// The Updates rows of the settings menu: what the app is at, and the one
// click that takes it to the next release.
function UpdateRows({
  update,
  onOpenExternal,
  onDone,
}: {
  update: UpdateController;
  onOpenExternal: (url: string) => void;
  /** Close the menu, for a row that leaves it. */
  onDone: () => void;
}) {
  const updateAvailable = update.phase === "available";
  const updateBusy =
    update.phase === "downloading" || update.phase === "installing";
  const ver = update.current ? `v${update.current}` : "";
  let updateStatusText: string;
  switch (update.phase) {
    case "checking":
      updateStatusText = ver || "Checking for updates…";
      break;
    case "available":
      updateStatusText = `Current: ${ver}`;
      break;
    case "installing":
      updateStatusText = "Restarting…";
      break;
    case "error":
      updateStatusText = ver ? `${ver} · Couldn't check` : "Couldn't check";
      break;
    case "downloading":
      updateStatusText = "";
      break;
    default:
      updateStatusText = ver ? `${ver} · Up to date` : "";
  }

  return (
    <>
      <div className="settings-divider" />
      <div className="settings-section-label">Updates</div>
      {updateAvailable ? (
        <button
          role="menuitem"
          className="settings-option settings-option--update"
          title={
            update.notes || `Install Doklin v${update.latest} and restart`
          }
          onClick={() => void update.install()}
        >
          <span className="settings-option-check">
            <DownloadIcon />
          </span>
          <span className="settings-option-label">
            Update to v{update.latest} &amp; Restart
          </span>
        </button>
      ) : updateBusy ? (
        <div className="settings-option is-progress" aria-live="polite">
          <span className="settings-option-check">
            <DownloadIcon />
          </span>
          <span className="settings-option-label">
            {update.phase === "downloading"
              ? `Downloading… ${Math.round(update.progress * 100)}%`
              : "Installing…"}
          </span>
        </div>
      ) : (
        <button
          role="menuitem"
          className="settings-option"
          disabled={update.phase === "checking"}
          onClick={() => void update.check()}
        >
          <span className="settings-option-check" />
          <span className="settings-option-label">
            {update.phase === "checking" ? "Checking…" : "Check for updates"}
          </span>
        </button>
      )}
      {update.phase === "downloading" && (
        <div className="settings-update-bar" aria-hidden>
          <span style={{ width: `${Math.round(update.progress * 100)}%` }} />
        </div>
      )}
      {updateStatusText && (
        <div
          className="settings-update-status"
          title={update.error ?? undefined}
        >
          {updateStatusText}
        </div>
      )}
      {update.phase === "error" && (
        <button
          role="menuitem"
          className="settings-option"
          onClick={() => {
            onDone();
            onOpenExternal(RELEASES_PAGE);
          }}
        >
          <span className="settings-option-check" />
          <span className="settings-option-label">Download manually…</span>
        </button>
      )}
    </>
  );
}

// The welcome screen shown when no document is open. (An open note, including
// an empty untitled one, shows the bare editor instead — no overlay.)
function ScratchEmptyState({
  onNewNote,
  onOpenFile,
  onOpenFolder,
  onJoinWorkspace,
}: {
  // Each is shown only where the platform has what it opens.
  onNewNote?: () => void;
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  /** Somebody sent an invite: the one door a new install needs. */
  onJoinWorkspace?: () => void;
}) {
  return (
    <div className="scratch-empty" aria-hidden={false}>
      <div className="scratch-empty-card">
        <div className="scratch-empty-hint">No note open</div>
        <div className="scratch-empty-actions">
          {onNewNote && (
            <button className="scratch-empty-button" onClick={onNewNote}>
              <FileIcon />
              <span>New note</span>
              <span className="scratch-empty-kbd">{keys("⌘N")}</span>
            </button>
          )}
          {onOpenFile && (
            <button className="scratch-empty-button" onClick={onOpenFile}>
              <FileIcon />
              <span>Open file</span>
              <span className="scratch-empty-kbd">{keys("⌘O")}</span>
            </button>
          )}
          {onOpenFolder && (
            <button className="scratch-empty-button" onClick={onOpenFolder}>
              <FolderIcon />
              <span>Open folder</span>
              <span className="scratch-empty-kbd">{keys("⌘⇧O")}</span>
            </button>
          )}
          {onJoinWorkspace && (
            <button className="scratch-empty-button" data-testid="join-workspace" onClick={onJoinWorkspace}>
              <FolderIcon />
              <span>Join a workspace</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Icons ---------- */

// The tick on a checked settings row ("Full width").
function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DownloadIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="13"
      height="13"
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

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
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


function SidebarIcon() {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}
