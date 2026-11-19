// Screenshot matrix for the visual refresh (tokens, palettes, type): the REAL
// App on the refresh.html IPC stub, in WebKit (the app's engine family), across
// every theme — plus "system" under an emulated dark OS, which must paint the
// same as Dark now that App.tsx resolves the theme in JS.
//
//   PORT=1437 node verify-harness/shot-refresh.mjs   (vite serving the worktree)
//
// Writes verify-harness/shots/refresh-*.png and prints a few computed-style
// probes (document fonts, measure, popover surface) per theme. Then Settings
// → Appearance (the theme as its only choice, swatches from each theme's own
// tokens, a live pick, persistence), and the flat window layout, in light and dark: the title row with the
// sidebar hidden (the lead moves into the tab bar and the toggles must not
// move), and a split.
import { webkit } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = process.env.PORT || "1420";
const PAGE = `http://localhost:${PORT}/verify-harness/refresh.html`;
const OUT = new URL("./shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const cases = [
  { name: "light", theme: "light", scheme: "light" },
  { name: "paper", theme: "paper", scheme: "light" },
  { name: "dark", theme: "dark", scheme: "dark" },
  { name: "system-dark", theme: "system", scheme: "dark" },
  { name: "system-light", theme: "system", scheme: "light" },
];

const browser = await webkit.launch();
let failed = false;
for (const c of cases) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: c.scheme,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // The stub seeds (and first clears) localStorage on its first load, so the
  // prefs go in after that seed, then a reload boots with them.
  await page.goto(PAGE);
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  await page.evaluate((theme) => localStorage.setItem("doklin:theme", theme), c.theme);
  await page.reload();
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}refresh-${c.name}.png` });

  const probe = await page.evaluate(() => {
    const root = document.documentElement;
    const pm = document.querySelector(".editor-wrap .ProseMirror");
    const p = pm.querySelector("p");
    const cs = getComputedStyle(p);
    const h1 = getComputedStyle(pm.querySelector("h1"));
    return {
      dataTheme: root.dataset.theme,
      pref: root.dataset.themePref,
      bg: getComputedStyle(document.body).backgroundColor,
      font: cs.fontFamily.split(",")[0],
      size: cs.fontSize,
      heading: `${h1.fontFamily.split(",")[0]} ${h1.fontWeight} ${h1.fontSize}`,
      loaded: ["Inter", "Literata", "Roboto Mono"].filter((f) => document.fonts.check(`16px "${f}"`)).join("+"),
      measure: Math.round(pm.getBoundingClientRect().width),
      footer: !!document.querySelector(".side-footer .settings-wrap.is-docked"),
    };
  });

  // The settings popover, docked in the footer.
  await page.click(".settings-fab");
  await page.waitForSelector(".settings-popover");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}refresh-${c.name}-settings.png` });
  probe.popoverBg = await page.evaluate(
    () => getComputedStyle(document.querySelector(".settings-popover")).backgroundColor,
  );

  if (errors.length) failed = true;
  console.log(c.name.padEnd(13), JSON.stringify(probe), errors.length ? `ERRORS ${errors}` : "");
  await ctx.close();
}

// ---------- Settings → Appearance ----------
// The theme tiles, then Full width: the swatches paint from their own
// theme's tokens, a pick applies live with the menu still open and survives
// a relaunch, the document's faces are fixed, and Full width lifts the
// column's cap (live, across a relaunch, and back).
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(PAGE);
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("doklin:theme", "light"));
  await page.reload();
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  const docLook = () =>
    page.evaluate(() => {
      const pm = document.querySelector(".editor-wrap .ProseMirror");
      const face = (sel) => getComputedStyle(pm.querySelector(sel)).fontFamily.split(",")[0];
      return { text: face("p"), head: face("h1"), measure: Math.round(pm.getBoundingClientRect().width) };
    });
  const faceBg = (t) =>
    page.evaluate(
      (theme) => getComputedStyle(document.querySelector(`[data-testid="settings-theme-${theme}"] .settings-swatch-face`)).backgroundColor,
      t,
    );
  const before = await docLook();
  await page.click(".settings-fab");
  await page.waitForSelector(".settings-tiles");
  const swatches = { light: await faceBg("light"), paper: await faceBg("paper"), dark: await faceBg("dark") };
  const systemFaces = await page.locator('[data-testid="settings-theme-system"] .settings-swatch-face').count();
  const appearance = await page.evaluate(() => {
    const label = [...document.querySelectorAll(".settings-section-label")].find((l) => l.textContent === "Appearance");
    const items = [];
    for (let el = label?.nextElementSibling; el && !el.classList.contains("settings-divider"); el = el.nextElementSibling) {
      items.push(el.className);
    }
    return { items, tiles: [...document.querySelectorAll(".settings-popover .settings-tile")].map((t) => t.dataset.testid) };
  });
  await page.click('[data-testid="settings-theme-paper"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}refresh-appearance.png` });
  const live = {
    open: await page.locator(".settings-popover").count(),
    theme: await page.evaluate(() => document.documentElement.dataset.theme),
    checked: await page.locator('.settings-tile[aria-checked="true"]').evaluateAll((els) => els.map((e) => e.dataset.testid)),
  };
  await page.click('[data-testid="settings-theme-dark"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}refresh-appearance-dark.png` });
  await page.click('[data-testid="settings-full-width"]');
  await page.waitForTimeout(250);
  const wide = {
    open: await page.locator(".settings-popover").count(),
    checked: await page.getAttribute('[data-testid="settings-full-width"]', "aria-checked"),
    measure: (await docLook()).measure,
    pane: await page.evaluate(() => Math.round(document.querySelector(".editor-wrap").clientWidth)),
  };
  // A relaunch.
  await page.reload();
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  const after = { theme: await page.evaluate(() => document.documentElement.dataset.theme), ...(await docLook()) };
  await page.click(".settings-fab");
  await page.click('[data-testid="settings-full-width"]');
  await page.waitForTimeout(250);
  const narrowAgain = (await docLook()).measure;
  const checks = {
    serifHeadingsSansText: /Inter/.test(before.text) && /Literata/.test(before.head),
    columnIs672: before.measure === 672 + 128,
    themeTilesThenFullWidth:
      appearance.items.join() === "settings-tiles,settings-option" &&
      appearance.tiles.join() === "settings-theme-system,settings-theme-light,settings-theme-paper,settings-theme-dark",
    swatchesOwnTokens:
      swatches.light === "rgb(249, 249, 247)" && swatches.paper === "rgb(243, 241, 236)" && swatches.dark === "rgb(11, 11, 11)",
    systemIsTwoFaces: systemFaces === 2,
    menuStaysOpen: live.open === 1,
    appliesLive: live.theme === "paper" && live.checked.join() === "settings-theme-paper",
    survivesReload: after.theme === "dark",
    facesFixed: after.text === before.text && after.head === before.head,
    fullWidthSpansPane: wide.open === 1 && wide.checked === "true" && wide.measure === wide.pane,
    fullWidthSurvivesReload: after.measure === wide.measure,
    fullWidthOffIs672: narrowAgain === 672 + 128,
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed = true;
  console.log(
    "appearance".padEnd(13),
    bad.length ? `FAIL ${bad.join(",")}` : "ok",
    JSON.stringify({ before, appearance, swatches, live, wide, after, narrowAgain }),
    errors.length ? `ERRORS ${errors}` : "",
  );
  await ctx.close();
}

// ---------- Window layout ----------
const rect = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  }, sel);
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(PAGE);
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  await page.evaluate((t) => localStorage.setItem("doklin:theme", t), theme);
  await page.reload();
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);

  const withSide = {
    toggle: await rect(page, ".title-toggle"),
    bar: await rect(page, ".tab-bar"),
    sheet: await rect(page, ".editor-area"),
    firstTab: await rect(page, ".tab"),
  };
  await page.click('[aria-label="Toggle sidebar"]');
  await page.waitForSelector(".tab-bar.has-lead .title-lead");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}refresh-layout-${theme}-nosidebar.png` });
  const noSide = {
    toggle: await rect(page, ".title-toggle"),
    sheet: await rect(page, ".editor-area"),
    firstTab: await rect(page, ".tab"),
  };
  await page.click('[aria-label="Toggle sidebar"]');
  await page.click(".split-toggle");
  await page.waitForSelector(".pane-header");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}refresh-layout-${theme}-split.png` });

  const checks = {
    barIs40: withSide.bar?.h === 40,
    togglesStay: withSide.toggle?.x === noSide.toggle?.x && withSide.toggle?.y === noSide.toggle?.y,
    sheetFlushNoSide: noSide.sheet?.x === 0 && noSide.sheet?.y === 40,
    sheetAgainstSidebar: withSide.sheet?.x === 240 && withSide.sheet?.y === 40,
    sheetToWindowEdge: noSide.sheet?.w === 1280 && noSide.sheet?.h === 780,
    tabsAfterLead: noSide.firstTab != null && noSide.firstTab.x > noSide.toggle.x + 28,
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed = true;
  console.log(
    `layout-${theme}`.padEnd(13),
    bad.length ? `FAIL ${bad.join(",")}` : "ok",
    JSON.stringify({ withSide, noSide }),
    errors.length ? `ERRORS ${errors}` : "",
  );
  await ctx.close();
}

await browser.close();
process.exit(failed ? 1 : 0);
