// A folder's boards.json (src/rank.ts, src/boards.ts and mergeBoards in
// src/web/merge.ts) against the shared cases
// (verify-harness/boards-fixture.json), which the iPhone's port and the
// engine's merge answer too, plus what holds for every case: canonical bytes
// read back to themselves, a merge is the same whichever side is ours when
// only one changed, and a drop leaves the column in the order it showed.
// Run:
//
//   node verify-harness/boards.test.mjs
//
// (Compiles the modules through vite, mirroring tags.test.mjs.)
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(...rel) {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    build: { write: false, target: "es2022", lib: { entry: path.join(repoRoot, ...rel), formats: ["es"], fileName: "m" } },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  return import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
}
const rank = await load("src", "rank.ts");
const boards = await load("src", "boards.ts");
const { mergeBoards } = await load("src", "web", "merge.ts");

const fx = JSON.parse(readFileSync(path.join(repoRoot, "verify-harness/boards-fixture.json"), "utf8"));
const show = (s) => JSON.stringify(s);
const read = (text) => {
  const b = boards.parseBoards(text);
  assert.ok(b !== null && b !== "newer", `a board: ${show(text)}`);
  return b;
};
let n = 0;

for (const c of fx.rank) {
  assert.equal(rank.rankBetween(c.a, c.b), c.out, `rank between ${c.a} and ${c.b}`);
  n += 1;
}
for (const c of fx.ranks) {
  const got = rank.ranksBetween(c.a, c.b, c.n);
  assert.deepStrictEqual(got, c.out, `${c.n} ranks between ${c.a} and ${c.b}`);
  assert.deepStrictEqual([...got].sort(), got, "ranks come in order");
  n += 1;
}
for (const c of fx.parse) {
  const got = boards.parseBoards(c.text);
  assert.deepStrictEqual(got === null || got === "newer" ? got : { tag: got.tag, cards: got.cards, extra: got.extra }, c.board, `read ${show(c.text)}`);
  n += 1;
}
for (const c of fx.canonical) {
  const got = boards.parseBoards(c.text);
  assert.equal(got === null || got === "newer" ? null : boards.serializeBoards(got), c.out, `canonical ${show(c.text)}`);
  if (c.out !== null) assert.equal(boards.serializeBoards(read(c.out)), c.out, `canonical bytes read back to themselves: ${show(c.out)}`);
  n += 1;
}
for (const c of fx.columns) {
  assert.deepStrictEqual(boards.boardColumns(read(c.board), c.def, c.notes), c.columns, `columns of ${show(c.board)}`);
  n += 1;
}
for (const c of fx.drop) {
  const before = read(c.board);
  const got = boards.dropCard(before, c.column, c.index, c.card);
  assert.equal(boards.serializeBoards(got), c.out, `drop ${c.card} at ${c.index} in ${show(c.column)}`);
  // What was seen is what stays: the column's cards keep their order, and
  // the card sits where it was dropped.
  const others = c.column.filter((x) => x.toLowerCase() !== c.card.toLowerCase());
  const at = Math.min(c.index, others.length);
  const want = [...others.slice(0, at), c.card, ...others.slice(at)];
  assert.deepStrictEqual(boards.orderCards(got, want), want, `the column shows what was dropped: ${show(want)}`);
  n += 1;
}
for (const c of fx.rename) {
  assert.equal(boards.serializeBoards(boards.renameCard(read(c.board), c.from, c.to)), c.out, `rename ${c.from} to ${c.to}`);
  n += 1;
}
for (const c of fx.prune) {
  assert.equal(boards.serializeBoards(boards.pruneBoard(read(c.board), c.names)), c.out, `prune to ${show(c.names)}`);
  n += 1;
}
for (const c of fx.merge) {
  assert.equal(mergeBoards(c.base, c.ours, c.theirs), c.out, `merge: ${c.name}`);
  // Changed on one side only: the same answer whichever side is ours.
  if (c.base !== null && (c.ours === c.base || c.theirs === c.base) && boards.parseBoards(c.ours) && boards.parseBoards(c.theirs)) {
    assert.equal(mergeBoards(c.base, c.theirs, c.ours), c.out, `merge, sides swapped: ${c.name}`);
  }
  n += 1;
}
assert.ok(boards.isBoardsFile("Projects/Launch/Boards.JSON") && !boards.isBoardsFile("Projects/boards.json.md"), "the file is found whatever its case");
console.log(`boards: ${n} cases pass`);
