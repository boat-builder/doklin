// Diagnosis harness: mounts the REAL Editor and watches an IDLE page — no
// scrolling, no typing — for code-block mount/teardown churn.
//
// Crepe's code-block node view lazy-mounts CodeMirror when a block comes
// within 200px of the viewport and tears it back down 5s after it leaves
// (@milkdown/components CodeMirrorBlock.TEARDOWN_DELAY). Every swap that
// isn't height-neutral moves the document under the reader. This harness
// records each swap with the block's height before/after, plus every
// scrollHeight/scrollTop change, so a self-sustaining mount⇄teardown
// oscillation shows up as a periodic event train on a page nobody touched.
//
// The document is the driver's (window.__md, set before load) or the
// built-in mixed doc below. Not part of the app.
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import "../src/App.css";
import "../web/web.css";

type BlinkEvent = Record<string, unknown>;

declare global {
  interface Window {
    __md?: string;
    __events: BlinkEvent[];
    __startMonitor: () => void;
    __blocks: () => Array<Record<string, unknown>>;
  }
}

const paras = (n: number, tag: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Paragraph ${tag}-${i}: prose between the blocks so the page scrolls through mixed content, the way a real document does.`,
  ).join("\n\n");

const codeBlock = (lines: number, tag: string) =>
  "```ts\n" +
  Array.from({ length: lines }, (_, i) => `function ${tag}_${i}() { return ${i}; }`).join(
    "\n",
  ) +
  "\n```";

const MERMAID = `\`\`\`mermaid
flowchart TD
  A[Client] --> B[Gateway]
  B --> C[Planner]
  C --> D[Tool runtime]
  D --> E[(Store)]
  C --> F[Critic]
  F --> C
  E --> G[Reporter]
\`\`\``;

const DOC = `# Idle blink harness

${paras(6, "intro")}

${MERMAID}

${paras(6, "after-diagram")}

${codeBlock(30, "alpha")}

${paras(6, "middle")}

${MERMAID}

${paras(6, "tail")}

${codeBlock(20, "beta")}

${paras(10, "end")}
`;

// Height of every code block, sampled continuously so a teardown can report
// what the block measured while it was mounted.
const heights = new WeakMap<Element, number>();

const blockInfo = (el: Element) => {
  const blocks = [...document.querySelectorAll(".milkdown-code-block")];
  const lang = el.querySelector(".milkdown-code-block-preview") ? "preview" : "";
  return {
    idx: blocks.indexOf(el),
    lang: el.getAttribute("data-language") ?? lang,
    mermaid: !!el.querySelector("svg[id^='mermaid'], .mermaid-preview, .dk-mermaid"),
  };
};

window.__events = [];
window.__blocks = () =>
  [...document.querySelectorAll(".milkdown-code-block")].map((el, i) => {
    const r = el.getBoundingClientRect();
    const wrap = document.querySelector(".editor-wrap") as HTMLElement;
    const wrapRect = wrap.getBoundingClientRect();
    return {
      idx: i,
      mounted: !el.querySelector(".milkdown-code-block-placeholder"),
      top: Math.round(r.top - wrapRect.top + wrap.scrollTop),
      height: Math.round(r.height),
      hasSvg: !!el.querySelector("svg"),
    };
  });

window.__startMonitor = () => {
  const wrap = document.querySelector(".editor-wrap") as HTMLElement;
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);

  // Keep a live height per block so a swap can report the delta it caused.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) heights.set(e.target, e.contentRect.height);
  });
  const observeAll = () => {
    for (const el of document.querySelectorAll(".milkdown-code-block")) {
      ro.observe(el);
      if (!heights.has(el)) heights.set(el, el.getBoundingClientRect().height);
    }
  };
  observeAll();

  new MutationObserver((records) => {
    for (const rec of records) {
      const target = rec.target as HTMLElement;
      const block = target.classList?.contains("milkdown-code-block")
        ? target
        : (target.closest?.(".milkdown-code-block") as HTMLElement | null);
      if (!block) continue;
      const isPlaceholder = (n: Node) =>
        n instanceof HTMLElement && n.classList.contains("milkdown-code-block-placeholder");
      const added = [...rec.addedNodes].some(isPlaceholder);
      const removed = [...rec.removedNodes].some(isPlaceholder);
      if (!added && !removed) continue;
      const before = Math.round(heights.get(block) ?? 0);
      // Measure after layout settles so the delta is the real one.
      requestAnimationFrame(() => {
        const after = Math.round(block.getBoundingClientRect().height);
        window.__events.push({
          kind: added ? "teardown" : "mount",
          t: at(),
          ...blockInfo(block),
          hBefore: before,
          hAfter: after,
          dH: after - before,
        });
        heights.set(block, after);
        observeAll();
      });
    }
  }).observe(document.querySelector(".milkdown") as HTMLElement, {
    childList: true,
    subtree: true,
  });

  let lastH = wrap.scrollHeight;
  let lastTop = wrap.scrollTop;
  const tick = () => {
    const h = wrap.scrollHeight;
    const top = wrap.scrollTop;
    if (h !== lastH) {
      window.__events.push({ kind: "height", t: at(), dH: h - lastH, height: h });
      lastH = h;
    }
    if (Math.abs(top - lastTop) > 0.5) {
      window.__events.push({
        kind: "scroll",
        t: at(),
        dTop: Math.round(top - lastTop),
        top: Math.round(top),
      });
      lastTop = top;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

function Harness() {
  const onChange = useCallback(() => {}, []);
  return (
    <div className="editor-wrap" style={{ height: "100vh", overflow: "auto" }}>
      <Editor initialMarkdown={window.__md ?? DOC} onChange={onChange} readOnly={false} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
