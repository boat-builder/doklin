// Drives the iOS app's core (ios/DoklinKit) end to end — the engine it
// links and the models the screens use, against the real worker, served by
// serve-worker.mjs over the seed workspace (cloud-worker/test/seed.mjs). The
// views are not driven: they need a simulator. Everything they call is.
//
// It starts the harness worker itself, on a port of its own, builds the
// engine this machine links (scripts/ios-engine.sh host), mints the device
// code the phone joins with — the way a Mac's Add a device does, sending
// only the code's hash — and runs the package's tests with the line in the
// environment:
//
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
// journey per test class through the real screens against this worker
// (DoklinUITests: join, browse, read, edit, tick a box, search, relaunch,
// remove from this iPhone; PeopleUITests: people, devices, agents, who is
// here, restricted folders; HistoryUITests: a note's versions, the
// workspace's moments, recently deleted; CommentsUITests: a thread read,
// started, answered and removed, a note published and stopped, published
// pages), each then checked against what it left on the domain. A journey asks this script, at an address it
// serves, for what only the domain's side can do: its line, another device
// editing a document, and a restricted folder deleted elsewhere. What was on screen at each step is printed (the
// lines that begin `UI>`), and the whole xcodebuild log and the screenshots
// are left in $DOKLIN_DRIVE_OUT (a temporary folder when unset; the path is
// printed). DOKLIN_ONLY=<class> runs one class; DOKLIN_SIMULATOR=<udid>
// picks the simulator rather than the newest iPhone.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_FILES } from "../cloud-worker/test/seed.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
/** The superadmin's device sign-in, which serve-worker.mjs traded its key for and printed. */
let OWNER;
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
  const child = spawn(process.execPath, [join(ROOT, "verify-harness/serve-worker.mjs"), "--no-app"], {
    env: { ...process.env, PORT: String(WORKER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  workerPid = child.pid;
  let said = "";
  const hear = (chunk) => {
    said += chunk;
    OWNER ??= /superadmin token: ([0-9a-f]{64})/.exec(said)?.[1];
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
// their canonical form, shown as dkln-XXXXX-XXXXX-XXXXX-XXXXX.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const asOwner = { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-doklin-device": "d-drive", "x-doklin-client": "0.0.0-drive" };

if (!OWNER) throw new Error("the harness worker did not print the superadmin's token");

// A device is added by a person, for themselves: the code another device of
// Sherin's — the superadmin, whose Mac this script stands for — joins with.
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

/** Another device of Sherin's — the Mac this script stands for — editing
 *  `path` now: it is here, and holds the document until it stops beating. */
async function editingElsewhere(path) {
  const res = await fetch(`${WORKER}/api/poll`, {
    method: "POST",
    headers: asOwner,
    body: JSON.stringify({ name: "Sherin's Mac (drive)", path }),
  });
  if (!res.ok) throw new Error(`could not say another device is editing ${path}: ${res.status} ${await res.text()}`);
  return `editing ${path}`;
}

/** The restricted folder called `name` deleted for everyone in it, on
 *  another device of Sherin's: she is in
 *  every folder she made. */
async function deletedElsewhere(name) {
  const listed = await fetch(`${WORKER}/api/spaces`, { headers: asOwner });
  if (!listed.ok) throw new Error(`could not list the restricted folders: ${listed.status} ${await listed.text()}`);
  const space = (await listed.json()).spaces.find((s) => s.kind === "restricted" && s.name === name);
  if (!space) throw new Error(`no restricted folder called ${name}`);
  for (;;) {
    const res = await fetch(`${WORKER}/api/spaces/${space.id}`, { method: "DELETE", headers: asOwner });
    if (!res.ok) throw new Error(`could not delete ${name}: ${res.status} ${await res.text()}`);
    if (!(await res.json()).remaining) return `deleted ${name}`;
  }
}

/** Whether the shared workspace's manifest lists a file at `path`. */
async function onTheDomain(path) {
  const res = await fetch(`${WORKER}/api/manifest`, { headers: asOwner });
  if (!res.ok) throw new Error(`could not read the manifest: ${res.status}`);
  const manifest = await res.json();
  return Object.values(manifest.files ?? {}).some((file) => file.path === path && !file.deleted);
}

/** The text of a file in the shared workspace, as the domain holds it; null when it holds none. */
async function textOnTheDomain(path) {
  const res = await fetch(`${WORKER}/api/manifest`, { headers: asOwner });
  if (!res.ok) throw new Error(`could not read the manifest: ${res.status}`);
  const found = Object.entries((await res.json()).files ?? {}).find(([, file]) => file.path === path && !file.deleted);
  if (!found) return null;
  const blob = await fetch(`${WORKER}/api/blobs/${found[0]}/${found[1].hash}`, { headers: asOwner });
  return blob.ok ? blob.text() : null;
}

/** What each journey left on the domain, asked of the domain itself. */
const ON_THE_DOMAIN = {
  DoklinUITests: async () => {
    if (!(await onTheDomain("Phone list.md"))) {
      console.error("the note made in the app never reached the domain");
      return false;
    }
    console.log("the note made in the app is on the domain");
    return true;
  },
  // The note as the seed has it (the thread started and removed, unwrapped
  // again), and the seed's thread with the reply that stayed — in the bytes a
  // Mac writes, stamped to the second.
  CommentsUITests: async () => {
    const md = await textOnTheDomain("Comments.md");
    const meta = await textOnTheDomain("Comments.meta.jsonl");
    const want =
      /^\{"doklin":"meta","v":1\}\n\{"t":"mthread","id":"plain1","comments":\[\{"author":"Ada","at":1757000000000,"body":"Say it plainer\."\},\{"author":"[^"]+","at":\d+000,"body":"Plainer, then\."\}\]\}\n$/;
    if (md !== SEED_FILES["Comments.md"] || !want.test(meta ?? "")) {
      console.error(`the comments the app wrote are not on the domain as a Mac would write them:\n${md}\n${meta}`);
      return false;
    }
    console.log("the comments the app wrote are on the domain");
    return true;
  },
};

/* ---------- The core: `swift test`, or the command after `--` ---------- */

async function driveCore() {
  const line = await deviceLine();
  const split = process.argv.indexOf("--");
  // The package links the engine; `swift test` is told where this machine's is.
  const engine = join(ROOT, "ios/Engine/host");
  if (split < 0) execFileSync(join(ROOT, "scripts/ios-engine.sh"), ["host"], { stdio: "inherit" });
  const command =
    split >= 0 ? process.argv.slice(split + 1) : ["swift", "test", "--package-path", join(ROOT, "ios/DoklinKit"), "-Xlinker", `-L${engine}`];
  console.log(`running: ${command.join(" ")}`);
  const status = await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, DOKLIN_TEST_DEVICE_LINE: line },
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
  // What a journey asks of the domain's side (ios/DoklinUITests/UITestCase.swift):
  //   /line                 a device line. A line works once, and a person has
  //                         one code waiting at a time — a new one stops the
  //                         last — so each class asks for its own as it starts,
  //                         rather than every line being minted up front, when
  //                         only the last would still work.
  //   /editing?path=<rel>   another device editing a document of the workspace.
  //   /deleted?name=<name>  a restricted folder deleted on another device.
  const drive = createHttpServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const asks = {
      "/line": () => deviceLine(),
      "/editing": () => editingElsewhere(url.searchParams.get("path") ?? ""),
      "/deleted": () => deletedElsewhere(url.searchParams.get("name") ?? ""),
    };
    const asked = asks[url.pathname]?.() ?? Promise.reject(new Error(`nothing at ${url.pathname}`));
    asked.then(
      (said) => res.writeHead(200, { "content-type": "text/plain" }).end(said),
      (e) => res.writeHead(500, { "content-type": "text/plain" }).end(String(e)),
    );
  });
  await new Promise((resolve) => drive.listen(0, "localhost", resolve));
  const driveAt = `http://localhost:${drive.address().port}`;
  const out = process.env.DOKLIN_DRIVE_OUT || mkdtempSync(join(tmpdir(), "doklin-drive-ios-"));
  mkdirSync(out, { recursive: true });
  const result = join(out, "DoklinUITests.xcresult");
  rmSync(result, { recursive: true, force: true });
  const simulator = process.env.DOKLIN_SIMULATOR
    ? { udid: process.env.DOKLIN_SIMULATOR, name: `the simulator ${process.env.DOKLIN_SIMULATOR}` }
    : pickSimulator();
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
        ...(process.env.DOKLIN_ONLY ? [`-only-testing:DoklinUITests/${process.env.DOKLIN_ONLY}`] : []),
        ...(process.env.DOKLIN_DERIVED_DATA ? ["-derivedDataPath", process.env.DOKLIN_DERIVED_DATA] : []),
      ],
      {
        // xcodebuild hands the test runner every variable named TEST_RUNNER_<name>, as <name>.
        env: { ...process.env, TEST_RUNNER_DOKLIN_TEST_DRIVE: driveAt },
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
  drive.close();

  // The screenshots out of the result bundle, as files anybody can open. Best effort.
  try {
    execFileSync("xcrun", ["xcresulttool", "export", "attachments", "--path", result, "--output-path", join(out, "screenshots")], { stdio: "ignore" });
  } catch {
    console.log("the screenshots stay inside the result bundle — this Xcode's xcresulttool does not export them");
  }
  if (status !== 0) return status;
  const only = process.env.DOKLIN_ONLY;
  for (const [name, check] of Object.entries(ON_THE_DOMAIN)) {
    if ((!only || only === name) && !(await check())) return 1;
  }
  return 0;
}

const status = await (process.argv.includes("--app") ? driveApp() : driveCore());
cleanup();
process.exit(status);
