// Drives the mermaid diagram pipeline (src/mermaid.ts + the Editor wiring) in
// Chromium: gallery rendering across diagram types, live re-render while
// typing, error-card recovery, theme flips, the slash-menu Diagram item, the
// language-picker entry, read-only preview-only mode, and markdown
// round-trip. Needs the repo-root vite dev server (port 1420) — see
// .claude/skills/verify/SKILL.md.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

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

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 940 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

/* ---------- Gallery: every diagram type renders, plain code untouched ---------- */

await page.goto("http://localhost:1420/verify-harness/mermaid.html");
await poll(async () =>
  (await page.evaluate(() => document.querySelectorAll(".dk-mermaid svg").length)) >= 5,
);
step("gallery: flowchart/sequence/state/pie/class all render to SVG", true);

// Code blocks initialize lazily (IntersectionObserver) — bring the tail of
// the document (broken block + js block) into view first.
await page.locator(".milkdown .ProseMirror").last().press("Control+End").catch(() => {});
await page.evaluate(() => {
  document.querySelector(".editor-wrap")?.scrollTo(0, 10 ** 6);
});
await poll(async () => page.locator(".dk-mermaid-error").count());
const errText = await page.locator(".dk-mermaid-error").textContent();
step(
  "broken source shows the quiet error card (with mermaid's message)",
  errText.includes("doesn’t parse yet") && errText.toLowerCase().includes("parse error"),
);

// The js block must NOT grow a preview panel (renderPreview returns null via
// the stock chain), and the mermaid blocks must keep their sources verbatim.
const jsPanels = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll(".milkdown-code-block")];
  const js = blocks.find((b) => b.textContent.includes("function hello"));
  return js ? js.querySelectorAll(".preview-panel .preview").length : -1;
});
step("plain ```js block gets no preview panel", jsPanels === 0);

const md = await page.evaluate(() => window.__md);
const fences = (md.match(/```mermaid/g) || []).length;
step("markdown round-trip keeps every ```mermaid fence", fences === 6, `${fences} fences`);
await page.screenshot({ path: `${SHOTS}/mermaid-01-gallery.png` });

/* ---------- Theme flip re-renders in place ---------- */

const styleBefore = await page.evaluate(
  () => document.querySelector(".dk-mermaid svg style").textContent,
);
await page.evaluate(() => window.__setTheme("dark"));
await poll(async () =>
  page.evaluate(
    (prev) => {
      const s = document.querySelector(".dk-mermaid svg style");
      return s && s.textContent !== prev;
    },
    styleBefore,
  ),
);
const svgCountAfterFlip = await page.evaluate(
  () => document.querySelectorAll(".dk-mermaid svg").length,
);
step("theme flip re-renders live diagrams with the new palette", svgCountAfterFlip >= 5);
await page.screenshot({ path: `${SHOTS}/mermaid-02-theme-flip.png` });

/* ---------- Live edit: type into the block, diagram follows ---------- */

await page.goto("http://localhost:1420/verify-harness/mermaid.html?doc=one");
await poll(async () => page.locator(".dk-mermaid svg").count());
const nodesBefore = await page.evaluate(
  () => document.querySelectorAll(".dk-mermaid svg .node").length,
);
await page.locator(".milkdown-code-block .cm-content").click();
await page.keyboard.press("End");
// The doc is "A[Start] --> B[End]"; caret lands where we clicked — go to the
// document end of the code editor to append a new edge line.
await page.keyboard.press("Control+End");
await page.keyboard.type("\n  B --> C[Published]");
await poll(async () =>
  page.evaluate(
    (prev) => document.querySelectorAll(".dk-mermaid svg .node").length > prev,
    nodesBefore,
  ),
);
step("typing a new edge live-updates the rendered diagram", true, `${nodesBefore}→3 nodes`);

// Break it → error card; fix it → diagram returns (debounced round trips).
await page.keyboard.type("\n  C --> [broken");
await poll(async () => page.locator(".dk-mermaid-error").count());
step("mid-edit syntax error swaps in the error card", true);
for (let i = 0; i < "\n  C --> [broken".length; i++) await page.keyboard.press("Backspace");
await poll(async () => page.locator(".dk-mermaid svg").count());
step("fixing the source brings the diagram back", true);
await page.screenshot({ path: `${SHOTS}/mermaid-03-live-edit.png` });

/* ---------- Preview toggle: diagram-only mode ---------- */

const block = page.locator(".milkdown-code-block").first();
await block.hover();
await block.locator(".preview-toggle-button").click();
await poll(async () => block.locator(".codemirror-host.hidden").count());
step("preview toggle hides the source (diagram-only)", true);
await block.locator(".preview-toggle-button").click();
await poll(async () => (await block.locator(".codemirror-host.hidden").count()) === 0);
step("toggle again brings the source back", true);

/* ---------- Slash menu: /Diagram inserts a mermaid block ---------- */

await page.locator(".milkdown .ProseMirror p", { hasText: "After." }).click();
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("/diagram");
await poll(async () => page.locator('.milkdown-slash-menu[data-show="true"]').count());
const item = page.locator(".milkdown-slash-menu li", { hasText: "Diagram" });
await poll(async () => item.count());
await item.click();
await poll(async () => (await page.locator(".milkdown-code-block").count()) === 2);
// The serializer runs on the editor's update listener — poll, don't race it.
await poll(async () =>
  page.evaluate(() => (window.__md.match(/```mermaid\b/g) || []).length === 2),
);
step("slash menu Diagram item inserts a ```mermaid block", true);
await page.screenshot({ path: `${SHOTS}/mermaid-04-slash.png` });

/* ---------- Language picker lists mermaid ---------- */

// (The picker excludes the block's CURRENT language from filtered results —
// stock behavior — so assert against the unfiltered list, where the selected
// language leads.)
const newBlock = page.locator(".milkdown-code-block").nth(1);
await newBlock.locator(".language-button").first().click();
await poll(async () => page.locator(".language-list-item").count());
const names = await page.locator(".language-list-item").allTextContents();
step(
  "language picker offers mermaid (listed first for a mermaid block)",
  names[0]?.trim() === "mermaid",
  `first: ${names[0]?.trim()}`,
);
await page.keyboard.press("Escape");
await page.screenshot({ path: `${SHOTS}/mermaid-05-picker.png` });

/* ---------- Read-only mount: diagram-only by default ---------- */

await page.goto("http://localhost:1420/verify-harness/mermaid.html?doc=one&ro=1");
await poll(async () => page.locator(".dk-mermaid svg").count());
const roHidden = await poll(async () =>
  page.locator(".milkdown-code-block .codemirror-host.hidden").count(),
);
step("read-only session gets the diagram alone (source hidden)", roHidden === 1);
await page.screenshot({ path: `${SHOTS}/mermaid-06-readonly.png` });

/* ---------- Verdict ---------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
await browser.close();
process.exit(failed.length > 0 ? 1 : 0);
