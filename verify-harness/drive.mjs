// Drives the real HtmlView and the script it puts in the page (htmlBridge.ts)
// in a browser, and captures evidence: comments beside the page, a thread
// started from selected words and from a picked part, hiding and showing, a
// page written again under its threads — and the `places` cases of
// comments-fixture.json, which the worker's and the iPhone's reading of a
// page are held to as well (`state` is this script's answer).
//
//   node verify-harness/drive.mjs
//
// HARNESS_ORIGIN picks the vite server (default http://localhost:1420), and
// BROWSER=webkit the engine the app itself runs on.
import { chromium, webkit } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = process.env.HARNESS_ORIGIN ?? "http://localhost:1420";
const fixture = JSON.parse(readFileSync(new URL("./comments-fixture.json", import.meta.url), "utf8"));

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

// A step that must become true: a timeout is the step failing, not the run.
async function eventually(name, fn, detail = "") {
  try {
    await poll(fn);
    step(name, true, detail);
  } catch (e) {
    step(name, false, String(e.message ?? e));
  }
}

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, by) => Math.abs(a - b) <= by;

const engine = process.env.BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch(
  engine === chromium && existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${ORIGIN}/verify-harness/index.html`);
const frame = page.frameLocator("iframe.html-preview");
const frameBox = () => page.locator(".html-frame-box").boundingBox();
const stageBox = () => page.locator("#stage").boundingBox();
const dump = async () => (await page.locator("#thread-dump").textContent()).trim();
const threadLines = async () => {
  const text = await dump();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
};
// Inside the frame: its own scroll, and what is tinted.
const inFrame = (fn, arg) => frame.locator("body").evaluate(fn, arg);
// How many stretches of words the script has marked (null: the browser has
// no highlight registry), and the intro line as it is painted — the two
// must agree, since a mark the browser never paints is no mark.
const tinted = () => inFrame(() => (window.CSS && CSS.highlights ? [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0) : null));
const introPainted = async () => {
  const box = await frame.locator("#intro").boundingBox();
  await page.mouse.move(5, 5);
  return (await page.screenshot({ clip: { x: box.x, y: box.y - 4, width: 420, height: box.height + 8 } })).toString("base64");
};
// A key pressed with the keyboard in the app, on nothing that takes typing.
async function appKey(key) {
  await page.locator("#controls").click({ position: { x: 400, y: 6 } });
  await page.keyboard.press(key);
}

/* ---------- The page as its reader gets it ---------- */

await poll(async () => (await frame.locator("#intro").count()) === 1);
await poll(async () => page.locator(".html-comment-btn").isVisible());
const pristine = await inFrame(() => ({
  scripts: document.querySelectorAll("script").length,
  marked: [...document.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => a.name.startsWith("data-dk"))).length,
  added: document.querySelectorAll("[id^='dk-']").length,
  children: document.body.children.length,
  styles: document.querySelectorAll("style").length,
}));
step(
  "the page is left as it was found: no script, attribute or element of the app's in it",
  pristine.scripts === 0 && pristine.marked === 0 && pristine.added === 0 && pristine.children === 2 && pristine.styles === 1,
  JSON.stringify(pristine),
);
{
  const [f, s] = [await frameBox(), await stageBox()];
  step("no comments: the page has its full width, and no column", near(f.width, s.width, 3) && (await page.locator(".html-comments-margin").count()) === 0, `${f.width} of ${s.width}`);
}
await page.screenshot({ path: `${SHOTS}/01-initial.png` });
const introPlain = await introPainted();

/* ---------- A thread on words ---------- */

// Select a word of the intro, as a reader does.
await frame.locator("#intro").dblclick({ position: { x: 150, y: 9 } });
await eventually("selecting words offers Comment", () => page.locator(".html-select-comment").isVisible());
const picked = await inFrame(() => {
  const range = getSelection().getRangeAt(0);
  const r = range.getBoundingClientRect();
  return { words: String(getSelection()).trim(), top: r.top, height: r.height };
});
{
  const button = await page.locator(".html-select-comment").boundingBox();
  const f = await frameBox();
  step(
    "the Comment button is at the page's right edge, level with the selected words",
    near(button.y + button.height / 2, f.y + picked.top + picked.height / 2, 6) && near(button.x + button.width, f.x + f.width - 14, 22),
    `button ${Math.round(button.y + button.height / 2)}, words ${Math.round(f.y + picked.top + picked.height / 2)}`,
  );
}
await page.screenshot({ path: `${SHOTS}/02-selected.png` });

const introBefore = await frame.locator("#intro").innerHTML();
await page.locator(".html-select-comment").click();
await eventually("Comment opens a card beside the page, ready to type in", () =>
  page.evaluate(() => {
    const active = document.activeElement;
    return !!active && active.tagName === "TEXTAREA" && !!active.closest(".html-comments-margin .comment-card.is-active");
  }),
);
step("the card says the words it is on, before anything is typed", (await page.locator(".comment-card.is-active .comment-on-quote").textContent()) === picked.words, picked.words);
await eventually("the page gives the column its width", async () => {
  const [f, s] = [await frameBox(), await stageBox()];
  return near(f.width, s.width - 312, 3);
});
await eventually("the card sits level with its words", async () => {
  const card = await page.locator(".comment-card.is-active").boundingBox();
  const f = await frameBox();
  const top = await inFrame((_body, words) => {
    const walker = document.createTreeWalker(document.querySelector("#intro"), NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const at = node.data.indexOf(words);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    return range.getBoundingClientRect().top;
  }, picked.words);
  return near(card.y, f.y + top, 10);
});
await page.keyboard.type("This word?");
await page.keyboard.press("Enter");
await eventually("the thread is saved with its words, the text either side and the part they are in", async () => {
  const [t] = await threadLines();
  return t && t.anchor.quote === picked.words && t.anchor.tag === "p" && t.anchor.ids?.[0] === "intro" && typeof t.anchor.prefix === "string" && t.comments[0].body === "This word?";
});
await eventually("the words are marked and painted so, and the paragraph's markup is what it was", async () => {
  const count = await tinted();
  return count === 1 && (await introPainted()) !== introPlain && (await frame.locator("#intro").innerHTML()) === introBefore;
});
const introHot = await introPainted();
await page.screenshot({ path: `${SHOTS}/03-words-thread.png` });

// Outside picking, the page's clicks are its own: a click elsewhere closes
// the card, the page's button still counts, and a click on the words opens
// the thread again.
await frame.locator("h1").click();
await eventually("a click elsewhere on the page closes the card", async () => (await page.locator(".comment-card.is-active").count()) === 0);
await eventually("the words stay marked, more lightly than while their card was open", async () => {
  const now = await introPainted();
  return now !== introPlain && now !== introHot;
});
await frame.locator("#counter").click();
await eventually("the page's own button still answers its click", async () => (await frame.locator("#counter").textContent()) === "clicked 1x");
const wordAt = await inFrame((_body, words) => {
  const node = document.createTreeWalker(document.querySelector("#intro"), NodeFilter.SHOW_TEXT).nextNode();
  const at = node.data.indexOf(words);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + words.length);
  const r = range.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, picked.words);
{
  const f = await frameBox();
  await page.mouse.click(f.x + wordAt.x, f.y + wordAt.y);
}
await eventually("a click on commented words opens their card", async () => (await page.locator(".comment-card.is-active").count()) === 1);
await frame.locator("h1").click();
await poll(async () => (await page.locator(".comment-card.is-active").count()) === 0);

/* ---------- A thread on a part ---------- */

await appKey("c");
await eventually("C starts picking, and says what a click will do", () => page.locator(".html-pick-bar").isVisible());
const para = frame.locator("#metrics-card p");
await para.hover();
await eventually("the smallest part under the pointer is outlined, and named", async () => {
  const outline = await page.locator(".html-part-outline.is-picking").boundingBox();
  const p = await para.boundingBox();
  const label = await page.locator(".html-part-outline-label").textContent();
  return near(outline.x, p.x - 4, 3) && near(outline.y, p.y - 4, 3) && near(outline.width, p.width + 8, 4) && label.startsWith("Paragraph");
});
await page.keyboard.press("ArrowUp");
await eventually("↑ takes the part around it", async () => {
  const outline = await page.locator(".html-part-outline.is-picking").boundingBox();
  const card = await frame.locator("#metrics-card").boundingBox();
  return near(outline.y, card.y - 4, 3) && near(outline.height, card.height + 8, 4) && (await page.locator(".html-part-outline-label").textContent()).includes("Metrics");
});
await page.keyboard.press("ArrowDown");
await eventually("↓ comes back in", async () => {
  const outline = await page.locator(".html-part-outline.is-picking").boundingBox();
  const p = await para.boundingBox();
  return near(outline.height, p.height + 8, 4);
});
step("commented words keep their tint while a part is being picked", (await introPainted()) !== introPlain);
await para.hover();
await page.screenshot({ path: `${SHOTS}/04-picking.png` });

// A click anywhere in a part picks it — here on a link, which is not followed.
await frame.locator("#ext").click();
await eventually("a click anywhere in a part starts a thread on it, and the page's link is not followed", async () => {
  const opened = await page.evaluate(() => window.__opened.length);
  const on = await page.locator(".comment-card.is-active .comment-on-part").textContent();
  return opened === 0 && on.startsWith("Paragraph") && on.includes("Read the full details online.");
});
step("picking has ended", !(await page.locator(".html-pick-bar").isVisible()));
await page.keyboard.type("Which details?");
await page.keyboard.press("Enter");
await eventually("the thread on the part is saved by its tag and opening words, with no words of its own", async () => {
  const list = await threadLines();
  const t = list.find((x) => x.comments[0].body === "Which details?");
  return t && t.anchor.tag === "p" && t.anchor.text === "Read the full details online." && t.anchor.quote === undefined;
});
await frame.locator("h1").click();
await poll(async () => (await page.locator(".comment-card.is-active").count()) === 0);
const linkPara = frame.locator("main > p", { hasText: "Read the" });
await eventually("a part with a thread has a marker at its corner, and no outline until asked", async () => {
  const marker = await page.locator(".html-comment-marker").boundingBox();
  const p = await linkPara.boundingBox();
  return near(marker.y + marker.height / 2, p.y, 4) && near(marker.x + marker.width / 2, p.x + p.width, 14) && (await page.locator(".html-part-outline").count()) === 0;
});
await page.locator(".html-comment-marker").hover();
await eventually("the marker and its card light together, and the part is outlined", async () =>
  (await page.locator(".comment-card.is-lit").count()) === 1 && (await page.locator(".html-part-outline").count()) === 1,
);
await page.locator(".html-comment-marker").click();
await eventually("the marker opens its card", async () => (await page.locator(".comment-card.is-active").textContent()).includes("Which details?"));
step("and after it: the words are painted as marked beside the open thread on a part", (await introPainted()) !== introPlain);
await page.locator(".html-comment-marker").hover();
await page.screenshot({ path: `${SHOTS}/05-part-thread.png` });
await page.keyboard.press("Escape");
await eventually("Esc closes the open card", async () => (await page.locator(".comment-card.is-active").count()) === 0);

// Esc also stops picking, and an abandoned draft is not saved.
await appKey("c");
await poll(() => page.locator(".html-pick-bar").isVisible());
await appKey("Escape");
await eventually("Esc stops picking", async () => !(await page.locator(".html-pick-bar").isVisible()));

// The same keys with the keyboard inside the page, where the app's window
// never hears them: the script passes them on. A message that only claims
// to be a key, posted by the page while the keyboard is elsewhere, is not
// one.
await frame.locator("h1").click();
await page.keyboard.press("c");
await eventually("C pressed inside the page starts picking too", () => page.locator(".html-pick-bar").isVisible());
await page.keyboard.press("Escape");
await eventually("and Esc pressed there stops it", async () => !(await page.locator(".html-pick-bar").isVisible()));
await page.locator("#controls").click({ position: { x: 400, y: 6 } });
await inFrame(() => window.parent.postMessage({ dk: "doklin-comments", type: "key", key: "c" }, "*"));
await settle();
step("a key the page only says was pressed, while the keyboard is elsewhere, does nothing", !(await page.locator(".html-pick-bar").isVisible()));
await appKey("c");
await frame.locator("#tail").scrollIntoViewIfNeeded();
await frame.locator("#tail").click();
await poll(async () => (await page.locator(".comment-card.is-active").count()) === 1);
await page.keyboard.press("Escape");
await eventually("a draft left empty is not saved", async () => (await threadLines()).length === 2 && (await page.locator(".comment-card").count()) === 2);

/* ---------- The cards follow the page ---------- */

await inFrame(() => window.scrollTo(0, 0));
await settle();
{
  const margin = await page.locator(".html-comments-margin").boundingBox();
  const before = await page.locator(".comment-card").first().boundingBox();
  await page.mouse.move(margin.x + margin.width / 2, margin.y + margin.height - 60);
  await page.mouse.wheel(0, 240);
  await eventually("the wheel over the cards scrolls the page, and the cards move with it", async () => {
    const y = await inFrame(() => window.scrollY);
    const after = await page.locator(".comment-card").first().boundingBox();
    return y > 100 && near(before.y - after.y, y, 3);
  });
  await inFrame(() => window.scrollTo(0, 0));
  await settle();
}

/* ---------- Hidden is as the reader gets the page ---------- */

await page.evaluate(() => window.__setVisible(false));
await eventually("hidden: no column, nothing marked or painted, no marker, the page's full width", async () => {
  const [f, s] = [await frameBox(), await stageBox()];
  const count = await tinted();
  return near(f.width, s.width, 3) && (await page.locator(".html-comments-margin").count()) === 0 && !count && (await introPainted()) === introPlain && (await page.locator(".html-comment-marker").count()) === 0;
});
await page.screenshot({ path: `${SHOTS}/06-hidden.png` });
await appKey("Shift+C");
await eventually("⇧C shows them again, where they were", async () => {
  const f = await frameBox();
  const s = await stageBox();
  return near(f.width, s.width - 312, 3) && (await page.locator(".comment-card").count()) === 2 && (await page.locator(".html-comment-marker").count()) === 1 && (await introPainted()) !== introPlain;
});

/* ---------- Zoomed, the app's layers stay on what they are about ---------- */

// Where the page's parts are is asked of the browser from outside the frame,
// so the script's own arithmetic is not what it is checked against.
const partsLineUp = async () => {
  const marker = await page.locator(".html-comment-marker").boundingBox();
  const p = await linkPara.boundingBox();
  if (!near(marker.y + marker.height / 2, p.y, 4) || !near(marker.x + marker.width / 2, p.x + p.width, 14)) return false;
  await page.locator(".html-comment-marker").hover();
  const outline = await page.locator(".html-part-outline").boundingBox();
  await page.mouse.move(5, 5);
  return !!outline && near(outline.x, p.x - 4, 3) && near(outline.y, p.y - 4, 3) && near(outline.width, p.width + 8, 4) && near(outline.height, p.height + 8, 4);
};
{
  const before = await linkPara.boundingBox();
  await page.evaluate(() => window.__setZoom(1.5));
  await poll(async () => (await linkPara.boundingBox()).height > before.height * 1.3);
  await eventually("zoomed in: a part's marker and outline are still on the part", partsLineUp);
  // The browser scrolls the column itself to show something in a card (the
  // caret, a control the Tab key lands on). Zoomed, the cards run past the
  // column's foot, so here it can.
  const column = page.locator(".html-comments-margin");
  await poll(() => column.evaluate((el) => el.scrollHeight >= el.clientHeight + 40));
  await column.evaluate((el) => { el.scrollTop = 40; });
  await eventually("the column never scrolls by itself: the move is the page's, and the cards stay with their places", async () => {
    const own = await column.evaluate((el) => el.scrollTop);
    const y = await inFrame(() => window.scrollY);
    return own === 0 && near(y, 40, 1) && (await partsLineUp());
  });
  await inFrame(() => window.scrollTo(0, 0));
  await poll(async () => (await inFrame(() => window.scrollY)) === 0);
  await page.locator(".comment-card", { hasText: "This word?" }).click();
  await eventually("zoomed in: the card of a thread on words is level with their paragraph", async () => {
    const card = await page.locator(".comment-card.is-active").boundingBox();
    const intro = await frame.locator("#intro").boundingBox();
    return card.y >= intro.y - 10 && card.y <= intro.y + intro.height;
  });
  await page.screenshot({ path: `${SHOTS}/07-zoomed.png` });
  await frame.locator("h1").click();
  await poll(async () => (await page.locator(".comment-card.is-active").count()) === 0);
  await page.evaluate(() => window.__setZoom(1));
  await poll(async () => near((await linkPara.boundingBox()).height, before.height, 1));
  await eventually("and at its own size again, they are back with it", partsLineUp);
}

/* ---------- The page is written again ---------- */

await page.locator("#regen-keep").click();
await poll(async () => (await frame.locator("h1").textContent()).includes("(v2)"));
await eventually("words that are still there are found, though everything around them changed", async () => {
  const card = page.locator(".comment-card", { hasText: "This word?" });
  return (await card.count()) === 1 && (await card.locator(".comment-orphan-note").count()) === 0 && (await card.locator(".comment-on-note").count()) === 0;
});
await eventually("a part that is gone is said to be gone, at the top of the column, with what it was on", async () => {
  const card = page.locator(".comment-card", { hasText: "Which details?" });
  const note = await card.locator(".comment-orphan-note").textContent();
  const on = await card.locator(".comment-on-part").textContent();
  const first = await page.locator(".comment-card").first().textContent();
  return note.includes("no longer in the document") && on.includes("Read the full details online.") && first.includes("Which details?");
});
step("finding a thread again rewrites nothing: its anchor is as it was saved", (await threadLines()).every((t) => t.anchor.path.includes("main")));
await page.screenshot({ path: `${SHOTS}/07-regenerated.png` });

const lost = page.locator(".comment-card", { hasText: "Which details?" });
await lost.locator(".comment-entry").first().hover();
await lost.locator(".comment-entry-delete").first().click();
await eventually("deleting a thread removes its record", async () => !(await dump()).includes("Which details?"));

/* ---------- The shared cases: what this script finds in the page as drawn ---------- */

let n = 0;
for (const c of fixture.places) {
  const id = `case${(n += 1)}`;
  await page.evaluate(
    ([html, thread]) => window.__setCase(html, [thread]),
    [c.html, { id, anchor: c.anchor, comments: [{ author: "A", at: 1, body: "x" }] }],
  );
  let said = "nothing";
  try {
    said = await poll(() => page.evaluate((key) => window.__places[key]?.state, id), 10000);
  } catch {
    // left as "nothing"
  }
  step(`place: ${c.about}`, said === c.state, said === c.state ? "" : `${said}, not ${c.state}`);
}

/* ---------- Cards that open, and a thread at the page's end ---------- */

{
  const said = (n) => ["One", "Two", "Three", "Four", "Five", "Six"].slice(0, n).map((body, i) => ({ author: "A", at: i + 1, body }));
  const on = (id, text, n) => ({ id, anchor: { path: "", tag: "p", text, ids: [id] }, comments: said(n) });
  await page.evaluate(
    ([html, threads]) => window.__setCase(html, threads),
    [
      `<!doctype html><html><body style="margin:0"><p id="first" style="margin:0">The opening line.</p><p id="second" style="margin:0">The line after it.</p><div style="height:1400px"></div><p id="last" style="margin:0">The closing line.</p></body></html>`,
      [on("first", "The opening line.", 4), on("second", "The line after it.", 1), on("last", "The closing line.", 6)],
    ],
  );
  await poll(() => page.evaluate(() => ["first", "second", "last"].every((id) => window.__places[id]?.state === "found")), 10000);
  const card = (text) => page.locator(".comment-card", { hasText: text });

  // A card grows when it opens: the one under it is stacked by the height
  // it has now, not the one it had closed.
  await card("The opening line.").click();
  await eventually("a card that opens pushes the one under it down, never over it", async () => {
    const [open, next] = [await card("The opening line.").boundingBox(), await card("The line after it.").boundingBox()];
    return (await page.locator(".comment-card.is-active").textContent()).includes("Four") && next.y >= open.y + open.height + 8;
  });
  await frame.locator("body").click({ position: { x: 300, y: 300 } });
  await poll(async () => (await page.locator(".comment-card.is-active").count()) === 0);

  // Nothing scrolls past the page's end, so a card there is kept above it,
  // closed or open: its last reply and the box to answer in can be reached.
  const atEnd = async () => {
    await inFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const [box, f] = [await card("The closing line.").boundingBox(), await frameBox()];
    return !!box && box.y >= f.y && box.y + box.height <= f.y + f.height + 1;
  };
  await eventually("a card at the page's end sits whole above it", atEnd);
  await card("The closing line.").click();
  await eventually("and open, with every reply and the box to answer in, it still does", async () =>
    (await page.locator(".comment-card.is-active .comment-input").count()) === 1 && (await page.locator(".comment-card.is-active").textContent()).includes("Six") && (await atEnd()),
  );
  await page.screenshot({ path: `${SHOTS}/08-page-end.png` });
}

console.log("\nFinal thread dump:\n" + (await dump()));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
