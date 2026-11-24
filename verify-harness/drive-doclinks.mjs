// Drives links between documents in the editor (src/linkMark.ts,
// src/mentionMenu.ts) in Chromium, on two real editors of one workspace
// (doclinks.html): a note opened with link records shows each link where its
// file is now and writes what a save writes, with its records after it; a
// link that can't be opened is greyed and not followed by its path; a rename
// while the note is open relinks it, outside the undo history; the `@` list
// picks a document, says who can open one in a narrower section, and leaves
// typed text alone; and a copy carries the links' records to a paste into a
// note in another folder, while the clipboard's text holds none of them.
// Needs the repo-root vite dev server; `PORT` picks it (default 1420).
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 10000, every = 100) {
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
  return last;
}

const RUNNER_CHROMIUM = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(RUNNER_CHROMIUM) ? { executablePath: RUNNER_CHROMIUM } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const PORT = process.env.PORT ?? "1420";
await page.goto(`http://localhost:${PORT}/verify-harness/doclinks.html`);
await poll(() => page.evaluate(() => document.querySelectorAll(".milkdown .ProseMirror").length === 2));

const editor = (id) => `[data-note="${id}"] .ProseMirror`;
const linksOf = (id) =>
  page.$$eval(`${editor(id)} a`, (as) =>
    as.map((a) => ({ words: a.textContent, href: a.getAttribute("href"), closed: !!a.querySelector(".doc-link-closed") })),
  );
// What the note's editor last said, split into the note and its records.
const said = (id, which = "md") =>
  page.evaluate(
    ([id, which]) => {
      const list = window.__said[id][which];
      const last = list[list.length - 1] ?? "";
      const { md, records } = window.__split(last);
      return { md, records: Object.fromEntries(records.map((r) => [r.id, r.file])), raw: last };
    },
    [id, which],
  );

/* ---------- Opening a note ---------- */
{
  const links = await linksOf("q1");
  const shown = links.map((l) => `${l.words}→${l.href}${l.closed ? " (closed)" : ""}`);
  step(
    "each link with a record is shown where its file is now",
    JSON.stringify(shown) ===
      JSON.stringify([
        "launch-plan-v2→../GTM/launch-plan-v2.md",
        "the budget→../Money/budget.md",
        "board-plan-final→../../Restricted/Board/board-plan-final.md",
        "old-note→old-note.md (closed)",
        "notes→notes.md",
        "the web→https://example.com",
      ]),
    shown.join(", "),
  );
  const first = await said("q1");
  step(
    "what it hands back is what a save writes: current links, a narrower section's written back",
    first.md.includes("[launch-plan-v2](../GTM/launch-plan-v2.md)") &&
      first.md.includes("[the budget](../Money/budget.md)") &&
      first.md.includes("[board-plan](../../Restricted/Board/board-plan.md)") &&
      first.md.includes("[old-note](old-note.md)") &&
      first.md.includes("[notes](notes.md)") &&
      !first.md.includes("doklin-links"),
    first.md.replace(/\n/g, "⏎").slice(0, 300),
  );
  step(
    "and the records its sidecar is to hold, one by its path into Library",
    JSON.stringify(first.records) ===
      JSON.stringify({
        "../GTM/launch-plan-v2.md": "f-launch",
        "../Money/budget.md": "f-budget",
        "../../Restricted/Board/board-plan.md": "f-board",
        "old-note.md": "f-gone",
        "notes.md": "f-notes",
      }),
    JSON.stringify(first.records),
  );
}

/* ---------- Following ---------- */
{
  await page.click(`${editor("q1")} a[href="old-note.md"]`);
  await page.click(`${editor("q1")} a[href="../GTM/launch-plan-v2.md"]`);
  const opened = await page.evaluate(() => window.__said.q1.opened);
  step(
    "a link that can't be opened is handed on as closed; one that can, by where it is now",
    JSON.stringify(opened) ===
      JSON.stringify([
        { href: "old-note.md", closed: true },
        { href: "../GTM/launch-plan-v2.md", closed: false },
      ]),
    JSON.stringify(opened),
  );
}

/* ---------- A rename while the note is open ---------- */
{
  const before = await page.evaluate(() => window.__said.q1.md.length);
  await page.evaluate(() => {
    const docs = [
      { path: "Library/GTM/launch-final.md", fileId: "f-launch", section: null },
      { path: "Library/Money/budget.md", fileId: "f-budget", section: null },
      { path: "Restricted/Board/board-plan-final.md", fileId: "f-board", section: "s-board" },
      { path: "Library/Roadmap/notes.md", fileId: "f-notes", section: null },
      { path: "Library/Roadmap/q1.md", fileId: "f-q1", section: null },
      { path: "Library/Deep/Down/other.md", fileId: "f-other", section: null },
      { path: "Private/todo.md", fileId: "f-todo", section: "p-me" },
    ];
    window.__setDocs(docs);
  });
  await poll(() => page.evaluate(() => window.__said.q1.relinked.length === 1));
  const relinked = await said("q1", "relinked");
  const links = await linksOf("q1");
  const after = await page.evaluate(() => window.__said.q1.md.length);
  step(
    "a rename shows the link's new name and writes it, said as a relink",
    links[0].words === "launch-final" &&
      links[0].href === "../GTM/launch-final.md" &&
      relinked.md.includes("[launch-final](../GTM/launch-final.md)") &&
      relinked.records["../GTM/launch-final.md"] === "f-launch",
    `${links[0].words} ${links[0].href}`,
  );
  step("the text as it stood is said first", after === before + 1, `${before} → ${after}`);
  const others = await page.evaluate(() => window.__said.other.relinked.length);
  step("a note with no link to it is not relinked", others === 0);

  // Undo after an edit takes the edit back, not the new name.
  await page.click(`${editor("q1")} p:last-of-type`);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  const undone = await linksOf("q1");
  step("undo never brings the old name back", undone[0].words === "launch-final", undone[0].words);
}

/* ---------- The @ list ---------- */
const menu = () =>
  page.evaluate(() => {
    const el = document.querySelector(".doc-mention-menu");
    if (!el || el.hidden) return null;
    return [...el.querySelectorAll(".row")].map((r) => ({
      name: r.querySelector(".name")?.textContent,
      section: r.querySelector(".section")?.textContent ?? null,
      who: r.querySelector(".who")?.textContent ?? null,
      selected: r.classList.contains("selected"),
    }));
  });
{
  await page.click(`${editor("q1")} p:last-of-type`);
  await page.keyboard.press("End");
  await page.keyboard.type(" @lau");
  const rows = await poll(menu);
  step("typing @ and a name lists the documents that match", rows?.[0]?.name === "launch-final", JSON.stringify(rows));
  await page.keyboard.press("Enter");
  await poll(async () => !(await menu()));
  const last = await page.$eval(`${editor("q1")} p:last-of-type`, (p) => p.textContent);
  const links = await linksOf("q1");
  const picked = links.find((l, i) => i > 4 && l.words === "launch-final");
  step(
    "Enter puts a named link in place of the @ and what followed it",
    last === "Last line launch-final " && picked?.href === "../GTM/launch-final.md",
    JSON.stringify(last),
  );

  await page.keyboard.type("@board");
  const board = await poll(menu);
  step(
    "a document in a narrower section says which and who can open it",
    board?.[0]?.name === "board-plan-final" &&
      board[0].section === "Board" &&
      board[0].who === "Only the people in “Board” can open it.",
    JSON.stringify(board),
  );
  await page.keyboard.press("Tab");
  await poll(async () => !(await menu()));
  const notices = await page.evaluate(() => window.__notices);
  step(
    "picking it tells the author what everyone who reads the note will see",
    notices.length === 1 &&
      notices[0] ===
        "Everyone who can read this note can see “board-plan-final” and its folder “Board”, but only the people in “Board” can open it.",
    JSON.stringify(notices),
  );
  // Report now: the editor hands its markdown on after a short pause.
  await page.waitForTimeout(400);
  const now = await said("q1");
  step(
    "a picked link is written where its file is now, with its record, even in a narrower section",
    now.md.includes("[launch-final](../GTM/launch-final.md) [board-plan-final](../../Restricted/Board/board-plan-final.md)") &&
      now.records["../../Restricted/Board/board-plan-final.md"] === "f-board" &&
      now.records["../../Restricted/Board/board-plan.md"] === "f-board",
    now.md.split("\n").filter((l) => l.startsWith("Last")).join(" "),
  );

  await page.keyboard.type("@zzz ");
  await page.waitForTimeout(150);
  step("a space with nothing matching leaves the text as typed", (await menu()) === null);
  await page.keyboard.type("@lau");
  await poll(menu);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const escaped = await page.$eval(`${editor("q1")} p:last-of-type`, (p) => p.textContent);
  step("Esc closes it and leaves the text", (await menu()) === null && escaped.endsWith("@zzz @lau"), JSON.stringify(escaped));
  await page.keyboard.type(" mail a@lau");
  await page.waitForTimeout(150);
  step("an @ inside a word opens nothing", (await menu()) === null);
}

/* ---------- Copy, and paste into a note in another folder ---------- */
{
  // Select the paragraph with the two links.
  await page.evaluate((sel) => {
    const p = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.startsWith("See "));
    const range = document.createRange();
    range.selectNodeContents(p);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, editor("q1"));
  await page.waitForTimeout(150);
  const copied = await page.evaluate((sel) => {
    const data = new DataTransfer();
    document.querySelector(sel).dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    window.__copied = data;
    return { text: data.getData("text/plain"), links: data.getData("application/x-doklin-links") };
  }, editor("q1"));
  const carried = copied.links ? JSON.parse(copied.links) : null;
  step(
    "a copy's text is plain markdown, with no records in it",
    copied.text.includes("[launch-final](../GTM/launch-final.md)") && !copied.text.includes("doklin-links"),
    JSON.stringify(copied.text),
  );
  step(
    "and its links' records go beside it, with the note they came from",
    carried?.from === "Library/Roadmap/q1.md" && carried.records.some((r) => r.file === "f-launch"),
    copied.links,
  );

  await page.click(`${editor("other")} p:last-of-type`);
  await page.keyboard.press("End");
  await page.evaluate((sel) => {
    document.querySelector(sel).dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: window.__copied, bubbles: true, cancelable: true }),
    );
  }, editor("other"));
  const pasted = await linksOf("other");
  step(
    "pasted into a note in another folder, each link still leads to its file",
    pasted.some((l) => l.words === "launch-final" && l.href === "../../GTM/launch-final.md") &&
      pasted.some((l) => l.words === "the budget" && l.href === "../../Money/budget.md"),
    JSON.stringify(pasted),
  );
  await page.waitForTimeout(400);
  const other = await said("other");
  step(
    "and keeps its record there",
    other.records["../../GTM/launch-final.md"] === "f-launch" && other.records["../../Money/budget.md"] === "f-budget",
    JSON.stringify(other.records),
  );
}

/* ---------- The iPhone's editor page, driven as the app drives it ---------- */
{
  const phone = await browser.newPage({ viewport: { width: 390, height: 760 } });
  phone.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
  await phone.addInitScript(() => {
    window.doklinMessages = [];
  });
  await phone.goto(`http://localhost:${PORT}/src/ios-editor/index.html`);
  await poll(() => phone.evaluate(() => window.doklinMessages.some((m) => m.kind === "ready")));
  const meta = [
    '{"doklin":"meta","v":1}',
    '{"t":"link","id":"../GTM/launch-plan.md","file":"f-launch"}',
    '{"t":"link","id":"gone.md","file":"f-gone"}',
  ].join("\n");
  await phone.evaluate(
    (meta) =>
      window.doklin.load({
        markdown: "# Phone\n\nSee [launch-plan](../GTM/launch-plan.md) and [gone](gone.md).\n",
        base: "/doc/Library/Roadmap/",
        meta,
        note: "Library/Roadmap/phone.md",
        documents: [
          { path: "Library/GTM/launch-plan-v2.md", fileId: "f-launch", section: null },
          { path: "Library/Roadmap/phone.md", fileId: "f-phone", section: null },
        ],
        recent: [],
        workspace: "Acme",
        block: null,
        prefix: null,
      }),
    meta,
  );
  const loaded = await phone.evaluate(() => window.doklinMessages.find((m) => m.kind === "loaded"));
  step(
    "the iPhone's editor hands back the note as a save writes it, with its records",
    loaded?.markdown === "# Phone\n\nSee [launch-plan-v2](../GTM/launch-plan-v2.md) and [gone](gone.md).\n" &&
      JSON.stringify(loaded.links) === JSON.stringify([["../GTM/launch-plan-v2.md", "f-launch"], ["gone.md", "f-gone"]]),
    JSON.stringify(loaded),
  );
  const closed = await phone.$$eval("#editor a .doc-link-closed", (els) => els.map((e) => e.textContent));
  step("and greys the link it can't open", JSON.stringify(closed) === JSON.stringify(["gone"]), JSON.stringify(closed));
  await phone.evaluate(() =>
    window.doklin.documents([
      { path: "Library/GTM/launch.md", fileId: "f-launch", section: null },
      { path: "Library/Roadmap/phone.md", fileId: "f-phone", section: null },
    ]),
  );
  const relinked = await poll(() => phone.evaluate(() => window.doklinMessages.find((m) => m.kind === "relinked")));
  const now = await phone.evaluate(() => window.doklin.markdown());
  step(
    "a rename while it is open is said as a relink, and is what a write holds",
    relinked?.markdown.includes("[launch](../GTM/launch.md)") &&
      now?.markdown === relinked.markdown &&
      JSON.stringify(now.links) === JSON.stringify(relinked.links),
    JSON.stringify(relinked),
  );
  await phone.close();
}

step("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
