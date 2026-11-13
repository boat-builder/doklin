#!/bin/sh
# How much of Cloudflare's free plan one Doklin domain is using — a table for
# us, while agents are new and nobody yet knows what they cost. Doklin itself
# puts no limit on an agent (docs/cloud.md §8.7); this is how that decision
# is watched. It ships nowhere and nothing calls it.
#
#   scripts/cloud-usage.sh notes.example.com
#
# It reads, and changes nothing:
#
#   wrangler d1 info        the database: size, and what it reports of the last 24 h
#   wrangler r2 bucket info the bucket: objects and bytes stored
#   GraphQL Analytics API   Worker requests since 00:00 UTC, and the bucket's
#                           operations this month — wrangler has no command for either
#
# The names follow the domain, as the setup prompt makes them: dots become
# dashes behind "doklin-". Wrangler must be logged in to the account that
# holds them (`npx wrangler login`).
#
# The Analytics API needs two things wrangler does not hand over by itself:
#
#   CLOUDFLARE_ACCOUNT_ID   the account's id (`npx wrangler whoami` prints it)
#   CLOUDFLARE_API_TOKEN    a token that may read analytics. Without one the
#                           script tries the token wrangler is logged in with.
#
# NOT YET RUN AGAINST A REAL ACCOUNT. Two things are unconfirmed and the
# script is written so that neither can produce a wrong number: which fields
# `wrangler d1 info --json` and `r2 bucket info --json` report (anything not
# recognised is printed as wrangler gave it), and whether wrangler's own
# login token may read Workers analytics (if not, the API's refusal is
# printed, and a read-only token with "Account Analytics: Read" is what it
# takes).
set -eu

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: scripts/cloud-usage.sh <domain>" >&2
  exit 2
fi
NAME="doklin-$(printf '%s' "$DOMAIN" | tr '.' '-')"
WRANGLER="npx -y wrangler@4"

echo "Cloudflare usage for $DOMAIN  (worker, bucket and database: $NAME)"
echo

# One wrangler JSON answer, reduced to the fields worth a line. Whatever is
# not recognised is shown whole rather than guessed at.
show() { # $1 = label, $2 = "key:Label:limit:unit ..." , stdin = JSON
  node -e '
    const [label, spec] = process.argv.slice(1);
    let text = "";
    process.stdin.on("data", (d) => (text += d)).on("end", () => {
      let v;
      try { v = JSON.parse(text); } catch { console.log(`${label}: wrangler did not answer JSON:\n${text.trim()}`); return; }
      if (Array.isArray(v)) v = v[0] ?? {};
      const fmt = (n, unit) => unit === "bytes" ? `${(n / 1048576).toFixed(1)} MB` : Number(n).toLocaleString("en-US");
      let found = 0;
      for (const item of spec.split(" ")) {
        const [keys, name, limit, unit] = item.split(":");
        const key = keys.split("|").find((k) => v[k] !== undefined && v[k] !== null);
        if (!key) continue;
        found += 1;
        const n = Number(v[key]);
        const of = limit ? `  of ${fmt(Number(limit), unit)}  (${((n / Number(limit)) * 100).toFixed(1)}%)` : "";
        console.log(`  ${name.replace(/_/g, " ").padEnd(28)} ${fmt(n, unit)}${of}`);
      }
      if (found === 0) console.log(`  none of the expected fields were reported — wrangler said:\n${JSON.stringify(v, null, 2)}`);
    });
  ' "$1" "$2"
}

echo "D1 database (free: 5,000,000 rows read and 100,000 written a day, 500 MB)"
$WRANGLER d1 info "$NAME" --json 2>&1 | show "d1" \
  "rows_read_24h:rows_read,_last_24_h:5000000 rows_written_24h:rows_written,_last_24_h:100000 read_queries_24h:read_queries,_last_24_h write_queries_24h:write_queries,_last_24_h database_size|file_size:size:524288000:bytes"
echo

echo "R2 bucket (free: 10 GB stored)"
$WRANGLER r2 bucket info "$NAME" --json 2>&1 | show "r2" \
  "object_count|objectCount:objects bucket_size|bucketSize|size:stored:10737418240:bytes"
echo

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$ACCOUNT" ]; then
  echo "Worker requests and R2 operations: set CLOUDFLARE_ACCOUNT_ID to read them"
  echo "  (wrangler has no command for either; \`npx wrangler whoami\` prints the id)"
  exit 0
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$($WRANGLER auth token 2>/dev/null | tail -n 1 || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "Worker requests and R2 operations: no token — set CLOUDFLARE_API_TOKEN (Account Analytics: Read)"
  exit 0
fi

DAY_START="$(date -u +%Y-%m-%dT00:00:00Z)"
MONTH_START="$(date -u +%Y-%m-01T00:00:00Z)"

QUERY='query ($account: String!, $script: String!, $bucket: String!, $day: Time!, $month: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $script, datetime_geq: $day }) {
      sum { requests errors subrequests }
    }
    r2OperationsAdaptiveGroups(limit: 10000, filter: { bucketName: $bucket, datetime_geq: $month }) {
      sum { requests }
      dimensions { actionType }
    }
  } }
}'

BODY="$(node -e '
  const [query, account, name, day, month] = process.argv.slice(1);
  console.log(JSON.stringify({ query, variables: { account, script: name, bucket: name, day, month } }));
' "$QUERY" "$ACCOUNT" "$NAME" "$DAY_START" "$MONTH_START")"

curl -sS https://api.cloudflare.com/client/v4/graphql \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" --data "$BODY" |
  node -e '
    // R2 bills by class. A: writes and listings; B: reads; deletes are free.
    const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload",
      "CreateMultipartUpload", "UploadPart", "UploadPartCopy", "ListMultipartUploads", "ListParts", "PutBucketEncryption",
      "PutBucketCors", "PutBucketLifecycleConfiguration"]);
    const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation",
      "GetBucketCors", "GetBucketLifecycleConfiguration"]);
    let text = "";
    process.stdin.on("data", (d) => (text += d)).on("end", () => {
      let v;
      try { v = JSON.parse(text); } catch { console.log(`The Analytics API did not answer JSON:\n${text.trim()}`); return; }
      const account = v?.data?.viewer?.accounts?.[0];
      if (!account) {
        console.log("The Analytics API refused, or knows no such account:");
        console.log(JSON.stringify(v.errors ?? v, null, 2));
        console.log("A read-only API token with \"Account Analytics: Read\", in CLOUDFLARE_API_TOKEN, is what this needs.");
        return;
      }
      const n = (x) => Number(x).toLocaleString("en-US");
      const pct = (x, of) => `${((x / of) * 100).toFixed(1)}%`;
      const worker = (account.workersInvocationsAdaptive ?? []).reduce(
        (sum, row) => ({ requests: sum.requests + row.sum.requests, errors: sum.errors + row.sum.errors, subrequests: sum.subrequests + row.sum.subrequests }),
        { requests: 0, errors: 0, subrequests: 0 });
      console.log("Worker, since 00:00 UTC (free: 100,000 requests a day)");
      console.log(`  ${"requests".padEnd(28)} ${n(worker.requests)}  of 100,000  (${pct(worker.requests, 100000)})`);
      console.log(`  ${"errors".padEnd(28)} ${n(worker.errors)}`);
      console.log(`  ${"subrequests".padEnd(28)} ${n(worker.subrequests)}`);
      let a = 0, b = 0, free = 0;
      const other = {};
      for (const row of account.r2OperationsAdaptiveGroups ?? []) {
        const action = row.dimensions.actionType;
        const count = row.sum.requests;
        if (CLASS_A.has(action)) a += count;
        else if (CLASS_B.has(action)) b += count;
        else if (/^(Delete|Abort)/.test(action)) free += count;
        else other[action] = (other[action] ?? 0) + count;
      }
      console.log("\nR2 operations, this month (free: 1,000,000 Class A and 10,000,000 Class B)");
      console.log(`  ${"Class A (writes, lists)".padEnd(28)} ${n(a)}  of 1,000,000  (${pct(a, 1000000)})`);
      console.log(`  ${"Class B (reads)".padEnd(28)} ${n(b)}  of 10,000,000  (${pct(b, 10000000)})`);
      console.log(`  ${"deletes (free)".padEnd(28)} ${n(free)}`);
      for (const [action, count] of Object.entries(other)) console.log(`  ${(action + " (unclassed)").padEnd(28)} ${n(count)}`);
    });
  '
