// Drives the PUBLIC pages end to end in Chromium — what a visitor gets from
// a published workspace — against the real worker served by
// serve-worker.mjs over the seed workspace (cloud-worker/test/seed.mjs):
// a note's page, the MD/HTML pill and the sandboxed rendition, a folder's
// table of contents, a nested note with its crumb, a board drawn with
// JavaScript off, a diagram hydrating in light and in dark, links between
// notes, the root page, and a 404. Run:
//
//   node verify-harness/serve-worker.mjs &     # bundles the worker (mermaid included), seeds, serves :8787
//   node verify-harness/drive-public.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:8787";
const SHOTS = new URL("./shots-public/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 8000, every = 120) {
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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);

async function pageIn(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, ...options });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  return page;
}

/* 1 — a note: the title, the document, the stored column widths, noindex */
const page = await pageIn();
const sizes = await page.goto(`${BASE}/sizes`);
await poll(async () => (await page.locator("main.doc h1").count()) === 1);
const colWidth = await page.locator("table.dk-cols col").first().evaluate((el) => el.style.width);
step(
  "a note renders: title, heading, the table with its stored column widths, noindex",
  sizes.status() === 200 &&
    (await page.title()) === "Sizes" &&
    (await page.locator("main.doc h1").textContent()) === "Sizes" &&
    colWidth === "260px" &&
    (await page.locator('meta[name="robots"]').getAttribute("content")) === "noindex",
  `col width ${colWidth}`,
);
await page.screenshot({ path: SHOTS + "public-01-note.png" });

/* 2 — the pill: the html rendition leads, framed and sandboxed; MD switches */
await page.goto(`${BASE}/plan`);
const frame = page.frameLocator("iframe.raw-frame");
await poll(async () => (await frame.locator("#rendered").count()) === 1);
const ran = await frame.locator("body").getAttribute("data-ran");
await page.locator(".view-seg", { hasText: "MD" }).click();
await poll(async () => (await page.locator("main.doc").count()) === 1);
const mdUrl = page.url();
await page.locator(".view-seg", { hasText: "HTML" }).click();
await poll(async () => (await page.locator("iframe.raw-frame").count()) === 1);
step(
  "the pill: the rendition is framed (its script ran inside the sandbox), MD shows the markdown at ?v=md, HTML comes back",
  ran === "yes" && mdUrl.endsWith("/plan?v=md") && page.url().endsWith("/plan"),
  mdUrl,
);
await page.screenshot({ path: SHOTS + "public-02-rendition.png" });

/* 3 — the folder page: cards for a handful of notes */
await page.goto(`${BASE}/projects`);
await poll(async () => (await page.locator(".toc-card").count()) === 5);
const tocTitle = await page.locator(".toc-title").textContent();
const cardPath = await page.locator(".toc-card", { hasText: "Ship the boat" }).locator(".toc-card-path").textContent();
await page.locator(".toc-card", { hasText: "board" }).click();
await poll(async () => (await page.locator(".dk-board").count()) === 2);
step(
  "the folder page: the owner's title, five cards, a card wears its subfolder; a card opens the nested note",
  tocTitle === "Projects" && cardPath === "Roadmap" && page.url().endsWith("/projects/board"),
  `${tocTitle} · ${cardPath}`,
);
await page.screenshot({ path: SHOTS + "public-03-toc.png" });

/* 4 — the crumb on a nested note leads back to the folder */
const crumbLabel = await page.locator(".home-crumb-label").textContent();
await page.locator(".home-crumb").click();
await poll(async () => (await page.locator(".toc-title").count()) === 1);
step("the crumb: '← Projects' on a nested note goes back to the folder page", crumbLabel === "Projects" && page.url().endsWith("/projects"));

/* 5 — a board with JavaScript off: drawn, its cards linking to their pages */
const noJs = await pageIn({ javaScriptEnabled: false });
await noJs.goto(`${BASE}/projects/board`);
await poll(async () => (await noJs.locator(".dk-board").count()) === 2);
const columns = await noJs.locator(".dk-board").first().locator(".dk-col-name").allTextContents();
const shipHref = await noJs.locator("a.dk-card-title", { hasText: "Ship the boat" }).getAttribute("href");
await noJs.locator("a.dk-card-title", { hasText: "Ship the boat" }).click();
await poll(async () => (await noJs.locator(".dk-props").count()) === 1);
const chips = await noJs.locator(".dk-props .dk-chip").allTextContents();
step(
  "a board with JavaScript off: three columns, a card links to its nested page, the card page shows its properties",
  columns.join("|") === "Backlog|In progress|Done" &&
    shipHref === "/projects/Roadmap/Ship%20the%20boat" &&
    chips.join("|") === "In progress|Ada|hull",
  `${columns.join("|")} · ${chips.join("|")}`,
);
await noJs.screenshot({ path: SHOTS + "public-05-board-nojs.png" });
await noJs.context().close();

/* 6 — a diagram hydrates, and takes the page's palette in light and in dark */
await page.goto(`${BASE}/diagram`);
await poll(async () => (await page.locator(".dk-mermaid svg").count()) === 1, 20000);
const lightSvg = await page.locator(".dk-mermaid svg").innerHTML();
const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.screenshot({ path: SHOTS + "public-06-diagram-light.png" });
const dark = await pageIn({ colorScheme: "dark" });
await dark.goto(`${BASE}/diagram`);
await poll(async () => (await dark.locator(".dk-mermaid svg").count()) === 1, 20000);
const darkSvg = await dark.locator(".dk-mermaid svg").innerHTML();
const darkBg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
await dark.screenshot({ path: SHOTS + "public-06-diagram-dark.png" });
await dark.context().close();
step(
  "a diagram: the code block becomes an SVG in light and in dark, and the two are drawn with different palettes",
  lightSvg.length > 200 &&
    darkSvg.length > 200 &&
    lightSvg !== darkSvg &&
    lightBg === "rgb(255, 255, 255)" &&
    darkBg === "rgb(25, 25, 25)" &&
    (await page.locator("code.language-mermaid").count()) === 0,
  `${lightBg} / ${darkBg}`,
);

/* 7 — the root page and its links */
await page.goto(`${BASE}/`);
await poll(async () => (await page.locator("main.doc h1").count()) === 1);
const planHref = await page.locator("main.doc a", { hasText: "the plan" }).getAttribute("href");
const boardHref = await page.locator("main.doc a", { hasText: "board" }).getAttribute("href");
const scratchLinks = await page.locator("main.doc a", { hasText: "scratch note" }).count();
const picSrc = await page.locator("main.doc img").first().getAttribute("src");
step(
  "the root page: Home at /, links rewritten to public addresses, an unpublished target left as text, a picture inside the folder share resolves",
  (await page.locator("main.doc h1").textContent()) === "Home" &&
    planHref === "/plan" &&
    boardHref === "/projects/board" &&
    scratchLinks === 0 &&
    picSrc === "/projects/assets/pic.png",
  `${planHref} ${boardHref} ${picSrc}`,
);

/* 8 — what isn't there */
const missing = await page.goto(`${BASE}/nope`);
const sub = await page.goto(`${BASE}/projects/Roadmap`);
step(
  "404: an unknown slug and a subfolder inside a published folder both get the 404 page",
  missing.status() === 404 && sub.status() === 404 && (await page.locator("h1").textContent()) === "Nothing here",
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
