// The Mac's answer to src/backend.ts: each operation is one or more of the
// Rust commands in src-tauri/src/, and each event one the Rust side emits.
// The only file under src/ that imports `@tauri-apps/*`.
//
// Here a document is files on a disk: `notes.md`, the `notes.html` rendition
// beside it and the `notes.meta.jsonl` sidecar (src/metaFile.ts). What it
// was read at is the file's modified time and size, and a deleted one is in
// the Trash.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  SaveConflict,
  type Backend,
  type Cloud,
  type CloudAccess,
  type CloudSpaces,
  type CloudDomain,
  type CloudSetup,
  type CloudSync,
  type DocumentChange,
  type DocumentPart,
  type Documents,
  type EntryKind,
  type FileClipboard,
  type FileClipboardPayload,
  type FileMatches,
  type Versions,
  type LeftBehind,
  type LocalFiles,
  type PdfExport,
  type PdfProgress,
  type Rev,
  type TreeNode,
  type Unsubscribe,
  type UntitledNotes,
  type Updater,
  type WatchedDocument,
  type Show,
  type Shows,
  type WindowInit,
  type Windows,
} from "../backend";
import type { CloudRemovedEvent, CloudStatus } from "../cloud";
import { documentsOf, type WorkspaceDocument } from "../docLinks";
import {
  HTML_EXT_RE,
  MD_EXT_RE,
  htmlSiblingOf,
  mdSiblingOf,
  metaFileOf,
  parseEntityMeta,
  serializeEntityMeta,
  sidecarWhileWriting,
} from "../metaFile";
import type { DeletedFile, FileHistory, SnapshotMeta, StoreInfo, VersionsStatus } from "../versions";

/** Hear one of the Rust side's events until the answer is called. */
function on<T>(event: string, cb: (payload: T) => void): Unsubscribe {
  const un = listen<T>(event, (e) => cb(e.payload));
  return () => {
    void un.then((f) => f()).catch(() => {});
  };
}

/** A harness that answers nothing gives null where a list was asked for. */
const listOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : []);

/* ---------- Documents ---------- */

// `FileSnapshot`, `ReadFileResult` and `WriteError` in src-tauri/src/lib.rs.
type FileSnapshot = { mtime_ms: number; size: number };
type ReadFileResult = { contents: string; snapshot: FileSnapshot };
type WriteError = { kind: "io"; message: string } | { kind: "conflict"; current: FileSnapshot };

const revOf = (s: FileSnapshot) => s as unknown as Rev;

const isWriteError = (e: unknown): e is WriteError =>
  typeof e === "object" &&
  e !== null &&
  "kind" in e &&
  ((e as { kind: unknown }).kind === "io" || (e as { kind: unknown }).kind === "conflict");

const exists = (path: string) => invoke<boolean>("path_exists", { path });
const present = (path: string) => exists(path).catch(() => false);

async function read(path: string) {
  const r = await invoke<ReadFileResult>("read_file", { path });
  return { text: r.contents, rev: revOf(r.snapshot) };
}

const readMeta = (path: string): Promise<string | null> =>
  invoke<ReadFileResult>("read_file", { path: metaFileOf(path) }).then(
    (r) => r.contents,
    () => null,
  );

async function write(path: string, contents: string, over: Rev | null): Promise<Rev> {
  try {
    return revOf(await invoke<FileSnapshot>("write_file", { path, contents, expected: over }));
  } catch (e) {
    if (!isWriteError(e)) throw e;
    if (e.kind === "conflict") throw new SaveConflict(revOf(e.current));
    throw new Error(e.message);
  }
}

/** Take a document's other files through what just happened to it: the
 *  rendition and the sidecar beside a markdown file, the sidecar alone beside
 *  an html file that is a document of its own. A rendition of a pair leaves
 *  the sidecar with its markdown. Best-effort: the document itself has
 *  already gone through. */
async function carryParts(
  from: string,
  to: string,
  kind: EntryKind,
  carry: (from: string, to: string) => Promise<unknown>,
): Promise<LeftBehind[]> {
  const left: LeftBehind[] = [];
  const part = async (pFrom: string, pTo: string, which: DocumentPart) => {
    if (!(await present(pFrom))) return;
    try {
      await carry(pFrom, pTo);
    } catch (e) {
      left.push({ part: which, error: String(e) });
    }
  };
  if (kind !== "file") return left;
  if (MD_EXT_RE.test(from) && MD_EXT_RE.test(to)) {
    await part(htmlSiblingOf(from), htmlSiblingOf(to), "rendition");
    await part(metaFileOf(from), metaFileOf(to), "meta");
  } else if (HTML_EXT_RE.test(from) && HTML_EXT_RE.test(to)) {
    if (!(await present(mdSiblingOf(from)))) await part(metaFileOf(from), metaFileOf(to), "meta");
  }
  return left;
}

const trash = (path: string) => invoke<string>("trash_file", { path });

// What `watch` was last told is on screen: an event names a file, and this is
// how it becomes a document and a part of it.
let watched: WatchedDocument[] = [];

const filesOf = (doc: WatchedDocument): string[] => {
  const files = [doc.path, metaFileOf(doc.path)];
  if (doc.rendition !== null && doc.rendition !== doc.path) files.push(doc.rendition);
  return files;
};

function changesAt(file: string): DocumentChange[] {
  const out: DocumentChange[] = [];
  for (const doc of watched) {
    if (file === doc.path) out.push({ path: doc.path, part: "text" });
    else if (file === metaFileOf(doc.path)) out.push({ path: doc.path, part: "meta" });
    else if (doc.rendition !== null && file === doc.rendition) out.push({ path: doc.path, part: "rendition" });
  }
  return out;
}

const documents: Documents = {
  async open(path) {
    const doc = await read(path);
    const sibling = MD_EXT_RE.test(path) ? htmlSiblingOf(path) : null;
    const rendition = sibling !== null && (await present(sibling)) ? sibling : null;
    return { ...doc, meta: await readMeta(path), rendition };
  },
  read,
  meta: readMeta,

  // The sidecar first, then the text, and a save fails whole: a sidecar
  // that can't be written leaves the text unwritten too. While the text is
  // written the sidecar holds the records of both the text on disk and the
  // new one (`sidecarWhileWriting`), so a failure or a stop between the two
  // writes never leaves a text without its records; the records it drops go
  // once the text is down.
  async save(path, parts, over) {
    const { text, meta } = parts;
    if (meta === undefined) return { rev: text === undefined ? null : await write(path, text, over) };
    const sidecar = metaFileOf(path);
    if (text === undefined) {
      await write(sidecar, meta, null);
      return { rev: null };
    }
    const meanwhile = sidecarWhileWriting(await readMeta(path), meta);
    await write(sidecar, meanwhile, null);
    const rev = await write(path, text, over);
    if (meanwhile !== meta) {
      // Only drops are left: failing them leaves records nothing uses.
      await write(sidecar, meta, null).catch((e) => console.error("sidecar tidy failed", e));
    }
    return { rev };
  },

  exists,
  tree: (root, all) => invoke<TreeNode>("list_md_tree", { path: root, all }),
  async documents(root) {
    const synced = await invoke<WorkspaceDocument[] | null>("cloud_documents", { root });
    if (synced) return synced;
    // A folder that doesn't sync: its tree, which lists documents only.
    const found: WorkspaceDocument[] = [];
    const walk = (node: TreeNode) => {
      if (node.kind === "dir") node.children.forEach(walk);
      else found.push({ path: node.path.slice(root.length + 1), fileId: null, section: null });
    };
    walk(await invoke<TreeNode>("list_md_tree", { path: root, all: false }));
    return documentsOf(found);
  },
  create: (path, kind) => invoke<void>(kind === "file" ? "create_file" : "create_dir", { path }),

  async move(from, to, kind) {
    await invoke("move_path", { from, to });
    return carryParts(from, to, kind, (a, b) => invoke("move_path", { from: a, to: b }));
  },

  async copy(from, to, kind) {
    await invoke("copy_path", { from, to });
    return carryParts(from, to, kind, (a, b) => invoke("copy_path", { from: a, to: b }));
  },

  removeUndoes: true,
  async remove(path, kind) {
    const files = [{ path, trashPath: await trash(path) }];
    const left: LeftBehind[] = [];
    const part = async (p: string, which: DocumentPart) => {
      if (!(await present(p))) return;
      try {
        files.push({ path: p, trashPath: await trash(p) });
      } catch (e) {
        left.push({ part: which, error: String(e) });
      }
    };
    if (kind === "file" && MD_EXT_RE.test(path)) {
      await part(htmlSiblingOf(path), "rendition");
      await part(metaFileOf(path), "meta");
    } else if (kind === "file" && HTML_EXT_RE.test(path)) {
      // An html document of its own owns the sidecar; a rendition of a pair
      // does not: only its own threads go with it, and the markdown's stay.
      if (!(await present(mdSiblingOf(path)))) {
        await part(metaFileOf(path), "meta");
      } else {
        try {
          const r = await invoke<ReadFileResult>("read_file", { path: metaFileOf(path) });
          const meta = parseEntityMeta(r.contents);
          if (meta.hthreads.length > 0) {
            await invoke("write_file", {
              path: metaFileOf(path),
              contents: serializeEntityMeta({ ...meta, hthreads: [] }),
              expected: r.snapshot,
            });
          }
        } catch {
          // no sidecar, or it moved underneath: nothing to take out
        }
      }
    }
    return {
      left,
      // Straight back out of the Trash, to where each file was.
      undo: async () => {
        const failed: { path: string; error: string }[] = [];
        let restored = false;
        for (const f of files) {
          try {
            await invoke("restore_trashed", { trashPath: f.trashPath, originalPath: f.path });
            restored = true;
          } catch (e) {
            failed.push({ path: f.path, error: String(e) });
          }
        }
        return { restored, failed };
      },
    };
  },

  // One watcher holds every file of every document on screen. A file that is
  // not there yet is not watched, so the set is given again once a document's
  // first sidecar has been written.
  async watch(docs) {
    watched = docs;
    const files = [...new Set(docs.flatMap(filesOf))];
    if (files.length === 0) await invoke("unwatch_file");
    else await invoke("watch_file", { path: files[0], extras: files.slice(1) });
  },
  onChange: (cb) =>
    on<{ path: string }>("file-externally-changed", (e) => {
      for (const change of changesAt(e.path)) cb(change);
    }),

  // What the search lists is capped far past what a screen holds
  // (`MAX_SEARCH_FILES`, lib.rs), and it does not count what it left out.
  search: async (root, query, caseSensitive, tags) => ({
    files: await invoke<FileMatches[]>("search_workspace", { root, query, caseSensitive, tags }),
    more: 0,
  }),
  searchByCase: true,
};

/* ---------- The file clipboard (`FileClipboard` in lib.rs) ---------- */

const fileClipboard: FileClipboard = {
  get: async () => (await invoke<FileClipboardPayload | null>("clipboard_get_files")) ?? null,
  set: (items, cut) => invoke<void>("clipboard_set_files", { items, cut }),
  clear: () => invoke<void>("clipboard_clear_files"),
  onChange: (cb) => on<FileClipboardPayload | null>("file-clipboard-changed", (clip) => cb(clip ?? null)),
};

/* ---------- The cloud (src-tauri/src/cloud.rs) ---------- */

const cloud: Cloud = {
  status: async () => listOf<CloudStatus>(await invoke<unknown>("cloud_status")),
  onStatus: (cb) => on<unknown>("cloud-status", (statuses) => cb(listOf<CloudStatus>(statuses))),
  onApplied: (cb) => on("cloud-applied", cb),
  onConflict: (cb) => on("cloud-conflict", cb),
  onSpaceLeft: (cb) => on("cloud-space-left", cb),

  setActivity: (path) => invoke("cloud_set_activity", { path }),
  takeOver: (root, path) => invoke("cloud_take_over", { root, path }),
  link: (path) => invoke("cloud_link", { path }),
  follow: (url) => invoke<string | null>("cloud_follow_link", { url }),

  publish: (path, opts = {}) =>
    invoke("cloud_publish", {
      path,
      slug: opts.slug ?? null,
      title: opts.title ?? null,
      desc: opts.desc ?? null,
    }),
  unpublish: (root, slug) => invoke("cloud_unpublish", { root, slug }),
  setRoot: (root, slug) => invoke("cloud_set_root", { root, slug }),
  pages: (root) => invoke("cloud_pages", { root }),
  pageTakeDown: (root, slug) => invoke("cloud_page_take_down", { root, slug }),
};

const setup: CloudSetup = {
  mintToken: () => invoke("cloud_mint_token"),
  probe: (endpoint, token) => invoke("cloud_probe", { endpoint, token }),
  marker: (root) => invoke("cloud_marker", { root }),
  held: (endpoint) => invoke("cloud_held", { endpoint }),
  parseInvite: (text) => invoke("cloud_parse_invite", { text }),
  redeem: (endpoint, code) => invoke("cloud_redeem", { endpoint, code }),
  recover: (endpoint, key, email, name) => invoke("cloud_recover", { endpoint, key, email, name }),
  connect: (root, endpoint, token, name) => invoke("cloud_connect", { root, endpoint, token, name }),
  join: (endpoint, token) => invoke("cloud_join", { endpoint, token }),
  resume: (root, endpoint, token) => invoke("cloud_resume", { root, endpoint, token }),
  onProgress: (cb) => on("cloud-progress", cb),
};

const sync: CloudSync = {
  syncNow: (root) => invoke("cloud_sync_now", { root }),
  pause: (root, paused) => invoke("cloud_pause", { root, paused }),
  disconnect: (root) => invoke("cloud_disconnect", { root }),
  confirmDeletes: (root) => invoke("cloud_confirm_deletes", { root }),
  confirmAdds: (root, sync) => invoke("cloud_confirm_adds", { root, sync }),
  liftWait: (root) => invoke("cloud_lift_wait", { root }),
  onPendingDeletes: (cb) => on("cloud-pending-deletes", cb),
  onPendingAdds: (cb) => on("cloud-pending-adds", cb),
  onAddressTaken: (cb) => on("cloud-address-taken", cb),
  removed: async () => listOf<CloudRemovedEvent>(await invoke<unknown>("cloud_removed")),
  onRemoved: (cb) => on("cloud-removed", cb),
  recent: (root, limit = null) => invoke("cloud_recent", { root, limit }),
};

const domain: CloudDomain = {
  checkWorker: (root) => invoke("cloud_check_worker", { root }),
  setPlan: (root, plan) => invoke("cloud_set_plan", { root, plan }),
  wipe: (root) => invoke("cloud_wipe", { root }),
};

const access: CloudAccess = {
  people: (root) => invoke("cloud_people", { root }),
  invite: (root, email, name, days) => invoke("cloud_invite", { root, email, name, days }),
  withdrawInvite: (root, inviteId) => invoke("cloud_withdraw_invite", { root, inviteId }),
  setRole: (root, memberId, role) => invoke("cloud_set_role", { root, memberId, role }),
  revokePerson: (root, memberId) => invoke("cloud_revoke_person", { root, memberId }),
  deviceCode: (root) => invoke("cloud_device_code", { root }),
  revokeDevice: (root, tokenId) => invoke("cloud_revoke_device", { root, tokenId }),

  agents: (root) => invoke("cloud_agents", { root }),
  agentAdd: (root, name, scopes) => invoke("cloud_agent_add", { root, name, scopes }),
  agentCode: (root, agentId) => invoke("cloud_agent_code", { root, agentId }),
  agentUpdate: (root, agentId, name, scopes) => invoke("cloud_agent_update", { root, agentId, name, scopes }),
  agentRemove: (root, agentId) => invoke("cloud_agent_remove", { root, agentId }),
  agentRevokeMachine: (root, agentId, tokenId) =>
    invoke("cloud_agent_revoke_machine", { root, agentId, tokenId }),
};

const spaces: CloudSpaces = {
  spaceCreate: (root, name, members, from = null) => invoke("cloud_space_create", { root, name, members, from }),
  spaceMember: (root, id, memberId, add) => invoke("cloud_space_member", { root, id, memberId, add }),
  spaceDelete: (root, id) => invoke("cloud_space_delete", { root, id }),
};

/* ---------- Version history (src-tauri/src/versions.rs) ---------- */

const versions: Versions = {
  status: async () => listOf<VersionsStatus>(await invoke<unknown>("versions_status")),
  onStatus: (cb) => on<unknown>("versions-status", (statuses) => cb(listOf<VersionsStatus>(statuses))),
  onApplied: (cb) => on("versions-applied", cb),
  onProgress: (cb) => on("versions-progress", cb),
  snapshots: async (root) => listOf<SnapshotMeta>(await invoke<unknown>("versions_snapshots", { root })),
  captureNow: (root, opts = {}) =>
    invoke("versions_capture_now", { root, reason: opts.reason ?? null, label: opts.label ?? null }),
  setPinned: (root, ts, pinned, label) =>
    invoke("versions_set_pinned", { root, ts, pinned, label: label ?? null }),
  setEnabled: (enabled) => invoke("versions_set_enabled", { enabled }),
  history: async (path) =>
    (await invoke<FileHistory | null>("versions_history", { path })) ?? { root: "", currentHash: null, versions: [] },
  read: (root, hash) => invoke("versions_read", { root, hash }),
  diff: (root, opts = {}) =>
    invoke("versions_diff", { root, path: opts.path ?? null, from: opts.from ?? null, to: opts.to ?? null }),
  restoreFile: (root, path, opts = {}) =>
    invoke("versions_restore_file", {
      root,
      path,
      ts: opts.ts ?? null,
      hash: opts.hash ?? null,
      text: opts.text ?? null,
    }),
  snapshotDiff: (root, ts) => invoke("versions_snapshot_diff", { root, ts }),
  deleted: async (root) => listOf<DeletedFile>(await invoke<unknown>("versions_deleted", { root })),
  restoreSnapshot: (root, ts, paths) => invoke("versions_restore_snapshot", { root, ts, paths: paths ?? null }),
  setHorizon: (root, days) => invoke("versions_set_horizon", { root, days }),
  setCloudHorizon: (root, days) => invoke("versions_set_cloud_horizon", { root, days }),
  stores: async () => listOf<StoreInfo>(await invoke<unknown>("versions_stores")),
  forget: (key) => invoke("versions_forget", { key }),
  export: (root, dest) => invoke("versions_export", { root, dest }),
};

/* ---------- Opens from outside (src-tauri/src/external_open.rs) ---------- */

const shows: Shows = {
  take: () => invoke<Show[]>("take_window_shows"),
  // `SHOWS_EVENT` in external_open.rs — change both.
  onArrive: (cb) => on("window-shows", cb),
};

/* ---------- Windows ---------- */

const windows: Windows = {
  init: () => invoke<WindowInit>("take_window_init"),
  pendingFolder: () => invoke<string | null>("take_pending_folder"),
  report: (content) => void invoke("register_window_content", content),
  openInNew: (target) =>
    invoke("open_in_window", {
      folder: "folder" in target ? target.folder : null,
      file: "file" in target ? target.file : null,
    }),
  focusNext: (backward) => void invoke("focus_next_window", { backward }),
  setTheme: (theme) => void getCurrentWindow().setTheme(theme).catch(() => {}),
  onCloseRequested: (cb) => {
    const un = getCurrentWindow().onCloseRequested(cb);
    return () => {
      void un.then((f) => f());
    };
  },
  close: () => void getCurrentWindow().close(),
  destroy: () => void getCurrentWindow().destroy(),
  // ⌘Q closes no window, so the backend asks each one to flush and waits,
  // about a second, for every ack (`begin_quit_flush` in lib.rs).
  onQuit: (flush) =>
    on("quit-flush-requested", async () => {
      try {
        await flush();
      } finally {
        void invoke("quit_flush_ack");
      }
    }),
  onAddTag: (cb) =>
    on<string>("menu-add-tag", (label) => {
      if (label === getCurrentWindow().label) cb();
    }),
  startDragging: () => void getCurrentWindow().startDragging(),
  toggleMaximize: () => void getCurrentWindow().toggleMaximize(),
};

/* ---------- Untitled notes (src-tauri/src/untitled.rs) ---------- */

const untitled: UntitledNotes = {
  dir: () => invoke<string>("untitled_dir"),
  discard: (path) => invoke<void>("discard_untitled", { path }),
  orphans: (open) => invoke<string[]>("orphaned_untitled", { open }),
};

/* ---------- This Mac's files ---------- */

const picked = (chosen: string | string[] | null): string | null => (typeof chosen === "string" ? chosen : null);

const localFiles: LocalFiles = {
  pickFolder: async () => picked(await openDialog({ directory: true, multiple: false })),
  pickDocument: async () =>
    picked(
      await openDialog({
        multiple: false,
        filters: [{ name: "Documents", extensions: ["md", "markdown", "mdown", "mkd", "html"] }],
      }),
    ),
  pickSaveAs: (defaultPath) =>
    saveDialog({
      title: "Save note",
      defaultPath,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    }),
  reveal: (path) => invoke<void>("reveal_in_finder", { path }),
};

/* ---------- PDF export (src-tauri/src/pdf_export.rs) ---------- */

const pdf: PdfExport = {
  // Listening before asking, so the first stage cannot slip past. The Rust
  // side runs one export at a time and refuses a second.
  async export(path, onProgress) {
    const unlisten = await listen<PdfProgress>("pdf-export-progress", (e) => onProgress(e.payload));
    try {
      return await invoke<string>("export_pdf", { path });
    } finally {
      unlisten();
    }
  },
};

/* ---------- Updates ----------
   Tauri's updater plugin fetches the release manifest (endpoint and public
   key in tauri.conf.json), downloads the signed bundle, verifies it and swaps
   it in place; the process plugin restarts into it. */

const updater: Updater = {
  version: getVersion,
  async check() {
    const found = await check();
    if (!found) return null;
    return {
      version: found.version,
      notes: found.body ?? "",
      async install(onProgress) {
        let total = 0;
        let done = 0;
        await found.downloadAndInstall((ev) => {
          if (ev.event === "Started") {
            total = ev.data.contentLength ?? 0;
            done = 0;
          } else if (ev.event === "Progress") {
            done += ev.data.chunkLength;
            onProgress({ phase: "downloading", fraction: total ? done / total : 0 });
          } else if (ev.event === "Finished") {
            onProgress({ phase: "installing" });
          }
        });
        await relaunch();
      },
    };
  },
};

export const macBackend: Backend = {
  documents,
  cloud,
  fileClipboard,
  openExternal: (url) => invoke<void>("open_external", { url }),
  // `device_name` in lib.rs: the Mac's own name.
  authorName: () => invoke<string>("device_name"),
  setTitle: (title) => void getCurrentWindow().setTitle(title),
  device: "Mac",
  setup,
  sync,
  domain,
  access,
  spaces,
  versions,
  shows,
  windows,
  untitled,
  localFiles,
  pdf,
  updater,
};
