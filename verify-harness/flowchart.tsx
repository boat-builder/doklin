// Verification harness: mounts the REAL Editor (Crepe + the flowchart preview
// from src/flowchartBlock.ts) over a document of ```mermaid blocks, so a
// browser can check what each one shows: a flowchart as its picture, a
// flowchart that cannot be read as the quiet error card, another kind of
// diagram as its source under a note. The Expand chip opens the app's own
// zoom view (src/FigureZoom.tsx), mounted here the way App mounts it.
// drive-flowchart.mjs checks it; shot-flowchart.mjs photographs it. Not part
// of the app.
//
//   ?ro=1         → read-only mount (a preview-only host, like a mirror pane)
//   ?theme=dark   → sets [data-theme] on <html> before mounting (light/paper/dark)
//   ?doc=gallery  → one block of every kind (the document when none is named)
//   ?doc=one      → a single small flowchart (for edit-interaction steps)
//   ?doc=big      → two flowcharts big enough that the editor draws them after
//                   a pause in the typing, not on every keystroke
//   ?doc=fixture  → every flowchart in flowchart-fixture.json, under its name
//
// window.__md carries the live serialized markdown (round-trip checks);
// window.__setTheme(t) flips the theme at runtime the way the app does;
// window.__fences lists the document's ```mermaid sources, in order, and
// whether each is a flowchart; window.__frame is the frame the editor draws
// one for; window.__expanded is the source the Expand chip last sent with
// its picture.
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import FigureZoom from "../src/FigureZoom";
import { FIGURE_EXPAND_EVENT, type FigureExpandDetail } from "../src/figureBlock";
import { FRAME, isFlowchart } from "../src/flowchart/index";
import fixture from "./flowchart-fixture.json";
import "../src/App.css";
import "./harness.css";

declare global {
  interface Window {
    __md: string;
    __setTheme: (theme: string) => void;
    __fences: { source: string; flowchart: boolean }[];
    __frame: number;
    __expanded: string | null;
  }
}

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

const GALLERY_DOC = `# Flowchart gallery

Left to right, with a title, a decision and labelled arrows:

${fence(`---
title: A draft goes round until it is published
---
flowchart LR
  A[Draft] --> B{Review?}
  B -- yes --> C[Publish]
  B -- no --> D[Revise]
  D --> A
  C --> E([Done])`)}

Top to bottom, with a group and a store:

${fence(`flowchart TB
  accTitle: Saving a note
  App[App] --> Engine
  subgraph Cloud
    Engine[Sync engine] --> Store[(Bucket)]
  end`)}

Boxes that carry a class:

${fence(`flowchart LR
  accTitle: Marked boxes
  plain[Plain] --> key[Key step]:::focus --> ok[Passed]:::good
  key --> slow[Slow]:::warn
  key --> down[Failed]:::bad`)}

Another kind of diagram stays its source, under a note:

${fence(`sequenceDiagram
  participant App
  participant Worker
  App->>Worker: PUT a page
  Worker-->>App: 200`)}

${fence(`pie title Where the bytes go
  "Editor" : 45
  "Fonts" : 25
  "Worker" : 30`)}

A flowchart that cannot be read yet (error card):

${fence(`flowchart LR
  A["unclosed --> B`)}

Plain code stays code:

\`\`\`js
function hello(name) {
  return \`hi, \${name}\`;
}
\`\`\`
`;

const ONE_DOC = `# One flowchart

${fence(`flowchart LR
  A[Start] --> B[End]`)}

After.
`;

// Three lanes of seven boxes: more lines of arrows than the editor lays out
// on every keystroke (src/flowchartBlock.ts).
const lanes = (word: string) =>
  `flowchart TB
  accTitle: ${word}s in three lanes
${Array.from({ length: 6 }, (_, r) =>
  [1, 2, 3].map((c) => `  ${word}${r + 1}_${c}[${word} ${r + 1}.${c}] --> ${word}${r + 2}_${c}[${word} ${r + 2}.${c}]`).join("\n"),
).join("\n")}`;

const BIG_DOC = `# Big flowcharts

${fence(lanes("Step"))}

Between.

${fence(lanes("Task"))}

After.
`;

// One block per source: the fixture lays some sources out for a second frame,
// and the editor draws for its own.
const FIXTURE_DOC = `# Fixture flowcharts

${[...new Map(fixture.cases.map((c) => [c.source, c.name])).entries()]
  .map(([source, name]) => `## ${name}\n\n${fence(source)}`)
  .join("\n\n")}
`;

const params = new URLSearchParams(location.search);
const readOnly = params.get("ro") === "1";
document.documentElement.dataset.theme = params.get("theme") ?? "light";
window.__setTheme = (t: string) => {
  document.documentElement.dataset.theme = t;
};

const DOCS: Record<string, string> = { gallery: GALLERY_DOC, one: ONE_DOC, big: BIG_DOC, fixture: FIXTURE_DOC };
const docName = params.get("doc") ?? "gallery";
const DOC = DOCS[docName];
if (DOC === undefined) throw new Error(`flowchart.html has no document named "${docName}".`);
window.__md = DOC;
window.__fences = [...DOC.matchAll(/^```mermaid\n([\s\S]*?)\n```$/gm)].map((m) => ({
  source: m[1],
  flowchart: isFlowchart(m[1]),
}));
window.__frame = FRAME;
window.__expanded = null;

function Harness() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  const [zoomSvg, setZoomSvg] = useState<string | null>(null);
  useEffect(() => {
    const onExpand = (e: Event) => {
      const detail = (e as CustomEvent<FigureExpandDetail>).detail;
      window.__expanded = detail.source;
      setZoomSvg(detail.svg);
    };
    window.addEventListener(FIGURE_EXPAND_EVENT, onExpand);
    return () => window.removeEventListener(FIGURE_EXPAND_EVENT, onExpand);
  }, []);
  return (
    <div
      className={`editor-wrap harness-editor-wrap ${readOnly ? "is-readonly" : ""}`}
      style={{ height: "100vh" }}
    >
      <Editor initialMarkdown={DOC} onChange={onChange} readOnly={readOnly} />
      {zoomSvg !== null && <FigureZoom svg={zoomSvg} onClose={() => setZoomSvg(null)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
