// Verification harness: two REAL editors, each a note of one workspace with
// the link records of its sidecar and the workspace's documents
// (src/linkMark.ts, src/mentionMenu.ts). It records what each editor hands
// back (window.__said), its relinks, the links it follows and what a pick
// tells the author. The driver changes the documents (a rename while the
// notes are open) through window.__setDocs. Not part of the app.
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../src/Editor";
import { indexDocuments, sectionOf, splitLinkRecords, type WorkspaceDocument } from "../src/docLinks";
import type { LinkContext } from "../src/linkMark";
import type { LinkRecord } from "../src/metaFile";
import "../src/App.css";
import "./harness.css";

type Said = { md: string[]; relinked: string[]; opened: { href: string; closed: boolean }[] };

declare global {
  interface Window {
    __said: Record<string, Said>;
    __notices: string[];
    __setDocs: (docs: WorkspaceDocument[]) => void;
    __notes: Record<string, { path: string; md: string; records: LinkRecord[] }>;
    __split: typeof splitLinkRecords;
  }
}

const notes = {
  q1: {
    path: "Library/Roadmap/q1.md",
    md: `# Q1

See [launch-plan](../GTM/launch-plan.md) and [the budget](../Finance/budget.md).

Board: [board-plan](<../../Shared with me/Board/board-plan.md>).

Gone: [old-note](old-note.md).

Plain: [notes](notes.md) and [the web](https://example.com).

Last line
`,
    records: [
      { id: "../GTM/launch-plan.md", file: "f-launch" },
      { id: "../Finance/budget.md", file: "f-budget" },
      { id: "../../Shared with me/Board/board-plan.md", file: "f-board" },
      { id: "old-note.md", file: "f-gone" },
    ],
  },
  other: {
    path: "Library/Deep/Down/other.md",
    md: `# Other

Paste here.
`,
    records: [],
  },
};

const initialDocs: WorkspaceDocument[] = [
  { path: "Library/GTM/launch-plan-v2.md", fileId: "f-launch", section: null },
  { path: "Library/Money/budget.md", fileId: "f-budget", section: null },
  { path: "Shared with me/Board/board-plan-final.md", fileId: "f-board", section: "s-board" },
  { path: "Library/Roadmap/notes.md", fileId: "f-notes", section: null },
  { path: "Library/Roadmap/q1.md", fileId: "f-q1", section: null },
  { path: "Library/Deep/Down/other.md", fileId: "f-other", section: null },
  { path: "My files/todo.md", fileId: "f-todo", section: "p-me" },
];

// What is shared, as the app names it for the `@` list.
const SHARES = new Map([["s-board", { name: "Board", alone: false }]]);

window.__notes = notes;
window.__split = splitLinkRecords;
window.__said = {};
window.__notices = [];

function Note({ id, docs }: { id: keyof typeof notes; docs: WorkspaceDocument[] }) {
  const note = notes[id];
  const said = (window.__said[id] ??= { md: [], relinked: [], opened: [] });
  const index = useMemo(() => indexDocuments(docs), [docs]);
  const links = useMemo(
    (): LinkContext => ({
      note: { path: note.path, section: sectionOf(note.path, index) },
      docs: index,
      recent: [],
      workspace: "Acme",
      shares: SHARES,
      placement: "caret",
      notify: (m) => window.__notices.push(m),
    }),
    [index, note.path],
  );
  return (
    <div className="editor-wrap harness-editor-wrap" data-note={id} style={{ height: "44vh" }}>
      <Editor
        initialMarkdown={note.md}
        linkRecords={note.records}
        links={links}
        onChange={(md) => said.md.push(md)}
        onRelinked={(md) => said.relinked.push(md)}
        onOpenLink={(href, link) => said.opened.push({ href, closed: !!link?.closed })}
      />
    </div>
  );
}

function Harness() {
  const [docs, setDocs] = useState(initialDocs);
  useEffect(() => {
    window.__setDocs = setDocs;
  }, []);
  return (
    <>
      <Note id="q1" docs={docs} />
      <Note id="other" docs={docs} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
