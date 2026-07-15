// Verification harness: mounts the REAL Editor (Crepe + the mermaid preview
// pipeline from src/mermaid.ts) with a document full of diagram types so a
// browser can check rendering, live re-render on edit, error cards, theme
// flips, and the read-only (preview-only) presentation. Not part of the app.
//
//   ?ro=1        → read-only mount (the WebApp comment-role way)
//   ?theme=dark  → sets [data-theme] on <html> before mounting (light/sepia/dark)
//   ?doc=one     → a single small flowchart (for edit-interaction steps)
//
// window.__md carries the live serialized markdown (round-trip checks);
// window.__setTheme(t) flips the theme at runtime the way the app does.
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import "../src/App.css";
import "../web/web.css";

declare global {
  interface Window {
    __md: string;
    __setTheme: (theme: string) => void;
  }
}

const FULL_DOC = `# Diagram gallery

A flowchart:

\`\`\`mermaid
flowchart LR
  A[Draft] --> B{Review?}
  B -- yes --> C[Publish]
  B -- no --> D[Revise]
  D --> A
  C --> E([Done])
\`\`\`

A sequence diagram:

\`\`\`mermaid
sequenceDiagram
  participant App
  participant Worker
  App->>Worker: PUT /api/pages/id
  activate Worker
  Worker-->>App: 200 {rev}
  deactivate Worker
  Note over App,Worker: autosave re-pushes on edit
\`\`\`

A state diagram:

\`\`\`mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Shared: publish
  Shared --> Draft: stop sharing
  Shared --> [*]
\`\`\`

A pie chart:

\`\`\`mermaid
pie title Where the bytes go
  "Editor" : 45
  "KaTeX fonts" : 25
  "Mermaid" : 20
  "Worker" : 10
\`\`\`

A class diagram:

\`\`\`mermaid
classDiagram
  class Page {
    +String id
    +String title
    +publish()
  }
  class Collection {
    +String id
    +items
  }
  Collection o-- Page
\`\`\`

A broken one (error card):

\`\`\`mermaid
flowchart LR
  A[unclosed --> B
\`\`\`

Plain code stays code:

\`\`\`js
function hello(name) {
  return \`hi, \${name}\`;
}
\`\`\`
`;

const ONE_DOC = `# One diagram

\`\`\`mermaid
flowchart LR
  A[Start] --> B[End]
\`\`\`

After.
`;

const params = new URLSearchParams(location.search);
const readOnly = params.get("ro") === "1";
const theme = params.get("theme");
if (theme) document.documentElement.dataset.theme = theme;
window.__setTheme = (t: string) => {
  document.documentElement.dataset.theme = t;
};

const DOC = params.get("doc") === "one" ? ONE_DOC : FULL_DOC;
window.__md = DOC;

function Harness() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  return (
    <div
      className={`editor-wrap web-editor-wrap ${readOnly ? "is-readonly" : ""}`}
      style={{ height: "100vh" }}
    >
      <Editor initialMarkdown={DOC} onChange={onChange} readOnly={readOnly} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
