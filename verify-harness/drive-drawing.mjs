// Drives the drawing harness (drawing.tsx): ```svg blocks in the REAL editor.
// The worked examples `doklin help drawings` teaches render as figures at
// the column's width; two drawings that both define `arrow` keep their own
// markers; a theme flip recolours a drawing in place (its colours are the
// --dg-* tokens, nothing re-renders); the sanitizer keeps nothing
// executable; a drawing that doesn't parse shows the quiet error card; the
// Source chip switches to the source; the markdown round-trips byte for
// byte; a read-only mount still draws. Needs a vite dev server for THIS
// tree (PORT, default 1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const PORT = process.env.PORT ?? "1420";
const URL_BASE = `http://localhost:${PORT}/verify-harness/drawing.html`;
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 10000, every = 100) {
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
// Tall enough that every code block is near the viewport and mounts at once
// (Crepe lazy-mounts code blocks as they scroll into view).
const page = await browser.newPage({ viewport: { width: 1100, height: 5200 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(URL_BASE);

const examples = await poll(() => page.evaluate(() => window.__examples));
await poll(async () => (await page.locator(".dk-drawing > svg").count()) === examples + 1);
const original = await page.evaluate(() => window.__md);

/* ---------- The guide's examples render, at the column's width ---------- */

const shapes = await page.evaluate(() =>
  [...document.querySelectorAll(".dk-drawing > svg")].map((svg) => ({
    label: svg.getAttribute("aria-label"),
    width: Math.round(svg.getBoundingClientRect().width),
    texts: svg.querySelectorAll("text").length,
  })),
);
const column = await page.evaluate(() => {
  const pm = document.querySelector(".editor-wrap .ProseMirror");
  const cs = getComputedStyle(pm);
  return Math.round(pm.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
});
step(
  "every worked example in `doklin help drawings` renders as a figure across the column",
  examples === 3 && shapes.slice(0, examples).every((s) => s.width === column && s.texts > 2),
  `${examples} examples, column ${column}: ${shapes.map((s) => `${s.label} ${s.width}`).join(" | ")}`,
);
await page.screenshot({ path: `${SHOTS}drawing-01-light.png` });

/* ---------- Ids are namespaced per drawing ---------- */

const markers = await page.evaluate(() =>
  [...document.querySelectorAll(".dk-drawing > svg")].map((svg) => ({
    ids: [...svg.querySelectorAll("[id]")].map((e) => e.id),
    refs: [...svg.querySelectorAll("[marker-end]")].map((e) => e.getAttribute("marker-end")),
  })),
);
const allIds = markers.flatMap((m) => m.ids);
const ownRefs = markers.every((m) =>
  m.refs.every((r) => m.ids.includes(r.replace(/^url\(#(.*)\)$/, "$1"))),
);
step(
  "two drawings that both define `arrow` keep their own: every id is unique on the page and every marker-end names its own drawing's",
  allIds.length > 3 && new Set(allIds).size === allIds.length && ownRefs && allIds.every((id) => /^dg\d+-/.test(id)),
  allIds.join(","),
);

/* ---------- A theme flip recolours in place ---------- */

const strokeOf = () =>
  page.evaluate(() => {
    const rect = document.querySelector(".dk-drawing > svg rect");
    return { stroke: getComputedStyle(rect).stroke, node: rect.dataset.probe ?? (rect.dataset.probe = "same") };
  });
const light = await strokeOf();
await page.evaluate(() => window.__setTheme("dark"));
await page.waitForTimeout(150);
const dark = await strokeOf();
await page.screenshot({ path: `${SHOTS}drawing-02-dark.png` });
await page.evaluate(() => window.__setTheme("light"));
step(
  "a theme flip recolours a drawing in place: the same element, the rule colour of each theme",
  light.stroke === "rgb(195, 194, 183)" && dark.stroke === "rgb(56, 56, 53)" && dark.node === "same",
  `${light.stroke} → ${dark.stroke}`,
);

/* ---------- The sanitizer ---------- */

const hostile = await page.evaluate(() => {
  const svg = [...document.querySelectorAll(".dk-drawing > svg")].find((s) => s.getAttribute("aria-label") === "Hostile");
  const line = svg.querySelector("line");
  return {
    pwned: window.__pwned ?? null,
    script: svg.querySelectorAll("script").length,
    foreign: svg.querySelectorAll("foreignObject").length,
    image: svg.querySelectorAll("image").length,
    onclick: line.hasAttribute("onclick"),
    externalStroke: line.hasAttribute("stroke"),
    marker: line.getAttribute("marker-end"),
    style: svg.querySelector("text").hasAttribute("style"),
    words: svg.querySelector("text").textContent,
  };
});
await page.evaluate(() => {
  const svg = [...document.querySelectorAll(".dk-drawing > svg")].find((s) => s.getAttribute("aria-label") === "Hostile");
  svg.querySelector("line").dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const pwnedAfterClick = await page.evaluate(() => window.__pwned ?? null);
step(
  "the sanitizer keeps nothing executable: no script, foreignObject, image, handler, style or outside url(), and the words stay",
  hostile.pwned === null &&
    pwnedAfterClick === null &&
    hostile.script + hostile.foreign + hostile.image === 0 &&
    !hostile.onclick &&
    !hostile.externalStroke &&
    /^url\(#dg\d+-arrow\)$/.test(hostile.marker) &&
    !hostile.style &&
    hostile.words === "kept words",
  JSON.stringify(hostile),
);

const errorCard = await page.locator(".dk-figure-error").textContent();
step(
  "a drawing that doesn't parse shows the quiet error card, with the parser's reason",
  /Drawing doesn’t parse yet/.test(errorCard) && /Unexpected <\/svg>/.test(errorCard),
  errorCard.replace(/\s+/g, " ").trim(),
);

/* ---------- Source switch and round trip ---------- */

const first = page.locator(".milkdown-code-block").filter({ has: page.locator(".dk-drawing") }).first();
await first.hover();
await first.locator(".dk-figure-source").click();
await poll(async () => (await first.locator(".cm-content").isVisible()) && !(await first.locator(".dk-drawing > svg").isVisible()));
const lang = await first.locator(".language-button").textContent();
step("the Source chip switches to the source alone, picked as svg", /svg/i.test(lang), lang.trim());
await page.locator(".ProseMirror p", { hasText: "After." }).click();
await poll(async () => first.locator(".dk-drawing > svg").isVisible());
const md = await page.evaluate(() => window.__md);
step(
  "leaving the block brings the drawing back, and the markdown round-trips byte for byte",
  md === original,
  md === original ? "" : `${md.length} vs ${original.length} chars`,
);

/* ---------- Read-only ---------- */

const ro = await browser.newPage({ viewport: { width: 1100, height: 5200 } });
await ro.goto(`${URL_BASE}?ro=1`);
await poll(async () => (await ro.locator(".dk-drawing > svg").count()) === examples + 1);
step("a read-only mount draws every drawing too", true);
await ro.close();

await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
