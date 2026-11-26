// Drives following links in the REAL App, in Chromium (follow.html: the
// Mac's backend over an in-memory /docs workspace of linked notes):
//
//   - a click goes there in the note's own tab, and Back and Forward (⌘[ ⌘],
//     the arrows before the tabs) walk the tab's steps, each back where it
//     was scrolled;
//   - a *Copy link* of the workspace is followed in place too, one that
//     opens nothing says why, and the web goes to the browser;
//   - ⌘-click opens a new tab beside, several in a row line up, and nothing
//     else moves;
//   - a document open in another tab brings that tab forward, and its Back
//     returns to where the link was clicked;
//   - ⌘[ and ⌘] never indent or outdent a list item, and Tab still does;
//   - a link in an html document follows the same way, and the app's
//     shortcuts (⌘] ⌘W ⌘T Ctrl+Tab ⌘\ ⌘⇧F ⌘⇧\) pressed inside its frame
//     still work, while one the page fakes is taken only from the app's
//     list and only while the page holds focus;
//   - in a split, the pane the link is in follows it, and in a
//     same-document split the pane that stays keeps the note in a tab of
//     its own.
//
// The click gesture itself is drive-links.mjs. Needs a vite server on the
// worktree (see CLAUDE.md); HARNESS_ORIGIN overrides it (default
// http://localhost:1420).
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 100) {
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
  return false;
}

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGEERROR:", e.message);
});

await page.goto(`${ORIGIN}/verify-harness/follow.html`);

const pane = (side = "left") => page.locator(`.editor-pane[data-side="${side}"]`);
const heading = async (side = "left") =>
  (await pane(side).locator(".ProseMirror h1").first().textContent({ timeout: 500 }))?.trim();
const at = (title, side = "left") => poll(async () => (await heading(side)) === title);
const link = (text, side = "left") => pane(side).locator(".ProseMirror a", { hasText: text }).first();
const labels = async () => (await page.locator(".tab .tab-label").allTextContents()).join(",");
const activeLabel = () => page.locator(".tab.is-active .tab-label").textContent();
const isActive = (label) => poll(async () => (await activeLabel()) === label);
const back = page.locator('.tab-step[aria-label="Back"]');
const forward = page.locator('.tab-step[aria-label="Forward"]');
const wrapTop = (side = "left") => pane(side).locator(".editor-wrap").evaluate((el) => el.scrollTop);
const key = (k) => page.keyboard.press(k);

/* 1 — boot */
await at("A");
step(
  "boots on a, with d in a second tab, and nowhere to go back or forward",
  (await labels()) === "a,d" && (await back.isDisabled()) && (await forward.isDisabled()),
  await labels(),
);

/* 2 — a click follows in the tab */
await link("to b").click();
await at("B");
step("a click follows the link in the note's own tab", (await labels()) === "b,d" && (await activeLabel()) === "b", await labels());
step("…and the tab can go back, not forward", !(await back.isDisabled()) && (await forward.isDisabled()));

/* 3 — Back and Forward */
await key("Meta+BracketLeft");
step("⌘[ goes back", (await at("A")) && (await labels()) === "a,d" && !(await forward.isDisabled()));
await key("Meta+BracketRight");
step("⌘] goes forward again", await at("B"));
await back.click();
const viaBack = await at("A");
await forward.click();
step("the arrows before the tabs do the same", viaBack && (await at("B")));
await back.click();
await at("A");

/* 4 — where each was scrolled */
// Clicked where it is: a locator's click would scroll it again first.
await link("to b again").scrollIntoViewIfNeeded();
const scrolled = await wrapTop();
{
  const box = await link("to b again").boundingBox();
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
}
await at("B");
const bAtTop = await poll(async () => (await wrapTop()) < 50, 3000);
const bTop = await wrapTop();
await key("Meta+BracketLeft");
await at("A");
const restored = await poll(async () => Math.abs((await wrapTop()) - scrolled) < 40, 3000);
step("a followed note opens at its top, and Back returns to where the note was scrolled", scrolled > 400 && bAtTop && restored, `${scrolled} → b ${bTop} → ${await wrapTop()}`);
await pane().locator(".editor-wrap").evaluate((el) => {
  el.scrollTop = 0;
});

/* 5 — a page's link, one that opens nothing, the web */
await link("to the page").click();
step("a link to a page of the workspace is followed in the tab", (await at("E")) && (await labels()) === "e,d", await labels());
await key("Meta+BracketLeft");
await at("A");
await link("a gone page").click();
const said = await poll(async () => (await page.locator(".toast-text").allTextContents()).some((t) => t.includes("isn't one you can open")));
step("one that opens nothing says why, and stays", said && (await heading()) === "A" && (await labels()) === "a,d");
await link("the web").click();
const web = await poll(() => page.evaluate(() => window.__opened.includes("https://example.com/")));
step("the web goes to the browser, and the tab stays", web && (await heading()) === "A" && (await labels()) === "a,d");

/* 6 — ⌘-click */
await link("to c").click({ modifiers: ["Meta"] });
await poll(async () => (await labels()) === "a,c,d");
step("⌘-click opens it in a new tab beside this one, and nothing here moves", (await labels()) === "a,c,d" && (await activeLabel()) === "a" && (await heading()) === "A", await labels());
await link("to b").click({ modifiers: ["Meta"] });
await poll(async () => (await labels()) === "a,c,b,d");
step("another ⌘-click lines up after it", (await labels()) === "a,c,b,d" && (await activeLabel()) === "a", await labels());

/* 7 — a document open in another tab */
await link("to c").click();
await isActive("c");
step("a document open in another tab brings that tab forward", (await at("C")) && (await labels()) === "a,c,b,d" && !(await back.isDisabled()), await labels());
await key("Meta+BracketLeft");
step("…and its Back returns to the note the link was clicked in", (await isActive("a")) && (await at("A")));
await key("Meta+BracketRight");
step("…and Forward goes there again", (await isActive("c")) && (await at("C")));

/* 8 — ⌘[ ⌘] never indent; Tab does */
await page.locator(".tab", { hasText: /^b$/ }).locator(".tab-main").click();
await at("B");
const nested = () => pane().locator(".ProseMirror li li").count();
await pane().locator(".ProseMirror li", { hasText: "item two" }).click();
await page.keyboard.press("End");
await key("Meta+BracketRight");
await page.waitForTimeout(200);
const keptFlat = (await nested()) === 0 && (await heading()) === "B";
await page.keyboard.press("Tab");
const tabbed = await poll(async () => (await nested()) === 1, 2000);
step("⌘] in a list item doesn't indent it, and Tab still does", keptFlat && tabbed, `nested ${await nested()}`);
await key("Meta+BracketLeft");
await page.waitForTimeout(200);
step("…nor does ⌘[ outdent it", (await nested()) === 1 && (await heading()) === "B");

/* 9 — a link in an html document */
await page.locator('[data-tree-path="/docs/web.html"]').click();
await isActive("web");
const frame = page.frameLocator("iframe.html-preview");
await frame.locator("#to-e").click();
step("a link in an html document follows in its tab, as one in a note does", (await at("E")) && (await activeLabel()) === "e" && !(await labels()).includes("web"), await labels());
await key("Meta+BracketLeft");
await isActive("web");
await frame.locator("h1").click();
await key("Meta+BracketRight");
step("⌘] pressed inside the html document steps too", (await isActive("e")) && (await at("E")));
await key("Meta+BracketLeft");
await isActive("web");
{
  const open = await labels();
  await frame.locator("h1").click();
  await key("Meta+KeyW");
  const closed = await poll(async () => !(await labels()).split(",").includes("web"), 2000);
  step("⌘W pressed inside the html document closes its tab", closed && (await labels()) === open.replace(/(^|,)web(?=,|$)/, "").replace(/^,/, ""), `${open} → ${await labels()}`);
}

/* 9b — the app's other shortcuts, pressed inside an html document */
const tabCount = () => page.locator(".tab").count();
const tree = page.locator('[data-tree-path="/docs/web.html"]');
const intoWeb = async () => {
  if ((await labels()).split(",").includes("web")) await page.locator(".tab", { hasText: /^web$/ }).locator(".tab-main").click();
  else await tree.click();
  await isActive("web");
  await frame.locator("h1").click();
};
await intoWeb();
{
  const count = await tabCount();
  await key("Meta+KeyT");
  const opened = await poll(async () => (await tabCount()) === count + 1 && (await activeLabel()) !== "web", 2000);
  step("⌘T pressed inside it opens a new note", opened, await labels());
  await key("Meta+KeyW"); // the new note, empty: it closes without a question
  await poll(async () => (await tabCount()) === count, 2000);
}
await intoWeb();
await key("Control+Tab");
step("Ctrl+Tab pressed inside it moves to the next tab", await poll(async () => (await activeLabel()) !== "web", 2000), await activeLabel());
await intoWeb();
await key("Meta+Backslash");
const hid = await poll(async () => !(await tree.isVisible()), 2000);
await frame.locator("h1").click();
await key("Meta+Backslash");
step("⌘\\ pressed inside it hides the sidebar, and shows it again", hid && (await poll(() => tree.isVisible(), 2000)));
await frame.locator("h1").click();
await key("Meta+Shift+KeyF");
step("⌘⇧F pressed inside it opens the workspace search", await poll(async () => (await page.locator(".ws-search-input").count()) === 1, 2000));
await page.locator(".ws-search .sidebar-header-button").click();
await poll(() => tree.isVisible(), 2000);
{
  // The page's own scripts can post what the bridge posts: the app takes a
  // shortcut only from its list, and only while the frame holds focus.
  const fake = async (shortcut) =>
    (await (await page.locator("iframe.html-preview").elementHandle()).contentFrame()).evaluate(
      (s) => parent.postMessage({ dk: "doklin-comments", type: "shortcut", shortcut: s }, "*"),
      shortcut,
    );
  const count = await tabCount();
  await frame.locator("h1").click();
  await fake("delete-file");
  await fake("new-tab");
  const heard = await poll(async () => (await tabCount()) === count + 1, 2000);
  await key("Meta+KeyW");
  await poll(async () => (await tabCount()) === count, 2000);
  await intoWeb();
  await page.locator(".tab.is-active .tab-label").click(); // focus leaves the frame
  await fake("new-tab");
  await new Promise((r) => setTimeout(r, 600));
  step("a shortcut the page fakes is taken only from the app's list, and only while the page holds focus", heard && (await tabCount()) === count, `${count} → ${await tabCount()}`);
}
await intoWeb();
await key("Meta+Shift+Backslash");
const splitOpen = await poll(async () => (await page.locator(".pane-header").count()) > 0, 2000);
await page.frameLocator("iframe.html-preview").first().locator("h1").click();
await key("Meta+Shift+Backslash");
step("⌘⇧\\ pressed inside it opens the split, and closes it again", splitOpen && (await poll(async () => (await page.locator(".pane-header").count()) === 0, 2000)));

/* 10 — split view: the pane the link is in follows it */
await page.locator(".tab", { hasText: /^a$/ }).locator(".tab-main").click();
await at("A");
{
  const row = await page.locator('[data-tree-path="/docs/d.md"]').boundingBox();
  const area = await page.locator(".editor-area").boundingBox();
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.8, area.y + 240, { steps: 10 });
  await page.mouse.up();
}
await at("D", "right");
const before = await labels();
await link("to f", "right").click();
step(
  "in a split, the pane the link is in follows it, in its own tab",
  (await at("F", "right")) && (await heading("left")) === "A" && (await labels()) === before.replace("d", "f"),
  `${before} → ${await labels()}`,
);
await key("Meta+BracketLeft");
step("…and Back takes that pane back", (await at("D", "right")) && (await heading("left")) === "A");
await page.locator(".pane-header-close").first().click();
await poll(async () => (await page.locator(".pane-header").count()) === 0);

/* 11 — a same-document split */
await page.locator(".tab", { hasText: /^a$/ }).locator(".tab-main").click();
await at("A");
await key("Meta+Shift+Backslash");
await at("A", "right");
const tabsBefore = await page.locator(".tab").count();
await link("to g", "left").click();
step(
  "in a same-document split, the pane that stays keeps the note, in a tab of its own",
  (await at("G", "left")) && (await heading("right")) === "A" && (await page.locator(".tab").count()) === tabsBefore + 1,
  await labels(),
);

step("no page errors", errors.length === 0, errors.join(" | "));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed ? 1 : 0);
