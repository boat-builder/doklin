// The three primitives credentials are made of, in a file of their own so
// auth.ts and members.ts can both have them without importing each other.
// Nothing here is Doklin-specific; everything here is about not leaking.

/** A sha256 hex digest — how every credential is stored and compared. */
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

/** `bytes` from the CSPRNG, hex. 32 is what a bearer token gets — the same
 *  256 bits the app mints the owner's with (src-tauri/src/cloud/scan.rs). */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
