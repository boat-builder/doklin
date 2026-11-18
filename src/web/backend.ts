// The browser's answer to src/backend.ts: the worker, through the picture of
// the workspace this page holds (workspace.ts). No Tauri, and no group for
// what a browser has none of: windows of its own, files on this computer,
// untitled notes, version history, PDF export, an updater.
//
// Here a document is stored copies named by a manifest: the note, the html
// rendition beside it and its sidecar are three files of one section. What
// the worker holds is workspace.ts's; what this page has yet to send it, and
// what it changes, is saving.ts's.

import type {
  Backend,
  Cloud,
  Documents,
  FileClipboard,
  FileClipboardPayload,
  Leaving,
  Shows,
} from "../backend";
import { takeLink } from "./address";
import type { Saving } from "./saving";
import type { Workspace } from "./workspace";

/** What the app's own business with a domain is answered with. */
const IN_THE_APP = "That is done in the Doklin app, not in a browser.";

const refuse = (sentence: string) => async (): Promise<never> => {
  throw new Error(sentence);
};

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
    async watch(docs) {
      ws.watch(docs);
    },
    onChange: (cb) => ws.onChange(cb),
    search: refuse("Search isn't in the browser version yet."),
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

/** The cloud as a browser answers it: the status, what changed, and which
 *  document this tab is editing, from the picture it holds. Everything else
 *  `Cloud` lists is the app's own business with a domain (setting one up,
 *  people, devices, agents) or is not built here yet, and is refused in a
 *  sentence; an event nothing here raises is listened to and never heard. */
function cloudOf(ws: Workspace): Cloud {
  const answered: Partial<Cloud> = {
    status: async () => [ws.status()],
    onStatus: (cb) => ws.onStatus(cb),
    removed: async () => [],
    onApplied: (cb) => ws.onApplied(cb),
    onConflict: (cb) => ws.onConflict(cb),
    onSpaceLeft: (cb) => ws.onSpaceLeft(cb),
    async setActivity(path) {
      ws.setActivity(path);
    },
    async takeOver(_root, path) {
      ws.takeOver(path);
    },
  };
  return new Proxy(answered as Cloud, {
    get(target, name) {
      if (typeof name !== "string" || name in target) return Reflect.get(target, name);
      return name.startsWith("on") ? () => () => {} : refuse(IN_THE_APP);
    },
  });
}

export function webBackend(ws: Workspace, saving: Saving): Backend {
  const leaving: Leaving = { onLeave: (flush) => saving.onLeave(flush) };
  const shows: Shows = {
    take: async () => takeLink(ws),
    onArrive(cb) {
      addEventListener("hashchange", cb);
      return () => removeEventListener("hashchange", cb);
    },
  };
  return {
    documents: documentsOf(ws, saving),
    cloud: cloudOf(ws),
    fileClipboard: fileClipboard(),
    // The addresses the Mac agrees to open, and no others (`open_external`,
    // src-tauri/src/lib.rs): a document shown in a frame may ask for this,
    // and what it asks for is not to be trusted.
    async openExternal(url) {
      if (!/^(https?:\/\/|mailto:)./i.test(url)) throw new Error(`Doklin doesn't open addresses like ${url}.`);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    authorName: async () => ws.status().me,
    setTitle(title) {
      document.title = title;
    },
    home: ws.root,
    htmlFrame: "/app/frame",
    shows,
    leaving,
  };
}
