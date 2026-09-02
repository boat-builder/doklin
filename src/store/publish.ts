// Reading a workspace to produce what a published page carries.
//
// The share worker renders a page's markdown with `marked` and knows nothing
// about the workspace it came from: no folder, no `store.jsonl`, no card
// files. So a published note can only show its board if the board's DATA
// travels with the page, the way table column widths do (src/tableWidths.ts).
// This module is the reading half of that — it walks a note's embed fences,
// resolves each to a folder, and freezes what it finds into the pure shapes
// board.ts defines. The same goes for a card's properties: the push
// splits the frontmatter off the markdown (the way the editor splits it off
// the document) and sends the readable pairs instead.
//
// Snapshots are keyed by the fence's own config text. Two embeds writing the
// same config show the same board the same way, so they share one snapshot;
// an embed that narrows the view (`group:`, `hide:`) writes different config
// and gets its own. Two fences with the same config in DIFFERENT languages
// are two different views, so the key carries the language too.

import { dirOf, linkTargetPath } from "../docLinks";
import { boardSnapshot, clipText, type BoardSnap, type PageProp, type PagePropValue } from "./board";
import { langOf, parseEmbedConfig, storeFences } from "./embedConfig";
import { propList, propText, type Props } from "./frontmatter";
import { readStoreOnce } from "./model";
import { RANK_KEY, type StoreDef } from "./storeFile";

/** A page is a document, not a database export: this many boards, at most. */
const MAX_BOARDS = 20;

/**
 * Snapshot every store view a document embeds.
 *
 * Returns null when the document has no embed fence at all — which a caller
 * needs to tell apart from a document whose fences resolved to nothing (a
 * board that has since been deleted still leaves its fence, and a page that
 * carried a board must stop carrying it).
 *
 * `dirs` is the set of store folders the fences resolved to: what a caller
 * watches to know this page's boards went stale without the note changing.
 */
export async function collectBoardSnapshots(
  markdown: string,
  docPath: string | null,
  pageIdFor: (cardPath: string) => string | undefined,
): Promise<{ boards: BoardSnap[]; dirs: string[] } | null> {
  const fences = storeFences(markdown);
  if (fences.length === 0) return null;
  const boards: BoardSnap[] = [];
  const dirs = new Set<string>();
  const seen = new Set<string>();
  for (const { kind, text } of fences) {
    const key = `${langOf(kind)}\u0000${text}`;
    if (seen.has(key)) continue; // one snapshot serves every embed writing it
    seen.add(key);
    if (boards.length >= MAX_BOARDS) break;
    const cfg = parseEmbedConfig(text);
    if (!cfg.store) continue; // a fence still waiting for its picker
    const dir = linkTargetPath(cfg.store, docPath);
    if (!dir) continue; // relative, and this note has no folder to resolve against
    dirs.add(dir);
    const read = await readStoreOnce(dir);
    if (!read) continue; // no board there — the fence stays, nothing is rewritten
    const snap = boardSnapshot(text, kind, read.def, read.cards, pageIdFor);
    if (snap) boards.push(snap);
  }
  return { boards, dirs: [...dirs] };
}

/**
 * The properties a published note shows above its body.
 *
 * A CARD's rows are its board's declared fields, in the board's order, named
 * and coloured the way the desktop's properties header names and colours
 * them — a published card and the card in the app say the same things in the
 * same words. Any other note with frontmatter falls back to its own keys in
 * file order, uncoloured — the same rows its properties header shows in the
 * app, and better in any case than what `marked` does with a frontmatter
 * block on its own, which is to make a heading out of it.
 *
 * Unset values are left out: an empty row is an invitation to fill it in,
 * and there is nothing to fill in on a published page. `rank` is a card's
 * position on its board, not a property — it never shows.
 */
export async function cardProperties(
  docPath: string,
  props: Props,
  order: string[],
): Promise<PageProp[] | null> {
  if (order.length === 0) return null;
  const read = await readStoreOnce(dirOf(docPath));
  const values = (key: string, def: StoreDef | null): PagePropValue[] => {
    const raw = props[key];
    const field = def?.fields.find((f) => f.id === key) ?? null;
    const list =
      field?.type === "multi_select" || Array.isArray(raw)
        ? propList(raw)
        : [propText(raw)];
    return list
      .filter((text) => text !== "")
      .map((text) => {
        const opt = def?.options.find((o) => o.field === key && o.name === text);
        return { text: clipText(text), ...(opt?.color ? { color: opt.color } : {}) };
      });
  };
  const keys = read
    ? read.def.fields.map((f) => f.id)
    : order.filter((k) => k !== RANK_KEY);
  const rows: PageProp[] = [];
  for (const key of keys) {
    const vs = values(key, read?.def ?? null);
    if (vs.length === 0) continue;
    const name = read?.def.fields.find((f) => f.id === key)?.name ?? key;
    rows.push({ name: clipText(name), values: vs });
  }
  return rows.length > 0 ? rows : null;
}
