// The web shell's persistence adapters — everything the desktop app does
// through Tauri IPC, the browser does through the share worker's
// session-gated JSON endpoints (the gate cookie rides every same-origin
// fetch):
//
//   POST /<id>/save           {markdown, baseRev, force?} → {rev} | 409 {rev, by, at}
//   GET  /<id>/html-comments  → {rev, threads}
//   POST /<id>/html-comments  {baseRev, threads} → {rev, threads} | 409 {rev, threads}
//
// Markdown comments need no endpoints of their own: they ARE the markdown
// (CriticMarkup), so the save above carries them, and the worker's
// strip-equality guard is what lets a comment-role session save comment-only
// changes to a document it cannot edit.

import type { HtmlThread } from "../src/htmlComments";

export type SaveResult =
  // Terminal states are distinguished from the transient one on purpose: a
  // 4xx (revoked code, "can't be emptied") is not going to succeed on retry,
  // so it must not be shown as "offline — retrying" forever.
  | { kind: "ok"; rev: number }
  | { kind: "conflict"; rev: number; by: string }
  | { kind: "offline" } // the network failed — retry is worthwhile
  | { kind: "rejected"; message: string }; // the server said no (4xx) — retry won't help

export async function saveMarkdown(
  id: string,
  markdown: string,
  baseRev: number,
  force = false,
): Promise<SaveResult> {
  let res: Response;
  try {
    res = await fetch(`/${id}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown, baseRev, ...(force ? { force: true } : {}) }),
    });
  } catch {
    return { kind: "offline" };
  }
  const body = (await res.json().catch(() => null)) as {
    rev?: number;
    by?: string;
    error?: string;
  } | null;
  if (res.ok && typeof body?.rev === "number") return { kind: "ok", rev: body.rev };
  if (res.status === 409) {
    return { kind: "conflict", rev: body?.rev ?? baseRev, by: body?.by ?? "" };
  }
  if (res.status === 403) {
    return {
      kind: "rejected",
      message: body?.error ?? "Your access code can no longer save this page.",
    };
  }
  // A 5xx is transient (deploys, blips); a 4xx is the request itself.
  if (res.status >= 500) return { kind: "offline" };
  return { kind: "rejected", message: body?.error ?? `Save failed (${res.status}).` };
}

// Best-effort flush while the page is going away: sendBeacon survives
// navigation where fetch may not. The worker accepts the same JSON body.
export function beaconMarkdown(id: string, markdown: string, baseRev: number): void {
  try {
    const blob = new Blob([JSON.stringify({ markdown, baseRev })], {
      type: "application/json",
    });
    navigator.sendBeacon(`/${id}/save`, blob);
  } catch {
    // Nothing to do — the debounced save already tried.
  }
}

/* ---------- HTML rendition threads ---------- */

export type ThreadsSnapshot = { rev: number; threads: HtmlThread[] };

export async function fetchHtmlThreads(id: string): Promise<ThreadsSnapshot> {
  const res = await fetch(`/${id}/html-comments`);
  if (!res.ok) throw new Error(`comments fetch failed (${res.status})`);
  const body = (await res.json()) as Partial<ThreadsSnapshot>;
  return {
    rev: typeof body.rev === "number" ? body.rev : 0,
    threads: Array.isArray(body.threads) ? body.threads : [],
  };
}

export type ThreadsPushResult =
  | { kind: "ok"; rev: number; threads: HtmlThread[] }
  | { kind: "conflict"; rev: number; threads: HtmlThread[] }
  | { kind: "error"; message: string };

export async function pushHtmlThreads(
  id: string,
  threads: HtmlThread[],
  baseRev: number,
): Promise<ThreadsPushResult> {
  let res: Response;
  try {
    res = await fetch(`/${id}/html-comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev, threads }),
    });
  } catch {
    return { kind: "error", message: "offline" };
  }
  const body = (await res.json().catch(() => null)) as Partial<ThreadsSnapshot> & {
    error?: string;
  } | null;
  const snap = {
    rev: typeof body?.rev === "number" ? body.rev : baseRev,
    threads: Array.isArray(body?.threads) ? body.threads : threads,
  };
  if (res.ok) return { kind: "ok", ...snap };
  if (res.status === 409) return { kind: "conflict", ...snap };
  return { kind: "error", message: body?.error ?? `comments save failed (${res.status})` };
}

export function beaconHtmlThreads(id: string, threads: HtmlThread[], baseRev: number): void {
  try {
    const blob = new Blob([JSON.stringify({ baseRev, threads })], {
      type: "application/json",
    });
    navigator.sendBeacon(`/${id}/html-comments`, blob);
  } catch {
    // best effort only
  }
}
