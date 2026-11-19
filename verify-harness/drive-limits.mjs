// Drives the REAL App's surfaces for the day's Cloudflare limits (cloud.html
// boots <App/> over the scripted fake engine): the sidebar footer's words
// for each mode and for the two new phases, the Cloud panel's cards — this
// Mac's own wait with Send them now and what it says after, everyone's wait
// with no button (and, for the superadmin, the line pointing at the plan),
// the slow mode, the used-up day — the quiet line of today's requests, the
// plan row (the superadmin's control behind a confirmation, plain words for
// everyone else), the many-new-documents question on a notice and in the
// panel with both answers, and the greyed row of a file that stays on this
// Mac. `PORT` picks the vite server (default 1420).
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
/** A poll that answers false instead of throwing, for a step's verdict. */
const holds = (fn, timeout) => poll(fn, timeout).then(() => true, () => false);

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(`http://localhost:${PORT}/verify-harness/cloud.html`);

const tid = (id) => page.locator(`[data-testid="${id}"]`);
const dialog = (label) => page.locator(`[role="dialog"][aria-label="${label}"]`);
const calls = (cmd) => page.evaluate((c) => window.__cloud.calls.filter((x) => x.cmd === c), cmd);
const emit = (event, payload) => page.evaluate(([e, p]) => window.__emit(e, p), [event, payload]);
const setStatuses = (statuses) => page.evaluate((s) => window.__setStatuses(s), statuses);
const text = async (id) => ((await tid(id).textContent()) ?? "").trim();

const SUPERADMIN_CAN = ["work", "people.see", "people.invite", "people.recover", "people.remove", "people.roles", "agents.own", "agents.manage", "devices.own", "pages.manage", "workspace.manage"];
const MEMBER_CAN = ["work", "people.see", "agents.own", "devices.own"];
// The next 00:00 UTC, and how this Mac's clock writes it — what every
// "until 05:30" must say.
const RESUMES = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
})();
const CLOCK = await page.evaluate((ms) => new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" }), RESUMES);
const n = (x) => x.toLocaleString();

const NORMAL = { mode: "normal", cause: null, today: 1240, fleetToday: 8900, cap: 100000, plan: "free", resumesAt: null, waiting: 0, liftable: false, lifted: false };
const status = (over = {}, usage = {}) => ({
  root: "/docs",
  domain: "notes.example.com",
  endpoint: "https://notes.example.com",
  wsId: "w-new",
  name: "docs",
  phase: "idle",
  lastSyncMs: Date.now(),
  error: null,
  pendingDeletes: 0,
  pendingAdds: 0,
  usage: { ...NORMAL, ...usage },
  me: "Ada",
  meId: "m-owner",
  can: SUPERADMIN_CAN,
  superadmin: "Ada",
  workerVersion: null,
  versions: { mirrored: 0, cloud: 0, lastMirrorMs: null, horizonDays: null },
  public: [],
  presence: [],
  leases: [],
  spaces: [],
  ...over,
});
const footer = async () => ({
  text: await text("sync-status"),
  tone: ((await tid("sync-status").getAttribute("class")) ?? "").replace("sync-status ", ""),
  // Whether the words fit the sidebar's default width, or lose their end to the ellipsis.
  whole: await tid("sync-status").locator(".sync-status-text").evaluate((el) => el.scrollWidth <= el.clientWidth),
});
const openPanel = async () => {
  if ((await dialog("Cloud").count()) === 1) return;
  await tid("sync-status").click();
  await poll(async () => (await dialog("Cloud").count()) === 1);
};
const closePanel = async () => {
  if ((await dialog("Cloud").count()) === 0) return;
  await page.keyboard.press("Escape");
  await poll(async () => (await dialog("Cloud").count()) === 0);
};

/* 1 — a file Doklin does not sync: its greyed row says so once the workspace
   is connected — which moves the folder's files into Library (the engine's
   move, as the stub plays it) */
await poll(async () => (await page.locator('[data-tree-path="/docs/other.md"]').count()) === 1);
// The sidebar lists every file, so a non-document shows as a greyed row.
await page.locator(".sidebar-header-button").click();
await page.locator(".sidebar-menu-item", { hasText: "Show all files" }).click();
await poll(async () => (await page.locator('[data-tree-path="/docs/photo.png"]').count()) === 1);
const rowBefore = await page.locator('[data-tree-path="/docs/photo.png"]').getAttribute("title");
await page.evaluate(() => window.__moveIntoLibrary("/docs"));
await setStatuses([status()]);
await poll(async () => (await tid("sync-status").count()) === 1);
// What sync applies is what redraws the tree.
await page.evaluate(() => window.__emit("cloud-applied", { root: "/docs", paths: [] }));
const photo = page.locator('[data-tree-path="/docs/Library/photo.png"]');
await poll(async () => (await photo.count()) === 1);
const rowAfter = await photo.getAttribute("title");
step(
  "greyed row: stays on this Mac once connected (and says Doklin can't open it before)",
  rowBefore.includes("Doklin can’t open this file type") &&
    rowAfter === "Stays on this Mac — Doklin syncs markdown and html" &&
    ((await photo.getAttribute("class")) ?? "").includes("is-unsupported"),
  `${rowBefore} / ${rowAfter}`,
);

/* 2 — this Mac's own wait: the footer, then the panel's card and Send them now */
await setStatuses([status({}, { mode: "bulk-waits", cause: "device", resumesAt: RESUMES, waiting: 412, liftable: true })]);
await poll(async () => (await tid("sync-status").getAttribute("data-usage")) === "waits");
const waitsFooter = await footer();
const waitsTitle = await tid("sync-status").getAttribute("title");
// A pass runs through "syncing": the words stand.
await setStatuses([status({ phase: "syncing" }, { mode: "bulk-waits", cause: "device", resumesAt: RESUMES, waiting: 412, liftable: true })]);
await new Promise((r) => setTimeout(r, 1000));
const waitsDuringPass = await footer();
await page.locator(".side-footer").screenshot({ path: SHOTS + "limits-01-footer-waits.png" });
// A long count fits too.
await setStatuses([status({}, { mode: "bulk-waits", cause: "device", resumesAt: RESUMES, waiting: 12400, liftable: true })]);
await poll(async () => (await text("sync-status")).startsWith("12,400"));
const longWait = await footer();
step(
  "footer: this Mac's wait reads '412 held until <05:30>' in amber, whole at the default width (12,400 too), through a pass too; the tooltip says it in full",
  waitsFooter.text === `412 held until ${CLOCK}` &&
    waitsFooter.tone === "is-warn" &&
    waitsFooter.whole &&
    longWait.text === `12,400 held until ${CLOCK}` &&
    longWait.whole &&
    waitsDuringPass.text === waitsFooter.text &&
    waitsTitle.startsWith(`412 changes wait until ${CLOCK} · `),
  `${waitsFooter.text} (${waitsFooter.tone}, whole ${waitsFooter.whole}) / ${longWait.text} (whole ${longWait.whole}) / ${waitsTitle}`,
);

await setStatuses([status({}, { mode: "bulk-waits", cause: "device", resumesAt: RESUMES, waiting: 412, liftable: true })]);
await openPanel();
await poll(async () => (await tid("usage-waits").count()) === 1);
const waitsCard = await text("usage-waits");
const usageLine = await text("usage-line");
await dialog("Cloud").screenshot({ path: SHOTS + "limits-02-panel-waits.png" });
step(
  "panel: this Mac's share is spent, the rest go out after <05:30>, Send them now; the quiet line of today's requests",
  waitsCard.includes(`412 changes wait until ${CLOCK}`) &&
    waitsCard.includes("This Mac has sent its share of big changes for today.") &&
    waitsCard.includes(`The rest go out after ${CLOCK}, so nothing else on this workspace slows down.`) &&
    (await tid("lift-wait").textContent()) === "Send them now" &&
    usageLine === `This Mac today: ${n(1240)} requests · everyone ≈ ${n(8900)} of ${n(100000)}`,
  `${waitsCard} | ${usageLine}`,
);

await tid("lift-wait").click();
await poll(async () => (await calls("cloud_lift_wait")).length === 1);
await poll(async () => (await tid("usage-sending").count()) === 1);
const liftCall = (await calls("cloud_lift_wait"))[0].args;
const sendingCard = await text("usage-sending");
const sendingFooter = await footer();
// Counting down, then done.
await setStatuses([status({ phase: "syncing" }, { lifted: true, waiting: 112 })]);
await poll(async () => (await text("usage-sending")) === "Sending 112 changes…");
await setStatuses([status({}, { lifted: true, waiting: 0 })]);
await poll(async () => (await tid("usage-sending").count()) === 0);
step(
  "Send them now: cloud_lift_wait {root}; 'Sending 412 changes…' in the panel and the footer, counting down, then Synced",
  liftCall.root === "/docs" &&
    sendingCard === "Sending 412 changes…" &&
    sendingFooter.text === "Sending 412 changes…" &&
    sendingFooter.tone === "is-busy" &&
    (await tid("usage-waits").count()) === 0 &&
    (await footer()).text === "Synced",
  `${sendingCard} / ${sendingFooter.text} (${sendingFooter.tone})`,
);

/* 3 — everyone's wait: no button; the superadmin is pointed at the plan, a member is not */
await setStatuses([status({}, { mode: "bulk-waits", cause: "fleet", resumesAt: RESUMES, waiting: 30, fleetToday: 61000 })]);
await poll(async () => (await tid("usage-waits").getAttribute("data-cause")) === "fleet");
const fleetAdmin = await text("usage-waits");
const adminLift = await tid("lift-wait").count();
await setStatuses([status({ can: MEMBER_CAN, me: "Bob", meId: "m-bob" }, { mode: "bulk-waits", cause: "fleet", resumesAt: RESUMES, waiting: 30, fleetToday: 61000 })]);
await poll(async () => (await tid("plan-free").count()) === 0);
const fleetMember = await text("usage-waits");
const memberPlan = await text("plan-row");
await dialog("Cloud").screenshot({ path: SHOTS + "limits-03-panel-fleet-member.png" });
step(
  "everyone's wait: same words with 'Everyone on this workspace together…', no button; the plan pointer for the superadmin only; a member reads the plan",
  fleetAdmin.includes("30 changes wait until") &&
    fleetAdmin.includes("Everyone on this workspace together is near today’s Cloudflare limit.") &&
    fleetAdmin.includes("say so under Cloudflare plan below") &&
    adminLift === 0 &&
    !fleetMember.includes("Cloudflare plan below") &&
    (await tid("lift-wait").count()) === 0 &&
    memberPlan === "Cloudflare plan:Free",
  `${fleetMember} | ${memberPlan}`,
);

/* 4 — slow: the footer's few words and the panel's sentence */
await setStatuses([status({}, { mode: "slow", cause: "device", resumesAt: RESUMES })]);
await poll(async () => (await tid("usage-slow").count()) === 1);
// The footer follows a render later (it holds a plain pass's Syncing… back).
await holds(async () => (await tid("sync-status").getAttribute("data-usage")) === "slow");
const slowFooter = await footer();
const slowLine = await text("usage-slow");
step(
  "slow: 'Sync is slower today' in the footer; the panel says edits still go out, about once a minute",
  slowFooter.text === "Sync is slower today" &&
    slowFooter.tone === "is-warn" &&
    slowLine === "Sync is slower for the rest of today to stay inside Cloudflare’s free requests — edits still go out, about once a minute.",
  `${slowFooter.text} | ${slowLine}`,
);

/* 5 — today's requests used up: the phase, its dot, the engine's sentence */
const LIMITED = `Today’s Cloudflare requests are used up. Sync resumes at ${CLOCK}.`;
await setStatuses([status({ phase: "limited", error: LIMITED }, { resumesAt: RESUMES })]);
await poll(async () => (await tid("limited").count()) === 1);
await holds(async () => (await tid("sync-status").getAttribute("data-phase")) === "limited");
const limitedFooter = await footer();
const limitedPhase = await text("phase-text");
const limitedLine = await text("limited");
await dialog("Cloud").screenshot({ path: SHOTS + "limits-04-panel-limited.png" });
step(
  "limited: footer 'Cloudflare's requests are used up until <05:30>' in amber; the panel's phase line, amber dot and the engine's sentence",
  limitedFooter.text === `Cloudflare’s requests are used up until ${CLOCK}` &&
    limitedFooter.tone === "is-warn" &&
    limitedPhase === `Cloudflare’s requests are used up until ${CLOCK}` &&
    (await page.locator(".cloud-dot.phase-limited").count()) === 1 &&
    limitedLine.startsWith(LIMITED) &&
    limitedLine.includes("Workers Paid lifts it within half an hour"),
  `${limitedFooter.text} | ${limitedLine}`,
);

/* 6 — the plan row: the superadmin's, behind a confirmation */
await setStatuses([status()]);
await poll(async () => (await tid("plan-free").count()) === 1);
const freeActive = (await tid("plan-free").getAttribute("aria-checked")) === "true";
await tid("plan-paid").click();
await poll(async () => (await tid("plan-confirm").count()) === 1);
const confirmText = await text("plan-confirm");
const askedBefore = (await calls("cloud_set_plan")).length;
await dialog("Cloud").screenshot({ path: SHOTS + "limits-05-plan-confirm.png" });
await tid("plan-yes").click();
await poll(async () => (await calls("cloud_set_plan")).length === 1);
await poll(async () => (await tid("plan-paid").getAttribute("aria-checked")) === "true");
const planCall = (await calls("cloud_set_plan"))[0].args;
const paidLine = await text("usage-line");
step(
  "plan: Free / Workers Paid for the superadmin; choosing Paid asks first, then cloud_set_plan {root, plan}; Paid has no cap in the line",
  freeActive &&
    askedBefore === 0 &&
    confirmText.includes("Choose this only once the account is on Workers Paid") &&
    confirmText.includes("Switch to Workers Paid") &&
    planCall.root === "/docs" &&
    planCall.plan === "paid" &&
    (await tid("plan-confirm").count()) === 0 &&
    paidLine === `This Mac today: ${n(1240)} requests · everyone ≈ ${n(8900)}`,
  `${confirmText} | ${paidLine}`,
);
await closePanel();

/* 7 — many new documents: the notice asks with both answers; Not now */
await setStatuses([status({ phase: "pending-adds", pendingAdds: 212 })]);
await emit("cloud-pending-adds", { root: "/docs", count: 212, folders: [{ path: "Library/Projects/foo", count: 212 }] });
await poll(async () => (await page.locator(".toast").count()) === 1);
const addsToast = await page.locator(".toast .toast-text").textContent();
const addsButtons = (await page.locator(".toast .toast-btn").allTextContents()).map((t) => t.trim());
const addsFooter = await footer();
await new Promise((r) => setTimeout(r, 400)); // the notice's fade-in
await page.screenshot({ path: SHOTS + "limits-06-adds-toast.png" });
await page.locator(".toast-btn", { hasText: "Not now" }).click();
await poll(async () => (await calls("cloud_confirm_adds")).length === 1);
const notNow = (await calls("cloud_confirm_adds"))[0].args;
step(
  "many new documents: the notice asks '212 new documents appeared in Library/Projects/foo. Sync them?' with Sync them / Not now; the footer asks too; Not now answers sync: false",
  addsToast === "212 new documents appeared in Library/Projects/foo. Sync them?" &&
    addsButtons.join("|") === "Sync them|Not now" &&
    addsFooter.text === "212 new documents — Sync them?" &&
    addsFooter.tone === "is-warn" &&
    notNow.root === "/docs" &&
    notNow.sync === false &&
    (await holds(async () => (await page.locator(".toast").count()) === 0)),
  `${addsToast} | ${addsFooter.text}`,
);

/* 8 — asked again across three folders: the panel lists them, Sync them
   there answers, and the notice goes with the question */
// Grouped two levels below a section's folder; the files straight in
// Library are Library's.
const FOLDERS = [
  { path: "Library/Projects/foo", count: 150 },
  { path: "Library/Projects/bar", count: 40 },
  { path: "Library", count: 22 },
];
await setStatuses([status({ phase: "pending-adds", pendingAdds: 212 })]);
await emit("cloud-pending-adds", { root: "/docs", count: 212, folders: FOLDERS });
await poll(async () => (await page.locator(".toast").count()) === 1);
const threeToast = await page.locator(".toast .toast-text").textContent();
await openPanel();
await poll(async () => (await tid("pending-adds").count()) === 1);
const addsCard = await text("pending-adds");
const listed = (await tid("pending-adds").locator(".cloud-paths li").allTextContents()).map((t) => t.trim());
await dialog("Cloud").screenshot({ path: SHOTS + "limits-07-panel-adds.png" });
await tid("confirm-adds").click();
await poll(async () => (await calls("cloud_confirm_adds")).length === 2);
const syncThem = (await calls("cloud_confirm_adds"))[1].args;
await poll(async () => (await tid("pending-adds").count()) === 0);
step(
  "asked again: 'in 3 folders' on the notice and the card, each folder listed by its path (Library's own files as Library); Sync them answers sync: true and the notice leaves",
  threeToast === "212 new documents appeared in 3 folders. Sync them?" &&
    addsCard.startsWith("212 new documents appeared in 3 folders. Sync them?") &&
    listed.join("|") === "Library/Projects/foo — 150|Library/Projects/bar — 40|Library — 22" &&
    syncThem.sync === true &&
    (await holds(async () => (await page.locator(".toast").count()) === 0)),
  `${threeToast} | ${listed.join(" · ")}`,
);
await closePanel();

/* 9 — more folders than the event lists, and a relaunched window that heard no event */
await setStatuses([status({ phase: "pending-adds", pendingAdds: 900 })]);
await emit("cloud-pending-adds", {
  root: "/docs",
  count: 900,
  folders: ["a", "b", "c", "d", "e"].map((p) => ({ path: p, count: 100 })),
});
await poll(async () => (await page.locator(".toast").count()) === 1);
const manyToast = await page.locator(".toast .toast-text").textContent();
await page.locator(".toast-btn", { hasText: "Sync them" }).click();
await poll(async () => (await calls("cloud_confirm_adds")).length === 3);
await setStatuses([status({ phase: "pending-adds", pendingAdds: 300 })]);
await openPanel();
await poll(async () => (await tid("pending-adds").count()) === 1);
const noEventCard = await tid("pending-adds").locator(".cloud-card-title").textContent();
await closePanel();
step(
  "the event lists five folders but more hold them: 'in more than 5 folders'; a count the last event did not ask about is said without a place",
  manyToast === `${n(900)} new documents appeared in more than 5 folders. Sync them?` &&
    (await calls("cloud_confirm_adds"))[2].args.sync === true &&
    noEventCard === "300 new documents appeared. Sync them?",
  `${manyToast} | ${noEventCard}`,
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
