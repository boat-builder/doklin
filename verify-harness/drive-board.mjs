// Drives the REAL App over board.html (a pretend workspace held in memory)
// through a folder shown as a board (src/Board.tsx, src/boards.ts).
//
// The walk: *Show as Board…* on a folder's menu picks a tag and writes the
// folder's boards.json, and its board opens in a tab: a column per value in
// the list's order, the notes with none first, an unlisted value's notes in
// a column of their own, a subfolder's notes left out, other tags as chips.
// A card dragged to another column sets its note's tag (that line alone)
// and ranks the column; one dragged within its column changes only
// boards.json; an html document can't change column. "+ New" makes a note
// with the column's value, ranked at its end, open with the caret in its
// title. A card clicked opens after the board and closing it comes back; ⌘
// opens it behind. Group by regroups; a right-click on a card is the
// sidebar's menu for its file, and a rename there keeps its card's place;
// another device's write shows; a tag renamed rewrites the board; the
// folder renamed takes its board along; *Show as Folder* takes it away.
//
// `PORT` picks the vite server (default 1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const PORT = process.env.PORT ?? "1420";

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 50) {
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
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const tried = async (fn) => {
  try {
    return await fn();
  } catch {
    return false;
  }
};

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGEERROR:", e.message);
});

const ROOT = "/Team notes";
let DIR = `${ROOT}/Launch`;
const row = (path) => page.locator(`[data-tree-path="${path}"]`);
const tabs = () => page.locator(".tab .tab-label").allInnerTexts();
const activeLabel = () => page.locator(".tab.is-active .tab-label").innerText();
const text = (path) => page.evaluate((p) => window.__board.doc(p)?.text ?? null, path);
const boardFile = async () => {
  const t = await text(`${DIR}/boards.json`);
  return t === null ? null : JSON.parse(t);
};
const ranks = async () => Object.fromEntries(Object.entries((await boardFile())?.cards ?? {}).map(([n, c]) => [n, c.rank]));
const columns = () =>
  page
    .locator('[data-testid="board-col"]')
    .evaluateAll((els) => els.map((el) => [el.getAttribute("aria-label"), [...el.querySelectorAll("[data-card]")].map((c) => c.dataset.card)]));
const columnOf = (label) => page.locator(`[data-testid="board-col"][aria-label="${label}"]`);
const card = (name) => page.locator(`[data-card="${name}"]`);
const menuItems = () => page.locator(".tree-context-menu button").allInnerTexts();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Drag `name` with the pointer to above `before` in column `to`, or to
 *  the end of that column. */
async function drag(name, to, before = null) {
  const from = await card(name).boundingBox();
  let x;
  let y;
  if (before) {
    const b = await card(before).boundingBox();
    x = b.x + b.width / 2;
    y = b.y + 6;
  } else {
    const col = await columnOf(to).locator(".board-col-add").boundingBox().catch(() => null);
    const box = col ?? (await columnOf(to).boundingBox());
    x = box.x + box.width / 2;
    y = col ? box.y - 4 : box.y + box.height - 8;
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await settle(120);
  await page.mouse.move(x, y + 1);
  await page.mouse.up();
}

await page.goto(`http://localhost:${PORT}/verify-harness/board.html`);
await poll(async () => (await activeLabel()) === "Ideas", 15000);

/* 1 — *Show as Board…* on a folder: the tags to pick from, then the file and
       the board in a tab of its own. */
{
  await row(DIR).click({ button: "right" });
  const items = await menuItems();
  await page.locator(".tree-context-menu button", { hasText: "Show as Board…" }).click();
  const dialog = page.locator('[data-testid="board-show-dialog"]');
  await poll(async () => (await dialog.count()) === 1);
  const picks = await dialog.locator('[data-testid="board-tag-pick"] .board-tag-pick-name').allInnerTexts();
  await settle(250);
  await page.screenshot({ path: SHOTS + "board-01-pick.png" });
  await dialog.locator('[data-testid="board-tag-pick"]', { hasText: "Status" }).click();
  await poll(async () => (await page.locator('[data-testid="board-col"]').count()) > 0);
  step(
    "a folder's menu offers Show as Board…, its dialog the list's tags; picking one writes boards.json and opens the board in its own tab",
    items.includes("Show as Board…") &&
      same(picks, ["Status", "Priority"]) &&
      (await text(`${DIR}/boards.json`)) === '{\n  "doklin": "boards",\n  "v": 1,\n  "tag": "Status",\n  "cards": {}\n}\n' &&
      (await activeLabel()) === "Launch" &&
      (await page.locator(".tab.is-active .tab-icon svg rect").count()) === 1 &&
      (await row(DIR).locator('[data-testid="tree-board"]').count()) === 1,
    JSON.stringify({ items, picks, tabs: await tabs() }),
  );
}

/* 2 — the columns: no value first, the list's values in order, an unlisted
       value after them; a subfolder's notes are not cards; other tags show
       as chips. */
{
  const cols = await columns();
  const chips = await card("Fix the login.md").locator(".board-chip").allInnerTexts();
  await settle(200);
  await page.screenshot({ path: SHOTS + "board-02-columns.png" });
  step(
    "a column per value in the list's order (values matched whatever their case), the notes with none first, an unlisted value's after; no subfolder note; other tags as chips",
    same(cols, [
      ["No Status", ["Loose idea.md", "Pricing.html"]],
      ["Todo", ["Write the docs.md"]],
      ["Doing", ["Fix the login.md"]],
      ["Done", ["Ship it.md"]],
      ["Blocked", ["Old.md"]],
    ]) &&
      (await columnOf("Blocked").evaluate((el) => el.classList.contains("is-unlisted"))) &&
      same(chips, ["p1"]),
    JSON.stringify({ cols, chips }),
  );
}

/* 3 — a card dragged to another column: its note's tag line is written as a
       tag chip writes it (the list's spelling) and nothing else changes,
       then the column is ranked as it showed. */
{
  await drag("Write the docs.md", "Doing");
  await poll(async () => (await text(`${DIR}/Write the docs.md`)).includes("Doing"));
  await poll(async () => Object.keys(await ranks()).length === 2);
  const cols = await columns();
  step(
    "a card dragged to another column rewrites only its note's tag line, as the list spells it, and ranks that column as it showed",
    (await text(`${DIR}/Write the docs.md`)) === "---\nStatus: Doing\n---\nWhat to write first.\n" &&
      same(await ranks(), { "Fix the login.md": "a0", "Write the docs.md": "a1" }) &&
      same(cols.find((c) => c[0] === "Doing")[1], ["Fix the login.md", "Write the docs.md"]) &&
      same(cols.find((c) => c[0] === "Todo")[1], []),
    JSON.stringify({ text: await text(`${DIR}/Write the docs.md`), ranks: await ranks(), cols }),
  );
}

/* 4 — within its column: only boards.json changes. */
{
  const note = await text(`${DIR}/Write the docs.md`);
  await drag("Write the docs.md", "Doing", "Fix the login.md");
  await poll(async () => (await ranks())["Write the docs.md"] < (await ranks())["Fix the login.md"]);
  const cols = await columns();
  step(
    "a card moved within its column changes boards.json alone",
    (await text(`${DIR}/Write the docs.md`)) === note &&
      same(cols.find((c) => c[0] === "Doing")[1], ["Write the docs.md", "Fix the login.md"]) &&
      same(await ranks(), { "Fix the login.md": "a0", "Write the docs.md": "Zz" }),
    JSON.stringify({ ranks: await ranks(), cols }),
  );
}

/* 5 — an html document can't change column: it has no tags. */
{
  const before = await text(`${DIR}/boards.json`);
  const writes = await page.evaluate(() => window.__board.boardWrites());
  const why = await card("Pricing.html").getAttribute("title");
  await drag("Pricing.html", "Todo");
  await settle(500);
  const cols = await columns();
  step(
    "an html document stays in No Status, and says why",
    same(cols.find((c) => c[0] === "No Status")[1], ["Loose idea.md", "Pricing.html"]) &&
      (await text(`${DIR}/boards.json`)) === before &&
      (await page.evaluate(() => window.__board.boardWrites())) === writes &&
      /html document has no tags/.test(why ?? ""),
    JSON.stringify({ cols, why }),
  );
}

/* 6 — "+ New": a note with the column's value, ranked at its end, opened
       after the board with the caret in its title. */
{
  await columnOf("Todo").locator('[data-testid="board-new"]').click();
  await poll(async () => (await text(`${DIR}/Untitled.md`)) !== null && (await activeLabel()) === "Untitled");
  await poll(async () => (await page.evaluate(() => document.activeElement?.closest(".doc-title") != null)));
  const order = await tabs();
  step(
    "+ New makes a note with the column's value, ranks it at the column's end, and opens it after the board, title first",
    (await text(`${DIR}/Untitled.md`)).startsWith("---\nStatus: Todo\n---\n") &&
      (await ranks())["Untitled.md"] === "a0" &&
      same(order, ["Ideas", "Launch", "Untitled"]),
    JSON.stringify({ text: await text(`${DIR}/Untitled.md`), ranks: await ranks(), order }),
  );
  await page.locator(".tab.is-active .tab-close").click();
  await poll(async () => (await activeLabel()) === "Launch");
}

/* 7 — a card clicked opens after the board, and closing it comes back; ⌘
       opens one behind. */
{
  await page.locator(".tab", { hasText: "Ideas" }).click();
  await poll(async () => (await activeLabel()) === "Ideas");
  await page.locator(".tab", { hasText: "Launch" }).click();
  await poll(async () => (await activeLabel()) === "Launch");
  await card("Ship it.md").click();
  await poll(async () => (await activeLabel()) === "Ship it");
  const opened = await tabs();
  await page.locator(".tab.is-active .tab-close").click();
  await poll(async () => (await activeLabel()) === "Launch");
  await card("Old.md").click({ modifiers: ["Meta"] });
  await poll(async () => (await tabs()).includes("Old"));
  step(
    "a card opens after the board's tab and closing it goes back to the board; ⌘-click opens it behind",
    same(opened, ["Ideas", "Launch", "Ship it"]) && (await activeLabel()) === "Launch" && same(await tabs(), ["Ideas", "Launch", "Old"]),
    JSON.stringify({ opened, now: await tabs() }),
  );
  await page.locator(".tab", { hasText: "Old" }).locator(".tab-close").click();
  await poll(async () => same(await tabs(), ["Ideas", "Launch"]));
}

/* 8 — Group by: another tag's values are the columns, the ranks stay. */
{
  const kept = await ranks();
  await page.locator('[data-testid="board-group"]').click();
  await page.locator(".tree-context-menu button", { hasText: "Priority" }).click();
  await poll(async () => (await boardFile())?.tag === "Priority");
  await poll(async () => (await columns()).some((c) => c[0] === "p1"));
  const cols = await columns();
  await page.locator('[data-testid="board-group"]').click();
  await page.locator(".tree-context-menu button", { hasText: "Status" }).click();
  await poll(async () => (await boardFile())?.tag === "Status");
  step(
    "Group by makes another tag's values the columns, and keeps the ranks",
    same(
      cols.map((c) => c[0]),
      ["No Priority", "p1", "p2", "p3"],
    ) && same(await ranks(), kept),
    JSON.stringify(cols),
  );
}

/* 9 — a right-click on a card is the sidebar's menu for its file; a rename
       there keeps the card's place. */
{
  await poll(async () => (await columns()).some((c) => c[0] === "Doing"));
  await card("Fix the login.md").click({ button: "right" });
  await poll(async () => (await page.locator(".tree-context-menu").count()) === 1);
  const items = await menuItems();
  await page.locator(".tree-context-menu button", { hasText: "Rename…" }).click();
  const input = page.locator('.sidebar input[aria-label^="Rename"]');
  await poll(async () => (await input.count()) === 1);
  await input.fill("Fix sign-in");
  await input.press("Enter");
  await poll(async () => (await ranks())["Fix sign-in.md"] === "a0");
  await poll(async () => (await columns()).find((c) => c[0] === "Doing")?.[1].includes("Fix sign-in.md"));
  step(
    "a card's right-click is the sidebar's file menu, and a rename there keeps its card's place",
    items.includes("Rename…") &&
      !items.some((i) => /board/i.test(i)) &&
      !("Fix the login.md" in (await ranks())) &&
      same((await columns()).find((c) => c[0] === "Doing")[1], ["Write the docs.md", "Fix sign-in.md"]),
    JSON.stringify({ items, ranks: await ranks() }),
  );
}

/* 10 — another device's write shows without a reload. */
{
  const next = JSON.parse(await text(`${DIR}/boards.json`));
  next.cards["Write the docs.md"].rank = "a5";
  await page.evaluate(
    ([p, t]) => window.__board.synced(p, t),
    [`${DIR}/boards.json`, JSON.stringify(next, null, 2) + "\n"],
  );
  await poll(async () => same((await columns()).find((c) => c[0] === "Doing")?.[1], ["Fix sign-in.md", "Write the docs.md"]));
  step("another device's write to boards.json shows on the board", true);
}

/* 11 — a tag renamed rewrites every board grouped by it. */
{
  await card("Ship it.md").click();
  await poll(async () => (await activeLabel()) === "Ship it");
  const pane = page.locator(".editor-pane.is-focused");
  await pane.locator('[data-testid="tag-chip-Status"]').click();
  await page.locator(".tag-menu").getByRole("menuitem", { name: "Edit Status…", exact: true }).click();
  const dialog = page.locator('[data-testid="tag-edit-dialog"]');
  await dialog.locator('[data-testid="tag-edit-name"]').fill("Stage");
  await dialog.locator('[data-testid="tag-edit-save"]').click();
  await poll(async () => (await boardFile())?.tag === "Stage", 8000);
  await page.locator(".tab.is-active .tab-close").click();
  await poll(async () => (await activeLabel()) === "Launch");
  await poll(async () => (await columns()).some((c) => c[0] === "No Stage"));
  step(
    "a tag renamed rewrites the boards grouped by it, and their columns follow",
    (await boardFile()).tag === "Stage" && (await columns()).some((c) => c[0] === "Doing"),
    JSON.stringify(await columns()),
  );
}

/* 12 — the folder renamed takes its board, and its tab, along. */
{
  await row(DIR).click({ button: "right" });
  await page.locator(".tree-context-menu button", { hasText: "Rename…" }).click();
  const input = page.locator('.sidebar input[aria-label^="Rename"]');
  await poll(async () => (await input.count()) === 1);
  await input.fill("Launch 2");
  await input.press("Enter");
  DIR = `${ROOT}/Launch 2`;
  await poll(async () => (await tried(() => activeLabel())) === "Launch 2");
  await poll(async () => (await columns()).some((c) => c[0] === "Doing"));
  step(
    "a folder renamed takes its boards.json, and its board's tab follows",
    (await text(`${DIR}/boards.json`)) !== null && (await text(`${ROOT}/Launch/boards.json`)) === null,
    JSON.stringify(await tabs()),
  );
}

/* 13 — *Show as Folder*: the file goes, the tab closes, the folder is a
       folder again. */
{
  await page.locator('[data-testid="board-show-folder"]').click();
  await poll(async () => (await text(`${DIR}/boards.json`)) === null);
  await poll(async () => !(await tabs()).includes("Launch 2"));
  await poll(async () => (await row(DIR).locator('[data-testid="tree-board"]').count()) === 0);
  await row(DIR).click({ button: "right" });
  const items = await menuItems();
  await page.keyboard.press("Escape");
  step(
    "Show as Folder deletes boards.json and closes the board's tab; the folder offers Show as Board… again",
    items.includes("Show as Board…") && !items.includes("Show as Folder"),
    JSON.stringify(items),
  );
}

step("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
