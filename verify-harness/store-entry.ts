// Test entry for store.test.mjs: the three PURE modules a datastore is built
// from, in one bundle so the suite pays for one vite build instead of three.
// Nothing here touches Tauri — src/store/model.ts (which does) is exercised
// by the browser drive, not by this suite.
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
  keyBetween,
  rankBetween,
  ranksBetween,
  sortByRank,
  validateRank,
  FIRST_RANK,
} from "../src/store/rank";
