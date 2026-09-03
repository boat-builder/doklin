// Verification harness: mounts the REAL Editor on a document full of links
// and records every link the editor hands back to its host (window.__opened).
// The editor surface is contenteditable, where browsers deliberately don't
// follow links — src/linkOpen.ts is what turns a plain click into a follow
// (Notion's gesture), so this page is where that gesture is proven: which
// clicks follow, which fall through to caret/selection, that a follow never
// navigates the webview, and that in-document `#anchor` links scroll here
// instead of reaching the host. Not part of the app.
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import { openInBrowserTab } from "../src/linkOpen";
import "../src/App.css";
import "./harness.css";

declare global {
  interface Window {
    __md: string;
    __opened: string[];
    __pwned?: boolean;
    __openInBrowserTab: (href: string) => void;
  }
}

// Filler around the anchor's heading, so a scroll to the target is
// unambiguous: enough above it to put it far below the fold, enough below it
// that the heading can actually reach the top of the viewport (against the
// document's end the scroll would stop short and prove nothing).
const filler = (label: string) =>
  Array.from(
    { length: 30 },
    (_, i) => `${label} filler paragraph ${i + 1} — padding the scroll.`,
  ).join("\n\n");

const DOC = `# Link harness

An external link: [example docs](https://example.com/docs) in a sentence.

Mail: [write to us](mailto:hi@example.com).

Sibling note: [the other note](./other-note.md).

Anchor: [jump to the section](#a-later-section).

- A list item with a **[bold link](https://example.com/list)** inside it.

Hostile: [do not run this](javascript:window.__pwned=true).

${filler("Above")}

## A later section

The anchor target.

${filler("Below")}
`;

window.__md = DOC;
window.__opened = [];
// The plain host behavior — what the editor falls back to without a host.
// Exposed so the driver can check which schemes it is willing to hand a
// browser tab.
window.__openInBrowserTab = openInBrowserTab;

function Harness() {
  const [readOnly, setReadOnly] = useState(false);
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  const onOpenLink = useCallback((url: string) => {
    window.__opened.push(url);
  }, []);

  useEffect(() => {
    const btn = document.getElementById("toggle-readonly")!;
    // StrictMode double-mounts: assign rather than addEventListener, or the
    // toggle fires twice per click.
    (btn as HTMLButtonElement).onclick = () => setReadOnly((v) => !v);
  }, []);
  useEffect(() => {
    document.getElementById("readonly-state")!.textContent = readOnly
      ? "read-only"
      : "editable";
  }, [readOnly]);

  return (
    <div className="editor-wrap harness-editor-wrap" style={{ height: "90vh" }}>
      <Editor
        initialMarkdown={DOC}
        onChange={onChange}
        onOpenLink={onOpenLink}
        readOnly={readOnly}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
