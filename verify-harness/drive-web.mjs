// Drives the PUBLIC web comment flow on an html page — gate unlock, the
// anchored comment layer, role gating, and the no-JS fallback — against the
// real worker served by serve-worker.mjs. Run:
//
//   node verify-harness/serve-worker.mjs &
//   node verify-harness/drive-web.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:8787";
const OWNER = "owner-secret";
const SHOTS = new URL("./shots-web/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 5000, every = 100) {
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

/* ----- seed a gated pair page through the owner API ----- */

const api = (path, body, method = "PUT") =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// Comments live in their own object and survive page re-pushes (by design),
// so clear the slate for a repeatable run.
await api("/api/pages/brief-web/comments", undefined, "DELETE");
await api("/api/pages/brief-web", {
  title: "Web Brief",
  markdown: "# Web Brief\n\nThe opening line of the brief.",
  html: `<!doctype html><html><head><style>
    body { font-family: Georgia, serif; margin: 0; background: #fff; }
    main { max-width: 620px; margin: 0 auto; padding: 32px 24px; }
  </style></head><body><main>
  <h1>Web Brief</h1>
  <p id="opening">The opening line of the brief.</p>
  <div class="callout"><p>A callout block with a <button id="cta" onclick="this.textContent='pressed'">Press me</button>.</p></div>
  <p id="closing">The closing line.</p>
  </main></body></html>`,
});
await api(
  "/api/pages/brief-web/access/codes",
  { label: "Reviewer", code: "web-comment-code", role: "comment" },
  "POST",
);
await api(
  "/api/pages/brief-web/access/codes",
  { label: "Reader", code: "web-view-code", role: "view" },
  "POST",
);

/* ----- the reviewer's journey ----- */

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

// 1. Gate, then unlock with the comment-role code.
await page.goto(`${BASE}/brief-web`);
await poll(async () => page.locator("#gate-code").isVisible());
await page.screenshot({ path: `${SHOTS}/01-gate.png` });
await page.fill("#gate-code", "web-comment-code");
await page.press("#gate-code", "Enter");
await poll(async () => page.locator("#comments").isVisible());
step("unlock lands on the html view with the comments section below", true);
step("the anchor chip starts hidden", await page.locator("#dkw-chip").isHidden());

const frame = page.frameLocator("iframe.raw-frame-flow");
await poll(async () => (await frame.locator("#opening").count()) === 1);
await poll(async () => (await frame.locator("#dkw-bubble").count()) === 1);
step("rendition renders in the flowing frame with the bridge installed", true);

// 2. Hover a paragraph, click the settled bubble → chip + focused composer.
const target = frame.locator("#opening");
await target.hover();
await poll(async () => {
  const t = await target.boundingBox();
  const b = await frame.locator("#dkw-bubble.dkw-on").boundingBox();
  return !!t && !!b && Math.abs(b.y - t.y - 4) < 8;
});
await frame.locator("#dkw-bubble").click();
await poll(async () => page.locator("#dkw-chip:not([hidden])").isVisible());
const chipText = await page.locator("#dkw-chip").textContent();
const pathVal = await page.locator('input[name="anchor_path"]').inputValue();
step(
  "bubble pick fills the chip + hidden anchor fields",
  chipText.includes("The opening line") && pathVal.includes("p:nth-of-type"),
  pathVal,
);
const focused = await page.evaluate(() => document.activeElement?.className || "");
step("composer textarea is focused after the pick", focused.includes("comment-text"));
await page.screenshot({ path: `${SHOTS}/02-picked.png` });

// 3. Post → lands back on the html view; comment listed + element highlighted.
await page.keyboard.type("Open with the metric instead.");
await page.click(".comment-post");
await poll(async () => page.url().endsWith("#comments"));
await poll(async () => page.locator(".comment-list").isVisible());
const listed = await page.locator(".comment-list").textContent();
step(
  "post returns to the html view and the comment is listed with its quote",
  page.url().includes("/brief-web#comments") &&
    listed.includes("Open with the metric instead.") &&
    listed.includes("The opening line"),
);
const frame2 = page.frameLocator("iframe.raw-frame-flow");
await poll(async () => (await frame2.locator("#opening[data-dkw-c]").count()) === 1);
step("the commented element is highlighted in the rendition", true);
await page.screenshot({ path: `${SHOTS}/03-posted.png` });

// 4. Element → list: clicking the highlighted paragraph flashes its comment.
await frame2.locator("#opening").click();
await poll(async () => (await page.locator(".comment.is-flash").count()) === 1);
step("clicking the highlighted element flashes its comment in the list", true);

// 5. List → element: "Show in document" flashes the paragraph.
await page.locator(".comment-reveal").first().click();
await poll(async () => (await frame2.locator("#opening[data-dkw-flash]").count()) === 1);
step("'Show in document' scrolls/flashes the element in the frame", true);

// 6. The rendition's own interactivity is untouched by the layer.
await frame2.locator("#cta").click();
const ctaText = await frame2.locator("#cta").textContent();
const commentCount = await page.locator(".comment").count();
step(
  "page's own button still works; its click creates no comment",
  ctaText === "pressed" && commentCount === 1,
);

// 7. Chip clear: pick then × posts the next comment unanchored.
const closing = frame2.locator("#closing");
await closing.hover();
await poll(async () => {
  const t = await closing.boundingBox();
  const b = await frame2.locator("#dkw-bubble.dkw-on").boundingBox();
  return !!t && !!b && Math.abs(b.y - t.y - 4) < 8;
});
await frame2.locator("#dkw-bubble").click();
await poll(async () => page.locator("#dkw-chip:not([hidden])").isVisible());
await page.click("#dkw-chip-clear");
const clearedPath = await page.locator('input[name="anchor_path"]').inputValue();
step("chip × clears the pending anchor", clearedPath === "");

/* ----- role gating: a view code sees no comment machinery ----- */

const viewerPage = await (await browser.newContext()).newPage();
await viewerPage.goto(`${BASE}/brief-web`);
await viewerPage.fill("#gate-code", "web-view-code");
await viewerPage.press("#gate-code", "Enter");
await poll(async () => (await viewerPage.locator("iframe.raw-frame").count()) === 1);
const viewerHasComments = await viewerPage.locator("#comments").count();
const viewerBubble = await viewerPage
  .frameLocator("iframe.raw-frame")
  .locator("#dkw-bubble")
  .count();
step(
  "view-role session gets the plain fixed frame — no section, no bubble",
  viewerHasComments === 0 && viewerBubble === 0,
);

/* ----- no-JS parity: the flat section still reads and posts ----- */

const nojs = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
await nojs.goto(`${BASE}/brief-web`);
await nojs.fill("#gate-code", "web-comment-code");
await Promise.all([nojs.waitForNavigation(), nojs.press("#gate-code", "Enter")]);
const nojsHtml = await nojs.content();
step(
  "without JS: comments render, the form posts, the layer stays out of the way",
  nojsHtml.includes("Open with the metric instead.") && nojsHtml.includes("comment-form"),
);
await nojs.fill(".comment-text", "Posted without JS.");
await Promise.all([nojs.waitForNavigation(), nojs.click(".comment-post")]);
const nojsAfter = await nojs.content();
step("no-JS post lands", nojsAfter.includes("Posted without JS."));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed`);
await browser.close();
process.exit(results.some((r) => !r.ok) ? 1 : 0);
