// Drives files that are not documents in Chromium (split.html boots the REAL
// <App/>, whose /docs tree lists photo.png and data.csv greyed). What this
// proves: a click on a greyed row opens it like any file — a tab that says
// "Unsupported file format" — without the file ever being read or watched;
// it can't be found in, split or published; the tab comes back after a
// relaunch; and it goes to the Trash like a document, by ⌘⌫ or the button.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 80) {
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";
await page.goto(`${ORIGIN}/verify-harness/split.html`);

const row = (path) => page.locator(`[data-tree-path="${path}"]`);
const unsupported = () => page.locator('[data-testid="unsupported-file"]');
const tabLabels = () => page.locator(".tab .tab-label").allTextContents();
const activeTabLabel = async () => (await page.locator(".tab.is-active .tab-label").textContent())?.trim();
const reads = () => page.evaluate(() => window.__reads);
const watched = () => page.evaluate(() => window.__watched ?? []);
const trashed = () => page.evaluate(() => window.__trashed);

await poll(async () => (await page.locator(".ProseMirror h1").first().textContent())?.includes("Notes"));
await poll(async () => (await row("/docs/photo.png").count()) === 1);

/* 1 — a greyed row opens: its own tab, the pane says it isn't a document,
      and the file is never read or watched. */
const greyed = await row("/docs/photo.png").evaluate((el) => el.classList.contains("is-unsupported"));
await row("/docs/photo.png").click();
await poll(async () => (await unsupported().count()) === 1);
const card = await unsupported().innerText();
step(
  "a click on a greyed row opens it in a tab that says it isn't a document, and nothing reads or watches it",
  greyed &&
    (await activeTabLabel()) === "photo.png" &&
    card.includes("Unsupported file format") &&
    card.includes("/docs/photo.png") &&
    (await page.locator(".editor-pane .ProseMirror").count()) === 0 &&
    (await row("/docs/photo.png").evaluate((el) => el.classList.contains("is-active"))) &&
    !(await reads()).includes("/docs/photo.png") &&
    !(await watched()).includes("/docs/photo.png"),
  card.split("\n")[0],
);
await page.screenshot({ path: SHOTS + "unsupported-01-tab.png" });

/* 2 — nothing to find in, split or publish: ⌘F and ⌘⇧\ do nothing, and the
      bar's document controls are gone. */
await page.locator("body").click({ position: { x: 900, y: 400 } });
await page.keyboard.press("Meta+f");
await page.keyboard.press("Meta+Shift+Backslash");
await settle();
step(
  "no find bar, no split, no document controls for a file that isn't a document",
  (await page.locator(".find-bar").count()) === 0 &&
    (await page.locator(".editor-pane").count()) === 1 &&
    (await page.locator('[data-testid="live-chip"]').count()) === 0,
);

/* 3 — the tab comes back after a relaunch, still unread. */
await page.reload();
await poll(async () => (await unsupported().count()) === 1);
step(
  "after a relaunch the tab is back, active, and the file still unread",
  (await activeTabLabel()) === "photo.png" &&
    (await tabLabels()).includes("photo.png") &&
    !(await reads()).includes("/docs/photo.png"),
  (await tabLabels()).join(" · "),
);

/* 4 — documents still open as before, and the greyed tab returns to its
      card when picked again. */
await row("/docs/other.md").click();
await poll(async () => (await page.locator(".ProseMirror h1").first().textContent())?.includes("Other"));
const editorBack = (await unsupported().count()) === 0;
await row("/docs/photo.png").click();
await poll(async () => (await unsupported().count()) === 1);
step("switching between a document and the greyed file swaps the editor and the card", editorBack);

/* 5 — ⌘⌫ sends it to the Trash like a document: the tab closes, the row goes. */
await page.locator("body").click({ position: { x: 900, y: 400 } });
await page.keyboard.press("Meta+Backspace");
await poll(async () => (await trashed()).includes("/docs/photo.png"));
await poll(async () => (await row("/docs/photo.png").count()) === 0);
step(
  "⌘⌫ trashes the open greyed file: its tab closes and its row goes",
  !(await tabLabels()).includes("photo.png") && (await trashed()).length === 1,
  (await trashed()).join(", "),
);

/* 6 — or from the card's own button. */
await row("/docs/data.csv").click();
await poll(async () => (await unsupported().count()) === 1);
await page.locator('[data-testid="unsupported-trash"]').click();
await poll(async () => (await trashed()).includes("/docs/data.csv"));
await poll(async () => (await row("/docs/data.csv").count()) === 0);
step(
  "Move to Trash on the card trashes it the same way",
  !(await tabLabels()).includes("data.csv") && !(await reads()).includes("/docs/data.csv"),
);

await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
process.exit(passed === results.length ? 0 : 1);
