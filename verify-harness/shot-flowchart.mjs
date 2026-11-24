// A look at the flowchart harness (flowchart.tsx), for eyes: each document in
// each theme, every block mounted, the whole page in one picture under
// shots/flowchart-<doc>-<theme>.png. The scripted PASS/FAIL drive is
// drive-flowchart.mjs.
//
//   node verify-harness/shot-flowchart.mjs [doc…]   # gallery and fixture when none is named
//
// A doc is one of flowchart.tsx's: gallery, one, big, fixture. `fixture` is
// every flowchart in flowchart-fixture.json: the pictures to look at before
// keeping a fixture flowchart.test.mjs --write wrote.
//
// Needs a vite dev server for THIS tree. HARNESS_ORIGIN overrides it
// (default http://localhost:1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const docs = process.argv.length > 2 ? process.argv.slice(2) : ["gallery", "fixture"];

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);

const WINDOW = { width: 1100, height: 900 };
for (const doc of docs) {
  for (const theme of ["light", "paper", "dark"]) {
    const tag = `${doc} ${theme}`;
    const page = await browser.newPage({ viewport: WINDOW });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[${tag}] console.error:`, m.text());
    });
    page.on("pageerror", (e) => console.log(`[${tag}] pageerror:`, e.message));
    await page.goto(`${ORIGIN}/verify-harness/flowchart.html?doc=${doc}&theme=${theme}`);
    await page.waitForSelector(".milkdown .ProseMirror");

    // Crepe mounts a code block as it nears the viewport, so the viewport
    // takes the document's height: once for the blocks to mount, and again
    // for the height their pictures gave it. Measured in the small window,
    // where the document's height is its own and not the window's.
    const fit = async () => {
      await page.setViewportSize(WINDOW);
      const height = await page.evaluate(() => document.querySelector(".editor-wrap").scrollHeight);
      await page.setViewportSize({ width: WINDOW.width, height });
    };
    await fit();
    // A block has settled once it shows a picture, an error card or a note:
    // a big flowchart first says it is being drawn.
    const count = () =>
      page.evaluate(() => {
        const drawn = document.querySelectorAll(".dk-flowchart:not(.dk-figure-error) > svg").length;
        const cards = document.querySelectorAll(".dk-figure-error").length;
        const notes = document.querySelectorAll(".dk-figure-note").length;
        return { blocks: window.__fences.length, settled: drawn + cards + notes, drawn, cards, notes };
      });
    try {
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".dk-flowchart:not(.dk-figure-error) > svg, .dk-figure-error, .dk-figure-note").length ===
          window.__fences.length,
        { timeout: 20000 },
      );
    } catch {
      const got = await count();
      console.log(`[${tag}] TIMEOUT: ${got.settled} of ${got.blocks} blocks settled`);
    }
    await fit();
    await page.evaluate(() => document.fonts.ready);

    const file = `flowchart-${doc}-${theme}.png`;
    await page.screenshot({ path: SHOTS + file });
    const got = await count();
    console.log(`[${tag}] ${file}: ${got.drawn} drawn, ${got.cards} error cards, ${got.notes} notes, of ${got.blocks} blocks`);
    await page.close();
  }
}
await browser.close();
