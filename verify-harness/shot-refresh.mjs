// Screenshot matrix for the visual refresh (tokens, palettes, type): the REAL
// App on the refresh.html IPC stub, in WebKit (the app's engine family), across
// every theme — plus "system" under an emulated dark OS, which must paint the
// same as Dark now that App.tsx resolves the theme in JS.
//
//   PORT=1437 node verify-harness/shot-refresh.mjs   (vite serving the worktree)
//
// Writes verify-harness/shots/refresh-*.png and prints a few computed-style
// probes (document font, measure, popover surface) per theme.
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
    ([theme, wide]) => {
      localStorage.setItem("doklin:theme", theme);
      localStorage.setItem("doklin:page-wide", wide ? "1" : "0");
    },
    [c.theme, !!c.wide],
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
await browser.close();
process.exit(failed ? 1 : 0);
