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

/* ---------- 4. a card opens as an ordinary note ---------- */
{
  await page.locator(".dk-card", { hasText: "Fix login redirect" }).first().click();
  await poll(async () => (await page.locator(".dk-props").count()) === 1);
  const tabs = (await page.locator(".tab-title, .tab-label, .tab").allTextContents()).join(" ");
  step("clicking a card opens its note in a tab", tabs.includes("Fix login redirect"), tabs);
  step("with its properties above the prose", (await page.locator(".dk-props").count()) === 1);
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
  await poll(async () => (await page.locator(".milkdown-slash-menu li[data-index]").count()) === 1);
  step("the slash menu offers a Board", true);
  await page.locator(".milkdown-slash-menu li[data-index]").first().click();
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
  await poll(async () => (await page.locator(".dk-embed-bar").count()) === 2);
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
      (await page.locator(".editor-pane.is-focused .dk-embed-source").count()) === 1,
  );
  step(
    "promoting a pane makes its board live, and the other one read-only",
    (await page.locator(".editor-pane:not(.is-focused) .dk-embed-source").count()) === 0,
  );
  await page.screenshot({ path: SHOTS + "kanban-embed-split.png" });
}

/* ---------- what a SHARE would publish (phase 3) ----------
   A published note carries a picture of the board it embeds, because the
   share worker has no workspace to read one from. The picture is built by
   reading the store's folder — the one seam the pure unit tests
   (verify-harness/store.test.mjs) can't reach, since it goes through the
   backend's read_store. Driven here against the same stubbed fs the rest of
   this file uses. */
{
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  // A fresh context, so the stubbed fs is the seed rather than whatever the
  // steps above left behind. Nothing needs the app mounted: the page's setup
  // script installs both the fs and the Tauri stub that reads it.
  await page.goto(HARNESS);
  const out = await page.evaluate(async () => {
    const { collectBoardSnapshots, cardProperties } = await import("/src/store/publish.ts");
    const md = window.__fs.get("/docs/Embed.md");
    const pages = { "/docs/Projects/Ship dark mode.md": "page-dark" };
    return {
      snapped: await collectBoardSnapshots(md, "/docs/Embed.md", (p) => pages[p]),
      broken: await collectBoardSnapshots(
        window.__fs.get("/docs/Broken.md"),
        "/docs/Broken.md",
        () => undefined,
      ),
      none: await collectBoardSnapshots("# Just prose\n", "/docs/Roadmap.md", () => undefined),
      props: await cardProperties(
        "/docs/Projects/Fix login redirect.md",
        { status: "In progress", tags: ["bug", "auth"], rank: "a1" },
        ["status", "tags", "rank"],
      ),
    };
  });
  const board = out.snapped?.boards?.[0];
  step(
    "a note's fence resolves to its folder and snapshots the board there",
    board?.fence === "store: ./Projects" &&
      board?.name === "Projects" &&
      out.snapped.dirs.join() === "/docs/Projects",
    JSON.stringify(out.snapped?.dirs),
  );
  step(
    "the snapshot holds the same columns, in the same order, as the board tab",
    board?.columns.map((c) => c.name).join("|") ===
      "No status|Backlog|In progress|Done",
    board?.columns.map((c) => `${c.name}:${c.cards.length}`).join(" "),
  );
  step(
    "cards carry their titles, their chips and (only) their own page ids",
    JSON.stringify(board?.columns.find((c) => c.name === "In progress")) ===
      JSON.stringify({
        name: "In progress",
        color: "blue",
        cards: [
          {
            title: "Fix login redirect",
            chips: [{ text: "bug", color: "red" }, { text: "auth" }],
          },
        ],
      }) &&
      JSON.stringify(board?.columns.find((c) => c.name === "Backlog").cards) ===
        JSON.stringify([{ title: "Ship dark mode", page: "page-dark" }]),
    JSON.stringify(board?.columns.find((c) => c.name === "In progress")),
  );
  step(
    "a fence pointing at no board publishes no board — and no error",
    out.broken !== null && out.broken.boards.length === 0 &&
      out.broken.dirs.join() === "/docs/Nowhere",
  );
  step(
    "a note with no fence at all is told apart from one whose fences found nothing",
    out.none === null,
  );
  step(
    "a card's properties publish as its board names and colours them",
    JSON.stringify(out.props) ===
      JSON.stringify([
        { name: "Status", values: [{ text: "In progress", color: "blue" }] },
        { name: "Tags", values: [{ text: "bug", color: "red" }, { text: "auth" }] },
      ]),
    JSON.stringify(out.props),
  );
  await page.context().close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) {
  console.log("failed: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
