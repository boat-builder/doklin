// Who is calling. Every /api route runs through `authenticate`: the bearer is
// hashed and compared with the owner secret's hash in constant time, then —
// when that is not it — looked up as auth/tokens/<sha256>.json, the record
// an invite mints for a member (docs/cloud.md §5.4, §8.1). No
// invite exists yet, so today the lookup finds nothing; it is here so that
// invites are an addition, not a change. Keying credential objects by their
// own hash makes resolving a bearer ONE strongly-consistent R2 get and makes
// revocation (delete the object) take effect on the very next request.

import type { Env } from "./env";
import { ID_RE, MAX_NAME_LEN, tokenKey } from "./layout";

export type Role = "owner" | "member";

export type Auth = {
  role: Role;
  /** "owner" for the OWNER_TOKEN secret; a minted token's own id otherwise. */
  tokenId: string;
  name: string;
  /** The token record's key in the bucket — null for the owner secret, which lives in the worker's env. */
  key: string | null;
  /** The calling device, from x-doklin-device (null when the header is missing or malformed). */
  deviceId: string | null;
};

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equality that takes the same time whichever character differs. */
export function timingEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The device a request speaks for (`x-doklin-device`), or null. Attribution only — never authority. */
export function deviceIdOf(request: Request): string | null {
  const id = request.headers.get("x-doklin-device")?.trim() ?? "";
  return ID_RE.test(id) ? id : null;
}

/** Resolve the bearer to an identity, or null. */
export async function authenticate(request: Request, env: Env): Promise<Auth | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const bearer = header.slice("Bearer ".length).trim();
  if (!bearer) return null;
  const deviceId = deviceIdOf(request);

  const bearerHash = await sha256Hex(bearer);
  if (env.OWNER_TOKEN && timingEq(bearerHash, await sha256Hex(env.OWNER_TOKEN))) {
    return { role: "owner", tokenId: "owner", name: "Owner", key: null, deviceId };
  }

  const key = tokenKey(bearerHash);
  const obj = await env.DATA.get(key);
  if (!obj) return null;
  let record: unknown;
  try {
    record = await obj.json();
  } catch {
    return null; // a corrupt token record is a dead credential, not a crash
  }
  if (record === null || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  return {
    role: r.role === "owner" ? "owner" : "member",
    tokenId: typeof r.id === "string" ? r.id : "unknown",
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, MAX_NAME_LEN) : "Member",
    key,
    deviceId,
  };
}
