// Drives a workspace in sections in Chromium (cloud.html?sections boots the
// REAL <App/> connected to a scripted engine whose workspace has a My files
// with a folder shared from it, a folder and a document somebody else
// shared, and things in no section). What this proves: where a document is
// and who it is shared with decide who can open it, and every way of
// changing that says so first.
//
// The walk: the three lists and what is not a row in them; what is shared
// marked as shared, and what nobody shared marked as not synced; what is at
// the workspace's top, in no section; Library's heading with its history and
// publishing; new notes landing in Library; a folder in Library called what
// a section is called; the top never a drop target, and a move into no
// section asking first; Copy link and Copy path; sharing a folder where it
// is, and a document; who it is shared with — adding, stopping; the Share
// button above a document; what is shared with you — copied, never moved,
// and left; deleting a share for everyone and bringing it back; a move that
// lets more people open a note asking first, and one that takes a share
// into Library; a share taken away elsewhere saying so, and one moved
// elsewhere taking its open tab with it; an owner taking down a page
// published from a section they cannot open; empty space being the list it
// is in, and each heading making in its own list.
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

const MINE = "/docs/My files";
const SHARED = "/docs/Shared with me";
const tid = (name) => page.locator(`[data-testid="${name}"]`);
const row = (path) => page.locator(`[data-tree-path="${path}"]`);
const dialog = (label) => page.locator(`[role="dialog"][aria-label="${label}"]`);
const calls = (cmd) => page.evaluate((c) => window.__cloud.calls.filter((k) => k.cmd === c), cmd);
const lastCall = async (cmd) => (await calls(cmd)).at(-1);
const versionCalls = (cmd) => page.evaluate((c) => window.__versions.calls.filter((k) => k.cmd === c), cmd);
const moves = () => page.evaluate(() => window.__moves ?? []);
const spaces = () => page.evaluate(() => window.__cloud.statuses[0].spaces);
const openTabs = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("doklin:session")).sessions["/docs"].tabs.map((t) => t.path));
const menuOn = async (locator) => {
  await locator.click({ button: "right" });
  await poll(async () => (await page.locator(".sidebar-menu-item").count()) > 0);
  return page.locator(".sidebar-menu-item").allTextContents();
};
const pick = (label) => page.locator(".sidebar-menu-item", { hasText: label }).first().click();
const closeMenu = async () => {
  await page.keyboard.press("Escape");
  await poll(async () => (await page.locator(".context-menu, .sidebar-menu").count()) === 0).catch(() => {});
};
const noToast = async () => {
  for (const close of await page.locator(".toast-close").all()) await close.click().catch(() => {});
  await poll(async () => (await page.locator(".toast").count()) === 0);
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
const asked = async () => {
  await poll(async () => (await tid("question-prompt").count()) === 1);
  return (await tid("question-prompt").innerText()).replace(/\n/g, " ");
};
const answer = async (yes) => {
  await tid(yes ? "question-yes" : "question-no").click();
  await poll(async () => (await tid("question-prompt").count()) === 0);
};

// A folder row's open state, and opening one (a click on its row).
const isOpen = async (path) => (await row(path).locator("xpath=..").getAttribute("aria-expanded")) === "true";
const openFolder = async (path) => {
  if (!(await isOpen(path))) await row(path).click();
  await poll(() => isOpen(path));
};

await poll(async () => (await page.locator(".sidebar").count()) === 1);
await poll(async () => (await row(`${MINE}/Finance`).count()) === 1);

/* 0 — folders start closed, and stay as they were left: the ones opened are
      kept for the workspace, and still open when the tree is drawn again
      (here: off to Search and back, which unmounts it). */
const closedAtStart =
  !(await isOpen(`${MINE}/Finance`)) &&
  !(await isOpen("/docs/Library/Projects")) &&
  (await row(`${MINE}/Finance/budget.md`).count()) === 0 &&
  (await row("/docs/Library/Projects/plan.md").count()) === 0;
await openFolder(`${MINE}/Finance`);
await openFolder("/docs/Library/Projects");
const storedTree = () => page.evaluate(() => localStorage.getItem("doklin:sidebar-tree"));
const storedOpen = await storedTree();
await page.locator(".sidebar-search").click();
await poll(async () => (await page.locator(".ws-search-input").count()) === 1);
const treeGone = (await page.locator('aside[aria-label="File browser"]').count()) === 0;
await page.locator('[title="Back to files"]').click();
await poll(async () => (await row(`${MINE}/Finance`).count()) === 1);
step(
  "folders start closed; the ones opened are kept for the workspace and are still open when the tree is drawn again",
  closedAtStart &&
    storedOpen === '{"/docs":{"open":["My files/Finance","Library/Projects"],"folded":[]}}' &&
    treeGone &&
    (await isOpen(`${MINE}/Finance`)) &&
    (await isOpen("/docs/Library/Projects")) &&
    (await row(`${MINE}/Finance/budget.md`).count()) === 1 &&
    (await row("/docs/Library/Projects/plan.md").count()) === 1,
  storedOpen,
);

/* 0b — a list's heading folds it away: its rows go, how many it holds
      shows, and it stays folded when the tree is drawn again. The headings
      pin to the top of the tree while their rows scroll under them. */
const libraryRows = await tid("section-library").locator("ul.tree > li").count();
await tid("section-library-toggle").click();
await poll(async () => (await row("/docs/Library/notes.md").count()) === 0);
const foldedCount = (await tid("section-library-count").textContent()).trim();
const foldedStored = await storedTree();
await page.locator(".sidebar-search").click();
await poll(async () => (await page.locator(".ws-search-input").count()) === 1);
await page.locator('[title="Back to files"]').click();
await poll(async () => (await row(`${MINE}/Finance`).count()) === 1);
const stillFolded =
  (await row("/docs/Library/notes.md").count()) === 0 &&
  (await tid("section-library-toggle").getAttribute("aria-expanded")) === "false";
await tid("section-library-toggle").click();
await poll(async () => (await row("/docs/Library/notes.md").count()) === 1);
const pinned = await tid("section-mine")
  .locator(".tree-section-head")
  .evaluate((el) => getComputedStyle(el).position);
step(
  "a heading folds its list away, shows how many rows it holds, and stays folded when the tree is drawn again; headings pin while scrolling",
  libraryRows > 0 &&
    foldedCount === String(libraryRows) &&
    foldedStored === '{"/docs":{"open":["My files/Finance","Library/Projects"],"folded":["library"]}}' &&
    stillFolded &&
    (await row("/docs/Library/Projects/plan.md").count()) === 1 &&
    pinned === "sticky",
  `${foldedCount} rows folded · ${pinned}`,
);

/* 1 — three lists. On disk Library, My files and Shared with me are three
      folders at the top of the workspace; here they are headings, with no
      row of their own, and nothing in the tree says "Workspace". */
const headings = [
  (await tid("section-library").locator(".sidebar-section-label").textContent()).trim(),
  (await tid("section-mine").locator(".sidebar-section-label").textContent()).trim(),
  (await tid("section-shared").locator(".sidebar-section-label").textContent()).trim(),
];
const inLibrary = await tid("section-library").locator("[data-tree-path]").evaluateAll((els) => els.map((e) => e.dataset.treePath));
const treeWords = await page.locator('aside[aria-label="File browser"] .sidebar-body').innerText();
step(
  "three lists — Library, My files, Shared with me — and the three folders behind them are headings, not rows; the tree never says Workspace, Private or Restricted",
  headings.join("|") === "Library|My files|Shared with me" &&
    (await tid("section-library-toggle").getAttribute("title")) === "Hide Library" &&
    !/workspace|private|restricted/i.test(treeWords) &&
    inLibrary.includes("/docs/Library/notes.md") &&
    inLibrary.every((p) => p.startsWith("/docs/Library/")) &&
    (await row("/docs/Library").count()) === 0 &&
    (await row(MINE).count()) === 0 &&
    (await row(SHARED).count()) === 0 &&
    (await tid("section-mine").locator(`[data-tree-path="${MINE}/journal.md"]`).count()) === 1 &&
    (await tid("section-mine").locator(`[data-tree-path="${MINE}/Finance"]`).count()) === 1 &&
    (await tid("section-shared").locator(`[data-tree-path="${SHARED}/Board"]`).count()) === 1 &&
    (await tid("section-shared").locator(`[data-tree-path="${SHARED}/Roadmap.md"]`).count()) === 1,
  headings.join(" | "),
);

/* 2 — what is shared says so on its row, where it is: a folder this person
      shares, with how many people; what was shared with them. What sits
      under Shared with me and nobody shared goes nowhere, and says that. */
const mark = (path) => row(path).locator('[data-testid="tree-shared"]');
const financeMark = { text: (await mark(`${MINE}/Finance`).textContent()).trim(), title: await mark(`${MINE}/Finance`).getAttribute("title") };
const boardTitle = await mark(`${SHARED}/Board`).getAttribute("title");
const roadmapTitle = await mark(`${SHARED}/Roadmap.md`).getAttribute("title");
const strayMark = row(`${SHARED}/stray.md`).locator('[data-testid="tree-nowhere"]');
step(
  "what is shared is marked where it is — a folder of your own with how many people, what others shared as shared with you; a note nobody shared, under Shared with me, is marked not synced; nothing else is marked",
  financeMark.text === "1" &&
    financeMark.title === "Shared with 1 person" &&
    boardTitle === "Shared with you" &&
    roadmapTitle === "Shared with you" &&
    (await strayMark.textContent()).trim() === "not synced" &&
    (await strayMark.getAttribute("title")) === "Nobody shared this with you, so it stays on this Mac — move it into Library or My files" &&
    (await mark(`${MINE}/Work`).count()) === 0 &&
    (await mark(`${MINE}/journal.md`).count()) === 0 &&
    (await row(`${MINE}/Finance/budget.md`).locator('[data-testid="tree-nowhere"]').count()) === 0,
  `${financeMark.title} / ${boardTitle}`,
);
await page.screenshot({ path: SHOTS + "sections-01-sidebar.png" });

/* 2b — what Finder or an agent put at the workspace's top is in no section:
       listed after the three lists, every row marked not synced and saying
       why, with no link, no way to share it and no Live chip. */
const sectionOrder = await page
  .locator(".sidebar-body > .tree-section")
  .evaluateAll((els) => els.map((e) => e.dataset.testid));
const strayRows = await tid("section-strays")
  .locator("[data-tree-path]")
  .evaluateAll((els) => els.map((e) => e.dataset.treePath).sort());
const todoMark = row("/docs/todo.md").locator('[data-testid="tree-nowhere"]');
const todoMenu = await menuOn(row("/docs/todo.md"));
await closeMenu();
const scratchMenu = await menuOn(row("/docs/Scratch"));
await closeMenu();
await row("/docs/todo.md").click();
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()) === "todo");
const strayChips = (await tid("live-chip").count()) + (await tid("share-chip").count());
await row("/docs/Library/notes.md").click();
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()) === "notes");
await poll(async () => (await tid("live-chip").count()) === 1);
step(
  "in no section: what is at the workspace's top is listed after the three lists, each row not synced and saying why — no Copy link, no Share…, no chips above it",
  sectionOrder.join(",") === "section-library,section-mine,section-shared,section-strays" &&
    (await tid("section-strays").locator(".sidebar-section-label").textContent()).trim() === "In no section" &&
    strayRows.join(",") === "/docs/Scratch,/docs/todo.md" &&
    (await todoMark.getAttribute("title")) === "In no section, so it stays on this Mac — move it into Library or My files" &&
    (await row("/docs/Scratch").locator('[data-testid="tree-nowhere"]').count()) === 1 &&
    !todoMenu.includes("Copy link") &&
    !todoMenu.includes("Share…") &&
    !scratchMenu.includes("Share…") &&
    strayChips === 0,
  `${strayRows.join(", ")} · ${todoMenu.join(" · ")}`,
);

/* 2c — Library's heading carries what all of Library has: its history
       (Library's own store), and publishing it. Nothing in Library is shared
       on its own: it is everyone's. */
const libraryMenu = await menuOn(tid("section-library-toggle"));
await pick("Library history");
await poll(async () => (await tid("workspace-history").count()) === 1);
const libraryHistoryRoot = (await versionCalls("versions_snapshots")).at(-1).args.root;
const libraryHistoryTitle = (await tid("workspace-history").locator(".modal-title").textContent()).trim();
await page.keyboard.press("Escape");
await poll(async () => (await tid("workspace-history").count()) === 0);
await menuOn(tid("section-library-toggle"));
await pick("Publish Library");
await poll(async () => (await dialog("Publish folder").count()) === 1);
await poll(async () => /\d/.test(await tid("folder-count").textContent()));
const libraryCount = await tid("folder-count").textContent();
await tid("folder-publish").click();
await poll(async () => (await dialog("Publish folder").count()) === 0);
const libraryPublish = (await lastCall("cloud_publish")).args;
const libraryNoteMenu = await menuOn(row("/docs/Library/notes.md"));
await closeMenu();
const libraryFolderMenu = await menuOn(row("/docs/Library/Projects"));
await closeMenu();
step(
  "Library's heading: Library history… over Library's own store, Publish Library… with its notes counted; a note or a folder in Library has no Share…",
  libraryMenu.includes("Library history…") &&
    libraryMenu.includes("Publish Library…") &&
    !libraryMenu.some((t) => /workspace/i.test(t)) &&
    libraryHistoryRoot === "/docs/Library" &&
    libraryHistoryTitle === "Library history" &&
    libraryCount.startsWith("Library — 4 notes will be public") &&
    libraryPublish.path === "/docs/Library" &&
    !libraryNoteMenu.includes("Share…") &&
    !libraryFolderMenu.includes("Share…") &&
    (await tid("share-chip").count()) === 0,
  `${libraryMenu.join(" · ")} // ${libraryCount.slice(0, 40)}`,
);
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  window.__setStatuses([{ ...s, public: [] }]);
});

/* 2d — a new note lands in Library, whatever would have put it at the
       workspace's top: nothing selected, or a stray selected. It is made
       as Untitled and named by its title. */
const activeTab = () => page.locator(".tab.is-active .tab-label").textContent();
const docTitle = () => page.locator(".editor-pane.is-focused .doc-title textarea");
await page.locator(".sidebar-body").dispatchEvent("click");
await page.locator(".sidebar-new").click();
await poll(async () => (await tid("section-library").locator('[data-tree-path="/docs/Library/Untitled.md"]').count()) === 1);
await poll(async () => (await activeTab()) === "Untitled" && (await docTitle().evaluate((el) => el === document.activeElement)));
await page.keyboard.type("Fresh");
await page.keyboard.press("Enter");
await poll(async () => (await tid("section-library").locator('[data-tree-path="/docs/Library/Fresh.md"]').count()) === 1);
const madeInLibrary = await page.evaluate(() => window.__fs.has("/docs/Library/Fresh.md") && !window.__fs.has("/docs/Fresh.md"));
await row("/docs/todo.md").click();
await poll(async () => (await activeTab()) === "todo");
await page.locator(".sidebar-new").click();
await poll(async () => (await activeTab()) === "Untitled");
const fromStrayInLibrary = await page.evaluate(() => window.__fs.has("/docs/Library/Untitled.md") && !window.__fs.has("/docs/Untitled.md"));
step(
  "a new note with nothing selected, or with a stray at the top selected, is made in Library as Untitled, with the caret in its title; typing there names it",
  madeInLibrary && fromStrayInLibrary,
);

/* 2d′ — inside Library a folder is called what its people like: a section's
        name is its own only at the top of the workspace. */
await tid("section-library").locator('[aria-label="New folder"]').click();
await poll(async () => (await tid("section-library").locator(".tree-create-input").count()) === 1);
await tid("section-library").locator(".tree-create-input").fill("My files");
await page.keyboard.press("Enter");
await poll(async () => (await page.locator(".tree-create-input").count()) === 0);
await page.evaluate(() => {
  window.__finderDirs = ["Shared with me"];
  window.__emit("cloud-applied", { root: "/docs", paths: [] });
});
await poll(async () => (await row("/docs/Library/Shared with me").count()) === 1);
const namedLikeASection = (await row("/docs/Library/Shared with me").locator('[data-testid="tree-nowhere"]').count()) === 0;
await page.evaluate(() => {
  window.__finderDirs = [];
  window.__emit("cloud-applied", { root: "/docs", paths: [] });
});
await poll(async () => (await row("/docs/Library/Shared with me").count()) === 0);
step(
  "a folder in Library may be called what a section is called: it is made, and one that is there is an ordinary folder",
  (await page.evaluate(() => window.__dirs.has("/docs/Library/My files"))) && namedLikeASection,
);

/* 2e — nothing is dropped at the workspace's top, or straight under Shared
       with me; a note dropped into a folder in no section is asked about
       first: it would stop syncing and leave every other device. */
const movesAtTop = (await moves()).length;
await drag(row("/docs/Library/Fresh.md"), tid("section-strays").locator(".sidebar-section-label"));
await settle();
await drag(row("/docs/Library/Fresh.md"), tid("section-shared").locator(".sidebar-section-label"));
await settle();
const noDropThere = (await moves()).length === movesAtTop && (await tid("question-prompt").count()) === 0;
await drag(row("/docs/Library/Fresh.md"), row("/docs/Scratch"));
const nowhereAsk = await asked();
await answer(false);
step(
  "the top and Shared with me are never drop targets; a move into a folder in no section asks first, and Cancel moves nothing",
  noDropThere &&
    nowhereAsk.includes("Move “Fresh” to “Scratch”?") &&
    nowhereAsk.includes("Nothing there syncs: it stays on this Mac and is removed from every other device.") &&
    (await moves()).length === movesAtTop &&
    (await row("/docs/Library/Fresh.md").count()) === 1,
  nowhereAsk,
);

/* 3 — Copy link: a note in a section copies the link that opens it in
      Doklin, and says who can open it; a note in no section has none.
      Copy path: what an agent's `doklin` names it by. */
const copied = async (path, item) => {
  await menuOn(row(path));
  await pick(item);
  await poll(async () => (await page.locator(".toast").count()) === 1);
  const toast = (await page.locator(".toast").textContent()).trim();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await noToast();
  return { toast, clip };
};
const libraryLink = await copied("/docs/Library/notes.md", "Copy link");
const financeLink = await copied(`${MINE}/Finance/budget.md`, "Copy link");
const journalLink = await copied(`${MINE}/journal.md`, "Copy link");
const roadmapLink = await copied(`${SHARED}/Roadmap.md`, "Copy link");
const strayMenu = await menuOn(row(`${SHARED}/stray.md`));
await closeMenu();
const paths = [];
for (const p of ["/docs/Library/notes.md", `${MINE}/Finance/budget.md`, `${MINE}/Finance`, `${SHARED}/Board`, `${SHARED}/Roadmap.md`]) {
  paths.push((await copied(p, "Copy path")).clip);
}
step(
  "Copy link says who can open it — everyone, the people a folder or a document is shared with, only you; Copy path names it as doklin does, in the new sections; what nobody shared has neither",
  libraryLink.toast.includes("Link copied. Everyone in Notes can open it.") &&
    financeLink.clip.includes("&s=s-finance0&") &&
    financeLink.toast.includes("Only the people “Finance” is shared with can open it.") &&
    journalLink.toast.includes("Only you can open it") &&
    roadmapLink.clip.includes("&s=s-roadmap0&") &&
    roadmapLink.toast.includes("Only the people “Roadmap” is shared with can open it.") &&
    !strayMenu.includes("Copy link") &&
    !strayMenu.includes("Copy path") &&
    paths.join("|") === "Library/notes|My files/Finance/budget|My files/Finance/|Shared with me/Board/|Shared with me/Roadmap",
  `${paths.join(" · ")} // ${financeLink.toast}`,
);

/* 4 — Share… on a folder in My files: it stays where it is, nobody picked
      is nothing to share, and shared it is marked where it sits. */
const workMenu = await menuOn(row(`${MINE}/Work`));
await pick("Share…");
await poll(async () => (await dialog("Share “Work”").count()) === 1);
await poll(async () => (await tid("share-people").count()) === 1);
const shareHint = (await tid("share-hint").textContent()).trim();
const nobodyPicked = await tid("share-submit").isDisabled();
await tid("share-pick-m-bob").check();
await tid("share-submit").click();
await poll(async () => (await tid("share-members").count()) === 1);
const sharedWork = (await lastCall("cloud_share")).args;
const workMembers = await tid("share-members").innerText();
step(
  "Share… on a folder of your own: it stays where it is; nothing without somebody picked; shared, the dialog lists who can open it — you, its owner, and who it is shared with",
  workMenu.includes("Share…") &&
    shareHint.includes("It stays where it is.") &&
    shareHint.includes("Shared with me") &&
    nobodyPicked &&
    sharedWork.path === `${MINE}/Work` &&
    JSON.stringify(sharedWork.members) === '["m-bob"]' &&
    (await moves()).length === movesAtTop &&
    workMembers.includes("Sherin") &&
    /owner/i.test(workMembers) &&
    workMembers.includes("Bob") &&
    (await row(`${MINE}/Work`).count()) === 1 &&
    (await mark(`${MINE}/Work`).getAttribute("title")) === "Shared with 1 person",
  `${shareHint.slice(0, 60)} // ${workMembers.replace(/\n/g, " ")}`,
);
await page.screenshot({ path: SHOTS + "sections-04-share.png" });

/* 5 — who it is shared with: one more person, and stopping with one —
      asked first, since their devices delete their copy. */
await tid("share-add-m-carol").click();
await poll(async () => (await tid("share-member-m-carol").count()) === 1);
const addedCarol = (await lastCall("cloud_share_member")).args;
await tid("share-out-m-bob").click();
await poll(async () => (await tid("share-out-yes-m-bob").count()) === 1);
const outAsk = await tid("share-member-m-bob").innerText();
await tid("share-out-yes-m-bob").click();
await poll(async () => (await tid("share-member-m-bob").count()) === 0);
const outBob = (await lastCall("cloud_share_member")).args;
const noLeaveForOwner = (await tid("share-leave").count()) === 0 && (await tid("share-delete").count()) === 1;
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Share “Work”").count()) === 0);
step(
  "the Share dialog adds a person at once, and stops sharing with one after saying their devices delete their copy; its owner has Delete it for everyone and no Leave",
  addedCarol.memberId === "m-carol" &&
    addedCarol.add === true &&
    outAsk.includes("Their devices delete their copy of it.") &&
    outBob.memberId === "m-bob" &&
    outBob.add === false &&
    noLeaveForOwner &&
    (await mark(`${MINE}/Work`).getAttribute("title")) === "Shared with 1 person",
);

/* 6 — a document is shared on its own, from its row or from the Share
      button above it, which says who can open it. */
await row(`${MINE}/plan.md`).click();
await poll(async () => (await activeTab()) === "plan");
await poll(async () => (await tid("share-chip").count()) === 1);
const chipAlone = (await tid("share-chip").textContent()).trim();
await tid("share-chip").click();
await poll(async () => (await dialog("Share “plan”").count()) === 1);
await poll(async () => (await tid("share-people").count()) === 1);
await tid("share-pick-m-bob").check();
await tid("share-pick-m-carol").check();
await tid("share-submit").click();
await poll(async () => (await tid("share-members").count()) === 1);
const sharedPlan = (await lastCall("cloud_share")).args;
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Share “plan”").count()) === 0);
const chipShared = (await tid("share-chip").textContent()).trim();
const planSpace = (await spaces()).find((sp) => sp.path === "My files/plan");
await row(`${MINE}/Finance/budget.md`).click();
await poll(async () => (await activeTab()) === "budget");
const chipInFolder = (await tid("share-chip").textContent()).trim();
await tid("share-chip").click();
await poll(async () => (await dialog("Share “budget”").count()) === 1);
const nestedHint = (await tid("share-hint").textContent()).trim();
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Share “budget”").count()) === 0);
step(
  "a document is shared on its own: the button above it says Share, then who can open it; one inside a shared folder says that folder's people can open it already",
  chipAlone === "Share" &&
    sharedPlan.path === `${MINE}/plan.md` &&
    JSON.stringify(sharedPlan.members) === '["m-bob","m-carol"]' &&
    planSpace?.kind === "document" &&
    chipShared === "You and 2 others" &&
    (await mark(`${MINE}/plan.md`).getAttribute("title")) === "Shared with 2 people" &&
    chipInFolder === "You and 1 other" &&
    nestedHint.includes("Everyone who can open “Finance” can open it already."),
  `${chipAlone} → ${chipShared} // ${chipInFolder}`,
);

/* 7 — what is shared with you sits where its owner keeps it: it is not
      dragged or cut, it is copied into your own files, and it is left —
      asked first — not deleted. */
const boardMenu = await menuOn(row(`${SHARED}/Board`));
await closeMenu();
const movesBeforeBoard = (await moves()).length;
await drag(row(`${SHARED}/Board`), tid("section-mine").locator(".sidebar-section-label"));
await settle();
const boardStayed = (await moves()).length === movesBeforeBoard && (await row(`${SHARED}/Board`).count()) === 1;
await menuOn(row(`${SHARED}/Roadmap.md`));
await pick("Copy to My files");
await poll(async () => (await row(`${MINE}/Roadmap.md`).count()) === 1);
const copiedTo = await page.evaluate(() => (window.__copies ?? []).at(-1));
await noToast();
await menuOn(row(`${SHARED}/Board`));
await pick("Leave…");
const leaveAsk = await asked();
await answer(false);
const stillThere = (await row(`${SHARED}/Board`).count()) === 1 && (await calls("cloud_share_member")).length === 2;
await menuOn(row(`${SHARED}/Board`));
await pick("Leave…");
await asked();
await answer(true);
await poll(async () => (await row(`${SHARED}/Board`).count()) === 0);
const left = (await lastCall("cloud_share_member")).args;
step(
  "what is shared with you: Share…, Copy to My files and Leave… — no Cut, no Delete, and it is not dragged away; the copy is an ordinary note of your own; leaving asks first, and then it goes quietly",
  boardMenu.includes("Share…") &&
    boardMenu.includes("Copy to My files") &&
    boardMenu.includes("Leave…") &&
    boardMenu.includes("Rename…") &&
    !boardMenu.includes("Cut") &&
    !boardMenu.includes("Delete") &&
    !boardMenu.includes("Delete for everyone…") &&
    boardStayed &&
    copiedTo.from === `${SHARED}/Roadmap.md` &&
    copiedTo.to === `${MINE}/Roadmap.md` &&
    (await mark(`${MINE}/Roadmap.md`).count()) === 0 &&
    leaveAsk.includes("Leave “Board”?") &&
    leaveAsk.includes("The others keep theirs.") &&
    stillThere &&
    left.id === "s-board000" &&
    left.memberId === "m-sherin" &&
    left.add === false &&
    (await page.locator(".toast").count()) === 0,
  `${boardMenu.join(" · ")} // ${leaveAsk}`,
);

/* 8 — deleting something you share is for everyone, and says who loses it;
      it is kept thirty days, and comes back from My files' deleted list. */
const financeMenu = await menuOn(row(`${MINE}/Finance`));
await pick("Delete for everyone…");
const deleteAsk = await asked();
await answer(true);
await poll(async () => (await row(`${MINE}/Finance`).count()) === 0);
const deleted = (await lastCall("cloud_share_delete")).args;
// The one delete with no Trash behind it offers the way back at once, and
// says nothing of it having been taken away.
await poll(async () => (await page.locator(".toast").count()) === 1);
const deletedToast = await page.locator(".toast").innerText();
const quiet = deletedToast.includes("“Finance” is deleted for everyone, and kept for 30 days.") && /Restore/.test(deletedToast);
await noToast();
await menuOn(tid("section-mine-toggle"));
await pick("Recently deleted");
await poll(async () => (await tid("recently-deleted").count()) === 1);
await poll(async () => (await tid("deleted-share").count()) === 1);
const deletedRow = await tid("deleted-share").innerText();
const deletedRoots = (await versionCalls("versions_deleted")).map((c) => c.args.root);
await tid("deleted-share-restore").click();
await poll(async () => (await tid("deleted-share").count()) === 0);
const restored = (await lastCall("cloud_share_restore")).args;
await noToast();
await page.locator('.ws-deleted [title="Back to files"]').click();
await poll(async () => (await row(`${MINE}/Finance`).count()) === 1);
step(
  "Delete for everyone… on a folder you share: asked first, naming who loses it and that it is kept 30 days; a notice offers Restore; then it is in My files' Recently deleted — with the files of the shared folders inside My files — and Restore brings it back",
  financeMenu.includes("Delete for everyone…") &&
    financeMenu.includes("Cut") &&
    financeMenu.includes("Folder history…") &&
    !financeMenu.includes("Delete") &&
    deleteAsk.includes("Delete “Finance” for everyone?") &&
    deleteAsk.includes("the other person who can open it") &&
    deleteAsk.includes("Recently deleted for 30 days") &&
    deleted.id === "s-finance0" &&
    quiet &&
    deletedRow.includes("Finance") &&
    deletedRow.includes("shared folder") &&
    deletedRoots.includes(MINE) &&
    deletedRoots.includes(`${MINE}/Work`) &&
    restored.id === "s-finance0" &&
    (await mark(`${MINE}/Finance`).getAttribute("title")) === "Shared with 1 person",
  `${deleteAsk} // ${deletedRow.replace(/\n/g, " ")}`,
);

/* 9 — a move that lets more people open a note asks first, naming them;
      one that narrows who can asks nothing. */
await openFolder(`${MINE}/Finance`);
const movesBefore = (await moves()).length;
await drag(row(`${MINE}/journal.md`), row(`${MINE}/Finance`));
const intoShareAsk = await asked();
await answer(false);
const cancelledMoved = (await moves()).length - movesBefore;
await drag(row(`${MINE}/journal.md`), row("/docs/Library/other.md"));
const intoLibraryAsk = await asked();
await answer(true);
await poll(async () => (await row("/docs/Library/journal.md").count()) === 1);
// Into My files: fewer people, no question.
await drag(row("/docs/Library/third.md"), tid("section-mine").locator(".sidebar-section-label"));
await poll(async () => (await row(`${MINE}/third.md`).count()) === 1);
const narrowedQuietly = (await tid("question-prompt").count()) === 0;
// Out of a shared folder into My files: fewer people too.
await drag(row(`${MINE}/Finance/budget.md`), tid("section-mine").locator(".sidebar-section-label"));
await poll(async () => (await row(`${MINE}/budget.md`).count()) === 1);
step(
  "moving a note where more people can open it asks first, naming them; Cancel moves nothing; narrowing who can open it asks nothing",
  intoShareAsk.includes("Move “journal” to “Finance”?") &&
    intoShareAsk.includes("Both people who can open “Finance” will be able to open it.") &&
    cancelledMoved === 0 &&
    intoLibraryAsk.includes("Move “journal” to Library?") &&
    intoLibraryAsk.includes("Everyone in Notes will be able to open it.") &&
    narrowedQuietly &&
    (await tid("question-prompt").count()) === 0,
  `${intoShareAsk} // ${intoLibraryAsk}`,
);

/* 10 — something shared moved into Library is everyone's, and stops being
       shared on its own: said first. Moved inside My files it is the same
       share, and nothing is asked. */
await page.evaluate(() => {
  (window.__madeDirs ??= []).push("/docs/My files/Archive");
  window.__sections.lists["/docs/My files/Archive"] = [];
  window.__dirs.add("/docs/My files/Archive");
  window.__emit("cloud-applied", { root: "/docs", paths: [] });
});
await poll(async () => (await row(`${MINE}/Archive`).count()) === 1);
await drag(row(`${MINE}/Work`), row(`${MINE}/Archive`));
await poll(async () => (await row(`${MINE}/Archive/Work`).count()) === 1);
const movedInside = (await tid("question-prompt").count()) === 0 && (await spaces()).some((sp) => sp.path === "My files/Archive/Work");
const stillMarked = (await mark(`${MINE}/Archive/Work`).getAttribute("title")) === "Shared with 1 person";
await drag(row(`${MINE}/Archive`), row("/docs/Library/other.md"));
const endAsk = await asked();
await answer(true);
await poll(async () => (await row(`${MINE}/Archive`).count()) === 0);
step(
  "a shared folder moved inside My files is the same share, and nothing is asked; a folder that holds one, moved into Library, says everyone can open it and that the share inside stops being shared on its own",
  movedInside &&
    stillMarked &&
    endAsk.includes("Move “Archive” to Library?") &&
    endAsk.includes("Everyone in Notes will be able to open it.") &&
    endAsk.includes("“Work” stops being shared on its own.") &&
    !(await spaces()).some((sp) => sp.name === "Work"),
  endAsk,
);

/* 11 — something shared taken away elsewhere says so and closes its tabs;
       something shared that sync moved takes its open tab with it. */
await row(`${MINE}/plan.md`).click();
await poll(async () => (await activeTab()) === "plan");
await page.evaluate(() => {
  const sec = window.__sections;
  sec.lists["/docs/My files/Archive 2"] = ["plan.md"];
  sec.lists["/docs/My files"].splice(sec.lists["/docs/My files"].indexOf("plan.md"), 1);
  window.__fs.set("/docs/My files/Archive 2/plan.md", window.__fs.get("/docs/My files/plan.md"));
  window.__fs.delete("/docs/My files/plan.md");
  const s = window.__cloud.statuses[0];
  window.__setStatuses([{ ...s, spaces: s.spaces.map((sp) => (sp.path === "My files/plan" ? { ...sp, path: "My files/Archive 2/plan" } : sp)) }]);
  window.__emit("cloud-space-moved", { root: "/docs", moves: [{ from: "My files/plan.md", to: "My files/Archive 2/plan.md", dir: false }] });
});
await poll(async () => (await openTabs()).includes(`${MINE}/Archive 2/plan.md`));
const followed = !(await openTabs()).includes(`${MINE}/plan.md`) && (await activeTab()) === "plan";
await row(`${SHARED}/Roadmap.md`).click();
await poll(async () => (await activeTab()) === "Roadmap");
await page.evaluate(() => {
  const sec = window.__sections;
  sec.lists["/docs/Shared with me"].splice(sec.lists["/docs/Shared with me"].indexOf("Roadmap.md"), 1);
  const s = window.__cloud.statuses[0];
  window.__setStatuses([{ ...s, spaces: s.spaces.filter((sp) => sp.id !== "s-roadmap0") }]);
  window.__emit("cloud-space-left", { root: "/docs", name: "Roadmap", path: "Shared with me/Roadmap" });
});
await poll(async () => (await page.locator(".toast").count()) === 1);
const goneToast = (await page.locator(".toast").textContent()).trim();
await poll(async () => !(await openTabs()).includes(`${SHARED}/Roadmap.md`));
await noToast();
step(
  "a shared document that sync moved takes its open tab with it; one no longer shared with you closes its tab and says why",
  followed &&
    goneToast.includes("“Roadmap” is no longer on this Mac — it is no longer shared with you, or it was deleted.") &&
    (await row(`${SHARED}/Roadmap.md`).count()) === 0,
  goneToast,
);

/* 12 — an owner sees every public address: the pages they can open, and —
       told only what the address tells anyone — the ones they cannot, each
       of which they can take down. The home page is one of Library's. */
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  const page = (slug, path) => ({ slug, kind: "file", path, title: null, desc: null, by: "Sherin", at: Date.now(), alive: true, root: false });
  window.__setStatuses([{ ...s, public: [page("notes", "Library/notes.md"), page("third", "My files/third.md")] }]);
});
await tid("sync-status").click();
await poll(async () => (await tid("published-pages").count()) === 1);
await tid("published-pages").click();
await poll(async () => (await tid("published-elsewhere-row").count()) === 1);
const elsewhere = await tid("published-elsewhere-row").innerText();
const elsewhereNote = await dialog("Published pages").innerText();
const homeButtons = await tid("published-home").count();
await tid("published-takedown").click();
await tid("published-takedown-yes").click();
await poll(async () => (await tid("published-elsewhere-row").count()) === 0);
step(
  "Published pages, for an owner: the ones they can open (only one in Library can be the home page), and one from somebody's My files — its title, its address, who — taken down",
  (await tid("published-row").count()) === 2 &&
    homeButtons === 1 &&
    elsewhereNote.includes("Published from somebody’s My files or something shared.") &&
    elsewhere.includes("/carols-notes") &&
    elsewhere.includes("Carol") &&
    (await lastCall("cloud_page_take_down")).args.slug === "carols-notes",
  elsewhere.replace(/\n/g, " "),
);
await page.keyboard.press("Escape");
await poll(async () => (await dialog("Published pages").count()) === 0);

/* 13 — empty space is the list it is in. A right-click in My files' makes
       things there and offers its history; under Shared with me nothing is
       made, so there is no menu; each heading makes in its own list. */
const menuAt = async (x, y) => {
  await page.mouse.click(x, y, { button: "right" });
  await settle(150);
  const items = await page.locator(".sidebar-menu-item").allTextContents();
  if (items.length > 0) await closeMenu();
  return items;
};
const bodyBox = await page.locator(".sidebar-body").boundingBox();
const mineBox = await tid("section-mine").boundingBox();
const sharedBox = await tid("section-shared").boundingBox();
const inMine = await menuAt(bodyBox.x + 1, mineBox.y + mineBox.height - 6);
const inShared = await menuAt(bodyBox.x + 1, sharedBox.y + sharedBox.height - 6);
const sharedRowMenu = await menuOn(row(`${SHARED}/stray.md`));
await closeMenu();
await row("/docs/Library/notes.md").click();
await tid("new-mine-folder").click();
const mineFromLibrary =
  (await tid("section-mine").locator(".tree-create-input").count()) === 1 &&
  (await tid("section-library").locator(".tree-create-input").count()) === 0;
await page.keyboard.type("Ideas");
await page.keyboard.press("Enter");
await poll(async () => (await row(`${MINE}/Ideas`).count()) === 1);
// The new folder is selected, so My files' + makes a note in it.
await tid("new-mine").click();
await poll(async () => (await row(`${MINE}/Ideas/Untitled.md`).count()) === 1);
const madeDirs = await page.evaluate(() => window.__madeDirs ?? []);
step(
  "empty space is the list it is in: My files' makes things there and has My files history…; Shared with me has no menu, and a row there offers no New Document, New Folder or Paste; My files' heading makes a folder and a note in My files",
  inMine.includes("New Folder…") &&
    inMine.includes("My files history…") &&
    inMine.includes("Recently deleted…") &&
    !inMine.includes("Library history…") &&
    inShared.length === 0 &&
    !sharedRowMenu.includes("New Document") &&
    !sharedRowMenu.includes("New Folder…") &&
    !sharedRowMenu.includes("Paste") &&
    (await tid("new-mine-folder").getAttribute("title")) === "New folder in My files" &&
    mineFromLibrary &&
    madeDirs.includes(`${MINE}/Ideas`) &&
    (await tid("section-shared").locator(".sidebar-section-btn").count()) === 0,
  `${inMine.slice(0, 4).join(" · ")} // ${sharedRowMenu.join(" · ")}`,
);
await page.screenshot({ path: SHOTS + "sections-13-end.png" });

await settle();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
