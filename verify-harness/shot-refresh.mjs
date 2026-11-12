// Screenshot matrix for the visual refresh (tokens, palettes, type): the REAL
// App on the refresh.html IPC stub, in WebKit (the app's engine family), across
// every theme — plus "system" under an emulated dark OS, which must paint the
// same as Dark now that App.tsx resolves the theme in JS.
//
//   PORT=1437 node verify-harness/shot-refresh.mjs   (vite serving the worktree)
//
// Writes verify-harness/shots/refresh-*.png and prints a few computed-style
// probes (document font, measure, popover surface) per theme and document
// font. Then Settings → Appearance (swatches from each theme's own tokens,
// live choices, persistence), and the window layout, in light and dark: the title row with the sidebar hidden (the lead
// moves into the tab bar and the toggles must not move), and a split.
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
  { name: "light-wide", theme: "light", scheme: "light", wide: true },
  { name: "light-sans", theme: "light", scheme: "light", font: "sans" },
  { name: "dark-mono", theme: "dark", scheme: "dark", font: "mono" },
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
  await page.evaluate(
    ([theme, wide, font]) => {
      localStorage.setItem("doklin:theme", theme);
      localStorage.setItem("doklin:page-wide", wide ? "1" : "0");
      localStorage.setItem("doklin:doc-font", font);
    },
    [c.theme, !!c.wide, c.font ?? "serif"],
  );
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
    return {
      dataTheme: root.dataset.theme,
      pref: root.dataset.themePref,
      docFont: root.dataset.docFont,
      bg: getComputedStyle(document.body).backgroundColor,
      font: cs.fontFamily.split(",")[0],
      size: cs.fontSize,
      newsreader: document.fonts.check(`18px Newsreader`),
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
// The swatches paint from their own theme's tokens, the choices apply live
// with the menu still open, and they survive a relaunch.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(PAGE);
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  await page.evaluate(() => {
    localStorage.setItem("doklin:theme", "light");
    localStorage.removeItem("doklin:doc-font");
  });
  await page.reload();
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  const bodyFont = () =>
    page.evaluate(() => getComputedStyle(document.querySelector(".editor-wrap .ProseMirror p")).fontFamily.split(",")[0]);
  const faceBg = (t) =>
    page.evaluate(
      (theme) => getComputedStyle(document.querySelector(`[data-testid="settings-theme-${theme}"] .settings-swatch-face`)).backgroundColor,
      t,
    );
  const before = { font: await bodyFont(), attr: await page.evaluate(() => document.documentElement.dataset.docFont) };
  await page.click(".settings-fab");
  await page.waitForSelector(".settings-tiles.is-themes");
  const swatches = { light: await faceBg("light"), paper: await faceBg("paper"), dark: await faceBg("dark") };
  const systemFaces = await page.locator('[data-testid="settings-theme-system"] .settings-swatch-face').count();
  await page.click('[data-testid="settings-theme-paper"]');
  await page.click('[data-testid="settings-font-sans"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}refresh-appearance.png` });
  const live = {
    open: await page.locator(".settings-popover").count(),
    theme: await page.evaluate(() => document.documentElement.dataset.theme),
    attr: await page.evaluate(() => document.documentElement.dataset.docFont),
    font: await bodyFont(),
    checked: await page.locator('.settings-tile[aria-checked="true"]').evaluateAll((els) => els.map((e) => e.dataset.testid)),
  };
  await page.click('[data-testid="settings-theme-dark"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}refresh-appearance-dark.png` });
  await page.reload();
  await page.waitForSelector(".editor-wrap .ProseMirror h1", { timeout: 15000 });
  const after = {
    theme: await page.evaluate(() => document.documentElement.dataset.theme),
    attr: await page.evaluate(() => document.documentElement.dataset.docFont),
    font: await bodyFont(),
  };
  const checks = {
    serifByDefault: before.attr === "serif" && /Newsreader/.test(before.font),
    swatchesOwnTokens:
      swatches.light === "rgb(238, 243, 250)" && swatches.paper === "rgb(238, 225, 204)" && swatches.dark === "rgb(0, 0, 0)",
    systemIsTwoFaces: systemFaces === 2,
    menuStaysOpen: live.open === 1,
    appliesLive: live.theme === "paper" && live.attr === "sans" && !/Newsreader/.test(live.font),
    oneCheckedPerRow: live.checked.join() === "settings-theme-paper,settings-font-sans",
    survivesReload: after.theme === "dark" && after.attr === "sans" && after.font === live.font,
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed = true;
  console.log(
    "appearance".padEnd(13),
    bad.length ? `FAIL ${bad.join(",")}` : "ok",
    JSON.stringify({ before, swatches, live, after }),
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
    sheetInsetNoSide: noSide.sheet?.x === 8 && noSide.sheet?.y === 40,
    sheetAgainstSidebar: withSide.sheet?.x === 240,
    tabsAfterLead: noSide.firstTab != null && noSide.firstTab.x > noSide.toggle.x + 2 * 28,
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
