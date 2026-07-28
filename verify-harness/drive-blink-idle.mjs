// Drives the idle-blink harness: parks the viewport at a scroll position and
// then does NOTHING for a while, reporting every code-block mount/teardown
// swap and every layout shift the page recorded. A healthy page produces a
// short settling burst and then silence; the bug under investigation is a
// self-sustaining mount⇄teardown oscillation that keeps firing on a ~5s
// beat (CodeMirrorBlock.TEARDOWN_DELAY) with nobody touching the page.
//
//   node verify-harness/drive-blink-idle.mjs [--doc <path.md>] [--idle 20]
//
// Needs a vite dev server for THIS worktree (default port 1435, override
// with HARNESS_PORT). --doc feeds a real document in instead of the built-in
// mixed one; it is read locally and never written anywhere.
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";

const PORT = process.env.HARNESS_PORT || "1435";
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DOC_PATH = argOf("--doc", null);
const IDLE_S = Number(argOf("--idle", "20"));
const SCROLLS = (argOf("--at", "") || "")
  .split(",")
  .filter(Boolean)
  .map(Number);

async function poll(fn, timeout = 30000, every = 100) {
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

if (DOC_PATH) {
  const md = readFileSync(DOC_PATH, "utf8");
  await page.addInitScript((doc) => {
    window.__md = doc;
  }, md);
  console.log(`doc: ${DOC_PATH} (${md.length} bytes)`);
}

await page.goto(`http://localhost:${PORT}/verify-harness/blink-idle.html`);
await poll(() => page.evaluate(() => !!document.querySelector(".milkdown .ProseMirror")));

// Settle: wait until scrollHeight stops moving (fonts, first mounts, mermaid).
let stable = 0;
let lastH = 0;
await poll(async () => {
  const h = await page.evaluate(() => document.querySelector(".editor-wrap").scrollHeight);
  stable = h === lastH ? stable + 1 : 0;
  lastH = h;
  return stable >= 8;
}, 60000);

const docH = await page.evaluate(() => document.querySelector(".editor-wrap").scrollHeight);
const blocks = await page.evaluate(() => window.__blocks());
console.log(`document height ${docH}px, ${blocks.length} code blocks`);
for (const b of blocks) {
  console.log(
    `  block ${b.idx}: top=${b.top} h=${b.height} ${b.mounted ? "mounted" : "placeholder"}${b.hasSvg ? " svg" : ""}`,
  );
}

// Park positions: a sweep through the document by default, or the exact
// offsets passed with --at.
const positions = SCROLLS.length
  ? SCROLLS
  : Array.from({ length: 8 }, (_, i) => Math.round(((i + 1) * docH) / 10));

let anyOscillation = false;
for (const top of positions) {
  await page.evaluate((y) => {
    document.querySelector(".editor-wrap").scrollTop = y;
  }, top);
  await page.waitForTimeout(2500); // let the scroll's own mounts settle
  await page.evaluate(() => {
    window.__events = [];
    if (!window.__monitoring) {
      window.__monitoring = true;
      window.__startMonitor();
    }
  });
  await page.waitForTimeout(IDLE_S * 1000);
  const events = await page.evaluate(() => window.__events);
  const swaps = events.filter((e) => e.kind === "mount" || e.kind === "teardown");
  const shifts = events.filter((e) => e.kind === "height" || e.kind === "scroll");
  const verdict = swaps.length > 2 ? "OSCILLATING" : swaps.length ? "settling" : "quiet";
  if (swaps.length > 2) anyOscillation = true;
  console.log(
    `\nscrollTop=${top}: ${swaps.length} swaps, ${shifts.length} layout shifts in ${IDLE_S}s idle — ${verdict}`,
  );
  for (const e of events.slice(0, 40)) {
    if (e.kind === "mount" || e.kind === "teardown") {
      console.log(
        `  ${String(e.t).padStart(6)}ms  ${e.kind.padEnd(8)} block ${e.idx}  ${e.hBefore}px → ${e.hAfter}px (${e.dH >= 0 ? "+" : ""}${e.dH})`,
      );
    } else {
      console.log(
        `  ${String(e.t).padStart(6)}ms  ${e.kind.padEnd(8)} ${e.kind === "height" ? `dH=${e.dH} (${e.height})` : `dTop=${e.dTop} (${e.top})`}`,
      );
    }
  }
  if (events.length > 40) console.log(`  … ${events.length - 40} more`);
}

console.log(
  anyOscillation
    ? "\nRESULT: idle oscillation reproduced"
    : "\nRESULT: no idle oscillation at the sampled positions",
);
await browser.close();
