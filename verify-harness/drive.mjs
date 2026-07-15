// Drives the real HtmlView + bridge + comment-mode overlay in Chromium and
// captures evidence. The layer lives behind the floating "Comment" button:
// mode off is the pristine page; mode on dims the page (bridge scrim with
// spotlight holes), arms the hover bubble, and shows threads as pins/cards
// anchored at their elements.
import { chromium } from "playwright";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
import { existsSync, mkdirSync } from "node:fs";
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

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

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

// The caret must actually be in the card textarea before typing (focus moves
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

// Scrim alpha (0..255) at an iframe-viewport point — 0 inside a spotlight
// hole, ~82 (0.32 * 255) over dimmed page.
async function scrimAlphaAt(frame, x, y) {
  return frame.locator("#dk-scrim").evaluate((c, pt) => {
    const dpr = window.devicePixelRatio || 1;
    return c
      .getContext("2d")
      .getImageData(Math.round(pt.x * dpr), Math.round(pt.y * dpr), 1, 1).data[3];
  }, { x, y });
}

const sidecarLines = async (page) =>
  (await page.locator("#sidecar-dump").textContent()).trim().split("\n").length;

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/index.html");
const frame = page.frameLocator("iframe.html-preview");

// 1. Rendition renders inside the sandboxed iframe; bridge installed; the
//    floating Comment button is the only comment UI visible.
await poll(async () => (await frame.locator("#intro").count()) === 1);
await poll(async () => (await frame.locator("#dk-bubble").count()) === 1);
await poll(async () => page.locator(".html-comment-btn").isVisible());
step("rendition renders in sandboxed iframe; bridge + Comment button present", true);
await page.screenshot({ path: `${SHOTS}/01-initial.png` });

// 2. DEFAULT experience is pristine: hovering shows no bubble, no scrim.
await frame.locator("#intro").hover();
await settle();
const defaultClean =
  !(await frame.locator("#dk-bubble.dk-on").isVisible()) &&
  !(await frame.locator("#dk-scrim.dk-on").isVisible());
step("comment mode off by default: hover shows no bubble, page undimmed", defaultClean);

// 3. Enter comment mode: scrim on, hover arms the dotted border + bubble.
await page.locator(".html-comment-btn").click();
await poll(async () => frame.locator("#dk-scrim.dk-on").isVisible());
await frame.locator("#intro").hover();
await poll(async () => frame.locator("#dk-bubble.dk-on").isVisible());
await poll(async () => (await frame.locator("#intro[data-dk-hover]").count()) === 1);
step("Comment button enters mode: page dims, hover shows dashed border + bubble", true);
await page.screenshot({ path: `${SHOTS}/02-mode-on-hover.png` });

// 4. The hovered block is spotlit: hole over it, dim elsewhere. Frame
//    locators report boxes in PAGE coordinates; the scrim canvas lives in
//    iframe-viewport space, so subtract the iframe's own origin.
const frameBox = await page.locator("iframe.html-preview").boundingBox();
const introBox = await frame.locator("#intro").boundingBox();
const inHole = await scrimAlphaAt(
  frame,
  introBox.x - frameBox.x + 10,
  introBox.y - frameBox.y + 5,
);
const inDim = await scrimAlphaAt(frame, frameBox.width - 30, frameBox.height - 40);
step(
  "scrim cuts a spotlight over the hovered block",
  inHole === 0 && inDim > 40,
  `alpha in hole ${inHole}, in dim ${inDim}`,
);

// 5. Click the bubble -> floating draft card AT the element, focused; type.
await clickBubbleFor(frame, "#intro");
await poll(async () => page.locator(".html-comment-pop .comment-card textarea").isVisible());
await waitCommentInputFocused(page);
const popBox = await page.locator(".html-comment-pop").boundingBox();
// Both boxes are page coordinates (the overlay shares the iframe's box).
const nearAnchor = Math.abs(popBox.y - introBox.y) < 60; // card top tracks the element top
step("bubble click opens a floating draft card at the element", nearAnchor,
  `card y ${Math.round(popBox.y)} vs anchor y ${Math.round(introBox.y)}`);
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

// 6. Reply in the open card.
await page.locator(".comment-reply-composer textarea").click();
await page.keyboard.type("agree, let's rephrase");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes("agree, let's rephrase"),
);
const oneLine = (await sidecarLines(page)) === 2; // header + one thread line carrying both entries
step("reply lands in the same thread (one JSONL line, two entries)", oneLine);
await page.screenshot({ path: `${SHOTS}/04-reply.png` });

// 6b. The body text is not an edit target: clicking it drops the caret in
//     the reply composer instead of opening the entry for rewriting.
await page.locator(".comment-card .comment-entry-body").first().click();
const bodyClickState = await page.evaluate(() => ({
  entryEditors: document.querySelectorAll(".comment-entry .comment-input").length,
  inComposer: document.activeElement?.closest(".comment-reply-composer") != null,
}));
step(
  "clicking a comment body replies instead of editing it",
  bodyClickState.entryEditors === 0 && bodyClickState.inComposer,
);

// 6c. Editing your own words goes through the explicit pencil.
await page.locator(".comment-card .comment-entry-edit").first().click();
await poll(async () => page.locator(".comment-entry .comment-input").isVisible());
await page.keyboard.type(" — reworded");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes(
    "This intro reads odd — reworded",
  ),
);
step("own entries edit via the explicit pencil (sidecar updated)", true);

// 7. Click pass-through: the rendition's own button still works, no comment
//    is created, and clicking a non-commented spot closes the open card.
await frame.locator("#counter").click();
const counterText = await frame.locator("#counter").textContent();
const threadsAfterClick = await sidecarLines(page);
await poll(async () => (await page.locator(".html-comment-pop").count()) === 0);
step(
  "page's own interactivity untouched; clicking elsewhere closes the card",
  counterText.includes("clicked 1x") && threadsAfterClick === 2,
  `button: "${counterText}"`,
);

// 8. The closed thread now shows as a pin at its element.
await poll(async () => (await page.locator(".html-comment-pin").count()) === 1);
const pinBox = await page.locator(".html-comment-pin").boundingBox();
const introBox2 = await frame.locator("#intro").boundingBox();
const pinOnCorner =
  Math.abs(pinBox.y - introBox2.y) < 30 &&
  pinBox.x > introBox2.x + introBox2.width - 60;
step("thread collapses to an avatar pin on the element's corner", pinOnCorner);
await page.screenshot({ path: `${SHOTS}/05-pin.png` });

// 9. Clicking the pin reopens the floating card.
await page.locator(".html-comment-pin").click();
await poll(async () => page.locator(".html-comment-pop .comment-card").isVisible());
const reopened = await page.locator(".html-comment-pop").textContent();
step("clicking a pin opens its thread card", reopened.includes("This intro reads odd"));

// 10. External link: routed to the system browser, iframe not navigated
//     away. The postMessage -> invoke hop is async — poll for it.
await frame.locator("#ext").click();
await poll(async () => page.evaluate(() => window.__opened.length === 1));
const opened = await page.evaluate(() => window.__opened);
const stillThere = (await frame.locator("#intro").count()) === 1;
step(
  "external link opens via app (system browser), rendition stays",
  opened.length === 1 && opened[0] === "https://example.com/details" && stillThere,
  `opened: ${JSON.stringify(opened)}`,
);

// 11. Second thread on the card component.
await clickBubbleFor(frame, "#metrics-card h2");
await poll(async () => page.locator(".html-comment-pop .comment-card textarea").isVisible());
await waitCommentInputFocused(page);
await page.keyboard.type("Metrics need a source note");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes("Metrics need a source"),
);
step("second thread on another component", true);
await page.screenshot({ path: `${SHOTS}/06-two-threads.png` });

// 12. Leave comment mode: everything vanishes — pins, cards, scrim,
//     highlights — and the hover bubble is disarmed; the button shows the
//     thread count instead.
await page.locator(".html-comment-btn").click();
await poll(async () => (await frame.locator("html[data-dk-hidden]").count()) === 1);
await poll(async () => !(await frame.locator("#dk-scrim.dk-on").isVisible()));
const nothingShown =
  (await page.locator(".html-comment-pin").count()) === 0 &&
  (await page.locator(".html-comment-pop").count()) === 0;
await frame.locator("#tail").hover();
await settle();
const bubbleDisarmed = !(await frame.locator("#dk-bubble.dk-on").isVisible());
const countChip = await page.locator(".html-comment-btn-count").textContent();
step(
  "Done restores the pristine page (no pins/cards/scrim, bubble disarmed)",
  nothingShown && bubbleDisarmed && countChip === "2",
  `count chip: ${countChip}`,
);
await page.screenshot({ path: `${SHOTS}/07-mode-off.png` });

// 13. Re-enter mode: pins come back where the threads live.
await page.locator(".html-comment-btn").click();
await poll(async () => (await page.locator(".html-comment-pin").count()) === 2);
step("re-entering mode shows a pin per thread", true);
await page.screenshot({ path: `${SHOTS}/08-two-pins.png` });

// 14. Draft abandon: open a draft, Esc -> thread discarded.
await clickBubbleFor(frame, "#tail");
await poll(async () => page.locator(".html-comment-pop .comment-card textarea").isVisible());
await waitCommentInputFocused(page);
await page.keyboard.press("Escape");
await settle(300);
step("abandoned draft (Esc without typing) is discarded", (await sidecarLines(page)) === 3);

// 15. Leaving mode with an unwritten draft open also discards it.
await clickBubbleFor(frame, "#tail");
await poll(async () => page.locator(".html-comment-pop .comment-card textarea").isVisible());
await waitCommentInputFocused(page);
await page.locator(".html-comment-btn").click(); // "Done" while the draft is open
await settle(300);
const draftSwept = (await sidecarLines(page)) === 3;
step("leaving mode discards an unwritten draft", draftSwept);
await page.locator(".html-comment-btn").click(); // back into mode for the rest
await poll(async () => frame.locator("#dk-scrim.dk-on").isVisible());

// 16. Comment on the subtitle (will be orphaned by regeneration).
await clickBubbleFor(frame, "#subtitle");
await poll(async () => page.locator(".html-comment-pop .comment-card textarea").isVisible());
await waitCommentInputFocused(page);
await page.keyboard.type("Subtitle wording?");
await page.keyboard.press("Enter");
await poll(async () =>
  (await page.locator("#sidecar-dump").textContent()).includes("Subtitle wording?"),
);

// 17. Regenerate the rendition (structure reshuffled, intro/tail text kept,
//     subtitle removed): intro re-anchors, subtitle + metrics orphan into
//     the stack under the button.
await page.locator("#regen-keep").click();
await poll(async () => (await frame.locator("section #intro").count()) === 1);
await poll(async () => (await frame.locator("#intro[data-dk-t]").count()) === 1);
step("after regeneration, thread re-anchors to same text in new structure", true);
await poll(async () => (await page.locator(".comment-orphan-note").count()) === 2);
const orphanStack = await page.locator(".html-comment-orphans").textContent();
step(
  "threads whose elements vanished become orphan cards (kept, labeled)",
  orphanStack.includes("Subtitle wording?") && orphanStack.includes("Metrics need a source"),
);
await page.screenshot({ path: `${SHOTS}/09-regenerated-orphan.png` });

// 18. Clicking a highlighted element opens its floating card.
await frame.locator("#intro").click();
await poll(async () => page.locator(".html-comment-pop .comment-card").isVisible());
const activeText = await page.locator(".html-comment-pop .comment-card").textContent();
step(
  "clicking a commented element opens its card",
  activeText.includes("This intro reads odd"),
);
await page.screenshot({ path: `${SHOTS}/10-activated.png` });

// 19. Delete the orphan thread via its trash button.
await frame.locator("h1").click(); // deselect first
await poll(async () => (await page.locator(".html-comment-pop").count()) === 0);
const orphanCard = page
  .locator(".html-comment-orphans .comment-card")
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
