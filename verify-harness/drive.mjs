// Drives the real HtmlView + bridge + rail in Chromium and captures evidence.
import { chromium } from "playwright";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 5000, every = 100) {
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

// Hover an element in the frame and click the add-comment bubble once it has
// SETTLED next to that element (it follows the pointer on rAF; clicking
// mid-flight hits the page instead).
async function clickBubbleFor(frame, selector) {
  const target = frame.locator(selector);
  await target.hover();
  await poll(async () => {
    const t = await target.boundingBox();
    const b = await frame.locator("#dk-bubble.dk-on").boundingBox();
    return !!t && !!b && Math.abs(b.y - t.y - 4) < 8;
  });
  await frame.locator("#dk-bubble").click();
}

// The caret must actually be in the rail textarea before typing (focus moves
// parent-ward asynchronously after the in-iframe bubble click).
async function waitCommentInputFocused(page) {
  await poll(async () =>
    page.evaluate(
      () =>
        document.activeElement?.tagName === "TEXTAREA" &&
        document.activeElement?.className.includes("comment-input"),
    ),
  );
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/index.html");
const frame = page.frameLocator("iframe.html-preview");

// 1. Rendition renders inside the sandboxed iframe; bridge installed.
await poll(async () => (await frame.locator("#intro").count()) === 1);
await poll(async () => (await frame.locator("#dk-bubble").count()) === 1);
step("rendition renders in sandboxed iframe; bridge script installed", true);
await page.screenshot({ path: `${SHOTS}/01-initial.png` });

// 2. Hover a paragraph -> the add-comment bubble appears next to it.
await frame.locator("#intro").hover();
await poll(async () => frame.locator("#dk-bubble.dk-on").isVisible());
step("hovering a block shows the add-comment bubble", true);
await page.screenshot({ path: `${SHOTS}/02-hover-bubble.png` });

// 3. Click the bubble -> draft card opens in the rail, focused; type + Enter.
await clickBubbleFor(frame, "#intro");
await poll(async () => page.locator(".comment-card textarea").isVisible());
await waitCommentInputFocused(page);
const focusedIsTextarea = await page.evaluate(
  () => document.activeElement?.tagName === "TEXTAREA",
);
step("bubble click opens a draft card with focused textarea", focusedIsTextarea);
await page.keyboard.type("This intro reads odd");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes("This intro reads odd"),
);
const dump1 = await page.locator("#sidecar-dump").textContent();
const hasAnchor = dump1.includes('"tag":"p"') && dump1.includes("intro paragraph");
step("comment persists to sidecar (JSONL line with element anchor)", hasAnchor);
await poll(async () => (await frame.locator("#intro[data-dk-t]").count()) === 1);
step("commented element gets the highlight outline", true);
await page.screenshot({ path: `${SHOTS}/03-first-comment.png` });

// 4. Reply in the active card.
await page.locator(".comment-reply-composer textarea").click();
await page.keyboard.type("agree, let's rephrase");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes("agree, let's rephrase"),
);
const oneLine = (await page.locator("#sidecar-dump").textContent())
  .trim()
  .split("\n").length === 2; // header + one thread line carrying both entries
step("reply lands in the same thread (one JSONL line, two entries)", oneLine);
await page.screenshot({ path: `${SHOTS}/04-reply.png` });

// 5. Click pass-through: the rendition's own button still works and no
//    comment is created by clicking it.
await frame.locator("#counter").click();
const counterText = await frame.locator("#counter").textContent();
const threadsAfterClick = (await page.locator("#sidecar-dump").textContent())
  .trim()
  .split("\n").length;
step(
  "page's own interactivity untouched (button clicked, no thread created)",
  counterText.includes("clicked 1x") && threadsAfterClick === 2,
  `button: "${counterText}"`,
);

// 6. External link: routed to the system browser, iframe not navigated away.
await frame.locator("#ext").click();
const opened = await page.evaluate(() => window.__opened);
const stillThere = (await frame.locator("#intro").count()) === 1;
step(
  "external link opens via app (system browser), rendition stays",
  opened.length === 1 && opened[0] === "https://example.com/details" && stillThere,
  `opened: ${JSON.stringify(opened)}`,
);

// 7. Second thread on the card component.
await clickBubbleFor(frame, "#metrics-card h2");
await poll(async () => page.locator(".comment-card textarea").isVisible());
await waitCommentInputFocused(page);
console.log("  [diag] activeElement after pick:", await page.evaluate(() => {
  const el = document.activeElement;
  return el ? el.tagName + "." + el.className : "none";
}));
await page.keyboard.type("Metrics need a source note");
await page.keyboard.press("Enter");
try {
  await poll(async () =>
    (await page.locator("#sidecar-dump").textContent()).includes("Metrics need a source"),
  );
} catch (e) {
  console.log("  [diag] dump:", await page.locator("#sidecar-dump").textContent());
  console.log("  [diag] cards:", await page.locator(".comment-card").count());
  await page.screenshot({ path: `${SHOTS}/fail-step7.png` });
  throw e;
}
step("second thread on another component", true);
await page.screenshot({ path: `${SHOTS}/05-two-threads.png` });

// 8. Toggle comments hidden: highlights + rail vanish, bubble still offered.
await page.locator("#toggle-visible").click();
await poll(async () => (await frame.locator("html[data-dk-hidden]").count()) === 1);
const railGone = (await page.locator(".comments-rail").count()) === 0;
await frame.locator("#tail").hover();
const bubbleStillWorks = await poll(async () =>
  frame.locator("#dk-bubble.dk-on").isVisible(),
);
step("hide toggle: clean read (no highlights, no rail), bubble still available",
  railGone && !!bubbleStillWorks);
await page.screenshot({ path: `${SHOTS}/06-hidden.png` });
await page.locator("#toggle-visible").click();
await poll(async () => (await frame.locator("html[data-dk-hidden]").count()) === 0);

// 9. Draft abandon: open a draft, Esc -> thread discarded.
await clickBubbleFor(frame, "#tail");
await poll(async () => page.locator(".comment-card textarea").isVisible());
await waitCommentInputFocused(page);
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 300));
const threadsAfterAbandon = (await page.locator("#sidecar-dump").textContent())
  .trim()
  .split("\n").length;
step("abandoned draft (Esc without typing) is discarded", threadsAfterAbandon === 3);

// 10. Comment on the subtitle (will be orphaned by regeneration).
await clickBubbleFor(frame, "#subtitle");
await poll(async () => page.locator(".comment-card textarea").isVisible());
await waitCommentInputFocused(page);
await page.keyboard.type("Subtitle wording?");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes("Subtitle wording?"),
);

// 11. Regenerate the rendition (structure reshuffled, intro/tail text kept,
//     subtitle removed): intro re-anchors, subtitle orphans.
await page.locator("#regen-keep").click();
await poll(async () => (await frame.locator("section #intro").count()) === 1);
await poll(async () => (await frame.locator("#intro[data-dk-t]").count()) === 1);
step("after regeneration, thread re-anchors to same text in new structure", true);
// V2 dropped both the subtitle and the whole metrics card -> 2 orphans.
await poll(async () => (await page.locator(".comment-orphan-note").count()) === 2);
const orphanCards = await page
  .locator(".comment-card", { has: page.locator(".comment-orphan-note") })
  .allTextContents();
step(
  "threads whose elements vanished become orphan cards (kept, labeled)",
  orphanCards.some((t) => t.includes("Subtitle wording?")) &&
    orphanCards.some((t) => t.includes("Metrics need a source")),
  `${orphanCards.length} orphan cards`,
);
await page.screenshot({ path: `${SHOTS}/07-regenerated-orphan.png` });

// 12. Clicking a highlighted element activates its thread card.
await frame.locator("#intro").click();
await poll(async () => page.locator(".comment-card.is-active").isVisible());
const activeText = await page.locator(".comment-card.is-active").textContent();
step(
  "clicking a commented element activates its card",
  activeText.includes("This intro reads odd"),
);
await page.screenshot({ path: `${SHOTS}/08-activated.png` });

// 13. Delete the orphan thread via its trash button. Deselect first: with a
// card active, cards above it clamp toward the top and may overlap (designed
// cram behavior, same as the md rail) — a user would deselect the same way.
await frame.locator("h1").click();
await poll(async () => (await page.locator(".comment-card.is-active").count()) === 0);
const orphanCard = page
  .locator(".comment-card", { has: page.locator(".comment-orphan-note") })
  .filter({ hasText: "Subtitle wording?" });
await orphanCard.locator(".comment-entry").first().hover();
await orphanCard.locator(".comment-entry-delete").first().click();
await poll(async () =>
  !(await page.locator("#sidecar-dump").textContent()).includes("Subtitle wording?"),
);
step("deleting a thread removes its sidecar line", true);

console.log("\nFinal sidecar dump:\n" + (await page.locator("#sidecar-dump").textContent()));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
