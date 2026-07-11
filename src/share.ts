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
  // Fingerprints of the content last successfully pushed, per rendition
  // (null = that version didn't exist at push time). Absent on entries from
  // before reconciliation existed — the next pass re-pushes once to establish.
  pushed?: { md: PushedFingerprint | null; html: PushedFingerprint | null };
  // The folder share (CollectionEntry.id) this page is included in, if any.
  // Membership is always explicit — sharing a folder shares no files by
  // itself, and sharing a file inside a shared folder doesn't enroll it.
  collectionId?: string;
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
    // ignore
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

// Publish (or update) a page. Comments are stripped before upload so editorial
// notes never reach the public copy — same transform as plain ⌘C. The full
// record is sent every time (the worker doesn't merge), so a rendition that no
// longer exists locally also disappears remotely — and so does the collection
// back-reference (the public page's "back to the folder" crumb) when the page
// is no longer included in a folder share. A page published from a synced
// workspace sends that workspace's id (`ws`): the worker stamps it, and from
// then on every member of the workspace can keep the page fresh or stop it —
// not just whoever pushed first. The stamp is sticky worker-side, so pushes
// that omit it never downgrade a page.
export async function pushPage(
  config: ShareConfig,
  id: string,
  title: string,
  parts: ShareParts,
  collection?: { id: string; title: string } | null,
  ws?: string | null,
): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      markdown: parts.markdown === null ? null : stripComments(parts.markdown),
      html: parts.html,
      ...(collection ? { collection } : {}),
      ...(ws ? { ws } : {}),
    }),
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
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
