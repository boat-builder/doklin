// Drives the scroll-blink harness: wheel-scrolls through a document with
// large code blocks and reports every mid-scroll layout correction the page
// monitor recorded. Evidence gathering for the "blink + scroll adjusts"
// report — see scroll-blink.tsx. Needs a vite dev server for THIS worktree
// (default port 1435, override with HARNESS_PORT).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const PORT = process.env.HARNESS_PORT || "1435";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

async function poll(fn, timeout = 20000, every = 100) {
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

const RUNNER_CHROMIUM = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(RUNNER_CHROMIUM) ? { executablePath: RUNNER_CHROMIUM } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 940 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`http://localhost:${PORT}/verify-harness/scroll-blink.html`);
await poll(() => page.evaluate(() => !!document.querySelector(".milkdown .cm-content")));

// Let fonts/layout settle: wait until scrollHeight is stable for ~600ms.
let stable = 0;
let lastH = 0;
await poll(async () => {
  const h = await page.evaluate(
    () => document.querySelector(".editor-wrap").scrollHeight,
  );
  stable = h === lastH ? stable + 1 : 0;
  lastH = h;
  return stable >= 6;
});

const before = await page.evaluate(() => {
  const wrap = document.querySelector(".editor-wrap");
  return {
    scrollHeight: wrap.scrollHeight,
    gaps: document.querySelectorAll(".cm-gap").length,
    gapHeights: [...document.querySelectorAll(".cm-gap")].map((g) =>
      Math.round(g.getBoundingClientRect().height),
    ),
    renderedCmLines: document.querySelectorAll(".cm-line").length,
  };
});
console.log("before scroll:", JSON.stringify(before));

await page.evaluate(() => window.__startMonitor());

// Wheel through the whole document the way a person would: repeated small
// wheel ticks with a beat between them so rAF/measure cycles run.
await page.mouse.move(590, 470);
const wheelUntilEnd = async (dir) => {
  for (let i = 0; i < 400; i++) {
    await page.mouse.wheel(0, dir * 130);
    await page.waitForTimeout(25);
    const done = await page.evaluate((d) => {
      const w = document.querySelector(".editor-wrap");
      return d > 0
        ? w.scrollTop + w.clientHeight >= w.scrollHeight - 2
        : w.scrollTop <= 2;
    }, dir);
    if (done) break;
  }
};
await wheelUntilEnd(1);
await page.waitForTimeout(400);
await wheelUntilEnd(-1);
await page.waitForTimeout(400);

const after = await page.evaluate(() => {
  const wrap = document.querySelector(".editor-wrap");
  return {
    scrollHeight: wrap.scrollHeight,
    gaps: document.querySelectorAll(".cm-gap").length,
    renderedCmLines: document.querySelectorAll(".cm-line").length,
    events: window.__events,
  };
});

const heights = after.events.filter((e) => e.kind === "height");
const scrolls = after.events.filter((e) => e.kind === "scroll");
// A wheel tick moves +130 (down) or -130 (up); anything far outside that per
// frame — especially against the current direction — is the browser adjusting
// scroll position under the user (anchoring compensation for a height change).
const anomalies = scrolls.filter((e) => Math.abs(e.dTop) > 200);

console.log("after scroll:", JSON.stringify({ ...after, events: undefined }));
console.log(`height corrections during scroll: ${heights.length}`);
for (const h of heights) console.log("  ", JSON.stringify(h));
console.log(`scroll jumps beyond wheel delta (|dTop| > 200): ${anomalies.length}`);
for (const a of anomalies) console.log("  ", JSON.stringify(a));
console.log(
  `net scrollHeight drift: ${after.scrollHeight - before.scrollHeight}px (before ${before.scrollHeight}, after ${after.scrollHeight})`,
);

await page.screenshot({ path: `${SHOTS}/scroll-blink-01.png` });
await browser.close();
