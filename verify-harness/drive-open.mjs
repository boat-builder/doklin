// Drives the page every link goes through (site/public/open.html, served at
// doklin.cc/open) in real browsers, as the devices a link is clicked on:
//
//   - a computer with no Doklin app (Windows) is offered the browser
//     version, and goes to the link's own domain only on a click;
//   - "always" is kept for one domain and skips the page from then on; the
//     address with no link after it is where that is undone;
//   - a Mac is offered both, and the link is still handed to the app at once;
//   - a phone or a tablet is never offered the browser version, whatever
//     was ticked: an iPhone and an iPad keep the app's button, anything else
//     is told to use a computer;
//   - a link that names no domain a browser could be sent to is cut short.
//
// The page is served from this file as doklin.cc serves it (a static
// directory), and the link's domain is answered by the test, so nothing
// leaves this machine.
//
//   (cd verify-harness && npm install && npx playwright install)   # once
//   node verify-harness/drive-open.mjs                 # every engine installed
//   ENGINES=chromium node verify-harness/drive-open.mjs
import { chromium, firefox, webkit } from "playwright";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "public");
const ENGINES = { chromium, firefox, webkit };
const wanted = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",").map((s) => s.trim()).filter(Boolean);

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

/* ---------- doklin.cc, from the directory it is deployed from ---------- */

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const site = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://site").pathname));
  const file = join(SITE, extname(path) ? path : `${path}.html`);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((up) => site.listen(0, "127.0.0.1", up));
const OPEN = `http://127.0.0.1:${site.address().port}/open`;

/* ---------- A link, and who clicks it ---------- */

const DOMAIN = "notes.example.com";
const IDS = "w=w-0a1b2c3d4e5f&s=s-1a2b3c4d&f=f-9c8b7a6d5e4f";
const LINK = `#d=${DOMAIN}&${IDS}`;
const IN_BROWSER = `https://${DOMAIN}/app#${IDS}`;

const DESK = { viewport: { width: 1280, height: 800 }, screen: { width: 1920, height: 1080 } };
const WINDOWS = {
  ...DESK,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
const MAC = {
  ...DESK,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};
const IPHONE = {
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
};
// An iPad asking for the desktop site calls itself a Mac.
const IPAD = { ...MAC, viewport: { width: 820, height: 1180 }, screen: { width: 820, height: 1180 }, hasTouch: true };
const ANDROID = {
  viewport: { width: 412, height: 915 },
  screen: { width: 412, height: 915 },
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};
const fingers = (n) => `Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => ${n} });`;
const ALWAYS = `try { localStorage.setItem("browser:${DOMAIN}", "1"); } catch (e) {}`;

const settle = 900;

async function drive(name) {
  const browser = await ENGINES[name].launch();
  const say = (what, ok, detail) => step(`[${name}] ${what}`, ok, detail);

  /** A device: its pages, every address its browser went to on the link's
   *  domain, and every link it handed to the app (Chromium alone reports a
   *  scheme nothing answers, so the app's hand-off is counted there). */
  const device = async (options, prepare = "") => {
    const context = await browser.newContext(options);
    if (prepare) await context.addInitScript(prepare);
    const handed = [];
    await context.route(/^https:\/\//, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>the browser version</title>" }),
    );
    const visit = async (hash = LINK) => {
      const page = await context.newPage();
      page.on("request", (request) => {
        if (request.url().startsWith("doklin:")) handed.push(request.url());
      });
      await page.goto(OPEN + hash);
      await page.waitForTimeout(settle);
      return page;
    };
    return { context, visit, handed };
  };
  const seen = (page, id) => page.locator(`#${id}`).isVisible();
  const stayed = (page) => page.url().startsWith(OPEN);

  /* 1 — a computer with no app */
  const pc = await device(WINDOWS);
  let page = await pc.visit();
  say(
    "a Windows PC is shown the domain and Continue in browser, and no app to open or download",
    stayed(page) &&
      (await page.locator("#link .lead .domain").textContent()) === DOMAIN &&
      (await seen(page, "browser")) &&
      (await page.locator("#browser").getAttribute("class")) === "btn btn-primary" &&
      !(await seen(page, "open")) &&
      !(await seen(page, "download")) &&
      (await seen(page, "on-computer")) &&
      !(await seen(page, "on-mac")),
  );
  say("it waits for a click, and hands nothing to an app", stayed(page) && pc.handed.length === 0);
  await page.click("#browser");
  await page.waitForURL(IN_BROWSER).catch(() => {});
  say("Continue in browser goes to the domain's /app with the page's ids", page.url() === IN_BROWSER, page.url());
  page = await pc.visit();
  say("the next link waits again: nothing was remembered", stayed(page) && !(await page.locator("#always-box").isChecked()));

  /* 2 — always, for one domain */
  await page.check("#always-box");
  say(
    "ticking always is kept at once, and the page says where it is undone",
    (await page.evaluate((d) => localStorage.getItem(`browser:${d}`), DOMAIN)) === "1" && (await seen(page, "always-note")),
  );
  page = await pc.visit();
  say("from then on a link to that domain opens in the browser without a click", page.url() === IN_BROWSER, page.url());
  const other = await pc.visit(`#d=other.example.org&${IDS}`);
  say(
    "a link to another domain still waits, under its own name",
    stayed(other) && (await other.locator("#link .lead .domain").textContent()) === "other.example.org" && !(await other.locator("#always-box").isChecked()),
  );
  page = await pc.visit("");
  say(
    "the address with no link after it names the domain that is always opened",
    (await seen(page, "kept")) && (await page.locator("#kept-domains").textContent()) === DOMAIN && !(await seen(page, "cut")),
  );
  await page.click("#forget");
  say(
    "Ask me every time forgets it, and says so",
    (await page.evaluate((d) => localStorage.getItem(`browser:${d}`), DOMAIN)) === null && (await seen(page, "kept-gone")) && !(await seen(page, "forget")),
  );
  page = await pc.visit();
  say("the next link waits again", stayed(page) && (await seen(page, "browser")) && !(await page.locator("#always-box").isChecked()));
  await page.check("#always-box");
  await page.click("#browser");
  await page.waitForURL(IN_BROWSER).catch(() => {});
  await page.goBack();
  await page.waitForTimeout(settle);
  say(
    "Back after a click shows the choice, ticked, and goes nowhere",
    stayed(page) && (await seen(page, "browser")) && (await page.locator("#always-box").isChecked()),
    page.url(),
  );
  await page.uncheck("#always-box");
  say(
    "unticked there, it is forgotten",
    (await page.evaluate((d) => localStorage.getItem(`browser:${d}`), DOMAIN)) === null && !(await seen(page, "always-note")),
  );

  /* 3 — what is sent on */
  page = await pc.visit(`#d=${DOMAIN}&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f`);
  say(
    "a page of the shared workspace is sent on with no space",
    (await page.locator("#browser").getAttribute("href")) === `https://${DOMAIN}/app#w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f`,
  );
  page = await pc.visit(`#x=1&d=%20Notes.Example.COM%20&${IDS}&next=https%3A%2F%2Felsewhere.example`);
  say(
    "only the page's ids are sent on, to the domain in small letters",
    (await page.locator("#browser").getAttribute("href")) === IN_BROWSER,
    await page.locator("#browser").getAttribute("href"),
  );
  page = await pc.visit(`#d=127.0.0.1%3A8787&${IDS}`);
  say("a domain may have a port", (await page.locator("#browser").getAttribute("href")) === `https://127.0.0.1:8787/app#${IDS}`);
  for (const [what, hash] of [
    ["no file", `#d=${DOMAIN}&w=w-0a1b2c3d4e5f`],
    ["no workspace", `#d=${DOMAIN}&f=f-9c8b7a6d5e4f`],
    ["no domain", `#${IDS}`],
    ["a path in its domain", `#d=${DOMAIN}%2Fx&${IDS}`],
    ["somebody's name before its domain", `#d=${DOMAIN}%40elsewhere.example&${IDS}`],
    ["a question in its domain", `#d=${DOMAIN}%3Fx&${IDS}`],
    ["a domain that starts with a dash", `#d=-bad-.example.com&${IDS}`],
    ["a port that is not a number", `#d=${DOMAIN}%3Aweb&${IDS}`],
    ["nothing after the address", ""],
  ]) {
    page = await pc.visit(hash);
    say(`a link with ${what} is cut short, and offers nothing`, (await seen(page, "cut")) && !(await seen(page, "link")) && !(await seen(page, "browser")));
  }
  await pc.context.close();

  /* 4 — what is on the page as it skips itself (a driver cannot ask a
     page that is on its way out, so the page notes down what it shows) */
  const LEAVING = `new MutationObserver(function () {
    var going = document.getElementById("going");
    if (going && !going.hidden) localStorage.setItem("shown-on-leaving", going.textContent);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["hidden"] });`;
  const skipping = await device(WINDOWS, ALWAYS + LEAVING);
  await skipping.visit();
  page = await skipping.visit("");
  const shown = (await page.evaluate(() => localStorage.getItem("shown-on-leaving"))) ?? "";
  say(
    "a page that skips itself says where it is going, and where that is undone",
    shown.includes("Opening this page in your browser.") && shown.includes(DOMAIN) && shown.includes("doklin.cc/open"),
    shown.replace(/\s+/g, " ").trim().slice(0, 80),
  );
  await skipping.context.close();

  /* 5 — a browser that keeps nothing */
  const forgetful = await device(WINDOWS, `Object.defineProperty(window, "localStorage", { get() { throw new DOMException("no", "SecurityError"); } });`);
  page = await forgetful.visit();
  say("a browser that keeps nothing is not offered always, and can still continue", (await seen(page, "browser")) && !(await seen(page, "always")));
  await forgetful.context.close();

  /* 6 — a laptop with a touchscreen is a computer */
  const touch = await device({ ...WINDOWS, hasTouch: true }, fingers(10));
  page = await touch.visit();
  say("a Windows laptop with a touchscreen is offered the browser version", await seen(page, "browser"));
  await touch.context.close();

  /* 7 — a Mac */
  const mac = await device(MAC);
  page = await mac.visit();
  say(
    "a Mac is offered the app first, the browser beside it, and the download",
    stayed(page) &&
      (await seen(page, "open")) &&
      (await page.locator("#open").getAttribute("href")) === `doklin://open${LINK}` &&
      (await seen(page, "browser")) &&
      (await page.locator("#browser").getAttribute("class")) === "btn btn-ghost" &&
      (await seen(page, "download")) &&
      (await seen(page, "on-mac")) &&
      (await seen(page, "always")),
  );
  if (name === "chromium") {
    say("the link is handed to the app as soon as the page is up", mac.handed.length === 1 && mac.handed[0].startsWith("doklin://open"), mac.handed.join(" "));
  }
  await page.click("#browser");
  await page.waitForURL(IN_BROWSER).catch(() => {});
  await page.goBack();
  await page.waitForTimeout(settle);
  if (name === "chromium") say("a Back to the page does not hand it to the app again", stayed(page) && mac.handed.length === 1, String(mac.handed.length));
  await page.check("#always-box");
  mac.handed.length = 0;
  page = await mac.visit();
  say("a Mac that ticked always goes to the browser", page.url() === IN_BROWSER, page.url());
  if (name === "chromium") say("and the app is not asked", mac.handed.length === 0, mac.handed.join(" "));
  await mac.context.close();

  /* 8 — phones and tablets, each with always ticked from some earlier day */
  for (const [what, options, prepare] of [
    ["an iPhone", IPHONE, ALWAYS],
    ["an iPad asking for the desktop site", IPAD, ALWAYS + fingers(5)],
  ]) {
    const handheld = await device(options, prepare);
    page = await handheld.visit();
    say(
      `${what} keeps the app's button and is told Doklin there is an app`,
      stayed(page) && (await seen(page, "open")) && (await seen(page, "on-apple-handheld")) && !(await seen(page, "download")),
    );
    say(`${what} is never offered the browser version, whatever was ticked`, stayed(page) && !(await seen(page, "browser")) && !(await seen(page, "always")));
    if (name === "chromium") say(`${what} hands the link on only on a tap`, handheld.handed.length === 0);
    page = await handheld.visit("");
    say(`${what} is shown nothing to undo`, (await seen(page, "cut")) && !(await seen(page, "kept")));
    await handheld.context.close();
  }
  for (const [what, options] of [
    ["an Android phone", ANDROID],
    ["a small screen that names nothing", { ...WINDOWS, viewport: { width: 480, height: 800 }, screen: { width: 480, height: 800 } }],
  ]) {
    const handheld = await device(options, ALWAYS);
    page = await handheld.visit();
    say(
      `${what} is told to open the link on a computer, with nothing to press`,
      stayed(page) && (await seen(page, "elsewhere")) && !(await seen(page, "link")) && !(await seen(page, "open")) && !(await seen(page, "browser")),
    );
    await handheld.context.close();
  }

  await browser.close();
}

/** Whether an engine is there to drive; one that is not is skipped, and said. */
async function installed(name) {
  try {
    await (await ENGINES[name].launch()).close();
    return true;
  } catch (e) {
    console.log(`SKIP  ${name}: not installed here (${String(e.message).split("\n")[0]})`);
    return false;
  }
}

let driven = 0;
for (const name of wanted) {
  if (!ENGINES[name]) throw new Error(`no such engine: ${name} (chromium, firefox, webkit)`);
  if (!(await installed(name))) continue;
  driven += 1;
  await drive(name);
}
site.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed, in ${driven} of ${wanted.length} engines`);
process.exit(passed === results.length && driven > 0 ? 0 : 1);
