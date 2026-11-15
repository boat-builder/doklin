// Drives the iOS app's core (ios/DoklinKit) end to end — its client and its
// models against the real worker, served by serve-worker.mjs over the seed
// workspace (cloud-worker/test/seed.mjs). The views are not driven: they
// need a simulator. Everything they call is.
//
// It starts the harness worker itself, on a port of its own, builds the
// engine this machine links (scripts/ios-engine.sh host), adds the agents
// the tests log in as and mints the device code the engine joins with — the
// way the owner's app does, sending only a code's hash — and runs the
// package's tests with the address and the codes in the environment:
//
//   DOKLIN_TEST_ENDPOINT      http://localhost:<port>
//   DOKLIN_TEST_CODES         {"<agent>": "dkla-…"} — each code works once
//   DOKLIN_TEST_DEVICE_LINE   doklin-invite http://localhost:<port> dkln-… — works once
//
// Run (a Mac with Xcode, or any machine with a Swift toolchain, and cargo):
//
//   node verify-harness/drive-ios.mjs
//   node verify-harness/drive-ios.mjs -- <command…>   # another way to run `swift test`,
//                                                     # e.g. inside a container on the host network
//
// Without this, `swift test` in ios/DoklinKit runs everything that needs no
// worker and skips the rest.
//
// And the app itself, on a Mac with Xcode:
//
//   node verify-harness/drive-ios.mjs --app
//
// builds it, starts an iPhone simulator and runs ios/DoklinUITests — one
// journey through the real screens against this worker: log in, browse, read,
// edit, tick a box, search, relaunch, log out. What was on screen at each
// step is printed (the lines that begin `UI>`), and the whole xcodebuild log
// and the screenshots are left in $DOKLIN_DRIVE_OUT (a temporary folder when
// unset; the path is printed).
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
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
// (engine/src/cloud/invite.rs): twenty Crockford characters, hashed in
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
  app: ALL,
};
const codes = {};
for (const [name, scopes] of Object.entries(AGENTS)) codes[name] = await addAgent(`${name} (iOS drive)`, scopes);

const asOwner = { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-doklin-device": "d-drive", "x-doklin-client": "0.0.0-drive" };

// A device is added by a person, for themselves, and the domain's secret is
// nobody until its holder says who they are: say so, as the Mac's People
// view does, then mint the code a second device of theirs joins with.
{
  const res = await fetch(`${WORKER}/api/auth/members`, {
    method: "POST",
    headers: asOwner,
    body: JSON.stringify({ email: "ada@example.com", name: "Ada (drive)" }),
  });
  if (!res.ok) throw new Error(`could not say who the creator is: ${res.status} ${await res.text()}`);
}
async function deviceLine() {
  const canonical = [...randomBytes(20)].map((b) => CROCKFORD[b % 32]).join("");
  const res = await fetch(`${WORKER}/api/auth/devices/code`, {
    method: "POST",
    headers: asOwner,
    body: JSON.stringify({ codeHash: sha256(canonical), expiresAt: Date.now() + 3_600_000 }),
  });
  if (res.status !== 201) throw new Error(`could not mint a device code: ${res.status} ${await res.text()}`);
  return `doklin-invite ${WORKER} dkln-${canonical.match(/.{5}/g).join("-")}`;
}

/** Whether the shared workspace's manifest lists a file at `path`. */
async function onTheDomain(path) {
  const res = await fetch(`${WORKER}/api/manifest`, { headers: asOwner });
  if (!res.ok) throw new Error(`could not read the manifest: ${res.status}`);
  const manifest = await res.json();
  return Object.values(manifest.files ?? {}).some((file) => file.path === path && !file.deleted);
}

/* ---------- The core: `swift test`, or the command after `--` ---------- */

async function driveCore() {
  const split = process.argv.indexOf("--");
  // The package links the engine; `swift test` is told where this machine's is.
  const engine = join(ROOT, "ios/Engine/host");
  if (split < 0) execFileSync(join(ROOT, "scripts/ios-engine.sh"), ["host"], { stdio: "inherit" });
  const command =
    split >= 0 ? process.argv.slice(split + 1) : ["swift", "test", "--package-path", join(ROOT, "ios/DoklinKit"), "-Xlinker", `-L${engine}`];
  console.log(`running: ${command.join(" ")}`);
  const status = await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, DOKLIN_TEST_ENDPOINT: WORKER, DOKLIN_TEST_CODES: JSON.stringify(codes), DOKLIN_TEST_DEVICE_LINE: line },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (status !== 0) return status;
  // What the engine said it synced, asked of the domain itself.
  if (!(await onTheDomain("From the phone.md"))) {
    console.error("the note the engine wrote never reached the domain");
    return 1;
  }
  console.log("the note the engine wrote is on the domain");
  return 0;
}

/* ---------- The app: its UI tests in a simulator ---------- */

/** An iPhone simulator this Xcode can run: the newest runtime its SDK covers. */
function pickSimulator() {
  const xcrun = (...args) => execFileSync("xcrun", args, { encoding: "utf8" });
  const sdk = xcrun("--sdk", "iphonesimulator", "--show-sdk-version").trim().split(".").map(Number);
  const newerThanSdk = ([major, minor]) => major > sdk[0] || (major === sdk[0] && minor > (sdk[1] ?? 0));
  const runtimes = Object.entries(JSON.parse(xcrun("simctl", "list", "devices", "available", "-j")).devices)
    .map(([runtime, devices]) => ({ version: /iOS-(\d+)-(\d+)/.exec(runtime)?.slice(1).map(Number), devices }))
    .filter((r) => r.version && !newerThanSdk(r.version))
    .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);
  for (const { version, devices } of runtimes) {
    const phones = devices.filter((d) => d.name.startsWith("iPhone"));
    const phone = phones.find((d) => !d.name.includes("SE")) ?? phones[0];
    if (phone) return { udid: phone.udid, name: `${phone.name}, iOS ${version.join(".")}` };
  }
  throw new Error("There is no iPhone simulator this Xcode can run — add one under Xcode → Settings → Components.");
}

async function driveApp() {
  const out = process.env.DOKLIN_DRIVE_OUT || mkdtempSync(join(tmpdir(), "doklin-drive-ios-"));
  mkdirSync(out, { recursive: true });
  const result = join(out, "DoklinUITests.xcresult");
  rmSync(result, { recursive: true, force: true });
  const simulator = pickSimulator();
  console.log(`driving the app on ${simulator.name}; the full log and the screenshots go to ${out}`);

  const log = createWriteStream(join(out, "xcodebuild.log"));
  // What a reader of the run wants: the screens, the tests, and anything that went wrong.
  const worthSaying = /^UI> |^Test (Case|Suite) |^\s*Executed |^\*\* |error:|: error |Testing failed|Testing started/;
  const status = await new Promise((resolve, reject) => {
    const child = spawn(
      "xcodebuild",
      [
        "test",
        "-project", join(ROOT, "ios/Doklin.xcodeproj"),
        "-scheme", "Doklin",
        "-destination", `id=${simulator.udid}`,
        "-resultBundlePath", result,
        ...(process.env.DOKLIN_DERIVED_DATA ? ["-derivedDataPath", process.env.DOKLIN_DERIVED_DATA] : []),
      ],
      {
        // xcodebuild hands the test runner every variable named TEST_RUNNER_<name>, as <name>.
        env: { ...process.env, TEST_RUNNER_DOKLIN_TEST_ENDPOINT: WORKER, TEST_RUNNER_DOKLIN_TEST_CODES: JSON.stringify(codes) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let rest = "";
    const hear = (chunk) => {
      log.write(chunk);
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) if (worthSaying.test(line)) console.log(line);
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  await new Promise((resolve) => log.end(resolve));

  // The screenshots out of the result bundle, as files anybody can open. Best effort.
  try {
    execFileSync("xcrun", ["xcresulttool", "export", "attachments", "--path", result, "--output-path", join(out, "screenshots")], { stdio: "ignore" });
  } catch {
    console.log("the screenshots stay inside the result bundle — this Xcode's xcresulttool does not export them");
  }
  return status;
}

const line = await deviceLine();
const status = await (process.argv.includes("--app") ? driveApp() : driveCore());
cleanup();
process.exit(status);
