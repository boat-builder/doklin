// Verification harness: mounts the REAL HtmlView (the page's script, the
// overlay, the column of cards, the thread model — no reimplementation) the
// way App.tsx does, with in-memory state in place of the entity meta file.
// Driven by Playwright (drive.mjs); not part of the app.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import HtmlView from "../src/HtmlView";
import type { HtmlThread } from "../src/htmlComments";
import "../src/App.css";
import { installBackend } from "../src/backend";
import { macBackend } from "../src/mac/backend";

// The Mac's backend, answered by the page's IPC stub.
installBackend(macBackend);

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
    <div style="height: 900px"></div>
    <p id="tail">A closing remark at the end of the document.</p>
  </main>
</body></html>`;

// Same text for #intro but the structure around it changed (found again by
// its words); the card and the paragraph with the link are gone entirely
// (lost).
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
    __setVisible: (v: boolean) => void;
    // Document zoom (⌘+ / ⌘-), as the app hands it to the view.
    __setZoom: (z: number) => void;
    // A page and the threads on it, for one case of the shared fixture: the
    // threads are handed over only once the new page's script is ready, so
    // no place is ever read off the page before it.
    __setCase: (html: string, threads: HtmlThread[]) => void;
    // What the page's script last said of each thread's place, by thread id.
    __places: Record<string, { state: string }>;
  }
}

function Harness() {
  const [threads, setThreads] = useState<HtmlThread[]>([]);
  const [html, setHtml] = useState(PAGE_V1);
  const [visible, setVisible] = useState(true);
  const [zoom, setZoom] = useState(1);
  const awaited = useRef<HtmlThread[] | null>(null);
  const cases = useRef(0);

  useEffect(() => {
    window.__places = {};
    window.__setVisible = setVisible;
    window.__setZoom = setZoom;
    window.__setCase = (page, list) => {
      window.__places = {};
      awaited.current = list;
      setThreads([]);
      // A page the same as the last still has to load afresh.
      setHtml(`${page}<!-- case ${(cases.current += 1)} -->`);
    };
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { dk?: string; type?: string; places?: { id: string; state: string }[] } | null;
      if (!msg || msg.dk !== "doklin-comments") return;
      if (msg.type === "ready" && awaited.current) {
        setThreads(awaited.current);
        awaited.current = null;
      } else if (msg.type === "layout" && !awaited.current) {
        window.__places = Object.fromEntries((msg.places ?? []).map((p) => [p.id, p]));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    window.__setHtml = (v) => setHtml(v === "v2" ? PAGE_V2 : PAGE_V1);
    window.__threads = () => threads;
    // One JSON line per thread — what the drive counts and greps.
    document.getElementById("thread-dump")!.textContent = threads
      .map((t) => JSON.stringify(t))
      .join("\n");
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
      commentsVisible={visible}
      zoom={zoom}
      onRequestShowComments={() => setVisible(true)}
      onToggleComments={() => setVisible((v) => !v)}
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
