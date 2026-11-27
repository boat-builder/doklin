// Drives the REAL App over tags.html (a pretend connected workspace held in
// memory) through a note's tags: the chips right below the title, set from
// their menus, and the workspace's tags they come from, in Settings.
//
// The walk: a note's tags show in the list's order and spelling, the rest of
// its block in a closed disclosure; a chip's menu sets a value in place
// (nothing else in the file changes) and a tag set while typing lands with
// the typing; *+ Tag* on a note with none adds a block, and removing the
// tag gives back the bytes; a value the list doesn't have is marked; *New
// tag…* changes the list and the note; a value renamed in *Edit* rewrites
// every note that has it, the open one through its save path, CRLF kept,
// with both values listed meanwhile; a tag renamed keeps its place in the
// list; `name:value` in search finds notes by tag; Settings' *Tags* lists
// the tags and what their values mean, makes and changes one; a deleted
// tag's lines stay as plain frontmatter; a change from elsewhere to the
// open note's block shows without a reload; an html document has no tags;
// and a folder that isn't connected has none.
//
// `PORT` picks the vite server (default 1420).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const PORT = process.env.PORT ?? "1420";

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 50) {
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

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGEERROR:", e.message);
});

const ROOT = "/Team notes/Library";
const pane = () => page.locator(".editor-pane.is-focused");
const editor = () => pane().locator(".ProseMirror");
const chips = () => pane().locator(".doc-tags-row .tag-chip");
const chipTexts = () => chips().evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
const chip = (name) => pane().locator(`[data-testid="tag-chip-${name}"]`);
const menu = () => page.locator(".tag-menu");
const menuItem = (label) => menu().getByRole("menuitem", { name: label, exact: true }).or(menu().getByRole("menuitemradio", { name: label, exact: true }));
const activeLabel = () => page.locator(".tab.is-active .tab-label").innerText();
const row = (path) => page.locator(`[data-tree-path="${path}"]`);
const text = (path) => page.evaluate((p) => window.__tags.doc(p)?.text ?? null, path);
const tagsNow = () => page.evaluate(() => window.__tags.tags());
const tagCalls = () => page.evaluate(() => window.__tags.tagCalls());
const page_ = () => page.locator('[data-testid="tags-settings"]');
const openTagsPage = async () => {
  await page.locator(".settings-fab").click();
  await page.locator('[data-testid="settings-tags"]').click();
  await poll(async () => (await page_().count()) === 1);
};
const open = async (path, label) => {
  await row(path).click();
  await poll(async () => (await activeLabel()) === label);
  await poll(async () => (await pane().locator(".doc-title textarea").inputValue()) === label);
};

await page.goto(`http://localhost:${PORT}/verify-harness/tags.html`);
await poll(async () => (await activeLabel()) === "Launch plan");
await poll(async () => (await chips().count()) === 2);

/* 1 — the note's tags, right below its title, in the list's order and
       spelling; the rest of its block in a closed disclosure. */
{
  const order = await pane().locator(".editor-wrap").evaluate((wrap) =>
    [...wrap.children]
      .map((el) =>
        el.classList.contains("doc-title")
          ? "title"
          : el.classList.contains("doc-tags")
            ? "tags"
            : el.hasAttribute("data-milkdown-root")
              ? "editor"
              : null,
      )
      .filter(Boolean),
  );
  const disclosure = pane().locator(".doc-frontmatter-more");
  step(
    "a note's tags show right below its title, in the list's order and spelling, the rest of the block in a closed disclosure",
    JSON.stringify(await chipTexts()) === JSON.stringify(["Status Doing", "Priority p1"]) &&
      JSON.stringify(order) === JSON.stringify(["title", "tags", "editor"]) &&
      (await disclosure.count()) === 1 &&
      !(await disclosure.evaluate((el) => el.open)) &&
      (await disclosure.locator("pre").textContent()).includes("owner: ada") &&
      !(await editor().innerText()).includes("owner"),
    JSON.stringify({ chips: await chipTexts(), order }),
  );
  await settle(250); // past the menus' and dialogs' fade-in
  await page.screenshot({ path: SHOTS + "tags-01-row.png" });
}

/* 2 — a chip's menu: its values with the current one checked, Remove, and
       Edit. Choosing one rewrites that line in place and nothing else. */
{
  await chip("Status").click();
  await poll(async () => (await menu().count()) === 1);
  const items = await menu().locator("button").evaluateAll((els) => els.map((el) => `${el.innerText.trim()}${el.getAttribute("aria-checked") === "true" ? "✓" : ""}`));
  await settle(250); // past the menus' and dialogs' fade-in
  await page.screenshot({ path: SHOTS + "tags-02-menu.png" });
  await menuItem("Done").click();
  await poll(async () => (await text(`${ROOT}/Launch plan.md`)).includes("Status: Done"));
  step(
    "a chip's menu lists the values with the current one checked; choosing one rewrites that line in place and nothing else",
    JSON.stringify(items) === JSON.stringify(["Todo", "Doing✓", "Done", "Remove", "Edit Status…"]) &&
      (await text(`${ROOT}/Launch plan.md`)) ===
        "---\nStatus: Done\npriority: p1\nowner: ada\n---\n## Goals\n\nShip the launch to ten teams by the end of the quarter.\n" &&
      JSON.stringify(await chipTexts()) === JSON.stringify(["Status Done", "Priority p1"]) &&
      (await menu().count()) === 0,
    JSON.stringify(items),
  );
}

/* 3 — a tag set while typing lands with what was typed, and no conflict. */
{
  await editor().locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Then twenty.");
  await chip("Priority").click();
  await menuItem("p2").click();
  await poll(async () => {
    const t = await text(`${ROOT}/Launch plan.md`);
    return t.includes("priority: p2") === false && t.includes("Priority: p2") && t.includes("Then twenty.");
  });
  await settle(900);
  step(
    "a tag set while typing lands with what was typed, and nothing conflicts",
    (await text(`${ROOT}/Launch plan.md`)).startsWith("---\nStatus: Done\nPriority: p2\nowner: ada\n---\n") &&
      (await text(`${ROOT}/Launch plan.md`)).includes("quarter. Then twenty.") &&
      (await page.locator(".conflict-banner").count()) === 0,
  );
}

/* 4 — a note with no tags: *Add tag* while the pointer is over its top; its
       menu offers the tags and their values; Remove gives back the bytes. */
{
  // As the note stands once open: opening a note can already save the
  // editor's form of it (a `-` list as `*`), as it does without tags.
  await open(`${ROOT}/Ideas.md`, "Ideas");
  await settle(1500);
  const before = await text(`${ROOT}/Ideas.md`);
  const add = pane().locator('[data-testid="tag-add"]');
  await page.mouse.move(5, 790);
  await settle(250);
  const hidden = await add.evaluate((el) => getComputedStyle(el).opacity);
  await pane().locator(".doc-title").hover();
  await settle(250);
  const shown = await add.evaluate((el) => getComputedStyle(el).opacity);
  await add.click();
  const level1 = await menu().locator("button").evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  await menu().locator("button", { hasText: "Status" }).click();
  await poll(async () => (await menu().locator("button").first().innerText()).includes("Status"));
  await menuItem("Todo").click();
  await poll(async () => (await text(`${ROOT}/Ideas.md`)) === `---\nStatus: Todo\n---\n${before}`);
  const chipAfter = JSON.stringify(await chipTexts());
  await chip("Status").click();
  await menuItem("Remove").click();
  await poll(async () => (await text(`${ROOT}/Ideas.md`)) === before);
  step(
    "a note with no tags shows Add tag over its top; the menu offers the tags and their values; Remove gives back the bytes",
    hidden === "0" &&
      shown === "1" &&
      JSON.stringify(level1) === JSON.stringify(["Status ›", "Priority ›", "New tag…"]) &&
      chipAfter === JSON.stringify(["Status Todo"]) &&
      (await chips().count()) === 0,
    JSON.stringify({ hidden, shown, level1, chipAfter }),
  );
}

/* 5 — a value the list doesn't have: kept, marked, and said. */
{
  await open(`${ROOT}/Old.md`, "Old");
  await chip("Status").click();
  const first = menu().locator("button").first();
  step(
    "a value the list doesn't have shows marked, with why, and its menu shows it checked",
    (await chip("Status").getAttribute("class")).includes("is-unknown") &&
      (await chip("Status").getAttribute("title")) === "Blocked isn't one of Status's values." &&
      (await first.innerText()).startsWith("Blocked") &&
      (await first.getAttribute("aria-checked")) === "true" &&
      (await first.isDisabled()),
  );
  await page.keyboard.press("Escape");
  await poll(async () => (await menu().count()) === 0);
}

/* 6 — *New tag…* from a note: a name already taken is said; the list gets
       the tag and the note the value picked. */
{
  await open(`${ROOT}/Ideas.md`, "Ideas");
  await pane().locator(".doc-title").hover();
  await pane().locator('[data-testid="tag-add"]').click();
  await menuItem("New tag…").click();
  const dialog = page.locator('[data-testid="tag-new-dialog"]');
  await dialog.locator('[data-testid="tag-new-name"]').fill("status");
  await dialog.locator('[data-testid="tag-new-values"]').fill("A\nB");
  await dialog.locator('[data-testid="tag-new-create"]').click();
  const taken = await dialog.locator(".modal-error").innerText();
  await dialog.locator('[data-testid="tag-new-name"]').fill("Area");
  await dialog.locator('[data-testid="tag-new-values"]').fill("Web\niPhone\n");
  await dialog.locator('[data-testid="tag-new-desc"]').fill("  Which part of the product.  ");
  await dialog.locator('[data-testid="tag-new-gets"]').selectOption("iPhone");
  await page.screenshot({ path: SHOTS + "tags-03-new.png" });
  await dialog.locator('[data-testid="tag-new-create"]').click();
  await poll(async () => (await dialog.count()) === 0);
  const list = await tagsNow();
  step(
    "New tag says a taken name, then puts the tag at the end of the list, what its values mean trimmed, and gives the note the value picked",
    taken === "There's already a tag called Status." &&
      JSON.stringify(list.map((d) => d.name)) === JSON.stringify(["Status", "Priority", "Area"]) &&
      JSON.stringify(list[2]) === JSON.stringify({ name: "Area", values: ["Web", "iPhone"], desc: "Which part of the product." }) &&
      (await text(`${ROOT}/Ideas.md`)).startsWith("---\nArea: iPhone\n---\n") &&
      JSON.stringify(await chipTexts()) === JSON.stringify(["Area iPhone"]),
    `${taken} ${JSON.stringify(list)}`,
  );
}

/* 7 — a value renamed in Edit: the list, then every note that has it, the
       open one through its save path; a note's own line endings kept. */
{
  await open(`${ROOT}/Roadmap.md`, "Roadmap");
  await chip("Status").click();
  await menuItem("Edit Status…").click();
  const dialog = page.locator('[data-testid="tag-edit-dialog"]');
  await dialog.locator('[data-testid="tag-edit-value-1"]').fill("In progress");
  const effect = await dialog.locator('[data-testid="tag-edit-effect"]').innerText();
  const desc = await dialog.locator('[data-testid="tag-edit-desc"]').inputValue();
  await settle(250); // past the menus' and dialogs' fade-in
  await page.screenshot({ path: SHOTS + "tags-04-edit.png" });
  const calls = (await tagCalls()).length;
  await dialog.locator('[data-testid="tag-edit-save"]').click();
  await poll(async () => (await text(`${ROOT}/Projects/Beta.md`)).includes("In progress"));
  await poll(async () => (await page.locator(".toast", { hasText: "changed to match" }).count()) === 1);
  const made = (await tagCalls()).slice(calls);
  step(
    "a value renamed lists both while every note that has it is rewritten, the open one too, each note's line endings kept",
    effect.includes("Doing") &&
      desc === "Where a piece of work is." &&
      JSON.stringify(made.map((c) => c.def?.values)) === JSON.stringify([["Todo", "Doing", "In progress", "Done"], ["Todo", "In progress", "Done"]]) &&
      JSON.stringify((await tagsNow())[0]) === JSON.stringify({ name: "Status", values: ["Todo", "In progress", "Done"], desc: "Where a piece of work is." }) &&
      (await text(`${ROOT}/Roadmap.md`)) === "---\nStatus: In progress\n---\n## Now\n\nTags on notes.\n" &&
      (await text(`${ROOT}/Projects/Beta.md`)) === "---\r\nStatus: In progress\r\n---\r\nTen teams in the beta.\r\n" &&
      (await text(`${ROOT}/Projects/Notes.md`)) === "---\nStatus: Todo\n---\nNothing yet.\n" &&
      JSON.stringify(await chipTexts()) === JSON.stringify(["Status In progress"]) &&
      (await page.locator(".toast", { hasText: "2 notes changed to match." }).count()) === 1 &&
      (await page.locator(".conflict-banner").count()) === 0,
    `${effect} ${JSON.stringify(made)}`,
  );
}

/* 8 — a tag renamed: every note's line, and the list keeps its order. */
{
  await chip("Status").click();
  await menuItem("Edit Status…").click();
  const dialog = page.locator('[data-testid="tag-edit-dialog"]');
  await dialog.locator('[data-testid="tag-edit-name"]').fill("Stage");
  const calls = (await tagCalls()).length;
  await dialog.locator('[data-testid="tag-edit-save"]').click();
  await poll(async () => (await text(`${ROOT}/Projects/Notes.md`)).includes("Stage: Todo"));
  await poll(async () => (await tagCalls()).length === calls + 4);
  const made = (await tagCalls()).slice(calls).map((c) => (c.remove ? `-${c.remove}` : `${c.set}=${c.def.name}`));
  step(
    "a tag renamed rewrites every note's line, lists the old name meanwhile, and keeps its place in the list",
    JSON.stringify(made) === JSON.stringify(["Status=Stage", "Status=Status", "-Status", "Stage=Stage"]) &&
      JSON.stringify((await tagsNow()).map((d) => d.name)) === JSON.stringify(["Stage", "Priority", "Area"]) &&
      (await tagsNow())[0].desc === "Where a piece of work is." &&
      (await text(`${ROOT}/Launch plan.md`)).startsWith("---\nStage: Done\nPriority: p2\n") &&
      (await text(`${ROOT}/Old.md`)) === "---\nStage: Blocked\n---\nWaiting on the vendor.\n" &&
      (await text(`${ROOT}/Roadmap.md`)).startsWith("---\nStage: In progress\n---\n") &&
      JSON.stringify(await chipTexts()) === JSON.stringify(["Stage In progress"]),
    JSON.stringify(made),
  );
}

/* 9 — `name:value` in search: notes by tag, with or without words. */
{
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+F" : "Control+Shift+F");
  const input = page.locator(".ws-search-input");
  await poll(async () => (await input.count()) === 1);
  const names = () => page.locator(".ws-result-file-name").evaluateAll((els) => els.map((el) => el.innerText));
  await input.fill('stage:"in progress"');
  await poll(async () => (await names()).length === 2);
  const byTag = await names();
  await input.fill("stage:done launch");
  await poll(async () => JSON.stringify(await names()) === JSON.stringify(["Launch plan"]));
  const lines = await page.locator(".ws-result-preview mark").first().innerText();
  await input.fill("owner:ada");
  await poll(async () => (await page.locator(".sidebar-message", { hasText: "No results" }).count()) === 1);
  step(
    "name:value in search finds the notes with that tag; with words, lines from those notes; any other x:y is words",
    JSON.stringify(byTag) === JSON.stringify(["Beta", "Roadmap"]) && lines.toLowerCase() === "launch",
    JSON.stringify(byTag),
  );
  await input.press("Escape");
}

/* 10 — Settings' Tags: each tag with its values and what they mean, Edit
        on each, and New tag; both come back to the list. */
{
  await openTagsPage();
  const rows = () => page_().locator(".tags-page-row").evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  const listed = await rows();
  await settle(250); // past the menus' and dialogs' fade-in
  await page.screenshot({ path: SHOTS + "tags-05-settings.png" });
  await page_().locator('[data-testid="tags-new"]').click();
  await page_().locator('[data-testid="tag-new-name"]').fill("Size");
  await page_().locator('[data-testid="tag-new-values"]').fill("S\nM\nL");
  const gets = await page_().locator('[data-testid="tag-new-gets"]').count();
  await page_().locator('[data-testid="tag-new-create"]').click();
  await poll(async () => (await rows()).length === 4);
  await page_().locator('[data-testid="tags-edit-Priority"]').click();
  await page_().locator('[data-testid="tag-edit-desc"]').fill("p1 first.");
  await page_().locator('[data-testid="tag-edit-save"]').click();
  await poll(async () => (await tagsNow())[1].desc === "p1 first.");
  await poll(async () => (await rows()).length === 4);
  step(
    "Settings' Tags lists each tag with its values and what they mean; New tag adds one at the end, Edit changes what they mean, and both come back to the list",
    JSON.stringify(listed) ===
      JSON.stringify([
        "Stage Edit Todo In progress Done Where a piece of work is.",
        "Priority Edit p1 p2 p3 How soon it matters: p1 first.",
        "Area Edit Web iPhone Which part of the product.",
      ]) &&
      gets === 0 &&
      JSON.stringify((await tagsNow()).at(-1)) === JSON.stringify({ name: "Size", values: ["S", "M", "L"] }) &&
      (await rows())[1] === "Priority Edit p1 p2 p3 p1 first.",
    JSON.stringify({ listed, now: await rows() }),
  );
}

/* 11 — a tag deleted: it leaves the list, and notes keep their line as
        plain frontmatter. */
{
  await page_().locator('[data-testid="tags-edit-Area"]').click();
  await page_().locator('[data-testid="tag-edit-delete"]').click();
  await page_().locator('[data-testid="tag-edit-delete-confirm"]').click();
  await poll(async () => !(await tagsNow()).some((d) => d.name === "Area"));
  await poll(async () => (await page_().locator(".tags-page-row").count()) === 3);
  await page.keyboard.press("Escape");
  await poll(async () => (await page_().count()) === 0);
  await open(`${ROOT}/Ideas.md`, "Ideas");
  step(
    "a deleted tag leaves the list, and a note keeps its line as plain frontmatter",
    (await text(`${ROOT}/Ideas.md`)).startsWith("---\nArea: iPhone\n---\n") &&
      (await chips().count()) === 0 &&
      (await pane().locator(".doc-frontmatter-more pre").textContent()) === "Area: iPhone",
  );
}

/* 12 — the open note's block changed somewhere else: the chips follow, and
        the editor is left alone. */
{
  await open(`${ROOT}/Roadmap.md`, "Roadmap");
  await editor().locator("p").first().click();
  const marker = await editor().evaluate((el) => {
    el.dataset.same = "yes";
    return el.dataset.same;
  });
  await page.evaluate((p) => window.__tags.external(p, "---\nStage: Done\npriority: p3\n---\n## Now\n\nTags on notes.\n"), `${ROOT}/Roadmap.md`);
  await poll(async () => JSON.stringify(await chipTexts()) === JSON.stringify(["Stage Done", "Priority p3"]));
  step(
    "a change from elsewhere to the open note's tags shows at once, and the editor isn't reloaded",
    marker === "yes" && (await editor().evaluate((el) => el.dataset.same)) === "yes",
  );
}

/* 13 — an html document has no tags. */
{
  if ((await row(`${ROOT}/Projects/Pricing.html`).count()) === 0) await row(`${ROOT}/Projects`).click();
  await row(`${ROOT}/Projects/Pricing.html`).click();
  await poll(async () => (await activeLabel()) === "Pricing");
  await settle();
  step("an html document has no tags row", (await page.locator(".editor-pane.is-focused .doc-tags").count()) === 0);
}

/* 14 — a folder that isn't connected has no tags: no chips, no Add tag,
        and Settings' Tags says why. */
{
  await open(`${ROOT}/Roadmap.md`, "Roadmap");
  await poll(async () => (await chips().count()) === 2);
  await page.evaluate(() => window.__tags.disconnect());
  await poll(async () => (await chips().count()) === 0);
  await pane().locator(".doc-title").hover();
  const add = await pane().locator('[data-testid="tag-add"]').count();
  await openTagsPage();
  step(
    "a folder that isn't connected shows no tags and no Add tag, and Settings' Tags says it isn't connected",
    add === 0 &&
      (await pane().locator(".doc-frontmatter-more pre").textContent()).includes("Stage: Done") &&
      (await page_().locator('[data-testid="tags-not-connected"]').count()) === 1 &&
      (await page_().locator('[data-testid="tags-new"]').count()) === 0,
  );
}

step("no page errors along the way", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
