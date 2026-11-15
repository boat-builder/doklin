// Verification harness: the REAL Editor (Crepe + figure blocks) showing a
// document with every block type, to judge the document look — type,
// rhythm, palettes, drawings and restyled Mermaid — in each theme. Not part
// of the app.
//
//   ?theme=light|dark|paper        [data-theme] on <html>
//   ?ro=1                          read-only mount
//   ?bar=0                         hide the switcher (for screenshots)
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import "../src/App.css";
import "./harness.css";

declare global {
  interface Window {
    __md: string;
  }
}

const SAMPLE = `# A sample document

Nov 14, 2026 · @Someone

A paragraph of body text with **bold**, *italic*, \`inline code\` and [a link](https://example.com). It runs long enough to wrap across a few lines of the column so the measure and the leading can be judged.

## A second-level heading

- A first item in a list
- A second item, long enough to wrap onto a second line so the hanging indent shows
  - A nested item
- A third item

1. One
2. Two
3. Three

- [x] A done task
- [ ] An open task

> A quote stays in the body ink, set off by a quiet bar.

### A third-level heading

| Column | Another column | A third |
|---|---|---|
| A cell | Another cell | 12 |
| A longer cell that wraps | Short | 345 |

\`\`\`ts
export function hello(name: string): string {
  return \`hi, \${name}\`;
}
\`\`\`

#### A fourth-level heading

---

\`\`\`svg
<svg viewBox="0 0 760 152" role="img" aria-label="A drawing">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--dg-rule)"/></marker>
</defs>
<text x="24" y="34" font-size="15" font-weight="600" fill="var(--dg-ink)">A drawing states its finding first</text>
<rect x="24" y="64" width="200" height="56" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
<text x="124" y="88" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">A box</text>
<text x="124" y="104" text-anchor="middle" font-size="11.5" fill="var(--dg-ink-2)">with a quiet line</text>
<line x1="224" y1="92" x2="272" y2="92" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#arrow)"/>
<rect x="280" y="64" width="200" height="56" rx="8" fill="color-mix(in srgb, var(--dg-accent) 12%, transparent)" stroke="var(--dg-accent)" stroke-width="2"/>
<text x="380" y="96" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">The one accent</text>
</svg>
\`\`\`

\`\`\`mermaid
flowchart LR
  a["<b>Draft</b><br/>someone writes it"] --> b["<b>Review</b><br/>a teammate reads it"] --> c["<b>Publish</b><br/>everyone can read it"]
  class c focus
\`\`\`
`;

const params = new URLSearchParams(location.search);
const DOC = SAMPLE;
const readOnly = params.get("ro") === "1";
const root = document.documentElement;
root.dataset.theme = params.get("theme") ?? "light";
window.__md = DOC;

// The switcher: each choice reloads with the new query, the simplest way to
// get a clean mount for every theme.
function Switch({ name, options }: { name: string; options: string[] }) {
  const current = params.get(name) ?? options[0];
  return (
    <span className="look-switch">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={o === current ? "is-on" : ""}
          onClick={() => {
            params.set(name, o);
            location.search = params.toString();
          }}
        >
          {o}
        </button>
      ))}
    </span>
  );
}

function Look() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  return (
    <>
      {params.get("bar") !== "0" && (
        <div className="look-bar">
          <Switch name="theme" options={["light", "dark", "paper"]} />
        </div>
      )}
      <div
        className={`editor-wrap harness-editor-wrap ${readOnly ? "is-readonly" : ""}`}
        style={{ height: "100vh" }}
      >
        <Editor initialMarkdown={DOC} onChange={onChange} readOnly={readOnly} />
      </div>
    </>
  );
}

const style = document.createElement("style");
style.textContent = `
  .look-bar { position: fixed; top: 10px; right: 10px; z-index: 50; display: flex; gap: 8px; flex-wrap: wrap;
    font: 500 12px/1 var(--font-ui); }
  .look-switch { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--raised);
    border: 1px solid var(--border); box-shadow: var(--shadow-pop); }
  .look-switch button { border: 0; background: none; color: var(--text-2); font: inherit; padding: 5px 8px;
    border-radius: 5px; cursor: pointer; }
  .look-switch button.is-on { background: var(--hover); color: var(--text-1); }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Look />
  </StrictMode>,
);
