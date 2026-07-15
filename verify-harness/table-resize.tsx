// Verification harness: mounts the REAL Editor (Crepe + tableResize) with a
// markdown table so column drag-resize can be driven by a browser. Exposes
// the live serialized markdown on window.__md to prove widths never leak
// into the document. Not part of the app.
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import "../src/App.css";

declare global {
  interface Window {
    __md: string;
  }
}

const DOC = `# Table resize harness

| Name | Role | Location |
| --- | --- | --- |
| Ada | Engineer | London |
| Grace | Admiral | Washington |

A paragraph after the table.
`;

window.__md = DOC;

function Harness() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  return (
    <div className="editor-wrap" style={{ height: "100vh" }}>
      <Editor initialMarkdown={DOC} onChange={onChange} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
