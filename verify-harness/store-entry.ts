// Test entry for store.test.mjs: the PURE modules a datastore is built from,
// in one bundle so the suite pays for one vite build instead of five.
// Nothing here touches Tauri — src/store/model.ts (which does) is exercised
// by the browser drive, not by this suite. (embedConfig.ts is pure too — an
// embed fence's config; its EDITOR side lives in storeEmbed.ts. So is
// board.ts — the columns a board shows and the snapshot a published page
// carries; the code that READS a folder to fill one is publish.ts. So is
// csv.ts, the export a view writes.)
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
  resolveView,
  newView,
  groupableFields,
  cardKeyOrder,
  storeFileOf,
  isStoreConflictName,
  STORE_FILE,
} from "../src/store/storeFile";
export {
  parseEmbedConfig,
  serializeEmbedConfig,
  fenceEmbed,
  embedKind,
  storeFences,
  langOf,
  KANBAN_LANG,
  TABLE_LANG,
} from "../src/store/embedConfig";
export {
  applyFilter,
  boardColumns,
  boardSnapshot,
  cardChips,
  cardPasses,
  cardValue,
  cardValues,
  chipFieldsOf,
  columnCards,
  fenceKeyOf,
  orderedOptions,
  snapKeyOf,
  snapKind,
  sortCards,
  viewCards,
  visibleFields,
} from "../src/store/board";
export { csvField, csvFileName, storeCsv, toCsv } from "../src/store/csv";
export {
  keyBetween,
  rankBetween,
  ranksBetween,
  sortByRank,
  validateRank,
  FIRST_RANK,
} from "../src/store/rank";
