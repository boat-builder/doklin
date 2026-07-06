// In-file search for the Milkdown (ProseMirror) editor.
//
// Milkdown is a WYSIWYG editor with no line numbers, so "find in note" is
// implemented as a ProseMirror plugin that highlights every match via inline
// decorations and tracks a "current" match. The React layer drives it through
// transaction meta (set query / next / prev / clear) and reads back the match
// count + current index to render the find bar. Scrolling the current match
// into view is a view concern handled in Editor.tsx (kept out of here so we
// never touch the editor selection and steal focus from the find input).

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

export type SearchMatch = { from: number; to: number };
export type SearchInfo = { count: number; current: number };

type SearchState = {
  query: string;
  caseSensitive: boolean;
  matches: SearchMatch[];
  current: number;
};

export type SearchMeta =
  | { kind: "set"; query: string; caseSensitive: boolean }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "clear" };

export const searchKey = new PluginKey<SearchState>("doklin-search");

// Hard cap so a 1-character query in a huge doc can't lock up the main thread.
const MAX_MATCHES = 5000;

// Find matches within each text node. Matches that span across marks/nodes
// (e.g. half-bold words) are not found — a deliberate v1 simplicity tradeoff;
// the common case (plain text within a paragraph) works.
function findMatches(
  doc: ProseNode,
  query: string,
  caseSensitive: boolean,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  const needle = caseSensitive ? query : query.toLowerCase();
  const len = needle.length;
  doc.descendants((node, pos) => {
    if (matches.length >= MAX_MATCHES) return false;
    if (!node.isText || !node.text) return undefined;
    const haystack = caseSensitive ? node.text : node.text.toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      const from = pos + idx;
      matches.push({ from, to: from + len });
      if (matches.length >= MAX_MATCHES) break;
      idx = haystack.indexOf(needle, idx + len);
    }
    return undefined;
  });
  return matches;
}

function buildDecorations(
  doc: ProseNode,
  matches: SearchMatch[],
  current: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? "search-match search-match-current" : "search-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

const EMPTY: SearchState = { query: "", caseSensitive: false, matches: [], current: 0 };

export function getSearchState(state: EditorState): SearchState | undefined {
  return searchKey.getState(state);
}

export const searchPlugin = $prose(
  () =>
    new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => EMPTY,
        apply(tr, value, _oldState, newState) {
          const meta = tr.getMeta(searchKey) as SearchMeta | undefined;
          if (meta) {
            switch (meta.kind) {
              case "clear":
                return EMPTY;
              case "set": {
                const matches = findMatches(newState.doc, meta.query, meta.caseSensitive);
                return {
                  query: meta.query,
                  caseSensitive: meta.caseSensitive,
                  matches,
                  current: 0,
                };
              }
              case "next":
                if (value.matches.length === 0) return value;
                return { ...value, current: (value.current + 1) % value.matches.length };
              case "prev":
                if (value.matches.length === 0) return value;
                return {
                  ...value,
                  current:
                    (value.current - 1 + value.matches.length) % value.matches.length,
                };
            }
          }
          // The doc changed under us (user typed) — re-find so the highlights and
          // count stay accurate, keeping the current index in range.
          if (tr.docChanged && value.query) {
            const matches = findMatches(newState.doc, value.query, value.caseSensitive);
            const current = matches.length === 0 ? 0 : Math.min(value.current, matches.length - 1);
            return { ...value, matches, current };
          }
          return value;
        },
      },
      props: {
        decorations(state) {
          const s = searchKey.getState(state);
          if (!s) return null;
          return buildDecorations(state.doc, s.matches, s.current);
        },
      },
    }),
);
