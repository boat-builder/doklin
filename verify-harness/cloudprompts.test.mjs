// Unit tests for the prompts and the naming rule they share
// (src/cloudPrompts.ts): the setup and teardown prompts the app hands to an
// agent, the update prompt that only asks an agent to run
// scripts/doklin-cloud-update.sh, and the "no step the agent has to invent"
// check. The script is held to the same
// naming rule and the same compatibility date as the prompts, by running its
// `--names` mode and reading the worker's source. The other line the app
// hands out — the one that installs the `doklin` command — is held to the
// release that serves it, and scripts/install-doklin.sh is run against a
// release made up on the spot. Run:
//
//   node verify-harness/cloudprompts.test.mjs
//
// (Compiles the module through vite, mirroring doclinks.test.mjs.)
import { build } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    target: "es2022",
    lib: { entry: path.join(repoRoot, "src", "cloudPrompts.ts"), formats: ["es"], fileName: "cp" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const {
  CLI_INSTALL_LINE,
  CLI_INSTALL_SCRIPT_URL,
  WORKER_BUNDLE_URL,
  WORKER_UPDATE_SCRIPT_URL,
  buildAgentLoginPrompt,
  buildSetupPrompt,
  buildTeardownPrompt,
  buildUpdatePrompt,
  cleanDomain,
  cleanWorkersName,
  deploymentNames,
  endpointOf,
  resourceName,
  targetProblem,
  updateCommands,
} = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const TOKEN = "ab".repeat(32);
const DATE = "2025-05-05";

/* ---------- the naming rule ---------- */
eq(cleanDomain("Notes.Example.com"), "notes.example.com");
eq(cleanDomain("https://notes.example.com/"), "notes.example.com");
eq(cleanDomain("notes.example.com:8443/api/meta"), "notes.example.com");
eq(cleanDomain("notes.example.com."), "notes.example.com");
eq(cleanDomain("notes"), null, "a bare word is not a domain");
eq(cleanDomain("10.0.0.1"), null, "an IP address is not a domain");
eq(cleanDomain("-bad.example.com"), null);
eq(cleanDomain("under_score.example.com"), null);
eq(cleanDomain(""), null);

eq(cleanWorkersName("Sherin-Notes"), "sherin-notes");
eq(cleanWorkersName("doklin-sherin-notes"), "sherin-notes", "the prefix is implied");
eq(cleanWorkersName("-x"), null);
eq(cleanWorkersName("a b"), null);
eq(cleanWorkersName(""), null);

eq(resourceName({ kind: "domain", domain: "notes.example.com" }), "doklin-notes-example-com");
eq(resourceName({ kind: "workers-dev", name: "sherin-notes" }), "doklin-sherin-notes");
eq(targetProblem({ kind: "domain", domain: "notes.example.com" }), null);
ok(
  /workers\.dev/.test(targetProblem({ kind: "domain", domain: "x.y.workers.dev" }) ?? ""),
  "a workers.dev host is not a custom domain",
);
ok(
  /too long/i.test(targetProblem({ kind: "domain", domain: "a".repeat(60) + ".example.com" }) ?? ""),
  "a name past Cloudflare's cap is refused",
);
eq(endpointOf({ kind: "domain", domain: "notes.example.com" }), "https://notes.example.com");
eq(endpointOf({ kind: "workers-dev", name: "sherin-notes" }), null, "only wrangler knows the subdomain");

{
  const d = deploymentNames("https://doklin-sherin-notes.sherin.workers.dev");
  eq(d.worker, "doklin-sherin-notes");
  eq(d.bucket, "doklin-sherin-notes");
  eq(d.database, "doklin-sherin-notes");
  eq(d.domain, null);
  eq(d.certain, true, "the hostname carries the name");
}
{
  const d = deploymentNames("https://notes.example.com");
  eq(d.worker, "doklin-notes-example-com");
  eq(d.bucket, "doklin-notes-example-com");
  eq(d.database, "doklin-notes-example-com");
  eq(d.domain, "notes.example.com");
  eq(d.certain, false, "a convention, to be verified");
}

/* ---------- the skeleton every prompt follows ---------- */
function skeleton(prompt, { steps, secret, wrangler = true }) {
  // Numbered steps 1..N, contiguous, each starting its own line.
  const nums = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: steps }, (_, i) => i + 1), "contiguous numbered steps");
  if (wrangler) {
    ok(prompt.includes("npx -y wrangler@4 whoami"), "establishes credentials");
    ok(prompt.includes("npx -y wrangler@4 login"), "…and says how to log in");
  }
  ok(/ask me/.test(prompt), "asks rather than invents");
  ok(/print exactly/.test(prompt), "one line back");
  ok(/Do not (commit|touch|deploy)/.test(prompt.split("\n").at(-1)), "closes with the negative scope");
  eq(prompt.includes(TOKEN), secret, secret ? "setup carries the token" : "no secret in this one");
  ok(!/<[a-z -]*guess[a-z -]*>/i.test(prompt), "no placeholder the agent must guess");
}

/* ---------- setup, a domain of your own ---------- */
{
  const p = buildSetupPrompt({
    target: { kind: "domain", domain: "notes.example.com" },
    token: TOKEN,
    workspaceName: "Notes",
    workerVersion: 1,
    compatibilityDate: DATE,
  });
  skeleton(p, { steps: 10, secret: true });
  ok(p.includes('workspace "Notes"'), "names the workspace");
  ok(p.includes(`curl -fsSL ${WORKER_BUNDLE_URL} -o doklin-cloud-worker.js`), "fetches the bundle");
  ok(p.includes("scripts/bundle-worker.mjs"), "…with the clone-and-bundle fallback");
  ok(p.includes("deployments list --name doklin-notes-example-com"), "verifies the worker name is free");
  ok(p.includes("r2 bucket list"), "verifies the bucket name is free");
  ok(p.includes("d1 list"), "…and the database name too");
  ok(p.includes('name = "doklin-notes-example-com"'), "the worker name, verbatim");
  ok(p.includes('main = "doklin-cloud-worker.js"'));
  ok(p.includes(`compatibility_date = "${DATE}"`), "the runtime date, from the worker's source");
  ok(p.includes('account_id = "<from whoami>"'), "the first fill-in");
  ok(p.includes("workers_dev = false"), "a custom domain turns workers.dev off");
  ok(p.includes('routes = [{ pattern = "notes.example.com", custom_domain = true }]'), "the route");
  ok(p.includes('binding = "DATA"'), "the binding the worker reads");
  ok(p.includes('bucket_name = "doklin-notes-example-com"'));
  ok(p.includes('binding = "DB"'), "…and the database binding beside it");
  ok(p.includes('database_name = "doklin-notes-example-com"'));
  ok(p.includes('database_id = "<from d1 create>"'), "the second fill-in");
  ok(p.includes("r2 bucket create doklin-notes-example-com"), "creates the bucket before the deploy");
  ok(p.includes("d1 create doklin-notes-example-com"), "…and the database, before the config that names its id");
  ok(
    p.indexOf("d1 create doklin-notes-example-com") < p.indexOf('database_id = "<from d1 create>"'),
    "an id can't be written down before it exists",
  );
  ok(p.includes("d1 info doklin-notes-example-com"), "how to read the id back if it scrolled away");
  ok(/never make one up/.test(p), "…and that inventing one is not a fallback");
  ok(p.includes("secret put OWNER_TOKEN"), "the secret's name");
  ok(p.includes(`\n${TOKEN}\n`), "the token on its own line");
  ok(p.includes("npx -y wrangler@4 deploy"), "deploys");
  ok(/zone/.test(p), "names the custom-domain failure");
  ok(p.includes("https://notes.example.com/api/meta"), "verifies from the endpoint");
  ok(p.includes('"workspace" is null'), "…and that the domain holds nothing yet");
  ok(/"d1" is a number/.test(p), "…and that the database binding took");
  ok(p.includes("ENDPOINT: https://notes.example.com"), "prints the endpoint line");
  ok(!p.includes("SHARE_TOKEN"), "nothing from the old stack");
}

/* ---------- setup, a workers.dev address ---------- */
{
  const p = buildSetupPrompt({
    target: { kind: "workers-dev", name: "sherin-notes" },
    token: TOKEN,
    workspaceName: "Notes",
    workerVersion: 1,
    compatibilityDate: DATE,
  });
  skeleton(p, { steps: 10, secret: true });
  ok(p.includes('name = "doklin-sherin-notes"'));
  ok(p.includes('database_name = "doklin-sherin-notes"'), "the database follows the same name");
  ok(p.includes("workers_dev = true"), "the free address");
  ok(!p.includes("routes ="), "…and no route");
  ok(p.includes("doklin-sherin-notes.<this account's subdomain>.workers.dev"), "says what the address looks like");
  ok(p.includes("ENDPOINT: <the workers.dev URL wrangler printed>"), "the agent fills the endpoint in");
}

/* ---------- update: the prompt is "run the script" ---------- */
{
  const p = buildUpdatePrompt({
    endpoint: "https://notes.example.com",
    fromVersion: 1,
    toVersion: 2,
  });
  skeleton(p, { steps: 3, secret: false, wrangler: false });
  ok(p.includes("worker version 2"), "says what the app expects");
  ok(p.includes("still runs version 1"), "…and what the domain runs");
  ok(p.includes(`curl -fsSL ${WORKER_UPDATE_SCRIPT_URL} -o doklin-cloud-update.sh`), "fetches the script");
  ok(p.includes("sh doklin-cloud-update.sh https://notes.example.com"), "…and runs it on the domain");
  ok(p.includes("scripts/doklin-cloud-update.sh"), "…with the clone fallback");
  ok(/SECOND worker/.test(p), "names the wrong outcome the script exists to prevent");
  ok(p.includes("UPDATED: https://notes.example.com"));
  ok(!/wrangler/.test(p), "the script drives wrangler, so the agent never does");
  ok(!p.includes("wrangler.toml"), "…and never writes a config");
  ok(!p.includes("OWNER_TOKEN\n"), "never asks to set the secret");
}
{
  const p = buildUpdatePrompt({
    endpoint: "https://doklin-sherin-notes.sherin.workers.dev",
    fromVersion: null,
    toVersion: 2,
  });
  skeleton(p, { steps: 3, secret: false, wrangler: false });
  ok(p.includes("sh doklin-cloud-update.sh https://doklin-sherin-notes.sherin.workers.dev"));
  ok(p.includes("an older version"), "no version known — says so instead of inventing one");
}
eq(
  updateCommands("HTTPS://Notes.Example.com/api/meta"),
  `curl -fsSL ${WORKER_UPDATE_SCRIPT_URL} -o doklin-cloud-update.sh\nsh doklin-cloud-update.sh https://notes.example.com`,
  "whatever the endpoint was typed as, the command line is a bare https://<host>",
);

/* ---------- update: the script, held to the same rules ---------- */
//
// The card hands out two commands and a prompt that runs them, so the script
// is as much a part of this contract as the prompts are: it has to derive the
// same names from an endpoint, pin the same compatibility date as the worker's
// source, and fetch the same bundle.
{
  const script = path.join(repoRoot, "scripts", "doklin-cloud-update.sh");
  const text = fs.readFileSync(script, "utf8");
  // Under the locale a Mac actually has, not the bare one a test inherits:
  // macOS's /bin/sh is bash 3.2, whose UTF-8 handling is where the script's
  // one shipped bug lived.
  const names = (endpoint) =>
    Object.fromEntries(
      execFileSync("sh", [script, "--names", endpoint], {
        encoding: "utf8",
        env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
      })
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );

  // `$ENDPOINT…` deployed the worker and then died on the line after it:
  // bash 3.2 in a UTF-8 locale eats the first byte of a following multibyte
  // character into the variable name, and `set -u` kills the script over a
  // name nobody wrote ("ENDPOINT\xe2: unbound variable"). Braces end the name
  // explicitly. Read as latin1 so one char is one byte.
  {
    const bytes = fs.readFileSync(script, "latin1");
    const bad = bytes
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]/.test(line));
    eq(bad.length, 0, `brace these — a bare $var before a multibyte char dies on macOS: ${JSON.stringify(bad)}`);
  }

  eq(path.basename(WORKER_UPDATE_SCRIPT_URL), "doklin-cloud-update.sh", "the release asset's name");
  ok(text.includes(`BUNDLE_URL="${WORKER_BUNDLE_URL}"`), "the script fetches the same worker bundle");

  const workerSource = fs.readFileSync(path.join(repoRoot, "cloud-worker", "src", "version.ts"), "utf8");
  const date = workerSource.match(/^export const COMPATIBILITY_DATE = "(.+)";$/m)?.[1];
  eq(date, DATE, "the test's date is the worker's");
  ok(text.includes(`COMPATIBILITY_DATE="${date}"`), "the script pins the date from the worker's source");

  for (const endpoint of [
    "https://notes.example.com",
    "https://doklin-sherin-notes.sherin.workers.dev",
    "https://a.b.c.workers.dev",
    "NOTES.example.com:8443/api/meta",
    "https://x.y.z.example.co.uk",
  ]) {
    const shell = names(endpoint);
    const ts = deploymentNames(endpoint);
    eq(shell.worker, ts.worker, `${endpoint}: the script and the app agree on the worker`);
    eq(shell.bucket, ts.bucket, `${endpoint}: …and on the bucket`);
    eq(shell.database, ts.database, `${endpoint}: …and on the database`);
    eq(shell.domain, ts.domain ?? "", `${endpoint}: …and on the routing`);
    eq(shell.certain, ts.certain ? "1" : "0", `${endpoint}: …and on how sure they are`);
  }

  // The overrides are the no-terminal escape hatch each confirmation loop
  // points at, so each one has to actually reach the name it claims to set.
  const overridden = Object.fromEntries(
    execFileSync("sh", [script, "--names", "https://notes.example.com"], {
      encoding: "utf8",
      env: { ...process.env, WORKER_NAME: "w", BUCKET_NAME: "b", D1_NAME: "d" },
    })
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  eq(overridden.worker, "w", "WORKER_NAME= overrides the worker");
  eq(overridden.bucket, "b", "BUCKET_NAME= overrides the bucket");
  eq(overridden.database, "d", "D1_NAME= overrides the database");

  // The binding the whole phase exists to deploy, and the one resource the
  // script may create: a domain set up before Doklin had a database has none.
  ok(text.includes('binding = "DB"'), "the script writes the D1 binding");
  ok(text.includes('database_name = "$DATABASE"'), "…with the name it confirmed");
  ok(text.includes('database_id = "$DATABASE_ID"'), "…and the id it read off the account");
  ok(text.includes("d1 list --json"), "the id comes from the account, never from a guess");
  ok(/d1 create/.test(text), "a missing database is created rather than refused");
  ok(/D1_NAME= names one that already exists/.test(text), "…except when the name was given by hand");
}

/* ---------- teardown ---------- */
{
  const p = buildTeardownPrompt({ endpoint: "https://notes.example.com" });
  skeleton(p, { steps: 6, secret: false });
  ok(p.includes("deployments list --name doklin-notes-example-com"), "confirms before deleting");
  ok(p.includes("wrangler@4 delete --name doklin-notes-example-com"), "deletes the worker");
  ok(p.includes("d1 delete doklin-notes-example-com"), "deletes the database");
  ok(p.includes("r2 bucket delete doklin-notes-example-com"), "deletes the bucket");
  ok(/found no such database/.test(p), "a domain set up before the database is not an error");
  ok(/isn't empty, STOP/.test(p), "a non-empty bucket stops the agent");
  ok(p.includes("TORN DOWN: https://notes.example.com"));
  ok(!p.includes("curl -fsSL"), "nothing to download for a teardown");
}

/* ---------- the agent login prompt ---------- */
//
// What the owner hands an agent — the one thing the Agents tab's login card
// copies. Held to being short, and to carrying exactly
// what a bot that has never heard of Doklin needs: what it is, the two
// commands, and what the address in the second one is.
{
  const LINE = "doklin login https://notes.example.com dkla-7QK2M-9XVR4-8TBHN-3WGYD";
  const p = buildAgentLoginPrompt({
    domain: "notes.example.com",
    line: LINE,
    expiresAt: Date.UTC(2026, 10, 13, 6, 40, 59),
  });
  const lines = p.split("\n");
  ok(p.startsWith("Doklin is a workspace of markdown and HTML documents."), "opens with what Doklin is");
  ok(/`doklin`, lets you read, write, search, comment on and publish them/.test(p), "…and what its command line does");
  ok(p.includes("with no copy of the folder"), "…without the folder");
  ok(lines.includes(CLI_INSTALL_LINE), "the install command, on a line of its own");
  ok(lines.includes(LINE), "the login command, verbatim, on a line of its own");
  eq(lines.indexOf(LINE), lines.indexOf(CLI_INSTALL_LINE) + 1, "install first, then login");
  ok(p.includes("installs `doklin` (skip it if it is already installed)"), "says what the first command is, and that it can be skipped");
  ok(p.includes("notes.example.com is the workspace's address"), "says what the address in the second command is");
  ok(p.includes("works once"), "the code is single-use");
  ok(p.includes("expires at 2026-11-13 06:40 UTC"), "…and when it stops working, in UTC");
  ok(p.endsWith("Then run `doklin help agent` to see what you can do."), "ends by pointing at the briefing");
  eq((p.match(/dkla-/g) ?? []).length, 1, "the code appears once");
  eq((p.match(/https?:\/\//g) ?? []).length, 2, "two addresses: the installer and the workspace");
  eq(lines.filter((l) => l.trim()).length, 5, "short: three paragraphs and two commands");
  ok(p.length < 700, "…and under 700 characters");
  ok(!/wrangler|Cloudflare|token/i.test(p), "nothing about how the domain is run");
  const help = fs.readFileSync(path.join(repoRoot, "cli", "src", "help.rs"), "utf8");
  ok(/"agent" \| "agents" => AGENT/.test(help), "the briefing it points at exists");
}

/* ---------- the `doklin` installer ---------- */
//
// The agent login card hands out one line that installs the command.
// That line, the script it fetches and the release
// that attaches the script and its binaries have to agree on every name —
// and the script has to refuse a download that is not what the release says
// it is. It is run here against a release made up in a temp folder: a `curl`
// and a `uname` of the test's own stand first on PATH, so nothing is fetched
// and every platform can be asked for from this one.
{
  const script = path.join(repoRoot, "scripts", "install-doklin.sh");
  const text = fs.readFileSync(script, "utf8");
  const release = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const ASSETS = ["doklin-linux-x64", "doklin-linux-arm64", "doklin-macos-arm64"];

  eq(path.basename(CLI_INSTALL_SCRIPT_URL), "install-doklin.sh", "the release asset's name");
  eq(CLI_INSTALL_LINE, `curl -fsSL ${CLI_INSTALL_SCRIPT_URL} | sh`, "the line the card hands out");
  ok(text.includes(CLI_INSTALL_LINE), "the script's own header shows that line");
  ok(text.includes(`BASE="${path.dirname(CLI_INSTALL_SCRIPT_URL)}"`), "it fetches from the release it came from");
  ok(release.includes("cp scripts/install-doklin.sh release-assets/install-doklin.sh"), "the release attaches it");
  ok(release.includes(CLI_INSTALL_LINE), "the release notes carry the same line");
  for (const asset of ASSETS) {
    ok(text.includes(asset), `the script documents ${asset}`);
    ok(new RegExp(`shasum -a 256 .*\\b${asset}\\b.* >> SHA256SUMS`).test(release), `the release checksums ${asset}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doklin-install-test-"));
  try {
    const rel = path.join(tmp, "release");
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(rel);
    fs.mkdirSync(bin);
    // A "binary" per platform, each saying which one it is.
    const sums = [];
    for (const asset of ASSETS) {
      const body = `#!/bin/sh\necho "doklin 9.9.9 (${asset})"\n`;
      fs.writeFileSync(path.join(rel, asset), body);
      sums.push(`${createHash("sha256").update(body).digest("hex")}  ${asset}`);
    }
    // As the release writes it: the disk images first, the binaries after.
    const writeSums = (lines) => fs.writeFileSync(path.join(rel, "SHA256SUMS"), `${"0".repeat(64)}  Doklin-macos-arm64.dmg\n${lines.join("\n")}\n`);
    writeSums(sums);
    // `curl -fsSL <url> -o <file>`: the file of that name out of the made-up release.
    fs.writeFileSync(
      path.join(bin, "curl"),
      `#!/bin/sh\n[ "$1" = "-fsSL" ] && [ "$3" = "-o" ] || exit 2\ncase "$2" in "$FAKE_BASE"/*) ;; *) exit 22 ;; esac\ncp "$FAKE_RELEASE/\${2##*/}" "$4" 2>/dev/null || exit 22\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac\n`, { mode: 0o755 });

    const install = (osName, arch, extra = {}) => {
      const home = fs.mkdtempSync(path.join(tmp, "home-"));
      const dir = path.join(home, "tools");
      let stdout = "";
      let stderr = "";
      let status = 0;
      try {
        stdout = execFileSync("sh", [script], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: home,
            DOKLIN_INSTALL_DIR: dir,
            FAKE_OS: osName,
            FAKE_ARCH: arch,
            FAKE_RELEASE: rel,
            FAKE_BASE: path.dirname(CLI_INSTALL_SCRIPT_URL),
            ...extra,
          },
        });
      } catch (e) {
        status = e.status;
        stdout = e.stdout;
        stderr = e.stderr;
      }
      const installed = path.join(dir, "doklin");
      return { status, stdout, stderr, home, dir, installed, exists: fs.existsSync(installed) };
    };

    for (const [osName, arch, asset] of [
      ["Linux", "x86_64", "doklin-linux-x64"],
      ["Linux", "amd64", "doklin-linux-x64"],
      ["Linux", "aarch64", "doklin-linux-arm64"],
      ["Linux", "arm64", "doklin-linux-arm64"],
      ["Darwin", "arm64", "doklin-macos-arm64"],
    ]) {
      const r = install(osName, arch);
      eq(r.status, 0, `${osName} ${arch}: installs (${r.stderr})`);
      ok(r.exists, `${osName} ${arch}: the command is where it was asked to go`);
      eq(execFileSync(r.installed, ["--version"], { encoding: "utf8" }).trim(), `doklin 9.9.9 (${asset})`, `${osName} ${arch}: it is ${asset}`);
      eq(fs.statSync(r.installed).mode & 0o777, 0o755, `${osName} ${arch}: and executable`);
      eq(fs.readdirSync(r.dir).join(), "doklin", `${osName} ${arch}: nothing else is left beside it`);
      ok(r.stdout.includes(`doklin 9.9.9 (${asset}) installed: ${r.installed}`), `${osName} ${arch}: says what it installed and where`);
      ok(r.stdout.includes("is not on this shell's PATH"), `${osName} ${arch}: says so when that folder is not on PATH`);
      ok(r.stdout.includes("doklin login <domain> <code>"), `${osName} ${arch}: and what to run next`);
    }

    // With no folder named: ~/.local/bin, when /usr/local/bin is not this
    // user's to write. Where it is — a container's root — the script would
    // put its made-up binary over a real one, so that machine skips this.
    {
      let open = true;
      try {
        fs.accessSync("/usr/local/bin", fs.constants.W_OK);
      } catch {
        open = false;
      }
      if (!open) {
        const r = install("Linux", "x86_64", { DOKLIN_INSTALL_DIR: "" });
        eq(r.status, 0, `the default folder: installs (${r.stderr})`);
        ok(fs.existsSync(path.join(r.home, ".local", "bin", "doklin")), "the default folder is ~/.local/bin");
      }
    }

    // What it refuses, leaving nothing behind.
    for (const [osName, arch, why] of [
      ["Darwin", "x86_64", /no doklin for Intel Macs/],
      ["Linux", "riscv64", /no doklin for riscv64/],
      ["MINGW64_NT", "x86_64", /Linux and macOS/],
    ]) {
      const r = install(osName, arch);
      eq(r.status, 1, `${osName} ${arch}: refused`);
      ok(why.test(r.stderr), `${osName} ${arch}: with the reason (${r.stderr.trim()})`);
      ok(!fs.existsSync(r.dir), `${osName} ${arch}: before touching the disk`);
    }
    {
      // A download that is not what the release says it is.
      writeSums(sums.map((line) => (line.endsWith("doklin-linux-x64") ? `${"f".repeat(64)}  doklin-linux-x64` : line)));
      const r = install("Linux", "x86_64");
      eq(r.status, 1, "a download that does not match its checksum is refused");
      ok(/does not match its checksum/.test(r.stderr), `…and says so (${r.stderr.trim()})`);
      ok(!r.exists, "…and is not installed");
      eq(fs.readdirSync(r.dir).length, 0, "…and nothing of it is left behind");
      eq(install("Linux", "aarch64").status, 0, "…while the others still install");
    }
    {
      writeSums(sums.filter((line) => !line.endsWith("doklin-macos-arm64")));
      const r = install("Darwin", "arm64");
      eq(r.status, 1, "a binary the checksums do not list is refused");
      ok(/do not list doklin-macos-arm64/.test(r.stderr), `…by name (${r.stderr.trim()})`);
      ok(!r.exists, "…and is not installed");
    }
    {
      writeSums(sums);
      fs.rmSync(path.join(rel, "doklin-linux-arm64"));
      const r = install("Linux", "aarch64");
      eq(r.status, 1, "a release with no such binary is an error, not an empty file");
      ok(/could not download doklin-linux-arm64/.test(r.stderr), `…named (${r.stderr.trim()})`);
      ok(!r.exists, "…and nothing is installed");
    }
    {
      // An older `doklin` already there is replaced by a rename, never written over.
      const r = install("Linux", "x86_64");
      const before = fs.statSync(r.installed).ino;
      const again = execFileSync("sh", [script], {
        encoding: "utf8",
        env: { PATH: `${bin}:${r.dir}:/usr/bin:/bin`, HOME: r.home, DOKLIN_INSTALL_DIR: r.dir, FAKE_OS: "Linux", FAKE_ARCH: "x86_64", FAKE_RELEASE: rel, FAKE_BASE: path.dirname(CLI_INSTALL_SCRIPT_URL) },
      });
      ok(fs.statSync(r.installed).ino !== before, "running it again puts a new file in place of the old one");
      ok(!again.includes("is not on this shell's PATH"), "…and says nothing about PATH when the folder is on it");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`cloudprompts: ${checks} checks passed`);
