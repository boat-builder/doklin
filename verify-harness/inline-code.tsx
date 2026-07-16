// Verification harness: mounts the REAL Editor with inline code spans that
// are hard-wrapped across source lines (valid CommonMark — the span doesn't
// end at a newline). Without normalization the raw newline lands in the
// ProseMirror text node and `white-space: pre-wrap` renders the code pill as
// a stacked two-line box; see src/inlineCodeNewlines.ts. Exposes the live
// serialized markdown on window.__md to prove the round-trip writes the span
// back on one line. Not part of the app.
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import "../src/App.css";
import "../web/web.css";

declare global {
  interface Window {
    __md: string;
  }
}

// One wrapped span inside a list item (the reported case — continuation
// indent in play), one in a plain paragraph, and an untouched one-liner as
// control.
const DOC = `# Inline-code newline harness

* **Money units**: Google uses micros; normalize to a \`Money{Micros int64,
  Currency string}\` in \`internal/sem\` and convert at the SDK boundary.

A paragraph case: prefer \`retry with
backoff\` for flaky calls.

Control: \`single-line span\` must be untouched.
`;

window.__md = DOC;

function Harness() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  return (
    <div className="editor-wrap web-editor-wrap" style={{ height: "100vh" }}>
      <Editor initialMarkdown={DOC} onChange={onChange} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
