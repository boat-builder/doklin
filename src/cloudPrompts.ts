// The three agent prompts (docs/cloud.md §7.4) and the naming rule
// they share, as pure functions: the setup wizard, the update card and the
// panel's teardown step render them, and verify-harness/cloudprompts.test.mjs
// checks that no step is left for the agent to invent. Nothing here touches
// the app — the version and the compatibility date come in as arguments
// (the app reads them from virtual:cloud-worker-version via src/cloud.ts).
//
// One skeleton for all three: the goal in a sentence, fetch the artifact,
// establish credentials, verify identity before mutating, the config file
// verbatim, deploy with the failure named, verify and print one line back,
// and the negative scope at the end. Setup carries the token — its copy
// point says so; update and teardown carry no secret.

export const WORKER_BUNDLE_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js";
export const REPO_URL = "https://github.com/boat-builder/doklin";

/** Where a cloud lives: a domain of the user's own, or a free workers.dev address. */
export type CloudTarget =
  | { kind: "domain"; domain: string }
  | { kind: "workers-dev"; name: string };

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Cloudflare caps a worker's (and a bucket's) name; the domain-derived
// name has to fit.
const MAX_RESOURCE_NAME = 63;

/** A hostname typed by hand: lowercased, scheme / path / port stripped.
 *  Null when it isn't one (a bare word, an IP address, junk). */
export function cleanDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (!s || s.length > 253) return null;
  const labels = s.split(".");
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) return null;
  if (/^\d+(\.\d+){3}$/.test(s)) return null;
  return s;
}

/** A *.workers.dev hostname is Cloudflare's — it can't be a custom domain. */
export const isWorkersDev = (host: string): boolean => /\.workers\.dev$/i.test(host);

/** The chosen workers.dev name: letters, digits and dashes; a typed
 *  "doklin-" prefix is dropped because the name gets one anyway. */
export function cleanWorkersName(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^doklin-/, "");
  if (!s || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) return null;
  return s;
}

/** The one name the worker and the bucket share: `doklin-` plus the domain
 *  with its dots as dashes, or `doklin-` plus the chosen workers.dev name.
 *  Never `doklin-share-…`, so a new deploy can't land on an old stack. */
export function resourceName(target: CloudTarget): string {
  return target.kind === "domain"
    ? `doklin-${target.domain.replace(/\./g, "-")}`
    : `doklin-${target.name}`;
}

/** Why a target can't be set up, or null when it can. */
export function targetProblem(target: CloudTarget): string | null {
  if (target.kind === "domain" && isWorkersDev(target.domain)) {
    return "That is a workers.dev address — pick the free address option instead.";
  }
  if (resourceName(target).length > MAX_RESOURCE_NAME) {
    return `Too long: Cloudflare limits a worker's name to ${MAX_RESOURCE_NAME} characters, and this one would be "${resourceName(target)}".`;
  }
  return null;
}

/** The endpoint a target answers at, when it is knowable before the deploy.
 *  A workers.dev address includes the account's subdomain, which only
 *  wrangler knows — the agent prints it. */
export function endpointOf(target: CloudTarget): string | null {
  return target.kind === "domain" ? `https://${target.domain}` : null;
}

export type DeploymentNames = {
  worker: string;
  bucket: string;
  /** The custom domain the route re-asserts; null for a workers.dev address. */
  domain: string | null;
  /** True when the endpoint literally carries the name (workers.dev). */
  certain: boolean;
};

/** Recover the resource names from an endpoint. A workers.dev hostname
 *  carries the worker name in its first label; a custom domain falls back
 *  to the naming convention, and the prompts say to verify it. */
export function deploymentNames(endpoint: string): DeploymentNames {
  const host = cleanDomain(endpoint) ?? endpoint.trim().toLowerCase();
  const m = host.match(/^([a-z0-9-]+)\.[^.]+\.workers\.dev$/);
  if (m) return { worker: m[1], bucket: m[1], domain: null, certain: true };
  const name = resourceName({ kind: "domain", domain: host });
  return { worker: name, bucket: name, domain: host, certain: false };
}

function routingLines(domain: string | null): string {
  return domain
    ? `workers_dev = false\nroutes = [{ pattern = "${domain}", custom_domain = true }]`
    : "workers_dev = true";
}

function wranglerToml(worker: string, bucket: string, domain: string | null, compatibilityDate: string): string {
  return [
    `name = "${worker}"`,
    `main = "doklin-cloud-worker.js"`,
    `compatibility_date = "${compatibilityDate}"`,
    `account_id = "<from whoami>"`,
    routingLines(domain),
    `[[r2_buckets]]`,
    `binding = "DATA"`,
    `bucket_name = "${bucket}"`,
  ].join("\n");
}

const FETCH_STEP = `Make an empty working directory and download the worker — one ready-to-deploy file, attached to every Doklin release:
   mkdir doklin-cloud && cd doklin-cloud
   curl -fsSL ${WORKER_BUNDLE_URL} -o doklin-cloud-worker.js
   If that download 404s, clone ${REPO_URL}, run \`pnpm install && node scripts/bundle-worker.mjs\` in the clone, and copy cloud-worker/dist/doklin-cloud-worker.js into the working directory.`;

const LOGIN_STEP =
  "Run `npx -y wrangler@4 whoami`. If it says you're not logged in, run `npx -y wrangler@4 login` and ask me to finish the sign-in in the browser window it opens; then run whoami again and note the account id it prints.";

const NEGATIVE_SCOPE =
  "Do not commit wrangler.toml anywhere, and do not create or modify any other Cloudflare resources.";

export type SetupPromptInput = {
  target: CloudTarget;
  /** The owner token the app minted — the one secret the prompt carries. */
  token: string;
  workspaceName: string;
  /** The worker version this app was built for (the download may be newer). */
  workerVersion: number;
  compatibilityDate: string;
};

/** Setup: a fresh worker and bucket, the token as the secret, the endpoint back. */
export function buildSetupPrompt(i: SetupPromptInput): string {
  const name = resourceName(i.target);
  const domain = i.target.kind === "domain" ? i.target.domain : null;
  const where = domain
    ? `at ${domain}`
    : `at a free workers.dev address — the worker is named ${name}, so it will answer at https://${name}.<this account's subdomain>.workers.dev`;
  const endpoint = domain ? `https://${domain}` : "<the workers.dev URL wrangler printed>";
  const deploy = domain
    ? `Deploy: \`npx -y wrangler@4 deploy\`. Wrangler binds ${domain} and provisions DNS and TLS itself when the domain's zone is active on this account. If it errors because the zone isn't on this account, pause and ask me to add the registrable domain in the Cloudflare dashboard (Account Home → Add a domain, the free plan is enough) and to point the registrar's nameservers at Cloudflare; retry once the zone is active. The first certificate can take a minute or two.`
    : `Deploy: \`npx -y wrangler@4 deploy\`. Note the workers.dev URL it prints — that is the endpoint.`;
  return `Set up Doklin's cloud for my workspace "${i.workspaceName}": one Cloudflare Worker in front of one R2 bucket, serving ${where}. Everything runs on my Cloudflare account. The worker is a single published file; nothing else on the account is to be touched.

1. ${FETCH_STEP}
2. ${LOGIN_STEP}
3. Verify the names are free — a same-name deploy silently replaces an existing worker, and a shared bucket serves two sites:
   \`npx -y wrangler@4 deployments list --name ${name}\` must fail because no such worker exists, and
   \`npx -y wrangler@4 r2 bucket list\` must not list ${name}.
   If either exists, stop and ask me; never reuse or replace them on your own.
4. Next to the downloaded file, write wrangler.toml with exactly this — the account_id from step 2 is the only fill-in:
${wranglerToml(name, name, domain, i.compatibilityDate)}
5. Create the bucket: \`npx -y wrangler@4 r2 bucket create ${name}\`. If the account has never enabled R2, pause and ask me to enable it once in the Cloudflare dashboard (it may ask for a payment method; the free allowance covers this use).
6. Store the app's token as the worker's secret: run \`npx -y wrangler@4 secret put OWNER_TOKEN\` and give it exactly this value:
${i.token}
7. ${deploy}
8. Verify: \`curl -fsS -H "Authorization: Bearer ${i.token}" ${endpoint}/api/meta\` must answer 200 with JSON whose "workspace" is null and whose "version" is at least ${i.workerVersion}. On a custom domain, retry that for up to five minutes while the certificate is being issued before treating it as a failure.
9. Then print exactly this line, filled in:
ENDPOINT: ${endpoint}

The token is already in the app, so the endpoint is the only value I need back. ${NEGATIVE_SCOPE}`;
}

export type UpdatePromptInput = {
  endpoint: string;
  /** What the domain runs now (null when it never answered a version). */
  fromVersion: number | null;
  /** What this app was built for. */
  toVersion: number;
  compatibilityDate: string;
};

/** Update: the same names, the new code, nothing else touched. No secret. */
export function buildUpdatePrompt(i: UpdatePromptInput): string {
  const { worker, bucket, domain, certain } = deploymentNames(i.endpoint);
  const running = i.fromVersion != null ? `the domain still runs version ${i.fromVersion}` : "the domain runs an older version";
  const nameNote = certain
    ? "certain: it is the first label of the workers.dev hostname"
    : "Doklin's naming convention — verify it before deploying";
  return `Update the Doklin cloud worker serving ${i.endpoint} to the latest code: the app I'm running was built for worker version ${i.toVersion}, and ${running}. It runs on my Cloudflare account. This is a code-only update — the R2 bucket binding, the OWNER_TOKEN secret and the domain routing all survive a same-name redeploy, so do not recreate or modify any of them.

1. ${FETCH_STEP}
2. ${LOGIN_STEP}
3. Confirm the worker's name before touching anything. It should be "${worker}" (${nameNote}): \`npx -y wrangler@4 deployments list --name ${worker}\` must list its deployments. If wrangler knows no such worker, ask me for the exact name — I can see it in the Cloudflare dashboard under Workers & Pages — and never substitute a name you invented. Then \`npx -y wrangler@4 r2 bucket list\` must show its bucket, "${bucket}"; if it doesn't, ask me which bucket the worker is bound to (dashboard → the worker → Settings → Bindings) rather than guessing.
4. Next to the downloaded file, write wrangler.toml with exactly this — the name and bucket confirmed in step 3, the account_id from step 2:
${wranglerToml(worker, bucket, domain, i.compatibilityDate)}
5. Deploy: \`npx -y wrangler@4 deploy\`. This must UPDATE the existing worker, never create a second one — the name in wrangler.toml decides. If anything suggests a new worker appeared (a "created" rather than "updated" message, a fresh workers.dev URL that isn't the endpoint above), delete what you just made with \`npx -y wrangler@4 delete --name <that-name>\` and go back to step 3.
6. Verify: \`curl -sS -o /dev/null -w "%{http_code}" ${i.endpoint}/api/meta\` must print 401 — the updated worker is up and asking for the app's token, which you don't have; the app checks the version itself. Then print exactly this line:
UPDATED: ${i.endpoint}

${NEGATIVE_SCOPE}`;
}

export type TeardownPromptInput = { endpoint: string };

/** Teardown: after the app's wipe emptied the bucket, remove the worker and
 *  the bucket. No secret. */
export function buildTeardownPrompt(i: TeardownPromptInput): string {
  const { worker, bucket, certain } = deploymentNames(i.endpoint);
  const nameNote = certain
    ? "certain: it is the first label of the workers.dev hostname"
    : "Doklin's naming convention — verify it before deleting";
  return `Tear down the Doklin cloud that served ${i.endpoint}: delete its Cloudflare Worker and its R2 bucket from my account. The app has already erased everything in the bucket; nothing on this domain is needed any more.

1. ${LOGIN_STEP}
2. Confirm the names before deleting anything. The worker should be "${worker}" (${nameNote}): \`npx -y wrangler@4 deployments list --name ${worker}\` must list its deployments. If wrangler knows no such worker, ask me for the exact name — never delete one you guessed. Its bucket should be "${bucket}": confirm it with \`npx -y wrangler@4 r2 bucket list\`, and ask me if it isn't there.
3. Delete the worker: \`npx -y wrangler@4 delete --name ${worker}\`. This also releases its route or workers.dev address.
4. Delete the bucket: \`npx -y wrangler@4 r2 bucket delete ${bucket}\`. If it refuses because the bucket isn't empty, STOP and tell me — the app's erase step may not have finished. Never force it.
5. Verify: \`curl -sS -o /dev/null -w "%{http_code}" ${i.endpoint}/\` must no longer print 200 (a custom domain stops resolving or answers 5xx once the route is gone; a workers.dev address answers 404). Then print exactly this line:
TORN DOWN: ${i.endpoint}

Do not touch any other Cloudflare resource.`;
}
