// Drives the REAL App through the life of an untitled note (untitled.html
// boots <App/> over an in-memory backend that survives a reload the way the
// real one survives a quit).
//
// The walk: ⌘N opens a note and writes nothing; typing titles the tab from
// the first line, marks it unsaved for good, and autosaves into the note's
// buffer — without a registry report per keystroke; closing an unsaved note
// asks (Esc / Cancel keep it, the question owns the keyboard), a reload
// brings it back unsaved, ⌘S and "Save…" turn it into a file and delete the
// buffer, "Don't Save" deletes it and writes nothing, an empty note closes
// without a question. Then the edges: a name that is taken, a note no window
// has open being recovered (and an empty buffer swept), another window's
// note left alone; text typed an instant before ⌘W still being asked about
// (the editor reports on a debounce — the close must not go by a stale
// copy), a slow load overtaken by a newer one not landing on the wrong tab,
// and a note staying with the window when it switches folders; the main
// window closing without asking, a second window
// asking before it goes, and — with no workspace — the native Save dialog,
// a write that fails leaving the note unsaved, and a dismissed dialog
// keeping the tab open.
//
// HARNESS_ORIGIN overrides the dev server (default http://localhost:1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";
const url = (query = "") => `${ORIGIN}/verify-harness/untitled.html${query}`;

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 100) {
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
// The autosave debounce is 600ms; this is "well after a write would land".
const AFTER_AUTOSAVE = 1100;

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const labels = () => page.locator(".tab .tab-label").allInnerTexts();
const activeLabel = () => page.locator(".tab.is-active .tab-label").innerText();
const unsavedLabels = () =>
  page.locator(".tab:has(.tab-close.is-dirty) .tab-label").allInnerTexts();
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const tab = (label) =>
  page.locator(".tab", { has: page.locator(".tab-label", { hasText: exactly(label) }) });
const buffers = () =>
  page.evaluate(() => [...window.__fs].filter(([p]) => p.startsWith("/untitled/")));
const file = (path) => page.evaluate((p) => window.__fs.get(p) ?? null, path);
const editor = () => page.locator(".editor-pane.is-focused .ProseMirror");
const typeInNote = async (text) => {
  await editor().click();
  await page.keyboard.type(text);
};
const ask = () => page.locator(".unsaved-prompt");
const saveAs = () => page.locator(".saveas-panel");
// ⌘N, then wait for the new note's own (empty) editor: the pane swaps
// editors a beat after the tab appears.
const newNote = async () => {
  await page.keyboard.press("Meta+KeyN");
  await poll(async () => (await activeLabel()) === "Untitled");
  await poll(async () => (await editor().innerText()).trim() === "");
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await page.goto(url());

/* 1 — boot: the workspace's one file, nothing unsaved. */
await poll(async () => (await activeLabel()) === "notes");
step("boots on the saved file", same(await labels(), ["notes"]) && (await unsavedLabels()).length === 0);

/* 2 — ⌘N: a tab called Untitled, not unsaved, and nothing written for it. */
await newNote();
step(
  "⌘N opens an untitled note that is not unsaved and has no buffer on disk",
  same(await labels(), ["notes", "Untitled"]) &&
    (await unsavedLabels()).length === 0 &&
    (await buffers()).length === 0,
);
await page.keyboard.press("Meta+KeyN");
await settle();
step("⌘N on a still-empty note does not open another", (await labels()).length === 2);

/* 3 — an empty note closes without a question and leaves nothing behind. */
await page.keyboard.press("Meta+KeyW");
await poll(async () => same(await labels(), ["notes"]));
step(
  "an empty untitled note closes without asking",
  (await ask().count()) === 0 && (await buffers()).length === 0,
);

/* 4 — typing: the first line names the tab, the note is unsaved, and its
       text is autosaved into its buffer. The dot is not the transient one. */
await newNote();
await typeInNote("# Meeting notes");
await page.keyboard.press("Enter");
await page.keyboard.type("hello world");
await poll(async () => (await activeLabel()) === "Meeting notes");
await poll(async () => (await buffers()).some(([, c]) => c.includes("hello world")));
await settle(AFTER_AUTOSAVE);
const [bufferPath] = (await buffers())[0];
step(
  "typing titles the tab from the first line and autosaves into the buffer",
  /^\/untitled\/[^/]+\.md$/.test(bufferPath),
  bufferPath,
);
step(
  "the note stays unsaved after its autosave lands",
  same(await unsavedLabels(), ["Meeting notes"]),
);
step(
  "the window title is the note's, with the edited mark",
  (await page.evaluate(() => window.__title)) === "● Meeting notes",
  await page.evaluate(() => window.__title),
);

/* 5 — the title follows the first line as it changes, and none of that is
       reported to the registry: the report is the persisted descriptor. */
const reportsBefore = await page.evaluate(() => window.__reports);
await editor().locator("h1").click({ clickCount: 3 }); // select the heading's text
await page.keyboard.type("Meeting notes today");
await poll(async () => (await activeLabel()) === "Meeting notes today");
await settle();
step(
  "retitling as you type sends no registry report",
  (await page.evaluate(() => window.__reports)) === reportsBefore,
  `${reportsBefore} → ${await page.evaluate(() => window.__reports)}`,
);
step(
  "the registry knows the tab as an untitled one",
  await page.evaluate(
    (p) => window.__registry.main.tabs.some((t) => t.kind === "untitled" && t.path === p),
    bufferPath,
  ),
);

/* 6 — an inactive unsaved note still shows its dot; closing it brings it to
       the front and asks. Esc keeps it. */
await tab("notes").locator(".tab-main").click();
await poll(async () => (await activeLabel()) === "notes");
step("an inactive unsaved note keeps its dot", same(await unsavedLabels(), ["Meeting notes today"]));
await tab("Meeting notes today").locator(".tab-close").click();
await poll(async () => (await ask().count()) === 1);
step(
  "closing an unsaved note asks, with the note in front",
  (await activeLabel()) === "Meeting notes today" &&
    (await ask().innerText()).includes("Meeting notes today"),
);
await page.screenshot({ path: SHOTS + "untitled-01-ask.png" });
await page.keyboard.press("Escape");
await poll(async () => (await ask().count()) === 0);
step("Esc keeps the note open", (await labels()).length === 2 && (await buffers()).length === 1);

/* 7 — the question owns the keyboard; Cancel keeps the note too. */
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await page.keyboard.press("Meta+KeyN");
await page.keyboard.press("Meta+KeyW");
await settle();
step(
  "no app shortcut reaches past the question",
  (await labels()).length === 2 && (await ask().count()) === 1,
);
await ask().locator("button", { hasText: "Cancel" }).click();
await poll(async () => (await ask().count()) === 0);
step("Cancel keeps the note open", same(await unsavedLabels(), ["Meeting notes today"]));

/* 8 — quit and relaunch: the note is back, unsaved, with its text. Only the
       descriptor was persisted; the title and the dot are read back. */
await settle(AFTER_AUTOSAVE);
await page.reload();
await poll(async () => same(await labels(), ["notes", "Meeting notes today"]));
await poll(async () => (await editor().innerText()).includes("hello world"));
step(
  "a relaunch brings the note back unsaved, active, with its text",
  (await activeLabel()) === "Meeting notes today" &&
    same(await unsavedLabels(), ["Meeting notes today"]),
);
step(
  "the session stores a tab's descriptor and nothing else",
  await page.evaluate(() =>
    JSON.parse(localStorage.getItem("doklin:session")).sessions["/docs"].tabs.every(
      (t) => Object.keys(t).sort().join() === "id,kind,path",
    ),
  ),
);

/* 9 — ⌘S asks for a name, offering the note's first line; Esc backs out. */
await page.keyboard.press("Meta+KeyS");
await poll(async () => (await saveAs().count()) === 1);
step(
  "⌘S offers the note's first line as its file name",
  (await page.locator(".saveas-input").inputValue()) === "Meeting notes today",
);
await page.screenshot({ path: SHOTS + "untitled-02-save.png" });
await page.keyboard.press("Escape");
await poll(async () => (await saveAs().count()) === 0);
step("backing out of Save leaves it unsaved", same(await unsavedLabels(), ["Meeting notes today"]));

/* 10 — close → Save… → name: the file is written, the buffer deleted, and
        the tab — a file's now — closes. */
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await ask().locator("button", { hasText: "Save" }).last().click();
await poll(async () => (await saveAs().count()) === 1);
await page.keyboard.press("Enter");
await poll(async () => same(await labels(), ["notes"]));
const saved = await file("/docs/Meeting notes today.md");
step(
  "Save… writes the file, deletes the buffer and closes the tab",
  saved?.includes("# Meeting notes today") &&
    saved.includes("hello world") &&
    (await buffers()).length === 0 &&
    (await page.evaluate((p) => window.__discarded.includes(p), bufferPath)),
);

/* 11 — Don't Save (⌘D): the note is gone, and nothing was written. */
await newNote();
await typeInNote("scratch thoughts");
await poll(async () => (await buffers()).length === 1);
const filesBefore = await page.evaluate(() => [...window.__fs.keys()].filter((p) => p.startsWith("/docs/")));
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await page.keyboard.press("Meta+KeyD");
await poll(async () => same(await labels(), ["notes"]));
await settle(AFTER_AUTOSAVE);
step(
  "Don't Save discards the note: no buffer, no file, no late write",
  (await buffers()).length === 0 &&
    same(
      await page.evaluate(() => [...window.__fs.keys()].filter((p) => p.startsWith("/docs/"))),
      filesBefore,
    ),
);

/* 12 — ⌘S without closing: the tab becomes the file's, in place, and from
        then on it autosaves like any file and closes without a question. */
await newNote();
await typeInNote("Keep me");
await poll(async () => (await buffers()).length === 1);
await page.keyboard.press("Meta+KeyS");
await poll(async () => (await saveAs().count()) === 1);
await page.keyboard.press("Enter");
await poll(async () => (await file("/docs/Keep me.md")) !== null);
await poll(async () => (await buffers()).length === 0);
await settle(AFTER_AUTOSAVE);
step(
  "⌘S turns the note into a file tab, in place, and it is no longer unsaved",
  same(await labels(), ["notes", "Keep me"]) &&
    (await activeLabel()) === "Keep me" &&
    (await unsavedLabels()).length === 0 &&
    (await tab("Keep me").locator(".tab-main").getAttribute("title")) === "/docs/Keep me.md",
);
await editor().locator("p").first().click({ clickCount: 3 });
await page.keyboard.type("Keep me for later");
await poll(async () => (await file("/docs/Keep me.md"))?.includes("Keep me for later"));
await page.keyboard.press("Meta+KeyW");
await poll(async () => same(await labels(), ["notes"]));
step("a saved note autosaves to its file and closes without asking", (await ask().count()) === 0);

/* 13 — a name that is taken is refused in the prompt; the note stays. */
await newNote();
await typeInNote("notes");
await page.keyboard.press("Meta+KeyS");
await poll(async () => (await saveAs().count()) === 1);
await page.keyboard.press("Enter");
await poll(async () => (await page.locator(".saveas-error").count()) === 1);
step(
  "a taken name is refused and nothing is overwritten",
  (await page.locator(".saveas-error").innerText()).includes("already exists") &&
    (await file("/docs/notes.md")) === "# Notes\n\nA saved file.\n",
);
await page.keyboard.press("Escape");
await poll(async () => (await saveAs().count()) === 0);
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await ask().locator("button", { hasText: "Don’t Save" }).click();
await poll(async () => same(await labels(), ["notes"]));

/* 13b — typed an instant ago, then ⌘W at once: the editor has not reported
         yet (it debounces), and the close must still see the text and ask. */
await newNote();
await typeInNote("typed a moment ago");
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
step(
  "⌘W straight after typing still asks: the close hears the editor first",
  (await ask().innerText()).includes("typed a moment ago"),
);
await ask().locator("button", { hasText: "Don’t Save" }).click();
await poll(async () => same(await labels(), ["notes"]));

/* 13c — a load that is overtaken does not land. Closing a tab starts loading
         its neighbour (made slow here); ⌘N before that finishes starts
         another. The neighbour's load wakes up last and must stand down —
         otherwise the new note's tab would be typing into the neighbour's
         file. */
await page.locator(".tree-file", { hasText: "other" }).click();
await poll(async () => (await activeLabel()) === "other");
await poll(async () => (await editor().innerText()).includes("Another saved file"));
await page.evaluate(() => window.__slow.set("/docs/notes.md", 700));
await page.keyboard.press("Meta+KeyW"); // back to notes — slowly
await page.keyboard.press("Meta+KeyN"); // …and on to a new note before it lands
await poll(async () => (await activeLabel()) === "Untitled");
await settle(1000); // the overtaken load has woken up by now
await page.evaluate(() => window.__slow.clear());
await typeInNote("after the overlap");
await poll(async () => (await buffers()).some(([, c]) => c.includes("after the overlap")));
await settle(AFTER_AUTOSAVE);
step(
  "an overtaken load stands down: the new note's text goes to its own buffer",
  (await activeLabel()) === "after the overlap" &&
    (await file("/docs/notes.md")) === "# Notes\n\nA saved file.\n" &&
    (await editor().innerText()).trim() === "after the overlap",
  JSON.stringify(await file("/docs/notes.md")),
);
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await ask().locator("button", { hasText: "Don’t Save" }).click();
await poll(async () => same(await labels(), ["notes"]));

/* 13d — a note belongs to the window, not to a folder: opening another
         folder takes it along instead of filing it under the one being left,
         and it is still there — in front — on the way back. */
await newNote();
await typeInNote("Carried note");
await poll(async () => (await buffers()).length === 1);
await page.evaluate(() => (window.__openAnswer = "/elsewhere"));
await page.keyboard.press("Meta+Shift+KeyO");
await poll(async () => same(await labels(), ["Carried note"]));
await poll(async () => (await editor().innerText()).includes("Carried note"));
const sessionsAway = await page.evaluate(
  () => JSON.parse(localStorage.getItem("doklin:session")).sessions,
);
step(
  "switching folders takes the note along, unsaved and in front",
  (await activeLabel()) === "Carried note" &&
    same(await unsavedLabels(), ["Carried note"]) &&
    sessionsAway["/docs"].tabs.every((t) => t.kind === "file") &&
    sessionsAway["/elsewhere"].tabs.some((t) => t.kind === "untitled"),
);
await page.evaluate(() => (window.__openAnswer = "/docs"));
await page.keyboard.press("Meta+Shift+KeyO");
await poll(async () => same(await labels(), ["notes", "Carried note"]));
await poll(async () => (await editor().innerText()).includes("Carried note"));
step(
  "…and brings it back: the folder's own tabs return around it",
  (await activeLabel()) === "Carried note" && (await buffers()).length === 1,
);
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await ask().locator("button", { hasText: "Don’t Save" }).click();
await poll(async () => same(await labels(), ["notes"]));

/* 14 — a note no window has open is recovered at launch, an empty buffer is
        swept, and a note ANOTHER window holds is left to that window. */
await page.evaluate(() => {
  window.__fs.set("/untitled/lost-1.md", "# Lost note\n\nfound again\n");
  window.__fs.set("/untitled/blank-1.md", "\n");
  window.__fs.set("/untitled/s-note.md", "# Window note\n\nin a second window\n");
  window.__registry["win-1"] = {
    folder: null,
    tabs: [
      { id: "s-file", kind: "file", path: "/docs/other.md" },
      { id: "s-note", kind: "untitled", path: "/untitled/s-note.md" },
    ],
    activeId: "s-note",
  };
  window.__persist();
});
await page.reload();
await poll(async () => (await labels()).includes("Lost note"));
step(
  "a note left behind is reopened unsaved; an empty buffer is swept; another window's note is not taken",
  same(await labels(), ["notes", "Lost note"]) &&
    same(await unsavedLabels(), ["Lost note"]) &&
    (await file("/untitled/blank-1.md")) === null &&
    (await file("/untitled/s-note.md")) !== null,
  (await labels()).join(" | "),
);

/* 15 — the main window closes without asking: it comes back with its notes. */
await page.evaluate(() => window.__emit("tauri://close-requested", null));
await poll(async () => (await page.evaluate(() => window.__destroyed)) === 1);
step(
  "the main window closes without a question and keeps its note for the next launch",
  (await ask().count()) === 0 && (await file("/untitled/lost-1.md")) !== null,
);

/* 16 — a second window is restored with its own note… */
await page.goto(url("?win=spawned"));
await poll(async () => same(await labels(), ["other", "Window note"]));
step(
  "a restored window gets its untitled note back, unsaved",
  (await activeLabel()) === "Window note" && same(await unsavedLabels(), ["Window note"]),
);

/* 17 — …and asks before it closes, because it will not come back. */
await page.evaluate(() => window.__emit("tauri://close-requested", null));
await poll(async () => (await ask().count()) === 1);
await page.evaluate(() => window.__emit("tauri://close-requested", null)); // a second click on the red button
await settle();
step(
  "closing a window that holds an unsaved note asks first",
  (await page.evaluate(() => window.__destroyed)) === 0 && (await ask().count()) === 1,
);
await ask().locator("button", { hasText: "Cancel" }).click();
await poll(async () => (await ask().count()) === 0);
await settle();
step(
  "Cancel keeps the window and the note",
  (await page.evaluate(() => window.__destroyed)) === 0 && (await labels()).length === 2,
);
await page.evaluate(() => window.__emit("tauri://close-requested", null));
await poll(async () => (await ask().count()) === 1);
await ask().locator("button", { hasText: "Don’t Save" }).click();
await poll(async () => (await page.evaluate(() => window.__destroyed)) === 1);
step(
  "Don't Save lets the window close, and the note goes with it",
  (await file("/untitled/s-note.md")) === null,
);

/* 18 — no workspace: Save goes through the native dialog. A write that
        fails leaves the note exactly as it was — unsaved, buffer intact. */
await page.evaluate(() => localStorage.clear());
await page.goto(url("?bare=1"));
await poll(async () => (await page.locator(".scratch-empty").count()) === 1);
await newNote();
await typeInNote("Loose note");
await poll(async () => (await buffers()).length === 1);
await page.evaluate(() => (window.__saveAnswer = "/readonly/Loose.md"));
await page.keyboard.press("Meta+KeyS");
await poll(async () => (await page.locator(".toast.is-error").count()) === 1);
await settle(AFTER_AUTOSAVE);
step(
  "a save that cannot be written leaves the note unsaved, with its buffer",
  (await page.locator(".toast.is-error").innerText()).includes("Couldn't save") &&
    same(await unsavedLabels(), ["Loose note"]) &&
    (await buffers()).length === 1 &&
    (await buffers())[0][1].includes("Loose note"),
);

/* 19 — a dismissed dialog on the way out keeps the tab open. */
await page.evaluate(() => (window.__saveAnswer = null));
await page.keyboard.press("Meta+KeyW");
await poll(async () => (await ask().count()) === 1);
await page.keyboard.press("Enter"); // Save… is the default button
await poll(async () => (await ask().count()) === 0);
await settle();
step(
  "backing out of the Save dialog cancels the close",
  same(await labels(), ["Loose note"]) && (await buffers()).length === 1,
);

/* 20 — and a dialog that answers saves the note where it says. */
await page.evaluate(() => (window.__saveAnswer = "/elsewhere/Loose.md"));
await page.keyboard.press("Meta+KeyS");
await poll(async () => (await file("/elsewhere/Loose.md")) !== null);
await poll(async () => (await buffers()).length === 0);
step(
  "the native dialog's answer becomes the note's file",
  (await file("/elsewhere/Loose.md")).includes("Loose note") &&
    same(await labels(), ["Loose"]) &&
    (await unsavedLabels()).length === 0,
);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
