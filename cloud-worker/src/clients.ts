// Which client is asking, read off `x-doklin-client`, and whether this worker
// still answers it. A client older than its minimum (version.ts) is refused
// on every /api request, before anything else is looked at, with a sentence
// telling it to update: `410 {error}`. The status is this refusal's alone —
// `426` is the manifest's, and every engine reads that one as "the worker is
// behind". Change both: engine/src/cloud/remote.rs and cli/src/http.rs read
// the 410.
//
// The header says (change both: src-tauri/src/engine.rs, cli/src/http.rs and
// ios/Doklin/DoklinApp.swift send it):
//   0.1.150              the Mac app, its release version
//   cli/0.1.150          `doklin`, its release version
//   ios/0.1.0+57         the iPhone, its version and build
//   ios/0.1.0+dev        an iPhone build run from Xcode: never refused
// Anything else — no header (a browser, a public page), a header this cannot
// read — is let through: the check turns away builds that say they are old,
// and is no lock.

import { json } from "./http";
import { MINIMUM_APP, MINIMUM_IOS } from "./version";

/** A version, and the build when one is named: [major, minor, patch, build]. */
type Version = [number, number, number, number | null];

export type Minimums = { app: string; ios: string };

/** What the release marked mandatory: version.ts. */
const SHIPPED: Minimums = { app: MINIMUM_APP, ios: MINIMUM_IOS };

/** scripts/install-doklin.sh, attached to every release (docs/release.md). */
const INSTALL_LINE =
  "curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh";

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const IOS = /^(\d+)\.(\d+)\.(\d+)(?:\+(\d+|dev))?$/;

/** "0.1.150", or "0.1.0+57" where builds count; null for anything else. */
function readVersion(text: string, re: RegExp): Version | "dev" | null {
  const m = re.exec(text);
  if (!m) return null;
  if (m[4] === "dev") return "dev";
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? null : Number(m[4])];
}

/** Whether `have` is older than `need`. A minimum with no build takes any
 *  build of its version; one with a build is older than a client naming none. */
function older(have: Version, need: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return (have[i] as number) < (need[i] as number);
  }
  return need[3] !== null && (have[3] ?? 0) < need[3];
}

/** A version the way TestFlight shows it: "0.1.0 (57)". */
const shown = (v: Version): string => `${v[0]}.${v[1]}.${v[2]}${v[3] === null ? "" : ` (${v[3]})`}`;

/** The refusal for a client older than `minimums`, or null to answer it. */
export function tooOld(client: string | null, host: string, minimums: Minimums = SHIPPED): Response | null {
  const said = client?.trim() ?? "";
  const [kind, text] = said.startsWith("cli/")
    ? (["cli", said.slice(4)] as const)
    : said.startsWith("ios/")
      ? (["ios", said.slice(4)] as const)
      : (["mac", said] as const);
  const have = readVersion(text, kind === "ios" ? IOS : RELEASE);
  const need = readVersion(kind === "ios" ? minimums.ios : minimums.app, IOS);
  if (have === null || have === "dev" || need === null || need === "dev" || !older(have, need)) return null;
  const needs = `This is ${kind === "cli" ? "doklin" : "Doklin"} ${shown(have)}, and ${host} needs ${shown(need)} or newer.`;
  const error =
    kind === "cli"
      ? `${needs} Update it: ${INSTALL_LINE} — or, on a Mac with the Doklin app, update the app.`
      : `${needs} Update Doklin to keep working.`;
  return json({ error }, 410);
}
