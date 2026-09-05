// Unit tests for the prompts and the naming rule they share
// (src/cloudPrompts.ts): the setup and teardown prompts the app hands to an
// agent, the update prompt that only asks an agent to run
// scripts/doklin-cloud-update.sh, and the "no step the agent has to invent"
// check that docs/cloud.md §7.4 asks for. The script is held to the same
// naming rule and the same compatibility date as the prompts, by running its
// `--names` mode and reading the worker's source. Run:
//
//   node verify-harness/cloudprompts.test.mjs
//
// (Compiles the module through vite, mirroring doclinks.test.mjs.)
import { build } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
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
  WORKER_BUNDLE_URL,
  WORKER_UPDATE_SCRIPT_URL,
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
  eq(d.domain, null);
  eq(d.certain, true, "the hostname carries the name");
}
{
  const d = deploymentNames("https://notes.example.com");
  eq(d.worker, "doklin-notes-example-com");
  eq(d.bucket, "doklin-notes-example-com");
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
  skeleton(p, { steps: 9, secret: true });
  ok(p.includes('workspace "Notes"'), "names the workspace");
  ok(p.includes(`curl -fsSL ${WORKER_BUNDLE_URL} -o doklin-cloud-worker.js`), "fetches the bundle");
  ok(p.includes("scripts/bundle-worker.mjs"), "…with the clone-and-bundle fallback");
  ok(p.includes("deployments list --name doklin-notes-example-com"), "verifies the worker name is free");
  ok(p.includes("r2 bucket list"), "verifies the bucket name is free");
  ok(p.includes('name = "doklin-notes-example-com"'), "the worker name, verbatim");
  ok(p.includes('main = "doklin-cloud-worker.js"'));
  ok(p.includes(`compatibility_date = "${DATE}"`), "the runtime date, from the worker's source");
  ok(p.includes('account_id = "<from whoami>"'), "the one fill-in");
  ok(p.includes("workers_dev = false"), "a custom domain turns workers.dev off");
  ok(p.includes('routes = [{ pattern = "notes.example.com", custom_domain = true }]'), "the route");
  ok(p.includes('binding = "DATA"'), "the binding the worker reads");
  ok(p.includes('bucket_name = "doklin-notes-example-com"'));
  ok(p.includes("r2 bucket create doklin-notes-example-com"), "creates the bucket before the deploy");
  ok(p.includes("secret put OWNER_TOKEN"), "the secret's name");
  ok(p.includes(`\n${TOKEN}\n`), "the token on its own line");
  ok(p.includes("npx -y wrangler@4 deploy"), "deploys");
  ok(/zone/.test(p), "names the custom-domain failure");
  ok(p.includes("https://notes.example.com/api/meta"), "verifies from the endpoint");
  ok(p.includes('"workspace" is null'), "…and that the domain holds nothing yet");
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
  skeleton(p, { steps: 9, secret: true });
  ok(p.includes('name = "doklin-sherin-notes"'));
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
  const names = (endpoint) =>
    Object.fromEntries(
      execFileSync("sh", [script, "--names", endpoint], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );

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
    eq(shell.domain, ts.domain ?? "", `${endpoint}: …and on the routing`);
    eq(shell.certain, ts.certain ? "1" : "0", `${endpoint}: …and on how sure they are`);
  }
}

/* ---------- teardown ---------- */
{
  const p = buildTeardownPrompt({ endpoint: "https://notes.example.com" });
  skeleton(p, { steps: 5, secret: false });
  ok(p.includes("deployments list --name doklin-notes-example-com"), "confirms before deleting");
  ok(p.includes("wrangler@4 delete --name doklin-notes-example-com"), "deletes the worker");
  ok(p.includes("r2 bucket delete doklin-notes-example-com"), "deletes the bucket");
  ok(/isn't empty, STOP/.test(p), "a non-empty bucket stops the agent");
  ok(p.includes("TORN DOWN: https://notes.example.com"));
  ok(!p.includes("curl -fsSL"), "nothing to download for a teardown");
}

console.log(`cloudprompts: ${checks} checks passed`);
