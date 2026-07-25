// Drives table column-width PERSISTENCE (src/tableWidths.ts + the two seams
// in src/tableResize.ts) in Chromium against the real Editor: a drag emits a
// record set, the markdown stays byte-identical, remounting from those
// records restores the columns on the first paint, a header rename carries
// the widths to the table's new identity, and a read-only view resizes
// without ever emitting. Needs the repo-root vite dev server (port 1420) —
// see .claude/skills/verify/SKILL.md.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 15000, every = 100) {
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

// CI runner has the browser preinstalled at a fixed path; on a dev machine
// fall back to playwright's own cache (CHROMIUM overrides it, e.g. when the
// cached build predates the installed driver).
const RUNNER_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.CHROMIUM ?? (existsSync(RUNNER_CHROMIUM) ? RUNNER_CHROMIUM : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 940 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

// PORT overrides the dev server port when 1420 is already taken by the
// user's own session.
const url = `http://localhost:${process.env.PORT ?? 1420}/verify-harness/table-resize.html`;

const waitForTable = () =>
  poll(async () =>
    (await page.evaluate(
      () => document.querySelectorAll(".milkdown table.children tbody tr").length,
    )) >= 3,
  );

// Column widths as the browser lays them out — the ground truth the user
// sees, independent of what the document says.
const renderedWidths = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".milkdown table.children colgroup col")].map((c) =>
      Math.round(c.getBoundingClientRect().width),
    ),
  );

// Drag the border between column `col` and the next one by `dx` px.
async function dragColumnBorder(col, dx) {
  const box = await page.evaluate((i) => {
    const cells = document.querySelectorAll(
      ".milkdown table.children tr:first-child > *",
    );
    const r = cells[i].getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  }, col);
  await page.mouse.move(box.x - 2, box.y); // arm the handle
  await page.mouse.move(box.x - 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x - 1 + dx, box.y, { steps: 8 });
  await page.mouse.up();
}

await page.goto(url);
await waitForTable();

const initial = await renderedWidths();
step(
  "a document with no stored widths lays out at auto width",
  initial.length === 3 && (await page.evaluate(() => window.__tcols)) === null,
  initial.join("/"),
);

/* ---------- A drag emits records, and only records ---------- */

const mdBefore = await page.evaluate(() => window.__md);
await dragColumnBorder(0, 140);
const emitted = await poll(async () => page.evaluate(() => window.__tcols));
step(
  "the drag emits one record for the one table",
  emitted.length === 1 && emitted[0].cols.length === 3,
  JSON.stringify(emitted),
);
step(
  "the resized column is stored, the untouched ones stay auto (0)",
  emitted[0].cols[0] > initial[0] + 100 && emitted[0].cols.slice(1).every((w) => w === 0),
  emitted[0].cols.join("/"),
);
step(
  "the id is the 8-char content-derived key",
  typeof emitted[0].id === "string" && /^[a-z0-9]{8}$/.test(emitted[0].id),
  emitted[0].id,
);
step(
  "the markdown is byte-identical — widths never touch the document",
  (await page.evaluate(() => window.__md)) === mdBefore,
);
const dragged = await renderedWidths();
await page.screenshot({ path: `${SHOTS}/table-resize-01-dragged.png` });

/* ---------- Reopening restores them ---------- */

await page.click("#reopen");
await waitForTable();
const reopened = await renderedWidths();
step(
  "a reopened document renders at its stored widths",
  Math.abs(reopened[0] - dragged[0]) <= 2 && reopened.length === 3,
  `${dragged.join("/")} → ${reopened.join("/")}`,
);
step(
  "restoring is not itself a change — no re-emit after the remount",
  JSON.stringify(await page.evaluate(() => window.__tcols)) === JSON.stringify(emitted),
);
step(
  "and it did not disturb the markdown",
  (await page.evaluate(() => window.__md)) === mdBefore,
);
await page.screenshot({ path: `${SHOTS}/table-resize-02-reopened.png` });

/* ---------- A second column, and the mid-session rename ---------- */

await dragColumnBorder(1, 90);
const twoCols = await poll(async () => {
  const t = await page.evaluate(() => window.__tcols);
  return t && t[0].cols[1] > 0 ? t : null;
});
step(
  "a second drag adds its column to the same record",
  twoCols.length === 1 && twoCols[0].cols[0] > 0 && twoCols[0].cols[1] > 0,
  twoCols[0].cols.join("/"),
);
step("and keeps the same id", twoCols[0].id === emitted[0].id);

// Rename a header WITH the document open: the table's derived identity
// changes, and the record must follow it rather than being orphaned.
await page.evaluate(() => {
  const cell = document.querySelector(".milkdown table.children tr:first-child > *");
  const p = cell.querySelector("p") ?? cell;
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.keyboard.type("Person");
const renamed = await poll(async () => {
  const t = await page.evaluate(() => window.__tcols);
  return t && t[0].id !== twoCols[0].id ? t : null;
});
step(
  "renaming a header re-keys the record instead of orphaning it",
  renamed.length === 1 && renamed[0].cols.join() === twoCols[0].cols.join(),
  `${twoCols[0].id} → ${renamed[0].id}`,
);
step(
  "the rename did reach the markdown (unlike the widths)",
  (await page.evaluate(() => window.__md)).includes("Person"),
);

await page.click("#reopen");
await waitForTable();
const afterRename = await renderedWidths();
step(
  "the renamed table reopens at its widths",
  Math.abs(afterRename[0] - twoCols[0].cols[0]) <= 2 &&
    Math.abs(afterRename[1] - twoCols[0].cols[1]) <= 2,
  afterRename.join("/"),
);

/* ---------- Read-only: still resizable, never persisted ---------- */

await page.goto(`${url}?ro=1`);
await waitForTable();
const roBefore = await renderedWidths();
await dragColumnBorder(0, 120);
const roAfter = await poll(async () => {
  const w = await renderedWidths();
  return w[0] > roBefore[0] + 60 ? w : null;
});
step(
  "a read-only view still resizes (shared pages, mirror panes)",
  roAfter[0] > roBefore[0] + 60,
  `${roBefore.join("/")} → ${roAfter.join("/")}`,
);
await page.waitForTimeout(600); // longer than the emitter's debounce
step(
  "…but a view that does not own the document never emits",
  (await page.evaluate(() => window.__tcols)) === null,
);
await page.screenshot({ path: `${SHOTS}/table-resize-03-readonly.png` });

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
