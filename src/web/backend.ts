// The browser's answer to src/backend.ts: the worker, through the picture of
// the workspace this page holds (workspace.ts). No Tauri, and no group for
// what a browser has none of: a copy of the workspace to sync, set up or
// disconnect, the domain's upkeep, windows of its own, files on this
// computer, untitled notes, version history, PDF export, an updater. What
// it has that a Mac has not is a sign-in to end (`session`).
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
  CloudAccess,
  CloudShares,
  Documents,
  FileClipboard,
  FileClipboardPayload,
  Leaving,
  SearchResults,
  Session,
  Shows,
} from "../backend";
import type {
  AgentScope,
  CloudAgent,
  CloudDevice,
  CloudInvite,
  CloudMember,
  CloudRole,
  EveryPage,
} from "../cloud";
import { followLink, linkTo, ownLink, takeLink } from "./address";
import { browserHistory } from "./steps";
import { mintAgentLogin, mintDeviceCode, mintInvite } from "./codes";
import { Refused, ask, askJson, deviceId } from "./http";
import type { TagFilter } from "../tags";
import type { Saving } from "./saving";
import type { Workspace } from "./workspace";

/** How often a search is asked again while the worker's mirror of the
 *  workspace catches up, and how long between: it reads some forty
 *  documents a request (`CATCH_UP_READS`, cloud-worker/src/search.ts). */
const SEARCH_TRIES = 6;
const SEARCH_AGAIN_MS = 1200;

/** How many requests one search makes for a workspace of more sections than
 *  a request opens (`next`, cloud-worker/src/webDocs.ts): what is shared is a
 *  section each. Past it, the answer says there is more. */
const SEARCH_PAGES = 6;

/** One request's worth of a search: the sections from `after` on. Asked
 *  again while the worker's mirror catches up. */
async function searched(at: string): Promise<SearchAnswer> {
  for (let tries = 1; ; tries += 1) {
    const res = await ask("GET", at);
    if (res.status !== 202) return (await res.json()) as SearchAnswer;
    const { pending } = (await res.json()) as SearchIndexing;
    if (tries === SEARCH_TRIES) {
      throw new Error(
        `Search is still reading this workspace: ${pending.toLocaleString()} ${pending === 1 ? "document" : "documents"} to go. Try again in a moment.`,
      );
    }
    await new Promise((done) => setTimeout(done, SEARCH_AGAIN_MS));
  }
}

/** Every section the person can open, searched by the worker (search.ts):
 *  the first documents that match, each with its first matching lines. What
 *  this page has typed and not yet sent is not in it. */
async function search(ws: Workspace, query: string, tags: TagFilter[]): Promise<SearchResults> {
  // A tag token rides as `tag=name:value`, or `tag=name` for a note that has
  // the tag at all: a name never holds a colon (src/tags.ts).
  const tagged = tags
    .map((t) => `&tag=${encodeURIComponent(t.value === null ? t.name : `${t.name}:${t.value}`)}`)
    .join("");
  const at = `/api/web/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT_MAX}${tagged}`;
  const needle = query.toLowerCase();
  const files: SearchResults["files"] = [];
  let more = 0;
  let after: number | undefined = 0;
  for (let page = 0; after !== undefined && page < SEARCH_PAGES && files.length < SEARCH_LIMIT_MAX; page += 1) {
    const found: SearchAnswer = await searched(after === 0 ? at : `${at}&after=${after}`);
    for (const hit of found.results) {
      const path = ws.pathOfFile(hit.space, hit.fid);
      if (!path) continue;
      files.push({
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        named: hit.inName === true,
        matches: hit.matches.map((m) => ({
          line: m.line ?? null,
          column: Math.max(0, m.text.toLowerCase().indexOf(needle)),
          preview: m.text,
        })),
      });
    }
    more += found.total - found.results.length;
    after = found.next;
  }
  return { files, more };
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
    documents: async () => ws.documents(),
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
    search: (_root, query, _caseSensitive, tags) => search(ws, query, tags),
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
    onSpaceMoved: (cb) => ws.onSpaceMoved(cb),
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
    async follow(url) {
      return followLink(ws, url);
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
    // The list is the shared workspace's manifest's: read again once changed.
    async setTag(_root, at, def) {
      await ask("PUT", "/api/web/tags", { body: { at, tag: def } });
      await ws.reread([""]);
    },
    async removeTag(_root, name) {
      await ask("DELETE", `/api/web/tags?name=${encodeURIComponent(name)}`);
      await ws.reread([""]);
    },
  };
}

/** What an agent may do, as the worker spells and orders it; `read` is always held. */
const SCOPES: readonly AgentScope[] = ["read", "comment", "edit", "publish"];
const cleanScopes = (scopes: AgentScope[]): AgentScope[] => SCOPES.filter((s) => s === "read" || scopes.includes(s));

/** People, their devices and agents: each is one of the routes a Mac's
 *  engine calls (`cloud_people` and the rest, engine/src/cloud/mod.rs), asked
 *  from here, and the worker decides by the person's role as it does for a
 *  Mac. A code is made on this page (codes.ts) and only its sha256 sent. */
function accessOf(ws: Workspace): CloudAccess {
  const here = location.origin;
  /** The row a call named is gone: somebody removed it first. */
  const missing = (e: unknown) => e instanceof Refused && e.status === 404;
  /** A call that names a row which has to be there. */
  const onRow = async <T>(what: string, asked: Promise<T>): Promise<T> => {
    try {
      return await asked;
    } catch (e) {
      if (missing(e)) throw new Error(`That ${what} isn’t on ${location.host} any more. Somebody may have removed it already.`);
      throw e;
    }
  };
  /** A removal: the row being gone already is what was asked for. */
  const removed = async (path: string): Promise<void> => {
    try {
      await ask("DELETE", path);
    } catch (e) {
      if (!missing(e)) throw e;
    }
  };
  const row = encodeURIComponent;

  return {
    async people() {
      // Asked each time the view opens, never remembered: a role is the
      // person's, and an owner can change it. Each list is asked for only
      // when the role is answered it, so a member's view costs no refusals.
      const { you } = await ws.probe();
      const may = (action: string) => (you.can as string[]).includes(action);
      const [members, invites, devices] = await Promise.all([
        may("people.see") ? askJson<{ members: CloudMember[] }>("GET", "/api/auth/members").then((a) => a.members) : [],
        may("people.invite") ? askJson<{ invites: CloudInvite[] }>("GET", "/api/auth/invites").then((a) => a.invites) : [],
        may("devices.own") ? askJson<{ devices: CloudDevice[] }>("GET", "/api/auth/devices").then((a) => a.devices) : [],
      ]);
      return {
        // A browser's sign-in is a person's: an agent's token is answered on
        // the document API alone.
        role: you.role as CloudRole,
        me: you.memberId,
        can: you.can,
        deviceId: deviceId(),
        tokenId: you.tokenId,
        members,
        invites,
        devices,
      };
    },
    async invite(_root, email, name, days) {
      const made = await mintInvite(here, days);
      const named = name?.trim();
      const { invite } = await askJson<{ invite: CloudInvite }>("POST", "/api/auth/invites", {
        body: { email: email.trim(), ...(named ? { name: named } : {}), codeHash: made.hash, expiresAt: made.expiresAt },
      });
      return { code: made.code, blob: made.line, invite };
    },
    withdrawInvite: (_root, inviteId) => removed(`/api/auth/invites/${row(inviteId)}`),
    async setRole(_root, memberId, role) {
      const { member } = await onRow(
        "person",
        askJson<{ member: CloudMember }>("PATCH", `/api/auth/members/${row(memberId)}`, { body: { role } }),
      );
      return member;
    },
    revokePerson: (_root, memberId) => removed(`/api/auth/members/${row(memberId)}`),
    async deviceCode() {
      const made = await mintDeviceCode(here);
      await ask("POST", "/api/auth/devices/code", { body: { codeHash: made.hash, expiresAt: made.expiresAt } });
      return { code: made.code, blob: made.line, expiresAt: made.expiresAt };
    },
    revokeDevice: (_root, tokenId) => removed(`/api/auth/devices/${row(tokenId)}`),

    async agents() {
      return (await askJson<{ agents: CloudAgent[] }>("GET", "/api/auth/agents")).agents;
    },
    async agentAdd(_root, name, scopes) {
      const called = name.trim();
      if (!called) throw new Error("Give the agent a name. It is what its comments and changes are signed with.");
      const made = await mintAgentLogin(here);
      const { agent } = await askJson<{ agent: CloudAgent }>("POST", "/api/auth/agents", {
        body: { name: called, scopes: cleanScopes(scopes), codeHash: made.hash, expiresAt: made.expiresAt },
      });
      // It has a name from now on, for whatever it changes.
      await ws.probe();
      return { agent, login: { line: made.line, code: made.code, expiresAt: made.expiresAt } };
    },
    async agentCode(_root, agentId) {
      const made = await mintAgentLogin(here);
      await onRow(
        "agent",
        ask("POST", `/api/auth/agents/${row(agentId)}/code`, { body: { codeHash: made.hash, expiresAt: made.expiresAt } }),
      );
      return { line: made.line, code: made.code, expiresAt: made.expiresAt };
    },
    async agentUpdate(_root, agentId, name, scopes) {
      const called = name?.trim();
      await onRow(
        "agent",
        ask("POST", `/api/auth/agents/${row(agentId)}`, {
          body: { ...(called ? { name: called } : {}), ...(scopes ? { scopes: cleanScopes(scopes) } : {}) },
        }),
      );
      await ws.probe();
    },
    agentRemove: (_root, agentId) => removed(`/api/auth/agents/${row(agentId)}`),
    agentRevokeMachine: (_root, agentId, tokenId) => removed(`/api/auth/agents/${row(agentId)}/tokens/${row(tokenId)}`),
  };
}

/** Sharing: each is the route a Mac's engine calls (`create_space` and the
 *  rest, engine/src/cloud/remote.rs), and the worker answers the people who
 *  can open the share and nobody else. What a Mac does by syncing, this page
 *  asks for: the files of what is shared are carried into the share
 *  (saving.ts), and something left or deleted goes from the picture held
 *  here at once (workspace.ts). */
function sharesOf(ws: Workspace, saving: Saving): CloudShares {
  // What was typed in it goes first, while there is still somewhere to send it.
  const flushed = async (id: string) => {
    const item = ws.itemAt(id);
    if (item !== null) await saving.flush(item);
  };
  return {
    share: (_root, path, members) => saving.share(path, members),
    async shareMember(_root, id, memberId, add) {
      if (!add && memberId === ws.me) await flushed(id);
      await ws.shareMember(id, memberId, add);
    },
    async shareDelete(_root, id) {
      await flushed(id);
      await ws.deleteShare(id);
    },
    shareRestore: (_root, id) => ws.restoreShare(id),
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
    access: accessOf(ws),
    shares: sharesOf(ws, saving),
    session,
    shows,
    leaving,
    browserHistory: browserHistory(),
  };
}
