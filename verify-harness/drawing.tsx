// Verification harness: the REAL Editor with ```svg drawing blocks — the
// three worked examples `doklin help drawings` teaches (read out of the CLI's
// own help text, so the guide can't teach a drawing that doesn't render),
// a hostile one, and one that doesn't parse. drive-drawing.mjs checks them.
// Not part of the app.
//
//   ?ro=1        → read-only mount
//   ?theme=dark  → sets [data-theme] on <html> before mounting
//
// window.__md carries the live serialized markdown (round-trip checks);
// window.__setTheme(t) flips the theme at runtime the way the app does.
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import helpRs from "../cli/src/help.rs?raw";
import "../src/App.css";
import "./harness.css";

declare global {
  interface Window {
    __md: string;
    __examples: number;
    __setTheme: (theme: string) => void;
  }
}

// The guide's examples: every <svg …>…</svg> run in the DRAWINGS text,
// unindented.
const guide = helpRs.slice(helpRs.indexOf('const DRAWINGS: &str'), helpRs.indexOf('const AGENT: &str'));
const examples = [...guide.matchAll(/^ {2}<svg viewBox[\s\S]*?^ {2}<\/svg>$/gm)].map((m) =>
  m[0].replace(/^ {2}/gm, ""),
);

const HOSTILE = `<svg viewBox="0 0 760 80" role="img" aria-label="Hostile">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"><path d="M0 0L10 5L0 10z" fill="var(--dg-rule)"/></marker></defs>
<script>window.__pwned = 1</script>
<foreignObject width="100" height="20"><div xmlns="http://www.w3.org/1999/xhtml">html inside</div></foreignObject>
<image href="https://example.com/x.png" width="10" height="10"/>
<line x1="24" y1="40" x2="200" y2="40" stroke="url(https://example.com/#x)" marker-end="url(#arrow)" onclick="window.__pwned = 2"/>
<text x="24" y="70" fill="var(--dg-ink)" style="fill:red">kept words</text>
</svg>`;

const BROKEN = `<svg viewBox="0 0 760 80"><g></svg>`;

const DOC = [
  "# Drawings",
  ...examples.map((svg, i) => `Example ${i + 1}:\n\n\`\`\`svg\n${svg}\n\`\`\``),
  `Hostile:\n\n\`\`\`svg\n${HOSTILE}\n\`\`\``,
  `Broken:\n\n\`\`\`svg\n${BROKEN}\n\`\`\``,
  "After.",
  "",
].join("\n\n");

const params = new URLSearchParams(location.search);
const readOnly = params.get("ro") === "1";
const theme = params.get("theme");
document.documentElement.dataset.theme = theme ?? "light";
window.__setTheme = (t: string) => {
  document.documentElement.dataset.theme = t;
};
window.__md = DOC;
window.__examples = examples.length;

function Harness() {
  const onChange = useCallback((md: string) => {
    window.__md = md;
  }, []);
  return (
    <div
      className={`editor-wrap harness-editor-wrap ${readOnly ? "is-readonly" : ""}`}
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
