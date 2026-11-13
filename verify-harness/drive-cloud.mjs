// Drives the REAL App's cloud surfaces in Chromium (cloud.html boots <App/>
// over an IPC stub whose cloud_* commands answer from a scripted fake of
// the engine): the not-connected state, the setup wizard's three outcomes
// (a fresh domain, a domain that already holds a workspace, a folder that
// carries that workspace's marker), the panel's phases, sync now / pause,
// the held mass-deletion (toast → panel → confirm), a conflict copy's toast,
// `cloud-applied` refreshing the tree, presence chips, a document another
// Mac holds opening view-only under its banner and Take over, the worker update
// card and its badge, the version rail reading a cloud-only revision
// through the manifest and restoring it, "Connect
// another Mac", disconnect, the wipe → teardown prompt, the join flow
// opening the downloaded folder, the invite door: one paste filling both
// boxes, a refused code spending nothing, a download on the member's own
// credential, the People view: adopting an identity, inviting somebody, the
// code shown once, and the three ways access goes away, and under the people
// its Agents section: adding an agent with publishing off until it is ticked,
// the two lines to hand over shown once, a new login code, changing what it
// may do, logging one machine out, removing it, and a worker too old for
// agents saying so without taking the people down — and publishing:
// the Live chip's not-connected
// door, publishing a note at a random then a chosen address, the chip's five
// states and the tab's live glyph, the sidebar's live dots, the folder
// dialog, the published list (home page, stop), and the sidebar's undoable
// stop — and the sidebar footer's sync line, the title row's facepile and
// the faces on a row somebody is editing.
import { chromium } from "playwright";

import { existsSync, mkdirSync, readFileSync } from "node:fs";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 60) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error("poll timeout: " + last);
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// The worker's compatibility date, from its one source — the wizard's
// prompt must carry exactly this (through vite's virtual module).
const versionTs = readFileSync(new URL("../cloud-worker/src/version.ts", import.meta.url), "utf8");
const COMPAT_DATE = versionTs.match(/^export const COMPATIBILITY_DATE = "([^"]+)";$/m)[1];
const WORKER_VERSION = Number(versionTs.match(/^export const WORKER_VERSION = (\d+);$/m)[1]);
const TOKEN = "ab".repeat(32);

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/cloud.html");
// The fake engine's worker answers with the version this app was built for.
await page.evaluate((v) => {
  window.__cloud.workerVersion = v;
}, WORKER_VERSION);

// The invite the stub is scripted with, plus the line an owner would send.
const INVITE = {
  endpoint: "https://notes.example.com",
  code: "dkln-K7QM2-9XVR4-8TBHN-3WGYD",
  token: "cd".repeat(32),
  member: { memberId: "m-1a2b3c4d", email: "bob@example.com", name: "Bob" },
  error: null,
};
INVITE.blob = `doklin-invite ${INVITE.endpoint} ${INVITE.code}`;

/** A real paste into a field: React's onPaste is what fills both boxes, so
 *  typing the text in would test nothing. */
const paste = (testid, text) =>
  page.evaluate(
    ([id, t]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      el.focus();
      const data = new DataTransfer();
      data.setData("text", t);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [testid, text],
  );

const calls = (cmd) => page.evaluate((c) => window.__cloud.calls.filter((x) => x.cmd === c), cmd);
const lastCall = async (cmd) => (await calls(cmd)).at(-1) ?? null;
const emit = (event, payload) => page.evaluate(([e, p]) => window.__emit(e, p), [event, payload]);
const setStatuses = (statuses) => page.evaluate((s) => window.__setStatuses(s), statuses);
const setCloud = (patch) => page.evaluate((p) => Object.assign(window.__cloud, p), patch);
const versionCalls = (cmd) =>
  page.evaluate((c) => window.__versions.calls.filter((x) => x.cmd === c), cmd);
const lastVersionCall = async (cmd) => (await versionCalls(cmd)).at(-1) ?? null;
const dialog = (label) => page.locator(`[role="dialog"][aria-label="${label}"]`);
const tid = (id) => page.locator(`[data-testid="${id}"]`);
const status = (over = {}) => ({
  root: "/docs",
  domain: "notes.example.com",
  endpoint: "https://notes.example.com",
  wsId: "w-new",
  name: "docs",
  phase: "idle",
  lastSyncMs: Date.now(),
  error: null,
  pendingDeletes: 0,
  me: "Sherin",
  workerVersion: WORKER_VERSION,
  versions: null,
  public: [],
  presence: [],
  leases: [],
  ...over,
});
const openPanelFromGear = async () => {
  await page.locator(".settings-fab").click();
  await tid("settings-cloud").click();
  await poll(async () => (await dialog("Cloud").count()) === 1);
};

/* 1 — boot: a plain workspace, no dot, the gear's Cloud… item without a badge */
await poll(async () => (await page.locator(".milkdown .ProseMirror").count()) === 1);
await poll(async () => (await page.locator('[data-tree-path="/docs/other.md"]').count()) === 1);
/* 1b — the chip on a note of an unconnected workspace: Publish, and the door to the wizard */
await poll(async () => (await tid("live-chip").count()) === 1);
const pillBefore = await tid("live-chip").textContent();
await tid("live-chip").click();
await poll(async () => (await tid("publish-pop").count()) === 1);
step(
  "chip (not connected): reads Publish, its popover explains and offers Create a workspace…",
  pillBefore === "Publish" &&
    (await tid("live-chip").getAttribute("data-state")) === "publish" &&
    (await tid("publish-connect").textContent()).trim() === "Create a workspace…" &&
    (await tid("publish-pop").textContent()).includes("connected to a domain"),
  pillBefore,
);
await page.keyboard.press("Escape");
await poll(async () => (await tid("publish-pop").count()) === 0);
await page.locator(".settings-fab").click();
await poll(async () => (await tid("settings-cloud").count()) === 1);
step(
  "boots: /docs listed, no sync line in the footer, Cloud… in the gear menu without a badge",
  (await tid("sync-status").count()) === 0 &&
    (await tid("settings-cloud").locator(".settings-option-dot").count()) === 0 &&
    (await page.locator(".settings-fab-badge").count()) === 0,
);

/* 2 — the panel, not connected: three doors, worded as what they do to a
   workspace — join one, create one, open one of your own on another Mac */
await tid("settings-cloud").click();
await poll(async () => (await dialog("Cloud").count()) === 1);
const doorNames = (await page.locator(".cloud-doors button").allTextContents()).map((t) => t.trim());
step(
  "panel (not connected): Join a workspace…, Create a workspace… (enabled: a folder is open), Open a workspace from a domain…",
  doorNames.join("|") === "Join a workspace…|Create a workspace…|Open a workspace from a domain…" &&
    (await tid("connect-domain").isEnabled()) &&
    (await tid("open-from-domain").count()) === 1,
  doorNames.join(" · "),
);
await page.screenshot({ path: SHOTS + "cloud-01-not-connected.png" });

/* 3 — the wizard: name prefilled, the domain typed, the prompt built from it */
await tid("connect-domain").click();
await poll(async () => (await dialog("Create a workspace").count()) === 1);
const nameValue = await tid("name-input").inputValue();
await tid("domain-input").fill("Notes.Example.com");
await poll(async () => (await tid("setup-prompt").count()) === 1);
const setupPrompt = await tid("setup-prompt").textContent();
step(
  "wizard: name prefilled from the folder, the prompt carries the token, the derived names, the route and the runtime date",
  nameValue === "docs" &&
    setupPrompt.includes(TOKEN) &&
    setupPrompt.includes('name = "doklin-notes-example-com"') &&
    setupPrompt.includes('bucket_name = "doklin-notes-example-com"') &&
    setupPrompt.includes('routes = [{ pattern = "notes.example.com", custom_domain = true }]') &&
    setupPrompt.includes(`compatibility_date = "${COMPAT_DATE}"`) &&
    setupPrompt.includes(`"version" is at least ${WORKER_VERSION}`) &&
    setupPrompt.includes("ENDPOINT: https://notes.example.com"),
  `name=${nameValue}`,
);

/* 4 — a workers.dev name changes the prompt's routing; back to the domain */
await page.locator(".cloud-choice", { hasText: "workers.dev" }).click();
await tid("workers-name-input").fill("doklin-Sherin-Notes");
await poll(async () => (await tid("setup-prompt").textContent()).includes("workers_dev = true"));
const devPrompt = await tid("setup-prompt").textContent();
step(
  "workers.dev choice: the prefix is implied, no route, the endpoint is what wrangler prints",
  devPrompt.includes('name = "doklin-sherin-notes"') &&
    !devPrompt.includes("routes =") &&
    devPrompt.includes("ENDPOINT: <the workers.dev URL wrangler printed>") &&
    (await tid("endpoint-input").inputValue()) === "",
);
await page.locator(".cloud-choice", { hasText: "A domain of my own" }).click();
await poll(async () => (await tid("endpoint-input").inputValue()) === "https://notes.example.com");

/* 5 — probe: an unreachable domain shows the engine's words */
await setCloud({ probe: "couldn't reach notes.example.com: connection refused" });
await tid("probe-button").click();
await poll(async () => (await tid("setup-error").count()) === 1);
step(
  "probe failure shows the engine's message",
  (await tid("setup-error").textContent()).includes("couldn't reach notes.example.com"),
);

/* 6 — probe: a fresh domain → Connect & upload */
await setCloud({
  probe: { workerVersion: WORKER_VERSION, bundledVersion: WORKER_VERSION, features: ["sync", "wipe"], workspace: null },
});
await tid("probe-button").click();
await poll(async () => (await tid("probe-outcome").count()) === 1);
step(
  "fresh domain: 'holds nothing yet', Connect & upload offered, no Download / Resume",
  (await tid("probe-outcome").textContent()).includes("holds nothing yet") &&
    (await tid("connect-upload").count()) === 1 &&
    (await tid("download-here").count()) === 0 &&
    (await tid("resume-folder").count()) === 0 &&
    (await lastCall("cloud_probe")).args.endpoint === "https://notes.example.com" &&
    (await lastCall("cloud_probe")).args.token === TOKEN,
);
await page.screenshot({ path: SHOTS + "cloud-02-wizard-fresh.png" });

/* 7 — connect & upload: progress, then the done card; the engine got root + endpoint + token + name */
await tid("connect-upload").click();
const sawProgress = await poll(
  async () => {
    const t = await page.locator(".cloud-progress-text").textContent().catch(() => "");
    return t && t.includes("Uploading") && t.includes("of 3") ? t : null;
  },
  4000,
  20,
).catch(() => null);
await poll(async () => (await tid("setup-done").count()) === 1);
const connectCall = await lastCall("cloud_connect");
step(
  "Connect & upload: progress shown, done card, cloud_connect(root, endpoint, token, name)",
  !!sawProgress &&
    connectCall.args.root === "/docs" &&
    connectCall.args.endpoint === "https://notes.example.com" &&
    connectCall.args.token === TOKEN &&
    connectCall.args.name === "docs",
  sawProgress ?? "no progress text seen",
);
await page.locator(".modal-btn", { hasText: "Done" }).click();
await poll(async () => (await dialog("Create a workspace").count()) === 0);

/* 8 — the footer says Synced, in green, and its tooltip names the domain */
await poll(async () => (await tid("sync-status").count()) === 1);
step(
  "footer: the sync line reads Synced (green), its tooltip names the domain",
  (await tid("sync-status").getAttribute("data-phase")) === "idle" &&
    (await tid("sync-status").textContent()) === "Synced" &&
    (await tid("sync-status").getAttribute("class")).includes("is-live") &&
    (await tid("sync-status").getAttribute("title")).includes("notes.example.com"),
);

/* 9 — the panel, connected: phase line, sync now, pause / resume */
await tid("sync-status").click();
await poll(async () => (await dialog("Cloud").count()) === 1);
const phaseText = await tid("phase-text").textContent();
await tid("sync-now").click();
await poll(async () => (await calls("cloud_sync_now")).length === 1);
await tid("pause-toggle").click();
await poll(async () => (await tid("phase-text").textContent()) === "Paused");
const pausedOk =
  (await tid("pause-toggle").textContent()) === "Resume" && (await tid("sync-now").isDisabled());
await tid("pause-toggle").click();
await poll(async () => (await tid("phase-text").textContent()).startsWith("Synced"));
step(
  "panel (connected): 'Synced just now', Sync now calls the engine, Pause → 'Paused' + Resume, Resume → synced",
  phaseText === "Synced just now" &&
    pausedOk &&
    (await tid("presence-empty").count()) === 1 &&
    (await page.locator(".cloud-head-domain").textContent()) === "notes.example.com",
  phaseText,
);
await page.screenshot({ path: SHOTS + "cloud-03-panel-connected.png" });
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);

/* 9a — publish the open note at a random address */
await tid("live-chip").click();
await poll(async () => (await tid("publish-go").count()) === 1);
await tid("publish-go").click();
await poll(async () => (await calls("cloud_publish")).length === 1);
await poll(async () => (await tid("live-chip").getAttribute("data-state")) === "live");
const firstPublish = await lastCall("cloud_publish");
const publishedUrl = await tid("publish-url").textContent();
step(
  "chip: Publish sends the note's path with no slug; the chip reads Live, the link is a random address, the sidebar row gets a dot",
  firstPublish.args.path === "/docs/notes.md" &&
    firstPublish.args.slug === null &&
    /^notes\.example\.com\/[a-z0-9]{8}$/.test(publishedUrl) &&
    (await tid("publish-by").textContent()).includes("by you") &&
    (await page.locator('[data-tree-path="/docs/notes.md"] [data-testid="tree-published"]').count()) === 1,
  publishedUrl,
);
await page.screenshot({ path: SHOTS + "cloud-09-published.png" });

/* 9b — a chosen address, and Copy */
await tid("publish-change").click();
await tid("publish-slug").fill("team-notes");
await tid("publish-rename").click();
await poll(async () => (await lastCall("cloud_publish")).args.slug === "team-notes");
await poll(async () => (await tid("publish-url").textContent()) === "notes.example.com/team-notes");
await tid("publish-copy").click();
await poll(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "https://notes.example.com/team-notes");

// Attribution is by person since manifest v3: the same page, published by
// somebody else, names them — and one published from another Mac of your own
// reads as yours, because `me` is a person rather than a Mac.
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  window.__setStatuses([{ ...s, public: s.public.map((p) => ({ ...p, by: "Bob" })) }]);
});
await poll(async () => (await tid("publish-by").textContent()).includes("Published by Bob"));
const byOther = await tid("publish-by").textContent();
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  window.__setStatuses([{ ...s, public: s.public.map((p) => ({ ...p, by: window.__cloud.me })) }]);
});
await poll(async () => (await tid("publish-by").textContent()).includes("by you"));

// A rename that landed folds the address away; Change address opens it again.
const foldedAfterRename = (await tid("publish-slug").count()) === 0;
await tid("publish-change").click();
await tid("publish-slug").fill("AB");
await poll(async () => (await tid("publish-pop").locator(".modal-error").count()) === 1);
step(
  "chip: Change address re-publishes under the chosen slug and folds away, Copy puts the link on the clipboard, a bad slug is refused before the engine sees it; a page names the person who published it",
  (await tid("publish-rename").isDisabled()) &&
    foldedAfterRename &&
    (await calls("cloud_publish")).length === 2 &&
    byOther.includes("Published by Bob") &&
    !byOther.includes("by you"),
);
await page.keyboard.press("Escape");
await poll(async () => (await tid("publish-pop").count()) === 0);

/* 9b2 — the chip's five states, in words: Live with its address (and the
   tab's glyph), Not updating while sync is stopped short of the page, Page
   offline when the page itself is down, and Updating while an edit made here
   is on its way — which lasts past the save, until a sync completes after it */
const currentStatus = () => page.evaluate(() => window.__cloud.statuses[0]);
const patchStatus = async (over) => setStatuses([{ ...(await currentStatus()), ...over }]);
const chipState = () => tid("live-chip").getAttribute("data-state");
const chipText = () => tid("live-chip").textContent();
const reasonOf = async () => {
  await tid("live-chip").click();
  await poll(async () => (await tid("publish-pop").count()) === 1);
  const reason = (await tid("publish-state").count()) === 1 ? await tid("publish-state").textContent() : "";
  const heading = await tid("publish-pop").locator(".live-pop-head").textContent();
  await page.keyboard.press("Escape");
  await poll(async () => (await tid("publish-pop").count()) === 0);
  return { reason, heading };
};
const liveText = await chipText();
const liveTitle = await tid("live-chip").getAttribute("title");
const liveHead = await reasonOf();
const tabGlyph = await page.locator('.tab.is-active [data-testid="tab-live"]').count();
await patchStatus({ phase: "paused" });
await poll(async () => (await chipState()) === "stale");
const staleText = await chipText();
const stale = await reasonOf();
await patchStatus({ phase: "revoked" });
await poll(async () => (await chipState()) === "offline");
const revokedText = await chipText();
const livePublic = (await currentStatus()).public;
await patchStatus({ phase: "idle", public: livePublic.map((p) => ({ ...p, alive: false })) });
await poll(async () => (await chipState()) === "offline");
const gone = await reasonOf();
await patchStatus({ public: livePublic });
await poll(async () => (await chipState()) === "live");
await page.locator(".milkdown .ProseMirror").first().click();
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type(" Edited here.");
await poll(async () => (await chipState()) === "updating");
const updatingText = await chipText();
await poll(async () => (await page.locator(".tab.is-active .tab-close.is-dirty").count()) === 0);
const updating = await reasonOf();
const updatingAfterSave = (await chipState()) === "updating";
await patchStatus({ lastSyncMs: Date.now() });
await poll(async () => (await chipState()) === "live");
step(
  "chip states: Live /team-notes (the address its tooltip, the tab's glyph); paused → Not updating and why; revoked, or a page whose note isn't synced → Page offline; an edit → Updating, past the save, until a sync completes after it",
  liveText === "Live/team-notes" &&
    liveTitle === "https://notes.example.com/team-notes" &&
    liveHead.heading.includes("“notes” is live") &&
    liveHead.reason === "" &&
    tabGlyph === 1 &&
    staleText === "Not updating" &&
    stale.reason.includes("paused") &&
    stale.heading.includes("isn’t updating") &&
    revokedText === "Page offline" &&
    gone.reason.includes("Not found") &&
    updatingText === "Updating" &&
    updating.reason === "Your latest changes appear once synced." &&
    updatingAfterSave,
  `${liveText} · ${staleText} · ${revokedText} · ${updatingText}`,
);
await page.screenshot({ path: SHOTS + "cloud-09b-chip.png" });

/* 9c — the folder dialog from the sidebar */
await page.locator('[data-tree-path="/docs/Projects"]').click({ button: "right" });
await poll(async () => (await page.locator(".sidebar-menu-item", { hasText: "Publish folder…" }).count()) === 1);
await page.locator(".sidebar-menu-item", { hasText: "Publish folder…" }).click();
await poll(async () => (await dialog("Publish folder").count()) === 1);
const suggested = await tid("folder-slug").inputValue();
const folderCount = await tid("folder-count").textContent();
await tid("folder-title").fill("Projects");
await tid("folder-desc").fill("What we're building");
await tid("folder-publish").click();
await poll(async () => (await dialog("Publish folder").count()) === 0);
const folderCall = await lastCall("cloud_publish");
await poll(async () => (await page.locator('[data-tree-path="/docs/Projects"] [data-testid="tree-published"]').count()) === 1);
step(
  "folder dialog: a slug suggested from the folder's name, the note count, title and description; Publish sends the folder's path; the folder row gets a dot",
  suggested === "projects" &&
    folderCount.includes("1 note") &&
    folderCall.args.path === "/docs/Projects" &&
    folderCall.args.slug === "projects" &&
    folderCall.args.title === "Projects" &&
    folderCall.args.desc === "What we're building",
  `${suggested} · ${folderCount}`,
);

/* 9d — a note inside the published folder: the pill knows its nested address */
await page.locator('[data-tree-path="/docs/Projects/plan.md"]').click();
await poll(async () => (await page.locator(".ProseMirror h1").first().textContent())?.includes("Plan"));
await poll(async () => (await tid("live-chip").getAttribute("data-state")) === "publish");
await tid("live-chip").click();
await poll(async () => (await tid("publish-nested").count()) === 1);
step(
  "chip (inside a published folder): not published on its own, but 'Already public inside Projects' at the nested address",
  (await tid("publish-nested").textContent()).includes("notes.example.com/projects/plan"),
);
await page.keyboard.press("Escape");
await poll(async () => (await tid("publish-pop").count()) === 0);
await page.screenshot({ path: SHOTS + "cloud-10-folder-published.png" });

/* 9e — the published list: folders first, home page, stop */
await tid("sync-status").click();
await poll(async () => (await tid("published-pages").count()) === 1);
const doorText = await tid("published-pages").textContent();
await tid("published-pages").click();
await poll(async () => (await dialog("Published pages").count()) === 1);
await poll(async () => (await tid("published-row").count()) === 2);
const rowSlugs = await page.locator('[data-testid="published-row"]').evaluateAll((els) => els.map((e) => e.dataset.slug));
const notesRow = page.locator('[data-testid="published-row"][data-slug="team-notes"]');
await notesRow.locator('[data-testid="published-home"]').click();
await poll(async () => (await lastCall("cloud_set_root")).args.slug === "team-notes");
await poll(async () => (await notesRow.locator(".published-badge", { hasText: "Home page" }).count()) === 1);
const projectsRow = page.locator('[data-testid="published-row"][data-slug="projects"]');
await projectsRow.locator('[data-testid="published-stop"]').click();
await projectsRow.locator('[data-testid="published-stop-yes"]').click();
await poll(async () => (await lastCall("cloud_unpublish")).args.slug === "projects");
await poll(async () => (await tid("published-row").count()) === 1);
step(
  "published list: the panel's door counts 2, folders sort first, Use as home page sets the root, Stop asks then removes the folder",
  doorText === "Published pages (2)…" && rowSlugs.join(",") === "projects,team-notes",
  `${doorText} · ${rowSlugs.join(",")}`,
);
await page.screenshot({ path: SHOTS + "cloud-11-published-list.png" });
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Published pages").count()) === 0);

/* 9f — the sidebar's Stop publishing is immediate and undoable */
await page.locator('[data-tree-path="/docs/notes.md"]').click({ button: "right" });
await poll(async () => (await page.locator(".sidebar-menu-item", { hasText: "Stop publishing" }).count()) === 1);
await page.locator(".sidebar-menu-item", { hasText: "Stop publishing" }).click();
await poll(async () => (await lastCall("cloud_unpublish")).args.slug === "team-notes");
await poll(async () => (await page.locator(".toast").count()) === 1);
const stopToast = await page.locator(".toast").textContent();
await page.locator(".toast-btn", { hasText: "Undo" }).click();
await poll(async () => (await lastCall("cloud_publish")).args.slug === "team-notes");
await poll(async () => (await page.locator('[data-tree-path="/docs/notes.md"] [data-testid="tree-published"]').count()) === 1);
step(
  "sidebar: Stop publishing stops at once and the toast's Undo brings the page back under the same slug",
  stopToast.includes("Stopped publishing notes.md") &&
    (await page.locator('[data-tree-path="/docs/Projects"] [data-testid="tree-published"]').count()) === 0,
  stopToast,
);
await page.locator('[data-tree-path="/docs/notes.md"]').click();
await poll(async () => (await page.locator(".ProseMirror h1").first().textContent())?.includes("Notes"));
await tid("sync-status").click();
await poll(async () => (await dialog("Cloud").count()) === 1);

/* 10 — every phase reaches the panel's line and dot, and the footer's words.
   A sync pass shows as Syncing… only once it has run a moment: the engine
   passes through "syncing" every 15 s, and most passes end in a blink. */
const phases = [
  ["offline", "Offline", "Offline"],
  ["syncing", "Syncing", "Syncing…"],
  ["revoked", "token isn't accepted", "Not signed in"],
  ["error", "disk full", "Can't sync"],
  ["pending-deletes", "deletions waiting", "3 deletions to confirm"],
  // Last: step 11 reads the worker-outdated status this leaves.
  ["worker-outdated", "Waiting on a worker update", "Worker update needed"],
];
// A pass that ends within the moment never says Syncing…
await setStatuses([status()]);
await poll(async () => (await tid("sync-status").getAttribute("data-phase")) === "idle");
await setStatuses([status({ phase: "syncing" })]);
await settle(300);
await setStatuses([status()]);
await settle(900);
const blinkStayedSynced = (await tid("sync-status").textContent()) === "Synced";
let phasesOk = true;
const footerWords = [];
for (const [phase, words, footer] of phases) {
  await setStatuses([
    status({ phase, error: phase === "error" ? "disk full" : null, pendingDeletes: phase === "pending-deletes" ? 3 : 0 }),
  ]);
  await poll(async () => (await tid("phase-text").textContent()).toLowerCase().includes(words.toLowerCase()));
  phasesOk &&= (await page.locator(`.cloud-dot.phase-${phase}`).count()) === 1;
  phasesOk &&= await poll(async () => (await tid("sync-status").getAttribute("data-phase")) === phase).catch(() => false);
  footerWords.push(await tid("sync-status").textContent());
  phasesOk &&= footerWords.at(-1) === footer;
}
step(
  "phases: each reaches the panel's line and dot, and the footer says it in words; a pass that ends in a blink never says Syncing…",
  phasesOk && blinkStayedSynced,
  footerWords.join(" / "),
);

/* 11 — worker behind: the card in the panel, the badge on the gear and its menu item */
const behindCard = (await tid("worker-behind").count()) === 1;
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);
const gearBadge = (await page.locator(".settings-fab-badge").count()) === 1;
await page.locator(".settings-fab").click();
await poll(async () => (await tid("settings-cloud").count()) === 1);
const menuDot = (await tid("settings-cloud").locator(".settings-option-dot").count()) === 1;
await page.keyboard.press("Escape");
step("worker behind: the panel's card, the gear badge, the menu item's dot", behindCard && gearBadge && menuDot);

/* 11b — the version store's line: how much of this Mac's history the domain
   holds, and what a worker one version behind says instead of it */
await setStatuses([status({ versions: { mirrored: 12, cloud: 30, lastMirrorMs: Date.now() - 5 * 60000 } })]);
await tid("sync-status").click();
await poll(async () => (await dialog("Cloud").count()) === 1);
const mirrorLine = await tid("versions-line").textContent();
await setStatuses([status({ workerVersion: WORKER_VERSION - 1, versions: null })]);
await poll(async () => (await tid("worker-behind").count()) === 1);
const oldWorkerLine = await tid("versions-line").textContent();
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);
step(
  "version history: the panel says what the domain holds; one version behind, it says it can't and offers the update",
  mirrorLine.includes("30 snapshots on notes.example.com") &&
    mirrorLine.includes("12 from this Mac") &&
    oldWorkerLine.includes("too old to keep version history"),
  `${mirrorLine} / ${oldWorkerLine}`,
);

/* 12 — the update card: v→v, the script commands and a prompt that runs them
   (neither carrying the token), Check again */
await setStatuses([status({ phase: "worker-outdated", workerVersion: 0 })]);
await tid("sync-status").click();
await poll(async () => (await tid("update-worker").count()) === 1);
await tid("update-worker").click();
await poll(async () => (await dialog("Update the worker").count()) === 1);
const updateCommands = await tid("update-commands").textContent();
const updatePrompt = await tid("update-prompt").textContent();
const versionLine = await page.locator(".cloud-version-line").textContent();
await page.locator(".modal-btn", { hasText: "Check again" }).click();
await poll(async () => (await calls("cloud_check_worker")).length === 1);
await poll(async () => (await dialog("Update the worker").textContent()).includes("Up to date"));
step(
  "update card: v0 → current, the two commands and the prompt that runs them, neither carrying the token, Check again re-probes and the card rests",
  versionLine.includes("v0") &&
    versionLine.includes(`v${WORKER_VERSION}`) &&
    updateCommands.includes("doklin-cloud-update.sh") &&
    updateCommands.includes("sh doklin-cloud-update.sh https://notes.example.com") &&
    updatePrompt.includes("sh doklin-cloud-update.sh https://notes.example.com") &&
    updatePrompt.includes("UPDATED: https://notes.example.com") &&
    !updateCommands.includes(TOKEN) &&
    !updatePrompt.includes(TOKEN) &&
    (await page.locator(".settings-fab-badge").count()) === 0,
);
await page.screenshot({ path: SHOTS + "cloud-04-update-card.png" });
await page.locator(".modal-btn", { hasText: "Done" }).click();
await poll(async () => (await dialog("Update the worker").count()) === 0);

/* 13 — pending deletes: toast → Review… → the panel lists the paths → confirm */
await setStatuses([status({ phase: "pending-deletes", pendingDeletes: 6 })]);
await emit("cloud-pending-deletes", {
  root: "/docs",
  count: 6,
  total: 12,
  paths: ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"],
});
await poll(async () => (await page.locator(".toast").count()) === 1);
const deletesToast = await page.locator(".toast").textContent();
const deletesTone = await page.locator(".toast").getAttribute("class");
await page.locator(".toast-btn", { hasText: "Review" }).click();
await poll(async () => (await tid("pending-deletes").count()) === 1);
const listed = await tid("pending-deletes").locator(".cloud-paths li").count();
await tid("confirm-deletes").click();
await poll(async () => (await calls("cloud_confirm_deletes")).length === 1);
await poll(async () => (await tid("pending-deletes").count()) === 0);
step(
  "pending deletes: the toast, Review… opens the panel's list of paths, confirming releases them",
  deletesToast.includes("6 files disappeared") &&
    listed === 6 &&
    (await tid("phase-text").textContent()).startsWith("Synced") &&
    deletesTone.includes("is-warn") &&
    (await page.locator(".toast").count()) === 0,
);
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);

/* 14 — a conflict copy: the toast's Open the copy opens it */
await page.evaluate(() => {
  window.__fs.set("/docs/notes (conflict — Bob, Jul 11 14.32).md", "# Conflict copy\n\nBob's side.\n");
});
await emit("cloud-conflict", {
  root: "/docs",
  path: "notes.md",
  by: "Bob",
  conflictPath: "/docs/notes (conflict — Bob, Jul 11 14.32).md",
});
await poll(async () => (await page.locator(".toast").count()) === 1);
const conflictToast = await page.locator(".toast").textContent();
await page.locator(".toast-btn", { hasText: "Open the copy" }).click();
await poll(async () =>
  (await page.locator(".ProseMirror h1").first().textContent())?.includes("Conflict copy"),
);
step(
  "conflict: the toast names who and what, Open the copy opens the conflict file",
  conflictToast.includes("Bob") && conflictToast.includes("notes.md") && (await page.locator(".toast").count()) === 0,
);

/* 15 — cloud-applied refreshes the tree */
await page.evaluate(() => window.__treeFiles.push("fresh.md"));
await emit("cloud-applied", { root: "/docs", paths: ["fresh.md"] });
await poll(async () => (await page.locator('[data-tree-path="/docs/fresh.md"]').count()) === 1);
step("cloud-applied: the tree picks up the file sync wrote", true);

/* 16 — presence: a chip on the row being edited, and the panel's list. The
   engine names people (worker v7): Bob is a person on his Mac, and your own
   other Mac is named as a Mac, since "you are editing" would say nothing. */
await setStatuses([
  status({
    presence: [
      { deviceId: "d-bob", memberId: "m-0000b0b0", name: "Bob Mbeki", device: "Bob's Air", path: "other.md", ts: Date.now() },
      { deviceId: "d-studio", memberId: "m-00000001", name: "Studio", device: "Studio", path: null, ts: Date.now() },
    ],
  }),
]);
await poll(async () => (await tid("tree-presence").count()) === 1);
const chipRow = await tid("tree-presence").locator("xpath=ancestor::button").getAttribute("data-tree-path");
await tid("sync-status").click();
await poll(async () => (await tid("presence-list").count()) === 1);
const hereNow = await tid("presence-list").textContent();
step(
  "presence: Bob Mbeki's face on other.md's row; the panel names the person, his Mac, and your own other Mac once",
  (await tid("tree-presence").textContent()) === "BM" &&
    (await tid("tree-presence").getAttribute("title")) === "Bob Mbeki — editing now" &&
    chipRow === "/docs/other.md" &&
    hereNow.includes("Bob Mbeki") &&
    hereNow.includes("on Bob's Air · editing other.md") &&
    hereNow.includes("Studio") &&
    !hereNow.includes("on Studio"),
);

/* 16a — the title row's facepile: who is in the open note, up to three faces
   and then +N, the same person on two Macs once, the names on hover */
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);
await page.locator('[data-tree-path="/docs/notes.md"]').click();
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()) === "notes");
const noFacesAlone = (await tid("note-facepile").count()) === 0;
const here = (deviceId, name) => ({ deviceId, memberId: null, name, device: `${name}'s Mac`, path: "notes.md", ts: Date.now() });
await setStatuses([
  status({
    presence: [
      here("d-bob", "Bob Mbeki"),
      here("d-bob-2", "Bob Mbeki"),
      here("d-ana", "Ana Lima"),
      here("d-cy", "Cy"),
      here("d-dee", "Dee"),
      { ...here("d-eve", "Eve"), path: "other.md" },
    ],
  }),
]);
await poll(async () => (await tid("note-facepile").count()) === 1);
const faces = await tid("note-facepile").locator(".avatar").allTextContents();
const facesTitle = await tid("note-facepile").getAttribute("title");
await setStatuses([status()]);
await poll(async () => (await tid("note-facepile").count()) === 0);
step(
  "facepile: nobody else here, no faces; four people in this note (Bob on two Macs) → BM, AL, +2, the names on hover; somebody in another note isn't counted",
  noFacesAlone &&
    faces.join(",") === "BM,AL,+2" &&
    facesTitle === "In this note: Bob Mbeki, Ana Lima, Cy, Dee",
  `${faces.join(",")} · ${facesTitle}`,
);

/* 16b — leases: a document another Mac holds opens view-only under a banner,
   and Take over is one command that hands the lease here. The engine names
   the holder the way presence does — your own other Mac as a Mac, flagged —
   and the path is the lease's lowercased key. */
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);
await page.locator('[data-tree-path="/docs/other.md"]').click();
await poll(async () => (await page.locator(".ProseMirror h1").first().textContent())?.includes("Other"));
const editable = () => page.locator(".milkdown .ProseMirror").first().getAttribute("contenteditable");
await poll(async () => (await editable()) === "true");
const bobsLease = { path: "other.md", deviceId: "d-bob", memberId: "m-0000b0b0", name: "Bob Mbeki", device: "Bob's Air", own: false, until: Date.now() + 90_000 };
await setStatuses([status({ leases: [bobsLease] })]);
await poll(async () => (await tid("lease-banner").count()) === 1);
await poll(async () => (await editable()) === "false");
const leaseText = await tid("lease-banner-text").textContent();
await page.screenshot({ path: SHOTS + "cloud-16-lease.png" });
const before16b = await page.evaluate(() => window.__fs.get("/docs/other.md"));
await page.locator(".milkdown .ProseMirror").first().click();
await page.keyboard.type("typed while held");
await page.waitForTimeout(900);
const after16b = await page.evaluate(() => window.__fs.get("/docs/other.md"));
await tid("lease-take-over").click();
await poll(async () => (await tid("lease-banner").count()) === 0);
await poll(async () => (await editable()) === "true");
const take = await lastCall("cloud_take_over");
// Your own other Mac: the same banner, saying so rather than naming you.
await setStatuses([status({ leases: [{ ...bobsLease, deviceId: "d-studio", memberId: "m-00000001", name: "Studio", device: "Studio", own: true }] })]);
await poll(async () => (await tid("lease-banner").count()) === 1);
const ownText = await tid("lease-banner-text").textContent();
// A lease on some other document is not a lock on this one.
await setStatuses([status({ leases: [{ ...bobsLease, path: "notes.md" }] })]);
await poll(async () => (await tid("lease-banner").count()) === 0);
step(
  "leases: Bob's document opens view-only ('Bob Mbeki is editing — view only'), typing writes nothing, Take over hands it here; your own other Mac is named as one",
  leaseText === "Bob Mbeki is editing — view only" &&
    before16b === after16b &&
    take?.args.root === "/docs" &&
    take?.args.path === "/docs/other.md" &&
    ownText === "Open on your other Mac, Studio — view only" &&
    (await editable()) === "true",
);
await setStatuses([status()]);
await tid("sync-status").click();
await poll(async () => (await dialog("Cloud").count()) === 1);

/* 17 — Connect another Mac: endpoint + token shown */
await tid("another-mac").click();
await poll(async () => (await tid("creds-token").inputValue()) === TOKEN);
const credsWarning = await dialog("Connect another Mac").textContent();
step(
  "Connect another Mac: the endpoint and this Mac's token, warned about and pointed away from for anyone else",
  (await tid("creds-endpoint").inputValue()) === "https://notes.example.com" &&
    credsWarning.includes("Share it only with Macs you own") &&
    credsWarning.includes("invite them under People"),
);
await page.keyboard.press("Escape"); // back to main
await poll(async () => (await dialog("Cloud").count()) === 1);
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);

/* 18 — history: the one thing only a connected workspace puts on the rail —
   a version another Mac mirrored, read like a local one and restored as the
   new current state. That is
   the whole of it: the sync manifest carries no history to fall back on, and
   nothing here asks it for a revision. drive-versions.mjs walks the rail
   itself; this is the part a folder on its own never has. */
await page.evaluate(() => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  window.__versions.histories["/docs/other.md"] = {
    root: "/docs",
    currentHash: "a".repeat(64),
    versions: [
      {
        ts: midnight.getTime() + 9 * 3600000,
        hash: "a".repeat(64),
        size: 30,
        by: "Test Mac",
        reason: "closing",
        label: null,
        pinned: false,
        restoredFrom: null,
        path: "other.md",
        source: "local",
        current: true,
      },
      {
        ts: midnight.getTime() - 86400000 + 16 * 3600000,
        hash: "f".repeat(64),
        size: 25,
        by: "Sherin's iMac",
        reason: "interval",
        label: null,
        pinned: false,
        restoredFrom: null,
        path: "other.md",
        source: "cloud",
        current: false,
      },
    ],
  };
  window.__versions.blobs["f".repeat(64)] = "# Other\n\nwritten on the iMac\n";
});
await page.locator('[data-tree-path="/docs/other.md"]').click({ button: "right" });
await poll(async () => (await page.locator(".sidebar-menu-item", { hasText: "Version history" }).count()) === 1);
await page.locator(".sidebar-menu-item", { hasText: "Version history" }).click();
await poll(async () => (await tid("history-rail").count()) === 1);
await poll(async () => (await page.locator('[data-source="cloud"]').count()) === 1);
const whereHistoryLives = await tid("history-trust").textContent();

// It says which Mac and why, reads through the version store like any other
// version, compares — and restores by TEXT, because the local store never
// saw those bytes.
const mirrored = page.locator('[data-source="cloud"]');
const mirroredRow = await mirrored.textContent();
await mirrored.click();
await poll(async () => (await tid("version-preview").innerText()).includes("written on the iMac"));
const mirroredRead = await lastVersionCall("versions_read");
const mirroredComparable = (await tid("show-changes").count()) === 1;
await tid("restore-version").click();
await poll(
  async () => (await page.evaluate(() => window.__fs.get("/docs/other.md"))) === "# Other\n\nwritten on the iMac\n",
);
const cloudRestore = await lastVersionCall("versions_restore_file");
step(
  "history: another Mac's version rides the same rail, read where it lives and restored by its text",
  // The merge itself happens in Rust (versions_history walks both stores
  // there), so what the frontend can be held to is the rows and how each reads.
  whereHistoryLives.includes("1 here · 1 in the cloud") &&
    mirroredRow.includes("Sherin's iMac") &&
    mirroredRead.args.hash === "f".repeat(64) &&
    mirroredComparable &&
    cloudRestore.args.hash === null &&
    cloudRestore.args.text === "# Other\n\nwritten on the iMac\n" &&
    // Phase 6: the manifest is out of the history business entirely.
    (await page.evaluate(() =>
      window.__cloud.calls.every((c) => c.cmd !== "cloud_history" && c.cmd !== "cloud_revision"),
    )),
  `${whereHistoryLives} / ${mirroredRow}`,
);
await page.screenshot({ path: SHOTS + "cloud-05-history.png" });
await page.locator(".history-rail-close").click();
await poll(async () => (await tid("history-rail").count()) === 0);

/* 19 — disconnect: inline confirm, then the panel is back to its two doors, no dot */
await tid("sync-status").click();
await poll(async () => (await tid("disconnect").count()) === 1);
await tid("disconnect").click();
await poll(async () => (await tid("disconnect-confirm").count()) === 1);
await tid("disconnect-yes").click();
await poll(async () => (await calls("cloud_disconnect")).length === 1);
await poll(async () => (await tid("connect-domain").count()) === 1);
step(
  "disconnect: asks inline, then the workspace is local again",
  (await lastCall("cloud_disconnect")).args.root === "/docs" && (await tid("sync-status").count()) === 0,
);

/* 20 — the bound outcome with this folder's marker: Resume syncing this folder */
await setCloud({
  marker: { domain: "notes.example.com", wsId: "w-1" },
  probe: {
    workerVersion: WORKER_VERSION,
    bundledVersion: WORKER_VERSION,
    features: ["sync", "wipe"],
    workspace: {
      id: "w-1",
      name: "Notes",
      createdAt: new Date(Date.now() - 12 * 86400000).toISOString(),
      createdBy: { deviceId: "d-imac", deviceName: "Sherin's iMac" },
    },
  },
});
await tid("connect-domain").click();
await poll(async () => (await dialog("Create a workspace").count()) === 1);
await tid("domain-input").fill("notes.example.com");
await poll(async () => (await tid("probe-button").isEnabled()));
await tid("probe-button").click();
await poll(async () => (await tid("probe-outcome").count()) === 1);
const boundText = await tid("probe-outcome").textContent();
const boundOk =
  boundText.includes("already holds “Notes”") &&
  boundText.includes("Sherin's iMac") &&
  boundText.includes("12 d ago") &&
  (await tid("download-here").count()) === 1 &&
  (await tid("resume-folder").count()) === 1 &&
  (await tid("connect-upload").count()) === 0;
await tid("resume-folder").click();
await poll(async () => (await tid("setup-done").count()) === 1);
step(
  "bound + marker: 'already holds Notes (created on Sherin's iMac, 12 d ago)', Download and Resume offered, no Connect; Resume adopts the folder",
  boundOk && (await lastCall("cloud_resume")).args.root === "/docs",
);
await page.screenshot({ path: SHOTS + "cloud-06-wizard-bound.png" });
await page.locator(".modal-btn", { hasText: "Done" }).click();
await poll(async () => (await tid("sync-status").count()) === 1);

/* 21 — the danger zone: erase needs the domain typed, then the teardown prompt */
await tid("sync-status").click();
await poll(async () => (await tid("wipe-open").count()) === 1);
await tid("wipe-open").click();
await poll(async () => (await tid("wipe-button").count()) === 1);
const wipeDisabled = await tid("wipe-button").isDisabled();
await tid("wipe-confirm-input").fill("notes.example.com");
await poll(async () => await tid("wipe-button").isEnabled());
await tid("wipe-button").click();
await poll(async () => (await tid("wipe-done").count()) === 1);
const teardownPrompt = await tid("teardown-prompt").textContent();
step(
  "wipe: disabled until the domain is typed; erases, reports the count, and hands over the teardown prompt without a token",
  wipeDisabled &&
    (await tid("wipe-done").textContent()).includes("Erased 42 objects") &&
    teardownPrompt.includes("wrangler@4 delete --name doklin-notes-example-com") &&
    teardownPrompt.includes("r2 bucket delete doklin-notes-example-com") &&
    !teardownPrompt.includes(TOKEN) &&
    (await tid("sync-status").count()) === 0,
);
await page.screenshot({ path: SHOTS + "cloud-07-teardown.png" });
await page.locator(".modal-btn", { hasText: "Done" }).click();
await poll(async () => (await dialog("Cloud").count()) === 0);

/* 22 — join: endpoint + token typed, the bound outcome, and one click
   downloads it into its own folder under ~/Doklin and opens it — no folder
   is asked for */
await setCloud({ marker: null });
await openPanelFromGear();
await tid("open-from-domain").click();
await poll(async () => (await dialog("Open a workspace from a domain").count()) === 1);
await tid("endpoint-input").fill("https://notes.example.com");
await tid("token-input").fill(TOKEN);
await tid("probe-button").click();
await poll(async () => (await tid("probe-outcome").count()) === 1);
const joinOutcome =
  (await tid("download-here").count()) === 1 && (await tid("resume-folder").count()) === 0;
const pickerOpens = () => page.evaluate(() => window.__cloud.pickerOpens ?? 0);
const pickersBefore = await pickerOpens();
await tid("download-here").click();
await poll(async () => (await dialog("Open a workspace from a domain").count()) === 0);
await poll(async () => (await page.locator(".sidebar-header-name").textContent()) === "Notes");
const joinCall = await lastCall("cloud_join");
step(
  "join: the bound outcome without a marker offers only Download; it asks for no folder, lands in ~/Doklin/Notes and opens",
  joinOutcome &&
    (await pickerOpens()) === pickersBefore &&
    !("destParent" in joinCall.args) &&
    joinCall.args.token === TOKEN &&
    (await page.evaluate(() => window.__cloud.statuses.at(-1).root)) === "/Users/me/Doklin/Notes" &&
    (await tid("setup-done").count()) === 0 &&
    (await tid("sync-status").count()) === 1,
);
await page.screenshot({ path: SHOTS + "cloud-08-joined.png" });

/* 23 — joining with an invite: one paste fills both boxes, a bad code costs
   nothing, and Join is the whole of it — the code is traded for this Mac's
   own credential, the workspace downloads with THAT (never the owner's) and
   opens. A download that dies after the code is spent offers the download
   again, never another redeem */
await setStatuses([]); // back to a Mac with nothing connected
await setCloud({ marker: null, invite: { ...INVITE, error: "that invite code doesn't work." } });
await openPanelFromGear();
await tid("join-with-invite").click();
await poll(async () => (await dialog("Join a workspace").count()) === 1);
// The line as it arrives in a chat client, pasted into the code box alone.
await paste("code-input", `Come and join us:\n\n  ${INVITE.blob}  .`);
await poll(async () => (await tid("endpoint-input").inputValue()) === INVITE.endpoint);
const pasteFilledBoth = (await tid("code-input").inputValue()) === INVITE.code;

await tid("redeem-button").click();
await poll(async () => (await tid("setup-error").count()) === 1);
const refusedKindly =
  (await tid("setup-error").textContent()).includes("doesn't work") &&
  (await tid("redeem-button").count()) === 1 &&
  (await tid("redeemed-as").count()) === 0 &&
  (await tid("code-input").isEnabled());

// The code is good, and the download dies: the credential is kept.
await setCloud({ invite: INVITE, joinError: "couldn't reach notes.example.com: timed out" });
await tid("redeem-button").click();
await poll(async () => (await tid("redeemed-as").count()) === 1);
const redeemedAs = await tid("redeemed-as").textContent();
const keptTheCredential =
  (await tid("setup-error").textContent()).includes("timed out") &&
  (await tid("redeem-button").count()) === 0 &&
  (await tid("download-again").count()) === 1 &&
  (await tid("code-input").isDisabled()) &&
  (await calls("cloud_redeem")).filter((c) => c.args.code === INVITE.code).length >= 1;
const redeemsSoFar = (await calls("cloud_redeem")).length;
await page.screenshot({ path: SHOTS + "cloud-09-invite.png" });
await tid("download-again").click();
await poll(async () => (await dialog("Join a workspace").count()) === 0);
await poll(async () => (await page.locator(".sidebar-header-name").textContent()) === "Notes");
const redeemJoin = await lastCall("cloud_join");
step(
  "join with an invite: one paste fills both boxes, a refused code spends nothing; Join trades the code and downloads with the member's own token; a download that fails afterwards is retried without another redeem; then the workspace opens",
  pasteFilledBoth &&
    refusedKindly &&
    redeemedAs.includes("Bob") &&
    keptTheCredential &&
    (await calls("cloud_redeem")).length === redeemsSoFar &&
    (await lastCall("cloud_redeem")).args.code === INVITE.code &&
    redeemJoin.args.token === INVITE.token &&
    redeemJoin.args.token !== TOKEN &&
    !("destParent" in redeemJoin.args) &&
    (await tid("sync-status").count()) === 1,
  redeemedAs.trim(),
);
await page.screenshot({ path: SHOTS + "cloud-09-redeemed.png" });

/* 23b — the switcher: the workspace goes by its own name, and its menu lists
   the workspaces this Mac belongs to — the open one ticked, another one click
   away — with the door to join one more */
await setStatuses([
  ...(await page.evaluate(() => window.__cloud.statuses)),
  status({ root: "/docs", name: "Team docs", domain: "team.example.com", endpoint: "https://team.example.com" }),
]);
await page.locator(".sidebar-header-button").click();
await poll(async () => (await tid("sidebar-menu-workspace").count()) === 2);
const wsListed = (await tid("sidebar-menu-workspace").allTextContents()).map((t) => t.trim());
const wsTicked = await page.locator('[data-testid="sidebar-menu-workspace"][aria-checked="true"]').textContent();
const joinDoor = (await tid("sidebar-menu-join").textContent()).trim();
await page.screenshot({ path: SHOTS + "cloud-09b-switcher.png" });
await tid("sidebar-menu-workspace").filter({ hasText: "Team docs" }).click();
await poll(async () => (await page.locator(".sidebar-header-name").textContent()) === "Team docs");
await poll(async () => (await page.locator('[data-tree-path="/docs/other.md"]').count()) === 1);
step(
  "switcher: the menu lists this Mac's workspaces by name with the open one ticked and Join a workspace… under them; picking another opens it",
  wsListed.some((t) => t.endsWith("Notes")) &&
    wsListed.some((t) => t.endsWith("Team docs")) &&
    wsTicked.trim().endsWith("Notes") &&
    joinDoor === "Join a workspace…",
  wsListed.join(" · "),
);
await page.locator(".sidebar-header-button").click();
await tid("sidebar-menu-workspace").filter({ hasText: "Notes" }).click();
await poll(async () => (await page.locator(".sidebar-header-name").textContent()) === "Notes");
await setStatuses((await page.evaluate(() => window.__cloud.statuses)).filter((s) => s.root !== "/docs"));

/* 24 — People and agents: one view, a tab each, and a door for each in the
   panel — so that neither has to be found behind the other.
   People… lands on the People tab, with the invite door above the list */
await tid("sync-status").click();
await poll(async () => (await tid("people-open").count()) === 1);
const doorLabel = await dialog("Cloud").locator(".cloud-section-label", { hasText: "People and agents" }).count();
const doors = [(await tid("people-open").textContent()).trim(), (await tid("agents-open").textContent()).trim()];
await tid("people-open").click();
await poll(async () => (await dialog("People and agents").count()) === 1);
await poll(async () => (await tid("people-list").count()) === 1);
const selected = async (tab) => (await tid(`tab-${tab}`).getAttribute("aria-selected")) === "true";
const above = async (a, b) => (await tid(a).boundingBox()).y < (await tid(b).boundingBox()).y;
step(
  "People and agents: the panel has a door for each; People… opens the view on its People tab — what a person is, the invite door above the list — with the agents a tab away",
  doorLabel === 1 &&
    doors.join("|") === "People…|Agents…" &&
    (await tid("tab-people").textContent()).trim() === "People" &&
    (await tid("tab-agents").textContent()).trim() === "Agents" &&
    (await selected("people")) &&
    !(await selected("agents")) &&
    (await tid("pane-people").isVisible()) &&
    !(await tid("pane-agents").isVisible()) &&
    (await tid("people-intro").textContent()).includes("Everyone in Notes") &&
    (await tid("people-intro").textContent()).includes("until an owner removes them") &&
    (await above("people-intro", "invite-open")) &&
    (await above("invite-open", "people-list")),
);

/* 24a — People: the panel adopts an identity for a domain that has none,
   lists everyone with the Macs they hold, and mints a code that is on screen
   once */
const adoptAsked = (await tid("adopt-owner").count()) === 1;
await tid("adopt-email").fill("ada@example.com");
await tid("adopt-name").fill("Ada");
await tid("adopt-save").click();
await poll(async () => (await tid("person-m-owner").count()) === 1);
const adoptCall = await lastCall("cloud_adopt_owner");
const ownerRow = await tid("person-m-owner").textContent();
const bobRow = await tid("person-m-bob").textContent();

await tid("invite-open").click();
await poll(async () => (await tid("invite-form").count()) === 1);
await tid("invite-email").fill("carol@example.com");
await tid("invite-name").fill("Carol");
await tid("invite-days").selectOption("30");
await tid("invite-send").click();
await poll(async () => (await tid("minted-invite").count()) === 1);
const shownCode = (await tid("invite-code").textContent()).trim();
const inviteTerms = (await tid("invite-terms").textContent()).replace(/\s+/g, " ").trim();
const inviteCall = await lastCall("cloud_invite");
await tid("copy-invite-line").click();
const copiedLine = await poll(async () => await page.evaluate(() => navigator.clipboard.readText()));
await page.screenshot({ path: SHOTS + "cloud-10-people.png" });
step(
  "People: a creator the workspace cannot name yet is asked who they are, then listed as you — an owner, with nothing to remove or change on their row; the code is shown once with the line to send, and its card says only the code runs out",
  adoptAsked &&
    (await tid("adopt-owner").count()) === 0 &&
    adoptCall.args.email === "ada@example.com" &&
    ownerRow.includes("Ada") &&
    ownerRow.includes("owner") &&
    ownerRow.includes("you") &&
    ownerRow.includes("Made this workspace") &&
    (await tid("remove-person-m-owner").count()) === 0 &&
    (await tid("set-role-m-owner").count()) === 0 &&
    inviteTerms === "The code works once, for 30 days. Their access lasts until an owner removes them." &&
    bobRow.includes("bob@example.com") &&
    (await tid("mac-t-bob-1").textContent()).includes("Bob\u2019s MacBook") &&
    inviteCall.args.days === 30 &&
    shownCode === "dkln-9F4TR-2QWXM-7NBKD-5HGVZ" &&
    copiedLine === `doklin-invite https://notes.example.com ${shownCode}` &&
    (await tid("invite-list").textContent()).includes("carol@example.com"),
  shownCode,
);

/* 24b — and each way of taking access away takes exactly one thing */
await tid("minted-done").click();
await tid("revoke-mac-t-bob-1").click();
const signOutSays = await tid("mac-t-bob-1").locator(".cloud-inline-confirm").textContent();
await tid("revoke-mac-yes-t-bob-1").click();
await poll(async () => (await tid("mac-t-bob-1").count()) === 0);
const bobKept = (await tid("person-m-bob").count()) === 1;
const bobRevoked = await lastCall("cloud_revoke_device");

await tid("withdraw-i-new-1").click();
await tid("withdraw-yes-i-new-1").click();
await poll(async () => (await tid("invite-list").count()) === 0);
const carolKept = (await tid("person-m-new-1").count()) === 1;

await tid("remove-person-m-new-1").click();
const removeSays = await tid("person-m-new-1").locator(".cloud-inline-confirm").textContent();
await tid("remove-person-yes-m-new-1").click();
await poll(async () => (await tid("person-m-new-1").count()) === 0);
step(
  "People: signing a Mac out leaves the person, withdrawing a code leaves them too, and removing a person takes their row away — each confirm saying that Mac's copy is deleted and nothing in the cloud is",
  bobKept &&
    signOutSays.includes("deletes its copy of Notes") &&
    removeSays.includes("deletes its copy of Notes") &&
    removeSays.includes("Nothing in the cloud is deleted") &&
    bobRevoked.args.tokenId === "t-bob-1" &&
    (await tid("person-m-bob").textContent()).includes("No Mac signed in") &&
    carolKept &&
    (await lastCall("cloud_withdraw_invite")).args.inviteId === "i-new-1" &&
    (await lastCall("cloud_revoke_person")).args.memberId === "m-new-1" &&
    (await tid("person-m-owner").count()) === 1,
);

/* 24b′ — roles: an owner makes another owner, and a member again. The role
   is the person's, so it is one button on their row, confirmed inline */
const bobBefore = (await tid("set-role-m-bob").textContent()).trim();
await tid("set-role-m-bob").click();
const promoteSays = await tid("person-m-bob").locator(".cloud-inline-confirm").textContent();
await tid("set-role-yes-m-bob").click();
await poll(async () => (await tid("person-m-bob").locator(".cloud-person-tag", { hasText: "owner" }).count()) === 1);
const promoted = await lastCall("cloud_set_role");
const bobAfter = (await tid("set-role-m-bob").textContent()).trim();
await tid("set-role-m-bob").click();
await tid("set-role-yes-m-bob").click();
await poll(async () => (await tid("person-m-bob").locator(".cloud-person-tag", { hasText: "owner" }).count()) === 0);
step(
  "People (roles): Make an owner on a member's row says what an owner can do, then tags them owner and offers Make a member; making them a member again takes the tag away",
  bobBefore === "Make an owner" &&
    promoteSays.includes("invite and remove people") &&
    promoted.args.memberId === "m-bob" &&
    promoted.args.role === "owner" &&
    bobAfter === "Make a member" &&
    (await lastCall("cloud_set_role")).args.role === "member",
);

/* 24c — Agents, on their own tab: the owner adds a bot,
   ticks what it may do — publishing is off until ticked, reading is not a
   choice — and is handed ONE thing, once: a short prompt that says what
   Doklin is and carries the command that installs `doklin` and the one that
   logs it in. One button copies it; a look at the other tab does not lose it */
const INSTALL_LINE = "curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh";
await tid("tab-agents").click();
await poll(async () => (await tid("agent-list").count()) === 1);
const agentsTab =
  (await selected("agents")) &&
  (await tid("pane-agents").isVisible()) &&
  !(await tid("pane-people").isVisible()) &&
  (await tid("agents-intro").textContent()).includes("bots") &&
  (await above("agents-intro", "agent-open")) &&
  (await above("agent-open", "agent-list"));
const reviewBot = await tid("agent-a-11111111").textContent();
await tid("agent-open").click();
await poll(async () => (await tid("agent-form").count()) === 1);
const boxes = async () => ({
  read: await tid("agent-scope-read").isChecked(),
  comment: await tid("agent-scope-comment").isChecked(),
  edit: await tid("agent-scope-edit").isChecked(),
  publish: await tid("agent-scope-publish").isChecked(),
});
const defaults = await boxes();
const readFixed = await tid("agent-scope-read").isDisabled();
const saveNeedsName = await tid("agent-save").isDisabled();
await tid("agent-name").fill("Grok bot");
await tid("agent-scope-comment").uncheck();
await tid("agent-save").click();
await poll(async () => (await tid("agent-login").count()) === 1);
const addCall = await lastCall("cloud_agent_add");
const prompt = await tid("agent-prompt").textContent();
const promptLines = prompt.split("\n");
const loginCard = await tid("agent-login").textContent();
const cardButtons = (await tid("agent-login").locator("button").allTextContents()).map((t) => t.trim());
await tid("copy-agent-prompt").click();
const copiedPrompt = await poll(async () => {
  const text = await page.evaluate(() => navigator.clipboard.readText());
  return text.startsWith("Doklin is") ? text : null;
});
const grokRow = await tid("agent-a-new-1").textContent();
await page.screenshot({ path: SHOTS + "cloud-10b-agents.png" });
// the code is shown once: a look at the People tab must not cost it
await tid("tab-people").click();
const hiddenNotGone = !(await tid("agent-login").isVisible()) && (await tid("agent-login").count()) === 1;
await tid("tab-agents").click();
const promptKept = (await tid("agent-prompt").isVisible()) && (await tid("agent-prompt").textContent()) === prompt;
const LOGIN_1 = "doklin login https://notes.example.com dkla-7QK2M-9XVR4-8TBHN-3WGYD";
step(
  "Agents: their own tab, the door above the list; the list names what each may do and where it is logged in; a new one starts without publishing, reading fixed; what is handed over is one short prompt — what Doklin is, install, login, what the address is — copied by one button, shown once, and kept through a look at the other tab",
  agentsTab &&
    reviewBot.includes("Review bot") &&
    reviewBot.includes("read · comment") &&
    !reviewBot.includes("can publish") &&
    reviewBot.includes("Logged in on 1 machine") &&
    reviewBot.includes("ci-runner-7") &&
    JSON.stringify(defaults) === JSON.stringify({ read: true, comment: true, edit: true, publish: false }) &&
    readFixed &&
    saveNeedsName &&
    addCall.args.name === "Grok bot" &&
    JSON.stringify(addCall.args.scopes) === JSON.stringify(["read", "edit"]) &&
    prompt.startsWith("Doklin is a workspace of markdown and HTML documents.") &&
    promptLines.indexOf(INSTALL_LINE) > 0 &&
    promptLines.indexOf(LOGIN_1) === promptLines.indexOf(INSTALL_LINE) + 1 &&
    prompt.includes("notes.example.com is the workspace's address") &&
    prompt.includes("doklin help agent") &&
    loginCard.includes("Log Grok bot in") &&
    /stops working in\s+(1 h|59 min)\./.test(loginCard) &&
    cardButtons.join("|") === "Copy prompt|Done" &&
    copiedPrompt === prompt &&
    hiddenNotGone &&
    promptKept &&
    grokRow.includes("Not logged in anywhere") &&
    grokRow.includes("a login code is waiting") &&
    (await tid("agent-form").count()) === 0,
  LOGIN_1,
);

/* 24d — and afterwards: the code is gone from the screen for good, a new one
   replaces it, the boxes can be changed, one machine can be logged out, and
   removing the agent takes its row */
await tid("agent-login-done").click();
const lineGone = (await tid("agent-login").count()) === 0;
await tid("agent-code-a-11111111").click();
await poll(async () => (await tid("agent-login").count()) === 1);
const secondPrompt = (await tid("agent-prompt").textContent()).split("\n");
const codeCall = await lastCall("cloud_agent_code");
await tid("agent-login-done").click();

await tid("agent-edit-a-new-1").click();
await poll(async () => (await tid("agent-form").count()) === 1);
const editBoxes = await boxes();
await tid("agent-scope-publish").check();
await tid("agent-save").click();
await poll(async () => (await tid("agent-a-new-1").textContent()).includes("can publish"));
const updateCall = await lastCall("cloud_agent_update");
const noLineOnEdit = (await tid("agent-login").count()) === 0;

await tid("agent-logout-t-box-1").click();
await tid("agent-logout-yes-t-box-1").click();
await poll(async () => (await tid("agent-machine-t-box-1").count()) === 0);
const logoutCall = await lastCall("cloud_agent_revoke_machine");
const reviewBotKept = (await tid("agent-a-11111111").textContent()).includes("Not logged in anywhere");

await tid("agent-remove-a-new-1").click();
await tid("agent-remove-yes-a-new-1").click();
await poll(async () => (await tid("agent-a-new-1").count()) === 0);
step(
  "Agents: Done takes the prompt off the screen; a new login code is another prompt for the same agent; ticking Publish says so on its row; logging a machine out leaves the agent, removing the agent takes its row — and the People tab is untouched",
  lineGone &&
    codeCall.args.agentId === "a-11111111" &&
    secondPrompt.includes(INSTALL_LINE) &&
    secondPrompt.includes("doklin login https://notes.example.com dkla-2B4D6-8FHKM-PRTVX-Z3579") &&
    !secondPrompt.join("\n").includes("dkla-7QK2M") &&
    JSON.stringify(editBoxes) === JSON.stringify({ read: true, comment: false, edit: true, publish: false }) &&
    updateCall.args.agentId === "a-new-1" &&
    JSON.stringify([...updateCall.args.scopes].sort()) === JSON.stringify(["edit", "publish", "read"]) &&
    noLineOnEdit &&
    logoutCall.args.agentId === "a-11111111" &&
    logoutCall.args.tokenId === "t-box-1" &&
    reviewBotKept &&
    (await lastCall("cloud_agent_remove")).args.agentId === "a-new-1" &&
    (await tid("agent-a-11111111").count()) === 1 &&
    (await tid("person-m-owner").count()) === 1 &&
    (await tid("person-m-bob").count()) === 1,
);

/* 24e — a worker that predates agents, reached by the panel's Agents door:
   the tab says so in a line under what an agent is, and the People tab is
   still there to manage */
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 1);
const TOO_OLD = "notes.example.com runs a worker too old for agents \u2014 update it from the Cloud panel";
await page.evaluate((error) => {
  window.__cloud.agents.error = error;
}, TOO_OLD);
await tid("agents-open").click();
await poll(async () => (await tid("agents-unavailable").count()) === 1);
await poll(async () => (await tid("agents-unavailable").textContent()).includes("too old for agents"));
const landedOnAgents = (await selected("agents")) && (await tid("agents-unavailable").isVisible()) && !(await tid("pane-people").isVisible());
const tooOld = (await tid("agents-unavailable").textContent()).trim();
const stillSaysWhat = await tid("agents-intro").isVisible();
await tid("tab-people").click();
step(
  "Agents (an older worker): Agents… opens the view on its Agents tab; one line saying the worker is too old, under what an agent is, no list and no door — and the People tab still lists and invites",
  landedOnAgents &&
    tooOld === TOO_OLD &&
    stillSaysWhat &&
    (await tid("agent-list").count()) === 0 &&
    (await tid("agent-open").count()) === 0 &&
    (await tid("person-m-bob").isVisible()) &&
    (await tid("invite-open").isVisible()),
);
await page.evaluate(() => {
  window.__cloud.agents.error = null;
});

/* 25 — the same workspace on a Mac that joined with an invite: who is here
   is everybody's to see, and nothing that is an owner's to do is offered —
   not in the panel (no Agents door, no worker update, no danger zone) and not
   in the view (no tabs, no invite door, no Remove, no role button) */
const MEMBER_CAN = ["work", "people.see"];
await page.keyboard.press("Escape"); // back to the panel's main view
await poll(async () => (await dialog("Cloud").count()) === 1);

/* 24f — an owner who is not the creator, on a Mac that syncs with a token
   another of their Macs handed it (Connect another Mac…): the row is this
   Mac's own sign-in whatever device id it carries, so it is tagged and never
   offered for signing out — that would delete the copy in hand */
const peopleBefore = await page.evaluate(() => window.__cloud.people);
await setCloud({
  people: {
    ...peopleBefore,
    creator: false,
    me: "m-bob",
    tokenId: "t-bob-9",
    members: peopleBefore.members.map((m) => (m.id === "m-bob" ? { ...m, role: "owner", devices: 1 } : m)),
    devices: [
      {
        id: "t-bob-9",
        memberId: "m-bob",
        email: "bob@example.com",
        deviceId: "d-bobs-first-mac",
        deviceName: "Bob\u2019s MacBook",
        createdAt: Date.now() - 86400000,
      },
    ],
  },
});
await tid("people-open").click();
await poll(async () => (await tid("mac-t-bob-9").count()) === 1);
step(
  "People (this Mac's own sign-in): the row whose token this Mac syncs with is tagged this Mac and has no Sign out, though another Mac redeemed it",
  (await tid("mac-t-bob-9").textContent()).includes("this Mac") &&
    (await tid("revoke-mac-t-bob-9").count()) === 0 &&
    (await tid("set-role-m-bob").count()) === 0 &&
    (await tid("remove-person-m-bob").count()) === 0,
);
await setCloud({ people: peopleBefore });
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 1);
await setCloud({ can: MEMBER_CAN });
await setStatuses((await page.evaluate(() => window.__cloud.statuses)).map((s) => ({ ...s, can: ["work", "people.see"] })));
const people = await page.evaluate(() => window.__cloud.people);
await setCloud({
  people: { ...people, role: "member", creator: false, me: "m-bob", can: MEMBER_CAN, invites: [], devices: [] },
});
await poll(async () => (await tid("agents-open").count()) === 0);
const memberPanel =
  (await dialog("Cloud").locator(".cloud-section-label", { hasText: /^People$/ }).count()) === 1 &&
  (await tid("people-open").count()) === 1 &&
  (await tid("wipe-open").count()) === 0 &&
  (await tid("update-worker-quiet").count()) === 0 &&
  (await tid("another-mac").count()) === 1 &&
  (await tid("disconnect").count()) === 1;
await tid("people-open").click();
await poll(async () => (await dialog("People").count()) === 1);
await poll(async () => (await tid("people-list").count()) === 1);
const memberIntro = await tid("people-intro").textContent();
step(
  "People (a member): the panel offers People… and nothing that is an owner's; the view lists everyone — the creator tagged owner, this person tagged you — with no tabs, no invite door, no Remove and no role button, and no error",
  memberPanel &&
    memberIntro.includes("Everyone in Notes") &&
    memberIntro.includes("An owner invites people and removes them") &&
    (await tid("person-m-owner").textContent()).includes("owner") &&
    (await tid("person-m-bob").textContent()).includes("you") &&
    !(await tid("person-m-owner").textContent()).includes("you") &&
    (await tid("tab-people").count()) === 0 &&
    (await tid("tab-agents").count()) === 0 &&
    (await tid("invite-open").count()) === 0 &&
    (await tid("adopt-owner").count()) === 0 &&
    (await page.locator('[data-testid^="remove-person-"]').count()) === 0 &&
    (await page.locator('[data-testid^="set-role-"]').count()) === 0 &&
    (await page.locator('[data-testid^="revoke-mac-"]').count()) === 0 &&
    (await tid("agent-list").count()) === 0 &&
    (await tid("agent-open").count()) === 0 &&
    (await dialog("People").locator(".modal-error").count()) === 0,
  memberIntro.trim(),
);
await page.screenshot({ path: SHOTS + "cloud-11-people-member.png" });

/* 26 — an owner removes this Mac. The engine deletes the copy and says so;
   the window lets go of the workspace — its tabs close, the sidebar goes, the
   panel shuts — and a notice says what happened, in words that do not
   pretend anything was deleted in the cloud */
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);
const removedRoot = await page.evaluate(() => window.__cloud.statuses.at(-1).root);
await setStatuses([]); // the engine forgets the workspace first, then says why
await emit("cloud-removed", { root: removedRoot, name: "Notes", domain: "notes.example.com", deleted: true, at: Date.now() });
await poll(async () => (await tid("access-removed").count()) === 1);
const notice = (await tid("access-removed").textContent()).replace(/\s+/g, " ");
step(
  "access removed: the workspace leaves the window (no sidebar, no sync line, no tabs of its files) and a notice names it, says its copy was deleted from this Mac and that nothing was deleted in the cloud",
  notice.includes("You no longer have access to Notes") &&
    notice.includes("deleted from this Mac") &&
    notice.includes("Nothing was deleted in the cloud") &&
    (await page.locator(".sidebar-header-name").count()) === 0 &&
    (await tid("sync-status").count()) === 0 &&
    (await page.evaluate((root) => !JSON.stringify(localStorage.getItem("doklin:session") ?? "").includes(root), removedRoot)),
  notice.trim(),
);
await settle(300); // the notice fades in
await page.screenshot({ path: SHOTS + "cloud-12-access-removed.png" });
await tid("access-removed-ok").click();
await poll(async () => (await tid("access-removed").count()) === 0);

/* 27 — and from there, with no folder open, the welcome screen has the one
   door somebody with an invite needs */
await poll(async () => (await tid("join-workspace").count()) === 1);
await tid("join-workspace").click();
await poll(async () => (await dialog("Join a workspace").count()) === 1);
step(
  "welcome screen: Join a workspace opens the invite door",
  (await tid("code-input").count()) === 1 && (await tid("redeem-button").count()) === 1,
);

/* 28 — the same removal, heard before the window was up: the app starts on a
   saved session that points at a folder already deleted, with no event left
   to hear. It asks what left since launch, lets go of that workspace — no
   ghost tab for a file that is gone — and says what happened, once */
await page.goto(page.url().replace(/\?.*$/, "") + "?removed-at-launch");
await poll(async () => (await tid("access-removed").count()) === 1);
await settle(300);
const lateNotice = (await tid("access-removed").textContent()).replace(/\s+/g, " ");
step(
  "access removed (before the window was listening): the list answers what the event could not — the notice shows once, the dead folder's tab and saved session are gone",
  lateNotice.includes("You no longer have access to Notes") &&
    (await tid("access-removed").count()) === 1 &&
    (await page.locator(".sidebar-header-name").count()) === 0 &&
    (await page.locator(".tab").count()) === 0 &&
    (await tid("join-workspace").count()) === 1 &&
    (await page.evaluate(() => !(localStorage.getItem("doklin:session") ?? "").includes("/Users/me/Doklin/Notes"))),
  lateNotice.trim(),
);
await tid("access-removed-ok").click();
await settle(400);
step(
  "…and it is not shown again by the list being read a second time",
  (await tid("access-removed").count()) === 0,
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
