import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import Editor, { type EditorHandle } from "./Editor";
import type { SearchInfo } from "./searchPlugin";
import Sidebar, { type SidebarSelection } from "./Sidebar";
import TabBar from "./TabBar";
import DraftsPanel from "./DraftsPanel";
import FindBar from "./FindBar";
import WorkspaceSearch from "./WorkspaceSearch";
import ShareMenu from "./ShareMenu";
import SharedPages from "./SharedPages";
import ShareSetup from "./ShareSetup";
import ShareFolder from "./ShareFolder";
import WorkerUpdate, { type OutdatedWorker } from "./WorkerUpdate";
import CloudSync from "./CloudSync";
import ConnectBackend from "./ConnectBackend";
import Backends from "./Backends";
import BackendTeardown from "./BackendTeardown";
import HistoryPanel from "./HistoryPanel";
import {
  reportSyncActivity,
  syncDevice,
  syncDisable,
  syncReloadConnections,
  syncSetShares,
  syncStatus,
  whoami,
  type SyncPresenceEvent,
  type SyncWorkspaceStatus,
} from "./sync";
import workerCode from "virtual:share-worker-code";
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
import {
  collectionManifestHash,
  contentHash,
  deletePage,
  deriveDocTitle,
  fetchWorkerVersion,
  forgetAccessCodes,
  generateShareId,
  getConnections,
  pageExists,
  parseWorkerVersion,
  pushCollection,
  pushOgImage,
  pushPage,
  readCollections,
  readShares,
  readWorkspaceConnectionMap,
  resolveConnection,
  saveConnections,
  shareUrl,
  writeCollections,
  writeShares,
  writeWorkspaceConnectionMap,
  type CollectionEntry,
  type CollectionItem,
  type PushedFingerprint,
  type ShareConnection,
  type ShareConnectionsState,
  type ShareEntry,
  type ShareParts,
} from "./share";
import { useUpdateCheck, RELEASES_PAGE, type UpdateController } from "./updater";

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

// The worker version this app build ships (parsed from the bundled worker
// source, so it can't drift from the code the setup/update flows hand out).
const BUNDLED_WORKER_VERSION = parseWorkerVersion(workerCode);

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
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

type DocView = "md" | "html";

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

type RecentEntry = { path: string; kind: "file" | "folder" };

// A tab is a lightweight descriptor; the document's content always lives on disk
// (drafts in app_data_dir/drafts/<id>.md, files at their real path) and autosaves
// there, so disk — not memory — is the source of truth across tabs.
type TabKind = "draft" | "file";
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
// Title used on the public share page / OG image: the tab title, minus the
// document extension for real files ("notes.md" shares as "notes").
const docShareTitle = (t: Tab) =>
  t.kind === "draft"
    ? t.title ?? "Untitled"
    : basename(t.path).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");
// Same, for a path with no open tab to derive it from (background pushes,
// folder-share manifests): the filename minus the document extension.
const pathShareTitle = (p: string) =>
  basename(p).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

// The innermost folder share containing `path`, if any — the collection a
// file's include/remove toggle binds to. With nested folder shares, the
// nearest one wins; a file belongs to at most one collection.
function nearestCollection(
  collections: Record<string, CollectionEntry>,
  path: string,
): CollectionEntry | null {
  let best: CollectionEntry | null = null;
  for (const c of Object.values(collections)) {
    if (path.startsWith(c.path + "/") && (!best || c.path.length > best.path.length)) {
      best = c;
    }
  }
  return best;
}
const SHARE_PUSH_DEBOUNCE_MS = 1500;
// Reconciliation (disk vs last-pushed fingerprints) runs at launch and on
// window focus, but at most this often — focus events come in bursts.
const SHARE_RECONCILE_MIN_MS = 15_000;

// What a push reads from disk: each rendition's content plus the snapshot of
// the file it came from, so the stored fingerprint describes exactly the bytes
// that were published.
type SharePartsOnDisk = ShareParts & {
  mdSnap: FileSnapshot | null;
  htmlSnap: FileSnapshot | null;
};

// Fingerprint freshly-pushed parts — what reconciliation later compares the
// disk against.
async function fingerprintParts(
  parts: SharePartsOnDisk,
): Promise<{ md: PushedFingerprint | null; html: PushedFingerprint | null }> {
  return {
    md:
      parts.markdown === null
        ? null
        : { snap: parts.mdSnap, hash: await contentHash(parts.markdown) },
    html:
      parts.html === null
        ? null
        : { snap: parts.htmlSnap, hash: await contentHash(parts.html) },
  };
}
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
type SessionEntry = { tabs: Tab[]; activeId: string | null };
type StoredSessions = { lastRoot: string | null; sessions: Record<string, SessionEntry> };
const NO_WORKSPACE_KEY = "<no-workspace>";
const sessionKeyFor = (root: string | null) => root ?? NO_WORKSPACE_KEY;

function sanitizeTabs(raw: unknown): Tab[] {
  return Array.isArray(raw)
    ? raw.filter(
        (t: unknown): t is Tab =>
          !!t &&
          typeof (t as Tab).id === "string" &&
          typeof (t as Tab).path === "string" &&
          ((t as Tab).kind === "draft" || (t as Tab).kind === "file"),
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
        const v = val as { tabs?: unknown; activeId?: unknown };
        sessions[key] = {
          tabs: sanitizeTabs(v?.tabs),
          activeId: typeof v?.activeId === "string" ? v.activeId : null,
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
    else all.sessions[key] = { tabs, activeId };
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
  // The sidebar's selected row (file or folder). Lives here — not in Sidebar —
  // because it is the creation context: saving a new draft defaults the save
  // dialog into the selected folder (or next to the selected file), falling
  // back to the workspace root. Mirrored in a ref for async readers.
  const [sidebarSelection, setSidebarSelection] = useState<SidebarSelection | null>(null);
  const sidebarSelectionRef = useRef<SidebarSelection | null>(null);
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
  // under it for a folder) so ⌘Z can reopen them after restoring;
  // `memberships` are the folder-share listings the delete removed, so undo
  // can put the pages back on their TOC.
  const deletedStackRef = useRef<
    {
      files: { path: string; trashPath: string }[];
      openPaths: string[];
      memberships: { dir: string; member: string }[];
    }[]
  >([]);
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

  // md/html rendition state for the ACTIVE document. `hasHtml` = an html
  // rendition exists on disk; `docView` = which version the editor area shows;
  // `htmlContent` = the rendition's markup (fed to a sandboxed iframe).
  // htmlPathRef mirrors the rendition path for async readers (watcher events,
  // share pushes). The markdown editor stays mounted (hidden) in html view so
  // toggling back keeps cursor, undo history, and unsaved state.
  const [docView, setDocViewState] = useState<DocView>("md");
  const docViewRef = useRef<DocView>("md");
  const [hasHtml, setHasHtml] = useState(false);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const htmlPathRef = useRef<string | null>(null);
  // Remembered view per document path (session-scoped): a tab you left on HTML
  // comes back on HTML; an html file opened explicitly starts on HTML.
  const viewPrefsRef = useRef<Map<string, DocView>>(new Map());

  const applyDocView = useCallback((v: DocView) => {
    docViewRef.current = v;
    setDocViewState(v);
  }, []);

  // In-app auto-update: quiet check on launch, plus manual re-check / one-click
  // install from the Settings menu. See updater.ts.
  const update = useUpdateCheck();

  // Public sharing: `shares` maps a document's absolute path to its live
  // share (see share.ts). Every successful disk write of a shared doc schedules
  // a debounced push of the same content to the remote page.
  const [shares, setShares] = useState<Record<string, ShareEntry>>(() => readShares());
  const sharesRef = useRef<Record<string, ShareEntry>>(shares);
  // The configured share backends. State mirrors share.ts's session cache for
  // rendering; callbacks read the cache directly (`await getConnections()`).
  const [shareConns, setShareConns] = useState<ShareConnectionsState>({
    connections: [],
    defaultId: null,
  });
  const [sharedPagesOpen, setSharedPagesOpen] = useState(false);
  const [shareSetupOpen, setShareSetupOpen] = useState(false);
  const sharePushTimersRef = useRef<Map<string, number>>(new Map());

  // Deployed-worker versions, probed via /api/meta once per connection set
  // (plus "Check again" in the update dialog). Drives the "update your share
  // worker" indication — the app carries the latest worker code but can't
  // deploy it itself (it holds only the share token, never Cloudflare account
  // credentials), so the dialog guides the redeploy instead. A failed probe
  // stays unknown: offline must not read as outdated.
  const [workerVersions, setWorkerVersions] = useState<Record<string, number>>({});
  // This device's role on each backend (owner vs member), from /api/auth/whoami.
  // Only an owner can redeploy — a member holds no Cloudflare credentials — so
  // the update dialog shows redeploy steps to owners and a "nudge the owner"
  // note to members. An unresolved probe (offline / revoked) leaves the entry
  // absent, which the dialog reads as owner: better to show the steps to an
  // actual owner than hide them.
  const [workerRoles, setWorkerRoles] = useState<Record<string, "owner" | "member">>({});
  // Connections whose role has been probed already (whether it resolved or is
  // in flight), so the outdated-role effect fires whoami at most once each.
  const roleProbedRef = useRef<Set<string>>(new Set());
  // The outdated list captured when the dialog opens, so a card can flip to
  // "Updated ✓" instead of vanishing the moment its recheck succeeds.
  const [workerUpdateList, setWorkerUpdateList] = useState<OutdatedWorker[] | null>(null);
  // Cloud sync: engine statuses (seeded once, then live via "sync-status"
  // events), other people's presence per workspace, and the dialogs. The
  // engines are app-wide (one per synced workspace, in the Rust process);
  // every window renders the same truth.
  const [syncStatuses, setSyncStatuses] = useState<SyncWorkspaceStatus[]>([]);
  const [syncPresence, setSyncPresence] = useState<
    Record<string, SyncPresenceEvent["devices"]>
  >({});
  const [syncDeviceName, setSyncDeviceName] = useState("This Mac");
  const [cloudSyncOpen, setCloudSyncOpen] = useState(false);
  const [connectBackendOpen, setConnectBackendOpen] = useState(false);
  const [backendsOpen, setBackendsOpen] = useState(false);
  // The connection whose guided teardown (erase + delete worker) is open.
  const [teardownConn, setTeardownConn] = useState<ShareConnection | null>(null);
  // Absolute path of the doc whose version history is open. null = closed.
  const [historyTarget, setHistoryTarget] = useState<string | null>(null);

  useEffect(() => {
    if (BUNDLED_WORKER_VERSION <= 0) return;
    let cancelled = false;
    for (const conn of shareConns.connections) {
      void fetchWorkerVersion(conn)
        .then((version) => {
          if (cancelled) return;
          setWorkerVersions((prev) =>
            prev[conn.id] === version ? prev : { ...prev, [conn.id]: version },
          );
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [shareConns.connections]);

  const recheckWorkerVersion = useCallback(async (conn: ShareConnection) => {
    const version = await fetchWorkerVersion(conn);
    setWorkerVersions((prev) =>
      prev[conn.id] === version ? prev : { ...prev, [conn.id]: version },
    );
    return version;
  }, []);

  const outdatedWorkers = useMemo<OutdatedWorker[]>(
    () =>
      BUNDLED_WORKER_VERSION > 0
        ? shareConns.connections.flatMap((conn) => {
            const version = workerVersions[conn.id];
            return typeof version === "number" && version < BUNDLED_WORKER_VERSION
              ? [{ conn, version, role: workerRoles[conn.id] }]
              : [];
          })
        : [],
    [shareConns.connections, workerVersions, workerRoles],
  );

  // Role (owner vs member) is only consumed by the update dialog, which only
  // opens for an outdated worker — so resolve it lazily, per outdated backend,
  // once each. In the steady state (every worker current) this makes no calls
  // at all; whoami costs one worker request (plus one R2 read for a member,
  // none for the owner), so even outdated it's negligible against the free
  // tier. The ref dedupes so a re-render doesn't re-probe; a failed probe is
  // dropped from it, letting a later outdated-set change retry.
  useEffect(() => {
    for (const { conn } of outdatedWorkers) {
      if (roleProbedRef.current.has(conn.id)) continue;
      roleProbedRef.current.add(conn.id);
      void whoami(conn)
        .then((me) =>
          setWorkerRoles((prev) =>
            prev[conn.id] === me.role ? prev : { ...prev, [conn.id]: me.role },
          ),
        )
        .catch(() => roleProbedRef.current.delete(conn.id));
    }
  }, [outdatedWorkers]);

  // The ref is the writable source of truth and updates synchronously (a React
  // state updater only runs at render time — too late for code that reads the
  // registry right after mutating it); state/localStorage follow.
  const updateShares = useCallback(
    (mut: (prev: Record<string, ShareEntry>) => Record<string, ShareEntry>) => {
      const next = mut(sharesRef.current);
      sharesRef.current = next;
      writeShares(next);
      setShares(next);
    },
    [],
  );

  // Folder shares: `collections` maps a directory's absolute path to its
  // published collection page (see share.ts). Members are ordinary entries in
  // `shares`; the collection carries only the membership list and pushes a
  // manifest — the public table of contents — whenever it changes.
  const [collections, setCollections] = useState<Record<string, CollectionEntry>>(() =>
    readCollections(),
  );
  const collectionsRef = useRef<Record<string, CollectionEntry>>(collections);
  const collectionPushTimersRef = useRef<Map<string, number>>(new Map());
  // shareFolderTarget = the directory whose share dialog (create or manage) is
  // open; null = closed.
  const [shareFolderTarget, setShareFolderTarget] = useState<string | null>(null);
  // A context-menu "Share…" on a tree file: the document opens first, then the
  // share popover pops once the ShareMenu for that path is mounted (it's keyed
  // by the active path, so this outlives the remount).
  const [pendingSharePopover, setPendingSharePopover] = useState<string | null>(null);

  // A pending popover request only survives while its document is the active
  // tab — navigating away (or a failed open) cancels it instead of leaving a
  // surprise popover for the next visit.
  useEffect(() => {
    if (!pendingSharePopover) return;
    const active = tabs.find((t) => t.id === activeId);
    if (!active || active.kind !== "file" || active.path !== pendingSharePopover) {
      setPendingSharePopover(null);
    }
  }, [pendingSharePopover, tabs, activeId]);

  const updateCollections = useCallback(
    (mut: (prev: Record<string, CollectionEntry>) => Record<string, CollectionEntry>) => {
      const next = mut(collectionsRef.current);
      collectionsRef.current = next;
      writeCollections(next);
      setCollections(next);
    },
    [],
  );

  /* ---------- Synced-workspace share mirroring, outbound half ----------
     For documents under a cloud-synced root, the workspace manifest is the
     shared truth of what's published where (everyone on the backend reads
     it, so nobody double-publishes and whoever edits a shared file keeps
     its public page fresh). Every local share mutation queues a matching
     manifest op here; the inbound half — the mirror effect further down —
     applies everyone else's ops to this device's registry. Shares published
     to a DIFFERENT backend than the workspace syncs to stay machine-local,
     exactly as before. */

  const syncStatusesRef = useRef<SyncWorkspaceStatus[]>([]);
  const syncDeviceNameRef = useRef("This Mac");

  // The synced workspace whose root contains `path`, if any.
  const syncWsForPath = useCallback(
    (path: string): SyncWorkspaceStatus | null =>
      syncStatusesRef.current.find(
        (s) => path === s.root || path.startsWith(s.root + "/"),
      ) ?? null,
    [],
  );

  // Queue the manifest op mirroring the CURRENT registry state of `absPath`:
  // share present → publish/update its record, absent → forget it. The
  // engine persists ops and carries them on its next won CAS, so this is
  // fire-and-forget even offline.
  const queueShareOp = useCallback(
    (absPath: string) => {
      const ws = syncWsForPath(absPath);
      if (!ws || absPath === ws.root) return;
      const rel = absPath.slice(ws.root.length + 1);
      const entry = sharesRef.current[absPath];
      if (entry && (entry.connectionId !== ws.connectionId || entry.kind !== "file")) return;
      void syncSetShares(ws.wsId, {
        [rel]: entry
          ? {
              id: entry.id,
              path: rel,
              cid: entry.collectionId ?? null,
              title: entry.title,
              by: syncDeviceNameRef.current,
              at: Date.now(),
            }
          : null,
      }).catch(() => {});
    },
    [syncWsForPath],
  );

  // Same, for folder shares. Pass `removedId` when the collection entry has
  // already been dropped from the registry (a stop) — the id can't be read
  // back then.
  const queueCollectionOp = useCallback(
    (dirPath: string, removedId?: string) => {
      const ws = syncWsForPath(dirPath);
      if (!ws) return;
      if (removedId) {
        void syncSetShares(ws.wsId, {}, { [removedId]: null }).catch(() => {});
        return;
      }
      const entry = collectionsRef.current[dirPath];
      if (!entry || entry.connectionId !== ws.connectionId) return;
      const rel = dirPath === ws.root ? "" : dirPath.slice(ws.root.length + 1);
      void syncSetShares(
        ws.wsId,
        {},
        {
          [entry.id]: {
            path: rel,
            title: entry.title,
            desc: entry.description ?? null,
            by: syncDeviceNameRef.current,
            at: Date.now(),
          },
        },
      ).catch(() => {});
    },
    [syncWsForPath],
  );

  // The workspace id a push should stamp its page with: set exactly when the
  // document lives in a synced workspace published to the SAME backend — the
  // worker then lets every member of the workspace manage the page.
  const wsStampFor = useCallback(
    (absPath: string, connectionId: string): string | null => {
      const ws = syncWsForPath(absPath);
      return ws && ws.connectionId === connectionId ? ws.wsId : null;
    },
    [syncWsForPath],
  );

  // Load the configured connections into render state.
  useEffect(() => {
    void getConnections().then(setShareConns);
  }, []);

  // Persist a connections change and refresh both the session cache and the
  // rendered state.
  const changeConnections = useCallback(
    async (mut: (prev: ShareConnectionsState) => ShareConnectionsState) => {
      const next = await saveConnections(mut(await getConnections()));
      setShareConns(next);
      return next;
    },
    [],
  );

  // Which connection an entry belongs to (share.ts's resolveConnection, fed
  // from the session cache). null = that connection has been removed; pushes
  // skip, stops forget locally.
  const connectionForEntry = useCallback(
    async (entry: { connectionId: string }): Promise<ShareConnection | null> =>
      resolveConnection(await getConnections(), entry),
    [],
  );

  // Per-workspace default connection: consulted before the global default
  // when a new share is created, written from the share popover's picker.
  const [workspaceConnMap, setWorkspaceConnMap] = useState<Record<string, string>>(() =>
    readWorkspaceConnectionMap(),
  );

  // Render-time mirror of connectionForEntry, driven by state instead of the
  // session cache so the UI re-resolves when connections change.
  const connectionForEntrySync = useCallback(
    (entry: { connectionId: string } | null): ShareConnection | null =>
      resolveConnection(shareConns, entry),
    [shareConns],
  );

  // Where a NEW share goes: the workspace's remembered connection if it still
  // exists, the global default otherwise.
  const workspaceKey = workspaceRoot ?? "";
  const mappedConn = workspaceConnMap[workspaceKey];
  const defaultConnectionId =
    mappedConn && shareConns.connections.some((c) => c.id === mappedConn)
      ? mappedConn
      : shareConns.defaultId;

  const rememberWorkspaceConnection = useCallback(
    (connectionId: string) => {
      setWorkspaceConnMap((prev) => {
        const next = { ...prev, [workspaceKey]: connectionId };
        writeWorkspaceConnectionMap(next);
        return next;
      });
    },
    [workspaceKey],
  );

  // Add or update a connection. An endpoint that matches an existing
  // connection updates it in place (same id — entries keep resolving), which
  // is what re-running the setup guide or rotating a token should do.
  const saveConnection = useCallback(
    async (conn: ShareConnection) => {
      await changeConnections((prev) => {
        const existing =
          prev.connections.find((c) => c.id === conn.id) ??
          prev.connections.find((c) => c.endpoint === conn.endpoint);
        const connections = existing
          ? prev.connections.map((c) =>
              c.id === existing.id ? { ...conn, id: existing.id } : c,
            )
          : [...prev.connections, conn];
        return { connections, defaultId: prev.defaultId ?? conn.id };
      });
      // Sync engines resolve their token from share.json at spawn — a rotated
      // or re-saved token needs them respawned to pick it up.
      void syncReloadConnections().catch(() => {});
    },
    [changeConnections],
  );

  // Stop this Mac's sync engines for every workspace on a connection. Local
  // folders stay; the backend keeps its copies. Used before removing a
  // connection (an engine whose connection vanished would respawn straight
  // into a dead "connection not found" error state) and before a teardown's
  // erase (an engine mustn't watch its workspace 404 out from under it).
  const disableSyncForConnection = useCallback(async (id: string) => {
    for (const s of syncStatusesRef.current.filter((s) => s.connectionId === id)) {
      await syncDisable(s.wsId).catch((e) => console.error("sync disable failed", e));
    }
  }, []);

  const removeConnection = useCallback(
    async (id: string) => {
      await disableSyncForConnection(id);
      await changeConnections((prev) => ({
        connections: prev.connections.filter((c) => c.id !== id),
        defaultId: prev.defaultId === id ? null : prev.defaultId,
      }));
      setWorkspaceConnMap((prev) => {
        const next = Object.fromEntries(
          Object.entries(prev).filter(([, v]) => v !== id),
        );
        writeWorkspaceConnectionMap(next);
        return next;
      });
      void syncReloadConnections().catch(() => {});
    },
    [changeConnections, disableSyncForConnection],
  );

  const makeDefaultConnection = useCallback(
    async (id: string) => {
      await changeConnections((prev) => ({ ...prev, defaultId: id }));
    },
    [changeConnections],
  );

  // How many local entries (pages + folder shares) live on a connection —
  // shown before removing one, since those pages stay live but lose their
  // update path from this Mac.
  const shareCountFor = useCallback(
    (connectionId: string) => {
      const owns = (e: { connectionId: string }) => e.connectionId === connectionId;
      return (
        Object.values(shares).filter(owns).length +
        Object.values(collections).filter(owns).length
      );
    },
    [shares, collections],
  );

  // What a manifest push carries: each member's page id, display title (the
  // share's title — the document's lead H1 when it has one, the filename
  // otherwise — so the TOC names pages the way the pages name themselves),
  // and folder-relative path (how the TOC groups into directories). Members
  // whose share is gone or that no longer live under the folder are simply
  // not listed.
  const collectionItemsFor = useCallback((entry: CollectionEntry): CollectionItem[] => {
    const items: CollectionItem[] = [];
    for (const m of entry.members) {
      const share = sharesRef.current[m];
      if (!share || !m.startsWith(entry.path + "/")) continue;
      items.push({
        id: share.id,
        title: share.title || pathShareTitle(m),
        path: m.slice(entry.path.length + 1),
      });
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return items;
  }, []);

  // Push a folder share's manifest if it differs from what's live (hash-
  // guarded, so redundant schedules collapse to nothing). A title change also
  // re-renders the OG image, same as pages.
  const pushCollectionNow = useCallback(
    async (dirPath: string) => {
      const entry = collectionsRef.current[dirPath];
      if (!entry) return;
      const config = await connectionForEntry(entry);
      if (!config) return;
      const items = collectionItemsFor(entry);
      const hash = await collectionManifestHash(entry.title, items, entry.description);
      if (hash === entry.pushedHash && entry.title === entry.pushedTitle) return;
      try {
        if (hash !== entry.pushedHash) {
          await pushCollection(
            config,
            entry.id,
            entry.title,
            items,
            entry.description,
            wsStampFor(entry.path, entry.connectionId),
          );
        }
        if (entry.title !== entry.pushedTitle) {
          await pushOgImage(config, entry.id, entry.title);
        }
        updateCollections((prev) =>
          prev[dirPath]
            ? {
                ...prev,
                [dirPath]: {
                  ...prev[dirPath],
                  updatedAt: Date.now(),
                  pushedHash: hash,
                  pushedTitle: entry.title,
                },
              }
            : prev,
        );
      } catch (e) {
        // Offline or the worker hiccuped; reconciliation retries via the hash.
        console.error("collection push failed", dirPath, e);
      }
    },
    [collectionItemsFor, updateCollections, connectionForEntry, wsStampFor],
  );

  const scheduleCollectionPush = useCallback(
    (dirPath: string) => {
      if (!collectionsRef.current[dirPath]) return;
      const timers = collectionPushTimersRef.current;
      const existing = timers.get(dirPath);
      if (existing != null) window.clearTimeout(existing);
      timers.set(
        dirPath,
        window.setTimeout(() => {
          timers.delete(dirPath);
          void pushCollectionNow(dirPath);
        }, SHARE_PUSH_DEBOUNCE_MS),
      );
    },
    [pushCollectionNow],
  );

  // Assemble what a share push carries: the markdown document and/or its html
  // rendition, always read fresh from DISK — the disk is what a share mirrors
  // (in-editor keystrokes reach it through autosave, which schedules its own
  // push). Reading and fingerprinting the same bytes keeps reconciliation
  // honest. Returns null when the primary file is unreadable (source gone; the
  // share stays until stopped explicitly).
  const readShareParts = useCallback(
    async (target: string): Promise<SharePartsOnDisk | null> => {
      if (isHtmlPath(target)) {
        try {
          const r = await invoke<ReadFileResult>("read_file", { path: target });
          return { markdown: null, mdSnap: null, html: r.contents, htmlSnap: r.snapshot };
        } catch {
          return null;
        }
      }
      let markdown: string;
      let mdSnap: FileSnapshot;
      try {
        const r = await invoke<ReadFileResult>("read_file", { path: target });
        markdown = r.contents;
        mdSnap = r.snapshot;
      } catch {
        return null;
      }
      let html: string | null = null;
      let htmlSnap: FileSnapshot | null = null;
      try {
        const sibling = htmlSiblingOf(target);
        if (await invoke<boolean>("path_exists", { path: sibling })) {
          const r = await invoke<ReadFileResult>("read_file", { path: sibling });
          html = r.contents;
          htmlSnap = r.snapshot;
        }
      } catch {
        // rendition unreadable right now; share the markdown alone
      }
      return { markdown, mdSnap, html, htmlSnap };
    },
    [],
  );

  // Push the current content of a shared doc to its remote page. Both
  // renditions travel together (see readShareParts), and so does the folder-
  // share back-reference (the public page's "back to the folder" crumb). A
  // title change (rename / draft promoted) also refreshes the OG image.
  const pushSharedNow = useCallback(
    async (target: string) => {
      const entry = sharesRef.current[target];
      if (!entry) return;
      const config = await connectionForEntry(entry);
      if (!config) return;
      const tab = tabsRef.current.find((t) => t.path === target);
      const collection = entry.collectionId
        ? (Object.values(collectionsRef.current).find((c) => c.id === entry.collectionId) ?? null)
        : null;
      const parts = await readShareParts(target);
      if (!parts) return; // source is gone; the share stays until stopped explicitly
      // The document names itself when it opens with an H1 (html-only pages:
      // their <title>); only untitled documents fall back to the file name.
      const title =
        deriveDocTitle(parts) ??
        (tab ? docShareTitle(tab) : entry.kind === "file" ? pathShareTitle(target) : entry.title);
      try {
        await pushPage(
          config,
          entry.id,
          title,
          parts,
          collection ? { id: collection.id, title: collection.title } : null,
          wsStampFor(target, entry.connectionId),
        );
        if (title !== entry.title) await pushOgImage(config, entry.id, title);
        const pushed = await fingerprintParts(parts);
        updateShares((prev) =>
          prev[target]
            ? { ...prev, [target]: { ...prev[target], title, updatedAt: Date.now(), pushed } }
            : prev,
        );
        // The folder TOC names this page by its share title — retitling the
        // document renames its row there too.
        if (title !== entry.title && collection) scheduleCollectionPush(collection.path);
      } catch (e) {
        // Offline or the worker hiccuped; the next save retries.
        console.error("share push failed", target, e);
      }
    },
    [updateShares, readShareParts, connectionForEntry, scheduleCollectionPush, wsStampFor],
  );

  const scheduleSharePush = useCallback(
    (target: string) => {
      if (!sharesRef.current[target]) return;
      const timers = sharePushTimersRef.current;
      const existing = timers.get(target);
      if (existing != null) window.clearTimeout(existing);
      timers.set(
        target,
        window.setTimeout(() => {
          timers.delete(target);
          void pushSharedNow(target);
        }, SHARE_PUSH_DEBOUNCE_MS),
      );
    },
    [pushSharedNow],
  );

  // Does `entry`'s local disk content differ from what was last pushed?
  // Stat-first: a matching snapshot rules a file unchanged without reading it;
  // otherwise read + hash decides (so a touched-but-identical file doesn't
  // push). A missing fingerprint (entry from before reconciliation existed)
  // counts as changed — one establishing push and it never re-fires.
  const shareNeedsPush = useCallback(async (entry: ShareEntry): Promise<boolean> => {
    const fp = entry.pushed;
    if (!fp) return true;
    const changed = async (
      path: string,
      pushed: PushedFingerprint | null,
    ): Promise<boolean> => {
      const snap = await invoke<FileSnapshot>("stat_file", { path }).catch(() => null);
      if (!snap) return pushed !== null; // gone locally; the published copy is stale
      if (!pushed) return true; // appeared since the last push
      if (
        pushed.snap &&
        pushed.snap.mtime_ms === snap.mtime_ms &&
        pushed.snap.size === snap.size
      ) {
        return false;
      }
      try {
        const r = await invoke<ReadFileResult>("read_file", { path });
        return (await contentHash(r.contents)) !== pushed.hash;
      } catch {
        return true; // vanished mid-check; the push path sorts it out
      }
    };
    if (isHtmlPath(entry.path)) return changed(entry.path, fp.html);
    if (await changed(entry.path, fp.md)) return true;
    return changed(htmlSiblingOf(entry.path), fp.html);
  }, []);

  // Catch up every share with edits made outside the app — a sync cycle
  // landing another device's changes is the common case now, an html
  // rendition regenerated by an AI tool or an externally rewritten markdown
  // the older ones. Event-driven pushes cover the active document; this pass
  // covers background tabs, unopened files, and changes made while the app
  // was closed. Runs in the main window only (one registry, one reconciler)
  // and at most once per SHARE_RECONCILE_MIN_MS — but a call inside the
  // window DEFERS to its end instead of dropping, so an edit that arrives
  // right after a pass (sync applying mid-throttle) still reaches the public
  // page without waiting for the next focus.
  const lastReconcileRef = useRef(0);
  const reconcileTimerRef = useRef<number | null>(null);
  const reconcileShares = useCallback(async () => {
    if (!isMainWindow) return;
    const entries = Object.values(sharesRef.current);
    const colEntries = Object.values(collectionsRef.current);
    if (entries.length === 0 && colEntries.length === 0) return;
    const now = Date.now();
    const wait = SHARE_RECONCILE_MIN_MS - (now - lastReconcileRef.current);
    if (wait > 0) {
      if (reconcileTimerRef.current == null) {
        reconcileTimerRef.current = window.setTimeout(() => {
          reconcileTimerRef.current = null;
          void reconcileShares();
        }, wait);
      }
      return;
    }
    lastReconcileRef.current = now;
    if ((await getConnections()).connections.length === 0) return;
    for (const entry of entries) {
      try {
        if (await shareNeedsPush(entry)) scheduleSharePush(entry.path);
      } catch (e) {
        console.error("share reconcile failed", entry.path, e);
      }
    }
    // A folder share's manifest is derived state (member ids, names, relative
    // paths); recompute it and re-push when it drifts from what's live — this
    // also catches a push that failed offline (the stored hash never updated).
    for (const c of colEntries) {
      try {
        const hash = await collectionManifestHash(c.title, collectionItemsFor(c), c.description);
        if (hash !== c.pushedHash || c.title !== c.pushedTitle) {
          scheduleCollectionPush(c.path);
        }
      } catch (e) {
        console.error("collection reconcile failed", c.path, e);
      }
    }
  }, [shareNeedsPush, scheduleSharePush, collectionItemsFor, scheduleCollectionPush]);

  // In-file find (⌘F): a bar over the editor that drives the ProseMirror search
  // plugin through the editor ref. `findInfo` mirrors the plugin's match count +
  // current index for the "3/12" readout.
  const editorRef = useRef<EditorHandle>(null);

  // Voice dictation. The controller (src/dictation.ts) owns the session; React
  // only mirrors its state for the HUD/inspector. Created once via ref so the
  // sidecar event listener never re-registers.
  const [dictationUi, setDictationUi] = useState<DictationUiState>(INITIAL_DICTATION_UI);
  const [dictationConfig, setDictationConfig] = useState<DictationConfig | null>(null);
  const [dictationSetupOpen, setDictationSetupOpen] = useState(false);
  const [inspectorEntries, setInspectorEntries] = useState<InspectorEntry[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const dictationRef = useRef<DictationController | null>(null);
  if (!dictationRef.current) {
    dictationRef.current = new DictationController({
      getEditor: () => editorRef.current,
      onState: (s) => setDictationUi(s),
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
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

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

  const writeToDisk = useCallback(async (target: string, contents: string) => {
    try {
      const newSnapshot = await invoke<FileSnapshot>("write_file", {
        path: target,
        contents,
        expected: snapshotRef.current,
      });
      // The remote mirror follows every successful disk write of a shared doc —
      // even one that resolves after switching tabs.
      scheduleSharePush(target);
      // Presence: an autosave landing is the definition of "actively editing"
      // — the sync engine heartbeats it to other members of the workspace.
      reportSyncActivity(target);
      // Same for the drafts panel: its previews come from disk, so re-list once
      // a draft's write has landed (including a flush resolving after a switch).
      if (tabsRef.current.some((t) => t.kind === "draft" && t.path === target)) {
        setDraftsRefreshToken((n) => n + 1);
      }
      // The active tab may have switched while this write was in flight (e.g. a
      // flush of the previous doc resolving after switching tabs). Only commit
      // baseline state if `target` is still the active path.
      if ((pathRef.current) !== target) return;
      snapshotRef.current = newSnapshot;
      lastSavedRef.current = contents;
      if (currentMarkdownRef.current === contents) setDirty(false);
    } catch (e) {
      if ((pathRef.current) !== target) return;
      if (isWriteError(e) && e.kind === "conflict") {
        setConflict({ diskSnapshot: e.current });
      } else {
        console.error("autosave failed", e);
      }
    }
  }, [scheduleSharePush]);

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

  // Snapshot the active tab's scroll offset — call this synchronously BEFORE
  // anything that remounts the editor (tab switch, external reload). In html
  // view the editor is hidden and the wrap doesn't scroll (the iframe scrolls
  // internally) — capturing would clobber the saved markdown offset with 0.
  const captureActiveScroll = useCallback(() => {
    const id = activeIdRef.current;
    if (!id || docViewRef.current === "html") return;
    const wrap = document.querySelector(".editor-wrap");
    if (wrap) scrollPositionsRef.current.set(id, wrap.scrollTop);
  }, []);

  // Restore the active tab's scroll offset. Runs from the editor's onReady; the
  // rAF re-apply covers Crepe finishing layout a frame after mount (a too-early
  // set gets clamped to 0 by a document that has no height yet).
  const restoreActiveScroll = useCallback(() => {
    const id = activeIdRef.current;
    const wrap = document.querySelector(".editor-wrap");
    if (!wrap) return;
    const saved = (id ? scrollPositionsRef.current.get(id) : 0) ?? 0;
    wrap.scrollTop = saved;
    requestAnimationFrame(() => {
      wrap.scrollTop = saved;
    });
  }, []);

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

  // Make `tab` the active document in the (single) editor: read its content from
  // disk, reset the per-doc refs, and remount the editor. Watch only real files.
  // A failed read doesn't drop the tab — it becomes a "ghost" (missing) tab with
  // no document loaded; a later activation retries and recovers automatically.
  const loadActiveContent = useCallback(async (tab: Tab) => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
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
      baselineCapturedRef.current = false;
      pathRef.current = null;
      currentMarkdownRef.current = "";
      lastSavedRef.current = "";
      snapshotRef.current = null;
      setInitialMarkdown("");
      setDirty(false);
      setConflict(null);
      htmlPathRef.current = null;
      setHtmlContent(null);
      setHasHtml(false);
      applyDocView("md");
      try {
        await invoke("unwatch_file");
      } catch {
        // ignore
      }
      return;
    }
    setTabMissing(tab.id, false); // the file is back (or was never gone)
    baselineCapturedRef.current = false;
    pathRef.current = htmlOnly ? null : tab.path;
    currentMarkdownRef.current = htmlOnly ? "" : contents;
    lastSavedRef.current = htmlOnly ? "" : contents;
    snapshotRef.current = htmlOnly ? null : snapshot;
    setInitialMarkdown(htmlOnly ? "" : contents);
    setDirty(false);
    setConflict(null);

    // Resolve the document's html rendition and which view to show. Markdown
    // files probe for a same-stem .html sibling; drafts are app-managed
    // markdown and never have one.
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
    setLoadKey((k) => k + 1);

    if (tab.kind === "file") {
      try {
        // Watch the document pair: the markdown for the edit/conflict flow,
        // the rendition so external regeneration re-renders (and re-pushes a
        // share) live.
        await invoke("watch_file", {
          path: tab.path,
          extra: htmlOnly ? null : htmlPath,
        });
      } catch (e) {
        console.error("watch_file failed", e);
      }
    } else {
      try {
        await invoke("unwatch_file"); // drafts aren't externally watched
      } catch {
        // ignore
      }
    }
  }, [setTabMissing, applyDocView]);

  // Re-materialize stored tab descriptors against disk: a readable tab keeps its
  // identity (a draft regains its Untitled-N title; a stale `missing` flag
  // clears), an unreadable FILE tab becomes a visible ghost, and an unreadable
  // draft (app-managed, so truly gone) is dropped. Shared by the startup restore
  // and in-app workspace switches.
  const rebuildTabs = useCallback(async (stored: Tab[]): Promise<Tab[]> => {
    const out: Tab[] = [];
    for (const t of stored) {
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
    try {
      await invoke("unwatch_file");
    } catch {
      // ignore
    }
    pathRef.current = null;
    currentMarkdownRef.current = "";
    lastSavedRef.current = "";
    snapshotRef.current = null;
    baselineCapturedRef.current = false;
    setInitialMarkdown("");
    setDirty(false);
    setConflict(null);
    htmlPathRef.current = null;
    setHtmlContent(null);
    setHasHtml(false);
    applyDocView("md");
  }, [applyDocView]);

  const switchTab = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      captureActiveScroll(); // remember where the outgoing doc was scrolled
      flushPendingAutosave(); // persist the outgoing doc before switching
      const target = tabsRef.current.find((t) => t.id === id);
      if (!target) return;
      activeIdRef.current = id;
      setActiveId(id);
      writeStoredSession(tabsRef.current, id);
      await loadActiveContent(target);
    },
    [captureActiveScroll, flushPendingAutosave, loadActiveContent],
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
      const nextTabs = [...tabsRef.current, tab];
      tabsRef.current = nextTabs;
      activeIdRef.current = tab.id;
      setTabs(nextTabs);
      setActiveId(tab.id);
      writeStoredSession(nextTabs, tab.id);
      await loadActiveContent(tab);
    },
    [captureActiveScroll, flushPendingAutosave, loadActiveContent],
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

  const selectSidebarEntry = useCallback((sel: SidebarSelection | null) => {
    sidebarSelectionRef.current = sel;
    setSidebarSelection(sel);
  }, []);

  const setWorkspace = useCallback((root: string) => {
    sessionWorkspaceRoot = root;
    setWorkspaceRoot(root);
    setSidebarOpen(true);
    selectSidebarEntry(null); // a selection from the previous workspace is meaningless
    addRecent(root, "folder");
    writeStoredSession(tabsRef.current, activeIdRef.current); // the root is part of the session
  }, [addRecent, selectSidebarEntry]);

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
      // returning to it later restores exactly these tabs.
      writeStoredSession(tabsRef.current, activeIdRef.current);
      // From here session writes target the incoming folder.
      sessionWorkspaceRoot = root;
      const session = readStoredSession(root);
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

  // Publish the active document at <endpoint>/<id> on the given connection
  // and record the share. Throws on failure so the share popover can surface
  // the error.
  const shareActiveDoc = useCallback(
    async (id: string, connectionId: string) => {
      const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!active) throw new Error("No document open.");
      const st = await getConnections();
      const config = st.connections.find((c) => c.id === connectionId);
      if (!config) throw new Error("Sharing is not configured.");
      // Pushes read the disk; land any keystrokes still inside the autosave
      // debounce so the first published copy is what the user is looking at.
      await flushPendingAutosave();
      const parts = await readShareParts(active.path);
      if (!parts) throw new Error("Could not read the document.");
      // Lead H1 (html-only: <title>) over file name — same rule as re-pushes.
      const title = deriveDocTitle(parts) ?? docShareTitle(active);
      await pushPage(config, id, title, parts, null, wsStampFor(active.path, config.id));
      try {
        await pushOgImage(config, id, title);
      } catch (e) {
        // The page is live either way; the link preview just won't have an image.
        console.error("og image upload failed", e);
      }
      const pushed = await fingerprintParts(parts);
      const now = Date.now();
      updateShares((prev) => ({
        ...prev,
        [active.path]: {
          id,
          path: active.path,
          kind: active.kind,
          title,
          sharedAt: now,
          updatedAt: now,
          pushed,
          connectionId: config.id,
        },
      }));
      // In a synced workspace: tell everyone else this document is published.
      queueShareOp(active.path);
    },
    [updateShares, readShareParts, flushPendingAutosave, wsStampFor, queueShareOp],
  );

  // Delete the remote page and forget the share (the local file is untouched).
  // A page that was included in a folder share also drops off that TOC. If the
  // connection it was published on has since been removed, the remote copy is
  // out of reach — forget the entry locally rather than trapping it forever.
  const stopSharing = useCallback(
    async (target: string) => {
      const entry = sharesRef.current[target];
      if (!entry) return;
      const config = await connectionForEntry(entry);
      if (config) {
        await deletePage(config, entry.id);
      } else {
        console.warn("share connection removed; forgetting entry locally", target);
      }
      const timers = sharePushTimersRef.current;
      const pending = timers.get(target);
      if (pending != null) {
        window.clearTimeout(pending);
        timers.delete(target);
      }
      // The page (and its access section) is gone remotely — the cached
      // plaintext codes are dead weight now.
      forgetAccessCodes(entry.connectionId, entry.id);
      updateShares((prev) => {
        const { [target]: _gone, ...rest } = prev;
        return rest;
      });
      for (const c of Object.values(collectionsRef.current)) {
        if (!c.members.includes(target)) continue;
        updateCollections((prev) =>
          prev[c.path]
            ? {
                ...prev,
                [c.path]: {
                  ...prev[c.path],
                  members: prev[c.path].members.filter((m) => m !== target),
                },
              }
            : prev,
        );
        scheduleCollectionPush(c.path);
      }
      // In a synced workspace: the entry is gone, so this queues a "forget".
      queueShareOp(target);
    },
    [updateShares, updateCollections, scheduleCollectionPush, connectionForEntry, queueShareOp],
  );

  // Publish a folder (or the whole workspace) as a collection page at
  // <endpoint>/<id> on the given connection. Nothing inside is shared by that
  // act alone — membership is explicit, so the TOC starts empty. Throws so
  // the dialog can surface the error (including the "worker needs
  // redeploying" case).
  const shareFolder = useCallback(
    async (dirPath: string, id: string, connectionId: string) => {
      const st = await getConnections();
      const config = st.connections.find((c) => c.id === connectionId);
      if (!config) throw new Error("Sharing is not configured.");
      const title = basename(dirPath);
      await pushCollection(config, id, title, [], null, wsStampFor(dirPath, config.id));
      try {
        await pushOgImage(config, id, title);
      } catch (e) {
        // The page is live either way; the link preview just won't have an image.
        console.error("og image upload failed", e);
      }
      const hash = await collectionManifestHash(title, [], null);
      const now = Date.now();
      updateCollections((prev) => ({
        ...prev,
        [dirPath]: {
          id,
          path: dirPath,
          title,
          members: [],
          sharedAt: now,
          updatedAt: now,
          pushedHash: hash,
          pushedTitle: title,
          connectionId: config.id,
        },
      }));
      queueCollectionOp(dirPath);
    },
    [updateCollections, wsStampFor, queueCollectionOp],
  );

  // Delete the collection page and forget the folder share. Member pages
  // either stay live as standalone shares (their public crumb disappears on
  // the next push) or stop too — the dialog asks which. A removed connection
  // forgets locally, like stopSharing.
  const stopSharingFolder = useCallback(
    async (dirPath: string, alsoStopPages: boolean) => {
      const entry = collectionsRef.current[dirPath];
      if (!entry) return;
      const config = await connectionForEntry(entry);
      if (config) {
        await deletePage(config, entry.id);
      } else {
        console.warn("share connection removed; forgetting folder share locally", dirPath);
      }
      const timers = collectionPushTimersRef.current;
      const pending = timers.get(dirPath);
      if (pending != null) {
        window.clearTimeout(pending);
        timers.delete(dirPath);
      }
      forgetAccessCodes(entry.connectionId, entry.id);
      const members = entry.members;
      updateCollections((prev) => {
        const { [dirPath]: _gone, ...rest } = prev;
        return rest;
      });
      // In a synced workspace: forget the collection everywhere. The engine
      // also releases every member share's listing bit manifest-side, so the
      // per-member ops below are only needed where the entry itself changes.
      queueCollectionOp(dirPath, entry.id);
      for (const m of members) {
        const share = sharesRef.current[m];
        if (!share || share.collectionId !== entry.id) continue;
        if (alsoStopPages) {
          try {
            await stopSharing(m);
          } catch (e) {
            console.error("stop sharing member failed", m, e);
          }
        } else {
          updateShares((prev) => {
            const cur = prev[m];
            if (!cur) return prev;
            const { collectionId: _c, ...rest } = cur;
            return { ...prev, [m]: rest };
          });
          scheduleSharePush(m);
        }
      }
    },
    [
      stopSharing,
      updateCollections,
      updateShares,
      scheduleSharePush,
      connectionForEntry,
      queueCollectionOp,
    ],
  );

  // Retitle a folder share and/or set the description shown under its public
  // TOC's title. A cleared title falls back to the folder name (and resumes
  // following renames, since it matches again). A title change also re-pushes
  // every member page — their "back to the folder" crumbs carry the title.
  const setCollectionMeta = useCallback(
    (dirPath: string, title: string, description: string) => {
      const entry = collectionsRef.current[dirPath];
      if (!entry) return;
      const nextTitle = title.trim().slice(0, 256) || basename(dirPath);
      const nextDesc = description.trim().slice(0, 500);
      if (nextTitle === entry.title && nextDesc === (entry.description ?? "")) return;
      updateCollections((prev) => {
        const cur = prev[dirPath];
        if (!cur) return prev;
        const { description: _gone, ...rest } = cur;
        return {
          ...prev,
          [dirPath]: {
            ...rest,
            title: nextTitle,
            ...(nextDesc ? { description: nextDesc } : {}),
          },
        };
      });
      scheduleCollectionPush(dirPath);
      queueCollectionOp(dirPath);
      if (nextTitle !== entry.title) {
        for (const m of entry.members) {
          if (sharesRef.current[m]?.collectionId === entry.id) scheduleSharePush(m);
        }
      }
    },
    [updateCollections, scheduleCollectionPush, scheduleSharePush, queueCollectionOp],
  );

  // Include a file in (or remove it from) a folder share. Including a not-yet-
  // shared file publishes it first — an ordinary page share with a generated
  // address — then lists it; including an already-shared page just lists it.
  // Removing only delists: the page share survives with its URL intact.
  const setCollectionMembership = useCallback(
    async (filePath: string, dirPath: string, include: boolean) => {
      const collection = collectionsRef.current[dirPath];
      if (!collection) return;
      // Members live on the collection's connection — the TOC links stay on
      // one domain.
      const config = await connectionForEntry(collection);
      if (!config) throw new Error("Sharing is not configured.");
      if (include) {
        if (!filePath.startsWith(collection.path + "/")) return;
        const existing = sharesRef.current[filePath];
        if (existing && existing.connectionId !== config.id) {
          throw new Error(
            "This page is shared on a different domain. A folder share can only list pages on its own domain — stop sharing the page first.",
          );
        }
        if (!existing) {
          // Land any in-flight keystrokes if this is the open document, so the
          // first published copy matches the screen.
          await flushPendingAutosave();
          const parts = await readShareParts(filePath);
          if (!parts) throw new Error("Could not read the document.");
          // Random ids virtually never collide, but a stale page under a
          // recycled id would be silently overwritten — probe once.
          let id = generateShareId();
          if (await pageExists(config, id).catch(() => false)) id = generateShareId();
          const title = deriveDocTitle(parts) ?? pathShareTitle(filePath);
          await pushPage(
            config,
            id,
            title,
            parts,
            { id: collection.id, title: collection.title },
            wsStampFor(filePath, config.id),
          );
          try {
            await pushOgImage(config, id, title);
          } catch (e) {
            console.error("og image upload failed", e);
          }
          const pushed = await fingerprintParts(parts);
          const now = Date.now();
          const created: ShareEntry = {
            id,
            path: filePath,
            kind: "file",
            title,
            sharedAt: now,
            updatedAt: now,
            pushed,
            collectionId: collection.id,
            connectionId: config.id,
          };
          updateShares((prev) => ({ ...prev, [filePath]: created }));
        } else {
          updateShares((prev) =>
            prev[filePath]
              ? {
                  ...prev,
                  [filePath]: { ...prev[filePath], collectionId: collection.id },
                }
              : prev,
          );
          // Re-push so the public page gains its folder crumb.
          scheduleSharePush(filePath);
        }
        // A page belongs to at most one folder share; moving it here delists
        // it from any other collection that still claims it.
        for (const other of Object.values(collectionsRef.current)) {
          if (other.path === dirPath || !other.members.includes(filePath)) continue;
          updateCollections((prev) =>
            prev[other.path]
              ? {
                  ...prev,
                  [other.path]: {
                    ...prev[other.path],
                    members: prev[other.path].members.filter((m) => m !== filePath),
                  },
                }
              : prev,
          );
          scheduleCollectionPush(other.path);
        }
        updateCollections((prev) => {
          const cur = prev[dirPath];
          if (!cur || cur.members.includes(filePath)) return prev;
          return { ...prev, [dirPath]: { ...cur, members: [...cur.members, filePath] } };
        });
      } else {
        updateCollections((prev) => {
          const cur = prev[dirPath];
          if (!cur || !cur.members.includes(filePath)) return prev;
          return {
            ...prev,
            [dirPath]: { ...cur, members: cur.members.filter((m) => m !== filePath) },
          };
        });
        if (sharesRef.current[filePath]?.collectionId === collection.id) {
          updateShares((prev) => {
            const cur = prev[filePath];
            if (!cur) return prev;
            const { collectionId: _c, ...rest } = cur;
            return { ...prev, [filePath]: rest };
          });
          // Re-push so the public page loses its folder crumb.
          scheduleSharePush(filePath);
        }
      }
      scheduleCollectionPush(dirPath);
      // In a synced workspace: the entry (and its listing bit) changed.
      queueShareOp(filePath);
    },
    [
      flushPendingAutosave,
      readShareParts,
      updateShares,
      updateCollections,
      scheduleSharePush,
      scheduleCollectionPush,
      connectionForEntry,
      wsStampFor,
      queueShareOp,
    ],
  );

  // "Share…" from the tree's context menu: sharing needs the user to pick an
  // address, and that form lives in the ShareMenu popover — so open the
  // document and pop the dialog rather than inventing a second share form.
  const shareFileFromTree = useCallback(
    async (target: string) => {
      await openTab(target, "file");
      setPendingSharePopover(target);
    },
    [openTab],
  );

  // Copy a share link from the tree without opening anything. The id belongs
  // to some registry entry; the link must use THAT entry's connection.
  const copyShareLink = useCallback(
    async (id: string) => {
      try {
        const entry =
          Object.values(sharesRef.current).find((e) => e.id === id) ??
          Object.values(collectionsRef.current).find((c) => c.id === id);
        const conn = entry ? await connectionForEntry(entry) : null;
        if (!conn) return;
        await navigator.clipboard.writeText(shareUrl(conn, id));
      } catch (e) {
        console.error("copy link failed", e);
      }
    },
    [connectionForEntry],
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
      baselineCapturedRef.current = false;
      setInitialMarkdown(result.contents);
      currentMarkdownRef.current = result.contents;
      lastSavedRef.current = result.contents;
      snapshotRef.current = result.snapshot;
      setDirty(false);
      setConflict(null);
      setLoadKey((k) => k + 1);
      // The document just adopted outside edits; a live share follows them
      // (covers both the watcher's auto-reload and the conflict banner's
      // "Reload from disk").
      if (sharesRef.current[target]) scheduleSharePush(target);
    } catch (e) {
      console.error("reload failed", e);
    }
  }, [captureActiveScroll, scheduleSharePush]);

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
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!tab) return;
      if (v === "html") {
        const htmlPath = htmlPathRef.current;
        if (!htmlPath) return; // no rendition — the toggle side is disabled
        captureActiveScroll(); // remember the markdown offset before hiding it
        // Dictation is an editing mode and the html view is read-only: end an
        // active session (its pending chunks flush) before hiding the editor.
        await dictationRef.current?.stop();
        flushPendingAutosave();
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
    [captureActiveScroll, flushPendingAutosave, applyDocView, restoreActiveScroll],
  );

  // Close a tab. Empty drafts are auto-discarded (nothing to recover); drafts
  // with content persist and stay reachable from the drafts list. Closing the
  // last tab leaves no document open (the welcome screen).
  const closeTab = useCallback(
    async (id: string, opts?: { discard?: boolean }) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
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
    [flushPendingAutosave, clearActiveDoc, loadActiveContent],
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
          t.kind === "file" &&
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
      // A markdown file's html rendition is trashed with it — they are one
      // document. Best-effort: the markdown is already in the Trash.
      if (kind === "file" && MD_EXT_RE.test(target)) {
        const sibling = htmlSiblingOf(target);
        const exists = await invoke<boolean>("path_exists", { path: sibling }).catch(
          () => false,
        );
        if (exists) {
          try {
            files.push({
              path: sibling,
              trashPath: await invoke<string>("trash_file", { path: sibling }),
            });
          } catch (e) {
            console.error("trash failed", e);
            alert(`Deleted ${basename(target)} but not its HTML version.\n${e}`);
          }
        }
      }
      // A deleted member drops off its folder share's TOC (the published page
      // itself stays live — delete ≠ unshare, same as standalone shares). A
      // deleted folder that IS a shared folder (or contains one) is left
      // frozen instead: its collection page stays live for cleanup from
      // Shared pages, and undo restores everything exactly as it was.
      const memberships: { dir: string; member: string }[] = [];
      for (const c of Object.values(collectionsRef.current)) {
        if (c.path === target || c.path.startsWith(target + "/")) continue;
        const gone = c.members.filter(
          (m) => m === target || (kind === "dir" && m.startsWith(target + "/")),
        );
        if (gone.length === 0) continue;
        for (const m of gone) memberships.push({ dir: c.path, member: m });
        updateCollections((prev) =>
          prev[c.path]
            ? {
                ...prev,
                [c.path]: {
                  ...prev[c.path],
                  members: prev[c.path].members.filter((m) => !gone.includes(m)),
                },
              }
            : prev,
        );
        scheduleCollectionPush(c.path);
      }
      deletedStackRef.current.push({
        files,
        openPaths: affected.map((t) => t.path),
        memberships,
      });
      const sel = sidebarSelectionRef.current;
      if (sel && (sel.path === target || sel.path.startsWith(target + "/"))) {
        selectSidebarEntry(null);
      }
      setTreeRefreshToken((t) => t + 1);
    },
    [closeTab, selectSidebarEntry, updateCollections, scheduleCollectionPush],
  );

  // Undo the most recent trash (⌘Z outside the editor): move the entry (and
  // any rendition trashed with it) back out of the Trash to its original path
  // and reopen the tabs the delete closed.
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
    // Restored members return to the folder shares that listed them (when
    // those shares still exist).
    const tocDirs = new Set<string>();
    for (const { dir, member } of entry.memberships) {
      updateCollections((prev) =>
        prev[dir] && !prev[dir].members.includes(member)
          ? { ...prev, [dir]: { ...prev[dir], members: [...prev[dir].members, member] } }
          : prev,
      );
      if (collectionsRef.current[dir]) tocDirs.add(dir);
    }
    for (const d of tocDirs) scheduleCollectionPush(d);
    for (const p of entry.openPaths) await openTab(p, "file");
  }, [openTab, updateCollections, scheduleCollectionPush]);

  // Move or rename a file/folder on disk (the sidebar's drag-and-drop and
  // inline Rename both end here), then repoint every piece of state that keys
  // off the old path: open tabs (including everything inside a moved folder),
  // the active document's autosave target and watcher, recents, shares, and
  // the sidebar selection. Returns an error message for the caller to surface
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
      try {
        await invoke("move_path", { from, to });
      } catch (e) {
        return String(e);
      }
      // A markdown file's html rendition moves/renames with it — the pair is
      // one document, and leaving the html behind would silently split it in
      // two. Best-effort: the markdown has already moved.
      if (kind === "file" && MD_EXT_RE.test(from) && MD_EXT_RE.test(to)) {
        const fromHtml = htmlSiblingOf(from);
        const exists = await invoke<boolean>("path_exists", { path: fromHtml }).catch(
          () => false,
        );
        if (exists) {
          try {
            await invoke("move_path", { from: fromHtml, to: htmlSiblingOf(to) });
          } catch (e) {
            window.alert(
              `Moved "${basename(from)}" but not its HTML version.\n${e}`,
            );
          }
        }
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
      if (pathRef.current) {
        const np = remap(pathRef.current);
        if (np !== pathRef.current) {
          pathRef.current = np;
          // The rendition rode along (moved above) — follow it.
          if (htmlPathRef.current) htmlPathRef.current = htmlSiblingOf(np);
          const active = nextTabs.find((t) => t.id === activeIdRef.current);
          if (active?.kind === "file") {
            try {
              await invoke("watch_file", { path: np, extra: htmlPathRef.current });
            } catch (e) {
              console.error("watch_file failed", e);
            }
          }
        }
      } else if (htmlPathRef.current) {
        // Active html-only document: keep the rendition path and watch current.
        const np = remap(htmlPathRef.current);
        if (np !== htmlPathRef.current) {
          htmlPathRef.current = np;
          try {
            await invoke("watch_file", { path: np });
          } catch (e) {
            console.error("watch_file failed", e);
          }
        }
      }

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

      // Shares are keyed by absolute path; re-key so a moved doc keeps
      // pushing, and re-push each renamed doc so the public page picks up its
      // new title (and, for folder-share members, a fresh crumb).
      const renamedShares: string[] = [];
      updateShares((prev) => {
        let changed = false;
        const next: Record<string, ShareEntry> = {};
        for (const [k, v] of Object.entries(prev)) {
          const nk = remap(k);
          if (nk !== k) {
            changed = true;
            renamedShares.push(nk);
          }
          next[nk] = nk === k ? v : { ...v, path: nk };
        }
        return changed ? next : prev;
      });

      // Folder shares are keyed by directory path too: re-key a renamed/moved
      // collection (its title follows the folder name while it still matches),
      // re-key member paths, and delist members that moved OUT of their folder
      // — their page shares stay live, they just leave the TOC. Anything that
      // changed re-pushes its manifest.
      {
        const prev = collectionsRef.current;
        const next: Record<string, CollectionEntry> = {};
        const tocPushes: string[] = [];
        const delisted: string[] = [];
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          const nk = remap(k);
          let entry = nk === k ? v : { ...v, path: nk, title: v.title === basename(k) ? basename(nk) : v.title };
          const moved = entry.members.map(remap);
          const kept = moved.filter((m) => m.startsWith(entry.path + "/"));
          for (const m of moved) {
            if (!m.startsWith(entry.path + "/")) delisted.push(m);
          }
          const membersChanged =
            kept.length !== entry.members.length ||
            kept.some((m, i) => m !== entry.members[i]);
          if (membersChanged) entry = { ...entry, members: kept };
          if (nk !== k || membersChanged) {
            changed = true;
            tocPushes.push(nk);
          }
          next[nk] = entry;
        }
        if (changed) {
          updateCollections(() => next);
          for (const m of delisted) {
            if (!sharesRef.current[m]?.collectionId) continue;
            updateShares((p) => {
              const cur = p[m];
              if (!cur) return p;
              const { collectionId: _c, ...rest } = cur;
              return { ...p, [m]: rest };
            });
            if (!renamedShares.includes(m)) renamedShares.push(m); // drop the crumb
          }
          for (const d of tocPushes) {
            scheduleCollectionPush(d);
            // Synced workspaces track folder shares by directory path, and
            // directories aren't files — a moved folder needs telling.
            queueCollectionOp(d);
          }
        }
      }
      // File shares need no rename ops (the engine follows moves by file
      // identity), but a delisted member's entry changed — and re-sending a
      // renamed one is a harmless refresh.
      for (const p of renamedShares) {
        scheduleSharePush(p);
        queueShareOp(p);
      }

      const sel = sidebarSelectionRef.current;
      if (sel) {
        const np = remap(sel.path);
        if (np !== sel.path) selectSidebarEntry({ ...sel, path: np });
      }

      setTreeRefreshToken((t) => t + 1);
      return null;
    },
    [
      flushPendingAutosave,
      updateShares,
      updateCollections,
      scheduleSharePush,
      scheduleCollectionPush,
      selectSidebarEntry,
      queueShareOp,
      queueCollectionOp,
    ],
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
      // The active document's html rendition changed (e.g. regenerated by an
      // AI tool): re-render it and mirror a live share. The markdown editor —
      // and its dirty/conflict flow — is untouched.
      if (e.payload.path === htmlPathRef.current) {
        void (async () => {
          try {
            const r = await invoke<ReadFileResult>("read_file", { path: e.payload.path });
            setHtmlContent(r.contents);
          } catch {
            return; // mid-rewrite; the next event covers it
          }
          const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
          if (active && sharesRef.current[active.path]) scheduleSharePush(active.path);
        })();
        return;
      }
      if (e.payload.path !== pathRef.current) return;
      if (dirtyRef.current || conflictRef.current) {
        setConflict({ diskSnapshot: e.payload.snapshot });
      } else {
        void reloadFromDisk();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [reloadFromDisk, scheduleSharePush]);

  // Reconcile shares with edits made outside the app at the moments staleness
  // becomes observable: once after launch/restore, then whenever the window
  // regains focus (throttled inside reconcileShares). The watcher covers the
  // active document in real time; this covers everything else.
  useEffect(() => {
    if (!ready) return;
    void reconcileShares();
    const onFocus = () => void reconcileShares();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, reconcileShares]);

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
        await flushPendingAutosave();
      } finally {
        void win.destroy();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [flushPendingAutosave]);

  // The close-requested flush above never fires on ⌘Q: the app menu's Quit
  // would invoke NSApp terminate:, which kills the process without any window
  // close events. So the backend replaces it with a custom Quit item (see
  // build_app_menu in lib.rs) that broadcasts this event instead; each window
  // flushes its pending autosave, acks, and the backend exits once every
  // window has acked (or its ~1s timeout fires).
  useEffect(() => {
    const un = listen("quit-flush-requested", async () => {
      try {
        await flushPendingAutosave();
      } finally {
        void invoke("quit_flush_ack");
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [flushPendingAutosave]);

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

  // Cloud sync wiring: seed the engine statuses once, then track events.
  useEffect(() => {
    void syncStatus()
      .then(setSyncStatuses)
      .catch(() => {}); // engine not ready yet — the first event seeds it
    void syncDevice()
      .then((d) => {
        setSyncDeviceName(d.name);
        syncDeviceNameRef.current = d.name;
      })
      .catch(() => {});
    const unStatus = listen<SyncWorkspaceStatus>("sync-status", (e) => {
      const s = e.payload;
      setSyncStatuses((prev) => {
        const rest = prev.filter((x) => x.wsId !== s.wsId);
        return s.phase === "removed"
          ? rest
          : [...rest, s].sort((a, b) => a.name.localeCompare(b.name));
      });
    });
    const unPresence = listen<SyncPresenceEvent>("sync-presence", (e) => {
      setSyncPresence((prev) => ({ ...prev, [e.payload.wsId]: e.payload.devices }));
    });
    return () => {
      void unStatus.then((f) => f());
      void unPresence.then((f) => f());
    };
  }, []);

  // Sync wrote/moved/removed workspace files: re-list the tree, and re-push
  // any public pages those files back — this machine holds the share
  // registry, so an edit arriving FROM another device reaches the public
  // copy through here, focus or not. (The open document itself reloads
  // through the existing file watcher.)
  useEffect(() => {
    const un = listen("sync-applied", () => {
      setTreeRefreshToken((t) => t + 1);
      void reconcileShares();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [reconcileShares]);

  // Callbacks (share hooks, the mirror below) read statuses through the ref;
  // render-time consumers use the state. Keep them in lockstep.
  useEffect(() => {
    syncStatusesRef.current = syncStatuses;
  }, [syncStatuses]);

  // The current workspace's sync status (null = not a synced workspace), and
  // other people's presence keyed by absolute path for the sidebar.
  const syncedWorkspace = useMemo(
    () => syncStatuses.find((s) => workspaceRoot != null && s.root === workspaceRoot) ?? null,
    [syncStatuses, workspaceRoot],
  );
  const presenceByPath = useMemo(() => {
    if (!syncedWorkspace || !workspaceRoot) return {};
    const out: Record<string, string> = {};
    for (const d of syncPresence[syncedWorkspace.wsId] ?? []) {
      if (d.path) out[`${workspaceRoot}/${d.path}`] = d.name;
    }
    return out;
  }, [syncPresence, syncedWorkspace, workspaceRoot]);

  /* ---------- Synced-workspace share mirroring, inbound half ----------
     The workspace manifest carries the share registry for documents under a
     synced root (the outbound helpers near updateShares put it there). This
     applies it: entries appear, re-point, and vanish here as people share,
     move, and stop things on other machines — which is what makes the whole
     feature: the sidebar badge and ShareMenu show "already shared" instead
     of minting a duplicate page, and mirrored entries land WITHOUT push
     fingerprints, so the ordinary reconcile pass establishes each with one
     push. That last part is the freshness guarantee — whoever edits a
     shared file re-publishes it from their own machine, no waiting for the
     original sharer to come online.

     Disambiguation rules, per entry, matched by page id:
       in the manifest            → mirror its fields, mark wsSynced
       absent + wsSynced          → someone unshared it remotely: drop the
                                    entry (only while the engine is settled —
                                    a mid-sync snapshot isn't evidence)
       absent + never wsSynced    → predates sync here: publish it (backfill)
     Path disagreements are arbitrated by the disk: local file still present
     means our rename hasn't pushed yet (keep), gone means theirs applied
     (adopt). Entries shared to a DIFFERENT backend than the workspace's are
     out of scope entirely and stay machine-local. */
  const mirrorBusyRef = useRef(false);
  // Backfills already queued this session (wsId + "\n" + path). Ops are
  // idempotent, but the fingerprint strip that rides along must fire once —
  // a share sync can never carry (an over-cap file, say) would otherwise
  // strip-and-republish on every status event.
  const backfilledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isMainWindow || syncStatuses.length === 0) return;
    if (mirrorBusyRef.current) return; // the next status event re-runs us
    let cancelled = false;
    mirrorBusyRef.current = true;
    (async () => {
      let touched = false;
      for (const ws of syncStatuses) {
        if (ws.phase === "removed") continue;
        const inRoot = (p: string) => p.startsWith(ws.root + "/");
        const absOf = (rel: string) => (rel === "" ? ws.root : `${ws.root}/${rel}`);
        const settled = ws.phase === "idle" || ws.phase === "pending-deletes";

        const effShares = new Map(ws.shares.map((s) => [s.id, s]));
        const effCols = new Map(ws.collections.map((c) => [c.id, c]));
        const localShares = Object.values(sharesRef.current).filter(
          (e) => e.kind === "file" && inRoot(e.path) && e.connectionId === ws.connectionId,
        );
        const localCols = Object.values(collectionsRef.current).filter(
          (e) => (e.path === ws.root || inRoot(e.path)) && e.connectionId === ws.connectionId,
        );

        // Probe the disk once per path disagreement, before the sync pass.
        const gone = new Map<string, boolean>();
        const probe = async (abs: string) => {
          if (!gone.has(abs)) {
            const exists = await invoke<boolean>("path_exists", { path: abs }).catch(
              () => true,
            );
            gone.set(abs, !exists);
          }
        };
        for (const e of localShares) {
          const eff = effShares.get(e.id);
          if (eff && absOf(eff.path) !== e.path) await probe(e.path);
        }
        for (const c of localCols) {
          const eff = effCols.get(c.id);
          if (eff && absOf(eff.path) !== c.path) await probe(c.path);
        }
        if (cancelled) return;

        // Registry deltas, assembled synchronously against fresh refs.
        const nextShares: Record<string, ShareEntry> = { ...sharesRef.current };
        let sharesChanged = false;
        const backfillShares: string[] = [];
        const seenIds = new Set<string>();
        for (const e of localShares) {
          const cur = nextShares[e.path];
          if (!cur || cur.id !== e.id) continue; // mutated underneath us — next pass
          seenIds.add(e.id);
          const eff = effShares.get(e.id);
          if (!eff) {
            if (cur.wsSynced && settled) {
              delete nextShares[e.path];
              sharesChanged = true;
            } else if (!cur.wsSynced && !backfilledRef.current.has(`${ws.wsId}\n${e.path}`)) {
              backfilledRef.current.add(`${ws.wsId}\n${e.path}`);
              backfillShares.push(e.path);
              // A page published before this folder was synced carries no
              // workspace stamp on the worker yet — only a push applies it.
              // Strip the fingerprints so reconciliation re-establishes the
              // page (one push, now stamped) from this device, the one that
              // can already touch it.
              if (cur.pushed) {
                const { pushed: _establish, ...rest } = cur;
                nextShares[e.path] = rest;
                sharesChanged = true;
              }
            }
            continue;
          }
          let entry = cur;
          const effAbs = absOf(eff.path);
          if (effAbs !== entry.path && gone.get(entry.path)) {
            delete nextShares[entry.path];
            entry = { ...entry, path: effAbs };
          }
          const cid = eff.cid ?? undefined;
          if (entry.collectionId !== cid || !entry.wsSynced) {
            entry = { ...entry, wsSynced: true };
            if (cid) entry.collectionId = cid;
            else delete entry.collectionId;
          }
          if (entry !== cur) {
            nextShares[entry.path] = entry;
            sharesChanged = true;
          }
        }
        for (const eff of ws.shares) {
          // Dead shares (file deleted, page kept) grow no new entries; the
          // machines that already list them keep theirs, same as a local
          // delete has always behaved.
          if (!eff.alive || seenIds.has(eff.id)) continue;
          const abs = absOf(eff.path);
          if (nextShares[abs]) continue; // occupied by another share — local wins
          const at = eff.at || Date.now();
          nextShares[abs] = {
            id: eff.id,
            path: abs,
            kind: "file",
            title: eff.title || pathShareTitle(abs),
            sharedAt: at,
            updatedAt: at,
            ...(eff.cid ? { collectionId: eff.cid } : {}),
            connectionId: ws.connectionId,
            ...(eff.by ? { sharedBy: eff.by } : {}),
            wsSynced: true,
          };
          sharesChanged = true;
        }

        // Collections second: their membership derives from the share
        // entries as just mirrored (cid pointers), so the lists can't drift.
        const membersFor = (cid: string) =>
          Object.values(nextShares)
            .filter(
              (e) =>
                e.collectionId === cid &&
                inRoot(e.path) &&
                e.connectionId === ws.connectionId &&
                effShares.get(e.id)?.alive !== false,
            )
            .map((e) => e.path)
            .sort();
        const nextCols: Record<string, CollectionEntry> = { ...collectionsRef.current };
        let colsChanged = false;
        const backfillCols: string[] = [];
        const seenColIds = new Set<string>();
        for (const c of localCols) {
          const cur = nextCols[c.path];
          if (!cur || cur.id !== c.id) continue;
          seenColIds.add(c.id);
          const eff = effCols.get(c.id);
          if (!eff) {
            if (cur.wsSynced && settled) {
              delete nextCols[c.path];
              colsChanged = true;
            } else if (!cur.wsSynced && !backfilledRef.current.has(`${ws.wsId}\n${c.path}`)) {
              backfilledRef.current.add(`${ws.wsId}\n${c.path}`);
              backfillCols.push(c.path);
              // Same stamping story as file shares above; pushedTitle stays,
              // so the establishing push skips the redundant OG render.
              if (cur.pushedHash != null) {
                const { pushedHash: _establish, ...rest } = cur;
                nextCols[c.path] = rest;
                colsChanged = true;
              }
            }
            continue;
          }
          let entry = cur;
          const effAbs = absOf(eff.path);
          if (effAbs !== entry.path && gone.get(entry.path)) {
            delete nextCols[entry.path];
            entry = { ...entry, path: effAbs };
          }
          const desc = eff.desc ?? undefined;
          const members = membersFor(c.id);
          const sameMembers =
            members.length === entry.members.length &&
            members.every((m, i) => m === entry.members[i]);
          if (
            entry.title !== eff.title ||
            (entry.description ?? undefined) !== desc ||
            !sameMembers ||
            !entry.wsSynced
          ) {
            entry = { ...entry, title: eff.title || entry.title, members, wsSynced: true };
            if (desc) entry.description = desc;
            else delete entry.description;
          }
          if (entry !== cur) {
            nextCols[entry.path] = entry;
            colsChanged = true;
          }
        }
        for (const eff of ws.collections) {
          if (seenColIds.has(eff.id)) continue;
          const abs = absOf(eff.path);
          if (nextCols[abs]) continue;
          const at = eff.at || Date.now();
          const title = eff.title || basename(abs);
          nextCols[abs] = {
            id: eff.id,
            path: abs,
            title,
            ...(eff.desc ? { description: eff.desc } : {}),
            members: membersFor(eff.id),
            sharedAt: at,
            updatedAt: at,
            // Skip the redundant OG render (the sharer made one for this
            // title); the absent pushedHash still gives the TOC its one
            // establishing push.
            pushedTitle: title,
            connectionId: ws.connectionId,
            ...(eff.by ? { sharedBy: eff.by } : {}),
            wsSynced: true,
          };
          colsChanged = true;
        }

        if (sharesChanged) updateShares(() => nextShares);
        if (colsChanged) updateCollections(() => nextCols);
        touched = touched || sharesChanged || colsChanged;
        for (const p of backfillShares) queueShareOp(p);
        for (const p of backfillCols) queueCollectionOp(p);
      }
      // New mirror entries carry no fingerprints; let reconciliation
      // establish (and thereby freshness-check) them now, not on next focus.
      if (!cancelled && touched) void reconcileShares();
    })().finally(() => {
      mirrorBusyRef.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [
    syncStatuses,
    updateShares,
    updateCollections,
    queueShareOp,
    queueCollectionOp,
    reconcileShares,
  ]);

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

  // Move the active draft's content into the real file `chosen`: write it,
  // flip the tab in place, re-key any share, start watching the file, and
  // delete the draft. The final step of every Save As path — the in-app prompt
  // (workspace open) and the native dialog (no workspace) both end here.
  const promoteDraftTo = useCallback(async (active: Tab, chosen: string) => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const draftPath = active.path;
    pathRef.current = chosen;
    snapshotRef.current = null; // Save As: overwrite the chosen target unconditionally
    await writeToDisk(chosen, currentMarkdownRef.current);
    // Flip the tab from draft to a real file (in place, keeping its position).
    const nextTabs = tabsRef.current.map((t) =>
      t.id === active.id ? { id: t.id, kind: "file" as const, path: chosen } : t,
    );
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    writeStoredSession(nextTabs, activeIdRef.current);
    // A shared draft keeps its share across promotion: re-key the entry to the
    // new path and republish (the title likely changed with the filename).
    if (sharesRef.current[draftPath]) {
      updateShares((prev) => {
        const { [draftPath]: moved, ...rest } = prev;
        return moved
          ? { ...rest, [chosen]: { ...moved, path: chosen, kind: "file" as const } }
          : prev;
      });
      scheduleSharePush(chosen);
      // The draft may have landed inside a synced workspace: publish the
      // share record there too.
      queueShareOp(chosen);
    }
    // The promoted file may have landed next to an existing html rendition of
    // the same stem — adopt it (enables the toggle, watches the pair).
    const sibling = htmlSiblingOf(chosen);
    const siblingExists = await invoke<boolean>("path_exists", { path: sibling }).catch(
      () => false,
    );
    htmlPathRef.current = siblingExists ? sibling : null;
    setHasHtml(siblingExists);
    try {
      await invoke("watch_file", { path: chosen, extra: htmlPathRef.current });
    } catch (e) {
      console.error("watch_file failed", e);
    }
    // The content now lives in a real file; remove the draft + its metadata.
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
  }, [writeToDisk, addRecent, updateShares, scheduleSharePush, queueShareOp]);

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
    const sel = sidebarSelectionRef.current;
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
  // after the editor remounts for a new doc (keyed by loadKey); calls before
  // mount are buffered inside Editor.
  useEffect(() => {
    if (findQuery) {
      editorRef.current?.setSearch(findQuery, findCase);
    } else {
      editorRef.current?.clearSearch();
    }
  }, [findQuery, findCase, loadKey]);

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
        // ⌘⌫ moves the selected entry to the Trash — but only when focus is
        // outside the editor, so it stays Milkdown's delete-to-line-start while
        // typing. (A sidebar-row handler can't be relied on: WebKit doesn't
        // focus buttons on click, so the row never holds focus to receive the
        // key.)
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.closest(".editor-wrap")) return;
        const sel = sidebarSelectionRef.current;
        if (sel?.kind === "dir" && workspaceRoot != null && sidebarOpen) {
          // A folder is only ever the sidebar selection (it's never an open
          // tab), so ⌘⌫ can target it only while its highlight is visible in the
          // tree. Otherwise fall through to the active file tab.
          e.preventDefault();
          void deleteEntry(sel.path, "dir");
        } else {
          const active = tabsRef.current.find((tb) => tb.id === activeIdRef.current);
          if (active?.kind === "file") {
            e.preventDefault();
            void deleteEntry(active.path, "file");
          }
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
      } else if (k === "\\") {
        e.preventDefault();
        if (workspaceRoot) setSidebarOpen((v) => !v);
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
    closeTab,
    deleteEntry,
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
  ]);

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    const name = active ? tabTitle(active) : "Doklin";
    void getCurrentWindow().setTitle(`${active && dirty ? "● " : ""}${name}`);
  }, [tabs, activeId, dirty]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeMissing = activeTab?.missing === true;
  const showSidebar = workspaceRoot != null && sidebarOpen;
  const activeFilePath = activeTab?.kind === "file" ? activeTab.path : null;
  const activeDraftPath = activeTab?.kind === "draft" ? activeTab.path : null;
  // html-only documents render in the iframe alone; there is no markdown
  // version to edit, so the editor never mounts and the MD side is disabled.
  const activeIsHtmlDoc = activeTab?.kind === "file" && isHtmlPath(activeTab.path);
  const showHtmlView = docView === "html" && !activeMissing;
  // The folder share the active document's include/remove toggle binds to
  // (drafts have no directory, so never a collection).
  const activeShareCollection = activeFilePath
    ? nearestCollection(collections, activeFilePath)
    : null;

  // Presence truth-telling: which document this window has focused. Autosaves
  // renew it (writeToDisk); switching away (or to a draft) clears it.
  useEffect(() => {
    reportSyncActivity(activeFilePath);
  }, [activeFilePath]);

  // No hooks below this line: a hook after the early return crashes React
  // ("rendered more hooks than during the previous render") the moment
  // `ready` flips, unmounting the whole app.
  if (!ready) return null;

  return (
    <div
      className={`app ${showSidebar ? "with-sidebar" : ""} ${draftsOpen ? "show-drafts" : ""}`}
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
      {activeTab && !activeMissing && (
        <ShareMenu
          key={activeTab.path}
          docTitle={docShareTitle(activeTab)}
          entry={shares[activeTab.path] ?? null}
          entryConnection={connectionForEntrySync(shares[activeTab.path] ?? null)}
          connections={shareConns.connections}
          defaultConnectionId={defaultConnectionId}
          globalDefaultId={shareConns.defaultId}
          shareCountFor={shareCountFor}
          collection={
            activeShareCollection && activeFilePath
              ? {
                  entry: activeShareCollection,
                  included: activeShareCollection.members.includes(activeFilePath),
                  connection: connectionForEntrySync(activeShareCollection),
                }
              : null
          }
          autoOpen={pendingSharePopover === activeTab.path}
          onAutoOpenConsumed={() => setPendingSharePopover(null)}
          onShare={shareActiveDoc}
          onStopSharing={() => stopSharing(activeTab.path)}
          onToggleCollection={(include) =>
            activeShareCollection && activeFilePath
              ? setCollectionMembership(activeFilePath, activeShareCollection.path, include)
              : Promise.resolve()
          }
          onOpenSharedPages={() => setSharedPagesOpen(true)}
          onOpenSetupGuide={() => setShareSetupOpen(true)}
          onOpenExternal={openExternal}
          onSaveConnection={saveConnection}
          onRemoveConnection={removeConnection}
          onMakeDefault={makeDefaultConnection}
          onRememberWorkspaceConnection={
            workspaceRoot ? rememberWorkspaceConnection : null
          }
          onProtectedChanged={(isProtected) => {
            const path = activeTab.path;
            updateShares((prev) =>
              prev[path] && !!prev[path].protected !== isProtected
                ? { ...prev, [path]: { ...prev[path], protected: isProtected } }
                : prev,
            );
          }}
          onOpenWorkerUpdate={
            outdatedWorkers.length > 0 ? () => setWorkerUpdateList(outdatedWorkers) : null
          }
        />
      )}
      {sharedPagesOpen && (
        <SharedPages
          shares={Object.values(shares).sort((a, b) => b.sharedAt - a.sharedAt)}
          collections={Object.values(collections).sort((a, b) => b.sharedAt - a.sharedAt)}
          connections={shareConns.connections}
          connectionFor={connectionForEntrySync}
          onClose={() => setSharedPagesOpen(false)}
          onOpenDoc={(entry) => {
            setSharedPagesOpen(false);
            void openTab(entry.path, entry.kind);
          }}
          onManageCollection={(entry) => {
            setSharedPagesOpen(false);
            setShareFolderTarget(entry.path);
          }}
          onOpenExternal={openExternal}
          onOpenSetup={() => setShareSetupOpen(true)}
          onOpenWorkerUpdate={
            outdatedWorkers.length > 0 ? () => setWorkerUpdateList(outdatedWorkers) : null
          }
          onStopSharing={(entry) => stopSharing(entry.path)}
        />
      )}
      {shareFolderTarget && (
        <ShareFolder
          dirPath={shareFolderTarget}
          collection={collections[shareFolderTarget] ?? null}
          collectionConnection={connectionForEntrySync(
            collections[shareFolderTarget] ?? null,
          )}
          shares={shares}
          connections={shareConns.connections}
          defaultConnectionId={defaultConnectionId}
          onShare={(id, connectionId) =>
            shareFolder(shareFolderTarget, id, connectionId)
          }
          onStopSharing={async (alsoStopPages) => {
            // Close only once the stop went through, so a failure (offline,
            // bad token) surfaces in the still-open dialog.
            await stopSharingFolder(shareFolderTarget, alsoStopPages);
            setShareFolderTarget(null);
          }}
          onToggleMember={(path, include) =>
            setCollectionMembership(path, shareFolderTarget, include)
          }
          onUpdateMeta={(title, description) =>
            setCollectionMeta(shareFolderTarget, title, description)
          }
          onProtectedChanged={(isProtected) => {
            updateCollections((prev) =>
              prev[shareFolderTarget] &&
              !!prev[shareFolderTarget].protected !== isProtected
                ? {
                    ...prev,
                    [shareFolderTarget]: {
                      ...prev[shareFolderTarget],
                      protected: isProtected,
                    },
                  }
                : prev,
            );
          }}
          onOpenWorkerUpdate={
            outdatedWorkers.length > 0 ? () => setWorkerUpdateList(outdatedWorkers) : null
          }
          onClose={() => setShareFolderTarget(null)}
          onOpenExternal={openExternal}
          onOpenSetup={() => {
            setShareFolderTarget(null);
            setShareSetupOpen(true);
          }}
        />
      )}
      {shareSetupOpen && (
        <ShareSetup
          isAddingAnother={shareConns.connections.length > 0}
          onClose={() => setShareSetupOpen(false)}
          onOpenExternal={openExternal}
          onConnectionSaved={saveConnection}
        />
      )}
      {workerUpdateList && workerUpdateList.length > 0 && (
        <WorkerUpdate
          outdated={workerUpdateList}
          latestVersion={BUNDLED_WORKER_VERSION}
          onRecheck={recheckWorkerVersion}
          onOpenExternal={openExternal}
          onClose={() => setWorkerUpdateList(null)}
        />
      )}
      {cloudSyncOpen && (
        <CloudSync
          workspaceRoot={workspaceRoot}
          workspaceName={workspaceRoot ? basename(workspaceRoot) : null}
          connections={shareConns.connections}
          defaultConnectionId={defaultConnectionId}
          statuses={syncStatuses}
          deviceName={syncDeviceName}
          onClose={() => setCloudSyncOpen(false)}
          onOpenShareSetup={() => {
            setCloudSyncOpen(false);
            setShareSetupOpen(true);
          }}
          onOpenWorkerUpdate={
            outdatedWorkers.length > 0
              ? () => {
                  setCloudSyncOpen(false);
                  setWorkerUpdateList(outdatedWorkers);
                }
              : null
          }
          onOpenConnectBackend={() => {
            setCloudSyncOpen(false);
            setConnectBackendOpen(true);
          }}
          onOpenBackends={() => {
            setCloudSyncOpen(false);
            setBackendsOpen(true);
          }}
        />
      )}
      {backendsOpen && (
        <Backends
          connections={shareConns.connections}
          defaultId={shareConns.defaultId}
          statuses={syncStatuses}
          shareCountFor={shareCountFor}
          outdatedIds={outdatedWorkers.map((w) => w.conn.id)}
          onClose={() => setBackendsOpen(false)}
          onOpenExternal={openExternal}
          onOpenSetup={() => setShareSetupOpen(true)}
          onOpenConnectBackend={() => setConnectBackendOpen(true)}
          onOpenWorkerUpdate={
            outdatedWorkers.length > 0 ? () => setWorkerUpdateList(outdatedWorkers) : null
          }
          onOpenCloudSync={() => setCloudSyncOpen(true)}
          onOpenSharedPages={() => setSharedPagesOpen(true)}
          onSaveConnection={saveConnection}
          onMakeDefault={makeDefaultConnection}
          onDisconnect={removeConnection}
          onTeardown={(conn) => {
            setBackendsOpen(false);
            setTeardownConn(conn);
          }}
        />
      )}
      {teardownConn && (
        <BackendTeardown
          conn={teardownConn}
          onDisableLocalSync={() => disableSyncForConnection(teardownConn.id)}
          onOpenExternal={openExternal}
          onOpenWorkerUpdate={
            outdatedWorkers.some((w) => w.conn.id === teardownConn.id)
              ? () => {
                  setTeardownConn(null);
                  setWorkerUpdateList(outdatedWorkers);
                }
              : null
          }
          onDisconnect={async () => {
            await removeConnection(teardownConn.id);
            setTeardownConn(null);
          }}
          onClose={() => setTeardownConn(null)}
        />
      )}
      {connectBackendOpen && (
        <ConnectBackend
          deviceName={syncDeviceName}
          onSaveConnection={saveConnection}
          onOpenWorkspace={(root) => void openWorkspace(root)}
          onClose={() => setConnectBackendOpen(false)}
        />
      )}
      {historyTarget &&
        syncedWorkspace &&
        workspaceRoot &&
        (() => {
          const connection =
            shareConns.connections.find((c) => c.id === syncedWorkspace.connectionId) ?? null;
          const rel = historyTarget.startsWith(`${workspaceRoot}/`)
            ? historyTarget.slice(workspaceRoot.length + 1)
            : null;
          return connection && rel ? (
            <HistoryPanel
              docPath={historyTarget}
              relPath={rel}
              wsId={syncedWorkspace.wsId}
              connection={connection}
              onClose={() => setHistoryTarget(null)}
              onOpenFile={(p) => void openTab(p, "file")}
            />
          ) : null;
        })()}
      {draftsOpen && (
        <DraftsPanel
          drafts={draftRows}
          activePath={activeDraftPath}
          onOpen={(p) => void openTab(p, "draft")}
          onDiscard={(p, id) => void discardDraft(p, id)}
          onNewDraft={() => void newDraft()}
          onClose={() => setDraftsOpen(false)}
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
        trailing={
          activeTab && !activeMissing ? (
            <>
              {docView === "md" && commentCount > 0 && (
                <CommentsToggle
                  count={commentCount}
                  visible={commentsVisible}
                  onToggle={() => setCommentsVisible((v) => !v)}
                />
              )}
              <ViewToggle
                view={docView}
                hasMd={!activeIsHtmlDoc}
                hasHtml={hasHtml}
                onSelect={(v) => void selectDocView(v)}
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
          currentPath={activeFilePath}
          selection={sidebarSelection}
          refreshToken={treeRefreshToken}
          shares={shares}
          collections={collections}
          onSelect={selectSidebarEntry}
          onOpenFile={(p) => void openTab(p, "file")}
          onOpenFolder={openFolderPicker}
          onOpenFilePicker={openFilePicker}
          onRevealInFinder={revealInFinder}
          onDelete={(p, kind) => void deleteEntry(p, kind)}
          onMovePath={movePath}
          onShareFolder={(dir) => setShareFolderTarget(dir)}
          onShareFile={(p) => void shareFileFromTree(p)}
          onStopSharingFile={(p) =>
            void stopSharing(p).catch((e) => {
              console.error("stop sharing failed", e);
              window.alert(e instanceof Error ? e.message : String(e));
            })
          }
          onCopyShareLink={(id) => void copyShareLink(id)}
          onToggleMembership={(path, dir, include) =>
            void setCollectionMembership(path, dir, include).catch((e) => {
              console.error("membership toggle failed", e);
              window.alert(e instanceof Error ? e.message : String(e));
            })
          }
          onSwitchToSearch={() => {
            setSidebarMode("search");
            setWsFocusToken((t) => t + 1);
          }}
          presence={presenceByPath}
          syncPhase={syncedWorkspace?.phase ?? null}
          onFileHistory={syncedWorkspace ? (p) => setHistoryTarget(p) : null}
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
        className={`editor-wrap ${showHtmlView ? "is-html-view" : ""} ${
          dictationUi.session !== "idle"
            ? `is-dictating ${dictationUi.gate === "listening" && dictationUi.session === "active" ? "is-listening" : "is-paused"}`
            : ""
        }`}
      >
        {findOpen && activeTab && !activeMissing && docView === "md" && (
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
        {activeTab && !activeMissing && !activeIsHtmlDoc && (
          <Editor
            key={loadKey}
            ref={editorRef}
            initialMarkdown={initialMarkdown}
            onChange={onMarkdownChange}
            onSearchState={setFindInfo}
            onReady={restoreActiveScroll}
            commentAuthor={syncDeviceName}
            commentsVisible={commentsVisible}
            onCommentsCount={setCommentCount}
            onRequestShowComments={() => setCommentsVisible(true)}
          />
        )}
        {activeTab && showHtmlView && htmlContent != null && (
          // The rendition is arbitrary generated markup: render it isolated in
          // a sandboxed frame (scripts run under an opaque origin — no access
          // to the app, its storage, or Tauri IPC).
          <iframe
            className="html-preview"
            title="HTML version"
            sandbox="allow-scripts allow-popups"
            srcDoc={htmlContent}
          />
        )}
        {activeTab && activeMissing && (
          <MissingFileState
            path={activeTab.path}
            onRetry={() => void loadActiveContent(activeTab)}
            onCloseTab={() => void closeTab(activeTab.id)}
          />
        )}
        {/* Only when NO document is open (the welcome screen). An open note —
            even an empty, unsaved draft — shows the bare editor, like an
            untitled tab in VS Code. */}
        {!activeTab && (
          <ScratchEmptyState
            recents={recents}
            onNewNote={() => void newDraft()}
            onOpenFile={openFilePicker}
            onOpenFolder={openFolderPicker}
            onOpenRecent={openRecent}
          />
        )}
        <DictationHud
          ui={dictationUi}
          onFlush={() => dictationRef.current?.flushPending()}
          onRevert={() => dictationRef.current?.revertPolish()}
          onStop={() => void dictationRef.current?.stop()}
        />
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
        onOpenSharedPages={() => setSharedPagesOpen(true)}
        onOpenCloudSync={() => setCloudSyncOpen(true)}
        onOpenBackends={() => setBackendsOpen(true)}
        syncAttention={syncStatuses.some(
          (s) => s.phase === "pending-deletes" || s.phase === "revoked" || s.phase === "error",
        )}
        onOpenDictationSetup={() => setDictationSetupOpen(true)}
        update={update}
        workerUpdateCount={outdatedWorkers.length}
        onOpenWorkerUpdate={() => setWorkerUpdateList(outdatedWorkers)}
        onOpenExternal={openExternal}
      />
    </div>
  );
}

/* ---------- Subviews ---------- */

// The MD/HTML segmented toggle (right end of the tab bar). Both sides always
// render so the control reads the same for every document; a side whose
// version doesn't exist on disk is disabled.
function ViewToggle({
  view,
  hasMd,
  hasHtml,
  onSelect,
}: {
  view: DocView;
  hasMd: boolean;
  hasHtml: boolean;
  onSelect: (v: DocView) => void;
}) {
  return (
    <div className="view-toggle" role="tablist" aria-label="Document view">
      <button
        role="tab"
        aria-selected={view === "md"}
        className={`view-toggle-seg ${view === "md" ? "is-active" : ""}`}
        disabled={!hasMd}
        title={hasMd ? "Markdown" : "No markdown version"}
        onClick={() => onSelect("md")}
      >
        MD
      </button>
      <button
        role="tab"
        aria-selected={view === "html"}
        className={`view-toggle-seg ${view === "html" ? "is-active" : ""}`}
        disabled={!hasHtml}
        title={hasHtml ? "HTML" : "No HTML version"}
        onClick={() => onSelect("html")}
      >
        HTML
      </button>
    </div>
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
  onOpenSharedPages,
  onOpenCloudSync,
  onOpenBackends,
  syncAttention,
  onOpenDictationSetup,
  update,
  workerUpdateCount,
  onOpenWorkerUpdate,
  onOpenExternal,
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
  onOpenSharedPages: () => void;
  onOpenCloudSync: () => void;
  // Opens the Backends dialog — the home for connecting, listing, and
  // disconnecting backends (it routes to setup / invite flows itself).
  onOpenBackends: () => void;
  // True when a synced workspace needs a decision (held deletions, revoked
  // access, an error) — dots the Cloud sync item.
  syncAttention: boolean;
  onOpenDictationSetup: () => void;
  update: UpdateController;
  // How many configured share backends run an older worker than this build
  // ships; > 0 lights the badge and shows the update item under Sharing.
  workerUpdateCount: number;
  onOpenWorkerUpdate: () => void;
  onOpenExternal: (url: string) => void;
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
          <div className="settings-section-label">Cloud</div>
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onOpenCloudSync();
            }}
          >
            <span className="settings-option-check">
              {syncAttention && <span className="sync-attention-dot" aria-hidden />}
            </span>
            <span className="settings-option-label">Cloud sync…</span>
          </button>
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onOpenSharedPages();
            }}
          >
            <span className="settings-option-check" />
            <span className="settings-option-label">Shared pages…</span>
          </button>
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onOpenBackends();
            }}
          >
            <span className="settings-option-check" />
            <span className="settings-option-label">Backends…</span>
          </button>
          {workerUpdateCount > 0 && (
            <button
              role="menuitem"
              className="settings-option settings-option--update"
              title="A newer backend worker is available for your domain — a quick redeploy picks it up"
              onClick={() => {
                setOpen(false);
                onOpenWorkerUpdate();
              }}
            >
              <span className="settings-option-check">
                <DownloadIcon />
              </span>
              <span className="settings-option-label">
                Update backend worker{workerUpdateCount > 1 ? `s (${workerUpdateCount})` : "…"}
              </span>
            </button>
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
        aria-label={
          updateAvailable || workerUpdateCount > 0 ? "Settings — update available" : "Settings"
        }
        aria-expanded={open}
        title={
          updateAvailable || workerUpdateCount > 0 ? "Settings — update available" : "Settings"
        }
      >
        <GearIcon />
        {(updateAvailable || workerUpdateCount > 0) && (
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
