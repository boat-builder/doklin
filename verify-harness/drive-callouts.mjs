// Drives the callout harness (callouts.tsx): `> [!NOTE]` callouts in the
// REAL editor, and the outline of a long note. What it proves:
//   - every example `doklin help writing` teaches, and every kind, opens as a
//     callout with its name and comes back byte for byte (the marker is never
//     escaped, a lowercase marker stays lowercase, a blank line after the
//     marker is kept, an empty callout is its marker alone);
//   - the guide's kinds and meanings are the app's (calloutTypes.ts);
//   - a title after the marker, an unknown kind and a quote in a list stay
//     quotes;
//   - the title is not text: find never sees "Note";
//   - the picker: a click on the title opens it under the title, arrows and
//     Enter change the kind (the marker rewritten uppercase), Esc closes it,
//     Remove callout leaves the body as ordinary blocks;
//   - typing a marker into a quote's first line and Enter makes the callout;
//     Enter on an empty last line leaves it; pasting GitHub alert markdown
//     makes one; Backspace at its start lifts its line out;
//   - read-only: the title is no control;
//   - contrast: every kind's title ≥ 4.5:1 and its text ≥ 7:1 on its tint, in
//     light, paper and dark;
//   - the outline: one line per section heading (the title left out), the
//     section being read marked, a click scrolling there.
// Needs a vite dev server for THIS tree (PORT, default 1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const PORT = process.env.PORT ?? "1420";
const URL_BASE = `http://localhost:${PORT}/verify-harness/callouts.html`;
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
  existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] } : {},
);
const open = async (query = "", viewport = { width: 1280, height: 900 }) => {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto(`${URL_BASE}${query}`);
  await poll(() => page.evaluate(() => window.__md.length > 0));
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const md = (page) => page.evaluate(() => window.__md);
const settle = (page) => page.waitForTimeout(400); // the editor's change debounce

const page = await open();

/* ---------- Open and save ---------- */

const before = await page.evaluate(() => window.__in);
const after = await md(page);
const cut = (s) => s.slice(0, s.indexOf("## Not callouts"));
step(
  "every callout comes back byte for byte: the guide's examples, every kind, a lowercase marker, a blank line after the marker, an empty one, a list and code inside",
  cut(after) === cut(before) && cut(before).length > 500,
  cut(after) === cut(before) ? "" : JSON.stringify(cut(after)).slice(0, 600),
);

const kinds = await page.evaluate(() => ({ guide: window.__guideKinds, app: window.__appKinds }));
step(
  "the guide's five kinds and meanings are the app's",
  JSON.stringify(kinds.guide) === JSON.stringify(kinds.app) && kinds.app.length === 5,
  JSON.stringify(kinds),
);

const drawn = await page.evaluate(() =>
  [...document.querySelectorAll(".ProseMirror .callout")].map((c) => ({
    kind: c.dataset.kind,
    title: c.querySelector(".callout-title")?.textContent,
    role: c.getAttribute("role"),
    editableTitle: c.querySelector(".callout-head")?.getAttribute("contenteditable"),
  })),
);
step(
  "they open as callouts: 2 from the guide, one of each kind, 5 forms — each titled with its kind's name, role note, the title not editable",
  drawn.length === 12 &&
    drawn.every((c) => c.role === "note" && c.editableTitle === "false" && c.title === c.kind[0].toUpperCase() + c.kind.slice(1)),
  JSON.stringify(drawn.map((c) => `${c.kind}:${c.title}`)),
);

const quotes = await page.evaluate(() =>
  [...document.querySelectorAll(".ProseMirror blockquote")].map((q) => q.textContent.trim().slice(0, 40)),
);
step(
  "a plain quote, a title after the marker, an unknown kind and a quote in a list stay quotes",
  quotes.length === 4 && quotes.some((q) => q.startsWith("[!NOTE] A title")) && quotes.some((q) => q.startsWith("[!info]")) && quotes.some((q) => q.startsWith("[!TIP]")),
  JSON.stringify(quotes),
);

const found = await page.evaluate(() => {
  const pm = document.querySelector(".ProseMirror");
  // The document's own text, as find and copy read it: the title widget is
  // contenteditable=false and outside the doc.
  const text = [...pm.querySelectorAll(".callout-body")].map((b) => b.textContent).join("\n");
  return { titleInBody: /\bNote\b(?! callout)/.test(text.replace(/Worth knowing.*$/m, "")) };
});
step("the title is not the document's text", found.titleInBody === false);
await page.screenshot({ path: `${SHOTS}callouts-01-light.png` });

/* ---------- The picker ---------- */

const firstHead = page.locator(".ProseMirror .callout").nth(2).locator(".callout-head"); // "Every kind": Note
await firstHead.evaluate((el) => el.scrollIntoView({ block: "center" }));
await firstHead.click();
const pickerOpen = await poll(() => page.evaluate(() => {
  const p = document.querySelector(".callout-picker");
  if (!p) return null;
  const head = document.querySelectorAll(".ProseMirror .callout")[2].querySelector(".callout-head").getBoundingClientRect();
  const r = p.getBoundingClientRect();
  return {
    rows: [...p.querySelectorAll(".callout-picker-name")].map((e) => e.textContent),
    checked: p.querySelector('[aria-checked="true"] .callout-picker-name')?.textContent,
    under: Math.round(r.top - head.bottom),
    remove: p.querySelector(".callout-picker-remove")?.textContent,
  };
}));
await page.screenshot({ path: `${SHOTS}callouts-02-picker.png` });
step(
  "a click on the title opens the picker under it: five kinds, the current one checked, then Remove callout",
  pickerOpen.rows.join() === "Note,Tip,Important,Warning,Caution" && pickerOpen.checked === "Note" && pickerOpen.under >= 0 && pickerOpen.under <= 12 && pickerOpen.remove === "Remove callout",
  JSON.stringify(pickerOpen),
);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await settle(page);
const afterPick = await page.evaluate(() => ({
  kind: document.querySelectorAll(".ProseMirror .callout")[2].dataset.kind,
  open: !!document.querySelector(".callout-picker"),
}));
const pickedMd = await md(page);
step(
  "↓ and Enter pick the next kind: the callout is a Tip, its marker rewritten",
  afterPick.kind === "tip" && !afterPick.open && pickedMd.includes("> [!TIP]\n> Worth knowing, even when skimming."),
  JSON.stringify(afterPick),
);
await firstHead.click();
await poll(() => page.evaluate(() => !!document.querySelector(".callout-picker")));
await page.keyboard.press("Escape");
const escClosed = await poll(() => page.evaluate(() => !document.querySelector(".callout-picker")));
step("Esc closes the picker", escClosed === true);

// Remove the "Every kind" Caution callout: its sentence stays as a paragraph.
const cautionHead = page.locator(".ProseMirror .callout").nth(6).locator(".callout-head");
await cautionHead.evaluate((el) => el.scrollIntoView({ block: "center" }));
await cautionHead.click();
await poll(() => page.evaluate(() => !!document.querySelector(".callout-picker")));
await page.locator(".callout-picker-remove").click();
await settle(page);
const removed = await md(page);
step(
  "Remove callout leaves its body as an ordinary paragraph",
  removed.includes("\n\nA risk: what could go wrong.\n\n") && !removed.includes("> [!CAUTION]\n> A risk"),
);

/* ---------- Typing one ---------- */

const last = page.locator(".ProseMirror p", { hasText: "The last paragraph." });
await last.click();
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("> ");
await page.keyboard.type("[!warning]");
await page.keyboard.press("Enter");
await page.keyboard.type("Typed into being.");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("And out again.");
await settle(page);
const typed = await md(page);
step(
  "typing `> [!warning]` and Enter makes a Warning; Enter on an empty last line leaves it",
  typed.includes("The last paragraph.\n\n> [!warning]\n> Typed into being.\n\nAnd out again.\n"),
  JSON.stringify(typed.slice(-120)),
);

// Paste GitHub alert markdown as text: it arrives as a callout.
await page.keyboard.press("Enter");
await page.evaluate(() => {
  const data = new DataTransfer();
  data.setData("text/plain", "> [!TIP]\n> Pasted from GitHub.");
  document.querySelector(".ProseMirror").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});
await settle(page);
const pasted = await md(page);
step(
  "pasting GitHub alert markdown makes a callout",
  pasted.includes("And out again.\n\n> [!TIP]\n> Pasted from GitHub.\n"),
  JSON.stringify(pasted.slice(-80)),
);

// Backspace at the very start of a callout's body lifts it out, as a quote's does.
const lone = page.locator(".ProseMirror .callout-body p", { hasText: "A marker in lowercase stays lowercase." });
await lone.click({ position: { x: 1, y: 8 } }); // the line's start (Home is not that on a Mac)
await page.waitForTimeout(150); // the editor reads the click's selection a beat later
await page.keyboard.press("Backspace");
await settle(page);
const lifted = await md(page);
step(
  "Backspace at the start of a callout's only line lifts the line out, the callout gone",
  lifted.includes("\n\nA marker in lowercase stays lowercase.\n\n") && !lifted.includes("> [!tip]\n> A marker in lowercase"),
  JSON.stringify(lifted.slice(lifted.indexOf("## Forms"), lifted.indexOf("## Forms") + 120)),
);
await page.close();

/* ---------- Read-only ---------- */

const ro = await open("?ro=1");
const head = ro.locator(".ProseMirror .callout").first().locator(".callout-head");
const cursor = await head.evaluate((el) => getComputedStyle(el).cursor);
await head.click();
await ro.waitForTimeout(300);
const roPicker = await ro.evaluate(() => !!document.querySelector(".callout-picker"));
step("read-only: the title is no control (no pointer, no picker)", cursor !== "pointer" && roPicker === false, cursor);
await ro.close();

/* ---------- Contrast, every kind, every theme ---------- */

const contrast = {};
for (const theme of ["light", "paper", "dark"]) {
  const p = await open(`?theme=${theme}`);
  contrast[theme] = await p.evaluate(() => {
    const parse = (s) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [v[0], v[1], v[2], v[3] ?? 1];
      }
      const c = s.match(/color\(srgb ([^)]+)\)/);
      const v = c[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1];
    };
    const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const lum = (c) => {
      const f = (x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const sheet = parse(getComputedStyle(document.querySelector(".editor-wrap")).backgroundColor);
    const out = {};
    for (const c of document.querySelectorAll(".ProseMirror .callout")) {
      if (out[c.dataset.kind]) continue;
      const tint = over(parse(getComputedStyle(c).backgroundColor), sheet);
      const ink = parse(getComputedStyle(c.querySelector(".callout-head")).color);
      const text = parse(getComputedStyle(c.querySelector(".callout-body p")).color);
      out[c.dataset.kind] = { title: +ratio(ink, tint).toFixed(2), text: +ratio(text, tint).toFixed(2) };
    }
    return out;
  });
  await p.screenshot({ path: `${SHOTS}callouts-03-${theme}.png` });
  await p.close();
}
const worst = Object.values(contrast).flatMap((t) => Object.values(t));
step(
  "every kind's title is ≥ 4.5:1 and its text ≥ 7:1 on its tint, in light, paper and dark",
  worst.length === 15 && worst.every((c) => c.title >= 4.5 && c.text >= 7),
  JSON.stringify(contrast),
);

/* ---------- The outline ---------- */

const o = await open();
const outline = await o.evaluate(() => ({
  lines: document.querySelectorAll(".doc-outline-line").length,
  items: [...document.querySelectorAll(".doc-outline-item")].map((e) => e.textContent),
  side: document.querySelector(".doc-outline")?.className,
}));
step(
  "the outline: a line per section heading, the title left out, at the right edge",
  outline.lines === 5 && outline.items[0] === "The guide's examples" && outline.items.at(-1) === "The end" && /is-right/.test(outline.side),
  JSON.stringify(outline),
);
await o.locator(".doc-outline").hover();
await o.locator(".doc-outline-item", { hasText: "Every kind" }).click();
await o.waitForTimeout(900);
const jumped = await o.evaluate(() => {
  const wrap = document.querySelector(".editor-wrap");
  const h = [...document.querySelectorAll(".ProseMirror h2")].find((e) => e.textContent === "Every kind");
  return {
    offset: Math.round(h.getBoundingClientRect().top - wrap.getBoundingClientRect().top),
    current: document.querySelector(".doc-outline-item.is-current")?.textContent,
    line: [...document.querySelectorAll(".doc-outline-line")].findIndex((l) => l.classList.contains("is-current")),
  };
});
await o.screenshot({ path: `${SHOTS}callouts-04-outline.png` });
step(
  "a click in the outline brings the section to the top, and it is the one marked",
  jumped.offset >= 0 && jumped.offset <= 40 && jumped.current === "Every kind" && jumped.line === 1,
  JSON.stringify(jumped),
);
await o.close();

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
