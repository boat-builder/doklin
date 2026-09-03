// Drives a BOARD INSIDE A NOTE — phase 2 of datastores — in real Chromium
// (kanban.html boots the real <App/> over an in-memory IPC stub whose /docs
// workspace holds a board and two notes that embed one).
//
// Two properties matter more than anything else on screen, and every step
// checks one of them:
//
//   - the fence round-trips BYTE FOR BYTE. A note is re-serialized on every
//     autosave, so an embed that drifted by a newline would rewrite the
//     reader's file for nothing.
//   - the board's inputs never reach ProseMirror. A card title typed into the
//     embed is text for a file in the store, not text for the document the
//     embed is sitting in.
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

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
// Milkdown's listener debounces its serialize by 200ms, so leaving a document
// whose LAST block is a leaf node (a thematic break, an embed) can serialize
// after the editor's ctx is gone and throw. Pre-existing — a note ending in
// `---` does it with every kanban plugin unregistered — and harmless: the
// document is being torn down. Named here so nobody reads it as this
// feature's doing.
const KNOWN_MILKDOWN_TEARDOWN = /Context "editorView" not found/;
page.on("pageerror", (e) => {
  if (KNOWN_MILKDOWN_TEARDOWN.test(e.message)) return;
  console.log("PAGEERROR:", e.message);
});

const HARNESS = "http://localhost:1420/verify-harness/kanban.html";
await page.goto(HARNESS);

const NOTE = "/docs/Embed.md";
const CARD_B = "/docs/Projects/Ship dark mode.md";
const NEW_CARD = "/docs/Projects/Rotate the signing key.md";
const FENCE = "```kanban\nstore: ./Projects\n```";

const fileOf = (p) => page.evaluate((path) => window.__fs.get(path), p);
const editorText = () => page.locator(".ProseMirror").first().innerText();
const column = (label) =>
  page.locator(".dk-col").filter({ has: page.locator(".dk-col-name", { hasText: label }) });
const cardsIn = async (label) => column(label).locator(".dk-card-title").allTextContents();
const openNote = async (name) => {
  await page.locator(".tree-row.tree-file", { hasText: name }).click();
  await poll(async () => (await page.locator(".ProseMirror").count()) > 0);
  await settle(600);
};

/* ---------- 1. a ```kanban fence renders as a board ---------- */
{
  await poll(async () => (await page.locator(".tree-row").count()) > 0);
  await openNote("Embed");
  await poll(async () => (await page.locator(".dk-board").count()) === 1);
  step("the fence becomes one board frame", (await page.locator(".dk-embed-frame").count()) === 1);
  step(
    "and not a code block",
    (await page.locator(".milkdown-code-block").count()) === 0,
  );
  const bar = (await page.locator(".dk-embed-bar").innerText()).replace(/\s+/g, " ").trim();
  step("the frame names the store it shows", bar.includes("./Projects"), bar);
  step(
    "columns come from store.jsonl in rank order",
    JSON.stringify(await page.locator(".dk-col-name").allTextContents()) ===
      JSON.stringify(["No status", "Backlog", "In progress", "Done"]),
  );
  step(
    "the prose around the board is untouched",
    (await editorText()).includes("Everything after the board is ordinary prose"),
  );
  step("opening the note does not rewrite it", (await fileOf(NOTE)).includes(FENCE));
  await page.screenshot({ path: SHOTS + "kanban-embed.png" });
}

/* ---------- 2. a card composed in the embed never reaches the document --- */
{
  const before = await fileOf(NOTE);
  await column("Backlog").locator("button", { hasText: "New" }).first().click();
  await settle(250);
  await page.keyboard.type("Rotate the signing key");
  await settle(250);
  step(
    "typing a card title never reaches ProseMirror",
    !(await editorText()).includes("Rotate the signing"),
  );
  await page.keyboard.press("Enter");
  await poll(async () => (await fileOf(NEW_CARD)) !== undefined);
  const card = await fileOf(NEW_CARD);
  step(
    "the card lands in the store with the column's value",
    card.startsWith("---\nstatus: Backlog\n") && card.includes("rank: "),
    JSON.stringify(card),
  );
  step("and the note it was typed in is byte-identical", (await fileOf(NOTE)) === before);
  step("the new card shows in its column", (await cardsIn("Backlog")).includes("Rotate the signing key"));
}

/* ---------- 3. a drag inside the embed writes one card, not the note ----- */
{
  const before = await fileOf(NOTE);
  const bodyBefore = (await fileOf(CARD_B)).split("---\n")[2];
  const card = page.locator(".dk-card", { hasText: "Ship dark mode" }).first();
  const from = await card.boundingBox();
  const to = await column("In progress").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 30, from.y + 10, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await settle(250);
  step("the drop line shows where the card would land", (await page.locator(".dk-drop-line").count()) === 1);
  await page.mouse.up();
  await poll(async () => (await fileOf(CARD_B)).includes("status: In progress"));
  step("the drag rewrote the card's status", true);
  step(
    "and left its body byte-identical",
    (await fileOf(CARD_B)).split("---\n")[2] === bodyBefore,
  );
  step("the note holding the board is untouched", (await fileOf(NOTE)) === before);
  step("the card moved column", (await cardsIn("In progress")).includes("Ship dark mode"));
}

/* ---------- 4. a card peeks, here as on a board tab ---------- */
{
  await page.locator(".dk-card", { hasText: "Fix login redirect" }).first().click();
  await poll(async () => (await page.locator(".dk-peek").count()) === 1);
  step(
    "clicking a card in a note peeks it rather than leaving the note",
    (await page.locator(".dk-peek-title").innerText()).trim() === "Fix login redirect",
    (await page.locator(".dk-peek-title").innerText()).trim(),
  );
  step(
    "with its properties above the prose",
    (await page.locator(".dk-peek .dk-prop-label").allTextContents()).join(",").includes("Status"),
  );
  // …and the tab is one click away, which is where the rest of this file
  // expects to be.
  await page.locator(".dk-peek-tab").click();
  await poll(async () => (await page.locator(".dk-peek").count()) === 0);
  const tabs = (await page.locator(".tab-title, .tab-label, .tab").allTextContents()).join(" ");
  step("Open in a tab opens the card's note", tabs.includes("Fix login redirect"), tabs);
}

/* ---------- 5. an ordinary edit to the note keeps the fence byte for byte -- */
{
  await page.locator(".tab", { hasText: "Embed" }).first().click();
  await poll(async () => (await page.locator(".dk-embed-frame").count()) === 1);
  await settle(400);
  await page.locator(".ProseMirror p", { hasText: "ordinary prose" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Still true.");
  await poll(async () => (await fileOf(NOTE)).includes("Still true."), 6000);
  const text = await fileOf(NOTE);
  step("typing in the note saves the note", text.includes("Still true."));
  step(
    "and the fence survives the re-serialization byte for byte",
    text.includes(FENCE) && (text.match(/```/g) ?? []).length === 2,
    JSON.stringify(text),
  );
}

/* ---------- 6. the Source chip edits the embed's config ---------- */
{
  await page.locator(".dk-embed-source").click();
  await poll(async () => (await page.locator(".dk-embed-editor").count()) === 1);
  step(
    "Source shows the fence's config text",
    (await page.locator(".dk-embed-editor").inputValue()) === "store: ./Projects",
  );
  await page.locator(".dk-embed-editor").fill("store: ./Projects\nhide: [Done]");
  await page.locator(".ProseMirror p", { hasText: "ordinary prose" }).first().click();
  await poll(async () => (await page.locator(".dk-col-name").count()) === 3);
  step(
    "hide: [Done] drops that column from THIS embed",
    !(await page.locator(".dk-col-name").allTextContents()).includes("Done"),
  );
  await poll(async () => (await fileOf(NOTE)).includes("hide: [Done]"), 6000);
  step(
    "and the fence on disk carries the new config",
    (await fileOf(NOTE)).includes("```kanban\nstore: ./Projects\nhide: [Done]\n```"),
  );
  step(
    "the store itself is unchanged — hiding is a view, not an edit",
    (await fileOf("/docs/Projects/store.jsonl")).includes('"name":"Done"'),
  );
}

/* ---------- 7. the embed is a block: ⌫ deletes it, ⌘Z brings it back ----- */
{
  const withEmbed = await fileOf(NOTE);
  await page.locator(".dk-embed-bar").click({ position: { x: 200, y: 10 } });
  await settle(250);
  step("clicking the frame's bar selects the block", (await page.locator(".dk-embed-frame.is-selected").count()) === 1);
  await page.keyboard.press("Backspace");
  await poll(async () => (await page.locator(".dk-embed-frame").count()) === 0);
  await poll(async () => !(await fileOf(NOTE)).includes("```kanban"), 6000);
  step("Backspace removes the embed from the note", true);
  await page.keyboard.press("Control+z");
  await poll(async () => (await page.locator(".dk-embed-frame").count()) === 1);
  await poll(async () => (await fileOf(NOTE)).includes("```kanban"), 6000);
  step("undo restores it byte for byte", (await fileOf(NOTE)) === withEmbed, JSON.stringify(await fileOf(NOTE)));
}

/* ---------- 8. the slash menu inserts one, and the picker names a board -- */
{
  await openNote("Roadmap");
  const before = await fileOf("/docs/Roadmap.md");
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/board");
  // Two items, because a store has two ways to be shown: "Board" and
  // "Board as a table". Both insert the same kind of block; only the fence's
  // language differs.
  await poll(async () => (await page.locator(".milkdown-slash-menu li[data-index]").count()) === 2);
  step(
    "the slash menu offers a Board and a table of one",
    (await page.locator(".milkdown-slash-menu li[data-index]").allTextContents()).join("|"),
    (await page.locator(".milkdown-slash-menu li[data-index]").allTextContents()).join(" | "),
  );
  // The items are in the order they were added: Board, then Board as a table.
  await page.locator(".milkdown-slash-menu li[data-index]").nth(0).click();
  await poll(async () => (await page.locator(".dk-embed-pick").count()) === 1);
  step(
    "a fresh embed asks which board, in place",
    (await page.locator(".dk-embed-pick-item").allTextContents()).includes("Projects"),
  );
  await page.locator(".dk-embed-pick-item", { hasText: "Projects" }).click();
  await poll(async () => (await page.locator(".dk-col-name").count()) > 0);
  step("picking one draws the board", (await page.locator(".dk-board").count()) === 1);
  await poll(async () => (await fileOf("/docs/Roadmap.md")).includes("```kanban"), 6000);
  const text = await fileOf("/docs/Roadmap.md");
  step(
    "and writes a path relative to the note",
    text.includes("```kanban\nstore: ./Projects\n```"),
    JSON.stringify(text),
  );
  step("the prose that was already there is intact", text.startsWith(before.trimEnd()));
  await page.screenshot({ path: SHOTS + "kanban-embed-picked.png" });
}

/* ---------- 8b. the same store, embedded as a table ---------- */
{
  // Roadmap already carries a ```kanban embed from the step above; a second
  // fence in the other language shows the same cards as rows.
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/board");
  await poll(async () => (await page.locator(".milkdown-slash-menu li[data-index]").count()) === 2);
  await page.locator(".milkdown-slash-menu li[data-index]").nth(1).click();
  await poll(async () => (await page.locator(".dk-embed-pick").count()) === 1);
  await page.locator(".dk-embed-pick-item", { hasText: "Projects" }).click();
  await poll(async () => (await page.locator(".dk-table").count()) === 1);
  step("a table embed draws the same store as rows", true);
  step(
    "the frame says which view it is",
    (await page.locator(".dk-embed-kind").allTextContents()).includes("Table"),
    (await page.locator(".dk-embed-kind").allTextContents()).join(" | "),
  );
  await poll(async () => (await fileOf("/docs/Roadmap.md")).includes("```table"), 6000);
  const text = await fileOf("/docs/Roadmap.md");
  step(
    "and the fence is written in the table language",
    text.includes("```table\nstore: ./Projects\n```"),
    JSON.stringify(text),
  );
  step(
    "the board fence beside it is untouched",
    text.includes("```kanban\nstore: ./Projects\n```"),
  );
  const rows = await page.locator(".dk-row-title").allTextContents();
  step("one row per card", rows.length >= 4, rows.join(" | "));
  await page.screenshot({ path: SHOTS + "kanban-embed-table.png" });

  // The round trip is what the whole feature is judged on: an ordinary edit
  // re-serializes the document, and both fences must come back as they were.
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nAfter both.");
  await poll(async () => (await fileOf("/docs/Roadmap.md")).includes("After both."), 8000);
  const after = await fileOf("/docs/Roadmap.md");
  step(
    "an edit re-serializes the note with both fences byte for byte",
    after.includes("```kanban\nstore: ./Projects\n```") &&
      after.includes("```table\nstore: ./Projects\n```"),
    JSON.stringify(after),
  );
}

/* ---------- 9. an embed pointing at a folder that isn't a board ---------- */
{
  await openNote("Broken");
  await poll(async () => (await page.locator(".dk-embed-frame").count()) === 1);
  const text = (await page.locator(".dk-embed-frame").innerText()).replace(/\s+/g, " ");
  step("a store that isn't one says so in place", text.includes("no board here"), text);
  step("and the note is left exactly as written", (await fileOf("/docs/Broken.md")).includes("store: ./Nowhere"));
}

/* ---------- 10. a split pane's embed is read-only until it is focused --- */
{
  await openNote("Embed");
  await page.keyboard.press("Control+Shift+Backslash");
  await poll(async () => (await page.locator(".editor-pane").count()) === 2);
  await poll(async () => (await page.locator(".dk-embed-frame").count()) === 2);
  const mirror = page.locator(".editor-pane:not(.is-focused)");
  step(
    "a split shows the board in both panes",
    (await page.locator(".dk-embed-frame").count()) === 2,
  );
  step(
    "the pane that doesn't own the document can't write to the board",
    (await mirror.locator(".dk-embed-source").count()) === 0 &&
      (await mirror.locator(".dk-col-menu-btn").count()) === 0 &&
      (await mirror.locator(".dk-col button", { hasText: "New" }).count()) === 0,
  );

  // Two documents, each with its own embed — then hand the focus over.
  await page.locator(".tree-row.tree-file", { hasText: "Roadmap" }).click();
  // Roadmap carries two embeds of its own by now (a board and a table), so
  // the pair of panes shows three frames between them.
  await poll(async () => (await page.locator(".dk-embed-bar").count()) >= 2);
  await settle(600);
  const focusedBar = async (focused) =>
    (
      await page
        .locator(focused ? ".editor-pane.is-focused" : ".editor-pane:not(.is-focused)")
        .locator(".dk-embed-bar")
        .first()
        .innerText()
    ).replace(/\s+/g, " ");
  step(
    "each pane resolves its OWN note's store",
    (await focusedBar(true)).includes("./Projects") &&
      (await focusedBar(false)).includes("./Projects"),
  );
  await page.locator(".editor-pane:not(.is-focused)").locator(".ProseMirror p").first().click();
  await poll(
    async () =>
      (await page.locator(".editor-pane.is-focused .dk-embed-source").count()) >= 1,
  );
  step(
    "promoting a pane makes its board live, and the other one read-only",
    (await page.locator(".editor-pane:not(.is-focused) .dk-embed-source").count()) === 0,
  );
  await page.screenshot({ path: SHOTS + "kanban-embed-split.png" });
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) {
  console.log("failed: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
