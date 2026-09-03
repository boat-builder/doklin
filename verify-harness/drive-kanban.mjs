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

/* ---------- 7. a card PEEKS, then opens as an ordinary note ---------- */
{
  // Clicking a card is a light question — "what does this say?" — so it opens
  // the panel beside the board, not a tab. The tab is one click further on.
  await column("Done").locator(".dk-card").first().click();
  await poll(async () => (await page.locator(".dk-peek").count()) === 1);
  step("a click peeks the card rather than opening a tab", true);
  step(
    "the board is still on screen behind it",
    (await page.locator(".dk-board").count()) === 1,
  );
  const peekProse = (await page.locator(".dk-peek .ProseMirror").first().innerText()).trim();
  step(
    "the peek shows the body, never the frontmatter",
    !peekProse.includes("status:") && peekProse.startsWith("Repro:"),
    peekProse.slice(0, 40),
  );
  step(
    "and its properties above it",
    (await page.locator(".dk-peek .dk-prop-label").allTextContents()).join(",").includes("Status"),
  );
  // A body typed in the peek is spliced in under the frontmatter block, which
  // comes back byte for byte (write_body, the mirror of write_frontmatter).
  const headBeforePeek = await headOf(CARD_A);
  await page.locator(".dk-peek .ProseMirror").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Peeked.");
  await poll(async () => (await bodyOf(CARD_A)).includes("Peeked."), 8000);
  step("the peek writes the body", (await bodyOf(CARD_A)).includes("Peeked."));
  step(
    "and leaves the frontmatter block exactly as it was",
    (await headOf(CARD_A)) === headBeforePeek,
    JSON.stringify(await headOf(CARD_A)),
  );
  await page.screenshot({ path: SHOTS + "kanban-peek.png" });

  await page.locator(".dk-peek-tab").click();
  await poll(async () => (await page.locator(".dk-peek").count()) === 0);
  step("Open in a tab closes the peek and opens the document", true);
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
  // Splitting the block off must not read as an edit: a card that opens
  // dirty would autosave a document nobody touched.
  await settle(600);
  step(
    "opening a card does not mark it dirty",
    (await page.locator(".tab.is-active .tab-dirty").count()) === 0,
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
  // A board is not a document: no MD/HTML switch, no Publish pill, nothing
  // that would try to publish or split a folder.
  step(
    "a board tab offers no document chrome",
    (await page.locator(".view-toggle").count()) === 0 &&
      (await page.locator(".publish-wrap").count()) === 0,
  );
  await page.screenshot({ path: SHOTS + "kanban-board-after.png" });
}

/* ---------- 11. properties on a note that is not a card ---------- */
{
  await page.locator(".tree-row.tree-file", { hasText: "Roadmap" }).click();
  await poll(async () => (await page.locator(".ProseMirror").count()) > 0);
  step(
    "every note has a properties header, empty for a note with no properties",
    (await page.locator(".dk-props.is-empty").count()) === 1 &&
      (await page.locator(".dk-prop-row").count()) === 0,
  );
  step(
    "opening it rewrites nothing",
    (await fileOf("/docs/Roadmap.md")) ===
      "# Roadmap\n\nWhere things stand this quarter.\n",
  );
  // Adding one to an ordinary note adds a KEY to that note. A note with no
  // frontmatter grows one only when someone asks for it.
  await page.locator(".dk-prop-add").click();
  await page.locator(".dk-prop-name-input").fill("Owner");
  await page.locator(".dk-prop-add-go").click();
  await poll(async () => (await page.locator(".dk-prop-label").count()) === 1);
  step(
    "an empty property is not yet a line in the file",
    (await fileOf("/docs/Roadmap.md")).startsWith("# Roadmap"),
  );
  await page.locator(".dk-prop-input").fill("Ada");
  await page.keyboard.press("Enter");
  await poll(async () => (await headOf("/docs/Roadmap.md")).includes("Owner: Ada"), 8000);
  step("giving it a value writes the frontmatter", true, await headOf("/docs/Roadmap.md"));
  step(
    "and leaves the body byte-identical",
    (await bodyOf("/docs/Roadmap.md")) === "# Roadmap\n\nWhere things stand this quarter.\n",
  );
  await page.screenshot({ path: SHOTS + "kanban-note-props.png" });
}

/* ---------- 12. a property declared on a card is a FIELD of the board ---- */
{
  await page.locator(".tree-row.tree-board").click();
  await poll(async () => (await page.locator(".dk-board").count()) === 1);
  // A card ALREADY open in a tab is never peeked: the tab is the better
  // answer and it is already there, so the click just goes to it.
  await column("Backlog").locator(".dk-card", { hasText: "Fix login redirect" }).click();
  await settle(600);
  step(
    "a card already open in a tab goes to the tab, not to a peek",
    (await page.locator(".dk-peek").count()) === 0 &&
      (await page.locator(".ProseMirror").count()) > 0,
  );

  await page.locator(".tree-row.tree-board").click();
  await poll(async () => (await page.locator(".dk-board").count()) === 1);
  await column("Backlog").locator(".dk-card", { hasText: "Ship dark mode" }).click();
  await poll(async () => (await page.locator(".dk-peek").count()) === 1);
  await page.locator(".dk-peek .dk-prop-add").click();
  await page.locator(".dk-peek .dk-prop-name-input").fill("Due");
  await page.locator(".dk-peek .dk-prop-type").selectOption("date");
  await page.locator(".dk-peek .dk-prop-add-go").click();
  await poll(async () => (await fileOf("/docs/Projects/store.jsonl")).includes('"id":"due"'), 8000);
  step(
    "a card's new property is declared on the store, not on the one card",
    (await fileOf("/docs/Projects/store.jsonl")).includes(
      '{"t":"field","id":"due","name":"Due","type":"date"}',
    ),
  );
  step(
    "no card was rewritten to hold it",
    !(await headOf(CARD_A)).includes("due:"),
    await headOf(CARD_A),
  );
  await page.locator(".dk-peek-close").click();
  await poll(async () => (await page.locator(".dk-peek").count()) === 0);
}

/* ---------- 13. the second view: a table of the same cards ---------- */
{
  const names = await page.locator(".dk-view-tab").allTextContents();
  step("the board tab names its saved views", names.includes("Board"), names.join(" | "));
  await page.locator(".dk-view-add").click();
  await page.locator(".dk-popover-item", { hasText: "New table" }).click();
  await poll(async () => (await page.locator(".dk-table").count()) === 1);
  step("a new table view is saved to store.jsonl", true);
  step(
    "it is one line of the definition file, and nothing else changed",
    (await fileOf("/docs/Projects/store.jsonl")).includes('"kind":"table"'),
  );
  const heads = await page.locator(".dk-th").allTextContents();
  step(
    "the table's columns are the store's fields, after the title",
    heads[0].startsWith("Title") && heads.join(",").includes("Status"),
    heads.join(" | "),
  );
  const rows = await page.locator(".dk-row-title").allTextContents();
  step(
    "one row per card, in title order",
    rows.length >= 4 && JSON.stringify(rows) === JSON.stringify([...rows].sort()),
    rows.join(" | "),
  );
  // A cell writes the same frontmatter a board's drag writes.
  const bodyBefore = await bodyOf(CARD_B);
  const row = page.locator(".dk-tr", { hasText: "Ship dark mode" });
  await row.locator(".dk-prop-trigger").first().click();
  await poll(async () => (await page.locator(".dk-prop-popover").count()) > 0);
  await page.locator(".dk-prop-popover .dk-popover-item", { hasText: "Done" }).first().click();
  await poll(async () => /status: Done/.test(await headOf(CARD_B)), 8000);
  step("a cell writes the card's frontmatter", /status: Done/.test(await headOf(CARD_B)));
  step("and not its body", (await bodyOf(CARD_B)) === bodyBefore);
  await page.screenshot({ path: SHOTS + "kanban-table.png" });

  // Sorting is the view's, saved with it.
  await page.locator(".dk-th-btn", { hasText: "Status" }).click();
  await poll(async () => (await fileOf("/docs/Projects/store.jsonl")).includes('"sort"'), 8000);
  step(
    "clicking a heading saves the sort on the view",
    (await fileOf("/docs/Projects/store.jsonl")).includes('"sort":{"f":"status","dir":"asc"}'),
  );

  // Back to the board: the same cards, the same files.
  await page.locator(".dk-view-tab", { hasText: "Board" }).click();
  await poll(async () => (await page.locator(".dk-board-cols").count()) === 1);
  step(
    "switching back shows the board again",
    (await cardsIn("Done")).includes("Ship dark mode"),
    (await cardsIn("Done")).join(" | "),
  );
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) {
  console.log("failed: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
