// Verification harness: the REAL Editor with callouts (`> [!NOTE]`) — the
// examples `doklin help writing` teaches (read out of the CLI's own help
// text, so the guide can't teach a callout that doesn't come back as it was
// written), one of each kind, the forms that must stay quotes, and enough
// headings for the outline. drive-callouts.mjs checks them.
//
//   ?theme=light|dark|paper        [data-theme] on <html>
//   ?ro=1                          read-only mount
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import helpRs from "../cli/src/help.rs?raw";
import { CALLOUTS, CALLOUT_KINDS } from "../src/calloutTypes";
import "../src/App.css";
import "./harness.css";

declare global {
  interface Window {
    __md: string;
    __in: string;
    /** The guide's kinds and meanings, as `doklin help writing` lists them. */
    __guideKinds: [string, string][];
    /** The app's, from calloutTypes.ts. */
    __appKinds: [string, string][];
  }
}

// The guide's examples: every run of lines indented four spaces that opens
// with a marker, in the WRITING text.
const guide = helpRs.slice(helpRs.indexOf("const WRITING: &str"), helpRs.indexOf("const DRAWINGS: &str"));
const examples: string[] = [];
const lines = guide.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (!/^ {4}> \[!/.test(lines[i])) continue;
  const block: string[] = [];
  while (i < lines.length && /^ {4}>/.test(lines[i])) block.push(lines[i++].slice(4));
  examples.push(block.join("\n"));
}
window.__guideKinds = [...guide.matchAll(/^ {4}([A-Z]+) {2,}(.+)$/gm)].map((m) => [m[1].toLowerCase(), m[2]]);
window.__appKinds = CALLOUT_KINDS.map((k) => [k, CALLOUTS[k].meaning]);

const DOC = `# Callouts

The opening paragraph, before any callout.

## The guide's examples

${examples.join("\n\n")}

## Every kind

${CALLOUT_KINDS.map((k) => `> [!${k.toUpperCase()}]\n> ${CALLOUTS[k].meaning}.`).join("\n\n")}

## Forms

> [!tip]
> A marker in lowercase stays lowercase.

> [!IMPORTANT]
>
> A blank line after the marker is kept.

> [!CAUTION]

> [!WARNING]
> A list inside:
>
> * one
>
> * two

> [!NOTE]
> Code inside: \`inline\`, then a block.
>
> \`\`\`ts
> const answer = 42;
> \`\`\`

## Not callouts

> A plain quote.

> [!NOTE] A title after the marker

> [!info]
> An unknown kind.

* An item.

  > [!TIP]
  > A quote inside a list.

## The end

The last paragraph.
`;

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
window.__in = DOC;
window.__md = "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ display: "flex", height: "100vh" }}>
      <section className="editor-pane">
        <div className="editor-wrap">
          <Editor
            initialMarkdown={DOC}
            onChange={(md) => {
              window.__md = md;
            }}
            readOnly={params.get("ro") === "1"}
          />
        </div>
      </section>
    </div>
  </StrictMode>,
);
