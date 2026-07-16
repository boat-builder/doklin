// Drives the inline-code newline normalization (src/inlineCodeNewlines.ts) in
// Chromium: inline code spans hard-wrapped across source lines must parse to
// a single-space value (no literal newline reaching ProseMirror's pre-wrap
// surface), render as one line fragment, and serialize back on one line.
// Needs the repo-root vite dev server (port 1420) — see
// .claude/skills/verify/SKILL.md.
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

await page.goto("http://localhost:1420/verify-harness/inline-code.html");
await poll(async () =>
  (await page.evaluate(
    () => document.querySelectorAll(".milkdown .ProseMirror code").length,
  )) === 4,
);

/* ---------- Parse: the newline never reaches the document ---------- */

const codes = await page.evaluate(() =>
  [...document.querySelectorAll(".milkdown .ProseMirror code")].map((c) => ({
    text: c.textContent,
    fragments: c.getClientRects().length,
  })),
);
step(
  "wrapped list-item span parses to a single-space value",
  codes[0].text === "Money{Micros int64, Currency string}",
  JSON.stringify(codes[0].text),
);
step(
  "wrapped paragraph span parses to a single-space value",
  codes[2].text === "retry with backoff",
  JSON.stringify(codes[2].text),
);
step(
  "no code span carries a literal newline",
  codes.every((c) => !c.text.includes("\n")),
);
step(
  "adjacent + control spans untouched",
  codes[1].text === "internal/sem" && codes[3].text === "single-line span",
);

/* ---------- Render: one line fragment per span (no stacked pill) ---------- */

step(
  "every span renders as a single line fragment",
  codes.every((c) => c.fragments === 1),
  codes.map((c) => c.fragments).join(","),
);
await page.screenshot({ path: `${SHOTS}/inline-code-01.png` });

/* ---------- Round-trip: serializes back on one line ---------- */

await page.locator(".milkdown .ProseMirror p", { hasText: "Control:" }).click();
await page.keyboard.press("End");
await page.keyboard.type(" Edited.");
const md = await poll(async () => {
  const m = await page.evaluate(() => window.__md);
  return m.includes("Edited.") ? m : null;
});
step(
  "round-trip writes the wrapped spans on one line",
  md.includes("`Money{Micros int64, Currency string}`") &&
    md.includes("`retry with backoff`"),
);
step(
  "round-trip keeps the control span verbatim",
  md.includes("Control: `single-line span` must be untouched. Edited."),
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
