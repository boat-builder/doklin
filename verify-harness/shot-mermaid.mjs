// Quick visual pass for the mermaid harness: load each theme, wait for the
// diagrams to land, screenshot full page. Not the scripted PASS/FAIL drive
// (drive-mermaid.mjs) — just eyeballs.
//   node verify-harness/shot-mermaid.mjs [urlSuffix]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:1420/verify-harness/mermaid.html";
const OUT = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

for (const theme of ["light", "sepia", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${theme}] console.error:`, m.text());
  });
  page.on("pageerror", (e) => console.log(`[${theme}] pageerror:`, e.message));
  await page.goto(`${BASE}?theme=${theme}${process.argv[2] ?? ""}`);
  // Diagrams are debounced + lazily loaded; wait for at least 5 SVGs.
  try {
    await page.waitForFunction(
      () => document.querySelectorAll(".dk-mermaid svg").length >= 5,
      { timeout: 20000 },
    );
  } catch {
    console.log(`[${theme}] TIMEOUT waiting for diagrams — svg count:`,
      await page.evaluate(() => document.querySelectorAll(".dk-mermaid svg").length));
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}mermaid-${theme}.png`, fullPage: true });
  console.log(`[${theme}] shot written; svgs:`,
    await page.evaluate(() => document.querySelectorAll(".dk-mermaid svg").length),
    "errors:",
    await page.evaluate(() => document.querySelectorAll(".dk-mermaid-error").length));
  await page.close();
}
await browser.close();
