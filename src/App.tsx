import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import Editor, { type EditorHandle } from "./Editor";
import type { SearchInfo } from "./searchPlugin";
import Sidebar from "./Sidebar";
import TabBar from "./TabBar";
import DraftsPanel from "./DraftsPanel";
import FindBar from "./FindBar";
import WorkspaceSearch from "./WorkspaceSearch";
import ShareMenu from "./ShareMenu";
import SharedPages from "./SharedPages";
import {
  deletePage,
  getShareConfig,
  pushOgImage,
  pushPage,
  readShares,
  writeShares,
  type ShareConfig,
  type ShareEntry,
} from "./share";

type OpenFilePayload = { path: string };
type OpenFolderPayload = { path: string };
type FileSnapshot = { mtime_ms: number; size: number };
type ReadFileResult = { contents: string; snapshot: FileSnapshot };
type ExternalChangePayload = { path: string; snapshot: FileSnapshot };
type WriteErrorPayload =
  | { kind: "io"; message: string }
  | { kind: "conflict"; current: FileSnapshot };
type Conflict = { diskSnapshot: FileSnapshot };

const AUTOSAVE_DEBOUNCE_MS = 600;

type WindowInit = { isMain: boolean; folder: string | null; file: string | null };

// Whether this window owns the shared tab session (doklin:session). The backend is
// the authority (take_window_init keys off the real window label); we default to
// true and flip it false for spawned windows once init resolves, so a spawned
// window never clobbers the main window's session. Shared prefs (theme, recents,
// drafts) stay shared across all windows.
let isMainWindow = true;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

type Theme = "system" | "light" | "sepia" | "dark";
const THEMES: Theme[] = ["system", "light", "sepia", "dark"];
const THEME_STORAGE_KEY = "doklin:theme";
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
// markdown extension for real files ("notes.md" shares as "notes").
const docShareTitle = (t: Tab) =>
  t.kind === "draft"
    ? t.title ?? "Untitled"
    : basename(t.path).replace(/\.(md|markdown|mdown|mkd)$/i, "");
const SHARE_PUSH_DEBOUNCE_MS = 1500;
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

function readStoredSession(): { tabs: Tab[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null };
    const parsed = JSON.parse(raw);
    const tabs: Tab[] = Array.isArray(parsed?.tabs)
      ? parsed.tabs.filter(
          (t: unknown): t is Tab =>
            !!t &&
            typeof (t as Tab).id === "string" &&
            typeof (t as Tab).path === "string" &&
            ((t as Tab).kind === "draft" || (t as Tab).kind === "file"),
        )
      : [];
    const activeId = typeof parsed?.activeId === "string" ? parsed.activeId : null;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

function writeStoredSession(tabs: Tab[], activeId: string | null) {
  // Only the main window owns the persisted session; spawned windows are driven
  // by take_window_init, so they must not clobber the shared session key.
  if (!isMainWindow) return;
  try {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ tabs, activeId, version: 1 }),
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
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readStoredSidebarOpen());
  const [draftsOpen, setDraftsOpen] = useState<boolean>(() => readDraftsOpen());
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [recents, setRecents] = useState<RecentEntry[]>(() => readStoredRecents());
  const [docEmpty, setDocEmpty] = useState(true);
  // Whether the editor's contenteditable holds focus. An empty draft's
  // placeholder card hides the moment the user clicks into the canvas, not
  // only once a first character lands.
  const [editorFocused, setEditorFocused] = useState(false);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  // Bumped after each autosave write of a draft lands on disk, so the drafts
  // panel re-lists (list_drafts reads from disk, so the refresh has to follow
  // the write, not the keystroke). The 600ms autosave debounce is the rate cap.
  const [draftsRefreshToken, setDraftsRefreshToken] = useState(0);
  const deletedStackRef = useRef<{ path: string; trashPath: string; wasOpen: boolean }[]>([]);
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

  // Public sharing: `shares` maps a document's absolute path to its live
  // share (see share.ts). Every successful disk write of a shared doc schedules
  // a debounced push of the same content to the remote page.
  const [shares, setShares] = useState<Record<string, ShareEntry>>(() => readShares());
  const sharesRef = useRef<Record<string, ShareEntry>>(shares);
  const [shareConfig, setShareConfig] = useState<ShareConfig | null>(null);
  const [sharedPagesOpen, setSharedPagesOpen] = useState(false);
  const sharePushTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    void getShareConfig().then(setShareConfig);
  }, []);

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

  // Push the current content of a shared doc to its remote page. Content comes
  // from the live editor when the doc is active, from disk otherwise. A title
  // change (draft renamed / promoted) also refreshes the OG image.
  const pushSharedNow = useCallback(
    async (target: string) => {
      const entry = sharesRef.current[target];
      if (!entry) return;
      const config = await getShareConfig();
      if (!config) return;
      const tab = tabsRef.current.find((t) => t.path === target);
      const title = tab ? docShareTitle(tab) : entry.title;
      let contents: string;
      if (pathRef.current === target) {
        contents = currentMarkdownRef.current;
      } else {
        try {
          contents = (await invoke<ReadFileResult>("read_file", { path: target })).contents;
        } catch {
          return; // source is gone; the share stays until stopped explicitly
        }
      }
      try {
        await pushPage(config, entry.id, title, contents);
        if (title !== entry.title) await pushOgImage(config, entry.id, title);
        updateShares((prev) =>
          prev[target]
            ? { ...prev, [target]: { ...prev[target], title, updatedAt: Date.now() } }
            : prev,
        );
      } catch (e) {
        // Offline or the worker hiccuped; the next save retries.
        console.error("share push failed", target, e);
      }
    },
    [updateShares],
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

  // In-file find (⌘F): a bar over the editor that drives the ProseMirror search
  // plugin through the editor ref. `findInfo` mirrors the plugin's match count +
  // current index for the "3/12" readout.
  const editorRef = useRef<EditorHandle>(null);
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
  // anything that remounts the editor (tab switch, external reload).
  const captureActiveScroll = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
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
      setDocEmpty(true);
      setEditorFocused(false); // the editor unmounts without firing blur
      setConflict(null);
      try {
        await invoke("unwatch_file");
      } catch {
        // ignore
      }
      return;
    }
    setTabMissing(tab.id, false); // the file is back (or was never gone)
    baselineCapturedRef.current = false;
    pathRef.current = tab.path;
    currentMarkdownRef.current = contents;
    lastSavedRef.current = contents;
    snapshotRef.current = snapshot;
    setInitialMarkdown(contents);
    setDirty(false);
    setDocEmpty(contents.trim().length === 0);
    setEditorFocused(false); // the remounted editor starts unfocused
    setConflict(null);
    setLoadKey((k) => k + 1);
    if (tab.kind === "file") {
      try {
        await invoke("watch_file", { path: tab.path });
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
  }, [setTabMissing]);

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

  const setWorkspace = useCallback((root: string) => {
    setWorkspaceRoot(root);
    setSidebarOpen(true);
    addRecent(root, "folder");
  }, [addRecent]);

  const openFolderPicker = useCallback(async () => {
    try {
      const chosen = await openDialog({ directory: true, multiple: false });
      if (typeof chosen === "string") setWorkspace(chosen);
    } catch (e) {
      console.error("open folder failed", e);
    }
  }, [setWorkspace]);

  const openFilePicker = useCallback(async () => {
    try {
      const chosen = await openDialog({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
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
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
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
      if (r.kind === "folder") setWorkspace(r.path);
      else void openTab(r.path, "file");
    },
    [setWorkspace, openTab],
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

  // Publish the active document at <endpoint>/<id> and record the share.
  // Throws on failure so the share popover can surface the error.
  const shareActiveDoc = useCallback(
    async (id: string) => {
      const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!active) throw new Error("No document open.");
      const config = await getShareConfig();
      if (!config) throw new Error("Sharing is not configured.");
      const title = docShareTitle(active);
      await pushPage(config, id, title, currentMarkdownRef.current);
      try {
        await pushOgImage(config, id, title);
      } catch (e) {
        // The page is live either way; the link preview just won't have an image.
        console.error("og image upload failed", e);
      }
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
        },
      }));
    },
    [updateShares],
  );

  // Delete the remote page and forget the share (the local file is untouched).
  const stopSharing = useCallback(
    async (target: string) => {
      const entry = sharesRef.current[target];
      if (!entry) return;
      const config = await getShareConfig();
      if (!config) throw new Error("Sharing is not configured.");
      await deletePage(config, entry.id);
      const timers = sharePushTimersRef.current;
      const pending = timers.get(target);
      if (pending != null) {
        window.clearTimeout(pending);
        timers.delete(target);
      }
      updateShares((prev) => {
        const { [target]: _gone, ...rest } = prev;
        return rest;
      });
    },
    [updateShares],
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
    } catch (e) {
      console.error("reload failed", e);
    }
  }, [captureActiveScroll]);

  const keepMyVersion = useCallback(() => {
    const c = conflictRef.current;
    if (c) snapshotRef.current = c.diskSnapshot;
    setConflict(null);
    if (currentMarkdownRef.current !== lastSavedRef.current) {
      scheduleAutosave();
    }
  }, [scheduleAutosave]);

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
    setDocEmpty(true);
    setEditorFocused(false);
    setConflict(null);
  }, []);

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

  // Move a file to the system Trash (⌘⌫ from the sidebar). The backend returns
  // where the file landed inside the Trash so undoDelete can pull it straight
  // back out — a true restore that leaves no stale copy. If the file is open in a
  // tab, that tab is closed first (see below).
  const deleteFile = useCallback(
    async (target: string) => {
      // Close the tab first (flushing its content while the file still exists),
      // so the trash that follows can't be resurrected by a late autosave write
      // and the watcher has already moved to a neighbor tab.
      const openForFile = tabsRef.current.find(
        (t) => t.kind === "file" && t.path === target,
      );
      if (openForFile) await closeTab(openForFile.id);
      let trashPath: string;
      try {
        trashPath = await invoke<string>("trash_file", { path: target });
      } catch (e) {
        console.error("trash failed", e);
        alert(`Could not delete ${target}\n${e}`);
        return;
      }
      deletedStackRef.current.push({ path: target, trashPath, wasOpen: !!openForFile });
      setTreeRefreshToken((t) => t + 1);
    },
    [closeTab],
  );

  // Undo the most recent trash (⌘Z outside the editor): move the file back out
  // of the Trash to its original path and reopen it if it had been open.
  const undoDelete = useCallback(async () => {
    const entry = deletedStackRef.current.pop();
    if (!entry) return;
    try {
      await invoke("restore_trashed", {
        trashPath: entry.trashPath,
        originalPath: entry.path,
      });
    } catch (e) {
      console.error("undo delete failed", e);
      alert(`Could not restore ${entry.path}\n${e}`);
      return;
    }
    setTreeRefreshToken((t) => t + 1);
    if (entry.wasOpen) await openTab(entry.path, "file");
  }, [openTab]);

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
        if (init.folder) setWorkspace(init.folder);
        if (init.file) await openTab(init.file, "file");
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

      // Restore the persisted session. A file tab whose path no longer reads is
      // kept as a visible "ghost" (missing) tab rather than silently dropped —
      // the disk may just be unmounted, and the user decides whether to close
      // it. Drafts are app-managed; one that's gone really is gone → drop.
      const stored = readStoredSession();
      const restored: Tab[] = [];
      for (const t of stored.tabs) {
        try {
          await invoke<ReadFileResult>("read_file", { path: t.path });
          restored.push(
            t.kind === "draft" && !t.title
              ? { ...t, title: `Untitled-${draftsMetaRef.current[t.id]?.seq ?? "?"}` }
              : { ...t, missing: undefined }, // readable again → clear a stale flag
          );
        } catch {
          if (t.kind === "file") restored.push({ ...t, missing: true });
        }
      }

      // Append the migrated scratchpad (if any) as a fresh draft tab.
      if (migrated) {
        const seq = draftSeqRef.current + 1;
        draftSeqRef.current = seq;
        writeDraftSeq(seq);
        draftsMetaRef.current = { ...draftsMetaRef.current, [migrated.id]: { seq } };
        writeDraftsMeta(draftsMetaRef.current);
        restored.push({ id: migrated.id, kind: "draft", path: migrated.path, title: `Untitled-${seq}` });
      }

      // CLI / Finder launch ADDS to the session rather than replacing it.
      const pendingFolder = await invoke<string | null>("take_pending_folder");
      const pendingFile = await invoke<string | null>("take_pending_open");

      if (restored.length > 0) {
        const activeId =
          stored.activeId && restored.some((t) => t.id === stored.activeId)
            ? stored.activeId
            : restored[restored.length - 1].id;
        tabsRef.current = restored;
        activeIdRef.current = activeId;
        setTabs(restored);
        setActiveId(activeId);
        writeStoredSession(restored, activeId);
        const active = restored.find((t) => t.id === activeId);
        if (active) await loadActiveContent(active);
      }
      // Nothing to restore and no file arg → no tab open (welcome screen).

      if (pendingFolder) setWorkspace(pendingFolder);
      if (pendingFile) await openTab(pendingFile, "file");
      setReady(true);
    })();
    const unFile = listen<OpenFilePayload>("open-file", (e) => {
      void openTab(e.payload.path, "file");
    });
    const unFolder = listen<OpenFolderPayload>("open-folder", (e) => {
      setWorkspace(e.payload.path);
    });
    return () => {
      void unFile.then((f) => f());
      void unFolder.then((f) => f());
    };
  }, [openTab, setWorkspace, loadActiveContent]);

  // Report this window's content (workspace folder + open file paths) to the
  // backend whenever it changes, so an external open can focus the window that
  // already shows a path instead of opening a duplicate. The first report also
  // marks the app "ready", flipping external opens from the cold-start
  // pending-open path to window routing.
  useEffect(() => {
    const files = tabs.filter((t) => t.kind === "file").map((t) => t.path);
    void invoke("register_window_content", { folder: workspaceRoot, files });
  }, [workspaceRoot, tabs]);

  useEffect(() => {
    const un = listen<ExternalChangePayload>("file-externally-changed", (e) => {
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
  }, [reloadFromDisk]);

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

  const onMarkdownChange = useCallback(
    (md: string) => {
      currentMarkdownRef.current = md;
      setDocEmpty(md.trim().length === 0);
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

  const handleSave = useCallback(async () => {
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!active) return;
    if (active.kind === "file") {
      // Real files autosave continuously; ⌘S just flushes any pending write.
      flushPendingAutosave();
      return;
    }
    // Promote a draft to a real file (Save As).
    const chosen = await saveDialog({
      title: "Save markdown",
      defaultPath: `${active.title ?? "untitled"}.md`,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!chosen) return;
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
    }
    try {
      await invoke("watch_file", { path: chosen });
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
  }, [writeToDisk, flushPendingAutosave, addRecent, updateShares, scheduleSharePush]);

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
        setWorkspace(chosen);
        setSidebarMode("search");
        setWsFocusToken((t) => t + 1);
      }
    } catch (e) {
      console.error("open folder failed", e);
    }
  }, [workspaceRoot, setWorkspace]);

  // Open a workspace-search result: load the file, then seed the search query
  // so the match is highlighted and scrolled into view (WYSIWYG has no line to
  // jump to). We deliberately do NOT open the find bar — the highlight alone is
  // the "you landed here" cue; Esc clears it (see the keydown handler).
  const openResult = useCallback(
    async (p: string, query: string) => {
      await openTab(p, "file");
      setFindCase(wsCase);
      setFindQuery(query);
    },
    [openTab, wsCase],
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
        if (active && !active.missing) {
          setFindOpen(true);
          setFindFocusToken((t) => t + 1);
        }
      } else if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        void newDraft();
      } else if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        if (activeIdRef.current) void closeTab(activeIdRef.current);
      } else if (k === "backspace") {
        // ⌘⌫ moves the active file to the Trash — but only when focus is outside
        // the editor, so it stays Milkdown's delete-to-line-start while typing.
        // (A sidebar-row handler can't be relied on: WebKit doesn't focus
        // buttons on click, so the row never holds focus to receive the key.)
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.closest(".editor-wrap")) return;
        const active = tabsRef.current.find((tb) => tb.id === activeIdRef.current);
        if (active?.kind === "file") {
          e.preventDefault();
          void deleteFile(active.path);
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
    deleteFile,
    openFolderPicker,
    openFilePicker,
    openFileInNewWindow,
    openFolderInNewWindow,
    cycleTab,
    workspaceRoot,
    undoDelete,
    openWorkspaceSearch,
  ]);

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    const name = active ? tabTitle(active) : "Doklin";
    void getCurrentWindow().setTitle(`${active && dirty ? "● " : ""}${name}`);
  }, [tabs, activeId, dirty]);

  if (!ready) return null;

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeMissing = activeTab?.missing === true;
  const showSidebar = workspaceRoot != null && sidebarOpen;
  const isDraft = activeTab?.kind === "draft";
  const activeFilePath = activeTab?.kind === "file" ? activeTab.path : null;
  const activeDraftPath = activeTab?.kind === "draft" ? activeTab.path : null;

  return (
    <div
      className={`app ${showSidebar ? "with-sidebar" : ""} ${draftsOpen ? "show-drafts" : ""}`}
    >
      <div className="drag-strip" data-tauri-drag-region />
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
      </div>
      {activeTab && !activeMissing && (
        <ShareMenu
          key={activeTab.path}
          docTitle={docShareTitle(activeTab)}
          entry={shares[activeTab.path] ?? null}
          config={shareConfig}
          onShare={shareActiveDoc}
          onStopSharing={() => stopSharing(activeTab.path)}
          onOpenSharedPages={() => setSharedPagesOpen(true)}
          onOpenExternal={openExternal}
          onConfigChanged={setShareConfig}
          onConfigDeleted={() => setShareConfig(null)}
        />
      )}
      {sharedPagesOpen && (
        <SharedPages
          shares={Object.values(shares).sort((a, b) => b.sharedAt - a.sharedAt)}
          config={shareConfig}
          onClose={() => setSharedPagesOpen(false)}
          onOpenDoc={(entry) => {
            setSharedPagesOpen(false);
            void openTab(entry.path, entry.kind);
          }}
          onOpenExternal={openExternal}
          onStopSharing={(entry) => stopSharing(entry.path)}
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
          refreshToken={treeRefreshToken}
          onOpenFile={(p) => void openTab(p, "file")}
          onOpenFolder={openFolderPicker}
          onOpenFilePicker={openFilePicker}
          onRevealInFinder={revealInFinder}
          onSwitchToSearch={() => {
            setSidebarMode("search");
            setWsFocusToken((t) => t + 1);
          }}
        />
      )}
      {conflict && (
        <ConflictBanner
          onReload={() => void reloadFromDisk()}
          onKeep={keepMyVersion}
        />
      )}
      <main className="editor-wrap">
        {findOpen && activeTab && !activeMissing && (
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
        {activeTab && !activeMissing && (
          <Editor
            key={loadKey}
            ref={editorRef}
            initialMarkdown={initialMarkdown}
            onChange={onMarkdownChange}
            onSearchState={setFindInfo}
            onFocusChange={setEditorFocused}
            onReady={restoreActiveScroll}
          />
        )}
        {activeTab && activeMissing && (
          <MissingFileState
            path={activeTab.path}
            onRetry={() => void loadActiveContent(activeTab)}
            onCloseTab={() => void closeTab(activeTab.id)}
          />
        )}
        {(!activeTab || (isDraft && docEmpty && !editorFocused)) && (
          <ScratchEmptyState
            noDoc={!activeTab}
            recents={recents}
            onNewNote={() => void newDraft()}
            onOpenFile={openFilePicker}
            onOpenFolder={openFolderPicker}
            onOpenRecent={openRecent}
          />
        )}
      </main>
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
      />
    </div>
  );
}

/* ---------- Subviews ---------- */

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
          <div className="settings-section-label">Sharing</div>
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
        </div>
      )}
      <button
        className="settings-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-expanded={open}
        title="Settings"
      >
        <GearIcon />
      </button>
    </div>
  );
}

function ScratchEmptyState({
  noDoc,
  recents,
  onNewNote,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
}: {
  noDoc: boolean;
  recents: RecentEntry[];
  onNewNote: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecent: (r: RecentEntry) => void;
}) {
  return (
    <div className="scratch-empty" aria-hidden={false}>
      <div className="scratch-empty-card">
        <div className="scratch-empty-hint">
          {noDoc ? "No note open" : "Start typing to jot a note"}
        </div>
        <div className="scratch-empty-actions">
          {noDoc && (
            <button className="scratch-empty-button" onClick={onNewNote}>
              <FileIcon />
              <span>New note</span>
              <span className="scratch-empty-kbd">⌘N</span>
            </button>
          )}
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
