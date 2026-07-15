// Verification harness: mounts the REAL HtmlView (bridge, comment-mode
// overlay, sidecar model — no reimplementation) the way App.tsx does, with
// in-memory state in place of the sidecar file. Driven by Playwright; not
// part of the app.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import HtmlView from "../src/HtmlView";
import { serializeHtmlComments, type HtmlThread } from "../src/htmlComments";
import "../src/App.css";

const PAGE_V1 = `<!doctype html>
<html><head><style>
  body { font-family: Georgia, serif; margin: 0; background: #fff; }
  .hero { padding: 28px 40px; background: #f5f1e8; }
  main { padding: 20px 40px; max-width: 640px; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 14px; margin: 14px 0; }
  button { padding: 6px 12px; }
</style></head>
<body>
  <div class="hero"><h1>Quarterly Report</h1><p id="subtitle">A generated rendition with interactive bits.</p></div>
  <main>
    <p id="intro">The intro paragraph everyone will want to comment on.</p>
    <div class="card" id="metrics-card">
      <h2>Metrics</h2>
      <p>Revenue grew 14 percent quarter over quarter.</p>
      <button id="counter" onclick="this.textContent='clicked ' + (++window.__count || (window.__count=1)) + 'x'">clicked 0x</button>
    </div>
    <p>Read the <a id="ext" href="https://example.com/details">full details</a> online.</p>
    <p id="tail">A closing remark at the end of the document.</p>
  </main>
</body></html>`;

// Same text for #intro but the structure around it changed (re-anchor case);
// the subtitle paragraph is gone entirely (orphan case).
const PAGE_V2 = `<!doctype html>
<html><head><style>
  body { font-family: Georgia, serif; margin: 0; background: #fff; }
  .wrapper { padding: 20px 40px; }
</style></head>
<body>
  <div class="wrapper">
    <h1>Quarterly Report (v2)</h1>
    <section><p id="intro">The intro paragraph everyone will want to comment on.</p></section>
    <p id="tail">A closing remark at the end of the document.</p>
  </div>
</body></html>`;

declare global {
  interface Window {
    __setHtml: (v: "v1" | "v2") => void;
    __threads: () => HtmlThread[];
  }
}

function Harness() {
  const [threads, setThreads] = useState<HtmlThread[]>([]);
  const [html, setHtml] = useState(PAGE_V1);

  useEffect(() => {
    window.__setHtml = (v) => setHtml(v === "v2" ? PAGE_V2 : PAGE_V1);
    window.__threads = () => threads;
    document.getElementById("sidecar-dump")!.textContent =
      serializeHtmlComments(threads);
  }, [threads]);

  useEffect(() => {
    // onclick assignment (not addEventListener): StrictMode double-mounts
    // this harness and duplicate listeners would double-toggle.
    (document.getElementById("regen-keep") as HTMLButtonElement).onclick = () =>
      setHtml(PAGE_V2);
  }, []);

  return (
    <HtmlView
      htmlContent={html}
      threads={threads}
      onThreadsChange={setThreads}
      commentAuthor="Sherin's Mac"
    />
  );
}

const stage = document.getElementById("stage")!;
stage.className = "editor-wrap is-html-view";
createRoot(stage).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
