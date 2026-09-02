// Drives the REAL App's datastore/kanban surface in Chromium (kanban.html
// boots <App/> over an in-memory IPC stub whose /docs workspace contains a
// board): the sidebar's one-row board, the board tab, a drag between columns
// writing one card's frontmatter and nothing else, the inline card and column
// composers, opening a card as an ordinary note, and the properties header —
// with the invariant the whole design rests on checked at every step: a
// card's BODY bytes never move when its properties do.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 8000, every = 100) {
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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/kanban.html");

const fileOf = (p) => page.evaluate((path) => window.__fs.get(path), p);
const bodyOf = async (p) => {
  const text = await fileOf(p);
  if (text === undefined) return undefined;
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
};
const headOf = async (p) => {
  const text = await fileOf(p);
  if (text === undefined) return undefined;
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m ? m[0] : "";
};
const column = (label) =>
  page.locator(".dk-col").filter({ has: page.locator(".dk-col-name", { hasText: label }) });
const cardsIn = async (label) =>
  column(label).locator(".dk-card-title").allTextContents();

const CARD_A = "/docs/Projects/Fix login redirect.md";
const CARD_B = "/docs/Projects/Ship dark mode.md";
const CARD_C = "/docs/Projects/Write onboarding docs.md";

/* ---------- 1. the sidebar shows a board as ONE row ---------- */
{
  await poll(async () => (await page.locator(".tree-row").count()) > 0);
  const boardRow = page.locator(".tree-row.tree-board");
  const count = await boardRow.count();
  const label = count ? (await boardRow.first().textContent())?.trim() : "";
  step("board is one sidebar row", count === 1 && label === "Projects", label);
  step(
    "the board row has no disclosure triangle",
    (await boardRow.locator(".tree-chevron").count()) === 0,
  );
  const rows = await page.locator(".tree-row").allTextContents();
  step(
    "cards are not listed in the tree",
    !rows.some((r) => r.includes("Fix login")),
    rows.join(" | "),
  );
}

/* ---------- 2. clicking it opens a board tab ---------- */
{
  await page.locator(".tree-row.tree-board").click();
  await poll(async () => (await page.locator(".dk-board").count()) === 1);
  const title = (await page.locator(".dk-board-title").textContent())?.trim();
  step("the row opens a board tab", title === "Projects", title);
  const tabs = await page.locator(".tab-title, .tab-label, .tab").allTextContents();
  step("a tab appears for the board", tabs.join(" ").includes("Projects"), tabs.join(" | "));
  step("no editor is mounted for a board", (await page.locator(".ProseMirror").count()) === 0);
}

/* ---------- 3. columns come from store.jsonl, in rank order ---------- */
{
  const names = await page.locator(".dk-col-name").allTextContents();
  step(
    "columns are the select options, in rank order, after the empty column",
    JSON.stringify(names) ===
      JSON.stringify(["No status", "Backlog", "In progress", "Done"]),
    names.join(" | "),
  );
  step("a card with no status sits in the empty column",
    (await cardsIn("No status")).includes("Write onboarding docs"));
  step("cards land in their own column",
    (await cardsIn("In progress")).includes("Fix login redirect") &&
      (await cardsIn("Backlog")).includes("Ship dark mode"));
  await page.screenshot({ path: SHOTS + "kanban-board.png" });
}

/* ---------- 4. a drag writes one card's properties, not its body ---------- */
{
  const bodyBefore = await bodyOf(CARD_A);
  const card = column("In progress").locator(".dk-card").first();
  const from = await card.boundingBox();
  const target = await column("Done").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + 12);
  await page.mouse.down();
  // Past the 4px threshold, then across in a few steps so the hit test runs.
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + 30, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
    steps: 8,
  });
  await settle(120);
  const line = await page.locator(".dk-drop-line").count();
  await page.mouse.up();
  await poll(async () => (await cardsIn("Done")).includes("Fix login redirect"));
  step("a drop line marks where the card would land", line > 0);
  step("the card moved column on screen", (await cardsIn("Done")).includes("Fix login redirect"));
  step(
    "its status is rewritten on disk",
    /status: Done/.test(await headOf(CARD_A)),
    await headOf(CARD_A),
  );
  step(
    "its body is byte-identical",
    (await bodyOf(CARD_A)) === bodyBefore,
    JSON.stringify(await bodyOf(CARD_A)),
  );
  step(
    "no other card was written",
    (await bodyOf(CARD_B)) === "The tokens are already there.\n",
  );
}

/* ---------- 5. a card is created from the column it lands in ---------- */
{
  await column("Backlog").locator(".dk-col-add").click();
  await page.locator(".dk-inline-input").fill("Ship the board");
  await page.keyboard.press("Enter");
  await poll(async () => (await cardsIn("Backlog")).includes("Ship the board"));
  const created = await fileOf("/docs/Projects/Ship the board.md");
  step("the new card is a note in the board's folder", created !== undefined);
  step(
    "it carries the column's value and a rank",
    /status: Backlog/.test(created ?? "") && /rank: /.test(created ?? ""),
    created,
  );
  step("its title is the file name, spaces and all", (await cardsIn("Backlog")).includes("Ship the board"));
}

/* ---------- 6. a column is added to store.jsonl ---------- */
{
  await page.locator(".dk-col-new .dk-col-add").click();
  await page.locator(".dk-inline-input").fill("Blocked");
  await page.keyboard.press("Enter");
  await poll(async () => (await page.locator(".dk-col-name").allTextContents()).includes("Blocked"));
  const def = await fileOf("/docs/Projects/store.jsonl");
  step("the option is written to store.jsonl", /"name":"Blocked"/.test(def));
  step(
    "one record per line, header first",
    def.split("\n")[0] === '{"doklin":"store","v":1,"name":"Projects"}',
    def.split("\n")[0],
  );
  step(
    "an empty column persists",
    (await cardsIn("Blocked")).length === 0 &&
      (await page.locator(".dk-col-name").allTextContents()).includes("Blocked"),
  );
}

/* ---------- 7. a card opens as an ordinary note, with its properties ------- */
{
  await column("Done").locator(".dk-card").first().click();
  await poll(async () => (await page.locator(".ProseMirror").count()) > 0);
  const prose = (await page.locator(".ProseMirror").first().innerText()).trim();
  step(
    "the editor never sees the frontmatter",
    !prose.includes("status:") && prose.startsWith("Repro:"),
    prose.slice(0, 60),
  );
  const labels = await page.locator(".dk-prop-label").allTextContents();
  step(
    "the properties header lists the store's fields",
    JSON.stringify(labels) === JSON.stringify(["Status", "Tags"]),
    labels.join(" | "),
  );
  const chips = await page.locator(".dk-prop-value .dk-chip").allTextContents();
  step("it shows the card's values", chips.includes("Done") && chips.includes("bug"), chips.join(","));
  step(
    "the board row stays highlighted while a card is focused",
    await page.locator(".tree-row.tree-board").evaluate((el) => el.classList.contains("is-active")),
  );
  await page.screenshot({ path: SHOTS + "kanban-card.png" });
}

/* ---------- 8. a pill writes the block and nothing else ---------- */
{
  const bodyBefore = await bodyOf(CARD_A);
  await page.locator(".dk-prop-row", { hasText: "Status" }).locator(".dk-prop-trigger").click();
  await poll(async () => (await page.locator(".dk-prop-popover").count()) > 0);
  await page.locator(".dk-prop-popover .dk-popover-item", { hasText: "Backlog" }).click();
  await poll(async () => /status: Backlog/.test(await headOf(CARD_A)));
  step("the pill rewrites the frontmatter", /status: Backlog/.test(await headOf(CARD_A)));
  step("the body is untouched", (await bodyOf(CARD_A)) === bodyBefore);
  // Canonical order: the store's declared fields, then `rank`. Equal state
  // has to serialize to equal bytes on every device, or two machines writing
  // the same property would conflict in the sync engine's line merge.
  const keys = (await headOf(CARD_A))
    .split("\n")
    .slice(1, -2)
    .map((l) => l.slice(0, l.indexOf(":")));
  step(
    "the block keeps the store's key order",
    JSON.stringify(keys) === JSON.stringify(["status", "tags", "rank"]),
    keys.join(","),
  );
}

/* ---------- 9. typing in a card keeps its properties ---------- */
{
  const headBefore = await headOf(CARD_A);
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Reproduced on main.");
  await poll(async () => (await bodyOf(CARD_A)).includes("Reproduced on main."), 8000);
  step("the edit lands in the body", (await bodyOf(CARD_A)).includes("Reproduced on main."));
  step(
    "the frontmatter block survives an autosave",
    (await headOf(CARD_A)) === headBefore,
    JSON.stringify(await headOf(CARD_A)),
  );
  step(
    "a note with no frontmatter never grows one",
    (await headOf(CARD_C)) === "",
    JSON.stringify(await headOf(CARD_C)),
  );
}

/* ---------- 10. the board reflects disk on re-open ---------- */
{
  await page.locator(".tree-row.tree-board").click();
  await poll(async () => (await page.locator(".dk-board").count()) === 1);
  step(
    "the moved card shows where the file says it is",
    (await cardsIn("Backlog")).includes("Fix login redirect"),
    (await cardsIn("Backlog")).join(" | "),
  );
  step("the added column is still there",
    (await page.locator(".dk-col-name").allTextContents()).includes("Blocked"));
  await page.screenshot({ path: SHOTS + "kanban-board-after.png" });
}

/* ---------- 11. an ordinary note is untouched by any of it ---------- */
{
  await page.locator(".tree-row.tree-file", { hasText: "Roadmap" }).click();
  await poll(async () => (await page.locator(".ProseMirror").count()) > 0);
  step(
    "a note outside a board shows no properties header",
    (await page.locator(".dk-props").count()) === 0,
  );
  step(
    "and is not rewritten",
    (await fileOf("/docs/Roadmap.md")) ===
      "# Roadmap\n\nWhere things stand this quarter.\n",
  );
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) {
  console.log("failed: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
