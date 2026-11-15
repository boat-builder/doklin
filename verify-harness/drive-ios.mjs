// Drives the iOS app's core (ios/DoklinKit) end to end — its client and its
// models against the real worker, served by serve-worker.mjs over the seed
// workspace (cloud-worker/test/seed.mjs). The views are not driven: they
// need a simulator. Everything they call is.
//
// It starts the harness worker itself, on a port of its own, adds the agents
// the tests log in as — the way the owner's app does, minting a code and
// sending only its hash — and runs the package's tests with the address and
// the codes in the environment:
//
//   DOKLIN_TEST_ENDPOINT   http://localhost:<port>
//   DOKLIN_TEST_CODES      {"<agent>": "dkla-…"} — each code works once
//
// Run (a Mac with Xcode, or any machine with a Swift toolchain):
//
//   node verify-harness/drive-ios.mjs
//   node verify-harness/drive-ios.mjs -- <command…>   # another way to run `swift test`,
//                                                     # e.g. inside a container on the host network
//
// Without this, `swift test` in ios/DoklinKit runs everything that needs no
// worker and skips the rest.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const OWNER = "owner-secret"; // what serve-worker.mjs binds the domain with
const sha256 = (input) => createHash("sha256").update(input).digest("hex");

let workerPid = null;
function cleanup() {
  if (workerPid === null) return;
  try {
    process.kill(workerPid);
  } catch {
    // already gone
  }
  workerPid = null;
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

/** A port nothing is listening on. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const WORKER_PORT = await freePort();
const WORKER = `http://localhost:${WORKER_PORT}`;
console.log(`starting the harness worker on ${WORKER}…`);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(ROOT, "verify-harness/serve-worker.mjs"), "--no-mermaid"], {
    env: { ...process.env, PORT: String(WORKER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  workerPid = child.pid;
  let said = "";
  const hear = (chunk) => {
    said += chunk;
    if (said.includes("cloud worker on")) resolve();
  };
  child.stdout.on("data", hear);
  child.stderr.on("data", hear);
  child.on("error", reject);
  child.on("exit", (code) => {
    workerPid = null;
    reject(new Error(`the harness worker stopped (exit ${code}) before it was serving:\n${said}`));
  });
  setTimeout(() => reject(new Error(`the harness worker did not start within three minutes:\n${said}`)), 180_000).unref();
});

// The app mints the code, shows it once and sends only its sha256
// (src-tauri/src/cloud/invite.rs): twenty Crockford characters, hashed in
// their canonical form, shown as dkla-XXXXX-XXXXX-XXXXX-XXXXX.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
async function addAgent(name, scopes) {
  const canonical = [...randomBytes(20)].map((b) => CROCKFORD[b % 32]).join("");
  const res = await fetch(`${WORKER}/api/auth/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-doklin-device": "d-drive", "x-doklin-client": "0.0.0-drive" },
    body: JSON.stringify({ name, scopes, codeHash: sha256(canonical), expiresAt: Date.now() + 3_600_000 }),
  });
  if (res.status !== 201) throw new Error(`could not add the agent ${name}: ${res.status} ${await res.text()}`);
  return `dkla-${canonical.match(/.{5}/g).join("-")}`;
}

// One agent a test that logs in: a code is spent by its first login.
const ALL = ["read", "comment", "edit", "publish"];
const AGENTS = {
  phone: ALL,
  tasks: ALL,
  comments: ALL,
  publisher: ALL,
  reader: ["read"],
  searcher: ["read"],
  leaving: ALL,
  twice: ALL,
};
const codes = {};
for (const [name, scopes] of Object.entries(AGENTS)) codes[name] = await addAgent(`${name} (iOS drive)`, scopes);

const split = process.argv.indexOf("--");
const command = split >= 0 ? process.argv.slice(split + 1) : ["swift", "test", "--package-path", join(ROOT, "ios/DoklinKit")];
console.log(`running: ${command.join(" ")}`);
const status = await new Promise((resolve, reject) => {
  const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, DOKLIN_TEST_ENDPOINT: WORKER, DOKLIN_TEST_CODES: JSON.stringify(codes) },
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
cleanup();
process.exit(status);
