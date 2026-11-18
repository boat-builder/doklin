// Unit tests for the codes a browser makes (src/web/codes.ts): an invite, a
// code for another device, an agent's login code. What they hold is that the
// worker can redeem what the page shows — the code the page hashed is the
// code the worker hashes when it is typed back (`canonicalCode`,
// cloud-worker/src/layout.ts) — and that a browser spells a code from its
// random bytes as a Mac does (engine/src/cloud/invite.rs, whose own tests
// hold the same pair of bytes and characters). Run:
//
//   node verify-harness/webcodes.test.mjs
//
// (Compiles the modules through vite, as webmerge.test.mjs does.)
import { build } from "vite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(...file) {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    build: { write: false, target: "es2022", lib: { entry: path.join(repoRoot, ...file), formats: ["es"], fileName: "m" } },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  return import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
}
const { codeOf, mintInvite, mintDeviceCode, mintAgentLogin } = await load("src", "web", "codes.ts");
const { canonicalCode, normalizeCode } = await load("cloud-worker", "src", "layout.ts");

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok   ${name}`);
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const AT = "https://notes.example.com";
const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SHAPE = /^(-[0-9A-HJKMNP-TV-Z]{5}){4}$/;

await test("thirteen bytes spell twenty characters, five bits each — the pair invite.rs holds", () => {
  const counting = Uint8Array.of(0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6, 0x35, 0xcf, 0x84, 0x65, 0x30);
  assert.equal(codeOf(counting), "0123456789ABCDEFGHJK");
  assert.equal(codeOf(new Uint8Array(13).fill(0xff)), "ZZZZZZZZZZZZZZZZZZZZ");
});

await test("an invite: the Mac's line, the worker's canonical form hashed, seven days unless said, thirty at most", async () => {
  const made = await mintInvite(AT, null, NOW);
  assert.ok(made.code.startsWith("dkln") && SHAPE.test(made.code.slice(4)), made.code);
  assert.equal(made.line, `doklin-invite ${AT} ${made.code}`);
  const canonical = normalizeCode(made.code);
  assert.ok(canonical, "the worker reads it as a code");
  assert.equal(made.hash, sha256(canonical), "what the page sent is what the worker will hash when the code is typed back");
  assert.equal(normalizeCode(made.code.toLowerCase().replaceAll("-", " ")), canonical, "however it is typed back");
  assert.equal(made.expiresAt, NOW + 7 * DAY);
  assert.equal((await mintInvite(AT, 3, NOW)).expiresAt, NOW + 3 * DAY);
  assert.equal((await mintInvite(AT, 90, NOW)).expiresAt, NOW + 30 * DAY);
  assert.equal((await mintInvite(AT, 0, NOW)).expiresAt, NOW + DAY);
});

await test("a device code: an invite's line, good for an hour", async () => {
  const made = await mintDeviceCode(AT, NOW);
  assert.equal(made.line, `doklin-invite ${AT} ${made.code}`);
  assert.equal(made.hash, sha256(normalizeCode(made.code)));
  assert.equal(made.expiresAt, NOW + 60 * MINUTE);
});

await test("an agent's login code: its own prefix, the command that logs it in, good for an hour", async () => {
  const made = await mintAgentLogin(AT, NOW);
  assert.ok(made.code.startsWith("dkla") && SHAPE.test(made.code.slice(4)), made.code);
  assert.equal(made.line, `doklin login ${AT} ${made.code}`);
  assert.equal(made.hash, sha256(canonicalCode(made.code, "DKLA")));
  assert.equal(made.expiresAt, NOW + 60 * MINUTE);
});

await test("no two codes are one, and each is a code to the worker", async () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const { code } = await mintDeviceCode(AT, NOW);
    assert.ok(normalizeCode(code), code);
    seen.add(code);
  }
  assert.equal(seen.size, 500);
});

console.log(`\n${passed} passed`);
