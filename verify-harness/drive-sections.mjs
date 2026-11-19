// Drives a workspace in sections in Chromium (cloud.html?sections boots the
// REAL <App/> connected to a scripted engine whose workspace is in the
// Library layout, with a Private, a restricted folder and things at its top
// in no section). What this proves: where a document is decides who can
// open it, and every way of changing that says so first.
//
// The walk: the three lists and what is not a row in them; a note in no
// folder marked as not synced; what is at the workspace's top, in no
// section; Library's heading with its history and publishing; new notes
// landing in Library; the top never a drop target, and a move into no
// section asking first; a section's own history and deleted files;
// making a restricted folder with people; restricting a folder everyone has
// — and an open tab following it; sharing a private note; a move that lets
// more people see a note asking first, and one that narrows asking nothing;
// who is in a folder — adding, removing, the last person handing it on;
// a folder taken away elsewhere saying so; deleting one for everyone; an
// owner taking down a page published from a section they are not in; and
// what was stored from before the folder moved following it into Library.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
// `PORT` picks the vite server (default 1420).
const PORT = process.env.PORT ?? "1420";

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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`http://localhost:${PORT}/verify-harness/cloud.html?sections`);

const tid = (name) => page.locator(`[data-testid="${name}"]`);
const row = (path) => page.locator(`[data-tree-path="${path}"]`);
const dialog = (label) => page.locator(`[role="dialog"][aria-label="${label}"]`);
const calls = (cmd) => page.evaluate((c) => window.__cloud.calls.filter((k) => k.cmd === c), cmd);
const lastCall = async (cmd) => (await calls(cmd)).at(-1);
const versionCalls = (cmd) => page.evaluate((c) => window.__versions.calls.filter((k) => k.cmd === c), cmd);
const moves = () => page.evaluate(() => window.__moves ?? []);
const openTabs = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("doklin:session")).sessions["/docs"].tabs.map((t) => t.path));
const menuOn = async (locator) => {
  await locator.click({ button: "right" });
  await poll(async () => (await page.locator(".sidebar-menu-item").count()) > 0);
  return page.locator(".sidebar-menu-item").allTextContents();
};
const pick = (label) => page.locator(".sidebar-menu-item", { hasText: label }).click();
const closeMenu = async () => {
  await page.keyboard.press("Escape");
  await poll(async () => (await page.locator(".context-menu, .sidebar-menu").count()) === 0).catch(() => {});
};
// A pointer drag of one tree row onto another element: the tree's own
// drag-to-move, which is built on pointer capture.
const drag = async (from, to) => {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 9, a.y + a.height / 2 + 9, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await settle(120);
  await page.mouse.up();
};

// A folder row's open state, and opening one (a click on its row).
const isOpen = async (path) => (await row(path).locator("xpath=..").getAttribute("aria-expanded")) === "true";
const openFolder = async (path) => {
  if (!(await isOpen(path))) await row(path).click();
  await poll(() => isOpen(path));
};

await poll(async () => (await page.locator(".sidebar").count()) === 1);
await poll(async () => (await row("/docs/Restricted/Finance").count()) === 1);

/* 0 — folders start closed, and stay as they were left: the ones opened are
      kept for the workspace, and still open when the tree is drawn again
      (here: off to Search and back, which unmounts it). */
const closedAtStart =
  !(await isOpen("/docs/Restricted/Finance")) &&
  !(await isOpen("/docs/Library/Projects")) &&
  (await row("/docs/Restricted/Finance/budget.md").count()) === 0 &&
  (await row("/docs/Library/Projects/plan.md").count()) === 0;
await openFolder("/docs/Restricted/Finance");
await openFolder("/docs/Library/Projects");
const storedTree = () => page.evaluate(() => localStorage.getItem("doklin:sidebar-tree"));
const storedOpen = await storedTree();
await page.locator(".sidebar-search").click();
await poll(async () => (await page.locator(".ws-search-input").count()) === 1);
const treeGone = (await page.locator('aside[aria-label="File browser"]').count()) === 0;
await page.locator('[title="Back to files"]').click();
await poll(async () => (await row("/docs/Restricted/Finance").count()) === 1);
step(
  "folders start closed; the ones opened are kept for the workspace and are still open when the tree is drawn again",
  closedAtStart &&
    storedOpen === '{"/docs":{"open":["Restricted/Finance","Library/Projects"],"folded":[]}}' &&
    treeGone &&
    (await isOpen("/docs/Restricted/Finance")) &&
    (await isOpen("/docs/Library/Projects")) &&
    (await row("/docs/Restricted/Finance/budget.md").count()) === 1 &&
    (await row("/docs/Library/Projects/plan.md").count()) === 1,
  storedOpen,
);

/* 0b — a list's heading folds it away: its rows go, how many it holds
      shows, and it stays folded when the tree is drawn again. The headings
      pin to the top of the tree while their rows scroll under them. */
const sharedRows = await tid("section-library").locator("ul.tree > li").count();
await tid("section-library-toggle").click();
await poll(async () => (await row("/docs/Library/notes.md").count()) === 0);
const foldedCount = (await tid("section-library-count").textContent()).trim();
const foldedStored = await storedTree();
await page.locator(".sidebar-search").click();
await poll(async () => (await page.locator(".ws-search-input").count()) === 1);
await page.locator('[title="Back to files"]').click();
await poll(async () => (await row("/docs/Restricted/Finance").count()) === 1);
const stillFolded =
  (await row("/docs/Library/notes.md").count()) === 0 &&
  (await tid("section-library-toggle").getAttribute("aria-expanded")) === "false";
await tid("section-library-toggle").click();
await poll(async () => (await row("/docs/Library/notes.md").count()) === 1);
const pinned = await tid("section-private")
  .locator(".tree-section-head")
  .evaluate((el) => getComputedStyle(el).position);
step(
  "a heading folds its list away, shows how many rows it holds, and stays folded when the tree is drawn again; headings pin while scrolling",
  sharedRows > 0 &&
    foldedCount === String(sharedRows) &&
    foldedStored === '{"/docs":{"open":["Restricted/Finance","Library/Projects"],"folded":["library"]}}' &&
    stillFolded &&
    (await row("/docs/Library/Projects/plan.md").count()) === 1 &&
    pinned === "sticky",
  `${foldedCount} rows folded · ${pinned}`,
);

/* 1 — three lists. On disk Library, Private and Restricted are three folders
      at the top of the workspace; here they are headings, with no row of
      their own, and nothing in the tree says "Workspace". */
const headings = [
  (await tid("section-library").locator(".sidebar-section-label").textContent()).trim(),
  (await tid("section-restricted").locator(".sidebar-section-label").textContent()).trim(),
  (await tid("section-private").locator(".sidebar-section-label").textContent()).trim(),
];
const inLibrary = await tid("section-library").locator("[data-tree-path]").evaluateAll((els) => els.map((e) => e.dataset.treePath));
const treeWords = await page.locator('aside[aria-label="File browser"] .sidebar-body').innerText();
const libraryTip = await tid("section-library-toggle").getAttribute("title");
step(
  "three lists — Library, Restricted, Private — and the three folders behind them are headings, not rows; the tree never says Workspace",
  headings.join("|") === "Library|Restricted|Private" &&
    libraryTip === "Hide Library" &&
    !/workspace/i.test(treeWords) &&
    inLibrary.includes("/docs/Library/notes.md") &&
    inLibrary.includes("/docs/Library/Projects") &&
    inLibrary.every((p) => p.startsWith("/docs/Library/")) &&
    (await row("/docs/Library").count()) === 0 &&
    (await row("/docs/Private").count()) === 0 &&
    (await row("/docs/Restricted").count()) === 0 &&
    (await tid("section-restricted").locator('[data-tree-path="/docs/Restricted/Finance"]').count()) === 1 &&
    (await tid("section-private").locator('[data-tree-path="/docs/Private/journal.md"]').count()) === 1,
  headings.join(" | "),
);

/* 2 — a restricted folder says how many people are in it; a note straight
      under Restricted is in no folder, and says it goes nowhere. */
const financeCount = (await row("/docs/Restricted/Finance").locator('[data-testid="space-count"]').textContent()).trim();
const stray = await row("/docs/Restricted/stray.md").locator('[data-testid="tree-nowhere"]').textContent();
step(
  "a restricted folder shows how many people it holds; a note in no folder is marked not synced",
  financeCount === "· 2" &&
    stray.trim() === "not synced" &&
    (await row("/docs/Restricted/Finance/budget.md").locator('[data-testid="tree-nowhere"]').count()) === 0,
  `${financeCount} / ${stray}`,
);
await page.screenshot({ path: SHOTS + "sections-01-sidebar.png" });

/* 2b — what Finder or an agent put at the workspace's top is in no section:
       listed after the three lists, every row marked not synced and saying
       why, with no link, no way to restrict it and no Live chip. */
const sectionOrder = await page
  .locator(".sidebar-body > .tree-section")
  .evaluateAll((els) => els.map((e) => e.dataset.testid));
const strayLabel = (await tid("section-strays").locator(".sidebar-section-label").textContent()).trim();
const strayRows = await tid("section-strays")
  .locator("[data-tree-path]")
  .evaluateAll((els) => els.map((e) => e.dataset.treePath).sort());
const todoMark = row("/docs/todo.md").locator('[data-testid="tree-nowhere"]');
const todoMarkText = (await todoMark.textContent()).trim();
const todoMarkTitle = await todoMark.getAttribute("title");
const scratchMarked = await row("/docs/Scratch").locator('[data-testid="tree-nowhere"]').count();
const todoMenu = await menuOn(row("/docs/todo.md"));
await closeMenu();
const scratchMenu = await menuOn(row("/docs/Scratch"));
await closeMenu();
await row("/docs/todo.md").click();
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()) === "todo");
const strayChip = await tid("live-chip").count();
await row("/docs/Library/notes.md").click();
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()) === "notes");
await poll(async () => (await tid("live-chip").count()) === 1);
step(
  "in no section: what is at the workspace's top is listed after the three lists, each row not synced and saying why — no Copy link, no Restrict access…, no Live chip",
  sectionOrder.join(",") === "section-library,section-restricted,section-private,section-strays" &&
    strayLabel === "In no section" &&
    strayRows.join(",") === "/docs/Scratch,/docs/todo.md" &&
    todoMarkText === "not synced" &&
    todoMarkTitle === "In no section, so it stays on this Mac — move it into Library or Private" &&
    scratchMarked === 1 &&
    !todoMenu.includes("Copy link") &&
    !scratchMenu.includes("Restrict access…") &&
    strayChip === 0,
  `${strayRows.join(", ")} · ${todoMenu.join(" · ")}`,
);

/* 2c — Library's heading carries what the whole shared section has: its
       history (Library's own store), and publishing it. The workspace's top
       is in no section: its empty space makes things, and has no history
       or publishing of its own. */
const libraryMenu = await menuOn(tid("section-library-toggle"));
await pick("Library history");
await poll(async () => (await tid("workspace-history").count()) === 1);
const libraryHistoryRoot = (await versionCalls("versions_snapshots")).at(-1).args.root;
const libraryHistoryTitle = (await tid("workspace-history").locator(".modal-title").textContent()).trim();
await page.keyboard.press("Escape");
await poll(async () => (await tid("workspace-history").count()) === 0);
const libraryDeleted = (await versionCalls("versions_deleted")).at(-1).args.root;
await page.locator(".sidebar-body").dispatchEvent("contextmenu", { clientX: 40, clientY: 860, bubbles: true });
await poll(async () => (await page.locator(".sidebar-menu-item").count()) > 0);
const topMenu = await page.locator(".sidebar-menu-item").allTextContents();
await closeMenu();
await menuOn(tid("section-library-toggle"));
await pick("Publish Library");
await poll(async () => (await dialog("Publish folder").count()) === 1);
await poll(async () => /\d/.test(await tid("folder-count").textContent()));
const libraryCount = await tid("folder-count").textContent();
const libraryTitle = await tid("folder-title").inputValue();
await tid("folder-publish").click();
await poll(async () => (await dialog("Publish folder").count()) === 0);
const libraryPublish = (await lastCall("cloud_publish")).args;
const publishedMenu = await menuOn(tid("section-library-toggle"));
await closeMenu();
step(
  "Library's heading: Library history… over Library's own store, Publish Library… with Library's notes counted and the workspace's name; the workspace's top makes things and offers no history or publishing",
  libraryMenu.includes("Library history…") &&
    libraryMenu.includes("Publish Library…") &&
    !libraryMenu.some((t) => /workspace/i.test(t)) &&
    libraryHistoryRoot === "/docs/Library" &&
    libraryHistoryTitle === "Library history" &&
    libraryDeleted === "/docs/Library" &&
    topMenu.includes("New File…") &&
    !topMenu.some((t) => /history|Publish|Recently deleted/.test(t)) &&
    libraryCount.startsWith("Library — 4 notes will be public") &&
    libraryTitle === "Notes" &&
    libraryPublish.path === "/docs/Library" &&
    publishedMenu.includes("Edit publishing…"),
  `${libraryMenu.join(" · ")} // ${libraryCount.slice(0, 40)}`,
);
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  window.__setStatuses([{ ...s, public: [] }]);
});

/* 2d — a new note lands in Library, whatever would have put it at the
       workspace's top: nothing selected, or a stray selected. */
await page.locator(".sidebar-body").dispatchEvent("click");
await page.locator(".sidebar-new").click();
await poll(async () => (await tid("section-library").locator(".tree-create-input").count()) === 1);
await tid("section-library").locator(".tree-create-input").fill("Fresh");
await page.keyboard.press("Enter");
await poll(async () => (await tid("section-library").locator('[data-tree-path="/docs/Library/Fresh.md"]').count()) === 1);
const madeInLibrary = await page.evaluate(() => window.__fs.has("/docs/Library/Fresh.md") && !window.__fs.has("/docs/Fresh.md"));
await row("/docs/todo.md").click();
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()) === "todo");
await page.locator(".sidebar-new").click();
await poll(async () => (await page.locator(".tree-create-input").count()) === 1);
const fromStrayInLibrary = (await tid("section-library").locator(".tree-create-input").count()) === 1;
await page.keyboard.press("Escape");
await poll(async () => (await page.locator(".tree-create-input").count()) === 0);
step(
  "a new note with nothing selected, or with a stray at the top selected, is made in Library",
  madeInLibrary && fromStrayInLibrary,
);

/* 2d′ — no folder at the top of Library has a section's name: making one
        is refused in a sentence, and one Finder made says it is not synced. */
await tid("section-library").locator('[aria-label="New folder"]').click();
await poll(async () => (await tid("section-library").locator(".tree-create-input").count()) === 1);
await tid("section-library").locator(".tree-create-input").fill("private");
await page.keyboard.press("Enter");
await poll(async () => (await page.locator(".tree-create-error").count()) === 1);
const sectionNameRefused = (await page.locator(".tree-create-error").textContent()).trim();
const sectionNameNotMade = await page.evaluate(() => !window.__dirs.has("/docs/Library/private"));
await page.keyboard.press("Escape");
await poll(async () => (await page.locator(".tree-create-input").count()) === 0);
await page.evaluate(() => {
  window.__finderDirs = ["Restricted"];
  window.__emit("cloud-applied", { root: "/docs", paths: [] });
});
await poll(async () => (await row("/docs/Library/Restricted").count()) === 1);
const sectionNamedMark = await row("/docs/Library/Restricted").locator('[data-testid="tree-nowhere"]').getAttribute("title");
const ordinaryUnmarked = (await row("/docs/Library/Projects").locator('[data-testid="tree-nowhere"]').count()) === 0;
await page.evaluate(() => {
  window.__finderDirs = [];
  window.__emit("cloud-applied", { root: "/docs", paths: [] });
});
await poll(async () => (await row("/docs/Library/Restricted").count()) === 0);
step(
  "a folder in Library is not called Library, Private or Restricted: making one is refused, and one Finder made is marked not synced",
  sectionNameRefused === "A folder in Library can't be called Library, Private or Restricted." &&
    sectionNameNotMade &&
    sectionNamedMark === "A folder in Library with a section's name stays on this Mac — rename it" &&
    ordinaryUnmarked,
  `${sectionNameRefused} // ${sectionNamedMark}`,
);

/* 2e — nothing is dropped at the workspace's top; a note dropped into a
       folder in no section is asked about first: it would stop syncing and
       leave every other device. */
const movesAtTop = (await moves()).length;
await drag(row("/docs/Library/Fresh.md"), tid("section-strays").locator(".sidebar-section-label"));
await settle();
const noDropAtTop = (await moves()).length === movesAtTop && (await tid("question-prompt").count()) === 0;
await drag(row("/docs/Library/Fresh.md"), row("/docs/Scratch"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const nowhereAsk = await tid("question-prompt").innerText();
await tid("question-no").click();
await poll(async () => (await tid("question-prompt").count()) === 0);
step(
  "the top is never a drop target; a move into a folder in no section asks first, and Cancel moves nothing",
  noDropAtTop &&
    nowhereAsk.includes("Move “Fresh” to “Scratch”?") &&
    nowhereAsk.includes("Nothing there syncs: it stays on this Mac and is removed from every other device.") &&
    (await moves()).length === movesAtTop &&
    (await row("/docs/Library/Fresh.md").count()) === 1,
  nowhereAsk.replace(/\n/g, " "),
);

/* 3 — a restricted folder is not cut or trashed like the rows beside it, and
      it has a history and a deleted list of its own. */
const folderMenu = await menuOn(row("/docs/Restricted/Finance"));
await pick("Folder history");
await poll(async () => (await tid("workspace-history").count()) === 1);
const historyRoot = (await versionCalls("versions_snapshots")).at(-1).args.root;
await page.keyboard.press("Escape");
await poll(async () => (await tid("workspace-history").count()) === 0);
await menuOn(row("/docs/Restricted/Finance"));
await pick("Recently deleted");
await poll(async () => (await tid("recently-deleted").count()) === 1);
const deletedRoot = (await versionCalls("versions_deleted")).at(-1).args.root;
await page.locator('.ws-deleted [title="Back to files"]').click();
await poll(async () => (await row("/docs/Restricted/Finance").count()) === 1);
step(
  "a restricted folder's menu: Manage access…, its own history and deleted files, Rename — and no Cut, no Delete",
  folderMenu.includes("Manage access…") &&
    folderMenu.includes("Folder history…") &&
    folderMenu.includes("Rename…") &&
    folderMenu.includes("Copy") &&
    !folderMenu.includes("Cut") &&
    !folderMenu.includes("Delete") &&
    !folderMenu.includes("Restrict access…") &&
    historyRoot === "/docs/Restricted/Finance" &&
    deletedRoot === "/docs/Restricted/Finance",
  folderMenu.join(" · "),
);

/* 3b — Copy link: a note in a section copies the link that opens it in
       Doklin, and says who can open it; a note in no section has none. */
const copied = async (path) => {
  await menuOn(row(path));
  await pick("Copy link");
  await poll(async () => (await page.locator(".toast").count()) === 1);
  const toast = (await page.locator(".toast").textContent()).trim();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await page.locator(".toast-close").click();
  await poll(async () => (await page.locator(".toast").count()) === 0);
  return { toast, clip, asked: (await lastCall("cloud_link")).args.path };
};
const sharedLink = await copied("/docs/Library/notes.md");
const financeLink = await copied("/docs/Restricted/Finance/budget.md");
const privateLink = await copied("/docs/Private/journal.md");
const strayMenu = await menuOn(row("/docs/Restricted/stray.md"));
await closeMenu();
step(
  "Copy link on a note: the link goes on the clipboard and the toast says who can open it — everyone, a folder's people, only you; a note in no folder has none",
  sharedLink.asked === "/docs/Library/notes.md" &&
    sharedLink.clip.startsWith("https://doklin.cc/open#d=notes.example.com&w=w-1&f=f-") &&
    sharedLink.toast.includes("Link copied. Everyone in Notes can open it.") &&
    financeLink.clip.includes("&s=s-finance0&") &&
    financeLink.toast.includes("Only the people in “Finance” can open it.") &&
    privateLink.toast.includes("Only you can open it") &&
    !strayMenu.includes("Copy link"),
  [sharedLink.toast, financeLink.toast, privateLink.toast].join(" / "),
);

/* 4 — New restricted folder…: a name, and who is in it. */
await tid("section-restricted").hover();
await tid("new-restricted").click();
await poll(async () => (await dialog("New restricted folder").count()) === 1);
await poll(async () => (await tid("restricted-people").count()) === 1);
const createDisabledEmpty = await tid("restricted-create").isDisabled();
await tid("restricted-name").fill("Plans");
await tid("restricted-pick-m-bob").check();
await tid("restricted-create").click();
await poll(async () => (await row("/docs/Restricted/Plans").count()) === 1);
const made = (await lastCall("cloud_space_create")).args;
step(
  "New restricted folder…: nothing without a name; made with the people picked, it is in the list at once with its count",
  createDisabledEmpty &&
    made.name === "Plans" &&
    JSON.stringify(made.members) === '["m-bob"]' &&
    made.from == null &&
    (await dialog("New restricted folder").count()) === 0 &&
    (await row("/docs/Restricted/Plans").locator('[data-testid="space-count"]').textContent()).trim() === "· 2",
);

/* 5 — dragging a folder everyone has onto Restricted restricts it, and says
      what that means before anything moves. */
await drag(row("/docs/Library/Projects"), tid("section-restricted").locator(".sidebar-section-label"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const restrictAsk = await tid("question-prompt").innerText();
await tid("question-no").click();
await poll(async () => (await tid("question-prompt").count()) === 0);
step(
  "a folder dropped on Restricted: asked first, in words — and Cancel moves nothing",
  restrictAsk.includes("Restrict “Projects”?") &&
    restrictAsk.includes("removed from everyone else’s devices") &&
    (await moves()).length === 0 &&
    (await row("/docs/Library/Projects").count()) === 1,
  restrictAsk.replace(/\n/g, " "),
);

/* 6 — Restrict access… on the same folder: it becomes a restricted folder
      holding the people picked, and a tab open inside it follows it there. */
await row("/docs/Library/Projects/plan.md").click();
await poll(async () => (await openTabs()).includes("/docs/Library/Projects/plan.md"));
const sharedMenu = await menuOn(row("/docs/Library/Projects"));
await pick("Restrict access");
await poll(async () => (await dialog("Restrict access to “Projects”").count()) === 1);
await poll(async () => (await tid("restricted-people").count()) === 1);
const prefilled = await tid("restricted-name").inputValue();
const alone = (await tid("restricted-effect").textContent()).trim();
await tid("restricted-pick-m-carol").check();
const withCarol = (await tid("restricted-effect").textContent()).trim();
await tid("restricted-create").click();
await poll(async () => (await row("/docs/Restricted/Projects").count()) === 1);
const restricted = (await lastCall("cloud_space_create")).args;
await poll(async () => (await openTabs()).includes("/docs/Restricted/Projects/plan.md"));
step(
  "Restrict access…: the folder's own name, who will have it said as they are picked; the folder leaves the workspace list for Restricted, and the tab open in it follows",
  sharedMenu.includes("Restrict access…") &&
    prefilled === "Projects" &&
    alone.startsWith("Only you will have it.") &&
    withCarol.startsWith("You and Carol will have it.") &&
    restricted.from === "/docs/Library/Projects" &&
    JSON.stringify(restricted.members) === '["m-carol"]' &&
    (await row("/docs/Library/Projects").count()) === 0 &&
    !(await openTabs()).includes("/docs/Library/Projects/plan.md"),
  `${alone} → ${withCarol}`,
);

/* 7 — Share with… on a private note: it goes into a new restricted folder
      with somebody — there are no per-note permissions. */
const privateMenu = await menuOn(row("/docs/Private/journal.md"));
await pick("Share with");
await poll(async () => (await dialog("Share “journal”").count()) === 1);
await poll(async () => (await tid("restricted-people").count()) === 1);
const shareNeedsSomebody = await tid("restricted-create").isDisabled();
await tid("restricted-pick-m-bob").check();
await tid("restricted-create").click();
await poll(async () => (await row("/docs/Restricted/journal").count()) === 1);
await openFolder("/docs/Restricted/journal");
await poll(async () => (await row("/docs/Restricted/journal/journal.md").count()) === 1);
const shared = (await lastCall("cloud_space_create")).args;
const sharedMove = (await moves()).at(-1);
step(
  "Share with…: nobody picked, nothing to share; with somebody, the note moves into a new folder that holds the two of you",
  privateMenu.includes("Share with…") &&
    shareNeedsSomebody &&
    shared.name === "journal" &&
    JSON.stringify(shared.members) === '["m-bob"]' &&
    shared.from == null &&
    sharedMove.from === "/docs/Private/journal.md" &&
    sharedMove.to === "/docs/Restricted/journal/journal.md" &&
    (await row("/docs/Private/journal.md").count()) === 0 &&
    !(await menuOn(row("/docs/Library/notes.md"))).includes("Share with…"),
);
await closeMenu();

/* 8 — a move that lets more people see a note asks first; one that narrows
      who sees it just happens. */
const movesBefore = (await moves()).length;
await poll(async () => (await row("/docs/Restricted/Finance/budget.md").count()) === 1);
await drag(row("/docs/Restricted/Finance/budget.md"), row("/docs/Library/other.md"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const widerAsk = await tid("question-prompt").innerText();
await tid("question-no").click();
await poll(async () => (await tid("question-prompt").count()) === 0);
const cancelledMoved = (await moves()).length - movesBefore;
await drag(row("/docs/Restricted/Finance/budget.md"), row("/docs/Library/other.md"));
await poll(async () => (await tid("question-prompt").count()) === 1);
await tid("question-yes").click();
await poll(async () => (await row("/docs/Library/budget.md").count()) === 1);
// Into Private: fewer people, no question.
await drag(row("/docs/Library/third.md"), tid("section-private").locator(".sidebar-section-label"));
await poll(async () => (await row("/docs/Private/third.md").count()) === 1);
// Into a folder with other people in it, from Private: asked.
await drag(row("/docs/Private/third.md"), row("/docs/Restricted/Plans"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const intoFolderAsk = await tid("question-prompt").innerText();
await tid("question-yes").click();
await poll(async () => (await row("/docs/Restricted/Plans/third.md").count()) === 1);
step(
  "moving a note where more people can see it asks first, naming them; Cancel moves nothing; narrowing who sees it asks nothing",
  widerAsk.includes("Move “budget” to Library?") &&
    widerAsk.includes("Everyone in Notes will be able to see it.") &&
    cancelledMoved === 0 &&
    intoFolderAsk.includes("Move “third” to “Plans”?") &&
    intoFolderAsk.includes("Both people in “Plans” will be able to see it."),
  `${widerAsk.replace(/\n/g, " ")} // ${intoFolderAsk.replace(/\n/g, " ")}`,
);

/* 9 — a note cannot be dropped straight under Restricted: it would be in no
      folder. */
await drag(row("/docs/Library/other.md"), tid("section-restricted").locator(".sidebar-section-label"));
await settle();
step(
  "a note dropped on the Restricted heading goes nowhere: there is no folder for it to be in",
  (await row("/docs/Library/other.md").count()) === 1 &&
    (await row("/docs/Restricted/other.md").count()) === 0 &&
    (await tid("question-prompt").count()) === 0,
);

/* 10 — Manage access…: who is in the folder, by name; anyone in it adds and
       removes people. */
await menuOn(row("/docs/Restricted/Finance"));
await pick("Manage access");
await poll(async () => (await dialog("Who can open “Finance”").count()) === 1);
await poll(async () => (await tid("space-addable").count()) === 1);
const membersBefore = await tid("space-members").innerText();
await tid("space-add-m-carol").click();
await poll(async () => (await tid("space-member-m-carol").count()) === 1);
const added = (await lastCall("cloud_space_member")).args;
const everyoneIn = await tid("space-everyone-in").count();
await tid("space-out-m-bob").click();
await tid("space-out-yes-m-bob").click();
await poll(async () => (await tid("space-member-m-bob").count()) === 0);
const removed = (await lastCall("cloud_space_member")).args;
step(
  "Manage access…: the people in it by name, you marked; adding one and removing one each change the list, and the count on the folder's row",
  membersBefore.includes("Sherin") &&
    membersBefore.includes("YOU") &&
    membersBefore.includes("Bob") &&
    added.memberId === "m-carol" &&
    added.add === true &&
    everyoneIn === 1 &&
    removed.memberId === "m-bob" &&
    removed.add === false &&
    (await tid("space-out-m-sherin").count()) === 0 &&
    (await row("/docs/Restricted/Finance").locator('[data-testid="space-count"]').textContent()).trim() === "· 2",
  membersBefore.replace(/\n/g, " "),
);
await page.screenshot({ path: SHOTS + "sections-02-access.png" });

/* 11 — the last person cannot just leave: the folder is handed to someone,
       or deleted. Handing it on leaves, and its going is not news here. */
await tid("space-out-m-carol").click();
await tid("space-out-yes-m-carol").click();
await poll(async () => (await tid("space-member-m-carol").count()) === 0);
await tid("space-leave").click();
await poll(async () => (await tid("space-last").count()) === 1);
const lastCard = await tid("space-last").innerText();
await tid("space-hand-m-bob").click();
await poll(async () => (await row("/docs/Restricted/Finance").count()) === 0);
await poll(async () => (await dialog("Who can open “Finance”").count()) === 0);
const handCalls = (await calls("cloud_space_member")).slice(-2).map((c) => [c.args.memberId, c.args.add]);
step(
  "the last person in a folder is asked — hand it to someone, or delete it; handed on, the folder leaves this Mac with no notice, because leaving was done here",
  lastCard.includes("You are the last person in “Finance”") &&
    JSON.stringify(handCalls) === '[["m-bob",true],["m-sherin",false]]' &&
    (await page.locator(".toast").count()) === 0,
  lastCard.replace(/\n/g, " "),
);

/* 12 — taken out of a folder by somebody else: its tabs close and a line
       says why it is gone. */
await poll(async () => (await openTabs()).includes("/docs/Restricted/Projects/plan.md"));
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  delete window.__sections.restricted.Projects;
  window.__setStatuses([{ ...s, spaces: s.spaces.filter((sp) => sp.path !== "Restricted/Projects") }]);
  window.__emit("cloud-space-left", { root: "/docs", name: "Projects", path: "Restricted/Projects" });
});
await poll(async () => (await page.locator(".toast").count()) === 1);
const leftToast = await page.locator(".toast").textContent();
await poll(async () => (await row("/docs/Restricted/Projects").count()) === 0);
await poll(async () => !(await openTabs()).includes("/docs/Restricted/Projects/plan.md"));
await page.locator(".toast-close").click();
step(
  "a folder that left because of somebody else: a line names it and says why, and the tab of a note in it closes",
  leftToast.includes("“Projects” is no longer on this Mac") &&
    leftToast.includes("you were taken out of it, or it was deleted"),
  leftToast,
);

/* 13 — Delete it for everyone: said in full before it happens. */
await menuOn(row("/docs/Restricted/Plans"));
await pick("Manage access");
await poll(async () => (await dialog("Who can open “Plans”").count()) === 1);
await tid("space-delete").click();
await poll(async () => (await tid("space-delete-confirm").count()) === 1);
const deleteAsk = await tid("space-delete-confirm").innerText();
await tid("space-delete-yes").click();
await poll(async () => (await row("/docs/Restricted/Plans").count()) === 0);
await poll(async () => (await dialog("Who can open “Plans”").count()) === 0);
step(
  "Delete it for everyone: what goes, and from where, is said first; then the folder is gone here, quietly",
  deleteAsk.includes("Delete “Plans” for everyone in it?") &&
    deleteAsk.includes("erased from the cloud") &&
    deleteAsk.includes("cannot be undone") &&
    (await calls("cloud_space_delete")).length === 1 &&
    (await page.locator(".toast").count()) === 0,
  deleteAsk.replace(/\n/g, " "),
);

/* 14 — an owner sees every public address: the pages they can open, and —
       told only what the address tells anyone — the ones they cannot, each
       of which they can take down. The home page is one of the shared ones. */
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  const page = (slug, path) => ({ slug, kind: "file", path, title: null, desc: null, by: "Sherin", at: Date.now(), alive: true, root: false });
  window.__setStatuses([{ ...s, public: [page("notes", "Library/notes.md"), page("journal", "Restricted/journal/journal.md")] }]);
});
await tid("sync-status").click();
await poll(async () => (await tid("published-pages").count()) === 1);
await tid("published-pages").click();
await poll(async () => (await tid("published-elsewhere-row").count()) === 1);
const elsewhere = await tid("published-elsewhere-row").innerText();
const homeButtons = await tid("published-home").count();
await tid("published-takedown").click();
await tid("published-takedown-yes").click();
await poll(async () => (await tid("published-elsewhere-row").count()) === 0);
step(
  "Published pages, for an owner: the ones they can open (only a shared one can be the home page), and one from a section they are not in — its title, its address, who — taken down",
  (await tid("published-row").count()) === 2 &&
    homeButtons === 1 &&
    elsewhere.includes("Private") &&
    elsewhere.includes("/carols-notes") &&
    elsewhere.includes("Carol") &&
    (await lastCall("cloud_page_take_down")).args.slug === "carols-notes",
  elsewhere.replace(/\n/g, " "),
);
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Published pages").count()) === 0);

/* 15 — what was stored about the folder from before it moved into the
       Library layout moves after it, once, when the folder is opened: the
       open note, the open folders, the folded list — and the folder is
       recorded as done. (A page of its own: cloud.html starts every load
       with nothing stored.) */
const before = await context.newPage();
before.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await before.goto(`http://localhost:${PORT}/verify-harness/cloud.html?sections&before-move`);
await poll(async () => (await before.locator(".ProseMirror h1").first().textContent().catch(() => ""))?.includes("Notes"));
await poll(async () => (await before.locator('[data-testid="section-library-toggle"]').count()) === 1);
const movedStore = await before.evaluate(() => ({
  tabs: JSON.parse(localStorage.getItem("doklin:session")).sessions["/docs"].tabs.map((t) => t.path),
  tree: localStorage.getItem("doklin:sidebar-tree"),
  done: localStorage.getItem("doklin:library-layout"),
}));
const libraryFoldedAfter = (await before.locator('[data-testid="section-library-toggle"]').getAttribute("aria-expanded")) === "false";
await before.locator('[data-testid="section-library-toggle"]').click();
await poll(async () => (await before.locator('[data-tree-path="/docs/Library/Projects/plan.md"]').count()) === 1);
step(
  "stored from before the move: the open note, the open folders and the folded list follow the folder into Library, once, and it is recorded",
  movedStore.tabs.join() === "/docs/Library/notes.md" &&
    movedStore.tree === '{"/docs":{"open":["Library/Projects","Restricted/Finance"],"folded":["library"]}}' &&
    movedStore.done === '["/docs"]' &&
    libraryFoldedAfter,
  JSON.stringify(movedStore),
);
await before.close();

await settle();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
