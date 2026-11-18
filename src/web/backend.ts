// The browser's answer to src/backend.ts: the worker, through the picture of
// the workspace this page holds (workspace.ts). No Tauri, and no group for
// what a browser has none of: a copy of the workspace to sync, set up or
// disconnect, the domain's upkeep, people and their devices, windows of its
// own, files on this computer, untitled notes, version history, PDF export,
// an updater. What it has that a Mac has not is a sign-in to end (`session`).
//
// Here a document is stored copies named by a manifest: the note, the html
// rendition beside it and its sidecar are three files of one section. What
// the worker holds is workspace.ts's; what this page has yet to send it, and
// what it changes, is saving.ts's.

import { SEARCH_LIMIT_MAX } from "../../cloud-worker/src/layout";
import type { SearchAnswer, SearchIndexing } from "../../cloud-worker/src/wire";
import type {
  Backend,
  Cloud,
  Documents,
  FileClipboard,
  FileClipboardPayload,
  Leaving,
  SearchResults,
  Session,
  Shows,
} from "../backend";
import type { EveryPage } from "../cloud";
import { linkTo, ownLink, takeLink } from "./address";
import { ask, askJson } from "./http";
import type { Saving } from "./saving";
import type { Workspace } from "./workspace";

/** How often a search is asked again while the worker's mirror of the
 *  workspace catches up, and how long between: it reads some forty
 *  documents a request (`CATCH_UP_READS`, cloud-worker/src/search.ts). */
const SEARCH_TRIES = 6;
const SEARCH_AGAIN_MS = 1200;

/** Every section the person is in, searched by the worker (search.ts): the
 *  first documents that match, each with its first matching lines. What
 *  this page has typed and not yet sent is not in it. */
async function search(ws: Workspace, query: string): Promise<SearchResults> {
  const at = `/api/web/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT_MAX}`;
  for (let tries = 1; ; tries += 1) {
    const res = await ask("GET", at);
    if (res.status !== 202) {
      const found = (await res.json()) as SearchAnswer;
      const needle = query.toLowerCase();
      const files = found.results.flatMap((hit) => {
        const path = ws.pathOfFile(hit.space, hit.fid);
        if (!path) return [];
        return {
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          named: hit.inName === true,
          matches: hit.matches.map((m) => ({
            line: m.line ?? null,
            column: Math.max(0, m.text.toLowerCase().indexOf(needle)),
            preview: m.text,
          })),
        };
      });
      return { files, more: found.total - found.results.length };
    }
    const { pending } = (await res.json()) as SearchIndexing;
    if (tries === SEARCH_TRIES) {
      throw new Error(
        `Search is still reading this workspace: ${pending.toLocaleString()} ${pending === 1 ? "document" : "documents"} to go. Try again in a moment.`,
      );
    }
    await new Promise((done) => setTimeout(done, SEARCH_AGAIN_MS));
  }
}

/** A change to the tree that fails is said under the row it was asked on,
 *  as it is: rejected with the sentence itself, as the Mac's commands are. */
const said =
  <A extends unknown[], T>(change: (...args: A) => Promise<T>) =>
  async (...args: A): Promise<T> => {
    try {
      return await change(...args);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  };

function documentsOf(ws: Workspace, saving: Saving): Documents {
  return {
    open: (path) => saving.open(path),
    read: (path) => saving.read(path),
    meta: (path) => saving.meta(path),
    save: (path, parts, over) => saving.save(path, parts, over),
    exists: async (path) => saving.exists(path),
    // A manifest names documents and nothing else, so every file is the same list.
    tree: async (root) => ws.tree(root),
    create: said((path, kind) => saving.create(path, kind)),
    move: said((from, to, kind) => saving.move(from, to, kind)),
    copy: said((from, to, kind) => saving.copy(from, to, kind)),
    remove: said((path, kind) => saving.remove(path, kind)),
    // A deletion here is a tombstone: there is no Trash to take it back out of.
    removeUndoes: false,
    async watch(docs) {
      ws.watch(docs);
    },
    onChange: (cb) => ws.onChange(cb),
    search: (_root, query) => search(ws, query),
    // The worker searches a lower-cased mirror.
    searchByCase: false,
  };
}

/** What Cut or Copy in the tree parked: this tab's own. */
function fileClipboard(): FileClipboard {
  let clip: FileClipboardPayload | null = null;
  const heard = new Set<(clip: FileClipboardPayload | null) => void>();
  const set = (next: FileClipboardPayload | null) => {
    clip = next;
    for (const cb of heard) cb(clip);
  };
  return {
    get: async () => clip,
    set: async (items, cut) => set({ items, cut }),
    clear: async () => set(null),
    onChange(cb) {
      heard.add(cb);
      return () => void heard.delete(cb);
    },
  };
}

/** The cloud as a browser answers it: the status and what changed, from the
 *  picture this page holds; a page's link, made here; and publishing, which
 *  the worker does and this page then reads back. */
function cloudOf(ws: Workspace, saving: Saving): Cloud {
  /** Where an absolute path is, for publishing it. */
  const placed = (path: string) => {
    const place = ws.place(path);
    if (!place) throw new Error("That isn’t in a part of the workspace a page can be published from.");
    return place;
  };
  return {
    status: async () => [ws.status()],
    onStatus: (cb) => ws.onStatus(cb),
    onApplied: (cb) => ws.onApplied(cb),
    onConflict: (cb) => ws.onConflict(cb),
    onSpaceLeft: (cb) => ws.onSpaceLeft(cb),
    async setActivity(path) {
      ws.setActivity(path);
    },
    async takeOver(_root, path) {
      ws.takeOver(path);
    },
    async link(path) {
      // A document made a moment ago is the workspace's once it has been sent.
      if (!ws.stored(path)) await saving.flush(path);
      const link = linkTo(ws, path);
      if (!link) throw new Error("it isn’t in the workspace yet");
      return link;
    },

    async publish(path, opts = {}) {
      const place = placed(path);
      const made = await askJson<{ slug: string }>("PUT", "/api/web/pages", {
        body: { space: place.space, path: place.path, kind: ws.stored(path) ? "document" : "folder", ...opts },
      });
      await ws.reread([place.space]);
      return made.slug;
    },
    async unpublish(_root, slug) {
      const space = ws.pageSpace(slug);
      await ask("DELETE", `/api/web/pages?slug=${encodeURIComponent(slug)}`);
      await ws.reread([space]);
    },
    async setRoot(_root, slug) {
      await ask("PUT", "/api/web/home", { body: { slug } });
      await ws.reread([""]);
    },
    pages: () => askJson<{ pages: EveryPage[]; truncated: boolean }>("GET", "/api/pages"),
    async pageTakeDown(_root, slug) {
      const space = ws.pageSpace(slug);
      await ask("DELETE", `/api/pages/${encodeURIComponent(slug)}`);
      await ws.reread([space]);
    },
  };
}

export function webBackend(ws: Workspace, saving: Saving): Backend {
  const leaving: Leaving = { onLeave: (flush) => saving.onLeave(flush) };
  const session: Session = {
    async signOut() {
      // What waits is sent first. What cannot be is lost with the sign-in,
      // as the question before this said: the worker's answer clears what
      // this browser kept (auth.ts), drafts included.
      await saving.flush().catch(() => {});
      await ask("DELETE", "/api/auth/session");
      saving.drop();
      location.reload();
    },
  };
  const shows: Shows = {
    take: async () => takeLink(ws),
    onArrive(cb) {
      addEventListener("hashchange", cb);
      return () => removeEventListener("hashchange", cb);
    },
  };
  return {
    documents: documentsOf(ws, saving),
    cloud: cloudOf(ws, saving),
    fileClipboard: fileClipboard(),
    // The addresses the Mac agrees to open, and no others (`open_external`,
    // src-tauri/src/lib.rs): a document shown in a frame may ask for this,
    // and what it asks for is not to be trusted.
    async openExternal(url) {
      if (!/^(https?:\/\/|mailto:)./i.test(url)) throw new Error(`Doklin doesn't open addresses like ${url}.`);
      // A link to a page of this workspace is followed here, as the address
      // it would come back as: the link page would only send it round again.
      const own = ownLink(url);
      if (own !== null) location.hash = own;
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    authorName: async () => ws.status().me,
    setTitle(title) {
      document.title = title;
    },
    device: "browser",
    home: ws.root,
    htmlFrame: "/app/frame",
    session,
    shows,
    leaving,
  };
}
