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
// And the browser version itself, as the web directory serves it at /app
// (app.html, src/web/) — the page a release ships, not a development build:
//
//   - the page's files and the policy each is served under;
//   - a link in the address survives the sign-in screen and opens its page;
//   - the sign-in screen says what is wrong with what was pasted, and loads
//     none of the editor until somebody is signed in;
//   - the tree is the workspace's documents, a note and an html document
//     open and read, comments come from the sidecar, a diagram draws, and
//     nothing a note carries runs as script;
//   - what somebody else changes arrives by itself;
//   - the page refuses to be framed, a phone and an old browser get a
//     sentence and none of the app, and a browser signed out from elsewhere
//     is back at the sign-in screen.
//
// And what it writes (src/web/saving.ts), with a second browser as somebody
// else:
//
//   - what is typed is saved once the typing settles, no more often than a
//     document's pace allows, and at once when the page loses attention;
//   - a save over a document that moved on is merged, and one that overlaps
//     leaves the other version beside it as a conflict copy;
//   - the browser says which document it is editing: a Mac that takes the
//     document over turns it view-only here, until it is taken back;
//   - a note made from the tree as Untitled and named by its title, then
//     renamed, copied and deleted from the tree, and a folder that is real
//     once a note is in it;
//   - closing with unsaved text asks first, and what was typed is sent as
//     the page goes; what could not be sent is sent the next time the
//     workspace is opened in that browser;
//   - every request says which release the page is, and a worker of another
//     release covers the page with a Reload, which asks nothing, stops the
//     app's shortcuts, and keeps what was typed for the page it brings;
//   - two tabs ask the worker as one;
//   - a browser that kept a draft, its tabs and its tree from before the
//     Library layout has them moved into Library once, and the draft is sent.
//
// And people, devices and agents (the `access` group, src/web/backend.ts),
// where a code is made on the page (src/web/codes.ts):
//
//   - an owner invites somebody from a browser, and only the code's sha256
//     reaches the worker;
//   - somebody with no Mac signs in with that invite, adds a second browser
//     and a Mac with lines their browser made, and signs one of them out;
//   - they add an agent, which logs in with the code on the page, and log
//     its machine out;
//   - a member is offered nothing that is an owner's, and an owner changes
//     a role and removes a person from a browser.
//
// And restricted folders (the `spaces` group), with a second person's
// browser beside the owner's:
//
//   - one is made with a person in it, who sees it; people are taken out and
//     put in from Manage access…;
//   - a folder of more files than the worker moves at once becomes one
//     (Restrict access…) in as many requests as it takes, and the note open
//     in it follows;
//   - a private note is shared into a new folder, and a folder dropped on
//     Restricted becomes one;
//   - a restricting that stops part of the way says how much went and where
//     the rest is, and one that moves nothing leaves no folder behind;
//   - a folder is left, and deleted for everyone.
//
// And tags (the `tags` group), which the worker's index answers in a browser:
//
//   - `status:Doing` in search lists the notes with that tag, asked of the
//     worker as a tag and no text, and words beside a tag find lines in
//     those notes alone;
//   - a value renamed in *Edit status…* rewrites the list, the open note and
//     every other note that has it, found by that same search.
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
//   PARTS=writing node verify-harness/drive-web.mjs   # files, cookie, app, writing, rest, access, folders, tags, cache
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
const parts = new Set((process.env.PARTS ?? "files,cookie,app,writing,rest,access,folders,tags,cache").split(",").map((s) => s.trim()));

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
  const child = spawn(process.execPath, [join(ROOT, "verify-harness/serve-worker.mjs")], {
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
/** A request the front answers in the worker's place, when a part of the
 *  drive wants one refused: `(req) => {status, error} | null`. */
let refusing = null;
/** What the front tells the worker a page's release is, in the page's place:
 *  a tab of another release than the worker's, when a part of the drive wants one. */
let staleAs = null;
/** The worker behind a front of this file's own, which writes down what passes. */
function front(listen) {
  return listen((req, res) => {
    const refusal = refusing?.(req) ?? null;
    if (refusal) {
      req.resume();
      answered.push({ method: req.method, path: req.url, status: refusal.status, at: Date.now(), refused: true });
      res.writeHead(refusal.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: refusal.error }));
      return;
    }
    // What a save carried: which of a document's parts. And what was asked
    // of a page: its address.
    const save = req.method === "PUT" && req.url.startsWith("/api/web/doc");
    const publish = req.method === "PUT" && req.url.startsWith("/api/web/pages");
    // And what a call that makes a code carried, whole; so with one that
    // makes a restricted folder.
    const coded = req.method === "POST" && (req.url.startsWith("/api/auth/") || req.url === "/api/spaces");
    const sent = [];
    if (save || publish || coded) req.on("data", (chunk) => sent.push(chunk));
    const upstream = httpRequest(
      {
        host: "localhost",
        port: WORKER_PORT,
        method: req.method,
        path: req.url,
        headers: staleAs && req.headers["x-doklin-client"] ? { ...req.headers, "x-doklin-client": staleAs } : req.headers,
      },
      (answer) => {
        let parts;
        let slug;
        try {
          if (save) parts = Object.keys(JSON.parse(Buffer.concat(sent).toString()));
          if (publish) slug = JSON.parse(Buffer.concat(sent).toString()).slug ?? null;
        } catch {
          // not a body of the app's
        }
        const body = coded ? Buffer.concat(sent).toString() : undefined;
        answered.push({ method: req.method, path: req.url, status: answer.statusCode, at: Date.now(), parts, slug, body, cookie: Boolean(req.headers.cookie), dest: req.headers["sec-fetch-dest"], site: req.headers["sec-fetch-site"], client: req.headers["x-doklin-client"] });
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
/** The workspace's root as the app names it: the seed's workspace is "Notes". */
const ROOT_NAME = "/Notes";
/** Where the shared section's documents are in the tree: its own folder
 *  (`LIBRARY_FOLDER`, cloud-worker/src/layout.ts). What the worker stores
 *  and is sent is relative to the section, without it. */
const LIBRARY = `${ROOT_NAME}/Library`;

/* ---------- One engine ---------- */

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

async function drive(name) {
  const say = (what, ok, detail) => step(`${name}: ${what}`, ok, detail);
  const browser = await ENGINES[name].launch();
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
  const history = await ask("/api/versions/index");
  say("nor is the version store", history.status === 403, String(history.status));

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

/* ---------- The page under /app ---------- */

/** The page's files, and what each is served under. */
async function driveFiles() {
  const say = (what, ok, detail) => step(`the page's files: ${what}`, ok, detail);
  const get = (path) => fetch(`${PLAIN}${path}`, { redirect: "manual" });
  const page = await get("/app");
  const html = await page.text();
  const policy = Object.fromEntries(
    (page.headers.get("content-security-policy") ?? "").split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...rest]) => [name, rest.join(" ")]),
  );
  say("/app is the page, asked for again on every visit", page.status === 200 && /text\/html/.test(page.headers.get("content-type") ?? "") && page.headers.get("cache-control") === "no-cache");
  say(
    "script runs from the domain's own files and nowhere else, and the page talks to the domain alone",
    policy["default-src"] === "'none'" && policy["script-src"] === "'self'" && policy["connect-src"] === "'self'" && policy["base-uri"] === "'none'" && policy["form-action"] === "'none'",
    JSON.stringify(policy),
  );
  say("nothing may frame it", policy["frame-ancestors"] === "'none'" && page.headers.get("x-frame-options") === "DENY");
  const entry = /<script type="module"[^>]* src="(\/app\/assets\/[^"]+)"/.exec(html)?.[1];
  const script = entry ? await get(entry) : null;
  say("its scripts are named by their content and kept for good", script?.status === 200 && script.headers.get("cache-control") === "public, max-age=31536000, immutable", entry ?? "no script in the page");
  say("no script is written into the page itself", !/<script(?![^>]* src=)[^>]*>/.test(html));
  const frame = await get("/app/frame");
  say(
    "the page an html document is shown in is sandboxed, and only this domain's pages frame it",
    frame.status === 200 && (frame.headers.get("content-security-policy") ?? "").startsWith("sandbox allow-scripts allow-popups;") && /frame-ancestors 'self'/.test(frame.headers.get("content-security-policy") ?? ""),
    frame.headers.get("content-security-policy") ?? "no policy",
  );
  const spelled = await get("/app.html");
  say("the page has one address", spelled.status === 307 && spelled.headers.get("location") === "/app", `${spelled.status} ${spelled.headers.get("location")}`);
}

/** A second browser of the owner's, signed in: somebody else, for the app to hear of. */
async function elsewhere(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(HOME);
  const ask = (path, init = {}) =>
    page.evaluate(
      async ([path, init]) => {
        const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-doklin-device": "d-drive-other" } });
        return { status: res.status, json: await res.json().catch(() => null) };
      },
      [path, init],
    );
  const signed = await ask("/api/web/session", { method: "POST", body: JSON.stringify({ code: await deviceCode(), deviceId: "d-drive-other", deviceName: "Somebody else" }) });
  if (signed.status !== 201) throw new Error(`the second browser could not sign in: ${signed.status}`);
  return { ask, close: () => context.close() };
}

async function driveApp(name) {
  const say = (what, ok, detail) => step(`${name}, the app: ${what}`, ok, detail);
  const browser = await ENGINES[name].launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  /** What the page's policy refused, and what the page threw. */
  const trouble = [];
  let stage = "starting";
  page.on("console", (m) => {
    if (process.env.DEBUG_DRIVE) console.log(`  [${stage}] console.${m.type()}: ${m.text().slice(0, 200)}`);
    if (/Content Security Policy|Content-Security-Policy|Refused to/i.test(m.text())) trouble.push(`${stage}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => trouble.push(`${stage}: ${String(e).slice(0, 200)}`));
  if (process.env.DEBUG_DRIVE) {
    page.on("response", (r) => r.status() >= 400 && console.log(`  [${stage}] ${r.status()} ${r.request().method()} ${r.url()}`));
  }
  const assetsAsked = (from) => answered.slice(from).filter((a) => a.path.startsWith("/app/assets/") && a.path.endsWith(".js")).length;
  const row = (path) => page.locator(`[title="${LIBRARY}/${path}"]`).last();
  const editorText = () => page.evaluate(() => document.querySelector(".ProseMirror")?.innerText ?? "");
  const invite = () => page.locator('[data-testid="web-invite"]');
  const error = () => page.locator('[data-testid="web-error"]').innerText({ timeout: 10_000 }).catch(() => "");
  const paste = async (text) => {
    await invite().fill(text);
    await page.click('[data-testid="web-sign-in"]');
  };

  const manifest = await (await owner("/api/manifest")).json();
  const fidOf = (path) => Object.entries(manifest.files).find(([, f]) => f.path === path)?.[0];
  const { id: wsId } = (await (await owner("/api/meta")).json()).workspace;

  /* 1 — signed out, on a link */
  stage = "signed out, on a link";
  let from = answered.length;
  await page.goto(`${ORIGIN}/app#w=${wsId}&f=${fidOf("Ideas.md")}`);
  await invite().waitFor({ timeout: 30_000 });
  const beforeSignIn = assetsAsked(from);
  say("signed out, the page is the sign-in screen", (await page.locator("h1.web-title").innerText()).startsWith("Sign in to localhost"));

  await paste("hello there");
  say("something that holds no code is said to hold none", /no invite code/.test(await error()), await error());
  await paste("doklin-invite https://notes.elsewhere.example dkln-AAAAA-AAAAA-AAAAA-AAAAA");
  say("an invite for another domain says where to take it", /is for notes\.elsewhere\.example\. Open https:\/\/notes\.elsewhere\.example\/app/.test(await error()), await error());
  await paste("dkln-AAAAA-AAAAA-AAAAA-AAAAA");
  say("a code nobody made is refused in a sentence", /isn't valid/.test(await error()), await error());
  say("and none of that signed anybody in", !(await context.cookies(ORIGIN)).some((c) => c.name === "__Host-doklin"));

  /* 2 — signing in */
  stage = "signing in";
  await paste(`doklin-invite ${ORIGIN} ${await deviceCode()}`);
  await row("Home.md").waitFor({ timeout: 60_000 });
  say("the line somebody was sent signs the browser in, and the app opens on the workspace", true);
  say("the editor is not asked for until somebody is signed in", beforeSignIn > 0 && assetsAsked(from) > beforeSignIn, `${beforeSignIn} script(s) for the sign-in screen, ${assetsAsked(from)} once signed in`);
  say("script cannot read the sign-in", (await page.evaluate(() => document.cookie)) === "");
  const mine = await page.evaluate(() => localStorage.getItem("doklin:web:device"));
  const listed = (await (await owner("/api/auth/devices")).json()).devices.find((d) => d.deviceId === mine);
  say("the browser is one of the person's devices, by a name a person can read", / on (a Mac|Windows|Linux)$/.test(listed?.deviceName ?? "") || ["Chrome", "Firefox", "Safari", "Edge"].includes(listed?.deviceName), listed?.deviceName ?? "not listed");

  /* 3 — the link that was in the address */
  stage = "the link that was in the address";
  const opened = await page
    .waitForFunction(() => /A teleporter/.test(document.querySelector(".ProseMirror")?.innerText ?? ""), null, { timeout: 30_000 })
    .then(() => true, () => false);
  say("the page the link named opens once signed in", opened, (await editorText()).replace(/\s+/g, " ").slice(0, 60));
  say("and the link is gone from the address", page.url() === `${ORIGIN}/app`, page.url());

  /* 4 — the tree */
  stage = "the tree";
  const titles = await page.evaluate(() => [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title")));
  const has = (path) => titles.includes(`${LIBRARY}/${path}`);
  say("the tree is the workspace's documents and folders", has("Home.md") && has("Scratch.md") && has("Projects") && has("Diagram.md"));
  const headings = (await page.locator(".sidebar-section-label").allInnerTexts()).map((t) => t.trim());
  say(
    "the shared ones are under Library, the tree's first heading, and none is at the workspace's top",
    headings[0] === "Library" && !headings.includes("Workspace") && (await page.locator('[data-testid="section-library"]').count()) === 1 && !titles.includes(`${ROOT_NAME}/Home.md`),
    headings.join(" · "),
  );
  await row("Projects").click();
  await row("Projects/plan.md").waitFor({ timeout: 10_000 });
  const inFolder = await page.evaluate(() => [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title")));
  say(
    "a note's html rendition and its sidecar are not rows of their own",
    inFolder.includes(`${LIBRARY}/Projects/plan.md`) && !inFolder.includes(`${LIBRARY}/Projects/plan.html`) && !inFolder.some((t) => t?.endsWith(".meta.jsonl")),
  );
  say("the person's own section is there", (await page.getByText("Private", { exact: true }).count()) > 0);

  /* 5 — reading */
  stage = "reading";
  from = answered.length;
  await row("Home.md").click();
  await page.waitForFunction(() => /Welcome\./.test(document.querySelector(".ProseMirror")?.innerText ?? ""), null, { timeout: 30_000 });
  say("a note opens and reads", true);
  await page.waitForTimeout(800);
  const strays = answered.slice(from).filter((a) => !a.path.startsWith("/api/") && !a.path.startsWith("/app"));
  say("a picture the note names by a path is asked of nobody", strays.length === 0, strays.map((a) => a.path).join(", "));

  await row("Projects/plan.md").click();
  await page.waitForFunction(() => /Ship it by June/.test(document.querySelector(".ProseMirror")?.innerText ?? ""), null, { timeout: 30_000 });
  await page.locator('.view-toggle [role="tab"]', { hasText: "HTML" }).click();
  const shown = page.frameLocator("iframe.html-preview");
  const rendered = await shown.locator("#rendered").innerText({ timeout: 20_000 }).catch((e) => `nothing: ${String(e).split("\n")[0]}`);
  say("an html document is shown, in the page that is served for it", rendered === "Rendered by hand." && (await page.getAttribute("iframe.html-preview", "src")) === "/app/frame", rendered);
  say("its own script runs there", (await shown.locator("body").getAttribute("data-ran").catch(() => null)) === "yes");
  // The probe is this drive's own: a browser that refuses it may say so as
  // an error on the page, which is the answer wanted and not the app's trouble.
  const untroubled = trouble.length;
  const inside = await shown.locator("body").evaluate(async () => ({
    origin: self.origin,
    api: await fetch("/api/meta", { credentials: "include" }).then((r) => r.status, () => "blocked"),
  }));
  await page.waitForTimeout(300);
  trouble.length = untroubled;
  say("under an origin that is nobody's, with no sign-in to send", inside.origin === "null" && inside.api !== 200, JSON.stringify(inside));

  await row("Comments.md").click();
  await page.getByText("Say it plainer.").first().waitFor({ timeout: 30_000 });
  say("a note's comments come with it, from its sidecar", true);

  await row("Diagram.md").click();
  await page.locator(".dk-flowchart > svg[role=img]").first().waitFor({ timeout: 60_000 });
  say("a flowchart draws under the page's policy", true);
  say("and nothing a note carries runs as script", (await page.evaluate(() => document.documentElement.dataset.ran ?? null)) === null);

  /* 6 — what somebody else changes */
  stage = "what somebody else changes";
  const other = await elsewhere(browser);
  const fresh = await other.ask(`/api/web/doc?path=${encodeURIComponent(`Fresh from ${name}.md`)}`, { method: "PUT", body: JSON.stringify({ md: { text: "# Fresh\n", ifRev: null } }) });
  await row("Scratch.md").click();
  // By its heading: the engines share one worker, and the one driven before
  // this left the note rewritten.
  await page.waitForFunction(() => /^\s*Scratch/.test(document.querySelector(".ProseMirror")?.innerText ?? ""), null, { timeout: 30_000 });
  const scratch = (await other.ask("/api/manifest")).json.files[fidOf("Scratch.md")];
  const rewritten = await other.ask("/api/web/doc?path=Scratch.md", { method: "PUT", body: JSON.stringify({ md: { text: `# Scratch\n\nRewritten elsewhere, seen from ${name}.\n`, ifRev: scratch.rev } }) });
  const arrived = await row(`Fresh from ${name}.md`).waitFor({ timeout: 80_000 }).then(() => true, () => false);
  say("a document somebody else makes appears in the tree by itself", fresh.status === 200 && arrived, String(fresh.status));
  const reread = await page
    .waitForFunction((who) => (document.querySelector(".ProseMirror")?.innerText ?? "").includes(`seen from ${who}`), name, { timeout: 80_000 })
    .then(() => true, () => false);
  say("and the open one is read again when somebody else writes it", rewritten.status === 200 && reread, String(rewritten.status));
  await other.close();

  /* 7 — a link while the app is up, and one that opens nothing */
  stage = "a link while the app is up, and one that opens nothing";
  await page.evaluate((hash) => (location.hash = hash), `w=${wsId}&f=${fidOf("Projects/status.md")}`);
  await page.waitForFunction(() => /Where things stand/.test(document.querySelector(".ProseMirror")?.innerText ?? ""), null, { timeout: 30_000 });
  say("a link followed while the app is open opens its page", page.url() === `${ORIGIN}/app`, page.url());
  await page.evaluate((hash) => (location.hash = hash), `w=${wsId}&f=f-000000000000`);
  const gone = await page.getByText(/isn't one you can open in Notes/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  say("a link to a page that is not there says so, the same for deleted and not yours", gone);

  /* 8 — coming back */
  stage = "coming back";
  await page.reload();
  await page.waitForFunction(() => /Where things stand/.test(document.querySelector(".ProseMirror")?.innerText ?? ""), null, { timeout: 60_000 });
  say("a reload is still signed in, on the page that was open", (await invite().count()) === 0);
  say("the page's policy refused nothing, and the page threw nothing", trouble.length === 0, trouble.slice(0, 3).join(" | "));

  /* 9 — framed by somebody else */
  stage = "framed by somebody else";
  const beside = await context.newPage();
  await beside.goto(`${OTHER}/`);
  await beside.evaluate((url) => new Promise((done) => {
    const frame = document.createElement("iframe");
    frame.onload = frame.onerror = () => done();
    frame.src = url;
    document.body.append(frame);
    setTimeout(done, 3000);
  }), `${ORIGIN}/app`);
  await beside.waitForTimeout(1500);
  const framed = beside.frames().find((f) => f !== beside.mainFrame());
  const inFrame = framed ? await framed.locator("#root").count().catch(() => 0) : 0;
  say("another origin cannot frame the page", inFrame === 0, framed ? framed.url() : "no frame");
  await beside.close();

  /* 10 — signed out from somewhere else */
  stage = "signed out from somewhere else";
  const signedOut = await owner(`/api/auth/devices/${listed?.id}`, { method: "DELETE" });
  const back = await invite().waitFor({ timeout: 80_000 }).then(() => true, () => false);
  say("signed out from Devices, the browser is back at the sign-in screen", signedOut.status === 204 && back, String(signedOut.status));
  say("and holds no sign-in", !(await context.cookies(ORIGIN)).some((c) => c.name === "__Host-doklin"));
  await context.close();

  /* 11 — who is not shown the app */
  stage = "who is not shown the app";
  const stopped = async (what, options, prepare, gate) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
    if (prepare) await ctx.addInitScript(prepare);
    const visitor = await ctx.newPage();
    const start = answered.length;
    await visitor.goto(`${ORIGIN}/app`);
    await visitor.waitForTimeout(1500);
    const told = await visitor.locator(gate).isVisible();
    const signIn = await visitor.locator('[data-testid="web-invite"]').count();
    say(`${what} is told why in a sentence, with no sign-in and none of the app`, told && signIn === 0 && assetsAsked(start) <= 1, `${assetsAsked(start)} script(s) asked for`);
    await ctx.close();
  };
  await stopped(
    "a phone",
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", viewport: { width: 390, height: 844 }, hasTouch: true },
    null,
    "#gate-handheld",
  );
  await stopped("a browser too old for the editor", {}, () => delete URL.canParse, "#gate-old");

  await browser.close();
}

/* ---------- What the app writes ---------- */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** `probe`'s first truthy answer, asked until `ms` have gone; null after. */
async function until(probe, ms = 20_000, every = 200) {
  for (const end = Date.now() + ms; ; ) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
/** A file of the shared workspace as the worker holds it now, with its text. */
async function storedAt(path) {
  const m = await (await owner("/api/manifest")).json();
  const found = Object.entries(m.files).find(([, f]) => f.path === path);
  if (!found) return null;
  const [fid, file] = found;
  return { fid, ...file, text: await (await owner(`/api/blobs/${fid}/${file.hash}`)).text() };
}

async function driveWriting(name) {
  const say = (what, ok, detail) => step(`${name}, writing: ${what}`, Boolean(ok), detail);
  const browser = await ENGINES[name].launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  let page = await context.newPage();
  const trouble = [];
  let stage = "starting";
  const watch = (p) => {
    p.on("console", (m) => {
      if (process.env.DEBUG_DRIVE) console.log(`  [${stage}] console.${m.type()}: ${m.text().slice(0, 200)}`);
      if (/Content Security Policy|Content-Security-Policy|Refused to/i.test(m.text())) trouble.push(`${stage}: ${m.text().slice(0, 200)}`);
    });
    p.on("pageerror", (e) => trouble.push(`${stage}: ${String(e).slice(0, 200)}`));
    if (process.env.DEBUG_DRIVE) {
      p.on("response", (r) => r.status() >= 400 && console.log(`  [${stage}] ${r.status()} ${r.request().method()} ${r.url()}`));
    }
  };
  watch(page);

  // A folder of this engine's own: the engines share one worker.
  const DIR = `Writing in ${name}`;
  const DRAFT = `${DIR}/Draft.md`;
  const other = await elsewhere(browser);
  const put = (path, body) => other.ask(`/api/web/doc?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify(body) });
  await put(DRAFT, { md: { text: "# Draft\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n", ifRev: null } });

  const row = (path, on = page) => on.locator(`[data-tree-path="${LIBRARY}/${path}"]`);
  const para = (text) => page.locator(".ProseMirror p", { hasText: text }).first();
  const editorHas = (text, on = page, ms = 30_000) =>
    on.waitForFunction((t) => (document.querySelector(".ProseMirror")?.innerText ?? "").includes(t), text, { timeout: ms }).then(() => true, () => false);
  const typeAfter = async (paragraph, text) => {
    await para(paragraph).click();
    await page.keyboard.press("End");
    await page.keyboard.type(text);
  };
  const saves = (from) => answered.slice(from).filter((a) => a.method === "PUT" && a.path.startsWith("/api/web/doc") && a.status === 200);
  const polls = (from) => answered.slice(from).filter((a) => a.path === "/api/poll" && a.status === 200);
  const pick = async (path, label) => {
    await row(path).click({ button: "right" });
    // By the whole label: "Copy" is not "Copy link".
    await page.locator(".sidebar-menu-item").filter({ hasText: new RegExp(`^${label}$`) }).click();
  };
  const signIn = async (on) => {
    await on.goto(`${ORIGIN}/app`);
    await on.locator('[data-testid="web-invite"]').fill(`doklin-invite ${ORIGIN} ${await deviceCode()}`);
    await on.click('[data-testid="web-sign-in"]');
    await row("Home.md", on).waitFor({ timeout: 60_000 });
  };

  await signIn(page);
  const mine = await page.evaluate(() => localStorage.getItem("doklin:web:device"));
  await row(DIR).click();
  await row(DRAFT).click();
  await editorHas("First paragraph.");

  /* 1 — typing is saved, at a pace */
  stage = "typing is saved, at a pace";
  let from = answered.length;
  await typeAfter("First paragraph.", " Typed here.");
  const typedAt = Date.now();
  await sleep(1500);
  say("what is typed is not sent the moment the typing stops", saves(from).length === 0, `${saves(from).length} save(s) after 1.5 s`);
  const first = await until(() => saves(from)[0], 10_000);
  const afterFirst = await storedAt(DRAFT);
  say(
    "it is saved once the typing has settled, in one request",
    first && first.at - typedAt >= 1900 && saves(from).length === 1 && afterFirst.text.includes("First paragraph. Typed here."),
    first ? `${first.at - typedAt} ms after the last key, ${saves(from).length} save(s)` : "never",
  );
  await typeAfter("Second paragraph.", " And again.");
  const second = await until(() => saves(from)[1], 20_000);
  say(
    "a document is not sent more often than its pace, however the typing goes",
    second && second.at - first.at >= 9500 && (await storedAt(DRAFT)).text.includes("Second paragraph. And again."),
    second ? `${second.at - first.at} ms between two saves` : "the second never went",
  );
  const polled = await until(() => polls(answered.indexOf(second) + 1)[0], 25_000);
  const reasked = answered.slice(answered.indexOf(first)).filter((a) => a.path.startsWith("/api/manifest"));
  say("after its own saves the page asks for no manifest: the answer said which one it was made to", polled && reasked.length === 0, `${reasked.length} manifest read(s)`);

  const here = async () => (await (await owner("/api/poll")).json());
  const seen = await until(async () => {
    const poll = await here();
    return poll.presence[mine]?.path === DRAFT && (poll.leases ?? []).some((l) => l.deviceId === mine && l.path === DRAFT.toLowerCase()) && poll;
  }, 30_000);
  say("everyone is told which document the browser is editing, and it holds it", seen, seen ? seen.presence[mine].name : "not in presence with the document");

  /* 2 — sent at once when the page loses attention */
  stage = "sent at once when the page loses attention";
  from = answered.length;
  await typeAfter("Third paragraph.", " Then away.");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const blurred = await until(() => saves(from)[0], 3000, 50);
  say("leaving the page for another window sends what was typed at once", blurred && (await storedAt(DRAFT)).text.includes("Then away."), blurred ? "sent" : "not sent within 3 s");

  /* 3 — somebody else changed another paragraph */
  stage = "somebody else changed another paragraph";
  await typeAfter("First paragraph.", " Mine.");
  await sleep(900);
  let cur = await storedAt(DRAFT);
  const elsewhereThird = await put(DRAFT, { md: { text: cur.text.replace("Third paragraph. Then away.", "Third paragraph, theirs."), ifRev: cur.rev } });
  const merged = await until(async () => {
    const now = await storedAt(DRAFT);
    return now.text.includes("Mine.") && now.text.includes("Third paragraph, theirs.") && now;
  }, 30_000);
  say("a save over a document that moved on is merged: both changes are in it", elsewhereThird.status === 200 && merged, merged ? `rev ${merged.rev}` : (await storedAt(DRAFT)).text.replace(/\s+/g, " "));
  say("and the page shows the other change too", await editorHas("Third paragraph, theirs."));
  const copiesAfterMerge = Object.values((await (await owner("/api/manifest")).json()).files).filter((f) => f.path.startsWith(`${DIR}/`) && f.path.includes("(conflict"));
  say("nothing was set aside: there was nothing to choose between", copiesAfterMerge.length === 0, copiesAfterMerge.map((f) => f.path).join(", "));

  /* 4 — somebody else changed the same line */
  stage = "somebody else changed the same line";
  await sleep(1200);
  await typeAfter("Second paragraph.", " Ours.");
  await sleep(900);
  cur = await storedAt(DRAFT);
  const elsewhereSecond = await put(DRAFT, { md: { text: cur.text.replace("Second paragraph. And again.", "Second paragraph, rewritten elsewhere."), ifRev: cur.rev } });
  const copy = await until(async () => {
    const m = await (await owner("/api/manifest")).json();
    return Object.values(m.files).find((f) => f.path.startsWith(`${DIR}/Draft (conflict — `));
  }, 30_000);
  const copyText = copy ? (await storedAt(copy.path)).text : "";
  const kept = await until(async () => {
    const now = await storedAt(DRAFT);
    return now.text.includes("Ours.") && now;
  }, 20_000);
  say(
    "changes that overlap are not merged: the other version is kept beside the document, named for who and when",
    elsewhereSecond.status === 200 && copy && /^Draft \(conflict — .+, [A-Z][a-z]{2} \d{1,2} \d\d\.\d\d\)\.md$/.test(copy.path.slice(DIR.length + 1)) && copyText.includes("rewritten elsewhere") && !copyText.includes("Ours."),
    copy ? copy.path : "no copy",
  );
  say("and the document is the one being typed", kept && !kept.text.includes("rewritten elsewhere"), kept ? "" : "ours did not land");
  const told = await page.locator(".toast-text", { hasText: "both versions are kept" }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  say("the page says so, and the copy is in the tree", told && copy && (await row(copy.path).count()) === 1);

  /* 5 — held somewhere else, and taken back */
  stage = "held somewhere else, and taken back";
  const taken = await owner("/api/poll", { method: "POST", json: { name: "The Mac", path: DRAFT, take: true } });
  const banner = page.locator('[data-testid="lease-banner"]');
  const viewOnly = await banner.waitFor({ timeout: 40_000 }).then(() => true, () => false);
  say("a document a Mac takes over is view-only here, and says who has it", taken.status === 200 && viewOnly && /The Mac/.test(await banner.innerText().catch(() => "")), await banner.innerText().catch(() => "no banner"));
  await page.locator('[data-testid="lease-take-over"]').click();
  const back = await banner.waitFor({ state: "detached", timeout: 20_000 }).then(() => true, () => false);
  const holder = (await here()).leases?.find((l) => l.path === DRAFT.toLowerCase())?.deviceId;
  say("Take over takes it back, on the very next beat", back && holder === mine, `held by ${holder === mine ? "this browser" : holder}`);

  /* 6 — the tree's changes */
  stage = "the tree's changes";
  const untitled = `${DIR}/Untitled.md`;
  await pick(DIR, "New Document");
  await row(untitled).waitFor({ timeout: 15_000 });
  const made = await until(() => storedAt(untitled), 10_000);
  const inTitle = await until(() => page.evaluate(() => document.activeElement?.closest(".doc-title") != null), 10_000);
  say("a new note is made on the domain as Untitled, with nothing in it, and the caret in its title", made && made.size === 0 && inTitle);
  const name1 = `${DIR}/Made here.md`;
  await page.keyboard.type("Made here");
  await page.keyboard.press("Enter");
  await row(name1).waitFor({ timeout: 15_000 });
  const titled = await until(() => storedAt(name1), 10_000);
  say("typing its title renames it, the same file under the new name", titled && titled.fid === made.fid && !(await storedAt(untitled)));
  await page.keyboard.type("Hello from the tree.");
  say("and what is typed into it is saved", await until(async () => (await storedAt(name1))?.text.includes("Hello from the tree."), 15_000));

  const name2 = `${DIR}/Renamed here.md`;
  await pick(name1, "Rename…");
  await page.locator(".tree-create-input").fill("Renamed here.md");
  await page.keyboard.press("Enter");
  await row(name2).waitFor({ timeout: 15_000 });
  const renamed = await storedAt(name2);
  say("a rename moves the note, the same file under its new name", renamed && renamed.fid === made.fid && !(await storedAt(name1)) && renamed.text.includes("Hello from the tree."));
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" And after the rename.");
  const afterRename = await until(async () => (await storedAt(name2))?.text.includes("And after the rename."), 20_000);
  say("what is typed after the rename is saved where the note now is, with no conflict", afterRename && (await page.locator(".conflict-banner").count()) === 0);

  await pick(name2, "Copy");
  await pick(DIR, "Paste");
  const name3 = `${DIR}/Renamed here copy.md`;
  await row(name3).waitFor({ timeout: 15_000 });
  const copied = await storedAt(name3);
  say("a copy is a note of its own with the same text", copied && copied.fid !== renamed.fid && copied.text.includes("And after the rename."));

  await pick(DIR, "New Folder…");
  await page.locator(".tree-create-input").fill("Empty here");
  await page.keyboard.press("Enter");
  await row(`${DIR}/Empty here`).waitFor({ timeout: 10_000 });
  const filesUnder = async (dir) => Object.values((await (await owner("/api/manifest")).json()).files).filter((f) => f.path.startsWith(`${dir}/`)).map((f) => f.path);
  say("a new folder is in the tree, and on the domain there is nothing yet", (await filesUnder(`${DIR}/Empty here`)).length === 0);
  await pick(`${DIR}/Empty here`, "New Document");
  await row(`${DIR}/Empty here/Untitled.md`).waitFor({ timeout: 15_000 });
  say("it is a folder for everyone once a note is in it", await until(async () => (await filesUnder(`${DIR}/Empty here`)).includes(`${DIR}/Empty here/Untitled.md`), 10_000));

  await pick(name3, "Delete");
  // A delete here cannot be taken back, so it is asked first (the rest).
  await page.locator('[data-testid="question-yes"]').click();
  const deleted = await until(async () => !(await storedAt(name3)), 15_000);
  const tombstones = (await (await owner("/api/manifest")).json()).tombstones ?? {};
  const rowGone = await until(async () => (await row(name3).count()) === 0, 10_000);
  say(
    "a delete takes the note off the domain, leaving what a Mac needs to do the same",
    deleted && tombstones[copied.fid] && rowGone,
    `${deleted ? "gone" : "still stored"}, ${tombstones[copied.fid] ? "a tombstone" : "no tombstone"}, ${rowGone ? "out of the tree" : "still in the tree"}`,
  );

  /* 7 — comments travel with the text */
  stage = "comments travel with the text";
  await row("Comments.md").click();
  await page.getByText("Say it plainer.").first().waitFor({ timeout: 30_000 });
  from = answered.length;
  await page.locator(".ProseMirror p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(` Edited in ${name}.`);
  const both = await until(() => saves(from)[0], 15_000);
  const sidecar = await storedAt("Comments.meta.jsonl");
  say("a note with comments is saved with them, in one write", both && both.parts.includes("md") && both.parts.includes("meta") && sidecar.text.includes("Say it plainer."), both ? both.parts.join(" + ") : "not saved");

  /* 8 — leaving with unsaved text */
  stage = "leaving with unsaved text";
  await row(DRAFT).click();
  await editorHas("Third paragraph, theirs.");
  let asked = null;
  page.on("dialog", (d) => {
    asked = d.type();
    void d.accept();
  });
  await typeAfter("Third paragraph, theirs.", " Typed, then gone.");
  await page.goto(`${OTHER}/`).catch(() => {});
  const sentGoing = await until(async () => (await storedAt(DRAFT)).text.includes("Typed, then gone."), 8000);
  say("a tab left with text that is not saved yet asks first", asked === "beforeunload", asked ?? "no question");
  say("and what was typed is sent as the page goes", sentGoing);

  /* 9 — what could not be sent */
  stage = "what could not be sent";
  await page.goto(`${ORIGIN}/app`);
  await editorHas("Typed, then gone.");
  page.removeAllListeners("dialog");
  await context.setOffline(true);
  await typeAfter("First paragraph.", " Typed with no network.");
  const draftKept = await until(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("doklin:web:draft:"))), 5000);
  await page.close();
  await context.setOffline(false);
  const beforeReopen = await storedAt(DRAFT);
  page = await context.newPage();
  watch(page);
  await page.goto(`${ORIGIN}/app`);
  const shownAgain = await editorHas("Typed with no network.");
  const sentLater = await until(async () => (await storedAt(DRAFT)).text.includes("Typed with no network."), 20_000);
  say("text that could not be sent before the tab closed is kept in the browser", draftKept && !beforeReopen.text.includes("Typed with no network."));
  say("the next time the workspace is opened there it is on the page, and sent", shownAgain && sentLater);
  const cleared = await until(() => page.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith("doklin:web:draft:"))), 10_000);
  say("and is kept no longer once it is saved", cleared);

  /* 10 — the domain is updated while the page is open */
  stage = "the domain is updated while the page is open";
  const release = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const named = [...new Set(answered.filter((a) => a.client !== undefined).map((a) => a.client))];
  say("every request the page makes says which release it is", named.length === 1 && named[0] === `web/${release}`, named.join(", "));
  staleAs = "web/0.0.1";
  from = answered.length;
  let leaveAsked = null;
  page.on("dialog", (d) => {
    leaveAsked = d.type();
    void d.accept();
  });
  const updatedCover = page.locator('[data-testid="web-updated"]');
  await typeAfter("First paragraph.", " Typed as the domain was updated.");
  const covered = await updatedCover.waitFor({ timeout: 40_000 }).then(() => true, () => false);
  const coverSays = covered ? (await updatedCover.innerText()).replace(/\s+/g, " ").trim() : "";
  say(
    "a worker of another release refuses the page, which is covered with one button: Reload",
    covered &&
      answered.slice(from).some((a) => a.status === 410) &&
      coverSays.includes(`Doklin on localhost:${PORT} was updated while this page was open. Reload it to keep going: what you typed is kept.`) &&
      (await updatedCover.getByRole("button").count()) === 1 &&
      (await page.locator("#root").evaluate((r) => r.inert === true)),
    coverSays,
  );
  // The app's shortcuts listen on the window, after the page's own guard.
  await page.evaluate(() => {
    window.__heard = 0;
    addEventListener("keydown", () => (window.__heard += 1), true);
  });
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Control+n");
  say("a shortcut under it reaches nothing of the app's", (await page.evaluate(() => window.__heard)) === 0);
  const keptForReload = await until(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("doklin:web:draft:"))), 5000);
  staleAs = null;
  const loaded = page.waitForEvent("load", { timeout: 30_000 });
  await updatedCover.getByRole("button", { name: "Reload" }).click();
  await loaded;
  const backAfterReload = await editorHas("Typed as the domain was updated.");
  const sentAfterReload = await until(async () => (await storedAt(DRAFT)).text.includes("Typed as the domain was updated."), 20_000);
  say(
    "Reload asks nothing, and the page it brings has what was typed, and sends it",
    keptForReload && leaveAsked === null && backAfterReload && sentAfterReload && (await updatedCover.count()) === 0,
    `${leaveAsked ? `asked: ${leaveAsked}` : "nothing asked"}, ${backAfterReload ? "on the page" : "not on the page"}, ${sentAfterReload ? "sent" : "not sent"}`,
  );
  page.removeAllListeners("dialog");

  /* 11 — two tabs ask as one */
  stage = "two tabs ask as one";
  const beside = await context.newPage();
  watch(beside);
  await beside.goto(`${ORIGIN}/app`);
  await row("Home.md", beside).waitFor({ timeout: 60_000 });
  for (const tab of [page, beside]) if ((await row(DRAFT, tab).count()) === 0) await row(DIR, tab).click();
  await sleep(3000);
  from = answered.length;
  const news = `${DIR}/Seen by both.md`;
  await put(news, { md: { text: "# Seen by both\n", ifRev: null } });
  await sleep(50_000);
  const asks = polls(from).length;
  say("two tabs of one browser ask the worker as one would", asks >= 2 && asks <= 4, `${asks} poll(s) in 50 s`);
  say("and both are told what the one that asks was told", (await row(news).count()) === 1 && (await row(news, beside).count()) === 1);
  await beside.close();

  say("the page's policy refused nothing, and the page threw nothing", trouble.length === 0, trouble.slice(0, 3).join(" | "));
  await other.close();
  await browser.close();
}

/* ---------- The rest of what a browser does: search, links, pages, the way out ---------- */

async function driveRest(name) {
  const say = (what, ok, detail) => step(`${name}, the rest: ${what}`, Boolean(ok), detail);
  const browser = await ENGINES[name].launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  // A keyboard with no ⌘, and what the page copies kept where the drive can
  // read it: a browser hands its clipboard to no script that did not ask.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    if (!navigator.clipboard) return;
    navigator.clipboard.write = async (items) => {
      for (const item of items) window.__copied = await (await item.getType("text/plain")).text();
    };
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });
  const page = await context.newPage();
  const trouble = [];
  let stage = "starting";
  page.on("console", (m) => {
    if (process.env.DEBUG_DRIVE) console.log(`  [${stage}] console.${m.type()}: ${m.text().slice(0, 200)}`);
    if (/Content Security Policy|Content-Security-Policy|Refused to/i.test(m.text())) trouble.push(`${stage}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => trouble.push(`${stage}: ${String(e).slice(0, 200)}`));
  if (process.env.DEBUG_DRIVE) {
    page.on("response", (r) => r.status() >= 400 && console.log(`  [${stage}] ${r.status()} ${r.request().method()} ${r.url()}`));
  }

  // A folder of this engine's own: the engines share one worker.
  const DIR = `Rest in ${name}`;
  const ALPHA = `${DIR}/Alpha.md`;
  const BETA = `${DIR}/Beta.md`;
  const LINKS = `${DIR}/Links.md`;
  const WORD = `zebra${name}`;
  const other = await elsewhere(browser);
  const put = (path, text) =>
    other.ask(`/api/web/doc?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ md: { text, ifRev: null } }) });
  await put(ALPHA, `# Alpha\n\nThe quick ${WORD} jumps.\n`);
  await put(BETA, "# Beta\n\nNothing to find here.\n");
  const meta = await (await owner("/api/meta")).json();
  const alpha = await storedAt(ALPHA);
  const linkTo = (fid) => `https://doklin.cc/open#d=${encodeURIComponent(new URL(ORIGIN).host)}&w=${meta.workspace.id}&f=${fid}`;
  await put(LINKS, `# Links\n\n[to alpha](${linkTo(alpha.fid)})\n\n[to nothing](${linkTo("f-0000000000000000")})\n`);

  const row = (path) => page.locator(`[data-tree-path="${LIBRARY}/${path}"]`);
  const editorHas = (text, ms = 30_000) =>
    page.waitForFunction((t) => (document.querySelector(".ProseMirror")?.innerText ?? "").includes(t), text, { timeout: ms }).then(() => true, () => false);
  const menu = () => page.locator(".sidebar-menu-item");
  const pick = async (path, label) => {
    await row(path).click({ button: "right" });
    await menu().filter({ hasText: new RegExp(`^${label}$`) }).click();
  };
  const labels = async (path) => {
    await row(path).click({ button: "right" });
    const all = await menu().allInnerTexts();
    await page.keyboard.press("Escape");
    return all.map((l) => l.trim());
  };
  const toast = (text, ms = 15_000) =>
    page.locator(".toast-text", { hasText: text }).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const copied = () => page.evaluate(() => window.__copied ?? null);
  const publicPage = (path) => fetch(`http://localhost:${WORKER_PORT}${path}`, { redirect: "manual" });
  const asked = (from, method, start) => answered.slice(from).filter((a) => a.method === method && a.path.startsWith(start));

  await page.goto(`${ORIGIN}/app`);
  await page.locator('[data-testid="web-invite"]').fill(`doklin-invite ${ORIGIN} ${await deviceCode()}`);
  await page.click('[data-testid="web-sign-in"]');
  await row("Home.md").waitFor({ timeout: 60_000 });
  const mine = await page.evaluate(() => localStorage.getItem("doklin:web:device"));

  /* 1 — nothing on screen is the Mac's */
  stage = "nothing on screen is the Mac's";
  await page.locator(".scratch-empty").waitFor();
  say("the empty screen offers no way to join a workspace: this one is the only one here", (await page.locator('[data-testid="join-workspace"]').count()) === 0);
  const lead = await page.locator(".title-lead").first().evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  say("the title row leaves no room for a window's buttons", lead < 30, `${lead}px`);
  const hint = await page.locator(".sidebar-search kbd").innerText();
  say("a shortcut is written for the keyboard in front of it", hint === "Ctrl+Shift+F", hint);
  await row(DIR).click();
  const offered = await labels(ALPHA);
  say(
    "the tree offers nothing a browser cannot do",
    offered.includes("Copy link") && offered.includes("Delete") && !offered.some((l) => /Finder|Restrict|Share with|history|Recently deleted/i.test(l)),
    offered.join(" · "),
  );
  await page.locator(".settings-fab").click();
  const gear = (await page.locator(".settings-popover").innerText()).replace(/\s+/g, " ");
  await page.keyboard.press("Escape");
  say("the settings menu names no Mac and no key a Windows keyboard has not got", /Cloud…/.test(gear) && !/\bMac\b|⌘|⌥|⇧/.test(gear), gear);
  await page.locator(".sidebar-header-button").first().click();
  const workspaceMenu = (await page.locator('[data-testid^="sidebar-menu-"]').evaluateAll((els) => els.map((el) => el.dataset.testid))).join(" ");
  await page.keyboard.press("Escape");
  say(
    "the workspace's menu has people, devices and agents in it, and no joining",
    ["cloud", "people", "devices", "agents"].every((item) => workspaceMenu.includes(`sidebar-menu-${item}`)) && !/join/.test(workspaceMenu),
    workspaceMenu,
  );

  /* 2 — search */
  stage = "search";
  let from = answered.length;
  await page.locator(".sidebar-search").click();
  await page.locator(".ws-search-input").fill(WORD);
  const hit = page.locator(".ws-result-row", { hasText: WORD }).first();
  const found = await hit.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const searches = asked(from, "GET", "/api/web/search");
  say(
    "a word is found in the document that holds it, by the worker",
    found && searches.some((a) => a.status === 200) && (await page.locator(".ws-result-file-name").first().innerText()) === "Alpha",
    `${searches.map((a) => a.status).join(", ")}`,
  );
  say("matching case is not offered where the search cannot do it", (await page.locator(".ws-search-case").count()) === 0);
  if (found) await hit.click();
  say("a result opens its document", await editorHas(`The quick ${WORD} jumps.`));
  await page.locator(".ws-search-input").fill("Beta");
  const named = await page.locator(".ws-result-file-name mark", { hasText: "Beta" }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
  say("and a document is found by its name", named);
  await page.locator('button[title="Back to files"]').click();

  /* 3 — a page's link */
  stage = "a page's link";
  await pick(ALPHA, "Copy link");
  const said = await toast("Link copied. Everyone in Notes can open it.");
  say("Copy link copies the link that opens the page anywhere, and says who can open it", said && (await copied()) === linkTo(alpha.fid), String(await copied()));
  await row(LINKS).click();
  await editorHas("to alpha");
  const pagesBefore = context.pages().length;
  const tabs = () => page.locator(".tab .tab-label").allTextContents();
  // Alpha in a tab of its own (the search opened it) would come forward
  // instead: one tab per file.
  const alphaTab = page.locator(".tab", { has: page.locator(".tab-label", { hasText: /^Alpha$/ }) });
  if (await alphaTab.count()) await alphaTab.locator(".tab-close").click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".tab .tab-label")].some((l) => l.textContent === "Alpha"));
  const tabsBefore = (await tabs()).length;
  await page.locator(".ProseMirror a", { hasText: "to alpha" }).click();
  say(
    "a link to a page of this workspace, clicked in a note, opens that page here",
    (await editorHas(`The quick ${WORD} jumps.`, 15_000)) && context.pages().length === pagesBefore && !new URL(page.url()).hash,
    `${context.pages().length} page(s), at ${page.url()}`,
  );
  say(
    "in the note's own tab",
    (await tabs()).length === tabsBefore && !(await tabs()).includes("Links"),
    (await tabs()).join(", "),
  );
  await page.evaluate(() => history.back());
  say("the browser's Back takes the tab back to the note the link was in", await editorHas("to alpha", 10_000), page.url());
  await page.evaluate(() => history.forward());
  say(
    "and its Forward to the page again, at the app's own address",
    (await editorHas(`The quick ${WORD} jumps.`, 10_000)) && page.url() === `${ORIGIN}/app`,
    page.url(),
  );
  await row(LINKS).click();
  await editorHas("to nothing");
  await page.locator(".ProseMirror a", { hasText: "to nothing" }).click();
  say("and one to a page that is not there says so", await toast("That page isn't one you can open in Notes"));

  /* 4 — publishing */
  stage = "publishing";
  const SLUG = `alpha-${name}`;
  await row(ALPHA).click();
  await editorHas(`The quick ${WORD} jumps.`);
  await page.locator('[data-testid="live-chip"]').click();
  await page.locator('[data-testid="publish-slug"]').fill(SLUG);
  from = answered.length;
  await page.locator('[data-testid="publish-go"]').click();
  const live = await until(async () => (await publicPage(`/${SLUG}`)).status === 200, 15_000);
  const shown = live ? await (await publicPage(`/${SLUG}`)).text() : "";
  say("a note is published at the address asked for, and the page answers at once", live && shown.includes(WORD), `${asked(from, "PUT", "/api/web/pages").map((a) => a.status).join(", ")}`);
  await page.locator('[data-testid="publish-url"]').waitFor({ timeout: 15_000 }).catch(() => {});
  say(
    "the app shows it as live, in the note and in the tree",
    (await page.locator('[data-testid="publish-url"]').innerText().catch(() => "")).includes(SLUG) &&
      (await row(ALPHA).locator('[data-testid="tree-published"]').count()) === 1,
  );
  await page.keyboard.press("Escape");
  await row(BETA).click();
  await editorHas("Nothing to find here.");
  await page.locator('[data-testid="live-chip"]').click();
  // The form starts over for this note a moment after it opens: typed into
  // before that, an address is the last note's and is taken for no change.
  await page.waitForFunction(() => document.querySelector('[data-testid="publish-slug"]')?.value === "");
  await page.locator('[data-testid="publish-slug"]').fill(SLUG);
  from = answered.length;
  await page.locator('[data-testid="publish-go"]').click();
  const taken = await page.locator('[data-testid="publish-pop"] .modal-error', { hasText: "is already the address of" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  say(
    "an address another page has is refused in the worker's own words",
    taken && (await storedAt(BETA)) !== null && !Object.values((await (await owner("/api/manifest")).json()).public ?? {}).some((e) => e.path === BETA),
    `${asked(from, "PUT", "/api/web/pages").map((a) => `${a.status} ${a.slug}`).join(", ")} — ${(await page.locator('[data-testid="publish-pop"]').innerText().catch(() => "")).replace(/\s+/g, " ")}`,
  );
  await page.keyboard.press("Escape");

  const FOLDER = `rest-${name}`;
  await pick(DIR, "Publish folder…");
  await page.locator('[data-testid="folder-slug"]').fill(FOLDER);
  await page.locator('[data-testid="folder-publish"]').click();
  const folderLive = await until(async () => (await publicPage(`/${FOLDER}/Beta`)).status === 200, 15_000);
  say("a folder is published, and a note in it answers under the folder's address", folderLive);

  await page.locator(".settings-fab").click();
  await page.locator('[data-testid="settings-cloud"]').click();
  const listed = answered.length;
  await page.locator('[data-testid="published-pages"]').click();
  const pageRow = (slug) => page.locator(`[data-testid="published-row"][data-slug="${slug}"]`);
  await pageRow(SLUG).waitFor({ timeout: 10_000 });
  say("the list of pages has both", (await pageRow(FOLDER).count()) === 1);
  await pageRow(SLUG).locator('[data-testid="published-home"]').click();
  const home = await until(async () => (await (await publicPage("/")).text()).includes(WORD), 15_000);
  say("a page is made the domain's home page", home);
  await pageRow(SLUG).locator('[data-testid="published-home"]').click();
  say("and unmade", await until(async () => !(await (await publicPage("/")).text()).includes(WORD), 15_000));
  from = answered.length;
  await pageRow(FOLDER).locator('[data-testid="published-stop"]').click();
  await page.locator('[data-testid="published-stop-yes"]').click();
  const stopped = await until(async () => (await publicPage(`/${FOLDER}/Beta`)).status === 404, 15_000);
  const gone = await until(async () => (await pageRow(FOLDER).count()) === 0, 10_000);
  say(
    "a page is stopped, and its address stops answering",
    stopped && gone,
    `${asked(from, "DELETE", "/api/web/pages").map((a) => a.status).join(", ")}; the address answers ${(await publicPage(`/${FOLDER}/Beta`)).status}; ${await pageRow(FOLDER).count()} row(s)`,
  );
  // The pages of sections this person is not in are listed under the rest;
  // here there are none, and what matters is that the domain was asked.
  const every = asked(listed, "GET", "/api/pages");
  say(
    "an owner's browser asks the domain for every page on it, and is answered",
    every.some((a) => a.status === 200) && (await page.locator('[data-testid="published-elsewhere-note"]').count()) === 0,
    every.map((a) => a.status).join(", "),
  );
  await page.keyboard.press("Escape");

  /* 5 — a delete is asked first */
  stage = "a delete is asked first";
  await pick(BETA, "Delete");
  const question = page.locator('[data-testid="question-prompt"]');
  await question.waitFor({ timeout: 10_000 });
  const words = (await question.innerText()).replace(/\s+/g, " ");
  await page.locator('[data-testid="question-no"]').click();
  await sleep(500);
  say("a delete that cannot be taken back is asked first, and Cancel deletes nothing", /Delete “Beta”\?/.test(words) && /this browser can’t bring it back/.test(words) && (await storedAt(BETA)) !== null, words);
  await pick(BETA, "Delete");
  await page.locator('[data-testid="question-yes"]').click();
  say("Delete deletes it", (await until(async () => (await storedAt(BETA)) === null, 15_000)) && (await until(async () => (await row(BETA).count()) === 0, 10_000)));

  /* 6 — the panel, and the way out */
  stage = "the panel, and the way out";
  await page.locator(".settings-fab").click();
  await page.locator('[data-testid="settings-cloud"]').click();
  const panel = page.locator(".cloud-modal");
  await panel.locator('[data-testid="usage-line"]').waitFor({ timeout: 10_000 });
  const panelText = (await panel.innerText()).replace(/\s+/g, " ");
  const absent = ["sync-now", "pause-toggle", "disconnect", "wipe-open", "versions-line", "update-worker-quiet", "plan-free"];
  const drawn = [];
  for (const id of absent) if ((await panel.locator(`[data-testid="${id}"]`).count()) > 0) drawn.push(id);
  say(
    "the Cloud panel speaks of this browser, and offers nothing a browser has not got",
    // Whoever else is here is named as their device names itself, a Mac among them.
    drawn.length === 0 &&
      /This browser today: /.test(panelText) &&
      !/this Mac|other Macs/i.test(panelText) &&
      (await panel.locator('[data-testid="sign-out"]').count()) === 1 &&
      (await panel.locator('[data-testid="add-device"]').count()) === 1,
    drawn.length > 0 ? `drawn: ${drawn.join(", ")}` : panelText.slice(0, 300),
  );
  await page.keyboard.press("Escape");

  // Typed, and signed out before its turn to be sent comes.
  await row(ALPHA).click();
  await editorHas(`The quick ${WORD} jumps.`);
  await page.locator(".ProseMirror p", { hasText: WORD }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Written just before leaving.");
  await page.locator(".settings-fab").click();
  await page.locator('[data-testid="settings-cloud"]').click();
  await page.locator('[data-testid="sign-out"]').click();
  const sure = (await page.locator('[data-testid="sign-out-confirm"]').innerText()).replace(/\s+/g, " ");
  from = answered.length;
  await page.locator('[data-testid="sign-out-yes"]').click();
  const out = await page.locator('[data-testid="web-invite"]').waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const cookies = await context.cookies(ORIGIN);
  say("signing out asks first, and ends at the sign-in screen with the cookie gone", /Sign out of Notes in this browser\?/.test(sure) && out && !cookies.some((c) => c.name === "__Host-doklin"), sure);
  say("what was typed was sent before the sign-in ended", (await storedAt(ALPHA)).text.includes("Written just before leaving."));
  const devices = await (await owner("/api/auth/devices")).json().catch(() => null);
  const still = JSON.stringify(devices ?? {}).includes(mine);
  say("the browser is no longer one of the person's devices", devices !== null && !still, devices === null ? "no list of devices" : "");
  say("nothing was refused by the page's policy, and nothing threw", trouble.length === 0, trouble.join(" | "));

  await other.close();
  await browser.close();
}

/* ---------- People, devices and agents ---------- */

/** Browsers of people's, for a part of the drive: each `open(who)` is one
 *  with its own cookies, whose page copies are kept where the drive can read
 *  them. What a page's policy refused, and what a page threw, go to `trouble`. */
function signedIn(browser, trouble) {
  return async (who) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
      navigator.clipboard.writeText = async (text) => {
        window.__copied = text;
      };
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (process.env.DEBUG_DRIVE) console.log(`  [${who}] console.${m.type()}: ${m.text().slice(0, 200)}`);
      if (/Content Security Policy|Content-Security-Policy|Refused to/i.test(m.text())) trouble.push(`${who}: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => trouble.push(`${who}: ${String(e).slice(0, 200)}`));
    if (process.env.DEBUG_DRIVE) {
      page.on("response", (r) => r.status() >= 400 && console.log(`  [${who}] ${r.status()} ${r.request().method()} ${r.url()}`));
    }
    const at = (id) => page.locator(`[data-testid="${id}"]`);
    const text = async (id) => (await at(id).innerText({ timeout: 15_000 })).replace(/\s+/g, " ").trim();
    return {
      context,
      page,
      at,
      text,
      copied: () => page.evaluate(() => window.__copied ?? null),
      device: () => page.evaluate(() => localStorage.getItem("doklin:web:device")),
      /** Paste a line at the sign-in screen; true once the workspace is up. */
      async signIn(line) {
        await page.goto(`${ORIGIN}/app`);
        await at("web-invite").fill(line);
        await at("web-sign-in").click();
        return page.locator(`[data-tree-path="${LIBRARY}/Home.md"]`).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      },
      /** The workspace menu's People…, Devices… or Agents…, opened afresh:
       *  the view reads its lists when it opens. */
      async show(tab) {
        if ((await page.locator(".cloud-modal").count()) > 0) await page.locator(".cloud-modal .modal-close").click();
        await page.locator(".sidebar-header-button").first().click();
        await at(`sidebar-menu-${tab}`).click();
        await at(`pane-${tab}`).waitFor({ timeout: 15_000 });
      },
      /** Back at the sign-in screen once the page is loaded again. */
      async signedOut() {
        await page.reload();
        return at("web-invite").waitFor({ timeout: 30_000 }).then(() => true, () => false);
      },
    };
  };
}

async function driveAccess(name) {
  const say = (what, ok, detail) => step(`${name}, access: ${what}`, Boolean(ok), detail);
  const browser = await ENGINES[name].launch();
  const trouble = [];
  const open = signedIn(browser, trouble);
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  /** A code as it is hashed: the twenty characters. */
  const canonical = (code) => code.replace(/^dkl[na]-/, "").replaceAll("-", "");
  const lastTo = (path) => answered.findLast((a) => a.method === "POST" && a.path === path);
  const worker = (path, { token, json, method = json === undefined ? "GET" : "POST" } = {}) =>
    fetch(`http://localhost:${WORKER_PORT}${path}`, {
      method,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { "content-type": "application/json" }) },
    });
  const devicesOf = async (member) => (await (await owner("/api/auth/devices")).json()).devices.filter((d) => d.memberId === member);

  /* 1 — an owner invites somebody, from a browser */
  const boss = await open("the owner");
  await boss.signIn(`doklin-invite ${ORIGIN} ${await deviceCode()}`);
  const EMAIL = `bo-${name}@example.com`;
  await boss.show("people");
  await boss.at("invite-open").click();
  await boss.at("invite-email").fill(EMAIL);
  await boss.at("invite-name").fill(`Bo ${name}`);
  await boss.at("invite-send").click();
  await boss.at("minted-invite").waitFor({ timeout: 15_000 });
  const inviteCode = await boss.text("invite-code");
  await boss.at("copy-invite-line").click();
  const toSend = await boss.copied();
  const inviteCall = lastTo("/api/auth/invites");
  const sentInvite = JSON.parse(inviteCall?.body ?? "{}");
  say(
    "an owner's browser makes an invite: a code of the Mac's shape, and the line to send with where the workspace opens in a browser",
    /^dkln(-[0-9A-HJKMNP-TV-Z]{5}){4}$/.test(inviteCode) &&
      toSend === `doklin-invite ${ORIGIN} ${inviteCode}\nNo Doklin app? Open ${ORIGIN}/app and paste the line above.`,
    toSend,
  );
  say(
    "only the code's sha256 went to the worker, never the code",
    inviteCall?.status === 201 &&
      sentInvite.codeHash === sha(canonical(inviteCode)) &&
      sentInvite.email === EMAIL &&
      !inviteCall.body.includes(canonical(inviteCode)) &&
      !inviteCall.body.includes(inviteCode) &&
      Math.abs(sentInvite.expiresAt - (inviteCall.at + 7 * 86_400_000)) < 60_000,
    inviteCall?.body,
  );
  await boss.at("minted-done").click();

  /* 2 — somebody with no Mac: the invite, pasted whole, signs their browser in */
  const bo = await open("somebody with no Mac");
  say("the whole text an owner sent, pasted at /app, signs a new person in", await bo.signIn(toSend));
  const them = (await (await owner("/api/auth/members")).json()).members.find((m) => m.email === EMAIL);
  const boDevice = await bo.device();
  await bo.show("people");
  const memberIntro = await bo.text("people-intro");
  say(
    "a member sees who is here, and nothing that is an owner's to do",
    memberIntro.includes("An owner invites people and removes them") &&
      (await bo.at("invite-open").count()) === 0 &&
      (await bo.at(`person-${them.id}`).count()) === 1 &&
      (await bo.page.locator('[data-testid^="remove-person-"], [data-testid^="set-role-"]').count()) === 0,
    memberIntro,
  );

  /* 3 — they add a device of their own: a second browser, then a Mac */
  await bo.show("devices");
  const own = (await devicesOf(them.id)).find((d) => d.deviceId === boDevice);
  const ownRow = await bo.text(`device-${own.id}`);
  say(
    "the Devices list marks this browser, and offers no way to sign it out from there",
    // The tag is drawn in capitals.
    /this browser/i.test(ownRow) && (await bo.at(`device-sign-out-${own.id}`).count()) === 0,
    ownRow,
  );
  await bo.at("device-add").click();
  await bo.at("minted-device").waitFor({ timeout: 15_000 });
  const deviceLine = await bo.text("device-line");
  const deviceTerms = await bo.text("device-terms");
  const deviceCall = lastTo("/api/auth/devices/code");
  const sentDevice = JSON.parse(deviceCall?.body ?? "{}");
  const deviceCodeShown = deviceLine.split(" ").at(-1);
  say(
    "Add a device makes a line in the browser, good for an hour, and says where a browser pastes it",
    new RegExp(`^doklin-invite ${ORIGIN.replaceAll(".", "\\.")} dkln(-[0-9A-HJKMNP-TV-Z]{5}){4}$`).test(deviceLine) &&
      deviceTerms.includes(`In a browser, open ${ORIGIN}/app.`) &&
      deviceTerms.includes("It works once, for 1 h.") &&
      deviceCall?.status === 201 &&
      sentDevice.codeHash === sha(canonical(deviceCodeShown)) &&
      !deviceCall.body.includes(canonical(deviceCodeShown)) &&
      Math.abs(sentDevice.expiresAt - (deviceCall.at + 3_600_000)) < 60_000,
    `${deviceLine} | ${deviceTerms}`,
  );
  const second = await open("their second browser");
  say("a second browser signs in with that line, as the same person", await second.signIn(deviceLine));
  const secondDevice = await second.device();
  await bo.at("minted-device-done").click();
  await bo.at("device-add").click();
  await bo.at("minted-device").waitFor({ timeout: 15_000 });
  const macLine = await bo.text("device-line");
  const mac = await worker("/api/auth/join", { json: { code: macLine.split(" ").at(-1), deviceId: `d-mac-${name}`, deviceName: "A Mac of Bo's" } });
  const macToken = (await mac.json().catch(() => ({}))).token ?? "";
  say(
    "and the same kind of line joins a Mac: a sign-in that syncs",
    mac.status === 201 && /^[a-f0-9]{64}$/.test(macToken) && (await worker("/api/manifest", { token: macToken })).status === 200,
    String(mac.status),
  );

  /* 4 — and signs one of them out */
  await bo.show("devices");
  const theirs = await devicesOf(them.id);
  const other = theirs.find((d) => d.deviceId === secondDevice);
  say("all three are listed as theirs", theirs.length === 3 && (await bo.page.locator('[data-testid="device-list"] > li').count()) === 3, `${theirs.length} devices`);
  await bo.at(`device-sign-out-${other.id}`).click();
  const sure = (await bo.page.locator(`[data-testid="device-${other.id}"] .cloud-inline-confirm`).innerText()).replace(/\s+/g, " ");
  await bo.at(`device-sign-out-yes-${other.id}`).click();
  const rowGone = await until(async () => (await bo.at(`device-${other.id}`).count()) === 0, 15_000);
  say(
    "signing the second browser out says what it does, takes it off the list, and ends its sign-in",
    sure.includes("It is signed out, and deletes what it keeps of Notes, the next time it is used.") &&
      rowGone &&
      (await second.signedOut()) &&
      !(await second.context.cookies(ORIGIN)).some((c) => c.name === "__Host-doklin"),
    sure,
  );

  /* 5 — an agent of their own */
  await bo.show("agents");
  await bo.at("agent-open").click();
  await bo.at("agent-name").fill(`Scout ${name}`);
  await bo.at("agent-save").click();
  await bo.at("agent-login").waitFor({ timeout: 15_000 });
  const prompt = await bo.text("agent-prompt");
  const loginLine = /doklin login (\S+) (dkla(?:-[0-9A-HJKMNP-TV-Z]{5}){4})/.exec(prompt);
  const agentCall = lastTo("/api/auth/agents");
  const sentAgent = JSON.parse(agentCall?.body ?? "{}");
  say(
    "Add an agent makes its login line in the browser, and only the code's sha256 went up",
    loginLine?.[1] === ORIGIN &&
      agentCall?.status === 201 &&
      sentAgent.codeHash === sha(canonical(loginLine[2])) &&
      sentAgent.scopes?.[0] === "read" &&
      !agentCall.body.includes(canonical(loginLine[2])),
    prompt.slice(0, 200),
  );
  const login = await worker("/api/agent/login", { json: { code: loginLine?.[2], host: "a-linux-box" } });
  const agentToken = (await login.json().catch(() => ({}))).token ?? "";
  const whoami = await worker("/api/agent/me", { token: agentToken });
  const agentIs = await whoami.json().catch(() => ({}));
  say("the agent logs in with it, as an agent of that person's", login.status === 201 && whoami.status === 200 && JSON.stringify(agentIs).includes(`Scout ${name}`), JSON.stringify(agentIs).slice(0, 200));
  await bo.show("agents");
  const machine = bo.page.locator('[data-testid^="agent-machine-"]');
  const listedMachine = (await machine.first().innerText({ timeout: 15_000 }).catch(() => "")).replace(/\s+/g, " ");
  const machineId = (await machine.first().getAttribute("data-testid").catch(() => null))?.slice("agent-machine-".length);
  await bo.at(`agent-logout-${machineId}`).click();
  await bo.at(`agent-logout-yes-${machineId}`).click();
  const loggedOut = await until(async () => (await worker("/api/agent/me", { token: agentToken })).status === 401, 15_000);
  say("its machine is listed, and logged out from the browser", listedMachine.includes("a-linux-box") && loggedOut, listedMachine);

  /* 6 — an owner changes their role and removes them, from a browser */
  await boss.show("people");
  const person = await boss.text(`person-${them.id}`);
  say("the owner's browser lists them with their devices", person.includes(`Bo ${name}`) && person.includes("2 devices"), person);
  await boss.at(`set-role-${them.id}`).click();
  await boss.at(`set-role-yes-${them.id}`).click();
  const promoted = await until(async () => (await boss.page.locator(`[data-testid="person-${them.id}"] .cloud-person-tag`, { hasText: "owner" }).count()) === 1, 15_000);
  await bo.show("people");
  say("made an owner, they are offered the invite door the next time they look", promoted && (await bo.at("invite-open").count()) === 1);
  await boss.at(`remove-person-${them.id}`).click();
  const removal = (await boss.page.locator(`[data-testid="person-${them.id}"] .cloud-inline-confirm`).innerText()).replace(/\s+/g, " ");
  await boss.at(`remove-person-yes-${them.id}`).click();
  const personGone = await until(async () => (await boss.at(`person-${them.id}`).count()) === 0, 15_000);
  const macAfter = await worker("/api/poll", { token: macToken });
  say(
    "removed, their browser is back at the sign-in screen and the Mac their browser let in is told to delete its copy",
    removal.includes("deletes what it keeps of Notes") &&
      personGone &&
      (await bo.signedOut()) &&
      macAfter.status === 401 &&
      (await macAfter.json().catch(() => ({}))).removed === true,
    removal,
  );
  say("nothing was refused by the page's policy, and nothing threw", trouble.length === 0, trouble.join(" | "));

  await browser.close();
}

/* ---------- Restricted folders ---------- */

async function driveFolders(name) {
  const say = (what, ok, detail) => step(`${name}, folders: ${what}`, Boolean(ok), detail);
  const browser = await ENGINES[name].launch();
  const trouble = [];
  const open = signedIn(browser, trouble);
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const row = (who, path) => who.page.locator(`[data-tree-path="${ROOT_NAME}/${path}"]`);
  const there = (who, path, ms = 30_000) => row(who, path).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const gone = (who, path, ms = 30_000) => until(async () => (await row(who, path).count()) === 0, ms);
  const pick = async (who, path, label) => {
    await row(who, path).click({ button: "right" });
    await who.page.locator(".sidebar-menu-item").filter({ hasText: new RegExp(`^${label}$`) }).click();
  };
  const labels = async (who, path) => {
    await row(who, path).click({ button: "right" });
    const all = await who.page.locator(".sidebar-menu-item").allInnerTexts();
    await who.page.keyboard.press("Escape");
    return all.map((l) => l.trim());
  };
  /** The page loaded again: what a poll would bring, without waiting for one. */
  const again = async (who) => {
    await who.page.reload();
    await row(who, "Library/Home.md").waitFor({ timeout: 60_000 });
  };
  const dialogText = async (who, id) => (await who.at(id).innerText({ timeout: 15_000 })).replace(/\s+/g, " ").trim();
  const moves = (from) => answered.slice(from).filter((a) => a.method === "POST" && a.path === "/api/web/move");
  const spacesNow = async () => (await (await owner("/api/spaces")).json()).spaces;
  const filesOf = async (space) => Object.values((await (await owner(space ? `/api/spaces/${space}/manifest` : "/api/manifest")).json()).files).map((f) => f.path);

  // Folders of this engine's own: the engines share one worker.
  const PLANS = `Plans ${name}`;
  const BOARD = `Board in ${name}`;
  const HALF = `Half in ${name}`;
  const NONE = `None in ${name}`;
  const DROP = `Drop in ${name}`;
  const SECRET = `Secret ${name}`;
  const other = await elsewhere(browser);
  const mine = (await (await owner("/api/spaces/private", { method: "PUT" })).json()).space.id;
  const put = (path, text, space = "") =>
    other.ask(`/api/web/doc?space=${space}&path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ md: { text, ifRev: null } }) });
  // Twenty-one files where the worker moves sixteen a request.
  for (const dir of [BOARD, HALF]) {
    for (let i = 0; i < 20; i += 1) await put(`${dir}/n${String(i).padStart(2, "0")}.md`, `# Note ${String(i).padStart(2, "0")}\n\nIn ${dir}.\n`);
    await put(`${dir}/Sub/Deep.md`, "# Deep\n");
  }
  for (const dir of [NONE, DROP]) for (const n of ["one", "two"]) await put(`${dir}/${n}.md`, `# ${n}\n`);
  await put(`${SECRET}.md`, "# Secret\n\nFor two people.\n", mine);

  // A second person, with a browser of their own.
  const EMAIL = `fo-${name}@example.com`;
  const code = Array.from({ length: 20 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("");
  const invited = await owner("/api/auth/invites", { method: "POST", json: { email: EMAIL, name: `Fo ${name}`, codeHash: sha(code), expiresAt: Date.now() + 86_400_000 } });
  if (invited.status !== 201) throw new Error(`could not invite a second person: ${invited.status}`);
  const boss = await open("the owner");
  const fo = await open("a second person");
  await boss.signIn(`doklin-invite ${ORIGIN} ${await deviceCode()}`);
  await fo.signIn(`doklin-invite ${ORIGIN} dkln-${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}-${code.slice(15)}`);
  const them = (await (await owner("/api/auth/members")).json()).members.find((m) => m.email === EMAIL);

  /* 1 — a new restricted folder, with somebody in it */
  let from = answered.length;
  await boss.at("section-restricted").hover();
  await boss.at("new-restricted").click();
  await boss.at("restricted-people").waitFor({ timeout: 15_000 });
  const newHint = await dialogText(boss, "restricted-folder");
  await boss.at("restricted-name").fill(PLANS);
  await boss.at(`restricted-pick-${them.id}`).check();
  await boss.at("restricted-create").click();
  const madeRow = await there(boss, `Restricted/${PLANS}`);
  const makeCall = answered.slice(from).find((a) => a.method === "POST" && a.path === "/api/spaces");
  const plans = (await spacesNow()).find((s) => s.name === PLANS);
  say(
    "a browser offers a new restricted folder, and makes it with the people picked: it is in the tree at once",
    newHint.includes("only on the devices of the people in it") &&
      madeRow &&
      makeCall?.status === 201 &&
      JSON.stringify(JSON.parse(makeCall.body).members) === JSON.stringify([them.id]) &&
      plans?.members.length === 2 &&
      (await boss.at("restricted-folder").count()) === 0,
    makeCall?.body,
  );
  await again(fo);
  say("the person put in it sees it, in their own browser", await there(fo, `Restricted/${PLANS}`));

  /* 2 — Manage access…: somebody taken out, and put back */
  await pick(boss, `Restricted/${PLANS}`, "Manage access…");
  await boss.at("space-members").waitFor({ timeout: 15_000 });
  const accessHint = await dialogText(boss, "space-access");
  await boss.at(`space-out-${them.id}`).click();
  await boss.at(`space-out-yes-${them.id}`).click();
  const takenOut = await until(async () => (await boss.at("space-members").locator("li").count()) === 1, 15_000);
  await again(fo);
  const hidden = (await row(fo, `Restricted/${PLANS}`).count()) === 0;
  await boss.at(`space-add-${them.id}`).click();
  const putBack = await until(async () => (await boss.at("space-members").locator("li").count()) === 2, 15_000);
  await boss.page.locator('[data-testid="space-access"] .modal-close').click();
  await again(fo);
  say(
    "Manage access… takes a person out, who stops seeing the folder, and puts them back",
    accessHint.includes("on their own devices") && takenOut && hidden && putBack && (await there(fo, `Restricted/${PLANS}`)),
    accessHint,
  );

  /* 3 — Restrict access… on a folder larger than one request moves */
  await row(boss, `Library/${BOARD}`).click();
  await row(boss, `Library/${BOARD}/n00.md`).click();
  const editorHas = (who, text, ms = 30_000) =>
    who.page.waitForFunction((t) => (document.querySelector(".ProseMirror")?.innerText ?? "").includes(t), text, { timeout: ms }).then(() => true, () => false);
  await editorHas(boss, "Note 00");
  const offered = await labels(boss, `Library/${BOARD}`);
  from = answered.length;
  await pick(boss, `Library/${BOARD}`, "Restrict access…");
  await boss.at("restricted-people").waitFor({ timeout: 15_000 });
  const restrictHint = await dialogText(boss, "restricted-folder");
  const prefilled = await boss.at("restricted-name").inputValue();
  await boss.at(`restricted-pick-${them.id}`).check();
  await boss.at("restricted-create").click();
  const restricted = await there(boss, `Restricted/${BOARD}`, 60_000);
  await until(async () => (await boss.at("restricted-folder").count()) === 0, 30_000);
  const board = (await spacesNow()).find((s) => s.name === BOARD);
  const boardMoves = moves(from);
  const inBoard = board ? await filesOf(board.id) : [];
  const leftBehind = (await filesOf("")).filter((x) => x.startsWith(`${BOARD}/`));
  say(
    "a folder of 21 files becomes a restricted folder in two requests, and nothing of it is left where everyone could open it",
    offered.includes("Restrict access…") &&
      prefilled === BOARD &&
      restrictHint.includes("removed from everyone else’s devices") &&
      restricted &&
      boardMoves.length === 2 &&
      boardMoves.every((m) => m.status === 200) &&
      inBoard.length === 21 &&
      inBoard.includes("n00.md") &&
      inBoard.includes("Sub/Deep.md") &&
      leftBehind.length === 0 &&
      (await row(boss, `Library/${BOARD}`).count()) === 0,
    `${boardMoves.length} move(s): ${boardMoves.map((m) => m.status).join(", ")}; ${inBoard.length} file(s) in it, ${leftBehind.length} left behind`,
  );
  if ((await row(boss, `Restricted/${BOARD}/n00.md`).count()) === 0) await row(boss, `Restricted/${BOARD}`).click();
  await there(boss, `Restricted/${BOARD}/n00.md`);
  const followed = await until(async () => /\bis-active\b/.test((await row(boss, `Restricted/${BOARD}/n00.md`).getAttribute("class")) ?? ""), 15_000);
  say("the note open in it follows it there, still open", followed && (await editorHas(boss, "Note 00", 5_000)));
  await again(fo);
  await row(fo, `Restricted/${BOARD}`).click();
  await row(fo, `Restricted/${BOARD}/n07.md`).click();
  say("the person picked opens a note of it in their own browser", await editorHas(fo, "Note 07"));
  // Closed again: the rest of this is done in a tree short enough to see whole.
  await row(boss, `Restricted/${BOARD}`).click();
  await gone(boss, `Restricted/${BOARD}/n00.md`, 5_000);

  /* 4 — Share with…: a private note goes into a new folder with somebody */
  const privateMenu = await labels(boss, `Private/${SECRET}.md`);
  await pick(boss, `Private/${SECRET}.md`, "Share with…");
  await boss.at("restricted-people").waitFor({ timeout: 15_000 });
  const aloneDisabled = await boss.at("restricted-create").isDisabled();
  await boss.at(`restricted-pick-${them.id}`).check();
  await boss.at("restricted-create").click();
  await there(boss, `Restricted/${SECRET}`, 60_000);
  await until(async () => (await boss.at("restricted-folder").count()) === 0, 30_000);
  if ((await row(boss, `Restricted/${SECRET}/${SECRET}.md`).count()) === 0) await row(boss, `Restricted/${SECRET}`).click();
  const shared = await there(boss, `Restricted/${SECRET}/${SECRET}.md`, 15_000);
  const secret = (await spacesNow()).find((s) => s.name === SECRET);
  say(
    "Share with… moves a private note into a new folder with the person picked",
    privateMenu.includes("Share with…") &&
      aloneDisabled &&
      shared &&
      (await gone(boss, `Private/${SECRET}.md`)) &&
      secret?.members.includes(them.id) &&
      (await filesOf(secret.id)).includes(`${SECRET}.md`) &&
      !(await filesOf(mine)).includes(`${SECRET}.md`),
  );

  /* 5 — a folder dropped on Restricted becomes one, after a question */
  await row(boss, `Library/${DROP}`).scrollIntoViewIfNeeded();
  const a = await row(boss, `Library/${DROP}`).boundingBox();
  const b = await boss.at("section-restricted").locator(".sidebar-section-label").boundingBox();
  await boss.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await boss.page.mouse.down();
  await boss.page.mouse.move(a.x + a.width / 2 + 9, a.y + a.height / 2 + 9, { steps: 3 });
  await boss.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await sleep(150);
  await boss.page.mouse.up();
  const asked = await boss.at("question-prompt").waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const question = asked ? await dialogText(boss, "question-prompt") : "";
  if (asked) await boss.at("question-yes").click();
  const dropped = await there(boss, `Restricted/${DROP}`, 60_000);
  const drop = (await spacesNow()).find((s) => s.name === DROP);
  say(
    "a folder dropped on Restricted is asked about, then becomes a restricted folder of its name with only its maker in it",
    question.includes(`Restrict “${DROP}”?`) &&
      dropped &&
      drop?.members.length === 1 &&
      (await filesOf(drop.id)).sort().join() === "one.md,two.md" &&
      (await gone(boss, `Library/${DROP}`)),
    question || `no question: dragged from ${JSON.stringify(a)} to ${JSON.stringify(b)}`,
  );

  /* 6 — a restricting that stops part of the way says so, in numbers */
  const REASON = "the bucket is not answering — try again in a moment";
  let asks = 0;
  refusing = (req) => (req.method === "POST" && req.url === "/api/web/move" && (asks += 1) === 2 ? { status: 503, error: REASON } : null);
  await pick(boss, `Library/${HALF}`, "Restrict access…");
  await boss.at("restricted-people").waitFor({ timeout: 15_000 });
  await boss.at("restricted-create").click();
  const partway = await boss.page.locator('[data-testid="restricted-folder"] .modal-error').innerText({ timeout: 60_000 }).catch(() => "");
  refusing = null;
  const half = (await spacesNow()).find((s) => s.name === HALF);
  const stillShared = (await filesOf("")).filter((x) => x.startsWith(`${HALF}/`));
  say(
    "stopped after the first sixteen files: the sentence says how many reached the folder and where the rest still are",
    partway.includes(`“${HALF}” was made, but only 16 of 21 files reached it`) &&
      partway.includes("The bucket is not answering") &&
      partway.includes(`The rest are still in “${HALF}”, open to whoever could open them before`) &&
      half !== undefined &&
      (await filesOf(half.id)).length === 16 &&
      stillShared.length === 5 &&
      (await there(boss, `Restricted/${HALF}`)) &&
      (await row(boss, `Library/${HALF}`).count()) === 1,
    partway,
  );
  await boss.page.locator('[data-testid="restricted-folder"] .modal-close').click();

  /* 7 — and one that moves nothing leaves no folder behind */
  from = answered.length;
  refusing = (req) => (req.method === "POST" && req.url === "/api/web/move" ? { status: 503, error: REASON } : null);
  await pick(boss, `Library/${NONE}`, "Restrict access…");
  await boss.at("restricted-people").waitFor({ timeout: 15_000 });
  await boss.at("restricted-create").click();
  const nothing = await boss.page.locator('[data-testid="restricted-folder"] .modal-error').innerText({ timeout: 60_000 }).catch(() => "");
  refusing = null;
  const takenBack = answered.slice(from).some((x) => x.method === "DELETE" && /^\/api\/spaces\/s-/.test(x.path) && x.status === 200);
  say(
    "stopped before anything moved: the folder made for it is taken back, and the sentence is the reason alone",
    nothing.trim() === "The bucket is not answering — try again in a moment" &&
      takenBack &&
      !(await spacesNow()).some((s) => s.name === NONE) &&
      (await row(boss, `Restricted/${NONE}`).count()) === 0 &&
      (await filesOf("")).filter((x) => x.startsWith(`${NONE}/`)).length === 2 &&
      (await boss.page.locator(".toast-text", { hasText: "no longer on this" }).count()) === 0,
    nothing,
  );
  await boss.page.locator('[data-testid="restricted-folder"] .modal-close').click();

  /* 8 — leaving a folder */
  await pick(fo, `Restricted/${BOARD}`, "Manage access…");
  await fo.at("space-leave").click();
  const leaveAsk = await dialogText(fo, "space-leave-confirm");
  await fo.at("space-leave-yes").click();
  const left = await gone(fo, `Restricted/${BOARD}`);
  say(
    "somebody leaves a folder from their browser: it goes from their tree, the note of it they had open closes, and nothing says they were taken out",
    leaveAsk.includes("It is removed from this browser. The others keep theirs.") &&
      left &&
      (await fo.at("space-access").count()) === 0 &&
      !(await editorHas(fo, "Note 07", 1_000)) &&
      (await fo.page.locator(".toast-text", { hasText: "no longer on this" }).count()) === 0 &&
      !(await spacesNow()).find((s) => s.name === BOARD)?.members.includes(them.id),
    leaveAsk,
  );

  /* 9 — and deleting one, for everyone in it */
  from = answered.length;
  await pick(boss, `Restricted/${PLANS}`, "Manage access…");
  await boss.at("space-delete").click();
  const deleteAsk = await dialogText(boss, "space-delete-confirm");
  await boss.at("space-delete-yes").click();
  const deleted = await gone(boss, `Restricted/${PLANS}`);
  await again(fo);
  say(
    "a folder deleted from a browser is gone for everyone in it",
    deleteAsk.includes("from the devices of each person in it") &&
      deleted &&
      answered.slice(from).some((x) => x.method === "DELETE" && x.path === `/api/spaces/${plans.id}` && x.status === 200) &&
      !(await spacesNow()).some((s) => s.id === plans.id) &&
      (await row(fo, `Restricted/${PLANS}`).count()) === 0,
    deleteAsk,
  );
  say("nothing was refused by the page's policy, and nothing threw", trouble.length === 0, trouble.join(" | "));

  // The folders this made go with it: the next engine's owner is in none of them.
  for (const s of await spacesNow()) {
    if (s.kind !== "restricted" || !s.name.endsWith(name)) continue;
    while ((await (await owner(`/api/spaces/${s.id}`, { method: "DELETE" })).json()).remaining) {
      // a request's worth at a time
    }
  }
  await other.close();
  await browser.close();
}

/* ---------- Tags ---------- */

async function driveTags(name) {
  const say = (what, ok, detail) => step(`${name}, tags: ${what}`, Boolean(ok), detail);
  const browser = await ENGINES[name].launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Win32" }));
  const page = await context.newPage();
  const trouble = [];
  let stage = "starting";
  page.on("console", (m) => {
    if (process.env.DEBUG_DRIVE) console.log(`  [${stage}] console.${m.type()}: ${m.text().slice(0, 200)}`);
    if (/Content Security Policy|Content-Security-Policy|Refused to/i.test(m.text())) trouble.push(`${stage}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => trouble.push(`${stage}: ${String(e).slice(0, 200)}`));

  // A folder of this engine's own; the list is the workspace's (its manifest's), made by each engine in its turn.
  const DIR = `Tags in ${name}`;
  const ONE = `${DIR}/One.md`;
  const TWO = `${DIR}/Two.md`;
  const THREE = `${DIR}/Three.md`;
  const other = await elsewhere(browser);
  const put = async (path, text) =>
    other.ask(`/api/web/doc?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ md: { text, ifRev: (await storedAt(path))?.rev ?? null } }) });
  const tagsNow = async () => (await (await owner("/api/manifest")).json()).tags ?? [];
  await other.ask("/api/web/tags", {
    method: "PUT",
    body: JSON.stringify({ at: "status", tag: { name: "status", values: ["Todo", "Doing", "Done"], desc: "What each value means." } }),
  });
  await put(ONE, "---\nstatus: Doing\n---\n# One\n\nA heron by the water.\n");
  await put(TWO, "---\nstatus: doing\nowner: Ada\n---\nTwo.\n");
  await put(THREE, "---\nstatus: Done\n---\nA heron too.\n");

  const row = (path) => page.locator(`[data-tree-path="${LIBRARY}/${path}"]`);
  const pane = () => page.locator(".editor-pane.is-focused");
  const chip = (tag) => pane().locator(`[data-testid="tag-chip-${tag}"]`);
  const menuItem = (label) => page.locator(".tag-menu").getByRole("menuitem", { name: label, exact: true });
  const names = () => page.locator(".ws-result-file-name").evaluateAll((els) => els.map((el) => el.innerText));
  const searched = (from) => answered.slice(from).filter((a) => a.method === "GET" && a.path.startsWith("/api/web/search"));

  await page.goto(`${ORIGIN}/app`);
  await page.locator('[data-testid="web-invite"]').fill(`doklin-invite ${ORIGIN} ${await deviceCode()}`);
  await page.click('[data-testid="web-sign-in"]');
  await row("Home.md").waitFor({ timeout: 60_000 });

  /* 1 — search by tag */
  stage = "search by tag";
  let from = answered.length;
  await page.locator(".sidebar-search").click();
  const input = page.locator(".ws-search-input");
  await input.fill("status:Doing");
  const byTag = await until(async () => {
    const got = await names();
    return got.length === 2 ? got : null;
  }, 30_000);
  const asked = searched(from);
  say(
    "status:Doing lists the notes with that tag, asked of the worker as a tag and no text",
    JSON.stringify(byTag) === JSON.stringify(["One", "Two"]) && asked.some((a) => a.status === 200 && /[?&]q=&/.test(a.path) && /[?&]tag=status%3ADoing\b/.test(a.path)),
    `${JSON.stringify(byTag)} ${asked.map((a) => a.path).join(" ")}`,
  );
  await input.fill("heron status:done");
  const withWords = await until(async () => {
    const got = await names();
    return JSON.stringify(got) === JSON.stringify(["Three"]) ? got : null;
  }, 30_000);
  say("words beside a tag find lines in the notes with it alone", withWords !== null, JSON.stringify(await names()));
  await page.keyboard.press("Escape");

  /* 2 — a value renamed */
  stage = "a value renamed";
  await row(DIR).click();
  await row(ONE).click();
  await chip("status").waitFor({ timeout: 30_000 });
  const before = (await chip("status").innerText()).replace(/\s+/g, " ").trim();
  await chip("status").click();
  await menuItem("Edit status…").click();
  const dialog = page.locator('[data-testid="tag-edit-dialog"]');
  await dialog.locator('[data-testid="tag-edit-value-1"]').fill("In progress");
  from = answered.length;
  await dialog.locator('[data-testid="tag-edit-save"]').click();
  const rewritten = await until(async () => {
    const [one, two, list] = await Promise.all([storedAt(ONE), storedAt(TWO), tagsNow()]);
    return one?.text.startsWith("---\nstatus: In progress\n---\n") &&
      two?.text === "---\nstatus: In progress\nowner: Ada\n---\nTwo.\n" &&
      JSON.stringify(list) === JSON.stringify([{ name: "status", values: ["Todo", "In progress", "Done"], desc: "What each value means." }])
      ? true
      : null;
  }, 45_000);
  say("the chip reads the note's value as the list spells it", before === "status Doing", before);
  say(
    "a value renamed rewrites the list, the open note and every other note that has it",
    rewritten && (await storedAt(THREE)).text === "---\nstatus: Done\n---\nA heron too.\n",
    JSON.stringify([(await storedAt(ONE))?.text, (await storedAt(TWO))?.text, await tagsNow()]),
  );
  say("…the notes found by a search for the old value", searched(from).some((a) => /[?&]tag=status%3ADoing\b/.test(a.path)));
  const after = await until(async () => {
    const text = (await chip("status").innerText()).replace(/\s+/g, " ").trim();
    return text === "status In progress" ? text : null;
  }, 15_000);
  say("the open note's chip follows", after !== null);

  /* 3 — Settings' Tags */
  stage = "Settings' Tags";
  const tagsPage = page.locator('[data-testid="tags-settings"]');
  await page.locator(".settings-fab").click();
  await page.locator('[data-testid="settings-tags"]').click();
  await tagsPage.waitFor({ timeout: 15_000 });
  const listed = (await tagsPage.locator(".tags-page-row").first().innerText()).replace(/\s+/g, " ").trim();
  from = answered.length;
  await tagsPage.locator('[data-testid="tags-new"]').click();
  await tagsPage.locator('[data-testid="tag-new-name"]').fill("Size");
  await tagsPage.locator('[data-testid="tag-new-values"]').fill("S\nM");
  await tagsPage.locator('[data-testid="tag-new-create"]').click();
  const made = await until(async () => ((await tagsNow()).some((d) => d.name === "Size") ? true : null), 15_000);
  const rows = await until(async () => ((await tagsPage.locator(".tags-page-row").count()) === 2 ? true : null), 15_000);
  say(
    "Settings' Tags lists the workspace's tags with what their values mean, and New tag adds one to the workspace",
    listed === "status Edit Todo In progress Done What each value means." &&
      made &&
      rows &&
      answered.slice(from).some((a) => a.method === "PUT" && a.path === "/api/web/tags" && a.status === 200),
    listed,
  );
  await tagsPage.locator('[data-testid="tags-edit-Size"]').click();
  await tagsPage.locator('[data-testid="tag-edit-delete"]').click();
  await tagsPage.locator('[data-testid="tag-edit-delete-confirm"]').click();
  const gone = await until(
    async () => (!(await tagsNow()).some((d) => d.name === "Size") && (await tagsPage.locator(".tags-page-row").count()) === 1 ? true : null),
    15_000,
  );
  say(
    "Delete takes it out of the workspace's tags, and the page's list follows",
    gone,
    JSON.stringify({ tags: await tagsNow(), rows: await tagsPage.locator(".tags-page-row").count(), error: await tagsPage.locator(".modal-error").allInnerTexts() }),
  );
  await page.keyboard.press("Escape");
  say("nothing was refused by the page's policy, and nothing threw", trouble.length === 0, trouble.join(" | "));

  await other.ask(`/api/web/folder?path=${encodeURIComponent(DIR)}`, { method: "DELETE" });
  await other.ask("/api/web/tags?name=status", { method: "DELETE" });
  await other.close();
  await browser.close();
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
if (parts.has("files")) await driveFiles();
for (const name of wanted) {
  if (!ENGINES[name]) throw new Error(`no such engine: ${name} (chromium, firefox, webkit)`);
  if (!(await installed(name))) continue;
  driven += 1;
  if (parts.has("cookie")) await drive(name);
  if (parts.has("app")) await driveApp(name);
  if (parts.has("writing")) await driveWriting(name);
  if (parts.has("rest")) await driveRest(name);
  if (parts.has("access")) await driveAccess(name);
  if (parts.has("folders")) await driveFolders(name);
  if (parts.has("tags")) await driveTags(name);
}
if (wanted.includes("chromium") && parts.has("cache")) await driveCache();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed, in ${driven} of ${wanted.length} engines`);
process.exit(passed === results.length && driven > 0 ? 0 : 1);
