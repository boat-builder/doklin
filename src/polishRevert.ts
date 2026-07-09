// Undo-polish tracking — remembers where polished dictation chunks landed in
// the document so the HUD's revert control can swap them back to the raw
// transcript.
//
// Regular editor undo can't do this: dictationCommit inserts only the
// *polished* text, so the raw transcript never enters the document or its
// history — Cmd+Z would delete the dictated text entirely. Instead, each
// commit whose polish changed the text records {range, inserted, raw} here.
// Ranges are position-mapped through every transaction, so typing between
// utterances keeps them valid; an entry whose text the user has edited is
// skipped at revert time rather than clobbered. The set clears on the next
// talk-key press — the window to undo an utterance's polish ends when the
// next utterance begins.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState } from "@milkdown/kit/prose/state";

export type RevertEntry = {
  from: number;
  to: number;
  /// Exact string dictationCommit inserted (post smart-join). Revert only
  /// fires while the doc still reads this — user edits win.
  inserted: string;
  /// The raw transcript to restore; re-joined against context at revert time.
  raw: string;
};

type RevertState = { entries: RevertEntry[] };

export type RevertMeta = { kind: "track"; entry: RevertEntry } | { kind: "clear" };

export const revertKey = new PluginKey<RevertState>("doklin-dictation-revert");

export function getRevertEntries(state: EditorState): RevertEntry[] {
  return revertKey.getState(state)?.entries ?? [];
}

export const polishRevertPlugin = $prose(
  () =>
    new Plugin<RevertState>({
      key: revertKey,
      state: {
        init: () => ({ entries: [] }),
        apply(tr, value) {
          const meta = tr.getMeta(revertKey) as RevertMeta | undefined;
          if (meta?.kind === "clear") {
            return value.entries.length === 0 ? value : { entries: [] };
          }
          let entries = value.entries;
          if (tr.docChanged && entries.length > 0) {
            entries = entries
              .map((e) => ({
                ...e,
                // Bias outward-in: text typed at either edge stays outside
                // the tracked range.
                from: tr.mapping.map(e.from, 1),
                to: tr.mapping.map(e.to, -1),
              }))
              .filter((e) => e.to > e.from);
          }
          // A "track" meta rides on the committing transaction itself, so its
          // coordinates are already in post-insert space — append unmapped.
          if (meta?.kind === "track") entries = [...entries, meta.entry];
          return entries === value.entries ? value : { entries };
        },
      },
    }),
);
