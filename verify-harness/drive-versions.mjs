// Drives the version history rail in Chromium (cloud.html boots the REAL
// <App/> over an IPC stub whose versions_* commands answer from a scripted
// store, and whose restore actually writes the file and emits
// `versions-applied`). What this proves is the shape the design argues for
// in docs/versioning-plan.md §12.3: history is not a cloud feature, a
// version is read where the document is, and a restore is undoable.
//
// The walk: the rail from the sidebar with NO cloud connected, its day
// groups and the ladder collapsed under an older day, the trust line, the
// in-place read-only preview and the live editor surviving it, Esc, Show
// changes, Restore + the toast's Undo, Make a copy, Name this version, the
// tab menu and ⌘⌥H, a draft's history, and a revision only the cloud has.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 6000, every = 60) {
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
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:1420/verify-harness/cloud.html");

const tid = (name) => page.locator(`[data-testid="${name}"]`);
const versionCalls = (cmd) =>
  page.evaluate((c) => window.__versions.calls.filter((k) => k.cmd === c), cmd);
const lastVersionCall = async (cmd) => (await versionCalls(cmd)).at(-1);
const openRail = async (path) => {
  await page.locator(`[data-tree-path="${path}"]`).click({ button: "right" });
  await poll(async () => (await page.locator(".sidebar-menu-item", { hasText: "Version history" }).count()) === 1);
  await page.locator(".sidebar-menu-item", { hasText: "Version history" }).click();
  await poll(async () => (await tid("history-rail").count()) === 1);
};

await poll(async () => (await page.locator(".sidebar").count()) === 1);
await poll(async () => (await page.locator('[data-tree-path="/docs/other.md"]').count()) === 1);

/* 1 — the entry point exists with nothing connected: history is not a cloud
      feature any more (§12.3.6). */
await page.locator('[data-tree-path="/docs/other.md"]').click({ button: "right" });
await poll(async () => (await page.locator(".sidebar-menu-item").count()) > 0);
const menuItems = await page.locator(".sidebar-menu-item").allTextContents();
step(
  "Version history… is offered with no cloud connected",
  menuItems.some((t) => t.includes("Version history")) &&
    (await page.evaluate(() => window.__cloud.statuses.length)) === 0,
);
await page.locator(".sidebar-menu-item", { hasText: "Version history" }).click();
await poll(async () => (await tid("history-rail").count()) === 1);

/* 2 — opening history opens the document too: a version shows where the
      document is, so the document has to be the one standing there. */
step(
  "the rail opens the document it lists",
  (await lastVersionCall("versions_history")).args.path === "/docs/other.md" &&
    (await page.locator(".tab.is-active .tab-label").textContent()) === "other",
);

/* 3 — the ladder, visible in the list: today and yesterday open, an older
      day collapsed to one row until it is asked to expand. */
await poll(async () => (await tid("history-day").count()) === 3);
const dayLabels = await page.locator(".history-day-label").allTextContents();
const openRows = await tid("history-version").count();
await tid("history-day").last().click();
await poll(async () => (await tid("history-version").count()) === openRows + 1);
step(
  "day groups: Today, Yesterday, then one row per older day that expands",
  dayLabels[0] === "Today" && dayLabels[1] === "Yesterday" && dayLabels.length === 3 && openRows === 3,
  dayLabels.join(" | "),
);

/* 4 — the trust line: the promise as a sentence (§12.3.7). */
const trust = await tid("history-trust").textContent();
step("the trust line says how far back this document reaches", /^Every change since \w/.test(trust), trust);

/* 5 — a named version keeps its own row with its name in it, even though
      the ladder would otherwise have thinned that moment away. */
step(
  "a named version shows its name",
  (await tid("history-version-label").textContent()) === "Before the rewrite" &&
    (await page.locator(".history-version-pin").count()) >= 1,
);
await page.screenshot({ path: SHOTS + "versions-01-rail.png" });

/* 6 — selecting a version shows it IN the document area, read-only, and the
      live editor is hidden rather than replaced. */
const liveText = await page.locator(".editor-wrap .milkdown").first().innerText();
await tid("history-version").nth(3).click(); // the oldest — "the first text"
await poll(async () => (await tid("version-preview").count()) === 1);
await poll(async () => (await tid("version-preview").innerText()).includes("the first text"));
const bannerText = await tid("version-banner").textContent();
step(
  "a version renders in the document area, read-only, under its banner",
  bannerText.startsWith("Viewing the version from") &&
    (await page.locator(".editor-wrap.is-version-preview").count()) === 1 &&
    (await page.locator(".version-preview .ProseMirror").first().getAttribute("contenteditable")) === "false" &&
    (await lastVersionCall("versions_read")).args.root === "/docs",
);
await page.screenshot({ path: SHOTS + "versions-02-preview.png" });

/* 7 — Show changes: the same version as a unified diff, additions marked. */
await tid("show-changes").click();
await poll(async () => (await tid("version-diff").count()) === 1);
const addLines = await page.locator(".version-diff-line.is-add").allTextContents();
step(
  "Show changes swaps the preview for a diff with its + lines marked",
  addLines.some((l) => l.startsWith("+the current text")) &&
    (await page.locator(".version-diff-line.is-del").count()) === 1 &&
    (await lastVersionCall("versions_diff")).args.from === "d".repeat(64),
);
await tid("show-changes").click();
await poll(async () => (await tid("version-diff").count()) === 0);

/* 8 — Esc goes back to now, and the live document is exactly as it was. */
await page.keyboard.press("Escape");
await poll(async () => (await tid("version-preview").count()) === 0);
step(
  "Esc returns to the live document, untouched",
  (await page.locator(".editor-wrap .milkdown").first().innerText()) === liveText &&
    (await tid("history-rail").count()) === 1,
);

/* 9 — Make a copy: the version written beside the original, opened in a tab.
      This is the only way a history forks, and it forks into a file. */
await tid("history-version").nth(3).click();
await poll(async () => (await tid("version-preview").count()) === 1);
await tid("copy-version").click();
await poll(async () => (await page.evaluate(() => window.__writes.filter((p) => p.includes("(version ")).length)) === 1);
const copyPath = await page.evaluate(() => window.__writes.filter((p) => p.includes("(version ")).at(-1));
await poll(async () => (await page.locator(".tab.is-active .tab-label").textContent()).includes("version"));
step(
  "Make a copy writes the version beside the original and opens it",
  copyPath.startsWith("/docs/other (version ") &&
    copyPath.endsWith(".md") &&
    !copyPath.includes(":") &&
    (await page.evaluate((p) => window.__fs.get(p), copyPath)) === "# Other\n\nthe first text\n",
  copyPath,
);

/* 10 — back on the document, restore: one command, and the file on disk
       becomes the old version. */
await page.locator(".tab", { hasText: "other" }).first().locator(".tab-main").click();
await poll(async () => (await tid("history-rail").count()) === 1);
await poll(async () => (await tid("history-version").count()) >= 4);
await tid("history-version").last().click();
await poll(async () => (await tid("version-preview").count()) === 1);
await tid("restore-version").click();
await poll(async () => (await page.evaluate(() => window.__fs.get("/docs/other.md"))) === "# Other\n\nthe first text\n");
const restoreCall = await lastVersionCall("versions_restore_file");
await poll(async () => (await page.locator(".cloud-toast").count()) === 1);
const toast = await page.locator(".cloud-toast-text").textContent();
step(
  "Restore is one command: the version's hash and its ts, and the file is written",
  restoreCall.args.path === "/docs/other.md" &&
    restoreCall.args.hash === "d".repeat(64) &&
    typeof restoreCall.args.ts === "number" &&
    restoreCall.args.text === null &&
    toast.startsWith("Restored the version from"),
  toast,
);

/* 11 — the restore left both states behind, and the rail says where the
       newest one came from. The preview closed; the live document reloaded. */
await poll(async () => (await tid("history-restored-from").count()) === 1);
step(
  "the rail gains a row that says what it was restored from, and nothing was removed",
  (await tid("version-preview").count()) === 0 &&
    (await tid("history-restored-from").textContent()).startsWith("restored from") &&
    (await tid("history-version").count()) >= 6 &&
    (await page.locator(".editor-wrap .milkdown").first().innerText()).includes("the first text"),
);
await page.screenshot({ path: SHOTS + "versions-03-restored.png" });

/* 12 — Undo is another restore, of the state the first one left (§12.3.8). */
await page.locator(".cloud-toast-btn", { hasText: "Undo" }).click();
await poll(async () => (await versionCalls("versions_restore_file")).length === 2);
const undo = await lastVersionCall("versions_restore_file");
await poll(async () => (await page.evaluate(() => window.__fs.get("/docs/other.md"))) === "# Other\n\nthe current text\n");
step(
  "Undo restores the state the restore left — the same command, pointed back",
  undo.args.hash === "a".repeat(64) && undo.args.hash !== restoreCall.args.hash,
);

/* 13 — Name this version: a pinned moment with a name, in the list. */
await tid("name-version-input").fill("Before the rewrite II");
await page.keyboard.press("Enter");
await poll(async () => (await versionCalls("versions_capture_now")).length === 1);
const named = await lastVersionCall("versions_capture_now");
await poll(async () => (await page.locator(".history-version-label").first().textContent()) === "Before the rewrite II");
step(
  "Name this version pins the moment under the name given",
  named.args.label === "Before the rewrite II" &&
    named.args.reason === "manual" &&
    named.args.root === "/docs" &&
    (await tid("name-version-input").inputValue()) === "",
);

/* 14 — the rail closes, then ⌘⌥H opens it again for whatever is open. */
await page.locator(".history-rail-close").click();
await poll(async () => (await tid("history-rail").count()) === 0);
await page.keyboard.press("Meta+Alt+KeyH");
await poll(async () => (await tid("history-rail").count()) === 1);
await page.keyboard.press("Meta+Alt+KeyH");
await poll(async () => (await tid("history-rail").count()) === 0);
step("⌘⌥H toggles the rail for the open document", true);

/* 15 — the tab's own menu is the second way in. */
await page.locator(".tab.is-active").click({ button: "right" });
await poll(async () => (await page.locator(".tree-context-menu").count()) === 1);
await page.locator(".tree-context-menu .sidebar-menu-item", { hasText: "Version history" }).click();
await poll(async () => (await tid("history-rail").count()) === 1);
step("the tab's right-click menu opens the rail", (await tid("history-rail").count()) === 1);
await page.locator(".history-rail-close").click();
await poll(async () => (await tid("history-rail").count()) === 0);

/* 16 — a draft has a history too: the drafts folder is a root like any
       other, so the one thing with nowhere else to live is kept as well. */
await page.keyboard.press("Meta+Shift+KeyD");
await poll(async () => (await page.locator(".draft-row").count()) === 1);
await page.locator(".draft-row").click({ button: "right" });
await poll(async () => (await page.locator(".tree-context-menu").count()) === 1);
await page.locator(".tree-context-menu .sidebar-menu-item", { hasText: "Version history" }).click();
await poll(async () => (await tid("history-rail").count()) === 1);
await poll(async () => (await lastVersionCall("versions_history")).args.path === "/drafts/d-1.md");
await tid("history-version").first().click();
await poll(async () => (await tid("version-preview").count()) === 1);
step(
  "a draft's history opens, from the store the drafts folder has of its own",
  (await lastVersionCall("versions_read")).args.root === "/drafts" &&
    (await tid("version-preview").innerText()).includes("a draft with a history"),
);
await page.keyboard.press("Escape");
await page.locator(".history-rail-close").click();
await page.keyboard.press("Meta+Shift+KeyD");
await poll(async () => (await page.locator(".draft-row").count()) === 0);

/* 17 — the cloud read-through: on the day the rail ships the local store is
       hours old and the manifest's `hist` is not, so what the user can see
       today stays visible. A cloud-only revision wears its badge and is read
       through cloud_revision, not out of the local store. */
await page.evaluate(() => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const h = window.__versions.histories["/docs/other.md"];
  h.versions = [
    ...h.versions.slice(0, 2),
    {
      // Yesterday afternoon: an open group, so the row is on screen without
      // an expand — the point of the step is the badge, not the grouping.
      ts: midnight.getTime() - 86400000 + 14 * 3600000,
      hash: "h2",
      size: 20,
      by: "Bob",
      reason: "",
      label: null,
      pinned: false,
      restoredFrom: null,
      path: "other.md",
      source: "manifest",
      current: false,
    },
  ];
});
await openRail("/docs/other.md");
await poll(async () => (await page.locator('[data-source="manifest"]').count()) === 1);
const where = await tid("history-trust").textContent();
const cloudRow = page.locator('[data-source="manifest"]');
step(
  "a revision only the cloud has appears, with where history lives",
  where.includes("in the cloud") && (await cloudRow.textContent()).includes("from the cloud"),
  where,
);
await cloudRow.click();
await poll(async () => (await tid("version-preview").innerText()).includes("bob's revision"));
step(
  "and it is read through the cloud, not the local store",
  (await page.evaluate(() => window.__cloud.calls.filter((c) => c.cmd === "cloud_revision").at(-1)?.args.hash)) === "h2" &&
    // The manifest names its revisions by a 16-character hash the version
    // store can't resolve, so there is nothing to compare it against.
    (await tid("show-changes").count()) === 0,
);
await page.screenshot({ path: SHOTS + "versions-04-cloud.png" });

/* 19 — a version another Mac mirrored: the same rail, the same reads. What
   the cloud adds is depth, and it arrives looking like everything else. */
await tid("back-to-now").click();
await poll(async () => (await tid("version-preview").count()) === 0);
await page.evaluate(() => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const h = window.__versions.histories["/docs/other.md"];
  h.versions = [
    ...h.versions.slice(0, 2),
    {
      ts: midnight.getTime() - 86400000 + 17 * 3600000,
      hash: "f".repeat(64),
      size: 25,
      by: "Sherin's iMac",
      reason: "interval",
      label: null,
      pinned: false,
      restoredFrom: null,
      path: "other.md",
      source: "cloud",
      current: false,
    },
    ...h.versions.slice(2),
  ];
  window.__versions.blobs["f".repeat(64)] = "# Other\n\nwritten on the iMac\n";
});
await tid("history-rail").locator(".history-rail-close").click();
await poll(async () => (await tid("history-rail").count()) === 0);
await openRail("/docs/other.md");
await poll(async () => (await page.locator('[data-source="cloud"]').count()) === 1);
const mirroredRow = await page.locator('[data-source="cloud"]').textContent();
const bothCounted = await tid("history-trust").textContent();
await page.locator('[data-source="cloud"]').click();
await poll(async () => (await tid("version-preview").innerText()).includes("written on the iMac"));
step(
  "a version another Mac made rides the same rail: its device, its reason, read through the store and comparable",
  mirroredRow.includes("Sherin's iMac") &&
    mirroredRow.includes("while editing") &&
    bothCounted.includes("2 in the cloud") &&
    (await page.evaluate(() => window.__versions.calls.filter((c) => c.cmd === "versions_read").at(-1)?.args.hash)) ===
      "f".repeat(64) &&
    (await tid("show-changes").count()) === 1,
  `${mirroredRow} / ${bothCounted}`,
);

await settle();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
