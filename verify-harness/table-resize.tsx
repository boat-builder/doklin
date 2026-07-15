// Verification harness: mounts the REAL Editor (Crepe + tableResize) with a
// markdown table so column drag-resize can be driven by a browser. Exposes
// the live serialized markdown on window.__md to prove widths never leak
// into the document. `?ro=1` mounts it read-only, the way comment-role web
// sessions do (WebApp passes readOnly the same way). Not part of the app.
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

const DOC = `# Table resize harness

| Name | Role | Location |
| --- | --- | --- |
| Ada | Engineer | London |
| Grace | Admiral | Washington |

A paragraph after the table.
`;

window.__md = DOC;

// ?ro=1 → the WebApp comment-role mount: readOnly Editor inside the same
// wrapper classes the shared page uses.
const readOnly = new URLSearchParams(location.search).get("ro") === "1";

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
  </StrictMode>
);
