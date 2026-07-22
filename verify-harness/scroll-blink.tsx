// Diagnosis harness: mounts the REAL Editor with a document containing large
// code blocks (some long wrapped lines) and instruments the scroll container
// for mid-scroll layout corrections — the suspected cause of the "blink +
// scroll position slightly adjusts" report. A rAF loop records every
// scrollHeight change (CodeMirror viewport re-render correcting its height
// estimate) and every scrollTop change that was not initiated by the driver
// (browser scroll anchoring compensating for content growth above the
// viewport). Not part of the app.
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import "../src/App.css";
import "../web/web.css";

declare global {
  interface Window {
    __md: string;
    __events: Array<Record<string, unknown>>;
    __startMonitor: () => void;
    __gapCount: () => number;
  }
}

const longLine = (i: number) =>
  `const handler${i} = createHandler({ retries: 5, backoffMs: 250, onFailure: (err) => logger.error("handler ${i} failed with an unusually verbose diagnostic message that wraps", err), onSuccess: (res) => metrics.increment("handler.${i}.ok", { region: res.region, shard: res.shard }) });`;

const codeBlock = (lines: number, tag: string) => {
  const body = Array.from({ length: lines }, (_, i) =>
    i % 6 === 5 ? longLine(i) : `function ${tag}_${i}() { return ${i}; } // ${tag}`,
  ).join("\n");
  return "```ts\n" + body + "\n```";
};

const paras = (n: number, tag: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Paragraph ${tag}-${i}: prose between the code blocks so the page scrolls through mixed content, the way a real document does.`,
  ).join("\n\n");

const DOC = `# Scroll blink harness

${paras(8, "intro")}

${codeBlock(240, "alpha")}

${paras(8, "middle")}

${codeBlock(140, "beta")}

${paras(8, "tail")}
`;

window.__md = DOC;
window.__events = [];
window.__gapCount = () => document.querySelectorAll(".cm-gap").length;

window.__startMonitor = () => {
  const wrap = document.querySelector(".editor-wrap") as HTMLElement;
  let lastH = wrap.scrollHeight;
  let lastTop = wrap.scrollTop;
  const tick = () => {
    const h = wrap.scrollHeight;
    const top = wrap.scrollTop;
    if (h !== lastH) {
      window.__events.push({
        kind: "height",
        t: Math.round(performance.now()),
        dH: h - lastH,
        top,
        gaps: window.__gapCount(),
      });
    }
    if (top !== lastTop) {
      window.__events.push({
        kind: "scroll",
        t: Math.round(performance.now()),
        dTop: Math.round((top - lastTop) * 100) / 100,
        top: Math.round(top * 100) / 100,
      });
    }
    lastH = h;
    lastTop = top;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

function Harness() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  return (
    <div className="editor-wrap" style={{ height: "100vh", overflow: "auto" }}>
      <Editor initialMarkdown={DOC} onChange={onChange} readOnly={false} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
