// Drives the browser version's side of the worker in real browsers, against
// the real worker served by serve-worker.mjs over the seed workspace
// (cloud-worker/test/seed.mjs). The worker's own tests (cloud-worker/test/
// run.mjs) hold what each route answers; this holds what only a browser can
// show — what it does with the cookie that is the sign-in:
//
//   - a code typed into a page of the domain signs the browser in, and the
//     script that sent it never sees the token: not in the answer, not in
//     document.cookie;
//   - the cookie is the browser's alone (HttpOnly), TLS-only (Secure, the
//     __Host- prefix), same-site (Strict), and kept for 400 days;
//   - with it, the app's own fetch is answered — the reads, a save — and
//     what a browser has no business doing is refused;
//   - the same cookie on anything but the app's own fetch counts for
//     nothing: an <img>, a frame, a link, the address bar, a page of another
//     origin on the same site;
//   - signing out takes the cookie and what the page kept;
//   - a stored copy is kept by the browser and not asked for twice, and
//     after signing out it is asked of the worker again, and refused.
//
// A real domain is https, and a Secure cookie needs it (WebKit keeps none
// over http, localhost included), so the worker is driven through a TLS
// front this file runs, with a certificate it makes for the run (`openssl`).
// The cache is the exception: a browser keeps nothing it read over a
// certificate it was told to overlook, so that part runs in Chromium over
// plain http.
//
//   (cd verify-harness && npm install && npx playwright install)   # once
//   node verify-harness/drive-web.mjs                 # every engine installed
//   ENGINES=chromium node verify-harness/drive-web.mjs
import { chromium, firefox, webkit } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINES = { chromium, firefox, webkit };
const wanted = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",").map((s) => s.trim()).filter(Boolean);

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/* ---------- The harness worker, and https in front of it ---------- */

let workerPid = null;
let OWNER;
const servers = [];
const scratch = mkdtempSync(join(tmpdir(), "doklin-drive-web-"));
const cleanUp = () => {
  if (workerPid) process.kill(workerPid);
  for (const s of servers) s.close();
  rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", cleanUp);

const WORKER_PORT = await freePort();
console.log(`starting the harness worker on http://localhost:${WORKER_PORT}…`);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(ROOT, "verify-harness/serve-worker.mjs"), "--no-mermaid"], {
    env: { ...process.env, PORT: String(WORKER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  workerPid = child.pid;
  let said = "";
  const hear = (chunk) => {
    said += chunk;
    OWNER ??= /superadmin token: ([0-9a-f]{64})/.exec(said)?.[1];
    if (said.includes("cloud worker on")) resolve();
  };
  child.stdout.on("data", hear);
  child.stderr.on("data", hear);
  child.on("error", reject);
  child.on("exit", (code) => {
    workerPid = null;
    reject(new Error(`the harness worker stopped (exit ${code}) before it was serving:\n${said}`));
  });
  setTimeout(() => reject(new Error(`the harness worker did not start within three minutes:\n${said}`)), 180_000).unref();
});

execFileSync(
  "openssl",
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", "key.pem", "-out", "cert.pem"],
  { cwd: scratch, stdio: "ignore" },
);
const tls = { key: readFileSync(join(scratch, "key.pem")), cert: readFileSync(join(scratch, "cert.pem")) };

/** What reached the worker: each request, and the status it was answered with. */
const answered = [];
/** The worker behind a front of this file's own, which writes down what passes. */
function front(listen) {
  return listen((req, res) => {
    const upstream = httpRequest(
      { host: "localhost", port: WORKER_PORT, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        answered.push({ method: req.method, path: req.url, status: answer.statusCode, cookie: Boolean(req.headers.cookie), dest: req.headers["sec-fetch-dest"], site: req.headers["sec-fetch-site"] });
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(upstream);
  });
}
const PORT = await freePort();
const ORIGIN = `https://localhost:${PORT}`;
servers.push(front((handle) => createHttpsServer(tls, handle).listen(PORT)));
/** The same worker over plain http, for the one thing a certificate made
 *  for the run gets in the way of: a browser caches nothing it read over a
 *  certificate it was told to overlook. */
const PLAIN_PORT = await freePort();
const PLAIN = `http://localhost:${PLAIN_PORT}`;
servers.push(front((handle) => createHttpServer(handle).listen(PLAIN_PORT)));
/** Another origin of the same site: a page somebody else serves on a host
 *  beside the workspace's. */
const OTHER_PORT = await freePort();
const OTHER = `https://localhost:${OTHER_PORT}`;
servers.push(
  createHttpsServer(tls, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>elsewhere</title>");
  }).listen(OTHER_PORT),
);
/** And a page of another site altogether. */
const FAR_PORT = await freePort();
const FAR = `http://127.0.0.1:${FAR_PORT}`;
servers.push(
  createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>far away</title>");
  }).listen(FAR_PORT),
);

/** The owner's own calls, as their Mac would make them. */
const owner = (path, { json, ...init } = {}) =>
  fetch(`http://localhost:${WORKER_PORT}${path}`, {
    ...init,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    headers: { authorization: `Bearer ${OWNER}`, "x-doklin-device": "d-seed", ...(json === undefined ? {} : { "content-type": "application/json" }) },
  });
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A code for another device of the owner's, as their app mints one. */
async function deviceCode() {
  const body = Array.from({ length: 20 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("");
  const made = await owner("/api/auth/devices/code", {
    method: "POST",
    json: { codeHash: createHash("sha256").update(body).digest("hex"), expiresAt: Date.now() + 3_600_000 },
  });
  if (made.status !== 201) throw new Error(`could not mint a device code: ${made.status}`);
  return `dkln-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
}
/** A page of the domain to stand on. */
const HOME = `${ORIGIN}/robots.txt`;

/* ---------- One engine ---------- */

async function drive(name) {
  const say = (what, ok, detail) => step(`${name}: ${what}`, ok, detail);
  let browser;
  try {
    browser = await ENGINES[name].launch();
  } catch (e) {
    console.log(`SKIP  ${name}: not installed here (${String(e.message).split("\n")[0]})`);
    return false;
  }
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  // A document of the domain that is under no policy of its own, as the
  // app's page will be. (A public page could not make these requests at all:
  // its policy lets it fetch nothing.)
  await page.goto(HOME);
  /** `fetch` from the page, as the app's script will: status, body, headers. */
  const ask = (path, init = {}) =>
    page.evaluate(
      async ([path, init]) => {
        const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-doklin-device": "d-drive-web", ...init.headers } });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not json
        }
        return { status: res.status, json, cache: res.headers.get("cache-control") };
      },
      [path, init],
    );
  const session = async () => (await context.cookies(ORIGIN)).find((c) => c.name === "__Host-doklin");

  /* 1 — signing in */
  say("before a code, nobody: the reads are refused", (await ask("/api/meta")).status === 401);
  const signed = await ask("/api/web/session", {
    method: "POST",
    body: JSON.stringify({ code: await deviceCode(), deviceId: "d-drive-web", deviceName: `${name}, driven` }),
  });
  say(
    "a code signs the browser in, and the answer holds no token",
    signed.status === 201 && Boolean(signed.json?.tokenId) && !("token" in signed.json) && !JSON.stringify(signed.json).includes("dkw_"),
    JSON.stringify(signed),
  );
  say("script cannot read the cookie", (await page.evaluate(() => document.cookie)) === "");
  const cookie = await session();
  const days = cookie ? (cookie.expires - Date.now() / 1000) / 86_400 : 0;
  say(
    "the cookie is the browser's alone, TLS-only, same-site, the host's and no other's, kept 400 days",
    Boolean(cookie) && cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict" && cookie.path === "/" && cookie.domain === "localhost" && days > 399 && days <= 400,
    cookie ? `${Math.round(days)} days, sameSite ${cookie.sameSite}` : "no cookie kept",
  );
  if (!cookie) {
    await browser.close();
    return true;
  }

  /* 2 — with it */
  const me = await ask("/api/meta");
  say("the app's own fetch is answered as the person", me.status === 200 && me.json?.you?.tokenId === signed.json.tokenId);
  const manifest = await ask("/api/manifest");
  const [fid, file] = Object.entries(manifest.json?.files ?? {})[0] ?? [];
  say("the manifest is read", manifest.status === 200 && Boolean(fid));
  const saved = await ask(`/api/web/doc?path=${encodeURIComponent(`driven/${name}.md`)}`, {
    method: "PUT",
    body: JSON.stringify({ md: { text: `# Saved from ${name}\n`, ifRev: null } }),
  });
  say("a note is saved", saved.status === 200 && saved.json?.md?.rev === 1, JSON.stringify(saved.json));
  const put = await ask("/api/manifest", { method: "PUT", headers: { "x-base-etag": "x" }, body: JSON.stringify(manifest.json) });
  say("putting a manifest is not a browser's to do", put.status === 403, String(put.status));
  const codes = await ask("/api/auth/devices/code", { method: "POST", body: JSON.stringify({ codeHash: "0".repeat(64), expiresAt: Date.now() + 1000 }) });
  say("nor is minting a code for another device", codes.status === 403, String(codes.status));

  /* 3 — a stored copy comes with leave to keep it */
  const blob = `/api/blobs/${fid}/${file.hash}`;
  const first = await ask(blob);
  say("a stored copy may be kept for good, by this browser alone", first.status === 200 && first.cache === "private, max-age=31536000, immutable", String(first.cache));

  /* 4 — the cookie on anything but the app's own fetch */
  const refusedAs = async (what, path, make) => {
    const before = answered.length;
    await make();
    await page.waitForTimeout(400);
    const hit = answered.slice(before).find((a) => a.path.startsWith(path));
    say(
      `${what}: the cookie goes along and counts for nothing`,
      Boolean(hit) && hit.cookie && hit.status === 401,
      hit ? `${hit.status}, cookie ${hit.cookie ? "sent" : "not sent"}, dest ${hit.dest}` : "the request never reached the worker",
    );
  };
  await refusedAs("an <img>", "/api/poll?img", () =>
    page.evaluate(() => new Promise((done) => {
      const img = new Image();
      img.onload = img.onerror = () => done();
      img.src = "/api/poll?img";
    })),
  );
  await refusedAs("a frame", "/api/poll?frame", () =>
    page.evaluate(() => new Promise((done) => {
      const frame = document.createElement("iframe");
      frame.onload = () => done();
      frame.src = "/api/poll?frame";
      document.body.append(frame);
    })),
  );
  await refusedAs("a link followed", "/api/poll?link", async () => {
    const tab = await context.newPage();
    await tab.goto(HOME);
    await tab.evaluate(() => {
      const a = document.createElement("a");
      a.href = "/api/poll?link";
      a.textContent = "a link in a note";
      document.body.append(a);
    });
    await Promise.all([tab.waitForNavigation(), tab.click("a")]);
    await tab.close();
  });
  await refusedAs("a no-cors fetch", "/api/poll?nocors", () => page.evaluate(() => fetch("/api/poll?nocors", { mode: "no-cors" }).then(() => undefined)));
  say("and none of that cost the browser its sign-in", (await ask("/api/poll")).status === 200 && Boolean(await session()));

  // A page of another origin on the same site: the cookie may go along
  // (SameSite is about sites, not origins), and must count for nothing.
  const beside = await context.newPage();
  await beside.goto(`${OTHER}/`);
  let before = answered.length;
  await beside.evaluate((url) => fetch(url, { method: "POST", mode: "no-cors", credentials: "include", body: "{}" }).catch(() => undefined), `${ORIGIN}/api/poll?beside`);
  await beside.waitForTimeout(400);
  let hit = answered.slice(before).find((a) => a.path.startsWith("/api/poll?beside"));
  say("a page of another origin on the same site is nobody", Boolean(hit) && hit.status === 401, hit ? `${hit.status}, site ${hit.site}, cookie ${hit.cookie ? "sent" : "not sent"}` : "never reached the worker");
  const typedElsewhere = await beside.evaluate(
    (url) =>
      fetch(url, { method: "POST", mode: "no-cors", credentials: "include", headers: { "content-type": "text/plain" }, body: JSON.stringify({ code: "dkln-AAAAA-AAAAA-AAAAA-AAAAA" }) })
        .then(() => "sent")
        .catch(() => "blocked"),
    `${ORIGIN}/api/web/session`,
  );
  await beside.waitForTimeout(300);
  hit = answered.findLast((a) => a.path === "/api/web/session" && a.site !== "same-origin");
  say("…and cannot sign this browser in to an account of its choosing", typedElsewhere === "blocked" || hit?.status === 403, hit ? String(hit.status) : typedElsewhere);
  await beside.close();

  const far = await context.newPage();
  await far.goto(`${FAR}/`);
  before = answered.length;
  await far.evaluate((url) => fetch(url, { mode: "no-cors", credentials: "include" }).catch(() => undefined), `${ORIGIN}/api/poll?far`);
  await far.waitForTimeout(400);
  hit = answered.slice(before).find((a) => a.path.startsWith("/api/poll?far"));
  say("a page of another site: the browser does not even send the cookie", Boolean(hit) && !hit.cookie && hit.status === 401, hit ? `${hit.status}, cookie ${hit.cookie ? "sent" : "not sent"}` : "never reached the worker");
  await far.close();

  /* 5 — signing out */
  await page.evaluate(() => localStorage.setItem("doklin:kept", "a draft"));
  const out = await ask("/api/auth/session", { method: "DELETE" });
  await page.waitForTimeout(300);
  say("signing out is answered", out.status === 204, String(out.status));
  say("the cookie is gone", !(await session()));
  say("what the page kept is gone with it", (await page.evaluate(() => localStorage.getItem("doklin:kept"))) === null);
  say("and the reads are refused again", (await ask("/api/meta")).status === 401 && (await ask(blob)).status === 401);

  await browser.close();
  return true;
}

/* ---------- What a browser keeps, and stops keeping ---------- */

/** Over plain http, where Chromium caches as it does on a real domain (and
 *  takes a Secure cookie, localhost being what it is). */
async function driveCache() {
  const say = (what, ok, detail) => step(`chromium, cache: ${what}`, ok, detail);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${PLAIN}/robots.txt`);
  const ask = (path, init = {}) =>
    page.evaluate(
      async ([path, init]) => {
        const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-doklin-device": "d-drive-cache" } });
        const text = await res.text();
        return { status: res.status, text };
      },
      [path, init],
    );
  const reached = (path) => answered.filter((a) => a.path === path).length;

  const signed = await ask("/api/web/session", {
    method: "POST",
    body: JSON.stringify({ code: await deviceCode(), deviceId: "d-drive-cache", deviceName: "chromium, cache" }),
  });
  const manifest = JSON.parse((await ask("/api/manifest")).text);
  const [fid, file] = Object.entries(manifest.files)[0];
  const blob = `/api/blobs/${fid}/${file.hash}`;
  const before = reached(blob);
  const first = await ask(blob);
  const second = await ask(blob);
  say(
    "a stored copy is read once and answered from the browser after",
    signed.status === 201 && first.status === 200 && second.text === first.text && reached(blob) === before + 1,
    `${reached(blob) - before} request(s) for two reads`,
  );
  const out = await ask("/api/auth/session", { method: "DELETE" });
  await page.waitForTimeout(300);
  const after = await ask(blob);
  say(
    "after signing out the copy is asked of the worker again, and refused",
    out.status === 204 && after.status === 401 && reached(blob) === before + 2,
    `${after.status}, ${reached(blob) - before} request(s) in all`,
  );
  await browser.close();
}

let driven = 0;
for (const name of wanted) {
  if (!ENGINES[name]) throw new Error(`no such engine: ${name} (chromium, firefox, webkit)`);
  if (await drive(name)) driven += 1;
}
if (wanted.includes("chromium")) await driveCache();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed, in ${driven} of ${wanted.length} engines`);
process.exit(passed === results.length && driven > 0 ? 0 : 1);
