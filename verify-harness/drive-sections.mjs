// Drives a workspace in sections in Chromium (cloud.html?sections boots the
// REAL <App/> connected to a scripted engine whose workspace has a Private
// and a restricted folder). What this proves: where a document is decides
// who can open it, and every way of changing that says so first.
//
// The walk: the three lists and what is not a row in them; a note in no
// folder marked as not synced; a section's own history and deleted files;
// making a restricted folder with people; restricting a folder everyone has
// — and an open tab following it; sharing a private note; a move that lets
// more people see a note asking first, and one that narrows asking nothing;
// who is in a folder — adding, removing, the last person handing it on;
// a folder taken away elsewhere saying so; deleting one for everyone; a
// creator nobody can name being told why they have no Private; and an owner
// taking down a page published from a section they are not in.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/cloud.html?sections");

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

await poll(async () => (await page.locator(".sidebar").count()) === 1);
await poll(async () => (await row("/docs/Restricted/Finance").count()) === 1);

/* 1 — three lists. On disk Private and Restricted are two folders at the top
      of the workspace; here they are headings, with no row of their own. */
const headings = [
  (await page.locator(".sidebar-head .sidebar-section-label").textContent()).trim(),
  (await tid("section-restricted").locator(".sidebar-section-label").textContent()).trim(),
  (await tid("section-private").locator(".sidebar-section-label").textContent()).trim(),
];
const inWorkspace = await tid("section-workspace").locator("[data-tree-path]").evaluateAll((els) => els.map((e) => e.dataset.treePath));
step(
  "three lists — Workspace, Restricted, Private — and the two folders behind the last two are headings, not rows",
  headings.join("|") === "Workspace|Restricted|Private" &&
    inWorkspace.includes("/docs/notes.md") &&
    inWorkspace.includes("/docs/Projects") &&
    !inWorkspace.some((p) => p.startsWith("/docs/Private") || p.startsWith("/docs/Restricted")) &&
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
await drag(row("/docs/Projects"), tid("section-restricted").locator(".sidebar-section-label"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const restrictAsk = await tid("question-prompt").innerText();
await tid("question-no").click();
await poll(async () => (await tid("question-prompt").count()) === 0);
step(
  "a folder dropped on Restricted: asked first, in words — and Cancel moves nothing",
  restrictAsk.includes("Restrict “Projects”?") &&
    restrictAsk.includes("removed from everyone else’s Mac") &&
    (await moves()).length === 0 &&
    (await row("/docs/Projects").count()) === 1,
  restrictAsk.replace(/\n/g, " "),
);

/* 6 — Restrict access… on the same folder: it becomes a restricted folder
      holding the people picked, and a tab open inside it follows it there. */
await row("/docs/Projects/plan.md").click();
await poll(async () => (await openTabs()).includes("/docs/Projects/plan.md"));
const sharedMenu = await menuOn(row("/docs/Projects"));
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
    restricted.from === "/docs/Projects" &&
    JSON.stringify(restricted.members) === '["m-carol"]' &&
    (await row("/docs/Projects").count()) === 0 &&
    !(await openTabs()).includes("/docs/Projects/plan.md"),
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
    !(await menuOn(row("/docs/notes.md"))).includes("Share with…"),
);
await closeMenu();

/* 8 — a move that lets more people see a note asks first; one that narrows
      who sees it just happens. */
const movesBefore = (await moves()).length;
await poll(async () => (await row("/docs/Restricted/Finance/budget.md").count()) === 1);
await drag(row("/docs/Restricted/Finance/budget.md"), row("/docs/other.md"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const widerAsk = await tid("question-prompt").innerText();
await tid("question-no").click();
await poll(async () => (await tid("question-prompt").count()) === 0);
const cancelledMoved = (await moves()).length - movesBefore;
await drag(row("/docs/Restricted/Finance/budget.md"), row("/docs/other.md"));
await poll(async () => (await tid("question-prompt").count()) === 1);
await tid("question-yes").click();
await poll(async () => (await row("/docs/budget.md").count()) === 1);
// Into Private: fewer people, no question.
await drag(row("/docs/third.md"), tid("section-private").locator(".sidebar-section-label"));
await poll(async () => (await row("/docs/Private/third.md").count()) === 1);
// Into a folder with other people in it, from Private: asked.
await drag(row("/docs/Private/third.md"), row("/docs/Restricted/Plans"));
await poll(async () => (await tid("question-prompt").count()) === 1);
const intoFolderAsk = await tid("question-prompt").innerText();
await tid("question-yes").click();
await poll(async () => (await row("/docs/Restricted/Plans/third.md").count()) === 1);
step(
  "moving a note where more people can see it asks first, naming them; Cancel moves nothing; narrowing who sees it asks nothing",
  widerAsk.includes("Move “budget” to the workspace?") &&
    widerAsk.includes("Everyone in Notes will be able to see it.") &&
    cancelledMoved === 0 &&
    intoFolderAsk.includes("Move “third” to “Plans”?") &&
    intoFolderAsk.includes("Both people in “Plans” will be able to see it."),
  `${widerAsk.replace(/\n/g, " ")} // ${intoFolderAsk.replace(/\n/g, " ")}`,
);

/* 9 — a note cannot be dropped straight under Restricted: it would be in no
      folder. */
await drag(row("/docs/other.md"), tid("section-restricted").locator(".sidebar-section-label"));
await settle();
step(
  "a note dropped on the Restricted heading goes nowhere: there is no folder for it to be in",
  (await row("/docs/other.md").count()) === 1 &&
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

/* 13 — Delete it for everyone…: said in full before it happens. */
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
  "Delete it for everyone…: what goes, and from where, is said first; then the folder is gone here, quietly",
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
  window.__setStatuses([{ ...s, public: [page("notes", "notes.md"), page("journal", "Restricted/journal/journal.md")] }]);
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

/* 15 — a creator who never said who they are has no Private, and is told
       what to do about it where they would look for one. */
await page.evaluate(() => {
  const s = window.__cloud.statuses[0];
  window.__sections.private = null;
  window.__setStatuses([{ ...s, meId: null, spaces: s.spaces.filter((sp) => sp.kind !== "private") }]);
  window.__emit("cloud-applied", { root: "/docs", paths: [] });
});
await poll(async () => (await tid("private-nobody").count()) === 1);
const nobody = await tid("private-nobody").innerText();
const noPlus = (await tid("new-private").count()) === 0;
await tid("private-nobody").locator(".tree-section-link").click();
await poll(async () => (await dialog("People and agents").count()) === 1);
step(
  "nobody a Private could belong to: the Private list says to say who you are, and its link opens People",
  nobody.includes("Say who you are") && noPlus,
  nobody.replace(/\n/g, " "),
);
await page.screenshot({ path: SHOTS + "sections-03-nobody.png" });

await settle();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
