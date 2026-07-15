// Public sharing — registry, connections, API client, and OG image rendering.
//
// A share means: this local document (keyed by its absolute path) is published
// read-only at <endpoint>/<id>. The registry lives in localStorage
// ("doklin:shares"); the remote side holds {title, markdown?, html?} JSON plus
// an OG png per page, written through the share worker's Bearer-token API
// (share-worker/src/index.js). The endpoints + tokens come from
// <app_data_dir>/share.json — a machine-local file that never enters the repo.
// Several connections (one per domain/backend) can be configured at once;
// every entry records which one it was published to.
//
// The remote mirrors the DISK: every push reads the files fresh, and each
// entry fingerprints what was pushed so a reconciliation pass (app launch /
// window focus) can re-push documents edited from outside the app.

import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { stripComments } from "./criticMarkup";
import type { HtmlThread } from "./htmlComments";

export type FileSnapshot = { mtime_ms: number; size: number };

// What one rendition's local file looked like when it was last pushed: the
// disk snapshot is a cheap pre-filter (stat, no read), the content hash is the
// truth (a touched-but-identical file — git checkout, `touch` — must not count
// as changed). Reconciliation compares the disk against these to decide
// whether the remote copy is stale.
export type PushedFingerprint = { snap: FileSnapshot | null; hash: string };

export type ShareEntry = {
  id: string;
  path: string;
  kind: "draft" | "file";
  title: string;
  sharedAt: number;
  updatedAt: number;
  // True when the public page is behind access codes. A local mirror of the
  // worker's truth for badges/summaries — the codes editor corrects it
  // whenever it talks to the backend.
  protected?: boolean;
  // Fingerprints of the content last successfully pushed, per rendition
  // (null = that version didn't exist at push time). Absent on entries from
  // before reconciliation existed — the next pass re-pushes once to establish.
  pushed?: { md: PushedFingerprint | null; html: PushedFingerprint | null };
  // The folder share (CollectionEntry.id) this page is included in, if any.
  // Membership is always explicit — sharing a folder shares no files by
  // itself, and sharing a file inside a shared folder doesn't enroll it.
  collectionId?: string;
  // The revision counter this Mac last pushed to (or pulled from) the
  // backend — the `baseRev` its next push claims, so the worker can tell an
  // unseen web edit from ordinary device-to-device churn. Absent on entries
  // that haven't pushed to a v8 worker yet.
  pushedRev?: number;
  // A web edit that diverged from local changes and is waiting on the owner's
  // call (shown in the share popover until resolved one way or the other).
  webConflict?: { rev: number; by: string; at: string | null };
  // Html-rendition comment threads, synced with the worker's per-page pool
  // (v10): the pool revision this Mac last agreed with, and the thread state
  // both sides held at that moment — the BASE of the three-way merge
  // (htmlComments.ts mergeHtmlThreads) that folds web comments into the
  // local sidecar and local ones into the pool, with deletions sticking on
  // both sides. Absent until the first sync. `commentsDirty` marks a local
  // sidecar change that hasn't reached the pool yet (a comment made offline,
  // or a push that failed): it survives restarts so the reconcile pass keeps
  // retrying until the pool catches up, cleared on a successful sync.
  commentsRev?: number;
  commentsBase?: HtmlThread[];
  commentsDirty?: boolean;
  // Which connection (ShareConnection.id) this page was published to.
  connectionId: string;
  // For a document in a cloud-synced workspace: who published it (their
  // device/person name), set only on entries mirrored FROM the workspace
  // manifest — your own shares don't carry it, so the UI can say
  // "Shared by Alice" exactly when that's news.
  sharedBy?: string;
  // True once this share has been SEEN in its synced workspace's manifest
  // (App.tsx's mirror sets it, nothing else). Meaningful only under a synced
  // root: with it, "no longer in the manifest" reads as remotely unshared
  // (drop the entry); without it, as never-synced (publish it there).
  wsSynced?: boolean;
};

// A folder (or whole-workspace) share: one published "collection" page whose
// public side is a table-of-contents home linking to the member pages. The
// members are ordinary ShareEntry pages — the collection only carries the
// membership list, so every page keeps its own URL and its own sync machinery.
export type CollectionEntry = {
  id: string;
  path: string; // absolute directory path
  // Defaults to the folder name; a rename follows it while it still matches.
  // Editable in the folder-share dialog — a custom title stops following.
  title: string;
  // Owner-written blurb shown under the public TOC's title. Absent = none.
  description?: string;
  members: string[]; // absolute paths of included files, each with a ShareEntry
  sharedAt: number;
  updatedAt: number;
  // Hash of the manifest last successfully pushed (title + items), so
  // reconciliation can tell a stale remote TOC without a network read.
  pushedHash?: string;
  // Title baked into the last-pushed OG image; a mismatch re-renders it.
  pushedTitle?: string;
  // Which connection this collection lives on. Members can only be pages on
  // the same connection.
  connectionId: string;
  // Mirror bookkeeping for synced workspaces — see ShareEntry.
  sharedBy?: string;
  wsSynced?: boolean;
  // Folder codes cover the TOC and every member page — see ShareEntry.
  protected?: boolean;
};

// One member reference inside a pushed manifest: the page's id, its display
// title, and its path relative to the shared folder (used only to group the
// public TOC into directories).
export type CollectionItem = { id: string; title: string; path: string };

// The wire-level credentials the API client needs. A ShareConnection carries
// these plus an identity, so it can be passed anywhere a ShareConfig goes.
export type ShareConfig = { endpoint: string; token: string };

// One configured share backend. Entries reference connections by id, so links
// keep resolving to the right domain no matter what's added or removed later.
export type ShareConnection = { id: string; endpoint: string; token: string };

export type ShareConnectionsState = {
  connections: ShareConnection[];
  // The connection new shares go to when nothing more specific applies (the
  // per-workspace map below wins when set).
  defaultId: string | null;
};

const SHARES_STORAGE_KEY = "doklin:shares";
const COLLECTIONS_STORAGE_KEY = "doklin:collections";
const WORKSPACE_CONNECTIONS_KEY = "doklin:share-connection-by-root";

export function readShares(): Record<string, ShareEntry> {
  try {
    const raw = localStorage.getItem(SHARES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ShareEntry> = {};
    for (const [path, e] of Object.entries(parsed as Record<string, ShareEntry>)) {
      if (
        e &&
        typeof e.id === "string" &&
        typeof e.path === "string" &&
        typeof e.connectionId === "string" &&
        (e.kind === "draft" || e.kind === "file")
      ) {
        out[path] = e;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeShares(shares: Record<string, ShareEntry>) {
  try {
    localStorage.setItem(SHARES_STORAGE_KEY, JSON.stringify(shares));
  } catch {
    // Quota: the comment-thread bases (full thread contents, for the 3-way
    // merge) are the heavy, purely-derived part of an entry — drop them and
    // retry so the actual share registry always persists. A dropped base only
    // costs a first-sync's precision (deletions could resurrect once), which
    // the next sync re-establishes; losing the whole registry would unshare
    // everything.
    try {
      const trimmed: Record<string, ShareEntry> = {};
      for (const [path, e] of Object.entries(shares)) {
        const { commentsBase: _drop, ...rest } = e;
        trimmed[path] = rest;
      }
      localStorage.setItem(SHARES_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // still over quota — nothing more we can safely shed here
    }
  }
}

// Folder shares, keyed by absolute directory path (mirrors the shares
// registry's shape and lifetime).
export function readCollections(): Record<string, CollectionEntry> {
  try {
    const raw = localStorage.getItem(COLLECTIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, CollectionEntry> = {};
    for (const [path, e] of Object.entries(parsed as Record<string, CollectionEntry>)) {
      if (
        e &&
        typeof e.id === "string" &&
        typeof e.path === "string" &&
        typeof e.title === "string" &&
        typeof e.connectionId === "string" &&
        Array.isArray(e.members)
      ) {
        out[path] = { ...e, members: e.members.filter((m) => typeof m === "string") };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCollections(collections: Record<string, CollectionEntry>) {
  try {
    localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
  } catch {
    // ignore
  }
}

/* ---------- Connections (share.json) ---------- */

const EMPTY_CONNECTIONS: ShareConnectionsState = { connections: [], defaultId: null };

// Canonical endpoint shape: no surrounding whitespace, no trailing slash.
// Everything that stores or compares endpoints (saves, dedupe) must run
// through this, or "same endpoint" checks quietly stop matching.
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

export function newConnectionId(): string {
  return `c-${generateShareId(10)}`;
}

// THE resolution rule for which connection owns an entry — every path that
// renders a link or pushes/deletes must agree, so it lives here once. An
// entry maps to its connection or, when that connection was removed, to null
// (degrade, don't guess).
export function resolveConnection(
  state: ShareConnectionsState,
  entry: { connectionId: string } | null,
): ShareConnection | null {
  if (!entry) return null;
  return state.connections.find((c) => c.id === entry.connectionId) ?? null;
}

// File shape: {version: 2, connections: [{id, endpoint, token}], defaultId}.
// Anything else — missing, malformed, hand-truncated — reads as unconfigured.
function parseConnections(contents: string): ShareConnectionsState {
  const parsed = JSON.parse(contents);
  if (!Array.isArray(parsed?.connections)) return EMPTY_CONNECTIONS;
  const connections: ShareConnection[] = [];
  for (const c of parsed.connections) {
    if (
      c &&
      typeof c.id === "string" &&
      typeof c.endpoint === "string" &&
      typeof c.token === "string" &&
      c.endpoint.trim() &&
      !connections.some((seen) => seen.id === c.id)
    ) {
      connections.push({ id: c.id, endpoint: normalizeEndpoint(c.endpoint), token: c.token });
    }
  }
  if (connections.length === 0) return EMPTY_CONNECTIONS;
  const defaultId =
    typeof parsed.defaultId === "string" && connections.some((c) => c.id === parsed.defaultId)
      ? parsed.defaultId
      : connections[0].id;
  return { connections, defaultId };
}

// Reads <app_data_dir>/share.json once and caches the result for the session.
// A missing or malformed file just means sharing is unconfigured.
let connectionsPromise: Promise<ShareConnectionsState> | null = null;

export function getConnections(): Promise<ShareConnectionsState> {
  if (!connectionsPromise) {
    connectionsPromise = (async () => {
      try {
        const dir = await appDataDir();
        const path = await join(dir, "share.json");
        const result = await invoke<{ contents: string }>("read_file", { path });
        return parseConnections(result.contents);
      } catch {
        return EMPTY_CONNECTIONS;
      }
    })();
  }
  return connectionsPromise;
}

// Writes <app_data_dir>/share.json and refreshes the session cache. An empty
// list deletes the file — sharing turns unconfigured, existing pages stay
// live remotely.
export async function saveConnections(state: ShareConnectionsState): Promise<ShareConnectionsState> {
  if (state.connections.length === 0) {
    await invoke("delete_share_config");
    connectionsPromise = Promise.resolve(EMPTY_CONNECTIONS);
    return EMPTY_CONNECTIONS;
  }
  const def =
    state.connections.find((c) => c.id === state.defaultId) ?? state.connections[0];
  const next: ShareConnectionsState = { connections: state.connections, defaultId: def.id };
  const dir = await appDataDir();
  const path = await join(dir, "share.json");
  await invoke("write_file", {
    path,
    contents: `${JSON.stringify({ version: 2, ...next }, null, 2)}\n`,
    expected: null, // settings file: last write wins
  });
  connectionsPromise = Promise.resolve(next);
  return next;
}

/* ---------- Per-workspace default connection ---------- */

// workspaceRoot (absolute path, or "" for no folder open) -> connection id.
// Consulted before the global default when a share is created.
export function readWorkspaceConnectionMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(WORKSPACE_CONNECTIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [root, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string") out[root] = id;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeWorkspaceConnectionMap(map: Record<string, string>) {
  try {
    localStorage.setItem(WORKSPACE_CONNECTIONS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

// Mirrors the worker's rules (plus "api" etc. are reserved there; a random id
// can't collide with them since they're too short-lived to matter, but a
// hand-edited slug is validated against the same shape).
export const SHARE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

// The single-file worker bundle every release publishes (see
// scripts/bundle-worker.mjs + the release workflow). Setup and update
// instructions point agents/terminals here so deploying a backend is one
// download — no clone, no build. `latest` is deliberate: a newer worker is
// always compatible with an older app (the API only grows).
export const WORKER_BUNDLE_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/doklin-worker.js";

// No 0/1/i/l/o — a share id should survive being read off a screen or aloud.
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

// nanoid-style: crypto randomness, rejection-sampled so every character is
// equally likely (256 isn't a multiple of 31 — plain modulo would slightly
// favor the first few letters). 31^8 ≈ 8.5e11 ids at the default length.
export function generateShareId(length = 8): string {
  const limit = 256 - (256 % ID_ALPHABET.length);
  let id = "";
  while (id.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue;
      id += ID_ALPHABET[b % ID_ALPHABET.length];
      if (id.length === length) break;
    }
  }
  return id;
}

// Both fall back to "" while unconfigured — the UI only renders share URLs
// once a config exists, so nothing user-visible depends on the fallback.
export function shareUrl(config: ShareConfig | null, id: string): string {
  return `${config?.endpoint ?? ""}/${id}`;
}

export function shareHost(config: ShareConfig | null): string {
  return (config?.endpoint ?? "").replace(/^https?:\/\//, "");
}

/* ---------- API client ---------- */

function apiFetch(config: ShareConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(init?.headers ?? {}),
    },
  });
}

// The two renditions a share can carry: the markdown document and/or a
// standalone html version of it (see App.tsx's readShareParts).
export type ShareParts = { markdown: string | null; html: string | null };

/* ---------- Document titles ---------- */

// A document that opens with an H1 has named itself — the public page, the
// TOC row, and the OG image should all say that, not the file name. Only a
// LEADING heading counts (nothing above it but blank lines, comments aside):
// an H1 halfway down is a section, not a title. Inline markdown is stripped
// so "# **Q3** plan" titles as "Q3 plan".
function markdownLeadTitle(md: string): string | null {
  const lines = stripComments(md).split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const m = lines[i]?.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/);
  if (!m) return null;
  const text = m[1]
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  return text ? text.slice(0, 256) : null;
}

// An html-only document's <title> plays the same role as a markdown H1.
function htmlDocTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const text = m[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 256) : null;
}

// The share title a document gives ITSELF, or null to fall back to the file
// name. The markdown is the document of record, so its lead H1 wins; the
// html <title> only speaks for html-only shares.
export function deriveDocTitle(parts: ShareParts): string | null {
  if (parts.markdown !== null) return markdownLeadTitle(parts.markdown);
  if (parts.html !== null) return htmlDocTitle(parts.html);
  return null;
}

// SHA-256 hex of a rendition's raw local content — the `hash` half of a
// PushedFingerprint. Hashed pre-strip (comments intact), since reconciliation
// only ever compares local content against local content.
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

// A push refused because the page carries a web edit the app hasn't seen
// (worker v8; the app sent `baseRev` and the worker's revision moved past it
// via /<id>/edit). Carries what the caller needs to pull or surface it.
export class SharePushConflictError extends Error {
  rev: number;
  webEdit: PageWebEdit | null;
  constructor(rev: number, webEdit: PageWebEdit | null) {
    super(
      webEdit?.by
        ? `This page was edited on the web by ${webEdit.by}.`
        : "This page was edited on the web.",
    );
    this.name = "SharePushConflictError";
    this.rev = rev;
    this.webEdit = webEdit;
  }
}

// Publish (or update) a page. The markdown travels WITH its CriticMarkup
// comments (v10 workers): the worker strips them at render time for
// view-role and public visitors, and serves them — the same threads the
// desktop shows — to comment/edit-role sessions. The full record is sent
// every time (the worker doesn't merge), so a rendition that no longer
// exists locally also disappears remotely — and so does the collection
// back-reference (the public page's "back to the folder" crumb) when the
// page is no longer included in a folder share. A page published from a
// synced workspace sends that workspace's id (`ws`): the worker stamps it,
// and from then on every member of the workspace can keep the page fresh or
// stop it — not just whoever pushed first. The stamp is sticky worker-side,
// so pushes that omit it never downgrade a page.
//
// `baseRev` (v8 workers) is the revision this Mac last pushed or pulled: when
// sent, a page that meanwhile took a WEB edit answers 409 (thrown here as
// SharePushConflictError) instead of silently clobbering it. Omitting baseRev
// keeps the old clobbering behavior — that's the explicit "keep mine" path.
// Returns the revision the worker stored (null from pre-v8 workers).
export async function pushPage(
  config: ShareConfig,
  id: string,
  title: string,
  parts: ShareParts,
  collection?: { id: string; title: string } | null,
  ws?: string | null,
  baseRev?: number | null,
): Promise<{ rev: number | null }> {
  const res = await apiFetch(config, `/api/pages/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      markdown: parts.markdown,
      html: parts.html,
      ...(collection ? { collection } : {}),
      ...(ws ? { ws } : {}),
      ...(typeof baseRev === "number" ? { baseRev } : {}),
    }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as {
      rev?: unknown;
      webEdit?: PageWebEdit | null;
    } | null;
    if (typeof body?.rev === "number") {
      throw new SharePushConflictError(body.rev, body.webEdit ?? null);
    }
  }
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { rev?: unknown } | null;
  return { rev: typeof body?.rev === "number" ? body.rev : null };
}

/* ---------- Web edits: pulling them back ----------

   A v8 worker lets restricted visitors with an "edit" code rewrite the page's
   markdown on the web. The page record counts revisions (`rev`) and stamps
   {webEdit: {by, at}} while the latest write came from the web; the app pulls
   the markdown through /content and folds it into the local file (App.tsx's
   reconcile pass), clearing the stamp with its next push. */

export type PageWebEdit = { by: string; at: string | null };

export type PageContent = {
  title: string;
  markdown: string | null;
  hasHtml: boolean;
  htmlStale: boolean;
  rev: number;
  webEdit: PageWebEdit | null;
};

export async function fetchPageContent(config: ShareConfig, id: string): Promise<PageContent> {
  const res = await apiFetch(config, `/api/pages/${id}/content`);
  if (!res.ok) throw await accessErrorFrom(config, res, 8);
  const body = (await res.json().catch(() => null)) as Partial<PageContent> | null;
  if (!body || typeof body !== "object") throw new Error("content read failed");
  return {
    title: typeof body.title === "string" ? body.title : "Untitled",
    markdown: typeof body.markdown === "string" ? body.markdown : null,
    hasHtml: body.hasHtml === true,
    htmlStale: body.htmlStale === true,
    rev: typeof body.rev === "number" ? body.rev : 1,
    webEdit:
      body.webEdit && typeof body.webEdit.by === "string"
        ? { by: body.webEdit.by, at: body.webEdit.at ?? null }
        : null,
  };
}

/* ---------- Web comments ----------

   Comments posted by restricted visitors whose code carries the comment (or
   edit) role. They live beside the page in their own object; the owner reads
   and moderates them here. `label` names the code that posted, `name` is
   whatever the visitor typed (optional). */

// The pool holds THREADS in the app's own sidecar shape (htmlComments.ts's
// HtmlThread — anchor + entries), plus per-entry provenance the worker
// stamps on web-originated entries (eid + which access code wrote it). It is
// a small rev-guarded document: readers get {rev, threads}; a push swaps the
// whole list against the rev it was built on, and a lost race answers 409
// with the current state to merge against.

export type PageThreadsSnapshot = { rev: number; threads: HtmlThread[] };

export async function fetchPageThreads(
  config: ShareConfig,
  id: string,
): Promise<PageThreadsSnapshot> {
  const res = await apiFetch(config, `/api/pages/${id}/comments`);
  if (!res.ok) throw await accessErrorFrom(config, res, 10);
  const body = (await res.json().catch(() => null)) as {
    rev?: unknown;
    threads?: HtmlThread[];
    comments?: unknown;
  } | null;
  // A pre-v10 worker answers this route 200 with the old flat {comments}
  // shape and no thread pool — distinguishable from an empty v10 pool by the
  // missing `threads` array. Treating it as outdated (rather than as "no
  // comments") keeps thread sync from silently no-opping against a backend
  // that can't hold threads, and routes the owner to redeploy.
  // TODO(legacy-cleanup): drop the flat-{comments} detection once v8/v9
  // workers are no longer in the wild — then a missing `threads` is simply an
  // empty pool.
  if (!Array.isArray(body?.threads)) {
    if (Array.isArray(body?.comments)) throw new ShareWorkerOutdatedError();
    return { rev: typeof body?.rev === "number" ? body.rev : 0, threads: [] };
  }
  return { rev: typeof body?.rev === "number" ? body.rev : 0, threads: body.threads };
}

export type PageThreadsPush =
  | { kind: "ok"; rev: number; threads: HtmlThread[] }
  | { kind: "conflict"; rev: number; threads: HtmlThread[] };

export async function pushPageThreads(
  config: ShareConfig,
  id: string,
  baseRev: number,
  threads: HtmlThread[],
): Promise<PageThreadsPush> {
  const res = await apiFetch(config, `/api/pages/${id}/comments`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRev, threads }),
  });
  if (res.ok || res.status === 409) {
    const body = (await res.json().catch(() => null)) as {
      rev?: unknown;
      threads?: HtmlThread[];
    } | null;
    return {
      kind: res.ok ? "ok" : "conflict",
      rev: typeof body?.rev === "number" ? body.rev : baseRev,
      threads: Array.isArray(body?.threads) ? body.threads : threads,
    };
  }
  throw await accessErrorFrom(config, res, 10);
}

export async function deletePageThread(
  config: ShareConfig,
  id: string,
  threadId: string,
): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}/comments/${threadId}`, {
    method: "DELETE",
  });
  // 404 = already gone; the outcome stands.
  if (!res.ok && res.status !== 404) throw await accessErrorFrom(config, res, 10);
}

// Thrown when the deployed worker predates a feature the app just used —
// folder shares (an old PUT validation 400s manifests) or the site config API
// (an old router 404s /api/site). The fix is always redeploying the worker,
// so the UI can route to the setup guide instead of showing a bare error.
export class ShareWorkerOutdatedError extends Error {
  constructor() {
    super(
      "Your share worker is an older version. Redeploy it with the latest worker code — the setup guide has it.",
    );
    this.name = "ShareWorkerOutdatedError";
  }
}

/* ---------- Worker version (update detection) ---------- */

// The WORKER_VERSION constant baked into a worker build, read from its
// source. The app bundles the latest worker code (virtual:share-worker-code),
// so parsing that — rather than mirroring a constant here — means app and
// worker can never drift apart silently. 0 = unparseable, which disables
// update nags rather than inventing them.
export function parseWorkerVersion(code: string): number {
  const m = code.match(/^const WORKER_VERSION = (\d+);$/m);
  return m ? Number(m[1]) : 0;
}

// The version a live deployment reports. /api/meta arrived in version 2, so a
// 404 positively identifies a version-1 worker; anything else (offline, bad
// token, server error) throws — unknown must not read as outdated.
export async function fetchWorkerVersion(config: ShareConfig): Promise<number> {
  const res = await apiFetch(config, "/api/meta");
  if (res.status === 404) return 1;
  if (!res.ok) throw new Error(`version check failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
  return typeof body?.version === "number" && body.version > 0 ? body.version : 1;
}

/* ---------- Site config (landing page branding + root page) ---------- */

// Mirror of the worker's site.json: landing-page branding plus the optional
// page that replaces the landing page entirely. Full record every push, like
// pages — a missing field means unset.
export type SiteConfig = {
  ownerName?: string;
  ownerLink?: string;
  downloadUrl?: string;
  rootPageId?: string;
  updatedAt?: string;
};

export async function fetchSiteConfig(config: ShareConfig): Promise<SiteConfig> {
  const res = await apiFetch(config, "/api/site");
  if (res.status === 404) throw new ShareWorkerOutdatedError();
  if (!res.ok) throw new Error(`site config read failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { site?: SiteConfig } | null;
  return body?.site && typeof body.site === "object" ? body.site : {};
}

export async function pushSiteConfig(config: ShareConfig, site: SiteConfig): Promise<void> {
  const res = await apiFetch(config, "/api/site", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(site),
  });
  if (res.status === 404) throw new ShareWorkerOutdatedError();
  if (!res.ok) throw new Error(`site config update failed (${res.status})`);
}

// Publish (or update) a folder share's manifest. Like pushPage, the full
// record is sent every time (a worker predating descriptions just ignores
// that field); the worker stores it verbatim and renders the TOC from it.
export async function pushCollection(
  config: ShareConfig,
  id: string,
  title: string,
  items: CollectionItem[],
  description?: string | null,
  ws?: string | null,
): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      kind: "collection",
      items,
      ...(description ? { description } : {}),
      ...(ws ? { ws } : {}),
    }),
  });
  // An up-to-date worker only 400s a collection push on malformed items (which
  // the app never sends); a pre-collections worker 400s every such body.
  if (res.status === 400) throw new ShareWorkerOutdatedError();
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
}

// Fingerprint of a manifest as it would be pushed, for reconciliation.
export function collectionManifestHash(
  title: string,
  items: CollectionItem[],
  description?: string | null,
): Promise<string> {
  return contentHash(JSON.stringify({ title, description: description ?? null, items }));
}

export async function pushOgImage(config: ShareConfig, id: string, title: string): Promise<void> {
  const png = await renderOgImage(title, shareHost(config));
  const res = await apiFetch(config, `/api/pages/${id}/og`, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: png,
  });
  if (!res.ok) throw new Error(`image upload failed (${res.status})`);
}

export async function deletePage(config: ShareConfig, id: string): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}`, { method: "DELETE" });
  // 404 = already gone remotely; treat as success so a stale entry can be cleared.
  if (!res.ok && res.status !== 404) throw new Error(`unshare failed (${res.status})`);
}

// Every page the backend holds — the whole deployment's list, not this Mac's
// registry (other devices and members publish too). Used by teardown to show
// what an erase would destroy, and by the reconcile pass to spot web edits
// with one request per backend (rev/webEdit ride along on v8 workers).
export type RemotePageInfo = {
  id: string;
  title: string;
  updatedAt: string | null;
  rev?: number | null;
  webEdit?: PageWebEdit | null;
  // The comment pool's revision (v10 workers): null = no pool, otherwise the
  // rev of the last swap (a migrated pre-v10 flat pool reports 1). Absent from
  // pre-v10 workers' listings entirely. Reconcile compares it against the
  // entry's synced rev to spot web comments to pull.
  commentsRev?: number | null;
};

export async function listRemotePages(config: ShareConfig): Promise<RemotePageInfo[]> {
  const res = await apiFetch(config, "/api/pages");
  if (!res.ok) throw new Error(`page list failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { pages?: RemotePageInfo[] } | null;
  return Array.isArray(body?.pages) ? body.pages : [];
}

export async function pageExists(config: ShareConfig, id: string): Promise<boolean> {
  const res = await apiFetch(config, `/api/pages/${id}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`address check failed (${res.status})`);
  return true;
}

// Proves an endpoint + token pair before it's saved: one authenticated list
// call shows the URL resolves, the token matches the worker's SHARE_TOKEN,
// and whatever answered actually speaks the share-worker API — so a typo
// fails here, with a specific message, instead of at the first share.
export async function testShareConfig(config: ShareConfig): Promise<void> {
  let res: Response;
  try {
    res = await apiFetch(config, "/api/pages");
  } catch {
    throw new Error("Could not reach that endpoint. Check the URL and your connection.");
  }
  if (res.status === 401) {
    throw new Error(
      "The endpoint answered but rejected the token. Paste the exact value stored as SHARE_TOKEN.",
    );
  }
  if (!res.ok) throw new Error(`The endpoint answered with an error (${res.status}).`);
  const body = (await res.json().catch(() => null)) as { pages?: unknown } | null;
  if (!body || !Array.isArray(body.pages)) {
    throw new Error("That URL answers, but not like a Doklin share worker.");
  }
}

/* ---------- Visitor access codes ----------

   A share can be protected with NAMED codes ("Acme team" / "sunset-marble-fig"),
   each individually revocable. The worker stores only SHA-256 hashes; the
   plaintext exists in exactly two places — the POST that creates it and this
   Mac's local cache below, so the owner can re-copy a code later. On another
   device the code shows as created-elsewhere: still revocable, never readable.
   Folder-share codes cover the TOC and every member page (a member's own
   codes, if set, take precedence — the worker resolves that). */

/* Each code carries a role (worker v8): what its holder may do on the public
   page. "view" is exactly what codes always were; "comment" opens the page's
   comments section; "edit" additionally opens the web markdown editor. Codes
   from older workers read as "view". */
export type AccessRole = "view" | "comment" | "edit";

export const ACCESS_ROLE_LABELS: Record<AccessRole, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
};

function normalizeRole(raw: unknown): AccessRole {
  return raw === "comment" || raw === "edit" ? raw : "view";
}

export type PageAccessCode = {
  id: string;
  label: string;
  role: AccessRole;
  createdAt: string | null;
};
export type PageAccess = { protected: boolean; codes: PageAccessCode[] };

// 404 on the access/content/comments routes is ambiguous: a worker predating
// the route, or a page that's gone. The caller has a live entry in hand, so we
// disambiguate with the version probe — "outdated" routes to the guided
// redeploy, like folder shares and the site config do. `minVersion` is the
// worker version the route arrived in.
async function accessErrorFrom(
  config: ShareConfig,
  res: Response,
  minVersion = 7,
): Promise<Error> {
  if (res.status === 404) {
    const version = await fetchWorkerVersion(config).catch(() => 0);
    if (version > 0 && version < minVersion) return new ShareWorkerOutdatedError();
    return new Error("That page isn't on the backend anymore.");
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `access update failed (${res.status})`);
}

export async function fetchPageAccess(config: ShareConfig, id: string): Promise<PageAccess> {
  const res = await apiFetch(config, `/api/pages/${id}/access`);
  if (!res.ok) throw await accessErrorFrom(config, res);
  const body = (await res.json().catch(() => null)) as {
    protected?: boolean;
    codes?: (Omit<PageAccessCode, "role"> & { role?: unknown })[];
  } | null;
  return {
    protected: body?.protected === true,
    codes: Array.isArray(body?.codes)
      ? body.codes.map((c) => ({ ...c, role: normalizeRole(c.role) }))
      : [],
  };
}

export async function addPageAccessCode(
  config: ShareConfig,
  id: string,
  label: string,
  code: string,
  role: AccessRole = "view",
): Promise<PageAccessCode> {
  const res = await apiFetch(config, `/api/pages/${id}/access/codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // role rides along only when it grants something: a pre-v8 worker ignores
    // unknown fields, and "view" is exactly its behavior anyway — so this
    // never silently downgrades a grant on an old backend (the UI hides the
    // role picker there; see AccessCodes).
    body: JSON.stringify({ label, code, ...(role !== "view" ? { role } : {}) }),
  });
  if (!res.ok) throw await accessErrorFrom(config, res);
  const body = (await res.json()) as Omit<PageAccessCode, "role"> & { role?: unknown };
  return { ...body, role: normalizeRole(body.role) };
}

// Rename a code or change its role (worker v8). The change reaches visitors
// on their next request — sessions aren't re-minted.
export async function updatePageAccessCode(
  config: ShareConfig,
  id: string,
  codeId: string,
  patch: { label?: string; role?: AccessRole },
): Promise<PageAccessCode> {
  const res = await apiFetch(config, `/api/pages/${id}/access/codes/${codeId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await accessErrorFrom(config, res, 8);
  const body = (await res.json()) as Omit<PageAccessCode, "role"> & { role?: unknown };
  return { ...body, role: normalizeRole(body.role) };
}

export async function removePageAccessCode(
  config: ShareConfig,
  id: string,
  codeId: string,
): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}/access/codes/${codeId}`, {
    method: "DELETE",
  });
  // 404 = already gone (another device revoked it) — the outcome stands.
  if (!res.ok && res.status !== 404) throw await accessErrorFrom(config, res);
}

export async function clearPageAccess(config: ShareConfig, id: string): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}/access`, { method: "DELETE" });
  if (!res.ok) throw await accessErrorFrom(config, res);
}

// Mirrors the worker's normalization (trim/lowercase/NFKC) so what the owner
// sees is byte-for-byte what a visitor's submission hashes to.
export function normalizeAccessCode(raw: string): string {
  return raw.trim().toLowerCase().normalize("NFKC");
}

// A share link that unlocks by itself: the code rides the URL #fragment
// (never sent to servers or logged — the /join invite links work the same
// way), and the gate page's script submits it on arrival.
export function unlockShareUrl(config: ShareConfig | null, id: string, code: string): string {
  return `${shareUrl(config, id)}#c=${encodeURIComponent(code)}`;
}

// Three words from a small curated list: easy to say over a call, easy to
// type on a phone (all lowercase, no homoglyphs), 256³ ≈ 17M combinations
// behind the worker's per-IP unlock rate limit. Owners can always type their
// own instead.
const ACCESS_WORDS = [
  "acorn", "amber", "anchor", "apple", "arrow", "aspen", "atlas", "autumn",
  "badge", "bamboo", "basil", "beacon", "berry", "birch", "bison", "blossom",
  "bolt", "borealis", "breeze", "brick", "bridge", "brook", "bugle", "butter",
  "cabin", "cactus", "candle", "canoe", "canyon", "carbon", "cedar", "chalk",
  "cherry", "china", "cinder", "citrus", "clover", "cobalt", "cocoa", "comet",
  "compass", "copper", "coral", "cotton", "cougar", "cricket", "crystal", "cypress",
  "daisy", "dawn", "delta", "denim", "desert", "dune", "eagle", "echo",
  "ember", "engine", "fable", "falcon", "feather", "fern", "fiddle", "field",
  "fig", "finch", "fjord", "flint", "forest", "fossil", "fox", "frost",
  "galaxy", "garden", "garnet", "gecko", "ginger", "glacier", "goose", "granite",
  "grape", "grove", "guitar", "harbor", "harvest", "hazel", "heron", "hickory",
  "hill", "honey", "horizon", "ibis", "indigo", "iris", "iron", "island",
  "ivory", "jade", "jasper", "jungle", "juniper", "kayak", "kelp", "kite",
  "lagoon", "lake", "lantern", "laurel", "lava", "leaf", "lemon", "lilac",
  "lime", "linen", "lotus", "lunar", "lyric", "magnet", "mango", "maple",
  "marble", "meadow", "melon", "mesa", "mint", "mirror", "mocha", "monsoon",
  "moose", "moss", "mountain", "mulberry", "nectar", "nickel", "north", "nutmeg",
  "oak", "oasis", "ocean", "olive", "onyx", "opal", "orbit", "orchid",
  "osprey", "otter", "owl", "oxide", "palm", "panda", "paper", "peach",
  "peak", "pearl", "pebble", "pecan", "penguin", "peony", "pepper", "petal",
  "pine", "pistachio", "planet", "plum", "pocket", "polar", "pond", "poplar",
  "poppy", "prairie", "prism", "pumpkin", "quail", "quartz", "quiet", "quill",
  "rain", "raven", "reef", "ridge", "river", "robin", "rocket", "rose",
  "rowan", "ruby", "rustic", "saddle", "saffron", "sage", "salmon", "sand",
  "sapphire", "scarlet", "seal", "sequoia", "shadow", "shore", "sierra", "silver",
  "sketch", "sky", "slate", "smoke", "snow", "solar", "sonnet", "sparrow",
  "spice", "spring", "spruce", "stone", "storm", "story", "summit", "sunset",
  "swan", "tango", "teal", "tempo", "thistle", "thunder", "tiger", "timber",
  "topaz", "trail", "tulip", "tundra", "turtle", "umber", "valley", "vanilla",
  "velvet", "verse", "violet", "walnut", "waterfall", "wave", "wheat", "willow",
  "winter", "wolf", "wren", "yarrow", "yonder", "zephyr", "zebra", "zinnia",
];

export function generateAccessCode(): string {
  const pick = () => {
    // Rejection-sampled like generateShareId, so every word is equally likely.
    const limit = 256 - (256 % ACCESS_WORDS.length);
    const bytes = new Uint8Array(8);
    for (;;) {
      crypto.getRandomValues(bytes);
      for (const b of bytes) {
        if (b < limit) return ACCESS_WORDS[b % ACCESS_WORDS.length];
      }
    }
  };
  return `${pick()}-${pick()}-${pick()}`;
}

/* The local plaintext cache: `${connectionId}/${pageId}/${codeId}` -> code.
   Owner-machine convenience only (re-copying a code later); the backend never
   returns plaintext. Entries are dropped when their code is revoked, their
   protection removed, or their share stopped. */

const ACCESS_CODES_STORAGE_KEY = "doklin:access-codes";

function readAccessCodeCache(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCESS_CODES_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAccessCodeCache(cache: Record<string, string>) {
  try {
    localStorage.setItem(ACCESS_CODES_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // ignore
  }
}

const accessCacheKey = (connectionId: string, pageId: string, codeId: string) =>
  `${connectionId}/${pageId}/${codeId}`;

export function rememberAccessCode(
  connectionId: string,
  pageId: string,
  codeId: string,
  code: string,
) {
  const cache = readAccessCodeCache();
  cache[accessCacheKey(connectionId, pageId, codeId)] = code;
  writeAccessCodeCache(cache);
}

export function cachedAccessCode(
  connectionId: string,
  pageId: string,
  codeId: string,
): string | null {
  return readAccessCodeCache()[accessCacheKey(connectionId, pageId, codeId)] ?? null;
}

// codeId omitted = forget every code cached for the page (protection removed
// or share stopped).
export function forgetAccessCodes(connectionId: string, pageId: string, codeId?: string) {
  const cache = readAccessCodeCache();
  const prefix = `${connectionId}/${pageId}/`;
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (codeId ? key === prefix + codeId : key.startsWith(prefix)) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) writeAccessCodeCache(cache);
}

/* ---------- OG image ----------
   1200×630 card drawn with 2d canvas right in the webview, so the worker never
   needs an image library: the app's dark-theme surface, a warm accent tick
   (the comment-highlight orange), the wrapped title, and the site host. */

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderOgImage(title: string, host: string): Promise<Blob> {
  const W = 1200;
  const H = 630;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  ctx.fillStyle = "#191919";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(160, 0, 0, 160, 0, 1000);
  glow.addColorStop(0, "rgba(255, 145, 0, 0.16)");
  glow.addColorStop(1, "rgba(255, 145, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const fontStack =
    '-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif';
  const marginX = 88;
  const maxWidth = W - marginX * 2;

  // Title: 72px, dropping to 56px for long titles, capped at 4 lines.
  const text = title.trim() || "Untitled";
  let size = 72;
  ctx.font = `700 ${size}px ${fontStack}`;
  let lines = wrapText(ctx, text, maxWidth);
  if (lines.length > 3) {
    size = 56;
    ctx.font = `700 ${size}px ${fontStack}`;
    lines = wrapText(ctx, text, maxWidth);
  }
  if (lines.length > 4) {
    lines = lines.slice(0, 4);
    lines[3] = `${lines[3].replace(/\s*\S*$/, "")}…`;
  }

  const lineHeight = Math.round(size * 1.2);
  const blockHeight = lines.length * lineHeight;
  const titleY = Math.max(170, Math.round((H - blockHeight) / 2));

  // Accent tick above the title.
  ctx.fillStyle = "rgba(255, 145, 0, 0.9)";
  ctx.beginPath();
  ctx.roundRect(marginX, titleY - 46, 56, 9, 4.5);
  ctx.fill();

  ctx.fillStyle = "#ebebeb";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, marginX, titleY + i * lineHeight);
  });

  // Footer: a small dot + host.
  const footY = H - 78;
  ctx.fillStyle = "rgba(255, 145, 0, 0.9)";
  ctx.beginPath();
  ctx.arc(marginX + 7, footY + 14, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.font = `500 26px ${fontStack}`;
  ctx.fillText(host, marginX + 28, footY);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("og image encode failed"));
    }, "image/png");
  });
}
