// Mounts the REAL App on a pretend connected workspace held in memory, to
// try tags by hand: notes in Library with tags, one whose value isn't in the
// list, one with other frontmatter beside its tags, and one with none. The
// list is the status's, as a Mac's engine says it, and changed the way the
// engine changes it (src/tags.ts's rules and `withTag`). The search reads
// tags the way the Mac's does (src-tauri/src/tags.rs), through the same
// rules in TypeScript. Nothing is kept: a reload starts again.
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
import { TAGS_MAX, matchesTags, tagProblem, withTag, withoutTag, type TagDef } from "../src/tags";

const ROOT = "/Team notes";
const LIB = `${ROOT}/Library`;
const UNTITLED = "/untitled";

// A file as the pretend disk holds it. `rev` counts the text's writes.
type File = { text: string; rev: number; meta: string | null };

const files = new Map<string, File>();
const dirs = new Set<string>([ROOT, LIB, `${LIB}/Projects`]);
const put = (path: string, text: string) => files.set(path, { text, rev: 1, meta: null });

put(
  `${LIB}/Launch plan.md`,
  `---
status: Doing
priority: p1
owner: ada
---
## Goals

Ship the launch to ten teams by the end of the quarter.
`,
);
put(`${LIB}/Ideas.md`, `- A weekly digest of what changed\n- Pin a note to the top of a folder\n`);
put(`${LIB}/Old.md`, `---\nstatus: Blocked\n---\nWaiting on the vendor.\n`);
put(`${LIB}/Roadmap.md`, `---\nstatus: doing\n---\n## Now\n\nTags on notes.\n`);
put(`${LIB}/Projects/Beta.md`, `---\r\nStatus: Doing\r\n---\r\nTen teams in the beta.\r\n`);
put(`${LIB}/Projects/Notes.md`, `---\nStatus: Todo\n---\nNothing yet.\n`);
put(
  `${LIB}/Projects/Pricing.html`,
  `<!doctype html><html><body style="font-family: sans-serif; padding: 32px"><h1>Pricing</h1><p>An html document: no tags.</p></body></html>`,
);

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
  for (const path of [...files.keys()].filter((p) => dirName(p) === dir).sort()) {
    if (path.endsWith(".html") && [...files.keys()].some((p) => isMd(p) && htmlOf(p) === path)) continue;
    children.push({ kind: "file", name: baseName(path), path, paired: isMd(path) && files.has(htmlOf(path)) });
  }
  return { kind: "dir", name: baseName(dir), path: dir, children };
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

// Connected, until `__tags.disconnect()`: the status holds the list, a
// change of it is checked and made as the engine does (engine/src/cloud/
// unit.rs `queue_tag`), and the rest of the cloud refuses.
let connected = true;
let tags: TagDef[] = [
  { name: "Status", values: ["Todo", "Doing", "Done"], desc: "Where a piece of work is." },
  { name: "Priority", values: ["p1", "p2", "p3"], desc: "How soon it matters: p1 first." },
];
const statusListeners = new Set<(statuses: CloudStatus[]) => void>();
const statusNow = (): CloudStatus[] =>
  connected
    ? [
        {
          root: ROOT,
          domain: "notes.example.com",
          endpoint: "https://notes.example.com",
          wsId: "w-tags",
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
      ]
    : [];
const tell = () => {
  for (const cb of statusListeners) cb(statusNow());
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tagCalls: unknown[] = [];
const cloud = new Proxy({} as Cloud, {
  get: (_, name: string) => {
    if (name === "status") return async () => statusNow();
    if (name === "onStatus") {
      return (cb: (statuses: CloudStatus[]) => void) => {
        statusListeners.add(cb);
        return () => statusListeners.delete(cb);
      };
    }
    if (name.startsWith("on")) return () => () => {};
    if (name === "setActivity") return async () => {};
    if (name === "setTag") {
      return async (_root: string, at: string, def: TagDef) => {
        const was = tags.find((d) => same(d.name, at));
        const wrong = tagProblem(def, tags, was?.name) ?? (!was && tags.length >= TAGS_MAX ? `A workspace can have ${TAGS_MAX} tags at most.` : null);
        if (wrong) throw new Error(wrong);
        tagCalls.push({ set: at, def });
        tags = withTag(tags, at, def);
        tell();
      };
    }
    if (name === "removeTag") {
      return async (_root: string, tag: string) => {
        if (!tags.some((d) => same(d.name, tag))) throw new Error(`There's no tag called ${tag}.`);
        tagCalls.push({ remove: tag });
        tags = withoutTag(tags, tag);
        tell();
      };
    }
    return async () => {
      throw new Error(`This page has no cloud: ${name}.`);
    };
  },
});

const backend: Backend = {
  documents,
  // No folder here is shown as a board.
  boards: {
    read: async () => null,
    write: async () => {
      throw new Error("This page has no boards.");
    },
    remove: async () => {},
    folders: async () => [],
    cards: async () => ({}),
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
    document.title = title || "Tags";
  },
  device: "computer",
  home: ROOT,
};

declare global {
  interface Window {
    __tags: unknown;
  }
}
window.__tags = {
  files: () => [...files.keys()].sort(),
  doc: (path: string) => files.get(path) ?? null,
  watched: () => watched,
  tags: () => tags,
  // Each change of the list, in order.
  tagCalls: () => tagCalls,
  // The folder is no longer a connected workspace's.
  disconnect() {
    connected = false;
    tell();
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

// Every load starts again: one tab, the launch plan.
try {
  localStorage.clear();
  localStorage.setItem(
    "doklin:session",
    JSON.stringify({
      version: 2,
      lastRoot: ROOT,
      sessions: { [ROOT]: { tabs: [{ id: "t-launch", kind: "file", path: `${LIB}/Launch plan.md` }], activeId: "t-launch" } },
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
