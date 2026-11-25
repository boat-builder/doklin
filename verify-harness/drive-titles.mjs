// Drives the REAL App over titles.html (a pretend workspace held in memory)
// through a document's title: the name above a note is its file's, and
// typing there renames the file.
//
// The walk: the title is the file's name and the note holds no heading for
// it; the tab and the tree row follow each key and the file is renamed once
// typing stops; Enter goes into the note at its start and ↑ comes back; a
// name another document has (its markdown or its html) and a character a
// file name can't hold are said under the title and never renamed to, and
// leaving puts the name back; a case-only change renames; an empty title
// keeps the name; "Untitled" shows as an empty title; New Document makes
// "Untitled 2" with the caret in its title and typing names it; Backspace
// in an empty note goes to the title; a pasted paragraph is one line; an
// html-only document has no title; and a long title wraps, its letters whole.
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
// The rename waits this long after the last key (RENAME_PAUSE_MS).
const AFTER_PAUSE = 1100;

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGEERROR:", e.message);
});

const ROOT = "/Team notes";
const title = () => page.locator(".editor-pane.is-focused .doc-title textarea");
const problem = () => page.locator(".editor-pane.is-focused .doc-title-problem");
const editor = () => page.locator(".editor-pane.is-focused .ProseMirror");
const activeLabel = () => page.locator(".tab.is-active .tab-label").innerText();
const row = (path) => page.locator(`[data-tree-path="${path}"]`);
const rowLabel = (path) => row(path).locator(".tree-label").innerText();
const files = () => page.evaluate(() => window.__titles.files());
const has = async (path) => (await files()).includes(path);
const text = (path) => page.evaluate((p) => window.__titles.doc(p)?.text ?? null, path);
const focused = (loc) => loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
const typeTitle = async (words) => {
  await title().click();
  await title().selectText();
  await page.keyboard.type(words);
};
const open = async (path, label) => {
  await row(path).click();
  await poll(async () => (await activeLabel()) === label);
};

await page.goto(`http://localhost:${PORT}/verify-harness/titles.html`);
await poll(async () => (await activeLabel()) === "Welcome");
await poll(async () => (await editor().innerText()).includes("The name above this note"));

/* 1 — the title is the file's name, and the note holds no heading for it. */
step(
  "the title above the note is its file's name, and the note has no heading of it",
  (await title().inputValue()) === "Welcome" &&
    (await editor().locator("h1").count()) === 0 &&
    !(await text(`${ROOT}/Welcome.md`)).startsWith("#"),
);

/* 2 — the tab and the tree row follow each key; the file is renamed once
       typing stops, not before. */
await typeTitle("Welcome page");
const labelWhileTyping = await activeLabel();
const rowWhileTyping = await rowLabel(`${ROOT}/Welcome.md`);
const notYet = (await has(`${ROOT}/Welcome.md`)) && !(await has(`${ROOT}/Welcome page.md`));
await poll(() => has(`${ROOT}/Welcome page.md`), 4000);
step(
  "the tab and the tree row follow the title as it is typed; the file is renamed when typing stops",
  labelWhileTyping === "Welcome page" &&
    rowWhileTyping === "Welcome page" &&
    notYet &&
    !(await has(`${ROOT}/Welcome.md`)) &&
    (await rowLabel(`${ROOT}/Welcome page.md`)) === "Welcome page" &&
    (await focused(title())),
  `${labelWhileTyping} / ${rowWhileTyping}`,
);

/* 3 — Enter goes into the note, at its start; ↑ on its first line comes
       back to the title. */
await page.keyboard.press("Enter");
await page.keyboard.type("Hi. ");
await poll(async () => (await editor().locator("p").first().innerText()).startsWith("Hi. The name above"));
const intoBody = await focused(editor());
await page.keyboard.press("ArrowUp");
step(
  "Enter goes into the note at its start, and ↑ on the note's first line comes back to the title",
  intoBody && (await focused(title())),
);
await poll(async () => (await text(`${ROOT}/Welcome page.md`))?.startsWith("Hi. The name above"));

/* 4 — a name another document in the folder has is said under the title and
       never renamed to; leaving puts the name back, with the sentence. */
await typeTitle("Ideas");
await poll(async () => (await problem().count()) === 1, 4000);
const takenSaid = await problem().innerText();
await settle(AFTER_PAUSE);
const takenKept = (await has(`${ROOT}/Welcome page.md`)) && (await text(`${ROOT}/Ideas.md`)).startsWith("- A weekly digest");
await editor().click();
await poll(async () => (await title().inputValue()) === "Welcome page");
step(
  "a name another document has is said under the title and never renamed to; leaving puts the name back, with the sentence",
  takenSaid === "There’s already a document called “Ideas” here." &&
    takenKept &&
    (await problem().count()) === 0 &&
    (await activeLabel()) === "Welcome page" &&
    (await page.locator(".toast", { hasText: "already a document called" }).count()) === 1,
  takenSaid,
);

/* 5 — a character a file name can't hold is said at once. */
await typeTitle("Plans/notes");
const slashSaid = (await problem().count()) === 1 ? await problem().innerText() : "";
await settle(AFTER_PAUSE);
const slashKept = (await has(`${ROOT}/Welcome page.md`)) && !(await files()).some((p) => p.includes("Plans"));
await editor().click();
await poll(async () => (await title().inputValue()) === "Welcome page");
step(
  "a / is said at once, and nothing is renamed",
  slashSaid === "A title can’t contain /, \\ or :." && slashKept,
  slashSaid,
);

/* 6 — a change of case alone is a rename too. */
await typeTitle("welcome page");
await poll(() => has(`${ROOT}/welcome page.md`), 4000);
step(
  "changing only the case renames the file",
  !(await has(`${ROOT}/Welcome page.md`)) && (await activeLabel()) === "welcome page",
);

/* 7 — an empty title keeps the name. */
await title().click();
await title().selectText();
await page.keyboard.press("Backspace");
await settle(AFTER_PAUSE);
const emptyKept = await has(`${ROOT}/welcome page.md`);
await editor().click();
await poll(async () => (await title().inputValue()) === "welcome page");
step("clearing the title and leaving keeps the name", emptyKept && (await activeLabel()) === "welcome page");

/* 8 — a document called Untitled shows an empty title, its name the
       placeholder; Backspace in its empty note goes up to the title. */
await open(`${ROOT}/Untitled.md`, "Untitled");
const untitledEmpty =
  (await title().inputValue()) === "" && (await title().getAttribute("placeholder")) === "Untitled";
await editor().click();
await page.keyboard.press("Backspace");
step(
  "Untitled shows an empty title with its name as the placeholder; Backspace in an empty note goes to the title",
  untitledEmpty && (await focused(title())),
);

/* 9 — New Document makes the next free Untitled, opens it with the caret in
       its title, and typing names it; Enter, and what is typed is its text. */
await page.locator(".sidebar-body").dispatchEvent("click");
await page.locator(".sidebar-new").click();
await poll(() => has(`${ROOT}/Untitled 2.md`));
await poll(async () => (await activeLabel()) === "Untitled 2" && (await focused(title())));
const newPlaceholder = await title().getAttribute("placeholder");
await page.keyboard.type("Call notes");
await page.keyboard.press("Enter");
await page.keyboard.type("Agenda first.");
await poll(() => has(`${ROOT}/Call notes.md`));
await poll(async () => (await text(`${ROOT}/Call notes.md`))?.includes("Agenda first."));
step(
  "New Document makes Untitled 2, with the caret in its title; typing names it and Enter goes into its text",
  newPlaceholder === "Untitled 2" &&
    !(await has(`${ROOT}/Untitled 2.md`)) &&
    (await text(`${ROOT}/Call notes.md`)).trim() === "Agenda first.",
);

/* 10 — a pasted paragraph is one line. */
await title().click();
await title().selectText();
await title().evaluate((el) => {
  const data = new DataTransfer();
  data.setData("text/plain", "Call notes\nfrom Tuesday\n");
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});
await poll(async () => (await title().inputValue()) === "Call notes from Tuesday");
await poll(() => has(`${ROOT}/Call notes from Tuesday.md`), 4000);
step("pasting several lines into the title keeps one", true);

/* 11 — an html document is named by its tree row and has no title; its
       name still counts as taken. */
await row(`${ROOT}/Projects`).click();
await open(`${ROOT}/Projects/Pricing.html`, "Pricing");
const htmlUntitled = !(await page.locator(".editor-pane.is-focused .doc-title").isVisible());
await open(`${ROOT}/Projects/Launch plan.md`, "Launch plan");
await typeTitle("Pricing");
await poll(async () => (await problem().count()) === 1, 4000);
step(
  "an html document has no title, and its name is taken for the markdown beside it",
  htmlUntitled && (await problem().innerText()) === "There’s already a document called “Pricing” here.",
);
await editor().click();
await poll(async () => (await title().inputValue()) === "Launch plan");

/* 12 — a long title wraps and the field grows to hold every line, with room
        past its line boxes for the tails of g, y and p and the tops of
        accents (a textarea clips whatever leaves it). */
await typeTitle("A long title with gypsy descenders, Ågé accents, and enough words to wrap");
await poll(() => has(`${ROOT}/Projects/A long title with gypsy descenders, Ågé accents, and enough words to wrap.md`), 4000);
const fit = await title().evaluate((el) => {
  const css = getComputedStyle(el);
  return {
    scroll: el.scrollHeight,
    client: el.clientHeight,
    lines: Math.floor(el.clientHeight / parseFloat(css.lineHeight)),
    room: [parseFloat(css.paddingTop), parseFloat(css.paddingBottom)],
  };
});
await page.screenshot({ path: SHOTS + "titles-01-long.png" });
step(
  "a long title wraps, the field grows to hold every line, and leaves room for the glyphs that reach past them",
  fit.scroll <= fit.client && fit.lines >= 2 && fit.room.every((r) => r > 0),
  JSON.stringify(fit),
);

step("no page errors along the way", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
