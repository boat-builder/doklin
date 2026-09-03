// Verification harness: mounts the REAL Editor (Crepe + tableResize) with a
// markdown table so column drag-resize can be driven by a browser. Exposes
// the live serialized markdown on window.__md to prove widths never leak
// into the document, plus the persistence pair — window.__tcols and a
// "Reopen" button — so the entity-meta round trip (src/tableWidths.ts) can be
// played out against a real editor: drag a border, read the records the
// editor emits, remount from those records, see the columns come back.
// `?ro=1` mounts it read-only, the way a mirror pane is mounted (App passes
// readOnly the same way). Not part of the app.
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import type { TableCols } from "../src/tableWidths";
import "../src/App.css";
import "./harness.css";

declare global {
  interface Window {
    __md: string;
    // The last record set the editor emitted — what the app would write into
    // <stem>.meta.jsonl. Null until a width actually changes.
    __tcols: TableCols[] | null;
    // Bumped by "Reopen": the editor remounts from __tcols, standing in for
    // closing the document and opening it again.
    __reopens: number;
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
window.__tcols = null;
window.__reopens = 0;

// ?ro=1 → a read-only mount: a readOnly Editor inside the app's own wrapper
// classes. Read-only views can still resize but
// don't own the document, so the harness withholds the sink — exactly what
// App does for a mirror pane.
const readOnly = new URLSearchParams(location.search).get("ro") === "1";

function Harness() {
  const [seq, setSeq] = useState(0);
  const [stored, setStored] = useState<TableCols[]>([]);
  // What a reopen re-parses. The app reads this back from disk, so the
  // harness reads it back from the last serialization — same thing, and it
  // matters: a header rename must reopen against the RENAMED table.
  const [saved, setSaved] = useState(DOC);
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  const onTableWidths = useCallback((records: TableCols[]) => {
    window.__tcols = records;
    setStored(records);
  }, []);
  return (
    <>
      <button
        id="reopen"
        onClick={() => {
          window.__reopens += 1;
          setSaved(window.__md);
          setSeq((n) => n + 1);
        }}
      >
        Reopen
      </button>
      <div
        className={`editor-wrap harness-editor-wrap ${readOnly ? "is-readonly" : ""}`}
        style={{ height: "90vh" }}
      >
        <Editor
          key={seq}
          initialMarkdown={saved}
          onChange={onChange}
          readOnly={readOnly}
          tableWidths={stored}
          onTableWidths={readOnly ? undefined : onTableWidths}
        />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
