// Drives the REAL App (cloud.html boots <App/> over the scripted fake engine)
// through a release marked mandatory: the release manifest naming a minimum
// newer than this app covers the window with Update Doklin, nothing beneath
// it answers a click or a shortcut, and its button downloads, installs and
// restarts; a minimum this app meets changes nothing; a domain's worker
// turning the app away (`app-outdated`) covers it too, naming the domain,
// with the words for an update not out yet and for one that could not be
// fetched, and lifts when the domain answers again. `PORT` picks the vite
// server (default 1420).
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const PORT = process.env.PORT ?? "1420";
const RELEASES_PAGE = "https://github.com/boat-builder/doklin/releases/latest";

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
const holds = (fn, timeout) => poll(fn, timeout).then(() => true, () => false);

const browser = await chromium.launch(
  existsSync("/opt/pw-browsers/chromium")
    ? { executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }
    : {},
);

/** The plugin's answer to a check that found `version`, its manifest naming `minimum`. */
const found = (version, minimum) => ({
  rid: 1,
  currentVersion: "0.1.140",
  version,
  date: null,
  body: "",
  rawJson: { version, notes: "", minimum, platforms: {} },
});

const status = (over = {}) => ({
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
  usage: { mode: "normal", cause: null, today: 10, fleetToday: 10, cap: 100000, plan: "free", resumesAt: null, waiting: 0, liftable: false, lifted: false },
  me: "Ada",
  meId: "m-owner",
  can: ["work"],
  superadmin: "Ada",
  workerVersion: null,
  versions: { mirrored: 0, cloud: 0, lastMirrorMs: null, horizonDays: null },
  public: [],
  presence: [],
  leases: [],
  spaces: [],
  ...over,
});

/** A window of the app, its updater scripted before anything loads. */
async function open(update) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript((u) => {
    window.__appVersion = "0.1.140";
    window.__update = u;
  }, update);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto(`http://localhost:${PORT}/verify-harness/cloud.html`);
  await poll(async () => (await page.locator(".tab").count()) > 0, 15000);
  return { page, close: () => context.close() };
}

const cover = (page) => page.locator('[data-testid="update-required"]');
const coverText = async (page) => ((await cover(page).textContent()) ?? "").replace(/\s+/g, " ").trim();
const updaterCalls = (page) => page.evaluate(() => window.__updaterCalls ?? []);

/* 1 — the manifest names a minimum newer than this app */
{
  const { page, close } = await open(found("0.1.150", "0.1.150"));
  // The download waits until the drive lets it finish.
  await page.evaluate(() => {
    window.__install = (send) =>
      new Promise((resolve) => {
        send({ event: "Started", data: { contentLength: 100 } });
        send({ event: "Progress", data: { chunkLength: 40 } });
        window.__finishInstall = () => {
          send({ event: "Finished" });
          resolve(null);
        };
      });
  });
  const shown = await holds(async () => (await cover(page).count()) === 1);
  const text = shown ? await coverText(page) : "";
  step(
    "a minimum newer than this app covers the window: Update Doklin, the version that stops working, and one button",
    shown &&
      text.includes("Update Doklin") &&
      text.includes("This version of Doklin (v0.1.140) no longer works. Update it to keep going: everything you wrote stays as it is.") &&
      (await cover(page).getByRole("button").count()) === 1 &&
      (await cover(page).getByRole("button").textContent()) === "Update to v0.1.150 and restart",
    text,
  );
  step(
    "the button has the keyboard, and everything beneath is inert",
    await holds(() => page.evaluate(() => document.activeElement?.textContent === "Update to v0.1.150 and restart")) &&
      (await page.evaluate(() => document.querySelector(".app")?.inert === true)),
  );
  const tabsBefore = await page.locator(".tab").count();
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Control+n");
  await page.mouse.click(640, 430);
  await page.waitForTimeout(400);
  step(
    "a shortcut or a click beneath it does nothing",
    (await page.locator(".tab").count()) === tabsBefore && (await cover(page).count()) === 1,
    `${tabsBefore} → ${await page.locator(".tab").count()} tabs`,
  );

  await cover(page).getByRole("button").click();
  const downloading = await holds(async () => (await coverText(page)).includes("Downloading… 40%"));
  step("the button downloads, with its progress on the cover", downloading && (await updaterCalls(page)).includes("plugin:updater|download_and_install"), await coverText(page));
  await page.evaluate(() => window.__finishInstall());
  const restarted = await holds(async () => (await updaterCalls(page)).includes("plugin:process|restart"));
  step("…then installs and restarts into the new version", restarted && (await coverText(page)).includes("Restarting…"), await coverText(page));
  await close();
}

/* 2 — a minimum this app meets: the ordinary update, and no cover */
{
  const { page, close } = await open(found("0.1.150", "0.1.100"));
  await poll(async () => (await updaterCalls(page)).includes("plugin:updater|check"));
  await page.waitForTimeout(500);
  step("an update whose minimum this app meets covers nothing", (await cover(page).count()) === 0 && (await page.evaluate(() => document.querySelector(".app")?.inert === false)));
  await close();
}

/* 3 — a domain's worker turns this app away */
{
  // No newer release is out yet.
  const { page, close } = await open(null);
  await page.evaluate((s) => window.__setStatuses([s]), status());
  await page.waitForTimeout(300);
  const before = await cover(page).count();
  const said = "This is Doklin 0.1.140, and notes.example.com needs 0.1.150 or newer. Update Doklin to keep working.";
  await page.evaluate((s) => window.__setStatuses([s]), status({ phase: "app-outdated", error: said }));
  const shown = await holds(async () => (await cover(page).count()) === 1);
  const text = shown ? await coverText(page) : "";
  step(
    "a worker that turns this app away covers the window and names its domain",
    before === 0 && shown && text.includes("This version of Doklin (v0.1.140) no longer works with notes.example.com."),
    text,
  );
  step(
    "with no newer release out yet, it says so and can check again",
    text.includes("The update isn’t out yet. Try again in a few minutes.") && (await cover(page).getByRole("button", { name: "Check again" }).count()) === 1,
  );
  const footer = ((await page.locator('[data-testid="sync-status"]').textContent()) ?? "").trim();
  step("the sidebar's sync line, beneath it, says Update Doklin", footer === "Update Doklin", footer);

  // The release comes out, and the check that finds it fails.
  await page.evaluate(() => {
    window.__update = undefined;
  });
  const checks = (await updaterCalls(page)).length;
  await cover(page).getByRole("button", { name: "Check again" }).click();
  await poll(async () => (await updaterCalls(page)).length > checks);
  const failed = await holds(async () => (await coverText(page)).includes("Doklin couldn’t get the update. Try again, or download it from the releases page."));
  step("a check that fails offers to try again, and the releases page", failed && (await cover(page).getByRole("button").count()) === 2, await coverText(page));
  await cover(page).getByRole("button", { name: "Open the releases page" }).click();
  step("…which opens in the browser", await holds(() => page.evaluate((u) => (window.__opened ?? []).includes(u), RELEASES_PAGE)));

  await page.evaluate((s) => window.__setStatuses([s]), status());
  step("once the domain answers this app again, the cover lifts", await holds(async () => (await cover(page).count()) === 0));
  await close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
