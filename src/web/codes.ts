// The codes a browser makes: an invite, a code for another device of its
// person's own, an agent's login code. Each is made as a Mac makes it
// (engine/src/cloud/invite.rs): 100 random bits written as twenty of
// Crockford's characters, shown once, and only its sha256 sent to the worker
// — which hashes what is typed back the same way (`canonicalCode`,
// cloud-worker/src/layout.ts). Nothing here stores one.
//
// The alphabet, the two prefixes, the two lines and the lifetimes are
// invite.rs's, whose tests read this file: **change both.**

/** Crockford's base32: no I, no L, no O, no U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 20 characters × 5 bits = 100 bits. */
const CODE_LEN = 20;
/** Written in groups of five. */
const GROUP = 5;
/** What an invite's code, and a device's, opens with. */
const PREFIX = "dkln";
/** What an agent's login code opens with. */
const AGENT_PREFIX = "dkla";
/** The word the line of an invite opens with. */
const KEYWORD = "doklin-invite";

/** How long an invite is good for when nobody says otherwise, and the most
 *  the worker takes. */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
/** How long a device code is good for. */
const DEVICE_CODE_MINUTES = 60;
/** How long an agent's login code is good for. */
const AGENT_CODE_MINUTES = 60;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A code in its canonical form, the twenty characters, from thirteen bytes
 *  of randomness: each character is five of their first hundred bits. */
export function codeOf(bytes: Uint8Array): string {
  let code = "";
  for (let i = 0; i < CODE_LEN; i += 1) {
    const bit = i * 5;
    const window = (bytes[bit >> 3] << 8) | bytes[(bit >> 3) + 1];
    code += ALPHABET[(window >> (11 - (bit % 8))) & 31];
  }
  return code;
}

const grouped = (prefix: string, canonical: string): string =>
  `${prefix}-${(canonical.match(new RegExp(`.{${GROUP}}`, "g")) ?? []).join("-")}`;

/** `sha256(canonical)`, hex: all of a code that leaves this page. */
async function hashOf(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh code: as it is written under `prefix`, and as it is sent. */
async function mint(prefix: string): Promise<{ code: string; hash: string }> {
  const canonical = codeOf(crypto.getRandomValues(new Uint8Array(13)));
  return { code: grouped(prefix, canonical), hash: await hashOf(canonical) };
}

/** What a freshly made code is: the code as it is shown, the line that
 *  carries it, what the worker is sent in its place, and when it runs out. */
export type Minted = { code: string; line: string; hash: string; expiresAt: number };

/** An invite for somebody, good for `days` (7 when nobody says). The line is
 *  `doklin-invite https://notes.example.com dkln-K7QM2-9XVR4-8TBHN-3WGYD`. */
export async function mintInvite(endpoint: string, days: number | null, now = Date.now()): Promise<Minted> {
  const { code, hash } = await mint(PREFIX);
  const kept = Math.min(Math.max(Math.floor(days ?? DEFAULT_DAYS), 1), MAX_DAYS);
  return { code, line: `${KEYWORD} ${endpoint} ${code}`, hash, expiresAt: now + kept * DAY_MS };
}

/** A code for another device of the person's own: an invite's line, to the
 *  worker their pending invite. */
export async function mintDeviceCode(endpoint: string, now = Date.now()): Promise<Minted> {
  const { code, hash } = await mint(PREFIX);
  return { code, line: `${KEYWORD} ${endpoint} ${code}`, hash, expiresAt: now + DEVICE_CODE_MINUTES * MINUTE_MS };
}

/** An agent's login code. The line is the command its machine runs:
 *  `doklin login https://notes.example.com dkla-K7QM2-9XVR4-8TBHN-3WGYD`. */
export async function mintAgentLogin(endpoint: string, now = Date.now()): Promise<Minted> {
  const { code, hash } = await mint(AGENT_PREFIX);
  return { code, line: `doklin login ${endpoint} ${code}`, hash, expiresAt: now + AGENT_CODE_MINUTES * MINUTE_MS };
}
