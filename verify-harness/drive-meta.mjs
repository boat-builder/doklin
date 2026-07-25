// Drives the REAL App over meta.html's IPC stub through the entity-meta
// layout (src/metaFile.ts): lazy migration of an old-format document on
// open (inline thread bodies → meta records, legacy html sidecar folded),
// the workspace sweep migrating an UNOPENED document, expansion feeding the
// editor full CriticMarkup, a reply saving as a meta-only write (markdown
// byte-identical), reload persistence, orphan surfacing, and deletions
// updating both files.
import { chromium } from "playwright";

import { existsSync, mkdirSync } from "node:fs";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 8000, every = 100) {
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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/meta.html");

const fsGet = (p) => page.evaluate((path) => window.__fs.get(path), p);
const persistFs = () =>
  page.evaluate(() =>
    sessionStorage.setItem("harness-fs", JSON.stringify([...window.__fs])),
  );

// 1. Boot: the old-format document opens; the editor shows the thread
//    (expansion happened at the read boundary) with its body in the rail.
await poll(async () => (await page.locator(".ProseMirror").count()) >= 1);
await poll(async () => (await page.locator(".critic-anchor").count()) >= 1);
await poll(async () =>
  (await page.locator(".comment-card").first().textContent()).includes(
    "needs a stronger opening",
  ),
);
step("old-format doc opens: anchor highlighted, body in the rail", true);
await page.screenshot({ path: `${SHOTS}/meta-01-boot.png` });

// 2. Lazy migration normalized the OPEN document on disk: the markdown
//    keeps only the bare marker, the body moved to the entity meta, and the
//    legacy html sidecar's thread folded in — with the legacy file left in
//    place for old app versions (transition posture).
await poll(async () => {
  const md = await fsGet("/docs/notes.md");
  return md?.includes("{>>#m1meta<<}") && !md.includes("needs a stronger opening");
});
const meta1 = await poll(async () => {
  const m = await fsGet("/docs/notes.meta.jsonl");
  return m &&
    m.includes('"t":"mthread"') &&
    m.includes("m1meta") &&
    m.includes("needs a stronger opening") &&
    m.includes('"t":"hthread"') &&
    m.includes("legacy html note")
    ? m
    : null;
});
const legacyKept = (await fsGet("/docs/notes.html.comments.jsonl")) !== undefined;
step(
  "lazy migration: bare marker in md, body + folded legacy thread in meta",
  Boolean(meta1) && legacyKept,
  legacyKept ? "legacy sidecar left for old versions" : "legacy sidecar missing!",
);

// 3. The workspace sweep migrated the UNOPENED third.md the same way.
await poll(async () => {
  const md = await fsGet("/docs/third.md");
  const m = await fsGet("/docs/third.meta.jsonl");
  return (
    md?.includes("{>>#m3meta<<}") &&
    !md.includes("sweep me") &&
    m?.includes("sweep me")
  );
});
step("workspace sweep migrates unopened documents", true);

// 4. A reply typed in the rail is a body-only change: the meta gains the
//    entry while the markdown file stays byte-identical (no write at all).
const mdBeforeReply = await fsGet("/docs/notes.md");
await page.locator(".comment-card").first().click();
await page.locator(".comment-reply-composer textarea").click();
await page.keyboard.type("reply from harness");
await page.keyboard.press("Enter");
await poll(async () => {
  const m = await fsGet("/docs/notes.meta.jsonl");
  return m?.includes("reply from harness");
});
const mdAfterReply = await fsGet("/docs/notes.md");
step(
  "reply is a meta-only save — markdown byte-identical",
  mdAfterReply === mdBeforeReply,
);
await page.screenshot({ path: `${SHOTS}/meta-02-reply.png` });

// 5. Relaunch over the same disk: the hybrid layout expands back — thread
//    and reply render from marker + meta records.
await persistFs();
await page.reload();
await poll(async () => (await page.locator(".critic-anchor").count()) >= 1);
await poll(async () =>
  (await page.locator(".comments-rail").textContent()).includes("needs a stronger opening"),
);
// Replies collapse to a "1 reply" hint until the card is active.
await page.locator(".comment-card").first().click();
await poll(async () =>
  (await page.locator(".comments-rail").textContent()).includes("reply from harness"),
);
step("reload expands marker + meta back into the full thread", true);

// 6. A meta record whose marker is gone (external edit elsewhere) surfaces
//    as an orphan card — kept, labeled, never silently dropped.
await page.evaluate(() => {
  const p = "/docs/notes.meta.jsonl";
  const line =
    `{"t":"mthread","id":"orphmm1","comments":[{"author":"Ghost","at":1,"body":"orphan body"}]}`;
  window.__fs.set(p, window.__fs.get(p) + line + "\n");
  sessionStorage.setItem("harness-fs", JSON.stringify([...window.__fs]));
});
await page.reload();
const orphanCard = page.locator(".comment-card:has(.comment-orphan-note)");
await poll(async () => (await orphanCard.count()) === 1);
step(
  "marker-less meta record shows as an orphan card",
  (await orphanCard.textContent()).includes("orphan body") &&
    (await orphanCard.textContent()).includes("no longer in the document"),
);
await page.screenshot({ path: `${SHOTS}/meta-03-orphan.png` });

// 7. Deleting the orphan removes its record from the meta.
await orphanCard.click();
await orphanCard.locator('[title="Delete comment"]').click();
await poll(async () => {
  const m = await fsGet("/docs/notes.meta.jsonl");
  return m !== undefined && !m.includes("orphmm1");
});
step("orphan delete scrubs its meta record", true);

// 8. Deleting the real thread updates BOTH files: the marker leaves the
//    markdown, the record leaves the meta.
const realCard = page.locator(".comment-card:not(:has(.comment-orphan-note))");
await realCard.first().click();
await realCard.first().locator('[title="Delete comment"]').first().click();
await poll(async () => {
  const md = await fsGet("/docs/notes.md");
  const m = await fsGet("/docs/notes.meta.jsonl");
  return md !== undefined && !md.includes("{>>#m1meta") && m !== undefined && !m.includes("m1meta");
});
step("thread delete scrubs marker from md and record from meta", true);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
