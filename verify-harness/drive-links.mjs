// Drives click-to-follow for links in the editor (src/linkOpen.ts) in
// Chromium: which clicks follow a link and which fall through to the caret,
// that a follow never navigates the page out from under the app, that
// in-document #anchors scroll here instead of reaching the host, and that a
// read-only document still follows links. Needs the repo-root vite dev server
// (port 1420) — see .claude/skills/verify/SKILL.md.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 15000, every = 100) {
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

// CI runner has the browser preinstalled at a fixed path; on a dev machine
// fall back to playwright's own cache.
const RUNNER_CHROMIUM = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(RUNNER_CHROMIUM) ? { executablePath: RUNNER_CHROMIUM } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 940 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const START = "http://localhost:1420/verify-harness/links.html";
// Any navigation is a failure by itself: in the desktop webview it would
// replace Doklin with the site.
const navigations = [];
page.on("framenavigated", (f) => {
  if (f === page.mainFrame() && f.url() !== START) navigations.push(f.url());
});
// Same for a link that escapes into a new tab of its own.
const popups = [];
page.on("popup", (p) => popups.push(p.url()));

await page.goto(START);
await poll(async () =>
  (await page.evaluate(
    () => document.querySelectorAll(".milkdown .ProseMirror a").length,
  )) === 6,
);

const opened = () => page.evaluate(() => window.__opened);
const link = (text) => page.locator(".milkdown .ProseMirror a", { hasText: text });
const caretInLink = () =>
  page.evaluate(() => {
    const node = document.getSelection()?.anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!(el instanceof HTMLElement && el.closest("a"));
  });

/* ---------- Affordance ---------- */

step(
  "links carry a pointer cursor",
  (await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".milkdown .ProseMirror a")).cursor,
  )) === "pointer",
);

/* ---------- A plain click follows the link ---------- */

await link("example docs").click();
await page.waitForTimeout(150);
step(
  "plain click hands the external url to the host",
  JSON.stringify(await opened()) === JSON.stringify(["https://example.com/docs"]),
  JSON.stringify(await opened()),
);
step("following a link never navigates the page", navigations.length === 0);
step("following a link never opens a browser tab of its own", popups.length === 0);
step(
  "the document is untouched by the click",
  (await page.evaluate(() => window.__md)).includes(
    "[example docs](https://example.com/docs)",
  ),
);

await link("write to us").click();
await link("the other note").click();
await page.waitForTimeout(150);
step(
  "mailto and relative-path links reach the host verbatim",
  JSON.stringify(await opened()) ===
    JSON.stringify([
      "https://example.com/docs",
      "mailto:hi@example.com",
      "./other-note.md",
    ]),
  JSON.stringify(await opened()),
);

await link("bold link").click();
await page.waitForTimeout(150);
step(
  "a link nested in bold text follows too",
  (await opened()).at(-1) === "https://example.com/list",
  (await opened()).at(-1),
);

/* ---------- A hostile href is inert ---------- */

// The editor hands every followed href to its host verbatim — deciding what a
// scheme is allowed to do is the host's job, and the click itself must never
// be what runs it.
await link("do not run this").click();
await page.waitForTimeout(150);
step(
  "a javascript: link does not execute on click",
  (await page.evaluate(() => window.__pwned)) === undefined,
);
step("…and does not navigate the page", navigations.length === 0 && popups.length === 0);

// The plain host behavior (the editor's own host-less fallback) only hands a
// browser tab the schemes a page link may carry.
step(
  "openInBrowserTab drops schemes a note has no business running",
  JSON.stringify(
    await page.evaluate(() => {
      const asked = [];
      const real = window.open;
      window.open = (url) => {
        asked.push(url);
        return null;
      };
      for (const href of [
        "https://example.com/a",
        "mailto:hi@example.com",
        "./other-note.md",
        "javascript:window.__pwned=true",
        "data:text/html,<b>x</b>",
        "doklin://open",
      ]) {
        window.__openInBrowserTab(href);
      }
      window.open = real;
      return asked;
    }),
  ) ===
    JSON.stringify([
      "https://example.com/a",
      "mailto:hi@example.com",
      "./other-note.md",
    ]),
);

/* ---------- Modifier / drag / double click stay editing gestures ---------- */

const before = (await opened()).length;

await link("example docs").click({ modifiers: ["Meta"] });
await page.waitForTimeout(120);
step("⌘-click does not follow", (await opened()).length === before);
step("⌘-click puts the caret in the link text", await caretInLink());

await link("example docs").click({ modifiers: ["Alt"] });
await page.waitForTimeout(120);
step("⌥-click does not follow", (await opened()).length === before);

// A double click opens its first (plain) click, same as double-clicking a
// link on any web page — what must not happen is a SECOND follow behind the
// word selection.
await link("example docs").dblclick();
await page.waitForTimeout(120);
step("double click follows exactly once", (await opened()).length === before + 1);
step(
  "double click still selects the word",
  (await page.evaluate(() => document.getSelection()?.toString() ?? "")).length > 0,
);

// Drag across the link (press inside it, release past its end): a selection
// gesture, not a follow.
const beforeDrag = (await opened()).length;
const box = await link("example docs").boundingBox();
await page.mouse.move(box.x + 4, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(120);
step(
  "dragging out of a link selects instead of following",
  (await opened()).length === beforeDrag,
);
step(
  "the drag left a real selection",
  (await page.evaluate(() => document.getSelection()?.toString() ?? "")).length > 0,
);
await page.screenshot({ path: `${SHOTS}/links-01.png` });

/* ---------- In-document #anchors scroll, and stay in the editor ---------- */

const scrollTopOf = () =>
  page.evaluate(() => document.querySelector(".editor-wrap").scrollTop);
// The scroll is smooth — wait for it to come to rest, not just to start.
const settledScroll = async () => {
  let last = -1;
  return poll(async () => {
    const now = await scrollTopOf();
    const settled = now === last ? now : null;
    last = now;
    return settled;
  });
};
const beforeAnchor = (await opened()).length;
await page.evaluate(() => {
  document.querySelector(".editor-wrap").scrollTop = 0;
});
await page.waitForTimeout(100);
await link("jump to the section").click();
const scrolled = await settledScroll();
step("clicking an #anchor scrolls to its heading", scrolled > 300, `scrollTop ${scrolled}`);
step(
  "the heading is what landed in view",
  await page.evaluate(() => {
    const h = [...document.querySelectorAll(".milkdown .ProseMirror h2")].find(
      (el) => el.textContent === "A later section",
    );
    const wrap = document.querySelector(".editor-wrap").getBoundingClientRect();
    const box = h.getBoundingClientRect();
    return box.top >= wrap.top - 8 && box.top < wrap.top + 120;
  }),
);
step("an #anchor is never handed to the host", (await opened()).length === beforeAnchor);
await page.screenshot({ path: `${SHOTS}/links-02.png` });

/* ---------- Crepe's hover tooltip: its url is a follow too ---------- */

await page.evaluate(() => {
  document.querySelector(".editor-wrap").scrollTop = 0;
});
await page.waitForTimeout(300);
// The preview only shows while the editor has focus — click into the text
// first, then hover the link.
await page.locator(".milkdown .ProseMirror p").first().click();
await link("example docs").hover();
const tipHref = await poll(async () =>
  page.evaluate(() => {
    const t = document.querySelector(".milkdown-link-preview .link-display");
    return t && t.getBoundingClientRect().width > 0 ? t.getAttribute("href") : null;
  }),
);
step("hovering a link shows Crepe's url tooltip", tipHref === "https://example.com/docs", tipHref);
await page.locator(".milkdown-link-preview .link-display").click();
await page.waitForTimeout(150);
step(
  "clicking the tooltip's url follows the link",
  (await opened()).at(-1) === "https://example.com/docs" &&
    (await opened()).length === beforeAnchor + 1,
  JSON.stringify(await opened()),
);
step("the tooltip's url never navigates the page", navigations.length === 0 && popups.length === 0);

/* ---------- Read-only documents follow links as well ---------- */

const readOnlyBefore = (await opened()).length;
await page.click("#toggle-readonly");
await poll(async () =>
  (await page.evaluate(() => document.getElementById("readonly-state").textContent)) ===
  "read-only",
);
await poll(async () =>
  (await page.evaluate(
    () => document.querySelectorAll(".milkdown .ProseMirror a").length,
  )) === 6,
);
await link("example docs").click();
await page.waitForTimeout(150);
step(
  "a read-only document still follows links",
  (await opened()).length === readOnlyBefore + 1 &&
    (await opened()).at(-1) === "https://example.com/docs",
  JSON.stringify((await opened()).slice(-1)),
);
step("read-only follow does not navigate either", navigations.length === 0 && popups.length === 0);
await page.screenshot({ path: `${SHOTS}/links-03.png` });

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
