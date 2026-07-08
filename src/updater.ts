// Update check: compares the running app version against the latest published
// GitHub release. Doklin ships a signed DMG via GitHub Releases (see
// .github/workflows/release.yml), not the Tauri auto-updater — so there is no
// updater manifest to swap the bundle in place. Instead we detect a newer
// version and point the user at the release page to download the new DMG.
//
// The check is a plain browser `fetch` from the webview: CSP is disabled
// (tauri.conf.json `security.csp: null`) and GitHub's API sends
// `Access-Control-Allow-Origin: *`, so no HTTP plugin or Rust command is needed.
// Opening the download page reuses the existing `open_external` command.
import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "boat-builder/doklin";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** The rolling "latest release" page — fallback when a release has no html_url. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export type UpdateStatus = {
  /** The running app version, e.g. "0.1.0". */
  current: string;
  /** The latest published release version (tag minus the leading "v"), or null. */
  latest: string | null;
  /** True when `latest` is strictly newer than `current`. */
  available: boolean;
  /** Where to send the user to download — the specific release page. */
  url: string;
  /** Release notes (GitHub release body), possibly empty. */
  notes: string;
  /** Epoch ms of when this check completed. */
  checkedAt: number;
  /** A human-readable reason the check couldn't complete, or null on success. */
  error: string | null;
};

type GithubRelease = {
  tag_name?: string;
  body?: string;
  html_url?: string;
};

// Parse "X.Y.Z[-prerelease][+build]" (tolerating a leading "v"). Build metadata
// is dropped; a missing/garbage version yields null so the caller can fall back
// to a string compare.
function parseSemver(v: string): { core: [number, number, number]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    v.trim(),
  );
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
}

/**
 * Compare two semver strings. Returns -1, 0, or 1 for a < b, a == b, a > b.
 * A full release outranks a pre-release of the same core (1.0.0 > 1.0.0-rc1).
 * Non-semver inputs fall back to a plain string comparison.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a is a release, b is a pre-release of the same core
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** Fetch the latest release and diff it against the running version. Never throws. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = await getVersion();
  const base: UpdateStatus = {
    current,
    latest: null,
    available: false,
    url: RELEASES_PAGE,
    notes: "",
    checkedAt: Date.now(),
    error: null,
  };
  try {
    const resp = await fetch(LATEST_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (resp.status === 404) {
      return { ...base, error: "No releases published yet." };
    }
    if (
      resp.status === 403 &&
      resp.headers.get("X-RateLimit-Remaining") === "0"
    ) {
      return { ...base, error: "GitHub rate limit reached — try again later." };
    }
    if (!resp.ok) {
      return { ...base, error: `Update check failed (HTTP ${resp.status}).` };
    }
    const data = (await resp.json()) as GithubRelease;
    const latest = String(data.tag_name ?? "")
      .trim()
      .replace(/^v/, "");
    if (!latest) {
      return { ...base, error: "Latest release has no version tag." };
    }
    return {
      ...base,
      latest,
      available: compareVersions(latest, current) > 0,
      url: data.html_url || RELEASES_PAGE,
      notes: String(data.body ?? "").trim(),
    };
  } catch (e) {
    return {
      ...base,
      error: e instanceof Error ? e.message : "Update check failed.",
    };
  }
}

/**
 * Owns update-check state and runs one quiet check on mount. Returns the last
 * status, whether a check is in flight, and a `check` fn for the manual button.
 */
export function useUpdateCheck() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const s = await checkForUpdate();
      setStatus(s);
      return s;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void checkForUpdate().then((s) => {
      if (alive) setStatus(s);
      if (alive) setChecking(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { status, checking, check };
}
