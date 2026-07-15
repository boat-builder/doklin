// Drives the PUBLIC web experience end to end — the app shell that comment/
// edit sessions get (the desktop's own editor + comment rail, in a browser),
// role gating, and the desktop⇄web comment flow — against the real worker
// served by serve-worker.mjs. Run:
//
//   node scripts/build-web.mjs               # once, or after editor changes
//   node verify-harness/serve-worker.mjs &
//   node verify-harness/drive-web.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const BASE = "http://localhost:8787";
const OWNER = "owner-secret";
const SHOTS = new URL("./shots-web/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 8000, every = 120) {
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

const api = async (path, body, method = body === undefined ? "GET" : "PUT") => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/* ----- seed a gated pair page through the owner API ----- */

// The pool and the page survive re-runs by design (and htmlStale is sticky
// while the rendition bytes don't change) — drop the page entirely for a
// truly repeatable drive.
await api("/api/pages/brief-web", undefined, "DELETE");
await api("/api/pages/brief-web", {
  title: "Web Brief",
  markdown: "# Web Brief\n\nThe opening line of the brief.\n\nThe closing line.",
  html: `<!doctype html><html><head><style>
    body { font-family: Georgia, serif; margin: 0; background: #fff; }
    main { max-width: 620px; margin: 0 auto; padding: 32px 24px; }
  </style></head><body><main>
  <h1>Web Brief</h1>
  <p id="opening">The opening line of the brief.</p>
  <div class="callout"><p>A callout block with a <button id="cta" onclick="this.textContent='pressed'">Press me</button>.</p></div>
  <p id="closing">The closing line.</p>
  </main></body></html>`,
});
for (const [label, code, role] of [
  ["Reviewer", "web-comment-code", "comment"],
  ["Editor", "web-edit-code", "edit"],
  ["Reader", "web-view-code", "view"],
]) {
  await api("/api/pages/brief-web/access/codes", { label, code, role }, "POST");
}

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);

async function unlockedPage(code, viewport = { width: 1360, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto(`${BASE}/brief-web`);
  await poll(async () => page.locator("#gate-code").isVisible());
  await page.fill("#gate-code", code);
  await page.press("#gate-code", "Enter");
  return page;
}

// Wait for the rail's focused textarea (focus lands asynchronously after the
// card mounts), then type + commit.
async function typeIntoFocusedCard(page, text) {
  await poll(async () =>
    page.evaluate(() => document.activeElement?.classList.contains("comment-input")),
  );
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/* ================= Reviewer (comment role) ================= */

const rev = await unlockedPage("web-comment-code");

// 1. Unlock lands on the app shell's HTML view (pair pages lead with the
//    rendition), with the desktop chrome: topbar, MD/HTML toggle, rail host.
await poll(async () => (await rev.locator(".web-topbar").count()) === 1);
await poll(async () => (await rev.locator(".editor-wrap.is-html-view").count()) === 1);
step(
  "comment role gets the app shell html view (topbar + MD/HTML toggle)",
  (await rev.locator(".view-toggle-seg").count()) === 2,
);

// 2. The rendition renders in the sandboxed frame with the DESKTOP bridge
//    (dk-bubble — the same instrumentHtml the app injects).
const frame = rev.frameLocator("iframe.html-preview");
await poll(async () => (await frame.locator("#opening").count()) === 1);
await poll(async () => (await frame.locator("#dk-bubble").count()) === 1);
step("rendition carries the desktop's own comment bridge", true);
await rev.screenshot({ path: `${SHOTS}/01-html-view.png` });

// 3. Enter comment mode (the floating button), hover → bubble → click → a
//    floating card opens at the element, focused; type + Enter.
await rev.locator(".html-comment-btn").click();
await poll(async () => frame.locator("#dk-scrim.dk-on").isVisible());
const opening = frame.locator("#opening");
await opening.hover();
await poll(async () => {
  const t = await opening.boundingBox();
  const b = await frame.locator("#dk-bubble.dk-on").boundingBox();
  return !!t && !!b && Math.abs(b.y - t.y - 4) < 8;
});
await frame.locator("#dk-bubble").click();
await poll(async () => (await rev.locator(".html-comment-pop .comment-card").count()) === 1);
await typeIntoFocusedCard(rev, "Open with the metric instead.");
await poll(async () =>
  (await rev.locator(".comment-card").textContent()).includes("Open with the metric instead."),
);
step("comment mode + bubble pick opens a floating card at the element", true);
await rev.screenshot({ path: `${SHOTS}/02-html-comment.png` });

// 4. The thread lands in the worker's pool (debounced push), stamped with
//    the session's code.
const pooled = await poll(async () => {
  const { json } = await api("/api/pages/brief-web/comments");
  return json?.threads?.length === 1 ? json : null;
});
const pooledEntry = pooled.threads[0].comments[0];
step(
  "thread reaches the worker pool with provenance",
  pooledEntry.body === "Open with the metric instead." &&
    pooledEntry.label === "Reviewer" &&
    /^e-/.test(pooledEntry.eid ?? ""),
  JSON.stringify(pooledEntry),
);

// 5. The commented element is highlighted; deselecting collapses the card
//    to a pin, clicking the element reopens it.
await poll(async () => (await frame.locator("#opening[data-dk-t]").count()) === 1);
await frame.locator("h1").click(); // a non-commented spot: card closes
await poll(async () => (await rev.locator(".html-comment-pop").count()) === 0);
await poll(async () => (await rev.locator(".html-comment-pin").count()) === 1);
await frame.locator("#opening").click();
await poll(async () => (await rev.locator(".html-comment-pop .comment-card").count()) === 1);
step("element highlight, pin collapse, and click-to-activate work", true);

// 6. Reply on the card (threads, not a flat list).
await rev.locator(".comment-reply-composer .comment-input").first().click();
await rev.keyboard.type("Agreed — swap it in.");
await rev.keyboard.press("Enter");
await poll(async () => (await rev.locator(".comment-entry.is-reply").count()) === 1);
const replied = await poll(async () => {
  const { json } = await api("/api/pages/brief-web/comments");
  return json?.threads?.[0]?.comments?.length === 2 ? json : null;
});
step(
  "replies thread under the opener and sync to the pool",
  replied.threads[0].comments[1].body === "Agreed — swap it in.",
);

// 7. The rendition's own interactivity is untouched (and clicking it, a
//    non-commented spot, closes the open card back to a pin — no new
//    thread).
await frame.locator("#cta").click();
await poll(async () => (await rev.locator(".html-comment-pop").count()) === 0);
step(
  "page's own button still works; its click creates no comment",
  (await frame.locator("#cta").textContent()) === "pressed" &&
    (await rev.locator(".html-comment-pin").count()) === 1,
);

// 8. "Done" restores the pristine page; the button re-enters with the pin.
await rev.locator(".html-comment-btn").click();
const hidden = await poll(
  async () =>
    (await rev.locator(".html-comment-pin").count()) === 0 &&
    !(await frame.locator("#dk-scrim.dk-on").isVisible()),
);
await rev.locator(".html-comment-btn").click();
await poll(async () => (await rev.locator(".html-comment-pin").count()) === 1);
step("Comment button hides/shows the whole layer", hidden === true);

// 9. MD view: the real Milkdown editor, read-only for the comment role.
await rev.locator(".view-toggle-seg", { hasText: "MD" }).click();
await poll(
  async () => (await rev.locator('.ProseMirror[contenteditable="false"]').count()) === 1,
);
step("MD view renders the real editor, read-only for the comment role", true);

// 10. Select text → floating Comment bubble → a Notion-style TEXT thread.
await poll(async () => (await rev.locator(".ProseMirror p").count()) >= 1);
await rev.evaluate(() => {
  const p = [...document.querySelectorAll(".ProseMirror p")].find((el) =>
    el.textContent?.includes("closing line"),
  );
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await poll(async () => rev.locator(".web-selection-bubble").isVisible());
await rev.locator(".web-selection-bubble").click();
await poll(async () => (await rev.locator(".comment-card").count()) === 1);
await typeIntoFocusedCard(rev, "End on the call to action?");
await poll(async () => (await rev.locator(".critic-anchor").count()) >= 1);
await poll(async () =>
  (await rev.locator(".comment-card").textContent()).includes("End on the call to action?"),
);
step("selection bubble creates a Notion-style text comment in the rail", true);
await rev.screenshot({ path: `${SHOTS}/03-md-comment.png` });

// 11. The comment IS the document: the save carries CriticMarkup and the
//     revision bumps, without changing the readable content.
const savedMd = await poll(async () => {
  const { json } = await api("/api/pages/brief-web/content");
  return json?.markdown?.includes("End on the call to action?") ? json : null;
});
step(
  "comment-role save lands as CriticMarkup in the stored markdown",
  savedMd.markdown.includes("{==") && savedMd.markdown.includes("{>>#"),
);

/* ================= Reader (view role) ================= */

const reader = await unlockedPage("web-view-code");
await poll(async () => (await reader.locator("main.doc, iframe.raw-frame").count()) === 1);
const readerHtml = await reader.content();
step(
  "view role keeps the classic read-only page — no shell, no comment text",
  !readerHtml.includes("dk-boot") &&
    !readerHtml.includes("End on the call to action?") &&
    !readerHtml.includes("Open with the metric instead."),
);
await reader.context().close();

/* ================= Editor (edit role) ================= */

const ed = await unlockedPage("web-edit-code");
await ed.locator(".view-toggle-seg", { hasText: "MD" }).click();
await poll(async () => (await ed.locator('.ProseMirror[contenteditable="true"]').count()) === 1);
step("edit role gets the editable Milkdown editor", true);

// 12. The web editor shows the reviewer's thread — one shared truth.
await poll(async () => (await ed.locator(".critic-anchor").count()) >= 1);
await poll(async () => (await ed.locator(".comment-card").count()) >= 1);
step(
  "the reviewer's markdown thread is live in the edit session's rail",
  (await ed.locator(".comments-rail").textContent()).includes("End on the call to action?"),
);

// 13. Typing autosaves through the rev-guarded endpoint; comments survive.
await ed.locator(".ProseMirror p").first().click();
await ed.keyboard.press("End");
await ed.keyboard.type(" Now edited on the web.");
const afterEdit = await poll(async () => {
  const { json } = await api("/api/pages/brief-web/content");
  return json?.markdown?.includes("Now edited on the web.") ? json : null;
});
step(
  "edit-role typing autosaves; the comment thread rides the edit",
  afterEdit.markdown.includes("End on the call to action?") &&
    afterEdit.webEdit?.by === "Editor",
);
await ed.screenshot({ path: `${SHOTS}/04-md-edit.png` });
await ed.context().close();

// 14. A desktop-side thread pushed into the pool (what the app's sidecar
//     sync does) shows up in the reviewer's rail on reload.
const poolNow = await api("/api/pages/brief-web/comments");
await api("/api/pages/brief-web/comments", {
  baseRev: poolNow.json.rev,
  threads: [
    ...poolNow.json.threads,
    {
      id: "t9desk",
      anchor: {
        path: "main:nth-of-type(1) > p:nth-of-type(2)",
        tag: "p",
        text: "The closing line.",
      },
      comments: [{ author: "Sherin's Mac", at: Date.now(), body: "Desktop says hi." }],
    },
  ],
});
// (?v=html explicitly: the edit above staled the rendition, so the plain
// URL now leads with the markdown — same rule as v8.)
await rev.goto(`${BASE}/brief-web?v=html`);
const frame2 = rev.frameLocator("iframe.html-preview");
await poll(async () => rev.locator(".html-comment-btn").isVisible());
await rev.locator(".html-comment-btn").click(); // back into comment mode
await poll(async () => (await rev.locator(".html-comment-pin").count()) === 2);
await frame2.locator("#closing").click(); // the desktop thread's element
await poll(async () =>
  (await rev.locator(".html-comment-pop .comment-card").textContent()).includes(
    "Desktop says hi.",
  ),
);
step("a desktop-pushed thread appears pinned at its element on the web", true);
await rev.screenshot({ path: `${SHOTS}/05-desktop-thread.png` });

// 15. Someone else's comment is not click-editable: the reviewer clicking
//     the desktop author's body gets the reply composer (no entry editor,
//     no Edit pencil on a foreign entry).
const deskCard = rev.locator(".html-comment-pop .comment-card");
await deskCard.locator(".comment-entry-body").first().click();
await poll(
  async () => (await deskCard.locator(".comment-reply-composer .comment-input").count()) === 1,
);
const foreignState = await rev.evaluate(() => ({
  entryEditors: document.querySelectorAll(".comment-entry .comment-input").length,
  inComposer: document.activeElement?.closest(".comment-reply-composer") != null,
}));
step(
  "a foreign comment isn't click-editable — the click lands in the reply box",
  foreignState.entryEditors === 0 &&
    foreignState.inComposer &&
    (await deskCard.locator(".comment-entry-edit").count()) === 0,
);

// 16. The reviewer's own entry still edits — through the explicit pencil —
//     and the change syncs to the pool.
await frame2.locator("#opening").click(); // switch the card to the reviewer's own thread
const ownCard = rev.locator(".html-comment-pop .comment-card");
await poll(async () =>
  (await ownCard.textContent()).includes("Open with the metric instead."),
);
await poll(async () => (await ownCard.locator(".comment-entry-edit").count()) > 0);
await ownCard.locator(".comment-entry-edit").first().click();
await poll(async () => (await ownCard.locator(".comment-entry .comment-input").count()) === 1);
await rev.keyboard.type(" (edited)");
await rev.keyboard.press("Enter");
const editedPool = await poll(async () => {
  const { json } = await api("/api/pages/brief-web/comments");
  const t = json?.threads?.find((x) =>
    x.comments[0]?.body?.startsWith("Open with the metric"),
  );
  return t?.comments[0]?.body?.endsWith("(edited)") ? json : null;
});
step("own entries edit via the explicit pencil and sync to the pool", !!editedPool);
await rev.context().close();

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed`);
await browser.close();
process.exit(results.some((r) => !r.ok) ? 1 : 0);
