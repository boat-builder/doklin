// Where a link written inside a note points on disk.
//
// The click gesture lives in linkOpen.ts; this is the other half of Notion's
// "an internal link opens in the app" — except that in a folder of markdown
// files, "internal" means a path: `[the other note](./other.md)`. Pure string
// work, so it can be tested without a filesystem (verify-harness/doclinks.test.mjs);
// whether the target actually exists is the caller's question.

// Fold "." and ".." out of a slash path, the way the filesystem would. A ".."
// that walks past an absolute root is dropped; on a relative path it is kept,
// so the result stays a truthful (if unopenable) path rather than a wrong one.
export function normalizePath(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

export const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};

/**
 * Resolve a link's href against the note it was written in — "./other.md",
 * "../archive/x.md", "/Users/me/notes/x.md", "file:///…". Returns null when
 * the target can't be placed: an external URL, or a relative link in a
 * document that has no path of its own (an unsaved draft).
 *
 * A #fragment or ?query is dropped — opening the document is as far as a link
 * between files takes us.
 */
export function linkTargetPath(href: string, fromPath: string | null): string | null {
  let raw = href.trim();
  if (/^file:\/\//i.test(raw)) raw = raw.slice("file://".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // some other scheme: not a path
  raw = raw.split("#")[0].split("?")[0];
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // a malformed escape sequence — take the path as written
  }
  if (raw.startsWith("/")) return normalizePath(raw);
  if (!fromPath) return null;
  return normalizePath(`${dirOf(fromPath)}/${raw}`);
}

/**
 * The inverse: how to write a link to `target` from inside `fromPath`, as a
 * relative path (`./Projects`, `../archive/x.md`). Both are absolute
 * workspace paths. Relative is what gets written because it is what survives
 * the folder being moved, renamed, or synced onto a machine that keeps its
 * notes somewhere else — the same reason a note links to its neighbour by
 * `./other.md` rather than by an absolute path.
 */
export function relativeLinkPath(fromPath: string, target: string): string {
  const from = normalizePath(dirOf(fromPath)).split("/").filter(Boolean);
  const to = normalizePath(target).split("/").filter(Boolean);
  let same = 0;
  while (same < from.length && same < to.length && from[same] === to[same]) same++;
  const up = from.length - same;
  const down = to.slice(same);
  if (up === 0 && down.length === 0) return ".";
  if (up === 0) return `./${down.join("/")}`;
  return [...Array<string>(up).fill(".."), ...down].join("/");
}
