// The browser version's one way to the worker: every request it makes is
// made here, and nothing outside src/web/ fetches at all (eslint holds it).
//
// The sign-in is a cookie this script cannot read (cloud-worker/src/auth.ts):
// the browser sends it on a request to the page's own origin, and the worker
// counts it only on such a request. So nothing here holds a credential, and
// every address is a path on this origin.
//
// Every request is counted, per UTC day, the way a Mac counts its own
// (engine/src/cloud/pace.rs): the domain's worker runs on an account whose
// requests are capped a day, and a request it refuses has been counted
// already.
//
// Every request also says which release this page is (`x-doklin-client`,
// cloud-worker/src/clients.ts: change both). The page is the worker's own, so
// a worker of another release refuses it with a 410: this tab was open
// across an update of the domain, and a reload brings the page it serves now.

import { version as RELEASE } from "../../package.json";

/** Where this browser keeps its device id: what presence, leases and the
 *  Devices list know it by. One per browser, shared by its tabs. */
const DEVICE_KEY = "doklin:web:device";
/** Today's requests: `{ day, sent, told }`. Shared by this browser's tabs. */
const USED_KEY = "doklin:web:used";
/** How often a request carries the count (`x-doklin-used`): `REPORT_EVERY_MS`, pace.rs. */
const REPORT_EVERY_MS = 15 * 60 * 1000;
const DAY_MS = 86_400_000;

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser that keeps nothing still works: it is a new device each load.
  }
};

/** This browser's device id (`ID_RE`, cloud-worker/src/layout.ts), made on first use. */
export function deviceId(): string {
  const kept = stored(DEVICE_KEY);
  if (kept && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(kept)) return kept;
  const made = `d-${randomHex(8)}`;
  store(DEVICE_KEY, made);
  return made;
}

/** What this browser is called wherever a device is named — Devices, who is
 *  here, who holds a document: "Chrome on Windows". */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  const system = /Windows/.test(ua)
    ? "Windows"
    : /Macintosh|Mac OS X/.test(ua)
      ? "a Mac"
      : /CrOS/.test(ua)
        ? "a Chromebook"
        : /Linux/.test(ua)
          ? "Linux"
          : null;
  return system ? `${browser} on ${system}` : browser;
}

type Used = { day: number; sent: number; told: number };

function readUsed(now: number): Used {
  const day = Math.floor(now / DAY_MS);
  try {
    const u = JSON.parse(stored(USED_KEY) ?? "null") as Partial<Used> | null;
    if (u && u.day === day && typeof u.sent === "number" && typeof u.told === "number") {
      return { day, sent: u.sent, told: u.told };
    }
  } catch {
    // unreadable: the day starts over
  }
  return { day, sent: 0, told: 0 };
}

/** This browser's requests to the domain today (UTC day). */
export const usedToday = (now = Date.now()): number => readUsed(now).sent;

/** The next 00:00 UTC, when the day's limits start over. */
export const nextDay = (now = Date.now()): number => (Math.floor(now / DAY_MS) + 1) * DAY_MS;

/** A request the domain refused: its status and its sentence. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
    /** How long the domain asked this device to wait, in seconds (a `429`). */
    readonly retryAfter: number | null,
    /** Cloudflare's own page for an account past its day's requests: nothing
     *  on the domain answers until 00:00 UTC. */
    readonly dailyLimit: boolean,
  ) {
    super(message);
    this.name = "Refused";
  }
}

/** The domain did not answer at all: no network, or no domain. */
export class Unreachable extends Error {
  constructor() {
    super("The workspace's domain isn't answering.");
    this.name = "Unreachable";
  }
}

let signedOut: () => void = () => {};
/** What happens when the worker says this browser is not signed in any more. */
export function onSignedOut(cb: () => void): void {
  signedOut = cb;
}

let outdated: () => void = () => {};
/** What happens when the worker says this page is of another release than
 *  its own: a request it answered `410`. */
export function onOutdated(cb: () => void): void {
  outdated = cb;
}

export type Ask = {
  body?: unknown;
  headers?: Record<string, string>;
  /** The request is to outlive the page that made it: one sent as the tab
   *  goes. A browser carries 64 KB of these at a time (`KEEPALIVE_BYTES`). */
  keepalive?: boolean;
};

/** How much a request that outlives its page may carry: the browsers' limit
 *  is 64 KiB for all of a page's at once, headers aside. */
export const KEEPALIVE_BYTES = 60_000;

/** One request to the worker. The answer is returned whatever its status;
 *  `Unreachable` is thrown when there is none. */
export async function send(method: string, path: string, ask: Ask = {}): Promise<Response> {
  const now = Date.now();
  const used = readUsed(now);
  used.sent += 1;
  const headers: Record<string, string> = {
    "x-doklin-device": deviceId(),
    "x-doklin-client": `web/${RELEASE}`,
    ...ask.headers,
  };
  if (now - used.told >= REPORT_EVERY_MS) {
    headers["x-doklin-used"] = String(used.sent);
    used.told = now;
  }
  store(USED_KEY, JSON.stringify(used));
  if (ask.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: ask.body === undefined ? undefined : JSON.stringify(ask.body),
      keepalive: ask.keepalive === true,
      // Never another origin's answer, and never a redirect followed there.
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
    });
  } catch {
    throw new Unreachable();
  }
  if (res.status === 410) outdated();
  return res;
}

/** A refusal, read as the engine reads one (`expect_status`,
 *  engine/src/cloud/remote.rs): the worker's own sentence where the answer
 *  carries one. Cloudflare answers for an account past its daily requests
 *  before the worker runs, with a page of its own whose status is not
 *  documented, so that one is known by what it says ("1027"). */
async function refusalOf(res: Response): Promise<Refused> {
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // not the worker's own answer
  }
  const dailyLimit = body === null && text.includes("1027");
  const said = dailyLimit
    ? "Cloudflare’s requests for today are used up."
    : typeof body?.error === "string"
      ? body.error
      : `The domain answered ${res.status}.`;
  const wait = Number(res.headers.get("retry-after")?.trim());
  return new Refused(
    res.status,
    said.charAt(0).toUpperCase() + said.slice(1),
    body ?? {},
    Number.isFinite(wait) && wait > 0 ? wait : null,
    dailyLimit,
  );
}

/** One request whose answer has to be a success. A `401` after sign-in means
 *  the sign-in ended somewhere else (signed out from Devices, access taken
 *  away): the app is told, and the refusal is still thrown. */
export async function ask(method: string, path: string, opts: Ask = {}): Promise<Response> {
  const res = await send(method, path, opts);
  if (res.ok || res.status === 304) return res;
  const refused = await refusalOf(res);
  if (res.status === 401) signedOut();
  throw refused;
}

/** The same, read as JSON. */
export async function askJson<T>(method: string, path: string, opts: Ask = {}): Promise<T> {
  return (await (await ask(method, path, opts)).json()) as T;
}

/** A refusal made of an answer already in hand. */
export const refused = refusalOf;
