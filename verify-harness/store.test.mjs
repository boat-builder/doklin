// Unit tests for the pure modules a datastore is built from (src/store/): the
// frontmatter dialect that holds a card's properties, the `store.jsonl`
// definition file, the fractional index that positions cards and columns, and
// the ```kanban embed's config. Run:
//
//   node verify-harness/store.test.mjs
//
// (Compiles through vite, mirroring metafile.test.mjs.)
import { build } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    target: "es2022",
    lib: {
      entry: path.join(repoRoot, "verify-harness", "store-entry.ts"),
      formats: ["es"],
      fileName: "store",
    },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const {
  parseFrontmatter,
  serializeFrontmatter,
  propsEqual,
  propText,
  propList,
  parseStoreDef,
  serializeStoreDef,
  defaultStoreDef,
  kanbanView,
  cardKeyOrder,
  storeFileOf,
  isStoreConflictName,
  STORE_FILE,
  keyBetween,
  rankBetween,
  ranksBetween,
  sortByRank,
  validateRank,
  FIRST_RANK,
  parseEmbedConfig,
  serializeEmbedConfig,
  fenceKanban,
  isKanbanFence,
  kanbanFences,
  KANBAN_LANG,
  boardColumns,
  boardSnapshot,
  cardChips,
  cardValue,
  chipFieldsOf,
  columnCards,
  fenceKeyOf,
  orderedOptions,
} = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);

let checks = 0;
const ok = (cond, msg) => {
  checks++;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks++;
  assert.deepStrictEqual(a, b, msg);
};

/* ==================== frontmatter: what IS a block ==================== */
{
  const fm = parseFrontmatter("---\nstatus: Done\n---\nbody\n");
  ok(fm.present, "a leading fenced block is frontmatter");
  eq(fm.props, { status: "Done" });
  eq(fm.body, "body\n");

  // Prose that merely starts with a horizontal rule is NOT frontmatter — the
  // rule every other tool applies, and the one that keeps existing notes safe.
  const rule = parseFrontmatter("---\nJust a rule and some prose.\n");
  ok(!rule.present, "an unterminated fence is prose");
  eq(rule.body, "---\nJust a rule and some prose.\n");
  eq(rule.props, {});

  // A fence that isn't the very first line is prose too.
  const late = parseFrontmatter("# Title\n\n---\na: 1\n---\n");
  ok(!late.present, "a fence below the first line is prose");
  eq(late.body, "# Title\n\n---\na: 1\n---\n");

  // A block with nothing after it leaves an empty body.
  eq(parseFrontmatter("---\na: 1\n---\n").body, "");
  // An empty block is still a block.
  ok(parseFrontmatter("---\n---\nx").present);
  eq(parseFrontmatter("---\n---\nx").body, "x");
  // A file that is only a fence has no block at all.
  ok(!parseFrontmatter("---").present);
  ok(!parseFrontmatter("").present);
  eq(parseFrontmatter("").body, "");
  // Editors leave trailing whitespace on a fence line; still a block.
  ok(parseFrontmatter("---  \na: 1\n--- \nbody").present);
  // CRLF files parse; the body keeps its own line endings.
  const crlf = parseFrontmatter("---\r\nstatus: Done\r\n---\r\nbody\r\n");
  ok(crlf.present, "CRLF frontmatter parses");
  eq(crlf.props, { status: "Done" });
}

/* ==================== frontmatter: the value dialect ==================== */
{
  const fm = parseFrontmatter(
    [
      "---",
      "text: In progress",
      'quoted: "a: b"',
      "single: 'it''s here'",
      "num: 3",
      "neg: -2.5",
      "yes: true",
      "no: false",
      "when: 2026-09-12",
      "flow: [a, b, \"c, d\"]",
      "block:",
      "  - one",
      "  - two",
      "empty:",
      "tilde: ~",
      "---",
      "body",
    ].join("\n"),
  );
  eq(fm.props.text, "In progress");
  eq(fm.props.quoted, "a: b");
  eq(fm.props.single, "it's here");
  eq(fm.props.num, 3);
  eq(fm.props.neg, -2.5);
  eq(fm.props.yes, true);
  eq(fm.props.no, false);
  eq(fm.props.when, "2026-09-12", "an ISO date stays a plain string");
  eq(fm.props.flow, ["a", "b", "c, d"]);
  eq(fm.props.block, ["one", "two"], "block-style lists are accepted on read");
  eq(fm.props.empty, null);
  eq(fm.props.tilde, null);
  eq(fm.opaque, [], "everything above is in the dialect");
}

/* ==================== frontmatter: opaque lines survive ==================== */
{
  const src = [
    "---",
    "status: Done",
    "nested:",
    "  a: 1",
    "# a comment",
    "multi: |",
    "  a literal block",
    "---",
    "body\n",
  ].join("\n");
  const fm = parseFrontmatter(src);
  eq(fm.props, { status: "Done" });
  ok(fm.opaque.length >= 3, "unreadable lines are kept, not dropped");
  ok(fm.opaque.includes("# a comment"));
  ok(fm.opaque.includes("  a: 1"));

  // Re-serializing keeps every opaque line verbatim.
  const head = serializeFrontmatter(fm.props, fm.opaque, ["status"]);
  for (const line of fm.opaque) ok(head.includes(line), `kept: ${line}`);
  ok(head.startsWith("---\nstatus: Done\n"));

  // A foreign key the store never declared rides along untouched.
  const foreign = parseFrontmatter("---\naliases: [old name]\nstatus: Done\n---\n");
  const out = serializeFrontmatter(foreign.props, foreign.opaque, ["status"]);
  eq(out, "---\nstatus: Done\naliases: [old name]\n---\n");
}

/* ============ frontmatter: canonical, round-tripping serialization ======== */
{
  // Declared field order first, then unknown keys alphabetically. Two devices
  // holding the same state must produce the same bytes.
  const props = { zeta: 1, status: "Done", alpha: "x", rank: "a1", tags: ["b", "a"] };
  const order = ["status", "tags", "rank"];
  const head = serializeFrontmatter(props, [], order);
  eq(
    head,
    "---\nstatus: Done\ntags: [b, a]\nrank: a1\nalpha: x\nzeta: 1\n---\n",
    "canonical key order",
  );
  eq(serializeFrontmatter({ ...props }, [], order), head, "stable across calls");

  // Empty state writes no block at all: a card with no properties is a plain
  // note again, which is the honest file.
  eq(serializeFrontmatter({}, [], order), "");

  // Round trip: parse(serialize(x)) === x, including the values that need
  // quoting to survive.
  const tricky = {
    plain: "In progress",
    colon: "a: b",
    hash: "# not a comment",
    numeric: "3",
    boolish: "true",
    bracket: "[not a list]",
    spaced: " padded ",
    quote: 'he said "hi"',
    list: ["a, b", "c", ""],
    zero: 0,
    off: false,
    nothing: null,
  };
  const round = parseFrontmatter(serializeFrontmatter(tricky, [], []) + "body\n");
  eq(round.opaque, [], "everything we write, we can read");
  eq(round.props.colon, "a: b");
  eq(round.props.hash, "# not a comment");
  eq(round.props.numeric, "3", "a numeric string stays a string");
  eq(round.props.boolish, "true", "a boolean-looking string stays a string");
  eq(round.props.bracket, "[not a list]");
  eq(round.props.spaced, " padded ");
  eq(round.props.quote, 'he said "hi"');
  eq(round.props.list, ["a, b", "c", ""]);
  eq(round.props.zero, 0);
  eq(round.props.off, false);
  eq(round.props.nothing, null);
  eq(round.body, "body\n");
}

/* ==================== frontmatter: helpers ==================== */
{
  ok(propsEqual({ a: 1, b: ["x"] }, { b: ["x"], a: 1 }));
  ok(!propsEqual({ a: 1 }, { a: 2 }));
  ok(!propsEqual({ a: ["x"] }, { a: ["x", "y"] }));
  eq(propText(["a", "b"]), "a, b");
  eq(propText(null), "");
  eq(propText(true), "Yes");
  eq(propList("x"), ["x"]);
  eq(propList(null), []);
  eq(propList(["x", ""]), ["x"]);
}

/* ==================== store.jsonl ==================== */
{
  const text = [
    '{"doklin":"store","v":1,"name":"Projects"}',
    '{"t":"field","id":"status","name":"Status","type":"select"}',
    '{"t":"field","id":"tags","name":"Tags","type":"multi_select"}',
    '{"t":"option","field":"status","name":"Backlog","rank":"a0"}',
    '{"t":"option","field":"status","name":"Done","rank":"a2","color":"green"}',
    '{"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}',
    "",
  ].join("\n");
  const def = parseStoreDef(text);
  eq(def.name, "Projects");
  eq(def.fields.length, 2);
  eq(def.options.length, 2);
  eq(def.views[0].groupBy, "status");
  eq(def.options[1].color, "green");

  // The HEADER is what makes a folder a store — not the file name.
  eq(parseStoreDef('{"t":"field","id":"a","type":"select"}\n'), null);
  eq(parseStoreDef(""), null);
  eq(parseStoreDef("not json\n"), null);

  // Canonical bytes: sorted, fixed key order, and identical for equal state
  // however the records arrived.
  const shuffled = parseStoreDef(
    [
      '{"doklin":"store","v":1,"name":"Projects"}',
      '{"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}',
      '{"t":"option","field":"status","name":"Done","color":"green","rank":"a2"}',
      '{"t":"field","id":"tags","type":"multi_select","name":"Tags"}',
      '{"t":"option","field":"status","name":"Backlog","rank":"a0"}',
      '{"t":"field","id":"status","type":"select","name":"Status"}',
      "",
    ].join("\n"),
  );
  eq(serializeStoreDef(shuffled), serializeStoreDef(def), "equal state, equal bytes");
  ok(serializeStoreDef(def).startsWith('{"doklin":"store","v":1,"name":"Projects"}\n'));

  // Options sort by (field, name), NOT by rank — so moving a column rewrites
  // one line in place instead of reshuffling the file.
  const moved = { ...def, options: def.options.map((o) => ({ ...o, rank: "b" + o.rank })) };
  const before = serializeStoreDef(def).split("\n");
  const after = serializeStoreDef(moved).split("\n");
  eq(before.length, after.length);
  eq(
    before.filter((l, i) => l !== after[i]).length,
    2,
    "a rank change touches only the option lines",
  );

  // Tolerant parse: torn lines skipped, first duplicate wins, unknown record
  // types survive a rewrite.
  const messy = parseStoreDef(
    [
      '{"doklin":"store","v":1,"name":"P"}',
      "{ not json",
      '{"t":"field","id":"status","name":"Status","type":"select"}',
      '{"t":"field","id":"status","name":"Second","type":"text"}',
      '{"t":"field","id":"bad","name":"Bad","type":"rollup"}',
      '{"t":"future","id":"z","payload":1}',
      "",
    ].join("\n"),
  );
  eq(messy.fields.length, 1, "first duplicate wins, unknown types are dropped");
  eq(messy.fields[0].name, "Status");
  eq(messy.foreign.length, 1, "a record from a newer version is carried");
  ok(
    serializeStoreDef(messy).includes('{"t":"future","id":"z","payload":1}'),
    "and survives a rewrite verbatim",
  );

  // The default a new board starts with, and the view fallbacks.
  const fresh = defaultStoreDef("Ideas");
  eq(fresh.options.length, 3);
  eq(kanbanView(fresh).groupBy, "status");
  const noView = { ...fresh, views: [] };
  eq(kanbanView(noView).groupBy, "status", "falls back to the first select field");
  eq(kanbanView({ ...fresh, views: [], fields: [], options: [] }), null);
  eq(cardKeyOrder(fresh), ["status", "rank"]);

  eq(storeFileOf("/w/Projects"), `/w/Projects/${STORE_FILE}`);
  ok(isStoreConflictName("store (conflict — Alice, Sep 2 14.32).jsonl"));
  ok(!isStoreConflictName("store.jsonl"));
  ok(!isStoreConflictName("notes (conflict — Alice).jsonl"));
}

/* ==================== fractional index ==================== */
{
  eq(keyBetween(null, null), "a0");
  eq(keyBetween("a0", null), "a1");
  eq(keyBetween("a0", "a1"), "a0V", "the documented midpoint");
  eq(keyBetween(null, "a0"), "Zz");
  ok(keyBetween("a0", "a0V") > "a0" && keyBetween("a0", "a0V") < "a0V");

  // A thousand drops into the SAME one-slot gap — the pathological case —
  // stay strictly ordered. Keys grow in that case (they must: the gap has to
  // be subdivided a thousand times), which is why the board never sorts on
  // anything but the string itself.
  let lo = "a0";
  const hi = "a1";
  let longest = 0;
  for (let i = 0; i < 1000; i++) {
    const next = keyBetween(lo, hi);
    ok(next > lo && next < hi, `strictly between at step ${i}`);
    longest = Math.max(longest, next.length);
    lo = next;
  }
  ok(longest < 600, `even the worst case stays bounded (longest ${longest})`);

  // The ordinary case — appending — keeps sort order AND stays tiny, which is
  // what a board full of "add a card at the bottom" actually does.
  let last = null;
  let appendLongest = 0;
  for (let i = 0; i < 1000; i++) {
    const next = keyBetween(last, null);
    ok(last === null || next > last);
    appendLongest = Math.max(appendLongest, next.length);
    last = next;
  }
  ok(appendLongest <= 4, `appends stay short (longest ${appendLongest})`);

  eq(ranksBetween(null, null, 3).length, 3);
  const three = ranksBetween(null, null, 3);
  ok(three[0] < three[1] && three[1] < three[2], "n keys come back in order");

  // The tolerant wrapper: hand-edited junk must never stop a drag.
  ok(rankBetween("nonsense", null).length > 0);
  ok(rankBetween(null, "nonsense").length > 0);
  eq(rankBetween("a1", "a0"), keyBetween("a1", null), "a reversed pair appends");
  eq(rankBetween(null, null), FIRST_RANK);
  assert.throws(() => validateRank("a0V0"), "a trailing zero is not a key");
  assert.throws(() => validateRank(""), "the empty string is not a key");

  // Sorting: ranked first in rank order, then everything unranked by title.
  const items = [
    { t: "d", r: null },
    { t: "b", r: "a1" },
    { t: "a", r: "a2" },
    { t: "c", r: "junk" },
  ];
  eq(
    sortByRank(items, (i) => i.r, (i) => i.t).map((i) => i.t),
    ["b", "a", "c", "d"],
    "unranked cards sort last, by title",
  );
}

/* ======================================================================
   4. The ```kanban embed's config (embedConfig.ts)
   ====================================================================== */

/* ---------- the config is read in the frontmatter dialect ---------- */
{
  const c = parseEmbedConfig("store: ./Projects\nview: board\ngroup: status\nhide: [Done, Archive]");
  eq(c.store, "./Projects");
  eq(c.view, "board");
  eq(c.group, "status");
  eq(c.hide, ["Done", "Archive"]);

  // The only key that has to be there is `store` — and an embed that names
  // none is the state the picker draws, never an error.
  const empty = parseEmbedConfig("");
  eq(empty.store, null, "an empty fence names no store");
  eq(empty.hide, []);
  eq(parseEmbedConfig("   \n\n").store, null, "whitespace names no store");

  // A quoted path (a name with a comma or a colon in it) reads back whole.
  eq(parseEmbedConfig('store: "./Q3: plans, revised"').store, "./Q3: plans, revised");

  // A single hidden value doesn't have to be a list.
  eq(parseEmbedConfig("store: ./P\nhide: Done").hide, ["Done"]);

  // Junk is ignored, not fatal: the keys it understands still land.
  const messy = parseEmbedConfig("nonsense\nstore: ./P\n# a comment\nnested:\n  a: 1");
  eq(messy.store, "./P", "an unreadable line doesn't lose the store");
  eq(messy.view, null);

  // An empty value is the same as an absent one.
  eq(parseEmbedConfig("store:\nview:").store, null);
}

/* ---------- what the picker writes reads back ---------- */
{
  const round = (c) => parseEmbedConfig(serializeEmbedConfig(c));
  const full = { store: "./Projects", view: "board", group: "status", hide: ["Done"] };
  eq(round(full), full, "a full config round-trips");
  eq(
    serializeEmbedConfig({ store: "./Projects", view: null, group: null, hide: [] }),
    "store: ./Projects",
    "only what is set gets written",
  );
  eq(serializeEmbedConfig({ store: null, view: null, group: null, hide: [] }), "");
  // Equal state, equal bytes — the same discipline the store file follows.
  eq(
    serializeEmbedConfig(full),
    serializeEmbedConfig({ hide: ["Done"], group: "status", view: "board", store: "./Projects" }),
    "key insertion order doesn't change the text",
  );
  // A path the dialect would misread comes back quoted.
  const tricky = { store: "./a, b", view: null, group: null, hide: ["x, y"] };
  eq(round(tricky), tricky, "a comma survives both the scalar and the list");
}

/* ---------- the fence ---------- */
{
  eq(fenceKanban("store: ./P"), "```kanban\nstore: ./P\n```");
  eq(fenceKanban(""), "```kanban\n```", "an empty embed is still a fence");
  eq(KANBAN_LANG, "kanban");
  // A config carrying a backtick run can't break out of its own fence: the
  // fence grows past the longest run, exactly as a markdown serializer's does.
  eq(fenceKanban("store: ./``x"), "```kanban\nstore: ./``x\n```", "a short run needs no growth");
  eq(fenceKanban("a\n```\nb"), "````kanban\na\n```\nb\n````");
  eq(fenceKanban("````"), "`````kanban\n````\n`````");

  // Which fences the app claims. Strict on purpose: anything else stays an
  // ordinary code block, which round-trips byte for byte.
  ok(isKanbanFence("kanban", null));
  ok(isKanbanFence("kanban", ""));
  ok(!isKanbanFence("Kanban", null), "case matters");
  ok(!isKanbanFence("kanban", "tight"), "a fence with meta is not ours");
  ok(!isKanbanFence("mermaid", null));
  ok(!isKanbanFence(null, null), "a bare fence is not ours");
}


/* ============ finding the fences in a document ============
   A share push has only the file's bytes — no parsed document — so it scans
   for ```kanban fences itself. The scan has to agree with the editor's
   parser about what IS a fence. */
{
  eq(kanbanFences("no fences here\n"), []);
  eq(kanbanFences("```kanban\nstore: ./P\n```\n"), ["store: ./P"]);
  eq(
    kanbanFences("# Hi\n\n```kanban\nstore: ./A\n```\n\ntext\n\n```kanban\nstore: ./B\n```\n"),
    ["store: ./A", "store: ./B"],
    "every fence, in document order",
  );
  eq(kanbanFences("```js\nstore: ./P\n```\n"), [], "another language is not ours");
  eq(kanbanFences("```kanban tight\nstore: ./P\n```\n"), [], "a fence with meta is not ours");
  eq(kanbanFences("```Kanban\nstore: ./P\n```\n"), [], "case matters");
  eq(kanbanFences("```kanban\n```\n"), [""], "an empty fence is still a fence");
  eq(kanbanFences("```kanban\nstore: ./P\n"), ["store: ./P"], "an unclosed fence ends at EOF");
  // A kanban fence written INSIDE a longer fence is an example, not a board.
  eq(
    kanbanFences("````markdown\n```kanban\nstore: ./P\n```\n````\n"),
    [],
    "a fence inside a fence is text",
  );
  // A longer opener needs a closer at least as long.
  eq(kanbanFences("````kanban\nstore: ./P\n```\nmore\n````\n"), ["store: ./P\n```\nmore"]);
  // Indentation: up to three spaces opens a fence, and the body is dedented
  // by as much as the opener carried.
  eq(kanbanFences("  ```kanban\n  store: ./P\n  ```\n"), ["store: ./P"]);
  eq(kanbanFences("    ```kanban\n    store: ./P\n    ```\n"), [], "four spaces is code, not a fence");
  eq(kanbanFences("```kanban\r\nstore: ./P\r\n```\r\n"), ["store: ./P"], "CRLF");
  eq(kanbanFences("~~~kanban\nstore: ./P\n~~~\n"), ["store: ./P"], "tildes fence too");

  // The key a fence and its snapshot are matched by; the worker's fenceKey
  // must normalize identically (share-worker/src/index.js).
  eq(fenceKeyOf("store: ./P"), "store: ./P");
  eq(fenceKeyOf("store: ./P\n\n"), "store: ./P");
  eq(fenceKeyOf("store: ./P\r\n"), "store: ./P");
}

/* ============ the columns a board shows ============
   One derivation for the board tab, a note's embed, and the picture a
   published page carries — so a published board can't disagree with the
   board it was published from. */
{
  const def = {
    name: "Projects",
    fields: [
      { id: "status", name: "Status", type: "select" },
      { id: "owner", name: "Owner", type: "select" },
      { id: "tags", name: "Tags", type: "multi_select" },
    ],
    options: [
      { field: "status", name: "Backlog", rank: "a0", color: "grey" },
      { field: "status", name: "In progress", rank: "a1", color: "blue" },
      { field: "status", name: "Done", rank: "a2", color: "green" },
      { field: "owner", name: "Ada", rank: "a0", color: "purple" },
    ],
    views: [{ id: "board", kind: "kanban", name: "Board", groupBy: "status" }],
    foreign: [],
  };
  const card = (title, props) => ({
    path: `/w/Projects/${title}.md`,
    name: `${title}.md`,
    title,
    snapshot: { mtime_ms: 0, size: 0 },
    props,
    opaque: [],
  });
  const cards = [
    card("Hull", { status: "In progress", rank: "a0", owner: "Ada", tags: ["big", "boat"] }),
    card("Sails", { status: "In progress", rank: "a1" }),
    card("Idea", { rank: "a0" }),
    card("Weird", { status: "Shipped?", rank: "a0" }),
  ];

  const cols = boardColumns(def, cards, "status");
  eq(
    cols.map((c) => c.key),
    ["", "Backlog", "In progress", "Done", "Shipped?"],
    "the empty column, the declared options by rank, then values nothing declares",
  );
  eq(cols.map((c) => c.declared), [false, true, true, true, false]);
  eq(cols[0].label, "No status", "the empty column is named after its field");
  eq(cols[2].color, "blue");
  eq(cols[2].cards.map((c) => c.title), ["Hull", "Sails"], "cards sort by rank");
  eq(cols[4].label, "Shipped?", "a stray value is shown, never normalized away");

  eq(
    boardColumns(def, cards, "status", ["Done", ""]).map((c) => c.key),
    ["Backlog", "In progress", "Shipped?"],
    "hide leaves a column out of THIS view",
  );
  eq(
    boardColumns(def, cards, "owner").map((c) => c.key),
    ["", "Ada"],
    "grouping by another field regroups the same cards",
  );
  eq(cardValue(cards[0], "status"), "In progress");
  eq(cardValue(cards[2], "status"), "", "an unset field is the empty value");
  eq(columnCards(cards, "status", "").map((c) => c.title), ["Idea"]);
  eq(orderedOptions(def, "status").map((o) => o.name), ["Backlog", "In progress", "Done"]);

  // Chips: every declared field but the one the board groups by.
  eq(chipFieldsOf(def, "status").map((f) => f.id), ["owner", "tags"]);
  eq(cardChips(cards[0], def, chipFieldsOf(def, "status")), [
    { key: "owner", text: "Ada", color: "purple" },
    { key: "tags:big", text: "big", color: null },
    { key: "tags:boat", text: "boat", color: null },
  ]);
  eq(cardChips(cards[1], def, chipFieldsOf(def, "status")), [], "an empty card has no chips");

  /* ---- the picture a published page carries ---- */
  const pages = { "/w/Projects/Hull.md": "page-hull" };
  const snap = boardSnapshot("store: ./Projects", def, cards, (p) => pages[p]);
  eq(snap.fence, "store: ./Projects");
  eq(snap.name, "Projects");
  eq(
    snap.columns.map((c) => c.name),
    ["No status", "Backlog", "In progress", "Done", "Shipped?"],
    "a declared column shows even when empty; an undeclared one shows when it holds cards",
  );
  // …but an EMPTY undeclared column is dropped: it exists on the desktop so
  // you can drag into it, and nobody drags on a published page.
  eq(
    boardSnapshot("store: ./P", def, [cards[0]], () => undefined).columns.map((c) => c.name),
    ["Backlog", "In progress", "Done"],
  );
  eq(snap.columns[2], {
    name: "In progress",
    color: "blue",
    cards: [
      {
        title: "Hull",
        chips: [
          { text: "Ada", color: "purple" },
          { text: "big" },
          { text: "boat" },
        ],
        page: "page-hull",
      },
      { title: "Sails" },
    ],
  });
  ok(
    snap.columns[1].color === "grey" && snap.columns[1].cards.length === 0,
    "an empty declared column keeps its colour",
  );
  ok(!("page" in snap.columns[2].cards[1]), "a card with no page of its own isn't a link");

  // The embed's own keys narrow the picture, exactly as they narrow the board.
  eq(
    boardSnapshot("store: ./P\nhide: [Done, Shipped?]", def, cards, () => undefined).columns.map(
      (c) => c.name,
    ),
    ["No status", "Backlog", "In progress"],
  );
  eq(
    boardSnapshot("store: ./P\ngroup: owner", def, cards, () => undefined).columns.map(
      (c) => c.name,
    ),
    ["No owner", "Ada"],
  );

  // Caps: a page is a document, not a database export — and what is cut is
  // counted, never silently dropped.
  const many = Array.from({ length: 260 }, (_, i) =>
    card(`C${String(i).padStart(3, "0")}`, { status: "Backlog", rank: `a${i}` }),
  );
  const big = boardSnapshot("store: ./P", def, many, () => undefined);
  const backlog = big.columns.find((c) => c.name === "Backlog");
  eq(backlog.cards.length, 200);
  eq(backlog.more, 60);

  // A definition with no groupable field at all has no board to draw.
  eq(
    boardSnapshot("store: ./P", { ...def, fields: [], options: [], views: [] }, [], () => undefined),
    null,
  );
}

console.log(`store.test.mjs: ${checks} checks passed`);
