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
// remove from this iPhone; CommentsUITests: a thread read, started,
// answered and removed, a note published and stopped, published pages),
// one class after another, each with a device line of its own and then a
// look at what it left on the domain. What was on screen at each step is
// printed (the lines that begin `UI>`), and the whole xcodebuild log and the
// screenshots (screenshots/, manifest.json naming each) are left in
// $DOKLIN_DRIVE_OUT (a temporary folder when unset; the path is printed).
// DOKLIN_ONLY=<class> runs one class; DOKLIN_SIMULATOR=<udid> picks the
// simulator rather than the newest iPhone.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_FILES } from "../cloud-worker/test/seed.mjs";

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
// their canonical form, shown as dkln-XXXXX-XXXXX-XXXXX-XXXXX.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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

/** The text of a file in the shared workspace, as the domain holds it; null when it holds none. */
async function textOnTheDomain(path) {
  const res = await fetch(`${WORKER}/api/manifest`, { headers: asOwner });
  if (!res.ok) throw new Error(`could not read the manifest: ${res.status}`);
  const found = Object.entries((await res.json()).files ?? {}).find(([, file]) => file.path === path && !file.deleted);
  if (!found) return null;
  const blob = await fetch(`${WORKER}/api/blobs/${found[0]}/${found[1].hash}`, { headers: asOwner });
  return blob.ok ? blob.text() : null;
}

/** What CommentsUITests left on the domain: the note as the seed has it (the
 *  thread it started and removed, unwrapped again), and the seed's thread
 *  with the reply that stayed — in the bytes a Mac writes, stamped to the second. */
async function commentsOnTheDomain() {
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
}

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
  CommentsUITests: commentsOnTheDomain,
};

async function driveApp() {
  // One journey per test class, by its file's name. A device line works
  // once, and the domain keeps one pending code per person — a code minted
  // later undoes one minted earlier — so each class's line is minted just
  // before that class runs (ios/DoklinUITests/UITestCase.swift reads its own).
  const only = process.env.DOKLIN_ONLY;
  const classes = readdirSync(join(ROOT, "ios/DoklinUITests"))
    .filter((f) => f.endsWith("UITests.swift"))
    .map((f) => f.replace(/\.swift$/, ""))
    .filter((name) => !only || name === only)
    .sort();
  if (classes.length === 0) throw new Error(`There is no test class ${only} in ios/DoklinUITests.`);
  const out = process.env.DOKLIN_DRIVE_OUT || mkdtempSync(join(tmpdir(), "doklin-drive-ios-"));
  mkdirSync(out, { recursive: true });
  const shots = join(out, "screenshots");
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots);
  const simulator = process.env.DOKLIN_SIMULATOR
    ? { udid: process.env.DOKLIN_SIMULATOR, name: `the simulator ${process.env.DOKLIN_SIMULATOR}` }
    : pickSimulator();
  console.log(`driving the app on ${simulator.name}; the full log and the screenshots go to ${out}`);

  const log = createWriteStream(join(out, "xcodebuild.log"));
  // What a reader of the run wants: the screens, the tests, and anything that went wrong.
  const worthSaying = /^UI> |^Test (Case|Suite) |^\s*Executed |^\*\* |error:|: error |Testing failed|Testing started/;
  const xcodebuild = (args, env = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "xcodebuild",
        [
          ...args,
          "-project", join(ROOT, "ios/Doklin.xcodeproj"),
          "-scheme", "Doklin",
          "-destination", `id=${simulator.udid}`,
          ...(process.env.DOKLIN_DERIVED_DATA ? ["-derivedDataPath", process.env.DOKLIN_DERIVED_DATA] : []),
        ],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
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

  // The screenshots out of a result bundle, as files anybody can open, all
  // in one folder under one manifest. Best effort.
  const manifest = [];
  const keepScreenshots = (result) => {
    const from = mkdtempSync(join(out, "attachments-"));
    try {
      execFileSync("xcrun", ["xcresulttool", "export", "attachments", "--path", result, "--output-path", from], { stdio: "ignore" });
      for (const file of readdirSync(from)) if (file !== "manifest.json") renameSync(join(from, file), join(shots, file));
      manifest.push(...JSON.parse(readFileSync(join(from, "manifest.json"), "utf8")));
      writeFileSync(join(shots, "manifest.json"), JSON.stringify(manifest, null, 2));
    } catch {
      console.log(`the screenshots stay inside ${result} — this Xcode's xcresulttool does not export them`);
    } finally {
      rmSync(from, { recursive: true, force: true });
    }
  };

  const built = await xcodebuild(["build-for-testing"]);
  if (built !== 0) {
    await new Promise((resolve) => log.end(resolve));
    return built;
  }
  const failed = [];
  for (const name of classes) {
    const result = join(out, `${name}.xcresult`);
    rmSync(result, { recursive: true, force: true });
    const status = await xcodebuild(
      ["test-without-building", `-only-testing:DoklinUITests/${name}`, "-resultBundlePath", result],
      // xcodebuild hands the test runner every variable named TEST_RUNNER_<name>, as <name>.
      { TEST_RUNNER_DOKLIN_TEST_DEVICE_LINES: JSON.stringify({ [name]: await deviceLine() }) },
    );
    keepScreenshots(result);
    const check = ON_THE_DOMAIN[name];
    if (status !== 0 || (check && !(await check()))) failed.push(name);
  }
  await new Promise((resolve) => log.end(resolve));
  if (failed.length > 0) {
    console.error(`these journeys failed: ${failed.join(", ")}`);
    return 1;
  }
  return 0;
}

const status = await (process.argv.includes("--app") ? driveApp() : driveCore());
cleanup();
process.exit(status);
