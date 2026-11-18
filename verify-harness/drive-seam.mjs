// Drives the REAL App on a backend that is not the Mac's (seam.tsx: documents
// in memory, no optional group, no Tauri on the page).
//
// What it holds:
//   - the UI boots, edits and saves on src/backend.ts alone;
//   - a note and its sidecar go down as ONE save, and a reply as a save of
//     the sidecar alone;
//   - a change made elsewhere reaches the editor, and a save over one the
//     backend refuses becomes the conflict banner;
//   - a feature whose group the backend lacks has no button, no menu row and
//     no shortcut (untitled notes, this computer's files, history, updates);
//   - a delete the backend cannot take back is asked first, and leaves
//     nothing for ⌘Z.
//
// Needs a vite server on the worktree (see CLAUDE.md).
// HARNESS_ORIGIN overrides it (default http://localhost:1420).
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const seam = (fn, arg) => page.evaluate(fn, arg);
const saves = () => seam(() => window.__seam.saves.slice());
const stored = (path) => seam((p) => window.__seam.doc(p), path);
const NOTES = "/docs/notes.md";

await page.goto(`${ORIGIN}/verify-harness/seam.html`);

/* 1 — boot, on the interface alone */
await poll(async () => (await page.locator(".ProseMirror h1").first().textContent())?.includes("Notes"));
await poll(async () => (await page.locator('[data-tree-path="/docs/other.md"]').count()) === 1);
step(
  "boots with no Tauri on the page: document in the editor, tree listed",
  await seam(() => !("__TAURI_INTERNALS__" in window)),
);

/* 2 — a document is opened as one thing: text, sidecar, rendition */
await poll(async () =>
  (await page.locator(".comment-card").first().textContent()).includes("needs a stronger opening"),
);
await settle(800);
step(
  "opening shows the sidecar's thread and saves nothing",
  (await saves()).length === 0,
  JSON.stringify(await saves()),
);
const watched = await seam(() => window.__seam.watched());
step(
  "the backend is told the document on screen, with its rendition",
  JSON.stringify(watched) === JSON.stringify([{ path: NOTES, rendition: "/docs/notes.html" }]),
  JSON.stringify(watched),
);

/* 3 — the note and its sidecar are one save */
await page.locator(".ProseMirror h1").first().click();
await page.keyboard.press("End");
await page.keyboard.type(" TYPED");
await poll(async () => (await saves()).length >= 1);
await settle(900);
{
  const s = await saves();
  const doc = await stored(NOTES);
  step(
    "typing lands as ONE save carrying the text and the sidecar",
    s.length === 1 && s[0].path === NOTES && s[0].text && s[0].meta && s[0].over === 1,
    JSON.stringify(s),
  );
  step(
    "what was saved is the hybrid form: bare marker in the text, body in the sidecar",
    doc.text.includes("TYPED") &&
      doc.text.includes("{>>#m1seam<<}") &&
      !doc.text.includes("needs a stronger opening") &&
      doc.meta.includes("needs a stronger opening"),
  );
}

/* 4 — a reply moves the sidecar alone */
await page.locator(".comment-card").first().click();
await page.locator(".comment-reply-composer textarea").click();
await page.keyboard.type("reply across the seam");
await page.keyboard.press("Enter");
await poll(async () => (await stored(NOTES)).meta.includes("reply across the seam"));
await settle(900);
{
  const s = (await saves()).slice(1);
  step(
    "a reply is a save of the sidecar alone",
    s.length >= 1 && s.every((x) => x.path === NOTES && x.meta && !x.text),
    JSON.stringify(s),
  );
}

/* 5 — what the backend lacks has no way in */
const tabCount = () => page.locator(".tab").count();
{
  const before = await tabCount();
  const plus = await page.locator(".tab-new").count();
  await page.keyboard.press("Meta+n");
  await settle();
  step(
    "no untitled notes: no “+” in the tab bar, and ⌘N opens nothing",
    plus === 0 && (await tabCount()) === before,
    `tabs ${before} → ${await tabCount()}`,
  );
}
await page.locator(".settings-fab").click();
await poll(async () => (await page.locator(".settings-popover").count()) === 1);
{
  const menu = await page.locator(".settings-popover").textContent();
  const absent = ["New note", "Open file", "Open folder", "new window", "Version history", "Updates", "Check for updates"];
  const shown = absent.filter((label) => menu.includes(label));
  step(
    "the settings menu has no file, window, history or update rows — and still has the rest",
    shown.length === 0 && menu.includes("Cloud…") && menu.includes("Appearance"),
    shown.join(", "),
  );
}
await page.keyboard.press("Escape");
await page.locator('[data-tree-path="/docs/other.md"]').click({ button: "right" });
await poll(async () => (await page.locator(".tree-context-menu").count()) === 1);
{
  const menu = await page.locator(".tree-context-menu").textContent();
  step(
    "a file's menu has no Reveal in Finder and no Version history",
    !menu.includes("Reveal") && !menu.includes("history") && menu.includes("Rename"),
    menu,
  );
}
await page.keyboard.press("Escape");
await settle();

/* 6 — a change made elsewhere reaches the editor */
await seam(
  ([p]) => window.__seam.outside(p, window.__seam.doc(p).text.replace("A closing paragraph.", "Rewritten elsewhere.")),
  [NOTES],
);
await poll(async () => (await page.locator(".ProseMirror").first().textContent()).includes("Rewritten elsewhere."));
step("a change made elsewhere is read back into the editor", true);

/* 7 — a save the backend refuses becomes the conflict banner */
await settle(500);
await seam(([p]) => window.__seam.outside(p, window.__seam.doc(p).text + "\nSlipped in unseen.\n", true), [NOTES]);
await page.locator(".ProseMirror h1").first().click();
await page.keyboard.press("End");
await page.keyboard.type(" MINE");
await poll(async () => (await page.locator(".conflict-banner").count()) === 1);
step(
  "a save over text that moved on is refused, and says so",
  !(await stored(NOTES)).text.includes("MINE"),
);
await page.locator(".conflict-banner-btn.is-primary").click();
await poll(async () => (await stored(NOTES)).text.includes("MINE"));
step(
  "Keep my version saves over what the backend said the text is at now",
  (await page.locator(".conflict-banner").count()) === 0,
);

/* 8 — a delete that cannot be taken back */
await settle(900);
await seam(() => document.activeElement?.blur());
{
  const before = await tabCount();
  await page.keyboard.press("Meta+Backspace");
  const question = page.getByTestId("question-prompt");
  await question.waitFor();
  const asked = (await question.innerText()).replace(/\s+/g, " ");
  await page.getByTestId("question-no").click();
  await settle(300);
  step(
    "⌘⌫ asks before a delete that cannot be taken back, and Cancel deletes nothing",
    /Delete “notes”\?/.test(asked) &&
      /can’t bring it back/.test(asked) &&
      (await seam(() => window.__seam.removed.length)) === 0 &&
      (await tabCount()) === before,
    asked,
  );
  await page.keyboard.press("Meta+Backspace");
  await page.getByTestId("question-yes").click();
  await poll(async () => (await seam(() => window.__seam.removed.length)) === 1);
  await poll(async () => (await tabCount()) === before - 1);
  await page.keyboard.press("Meta+z");
  await settle(600);
  step(
    "Delete deletes the document as one thing; with no undo offered, ⌘Z brings nothing back",
    (await seam(() => window.__seam.removed[0])) === NOTES &&
      (await stored(NOTES)) === null &&
      (await tabCount()) === before - 1,
  );
}

step("no page error across the whole run", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
