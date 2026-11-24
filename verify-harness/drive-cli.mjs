// Drives the `doklin` CLI end to end — the built binary (cli/) against the
// real worker, served by serve-worker.mjs over the seed workspace
// (cloud-worker/test/seed.mjs). Every command, in the output a program gets
// (JSON, whenever stdout is not a terminal) and the output a person gets (on
// a pseudo-terminal, through script(1)), and every exit code:
//
//   0 done · 1 anything else · 2 bad usage · 3 not found · 4 not permitted ·
//   5 conflict · 6 not logged in, or the login was revoked · 7 the worker is
//   too old for the command · 8 the domain asked to slow down, or today's
//   Cloudflare requests are used up
//
// It needs no browser and builds nothing. It starts the harness worker
// itself, on a port of its own, and stops it when it is done. Run:
//
//   (cd cli && cargo build --release)
//   node verify-harness/drive-cli.mjs            # VERBOSE=1 shows every command and its output
//
// How it is wired:
//
//   doklin ──► a recording relay (this file) ──► serve-worker.mjs
//
// The relay forwards every request untouched and notes it, so a check can
// say what the CLI actually asked — that `edit` sent the revision it read,
// that a search asked again after a 202, that a logout revoked the token.
// The worker answers public addresses under its own origin, which is where
// the checks open them.
//
// Each "machine" below is a scratch HOME and XDG_CONFIG_HOME, so the
// credentials file a login leaves is the scratch one and never the real one.
//
// Every path an agent types starts with its section: the seed's Home.md is
// Library/Home to the CLI, while a Mac's own sync calls (`macWrites`) name it
// as the shared manifest stores it, Home.md.
//
// Two things are not the real worker, and say so where they are made: the
// "Mac" (the superadmin's device token on the sync API, as an engine would
// use it) and
// the worker that is behind (a stand-in that lacks the later routes —
// exit 7 cannot be had from a worker that is current). The terminal steps
// are skipped, out loud, where there is no script(1).
//
// NOT DRIVEN, on purpose: `doklin open` without --dry-run. It opens the
// Doklin app on the machine running this — the app somebody has open.
// `doklin()` below refuses to run the binary that way.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PIXEL_PNG, SEED_FILES, blobHash, fidOf } from "../cloud-worker/test/seed.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const BIN = join(ROOT, "cli/target/release/doklin");
if (!existsSync(BIN)) {
  console.error("There is no built CLI at cli/target/release/doklin — build it first:  (cd cli && cargo build --release)");
  process.exit(1);
}
const CLI_VERSION = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, "cli/Cargo.toml"), "utf8"))?.[1];

/** The superadmin's device sign-in, which serve-worker.mjs traded its key for and printed. */
let OWNER;
const SCRATCH = mkdtempSync(join(tmpdir(), "doklin-drive-cli-"));
const sha256 = (input) => createHash("sha256").update(input).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Ports, servers, and stopping them ---------- */

const servers = [];
let workerPid = null;
function cleanup() {
  if (workerPid !== null) {
    try {
      process.kill(workerPid);
    } catch {
      // already gone
    }
    workerPid = null;
  }
  for (const s of servers) s.close();
  rmSync(SCRATCH, { recursive: true, force: true });
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

/** A small http server on a port of its own; `handle(req, body)` answers `[status, body, headers?]`. */
async function serve(handle) {
  const port = await freePort();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const [status, body, headers = {}] = await handle(req, Buffer.concat(chunks));
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      const type = typeof body === "string" || Buffer.isBuffer(body) ? {} : { "content-type": "application/json" };
      res.writeHead(status, { ...type, ...headers, "content-length": bytes.length });
      res.end(bytes);
    } catch (e) {
      res.writeHead(502);
      res.end(String(e?.stack ?? e));
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  servers.push(server);
  return port;
}

/* ---------- The harness worker ---------- */

const WORKER_PORT = await freePort();
const WORKER = `http://localhost:${WORKER_PORT}`;
console.log(`starting the harness worker on ${WORKER}…`);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(ROOT, "verify-harness/serve-worker.mjs"), "--no-mermaid", "--no-app"], {
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

/** The owner's own calls — what the app's engine would make. Straight to the worker, never through the CLI. */
const owner = (path, { json, ...init } = {}) =>
  fetch(`${WORKER}${path}`, {
    ...init,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    headers: {
      authorization: `Bearer ${OWNER}`,
      "x-doklin-device": "d-drive",
      "x-doklin-client": "0.0.0-drive",
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });

/** The owner's member id: what a Mac signs its changes with. */
const OWNER_ID = (await (await owner("/api/meta")).json()).you.memberId;

/* ---------- The relay the CLI talks through ---------- */

/** Every request the CLI made, in order: {method, url, status, headers, body}. */
const calls = [];
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]);
/** Run once, just before the relay forwards the next request `match` accepts — a change that lands between two requests of one command. */
let meanwhile = null;
const RELAY_PORT = await serve(async (req, body) => {
  if (meanwhile?.match(req)) {
    const { run } = meanwhile;
    meanwhile = null;
    await run();
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const upstream = await fetch(`${WORKER}${req.url}`, {
    method: req.method,
    headers,
    redirect: "manual",
    ...(body.length > 0 ? { body } : {}),
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  calls.push({ method: req.method, url: req.url, status: upstream.status, headers: req.headers, body: body.toString("utf8") });
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
  });
  return [upstream.status, bytes, out];
});
/** The workspace's address, as the CLI is given it. */
const BASE = `http://localhost:${RELAY_PORT}`;
const DOMAIN = `localhost:${RELAY_PORT}`;
/** What the CLI asked since `from` (an index into `calls`), as "METHOD route → status". */
const asked = (from) => calls.slice(from).map((c) => `${c.method} ${c.url.replace(/^\/api\/agent\//, "").replace(/\?.*$/, "")} → ${c.status}`);

/* ---------- Agents, as the owner's app makes them ---------- */

// The app mints the code, shows it once and sends only its sha256
// (engine/src/cloud/invite.rs): twenty Crockford characters, hashed in
// their canonical form, shown as dkla-XXXXX-XXXXX-XXXXX-XXXXX.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function mintCode() {
  const canonical = [...randomBytes(20)].map((b) => CROCKFORD[b % 32]).join("");
  return { shown: `dkla-${canonical.match(/.{5}/g).join("-")}`, canonical, hash: sha256(canonical) };
}

async function addAgent(name, scopes, { codeLife = 3_600_000 } = {}) {
  const code = mintCode();
  const res = await owner("/api/auth/agents", { method: "POST", json: { name, scopes, codeHash: code.hash, expiresAt: Date.now() + codeLife } });
  if (res.status !== 201) throw new Error(`could not add the agent ${name}: ${res.status} ${await res.text()}`);
  const { agent } = await res.json();
  return { id: agent.id, name, code: code.shown, canonical: code.canonical };
}

/** A fresh login code for an agent that has spent its first. */
async function newCode(agent) {
  const code = mintCode();
  const res = await owner(`/api/auth/agents/${agent.id}/code`, { method: "POST", json: { codeHash: code.hash, expiresAt: Date.now() + 3_600_000 } });
  if (res.status !== 201) throw new Error(`could not mint a code for ${agent.name}: ${res.status} ${await res.text()}`);
  return code.shown;
}

/** The owner's list: every agent with the machines it is logged in on. */
const listed = async (agent) => (await (await owner("/api/auth/agents")).json()).agents.find((a) => a.id === agent.id);

/**
 * A change made on a Mac: blobs, then the manifest by compare-and-swap — the
 * sync API, which the worker does not mirror into its search index.
 */
async function macWrites(files, { mtime = Date.now() } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await owner("/api/manifest");
    const etag = current.headers.get("x-manifest-etag");
    const manifest = await current.json();
    const byPath = new Map(Object.entries(manifest.files).map(([fid, f]) => [f.path, fid]));
    for (const [path, text] of Object.entries(files)) {
      const bytes = Buffer.from(text, "utf8");
      const fid = byPath.get(path) ?? fidOf(path);
      const hash = blobHash(bytes);
      const put = await owner(`/api/blobs/${fid}/${hash}`, { method: "PUT", headers: { "content-type": "text/markdown" }, body: bytes });
      if (put.status !== 200) throw new Error(`blob for ${path} failed: ${put.status} ${await put.text()}`);
      manifest.files[fid] = { path, rev: (manifest.files[fid]?.rev ?? 0) + 1, hash, size: bytes.length, mtime, by: OWNER_ID };
    }
    manifest.seq += 1;
    const res = await owner("/api/manifest", { method: "PUT", headers: { "x-base-etag": etag, "content-type": "application/json" }, body: JSON.stringify(manifest) });
    if (res.status === 200) return;
    if (res.status !== 409 && res.status !== 412) throw new Error(`the Mac's manifest write failed: ${res.status} ${await res.text()}`);
  }
  throw new Error("the Mac's manifest write kept losing the race");
}

/* ---------- Running the binary ---------- */

const COMMANDS = [
  "login", "logout", "whoami", "ls", "info", "read", "search", "comments", "comment", "reply",
  "write", "edit", "mv", "rm", "publish", "unpublish", "published", "open",
];

/** A machine: its own HOME and config directory, and so its own credentials file. */
function machine(name) {
  const home = join(SCRATCH, name, "home");
  const xdg = join(SCRATCH, name, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  return { name, home, xdg, dir: join(xdg, "doklin"), creds: join(xdg, "doklin", "credentials.json") };
}
const credsOf = (box) => JSON.parse(readFileSync(box.creds, "utf8"));

/** A scratch file with these bytes; answers its path. */
function scratchFile(name, content) {
  const path = join(SCRATCH, name);
  writeFileSync(path, content);
  return path;
}

const SCRIPT_ARGS = { darwin: (argv) => ["-q", "/dev/null", ...argv], linux: (argv) => ["-qec", argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" "), "/dev/null"] };
let trail = [];
const seen = new Set();

/**
 * Run the binary on a machine. Piped by default — stdout is not a terminal,
 * so the answer is JSON — with `input` as what was piped in. With `tty` it
 * runs on a pseudo-terminal through script(1): what a person at a shell sees,
 * stdout and stderr together.
 */
function doklin(box, args, { input = "", tty = false } = {}) {
  if (args[0] === "open" && !args.includes("--dry-run") && !args.includes("--help")) {
    throw new Error("refusing to run `doklin open` for real: it opens the Doklin app on the machine running this");
  }
  const env = { PATH: process.env.PATH ?? "", HOME: box.home, XDG_CONFIG_HOME: box.xdg };
  const [cmd, argv] = tty ? ["script", SCRIPT_ARGS[process.platform]([BIN, ...args])] : [BIN, args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env, cwd: SCRATCH, stdio: [tty ? "ignore" : "pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      const r = {
        code: signal ? `killed by ${signal}` : code,
        bytes,
        out: tty ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes.toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
        /** stdout, as the JSON it is when piped. */
        get json() {
          return JSON.parse(this.out);
        },
        /** stderr, as the JSON a refusal is when piped: the worker's own answer plus `exit`. */
        get problem() {
          return JSON.parse(this.err);
        },
        /** stderr, as what `read` says about the content it put on stdout. */
        get meta() {
          return JSON.parse(this.err);
        },
      };
      seen.add(r.code);
      const cut = (s) => (s.length > 700 ? `${s.slice(0, 700)}…` : s).trimEnd().replaceAll("\n", "\n              ");
      trail.push(`      $ doklin ${args.join(" ")}${tty ? "   (on a terminal)" : ""}   [${box.name}] → exit ${r.code}\n        stdout: ${cut(r.out)}\n        stderr: ${cut(r.err)}`);
      resolve(r);
    });
    if (!tty) {
      child.stdin.on("error", () => {}); // a command that refuses before reading closes the pipe
      child.stdin.end(input);
    }
  });
}

/** A refusal when piped: this exit code, the same code in the JSON on stderr, a sentence, and nothing on stdout. */
const refused = (r, exit, words = /./) => {
  if (r.code !== exit || r.out !== "") return false;
  const said = r.problem;
  return said.exit === exit && typeof said.error === "string" && words.test(said.error);
};

/* ---------- Reporting ---------- */

const results = [];
/** VERBOSE=1 prints what every step ran and got, not only the steps that failed. */
const VERBOSE = Boolean(process.env.VERBOSE);
/** One step. `fn` answers {label: held?, …}; every label that did not hold is named, with what was run. */
async function check(name, fn) {
  trail = [];
  let failed;
  try {
    failed = Object.entries(await fn())
      .filter(([, held]) => held !== true)
      .map(([label]) => label);
  } catch (e) {
    failed = [`it threw: ${e?.message ?? e}`];
  }
  const ok = failed.length === 0;
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      not: ${failed.join("\n      not: ")}`}`);
  if (!ok || VERBOSE) for (const line of trail) console.log(line);
}

/** Deep equality that does not care which order an object's keys came in. */
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const ALL_SCOPES = ["read", "comment", "edit", "publish"];

/* ====================================================================== */
/* 1 — what needs no workspace: help, the version, bad usage              */
/* ====================================================================== */

const nobody = machine("nobody");

await check("help: the overview lists every command; each topic and each command has a page; `<command> --help` is that page; an unknown topic is bad usage", async () => {
  const overview = await doklin(nobody, ["help"]);
  const facts = {
    "the overview prints and exits 0": overview.code === 0 && overview.out.startsWith("doklin — work with a Doklin workspace"),
    "--help and -h are the overview": (await doklin(nobody, ["--help"])).out === overview.out && (await doklin(nobody, ["-h"])).out === overview.out,
    "the overview says the exit codes": /Exit codes: 0 done · 2 bad usage · 3 not found · 4 not permitted · 5 conflict/.test(overview.out),
    "…8 among them": /8 the domain asked to slow down, or today's Cloudflare requests are used up/.test(overview.out),
    "the overview says only documents sync": /Doklin syncs markdown and html documents; any other file in\nthe folder stays on the device it is on\./.test(overview.out),
  };
  for (const name of COMMANDS) facts[`the overview lists ${name}`] = new RegExp(`^  ${name}\\b`, "m").test(overview.out);
  for (const [topic, headline] of [["documents", "DOCUMENTS"], ["comments", "COMMENTS"], ["publishing", "PUBLISHING"], ["sections", "SECTIONS"], ["drawings", "DRAWINGS"], ["agent", "FOR AN AGENT"]]) {
    const r = await doklin(nobody, ["help", topic]);
    facts[`help ${topic}`] = r.code === 0 && r.out.startsWith(headline) && overview.out.includes(`doklin help ${topic}`);
  }
  for (const name of COMMANDS) {
    const own = await doklin(nobody, [name, "--help"]);
    facts[`${name} --help`] = own.code === 0 && own.out.startsWith(`doklin ${name}`) && own.err === "";
    // `help comments` is the topic above — how comments work — and the one
    // command of that name keeps its own page under --help.
    if (name !== "comments") facts[`help ${name}`] = (await doklin(nobody, ["help", name])).out === own.out;
  }
  facts["read -h"] = (await doklin(nobody, ["read", "-h"])).out.startsWith("doklin read <doc>");
  const documents = (await doklin(nobody, ["help", "documents"])).out;
  facts["help documents says only documents sync"] =
    documents.includes("Doklin syncs markdown and html documents, nothing else.") && !/plain file|a picture|a PDF|CSV/.test(documents);
  const agent = (await doklin(nobody, ["help", "agent"])).out;
  facts["no help mentions a plain file"] = !/plain file/.test(overview.out + documents + agent);
  facts["the overview says every path starts with its section"] =
    /Every path starts with the\nsection it is in, and a path with no section is refused:\n  Library\/… +everyone in the workspace sees it\n  Private\/… +only your person sees it\n  Restricted\/<folder>\/… +only the people in that folder\n/.test(overview.out);
  facts["the agent's brief says where new work goes, in the app's words"] = agent
    .replace(/\s+/g, " ")
    .includes(
      "You see what the person who gave you this sees. Every path starts with its section: Library/ is what everyone sees, Private/ only them, Restricted/<folder>/ that folder's people. Put anything new under Private/ unless they tell you where it goes",
    );
  facts["no example path lacks its section"] = !/doklin (read|write|rm|comments?|reply|publish|unpublish|mv) (?!Library\/|Private\/|Restricted\/|rm\b|<)/.test(
    [documents, agent, ...(await Promise.all(["comments", "publishing", "sections"].map(async (t) => (await doklin(nobody, ["help", t])).out)))].join("\n"),
  );
  facts["an unknown topic is exit 2"] = refused(await doklin(nobody, ["help", "nonsense"]), 2, /no help on "nonsense"/);
  return facts;
});

await check("every word after `doklin` is a command, on every system: alone it is the overview; anything else is bad usage", async () => {
  const overview = (await doklin(nobody, ["help"])).out;
  const alone = await doklin(nobody, []);
  return {
    "`doklin` alone prints the overview": alone.code === 0 && alone.out === overview,
    "an unknown word is exit 2": refused(await doklin(nobody, ["raed", "Library/Projects/plan"]), 2, /"raed" is not a doklin command — run `doklin help`/),
    "so is a path": refused(await doklin(nobody, ["notes.md"]), 2, /"notes\.md" is not a doklin command/),
    "and an option no command has": refused(await doklin(nobody, ["--nope"]), 2, /there is no --nope option/),
  };
});

await check("open: paths on this disk, made absolute and checked, no login; refused off a Mac (--dry-run: nothing is opened)", async () => {
  const file = scratchFile("open-me.md", "# Hi\n");
  const mac = process.platform === "darwin";
  const one = await doklin(nobody, ["open", "--dry-run", "open-me.md", SCRATCH]);
  const facts = {};
  if (mac) {
    // Where it runs is the folder itself (/private/var…), not the link to it
    // the temp folder's name goes through (/var…); a path given whole is kept.
    facts["a relative path is resolved where the command runs, a folder is fine too"] =
      one.code === 0 && JSON.stringify(JSON.parse(one.out)) === JSON.stringify({ links: [], opened: false, paths: [realpathSync(file), SCRATCH] });
    facts["no path is the app itself"] = JSON.parse((await doklin(nobody, ["open", "--dry-run"])).out).paths.length === 0;
    facts["a path that is not there is exit 3"] = refused(await doklin(nobody, ["open", "--dry-run", "nope.md"]), 3, /there is no file or folder at "nope\.md"/);
    const tty = await doklin(nobody, ["open", "--dry-run", "open-me.md"], { tty: true });
    facts["a person reads what would open"] = tty.out.includes("Would open open-me.md in Doklin.");
  } else {
    facts["off a Mac it is refused: there is no app here"] = refused(one, 1, /open hands files to the Doklin app, which runs only on a Mac/);
  }
  facts["it takes no options of its own"] = refused(await doklin(nobody, ["open", "--dry-run", "--force"]), 2, /--force/);
  return facts;
});

await check("version: `--version` is the crate's version", async () => {
  const r = await doklin(nobody, ["--version"]);
  return {
    "cli/Cargo.toml has a version": typeof CLI_VERSION === "string",
    "it prints it": r.code === 0 && r.out === `doklin ${CLI_VERSION}\n`,
    "`version` and -V too": (await doklin(nobody, ["version"])).out === r.out && (await doklin(nobody, ["-V"])).out === r.out,
  };
});

await check("bad usage is exit 2 before anything is asked of a domain: a missing argument, one too many, an option that does not exist, --md with --html", async () => {
  const from = calls.length;
  const cases = {
    "read with no document": ["read"],
    "info with no document": ["info"],
    "mv with one name": ["mv", "a"],
    "reply with no thread": ["reply", "a", "-m", "x"],
    "login with only a domain": ["login", BASE],
    "login with three words": ["login", BASE, "dkla-00000-00000-00000-00000", "extra"],
    "login to something that is no address": ["login", "not a domain", "dkla-00000-00000-00000-00000"],
    "ls with two folders": ["ls", "a", "b"],
    "an option no command has": ["ls", "--nope"],
    "an option this command lacks": ["ls", "--force"],
    "a short option that does not exist": ["ls", "-x"],
    "a value option with no value": ["read", "a", "-o"],
    "a switch given a value": ["ls", "--deep=yes"],
    "read --md --html": ["read", "a", "--md", "--html"],
    "write --if-rev that is no number": ["write", "a", "--if-rev", "latest"],
    "write --from a file that is not there": ["write", "a", "--from", join(SCRATCH, "no-such-file.md")],
    "edit with no --find": ["edit", "a", "--replace", "x"],
    "edit with no --replace": ["edit", "a", "--find", "x"],
    "comment with no --on": ["comment", "a", "-m", "x"],
    "comment with no -m": ["comment", "a", "--on", "x"],
    "comment rm with no thread": ["comment", "rm", "a"],
    "search with no text": ["search"],
    "search --limit 0": ["search", "x", "--limit", "0"],
    "search --limit that is no number": ["search", "x", "--limit", "many"],
    "publish with nothing": ["publish"],
    "unpublish with nothing": ["unpublish"],
    "whoami with an argument": ["whoami", "me"],
  };
  const facts = {};
  for (const [label, args] of Object.entries(cases)) facts[label] = refused(await doklin(nobody, args, { input: "text" }), 2);
  facts["no request was made"] = calls.length === from;
  return facts;
});

await check("not logged in: every command that needs the workspace exits 6 and says how to get in — and asks nothing of anybody", async () => {
  const from = calls.length;
  const facts = {};
  const all = [
    ["whoami"], ["ls"], ["info", "Library/Home"], ["read", "Library/Home"], ["search", "x"], ["comments", "Library/Home"], ["published"],
    ["write", "Library/Home"], ["edit", "Library/Home", "--find", "a", "--replace", "b"], ["mv", "Library/Home", "Library/Away"], ["rm", "Library/Home"],
    ["comment", "Library/Home", "--on", "a", "-m", "b"], ["reply", "Library/Home", "t", "-m", "b"], ["comment", "rm", "Library/Home", "t"],
    ["publish", "Library/Home"], ["unpublish", "Library/Home"], ["logout"],
  ];
  for (const args of all) facts[args.join(" ")] = refused(await doklin(nobody, args, { input: "text" }), 6, /not logged in/);
  const named = await doklin(nobody, ["ls", "-w", "nowhere.example.com"]);
  facts["-w for a domain this machine never logged in to"] = refused(named, 6, /not logged in to nowhere\.example\.com/);
  // On a Mac the app is the other way in; elsewhere there is no app to name.
  const app = /Doklin → Install Command Line Tool/;
  const bare = await doklin(nobody, ["ls"]);
  facts[process.platform === "darwin" ? "on a Mac, both name the menu item that logs in" : "off a Mac, neither names the app"] =
    process.platform === "darwin"
      ? app.test(bare.problem.error) && app.test(named.problem.error)
      : !app.test(bare.problem.error) && !app.test(named.problem.error);
  facts["no request was made"] = calls.length === from;
  facts["no credentials file was made"] = !existsSync(nobody.creds);
  return facts;
});

/* ====================================================================== */
/* 2 — login                                                              */
/* ====================================================================== */

const editor = await addAgent("Editor bot", ALL_SCOPES);
const reader = await addAgent("Reader bot", ["read"]);
const reviewer = await addAgent("Reviewer bot", ["read", "comment"]);
const writer = await addAgent("Writer bot", ["read", "edit"]);
const editorBox = machine("editor");
const readerBox = machine("reader");
const reviewerBox = machine("reviewer");
const writerBox = machine("writer");

await check("login: the line the owner hands over logs this machine in — the answer names the workspace, the agent and what it may do, and never the token", async () => {
  const from = calls.length;
  const r = await doklin(editorBox, ["login", BASE, editor.code]);
  const sent = calls[from];
  const creds = credsOf(editorBox);
  const entry = creds.workspaces[0];
  return {
    "exit 0": r.code === 0,
    "the answer": same(r.json, { workspace: r.json.workspace, agent: { id: editor.id, name: "Editor bot" }, scopes: ALL_SCOPES, endpoint: BASE }) && r.json.workspace.name === "Notes",
    "nothing printed is the token": !r.out.includes("dka_") && !r.err.includes("dka_"),
    "one request: POST login": same(asked(from), ["POST login → 201"]),
    "it carried no bearer": sent.headers.authorization === undefined,
    "it said which client it is": sent.headers["x-doklin-client"] === `cli/${CLI_VERSION}`,
    "it sent the code and this machine's name": same(JSON.parse(sent.body), { code: editor.code, host: hostname() }),
    "the credentials file": creds.version === 1 && creds.workspaces.length === 1 && entry.endpoint === BASE && entry.name === "Notes" && entry.agent === "Editor bot",
    "it holds the token": /^dka_[0-9a-f]{64}$/.test(entry.token),
    "the file is 0600": (statSync(editorBox.creds).mode & 0o777) === 0o600,
    "its directory is 0700": (statSync(editorBox.dir).mode & 0o777) === 0o700,
    "nothing was left beside it": !existsSync(`${editorBox.creds}.tmp`),
    "nothing was written under HOME": !existsSync(join(editorBox.home, ".config")),
  };
});

await check("login: a code works once; a code typed loosely still works; an unknown, a spent and an expired code are the same refusal (exit 6); a malformed one is bad usage", async () => {
  const again = await doklin(machine("thief"), ["login", BASE, editor.code]);
  // As somebody retyped the line: the address in capitals with a slash on the
  // end, the code in lower case with no dashes and no prefix.
  const loose = await doklin(readerBox, ["login", `HTTP://LOCALHOST:${RELAY_PORT}/`, reader.canonical.toLowerCase()]);
  const shortLived = await addAgent("Late bot", ["read"], { codeLife: 1200 });
  await sleep(1300);
  const expired = await doklin(machine("late"), ["login", BASE, shortLived.code]);
  const unknown = await doklin(machine("guess"), ["login", BASE, mintCode().shown]);
  const malformed = await doklin(machine("typo"), ["login", BASE, "dkla-123"]);
  return {
    "a spent code is exit 6": refused(again, 6, /not valid/),
    "an expired code is exit 6": refused(expired, 6, /not valid/),
    "an unknown code is exit 6": refused(unknown, 6, /not valid/),
    "the three say the same thing": again.problem.error === expired.problem.error && expired.problem.error === unknown.problem.error,
    "a malformed code is exit 2": refused(malformed, 2, /not a Doklin login code/),
    "a refused login leaves no credentials": !existsSync(join(SCRATCH, "thief", "config", "doklin", "credentials.json")),
    "a loosely typed address and code log in": loose.code === 0 && loose.json.agent.name === "Reader bot" && same(loose.json.scopes, ["read"]),
    "the address is stored in its plain form": loose.code === 0 && credsOf(readerBox).workspaces[0].endpoint === BASE,
  };
});

await check("login: a domain typed without a scheme means https; one that cannot be reached is exit 1; one that is no Doklin worker is exit 1", async () => {
  const from = calls.length;
  // Nothing here speaks TLS, so https to the relay's port cannot connect —
  // which is the proof that https is what was tried.
  const bare = await doklin(machine("bare"), ["login", DOMAIN, mintCode().shown]);
  const closed = await freePort();
  const unreachable = await doklin(machine("offline"), ["login", `http://127.0.0.1:${closed}`, mintCode().shown]);
  const strangerPort = await serve(async () => [200, "<html><body>Just a website.</body></html>", { "content-type": "text/html" }]);
  const stranger = await doklin(machine("stranger"), ["login", `http://localhost:${strangerPort}`, mintCode().shown]);
  const emptyPort = await serve(async () => [200, {}]);
  const empty = await doklin(machine("empty"), ["login", `http://localhost:${emptyPort}`, mintCode().shown]);
  return {
    "no scheme means https": refused(bare, 1, new RegExp(`could not reach ${DOMAIN}`)) && calls.length === from,
    "unreachable is exit 1": refused(unreachable, 1, /could not reach 127\.0\.0\.1/),
    "a website that answers html is exit 1": refused(stranger, 1, /not what a Doklin worker sends/),
    "an answer with no token is exit 1": refused(empty, 1, /did not answer with a login/),
  };
});

await check("login again on a machine that is logged in: the new token replaces the old one, which is revoked — the owner sees one machine, not two", async () => {
  const before = credsOf(editorBox).workspaces[0].token;
  const from = calls.length;
  const r = await doklin(editorBox, ["login", BASE, await newCode(editor)]);
  const after = credsOf(editorBox);
  const mine = await listed(editor);
  return {
    "exit 0": r.code === 0,
    "still one entry, with a new token": after.workspaces.length === 1 && after.workspaces[0].token !== before,
    "the old login was let go": same(asked(from), ["POST login → 201", "DELETE login → 204"]) && calls[from + 1].headers.authorization === `Bearer ${before}`,
    "the owner sees one machine, by this machine's name": mine.machines.length === 1 && mine.machines[0].host === hostname(),
  };
});

await check("login <domain> -: the code is the first line piped in — how the Doklin app hands one over, off the command line; nothing piped in is bad usage that asks nothing", async () => {
  const terminal = await addAgent("Sherin's terminal (Studio)", ALL_SCOPES);
  const box = machine("terminal");
  const empty = calls.length;
  const nothing = await doklin(box, ["login", BASE, "-"], { input: "" });
  const blank = await doklin(box, ["login", BASE, "-"], { input: "\n  \n" });
  const askedNothing = calls.length === empty;
  const leftNothing = !existsSync(box.creds);
  const from = calls.length;
  const r = await doklin(box, ["login", BASE, "-"], { input: `${terminal.code}\n` });
  const sent = calls[from];
  return {
    "nothing piped in is exit 2": refused(nothing, 2, /nothing was piped in/),
    "a blank line is exit 2": refused(blank, 2, /nothing was piped in/),
    "neither asked the domain anything": askedNothing,
    "nor left a credentials file": leftNothing,
    "the piped code logs in": r.code === 0 && r.json.agent.name === "Sherin's terminal (Studio)" && same(r.json.scopes, ALL_SCOPES),
    "it sent the code it was piped": same(asked(from), ["POST login → 201"]) && JSON.parse(sent.body).code === terminal.code,
    "the credentials file holds the login": credsOf(box).workspaces[0].agent === "Sherin's terminal (Studio)",
  };
});

await check("the reviewer and the writer log in on machines of their own", async () => ({
  reviewer: (await doklin(reviewerBox, ["login", BASE, reviewer.code])).json.agent.name === "Reviewer bot",
  writer: (await doklin(writerBox, ["login", BASE, writer.code])).json.agent.name === "Writer bot",
}));

/* ====================================================================== */
/* 3 — reading: whoami, ls, info, read                                    */
/* ====================================================================== */

await check("whoami: the workspace, the agent, what it may do, the sections it sees and the worker's version — piped and with --json alike", async () => {
  const piped = await doklin(editorBox, ["whoami"]);
  const flagged = await doklin(editorBox, ["whoami", "--json"]);
  const me = piped.json;
  const readerMe = (await doklin(readerBox, ["whoami"])).json;
  return {
    "exit 0": piped.code === 0 && flagged.code === 0,
    who: same(me.agent, { id: editor.id, name: "Editor bot" }) && me.workspace.name === "Notes",
    "what it may do": same(me.scopes, ALL_SCOPES) && same(readerMe.scopes, ["read"]) && readerMe.agent.name === "Reader bot",
    // Sherin's Private is a section of hers, so her agents see it too.
    "the sections it sees, Library first": same(me.sections, ["Library", "Private"]) && same(readerMe.sections, me.sections),
    "the worker": Number.isInteger(me.version),
    "the domain's limits come with it": Number.isInteger(me.limits?.cliDaily) && me.limits.plan === "free",
    "the fleet's sum is a number": Number.isInteger(me.limits?.fleetToday),
    "--json is the same answer": same(flagged.json, me),
    "one line of JSON, nothing on stderr": piped.out.trim().split("\n").length === 1 && piped.err === "",
  };
});

await check("ls: the sections at the top; in a folder, its folders, and documents with their versions — no address, never a sidecar, never a plain file", async () => {
  const top = (await doklin(editorBox, ["ls"])).json;
  const root = (await doklin(editorBox, ["ls", "Library"])).json;
  const projects = (await doklin(editorBox, ["ls", "Library/Projects"])).json;
  const slashed = (await doklin(editorBox, ["ls", "/Library/Projects/"])).json;
  const lower = (await doklin(editorBox, ["ls", "library/Projects"])).json;
  const deep = (await doklin(editorBox, ["ls", "--deep"])).json;
  const deepProjects = (await doklin(editorBox, ["ls", "Library/Projects", "--deep", "--json"])).json;
  const doc = (list, path) => list.documents.find((d) => d.path === path);
  const home = doc(root, "Library/Home");
  const plan = doc(projects, "Library/Projects/plan");
  return {
    // Sherin's Private is a section of hers, so her agents see it too.
    "the top is the sections, and no document": same(top, { dir: "", folders: ["Library", "Private"], documents: [] }),
    "Library's folders": same(root.folders, ["Library/Projects"]) && root.dir === "Library",
    "Library's documents": same(root.documents.map((d) => d.path), ["Library/Comments", "Library/Diagram", "Library/Home", "Library/Ideas", "Library/Scratch", "Library/Sizes"]),
    "a listing is folders and documents, nothing else": same(Object.keys(root).sort(), ["dir", "documents", "folders"]),
    "a row says no address, public or link: info does": same(Object.keys(home).sort(), ["md", "path"]) && same(Object.keys(plan).sort(), ["html", "md", "path"]),
    "a version's facts": home.md.file === "Home.md" && home.md.rev === 1 && home.md.size === Buffer.byteLength(SEED_FILES["Home.md"]) && home.html === undefined,
    "Projects' folders": same(projects.folders, ["Library/Projects/Roadmap"]) && projects.dir === "Library/Projects",
    "plan has both versions, in step": plan.md.file === "plan.md" && plan.html.file === "plan.html" && plan.htmlBehind === undefined,
    "status has only markdown": doc(projects, "Library/Projects/status").md.rev === 1 && doc(projects, "Library/Projects/status").html === undefined,
    "slashes around a folder are forgiven": same(slashed, projects),
    "a section's name in any case": same(lower.documents, projects.documents),
    "--deep is folders and documents too": same(Object.keys(deepProjects).sort(), ["dir", "documents", "folders"]) && deepProjects.documents.some((d) => d.path === "Library/Projects/Roadmap/Paint it"),
    "--deep at the top lists every section's documents and folders": deep.documents.some((d) => d.path === "Library/Projects/Roadmap/Launch") && deep.folders.includes("Library/Projects/Roadmap") && deep.folders.includes("Private"),
    "no sidecar anywhere": !JSON.stringify(deep).includes(".meta.jsonl"),
  };
});

await check("ls: a folder that is not there is exit 3; a hidden or an ignored one is bad usage", async () => ({
  missing: refused(await doklin(editorBox, ["ls", "Library/Nope"]), 3, /no folder "Library\/Nope"/),
  hidden: refused(await doklin(editorBox, ["ls", "Library/.git"]), 2, /hidden/),
  ignored: refused(await doklin(editorBox, ["ls", "Library/node_modules"]), 2, /does not sync/),
}));

await check("info: a document's versions, comment threads, link and public addresses — by its name or either file's; a plain file is refused", async () => {
  const plan = (await doklin(editorBox, ["info", "Library/Projects/plan"])).json;
  const byHtml = (await doklin(editorBox, ["info", "Library/Projects/plan.html"])).json;
  const byMd = (await doklin(editorBox, ["info", "Library/Projects/plan.md", "--json"])).json;
  const comments = (await doklin(editorBox, ["info", "Library/Comments"])).json;
  const home = (await doklin(editorBox, ["info", "Library/Home"])).json;
  const scratch = (await doklin(editorBox, ["info", "Library/Scratch"])).json;
  const ws = (await (await owner("/api/meta")).json()).workspace.id;
  const words = (await doklin(editorBox, ["info", "Library/Scratch"], { tty: true })).out;
  return {
    "a document": plan.kind === "document" && plan.path === "Library/Projects/plan" && plan.md.rev === 1 && plan.html.rev === 1 && plan.comments === 0,
    "each version's size": plan.md.size === Buffer.byteLength(SEED_FILES["Projects/plan.md"]) && plan.html.size === Buffer.byteLength(SEED_FILES["Projects/plan.html"]),
    "its addresses: its own page, and inside the published folder": same(plan.public, [`${WORKER}/plan`, `${WORKER}/projects/plan`]),
    "Home is public at / and /home": same(home.public, [`${WORKER}/`, `${WORKER}/home`]),
    "Scratch is not public": scratch.public === undefined,
    "its link, as the app copies it: the markdown's": plan.link === `https://doklin.cc/open#d=${encodeURIComponent(DOMAIN)}&w=${ws}&f=${fidOf("Projects/plan.md")}`,
    "only the link, not the ids it is written from": plan.linkTo === undefined,
    "a person reads it beside the addresses": /\n  link {6}https:\/\/doklin\.cc\/open#\S+\n  public {4}no\n/.test(words),
    "the same document by either file's name": same(byHtml, plan) && same(byMd, plan),
    "its comment threads are counted": comments.comments === 1,
    "a plain file is bad usage that names what syncs": refused(await doklin(editorBox, ["info", "Library/Projects/assets/pic.png"]), 2, /^Doklin syncs markdown and html documents only — "pic\.png" is neither/),
    "what is not there is exit 3": refused(await doklin(editorBox, ["info", "Library/Nope"]), 3, /there is no document at "Library\/Nope"/),
  };
});

await check("read: the text on stdout and what is known about it on stderr; --md, --html or an extension picks the version; --clean drops comment markers; -o writes a file", async () => {
  const md = await doklin(editorBox, ["read", "Library/Projects/plan"]);
  const html = await doklin(editorBox, ["read", "Library/Projects/plan", "--html"]);
  const byName = await doklin(editorBox, ["read", "Library/Projects/plan.html"]);
  const explicit = await doklin(editorBox, ["read", "Library/Projects/plan", "--md", "--json"]);
  const spaced = await doklin(editorBox, ["read", "Library/Projects/Roadmap/Ship the boat"]);
  const marked = await doklin(editorBox, ["read", "Library/Comments"]);
  const clean = await doklin(editorBox, ["read", "Library/Comments", "--clean"]);
  const copy = join(SCRATCH, "plan-copy.md");
  const toFile = await doklin(editorBox, ["read", "Library/Projects/plan", "-o", copy]);
  return {
    "markdown by default, byte for byte": md.code === 0 && md.out === SEED_FILES["Projects/plan.md"],
    "what it is, on stderr": same(md.meta, { kind: "document", path: "Library/Projects/plan", file: "Library/Projects/plan.md", rev: 1, version: "md" }),
    "--html": html.out === SEED_FILES["Projects/plan.html"] && same(html.meta, { kind: "document", path: "Library/Projects/plan", file: "Library/Projects/plan.html", rev: 1, version: "html" }),
    "the .html name picks the html": byName.out === html.out && byName.meta.version === "html",
    "--md": explicit.out === md.out && same(explicit.meta, md.meta),
    "a name with spaces — its frontmatter is its text like the rest": spaced.out === SEED_FILES["Projects/Roadmap/Ship the boat.md"] && same(spaced.meta, { kind: "document", path: "Library/Projects/Roadmap/Ship the boat", file: "Library/Projects/Roadmap/Ship the boat.md", rev: 1, version: "md" }),
    "comment markers are kept": marked.out === SEED_FILES["Comments.md"] && marked.out.includes("{=="),
    "--clean drops them and keeps the words": clean.code === 0 && !/\{==|==\}|\{>>|<<\}/.test(clean.out) && clean.out.includes("a highlighted phrase"),
    "-o writes the file and prints nothing": toFile.code === 0 && toFile.out === "" && readFileSync(copy, "utf8") === SEED_FILES["Projects/plan.md"] && toFile.meta.rev === 1,
  };
});

await check("a link to a page, as the app copies it, is taken wherever a document is named: the domain says where it leads, and the command runs in the link's workspace", async () => {
  const ws = (await (await owner("/api/meta")).json()).workspace.id;
  const link = (path, domain = DOMAIN) => `https://doklin.cc/open#d=${encodeURIComponent(domain)}&w=${ws}&f=${fidOf(path)}`;
  const from = calls.length;
  const read = await doklin(editorBox, ["read", link("Projects/plan.md")]);
  const steps = asked(from);
  const info = await doklin(editorBox, ["info", `<${link("Projects/plan.html")}>`]);
  const comments = await doklin(editorBox, ["comments", link("Comments.md")]);
  const wiped = `https://doklin.cc/open#d=${encodeURIComponent(DOMAIN)}&w=w-000000000000&f=${fidOf("Projects/plan.md")}`;
  const opened = await doklin(nobody, ["open", "--dry-run", link("Projects/plan.md")]);
  const forApp = link("Projects/plan.md").replace("https://doklin.cc/open", "doklin://open");
  const handed =
    process.platform === "darwin"
      ? ["open hands a link to the app as it is registered for it", opened.code === 0 && same(JSON.parse(opened.out).links, [forApp])]
      : ["off a Mac, open refuses a link as it refuses a path: there is no app here", refused(opened, 1, /open hands files to the Doklin app, which runs only on a Mac/)];
  return {
    "read takes it: the text, and the path it led to, in its section": read.code === 0 && read.out === SEED_FILES["Projects/plan.md"] && read.meta.path === "Library/Projects/plan",
    "one question first, then the read": same(steps, ["GET find → 200", "GET doc → 200"]),
    "info takes it in a mail's angle brackets, by its html file too": info.code === 0 && info.json.path === "Library/Projects/plan",
    "and comments": comments.code === 0 && comments.json.path === "Library/Comments",
    "a page that is not there is exit 3": refused(await doklin(editorBox, ["read", link("Nope.md")]), 3, /no page at that link/),
    "a link from before the domain was set up again is the same": refused(await doklin(editorBox, ["read", wiped]), 3, /no page at that link/),
    "a link to a workspace this machine is not logged in to says which": refused(await doklin(editorBox, ["read", link("Projects/plan.md", "elsewhere.example.com")]), 6, /not logged in to elsewhere\.example\.com/),
    "-w naming another workspace than the link's is bad usage": refused(await doklin(editorBox, ["read", link("Projects/plan.md"), "-w", "elsewhere.example.com"]), 2, /that link is to a page in localhost/),
    [handed[0]]: handed[1],
  };
});

await check("read: what is not there is exit 3 and says which half is missing; a sidecar, a plain file and a hidden path are bad usage", async () => {
  const noHtml = await doklin(editorBox, ["read", "Library/Home", "--html"]);
  return {
    "no such document": refused(await doklin(editorBox, ["read", "Library/Nope"]), 3, /there is no document at "Library\/Nope"/),
    "no html version": refused(noHtml, 3, /Library\/Home has no html version/) && noHtml.problem.code === "no_html",
    "a sidecar is not a document": refused(await doklin(editorBox, ["read", "Library/Sizes.meta.jsonl"]), 2, /comments commands/),
    "nor is a plain file": refused(await doklin(editorBox, ["read", "Library/Projects/Roadmap/notes.txt"]), 2, /Doklin syncs markdown and html documents only — "notes\.txt" is neither/),
    "a hidden path": refused(await doklin(editorBox, ["read", ".env"]), 2, /hidden/),
  };
});

await check("a path with no section is refused by every command that names one — exit 2, with the sentence that says which to use — and nothing changes", async () => {
  const said = /^Projects\/plan is in no section\. Say which: Library\/Projects\/plan \(everyone\), Private\/Projects\/plan \(only your person\) or Restricted\/<folder>\/Projects\/plan\.$/;
  const facts = {};
  for (const args of [
    ["read", "Projects/plan"], ["info", "Projects/plan"], ["comments", "Projects/plan"],
    ["write", "Projects/plan", "--force"], ["edit", "Projects/plan", "--find", "June", "--replace", "July"],
    ["comment", "Projects/plan", "--on", "June", "-m", "When?"], ["rm", "Projects/plan"],
    ["mv", "Projects/plan", "Library/Projects/plan-2"], ["mv", "Library/Projects/plan", "Projects/plan"],
    ["publish", "Projects/plan"], ["unpublish", "Projects/plan"],
  ]) {
    facts[args.join(" ")] = refused(await doklin(editorBox, args, { input: "# Lost\n" }), 2, said);
  }
  facts["ls of a folder with no section"] = refused(await doklin(editorBox, ["ls", "Projects"]), 2, /^Projects is in no section\. Say which: Library\/Projects \(everyone\)/);
  facts["search --in one"] = refused(await doklin(editorBox, ["search", "plan", "--in", "Projects"]), 2, /^Projects is in no section\./);
  const plan = await doklin(editorBox, ["read", "Library/Projects/plan"]);
  facts["the document is as it was"] = plan.out === SEED_FILES["Projects/plan.md"] && plan.meta.rev === 1;
  facts["nothing was made where the paths pointed"] = (await doklin(editorBox, ["info", "Library/Projects/plan-2"])).code === 3;
  return facts;
});

/* ====================================================================== */
/* 4 — changing documents: write, edit                                    */
/* ====================================================================== */

const ALPHA = "# Alpha\n\nThe boat ships in June if the paint dries.\n\nThe boat is blue. The boat is fast.\n";
const ALPHA_HTML =
  "<!doctype html><html><head><title>Alpha</title></head><body><h1>Alpha page</h1><p>The boat ships in June.</p><ul><li>One item</li><li>One more item</li></ul></body></html>";

await check("write: creates a document from what is piped in; replacing needs the revision that was read, or --force; the same text again writes nothing; --dry-run only says", async () => {
  const from = calls.length;
  const first = "# Alpha\n\nfirst draft\n";
  const created = await doklin(editorBox, ["write", "Library/Drive/alpha"], { input: first });
  const bare = await doklin(editorBox, ["write", "Library/Drive/alpha"], { input: "lost\n" });
  const second = await doklin(editorBox, ["write", "Library/Drive/alpha", "--if-rev", "1"], { input: "# Alpha\n\nsecond draft\n" });
  const stale = await doklin(editorBox, ["write", "Library/Drive/alpha", "--if-rev", "1"], { input: "lost\n" });
  const both = await doklin(editorBox, ["write", "Library/Drive/alpha", "--if-rev", "2", "--force"], { input: "lost\n" });
  const forced = await doklin(editorBox, ["write", "Library/Drive/alpha", "--force", "--json"], { input: "# Alpha\n\nthird draft\n" });
  const unchanged = await doklin(editorBox, ["write", "Library/Drive/alpha", "--force"], { input: "# Alpha\n\nthird draft\n" });
  const dry = await doklin(editorBox, ["write", "Library/Drive/alpha", "--if-rev=3", "--dry-run"], { input: "never\n" });
  const now = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const last = await doklin(editorBox, ["write", "Library/Drive/alpha", "--if-rev", "3"], { input: ALPHA });
  const info = (await doklin(editorBox, ["info", "Library/Drive/alpha"])).json;
  return {
    created: created.code === 0 && same(created.json, { kind: "document", path: "Library/Drive/alpha", version: "md", file: "alpha.md", rev: 1, size: Buffer.byteLength(first), created: true }),
    "creating answered 201": asked(from)[0] === "PUT doc → 201",
    "replacing with no revision is a conflict that names it": refused(bare, 5, /--if-rev 1/) && bare.problem.code === "needs_rev" && bare.problem.rev === 1,
    "--if-rev with the revision read": second.code === 0 && second.json.rev === 2 && second.json.created === false,
    "a stale --if-rev is a conflict that says where it is now": refused(stale, 5, /revision 2, not 1/) && stale.problem.rev === 2,
    "--if-rev with --force is bad usage": refused(both, 2, /not both/),
    "--force replaces whatever is there": forced.code === 0 && forced.json.rev === 3,
    "the same text again is not a revision": unchanged.code === 0 && unchanged.json.unchanged === true && unchanged.json.rev === 3,
    "--dry-run says what would happen": dry.code === 0 && dry.json.written === false && dry.json.rev === 4,
    "…and changes nothing": now.out === "# Alpha\n\nthird draft\n" && now.meta.rev === 3,
    "nothing refused was written": last.code === 0 && last.json.rev === 4,
    "it is signed with the agent": info.md.by === editor.id && info.md.byName === "Editor bot" && info.md.rev === 4,
  };
});

await check("write --from: a file's bytes become a document; a plain file — a CSV, a picture — is refused, and nothing is written", async () => {
  const beta = "# Beta\n\nA second document, from a file.\n";
  const made = await doklin(editorBox, ["write", "Library/Drive/beta", "--from", scratchFile("beta.md", beta)]);
  const from = calls.length;
  const csv = await doklin(editorBox, ["write", "Library/Drive/data.csv", "--from", scratchFile("data.csv", "name,knots\nAda,7\n")]);
  const picture = await doklin(editorBox, ["write", "Library/Drive/pic.png", "--force"], { input: PIXEL_PNG });
  const wire = asked(from);
  const listed = JSON.stringify((await doklin(editorBox, ["ls", "--deep"])).json);
  return {
    "a document from a file": made.code === 0 && made.json.created === true && (await doklin(editorBox, ["read", "Library/Drive/beta"])).out === beta,
    "a CSV is bad usage that names what syncs": refused(csv, 2, /^Doklin syncs markdown and html documents only — "data\.csv" is neither\. Name a document/),
    "so is a picture, --force or not": refused(picture, 2, /Doklin syncs markdown and html documents only — "pic\.png" is neither/),
    "the domain refused each": same(wire, ["PUT doc → 400", "PUT doc → 400"]),
    "nothing was written": !/data\.csv|pic\.png/.test(listed),
  };
});

await check("write --html: a document gains its html version; an html-only document is first-class — and the one thing refused is writing to it without saying which version", async () => {
  const html = await doklin(editorBox, ["write", "Library/Drive/alpha", "--html"], { input: ALPHA_HTML });
  const row = (await doklin(editorBox, ["ls", "Library/Drive"])).json.documents.find((d) => d.path === "Library/Drive/alpha");
  const readHtml = await doklin(editorBox, ["read", "Library/Drive/alpha", "--html"]);

  const POSTER = "<!doctype html><html><body><h1>Regatta poster</h1><p>Saturday at noon.</p></body></html>";
  const only = await doklin(editorBox, ["write", "Library/Drive/poster.html"], { input: POSTER });
  const guess = await doklin(editorBox, ["write", "Library/Drive/poster", "--force"], { input: "# Poster\n" });
  const read = await doklin(editorBox, ["read", "Library/Drive/poster"]);
  const readMd = await doklin(editorBox, ["read", "Library/Drive/poster", "--md"]);
  const info = (await doklin(editorBox, ["info", "Library/Drive/poster"])).json;
  const replaced = await doklin(editorBox, ["write", "Library/Drive/poster", "--html", "--if-rev", "1"], { input: POSTER.replace("noon", "one") });

  const page = await doklin(editorBox, ["write", "Library/Drive/page", "--html"], { input: "<h1>Page</h1><p>Made first as html.</p>" });
  const addMd = await doklin(editorBox, ["write", "Library/Drive/page", "--md"], { input: "# Page\n\nIts markdown came second.\n" });
  const both = (await doklin(editorBox, ["info", "Library/Drive/page"])).json;
  const nowMd = await doklin(editorBox, ["read", "Library/Drive/page"]);
  return {
    "the html version is created beside the markdown": html.code === 0 && same(html.json, { kind: "document", path: "Library/Drive/alpha", version: "html", file: "alpha.html", rev: 1, size: Buffer.byteLength(ALPHA_HTML), created: true }),
    "ls shows both versions": row.md.rev === 4 && row.html.rev === 1 && row.htmlBehind === undefined,
    "it reads back": readHtml.out === ALPHA_HTML && readHtml.meta.version === "html",
    "an html-only document is created by its .html name": only.code === 0 && only.json.version === "html" && only.json.created === true && only.json.path === "Library/Drive/poster",
    "writing to it with no flag is refused, even forced": refused(guess, 2, /only an html version — say --html to replace it, or --md to add/) && guess.problem.code === "html_only",
    "reading it with no flag gives the html": read.out === POSTER && read.meta.version === "html",
    "--md says there is none": refused(readMd, 3, /only an html version/) && readMd.problem.code === "no_md",
    "info shows the one version": info.html.rev === 1 && info.md === undefined,
    "--html replaces it": replaced.code === 0 && replaced.json.rev === 2 && replaced.json.version === "html",
    "--md adds a markdown version beside an html one": page.json.created === true && addMd.code === 0 && addMd.json.version === "md" && addMd.json.created === true,
    "then the document has both, and reads as markdown": both.md.rev === 1 && both.html.rev === 1 && nowMd.meta.version === "md",
  };
});

await check("write: what the workspace cannot hold is refused — not text, a hidden or ignored path, a sidecar, a name taken in another case, a comment marker nobody started", async () => {
  const notText = await doklin(editorBox, ["write", "Library/Drive/garbled"], { input: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) });
  const invented = await doklin(editorBox, ["write", "Library/Drive/alpha", "--force"], { input: "# Alpha\n\nA {==made-up==}{>>#zzzzzz<<} marker.\n" });
  const facts = {
    "markdown that is not UTF-8": refused(notText, 2, /not UTF-8/),
    "a hidden path": refused(await doklin(editorBox, ["write", "Library/.secret/plan"], { input: "x" }), 2, /hidden/),
    "an ignored folder": refused(await doklin(editorBox, ["write", "Library/node_modules/plan"], { input: "x" }), 2, /does not sync/),
    "a sidecar": refused(await doklin(editorBox, ["write", "Library/Drive/alpha.meta.jsonl", "--force"], { input: "x" }), 2, /comments commands/),
    "a path that climbs out": refused(await doklin(editorBox, ["write", "../outside"], { input: "x" }), 2, /not a path in a workspace/),
    "a name taken in another case is that document, not a second one": refused(await doklin(editorBox, ["write", "Library/DRIVE/Alpha"], { input: "x" }), 5, /Library\/Drive\/alpha already exists/),
    "a marker no thread has": refused(invented, 2, /add a comment marker \(#zzzzzz\) — start a thread with `doklin comment`/) && invented.problem.code === "comments" && same(invented.problem.added, ["zzzzzz"]),
  };
  const alpha = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  facts["none of it touched the document"] = alpha.out === ALPHA && alpha.meta.rev === 4;
  const byOtherCase = await doklin(editorBox, ["read", "library/drive/ALPHA.md"]);
  facts["…and reads as it, under the name it has"] = byOtherCase.out === ALPHA && byOtherCase.meta.path === "Library/Drive/alpha";
  facts["none of it made a file"] = !/garbled|outside|secret|node_modules/.test(JSON.stringify((await doklin(editorBox, ["ls", "--deep"])).json));
  return facts;
});

await check("write: a name with spaces and letters beyond ASCII goes there and comes back the same", async () => {
  const name = "Library/Drive/Café notes ☕";
  const made = await doklin(editorBox, ["write", name], { input: "# Café\n\nÀ bientôt.\n" });
  const read = await doklin(editorBox, ["read", name]);
  const listed = (await doklin(editorBox, ["ls", "Library/Drive"])).json.documents.map((d) => d.path);
  // `--` ends the options, for a name that begins with a dash.
  const dashed = await doklin(editorBox, ["write", "--", "Library/Drive/-dashed"], { input: "- a list\n" });
  const dashedBack = await doklin(editorBox, ["read", "--clean", "--", "Library/Drive/-dashed"]);
  const dashedGone = await doklin(editorBox, ["rm", "--", "Library/Drive/-dashed"]);
  return {
    "a name that begins with a dash, after --": dashed.code === 0 && dashed.json.path === "Library/Drive/-dashed" && dashedBack.out === "- a list\n" && dashedGone.code === 0,
    created: made.code === 0 && made.json.path === name && made.json.file === "Café notes ☕.md",
    "read back": read.out === "# Café\n\nÀ bientôt.\n" && read.meta.path === name && read.meta.file === `${name}.md`,
    listed: listed.includes(name),
  };
});

await check("a change made on a Mac between the read and the write: the write is refused (exit 5) with the revision the document is at, and nothing is lost", async () => {
  const before = await doklin(editorBox, ["read", "Library/Scratch"]);
  await macWrites({ "Scratch.md": "# Scratch\n\nTyped on the Mac.\n" });
  const lost = await doklin(editorBox, ["write", "Library/Scratch", "--if-rev", String(before.meta.rev)], { input: "# Scratch\n\nFrom the bot.\n" });
  const after = await doklin(editorBox, ["read", "Library/Scratch"]);
  const redo = await doklin(editorBox, ["write", "Library/Scratch", "--if-rev", String(after.meta.rev)], { input: `${after.out}\nAnd from the bot.\n` });

  // The same inside one `edit`: the Mac's change lands after the CLI has read
  // the document and before its write arrives.
  meanwhile = {
    match: (req) => req.method === "PUT" && req.url.startsWith("/api/agent/doc"),
    run: () => macWrites({ "Scratch.md": "# Scratch\n\nTyped on the Mac again.\n" }),
  };
  const raced = await doklin(editorBox, ["edit", "Library/Scratch", "--find", "Typed on the Mac", "--replace", "Typed by the bot"]);
  const settled = await doklin(editorBox, ["read", "Library/Scratch"]);
  return {
    "the write is a conflict": refused(lost, 5, /changed after you read it/) && lost.problem.rev === before.meta.rev + 1,
    "the Mac's text is what is there": after.out === "# Scratch\n\nTyped on the Mac.\n" && after.meta.rev === before.meta.rev + 1,
    "reading again, then writing, works": redo.code === 0 && redo.json.rev === before.meta.rev + 2,
    "an edit that the Mac overtook is a conflict too": meanwhile === null && refused(raced, 5, /changed after you read it/),
    "…and the Mac's text stands": settled.out === "# Scratch\n\nTyped on the Mac again.\n",
  };
});

await check("edit: changes part of a document with the revision it read; --find must occur once unless --all; nothing found is exit 3; --dry-run only says", async () => {
  let from = calls.length;
  const once = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "blue", "--replace", "green"]);
  const put = calls.slice(from).find((c) => c.method === "PUT");
  const wire = asked(from);

  from = calls.length;
  const none = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "no such words", "--replace", "x"]);
  const many = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "The boat", "--replace", "A boat"]);
  const refusedWire = asked(from);

  const all = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "is ", "--replace=was ", "--all", "--json"]);
  const cut = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", " The boat was fast.", "--replace", ""]);
  const dry = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "green", "--replace", "red", "--dry-run"]);
  const now = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const html = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--html", "--find", "Alpha page", "--replace", "Alpha, the page"]);
  const onlyHtml = await doklin(editorBox, ["edit", "Library/Drive/poster", "--find", "Saturday", "--replace", "Sunday"]);
  return {
    "one place changed": once.code === 0 && once.json.rev === 5 && once.json.version === "md",
    "a read, then a write that names the revision read": same(wire, ["GET doc → 200", "PUT doc → 200"]) && put.headers["if-rev"] === "4",
    "nothing found is exit 3": refused(none, 3, /does not occur in the markdown version of Library\/Drive\/alpha/),
    "found more than once is a conflict that counts them": refused(many, 5, /occurs 3 times/),
    "neither wrote anything": same(refusedWire, ["GET doc → 200", "GET doc → 200"]),
    "--all changes every one": all.code === 0 && all.json.rev === 6,
    "--replace may be empty": cut.code === 0 && cut.json.rev === 7,
    "--dry-run says what would happen": dry.code === 0 && dry.json.written === false && dry.json.rev === 8,
    "the text after all that": now.out === "# Alpha\n\nThe boat ships in June if the paint dries.\n\nThe boat was green.\n" && now.meta.rev === 7,
    "--html edits the html version": html.code === 0 && html.json.version === "html" && html.json.rev === 2 && (await doklin(editorBox, ["read", "Library/Drive/alpha", "--html"])).out.includes("<h1>Alpha, the page</h1>"),
    "an html-only document is edited as html": onlyHtml.code === 0 && onlyHtml.json.version === "html" && (await doklin(editorBox, ["read", "Library/Drive/poster"])).out.includes("Sunday at one"),
  };
});

await check("html is behind: changing the markdown of a document that has an html version says so — in the answer, in ls, in info, when reading — until the html is written again", async () => {
  const edit = await doklin(editorBox, ["edit", "Library/Projects/plan", "--find", "June", "--replace", "July"]);
  const row = (await doklin(editorBox, ["ls", "Library/Projects"])).json.documents.find((d) => d.path === "Library/Projects/plan");
  const info = (await doklin(editorBox, ["info", "Library/Projects/plan"])).json;
  const read = await doklin(editorBox, ["read", "Library/Projects/plan"]);
  const rewritten = await doklin(editorBox, ["write", "Library/Projects/plan", "--html", "--if-rev", "1"], { input: SEED_FILES["Projects/plan.html"].replace("Rendered by hand", "Rendered again") });
  const after = (await doklin(editorBox, ["info", "Library/Projects/plan"])).json;
  return {
    "the edit's answer": edit.code === 0 && edit.json.rev === 2 && edit.json.htmlBehind === true,
    ls: row.htmlBehind === true,
    info: info.htmlBehind === true,
    read: read.out.includes("July") && read.meta.htmlBehind === true,
    "writing the html again brings it back in step": rewritten.code === 0 && rewritten.json.htmlBehind === undefined && after.htmlBehind === undefined && after.html.rev === 2,
  };
});


/* ====================================================================== */
/* 5 — comments                                                           */
/* ====================================================================== */

/** The first thread on Library/Drive/alpha's markdown, and the one on its html. */
let thread;
let htmlThread;

await check("comment: starts a thread on words of the markdown — the text gains a marker there, and the words said are the agent's; comments lists it; reply answers it", async () => {
  const from = calls.length;
  const started = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--on", "ships in June", "-m", "Is that still true?"]);
  thread = started.json.thread;
  const text = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const clean = await doklin(editorBox, ["read", "Library/Drive/alpha", "--clean"]);
  const listed = (await doklin(editorBox, ["comments", "Library/Drive/alpha"])).json;
  const answered = await doklin(reviewerBox, ["reply", "Library/Drive/alpha", thread, "--message", "Yes."]);
  const after = (await doklin(reviewerBox, ["comments", "Library/Drive/alpha.md", "--json"])).json;
  const info = (await doklin(editorBox, ["info", "Library/Drive/alpha"])).json;
  const t = listed.threads[0];
  return {
    "the answer": started.code === 0 && typeof thread === "string" && thread.length > 0 && same(started.json, { path: "Library/Drive/alpha", thread, version: "md", on: "ships in June", line: 3 }),
    "starting one answered 201": asked(from)[0] === "POST comments → 201",
    "the marker is in the text, around those words": text.out === `# Alpha\n\nThe boat {==ships in June==}{>>#${thread}<<} if the paint dries.\n\nThe boat was green.\n`,
    "the markdown moved on a revision": text.meta.rev === 8,
    "--clean reads it without the marker": clean.out === "# Alpha\n\nThe boat ships in June if the paint dries.\n\nThe boat was green.\n",
    "comments lists it": listed.path === "Library/Drive/alpha" && listed.threads.length === 1 && t.id === thread && t.version === "md" && t.on === "ships in June" && t.line === 3 && t.orphaned === undefined,
    "said by the agent, just now": t.comments.length === 1 && t.comments[0].author === "Editor bot" && t.comments[0].body === "Is that still true?" && Math.abs(Date.now() - t.comments[0].at) < 60_000,
    "reply answers it": answered.code === 0 && same(answered.json, { path: "Library/Drive/alpha", thread, version: "md", comments: 2 }),
    "…under the name of who replied": same(after.threads[0].comments.map((c) => [c.author, c.body]), [["Editor bot", "Is that still true?"], ["Reviewer bot", "Yes."]]),
    "a reply does not touch the text": (await doklin(editorBox, ["read", "Library/Drive/alpha"])).meta.rev === 8,
    "info counts the thread": info.comments === 1,
    "the sidecar never shows": !JSON.stringify((await doklin(editorBox, ["ls", "Library/Drive"])).json).includes("meta.jsonl"),
  };
});

await check("comments: a thread somebody started in the app reads back — its words, who said what, and when — and an agent can answer it", async () => {
  // As the app leaves it on disk and a Mac syncs it: a bare marker in the
  // markdown, the conversation in the sidecar (src/metaFile.ts).
  await macWrites({
    "Review.md": "# Review\n\nThe keel is {==too shallow==}{>>#k3m9x2<<} for this hull.\n",
    "Review.meta.jsonl": '{"doklin":"meta","v":1}\n{"t":"mthread","id":"k3m9x2","comments":[{"author":"Ada","at":1757000000000,"body":"By how much?"}]}\n',
  });
  const seeded = (await doklin(readerBox, ["comments", "Library/Review"])).json;
  const answered = await doklin(reviewerBox, ["reply", "Library/Review", "k3m9x2", "-m", "Two inches."]);
  const after = (await doklin(readerBox, ["comments", "Library/Review"])).json.threads[0].comments;
  return {
    "the app's thread": same(seeded, {
      path: "Library/Review",
      threads: [{ id: "k3m9x2", version: "md", on: "too shallow", line: 3, comments: [{ author: "Ada", at: 1757000000000, body: "By how much?" }] }],
    }),
    "an agent answers it": answered.code === 0 && answered.json.comments === 2 && same(after.map((c) => c.author), ["Ada", "Reviewer bot"]),
    "the text keeps its marker": (await doklin(readerBox, ["read", "Library/Review"])).out.includes("{==too shallow==}{>>#k3m9x2<<}"),
  };
});

await check("comment: words that occur more than once, or only inside another comment, are a conflict (exit 5) that says where; words that are not there are exit 3; --dry-run starts nothing", async () => {
  const twice = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--on", "The boat", "-m", "Which boat?"]);
  const absent = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--on", "no such words", "-m", "?"]);
  const inside = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--on", "ships in June", "-m", "Again?"]);
  const dry = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--on", "paint dries", "-m", "Will it?", "--dry-run"]);
  const count = (await doklin(editorBox, ["comments", "Library/Drive/alpha"])).json.threads.length;
  return {
    "twice: every place is listed": refused(twice, 5, /occurs 2 times/) && twice.problem.code === "anchor" && same(twice.problem.occurrences.map((o) => o.line), [3, 5]),
    "not at all is not found": refused(absent, 3, /does not occur/) && absent.problem.code === "anchor",
    "only inside another comment": refused(inside, 5, /only occurs inside/) && inside.problem.code === "anchor",
    "--dry-run says where it would go": dry.code === 0 && dry.json.written === false && dry.json.on === "paint dries" && dry.json.line === 3,
    "…and starts nothing": count === 1 && (await doklin(editorBox, ["read", "Library/Drive/alpha"])).meta.rev === 8,
  };
});

await check("comment --html: a thread on an element of the html version, named by its opening words; the threads of both versions are one list", async () => {
  const started = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--html", "--on", "One item", "-m", "Which one?"]);
  htmlThread = started.json.thread;
  const two = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--html", "--on", "One", "-m", "?"]);
  const none = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--html", "--on", "Nothing begins so", "-m", "?"]);
  const listed = (await doklin(editorBox, ["comments", "Library/Drive/alpha"])).json.threads;
  const poster = await doklin(reviewerBox, ["comment", "Library/Drive/poster", "--on", "Regatta", "-m", "Lovely."]);
  const noHtml = await doklin(editorBox, ["comment", "Library/Drive/beta", "--html", "--on", "Beta", "-m", "?"]);
  const noMd = await doklin(editorBox, ["comment", "Library/Drive/poster", "--md", "--on", "Regatta", "-m", "?"]);
  const h = listed.find((t) => t.id === htmlThread);
  return {
    "the answer names the element": started.code === 0 && same(started.json, { path: "Library/Drive/alpha", thread: htmlThread, version: "html", on: "One item", tag: "li" }),
    "the page itself is untouched": (await doklin(editorBox, ["read", "Library/Drive/alpha", "--html"])).meta.rev === 2,
    "two elements that begin so is a conflict, with the candidates": refused(two, 5, /2 elements/) && two.problem.code === "anchor" && same(two.problem.candidates, [{ tag: "li", text: "One item" }, { tag: "li", text: "One more item" }]),
    "none that begins so is not found": refused(none, 3, /nothing on the html page/),
    "both versions' threads are one list": same(listed.map((t) => t.version).sort(), ["html", "md"]) && h.tag === "li" && h.on === "One item" && h.comments[0].author === "Editor bot" && h.orphaned === undefined,
    "an html-only document takes a comment on its html with no flag": poster.code === 0 && poster.json.version === "html" && poster.json.tag === "h1" && poster.json.on === "Regatta poster",
    "--html where there is no html is exit 3": refused(noHtml, 3, /no html version/),
    "--md where there is no markdown is exit 3": refused(noMd, 3, /no markdown version/),
  };
});

await check("a write keeps every comment where it was: keeping a marker keeps its thread in place; dropping one or changing its words is refused, --force or not; comment rm removes a thread and unwraps its words", async () => {
  const kept = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "green", "--replace", "teal"]);
  const inPlace = (await doklin(editorBox, ["comments", "Library/Drive/alpha"])).json.threads.find((t) => t.id === thread);
  const MARKED = `# Alpha\n\nThe boat {==ships in June==}{>>#${thread}<<} if the paint dries.\n\nThe boat was teal.\n`;
  const dropped = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", `{==ships in June==}{>>#${thread}<<}`, "--replace", "leaves in July"]);
  const reworded = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "ships in June", "--replace", "leaves in July"]);
  const forced = await doklin(editorBox, ["write", "Library/Drive/alpha", "--force"], { input: MARKED.replace(`{==ships in June==}{>>#${thread}<<}`, "leaves in July") });
  const untouched = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const stillThere = (await doklin(editorBox, ["comments", "Library/Drive/alpha"])).json.threads.find((t) => t.id === thread);
  const removedFirst = await doklin(editorBox, ["comment", "rm", "Library/Drive/alpha", thread]);
  const rewritten = await doklin(editorBox, ["edit", "Library/Drive/alpha", "--find", "ships in June", "--replace", "leaves in July"]);

  const second = await doklin(editorBox, ["comment", "Library/Drive/alpha", "--on", "paint dries", "-m", "Will it?"]);
  const marked = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const dry = await doklin(editorBox, ["comment", "rm", "Library/Drive/alpha", second.json.thread, "--dry-run"]);
  const removed = await doklin(editorBox, ["comment", "rm", "Library/Drive/alpha", second.json.thread, "--json"]);
  const plain = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const left = (await doklin(editorBox, ["comments", "Library/Drive/alpha"])).json.threads;
  return {
    "a write that keeps the marker keeps the thread in place": kept.code === 0 && inPlace.on === "ships in June" && inPlace.orphaned === undefined,
    "a write that drops it is refused, and says how to remove the thread": refused(dropped, 2, new RegExp(`remove the marker of comment #${thread} \\(on "ships in June"\\).*\`doklin comment rm Library/Drive/alpha ${thread}\``)) && dropped.problem.code === "comments" && same(dropped.problem.threads, [thread]),
    "so is one that changes its words": refused(reworded, 2, new RegExp(`change the words of comment #${thread}`)) && same(reworded.problem.threads, [thread]),
    "--force does not get past it": refused(forced, 2, /remove the marker of comment/),
    "the text and the thread are as they were": untouched.out === MARKED && stillThere.orphaned === undefined && stillThere.comments.length === 2,
    "comment rm first, and then the words are the agent's to change": removedFirst.code === 0 && same(removedFirst.json, { path: "Library/Drive/alpha", thread, version: "md", removed: true }) && rewritten.code === 0,
    "a second thread marks its words": marked.out.includes(`the {==paint dries==}{>>#${second.json.thread}<<}.`),
    "comment rm --dry-run removes nothing": dry.code === 0 && dry.json.removed === false,
    "comment rm unwraps the words": removed.code === 0 && removed.json.removed === true && plain.out === "# Alpha\n\nThe boat leaves in July if the paint dries.\n\nThe boat was teal.\n",
    "only the html thread is left": same(left.map((t) => t.id), [htmlThread]),
  };
});

await check("comments: a thread or a document that is not there is exit 3; a plain file is no document to comment on", async () => ({
  "reply to no thread": refused(await doklin(editorBox, ["reply", "Library/Drive/alpha", "nosuch", "-m", "x"]), 3, /no thread #nosuch/),
  "comment rm of no thread": refused(await doklin(editorBox, ["comment", "rm", "Library/Drive/alpha", "nosuch"]), 3, /no thread #nosuch/),
  "comments on no document": refused(await doklin(editorBox, ["comments", "Library/Nope"]), 3, /no document at "Library\/Nope"/),
  "comment on no document": refused(await doklin(editorBox, ["comment", "Library/Nope", "--on", "a", "-m", "b"]), 3, /no document at "Library\/Nope"/),
  "a plain file": refused(await doklin(editorBox, ["comments", "Library/Drive/data.csv"]), 2, /Doklin syncs markdown and html documents only — "data\.csv" is neither/),
  "nor is one to start a thread on": refused(await doklin(editorBox, ["comment", "Library/Drive/data.csv", "--on", "Ada", "-m", "Who?"]), 2, /Doklin syncs markdown and html documents only/),
}));

/* ====================================================================== */
/* 6 — publishing                                                         */
/* ====================================================================== */

/** Library/Drive/alpha's page: {slug, url}. */
let alphaPage;
const published = async (box = editorBox) => (await doklin(box, ["published"])).json.pages;

await check("publish: a document gets an address that answers at once; publishing again changes nothing; --slug, --title and --desc; published lists it with who published it", async () => {
  const from = calls.length;
  const first = await doklin(editorBox, ["publish", "Library/Drive/alpha"]);
  alphaPage = { slug: first.json.slug, url: first.json.url };
  const page = await fetch(alphaPage.url);
  const again = await doklin(editorBox, ["publish", "Library/Drive/alpha.md", "--json"]);
  const named = await doklin(editorBox, ["publish", "Library/Drive/beta", "--slug", "beta-page", "--title", "Beta, in public", "--desc", "What beta is about"]);
  const betaPage = await fetch(`${WORKER}/beta-page`);
  const pages = await published();
  const bySlug = (slug) => pages.find((p) => p.slug === slug) ?? {};
  const mine = bySlug(alphaPage.slug);
  const addresses = (await doklin(editorBox, ["info", "Library/Drive/alpha"])).json.public;
  return {
    "the answer": first.code === 0 && /^[a-z2-9]{8}$/.test(alphaPage.slug) && same(first.json, { slug: alphaPage.slug, url: `${WORKER}/${alphaPage.slug}`, kind: "document", path: "Library/Drive/alpha", documents: ["Library/Drive/alpha"], created: true }),
    "publishing answered 201": asked(from)[0] === "PUT pages → 201",
    "the address answers": page.status === 200,
    "again is the same page, and nothing is written": again.code === 0 && again.json.slug === alphaPage.slug && again.json.created === false && again.json.written === false,
    "--slug chooses the address": named.code === 0 && named.json.slug === "beta-page" && named.json.url === `${WORKER}/beta-page` && betaPage.status === 200,
    "--title is the page's title": (await betaPage.text()).includes("Beta, in public"),
    "published lists it, with who and when": mine.kind === "document" && mine.path === "Library/Drive/alpha" && mine.url === alphaPage.url && mine.by === editor.id && mine.byName === "Editor bot" && Math.abs(Date.now() - mine.at) < 60_000,
    "…and its title and description": bySlug("beta-page").title === "Beta, in public" && bySlug("beta-page").desc === "What beta is about",
    "the pages that were there": bySlug("home").home === true && bySlug("ghost").missing === true && bySlug("projects").kind === "folder" && bySlug("projects").path === "Library/Projects",
    "info shows the address": same(addresses, [alphaPage.url]),
  };
});

await check("publish: an address already taken is a conflict (exit 5); one that is no address is bad usage; nothing to publish is exit 3; a folder is looked at with --dry-run, then published", async () => {
  const taken = await doklin(editorBox, ["publish", "Library/Drive/page", "--slug", "plan"]);
  const bad = await doklin(editorBox, ["publish", "Library/Drive/page", "--slug", "No Such Address!"]);
  const missing = await doklin(editorBox, ["publish", "Library/Nope"]);
  const dry = await doklin(editorBox, ["publish", "Library/Drive/", "--dry-run", "--slug", "drive"]);
  const before = (await published()).some((p) => p.slug === "drive");
  const real = await doklin(editorBox, ["publish", "Library/Drive/", "--slug", "drive"]);
  const after = (await published()).find((p) => p.slug === "drive") ?? {};
  const addresses = (await doklin(editorBox, ["info", "Library/Drive/alpha"])).json.public;
  const whole = await doklin(editorBox, ["publish", "Library/", "--dry-run"]);
  const wholeWords = (await doklin(editorBox, ["publish", "Library/", "--dry-run"], { tty: true })).out;
  // Every document in the folder, the html-only one among them.
  const inFolder = ["Library/Drive/Café notes ☕", "Library/Drive/alpha", "Library/Drive/beta", "Library/Drive/page", "Library/Drive/poster"];
  return {
    "an address that is taken": refused(taken, 5, /"plan" is already the address of/) && taken.problem.code === "slug_taken",
    "something that is no address": refused(bad, 2, /an address is 3 to 64 characters/),
    "nothing there to publish": refused(missing, 3, /nothing at "Library\/Nope" to publish/),
    "--dry-run lists every document that would become public": dry.code === 0 && dry.json.kind === "folder" && dry.json.path === "Library/Drive" && dry.json.written === false && same([...dry.json.documents].sort(), inFolder),
    "…and publishes nothing": before === false,
    "the folder is published": real.code === 0 && real.json.created === true && real.json.url === `${WORKER}/drive` && same([...real.json.documents].sort(), inFolder),
    "published lists the folder": after.kind === "folder" && after.path === "Library/Drive" && after.byName === "Editor bot",
    // In the order of their addresses, and the page's own is a random one.
    "a document in it has two addresses now": same([...addresses].sort(), [alphaPage.url, `${WORKER}/drive/alpha`].sort()),
    "the address inside the folder answers": (await fetch(`${WORKER}/drive/beta`)).status === 200,
    "Library/ is every document everyone sees, and nothing of Private's": whole.code === 0 && whole.json.kind === "folder" && whole.json.path === "Library" && whole.json.written === false && whole.json.documents.includes("Library/Home") && inFolder.every((d) => whole.json.documents.includes(d)) && whole.json.documents.every((d) => d.startsWith("Library/")),
    "…and a person reads it as the folder it is": /Would publish the folder Library at http:\S+ — \d+ documents would be public:\n  Library\/Comments\n/.test(wholeWords),
  };
});

/* ====================================================================== */
/* 7 — moving and removing                                                */
/* ====================================================================== */

await check("mv: a document moves whole — both versions and its comments — whatever extension is typed, and its page follows; into a folder; a rename; a folder; --dry-run only says", async () => {
  const dry = await doklin(editorBox, ["mv", "Library/Drive/alpha", "Library/Drive/Archive/alpha2", "--dry-run"]);
  const stillThere = (await doklin(editorBox, ["info", "Library/Drive/alpha"])).code === 0;
  const moved = await doklin(editorBox, ["mv", "Library/Drive/alpha.md", "Library/Drive/Archive/alpha2"]);
  const info = (await doklin(editorBox, ["info", "Library/Drive/Archive/alpha2"])).json;
  const threads = (await doklin(editorBox, ["comments", "Library/Drive/Archive/alpha2"])).json.threads;
  const gone = await doklin(editorBox, ["read", "Library/Drive/alpha"]);
  const page = await fetch(alphaPage.url);
  const listed = (await published()).find((p) => p.slug === alphaPage.slug) ?? {};
  const into = await doklin(editorBox, ["mv", "Library/Drive/beta", "Library/Drive/Archive/"]);
  const renamed = await doklin(editorBox, ["mv", "Library/Drive/Archive/beta", "Library/Drive/Archive/gamma", "--json"]);
  const folder = await doklin(editorBox, ["mv", "Library/Drive/Archive", "Library/Drive/Old"]);
  const old = (await doklin(editorBox, ["ls", "Library/Drive/Old"])).json;
  const text = await doklin(editorBox, ["read", "Library/Drive/Old/alpha2"]);
  return {
    "--dry-run says what would move": dry.code === 0 && same(dry.json, { kind: "document", from: "Library/Drive/alpha", to: "Library/Drive/Archive/alpha2", files: 3, moved: false }) && stillThere,
    "the document moved: markdown, html and comments": moved.code === 0 && same(moved.json, { kind: "document", from: "Library/Drive/alpha", to: "Library/Drive/Archive/alpha2", files: 3 }),
    "both versions are there": info.md.file === "alpha2.md" && info.html.file === "alpha2.html" && info.comments === 1,
    "so are its comments": same(threads.map((t) => t.id), [htmlThread]),
    "nothing is left where it was": refused(gone, 3),
    "its page follows it": page.status === 200 && listed.path === "Library/Drive/Archive/alpha2",
    "a destination ending in / means into it": into.code === 0 && same(into.json, { kind: "document", from: "Library/Drive/beta", to: "Library/Drive/Archive/beta", files: 1 }),
    "a rename": renamed.code === 0 && same(renamed.json, { kind: "document", from: "Library/Drive/Archive/beta", to: "Library/Drive/Archive/gamma", files: 1 }),
    "a folder, with everything in it": folder.code === 0 && same(folder.json, { kind: "folder", from: "Library/Drive/Archive", to: "Library/Drive/Old", files: 4 }),
    "what the folder holds now": same(old.documents.map((d) => d.path), ["Library/Drive/Old/alpha2", "Library/Drive/Old/gamma"]) && same(old.folders, []),
    "a move is not an edit: the text is the same": text.out === "# Alpha\n\nThe boat leaves in July if the paint dries.\n\nThe boat was teal.\n",
    "a renamed document's page follows it too": (await published()).find((p) => p.slug === "beta-page")?.path === "Library/Drive/Old/gamma" && (await fetch(`${WORKER}/beta-page`)).status === 200,
  };
});

await check("mv: into another section, a document keeps its link — a link from before still opens it, and info names its section now; inside a section its link stays; a section as the destination means into it", async () => {
  const fileOf = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get("f");
  const made = await doklin(editorBox, ["write", "Library/Drive/linked"], { input: "# Linked\n" });
  const before = (await doklin(editorBox, ["info", "Library/Drive/linked"])).json.link;
  const dry = await doklin(editorBox, ["mv", "Library/Drive/linked", "Private/", "--dry-run"]);
  const words = (await doklin(editorBox, ["mv", "Library/Drive/linked", "Private/"], { tty: true })).out;
  const stale = await doklin(editorBox, ["read", before]);
  const after = (await doklin(editorBox, ["info", "Private/linked"])).json.link;
  const opened = await doklin(editorBox, ["read", after]);
  const renamed = await doklin(editorBox, ["mv", "Private/linked", "Private/kept"]);
  const kept = (await doklin(editorBox, ["info", "Private/kept"])).json.link;
  const back = await doklin(editorBox, ["mv", "Private/kept", "Library/"]);
  const home = (await doklin(editorBox, ["info", "Library/kept"])).json.link;
  return {
    "written, with a link": made.code === 0 && typeof before === "string",
    "a dry run says nothing of links": dry.code === 0 && dry.json.newLinks === undefined && dry.json.moved === false,
    "nor does the move": !/\blinks?\b/i.test(words),
    "a link from before still opens it": stale.code === 0 && stale.out === "# Linked\n" && stale.meta.path === "Private/linked",
    "info names its section now, under the same file": after !== before && /&s=p-[0-9a-f]+&/.test(after) && fileOf(after) === fileOf(before) && opened.code === 0 && opened.out === "# Linked\n",
    "a move inside the section keeps it": renamed.code === 0 && kept === after,
    "back in Library, it is the link it had": back.code === 0 && back.json.to === "Library/kept" && home === before,
  };
});

await check("mv: onto something that is there is a conflict (exit 5); nothing to move is exit 3; a folder into itself, a plain file, or anything to a hidden place, is bad usage", async () => ({
  "onto a document": refused(await doklin(editorBox, ["mv", "Library/Drive/Old/gamma", "Library/Drive/Old/alpha2"]), 5, /already/),
  "a plain file is no document to move": refused(await doklin(editorBox, ["mv", "Library/Drive/data.csv", "Library/Drive/Old"]), 2, /Doklin syncs markdown and html documents only — "data\.csv" is neither/),
  "nothing there": refused(await doklin(editorBox, ["mv", "Library/Nope", "Library/Somewhere"]), 3, /nothing at "Library\/Nope"/),
  "a section itself": refused(await doklin(editorBox, ["mv", "Library", "Private/Library"]), 2, /^Library is a section of this workspace, not a folder to move/),
  "a folder into itself": refused(await doklin(editorBox, ["mv", "Library/Drive/Old", "Library/Drive/Old/Inner"]), 2, /inside itself/),
  "to a hidden place": refused(await doklin(editorBox, ["mv", "Library/Drive/Old/gamma", "Library/.hidden/gamma"]), 2, /hidden/),
  "nothing moved": same((await doklin(editorBox, ["ls", "Library/Drive/Old"])).json.documents.map((d) => d.path), ["Library/Drive/Old/alpha2", "Library/Drive/Old/gamma"]),
}));

await check("rm: one version with --html or --md, never the last; the whole document with its comments; --dry-run only says; a page outlives its document; a plain file is refused", async () => {
  const dry = await doklin(editorBox, ["rm", "Library/Drive/Old/alpha2", "--html", "--dry-run"]);
  const html = await doklin(editorBox, ["rm", "Library/Drive/Old/alpha2", "--html"]);
  const info = (await doklin(editorBox, ["info", "Library/Drive/Old/alpha2"])).json;
  const last = await doklin(editorBox, ["rm", "Library/Drive/Old/alpha2", "--md"]);
  const noHtml = await doklin(editorBox, ["rm", "Library/Drive/Old/alpha2", "--html"]);
  const dryWhole = await doklin(editorBox, ["rm", "Library/Drive/Old/alpha2", "--dry-run"]);
  const stillThere = (await doklin(editorBox, ["info", "Library/Drive/Old/alpha2"])).code === 0;
  const whole = await doklin(editorBox, ["rm", "Library/Drive/Old/alpha2.md"]);
  const gone = await doklin(editorBox, ["read", "Library/Drive/Old/alpha2"]);
  const page = await fetch(alphaPage.url);
  const listed = (await published()).find((p) => p.slug === alphaPage.slug) ?? {};
  return {
    "--dry-run says what would go": dry.code === 0 && same(dry.json, { kind: "document", path: "Library/Drive/Old/alpha2", versions: ["html"], threadsRemoved: 1, removed: false }),
    "--html removes the html, and the threads that were on it": html.code === 0 && same(html.json, { kind: "document", path: "Library/Drive/Old/alpha2", versions: ["html"], threadsRemoved: 1 }),
    "the document keeps its markdown": info.md.file === "alpha2.md" && info.html === undefined && info.comments === 0,
    "the last version cannot go that way": refused(last, 5, /only version/) && last.problem.code === "last_version",
    "a version that is not there is exit 3": refused(noHtml, 3, /no html version/),
    "rm --dry-run of the document": dryWhole.code === 0 && dryWhole.json.removed === false && stillThere,
    "the whole document, by either name": whole.code === 0 && same(whole.json, { kind: "document", path: "Library/Drive/Old/alpha2", versions: ["md"], stillPublic: [alphaPage.url] }),
    "it is gone": refused(gone, 3),
    "its page answers 404 and is listed as missing": page.status === 404 && listed.missing === true && listed.path === "Library/Drive/Old/alpha2",
    "a plain file is bad usage": refused(await doklin(editorBox, ["rm", "Library/Drive/Old/data.csv", "--json"]), 2, /Doklin syncs markdown and html documents only — "data\.csv" is neither/),
    "what is not there is exit 3": refused(await doklin(editorBox, ["rm", "Library/Nope"]), 3, /there is no document at "Library\/Nope"/),
  };
});

await check("unpublish: by the document, by the folder, by the address, and by the name of a document that is gone; what is not published is exit 3; --dry-run only says", async () => {
  const dry = await doklin(editorBox, ["unpublish", "Library/Drive/Old/gamma", "--dry-run"]);
  const stillUp = (await fetch(`${WORKER}/beta-page`)).status;
  const byDocument = await doklin(editorBox, ["unpublish", "Library/Drive/Old/gamma.md"]);
  const down = (await fetch(`${WORKER}/beta-page`)).status;
  const dead = await doklin(editorBox, ["unpublish", "Library/Drive/Old/alpha2"]);
  const byFolder = await doklin(editorBox, ["unpublish", "Library/Drive/", "--json"]);
  await doklin(editorBox, ["publish", "Library/Drive/page", "--slug", "page-two"]);
  const byAddress = await doklin(editorBox, ["unpublish", "page-two", "--slug"]);
  await doklin(editorBox, ["publish", "Library/Drive/page", "--slug", "page-three"]);
  const byWord = await doklin(editorBox, ["unpublish", "page-three"]);
  const slugs = (await published()).map((p) => p.slug);
  return {
    "--dry-run says what would stop": dry.code === 0 && same(dry.json, { stopped: [{ slug: "beta-page", url: `${WORKER}/beta-page` }], written: false }) && stillUp === 200,
    "by the document": byDocument.code === 0 && same(byDocument.json, { stopped: [{ slug: "beta-page", url: `${WORKER}/beta-page` }] }) && down === 404,
    "by the name of a document that is gone": dead.code === 0 && same(dead.json.stopped, [alphaPage]),
    "by the folder": byFolder.code === 0 && same(byFolder.json.stopped, [{ slug: "drive", url: `${WORKER}/drive` }]),
    "by the address, with --slug": byAddress.code === 0 && byAddress.json.stopped[0].slug === "page-two",
    "by the address alone": byWord.code === 0 && byWord.json.stopped[0].slug === "page-three",
    "none of them is listed any more": !slugs.some((s) => ["beta-page", "drive", "page-two", "page-three", alphaPage.slug].includes(s)),
    "the pages that were there still are": ["home", "plan", "projects", "ghost"].every((s) => slugs.includes(s)),
    "a document that is not published is exit 3": refused(await doklin(editorBox, ["unpublish", "Library/Scratch"]), 3, /"Library\/Scratch" is not published/),
    "an address nothing is published at is exit 3": refused(await doklin(editorBox, ["unpublish", "nothing-here", "--slug"]), 3, /nothing is published at "nothing-here"/),
  };
});

/* ====================================================================== */
/* 8 — search                                                             */
/* ====================================================================== */

await check("search: the first search waits while the domain reads the workspace into its index — a 202, asked again — and then answers: documents, their lines, a total", async () => {
  // Sixty documents a Mac synced: more than one request may read into the index.
  const herd = {};
  for (let i = 1; i <= 60; i += 1) herd[`Herd/doc-${String(i).padStart(2, "0")}.md`] = `# Doc ${i}\n\nA zebrafish swims here.\n`;
  await macWrites(herd);
  const from = calls.length;
  const first = await doklin(editorBox, ["search", "zebrafish"]);
  const wire = asked(from);
  const j = first.json;
  return {
    "it asked again while the index was being read": wire.filter((w) => w === "GET search → 202").length >= 1 && wire.at(-1) === "GET search → 200",
    "…and asked nothing else": wire.every((w) => w.startsWith("GET search")),
    "the whole answer, once": first.code === 0 && first.out.trim().split("\n").length === 1 && first.err === "",
    "documents, a total, and that there are more": j.query === "zebrafish" && j.total === 60 && j.results.length === 20 && j.truncated === true,
    "each with its lines": same(j.results[0], { path: "Library/Herd/doc-01", version: "md", matches: [{ line: 3, text: "A zebrafish swims here." }] }),
  };
});

await check("search: whatever its case; a phrase, quoted or not; --in a folder; --limit; what was said in a comment; an html-only document; what a Mac just changed; nothing found is still exit 0; a name", async () => {
  await doklin(editorBox, ["write", "Library/Drive/zebra-note"], { input: `${Array.from({ length: 7 }, (_, i) => `Line ${i + 1}: the Zebrafish again.`).join("\n")}\n` });
  const inDrive = (await doklin(editorBox, ["search", "ZEBRAFISH", "--in", "Library/Drive"])).json;
  const inHerd = (await doklin(readerBox, ["search", "zebrafish", "--in", "Library/Herd", "--limit", "30"])).json;
  const capped = (await doklin(editorBox, ["search", "zebrafish", "--limit=100"])).json;
  const phrase = (await doklin(editorBox, ["search", "or", "a", "jetpack"])).json;
  const quoted = (await doklin(editorBox, ["search", "Or a jetpack", "--json"])).json;
  const comment = (await doklin(editorBox, ["search", "two inches"])).json;
  const htmlOnly = (await doklin(editorBox, ["search", "regatta"])).json;
  await macWrites({ "Scratch.md": "# Scratch\n\nThe halyard needs splicing.\n" });
  const fromMac = (await doklin(editorBox, ["search", "halyard"])).json;
  const nothing = await doklin(editorBox, ["search", "qqzzxxqq"]);
  const byName = (await doklin(editorBox, ["search", "Zebra-Note"])).json;
  await doklin(editorBox, ["rm", "Library/Drive/zebra-note"]);
  const afterRm = (await doklin(editorBox, ["search", "zebrafish", "--in", "Library/Drive"])).json;
  const poster = htmlOnly.results.find((r) => r.path === "Library/Drive/poster") ?? { matches: [{}] };
  return {
    "case does not matter; --in keeps to a folder": inDrive.total === 1 && inDrive.dir === "Library/Drive" && inDrive.results[0].path === "Library/Drive/zebra-note",
    "five lines are shown and the rest counted": inDrive.results[0].matches.length === 5 && inDrive.results[0].moreLines === 2 && same(inDrive.results[0].matches[0], { line: 1, text: "Line 1: the Zebrafish again." }),
    "--limit shows that many": inHerd.total === 60 && inHerd.results.length === 30 && inHerd.truncated === true,
    "--limit is capped at 30": capped.total === 61 && capped.results.length === 30,
    "words not in quotes are a phrase": same(phrase.results, [{ path: "Library/Ideas", version: "md", matches: [{ line: 3, text: "A teleporter, or a jetpack." }] }]) && same(quoted.results, phrase.results),
    "what was said in a comment": comment.total === 1 && comment.results[0].path === "Library/Review" && comment.results[0].inComments === true && same(comment.results[0].matches, []),
    "an html-only document, by the text of its page": poster.version === "html" && poster.matches[0].text === "Regatta poster" && poster.matches[0].line === undefined,
    "what a Mac just changed": fromMac.total === 1 && same(fromMac.results[0], { path: "Library/Scratch", version: "md", matches: [{ line: 3, text: "The halyard needs splicing." }] }),
    "nothing found is an answer, not a refusal": nothing.code === 0 && nothing.json.total === 0 && same(nothing.json.results, []),
    "a document by its name": same(byName.results, [{ path: "Library/Drive/zebra-note", version: "md", matches: [], inName: true }]),
    "a removed document is not found": afterRm.total === 0,
  };
});

/* ====================================================================== */
/* 9 — what an agent may do                                               */
/* ====================================================================== */

await check("permissions: an agent that may only read reads everything and changes nothing — each refusal is exit 4 and names the permission it lacks", async () => {
  const facts = {};
  for (const args of [["whoami"], ["ls"], ["info", "Library/Home"], ["read", "Library/Home"], ["comments", "Library/Review"], ["published"], ["search", "halyard"]]) {
    facts[`may ${args.join(" ")}`] = (await doklin(readerBox, args)).code === 0;
  }
  const denied = {
    edit: [
      ["write", "Library/Drive/denied"], ["write", "Library/Home", "--force"], ["write", "Library/Drive/denied", "--dry-run"],
      ["edit", "Library/Home", "--find", "Welcome", "--replace", "Hello"], ["mv", "Library/Home", "Library/Away"], ["rm", "Library/Home"], ["rm", "Library/Home", "--dry-run"],
    ],
    comment: [["comment", "Library/Home", "--on", "Welcome", "-m", "hi"], ["reply", "Library/Review", "k3m9x2", "-m", "hi"], ["comment", "rm", "Library/Review", "k3m9x2"]],
    publish: [["publish", "Library/Scratch"], ["publish", "Library/Scratch", "--dry-run"], ["unpublish", "Library/Home"]],
  };
  for (const [need, list] of Object.entries(denied)) {
    for (const args of list) {
      const r = await doklin(readerBox, args, { input: "x\n" });
      facts[`may not ${args.join(" ")}`] = refused(r, 4, /this agent may not/) && r.problem.need === need && same(r.problem.scopes, ["read"]);
    }
  }
  facts["nothing changed"] = (await doklin(readerBox, ["read", "Library/Home"])).out === SEED_FILES["Home.md"] && (await doklin(readerBox, ["info", "Library/Drive/denied"])).code === 3;
  return facts;
});

await check("permissions: comment without edit is a reviewer; edit without publish cannot make anything public", async () => {
  const said = await doklin(reviewerBox, ["comment", "Library/Scratch", "--on", "halyard", "-m", "Which one?"]);
  const reviewerMay = (need, r) => refused(r, 4, /this agent may not/) && r.problem.need === need;
  const wrote = await doklin(writerBox, ["write", "Library/Drive/by-writer"], { input: "# Mine\n" });
  return {
    "a reviewer may comment": said.code === 0 && said.json.version === "md",
    "…and may not write": reviewerMay("edit", await doklin(reviewerBox, ["write", "Library/Scratch", "--force"], { input: "x" })),
    "…or move": reviewerMay("edit", await doklin(reviewerBox, ["mv", "Library/Scratch", "Library/Scratched"])),
    "…or remove": reviewerMay("edit", await doklin(reviewerBox, ["rm", "Library/Scratch"])),
    "…or publish": reviewerMay("publish", await doklin(reviewerBox, ["publish", "Library/Scratch"])),
    "a writer may write": wrote.code === 0 && wrote.json.created === true,
    "…and may not comment": reviewerMay("comment", await doklin(writerBox, ["comment", "Library/Drive/by-writer", "--on", "Mine", "-m", "hm"])),
    "…or publish": reviewerMay("publish", await doklin(writerBox, ["publish", "Library/Drive/by-writer"])),
    "…or stop publishing": reviewerMay("publish", await doklin(writerBox, ["unpublish", "Library/Home"])),
    "…but sees what is public": (await doklin(writerBox, ["published"])).code === 0,
  };
});

/* ====================================================================== */
/* 10 — what the owner takes away                                         */
/* ====================================================================== */

await check("what the owner takes away is gone on the next request: a permission (exit 4), one machine's login (exit 6), the agent itself (exit 6)", async () => {
  const narrow = await owner(`/api/auth/agents/${writer.id}`, { method: "POST", json: { scopes: ["read"] } });
  const narrowed = await doklin(writerBox, ["write", "Library/Drive/by-writer", "--force"], { input: "again\n" });
  const me = (await doklin(writerBox, ["whoami"])).json;

  const reviewerMachine = (await listed(reviewer)).machines[0];
  const revoke = await owner(`/api/auth/agents/${reviewer.id}/tokens/${reviewerMachine.id}`, { method: "DELETE" });
  const loggedOut = await doklin(reviewerBox, ["whoami"]);
  const loggedOutRead = await doklin(reviewerBox, ["read", "Library/Home"]);
  const loggedOutWrite = await doklin(reviewerBox, ["comment", "Library/Scratch", "--on", "splicing", "-m", "?"]);

  const remove = await owner(`/api/auth/agents/${writer.id}`, { method: "DELETE" });
  const removed = await doklin(writerBox, ["ls"]);
  return {
    "a permission": narrow.status === 200 && refused(narrowed, 4, /this agent may not change documents/) && same(me.scopes, ["read"]),
    "one machine's login": revoke.status === 204 && [loggedOut, loggedOutRead, loggedOutWrite].every((r) => refused(r, 6, /login to localhost:\d+ no longer works/)),
    "the agent itself": remove.status === 204 && refused(removed, 6, /no longer works/),
    "the refusal is the gate's own 401": loggedOut.problem.exit === 6 && calls.at(-1).status === 401,
  };
});

await check("a machine that was logged out by the owner logs in again with a new code", async () => {
  const r = await doklin(reviewerBox, ["login", BASE, await newCode(reviewer)]);
  const said = await doklin(reviewerBox, ["comment", "Library/Scratch", "--on", "splicing", "-m", "With what?"]);
  return {
    "login": r.code === 0 && credsOf(reviewerBox).workspaces.length === 1,
    "and works": said.code === 0,
    "the owner sees the one machine": (await listed(reviewer)).machines.length === 1,
  };
});

/* ====================================================================== */
/* 11 — more than one workspace on a machine                              */
/* ====================================================================== */

// The same worker under two addresses — through the relay, and straight to
// its own port — which the CLI knows as two domains, each with an agent of
// its own. (A second workspace would be a second worker; what -w picks is
// the entry in the credentials file, and that is what differs here.)
const DIRECT = `http://127.0.0.1:${WORKER_PORT}`;
const DIRECT_DOMAIN = `127.0.0.1:${WORKER_PORT}`;
const second = await addAgent("Second bot", ["read"]);
const third = await addAgent("Third bot", ["read", "edit"]);
const multi = machine("multi");

await check("-w: a machine logged in to two domains must say which; -w picks one, however the domain is spelt; logout takes one and leaves the other", async () => {
  const one = await doklin(multi, ["login", BASE, second.code]);
  const two = await doklin(multi, ["login", DIRECT, third.code]);
  const entries = credsOf(multi).workspaces.map((w) => [w.endpoint, w.agent]);
  const neither = await doklin(multi, ["whoami"]);
  const a = await doklin(multi, ["whoami", "-w", DOMAIN]);
  const b = await doklin(multi, ["whoami", "--workspace", `${DIRECT}/`]);
  const c = await doklin(multi, ["whoami", `--workspace=${DOMAIN.toUpperCase()}`]);
  const wrote = await doklin(multi, ["write", "Library/Drive/by-third", "-w", DIRECT_DOMAIN], { input: "# Third\n" });
  const denied = await doklin(multi, ["write", "Library/Drive/by-second", "-w", DOMAIN], { input: "# Second\n" });
  const elsewhere = await doklin(multi, ["whoami", "-w", "elsewhere.example.com"]);
  const which = await doklin(multi, ["logout"]);
  const out = await doklin(multi, ["logout", "-w", DOMAIN]);
  const left = credsOf(multi).workspaces.map((w) => w.endpoint);
  const alone = await doklin(multi, ["whoami"]);
  return {
    "both logins are kept": one.code === 0 && two.code === 0 && same(entries, [[BASE, "Second bot"], [DIRECT, "Third bot"]]),
    "with two, a command must be told which": refused(neither, 2, new RegExp(`logged in to ${DOMAIN}, ${DIRECT_DOMAIN} — say which with -w`)),
    "-w picks": a.json.agent.name === "Second bot" && b.json.agent.name === "Third bot" && c.json.agent.name === "Second bot",
    "each acts with its own permissions": wrote.code === 0 && refused(denied, 4),
    "-w for a domain not logged in to is exit 6": refused(elsewhere, 6, /not logged in to elsewhere\.example\.com/),
    "logout must be told which, too": refused(which, 2, /say which with -w/),
    "logout -w takes that one": out.code === 0 && same(out.json, { endpoint: BASE, loggedOut: true }) && same(left, [DIRECT]),
    "…revokes it on the domain, and leaves the other": (await listed(second)).machines.length === 0 && (await listed(third)).machines.length === 1,
    "with one left, no -w is needed": alone.code === 0 && alone.json.agent.name === "Third bot",
  };
});

/* ====================================================================== */
/* 12 — on a terminal                                                     */
/* ====================================================================== */

const canTty =
  process.platform in SCRIPT_ARGS &&
  (await new Promise((resolve) => {
    const probe = spawn("script", SCRIPT_ARGS[process.platform](["true"]), { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  }));

if (!canTty) {
  console.log("SKIP  on a terminal: there is no script(1) here to give the CLI a terminal, so the sentences a person reads were not driven");
} else {
  const terminal = await addAgent("Terminal bot", ALL_SCOPES);
  const ttyBox = machine("terminal");
  const t = (args) => doklin(ttyBox, args, { tty: true });

  await check("on a terminal: sentences, not JSON — login, whoami, ls, info, read, each change and its dry run, comments, published, search; --json is still JSON", async () => {
    const login = await t(["login", BASE, terminal.code]);
    const whoami = await t(["whoami"]);
    const ls = await t(["ls", "Library/Projects"]);
    const info = await t(["info", "Library/Projects/plan"]);
    const read = await t(["read", "Library/Scratch", "--clean"]);
    const write = await t(["write", "Library/Drive/typed", "--from", scratchFile("typed.md", "# Typed\n\nBy hand.\n")]);
    const dryWrite = await t(["write", "Library/Drive/typed", "--force", "--dry-run", "--from", scratchFile("typed-again.md", "# Typed\n\nAgain.\n")]);
    const edit = await t(["edit", "Library/Drive/typed", "--find", "By hand", "--replace", "By machine"]);
    const comment = await t(["comment", "Library/Drive/typed", "--on", "By machine", "-m", "Really?"]);
    const comments = await t(["comments", "Library/Drive/typed"]);
    const mv = await t(["mv", "Library/Drive/typed", "Library/Drive/typed-2", "--dry-run"]);
    const publish = await t(["publish", "Library/Drive/", "--dry-run"]);
    const pages = await t(["published"]);
    const search = await t(["search", "by machine"]);
    const rmDry = await t(["rm", "Library/Drive/typed", "--dry-run"]);
    const rm = await t(["rm", "Library/Drive/typed"]);
    const json = await t(["whoami", "--json"]);
    return {
      login: login.code === 0 && login.out.includes(`Logged in to Notes (${DOMAIN}) as Terminal bot. It may read, comment, edit and publish.`) && login.out.includes("doklin help agent") && !login.out.includes("dka_") &&
        login.out.includes("Every path starts with its section: Library/, Private/ or Restricted/<folder>/.\nPut new work under Private/ unless you are told where it goes."),
      whoami:
        whoami.out.includes(`Terminal bot, Sherin's agent on Notes (${DOMAIN})`) &&
        whoami.out.includes("It may read, comment, edit and publish.") &&
        whoami.out.includes("It sees Library/ and Private/.") &&
        /Worker version \d+\./.test(whoami.out),
      ls: ls.out.includes("Library/Projects/Roadmap/\n") && ls.out.includes("Library/Projects/plan  [md · html]\n") && ls.out.includes("Library/Projects/status  [md]") && !ls.out.includes("http"),
      info: info.out.includes("Library/Projects/plan — a document") && /markdown\s+plan\.md  revision 2 · \d+ B · changed .* by Editor bot/.test(info.out) && /comments\s+none/.test(info.out) && /link\s+https:\/\/doklin\.cc\/open#/.test(info.out) && /public\s+http/.test(info.out),
      read: read.out.includes("The halyard needs splicing.") && /Library\/Scratch · markdown · revision \d+/.test(read.out),
      write: write.code === 0 && write.out.includes("Created the markdown version of Library/Drive/typed — revision 1."),
      "write --dry-run": dryWrite.out.includes("Would replace the markdown version of Library/Drive/typed, making it revision 2."),
      edit: edit.out.includes("Changed 1 place in the markdown version of Library/Drive/typed — revision 2."),
      comment: /Started thread #\S+ on "By machine", line 3 in Library\/Drive\/typed\./.test(comment.out),
      comments: /#\S+  markdown, line 3 — on "By machine"/.test(comments.out) && /Terminal bot · \d{4}-\d\d-\d\d \d\d:\d\d UTC: Really\?/.test(comments.out),
      "mv --dry-run": mv.out.includes("Would move the document Library/Drive/typed to Library/Drive/typed-2 (2 files)."),
      "publish --dry-run": /Would publish the folder Library\/Drive at http:\S+ — \d+ documents would be public:/.test(publish.out) && publish.out.includes("\n  Library/Drive/typed\n"),
      published: /\/home  Library\/Home  \(the home page; published by /.test(pages.out) && pages.out.includes("its document is gone, so it answers 404"),
      search: search.out.includes("Library/Drive/typed\n  3: By machine.") && search.out.includes("1 document."),
      "rm --dry-run": rmDry.out.includes("Would remove the document Library/Drive/typed (markdown), and its comments.") && !rmDry.out.includes("Trash"),
      rm: rm.out.includes("Removed the document Library/Drive/typed (markdown), and its comments.") && rm.out.includes("keeps a copy in its Trash"),
      "--json on a terminal is JSON": json.code === 0 && JSON.parse(json.out.slice(json.out.indexOf("{"))).agent.name === "Terminal bot",
    };
  });

  await check("on a terminal: the other sentences — a reply, a thread on html, the same text again, a write that would drop a comment, html left behind, a thread a Mac's edit left without its words, publishing and stopping, a move, one version removed, a search that waits", async () => {
    // A document as a Mac synced it a minute ago: both versions, and a thread.
    const PAIR_HTML = "<h1>Pair</h1><p>The mast is too tall.</p>";
    await macWrites(
      {
        "Pair.md": "# Pair\n\nThe mast is {==too tall==}{>>#m4st01<<}.\n",
        "Pair.html": PAIR_HTML,
        "Pair.meta.jsonl": '{"doklin":"meta","v":1}\n{"t":"mthread","id":"m4st01","comments":[{"author":"Ada","at":1757000000000,"body":"How tall?"}]}\n',
      },
      { mtime: Date.now() - 60_000 },
    );
    const inStep = await t(["ls", "Library"]);
    const reply = await t(["reply", "Library/Pair", "m4st01", "-m", "Forty feet."]);
    const onHtml = await t(["comment", "Library/Pair", "--html", "--on", "The mast", "-m", "Shorter?"]);
    const unchanged = await t(["write", "Library/Pair", "--html", "--force", "--from", scratchFile("pair.html", PAIR_HTML)]);
    const dropping = await t(["edit", "Library/Pair", "--find", "{==too tall==}{>>#m4st01<<}", "--replace", "just right"]);
    const edit = await t(["edit", "Library/Pair", "--find", "The mast is", "--replace", "The mast was"]);
    // A person rewrites the sentence on their Mac: the thread loses its words, which is theirs to do.
    await macWrites({ "Pair.md": "# Pair\n\nThe mast is just right.\n" });
    const behind = await t(["ls", "Library"]);
    const info = await t(["info", "Library/Pair"]);
    const read = await t(["read", "Library/Pair"]);
    const comments = await t(["comments", "Library/Pair"]);
    const rmThread = await t(["comment", "rm", "Library/Pair", "m4st01"]);
    const publish = await t(["publish", "Library/Pair", "--slug", "pair-page"]);
    const again = await t(["publish", "Library/Pair"]);
    const mv = await t(["mv", "Library/Pair", "Library/Drive/Pair"]);
    const rmHtml = await t(["rm", "Library/Drive/Pair", "--html"]);
    const rm = await t(["rm", "Library/Drive/Pair"]);
    const unpublish = await t(["unpublish", "pair-page", "--slug"]);
    const file = await t(["info", "Library/Projects/assets/pic.png"]);
    const nothing = await t(["search", "qqzzxxqq"]);
    // Forty-five more documents from a Mac: the next search has reading to do first.
    const flock = {};
    for (let i = 1; i <= 45; i += 1) flock[`Flock/bird-${String(i).padStart(2, "0")}.md`] = `# Bird ${i}\n\nA heron wades here.\n`;
    await macWrites(flock);
    const waited = await t(["search", "zebrafish"]);
    const byName = await t(["search", "bird-07"]);
    return {
      "ls, in step": /^Library\/Pair  \[md · html\]$/m.test(inStep.out),
      reply: reply.out.includes("Answered thread #m4st01 in Library/Pair — it has 2 comments now."),
      "a thread on html": /Started thread #\S+ on the <p> that begins "The mast is too tall\." in Library\/Pair\./.test(onHtml.out),
      "the same text again": unchanged.out.includes("The html version of Library/Pair already says exactly that — nothing was written."),
      "a write that would drop a comment": dropping.code === 2 && dropping.out.includes('doklin: this write would remove the marker of comment #m4st01 (on "too tall")') && dropping.out.includes("`doklin comment rm Library/Pair m4st01`"),
      "an edit that leaves the html behind": edit.out.includes("Changed 1 place in the markdown version of Library/Pair — revision 2.") && edit.out.includes("Its html version is now behind"),
      "ls, behind": /^Library\/Pair  \[md · html, html is behind\]$/m.test(behind.out),
      "info, behind": info.out.includes("(made from an older text than the markdown)") && /comments\s+2 threads/.test(info.out) && /public\s+no/.test(info.out),
      "read, behind": read.out.includes("The mast is just right.") && read.out.includes("Library/Pair · markdown · revision 3 · its html version is behind this text"),
      "comments, with an orphan": comments.out.includes("#m4st01  markdown   (orphaned: the text it was on is gone)") && /#\S+  html, <p> — on "The mast is too tall\."/.test(comments.out) && comments.out.includes("Ada · 2025-09-04 15:33 UTC: How tall?"),
      "a thread removed": rmThread.out.includes("Removed thread #m4st01 from Library/Pair."),
      publish: publish.out.includes(`Published Library/Pair at ${WORKER}/pair-page`),
      "publish again": again.out.includes(`Library/Pair is published at ${WORKER}/pair-page`),
      mv: mv.out.includes("Moved the document Library/Pair to Library/Drive/Pair (3 files)."),
      "rm --html": rmHtml.out.includes("Removed the html version of Library/Drive/Pair.") && rmHtml.out.includes("1 comment thread on that version went with it."),
      "rm, of something published": rm.out.includes(`It stays published at ${WORKER}/pair-page — the page answers 404 until the document is back. Stop with \`doklin unpublish\`.`),
      unpublish: unpublish.out.includes(`Stopped publishing ${WORKER}/pair-page.`),
      "a plain file, refused in a sentence": file.code === 2 && file.out.includes('doklin: Doklin syncs markdown and html documents only — "pic.png" is neither. Name a document: plan, plan.md or plan.html.'),
      "nothing found": nothing.code === 0 && nothing.out.includes('Nothing has "qqzzxxqq" in its name or its text.'),
      "a search that waits says why, then answers": waited.out.includes("Reading the workspace into its search index") && waited.out.includes("60 documents match; these are the first 20 — narrow it with --in <folder>, or raise --limit."),
      "found by its name": byName.out.includes("Library/Flock/bird-07 — in its name\n1 document."),
    };
  });

  await check("on a terminal: a refusal is `doklin: ` and a sentence, with the same exit code — and the places a comment's words occur are listed under it; write waits for nothing", async () => {
    await doklin(ttyBox, ["write", "Library/Drive/echo"], { input: "An echo here.\n\nAn echo there.\n" });
    const missing = await t(["read", "Library/Nope"]);
    const noSection = await t(["read", "Projects/plan"]);
    const usage = await t(["read"]);
    const noPipe = await t(["write", "Library/Drive/typed"]);
    const conflict = await t(["write", "Library/Drive/echo", "--from", scratchFile("echo.md", "x\n")]);
    const ambiguous = await t(["comment", "Library/Drive/echo", "--on", "An echo", "-m", "Which?"]);
    const logout = await t(["logout"]);
    const after = await t(["whoami"]);
    return {
      "not found": missing.code === 3 && missing.out.includes('doklin: there is no document at "Library/Nope"') && !missing.out.includes('{"'),
      "a path with no section, refused in a sentence that says which to use":
        noSection.code === 2 && noSection.out.includes("doklin: Projects/plan is in no section. Say which: Library/Projects/plan (everyone), Private/Projects/plan (only your person) or Restricted/<folder>/Projects/plan."),
      "bad usage": usage.code === 2 && usage.out.includes("doklin: say which document — doklin read <doc>"),
      "write with nothing piped in is refused, not waited for": noPipe.code === 2 && noPipe.out.includes("doklin: pipe the new content in, or name a file with --from <file>"),
      "a conflict says how to go on": conflict.code === 5 && conflict.out.includes("--if-rev 1"),
      "an ambiguous comment lists each place": ambiguous.code === 5 && ambiguous.out.includes("  line 1: An echo here.") && ambiguous.out.includes("  line 3: An echo there."),
      logout: logout.code === 0 && logout.out.includes(`Logged out of ${DOMAIN}. This machine's token no longer works anywhere.`),
      "then not logged in": after.code === 6 && after.out.includes("doklin: this machine is not logged in"),
    };
  });
}

/* ====================================================================== */
/* 13 — logout                                                            */
/* ====================================================================== */

await check("logout: --dry-run only says; logout revokes this machine's token on the domain and forgets it here; a login the domain already forgot is still a logout", async () => {
  const token = credsOf(editorBox).workspaces[0].token;
  const dry = await doklin(editorBox, ["logout", "--dry-run"]);
  const still = (await doklin(editorBox, ["whoami"])).code;
  const from = calls.length;
  const out = await doklin(editorBox, ["logout"]);
  const wire = asked(from);
  const after = await doklin(editorBox, ["whoami"]);
  const direct = await fetch(`${WORKER}/api/agent/me`, { headers: { authorization: `Bearer ${token}` } });
  const again = await doklin(editorBox, ["logout"]);

  // The reader's login is revoked by the owner first; its logout has nothing to revoke.
  const readerMachine = (await listed(reader)).machines[0];
  await owner(`/api/auth/agents/${reader.id}/tokens/${readerMachine.id}`, { method: "DELETE" });
  const forgotten = await doklin(readerBox, ["logout"]);
  return {
    "--dry-run logs nothing out": dry.code === 0 && same(dry.json, { endpoint: BASE, loggedOut: false }) && still === 0,
    logout: out.code === 0 && same(out.json, { endpoint: BASE, loggedOut: true }),
    "one request: the token revokes itself": same(wire, ["DELETE login → 204"]),
    "it is forgotten here, and the file stays private": same(credsOf(editorBox).workspaces, []) && (statSync(editorBox.creds).mode & 0o777) === 0o600,
    "the owner sees no machine": (await listed(editor)).machines.length === 0,
    "the token no longer works anywhere": direct.status === 401,
    "after it, the machine is not logged in": refused(after, 6, /not logged in/),
    "logging out twice is exit 6": refused(again, 6, /not logged in/),
    "a login the domain forgot is still a logout": forgotten.code === 0 && forgotten.json.loggedOut === true && same(credsOf(readerBox).workspaces, []),
  };
});

/* ====================================================================== */
/* 14 — the CLI's own allowance                                           */
/* ====================================================================== */

await check("allowance: every request is counted beside the credentials; the count rides a signed-in request at most every 15 minutes; past the domain's cliDaily nothing is sent and it is exit 8", async () => {
  const counted = await addAgent("Counted bot", ["read"]);
  const box = machine("counted");
  const file = join(box.dir, "usage.json");
  const today = () => JSON.parse(readFileSync(file, "utf8"))[DOMAIN];
  const from = calls.length;
  const login = await doklin(box, ["login", BASE, counted.code]);
  const afterLogin = today();
  const whoami = await doklin(box, ["whoami"]);
  const ls = await doklin(box, ["ls"]);
  const wire = calls.slice(from);
  const afterThree = today();
  // The rest of today's allowance, spent: what a loop would have done by now.
  writeFileSync(file, JSON.stringify({ [DOMAIN]: { ...afterThree, requests: afterThree.limits.cliDaily } }));
  const before = calls.length;
  const spent = await doklin(box, ["ls"]);
  return {
    "login, whoami and ls": login.code === 0 && whoami.code === 0 && ls.code === 0,
    "the count is kept as privately as the login": (statSync(file).mode & 0o777) === 0o600,
    "the login is counted, and the domain's limits kept": afterLogin.requests === 1 && afterLogin.limits.cliDaily === whoami.json.limits.cliDaily && Number.isInteger(afterLogin.day),
    "every request after it too": afterThree.requests === 3 && wire.length === 3,
    "a login reports nothing": wire[0].url === "/api/agent/login" && wire[0].headers["x-doklin-used"] === undefined,
    "the first signed-in request reports the count so far": wire[1].headers["x-doklin-used"] === "2",
    "the next, within 15 minutes, does not": wire[2].headers["x-doklin-used"] === undefined,
    "past the allowance it is exit 8, saying when it comes back": refused(spent, 8, new RegExp(`^this machine has sent its [\\d,]+ requests to ${DOMAIN} for today — it can send again at \\S+`)),
    "and nothing is sent": calls.length === before,
  };
});

/* ====================================================================== */
/* 15 — a worker that is behind                                           */
/* ====================================================================== */

// Not the real worker: a stand-in that answers login and `me` and knows no
// other route — the way one from an earlier release answers a command it
// has no route for.
const behind = { asked: [] };
const behindPort = await serve(async (req) => {
  const route = new URL(req.url, "http://x").pathname.replace(/^\/api\/agent\//, "");
  behind.asked.push(`${req.method} ${route}`);
  const about = { agent: { id: "a-00000000", name: "Old bot" }, scopes: ALL_SCOPES, workspace: { id: "w-old", name: "Old notes" }, version: 9 };
  if (req.method === "POST" && route === "login") return [201, { token: `dka_${"0".repeat(64)}`, ...about }];
  if (req.method === "GET" && route === "me") return [200, about];
  if (route === "doc") return [405, { error: "method not allowed" }];
  return [404, { error: "not found" }];
});
const behindBox = machine("behind");

await check("a worker that is behind: a route it does not know, or a method, is exit 7 and says whose worker", async () => {
  const login = await doklin(behindBox, ["login", `http://localhost:${behindPort}`, mintCode().shown]);
  const whoami = await doklin(behindBox, ["whoami"]);
  const from = behind.asked.length;
  const search = await doklin(behindBox, ["search", "x"]);
  const searchAsked = behind.asked.slice(from);
  const ls = await doklin(behindBox, ["ls"]);
  const read = await doklin(behindBox, ["read", "Library/Home"]);
  return {
    "login and whoami work": login.code === 0 && whoami.code === 0 && whoami.json.agent.name === "Old bot",
    "a route the worker does not know is exit 7, and says whose worker": refused(search, 7, new RegExp(`the worker on localhost:${behindPort} is too old for this command`)),
    "…it was asked once": same(searchAsked, ["GET search"]),
    "ls too": refused(ls, 7, /too old/),
    "a method it does not know": refused(read, 7, /too old/),
  };
});

/* ====================================================================== */
/* 16 — the whole run                                                     */
/* ====================================================================== */

await check("the whole run: every exit code was seen; the CLI asked only the document API, and always said which client it is", async () => {
  const facts = {};
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8]) facts[`exit ${code}`] = seen.has(code);
  facts["no other exit code"] = [...seen].every((code) => Number.isInteger(code) && code >= 0 && code <= 8);
  facts["only /api/agent/ was asked"] = calls.length > 0 && calls.every((c) => c.url.startsWith("/api/agent/"));
  facts["x-doklin-client on every request"] = calls.every((c) => c.headers["x-doklin-client"] === `cli/${CLI_VERSION}`);
  return facts;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
