// Mounts the REAL App on a second backend: a few documents held in memory,
// with none of the optional groups and no Tauri on the page (seam.html has no
// IPC stub). drive-seam.mjs proves three things by it: the UI needs nothing
// but src/backend.ts, a note and its sidecar go down as one save, and a
// feature whose group is absent has no way in.
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
  type WatchedDocument,
} from "../src/backend";

// A document as something that is not a disk holds it: one record, its parts
// inside. `rev` counts the text's writes.
type Doc = { text: string; rev: number; meta: string | null; html: string | null };

const ROOT = "/docs";
const docs = new Map<string, Doc>([
  [
    `${ROOT}/notes.md`,
    {
      text:
        `# Notes\n\nAn intro paragraph nobody commented on.\n\n` +
        `The {==anchor text==}{>>#m1seam<<} sits here.\n\nA closing paragraph.\n`,
      rev: 1,
      meta:
        `{"doklin":"meta","v":1}\n` +
        `{"t":"mthread","id":"m1seam","comments":[{"author":"Studio","at":1782900000000,"body":"needs a stronger opening"}]}\n`,
      html: `<!doctype html><html><body><main><h1>Notes rendition</h1></main></body></html>`,
    },
  ],
  [`${ROOT}/other.md`, { text: `# Other\n\nNo comments here.\n`, rev: 1, meta: null, html: null }],
]);

const revOf = (doc: Doc) => doc.rev as unknown as Rev;
const renditionOf = (path: string) => path.replace(/\.md$/, ".html");
const ownerOf = (htmlPath: string) => docs.get(htmlPath.replace(/\.html$/, ".md"));
const need = (path: string): Doc => {
  const doc = docs.get(path);
  if (!doc) throw new Error(`There is no document at ${path}.`);
  return doc;
};

// What the drive reads back.
const saves: { path: string; text: boolean; meta: boolean; over: number | null }[] = [];
const removed: string[] = [];
let watched: WatchedDocument[] = [];
const listeners = new Set<(change: DocumentChange) => void>();

const documents: Documents = {
  async open(path) {
    const doc = need(path);
    return { text: doc.text, rev: revOf(doc), meta: doc.meta, rendition: doc.html === null ? null : renditionOf(path) };
  },
  async read(path) {
    const html = path.endsWith(".html") ? ownerOf(path) : undefined;
    if (html && html.html !== null) return { text: html.html, rev: revOf(html) };
    const doc = need(path);
    return { text: doc.text, rev: revOf(doc) };
  },
  meta: async (path) => docs.get(path)?.meta ?? null,
  async save(path, parts, over) {
    saves.push({
      path,
      text: parts.text !== undefined,
      meta: parts.meta !== undefined,
      over: over as unknown as number | null,
    });
    let doc = docs.get(path);
    if (parts.text !== undefined) {
      if (doc && over !== null && (over as unknown as number) !== doc.rev) throw new SaveConflict(revOf(doc));
      if (!doc) docs.set(path, (doc = { text: "", rev: 0, meta: null, html: null }));
      doc.text = parts.text;
      doc.rev += 1;
    }
    if (parts.meta !== undefined) need(path).meta = parts.meta;
    return { rev: parts.text === undefined ? null : revOf(need(path)), meta: true };
  },
  exists: async (path) => path === ROOT || docs.has(path) || (path.endsWith(".html") && ownerOf(path)?.html != null),
  // A folder that doesn't sync: its documents, with no ids.
  documents: async (root) =>
    [...docs.keys()].sort().map((path) => ({ path: path.slice(root.length + 1), fileId: null, section: null })),
  tree: async (root) => ({
    kind: "dir",
    name: "docs",
    path: root,
    children: [...docs].map(([path, doc]) => ({
      kind: "file" as const,
      name: path.slice(ROOT.length + 1),
      path,
      paired: doc.html !== null,
    })),
  }),
  async create(path, kind) {
    if (kind === "file") docs.set(path, { text: "", rev: 1, meta: null, html: null });
  },
  async move(from, to) {
    docs.set(to, need(from));
    docs.delete(from);
    return [];
  },
  async copy(from, to) {
    docs.set(to, { ...need(from), rev: 1 });
    return [];
  },
  // Nothing here takes a delete back, so the app asks first.
  removeUndoes: false,
  async remove(path) {
    need(path);
    docs.delete(path);
    removed.push(path);
    return { left: [], undo: null };
  },
  async watch(set) {
    watched = set;
  },
  onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  search: async () => ({ files: [], more: 0 }),
  searchByCase: true,
};

let clip: FileClipboardPayload | null = null;
const clipListeners = new Set<(clip: FileClipboardPayload | null) => void>();
const setClip = (next: FileClipboardPayload | null) => {
  clip = next;
  for (const cb of clipListeners) cb(clip);
};

// No workspace here is connected: the cloud answers "none", hears nothing,
// and refuses whatever else it is asked.
const cloud = new Proxy({} as Cloud, {
  get: (_, name: string) =>
    name === "status"
      ? async () => []
      : name.startsWith("on")
        ? () => () => {}
        : name === "setActivity"
          ? async () => {}
          : async () => {
              throw new Error(`The seam harness has no cloud: ${name}.`);
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
  openExternal: async () => {},
  authorName: async () => "Seam Tester",
  setTitle(title) {
    document.title = title;
  },
  device: "harness",
};

declare global {
  interface Window {
    __seam: unknown;
  }
}
window.__seam = {
  saves,
  removed,
  watched: () => watched,
  doc: (path: string) => docs.get(path) ?? null,
  /** Somebody else wrote `text`; with `quiet`, without the backend saying so. */
  outside(path: string, text: string, quiet = false) {
    const doc = need(path);
    doc.text = text;
    doc.rev += 1;
    if (!quiet) for (const cb of listeners) cb({ path, part: "text" });
  },
};

// A restorable /docs session, seeded once per browser context.
if (!localStorage.getItem("doklin:seam-harness-seeded")) {
  localStorage.clear();
  localStorage.setItem("doklin:seam-harness-seeded", "1");
  localStorage.setItem(
    "doklin:session",
    JSON.stringify({
      version: 2,
      lastRoot: ROOT,
      sessions: {
        [ROOT]: {
          tabs: [
            { id: "t-notes", kind: "file", path: `${ROOT}/notes.md` },
            { id: "t-other", kind: "file", path: `${ROOT}/other.md` },
          ],
          activeId: "t-notes",
        },
      },
    }),
  );
}

installBackend(backend);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
