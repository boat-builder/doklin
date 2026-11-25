// Mounts the REAL App on a pretend workspace held in memory, to try a
// document's title by hand: the name above each note is its file's, and
// typing there renames it. Folders, an html-only document and an "Untitled"
// one are there to rename into, against and over. The files rename and
// collide the way a Mac's do (a name is taken whatever its case). Nothing
// is kept: a reload starts again.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";
import {
  installBackend,
  SaveConflict,
  type Backend,
  type Cloud,
  type DocumentChange,
  type Documents,
  type FileClipboardPayload,
  type Rev,
  type TreeNode,
  type WatchedDocument,
} from "../src/backend";

const ROOT = "/Team notes";
const UNTITLED = "/untitled";

// A file as the pretend disk holds it. `rev` counts the text's writes.
type File = { text: string; rev: number; meta: string | null };

const files = new Map<string, File>();
const dirs = new Set<string>([ROOT, `${ROOT}/Projects`, `${ROOT}/Meetings`, `${ROOT}/Archive`]);
const put = (path: string, text: string) => files.set(path, { text, rev: 1, meta: null });

put(
  `${ROOT}/Welcome.md`,
  `The name above this note is the file's name, and typing there renames the file. Things to try:

- Click the title and type. The tab and the sidebar row follow each keystroke; the file is renamed when you stop for a moment, or when you leave the title.
- Press Enter, ↓ at the end of the title, or Tab: the caret goes to the start of the note. ↑ on the note's first line comes back up.
- Name it **Ideas**: that name is taken in this folder, so a line under the title says so. Click away and the title goes back.
- Type a \`/\` in the title: a file name can't hold one, and the line says that at once.
- Open **Projects → Launch plan** and name it **Pricing**: Pricing is an html document there, so the name is taken.
- Change only the case of a title (welcome): that's a rename too.
- Clear the title and click away: the name stays.
- Open **Untitled**: its title is empty with a grey placeholder, so you just type.
- Make a new document: the blue + beside Search, or right-click a folder → New Document. It's made as "Untitled" with the caret in its title.
- ⌘N (or Ctrl+N) opens a note with no file: its title names the tab and is what Save offers.
- Split the view (⌘⇧\\\\) with another note: the other pane's title follows, read-only.

A reload starts everything again.
`,
);
put(`${ROOT}/Ideas.md`, `- A weekly digest of what changed\n- Pin a note to the top of a folder\n`);
put(`${ROOT}/Untitled.md`, "");
put(
  `${ROOT}/Projects/Launch plan.md`,
  `## Goals\n\nShip the first version to ten teams by the end of the quarter.\n\n## Milestones\n\n1. Private beta\n2. Public page\n3. Pricing\n\n## Risks\n\nThe import from other tools is the slowest part.\n`,
);
put(
  `${ROOT}/Projects/Pricing.html`,
  `<!doctype html><html><body style="font-family: sans-serif; padding: 32px"><h1>Pricing</h1><p>An html document: its view has no title above it.</p></body></html>`,
);
put(`${ROOT}/Projects/Roadmap.md`, `## Now\n\nTitles that are file names.\n\n## Next\n\nThe iPhone.\n`);
put(`${ROOT}/Meetings/2026-11-24 Standup.md`, `- Titles: phase 1 in review\n- Release on Thursday\n`);

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
  async search(root, query, caseSensitive) {
    const norm = (t: string) => (caseSensitive ? t : t.toLowerCase());
    const q = norm(query);
    const out = [];
    for (const [path, f] of files) {
      if (!path.startsWith(`${root}/`) || !isMd(path)) continue;
      const name = baseName(path).replace(/\.md$/, "");
      const matches = f.text
        .split("\n")
        .map((line, i) => ({ line: i + 1, column: norm(line).indexOf(q) + 1, preview: line }))
        .filter((m) => m.column > 0);
      const named = norm(name).includes(q);
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

// Not connected: the cloud answers "none", hears nothing, and refuses the rest.
const cloud = new Proxy({} as Cloud, {
  get: (_, name: string) =>
    name === "status"
      ? async () => []
      : name.startsWith("on")
        ? () => () => {}
        : name === "setActivity"
          ? async () => {}
          : async () => {
              throw new Error(`This page has no cloud: ${name}.`);
            },
});

const backend: Backend = {
  documents,
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
    document.title = title || "Titles";
  },
  device: "computer",
  home: ROOT,
};

declare global {
  interface Window {
    __titles: unknown;
  }
}
window.__titles = {
  files: () => [...files.keys()].sort(),
  doc: (path: string) => files.get(path) ?? null,
  watched: () => watched,
};

// Every load starts again: one tab, the welcome note.
try {
  localStorage.clear();
  localStorage.setItem(
    "doklin:session",
    JSON.stringify({
      version: 2,
      lastRoot: ROOT,
      sessions: { [ROOT]: { tabs: [{ id: "t-welcome", kind: "file", path: `${ROOT}/Welcome.md` }], activeId: "t-welcome" } },
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
