#!/bin/sh
# Doklin — update the cloud worker serving one domain to the code published
# with the latest Doklin release (docs/cloud.md §7.4).
#
#   sh doklin-cloud-update.sh https://notes.example.com
#
# It is attached to every release, so nobody clones anything to run it:
#
#   curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-update.sh -o doklin-cloud-update.sh
#   sh doklin-cloud-update.sh https://notes.example.com
#
# Why a script and not an agent prompt, when setup and teardown are prompts:
# the update is one deterministic sequence with no judgement in it — fetch the
# worker, confirm the names, write wrangler.toml, deploy over the same name.
# The app's "Update the worker" card hands an agent these same two commands.
#
# This is a CODE-ONLY redeploy. The R2 bucket binding, the OWNER_TOKEN secret
# and the domain routing all survive a same-name deploy, so there is nothing
# secret in this file and nothing else on the Cloudflare account is touched.
#
# The one thing it will not do is guess. Deploying under a name that doesn't
# exist CREATES a second worker rather than updating yours, so the worker and
# its bucket are confirmed against the account before anything is written, and
# the script asks — or, with no terminal to ask from, stops and says what to
# pass — rather than inventing a name.
#
# Needs curl and Node.js (https://nodejs.org). Wrangler opens a browser to sign
# you in to Cloudflare if you are not signed in already.
#
# Env, all optional:
#   CLOUDFLARE_ACCOUNT_ID=…              pick one, when the login has several
#   WORKER_NAME=… BUCKET_NAME=…          override the names read from the endpoint
#
# `sh doklin-cloud-update.sh --names <endpoint>` prints the names it would use
# and exits — verify-harness/cloudprompts.test.mjs runs it to hold this file
# and src/cloudPrompts.ts to the same naming rule.

set -u

BUNDLE_URL="https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js"
# cloud-worker/src/version.ts is the source of this date; the test pins them
# together. Moving it changes runtime behaviour — do it there, on purpose.
COMPATIBILITY_DATE="2025-05-05"
WRANGLER="wrangler@4"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
interactive() { [ -t 0 ]; }

# ---------- the endpoint, and the names it implies ----------
#
# The same rule as `deploymentNames` in src/cloudPrompts.ts: a workers.dev
# hostname carries the worker's name in its first label and is certain; a
# custom domain falls back to the convention `doklin-<domain with dashes>`,
# which is a guess and gets verified before any deploy.

host_of() {
  printf '%s' "$1" |
    tr 'A-Z' 'a-z' |
    sed -e 's#^[a-z][a-z0-9+.-]*://##' -e 's#/.*$##' -e 's#:[0-9]*$##' -e 's#\.$##'
}

usage() { printf 'usage: sh %s https://notes.example.com\n' "$0"; }

derive_names() {
  HOST=$(host_of "$1")
  if ! printf '%s' "$HOST" |
    grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
    usage >&2
    die "\"$1\" is not a domain. The endpoint is the one in Doklin's Cloud panel."
  fi
  ENDPOINT="https://$HOST"
  # <name>.<subdomain>.workers.dev — four labels, no more.
  if [ "$(printf '%s' "$HOST" | awk -F. '{print NF}')" = "4" ] &&
    [ "${HOST#*.*.}" = "workers.dev" ] &&
    printf '%s' "${HOST%%.*}" | grep -Eq '^[a-z0-9-]+$'; then
    WORKER=${HOST%%.*}
    DOMAIN=""
    CERTAIN=1
  else
    WORKER="doklin-$(printf '%s' "$HOST" | tr '.' '-')"
    DOMAIN="$HOST"
    CERTAIN=0
  fi
  BUCKET="$WORKER"
  [ -z "${WORKER_NAME:-}" ] || { WORKER="$WORKER_NAME"; CERTAIN=0; }
  [ -z "${BUCKET_NAME:-}" ] || BUCKET="$BUCKET_NAME"
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

if [ "${1:-}" = "--names" ]; then
  derive_names "${2:-}"
  say "worker=$WORKER"
  say "bucket=$BUCKET"
  say "domain=$DOMAIN"
  say "certain=$CERTAIN"
  exit 0
fi

if [ $# -ge 1 ]; then
  target=$1
elif interactive; then
  printf 'Which domain? (the endpoint in Doklin'\''s Cloud panel) '
  read -r target || die "no endpoint given"
else
  usage >&2
  die "no endpoint given."
fi
derive_names "$target"

command -v curl >/dev/null 2>&1 || die "curl not found."
command -v npx >/dev/null 2>&1 ||
  die "npx not found. Install Node.js from https://nodejs.org, then re-run this."

say "Updating the Doklin worker serving $ENDPOINT"
say "  worker \"$WORKER\" · bucket \"$BUCKET\""
say ""

# ---------- 1. the worker, from the latest release ----------

work=$(mktemp -d) || die "couldn't make a working directory"
trap 'rm -rf "$work"' EXIT INT TERM
cd "$work" || die "couldn't enter $work"

say "Downloading the worker…"
curl -fsSL "$BUNDLE_URL" -o doklin-cloud-worker.js || die "download failed: $BUNDLE_URL
       If it 404s, clone https://github.com/boat-builder/doklin, run
       \`pnpm install && node scripts/bundle-worker.mjs\` there, and re-run this
       script from a directory holding the built doklin-cloud-worker.js."

# ---------- 2. the Cloudflare login, and which account ----------
#
# whoami's exit code has not been dependable across wrangler versions, so the
# account id in its output is what says "signed in". Cloudflare account ids are
# 32 hex characters; exporting the one we find carries it to the name checks
# too, not only the deploy.

say "Checking your Cloudflare login…"
whoami_said=$(npx -y "$WRANGLER" whoami 2>&1)
ids=$(printf '%s\n' "$whoami_said" | grep -oE '[0-9a-f]{32}' | sort -u)
if [ -z "$ids" ]; then
  interactive || die "not signed in to Cloudflare. Run \`npx -y $WRANGLER login\` and re-run this."
  say "Not signed in — opening Cloudflare's sign-in in your browser."
  npx -y "$WRANGLER" login || die "sign-in failed."
  whoami_said=$(npx -y "$WRANGLER" whoami 2>&1)
  ids=$(printf '%s\n' "$whoami_said" | grep -oE '[0-9a-f]{32}' | sort -u)
  [ -n "$ids" ] || die "still not signed in."
fi

if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  : # the caller picked
elif [ "$(printf '%s\n' "$ids" | wc -l | tr -d ' ')" = "1" ]; then
  CLOUDFLARE_ACCOUNT_ID="$ids"
else
  say ""
  say "This login reaches more than one Cloudflare account, and wrangler can't"
  say "pick for you. Here is what it sees:"
  printf '%s\n' "$whoami_said" | sed 's/^/  /'
  say ""
  interactive || die "re-run with the account the worker is on, e.g.
       CLOUDFLARE_ACCOUNT_ID=$(printf '%s\n' "$ids" | head -1) sh $0 $ENDPOINT"
  n=0
  for id in $ids; do
    n=$((n + 1))
    say "  $n) $id"
  done
  printf 'Which account is %s on? [1-%s] ' "$WORKER" "$n"
  pick=""
  read -r pick || pick=""
  CLOUDFLARE_ACCOUNT_ID=$(printf '%s\n' "$ids" | sed -n "${pick:-0}p")
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] || die "no account chosen."
fi
export CLOUDFLARE_ACCOUNT_ID

# ---------- 3. the names, confirmed against the account ----------

# Both checks keep wrangler's own words in $probe: "no such worker" and "this
# login can't see that account" are very different problems, and the second one
# is not fixed by typing a different name.
probe=""

worker_exists() {
  probe=$(npx -y "$WRANGLER" deployments list --name "$1" 2>&1)
}

bucket_listed=""
bucket_exists() {
  bucket_listed=""
  probe=$(npx -y "$WRANGLER" r2 bucket list 2>&1) || return 1
  bucket_listed=1
  printf '%s\n' "$probe" | tr -s ' \t,"|│' '\n' | grep -Fxq "$1"
}

say "Confirming the worker…"
answer=""
while ! worker_exists "$WORKER"; do
  warn ""
  warn "Couldn't confirm a worker named \"$WORKER\" on this account. Wrangler said:"
  printf '%s\n' "$probe" | sed 's/^/  | /' >&2
  if [ "$CERTAIN" = "1" ]; then
    warn "That name comes straight from the endpoint's hostname, so either the"
    warn "worker was renamed or this is the wrong Cloudflare account."
  else
    warn "That name is Doklin's naming convention, not something the endpoint"
    warn "told us. Deploying it blind would create a SECOND worker instead of"
    warn "updating yours, so nothing has been deployed."
  fi
  warn "Look the real name up in the Cloudflare dashboard, under Workers & Pages."
  interactive || die "re-run with the name, e.g. WORKER_NAME=my-worker sh $0 $ENDPOINT"
  printf 'Worker name (blank to give up): '
  read -r answer || answer=""
  [ -n "$answer" ] || die "nothing deployed."
  WORKER="$answer"
  CERTAIN=0
  [ -n "${BUCKET_NAME:-}" ] || BUCKET="$WORKER"
done

say "Confirming the bucket…"
while ! bucket_exists "$BUCKET"; do
  warn ""
  if [ -z "$bucket_listed" ]; then
    warn "Couldn't list this account's R2 buckets. Wrangler said:"
    printf '%s\n' "$probe" | sed 's/^/  | /' >&2
  else
    warn "No R2 bucket named \"$BUCKET\" on this account."
  fi
  warn "Deploying with the wrong bucket would point the worker at the wrong"
  warn "data, so nothing has been deployed. The right name is in the dashboard,"
  warn "under the worker → Settings → Bindings (the binding called DATA)."
  interactive || die "re-run with the name, e.g. BUCKET_NAME=my-bucket sh $0 $ENDPOINT"
  printf 'Bucket name (blank to give up): '
  read -r answer || answer=""
  [ -n "$answer" ] || die "nothing deployed."
  BUCKET="$answer"
done

# ---------- 4. deploy over the same name ----------

if [ -n "$DOMAIN" ]; then
  routes="workers_dev = false
routes = [{ pattern = \"$DOMAIN\", custom_domain = true }]"
else
  routes="workers_dev = true"
fi

cat > wrangler.toml <<TOML
name = "$WORKER"
main = "doklin-cloud-worker.js"
compatibility_date = "$COMPATIBILITY_DATE"
account_id = "$CLOUDFLARE_ACCOUNT_ID"
$routes
[[r2_buckets]]
binding = "DATA"
bucket_name = "$BUCKET"
TOML

say ""
say "Deploying…"
npx -y "$WRANGLER" deploy || die "the deploy failed — see wrangler's output above.
       $ENDPOINT keeps serving its old worker; nothing is broken."

# ---------- 5. is it up? ----------
#
# /api/meta wants the owner token, which this script deliberately does not
# have, so 401 is the answer that means "the new worker is serving". A custom
# domain can take a moment to come back, so give it one.
#
# ${ENDPOINT} is braced because the next character is not ASCII: macOS's
# /bin/sh is bash 3.2, which in a UTF-8 locale eats the first byte of a
# multibyte character into the variable name and then dies under `set -u`
# ("ENDPOINT\xe2: unbound variable"). The test greps for the pattern.

say ""
say "Checking ${ENDPOINT}…"
code=""
i=0
while [ "$i" -lt 10 ]; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$ENDPOINT/api/meta" 2>/dev/null || printf '000')
  [ "$code" = "401" ] && break
  i=$((i + 1))
  sleep 3
done

if [ "$code" != "401" ]; then
  warn "The deploy succeeded, but $ENDPOINT/api/meta answered $code instead of 401."
  warn "Give it a minute and press \"Check again\" in Doklin's Cloud panel."
  exit 1
fi

say ""
say "UPDATED: $ENDPOINT"
say "Press \"Check again\" in Doklin to confirm the version."
