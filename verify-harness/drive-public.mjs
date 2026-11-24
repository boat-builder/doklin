// Drives the PUBLIC pages end to end in Chromium — what a visitor gets from
// a published workspace — against the real worker served by
// serve-worker.mjs over the seed workspace (cloud-worker/test/seed.mjs):
// a note's page, the MD/HTML pill and the sandboxed rendition, a folder's
// table of contents, a nested note with its crumb, a note whose frontmatter
// is left off its page, a flowchart drawn by the page's module (the same
// picture in light and in dark, laid out for the column on a phone, its
// source with scripts off) beside another kind of diagram left as its
// source, the app's own type and palettes, HTML written into a note refused
// by the page's policy, links between notes, the root page, a picture in the
// workspace shown as its alt text, an html document by its exact path, and a
// 404. Run:
//
//   node verify-harness/serve-worker.mjs --no-app &     # bundles the worker, seeds, serves :8787
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
  // What a page's policy refused, where a step can read it. The driver's own
  // script, so no policy applies to it.
  await context.addInitScript(() => {
    window.__refused = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__refused.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  return page;
}
const refusedOn = (p) => p.evaluate(() => window.__refused);

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

/* 6 — a flowchart: the page's module swaps its code block for the picture,
   and the picture takes the page's palette in light and in dark */
const flowchartLook = (p) =>
  p.evaluate(() => {
    const doc = document.querySelector("main.doc");
    const cs = getComputedStyle(doc);
    const svg = document.querySelector("figure.dk-flowchart > svg");
    const rect = svg.querySelector("rect[stroke]");
    // What the stroke's token is on this page, read off an element of the page's own.
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = rect.getAttribute("stroke");
    const token = getComputedStyle(probe).color;
    probe.remove();
    return {
      drew: document.documentElement.dataset.flowcharts,
      module: [...document.querySelectorAll("script")].map((el) => el.getAttribute("src")).filter(Boolean),
      marked: document.querySelectorAll("pre[data-dk-flowchart]").length,
      markup: svg.outerHTML,
      viewBox: svg.getAttribute("viewBox"),
      role: svg.getAttribute("role"),
      tags: [...new Set([...svg.querySelectorAll("*")].map((el) => el.tagName))].sort().join(),
      words: [...svg.querySelectorAll("text")].map((t) => t.textContent).join(),
      width: Math.round(svg.getBoundingClientRect().width),
      column: Math.round(doc.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      stroke: getComputedStyle(rect).stroke,
      token,
      background: getComputedStyle(document.body).backgroundColor,
      // Every ```mermaid block still a code block: its first line, and whether it is on show.
      sources: [...document.querySelectorAll("pre > code.language-mermaid")].map((code) => ({
        first: code.textContent.split("\n")[0],
        shown: code.getClientRects().length > 0,
        marked: code.parentElement.hasAttribute("data-dk-flowchart"),
      })),
    };
  });
await page.goto(`${BASE}/diagram`);
await poll(async () => (await page.locator("figure.dk-flowchart > svg").count()) === 1);
const lightChart = await flowchartLook(page);
await page.screenshot({ path: SHOTS + "public-06-flowchart-light.png" });
const dark = await pageIn({ colorScheme: "dark" });
await dark.goto(`${BASE}/diagram`);
await poll(async () => (await dark.locator("figure.dk-flowchart > svg").count()) === 1);
const darkChart = await flowchartLook(dark);
await dark.screenshot({ path: SHOTS + "public-06-flowchart-dark.png" });
await dark.context().close();
step(
  "a flowchart: the page names the flowchart module, which swaps the code block for one picture across the column and says how many it drew",
  lightChart.drew === "1" &&
    lightChart.module.length === 1 &&
    /^\/__web\/[^/]+\/flowchart\.js$/.test(lightChart.module[0]) &&
    lightChart.marked === 0 &&
    lightChart.role === "img" &&
    /^0 0 \d+ \d+$/.test(lightChart.viewBox) &&
    lightChart.tags.split(",").every((t) => ["rect", "path", "text", "tspan"].includes(t)) &&
    lightChart.words === "Write,Publish" &&
    lightChart.width === lightChart.column,
  `${lightChart.module[0]} · ${lightChart.viewBox} → ${lightChart.width}px of ${lightChart.column} · <${lightChart.tags}> ${lightChart.words}`,
);
step(
  "a flowchart is the same picture in light and in dark, coloured by each page's own tokens",
  darkChart.drew === "1" &&
    darkChart.markup === lightChart.markup &&
    lightChart.stroke === lightChart.token &&
    darkChart.stroke === darkChart.token &&
    lightChart.stroke !== darkChart.stroke &&
    lightChart.background === "rgb(255, 255, 255)" &&
    darkChart.background === "rgb(11, 11, 11)",
  `${lightChart.stroke} on ${lightChart.background} / ${darkChart.stroke} on ${darkChart.background}`,
);
step(
  "another kind of diagram is not drawn: its ```mermaid block stays a code block with its source showing",
  lightChart.sources.length === 1 &&
    lightChart.sources[0].first === "sequenceDiagram" &&
    lightChart.sources[0].shown &&
    !lightChart.sources[0].marked,
  JSON.stringify(lightChart.sources),
);

// With scripts off the page still shows the flowchart, as its source.
const plain = await pageIn({ javaScriptEnabled: false });
await plain.goto(`${BASE}/diagram`);
const unscripted = await plain.evaluate(() => ({
  drew: document.documentElement.dataset.flowcharts ?? null,
  figures: document.querySelectorAll(".dk-flowchart").length,
  sources: [...document.querySelectorAll("pre > code.language-mermaid")].map(
    (code) => `${code.parentElement.hasAttribute("data-dk-flowchart") ? "flowchart" : "other"}: ${code.textContent.split("\n")[0]}`,
  ),
}));
await plain.context().close();
step(
  "with scripts off a flowchart is its source: the worker serves the code block, marked for the module, beside the other diagram's unmarked one",
  unscripted.drew === null &&
    unscripted.figures === 0 &&
    unscripted.sources.join(" | ") === "flowchart: flowchart LR | other: sequenceDiagram",
  unscripted.sources.join(" | "),
);

// On a phone the flowchart is laid out for the column itself, so its words
// are drawn at their own size.
const phone = await pageIn({ viewport: { width: 390, height: 844 } });
await phone.goto(`${BASE}/diagram`);
await poll(async () => (await phone.locator("figure.dk-flowchart > svg").count()) === 1);
const phoneChart = await flowchartLook(phone);
await phone.screenshot({ path: SHOTS + "public-06-flowchart-phone.png" });
await phone.context().close();
step(
  "on a phone a flowchart is laid out for the column: its frame is the column's width, not the page's, so nothing is scaled",
  phoneChart.drew === "1" &&
    phoneChart.viewBox.split(" ")[2] === String(phoneChart.column) &&
    phoneChart.width === phoneChart.column &&
    phoneChart.viewBox !== lightChart.viewBox,
  `${phoneChart.viewBox} → ${phoneChart.width}px of ${phoneChart.column}`,
);

/* 6c — the same page carries HTML written into its markdown. It is drawn as
   written and does nothing: the page's policy runs the one script that drew
   the flowchart above and refuses the rest */
const written = async () => ({
  ran: await page.evaluate(() => document.documentElement.dataset.ran ?? null),
  base: await page.evaluate(() => document.baseURI),
  url: page.url(),
  refused: await refusedOn(page),
});
const loaded = await written();
// A refused navigation never finishes, so the clicks don't wait for one.
await page.locator("#written-link").click({ noWaitAfter: true });
await page.locator("#written-form button").click({ noWaitAfter: true });
await page.waitForTimeout(400);
const pressed = await written();
const kinds = [...new Set(pressed.refused.map((r) => r.split(" ")[0]))].sort();
step(
  "HTML written into a note is drawn and does nothing: its script, its handler, its javascript: link, its form and its <base> are each refused, and nothing the page itself asked for is",
  (await page.locator("#written-in img").count()) === 1 &&
    loaded.ran === null &&
    pressed.ran === null &&
    loaded.base === `${BASE}/diagram` &&
    pressed.url === `${BASE}/diagram` &&
    kinds.join() === "base-uri,form-action,script-src-attr,script-src-elem" &&
    // the script tag when the page loaded, the link when it was pressed
    loaded.refused.filter((r) => r.startsWith("script-src-elem")).length === 1 &&
    pressed.refused.filter((r) => r.startsWith("script-src-elem")).length === 2 &&
    !pressed.refused.some((r) => r.includes("/__web/")),
  JSON.stringify(pressed.refused),
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
    lightDrawings.width === 680 &&
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
    loaded: document.fonts.check('17px "Inter"') && document.fonts.check('500 44px "Literata"'),
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
  "the app's look: text in the bundled Inter at 17px and headings in Literata 500 at 44px, in the 680px column, the chrome in the UI face, links in the light and dark link colours",
  type.face === "Inter" &&
    type.heading === "Literata 500 44px" &&
    type.size === "17px" &&
    type.loaded &&
    type.served &&
    type.chrome === "Inter" &&
    type.measure === 680 &&
    type.accent === "rgb(37, 106, 191)" &&
    darkLink === "rgb(57, 135, 229)",
  JSON.stringify({ ...type, darkLink }),
);

/* 7 — the root page and its links */
// The picture on the web stays a picture; the drive never fetches it.
await page.route("https://example.com/**", (route) => route.abort());
await page.goto(`${BASE}/`);
await poll(async () => (await page.locator("main.doc h1").count()) === 1);
const planHref = await page.locator("main.doc a", { hasText: "the plan" }).getAttribute("href");
const statusHref = await page.locator("main.doc a", { hasText: "status" }).getAttribute("href");
const scratchLinks = await page.locator("main.doc a", { hasText: "scratch note" }).count();
step(
  "the root page: Home at /, links rewritten to public addresses, an unpublished target left as text",
  (await page.locator("main.doc h1").textContent()) === "Home" &&
    planHref === "/plan" &&
    statusHref === "/projects/status" &&
    scratchLinks === 0,
  `${planHref} ${statusHref}`,
);

/* 7a — pictures: one in the workspace is its alt text, one on the web is shown */
const imgSrcs = await page.locator("main.doc img").evaluateAll((els) => els.map((el) => el.getAttribute("src")));
const homeText = await page.locator("main.doc").innerText();
step(
  "a note's picture in the workspace is its alt text — pictures stay on their device — and a picture on the web is an <img>",
  JSON.stringify(imgSrcs) === JSON.stringify(["https://example.com/sky.png"]) &&
    /\ba picture\b/.test(homeText) &&
    homeText.includes("a missing picture") &&
    !(await page.content()).includes("pic.png"),
  `${JSON.stringify(imgSrcs)} · ${JSON.stringify(homeText.split("\n").at(-1))}`,
);

/* 7b — a published folder serves an html document by its exact path, and nothing else */
const byPath = await page.goto(`${BASE}/projects/plan.html`);
const byPathCsp = byPath.headers()["content-security-policy"];
const byPathType = byPath.headers()["content-type"];
const rendered = await page.locator("#rendered").count();
const pic = await page.goto(`${BASE}/projects/assets/pic.png`);
const picHeading = await page.locator("h1").textContent();
step(
  "a published folder: an html document answers at its exact path, sandboxed; /projects/assets/pic.png is the 404 page",
  byPath.status() === 200 &&
    /^text\/html/.test(byPathType ?? "") &&
    byPathCsp === "sandbox allow-scripts allow-popups" &&
    rendered === 1 &&
    pic.status() === 404 &&
    picHeading === "Nothing here",
  `${byPath.status()} ${byPathType} · ${pic.status()}`,
);

/* 8 — what isn't there */
const missing = await page.goto(`${BASE}/nope`);
const sub = await page.goto(`${BASE}/projects/Roadmap`);
step(
  "404: an unknown slug and a subfolder inside a published folder both get the 404 page",
  missing.status() === 404 && sub.status() === 404 && (await page.locator("h1").textContent()) === "Nothing here",
);

/* 9 — the policy refuses nothing a page of the worker's own asks for */
const asked = {};
for (const path of ["/sizes", "/plan", "/plan?v=md", "/projects", "/projects/status", "/home", "/", "/nope"]) {
  await page.goto(`${BASE}${path}`);
  await page.evaluate(() => document.fonts.ready);
  const refused = await refusedOn(page);
  if (refused.length > 0) asked[path] = refused;
}
step(
  "the policy refuses nothing of the worker's own: a note, a framed rendition, a folder, the root and the 404 load their styles, fonts, pictures and frame",
  Object.keys(asked).length === 0,
  JSON.stringify(asked),
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
