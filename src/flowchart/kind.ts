// What kind of Mermaid diagram a source is, by the word it starts with. Only
// a flowchart is drawn. This file imports nothing, so code that only needs to
// ask (the worker, deciding whether a page needs the flowchart module) does
// not pull the renderer in with it.

/** The first word of a Mermaid source, past its front matter, comments and blank lines. */
function firstWord(source: string): string {
  const lines = source.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() === "---") {
    for (i++; i < lines.length && lines[i].trim() !== "---"; i++);
    i++;
  }
  for (; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s === "" || s.startsWith("%%")) continue;
    return (/^[\w-]+/.exec(s)?.[0] ?? s).toLowerCase();
  }
  return "";
}

const FLOWCHART_WORDS = new Set(["flowchart", "graph", "flowchart-elk"]);

/** Mermaid's other kinds of diagram, as a reader would name them. */
const OTHER_KINDS: Record<string, string> = {
  sequencediagram: "A sequence diagram",
  classdiagram: "A class diagram",
  "classdiagram-v2": "A class diagram",
  statediagram: "A state diagram",
  "statediagram-v2": "A state diagram",
  erdiagram: "An entity relationship diagram",
  gantt: "A Gantt chart",
  pie: "A pie chart",
  journey: "A user journey",
  mindmap: "A mind map",
  timeline: "A timeline",
  gitgraph: "A git graph",
  quadrantchart: "A quadrant chart",
  requirementdiagram: "A requirement diagram",
  c4context: "A C4 diagram",
  c4container: "A C4 diagram",
  c4component: "A C4 diagram",
  c4dynamic: "A C4 diagram",
  c4deployment: "A C4 diagram",
  "xychart-beta": "An XY chart",
  xychart: "An XY chart",
  "block-beta": "A block diagram",
  block: "A block diagram",
  "sankey-beta": "A Sankey diagram",
  sankey: "A Sankey diagram",
  "packet-beta": "A packet diagram",
  packet: "A packet diagram",
  "architecture-beta": "An architecture diagram",
  architecture: "An architecture diagram",
  "radar-beta": "A radar chart",
  "treemap-beta": "A treemap",
  kanban: "A kanban board",
  zenuml: "A ZenUML diagram",
};

/** Whether a ```mermaid source is a flowchart. */
export function isFlowchart(source: string): boolean {
  return FLOWCHART_WORDS.has(firstWord(source));
}

/** The name of the kind of diagram a source is, when it is one of Mermaid's that Doklin does not draw; else null. */
export function otherKind(source: string): string | null {
  return OTHER_KINDS[firstWord(source)] ?? null;
}
