#!/bin/sh
# How much of Cloudflare's free plan one Doklin domain is using — a table for
# us, while agents are new and nobody yet knows what they cost. Doklin itself
# puts no limit on an agent; this is how that decision
# is watched. It ships nowhere and nothing calls it.
#
#   scripts/cloud-usage.sh notes.example.com        the last 14 days
#   scripts/cloud-usage.sh notes.example.com 30     the last 30 (the most)
#
# It reads, and changes nothing. Wrangler must be logged in to the account
# that holds the domain (`npx wrangler login`); nothing else is needed.
#
#   wrangler whoami      the accounts the login reaches — the one that holds
#                        this domain's database is found by asking each
#                        (CLOUDFLARE_ACCOUNT_ID, if set, is asked alone)
#   wrangler d1 info     the database's id and size
#   wrangler auth token  the login's own token, which may read analytics
#   GraphQL Analytics    everything else, in one query: Worker requests and
#                        D1 rows for each day, what the bucket holds, and its
#                        operations this month
#
# The names follow the domain, as the setup prompt makes them: dots become
# dashes behind "doklin-".
#
# Why not `wrangler r2 bucket info`: it asks the same Analytics API and then
# answers in words ("14.1 MB", "1,234"), which cannot be set against a limit.
#
# Three things about the numbers. Days are UTC days, because that is when
# Cloudflare's daily limits reset. Cloudflare samples Worker requests, so
# those are estimates (a quiet day reads as a round number). And the plan's
# allowances belong to the whole account: every other worker, database and
# bucket on it draws on the same ones, so this is one domain's share.
exec node --input-type=module - "$@" <<'EOF'
import { execFileSync } from "node:child_process";

const [domain, daysArg = "14"] = process.argv.slice(2);
const days = Number(daysArg);
if (!domain || !Number.isInteger(days) || days < 1 || days > 30) {
  console.error("usage: scripts/cloud-usage.sh <domain> [days: 1 to 30, 14 if not given]");
  process.exit(2);
}
const name = `doklin-${domain.replaceAll(".", "-")}`;

const stop = (message) => {
  console.error(message);
  process.exit(1);
};

// One wrangler command, answered as JSON. A refusal comes back as its text,
// without the colour codes, under `refused`.
function wrangler(args, account) {
  const env = account ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } : process.env;
  try {
    const out = execFileSync("npx", ["-y", "wrangler@4", ...args, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (error) {
    const said = `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error.message);
    return { refused: said.replace(/\x1b\[[0-9;]*m/g, "").trim() };
  }
}

// The account: the one whose database carries this domain's name.
let accounts = process.env.CLOUDFLARE_ACCOUNT_ID ? [process.env.CLOUDFLARE_ACCOUNT_ID] : null;
if (!accounts) {
  const who = wrangler(["whoami"]);
  if (!who.loggedIn) stop("Wrangler is not logged in to Cloudflare. Run `npx wrangler login`, then this again.");
  accounts = who.accounts.map((account) => account.id);
}
let account, database;
for (const id of accounts) {
  const info = wrangler(["d1", "info", name], id);
  if (!info.uuid) continue;
  [account, database] = [id, info];
  break;
}
if (!database) {
  stop(`No database named ${name} in ${accounts.length === 1 ? `account ${accounts[0]}` : `any of the ${accounts.length} accounts wrangler is logged in to`}.\n` +
    `Is ${domain} the domain exactly as it was connected, and is wrangler logged in to the account that holds it?`);
}

const { token } = wrangler(["auth", "token"]);
if (!token) stop("Wrangler would not hand over its login token. Run `npx wrangler login`, then this again.");

const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = Date.now();
const today = utcDay(now);
const dayList = Array.from({ length: days }, (_, i) => utcDay(now - (days - 1 - i) * DAY_MS));

const query = `query ($account: String!, $name: String!, $database: String!, $since: Date!, $month: Date!, $lately: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    worker: workersInvocationsAdaptive(limit: 100, filter: { scriptName: $name, date_geq: $since }) {
      sum { requests errors }
      dimensions { date }
    }
    rows: d1AnalyticsAdaptiveGroups(limit: 100, filter: { databaseId: $database, date_geq: $since }) {
      sum { rowsRead rowsWritten }
      dimensions { date }
    }
    stored: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $name, datetime_geq: $lately }, orderBy: [datetime_DESC]) {
      max { objectCount payloadSize metadataSize }
      dimensions { datetime }
    }
    operations: r2OperationsAdaptiveGroups(limit: 1000, filter: { bucketName: $name, date_geq: $month }) {
      sum { requests }
      dimensions { actionType }
    }
  } }
}`;
const variables = { account, name, database: database.uuid, since: dayList[0], month: `${today.slice(0, 7)}-01`, lately: new Date(now - DAY_MS).toISOString() };

const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ query, variables }),
});
const answer = await response.json().catch(() => null);
const data = answer?.data?.viewer?.accounts?.[0];
if (!data) {
  const errors = answer?.errors ?? [];
  const unauthorized = response.status === 401 || response.status === 403 || errors.some((error) => error.extensions?.code === "authz");
  stop(`Cloudflare's Analytics API refused (HTTP ${response.status}):\n${JSON.stringify(answer?.errors ?? answer, null, 2)}` +
    (unauthorized ? "\nWrangler's login may not read analytics on this account. A read-only API token with \"Account Analytics: Read\", in CLOUDFLARE_API_TOKEN, may." : ""));
}

const count = (n) => Number(n).toLocaleString("en-US");
const share = (n, of) => `${((n / of) * 100).toFixed(1)}%`;
const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

console.log(`Cloudflare usage for ${domain}`);
console.log(`worker, bucket and database ${name} · account ${account}`);

const bucket = data.stored[0]?.max ?? { objectCount: 0, payloadSize: 0, metadataSize: 0 };
const bucketBytes = bucket.payloadSize + bucket.metadataSize;
console.log("\nStored now");
console.log(`  ${"database".padEnd(10)} ${size(database.database_size).padStart(10)}   of 500 MB   ${share(database.database_size, 500e6).padStart(6)}`);
console.log(`  ${"bucket".padEnd(10)} ${size(bucketBytes).padStart(10)}   of 10 GB    ${share(bucketBytes, 10e9).padStart(6)}   ${count(bucket.objectCount)} objects`);

// A day Cloudflare has no row for is a day with nothing to count.
const DAILY = [
  { title: "Worker requests", allowed: 100_000, of: (day) => day.requests },
  { title: "D1 rows read", allowed: 5_000_000, of: (day) => day.rowsRead },
  { title: "D1 rows written", allowed: 100_000, of: (day) => day.rowsWritten },
];
const byDay = new Map(dayList.map((date) => [date, { requests: 0, errors: 0, rowsRead: 0, rowsWritten: 0 }]));
for (const row of data.worker) Object.assign(byDay.get(row.dimensions.date) ?? {}, row.sum);
for (const row of data.rows) Object.assign(byDay.get(row.dimensions.date) ?? {}, row.sum);

const WIDTH = 22;
const cell = (n, allowed) => `${count(n).padStart(10)}  ${share(n, allowed).padStart(6)}`.padEnd(WIDTH);
console.log("\nEach day (UTC), against what the free plan allows in a day");
console.log(`  ${"".padEnd(12)}${DAILY.map((column) => column.title.padStart(10 + 8).padEnd(WIDTH)).join("")}  Worker errors`);
console.log(`  ${"".padEnd(12)}${DAILY.map((column) => `of ${count(column.allowed)}`.padStart(10 + 8).padEnd(WIDTH)).join("")}`.trimEnd());
for (const [date, day] of byDay) {
  console.log(`  ${date.padEnd(12)}${DAILY.map((column) => cell(column.of(day), column.allowed)).join("")}  ${count(day.errors).padStart(13)}${date === today ? "   so far" : ""}`);
}
if (days > 1) {
  const highest = DAILY.map((column) => cell(Math.max(...[...byDay.values()].map(column.of)), column.allowed));
  console.log(`  ${"highest".padEnd(12)}${highest.join("")}`.trimEnd());
}

// R2 bills by class. A: writes and listings; B: reads; deletes are free.
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload",
  "CreateMultipartUpload", "UploadPart", "UploadPartCopy", "ListMultipartUploads", "ListParts", "PutBucketEncryption",
  "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation",
  "GetBucketCors", "GetBucketLifecycleConfiguration"]);
let classA = 0, classB = 0, free = 0;
const unclassed = {};
for (const row of data.operations) {
  const action = row.dimensions.actionType;
  if (CLASS_A.has(action)) classA += row.sum.requests;
  else if (CLASS_B.has(action)) classB += row.sum.requests;
  else if (/^(Delete|Abort)/.test(action)) free += row.sum.requests;
  else unclassed[action] = (unclassed[action] ?? 0) + row.sum.requests;
}
const line = (label, n, allowed) => `  ${label.padEnd(26)}${count(n).padStart(10)}${allowed ? `   of ${count(allowed).padEnd(10)}  ${share(n, allowed).padStart(6)}` : ""}`;
console.log(`\nR2 operations since ${variables.month}, against what the free plan allows in a month`);
console.log(line("Class A (writes, lists)", classA, 1_000_000));
console.log(line("Class B (reads)", classB, 10_000_000));
console.log(line("deletes (free)", free));
for (const [action, n] of Object.entries(unclassed)) console.log(line(`${action} (unclassed)`, n));
EOF
