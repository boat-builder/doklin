// Unit tests for the three agent prompts and the naming rule they share
// (src/cloudPrompts.ts): the setup, update and teardown prompts the app
// hands to an agent, and the "no step the agent has to invent" check that
// docs/cloud.md §7.4 asks for. Run:
//
//   node verify-harness/cloudprompts.test.mjs
//
// (Compiles the module through vite, mirroring doclinks.test.mjs.)
import { build } from "vite";
import { fileURLToPath } from "node:url";
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
  buildSetupPrompt,
  buildTeardownPrompt,
  buildUpdatePrompt,
  cleanDomain,
  cleanWorkersName,
  deploymentNames,
  endpointOf,
  resourceName,
  targetProblem,
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
function skeleton(prompt, { steps, secret }) {
  // Numbered steps 1..N, contiguous, each starting its own line.
  const nums = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: steps }, (_, i) => i + 1), "contiguous numbered steps");
  ok(prompt.includes("npx -y wrangler@4 whoami"), "establishes credentials");
  ok(prompt.includes("npx -y wrangler@4 login"), "…and says how to log in");
  ok(/ask me/.test(prompt), "asks rather than invents");
  ok(/print exactly/.test(prompt), "one line back");
  ok(/Do not (commit|touch)/.test(prompt.split("\n").at(-1)), "closes with the negative scope");
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

/* ---------- update ---------- */
{
  const p = buildUpdatePrompt({
    endpoint: "https://notes.example.com",
    fromVersion: 1,
    toVersion: 2,
    compatibilityDate: DATE,
  });
  skeleton(p, { steps: 6, secret: false });
  ok(p.includes("worker version 2"), "says what the app expects");
  ok(p.includes("still runs version 1"), "…and what the domain runs");
  ok(p.includes("deployments list --name doklin-notes-example-com"), "confirms the worker exists first");
  ok(/verify it before deploying/.test(p), "a convention-derived name is flagged as such");
  ok(p.includes('name = "doklin-notes-example-com"'), "the same name, so the deploy updates");
  ok(p.includes('routes = [{ pattern = "notes.example.com", custom_domain = true }]'), "re-asserts the route");
  ok(p.includes("wrangler@4 delete --name <that-name>"), "names the wrong outcome and its cleanup");
  ok(p.includes("https://notes.example.com/api/meta"), "verifies against the endpoint");
  ok(p.includes("UPDATED: https://notes.example.com"));
  ok(!p.includes("OWNER_TOKEN\n"), "never asks to set the secret");
}
{
  const p = buildUpdatePrompt({
    endpoint: "https://doklin-sherin-notes.sherin.workers.dev",
    fromVersion: null,
    toVersion: 2,
    compatibilityDate: DATE,
  });
  skeleton(p, { steps: 6, secret: false });
  ok(p.includes("deployments list --name doklin-sherin-notes"));
  ok(/certain: it is the first label/.test(p), "a workers.dev name is certain");
  ok(p.includes("workers_dev = true"));
  ok(p.includes("an older version"), "no version known — says so instead of inventing one");
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
