// Public sharing — registry, config, API client, and OG image rendering.
//
// A share means: this local document (keyed by its absolute path) is published
// read-only at <endpoint>/<id>. The registry lives in localStorage
// ("doklin:shares"); the remote side holds {title, markdown?, html?} JSON plus
// an OG png per page, written through the share worker's Bearer-token API
// (share-worker/src/index.js). The endpoint + token come from
// <app_data_dir>/share.json — a machine-local file that never enters the repo.
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
};

export type ShareConfig = { endpoint: string; token: string };

const SHARES_STORAGE_KEY = "doklin:shares";

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

// Reads <app_data_dir>/share.json once and caches the result for the session.
// A missing or malformed file just means sharing is unconfigured (null).
let configPromise: Promise<ShareConfig | null> | null = null;

export function getShareConfig(): Promise<ShareConfig | null> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const dir = await appDataDir();
        const path = await join(dir, "share.json");
        const result = await invoke<{ contents: string }>("read_file", { path });
        const parsed = JSON.parse(result.contents);
        if (typeof parsed?.endpoint === "string" && typeof parsed?.token === "string") {
          return {
            endpoint: parsed.endpoint.replace(/\/+$/, ""),
            token: parsed.token,
          };
        }
      } catch {
        // fall through
      }
      return null;
    })();
  }
  return configPromise;
}

// Writes <app_data_dir>/share.json and refreshes the session cache, so sharing
// can be configured (or the token rotated) from inside the app.
export async function saveShareConfig(config: ShareConfig): Promise<void> {
  const dir = await appDataDir();
  const path = await join(dir, "share.json");
  await invoke("write_file", {
    path,
    contents: `${JSON.stringify({ endpoint: config.endpoint, token: config.token }, null, 2)}\n`,
    expected: null, // settings file: last write wins
  });
  configPromise = Promise.resolve(config);
}

// Deletes <app_data_dir>/share.json from disk; sharing turns unconfigured
// until a new token is saved. Existing shares stay live remotely.
export async function deleteShareConfig(): Promise<void> {
  await invoke("delete_share_config");
  configPromise = Promise.resolve(null);
}

// Mirrors the worker's rules (plus "api" etc. are reserved there; a random id
// can't collide with them since they're too short-lived to matter, but a
// hand-edited slug is validated against the same shape).
export const SHARE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

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
// longer exists locally also disappears remotely.
export async function pushPage(
  config: ShareConfig,
  id: string,
  title: string,
  parts: ShareParts,
): Promise<void> {
  const res = await apiFetch(config, `/api/pages/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      markdown: parts.markdown === null ? null : stripComments(parts.markdown),
      html: parts.html,
    }),
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
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
