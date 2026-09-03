// Drives the REAL App's cloud surfaces in Chromium (cloud.html boots <App/>
// over an IPC stub whose cloud_* commands answer from a scripted fake of
// the engine): the not-connected state, the setup wizard's three outcomes
// (a fresh domain, a domain that already holds a workspace, a folder that
// carries that workspace's marker), the panel's phases, sync now / pause,
// the held mass-deletion (toast → panel → confirm), a conflict copy's toast,
// `cloud-applied` refreshing the tree, presence chips, the worker update
// card and its badge, the history panel restoring a revision, "Connect
// another Mac", disconnect, the wipe → teardown prompt, and the join flow
// opening the downloaded folder — and publishing: the pill's not-connected
// door, publishing a note at a random then a chosen address, the sidebar's
// dots, the folder dialog, the published list (home page, stop), and the
// sidebar's undoable stop.
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

const calls = (cmd) => page.evaluate((c) => window.__cloud.calls.filter((x) => x.cmd === c), cmd);
const lastCall = async (cmd) => (await calls(cmd)).at(-1) ?? null;
const emit = (event, payload) => page.evaluate(([e, p]) => window.__emit(e, p), [event, payload]);
const setStatuses = (statuses) => page.evaluate((s) => window.__setStatuses(s), statuses);
const setCloud = (patch) => page.evaluate((p) => Object.assign(window.__cloud, p), patch);
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
  workerVersion: WORKER_VERSION,
  public: [],
  presence: [],
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
/* 1b — the pill on a note of an unconnected workspace: Publish, and the door to the wizard */
await poll(async () => (await tid("publish-pill").count()) === 1);
const pillBefore = await tid("publish-pill").textContent();
await tid("publish-pill").click();
await poll(async () => (await tid("publish-pop").count()) === 1);
step(
  "pill (not connected): reads Publish, its popover explains and offers Connect a domain…",
  pillBefore === "Publish" &&
    (await tid("publish-connect").count()) === 1 &&
    (await tid("publish-pop").textContent()).includes("connected to a domain"),
  pillBefore,
);
await page.keyboard.press("Escape");
await poll(async () => (await tid("publish-pop").count()) === 0);
await page.locator(".settings-fab").click();
await poll(async () => (await tid("settings-cloud").count()) === 1);
step(
  "boots: /docs listed, no cloud dot, Cloud… in the gear menu without a badge",
  (await tid("sidebar-cloud-dot").count()) === 0 &&
    (await tid("settings-cloud").locator(".settings-option-dot").count()) === 0 &&
    (await page.locator(".settings-fab-badge").count()) === 0,
);

/* 2 — the panel, not connected: two doors */
await tid("settings-cloud").click();
await poll(async () => (await dialog("Cloud").count()) === 1);
step(
  "panel (not connected): Connect a domain… enabled, Open a workspace from a domain… offered",
  (await tid("connect-domain").isEnabled()) && (await tid("open-from-domain").count()) === 1,
);
await page.screenshot({ path: SHOTS + "cloud-01-not-connected.png" });

/* 3 — the wizard: name prefilled, the domain typed, the prompt built from it */
await tid("connect-domain").click();
await poll(async () => (await dialog("Connect a domain").count()) === 1);
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
await poll(async () => (await dialog("Connect a domain").count()) === 0);

/* 8 — the sidebar dot is green and names the domain */
await poll(async () => (await tid("sidebar-cloud-dot").count()) === 1);
step(
  "sidebar dot: phase-idle, tooltip names the domain",
  (await page.locator(".sidebar-cloud-dot.phase-idle").count()) === 1 &&
    (await tid("sidebar-cloud-dot").getAttribute("title")).includes("notes.example.com"),
);

/* 9 — the panel, connected: phase line, sync now, pause / resume */
await tid("sidebar-cloud-dot").click();
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
await tid("publish-pill").click();
await poll(async () => (await tid("publish-go").count()) === 1);
await tid("publish-go").click();
await poll(async () => (await calls("cloud_publish")).length === 1);
await poll(async () => (await tid("publish-pill").textContent()) === "Published");
const firstPublish = await lastCall("cloud_publish");
const publishedUrl = await tid("publish-url").textContent();
step(
  "pill: Publish sends the note's path with no slug; the pill reads Published, the link is a random address, the sidebar row gets a dot",
  firstPublish.args.path === "/docs/notes.md" &&
    firstPublish.args.slug === null &&
    /^notes\.example\.com\/[a-z0-9]{8}$/.test(publishedUrl) &&
    (await tid("publish-by").textContent()).includes("by this Mac") &&
    (await page.locator('[data-tree-path="/docs/notes.md"] [data-testid="tree-published"]').count()) === 1,
  publishedUrl,
);
await page.screenshot({ path: SHOTS + "cloud-09-published.png" });

/* 9b — a chosen address, and Copy */
await tid("publish-slug").fill("team-notes");
await tid("publish-rename").click();
await poll(async () => (await lastCall("cloud_publish")).args.slug === "team-notes");
await poll(async () => (await tid("publish-url").textContent()) === "notes.example.com/team-notes");
await tid("publish-copy").click();
await poll(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "https://notes.example.com/team-notes");
await tid("publish-slug").fill("AB");
await poll(async () => (await tid("publish-pop").locator(".modal-error").count()) === 1);
step(
  "pill: Change re-publishes under the chosen slug, Copy puts the link on the clipboard, a bad slug is refused before the engine sees it",
  (await tid("publish-rename").isDisabled()) && (await calls("cloud_publish")).length === 2,
);
await page.keyboard.press("Escape");
await poll(async () => (await tid("publish-pop").count()) === 0);

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
await poll(async () => (await tid("publish-pill").textContent()) === "Publish");
await tid("publish-pill").click();
await poll(async () => (await tid("publish-nested").count()) === 1);
step(
  "pill (inside a published folder): not published on its own, but 'Already public inside Projects' at the nested address",
  (await tid("publish-nested").textContent()).includes("notes.example.com/projects/plan"),
);
await page.keyboard.press("Escape");
await poll(async () => (await tid("publish-pop").count()) === 0);
await page.screenshot({ path: SHOTS + "cloud-10-folder-published.png" });

/* 9e — the published list: folders first, home page, stop */
await tid("sidebar-cloud-dot").click();
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
await poll(async () => (await page.locator(".cloud-toast").count()) === 1);
const stopToast = await page.locator(".cloud-toast").textContent();
await page.locator(".cloud-toast-btn", { hasText: "Undo" }).click();
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
await tid("sidebar-cloud-dot").click();
await poll(async () => (await dialog("Cloud").count()) === 1);

/* 10 — every phase reaches the phase line and the dot */
const phases = [
  ["offline", "Offline"],
  ["syncing", "Syncing"],
  ["revoked", "Access revoked"],
  ["error", "disk full"],
  ["worker-outdated", "Waiting on a worker update"],
];
let phasesOk = true;
for (const [phase, words] of phases) {
  await setStatuses([status({ phase, error: phase === "error" ? "disk full" : null })]);
  await poll(async () => (await tid("phase-text").textContent()).toLowerCase().includes(words.toLowerCase()));
  phasesOk &&= (await page.locator(`.cloud-dot.phase-${phase}`).count()) === 1;
  phasesOk &&= (await page.locator(`.sidebar-cloud-dot.phase-${phase}`).count()) === 1;
}
step("phases: offline / syncing / revoked / error / worker-outdated reach the line and both dots", phasesOk);

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

/* 12 — the update card: v→v, a prompt without the token, Check again */
await setStatuses([status({ phase: "worker-outdated", workerVersion: 0 })]);
await tid("sidebar-cloud-dot").click();
await poll(async () => (await tid("update-worker").count()) === 1);
await tid("update-worker").click();
await poll(async () => (await dialog("Update the worker").count()) === 1);
const updatePrompt = await tid("update-prompt").textContent();
const versionLine = await page.locator(".cloud-version-line").textContent();
await page.locator(".modal-btn", { hasText: "Check again" }).click();
await poll(async () => (await calls("cloud_check_worker")).length === 1);
await poll(async () => (await dialog("Update the worker").textContent()).includes("Up to date"));
step(
  "update card: v0 → current, prompt names the worker and carries no token, Check again re-probes and the card rests",
  versionLine.includes("v0") &&
    versionLine.includes(`v${WORKER_VERSION}`) &&
    updatePrompt.includes("deployments list --name doklin-notes-example-com") &&
    updatePrompt.includes("UPDATED: https://notes.example.com") &&
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
await poll(async () => (await page.locator(".cloud-toast").count()) === 1);
const deletesToast = await page.locator(".cloud-toast").textContent();
await page.locator(".cloud-toast-btn", { hasText: "Review" }).click();
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
    (await page.locator(".cloud-toast").count()) === 0,
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
await poll(async () => (await page.locator(".cloud-toast").count()) === 1);
const conflictToast = await page.locator(".cloud-toast").textContent();
await page.locator(".cloud-toast-btn", { hasText: "Open the copy" }).click();
await poll(async () =>
  (await page.locator(".ProseMirror h1").first().textContent())?.includes("Conflict copy"),
);
step(
  "conflict: the toast names who and what, Open the copy opens the conflict file",
  conflictToast.includes("Bob") && conflictToast.includes("notes.md") && (await page.locator(".cloud-toast").count()) === 0,
);

/* 15 — cloud-applied refreshes the tree */
await page.evaluate(() => window.__treeFiles.push("fresh.md"));
await emit("cloud-applied", { root: "/docs", paths: ["fresh.md"] });
await poll(async () => (await page.locator('[data-tree-path="/docs/fresh.md"]').count()) === 1);
step("cloud-applied: the tree picks up the file sync wrote", true);

/* 16 — presence: a chip on the row being edited, and the panel's list */
await setStatuses([
  status({ presence: [{ deviceId: "d-bob", name: "Bob", path: "other.md", ts: Date.now() }] }),
]);
await poll(async () => (await tid("tree-presence").count()) === 1);
const chipRow = await tid("tree-presence").locator("xpath=ancestor::button").getAttribute("data-tree-path");
await tid("sidebar-cloud-dot").click();
await poll(async () => (await tid("presence-list").count()) === 1);
step(
  "presence: 'Bob' on other.md's row, 'Bob editing other.md' in the panel",
  (await tid("tree-presence").textContent()) === "Bob" &&
    chipRow === "/docs/other.md" &&
    (await tid("presence-list").textContent()).includes("editing other.md"),
);

/* 17 — Connect another Mac: endpoint + token shown */
await tid("another-mac").click();
await poll(async () => (await tid("creds-token").inputValue()) === TOKEN);
step(
  "Connect another Mac: the endpoint and the owner token, with the warning",
  (await tid("creds-endpoint").inputValue()) === "https://notes.example.com" &&
    (await dialog("Connect another Mac").textContent()).includes("owner credential"),
);
await page.keyboard.press("Escape"); // back to main
await poll(async () => (await dialog("Cloud").count()) === 1);
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Cloud").count()) === 0);

/* 18 — history: the context menu, the revisions, restore writes the file */
await page.locator('[data-tree-path="/docs/other.md"]').click({ button: "right" });
await poll(async () => (await page.locator(".sidebar-menu-item", { hasText: "Version history" }).count()) === 1);
await page.locator(".sidebar-menu-item", { hasText: "Version history" }).click();
await poll(async () => (await dialog("Version history").count()) === 1);
await poll(async () => (await page.locator(".cloud-history-rev").count()) === 3);
const revTitles = await page.locator(".cloud-history-rev-title").allTextContents();
await page.locator(".cloud-history-rev", { hasText: "Revision 1" }).click();
await poll(async () => (await page.locator(".cloud-history-pre").textContent()).includes("the first revision"));
await page.locator(".modal-btn", { hasText: "Restore this version" }).click();
await poll(async () => (await page.evaluate(() => window.__fs.get("/docs/other.md"))) === "# Other\n\nthe first revision\n");
step(
  "history: Current / Revision 2 / Revision 1, the preview, Restore writes the revision as the file",
  revTitles.join("|") === "Current|Revision 2|Revision 1" &&
    (await lastCall("cloud_history")).args.path === "/docs/other.md" &&
    (await lastCall("cloud_revision")).args.hash === "h1",
);
await page.screenshot({ path: SHOTS + "cloud-05-history.png" });
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Version history").count()) === 0);

/* 19 — disconnect: inline confirm, then the panel is back to its two doors, no dot */
await tid("sidebar-cloud-dot").click();
await poll(async () => (await tid("disconnect").count()) === 1);
await tid("disconnect").click();
await poll(async () => (await tid("disconnect-confirm").count()) === 1);
await tid("disconnect-yes").click();
await poll(async () => (await calls("cloud_disconnect")).length === 1);
await poll(async () => (await tid("connect-domain").count()) === 1);
step(
  "disconnect: asks inline, then the workspace is local again",
  (await lastCall("cloud_disconnect")).args.root === "/docs" && (await tid("sidebar-cloud-dot").count()) === 0,
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
await poll(async () => (await dialog("Connect a domain").count()) === 1);
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
await poll(async () => (await tid("sidebar-cloud-dot").count()) === 1);

/* 21 — the danger zone: erase needs the domain typed, then the teardown prompt */
await tid("sidebar-cloud-dot").click();
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
    (await tid("sidebar-cloud-dot").count()) === 0,
);
await page.screenshot({ path: SHOTS + "cloud-07-teardown.png" });
await page.locator(".modal-btn", { hasText: "Done" }).click();
await poll(async () => (await dialog("Cloud").count()) === 0);

/* 22 — join: endpoint + token typed, the bound outcome, download into a picked folder, open it */
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
await tid("download-here").click();
await poll(async () => (await tid("setup-done").count()) === 1);
const joinCall = await lastCall("cloud_join");
await page.locator(".modal-btn", { hasText: "Open the folder" }).click();
await poll(async () => (await page.locator(".sidebar-header-name").textContent()) === "Notes");
step(
  "join: the bound outcome without a marker offers only Download; it downloads into the picked folder and opens it",
  joinOutcome &&
    joinCall.args.destParent === "/Users/me/Downloads" &&
    joinCall.args.token === TOKEN &&
    (await tid("sidebar-cloud-dot").count()) === 1,
);
await page.screenshot({ path: SHOTS + "cloud-08-joined.png" });

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
