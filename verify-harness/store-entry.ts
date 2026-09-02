// Test entry for store.test.mjs: the PURE modules a datastore is built from,
// in one bundle so the suite pays for one vite build instead of five.
// Nothing here touches Tauri — src/store/model.ts (which does) is exercised
// by the browser drive, not by this suite. (embedConfig.ts is pure too — the
// ```kanban fence's config; its EDITOR side lives in kanbanEmbed.ts. So is
// board.ts — the columns a board shows and the snapshot a published page
// carries; the code that READS a folder to fill one is publish.ts.)
export {
  parseFrontmatter,
  serializeFrontmatter,
  propsEqual,
  propText,
  propList,
} from "../src/store/frontmatter";
export {
  parseStoreDef,
  serializeStoreDef,
  defaultStoreDef,
  kanbanView,
  cardKeyOrder,
  storeFileOf,
  isStoreConflictName,
  STORE_FILE,
} from "../src/store/storeFile";
export {
  parseEmbedConfig,
  serializeEmbedConfig,
  fenceKanban,
  isKanbanFence,
  kanbanFences,
  KANBAN_LANG,
} from "../src/store/embedConfig";
export {
  boardColumns,
  boardSnapshot,
  cardChips,
  cardValue,
  chipFieldsOf,
  columnCards,
  fenceKeyOf,
  orderedOptions,
} from "../src/store/board";
export {
  keyBetween,
  rankBetween,
  ranksBetween,
  sortByRank,
  validateRank,
  FIRST_RANK,
} from "../src/store/rank";
