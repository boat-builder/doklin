// Mounts the REAL App on a pretend workspace held in memory, to try boards
// by hand: a folder of notes with tags (one whose value isn't in the list,
// one with none, an html document, a note in a subfolder). The tag list is
// the cloud status's, changed as tags.tsx changes it.
// A folder's `boards.json` is a file here like any other, read and written
// as the Mac's backend does (src-tauri/src/boards.rs): a write over a file
// that moved on is merged by record (`mergeBoards`). Nothing is kept: a
// reload starts again.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";
import {
  installBackend,
  SaveConflict,
  type Backend,
  type Cloud,
  type CloudStatus,
  type DocumentChange,
  type Documents,
  type FileClipboardPayload,
  type Rev,
  type TreeNode,
  type WatchedDocument,
} from "../src/backend";
import { BOARDS_FILE, isBoardsFile } from "../src/boards";
import { TAGS_MAX, keyedLines, matchesTags, tagProblem, withTag, withoutTag, type TagDef } from "../src/tags";
import { mergeBoards } from "../src/web/merge";

const ROOT = "/Team notes";
const UNTITLED = "/untitled";

// A file as the pretend disk holds it. `rev` counts the text's writes.
type File = { text: string; rev: number; meta: string | null };

const files = new Map<string, File>();
const dirs = new Set<string>([ROOT, `${ROOT}/Launch`, `${ROOT}/Launch/Archive`]);
const put = (path: string, text: string) => files.set(path, { text, rev: 1, meta: null });

put(`${ROOT}/Launch/Fix the login.md`, `---\nStatus: Doing\nPriority: p1\n---\nThe sign-in page loops.\n`);
put(`${ROOT}/Launch/Write the docs.md`, `---\nstatus: todo\n---\nWhat to write first.\n`);
put(`${ROOT}/Launch/Ship it.md`, `---\nStatus: Done\npriority: p2\n---\nOut on Friday.\n`);
put(`${ROOT}/Launch/Loose idea.md`, `A weekly digest of what changed.\n`);
put(`${ROOT}/Launch/Old.md`, `---\nStatus: Blocked\n---\nWaiting on the vendor.\n`);
put(
  `${ROOT}/Launch/Pricing.html`,
  `<!doctype html><html><body style="font-family: sans-serif; padding: 32px"><h1>Pricing</h1><p>An html document: no tags.</p></body></html>`,
);
put(`${ROOT}/Launch/Archive/Done before.md`, `---\nStatus: Done\n---\nLast quarter.\n`);
put(`${ROOT}/Ideas.md`, `- Pin a note to the top of a folder\n`);

const lower = (p: string) => p.toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => p.slice(0, p.lastIndexOf("/"));
const isMd = (p: string) => /\.(md|markdown|mdown|mkd)$/i.test(p);
const htmlOf = (md: string) => md.replace(/\.(md|markdown|mdown|mkd)$/i, ".html");
const revOf = (f: File) => f.rev as unknown as Rev;

// A name is taken whatever its case, as on a Mac's disk.
const fileAt = (path: string): string | undefined => {
  if (files.has(path)) return path;
  return [...files.keys()].find((p) => lower(p) === lower(path));
};
const dirAt = (path: string): string | undefined => [...dirs].find((d) => lower(d) === lower(path));
const taken = (path: string) => fileAt(path) !== undefined || dirAt(path) !== undefined;
const need = (path: string): File => {
  const f = files.get(path);
  if (!f) throw `“${baseName(path)}” no longer exists.`;
  return f;
};

const listeners = new Set<(change: DocumentChange) => void>();
let watched: WatchedDocument[] = [];

const treeOf = (dir: string): TreeNode & { kind: "dir" } => {
  const children: TreeNode[] = [];
  for (const d of [...dirs].filter((d) => dirName(d) === dir).sort()) children.push(treeOf(d));
  let board = false;
  for (const path of [...files.keys()].filter((p) => dirName(p) === dir).sort()) {
    if (isBoardsFile(path)) {
      board = true;
      continue;
    }
    if (path.endsWith(".html") && [...files.keys()].some((p) => isMd(p) && htmlOf(p) === path)) continue;
    children.push({ kind: "file", name: baseName(path), path, paired: isMd(path) && files.has(htmlOf(path)) });
  }
  return { kind: "dir", name: baseName(dir), path: dir, children, ...(board ? { board } : {}) };
};

// Every path a move takes along: a document's html and nothing else beside
// it (no sidecars here), a folder's whole inside.
const movePairs = (from: string, to: string, kind: "file" | "dir"): [string, string][] => {
  if (kind === "dir") {
    return [...files.keys()]
      .filter((p) => p.startsWith(`${from}/`))
      .map((p): [string, string] => [p, to + p.slice(from.length)]);
  }
  const pairs: [string, string][] = [[from, to]];
  if (isMd(from) && files.has(htmlOf(from))) pairs.push([htmlOf(from), htmlOf(to)]);
  return pairs;
};

const documents: Documents = {
  async open(path) {
    const f = need(path);
    const rendition = isMd(path) && files.has(htmlOf(path)) ? htmlOf(path) : null;
    return { text: f.text, rev: revOf(f), meta: f.meta, rendition };
  },
  async read(path) {
    const f = need(path);
    return { text: f.text, rev: revOf(f) };
  },
  meta: async (path) => files.get(path)?.meta ?? null,
  async save(path, parts, over) {
    let f = files.get(path);
    if (parts.text !== undefined) {
      if (f && over !== null && (over as unknown as number) !== f.rev) throw new SaveConflict(revOf(f));
      if (!f) files.set(path, (f = { text: "", rev: 0, meta: null }));
      f.text = parts.text;
      f.rev += 1;
    }
    if (parts.meta !== undefined) {
      if (!f) files.set(path, (f = { text: "", rev: 1, meta: null }));
      f.meta = parts.meta;
    }
    return { rev: parts.text === undefined ? null : revOf(f!) };
  },
  exists: async (path) => taken(path),
  documents: async (root) =>
    [...files.keys()]
      .filter((p) => p.startsWith(`${root}/`))
      .sort()
      .map((p) => ({ path: p.slice(root.length + 1), fileId: null, section: null })),
  tree: async (root) => treeOf(root),
  async create(path, kind) {
    if (taken(path)) throw `A file or folder named "${baseName(path)}" already exists`;
    if (kind === "dir") dirs.add(path);
    else put(path, "");
  },
  async move(from, to, kind) {
    const same = lower(from) === lower(to);
    if (!same && taken(to)) throw `A file or folder named "${baseName(to)}" already exists`;
    for (const [a, b] of movePairs(from, to, kind)) {
      const f = need(a);
      files.delete(a);
      files.set(b, f);
    }
    if (kind === "dir") {
      for (const d of [...dirs]) {
        if (d === from || d.startsWith(`${from}/`)) {
          dirs.delete(d);
          dirs.add(to + d.slice(from.length));
        }
      }
    }
    return [];
  },
  async copy(from, to, kind) {
    if (taken(to)) throw `A file or folder named "${baseName(to)}" already exists`;
    for (const [a, b] of movePairs(from, to, kind)) files.set(b, { ...need(a), rev: 1 });
    if (kind === "dir") dirs.add(to);
    return [];
  },
  // Nothing here takes a delete back, so the app asks first.
  removeUndoes: false,
  async remove(path, kind) {
    for (const [a] of movePairs(path, path, kind)) files.delete(a);
    if (kind === "dir") for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
    return { left: [], undo: null };
  },
  async watch(set) {
    watched = set;
  },
  onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  async search(root, query, caseSensitive, tags) {
    const norm = (t: string) => (caseSensitive ? t : t.toLowerCase());
    const q = norm(query);
    const out = [];
    for (const [path, f] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!path.startsWith(`${root}/`) || !isMd(path)) continue;
      if (!matchesTags(f.text, tags)) continue;
      const name = baseName(path);
      if (!q) {
        out.push({ path, name, named: false, matches: [] });
        continue;
      }
      const matches = f.text
        .split("\n")
        .map((line, i) => ({ line: i + 1, column: norm(line).indexOf(q) + 1, preview: line }))
        .filter((m) => m.column > 0);
      const named = norm(name.replace(/\.md$/, "")).includes(q);
      if (named || matches.length) out.push({ path, name, named, matches });
    }
    return { files: out, more: 0 };
  },
  searchByCase: true,
};

let clip: FileClipboardPayload | null = null;
const clipListeners = new Set<(clip: FileClipboardPayload | null) => void>();
const setClip = (next: FileClipboardPayload | null) => {
  clip = next;
  for (const cb of clipListeners) cb(clip);
};

// Connected: the status holds the list, a change of it is checked and made
// as the engine does (engine/src/cloud/unit.rs `queue_tag`), the cloud hears
// only what `__board.applied` says another device changed, and it refuses
// the rest.
let tags: TagDef[] = [
  { name: "Status", values: ["Todo", "Doing", "Done"], desc: "Where a piece of work is." },
  { name: "Priority", values: ["p1", "p2", "p3"], desc: "How soon it matters: p1 first." },
];
const statusListeners = new Set<(statuses: CloudStatus[]) => void>();
const statusNow = (): CloudStatus[] => [
  {
    root: ROOT,
    domain: "notes.example.com",
    endpoint: "https://notes.example.com",
    wsId: "w-board",
    name: "Team notes",
    phase: "idle",
    lastSyncMs: Date.now(),
    error: null,
    pendingDeletes: 0,
    pendingAdds: 0,
    usage: { mode: "normal", cause: null, today: 0, fleetToday: null, cap: 100000, plan: "free", resumesAt: null, waiting: 0, liftable: false, lifted: false },
    me: "You",
    meId: "m-you",
    can: ["work"],
    superadmin: "You",
    workerVersion: null,
    versions: { mirrored: 0, cloud: 0, lastMirrorMs: null, horizonDays: null },
    public: [],
    presence: [],
    leases: [],
    spaces: [],
    tags,
  },
];
const tell = () => {
  for (const cb of statusListeners) cb(statusNow());
};
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const applied = new Set<(e: { root: string; paths: string[] }) => void>();
const cloud = new Proxy({} as Cloud, {
  get: (_, name: string) => {
    if (name === "status") return async () => statusNow();
    if (name === "onStatus") {
      return (cb: (statuses: CloudStatus[]) => void) => {
        statusListeners.add(cb);
        return () => statusListeners.delete(cb);
      };
    }
    if (name === "onApplied") {
      return (cb: (e: { root: string; paths: string[] }) => void) => {
        applied.add(cb);
        return () => applied.delete(cb);
      };
    }
    if (name.startsWith("on")) return () => () => {};
    if (name === "setActivity") return async () => {};
    if (name === "setTag") {
      return async (_root: string, at: string, def: TagDef) => {
        const was = tags.find((d) => sameName(d.name, at));
        const wrong = tagProblem(def, tags, was?.name) ?? (!was && tags.length >= TAGS_MAX ? `A workspace can have ${TAGS_MAX} tags at most.` : null);
        if (wrong) throw new Error(wrong);
        tags = withTag(tags, at, def);
        tell();
      };
    }
    if (name === "removeTag") {
      return async (_root: string, tag: string) => {
        if (!tags.some((d) => sameName(d.name, tag))) throw new Error(`There's no tag called ${tag}.`);
        tags = withoutTag(tags, tag);
        tell();
      };
    }
    return async () => {
      throw new Error(`This page has no cloud: ${name}.`);
    };
  },
});

const boardAt = (dir: string) => fileAt(`${dir}/${BOARDS_FILE}`);
let boardWrites = 0;

const backend: Backend = {
  documents,
  boards: {
    async read(dir) {
      const at = boardAt(dir);
      const f = at ? files.get(at)! : null;
      return f ? { text: f.text, rev: revOf(f) } : null;
    },
    async write(dir, text, base) {
      const at = boardAt(dir) ?? `${dir}/${BOARDS_FILE}`;
      const f = files.get(at);
      if (!f && base) throw new Error("This folder isn't shown as a board any more.");
      const moved = f && (base === null || (base.rev as unknown as number) !== f.rev);
      const out = f && moved ? mergeBoards(base?.text ?? null, text, f.text) : text;
      if (f) {
        f.text = out;
        f.rev += 1;
      } else put(at, out);
      boardWrites += 1;
      return { text: out, rev: revOf(files.get(at)!) };
    },
    async remove(dir) {
      const at = boardAt(dir);
      if (at) files.delete(at);
    },
    folders: async (root) =>
      [...files.keys()].filter((p) => isBoardsFile(p) && p.startsWith(`${root}/`) && dirName(p) !== root).map(dirName).sort(),
    async cards(dir) {
      const out: Record<string, { name: string; value: string }[]> = {};
      for (const [path, f] of files) {
        if (dirName(path) !== dir || !isMd(path)) continue;
        out[baseName(path)] = keyedLines(f.text).flatMap((l) => (l.value === null ? [] : [{ name: l.key, value: l.value }]));
      }
      return out;
    },
  },
  cloud,
  fileClipboard: {
    get: async () => clip,
    set: async (items, cut) => setClip({ items, cut }),
    clear: async () => setClip(null),
    onChange(cb) {
      clipListeners.add(cb);
      return () => clipListeners.delete(cb);
    },
  },
  // ⌘N's notes: their buffers are files here too, outside the workspace.
  untitled: {
    dir: async () => UNTITLED,
    async discard(path) {
      files.delete(path);
    },
    orphans: async () => [],
  },
  openExternal: async () => {},
  authorName: async () => "You",
  setTitle(title) {
    document.title = title || "Board";
  },
  device: "computer",
  home: ROOT,
};

declare global {
  interface Window {
    __board: unknown;
  }
}
window.__board = {
  files: () => [...files.keys()].sort(),
  doc: (path: string) => files.get(path) ?? null,
  watched: () => watched,
  boardWrites: () => boardWrites,
  // Another device wrote a file, and the sync says so.
  synced(path: string, text: string) {
    const f = files.get(path);
    if (f) {
      f.text = text;
      f.rev += 1;
    } else put(path, text);
    for (const cb of applied) cb({ root: ROOT, paths: [path.slice(ROOT.length + 1)] });
  },
  // Another device changed a note: its text, and the change heard.
  external(path: string, text: string) {
    const f = files.get(path);
    if (!f) return;
    f.text = text;
    f.rev += 1;
    for (const cb of listeners) cb({ path, part: "text" });
  },
};

// Every load starts again: one tab, the ideas.
try {
  localStorage.clear();
  localStorage.setItem(
    "doklin:session",
    JSON.stringify({
      version: 2,
      lastRoot: ROOT,
      sessions: { [ROOT]: { tabs: [{ id: "t-ideas", kind: "file", path: `${ROOT}/Ideas.md` }], activeId: "t-ideas" } },
    }),
  );
} catch {
  // ignore
}

installBackend(backend);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
