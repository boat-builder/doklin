// Drives the REAL App's split view in Chromium (split.html boots <App/> over
// an in-memory IPC stub): same-document split (markdown | rendition),
// materializing into a two-document split, promotion by click and by iframe
// gesture, read-only companions, promote→edit→autosave, proportional scroll
// sync (md↔html and md↔md) with the on/off toggle, divider resize, pane
// close, ⌘⇧\, and drag-a-tab-to-a-half drop zones.
import { chromium } from "playwright";

import { existsSync, mkdirSync } from "node:fs";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/split.html");

const pane = (side) => page.locator(`.editor-pane[data-side="${side}"]`);
const header = (side) => pane(side).locator(".pane-header");
const wrapScroll = (side) =>
  pane(side).locator(".editor-wrap").evaluate((el) => el.scrollTop);
const setWrapScroll = (side, top) =>
  pane(side)
    .locator(".editor-wrap")
    .evaluate((el, t) => {
      el.scrollTop = t;
    }, top);
const iframeScroll = () =>
  page
    .frameLocator("iframe.html-preview")
    .locator("body")
    .evaluate(() => (document.scrollingElement || document.documentElement).scrollTop);

/* 1 — boot: one pane, no headers, notes.md active */
await poll(async () => (await page.locator(".milkdown .ProseMirror").count()) === 1);
await poll(async () =>
  (await page.locator(".ProseMirror h1").first().textContent())?.includes("Notes"),
);
step(
  "boots to a single pane (no pane headers), notes.md in the editor",
  (await page.locator(".pane-header").count()) === 0 &&
    (await page.locator(".editor-pane").count()) === 1,
);

/* 2 — split button → same-document split */
await page.locator(".split-toggle").click();
await poll(async () => (await page.locator(".pane-header").count()) === 2);
const leftFocused = await header("left").evaluate((el) => el.classList.contains("is-focused"));
const rightHasIframe = (await pane("right").locator("iframe.html-preview").count()) === 1;
const leftMdActive = await header("left")
  .locator(".view-toggle-seg", { hasText: "MD" })
  .evaluate((el) => el.classList.contains("is-active"));
const leftHtmlPinned = await header("left")
  .locator(".view-toggle-seg", { hasText: "HTML" })
  .isDisabled();
const rightMdPinned = await header("right")
  .locator(".view-toggle-seg", { hasText: "MD" })
  .isDisabled();
step(
  "split button: markdown focused left, rendition iframe right, cross-views pinned",
  leftFocused && rightHasIframe && leftMdActive && leftHtmlPinned && rightMdPinned,
);
await page.screenshot({ path: SHOTS + "split-same-doc.png" });

/* 3 — sync scroll ON by default: left md scroll drives the iframe */
const syncOn = await page
  .locator(".sync-scroll-toggle")
  .evaluate((el) => el.classList.contains("is-on"));
await pane("left").locator(".editor-wrap").hover();
await setWrapScroll("left", 600);
await poll(async () => (await iframeScroll()) > 100);
step(
  "sync scroll (default on): scrolling the markdown pane scrolls the rendition",
  syncOn,
  `iframe at ${await iframeScroll()}`,
);

/* 4 — sync scroll OFF: panes scroll independently */
await page.locator(".sync-scroll-toggle").click();
await page
  .frameLocator("iframe.html-preview")
  .locator("body")
  .evaluate(() => (document.scrollingElement || document.documentElement).scrollTop = 0);
await pane("left").locator(".editor-wrap").hover();
await setWrapScroll("left", 1200);
await settle(500);
const iframeStayed = (await iframeScroll()) === 0;
step("sync scroll off: the other pane stays put", iframeStayed);
await page.locator(".sync-scroll-toggle").click(); // back on

/* 5 — clicking another tab replaces the FOCUSED pane; rendition pane stays */
await page.locator(".tab-main", { hasText: "other" }).click();
await poll(async () =>
  (await pane("left").locator(".ProseMirror h1").first().textContent())?.includes("Other"),
);
const rightStillNotes =
  (await header("right").locator(".pane-header-title").textContent())?.includes("notes") &&
  (await pane("right").locator("iframe.html-preview").count()) === 1;
const rightMdNowEnabled = !(await header("right")
  .locator(".view-toggle-seg", { hasText: "MD" })
  .isDisabled());
step(
  "tab click swaps the focused pane; the old doc's rendition pane stays (two-doc split)",
  rightStillNotes && rightMdNowEnabled,
);

/* 6 — clicking inside the iframe promotes that pane (bridge gesture) */
await page.frameLocator("iframe.html-preview").locator("body").click({ position: { x: 200, y: 60 } });
await poll(async () =>
  header("right").evaluate((el) => el.classList.contains("is-focused")),
);
const notesTabActive = await page
  .locator(".tab", { hasText: "notes" })
  .evaluate((el) => el.classList.contains("is-active"));
step(
  "click inside the rendition promotes its pane (tab strip follows)",
  notesTabActive,
);

/* 7 — the focused pane's header toggle switches it to MD */
await header("right").locator(".view-toggle-seg", { hasText: "MD" }).click();
await poll(async () =>
  (await pane("right").locator(".ProseMirror h1").first().textContent())?.includes("Notes"),
);
step(
  "focused pane's MD/HTML toggle switches views in place",
  (await pane("right").locator("iframe.html-preview").count()) === 0,
);

/* 8 — the unfocused pane's editor is read-only */
const leftReadOnly = await pane("left")
  .locator(".ProseMirror")
  .evaluate((el) => el.getAttribute("contenteditable") === "false");
step("unfocused pane's editor is read-only", leftReadOnly);

/* 9 — clicking into it promotes it and makes it editable */
await pane("left").locator(".ProseMirror p").first().click();
await poll(async () =>
  header("left").evaluate((el) => el.classList.contains("is-focused")),
);
await poll(async () =>
  pane("left")
    .locator(".ProseMirror")
    .evaluate((el) => el.getAttribute("contenteditable") === "true"),
);
step("clicking the unfocused pane promotes it (editable again)", true);

/* 10 — typing in the promoted pane autosaves to ITS file */
await pane("left").locator(".ProseMirror h1").first().click();
await page.keyboard.press("End");
await page.keyboard.type(" EDITED");
await poll(async () =>
  page.evaluate(() => window.__fs.get("/docs/other.md").includes("EDITED")),
  8000,
);
step("promote → edit → autosave lands in the right file", true);

/* 11 — md↔md sync scroll */
await pane("left").locator(".editor-wrap").hover();
await setWrapScroll("left", 900);
await poll(async () => (await wrapScroll("right")) > 100);
step(
  "sync scroll drives md↔md panes too",
  true,
  `right wrap at ${await wrapScroll("right")}`,
);
await page.screenshot({ path: SHOTS + "split-two-doc.png" });

/* 12 — divider drag resizes the panes */
const before = (await pane("left").boundingBox()).width;
const div = await page.locator(".split-divider").boundingBox();
await page.mouse.move(div.x + div.width / 2, div.y + 300);
await page.mouse.down();
await page.mouse.move(div.x + div.width / 2 + 140, div.y + 300, { steps: 6 });
await page.mouse.up();
const after = (await pane("left").boundingBox()).width;
step("divider drag resizes the split", after - before > 100, `${before} → ${after}`);

/* 13 — closing the unfocused pane unsplits; its tab stays */
await header("right").locator(".pane-header-close").click();
await poll(async () => (await page.locator(".pane-header").count()) === 0);
step(
  "closing a pane unsplits (both tabs remain)",
  (await page.locator(".tab").count()) === 2 &&
    (await pane("left").locator(".ProseMirror h1").first().textContent())?.includes("Other"),
);

/* 14 — ⌘⇧\ splits with the neighbor when the doc has no rendition */
await page.keyboard.press("Meta+Shift+Backslash");
await poll(async () => (await page.locator(".pane-header").count()) === 2);
step(
  "⌘⇧\\ splits with the neighboring tab (no rendition on this doc)",
  (await header("right").locator(".pane-header-title").textContent())?.includes("notes"),
);

/* 15 — dragging a tab over the editor area shows drop zones; dropping on the
        focused half promotes that document into it */
const tabBox = await page.locator(".tab-main", { hasText: "notes" }).boundingBox();
const area = await page.locator(".editor-area").boundingBox();
await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
await page.mouse.down();
await page.mouse.move(area.x + area.width * 0.2, area.y + 200, { steps: 8 });
const overlayShown = await page.locator(".split-drop-half.is-left.is-active").isVisible();
await page.mouse.up();
await poll(async () =>
  (await header("left").locator(".pane-header-title").textContent())?.includes("notes"),
);
const leftNowFocused = await header("left").evaluate((el) =>
  el.classList.contains("is-focused"),
);
step(
  "drag a tab onto a half: drop zone lights up, drop places the doc there",
  overlayShown && leftNowFocused,
);
await page.screenshot({ path: SHOTS + "split-after-drop.png" });

/* 16 — session persistence round-trip: reload restores the split */
await page.reload();
await poll(async () => (await page.locator(".pane-header").count()) === 2, 8000);
step(
  "reload restores the split from the stored session",
  (await page.locator(".editor-pane").count()) === 2,
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed ? 1 : 0);
