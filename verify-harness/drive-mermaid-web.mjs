// Drives mermaid on the PUBLIC web surfaces against the real worker: the
// static reading view (```mermaid blocks hydrate into SVG, tracking light and
// dark) and the app shell (the editor loads the worker-served mermaid module
// — the shell bundle itself ships without mermaid). Run:
//
//   node scripts/build-web.mjs               # once, or after editor changes
//   node verify-harness/serve-worker.mjs &
//   node verify-harness/drive-mermaid-web.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:8787";
const OWNER = "owner-secret";
const SHOTS = new URL("./shots-web/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function poll(fn, timeout = 15000, every = 120) {
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

const api = async (path, body, method = body === undefined ? "GET" : "PUT") => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const MD = `# Release flow

\`\`\`mermaid
flowchart LR
  A[Draft] --> B{Review?}
  B -- yes --> C[Publish]
  B -- no --> A
\`\`\`

A broken one stays a code block:

\`\`\`mermaid
flowchart LR
  A[unclosed --> B
\`\`\`
`;

/* ----- seed: one public page, one gated editable page ----- */

await api("/api/pages/diagram-pub", undefined, "DELETE");
await api("/api/pages/diagram-pub", { title: "Diagram public", markdown: MD });
await api("/api/pages/diagram-edit", undefined, "DELETE");
await api("/api/pages/diagram-edit", { title: "Diagram editable", markdown: MD });
await api(
  "/api/pages/diagram-edit/access/codes",
  { label: "Editor", code: "web-edit-code", role: "edit" },
  "POST",
);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

/* ---------- static reading view ---------- */

const pub = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
pub.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pub.goto(`${BASE}/diagram-pub`);
await poll(async () => (await pub.locator(".doc .dk-mermaid svg").count()) === 1);
step("static page: the good diagram hydrates into SVG", true);
const stillCode = await pub.locator(".doc pre > code.language-mermaid").count();
step("static page: the broken block stays a plain code block", stillCode === 1);
const lightStyle = await pub.evaluate(
  () => document.querySelector(".dk-mermaid svg style").textContent,
);
step(
  "static page: diagram wears the page palette (light bg)",
  lightStyle.includes("#ffffff"),
);
await pub.screenshot({ path: `${SHOTS}/mermaid-static-light.png`, fullPage: true });

await pub.emulateMedia({ colorScheme: "dark" });
await poll(async () =>
  pub.evaluate(
    (prev) => document.querySelector(".dk-mermaid svg style").textContent !== prev,
    lightStyle,
  ),
);
step("static page: scheme flip re-renders with the dark palette", true);
await pub.screenshot({ path: `${SHOTS}/mermaid-static-dark.png`, fullPage: true });
await pub.close();

/* ---------- app shell (edit role) ---------- */

const shell = await (
  await browser.newContext({ viewport: { width: 1360, height: 900 } })
).newPage();
shell.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const mermaidRequests = [];
shell.on("request", (r) => {
  if (r.url().includes("/mermaid.js")) mermaidRequests.push(r.url());
});
await shell.goto(`${BASE}/diagram-edit`);
await poll(async () => shell.locator("#gate-code").isVisible());
await shell.fill("#gate-code", "web-edit-code");
await shell.press("#gate-code", "Enter");
await poll(async () => (await shell.locator(".milkdown .dk-mermaid svg").count()) >= 1);
step("app shell: the editor renders the diagram in the code block preview", true);
step(
  "app shell: mermaid came from the worker's /__web asset (not the shell bundle)",
  mermaidRequests.some((u) => u.includes("/__web/")),
  mermaidRequests[0] ?? "no request seen",
);
await poll(async () => shell.locator(".dk-mermaid-error").count());
step("app shell: the broken block shows the quiet error card", true);
await shell.screenshot({ path: `${SHOTS}/mermaid-shell-edit.png`, fullPage: true });
await shell.close();

/* ---------- verdict ---------- */

await api("/api/pages/diagram-pub", undefined, "DELETE");
await api("/api/pages/diagram-edit", undefined, "DELETE");
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
await browser.close();
process.exit(failed.length > 0 ? 1 : 0);
