import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  cloudForWorkspace,
  cloudNeedsAttention,
  cloudPublish,
  cloudSetActivity,
  cloudStatus,
  cloudUnpublish,
  onCloudApplied,
  onCloudConflict,
  onCloudPendingDeletes,
  onCloudStatus,
  relPathIn,
  type CloudPendingDeletesEvent,
  type CloudStatus,
  type PublicPage,
} from "./cloud";
import CloudPanel from "./CloudPanel";
import {
  onVersionsApplied,
  versionsRestoreFile,
  type FileVersion,
  type RestoreOutcome,
} from "./versions";
import CloudSetup, { type CloudSetupMode } from "./CloudSetup";
import CloudToasts, { type CloudToast } from "./CloudToasts";
import PublishMenu from "./PublishMenu";
import PublishFolder from "./PublishFolder";
import PublishedPages from "./PublishedPages";
import WorkerUpdate from "./WorkerUpdate";
import HistoryRail from "./HistoryRail";
import VersionPreview, { momentLabel } from "./VersionPreview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import Editor, { type EditorHandle } from "./Editor";
import type { SearchInfo } from "./searchPlugin";
import Sidebar, {
  pruneNestedSelection,
  type SidebarSelection,
  type FileClipboardPayload,
  type TreeNode,
} from "./Sidebar";
import TabBar from "./TabBar";
import DraftsPanel from "./DraftsPanel";
import FindBar from "./FindBar";
import WorkspaceSearch from "./WorkspaceSearch";
import MermaidModal from "./MermaidModal";
import DictationHud from "./DictationHud";
import DictationInspector from "./DictationInspector";
import DictationSetup from "./DictationSetup";
import {
  DictationController,
  getDictationConfig,
  INITIAL_DICTATION_UI,
  type DictationConfig,
  type DictationUiState,
  type InspectorEntry,
} from "./dictation";
import { useUpdateCheck, RELEASES_PAGE, type UpdateController } from "./updater";
import HtmlView, { type HtmlViewHandle } from "./HtmlView";
import { mergeHtmlThreads, type HtmlThread } from "./htmlComments";
import { sanitizeAuthor, sanitizeBody } from "./criticMarkup";
import {
  metaFileOf,
  parseEntityMeta,
  serializeEntityMeta,
  metaIsEmpty,
  emptyMeta,
  expandMarkdown,
  extractMarkdown,
  markerIds,
  migrateEntity,
  type EntityMeta,
  type MdThread,
  type ForeignRecord,
  type TableCols,
} from "./metaFile";
import { tableWidthsKey } from "./tableWidths";
import { linkTargetPath } from "./docLinks";
import StoreView from "./StoreView";
import CardPeek from "./CardPeek";
import type { StoreEmbedHost, StoreChoice } from "./StoreEmbedFrame";
import PropertiesHeader from "./PropertiesHeader";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type Props as CardProps,
  type PropValue,
} from "./store/frontmatter";
import { cardKeyOrder, RANK_KEY, STORE_FILE } from "./store/storeFile";
import { createStoreFile } from "./store/model";
import { useStore } from "./store/useStore";

type FileSnapshot = { mtime_ms: number; size: number };
type ReadFileResult = { contents: string; snapshot: FileSnapshot };
type ExternalChangePayload = { path: string; snapshot: FileSnapshot };
type WriteErrorPayload =
  | { kind: "io"; message: string }
  | { kind: "conflict"; current: FileSnapshot };
type Conflict = { diskSnapshot: FileSnapshot };

const AUTOSAVE_DEBOUNCE_MS = 600;

type WindowInit = {
  isMain: boolean;
  folder: string | null;
  file: string | null;
  files: string[];
  activeFile: string | null;
  restored: boolean;
};

// Whether this window owns the shared tab session (doklin:session). The backend is
// the authority (take_window_init keys off the real window label); we default to
// true and flip it false for spawned windows once init resolves, so a spawned
// window never clobbers the main window's session. Shared prefs (theme, recents,
// drafts) stay shared across all windows.
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
const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
const HTML_EXT_RE = /\.html$/i;

// A document is a markdown file, an html file, or the pair: same stem, side by
// side ("notes.md" + "notes.html" — the html is a generated *rendition* of the
// markdown, not a separate document). The pair opens as ONE tab keyed on the
// markdown path, with an in-editor MD/HTML view toggle.
const isHtmlPath = (p: string) => HTML_EXT_RE.test(p);
const htmlSiblingOf = (mdPath: string) => mdPath.replace(MD_EXT_RE, "") + ".html";
const mdSiblingOf = (htmlPath: string) => htmlPath.replace(HTML_EXT_RE, "") + ".md";

// The companion files the document watcher rides along with a tab: the
// entity meta file (thread bodies for both renditions) and the html
// rendition (when the tab is its markdown side). watch_file skips paths
// that don't exist, so companions are always offered.
const watchExtrasOf = (tabPath: string, htmlPath: string | null): string[] => {
  const extras = [metaFileOf(tabPath)];
  if (htmlPath !== null && htmlPath !== tabPath) extras.push(htmlPath);
  return extras;
};

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
    if (await invoke<boolean>("path_exists", { path: p })) return true;
    if (!isDoc) return false;
    const sibling = HTML_EXT_RE.test(p) ? mdSiblingOf(p) : htmlSiblingOf(p);
    return invoke<boolean>("path_exists", { path: sibling });
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
   document machinery (autosave, watcher, conflicts, comments,
   dictation, find) stays bound to ONE document — the FOCUSED pane's — and
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
  snapshot: FileSnapshot | null;
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
  // other document's properties.
  head: string;
  props: CardProps;
  opaque: string[];
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

// Suggest a filename (no extension) for saving a draft: its first non-empty
// line with markdown syntax and filesystem-hostile characters stripped, falling
// back to the draft's Untitled-N title. Pre-fills the Save As prompt so naming
// a note that already starts with a heading is just ⌘S + Enter.
function suggestDraftFileName(md: string, fallback: string): string {
  const line = md.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const cleaned = line
    .replace(/^[#>\s*+-]+/, "") // heading/quote/list markers
    .replace(/[*_`~[\]]/g, "") // inline emphasis/link syntax
    .replace(/[/\\:]/g, "-")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

type Theme = "system" | "light" | "sepia" | "dark";
const THEMES: Theme[] = ["system", "light", "sepia", "dark"];
const THEME_STORAGE_KEY = "doklin:theme";
const COMMENTS_VISIBLE_STORAGE_KEY = "doklin:comments-visible";
const SIDEBAR_OPEN_STORAGE_KEY = "doklin:sidebar-open";
const RECENTS_STORAGE_KEY = "doklin:recents";
const RECENTS_MAX = 8;
const SESSION_STORAGE_KEY = "doklin:session";
const DRAFT_SEQ_STORAGE_KEY = "doklin:draft-seq";
const DRAFTS_META_STORAGE_KEY = "doklin:drafts-meta";
const DRAFTS_OPEN_STORAGE_KEY = "doklin:drafts-open";
const DOC_ZOOM_STORAGE_KEY = "doklin:doc-zoom";

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

type RecentEntry = { path: string; kind: "file" | "folder" };

// A tab is a lightweight descriptor; the document's content always lives on disk
// (drafts in app_data_dir/drafts/<id>.md, files at their real path) and autosaves
// there, so disk — not memory — is the source of truth across tabs.
// "store" is a DATASTORE folder shown as a kanban board — a tab whose path is
// a directory, not a document. The app's document machinery (autosave,
// watcher, comments, dictation, find) stands down for one, the way it
// does for an html-only document: the board owns its own reads and writes.
type TabKind = "draft" | "file" | "store";
// `missing` marks a file tab whose path failed to read (drive unmounted, file
// moved) — kept visible as a "ghost" tab instead of silently dropped. Every
// activation re-checks the path, so the flag self-heals if the file returns.
type Tab = { id: string; kind: TabKind; path: string; title?: string; missing?: boolean };
type DraftInfo = { id: string; path: string; snapshot: FileSnapshot; preview: string };
type DraftRow = { id: string; path: string; title: string; preview: string };
type DraftsMeta = Record<string, { seq: number }>;

// For a draft the tab id IS the draft file's stem (the uuid), so tab/meta/disk
// all join on the same id. For files the title is derived from the path.
const draftIdFromPath = (p: string) => basename(p).replace(/\.(md|markdown|mdown|mkd)$/i, "");
const uuid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
const tabTitle = (t: Tab) => (t.kind === "draft" ? t.title ?? "Untitled" : basename(t.path));
// A document's display title, for pane headers: the tab title, minus the
// document extension for real files ("notes.md" reads as "notes").
const docDisplayTitle = (t: Tab) =>
  t.kind === "draft"
    ? t.title ?? "Untitled"
    : basename(t.path).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

// One in-app delete, as undo needs to see it — see deletedStackRef.
type DeletedRecord = {
  files: { path: string; trashPath: string }[];
  openPaths: string[];
};
const THEME_LABEL: Record<Theme, string> = {
  system: "System",
  light: "Light",
  sepia: "Sepia",
  dark: "Dark",
};

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && (THEMES as string[]).includes(v)) return v as Theme;
  } catch {
    // localStorage may be unavailable; fall through
  }
  return "system";
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

function isWriteError(e: unknown): e is WriteErrorPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    ((e as { kind: unknown }).kind === "io" ||
      (e as { kind: unknown }).kind === "conflict")
  );
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

function readStoredRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentEntry =>
        r && typeof r.path === "string" && (r.kind === "file" || r.kind === "folder"),
    );
  } catch {
    return [];
  }
}

function writeStoredRecents(entries: RecentEntry[]) {
  try {
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(entries));
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
type SessionEntry = { tabs: Tab[]; activeId: string | null; split?: StoredSplit | null };
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

function sanitizeTabs(raw: unknown): Tab[] {
  return Array.isArray(raw)
    ? raw.filter(
        (t: unknown): t is Tab =>
          !!t &&
          typeof (t as Tab).id === "string" &&
          typeof (t as Tab).path === "string" &&
          ((t as Tab).kind === "draft" ||
            (t as Tab).kind === "file" ||
            (t as Tab).kind === "store"),
      )
    : [];
}

// Read the whole keyed-session map, migrating a legacy v1 blob
// ({ tabs, activeId, workspaceRoot }) into a single keyed entry on the way so an
// existing user's open tabs survive the upgrade under their own workspace.
function readAllSessions(): StoredSessions {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return { lastRoot: null, sessions: {} };
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2 && parsed?.sessions && typeof parsed.sessions === "object") {
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
    }
    // Legacy v1 → keep the single blob under its workspace key.
    const tabs = sanitizeTabs(parsed?.tabs);
    const activeId = typeof parsed?.activeId === "string" ? parsed.activeId : null;
    const workspaceRoot =
      typeof parsed?.workspaceRoot === "string" ? parsed.workspaceRoot : null;
    return {
      lastRoot: workspaceRoot,
      sessions: { [sessionKeyFor(workspaceRoot)]: { tabs, activeId } },
    };
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
    else all.sessions[key] = { tabs, activeId, split: sessionSplit };
    all.lastRoot = sessionWorkspaceRoot;
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ version: 2, lastRoot: all.lastRoot, sessions: all.sessions }),
    );
  } catch {
    // ignore
  }
}

function readDraftSeq(): number {
  try {
    const v = parseInt(localStorage.getItem(DRAFT_SEQ_STORAGE_KEY) || "0", 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeDraftSeq(n: number) {
  try {
    localStorage.setItem(DRAFT_SEQ_STORAGE_KEY, String(n));
  } catch {
    // ignore
  }
}

function readDraftsMeta(): DraftsMeta {
  try {
    const raw = localStorage.getItem(DRAFTS_META_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as DraftsMeta) : {};
  } catch {
    return {};
  }
}

function writeDraftsMeta(m: DraftsMeta) {
  try {
    localStorage.setItem(DRAFTS_META_STORAGE_KEY, JSON.stringify(m));
  } catch {
    // ignore
  }
}

function readDraftsOpen(): boolean {
  try {
    return localStorage.getItem(DRAFTS_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDraftsOpen(open: boolean) {
  try {
    localStorage.setItem(DRAFTS_OPEN_STORAGE_KEY, open ? "1" : "0");
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
  // entry, the row clicked most recently) is the creation context: saving a
  // new draft defaults the save dialog into the selected folder (or next to
  // the selected file), falling back to the workspace root. Mirrored in a ref
  // for async readers.
  const [sidebarSelection, setSidebarSelection] = useState<SidebarSelection[]>([]);
  const sidebarSelectionRef = useRef<SidebarSelection[]>([]);
  // The in-app Save As prompt (shown instead of the native save panel when a
  // workspace decides the destination): the folder is fixed, only the name is
  // asked for. null = closed.
  const [savePrompt, setSavePrompt] = useState<{ dir: string; suggested: string } | null>(null);
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
  const [draftsOpen, setDraftsOpen] = useState<boolean>(() => readDraftsOpen());
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [recents, setRecents] = useState<RecentEntry[]>(() => readStoredRecents());
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  // Bumped after each autosave write of a draft lands on disk, so the drafts
  // panel re-lists (list_drafts reads from disk, so the refresh has to follow
  // the write, not the keystroke). The 600ms autosave debounce is the rate cap.
  const [draftsRefreshToken, setDraftsRefreshToken] = useState(0);
  // Undo stack for trashed entries. `files` is everything one delete moved to
  // the Trash (a markdown file's html rendition rides along); `openPaths` are
  // the file tabs the delete closed (the entry itself for a file, everything
  // under it for a folder) so ⌘Z can reopen them after restoring.
  const deletedStackRef = useRef<DeletedRecord[]>([]);
  const currentMarkdownRef = useRef<string>("");
  const lastSavedRef = useRef<string>("");
  const baselineCapturedRef = useRef<boolean>(false);
  const pathRef = useRef<string | null>(null);
  const snapshotRef = useRef<FileSnapshot | null>(null);
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
  const draftsMetaRef = useRef<DraftsMeta>({});
  const draftSeqRef = useRef<number>(0);
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
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
  // the entity META file (see metaFile.ts; formerly its own sidecar). The ref
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
     Milkdown never sees frontmatter. Like expandMarkdown / extractMarkdown
     for comment bodies, the split happens at the IO boundary: a load parses
     the block off the top and hands the editor the body; a save prepends the
     block back, byte for byte, so an edit to the prose can't rewrite someone
     else's `aliases:` line and a properties-only change from a board (or
     another device) leaves the body untouched.

     `cardHeadRef` is the exact block text as last seen on disk — what the
     next write re-attaches. `cardProps` is its parsed form, for the
     properties header. */
  const cardHeadRef = useRef<string>("");
  const cardPropsRef = useRef<CardProps>({});
  const cardOpaqueRef = useRef<string[]>([]);
  const [cardProps, setCardProps] = useState<CardProps>({});
  const [cardOpaque, setCardOpaque] = useState<string[]>([]);
  // The keys the file itself carries, in file order — what an ordinary note's
  // properties header shows rows for (a card's rows come from its board).
  const [cardOrder, setCardOrder] = useState<string[]>([]);
  // Adopt a document's frontmatter block: the refs the writers read and the
  // state the header renders, in one place so the two can't drift.
  const adoptFrontmatter = useCallback((fullText: string) => {
    const fm = parseFrontmatter(fullText);
    cardHeadRef.current = fullText.slice(0, fullText.length - fm.body.length);
    cardPropsRef.current = fm.props;
    cardOpaqueRef.current = fm.opaque;
    setCardProps(fm.props);
    setCardOpaque(fm.opaque);
    setCardOrder(fm.order);
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

  // The name comments written on this Mac are signed with (device_name in
  // lib.rs: the Mac's own name). Seeded once; the fallback holds until then.
  const [deviceName, setDeviceName] = useState("This Mac");
  useEffect(() => {
    void invoke<string>("device_name")
      .then(setDeviceName)
      .catch(() => {});
  }, []);

  // The cloud: every connected workspace's status, as the engine reports it
  // — one array, replaced whole on every `cloud-status` event (src/cloud.ts).
  // Everything cloud-shaped in the UI derives from this and nothing else.
  const [cloudStatuses, setCloudStatuses] = useState<CloudStatus[]>([]);
  useEffect(() => {
    let live = true;
    void cloudStatus()
      .then((s) => {
        if (live) setCloudStatuses(s);
      })
      .catch(() => {});
    const un = onCloudStatus((s) => {
      if (live) setCloudStatuses(s);
    });
    return () => {
      live = false;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);
  const cloudForRoot = useMemo(
    () => cloudForWorkspace(cloudStatuses, workspaceRoot),
    [cloudStatuses, workspaceRoot],
  );
  // The cloud surfaces (docs/cloud.md §7.2): the panel, the setup
  // wizard (connect this folder, or open a workspace from a domain), the
  // worker update card, and the transient notices. The held mass-deletion's paths ride the event that
  // announced it; the panel lists them.
  const [cloudPanelOpen, setCloudPanelOpen] = useState(false);
  const [cloudSetup, setCloudSetup] = useState<CloudSetupMode | null>(null);
  const [workerUpdateOpen, setWorkerUpdateOpen] = useState(false);
  // Version history (docs/versioning-plan.md §5.4): which document's rail is
  // open, and which of its versions is showing in the document area instead
  // of the live editor. `historyToken` re-reads the rail after a restore
  // adds rows to it.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versionPreview, setVersionPreview] = useState<
    { version: FileVersion; newer: FileVersion | null; root: string } | null
  >(null);
  const [historyToken, setHistoryToken] = useState(0);
  const historyForRef = useRef<string | null>(null);
  // What ⌘⌥H opens history for: the active tab, unless it is a board.
  const historyTargetRef = useRef<{ path: string; kind: "file" | "draft" } | null>(null);
  const [cloudToasts, setCloudToasts] = useState<CloudToast[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<CloudPendingDeletesEvent | null>(null);
  const toastSeq = useRef(0);
  const pushToast = useCallback((text: string, action?: CloudToast["action"]) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setCloudToasts((ts) => [...ts.slice(-3), { id, text, action }]);
  }, []);
  const dismissToast = useCallback(
    (id: number) => setCloudToasts((ts) => ts.filter((t) => t.id !== id)),
    [],
  );  // Publishing (docs/cloud.md §7.2): the folder dialog (a folder,
  // or the root for the whole workspace) and the list of every published
  // page. The pill lives in the tab bar (PublishMenu).
  const [publishFolder, setPublishFolder] = useState<string | null>(null);
  const [publishedOpen, setPublishedOpen] = useState(false);
  // Stopping from the sidebar is immediate and undoable: the toast's Undo
  // publishes the same path again under the same slug.
  const stopPublishing = useCallback(
    (page: PublicPage) => {
      const root = workspaceRoot;
      if (!root) return;
      const abs = page.path ? `${root}/${page.path}` : root;
      void cloudUnpublish(root, page.slug)
        .then(() =>
          pushToast(`Stopped publishing ${page.path ? basename(page.path) : "the workspace"}.`, {
            label: "Undo",
            run: () =>
              void cloudPublish(abs, {
                slug: page.slug,
                title: page.title ?? undefined,
                desc: page.desc ?? undefined,
              }).catch((e) => pushToast(`Couldn't publish again: ${String(e)}`)),
          }),
        )
        .catch((e) => pushToast(`Couldn't stop publishing: ${String(e)}`));
    },
    [workspaceRoot, pushToast],
  );


  // The SVG of a rendered mermaid diagram opened in the zoom/pan canvas; null
  // when closed. Set by the `dk-mermaid-expand` event a diagram's expand chip
  // fires (src/mermaid.ts).
  const [zoomDiagramSvg, setZoomDiagramSvg] = useState<string | null>(null);

  // A rendered mermaid diagram's expand chip (src/mermaid.ts) fires this with
  // the diagram's SVG; open the zoom/pan canvas on it.
  useEffect(() => {
    const onExpand = (e: Event) => {
      const detail = (e as CustomEvent<{ svg?: string }>).detail;
      if (detail && typeof detail.svg === "string") setZoomDiagramSvg(detail.svg);
    };
    window.addEventListener("dk-mermaid-expand", onExpand);
    return () => window.removeEventListener("dk-mermaid-expand", onExpand);
  }, []);

  // Land a markdown save's thread bodies in the entity meta of a document
  // that is NOT the active one (a background flush after a focus swap, a
  // web-edit pull): a guarded read-modify-write preserving the sections this
  // write doesn't own — html threads, table widths, foreign records — and
  // any orphaned bodies whose marker is still missing from the given hybrid
  // markdown.
  const writeMdThreadsToMeta = useCallback(
    async (target: string, hybridMd: string, mthreads: MdThread[]) => {
      let base = emptyMeta();
      let exists = false;
      try {
        const r = await invoke<ReadFileResult>("read_file", { path: metaFileOf(target) });
        base = parseEntityMeta(r.contents);
        exists = true;
      } catch {
        // no meta yet
      }
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
      await invoke<FileSnapshot>("write_file", {
        path: metaFileOf(target),
        contents: serializeEntityMeta(out),
        expected: null,
      }).catch((e) => console.error("meta save failed", target, e));
    },
    [],
  );


  // In-file find (⌘F): a bar over the editor that drives the ProseMirror search
  // plugin through the editor ref. `findInfo` mirrors the plugin's match count +
  // current index for the "3/12" readout.
  const editorRef = useRef<EditorHandle>(null);

  // Voice dictation. The controller (src/dictation.ts) owns the session; React
  // only mirrors its state for the HUD/inspector. Created once via ref so the
  // sidecar event listener never re-registers.
  const [dictationUi, setDictationUi] = useState<DictationUiState>(INITIAL_DICTATION_UI);
  // Session mirror for the split view's focus swap (a swap retargets
  // editorRef; an active session must end first, on the old target).
  const dictationSessionRef = useRef<DictationUiState["session"]>("idle");
  const [dictationConfig, setDictationConfig] = useState<DictationConfig | null>(null);
  const [dictationSetupOpen, setDictationSetupOpen] = useState(false);
  const [inspectorEntries, setInspectorEntries] = useState<InspectorEntry[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const dictationRef = useRef<DictationController | null>(null);
  if (!dictationRef.current) {
    dictationRef.current = new DictationController({
      getEditor: () => editorRef.current,
      onState: (s) => {
        dictationSessionRef.current = s.session;
        setDictationUi(s);
      },
      onInspect: (entry) => setInspectorEntries((prev) => [entry, ...prev].slice(0, 200)),
    });
  }
  useEffect(() => {
    void dictationRef.current?.init();
    void getDictationConfig().then(setDictationConfig);
    return () => dictationRef.current?.dispose();
  }, []);
  // The inspector auto-opens with a session when enabled in settings.
  useEffect(() => {
    if (dictationUi.session === "active" && dictationConfig?.inspector) setInspectorOpen(true);
  }, [dictationUi.session, dictationConfig?.inspector]);

  // Session keyboard: while a dictation session is live, Space doubles as the
  // talk key — held past a short threshold it opens the mic; a quick tap is
  // just the spacebar (the keydown was swallowed, so the release types the
  // space). Everything else passes through: the document stays editable
  // between utterances, and the controller suspends typing on its own while
  // the pipeline is busy. Esc ends the session. Capture phase, so the editor
  // and the global shortcut handler never see the intercepted keys; text
  // fields (find bar, comment cards, rename inputs) keep theirs.
  useEffect(() => {
    if (dictationUi.session === "idle") return;
    const ctl = dictationRef.current!;
    const active = dictationUi.session === "active";
    const HOLD_MS = 200;
    let holdTimer: number | null = null;
    const inTextField = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
      return t.isContentEditable && !t.closest(".milkdown");
    };
    const isTalkKey = (e: KeyboardEvent) =>
      active && e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey;
    const down = (e: KeyboardEvent) => {
      if (inTextField(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void ctl.stop();
        return;
      }
      if (!isTalkKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        ctl.setGate(true);
      }, HOLD_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (!isTalkKey(e) || inTextField(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (holdTimer != null) {
        // Released before the hold threshold: an ordinary spacebar press.
        window.clearTimeout(holdTimer);
        holdTimer = null;
        editorRef.current?.insertText(" ");
      } else {
        ctl.setGate(false);
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      if (holdTimer != null) window.clearTimeout(holdTimer);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [dictationUi.session]);

  // A dictation session is anchored to one document; switching or closing
  // tabs ends it immediately (pending chunks flush as raw text first) — the
  // graceful drain would land text in the wrong editor.
  useEffect(() => {
    if (dictationUi.session !== "idle") void dictationRef.current?.stop(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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
  const [sidebarMode, setSidebarMode] = useState<"files" | "search">("files");
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
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

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

  useEffect(() => {
    writeDraftsOpen(draftsOpen);
  }, [draftsOpen]);

  // Defined with the meta helpers below; writeToDisk needs it before then.
  const writeSidecarNowRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // `contents` is the editor's serialization — FULL CriticMarkup. The disk
  // gets the hybrid split: markers-only markdown plus thread-body records in
  // the entity meta (see metaFile.ts). A body-only edit (a reply typed in
  // the rail) leaves the hybrid markdown byte-identical and skips that
  // write entirely — only the meta moves.
  const writeToDisk = useCallback(async (target: string, contents: string) => {
    const { md: hybrid, mthreads } = extractMarkdown(contents);
    // The editor never saw the document's frontmatter block; put it back,
    // byte for byte, in front of what it did see. Captured now, because the
    // active document can change while the write is in flight.
    const head = pathRef.current === target ? cardHeadRef.current : "";
    try {
      const isActive = pathRef.current === target;
      let newSnapshot: FileSnapshot | null = null;
      // Never skip a file's FIRST write (no snapshot = nothing on disk yet
      // — a promoted draft must be created even when its content is empty).
      const mdUnchanged =
        isActive && snapshotRef.current !== null && hybrid === lastDiskMdRef.current;
      if (!mdUnchanged) {
        newSnapshot = await invoke<FileSnapshot>("write_file", {
          path: target,
          contents: head + hybrid,
          expected: snapshotRef.current,
        });
      }
      // Same for the drafts panel: its previews come from disk, so re-list once
      // a draft's write has landed (including a flush resolving after a switch).
      if (tabsRef.current.some((t) => t.kind === "draft" && t.path === target)) {
        setDraftsRefreshToken((n) => n + 1);
      }
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
        // The doc's thread bodies still land in ITS meta — a guarded
        // read-modify-write that preserves the sections this save doesn't
        // own (html threads, foreign records) and any orphaned bodies.
        await writeMdThreadsToMeta(target, hybrid, mthreads);
        return;
      }
      if (newSnapshot) {
        snapshotRef.current = newSnapshot;
        lastDiskMdRef.current = hybrid;
      }
      lastSavedRef.current = contents;
      // This save's extraction is the live thread-body set; an orphan whose
      // marker came back (undo, paste) is live again and leaves the orphan
      // list.
      mdThreadsRef.current = mthreads;
      const rooted = new Set(mthreads.map((t) => t.id));
      const ids = markerIds(hybrid);
      if (mdOrphansRef.current.some((t) => rooted.has(t.id) || ids.has(t.id))) {
        const remaining = mdOrphansRef.current.filter(
          (t) => !rooted.has(t.id) && !ids.has(t.id),
        );
        mdOrphansRef.current = remaining;
        setMdOrphans(remaining);
      }
      await writeSidecarNowRef.current();
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
        if (s?.doc && s.doc.path === target && isWriteError(e) && e.kind === "conflict") {
          setSplitState({
            ...s,
            doc: { ...s.doc, conflict: { diskSnapshot: e.current }, dirty: true },
          });
        }
        return;
      }
      if (isWriteError(e) && e.kind === "conflict") {
        setConflict({ diskSnapshot: e.current });
      } else {
        console.error("autosave failed", e);
      }
    }
  }, [setSplitState, refreshMirror, writeMdThreadsToMeta]);

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
  const flushPendingAutosave = useCallback((): Promise<void> => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const target = pathRef.current;
    if (!target) return Promise.resolve();
    const snapshot = currentMarkdownRef.current;
    if (snapshot === lastSavedRef.current) return Promise.resolve();
    return writeToDisk(target, snapshot);
  }, [writeToDisk]);

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
  // (missing file = no comments yet). Never writes; migration (and ordinary
  // saves) normalize later.
  const readEntityMeta = useCallback(
    async (
      docPath: string,
    ): Promise<{
      meta: EntityMeta;
      metaExists: boolean;
      // The meta FILE's bytes — what a migration write-back must diff
      // against to know the disk needs updating.
      diskRaw: string | null;
    }> => {
      let meta = emptyMeta();
      let metaExists = false;
      let diskRaw: string | null = null;
      try {
        const r = await invoke<ReadFileResult>("read_file", { path: metaFileOf(docPath) });
        meta = parseEntityMeta(r.contents);
        metaExists = true;
        diskRaw = r.contents;
      } catch {
        // no meta file yet
      }
      return { meta, metaExists, diskRaw };
    },
    [],
  );

  // Load the ACTIVE entity's meta into the app refs. The markdown-side split
  // into live threads vs orphans needs the markdown text — callers that have
  // it pass it; an html-only document parks every mthread record as a hidden
  // orphan (unreachable without a markdown side, but never dropped).
  const loadEntityMeta = useCallback(
    async (
      docPath: string | null,
      md: string | null,
    ): Promise<{ meta: EntityMeta; diskRaw: string | null }> => {
      if (!docPath) {
        htmlSidecarExistsRef.current = false;
        applyHtmlThreads([]);
        mdThreadsRef.current = [];
        mdOrphansRef.current = [];
        setMdOrphans([]);
        adoptTableWidths([]);
        metaForeignRef.current = [];
        return { meta: emptyMeta(), diskRaw: null };
      }
      const { meta, metaExists, diskRaw } = await readEntityMeta(docPath);
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
      return { meta, diskRaw };
    },
    [applyHtmlThreads, adoptTableWidths, readEntityMeta],
  );

  // (Re)arm the file watcher with the full CURRENT document set: the active
  // document and its companions, plus the split pane's document and its
  // companions. One watcher covers both panes — events carry the path and the
  // change handler routes them. Also the re-arm after the FIRST sidecar
  // write: a file that didn't exist when watch_file ran isn't being watched,
  // so external edits to it would go unseen.
  const refreshWatchSet = useCallback(async () => {
    const files: string[] = [];
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (active?.kind === "file" && !active.missing) {
      if (pathRef.current) {
        files.push(pathRef.current, ...watchExtrasOf(pathRef.current, htmlPathRef.current));
      } else if (htmlPathRef.current) {
        // html-only document: the rendition is the primary file.
        files.push(
          htmlPathRef.current,
          ...watchExtrasOf(htmlPathRef.current, htmlPathRef.current),
        );
      }
    }
    const sd = splitRef.current?.doc;
    if (sd && sd.kind === "file" && !sd.missing) {
      files.push(sd.path, ...watchExtrasOf(sd.path, sd.htmlPath));
    }
    const seen = new Set<string>();
    const unique = files.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
    try {
      if (unique.length === 0) {
        await invoke("unwatch_file");
      } else {
        await invoke("watch_file", { path: unique[0], extras: unique.slice(1) });
      }
    } catch (e) {
      console.error("watch_file failed", e);
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

  const writeSidecarNow = useCallback(async () => {
    const docPath = pathRef.current ?? htmlPathRef.current;
    if (!docPath) return;
    const meta = composeActiveMeta();
    // Deleting the last thread empties the file rather than deleting it (the
    // only remover the app has is the Trash — too loud for a sidecar); a doc
    // that never had comments never gets one.
    if (metaIsEmpty(meta) && !htmlSidecarExistsRef.current) return;
    try {
      await invoke<FileSnapshot>("write_file", {
        path: metaFileOf(docPath),
        contents: serializeEntityMeta(meta),
        expected: null,
      });
      const isNew = !htmlSidecarExistsRef.current;
      htmlSidecarExistsRef.current = true;
      if (isNew) await refreshWatchSet();
    } catch (e) {
      console.error("comment save failed", e);
    }
  }, [refreshWatchSet, composeActiveMeta]);
  writeSidecarNowRef.current = writeSidecarNow;

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

  /* ---------- The one-time layout migration ----------
     Normalize an entity's files to the hybrid layout: full inline threads in
     the markdown move to meta records (bare markers stay). Pure logic in
     metaFile.migrateEntity; this wrapper does the guarded IO. Idempotent and
     conflict-safe: markdown writes are conditional on the snapshot the
     content was read at, so racing a concurrent edit (or another device's
     migration — byte-identical by construction) just skips; the next open
     retries. */
  const migrateEntityOnDisk = useCallback(
    async (
      docPath: string,
      known?: { md: string; snapshot: FileSnapshot; meta: EntityMeta; diskRaw: string | null },
    ): Promise<void> => {
      const htmlOnly = isHtmlPath(docPath);
      let md: string | null = null;
      let snapshot: FileSnapshot | null = null;
      let meta: EntityMeta;
      let diskRaw: string | null;
      if (known) {
        md = htmlOnly ? null : known.md;
        snapshot = known.snapshot;
        meta = known.meta;
        diskRaw = known.diskRaw;
      } else {
        if (!htmlOnly) {
          try {
            const r = await invoke<ReadFileResult>("read_file", { path: docPath });
            md = r.contents;
            snapshot = r.snapshot;
          } catch {
            return; // unreadable right now; nothing to migrate
          }
        }
        const read = await readEntityMeta(docPath);
        meta = read.meta;
        diskRaw = read.diskRaw;
      }
      const result = migrateEntity({ diskMd: md, meta });
      if (result.mdChanged && result.md !== null) {
        try {
          const newSnap = await invoke<FileSnapshot>("write_file", {
            path: docPath,
            contents: result.md,
            expected: snapshot,
          });
          // The active document's disk baseline moved (its EXPANDED editor
          // content is unchanged — that's the point of the split layout).
          if (pathRef.current === docPath) {
            snapshotRef.current = newSnap;
            // The disk baseline is the body — the migration rewrote the whole
            // file, frontmatter block and all (it only touches CriticMarkup).
            lastDiskMdRef.current = parseFrontmatter(result.md).body;
          }
        } catch {
          return; // lost to a concurrent edit; retried on the next open
        }
      }
      const desired = serializeEntityMeta(result.meta);
      const mustWriteMeta =
        diskRaw === null ? !metaIsEmpty(result.meta) : desired !== diskRaw;
      if (mustWriteMeta) {
        try {
          await invoke<FileSnapshot>("write_file", {
            path: metaFileOf(docPath),
            contents: desired,
            expected: null,
          });
          if ((pathRef.current ?? htmlPathRef.current) === docPath) {
            htmlSidecarExistsRef.current = true;
          }
        } catch (e) {
          console.error("meta migration write failed", docPath, e);
        }
      }
    },
    [readEntityMeta],
  );


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

  const addRecent = useCallback((p: string, kind: "file" | "folder") => {
    setRecents((prev) => {
      const next = [{ path: p, kind }, ...prev.filter((r) => r.path !== p)].slice(
        0,
        RECENTS_MAX,
      );
      writeStoredRecents(next);
      return next;
    });
  }, []);

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
      t.id === id ? { ...t, missing: missing || undefined } : t,
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
      head: cardHeadRef.current,
      props: cardPropsRef.current,
      opaque: cardOpaqueRef.current,
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
      let contents = "";
      let snapshot: FileSnapshot | null = null;
      try {
        const r = await invoke<ReadFileResult>("read_file", { path: tab.path });
        contents = r.contents;
        snapshot = r.snapshot;
      } catch (e) {
        console.error("read failed", tab.path, e);
        return {
          doc: {
            path: tab.path,
            kind: tab.kind,
            missing: true,
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
            props: {},
            opaque: [],
            conflict: null,
            dirty: false,
          },
          view: "md",
        };
      }
      let htmlPath: string | null = null;
      if (htmlOnly) {
        htmlPath = tab.path;
      } else if (tab.kind === "file") {
        const sibling = htmlSiblingOf(tab.path);
        const exists = await invoke<boolean>("path_exists", { path: sibling }).catch(
          () => false,
        );
        if (exists) htmlPath = sibling;
      }
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
          : await invoke<ReadFileResult>("read_file", { path: htmlPath })
              .then((r) => r.contents)
              .catch(() => null);
      }
      // The pane's threads and thread bodies come from the entity meta; the
      // pane editor gets EXPANDED markdown — same read boundary as the
      // active document.
      const { meta, metaExists } = await readEntityMeta(tab.path);
      // The frontmatter boundary again: this pane's editor is handed the body,
      // and the block rides along in the record.
      const fm = parseFrontmatter(htmlOnly ? "" : contents);
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
          head: htmlOnly ? "" : contents.slice(0, contents.length - fm.body.length),
          props: fm.props,
          opaque: fm.opaque,
          conflict: null,
          dirty: false,
        },
        view: view === "html" && htmlContentValue === null && !htmlOnly ? "md" : view,
      };
    },
    [readEntityMeta],
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
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    // A pending comment write still targets the PREVIOUS document's sidecar
    // (htmlPathRef switches below) — land it first.
    await flushSidecarWrite();
    // A BOARD tab: its path is a folder, and KanbanBoard owns every read and
    // write inside it. Stand the document machinery down completely — the
    // same posture an html-only document takes, one step further.
    if (tab.kind === "store") {
      const exists = await invoke<boolean>("path_exists", { path: tab.path }).catch(
        () => false,
      );
      setTabMissing(tab.id, !exists);
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
      await loadEntityMeta(null, null);
      applyDocView("md");
      setLoadKey((k) => k + 1);
      await refreshWatchSet(); // nothing of the board's is watched as a file
      return;
    }
    // An html-only document: rendered read-only, never loaded into the
    // markdown editor and never an autosave target (pathRef stays null).
    const htmlOnly = tab.kind === "file" && isHtmlPath(tab.path);

    let contents = "";
    let snapshot: FileSnapshot | null = null;
    let failed = false;
    try {
      const result = await invoke<ReadFileResult>("read_file", { path: tab.path });
      contents = result.contents;
      snapshot = result.snapshot;
    } catch (e) {
      failed = true;
      console.error("read failed", tab.path, e);
    }
    if (failed) {
      // Ghost state: pathRef stays null so autosave can't recreate the file at
      // its old path, and nothing is watched. The editor is not rendered.
      setTabMissing(tab.id, true);
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
      await loadEntityMeta(null, null);
      applyDocView("md");
      await refreshWatchSet(); // nothing active to watch (a split pane may remain)
      return;
    }
    setTabMissing(tab.id, false); // the file is back (or was never gone)

    // Resolve the document's html rendition: the MD/HTML toggle and the
    // watcher's companion set both need it.
    let htmlPath: string | null = null;
    if (htmlOnly) {
      htmlPath = tab.path;
    } else if (tab.kind === "file") {
      const sibling = htmlSiblingOf(tab.path);
      const exists = await invoke<boolean>("path_exists", { path: sibling }).catch(
        () => false,
      );
      if (exists) htmlPath = sibling;
    }
    // The frontmatter boundary: split the leading block off the top and keep
    // it in the refs. Everything below — the meta layer, the editor, the disk
    // baseline — works on the BODY alone, so prose edits can never rewrite
    // properties and property edits never touch the prose.
    const body = adoptFrontmatter(htmlOnly ? "" : contents).body;
    const { meta, diskRaw } = await loadEntityMeta(tab.path, htmlOnly ? null : body);
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
    // Old-layout content (full threads inline) normalizes on open —
    // fire-and-forget; conditional writes make racing edits safe. Drafts
    // migrate through their own saves.
    if (tab.kind === "file" && snapshot) {
      const snap = snapshot;
      void migrateEntityOnDisk(tab.path, {
        md: contents,
        snapshot: snap,
        meta,
        diskRaw,
      });
    }
    const view: DocView =
      htmlOnly || (htmlPath != null && viewPrefsRef.current.get(tab.path) === "html")
        ? "html"
        : "md";
    applyDocView(view);
    if (view === "html" && htmlPath) {
      if (htmlOnly) {
        setHtmlContent(contents);
      } else {
        try {
          const r = await invoke<ReadFileResult>("read_file", { path: htmlPath });
          setHtmlContent(r.contents);
        } catch (e) {
          console.error("read failed", htmlPath, e);
          setHtmlContent(null);
          applyDocView("md");
        }
      }
    } else {
      setHtmlContent(null);
    }
    bumpEditorSeq(tab.id); // remount the focused pane's editor with the fresh content
    setLoadKey((k) => k + 1);

    // Watch the document set: the markdown for the edit/conflict flow, the
    // rendition so external regeneration re-renders live, the entity meta so
    // threads delivered from outside pop in — plus the
    // split pane's set. Drafts aren't externally watched.
    await refreshWatchSet();
  }, [
    setTabMissing,
    adoptFrontmatter,
    applyDocView,
    flushSidecarWrite,
    loadEntityMeta,
    migrateEntityOnDisk,
    refreshWatchSet,
    bumpEditorSeq,
  ]);

  // Re-materialize stored tab descriptors against disk: a readable tab keeps its
  // identity (a draft regains its Untitled-N title; a stale `missing` flag
  // clears), an unreadable FILE tab becomes a visible ghost, and an unreadable
  // draft (app-managed, so truly gone) is dropped. Shared by the startup restore
  // and in-app workspace switches.
  const rebuildTabs = useCallback(async (stored: Tab[]): Promise<Tab[]> => {
    const out: Tab[] = [];
    for (const t of stored) {
      if (t.kind === "store") {
        const exists = await invoke<boolean>("path_exists", { path: t.path }).catch(
          () => false,
        );
        out.push(exists ? { ...t, missing: undefined } : { ...t, missing: true });
        continue;
      }
      try {
        await invoke<ReadFileResult>("read_file", { path: t.path });
        out.push(
          t.kind === "draft" && !t.title
            ? { ...t, title: `Untitled-${draftsMetaRef.current[t.id]?.seq ?? "?"}` }
            : { ...t, missing: undefined }, // readable again → clear a stale flag
        );
      } catch {
        if (t.kind === "file") out.push({ ...t, missing: true });
      }
    }
    return out;
  }, []);

  // Reset to the "no document open" state (welcome screen). Clears the per-doc
  // refs so autosave is a no-op and unmounts the editor.
  const clearActiveDoc = useCallback(async () => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await flushSidecarWrite();
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
    await loadEntityMeta(null, null);
    applyDocView("md");
    await refreshWatchSet(); // drops the active set; keeps a split pane's watch alive
  }, [adoptFrontmatter, applyDocView, flushSidecarWrite, loadEntityMeta, refreshWatchSet]);

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

  // Open a path in a tab (dedupe by path). Used for files (picker/recents/sidebar/
  // CLI) and for reopening a draft from the drafts list.
  const openTab = useCallback(
    async (p: string, kind: TabKind) => {
      // An html file whose markdown sibling exists is a rendition of THAT
      // document — open the pair as one tab keyed on the markdown path,
      // starting on the view the user actually asked for.
      if (kind === "file" && isHtmlPath(p)) {
        const md = mdSiblingOf(p);
        const paired = await invoke<boolean>("path_exists", { path: md }).catch(
          () => false,
        );
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
      if (kind === "file") addRecent(p, "file");
      if (kind === "draft") {
        const id = draftIdFromPath(p);
        await appendAndActivate({
          id,
          kind,
          path: p,
          title: `Untitled-${draftsMetaRef.current[id]?.seq ?? "?"}`,
        });
      } else {
        await appendAndActivate({ id: uuid(), kind, path: p });
      }
    },
    [switchTab, addRecent, appendAndActivate, loadActiveContent],
  );

  // ⌘N: create a brand-new empty draft and open it. Don't spawn a second empty
  // draft if the active one is already an untouched draft.
  const newDraft = useCallback(async () => {
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (active?.kind === "draft" && currentMarkdownRef.current.trim().length === 0) {
      return;
    }
    const seq = draftSeqRef.current + 1;
    draftSeqRef.current = seq;
    writeDraftSeq(seq);
    const id = uuid();
    let draftPath: string;
    try {
      draftPath = await invoke<string>("create_draft", { id });
    } catch (e) {
      console.error("create_draft failed", e);
      return;
    }
    draftsMetaRef.current = { ...draftsMetaRef.current, [id]: { seq } };
    writeDraftsMeta(draftsMetaRef.current);
    await appendAndActivate({ id, kind: "draft", path: draftPath, title: `Untitled-${seq}` });
  }, [appendAndActivate]);

  // Refresh the drafts-panel list: all drafts (newest first) joined with their
  // Untitled-N number. Keeps open + empty drafts so the panel always reflects
  // what exists (including the active new draft).
  const refreshDraftsPanel = useCallback(async () => {
    let drafts: DraftInfo[] = [];
    try {
      drafts = await invoke<DraftInfo[]>("list_drafts");
    } catch (e) {
      console.error("list_drafts failed", e);
      setDraftRows([]);
      return;
    }
    setDraftRows(
      drafts.map((d) => ({
        id: d.id,
        path: d.path,
        title: `Untitled-${draftsMetaRef.current[d.id]?.seq ?? "?"}`,
        preview: d.preview,
      })),
    );
  }, []);

  const selectSidebarEntries = useCallback((sels: SidebarSelection[]) => {
    sidebarSelectionRef.current = sels;
    setSidebarSelection(sels);
  }, []);

  const setWorkspace = useCallback((root: string) => {
    sessionWorkspaceRoot = root;
    setWorkspaceRoot(root);
    setSidebarOpen(true);
    selectSidebarEntries([]); // a selection from the previous workspace is meaningless
    addRecent(root, "folder");
    writeStoredSession(tabsRef.current, activeIdRef.current); // the root is part of the session
  }, [addRecent, selectSidebarEntries]);

  // Switch this window to a different workspace folder (File ▸ Open Folder, a
  // recent, the sidebar). Because tabs are keyed by folder, we persist the
  // outgoing folder's tabs under its own key, then load and install the incoming
  // folder's — the same directory-scoped model a `doklin <dir>` launch uses.
  // Document content lives on disk and autosaves, so swapping the tab set never
  // loses edits.
  const openWorkspace = useCallback(
    async (root: string) => {
      if (root === sessionWorkspaceRoot) {
        setWorkspace(root); // already here — just resurface the sidebar/recents
        return;
      }
      flushPendingAutosave(); // land the outgoing doc before we swap tabs
      captureActiveScroll();
      // Persist the outgoing workspace under its own key before switching, so
      // returning to it later restores exactly these tabs (split included —
      // the module mirror still holds the outgoing one).
      writeStoredSession(tabsRef.current, activeIdRef.current);
      // From here session writes target the incoming folder. Drop the split
      // WITHOUT persisting (tabsRef still holds the outgoing tabs; a write
      // now would stamp them into the incoming key).
      splitRef.current = null;
      setSplit(null);
      sessionSplit = null;
      const session = readStoredSession(root);
      sessionWorkspaceRoot = root;
      const restored = await rebuildTabs(session.tabs);
      const activeId =
        restored.length === 0
          ? null
          : session.activeId && restored.some((t) => t.id === session.activeId)
            ? session.activeId
            : restored[restored.length - 1].id;
      tabsRef.current = restored;
      activeIdRef.current = activeId;
      setTabs(restored);
      setActiveId(activeId);
      setWorkspace(root); // adopt root, open sidebar, add recent, persist session
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
      const chosen = await openDialog({ directory: true, multiple: false });
      if (typeof chosen === "string") await openWorkspace(chosen);
    } catch (e) {
      console.error("open folder failed", e);
    }
  }, [openWorkspace]);

  const openFilePicker = useCallback(async () => {
    try {
      const chosen = await openDialog({
        multiple: false,
        filters: [
          { name: "Documents", extensions: ["md", "markdown", "mdown", "mkd", "html"] },
        ],
      });
      if (typeof chosen === "string") await openTab(chosen, "file");
    } catch (e) {
      console.error("open file failed", e);
    }
  }, [openTab]);

  // Open in a NEW window (⌘⌥O / ⌘⌥⇧O). The backend focuses an existing window
  // already showing the path, or spawns a fresh one — so the same file/folder is
  // never opened twice.
  const openFileInNewWindow = useCallback(async () => {
    try {
      const chosen = await openDialog({
        multiple: false,
        filters: [
          { name: "Documents", extensions: ["md", "markdown", "mdown", "mkd", "html"] },
        ],
      });
      if (typeof chosen === "string") {
        addRecent(chosen, "file");
        await invoke("open_in_window", { folder: null, file: chosen });
      }
    } catch (e) {
      console.error("open file in new window failed", e);
    }
  }, [addRecent]);

  const openFolderInNewWindow = useCallback(async () => {
    try {
      const chosen = await openDialog({ directory: true, multiple: false });
      if (typeof chosen === "string") {
        addRecent(chosen, "folder");
        await invoke("open_in_window", { folder: chosen, file: null });
      }
    } catch (e) {
      console.error("open folder in new window failed", e);
    }
  }, [addRecent]);

  const openRecent = useCallback(
    (r: RecentEntry) => {
      if (r.kind === "folder") void openWorkspace(r.path);
      else void openTab(r.path, "file");
    },
    [openWorkspace, openTab],
  );

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
      await invoke("reveal_in_finder", { path: target });
    } catch (e) {
      console.error("reveal failed", e);
    }
  }, []);

  const openExternal = useCallback((url: string) => {
    void invoke("open_external", { url }).catch((e) =>
      console.error("open external failed", e),
    );
  }, []);

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
        if (await invoke<boolean>("path_exists", { path: target })) {
          await openTab(target, "file");
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
      const result = await invoke<ReadFileResult>("read_file", { path: target });
      // The disk holds hybrid markdown; refresh the meta alongside it and
      // hand the editor the expanded form (same boundary as the first load).
      const body = adoptFrontmatter(result.contents).body;
      const { meta } = await loadEntityMeta(target, body);
      const full = expandMarkdown(body, meta.mthreads).md;
      baselineCapturedRef.current = false;
      setInitialMarkdown(full);
      currentMarkdownRef.current = full;
      lastSavedRef.current = full;
      snapshotRef.current = result.snapshot;
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

  /* ---------- Version history (docs/versioning-plan.md §5.4) ---------- */

  // The rail, for a document reached from the sidebar, a tab, the drafts
  // panel or ⌘⌥H. It always opens on the list: a rail is somewhere to look,
  // not a jump to a version.
  const openHistory = useCallback(
    async (path: string, kind: "file" | "draft" = "file") => {
      setVersionPreview(null);
      // A version shows in the document area, so the document has to be the
      // one standing in it: opening history for a file in the tree opens the
      // file too.
      if (historyTargetRef.current?.path !== path) await openTab(path, kind);
      setHistoryFor(path);
      setHistoryToken((t) => t + 1);
    },
    [openTab],
  );

  const closeHistory = useCallback(() => {
    setHistoryFor(null);
    setVersionPreview(null);
  }, []);

  // ⌘⌥H, the fourth way in: a toggle for whatever is open.
  const toggleHistory = useCallback(() => {
    if (historyForRef.current) {
      closeHistory();
      return;
    }
    const target = historyTargetRef.current;
    if (target) void openHistory(target.path, target.kind);
  }, [closeHistory, openHistory]);

  // Selecting a version shows it where the document is. The live editor's
  // pending autosave lands FIRST: what has been typed since the last
  // capture has to be on disk before a restore can promise to bring it back.
  const previewVersion = useCallback(
    (version: FileVersion, root: string, newer: FileVersion | null) => {
      void flushPendingAutosave();
      setVersionPreview({ version, newer, root });
    },
    [flushPendingAutosave],
  );

  // Undoing a restore is another restore — of the state the first one left
  // (docs/versioning-plan.md §12.3.8). The timeline is the undo; ⌘Z is not
  // promised for it.
  const undoRestore = useCallback(
    async (docPath: string, root: string, outcome: RestoreOutcome) => {
      if (outcome.preRestoreHash == null) return;
      try {
        await versionsRestoreFile(root, docPath, {
          ts: outcome.preRestoreTs,
          hash: outcome.preRestoreHash,
        });
        setHistoryToken((t) => t + 1);
      } catch (e) {
        pushToast(`Couldn't undo that restore: ${errText(e)}`);
      }
    },
    [pushToast],
  );

  // One Rust command does all three steps — capture what is here, write the
  // old bytes, capture what that made — because the cadence must not get
  // between them.
  const restoreVersion = useCallback(
    async (docPath: string, root: string, version: FileVersion, text: string | null) => {
      try {
        const outcome = await versionsRestoreFile(root, docPath, {
          ts: version.ts,
          hash: version.source === "cloud" ? null : version.hash,
          text,
        });
        setVersionPreview(null);
        setHistoryToken((t) => t + 1);
        pushToast(`Restored the version from ${momentLabel(version.ts)}.`, {
          label: "Undo",
          run: () => void undoRestore(docPath, root, outcome),
        });
      } catch (e) {
        pushToast(`Couldn't restore that version: ${errText(e)}`);
      }
    },
    [pushToast, undoRestore],
  );

  const keepMyVersion = useCallback(() => {
    const c = conflictRef.current;
    if (c) snapshotRef.current = c.diskSnapshot;
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
          await dictationRef.current?.stop();
          // Awaited: the meta reload below re-reads the entity from disk,
          // and a still-in-flight autosave (markdown + thread bodies) must
          // land first or the reload adopts a stale thread set.
          await flushPendingAutosave();
          let contents: string;
          try {
            contents = (await invoke<ReadFileResult>("read_file", { path: htmlPath }))
              .contents;
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
        // Dictation is an editing mode and the html view is read-only: end an
        // active session (its pending chunks flush) before hiding the editor.
        await dictationRef.current?.stop();
        // Awaited for the same reason as the pane-swap branch above: the
        // meta reload must see this document's landed thread bodies.
        await flushPendingAutosave();
        setFindOpen(false);
        setFindQuery(""); // find targets the markdown editor only
        let contents: string;
        try {
          contents = (await invoke<ReadFileResult>("read_file", { path: htmlPath }))
            .contents;
        } catch (e) {
          console.error("read failed", htmlPath, e);
          return; // rendition vanished from disk; stay on markdown
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
      // Dictation writes through editorRef; retargeting mid-session would
      // land spoken text in the other document. End it first (the common
      // promote path — a click — runs with dictation idle and stays sync).
      if (dictationSessionRef.current !== "idle") {
        await dictationRef.current?.stop();
      }
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
        incoming.missing || incomingHtmlOnly ? null : incoming.path;
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
      // document's properties to this one.
      cardHeadRef.current = incoming.head;
      cardPropsRef.current = incoming.props;
      cardOpaqueRef.current = incoming.opaque;
      setCardProps(incoming.props);
      setCardOpaque(incoming.opaque);
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
      if (!tab || tab.missing) return;
      const htmlOnly = tab.kind === "file" && isHtmlPath(tab.path);
      let v: DocView = view ?? docViewRef.current;
      if (htmlOnly) v = "html";
      if (v === "html" && !htmlPathRef.current) v = "md"; // no rendition on disk
      if (v === "html" && htmlContentRef.current == null) {
        // Restoring an md|html arrangement: the rendition isn't loaded yet.
        const htmlPath = htmlPathRef.current!;
        try {
          const r = await invoke<ReadFileResult>("read_file", { path: htmlPath });
          setHtmlContent(r.contents);
          htmlContentRef.current = r.contents;
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
              const r = await invoke<ReadFileResult>("read_file", { path: htmlPath });
              setHtmlContent(r.contents);
              htmlContentRef.current = r.contents;
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
            contents = (
              await invoke<ReadFileResult>("read_file", { path: s.doc.htmlPath })
            ).contents;
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
          const paired = await invoke<boolean>("path_exists", { path: md }).catch(
            () => false,
          );
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
        addRecent(target, "file");
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
    [dropSideForPointer, commitTabDrop, addRecent, appendAndActivate, openInPane],
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

  const closeTab = useCallback(
    async (id: string, opts?: { discard?: boolean }) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      // Split bookkeeping first, so the close below never leaves a pane
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
      if (isActive) flushPendingAutosave();

      if (tab.kind === "draft") {
        // Delete the draft file when discarding outright, or when it's empty
        // (nothing to recover). Otherwise the draft persists in the drafts panel.
        let remove = opts?.discard === true;
        if (!remove) {
          const content = isActive
            ? currentMarkdownRef.current
            : await invoke<ReadFileResult>("read_file", { path: tab.path })
                .then((r) => r.contents)
                .catch(() => "");
          remove = content.trim().length === 0;
        }
        if (remove) {
          try {
            await invoke("delete_draft", { path: tab.path });
          } catch (e) {
            console.error("delete_draft failed", e);
          }
          const { [tab.id]: _removed, ...rest } = draftsMetaRef.current;
          draftsMetaRef.current = rest;
          writeDraftsMeta(rest);
        }
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
    },
    [
      flushPendingAutosave,
      clearActiveDoc,
      loadActiveContent,
      swapFocus,
      closeSplit,
    ],
  );

  // Discard a draft from the drafts panel: if it's open in a tab, close that tab
  // and force-delete it (even with content); otherwise just delete the file.
  const discardDraft = useCallback(
    async (p: string, id: string) => {
      const open = tabsRef.current.find((t) => t.path === p);
      if (open) {
        await closeTab(open.id, { discard: true });
      } else {
        try {
          await invoke("delete_draft", { path: p });
        } catch (e) {
          console.error("delete_draft failed", e);
        }
        const { [id]: _removed, ...rest } = draftsMetaRef.current;
        draftsMetaRef.current = rest;
        writeDraftsMeta(rest);
      }
      await refreshDraftsPanel();
    },
    [closeTab, refreshDraftsPanel],
  );

  // Keep the drafts panel in sync: refresh when it opens, whenever the open
  // tabs change (new / close / promote all flow through here), and after each
  // autosaved draft write lands (so previews track live edits).
  useEffect(() => {
    if (draftsOpen) void refreshDraftsPanel();
  }, [draftsOpen, tabs, draftsRefreshToken, refreshDraftsPanel]);

  // Move a file or folder to the system Trash (⌘⌫ / the sidebar's context
  // menu). The backend returns where the entry landed inside the Trash so
  // undoDelete can pull it straight back out — a true restore that leaves no
  // stale copy. Any tabs on the entry (or inside it, for a folder) are closed
  // first.
  const deleteEntry = useCallback(
    async (target: string, kind: "file" | "dir") => {
      // Close affected tabs first (flushing their content while the files still
      // exist), so the trash that follows can't be resurrected by a late
      // autosave write and the watcher has already moved to a neighbor tab.
      const affected = tabsRef.current.filter(
        (t) =>
          (t.kind === "file" || t.kind === "store") &&
          (t.path === target || (kind === "dir" && t.path.startsWith(target + "/"))),
      );
      for (const t of affected) await closeTab(t.id);
      let trashPath: string;
      try {
        trashPath = await invoke<string>("trash_file", { path: target });
      } catch (e) {
        console.error("trash failed", e);
        alert(`Could not delete ${target}\n${e}`);
        return;
      }
      const files = [{ path: target, trashPath }];
      // A document's companions are trashed with it — the html rendition (for
      // a markdown file) and the entity meta are one document with it.
      // Best-effort: the primary is already in the Trash.
      const trashCompanion = async (path: string, label: string) => {
        const exists = await invoke<boolean>("path_exists", { path }).catch(() => false);
        if (!exists) return;
        try {
          files.push({
            path,
            trashPath: await invoke<string>("trash_file", { path }),
          });
        } catch (e) {
          console.error("trash failed", e);
          alert(`Deleted ${basename(target)} but not its ${label}.\n${e}`);
        }
      };
      if (kind === "file" && MD_EXT_RE.test(target)) {
        const sibling = htmlSiblingOf(target);
        await trashCompanion(sibling, "HTML version");
        await trashCompanion(metaFileOf(target), "comments");
      } else if (kind === "file" && HTML_EXT_RE.test(target)) {
        // A standalone html document owns the entity meta; a rendition of a
        // live pair doesn't — there, only its own (hthread) records die with
        // it and the markdown side's stay.
        const mdSide = mdSiblingOf(target);
        const mdExists = await invoke<boolean>("path_exists", { path: mdSide }).catch(
          () => false,
        );
        if (!mdExists) {
          await trashCompanion(metaFileOf(target), "comments");
        } else {
          try {
            const r = await invoke<ReadFileResult>("read_file", { path: metaFileOf(target) });
            const m = parseEntityMeta(r.contents);
            if (m.hthreads.length > 0) {
              await invoke<FileSnapshot>("write_file", {
                path: metaFileOf(target),
                contents: serializeEntityMeta({ ...m, hthreads: [] }),
                expected: r.snapshot,
              });
            }
          } catch {
            // no meta (or it moved underneath) — nothing to scrub
          }
        }
      }
      const record: DeletedRecord = {
        files,
        openPaths: affected.map((t) => t.path),
      };
      deletedStackRef.current.push(record);
      const sels = sidebarSelectionRef.current;
      const kept = sels.filter(
        (s) => s.path !== target && !s.path.startsWith(target + "/"),
      );
      if (kept.length !== sels.length) selectSidebarEntries(kept);
      setTreeRefreshToken((t) => t + 1);
    },
    [closeTab, selectSidebarEntries],
  );

  // Undo the most recent trash (⌘Z outside the editor): move the entry (and
  // any rendition trashed with it) back out of the Trash to its original
  // path, and reopen the tabs it closed.
  const undoDelete = useCallback(async () => {
    const entry = deletedStackRef.current.pop();
    if (!entry) return;
    let restoredAny = false;
    for (const f of entry.files) {
      try {
        await invoke("restore_trashed", {
          trashPath: f.trashPath,
          originalPath: f.path,
        });
        restoredAny = true;
      } catch (e) {
        console.error("undo delete failed", e);
        alert(`Could not restore ${f.path}\n${e}`);
      }
    }
    if (!restoredAny) return;
    setTreeRefreshToken((t) => t + 1);
    for (const p of entry.openPaths) {
      // A restored path is a document or a board folder; ask disk which.
      const isBoard = await invoke<boolean>("path_exists", {
        path: `${p}/${STORE_FILE}`,
      }).catch(() => false);
      await openTab(p, isBoard ? "store" : "file");
    }
  }, [openTab]);

  // Move or rename a file/folder on disk (the sidebar's drag-and-drop and
  // inline Rename both end here), then repoint every piece of state that keys
  // off the old path: open tabs (including everything inside a moved folder),
  // the active document's autosave target and watcher, recents, and the
  // sidebar selection. Returns an error message for the caller to surface
  // (inline under the rename input, alert for a drop), or null on success.
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
      try {
        await invoke("move_path", { from, to });
      } catch (e) {
        return String(e);
      }
      // A document's companions move/rename with it — the markdown, its html
      // rendition and the entity meta are one document, and leaving one
      // behind would silently split it. Best-effort: the primary file has
      // already moved.
      const moveCompanion = async (cFrom: string, cTo: string, label: string) => {
        const exists = await invoke<boolean>("path_exists", { path: cFrom }).catch(
          () => false,
        );
        if (!exists) return;
        try {
          await invoke("move_path", { from: cFrom, to: cTo });
        } catch (e) {
          window.alert(`Moved "${basename(from)}" but not its ${label}.\n${e}`);
        }
      };
      if (kind === "file" && MD_EXT_RE.test(from) && MD_EXT_RE.test(to)) {
        const fromHtml = htmlSiblingOf(from);
        const toHtml = htmlSiblingOf(to);
        await moveCompanion(fromHtml, toHtml, "HTML version");
        await moveCompanion(metaFileOf(from), metaFileOf(to), "comments");
      } else if (kind === "file" && HTML_EXT_RE.test(from) && HTML_EXT_RE.test(to)) {
        // A standalone html document carries the entity meta; a rendition of
        // a pair leaves it with the markdown side.
        const mdExists = await invoke<boolean>("path_exists", {
          path: mdSiblingOf(from),
        }).catch(() => false);
        if (!mdExists) await moveCompanion(metaFileOf(from), metaFileOf(to), "comments");
      }
      const remap = (p: string) =>
        p === from
          ? to
          : kind === "dir" && p.startsWith(from + "/")
            ? to + p.slice(from.length)
            : p;

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

      setRecents((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          const np = remap(r.path);
          if (np === r.path) return r;
          changed = true;
          return { ...r, path: np };
        });
        if (!changed) return prev;
        writeStoredRecents(next);
        return next;
      });

      const sels = sidebarSelectionRef.current;
      const remapped = sels.map((s) => {
        const np = remap(s.path);
        return np === s.path ? s : { ...s, path: np };
      });
      if (remapped.some((s, i) => s !== sels[i])) selectSidebarEntries(remapped);

      setTreeRefreshToken((t) => t + 1);
      return null;
    },
    [
      flushPendingAutosave,
      flushSidecarWrite,
      selectSidebarEntries,
      refreshWatchSet,
      setSplitState,
    ],
  );

  /* ---------- File clipboard (sidebar Cut/Copy/Paste) ---------- */

  // Local mirror of the backend clipboard, for the UI only: enabling Paste
  // and dimming rows a Cut is about to move. The backend copy is the truth —
  // paste re-reads it — so a stale mirror can't misfile anything.
  const [fileClipboard, setFileClipboard] = useState<FileClipboardPayload | null>(null);
  useEffect(() => {
    invoke<FileClipboardPayload | null>("clipboard_get_files")
      .then((p) => setFileClipboard(p ?? null))
      .catch(() => {});
    const un = listen<FileClipboardPayload | null>("file-clipboard-changed", (e) => {
      setFileClipboard(e.payload ?? null);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Cut/Copy: park the selection on the app-wide clipboard. The files aren't
  // touched until paste (a cut that's never pasted moves nothing).
  const copyEntries = useCallback(async (entries: SidebarSelection[], cut: boolean) => {
    const items = pruneNestedSelection(entries);
    if (items.length === 0) return;
    try {
      await invoke("clipboard_set_files", { items, cut });
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
        clip = await invoke<FileClipboardPayload | null>("clipboard_get_files");
      } catch {
        return;
      }
      if (!clip || clip.items.length === 0) return;
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
          try {
            await invoke("copy_path", { from: item.path, to });
          } catch (e) {
            window.alert(`Could not copy ${name}\n${e}`);
            continue;
          }
          copiedAny = true;
          // The document's companions ride along, mirroring delete/move: the
          // html rendition and the entity meta are one document with it.
          const copyCompanion = async (cFrom: string, cTo: string, label: string) => {
            const exists = await invoke<boolean>("path_exists", { path: cFrom }).catch(
              () => false,
            );
            if (!exists) return;
            try {
              await invoke("copy_path", { from: cFrom, to: cTo });
            } catch (e) {
              window.alert(`Copied ${name} but not its ${label}.\n${e}`);
            }
          };
          if (item.kind === "file" && MD_EXT_RE.test(item.path) && MD_EXT_RE.test(to)) {
            const fromHtml = htmlSiblingOf(item.path);
            const toHtml = htmlSiblingOf(to);
            await copyCompanion(fromHtml, toHtml, "HTML version");
            await copyCompanion(metaFileOf(item.path), metaFileOf(to), "comments");
          } else if (item.kind === "file" && HTML_EXT_RE.test(item.path)) {
            // A standalone html document owns the entity meta; a rendition of
            // a pair leaves it with the markdown side (same rule as move).
            // Duplicating a meta is safe by design — it carries no sync
            // identity (see metaFile.ts).
            const mdExists = await invoke<boolean>("path_exists", {
              path: mdSiblingOf(item.path),
            }).catch(() => false);
            if (!mdExists) await copyCompanion(metaFileOf(item.path), metaFileOf(to), "comments");
          }
          pasted.push({ path: to, kind: item.kind });
        }
      }
      if (clip.cut && pasted.length > 0) {
        // A cut is consumed by its paste (VS Code): a second ⌘V must not try
        // to move files that already left.
        invoke("clipboard_clear_files").catch(() => {});
      }
      if (copiedAny) setTreeRefreshToken((t) => t + 1); // moves refresh on their own
      if (pasted.length > 0) selectSidebarEntries(pasted);
    },
    [movePath, selectSidebarEntries],
  );

  // Trash a whole selection, outermost entries only — deleting a folder
  // already takes its selected children with it.
  const deleteEntries = useCallback(
    async (entries: SidebarSelection[]) => {
      for (const s of pruneNestedSelection(entries)) await deleteEntry(s.path, s.kind);
    },
    [deleteEntry],
  );

  useEffect(() => {
    (async () => {
      draftSeqRef.current = readDraftSeq();
      draftsMetaRef.current = readDraftsMeta();

      // Ask the backend who we are and what to open (the window label is the
      // authority). A spawned window initializes from its stashed file/folder and
      // skips session restore, scratch migration, and pending-open consumption —
      // those belong to the main window. (Shared prefs/drafts loaded above.)
      const init = await invoke<WindowInit>("take_window_init");
      if (!init.isMain) {
        isMainWindow = false;
        if (init.restored) {
          // A window brought back by quit-time session restore: re-adopt its
          // folder and rebuild its file tabs directly — openTab/setWorkspace
          // would reshuffle recents, and restoring isn't an "open". Unreadable
          // paths stay visible as ghost tabs, same as the main window's restore.
          if (init.folder) setWorkspaceRoot(init.folder);
          const restored: Tab[] = [];
          for (const p of init.files) {
            try {
              await invoke<ReadFileResult>("read_file", { path: p });
              restored.push({ id: uuid(), kind: "file", path: p });
            } catch {
              restored.push({ id: uuid(), kind: "file", path: p, missing: true });
            }
          }
          if (restored.length > 0) {
            const active =
              restored.find((t) => t.path === init.activeFile) ??
              restored[restored.length - 1];
            tabsRef.current = restored;
            activeIdRef.current = active.id;
            setTabs(restored);
            setActiveId(active.id);
            await loadActiveContent(active);
          }
        } else {
          if (init.folder) setWorkspace(init.folder);
          if (init.file) await openTab(init.file, "file");
        }
        setReady(true);
        return;
      }

      // One-shot migration of the legacy single scratchpad into a draft.
      let migrated: { id: string; path: string } | null = null;
      const migrateId = uuid();
      try {
        const p = await invoke<string | null>("migrate_scratch", { id: migrateId });
        if (p) migrated = { id: migrateId, path: p };
      } catch (e) {
        console.error("migrate_scratch failed", e);
      }

      // Which workspace are we opening? A CLI / Finder folder launch
      // (pendingFolder) targets that folder; otherwise reopen the last-active
      // workspace. Tabs are keyed by workspace, so we restore ONLY the target
      // directory's own tabs — a different directory's tabs never leak in.
      // (Files never arrive as a pending folder: an externally opened file
      // always gets its own spawned window, so it can't attach to this session.)
      const pendingFolder = await invoke<string | null>("take_pending_folder");
      const all = readAllSessions();
      const targetRoot = pendingFolder ?? all.lastRoot;
      // Adopt the target root into the module mirror BEFORE any
      // writeStoredSession below, so re-persisting keys tabs under the right
      // folder rather than wiping the map.
      sessionWorkspaceRoot = targetRoot;

      // Restore that folder's persisted tabs. A file tab whose path no longer
      // reads is kept as a visible "ghost" (missing) tab rather than silently
      // dropped — the disk may just be unmounted, and the user decides whether
      // to close it. Drafts are app-managed; one that's gone really is gone → drop.
      const session = all.sessions[sessionKeyFor(targetRoot)] ?? {
        tabs: [],
        activeId: null,
      };
      const restored = await rebuildTabs(session.tabs);

      // Append the migrated scratchpad (if any) as a fresh draft tab.
      if (migrated) {
        const seq = draftSeqRef.current + 1;
        draftSeqRef.current = seq;
        writeDraftSeq(seq);
        draftsMetaRef.current = { ...draftsMetaRef.current, [migrated.id]: { seq } };
        writeDraftsMeta(draftsMetaRef.current);
        restored.push({ id: migrated.id, kind: "draft", path: migrated.path, title: `Untitled-${seq}` });
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
        // separately) or reshuffle recents. A root that doesn't read right now
        // stays in the stored session (see sessionWorkspaceRoot) but isn't
        // shown, so an unmounted drive self-heals on a later launch.
        const exists = await invoke<boolean>("path_exists", {
          path: targetRoot,
        }).catch(() => false);
        if (exists) setWorkspaceRoot(targetRoot);
      }
      setReady(true);
    })();
  }, [openTab, setWorkspace, loadActiveContent, rebuildTabs]);

  // Report this window's content (workspace folder + open file paths + active
  // tab) to the backend whenever it changes, so folder opens and the in-app
  // "open in new window" actions can focus the window that already shows a path
  // instead of opening a duplicate, and so the backend's persisted session
  // (session.json) can respawn this window after a quit. (External file opens
  // always spawn a new window and never consult this registry.) The first
  // report also marks the app "ready", flipping external folder opens from the
  // cold-start pending-open path to window routing.
  useEffect(() => {
    const files = tabs.filter((t) => t.kind === "file").map((t) => t.path);
    const active = tabs.find((t) => t.id === activeId);
    void invoke("register_window_content", {
      folder: workspaceRoot,
      files,
      activeFile: active?.kind === "file" ? active.path : null,
    });
  }, [workspaceRoot, tabs, activeId]);

  useEffect(() => {
    const un = listen<ExternalChangePayload>("file-externally-changed", (e) => {
      // The split pane's document set changed externally: refresh that pane.
      // Its documents are disjoint from the active one's (a same-document
      // split has no record and falls through to the active branches below).
      const sd = splitRef.current?.doc;
      if (sd) {
        if (e.payload.path === sd.path) {
          void (async () => {
            try {
              const r = await invoke<ReadFileResult>("read_file", { path: sd.path });
              const cur = splitRef.current;
              if (!cur?.doc || cur.doc.path !== sd.path) return;
              captureCompanionScroll(); // the pane's editor remounts on new content
              companionMdRef.current = { md: "", baseline: "", baselined: false };
              bumpEditorSeq(cur.tabId);
              const htmlOnly = cur.doc.kind === "file" && isHtmlPath(cur.doc.path);
              const { meta } = await readEntityMeta(sd.path);
              const fm = parseFrontmatter(htmlOnly ? "" : r.contents);
              const full = htmlOnly ? "" : expandMarkdown(fm.body, meta.mthreads).md;
              setSplitState({
                ...cur,
                doc: {
                  ...cur.doc,
                  missing: false,
                  head: htmlOnly
                    ? cur.doc.head
                    : r.contents.slice(0, r.contents.length - fm.body.length),
                  props: fm.props,
                  opaque: fm.opaque,
                  contents: full,
                  snapshot: htmlOnly ? null : r.snapshot,
                  htmlContent: htmlOnly ? r.contents : cur.doc.htmlContent,
                  dirty: false,
                  conflict: null,
                },
              });
            } catch {
              // mid-rewrite; the next event covers it
            }
          })();
          return;
        }
        if (sd.htmlPath && e.payload.path === sd.htmlPath && sd.htmlPath !== sd.path) {
          void (async () => {
            try {
              const r = await invoke<ReadFileResult>("read_file", { path: sd.htmlPath! });
              const cur = splitRef.current;
              if (!cur?.doc || cur.doc.htmlPath !== sd.htmlPath) return;
              setSplitState({
                ...cur,
                doc: { ...cur.doc, htmlContent: cur.view === "html" ? r.contents : null },
              });
            } catch {
              // mid-rewrite; the next event covers it
            }
          })();
          return;
        }
        // The pane entity's META changed (sync delivered a teammate's thread
        // or reply): refresh the pane's threads and re-expand its markdown.
        if (e.payload.path === metaFileOf(sd.path)) {
          void (async () => {
            try {
              const { meta, metaExists } = await readEntityMeta(sd.path);
              const cur = splitRef.current;
              if (!cur?.doc || cur.doc.path !== sd.path) return;
              const htmlOnly = cur.doc.kind === "file" && isHtmlPath(cur.doc.path);
              let contents = cur.doc.contents;
              let ids = new Set<string>();
              if (!htmlOnly) {
                const r = await invoke<ReadFileResult>("read_file", { path: sd.path });
                const body = parseFrontmatter(r.contents).body;
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
              // mid-rewrite; the next event covers it
            }
          })();
          return;
        }
      }
      // The active entity's META changed (cloud sync delivered a teammate's
      // thread, another window wrote): fold it in — unless a local write is
      // pending, which would clobber a comment mid-typing; that write lands
      // in a moment and last-write-wins. Html threads land on the rail;
      // markdown thread bodies land IN PLACE on the open editor's marks
      // (three-way against the last disk state, so a reply typed here while
      // the change was in flight survives).
      const activeDocPath = pathRef.current ?? htmlPathRef.current;
      const metaPath = activeDocPath ? metaFileOf(activeDocPath) : null;
      if (metaPath !== null && e.payload.path === metaPath) {
        if (sidecarWriteTimerRef.current != null) return;
        void (async () => {
          try {
            const r = await invoke<ReadFileResult>("read_file", { path: metaPath });
            const meta = parseEntityMeta(r.contents);
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
            // mid-rewrite; the next event covers it
          }
        })();
        return;
      }
      // The active document's html rendition changed (e.g. regenerated by an
      // AI tool): re-render it. The markdown editor — and its dirty/conflict
      // flow — is untouched.
      if (e.payload.path === htmlPathRef.current) {
        void (async () => {
          try {
            const r = await invoke<ReadFileResult>("read_file", { path: e.payload.path });
            setHtmlContent(r.contents);
          } catch {
            // mid-rewrite; the next event covers it
          }
        })();
        return;
      }
      if (e.payload.path !== pathRef.current) return;
      // The active document changed on disk. A PROPERTIES-ONLY change — a
      // board dragged this card, a teammate set a field, another window's
      // header wrote a pill — leaves the body exactly as we last saved it, so
      // there is nothing to reload: adopt the new block, refresh the header,
      // take the new snapshot, and leave the editor and its caret alone. Only
      // a body change from outside still goes through reload / conflict.
      void (async () => {
        const target = e.payload.path;
        let r: ReadFileResult;
        try {
          r = await invoke<ReadFileResult>("read_file", { path: target });
        } catch {
          return; // mid-rewrite; the next event covers it
        }
        if (pathRef.current !== target) return;
        const fm = parseFrontmatter(r.contents);
        if (fm.body === lastDiskMdRef.current) {
          adoptFrontmatter(r.contents);
          snapshotRef.current = r.snapshot;
          return;
        }
        if (dirtyRef.current || conflictRef.current) {
          setConflict({ diskSnapshot: r.snapshot });
        } else {
          await reloadFromDisk();
        }
      })();
    });
    return () => {
      void un.then((f) => f());
    };
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


  // The one-time layout migration, workspace-wide: every entity the tree
  // knows normalizes to the hybrid layout (inline thread bodies → meta
  // records). Runs once per
  // workspace root in the main window; open tabs are skipped — they
  // migrate through their own load/save path. Interrupted or failed runs
  // leave the flag unset and retry on the next launch; re-running is safe
  // (migrateEntity is idempotent, and two devices migrating the same file
  // concurrently produce byte-identical writes).
  useEffect(() => {
    if (!ready || !workspaceRoot || !isMainWindow) return;
    const FLAG = `doklin:meta-migrated-v1:${workspaceRoot}`;
    try {
      if (localStorage.getItem(FLAG) === "1") return;
    } catch {
      // storage unavailable; sweep anyway (idempotent)
    }
    let cancelled = false;
    void (async () => {
      let tree: TreeNode;
      try {
        tree = await invoke<TreeNode>("list_md_tree", { path: workspaceRoot, all: false });
      } catch {
        return; // workspace unreadable right now; retried next launch
      }
      const files: string[] = [];
      const walk = (n: TreeNode) => {
        if (n.kind === "file") files.push(n.path);
        else for (const c of n.children) walk(c);
      };
      walk(tree);
      const open = new Set(tabsRef.current.map((t) => t.path));
      for (const f of files) {
        if (cancelled) return;
        if (open.has(f)) continue;
        try {
          await migrateEntityOnDisk(f);
        } catch (e) {
          console.error("meta migration failed", f, e);
          return; // flag stays unset; the next launch retries
        }
        // Yield between entities so a large workspace never janks the UI.
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled) return;
      try {
        localStorage.setItem(FLAG, "1");
      } catch {
        // storage unavailable — the sweep just reruns next launch
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, workspaceRoot, migrateEntityOnDisk]);

  // Robust quit flush: type-then-⌘Q within the autosave debounce would lose the
  // last keystrokes if the process exits before the fire-and-forget write_file
  // resolves. Intercept the close, await the pending write, then destroy the
  // window for real. A second close request while the flush is in flight is let
  // through untouched — the escape hatch if the write ever hangs.
  const closingRef = useRef(false);
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (event) => {
      if (closingRef.current) return;
      closingRef.current = true;
      event.preventDefault();
      try {
        await Promise.all([flushPendingAutosave(), flushSidecarWrite()]);
      } finally {
        void win.destroy();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [flushPendingAutosave, flushSidecarWrite]);

  // The close-requested flush above never fires on ⌘Q: the app menu's Quit
  // would invoke NSApp terminate:, which kills the process without any window
  // close events. So the backend replaces it with a custom Quit item (see
  // build_app_menu in lib.rs) that broadcasts this event instead; each window
  // flushes its pending autosave, acks, and the backend exits once every
  // window has acked (or its ~1s timeout fires).
  useEffect(() => {
    const un = listen("quit-flush-requested", async () => {
      try {
        await Promise.all([flushPendingAutosave(), flushSidecarWrite()]);
      } finally {
        void invoke("quit_flush_ack");
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [flushPendingAutosave, flushSidecarWrite]);

  // Mirror recent workspaces into the native File → "Open Recent Workspace"
  // menu (macOS). Fires on mount (restoring from localStorage) and on every
  // change. Folders only — files aren't workspaces. The backend menu is
  // app-global, so the last window to push wins, which is the freshest list.
  useEffect(() => {
    const folders = recents
      .filter((r) => r.kind === "folder")
      .map((r) => r.path);
    void invoke("set_recent_workspaces", { folders }).catch(() => {});
  }, [recents]);

  // "Clear Menu" in that native submenu emits this; wipe the shared recents (the
  // push effect above then blanks the menu). Broadcast to every window, each
  // clearing its own copy of the shared list.
  useEffect(() => {
    const un = listen("menu-clear-recent-workspaces", () => {
      setRecents([]);
      writeStoredRecents([]);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);


  const onMarkdownChange = useCallback(
    (md: string) => {
      currentMarkdownRef.current = md;
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
    [scheduleAutosave],
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

  // Move the active draft's content into the real file `chosen`: write it,
  // flip the tab in place, start watching the file, and
  // delete the draft. The final step of every Save As path — the in-app prompt
  // (workspace open) and the native dialog (no workspace) both end here.
  const promoteDraftTo = useCallback(async (active: Tab, chosen: string) => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const draftPath = active.path;
    // The chosen stem may already have an entity meta (an existing rendition
    // with comments): adopt it BEFORE the first write — writeToDisk composes
    // the meta from the app refs, and stale draft refs would clobber it. The
    // draft's own unanchored bodies ride along.
    const draftOrphans = mdOrphansRef.current;
    const draftTableWidths = tableWidthsRef.current;
    const sibling0 = htmlSiblingOf(chosen);
    const siblingExists0 = await invoke<boolean>("path_exists", { path: sibling0 }).catch(
      () => false,
    );
    await loadEntityMeta(chosen, currentMarkdownRef.current);
    if (draftOrphans.length > 0) {
      const have = new Set(mdOrphansRef.current.map((t) => t.id));
      const merged = [
        ...mdOrphansRef.current,
        ...draftOrphans.filter((t) => !have.has(t.id)),
      ];
      mdOrphansRef.current = merged;
      setMdOrphans(merged);
    }
    // The document travels with the draft, so its table widths do too — but
    // an existing entity at the target keeps its own (the same rule the
    // thread bodies above follow: adopt the destination, add what only the
    // draft had).
    if (draftTableWidths.length > 0) {
      const have = new Set(tableWidthsRef.current.map((t) => t.id));
      adoptTableWidths([
        ...tableWidthsRef.current,
        ...draftTableWidths.filter((t) => !have.has(t.id)),
      ]);
    }
    pathRef.current = chosen;
    snapshotRef.current = null; // Save As: overwrite the chosen target unconditionally
    lastDiskMdRef.current = "";
    await writeToDisk(chosen, currentMarkdownRef.current);
    // Flip the tab from draft to a real file (in place, keeping its position).
    const nextTabs = tabsRef.current.map((t) =>
      t.id === active.id ? { id: t.id, kind: "file" as const, path: chosen } : t,
    );
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    writeStoredSession(nextTabs, activeIdRef.current);
    // The rendition (probed before the write — its meta was adopted there)
    // enables the view toggle and joins the watch set.
    htmlPathRef.current = siblingExists0 ? sibling0 : null;
    setHasHtml(siblingExists0);
    await refreshWatchSet();
    // The content now lives in a real file; remove the draft + its metadata
    // (the backend clears the draft's own meta sidecar with it).
    try {
      await invoke("delete_draft", { path: draftPath });
    } catch (e) {
      console.error("delete_draft failed", e);
    }
    const { [active.id]: _removed, ...rest } = draftsMetaRef.current;
    draftsMetaRef.current = rest;
    writeDraftsMeta(rest);
    addRecent(chosen, "file");
    setTreeRefreshToken((t) => t + 1); // the new file may have landed in the workspace tree
  }, [
    writeToDisk,
    addRecent,
    loadEntityMeta,
    adoptTableWidths,
    refreshWatchSet,
  ]);

  const handleSave = useCallback(async () => {
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!active) return;
    if (active.kind === "file") {
      // Real files autosave continuously; ⌘S just flushes any pending write.
      flushPendingAutosave();
      return;
    }
    // Promote a draft to a real file (Save As). With a workspace open there is
    // no Finder navigation (VS Code-style): the destination is already decided
    // by context — the sidebar's selected folder, the selected file's folder,
    // or the workspace root — so the in-app prompt only asks for a name.
    const sels = sidebarSelectionRef.current;
    const sel = sels[sels.length - 1] ?? null; // primary selection
    const contextDir = sel
      ? sel.kind === "dir"
        ? sel.path
        : dirname(sel.path)
      : workspaceRoot;
    const fallback = active.title ?? "untitled";
    if (contextDir) {
      setSavePrompt({
        dir: contextDir,
        suggested: suggestDraftFileName(currentMarkdownRef.current, fallback),
      });
      return;
    }
    // No workspace: the native Save dialog is the only way to pick a location.
    const chosen = await saveDialog({
      title: "Save markdown",
      defaultPath: `${fallback}.md`,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!chosen) return;
    await promoteDraftTo(active, chosen);
  }, [flushPendingAutosave, promoteDraftTo, workspaceRoot]);

  // Commit the in-app Save As prompt. Returns an error message to show under
  // the input (bad name, collision), or null once the draft is promoted.
  const commitSavePrompt = useCallback(
    async (name: string): Promise<string | null> => {
      const sp = savePrompt;
      const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!sp || active?.kind !== "draft") {
        setSavePrompt(null); // the draft went away under the prompt; nothing to save
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
        exists = await invoke<boolean>("path_exists", { path: target });
      } catch {
        // If the check itself fails, fall through — the write will surface it.
      }
      if (exists) return `"${fileName}" already exists in this folder.`;
      setSavePrompt(null);
      await promoteDraftTo(active, target);
      return null;
    },
    [savePrompt, promoteDraftTo],
  );

  // The prompt's escape hatch: hand off to the native dialog (pre-filled with
  // the typed name) for saving somewhere outside the workspace.
  const browseSavePrompt = useCallback(
    async (name: string) => {
      const sp = savePrompt;
      const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
      setSavePrompt(null);
      if (!sp || active?.kind !== "draft") return;
      const base = name.trim() || sp.suggested;
      const fileName = MD_EXT_RE.test(base) ? base : `${base}.md`;
      const chosen = await saveDialog({
        title: "Save markdown",
        defaultPath: `${sp.dir}/${fileName}`,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!chosen) return;
      await promoteDraftTo(active, chosen);
    },
    [savePrompt, promoteDraftTo],
  );

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
      const chosen = await openDialog({ directory: true, multiple: false });
      if (typeof chosen === "string") {
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
  // the "you landed here" cue; Esc clears it (see the keydown handler).
  const openResult = useCallback(
    async (p: string, query: string) => {
      viewPrefsRef.current.set(p, "md"); // the match lives in the markdown
      await openTab(p, "file");
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
        if (active && !active.missing && docViewRef.current === "md") {
          setFindOpen(true);
          setFindFocusToken((t) => t + 1);
        }
      } else if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
      } else if ((k === "n" || k === "t") && !e.shiftKey) {
        // ⌘N and ⌘T both open a new untitled tab (⌘T is the macOS/VS Code
        // "new tab" convention; the tab-per-document model makes them the same).
        e.preventDefault();
        void newDraft();
      } else if (k === "w" && !e.shiftKey) {
        // ⌘W closes the active tab; with none left it closes the window (which
        // flushes autosave then destroys — see onCloseRequested). ⌘⇧W always
        // closes the window (native menu item). VS Code / Chrome convention.
        e.preventDefault();
        if (activeIdRef.current) void closeTab(activeIdRef.current);
        else void getCurrentWindow().close();
      } else if (k === "backspace") {
        // ⌘⌫ moves the selected entries to the Trash — but only when focus is
        // outside the editor, so it stays Milkdown's delete-to-line-start while
        // typing. (A sidebar-row handler can't be relied on: WebKit doesn't
        // focus buttons on click, so the row never holds focus to receive the
        // key.)
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.closest(".editor-wrap")) return;
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
            void deleteEntry(active.path, "file");
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
        void invoke("focus_next_window", { backward: e.shiftKey });
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
      } else if (k === "d" && e.shiftKey) {
        e.preventDefault();
        setDraftsOpen((v) => !v);
      } else if (k === "v" && e.shiftKey) {
        // ⌘⇧V: start/finish voice dictation (same as the titlebar mic).
        // Dictation types into the markdown editor; starting it from the html
        // view brings the editable version forward first. (In html view a
        // session is never active — entering the view stops it — so this
        // toggle can only be a start.)
        e.preventDefault();
        void (async () => {
          if (docViewRef.current === "html") await selectDocView("md");
          await dictationRef.current?.toggle();
        })();
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
    newDraft,
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
    const name = active ? tabTitle(active) : "Doklin";
    void getCurrentWindow().setTitle(`${active && dirty ? "● " : ""}${name}`);
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
  const showSidebar = workspaceRoot != null && sidebarOpen;
  const activeFilePath = activeTab?.kind === "file" ? activeTab.path : null;
  // Presence: tell the engines which document this window is editing (a
  // file, or nothing) so other devices see "editing Projects/plan.md". The
  // Rust side decides which connected workspace, if any, it concerns.
  useEffect(() => {
    void cloudSetActivity(activeFilePath).catch(() => {});
  }, [activeFilePath]);
  // Sync wrote files: the tree refreshes (open tabs already reload through
  // the file watcher). A merge that left a conflict copy, or a mass
  // deletion the engine is holding, becomes a notice carrying the one
  // action that matters.
  useEffect(() => {
    const uns = [
      onCloudApplied((e) => {
        if (e.root === sessionWorkspaceRoot) setTreeRefreshToken((t) => t + 1);
      }),
      // A restore wrote a document: the tree refreshes like sync's, and the
      // open editor reloads — the watcher stays quiet for our own writes.
      onVersionsApplied((e) => {
        if (e.root === sessionWorkspaceRoot) setTreeRefreshToken((t) => t + 1);
        if (pathRef.current && e.paths.includes(pathRef.current)) void reloadFromDisk();
      }),
      onCloudConflict((e) => {
        pushToast(`${e.by} and this Mac both changed ${e.path} — both versions are kept.`, {
          label: "Open the copy",
          run: () => void openTab(e.conflictPath, "file"),
        });
      }),
      onCloudPendingDeletes((e) => {
        setPendingDeletes(e);
        if (e.count > 0) {
          pushToast(
            `${e.count} files disappeared from ${basename(e.root)} — sync is holding the deletion.`,
            { label: "Review…", run: () => setCloudPanelOpen(true) },
          );
        }
      }),
    ];
    return () => {
      for (const un of uns) void un.then((f) => f()).catch(() => {});
    };
  }, [openTab, pushToast, reloadFromDisk]);
  // The version rail follows the document: switching tabs while it is open
  // shows the new one's history and drops the old one's preview.
  useEffect(() => {
    historyForRef.current = historyFor;
    historyTargetRef.current =
      activeTab && activeTab.kind !== "store" ? { path: activeTab.path, kind: activeTab.kind } : null;
    const open = historyTargetRef.current?.path ?? null;
    if (historyFor && open && open !== historyFor) {
      setHistoryFor(open);
      setVersionPreview(null);
      setHistoryToken((t) => t + 1);
    }
  }, [activeTab, historyFor]);

  const activeDraftPath = activeTab?.kind === "draft" ? activeTab.path : null;
  // A board tab: its path is a FOLDER, and the whole document machinery is
  // standing down for it (see loadActiveContent).
  const activeIsStore = activeTab?.kind === "store";
  // The sidebar's active row. A board's cards have no rows of their own, so
  // the board's row carries the highlight for whatever inside it is focused.
  const sidebarCurrentPath = activeIsStore ? activeTab.path : activeFilePath;
  // html-only documents render in the iframe alone; there is no markdown
  // version to edit, so the editor never mounts and the MD side is disabled.
  const activeIsHtmlDoc = activeTab?.kind === "file" && isHtmlPath(activeTab.path);
  const showHtmlView = docView === "html" && !activeMissing;
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
  // A board owns the whole pane: it has no second rendition to show beside
  // itself, and none of the split's document machinery applies to it.
  const canSplit = activeTab != null && !activeMissing && !activeIsStore;
  // The store the active note belongs to, if it belongs to one. A note in an
  // ordinary folder costs a single `path_exists` — the model checks for a
  // definition file before it reads anything else — so this is cheap to ask
  // for every note.
  const activeCardDir =
    activeFilePath && MD_EXT_RE.test(activeFilePath)
      ? dirname(activeFilePath)
      : null;
  const { state: cardStore, model: cardModel } = useStore(activeCardDir);
  const activeCardDef = activeCardDir && !activeIsStore ? cardStore.def : null;

  // A card peeked from a board: the panel beside it, not a tab. Held here
  // rather than inside the board so it survives a re-render of the board and
  // so the app's own rename / open-in-a-tab plumbing is one call away.
  const [peekCard, setPeekCard] = useState<string | null>(null);

  // No hooks below this line: a hook after the early return crashes React
  // ("rendered more hooks than during the previous render") the moment
  // `ready` flips, unmounting the whole app.
  if (!ready) return null;

  // Write one of the ACTIVE CARD's properties. Two writers can touch a card's
  // frontmatter — this header and any board showing it — and both go through
  // the same guarded splice in the backend, which keeps the body bytes on
  // disk exactly as they are. So a pill can't lose a keystroke the editor
  // hasn't flushed, and the loser of a race fails loudly instead of
  // clobbering.
  const setCardProperty = async (key: string, value: PropValue) => {
    const target = pathRef.current;
    if (!target) return;
    const next: CardProps = { ...cardPropsRef.current };
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    } else {
      next[key] = value;
    }
    const head = serializeFrontmatter(
      next,
      cardOpaqueRef.current,
      activeCardDef ? cardKeyOrder(activeCardDef) : [RANK_KEY],
    );
    cardPropsRef.current = next;
    setCardProps(next);
    cardHeadRef.current = head;
    try {
      const snap = await invoke<FileSnapshot>("write_frontmatter", {
        path: target,
        head,
        expected: snapshotRef.current,
      });
      if (pathRef.current === target) snapshotRef.current = snap;
    } catch (e) {
      // Someone got there first (a board drag here, a teammate over sync).
      // Disk wins — re-read the block instead of reloading the editor and
      // dropping the caret.
      console.error("property write failed", target, e);
      try {
        const r = await invoke<ReadFileResult>("read_file", { path: target });
        if (pathRef.current === target) {
          adoptFrontmatter(r.contents);
          snapshotRef.current = r.snapshot;
        }
      } catch {
        // unreadable right now; the watcher covers it
      }
    }
  };

  // Clicking a card PEEKS it — the panel beside the board, not a tab. A card
  // already open in a tab is the exception: the tab is the better answer and
  // it is already there, so we just go to it.
  const openCardFromStore = (target: string) => {
    if (tabsRef.current.some((t) => t.kind === "file" && t.path === target)) {
      void openTab(target, "file");
      return;
    }
    setPeekCard(target);
  };

  // A view, as a spreadsheet. StoreView builds the text (it knows which cards
  // and which columns the view shows); the app only knows where to put it.
  const exportStoreCsv = async (fileName: string, text: string) => {
    const chosen = await saveDialog({
      title: "Export as CSV",
      defaultPath: workspaceRoot ? `${workspaceRoot}/${fileName}` : fileName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!chosen) return;
    try {
      await invoke<FileSnapshot>("write_file", {
        path: chosen,
        contents: text,
        expected: null,
      });
    } catch (e) {
      console.error("csv export failed", chosen, e);
    }
  };

  const openBoard = (dirPath: string) => void openTab(dirPath, "store");

  // Turn a folder into a board: write the definition file, nothing else. Not
  // one note inside it is touched — they simply become cards with no status.
  const makeBoard = async (dirPath: string): Promise<string | null> => {
    try {
      await createStoreFile(dirPath, basename(dirPath));
      setTreeRefreshToken((t) => t + 1);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  // Every board in the workspace, for an embed's picker. Asked for on demand
  // (opening the picker) rather than kept in state: the sidebar already owns
  // the tree, and a board list that is one call old is a worse answer than
  // one that is one call fresh.
  const listStores = async (): Promise<StoreChoice[]> => {
    if (!workspaceRoot) return [];
    const tree = await invoke<TreeNode>("list_md_tree", {
      path: workspaceRoot,
      all: false,
    });
    const out: StoreChoice[] = [];
    const walk = (n: TreeNode) => {
      if (n.kind !== "dir") return;
      // A board is a leaf here — the backend hands one no children, and a
      // board inside a board is not a thing to offer.
      if (n.store) out.push({ path: n.path, name: n.name });
      else for (const c of n.children) walk(c);
    };
    walk(tree);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  };

  // "New board…" from inside an embed: a folder beside the note, plus its
  // definition file. Resolves to the folder so the embed can name it.
  const createStoreBeside = async (parentDir: string, name: string): Promise<string> => {
    const clean = name.trim().replace(/[/\\:]/g, "-");
    if (!clean) throw new Error("A name is required.");
    if (clean.startsWith(".")) throw new Error("Names can't start with a dot.");
    const path = `${parentDir}/${clean}`;
    await invoke("create_dir", { path });
    const err = await makeBoard(path);
    if (err) throw new Error(err);
    return path;
  };

  // What an embed inside a pane's note can reach. Built per pane
  // because a relative `store:` resolves against the note the embed is
  // written in — a draft has nowhere to resolve against, and says so.
  const kanbanHostFor = (tab: Tab | null): StoreEmbedHost | null => {
    if (!tab || tab.kind === "store") return null;
    const docPath = tab.kind === "file" ? tab.path : null;
    return {
      docPath,
      listStores,
      createStore: (name) =>
        docPath
          ? createStoreBeside(dirname(docPath), name)
          : // A draft has no folder of its own to put one beside. The picker
            // says so and disables the button; this is the backstop.
            Promise.reject(new Error("Save this note first.")),
      // A card peeks, here as on a board tab — clicking one in the middle of
      // your prose should not yank you out of the note you are reading.
      openCard: openCardFromStore,
      openCardTab: (p) => void openTab(p, "file"),
      renameCard: (from, to) => movePath(from, to, "file"),
      deleteCard: (p) => void deleteEntries([{ path: p, kind: "file" }]),
      revealCard: revealInFinder,
    };
  };

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

    // A same-document split pane on markdown is a read-only MIRROR of the
    // live editor (see the SplitPane comment).
    const isMirror = !focused && s != null && !s.doc && s.view === "md";
    const showBoardHere = paneTab?.kind === "store" && !paneMissing;
    const showEditorHere = showBoardHere
      ? false
      : focused
      ? activeTab != null && !activeMissing && !activeIsHtmlDoc
      : isMirror
        ? !activeMissing
        : doc != null &&
          s!.view === "md" &&
          !doc.missing &&
          !(doc.kind === "file" && isHtmlPath(doc.path));
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
    // autosaved over the newer text (§12.3.1).
    const previewHere =
      focused && versionPreview != null && historyFor != null && historyFor === paneTab?.path;

    const wrapClass = focused
      ? `editor-wrap ${showHtmlView ? "is-html-view" : ""} ${
          previewHere ? "is-version-preview" : ""
        } ${
          dictationUi.session !== "idle"
            ? `is-dictating ${dictationUi.gate === "listening" && dictationUi.session === "active" ? "is-listening" : "is-paused"}`
            : ""
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
            title={docDisplayTitle(paneTab)}
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
          {focused && findOpen && activeTab && !activeMissing && docView === "md" && (
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
          {showBoardHere && (
            // A store reads and writes its own folder; the pane just hosts it.
            // An unfocused pane shows the same DOM with writing off.
            <StoreView
              dir={paneTab.path}
              readOnly={!focused}
              onOpenCard={openCardFromStore}
              onOpenCardTab={(p) => void openTab(p, "file")}
              onRenameCard={(from, to) => movePath(from, to, "file")}
              onDeleteCard={(p) => void deleteEntries([{ path: p, kind: "file" }])}
              onRevealInFinder={revealInFinder}
              onExport={exportStoreCsv}
            />
          )}
          {focused && showEditorHere && paneTab?.kind === "file" && (
            // This note's properties, above it. Changing a pill writes the
            // frontmatter block and nothing else — the body never moves. Every
            // note gets a header: a card's rows are its board's fields, any
            // other note's are the keys its own file carries. A DRAFT gets
            // none — it has no file to write a property to yet.
            <PropertiesHeader
              def={activeCardDef}
              props={cardProps}
              order={cardOrder}
              opaqueCount={cardOpaque.length}
              onChange={setCardProperty}
              onAddField={
                activeCardDef && cardModel
                  ? (name, type) => void cardModel.addField(name, type)
                  : undefined
              }
              onRenameField={
                activeCardDef && cardModel
                  ? (id, name) => void cardModel.renameField(id, name)
                  : undefined
              }
              onRetypeField={
                activeCardDef && cardModel
                  ? (id, type) => void cardModel.retypeField(id, type)
                  : undefined
              }
              onDeleteField={
                activeCardDef && cardModel
                  ? (id) => void cardModel.deleteField(id)
                  : undefined
              }
              onAddOption={
                activeCardDef && cardModel
                  ? (field, name) => void cardModel.addOption(field, name)
                  : undefined
              }
            />
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
                  ? onMarkdownChange
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
              readOnly={!focused}
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
              // A ```kanban fence in this note becomes a board (kanbanEmbed.ts).
              kanban={kanbanHostFor(paneTab)}
            />
          )}
          {previewHere && historyFor && versionPreview && (
            <VersionPreview
              docPath={historyFor}
              root={versionPreview.root}
              version={versionPreview.version}
              newer={versionPreview.newer}
              onBack={() => setVersionPreview(null)}
              onRestore={(version, text) =>
                void restoreVersion(historyFor, versionPreview.root, version, text)
              }
              onOpenFile={(path) => void openTab(path, "file")}
              onError={(message) => pushToast(message)}
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
          {/* Only when NO document is open (the welcome screen). An open note —
              even an empty, unsaved draft — shows the bare editor, like an
              untitled tab in VS Code. */}
          {focused && !activeTab && (
            <ScratchEmptyState
              recents={recents}
              onNewNote={() => void newDraft()}
              onOpenFile={openFilePicker}
              onOpenFolder={openFolderPicker}
              onOpenRecent={openRecent}
            />
          )}
          {focused && (
            <DictationHud
              ui={dictationUi}
              onFlush={() => dictationRef.current?.flushPending()}
              onRevert={() => dictationRef.current?.revertPolish()}
              onStop={() => void dictationRef.current?.stop()}
            />
          )}
        </div>
      </section>
    );
  };

  return (
    <div
      className={`app ${showSidebar ? "with-sidebar" : ""} ${draftsOpen ? "show-drafts" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <div
        className="drag-strip"
        onMouseDown={(e) => {
          // Drive the window drag ourselves rather than through the passive
          // `data-tauri-drag-region` attribute: on macOS/WKWebView its injected
          // mousedown handler intermittently fails to start the native drag, and
          // a missed drag falls through to a normal content interaction — which
          // is why dragging the strip would sometimes just select text instead
          // of moving the window. Handling mousedown here (and preventing the
          // default) starts the drag reliably and never selects text. A
          // double-click zooms, matching a native title bar.
          if (e.button !== 0) return;
          e.preventDefault();
          const win = getCurrentWindow();
          if (e.detail === 2) void win.toggleMaximize();
          else void win.startDragging();
        }}
      />
      <div className="title-actions">
        <button
          className="title-toggle"
          onClick={() => setDraftsOpen((v) => !v)}
          title={draftsOpen ? "Hide drafts (⌘⇧D)" : "Show drafts (⌘⇧D)"}
          aria-label="Toggle drafts panel"
          aria-pressed={draftsOpen}
        >
          <DraftsIcon />
        </button>
        {workspaceRoot && (
          <button
            className="title-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Hide sidebar (⌘\\)" : "Show sidebar (⌘\\)"}
            aria-label="Toggle sidebar"
            aria-pressed={sidebarOpen}
          >
            <SidebarIcon />
          </button>
        )}
        {activeTab && !activeMissing && !activeIsHtmlDoc && (
          <button
            className={`title-toggle dictation-mic ${dictationUi.session !== "idle" ? "is-dictating" : ""}`}
            onClick={() =>
              // Dictation types into the markdown editor; from the html view,
              // bring the editable version forward first (a session is never
              // active there, so this is always a start).
              void (async () => {
                if (docViewRef.current === "html") await selectDocView("md");
                await dictationRef.current?.toggle();
              })()
            }
            title={
              dictationUi.session === "idle"
                ? "Start dictation (⌘⇧V)"
                : "Finish dictation (Esc)"
            }
            aria-label="Toggle dictation"
            aria-pressed={dictationUi.session !== "idle"}
          >
            <MicIcon />
          </button>
        )}
      </div>
      {zoomDiagramSvg && (
        <MermaidModal svg={zoomDiagramSvg} onClose={() => setZoomDiagramSvg(null)} />
      )}
      {peekCard && (
        <CardPeek
          path={peekCard}
          dir={dirname(peekCard)}
          onClose={() => setPeekCard(null)}
          onOpenTab={(p) => void openTab(p, "file")}
          // The panel follows the file it is looking at: movePath answers with
          // an error message, or null once the card has moved.
          onRename={async (from, to) => {
            const failed = await movePath(from, to, "file");
            if (!failed) setPeekCard(to);
            return failed;
          }}
          onWriteThreads={writeMdThreadsToMeta}
        />
      )}
      {draftsOpen && (
        <DraftsPanel
          drafts={draftRows}
          activePath={activeDraftPath}
          onOpen={(p) => void openTab(p, "draft")}
          onDiscard={(p, id) => void discardDraft(p, id)}
          onNewDraft={() => void newDraft()}
          onClose={() => setDraftsOpen(false)}
          onHistory={(path) => void openHistory(path, "draft")}
        />
      )}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        dirty={dirty}
        onSwitch={(id) => void switchTab(id)}
        onClose={(id) => void closeTab(id)}
        onNewDraft={() => void newDraft()}
        onReorder={reorderTabs}
        onDragOut={handleTabDragOut}
        onDragOutEnd={handleTabDragEnd}
        onDragOutCancel={handleTabDragCancel}
        onHistory={(path, kind) => void openHistory(path, kind)}
        trailing={
          activeTab && !activeMissing && !activeIsStore ? (
            <>
              {/* Publishing: a file inside the open workspace only — not a
                  draft, not a board, not a file from outside (§7.3). */}
              {activeTab.kind === "file" &&
                workspaceRoot &&
                relPathIn(workspaceRoot, activeTab.path) !== null && (
                  <PublishMenu
                    cloud={cloudForRoot}
                    absPath={activeTab.path}
                    rel={relPathIn(workspaceRoot, activeTab.path) ?? ""}
                    deviceName={deviceName}
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
      {showSidebar && workspaceRoot && sidebarMode === "files" && (
        <Sidebar
          root={workspaceRoot}
          cloud={cloudForRoot}
          currentPath={sidebarCurrentPath}
          selection={sidebarSelection}
          clipboard={fileClipboard}
          refreshToken={treeRefreshToken}
          onSelect={selectSidebarEntries}
          onOpenFile={(p) => void openTab(p, "file")}
          onOpenBoard={openBoard}
          onMakeBoard={makeBoard}
          onOpenFolder={openFolderPicker}
          onOpenFilePicker={openFilePicker}
          onRevealInFinder={revealInFinder}
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
          onPublishFolder={cloudForRoot ? (dir) => setPublishFolder(dir) : undefined}
          onStopPublishing={cloudForRoot ? stopPublishing : undefined}
          onCopyLink={(url) => void navigator.clipboard.writeText(url).catch(() => {})}
          onHistory={(path) => void openHistory(path)}
        />
      )}
      {conflict && (
        <ConflictBanner
          onReload={() => void reloadFromDisk()}
          onKeep={keepMyVersion}
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
          onCancel={() => setSavePrompt(null)}
        />
      )}
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
        {historyFor && (
          // A right rail beside the document, never over it (§12.3.1).
          <HistoryRail
            docPath={historyFor}
            selected={versionPreview?.version.ts ?? null}
            onSelect={previewVersion}
            onClose={closeHistory}
            reloadToken={historyToken}
            onError={(message) => pushToast(message)}
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
      {inspectorOpen && dictationConfig?.inspector && (
        <DictationInspector
          entries={inspectorEntries}
          onClear={() => setInspectorEntries([])}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      {dictationSetupOpen && dictationConfig && (
        <DictationSetup
          config={dictationConfig}
          onClose={() => setDictationSetupOpen(false)}
          onSaved={(next) => {
            setDictationConfig(next);
            void dictationRef.current?.reloadConfig();
          }}
        />
      )}
      {cloudPanelOpen && (
        <CloudPanel
          root={workspaceRoot}
          cloud={cloudForRoot}
          pendingDeletePaths={
            pendingDeletes && pendingDeletes.root === workspaceRoot ? pendingDeletes.paths : []
          }
          onClose={() => setCloudPanelOpen(false)}
          onConnect={() => {
            setCloudPanelOpen(false);
            setCloudSetup("connect");
          }}
          onJoin={() => {
            setCloudPanelOpen(false);
            setCloudSetup("join");
          }}
          onUpdateWorker={() => {
            setCloudPanelOpen(false);
            setWorkerUpdateOpen(true);
          }}
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
            void openTab(p, "file");
          }}
          onEditFolder={(dir) => {
            setPublishedOpen(false);
            setPublishFolder(dir);
          }}
        />
      )}
      {cloudSetup && (
        <CloudSetup
          mode={cloudSetup}
          root={workspaceRoot}
          onClose={() => setCloudSetup(null)}
          onConnected={(root, how) => {
            setCloudSetup(null);
            if (how === "join") void openWorkspace(root);
          }}
        />
      )}
      {workerUpdateOpen && cloudForRoot && (
        <WorkerUpdate
          cloud={cloudForRoot}
          onClose={() => setWorkerUpdateOpen(false)}
          onOpenExternal={openExternal}
        />
      )}
      <CloudToasts toasts={cloudToasts} onDismiss={dismissToast} />
      <Settings
        theme={theme}
        onChange={setTheme}
        recents={recents}
        onNewNote={() => void newDraft()}
        onOpenFile={openFilePicker}
        onOpenFolder={openFolderPicker}
        onOpenFileNewWindow={() => void openFileInNewWindow()}
        onOpenFolderNewWindow={() => void openFolderInNewWindow()}
        onOpenRecent={openRecent}
        canCopyWithComments={activeTab != null}
        onCopyWithComments={() => void copyWithComments()}
        onOpenDictationSetup={() => setDictationSetupOpen(true)}
        update={update}
        onOpenExternal={openExternal}
        onOpenCloud={() => setCloudPanelOpen(true)}
        cloudAttention={cloudNeedsAttention(cloudStatuses)}
      />
    </div>
  );
}

/* ---------- Subviews ---------- */

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
// typing, find, and dictation act.
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
      title={active ? "Close split (⌘⇧\\)" : "Split editor right (⌘⇧\\)"}
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
    <div
      className="saveas-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="saveas-panel" role="dialog" aria-label="Save note">
        <div className="saveas-title">
          Save to <span className="saveas-dir">{dirLabel}</span>
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
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
              e.stopPropagation(); // keep app-level shortcuts out of the prompt
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

function ConflictBanner({
  onReload,
  onKeep,
}: {
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner-text">
        This file has changed on disk.
      </span>
      <div className="conflict-banner-actions">
        <button className="conflict-banner-btn" onClick={onReload}>
          Reload from disk
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

function Settings({
  theme,
  onChange,
  recents,
  onNewNote,
  onOpenFile,
  onOpenFolder,
  onOpenFileNewWindow,
  onOpenFolderNewWindow,
  onOpenRecent,
  canCopyWithComments,
  onCopyWithComments,
  onOpenDictationSetup,
  update,
  onOpenExternal,
  onOpenCloud,
  cloudAttention,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
  recents: RecentEntry[];
  onNewNote: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenFileNewWindow: () => void;
  onOpenFolderNewWindow: () => void;
  onOpenRecent: (r: RecentEntry) => void;
  canCopyWithComments: boolean;
  onCopyWithComments: () => void;
  onOpenDictationSetup: () => void;
  update: UpdateController;
  onOpenExternal: (url: string) => void;
  // Open the Cloud panel; `cloudAttention` lights the item (and the gear)
  // when a connected domain's worker is behind this app.
  onOpenCloud: () => void;
  cloudAttention: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

  // One badge, two reasons: an app update, or a cloud worker behind it.
  const fabLabel = updateAvailable
    ? "Settings — update available"
    : cloudAttention
      ? "Settings — the cloud worker needs an update"
      : "Settings";

  return (
    <div ref={wrapRef} className="settings-wrap">
      {open && (
        <div className="settings-popover" role="menu" aria-label="Settings">
          <div className="settings-section-label">File</div>
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
            <span className="settings-option-kbd">⌘N</span>
          </button>
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
            <span className="settings-option-kbd">⌘O</span>
          </button>
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
            <span className="settings-option-kbd">⌘⇧O</span>
          </button>
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
            <span className="settings-option-kbd">⌘⌥O</span>
          </button>
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
            <span className="settings-option-kbd">⌘⌥⇧O</span>
          </button>
          {canCopyWithComments && (
            <>
              <div className="settings-divider" />
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
          <div className="settings-divider" />
          <div className="settings-section-label">Voice</div>
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onOpenDictationSetup();
            }}
          >
            <span className="settings-option-check" />
            <span className="settings-option-label">Dictation settings…</span>
          </button>
          <div className="settings-divider" />
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
          {recents.length > 0 && (
            <>
              <div className="settings-divider" />
              <div className="settings-section-label">Recent</div>
              <div className="settings-recents">
                {recents.map((r) => (
                  <button
                    key={r.path}
                    role="menuitem"
                    className="settings-option"
                    title={r.path}
                    onClick={() => {
                      setOpen(false);
                      onOpenRecent(r);
                    }}
                  >
                    <span className="settings-option-check">
                      {r.kind === "folder" ? <FolderIcon /> : <FileIcon />}
                    </span>
                    <span className="settings-option-label">{basename(r.path)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="settings-divider" />
          <div className="settings-section-label">Appearance</div>
          {THEMES.map((t) => (
            <button
              key={t}
              role="menuitemradio"
              aria-checked={theme === t}
              className={`settings-option ${theme === t ? "is-active" : ""}`}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <span className="settings-option-check">
                {theme === t ? <CheckIcon /> : null}
              </span>
              <span className="settings-option-label">{THEME_LABEL[t]}</span>
            </button>
          ))}
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
                setOpen(false);
                onOpenExternal(RELEASES_PAGE);
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">Download manually…</span>
            </button>
          )}
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

// The welcome screen shown when no document is open. (An open note, including
// an empty unsaved draft, shows the bare editor instead — no overlay.)
function ScratchEmptyState({
  recents,
  onNewNote,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
}: {
  recents: RecentEntry[];
  onNewNote: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecent: (r: RecentEntry) => void;
}) {
  return (
    <div className="scratch-empty" aria-hidden={false}>
      <div className="scratch-empty-card">
        <div className="scratch-empty-hint">No note open</div>
        <div className="scratch-empty-actions">
          <button className="scratch-empty-button" onClick={onNewNote}>
            <FileIcon />
            <span>New note</span>
            <span className="scratch-empty-kbd">⌘N</span>
          </button>
          <button className="scratch-empty-button" onClick={onOpenFile}>
            <FileIcon />
            <span>Open file</span>
            <span className="scratch-empty-kbd">⌘O</span>
          </button>
          <button className="scratch-empty-button" onClick={onOpenFolder}>
            <FolderIcon />
            <span>Open folder</span>
            <span className="scratch-empty-kbd">⌘⇧O</span>
          </button>
        </div>
        {recents.length > 0 && (
          <div className="scratch-empty-recents">
            <div className="scratch-empty-recents-label">Recent</div>
            {recents.map((r) => (
              <button
                key={r.path}
                className="scratch-empty-recent"
                title={r.path}
                onClick={() => onOpenRecent(r)}
              >
                {r.kind === "folder" ? <FolderIcon /> : <FileIcon />}
                <span className="scratch-empty-recent-name">{basename(r.path)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Icons ---------- */

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

function MicIcon() {
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
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function DraftsIcon() {
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
      <path d="M4 5h12M4 10h16M4 15h10M4 20h14" />
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
