// Dictation ghost text — the not-yet-committed transcript rendered at the
// insertion point as a ProseMirror widget decoration.
//
// While dictation holds the editor (talk-key press → pipeline drained) it
// pins an *anchor*: a doc position that starts at the selection head and then
// maps through every transaction (bias forward, so each committed chunk
// pushes it right and the ghost always trails the last commit). Ghost
// segments carry a state that drives their tint:
//   "listening"  gray shimmer — live STT partial, still changing
//   "polishing"  accent tint — STT finalized, waiting on the LLM polish pass
// Committed text is ordinary document content inserted by the controller; the
// ghost is pure decoration and never touches the doc.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export type GhostSegment = {
  id: string;
  text: string;
  state: "listening" | "polishing";
};

type GhostState = {
  anchor: number | null;
  segments: GhostSegment[];
};

export type GhostMeta =
  | { kind: "begin"; pos: number }
  | { kind: "segments"; segments: GhostSegment[] }
  | { kind: "end" };

export const ghostKey = new PluginKey<GhostState>("doklin-dictation-ghost");

const EMPTY: GhostState = { anchor: null, segments: [] };

export function getGhostState(state: EditorState): GhostState | undefined {
  return ghostKey.getState(state);
}

function buildWidget(segments: GhostSegment[]): HTMLElement {
  const span = document.createElement("span");
  span.className = "dictation-ghost";
  for (const seg of segments) {
    if (!seg.text) continue;
    const child = document.createElement("span");
    child.className = `dictation-ghost-seg is-${seg.state}`;
    // Leading space keeps segments visually separated; the smart joiner adds
    // the real spacing at commit time.
    child.textContent = (span.childNodes.length > 0 ? " " : "") + seg.text;
    span.appendChild(child);
  }
  return span;
}

export const ghostPlugin = $prose(
  () =>
    new Plugin<GhostState>({
      key: ghostKey,
      state: {
        init: () => EMPTY,
        apply(tr, value) {
          const meta = tr.getMeta(ghostKey) as GhostMeta | undefined;
          if (meta) {
            switch (meta.kind) {
              case "begin":
                return { anchor: meta.pos, segments: [] };
              case "segments":
                return value.anchor == null ? value : { ...value, segments: meta.segments };
              case "end":
                return EMPTY;
            }
          }
          if (value.anchor != null && tr.docChanged) {
            // Bias forward: text committed at the anchor lands before it.
            return { ...value, anchor: tr.mapping.map(value.anchor, 1) };
          }
          return value;
        },
      },
      props: {
        decorations(state) {
          const s = ghostKey.getState(state);
          if (!s || s.anchor == null) return null;
          if (!s.segments.some((seg) => seg.text)) return null;
          return DecorationSet.create(state.doc, [
            Decoration.widget(s.anchor, () => buildWidget(s.segments), {
              side: 1,
              // The key is ProseMirror's redraw check: an unchanged key keeps
              // the old DOM and never re-renders. Derive it from the content
              // so streaming partials repaint — a constant key froze the ghost
              // at the first text it ever painted.
              key: s.segments.map((seg) => `${seg.state}:${seg.text}`).join("\u0000"),
            }),
          ]);
        },
      },
    }),
);
