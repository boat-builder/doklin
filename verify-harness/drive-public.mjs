// Drives the PUBLIC pages end to end in Chromium — what a visitor gets from
// a published workspace — against the real worker served by
// serve-worker.mjs over the seed workspace (cloud-worker/test/seed.mjs):
// a note's page, the MD/HTML pill and the sandboxed rendition, a folder's
// table of contents, a nested note with its crumb, a note whose frontmatter
// is left off its page, a diagram hydrating in light and in dark, the app's
// own type and palettes, links between notes, the root page, and a 404. Run:
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
await page.locator(".toc-card", { hasText: "status" }).click();
await poll(async () => (await page.locator("main.doc h1").textContent()) === "Status");
step(
  "the folder page: the owner's title, five cards, a card wears its subfolder; a card opens the nested note",
  tocTitle === "Projects" && cardPath === "Roadmap" && page.url().endsWith("/projects/status"),
  `${tocTitle} · ${cardPath}`,
);
await page.screenshot({ path: SHOTS + "public-03-toc.png" });

/* 4 — the crumb on a nested note leads back to the folder */
const crumbLabel = await page.locator(".home-crumb-label").textContent();
await page.locator(".home-crumb").click();
await poll(async () => (await page.locator(".toc-title").count()) === 1);
step("the crumb: '← Projects' on a nested note goes back to the folder page", crumbLabel === "Projects" && page.url().endsWith("/projects"));

/* 5 — a note that opens with a frontmatter block: the page is its body alone */
await page.goto(`${BASE}/projects/Roadmap/Ship%20the%20boat`);
await poll(async () => (await page.locator("main.doc p").count()) === 1);
const shipText = (await page.locator("main.doc").innerText()).trim();
const shipRules = await page.locator("main.doc hr").count();
step(
  "a note's frontmatter is left off its page: the document is the body alone, and the title is the file's name",
  shipText === "The hull is done." && shipRules === 0 && (await page.title()) === "Ship the boat",
  JSON.stringify(shipText),
);
await page.screenshot({ path: SHOTS + "public-05-frontmatter.png" });

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
    darkBg === "rgb(11, 11, 11)" &&
    (await page.locator("code.language-mermaid").count()) === 0,
  `${lightBg} / ${darkBg}`,
);

/* 6a — drawings are drawn by the worker: there with scripts off, each with
   its own marker, in the page's drawing tokens light and dark */
const drawingLook = async (scheme) => {
  const p = await pageIn({ colorScheme: scheme, javaScriptEnabled: false });
  await p.goto(`${BASE}/diagram`);
  const got = await p.evaluate(() => {
    const svgs = [...document.querySelectorAll(".dk-drawing svg")];
    return {
      count: svgs.length,
      width: Math.round(svgs[0]?.getBoundingClientRect().width ?? 0),
      stroke: svgs[0] ? getComputedStyle(svgs[0].querySelector("line")).stroke : "",
      markers: svgs.map((s) => s.querySelector("marker")?.id),
      scripts: document.querySelectorAll(".dk-drawing script").length,
      broken: document.querySelectorAll("code.language-svg").length,
    };
  });
  await p.screenshot({ path: SHOTS + `public-06a-drawings-${scheme}.png`, fullPage: true });
  await p.context().close();
  return got;
};
const lightDrawings = await drawingLook("light");
const darkDrawings = await drawingLook("dark");
step(
  "drawings: drawn with scripts off, full column width, own markers, nothing executable, the theme's rule colour light and dark, a broken one left as source",
  lightDrawings.count === 2 &&
    lightDrawings.width === 672 &&
    lightDrawings.markers.join() === "dg1-arrow,dg2-arrow" &&
    lightDrawings.scripts === 0 &&
    lightDrawings.broken === 1 &&
    lightDrawings.stroke === "rgb(195, 194, 183)" &&
    darkDrawings.stroke === "rgb(56, 56, 53)",
  JSON.stringify({ lightDrawings, darkStroke: darkDrawings.stroke }),
);

/* 6b — the app's look: its fonts, its measure, its palettes */
await page.goto(`${BASE}/home`);
await page.evaluate(() => document.fonts.ready);
const type = await page.evaluate(() => {
  const doc = getComputedStyle(document.querySelector("main.doc"));
  const p = getComputedStyle(document.querySelector("main.doc p"));
  return {
    face: doc.fontFamily.split(",")[0].replace(/"/g, ""),
    heading: (() => {
      const h1 = getComputedStyle(document.querySelector("main.doc h1"));
      return `${h1.fontFamily.split(",")[0].replace(/"/g, "")} ${h1.fontWeight} ${h1.fontSize}`;
    })(),
    size: p.fontSize,
    loaded: document.fonts.check('16px "Inter"') && document.fonts.check('32px "Literata"'),
    served: performance.getEntriesByType("resource").some((r) => r.name.includes("/__web/fonts/")),
    chrome: getComputedStyle(document.querySelector("footer")).fontFamily.split(",")[0],
    // The reading measure: the column's content box, without its padding.
    measure: Math.round(
      document.querySelector("main.doc").getBoundingClientRect().width -
        parseFloat(doc.paddingLeft) -
        parseFloat(doc.paddingRight),
    ),
    accent: getComputedStyle(document.querySelector("main.doc a")).color,
  };
});
const darkHome = await pageIn({ colorScheme: "dark" });
await darkHome.goto(`${BASE}/home`);
const darkLink = await darkHome.evaluate(() => getComputedStyle(document.querySelector("main.doc a")).color);
await darkHome.screenshot({ path: SHOTS + "public-06b-home-dark.png" });
await darkHome.context().close();
await page.screenshot({ path: SHOTS + "public-06b-home-light.png" });
step(
  "the app's look: text in the bundled Inter at 16px and headings in Literata 400 at 32px, in the 672px column, the chrome in the UI face, links in the light and dark link colours",
  type.face === "Inter" &&
    type.heading === "Literata 400 32px" &&
    type.size === "16px" &&
    type.loaded &&
    type.served &&
    type.chrome === "Inter" &&
    type.measure === 672 &&
    type.accent === "rgb(37, 106, 191)" &&
    darkLink === "rgb(57, 135, 229)",
  JSON.stringify({ ...type, darkLink }),
);

/* 7 — the root page and its links */
await page.goto(`${BASE}/`);
await poll(async () => (await page.locator("main.doc h1").count()) === 1);
const planHref = await page.locator("main.doc a", { hasText: "the plan" }).getAttribute("href");
const statusHref = await page.locator("main.doc a", { hasText: "status" }).getAttribute("href");
const scratchLinks = await page.locator("main.doc a", { hasText: "scratch note" }).count();
const picSrc = await page.locator("main.doc img").first().getAttribute("src");
step(
  "the root page: Home at /, links rewritten to public addresses, an unpublished target left as text, a picture inside the published folder resolves",
  (await page.locator("main.doc h1").textContent()) === "Home" &&
    planHref === "/plan" &&
    statusHref === "/projects/status" &&
    scratchLinks === 0 &&
    picSrc === "/projects/assets/pic.png",
  `${planHref} ${statusHref} ${picSrc}`,
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
