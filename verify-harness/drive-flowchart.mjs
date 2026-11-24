// Drives the flowchart harness (flowchart.tsx): ```mermaid blocks in the REAL
// editor. A flowchart is drawn as a picture across the column, in the
// drawing grammar's elements; a box's class marks it (:::focus and the three
// statuses); a flowchart that cannot be read shows the quiet error card with
// a sentence naming the line; another kind of diagram stays a code block
// with its source showing, under a note naming the kind; plain code gets no
// preview; every source survives the serializer byte for byte; a theme flip
// recolours a picture in place (its colours are the --dg-* tokens, nothing
// is drawn again). Then one block through its life: the picture alone while
// reading, the Source chip, typing that redraws the picture, the error card
// mid-typing and the picture coming back, leaving the block, the Expand chip
// and the zoom view, the slash menu's Diagram item drawn from scratch, the
// language picker, and a read-only mount. Last, flowcharts big enough to be
// drawn after a pause in the typing: each says it is being drawn, then shows
// its own picture, and typing ends on the picture of what was typed.
//
// Needs a vite dev server for THIS tree. HARNESS_ORIGIN overrides it
// (default http://localhost:1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";
const url = (query = "") => `${ORIGIN}/verify-harness/flowchart.html${query}`;
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
const pageErrors = [];
const open = async (query, viewport, before = null) => {
  const p = await browser.newPage({ viewport });
  p.on("pageerror", (e) => {
    pageErrors.push(e.message);
    console.log("PAGEERROR:", e.message);
  });
  if (before) await p.addInitScript(before);
  await p.goto(url(query));
  return p;
};

// The sources a page's ```mermaid fences hold, as the serializer wrote them.
const fenced = (md) => [...md.matchAll(/^```mermaid\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
const PICTURE = ".dk-flowchart:not(.dk-figure-error) > svg";

/* ---------- The gallery: what each kind of block shows ---------- */

// Tall enough that every code block is near the viewport and mounts at once
// (Crepe lazy-mounts code blocks as they scroll into view).
const gallery = await open("", { width: 1180, height: 5200 });
const blocks = await poll(() => gallery.evaluate(() => window.__fences));
const frame = await gallery.evaluate(() => window.__frame);
const flowcharts = blocks.filter((b) => b.flowchart).length;
const others = blocks.length - flowcharts;
await poll(
  async () =>
    (await gallery.locator(`${PICTURE}, .dk-figure-error`).count()) === flowcharts &&
    (await gallery.locator(".dk-figure-note").count()) === others,
);

const pictures = await gallery.evaluate((sel) => {
  const pm = document.querySelector(".editor-wrap .ProseMirror");
  const cs = getComputedStyle(pm);
  const column = Math.round(pm.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  return {
    column,
    drawn: [...document.querySelectorAll(sel)].map((svg) => ({
      label: svg.getAttribute("aria-label"),
      role: svg.getAttribute("role"),
      viewBox: svg.getAttribute("viewBox"),
      width: Math.round(svg.getBoundingClientRect().width),
      tags: [...new Set([...svg.querySelectorAll("*")].map((el) => el.tagName))].sort().join(),
      words: [...svg.querySelectorAll("text")].map((t) => t.textContent),
      chips: svg.parentElement.querySelectorAll(".dk-figure-expand, .dk-figure-source").length,
    })),
  };
}, PICTURE);
const [loop, saving] = pictures.drawn;
// One of the gallery's flowcharts cannot be read: it is the error card's.
step(
  "every flowchart that can be read is drawn as a picture across the column: one svg in its frame, named for a screen reader, holding only rect, path, text and tspan, with its two chips",
  pictures.drawn.length === flowcharts - 1 &&
    pictures.drawn.every(
      (p) =>
        p.role === "img" &&
        new RegExp(`^0 0 ${frame} \\d+$`).test(p.viewBox) &&
        p.width === pictures.column &&
        p.tags.split(",").every((t) => ["rect", "path", "text", "tspan"].includes(t)) &&
        p.chips === 2,
    ) &&
    pictures.drawn.map((p) => p.label).join(" | ") === "A draft goes round until it is published | Saving a note | Marked boxes",
  `column ${pictures.column}: ${pictures.drawn.map((p) => `${p.label} ${p.viewBox} → ${p.width}px <${p.tags}>`).join(" | ")}`,
);
step(
  "a picture holds the source's words: the title, every box, the arrows' labels and a group's name",
  ["A draft goes round until it is published", "Draft", "Review?", "Publish", "Revise", "Done", "yes", "no"].every((w) =>
    loop.words.includes(w),
  ) && ["App", "Cloud", "Sync engine", "Bucket"].every((w) => saving.words.includes(w)),
  `${loop.words.join(", ")} | ${saving.words.join(", ")}`,
);
await gallery.screenshot({ path: `${SHOTS}flowchart-01-gallery.png` });

/* ---------- A box's class ---------- */

const marked = await gallery.evaluate(() => {
  const svg = document.querySelector('.dk-flowchart > svg[aria-label="Marked boxes"]');
  const probe = document.body.appendChild(document.createElement("span"));
  const token = (name) => {
    probe.style.color = `var(--dg-${name})`;
    return getComputedStyle(probe).color;
  };
  // The rectangle a word sits in.
  const boxOf = (word) => {
    const at = [...svg.querySelectorAll("text")].find((t) => t.textContent === word).getBBox();
    const cx = at.x + at.width / 2;
    const cy = at.y + at.height / 2;
    const rect = [...svg.querySelectorAll("rect")].find((r) => {
      const b = r.getBBox();
      return cx > b.x && cx < b.x + b.width && cy > b.y && cy < b.y + b.height;
    });
    return {
      stroke: rect.getAttribute("stroke"),
      width: Number(rect.getAttribute("stroke-width")),
      fill: rect.getAttribute("fill"),
      tint: Number(rect.getAttribute("fill-opacity")),
      drawn: getComputedStyle(rect).stroke,
    };
  };
  const got = {
    plain: boxOf("Plain"),
    focus: boxOf("Key step"),
    good: boxOf("Passed"),
    warn: boxOf("Slow"),
    bad: boxOf("Failed"),
    accentBoxes: svg.querySelectorAll('rect[stroke="var(--dg-accent)"]').length,
    tokens: { rule: token("rule"), accent: token("accent"), good: token("good"), warn: token("warn"), bad: token("bad") },
  };
  probe.remove();
  return got;
});
step(
  ":::focus marks one box: the accent stroke, heavier than a plain box's hairline, over an accent tint",
  marked.accentBoxes === 1 &&
    marked.focus.stroke === "var(--dg-accent)" &&
    marked.focus.fill === "var(--dg-accent)" &&
    marked.focus.tint > 0 &&
    marked.focus.tint < 0.5 &&
    marked.focus.width === 2 &&
    marked.focus.width > marked.plain.width &&
    marked.focus.drawn === marked.tokens.accent &&
    marked.plain.stroke === "var(--dg-rule)" &&
    marked.plain.fill === "none",
  JSON.stringify({ focus: marked.focus, plain: marked.plain }),
);
step(
  ":::good, :::warn and :::bad each draw their box in their own status colour, stroke and tint",
  ["good", "warn", "bad"].every(
    (s) =>
      marked[s].stroke === `var(--dg-${s})` &&
      marked[s].fill === `var(--dg-${s})` &&
      marked[s].tint > 0 &&
      marked[s].tint < 0.5 &&
      marked[s].drawn === marked.tokens[s],
  ) && new Set(Object.values(marked.tokens)).size === 5,
  JSON.stringify(marked.tokens),
);

/* ---------- A flowchart that cannot be read ---------- */

const card = gallery.locator(".dk-figure.dk-flowchart.dk-figure-error");
const cardHead = (await card.locator(".dk-figure-error-head").textContent()).trim();
const cardMsg = (await card.locator(".dk-figure-error-msg").textContent()).trim();
step(
  "a flowchart that cannot be read shows the quiet error card: a sentence naming the line, the Source chip, nothing to expand",
  (await card.count()) === 1 &&
    cardHead === "Flowchart can’t be drawn yet" &&
    /^Line 2: [a-z].*\.$/.test(cardMsg) &&
    (await card.locator(".dk-figure-source").count()) === 1 &&
    (await card.locator(".dk-figure-expand").count()) === 0 &&
    (await card.locator("svg[role='img']").count()) === 0,
  `${cardHead} · ${cardMsg}`,
);

/* ---------- Another kind of diagram ---------- */

const noted = await gallery.evaluate(() =>
  [...document.querySelectorAll(".milkdown-code-block")]
    .filter((b) => b.querySelector(".dk-figure-note"))
    .map((b) => {
      const shown = (el) => !!el && el.getClientRects().length > 0;
      const cm = b.querySelector(".cm-content");
      return {
        note: b.querySelector(".dk-figure-note").textContent,
        noteShown: shown(b.querySelector(".dk-figure-note")),
        source: shown(cm) ? [...cm.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n") : null,
        figure: b.querySelectorAll(".dk-figure").length,
        drawn: b.querySelectorAll(".preview svg").length,
        chips: b.querySelectorAll(".dk-figure-expand, .dk-figure-source").length,
        language: b.querySelector(".language-button")?.textContent.trim(),
      };
    }),
);
const otherSources = blocks.filter((b) => !b.flowchart).map((b) => b.source);
step(
  "another kind of diagram is not drawn: the block stays a code block with its whole source showing, under a note that names the kind",
  noted.length === others &&
    noted.map((n) => n.note).join(" | ") ===
      "Doklin draws flowcharts. A sequence diagram is shown as its source. | Doklin draws flowcharts. A pie chart is shown as its source." &&
    noted.every(
      (n, i) => n.noteShown && n.source === otherSources[i] && n.figure === 0 && n.drawn === 0 && n.chips === 0 && n.language === "mermaid",
    ),
  JSON.stringify(noted.map((n) => ({ ...n, source: n.source?.split("\n")[0] }))),
);

// A ```js block answers through the stock preview chain: nothing to show.
const jsPanels = await gallery.evaluate(() => {
  const js = [...document.querySelectorAll(".milkdown-code-block")].find((b) => b.textContent.includes("function hello"));
  return js ? js.querySelectorAll(".preview-panel .preview").length : -1;
});
step("a plain ```js block gets no preview panel", jsPanels === 0, `${jsPanels} panels`);

/* ---------- A theme flip recolours in place ---------- */

const paint = () =>
  gallery.evaluate((sel) => {
    const svg = document.querySelector(sel);
    const rect = svg.querySelector("rect[stroke]");
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = rect.getAttribute("stroke");
    const token = getComputedStyle(probe).color;
    probe.remove();
    window.__first ??= svg;
    return { stroke: getComputedStyle(rect).stroke, token, markup: svg.outerHTML, same: window.__first === svg && svg.isConnected };
  }, PICTURE);
const light = await paint();
await gallery.evaluate(() => window.__setTheme("dark"));
await poll(async () => (await paint()).stroke !== light.stroke);
const dark = await paint();
await gallery.screenshot({ path: `${SHOTS}flowchart-02-dark.png` });
await gallery.evaluate(() => window.__setTheme("light"));
step(
  "a theme flip recolours a flowchart in place: the same element with the same markup, in each theme's own rule colour",
  light.stroke === light.token && dark.stroke === dark.token && dark.stroke !== light.stroke && dark.same && dark.markup === light.markup,
  `${light.stroke} → ${dark.stroke}`,
);

/* ---------- The serializer keeps every source ---------- */

// An edit elsewhere in the document makes the editor report its markdown.
await gallery.locator(".milkdown .ProseMirror p", { hasText: "Plain code stays code:" }).click();
await gallery.keyboard.press("End");
await gallery.keyboard.type(" Still.");
await poll(() => gallery.evaluate(() => window.__md.includes("stays code: Still.")));
const written = fenced(await gallery.evaluate(() => window.__md));
step(
  "the markdown keeps every ```mermaid source byte for byte, drawn or not",
  written.length === blocks.length && written.every((source, i) => source === blocks[i].source),
  `${written.length} of ${blocks.length} fences`,
);
await gallery.close();

/* ---------- Two states: the picture, or the source, never both ---------- */

const page = await open("?doc=one", { width: 1180, height: 940 });
await poll(async () => page.locator(PICTURE).count());
const block = page.locator(".milkdown-code-block").first();
const reading = async () =>
  (await block.locator(".codemirror-host").isHidden()) && (await block.locator(PICTURE).isVisible());
step("reading shows the picture alone (source hidden)", await reading());

await block.hover();
await block.locator(".dk-figure-source").click();
await poll(async () => block.locator(".cm-content").isVisible());
step("the Source chip switches to the source alone (picture put away)", await block.locator(".preview-panel").isHidden());
await page.screenshot({ path: `${SHOTS}flowchart-03-source.png` });

/* ---------- Typing redraws the picture ---------- */

// What the block's picture holds. It sits in the hidden panel while the
// source is open; the DOM tells the truth.
const drawn = () =>
  block.evaluate((el, sel) => {
    const svg = el.querySelector(sel);
    return svg ? { boxes: svg.querySelectorAll("rect").length, words: [...svg.querySelectorAll("text")].map((t) => t.textContent) } : null;
  }, PICTURE);
const before = await drawn();
await block.locator(".cm-content").click();
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n  B --> C[Published]");
await poll(async () => (await drawn())?.words.includes("Published"));
const after = await drawn();
await poll(() => page.evaluate(() => /```mermaid\n[^`]*B --> C\[Published\]/.test(window.__md)));
step(
  "typing a new arrow redraws the picture with its box, and the markdown holds the line",
  before.boxes === 2 && after.boxes === 3 && after.words.join() === "Start,End,Published",
  `${before.words.join()} → ${after.words.join()}`,
);

// A dangling arrow, bracket-free on purpose: CodeMirror closes a bracket as
// it is typed, which would leave one behind when the line is taken out.
await page.keyboard.type("\n  C -->");
await poll(async () => block.locator(".dk-figure-error").count());
const midMsg = (await block.locator(".dk-figure-error-msg").textContent()).trim();
step(
  "an arrow typed halfway swaps in the error card, naming the line being typed",
  (await drawn()) === null && /^Line 4: [a-z].*\.$/.test(midMsg),
  midMsg,
);
await page.keyboard.press("Shift+Home");
await page.keyboard.press("Backspace");
await poll(async () => (await drawn())?.words.includes("Published"));
step("taking the half-typed arrow out brings the picture back", (await block.locator(".dk-figure-error").count()) === 0);

/* ---------- Leaving the block ---------- */

await page.locator(".milkdown .ProseMirror p", { hasText: "After." }).click();
await poll(reading);
step("leaving the block switches back to the picture", true);
await page.screenshot({ path: `${SHOTS}flowchart-04-live-edit.png` });

/* ---------- The Expand chip ---------- */

await block.hover();
await block.locator(".dk-figure-expand").click();
await poll(async () => page.locator(".dk-zoom-overlay .dk-zoom-content svg").count());
const zoom = await page.evaluate((sel) => {
  const inBlock = document.querySelector(`.milkdown-code-block ${sel}`);
  const inZoom = document.querySelector(".dk-zoom-content svg");
  return {
    samePicture: inZoom.innerHTML === inBlock.innerHTML && inZoom.getAttribute("viewBox") === inBlock.getAttribute("viewBox"),
    source: window.__expanded,
    editing: document.querySelectorAll(".dk-figure-editing").length,
  };
}, PICTURE);
await page.screenshot({ path: `${SHOTS}flowchart-05-zoom.png` });
const [blockSource] = fenced(await page.evaluate(() => window.__md));
await page.keyboard.press("Escape");
await poll(async () => (await page.locator(".dk-zoom-overlay").count()) === 0);
step(
  "the Expand chip opens the zoom view on the same picture, sent with the block's source; Esc closes it and the block still shows its picture",
  zoom.samePicture && zoom.source === blockSource && zoom.editing === 0 && (await reading()),
  JSON.stringify(zoom.source),
);

/* ---------- The slash menu's Diagram item ---------- */

await page.locator(".milkdown .ProseMirror p", { hasText: "After." }).click();
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("/diagram");
await poll(async () => page.locator('.milkdown-slash-menu[data-show="true"]').count());
const item = page.locator(".milkdown-slash-menu li", { hasText: "Diagram" });
await poll(async () => item.count());
await item.click();
await poll(async () => (await page.locator(".milkdown-code-block").count()) === 2);
// The serializer runs on the editor's update listener: poll, don't race it.
await poll(() => page.evaluate(() => (window.__md.match(/^```mermaid$/gm) || []).length === 2));
step("the slash menu's Diagram item inserts a ```mermaid block", true);

// The new block is empty: nothing to draw until there is a source.
const fresh = page.locator(".milkdown-code-block").nth(1);
const emptyPreviews = await fresh.locator(".dk-figure, .dk-figure-note").count();
await fresh.locator(".cm-content").click();
await page.keyboard.type("flowchart TB");
await poll(async () => fresh.locator(".dk-figure-error").count());
const emptyMsg = (await fresh.locator(".dk-figure-error-msg").textContent()).trim();
await page.keyboard.type("\n  Idea --> Page");
await poll(async () => fresh.locator(PICTURE).count());
const freshWords = await fresh.locator(`${PICTURE} text`).allTextContents();
step(
  "a flowchart typed from scratch: nothing while the block is empty, the error card at the header alone, the picture once it has boxes",
  emptyPreviews === 0 && /^[A-Z].*\.$/.test(emptyMsg) && freshWords.join() === "Idea,Page",
  `${emptyMsg} → ${freshWords.join()}`,
);
await page.screenshot({ path: `${SHOTS}flowchart-06-slash.png` });

/* ---------- The language picker lists mermaid ---------- */

// The picker leaves the block's own language out of filtered results, so
// this reads the unfiltered list, where the selected language leads.
await fresh.locator(".language-button").first().click();
await poll(async () => page.locator(".language-list-item").count());
const names = await page.locator(".language-list-item").allTextContents();
step(
  "the language picker offers mermaid (listed first for a mermaid block)",
  names[0]?.trim() === "mermaid",
  `first: ${names[0]?.trim()}`,
);
await page.keyboard.press("Escape");
await page.screenshot({ path: `${SHOTS}flowchart-07-picker.png` });
await page.close();

/* ---------- A read-only mount ---------- */

const ro = await open("?doc=one&ro=1", { width: 1180, height: 940 });
await poll(async () => ro.locator(PICTURE).count());
const roHidden = await poll(async () => ro.locator(".milkdown-code-block .codemirror-host.hidden").count());
step("a read-only mount shows the picture alone (source hidden)", roHidden === 1 && (await ro.locator(PICTURE).isVisible()));
await ro.screenshot({ path: `${SHOTS}flowchart-08-readonly.png` });
await ro.close();

/* ---------- A big flowchart is drawn after a pause ---------- */

// Counts every time a block says its flowchart is being drawn. The line is
// up for a moment only, so the page counts it as it comes.
const countWaits = () => {
  window.__waits = 0;
  new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node instanceof Element && (node.matches(".dk-figure-loading") || node.querySelector(".dk-figure-loading"))) {
          window.__waits++;
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
};
const big = await open("?doc=big", { width: 1180, height: 2400 }, countWaits);
const bigBlocks = await poll(() => big.evaluate(() => window.__fences));
await poll(async () => (await big.locator(PICTURE).count()) === bigBlocks.length);
// A block's picture: its words, and the source its wrapper says it was drawn from.
const bigDrawn = () =>
  big.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((svg) => ({
        label: svg.getAttribute("aria-label"),
        words: [...svg.querySelectorAll("text")].map((t) => t.textContent),
        source: decodeURIComponent(svg.parentElement.dataset.dkFigureSrc),
      })),
    PICTURE,
  );
const mounted = await bigDrawn();
const waits = await big.evaluate(() => window.__waits);
step(
  "big flowcharts mounted together: each block says its flowchart is being drawn, then shows its own picture",
  waits >= bigBlocks.length &&
    (await big.locator(".dk-figure-loading").count()) === 0 &&
    mounted.every((m, i) => m.source === bigBlocks[i].source && m.words.length === 21) &&
    mounted[0].words.every((w) => w.startsWith("Step ")) &&
    mounted[1].words.every((w) => w.startsWith("Task ")),
  `said so ${waits} times: ${mounted.map((m) => `${m.label}, ${m.words.length} boxes`).join(" | ")}`,
);

const bigBlock = big.locator(".milkdown-code-block").first();
await bigBlock.hover();
await bigBlock.locator(".dk-figure-source").click();
await poll(async () => bigBlock.locator(".cm-content").isVisible());
await big.keyboard.press("ControlOrMeta+End");
await big.keyboard.type("\n  Step7_3 --> Last");
await poll(async () => (await bigDrawn())[0].words.includes("Last"));
// The markdown follows the typing on its own delay.
await poll(() => big.evaluate(() => window.__md.includes("Step7_3 --> Last")));
const typed = (await bigDrawn())[0];
const [bigSource] = fenced(await big.evaluate(() => window.__md));
step(
  "typing in a big flowchart ends on the picture of the whole typed source, with no line left saying it is being drawn",
  typed.source === bigSource &&
    bigSource.endsWith("Step7_3 --> Last") &&
    typed.words.length === 22 &&
    (await big.locator(".dk-figure-loading").count()) === 0 &&
    (await big.locator(".dk-figure-error").count()) === 0,
  `${typed.words.length} boxes, the last ${typed.words.at(-1)}`,
);
await big.locator(".milkdown .ProseMirror p", { hasText: "After." }).click();
await poll(async () => bigBlock.locator(PICTURE).isVisible());
await big.screenshot({ path: `${SHOTS}flowchart-09-big.png` });
await big.close();

/* ---------- Verdict ---------- */

step("no page raised an error", pageErrors.length === 0, pageErrors.join(" | "));
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
process.exit(passed === results.length ? 0 : 1);
