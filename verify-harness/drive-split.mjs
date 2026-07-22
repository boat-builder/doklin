// Drives the REAL App's split view in Chromium (split.html boots <App/> over
// an in-memory IPC stub with a /docs workspace): VS Code-style same-document
// splits (duplicate view + read-only mirror that tracks autosaves), free
// per-pane MD/HTML picks with live-editor normalization, two-document splits
// with promotion, sync scroll OFF by default (opt-in chain), divider and
// sidebar resizing, and drag-to-pane from both the tab bar and the file
// tree.
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
const seg = (side, label) =>
  header(side).locator(".view-toggle-seg", { hasText: label });
const paneEditable = (side) =>
  pane(side)
    .locator(".ProseMirror")
    .evaluate((el) => el.getAttribute("contenteditable") === "true");
const headerFocused = (side) =>
  header(side).evaluate((el) => el.classList.contains("is-focused"));
const setWrapScroll = (side, top) =>
  pane(side)
    .locator(".editor-wrap")
    .evaluate((el, t) => {
      el.scrollTop = t;
    }, top);
const wrapScroll = (side) =>
  pane(side).locator(".editor-wrap").evaluate((el) => el.scrollTop);
const iframeScroll = () =>
  page
    .frameLocator("iframe.html-preview")
    .locator("body")
    .evaluate(() => (document.scrollingElement || document.documentElement).scrollTop);

/* 1 — boot: single pane, sidebar tree, notes.md */
await poll(async () => (await page.locator(".milkdown .ProseMirror").count()) === 1);
await poll(async () =>
  (await page.locator(".ProseMirror h1").first().textContent())?.includes("Notes"),
);
await poll(async () => (await page.locator('[data-tree-path="/docs/third.md"]').count()) === 1);
step(
  "boots: single pane, /docs sidebar listed, notes.md in the editor",
  (await page.locator(".pane-header").count()) === 0,
);

/* 2 — split button duplicates the SAME doc in the SAME view (md|md mirror) */
await page.locator(".split-toggle").click();
await poll(async () => (await page.locator(".pane-header").count()) === 2);
const bothTitledNotes =
  (await header("left").locator(".pane-header-title").textContent())?.includes("notes") &&
  (await header("right").locator(".pane-header-title").textContent())?.includes("notes");
const rightIsMirror = !(await paneEditable("right"));
const bothMdActive =
  (await seg("left", "MD").evaluate((el) => el.classList.contains("is-active"))) &&
  (await seg("right", "MD").evaluate((el) => el.classList.contains("is-active")));
const rightHtmlEnabled = !(await seg("right", "HTML").isDisabled());
step(
  "split opens the SAME doc twice, same view: left live, right read-only mirror, toggles free",
  bothTitledNotes && rightIsMirror && bothMdActive && rightHtmlEnabled && (await paneEditable("left")),
);
await page.screenshot({ path: SHOTS + "split-mirror.png" });

/* 3 — the mirror tracks the live editor through autosaves */
await pane("left").locator(".ProseMirror h1").first().click();
await page.keyboard.press("End");
await page.keyboard.type(" MIRRORTEST");
await poll(
  async () =>
    (await pane("right").locator(".ProseMirror h1").first().textContent())?.includes(
      "MIRRORTEST",
    ),
  8000,
);
step("mirror pane refreshes from the autosave", true);

/* 4 — sync scroll is OFF by default */
const chainOff = !(await page
  .locator(".sync-scroll-toggle")
  .evaluate((el) => el.classList.contains("is-on")));
step("sync scroll defaults to OFF (independent panes)", chainOff);

/* 5 — manual md|html: pick HTML on the right pane's own toggle */
await seg("right", "HTML").click();
await poll(async () => (await pane("right").locator("iframe.html-preview").count()) === 1);
step(
  "right pane's toggle switches it to the HTML rendition (md | html by hand)",
  (await paneEditable("left")) && (await headerFocused("left")),
);

/* 6 — with sync off, scrolling the md pane leaves the rendition alone */
await pane("left").locator(".editor-wrap").hover();
await setWrapScroll("left", 800);
await settle(500);
step("sync off: rendition stays put while the markdown scrolls", (await iframeScroll()) === 0);

/* 7 — chain on: panes scroll together */
await page.locator(".sync-scroll-toggle").click();
await pane("left").locator(".editor-wrap").hover();
await setWrapScroll("left", 1400);
await poll(async () => (await iframeScroll()) > 100);
step("sync on: markdown drives the rendition", true, `iframe at ${await iframeScroll()}`);

/* 8 — right pane back to MD → read-only mirror again */
await seg("right", "MD").click();
await poll(async () => (await pane("right").locator(".ProseMirror").count()) === 1);
step(
  "right pane back to MD becomes the read-only mirror again",
  !(await paneEditable("right")),
);

/* 9 — normalization: focused pane picks HTML while the other shows MD —
       the LIVE editor follows the markdown view (panes swap roles) */
await seg("left", "HTML").click();
await poll(async () => (await pane("left").locator("iframe.html-preview").count()) === 1);
await poll(async () => paneEditable("right"));
step(
  "focused→HTML with markdown opposite: live editor moves to the md pane (normalize)",
  (await headerFocused("right")) && !(await headerFocused("left")),
);

/* 10 — the relocated live editor still autosaves to the right file */
await pane("right").locator(".ProseMirror h1").first().click();
await page.keyboard.press("End");
await page.keyboard.type(" SWAPPED");
await poll(
  async () => page.evaluate(() => window.__fs.get("/docs/notes.md").includes("SWAPPED")),
  8000,
);
step("relocated live editor autosaves to its own file", true);

/* 11 — clicking another tab replaces the FOCUSED pane; the html pane stays */
await page.locator(".tab-main", { hasText: "other" }).click();
await poll(async () =>
  (await pane("right").locator(".ProseMirror h1").first().textContent())?.includes("Other"),
);
step(
  "tab click swaps the focused pane; the outgoing doc's rendition pane stays",
  (await header("left").locator(".pane-header-title").textContent())?.includes("notes") &&
    (await pane("left").locator("iframe.html-preview").count()) === 1,
);

/* 12 — clicking inside the rendition iframe promotes that pane */
await page
  .frameLocator("iframe.html-preview")
  .locator("body")
  .click({ position: { x: 200, y: 60 } });
await poll(async () => headerFocused("left"));
step(
  "click inside the rendition promotes its pane",
  await page
    .locator(".tab", { hasText: "notes" })
    .evaluate((el) => el.classList.contains("is-active")),
);

/* 13 — focused pane to MD; md↔md sync across two documents */
await seg("left", "MD").click();
await poll(async () => paneEditable("left"));
await pane("left").locator(".editor-wrap").hover();
await setWrapScroll("left", 900);
await poll(async () => (await wrapScroll("right")) > 100);
step("md↔md sync scroll across two documents", true, `right at ${await wrapScroll("right")}`);
await page.screenshot({ path: SHOTS + "split-two-doc.png" });

/* 14 — divider drag resizes the split */
{
  const before = (await pane("left").boundingBox()).width;
  const div = await page.locator(".split-divider").boundingBox();
  await page.mouse.move(div.x + div.width / 2, div.y + 300);
  await page.mouse.down();
  await page.mouse.move(div.x + div.width / 2 + 120, div.y + 300, { steps: 6 });
  await page.mouse.up();
  const after = (await pane("left").boundingBox()).width;
  step("divider drag resizes the split", after - before > 80, `${before} → ${after}`);
}

/* 15 — dragging a file from the SIDEBAR into a pane opens it there */
{
  const row = await page.locator('[data-tree-path="/docs/third.md"]').boundingBox();
  const area = await page.locator(".editor-area").boundingBox();
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.8, area.y + 240, { steps: 10 });
  const overlayShown = await page.locator(".split-drop-half.is-right.is-active").isVisible();
  await page.mouse.up();
  await poll(async () =>
    (await header("right").locator(".pane-header-title").textContent())?.includes("third"),
  );
  const activeStillNotes = await page
    .locator(".tab", { hasText: "notes" })
    .evaluate((el) => el.classList.contains("is-active"));
  step(
    "sidebar file dragged onto a half opens THERE (tab added, focus untouched)",
    overlayShown && activeStillNotes && (await page.locator(".tab").count()) === 3,
  );
}
await page.screenshot({ path: SHOTS + "split-tree-drop.png" });

/* 16 — the sidebar's edge is draggable too */
{
  const before = (await page.locator(".sidebar").boundingBox()).width;
  const handle = await page.locator(".sidebar-resize").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 300);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + 300, { steps: 6 });
  await page.mouse.up();
  const after = (await page.locator(".sidebar").boundingBox()).width;
  step("sidebar width drags like the split divider", after - before > 60, `${before} → ${after}`);
}

/* 17 — closing a pane unsplits; every tab stays */
await header("right").locator(".pane-header-close").click();
await poll(async () => (await page.locator(".pane-header").count()) === 0);
step("closing a pane unsplits (tabs all remain)", (await page.locator(".tab").count()) === 3);

/* 18 — ⌘⇧\ same-doc split + session-restore round trip */
await page.keyboard.press("Meta+Shift+Backslash");
await poll(async () => (await page.locator(".pane-header").count()) === 2);
const dupTitles =
  (await header("left").locator(".pane-header-title").textContent()) ===
  (await header("right").locator(".pane-header-title").textContent());
await page.reload();
await poll(async () => (await page.locator(".pane-header").count()) === 2, 8000);
step(
  "⌘⇧\\ duplicates the active doc; reload restores the split from the session",
  dupTitles && (await page.locator(".editor-pane").count()) === 2,
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed ? 1 : 0);
