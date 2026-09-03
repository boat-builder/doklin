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
  resolveView,
  newView,
  groupableFields,
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
  fenceEmbed,
  embedKind,
  storeFences,
  langOf,
  KANBAN_LANG,
  TABLE_LANG,
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
  csvField,
  csvFileName,
  storeCsv,
  toCsv,
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
  eq(resolveView(fresh, "kanban").groupBy, "status");
  const noView = { ...fresh, views: [] };
  eq(
    resolveView(noView, "kanban").groupBy,
    "status",
    "falls back to the first select field",
  );
  eq(resolveView({ ...fresh, views: [], fields: [], options: [] }, "kanban"), null);
  eq(cardKeyOrder(fresh), ["status", "rank"]);

  // A ```table fence works before anyone has saved a table view: the fence's
  // LANGUAGE decides the kind, so it gets a synthetic one rather than the
  // kanban view that happens to be saved.
  eq(resolveView(fresh, "table").kind, "table");
  eq(resolveView(fresh, "table").groupBy, "", "a table groups by nothing");
  eq(
    resolveView(fresh, "kanban", "nope").id,
    "board",
    "an id nobody declares falls back to the first view of the kind",
  );
  // A saved view whose group-by field was deleted is still THE view: showing
  // a different one silently would be worse than saying what it is missing.
  const orphaned = { ...fresh, fields: [], options: [] };
  eq(resolveView(orphaned, "kanban").id, "board");
  eq(resolveView(orphaned, "kanban").groupBy, "status", "even though nothing declares it");
  // A synthetic view never takes a saved view's id, so narrowing it saves a
  // NEW view rather than overwriting somebody else's.
  const tableNamedBoard = {
    ...fresh,
    views: [newView("board", "table", "Board", "")],
  };
  eq(resolveView(tableNamedBoard, "kanban").id, "board_2");
  eq(
    groupableFields({
      ...fresh,
      fields: [
        { id: "note", name: "Note", type: "text" },
        { id: "due", name: "Due", type: "date" },
        { id: "tags", name: "Tags", type: "multi_select" },
      ],
    }).map((f) => f.id),
    ["due", "tags"],
    "a board can put selects, multi-selects and dates in columns — nothing else",
  );

  /* ---- what a view carries ---- */
  const viewed = parseStoreDef(
    [
      '{"doklin":"store","v":1,"name":"P"}',
      '{"t":"field","id":"status","name":"Status","type":"select"}',
      '{"t":"view","id":"b","kind":"kanban","name":"Board","groupBy":"status",' +
        '"filter":[{"f":"status","op":"is","v":"Done"},{"f":"status","op":"nope","v":"x"}],' +
        '"sort":{"f":"status","dir":"desc"},"show":["status"],"hide":["Done"]}',
      '{"t":"view","id":"t","kind":"table","name":"Table","groupBy":""}',
      '{"t":"view","id":"bad","kind":"gantt","name":"Gantt","groupBy":"status"}',
      '{"t":"view","id":"ungrouped","kind":"kanban","name":"X","groupBy":""}',
      "",
    ].join("\n"),
  );
  eq(viewed.views.map((v) => v.id), ["b", "t"], "an unknown kind is not a view");
  eq(viewed.views[0].filter, [{ field: "status", op: "is", value: "Done" }],
    "a clause with an op this version doesn't know is skipped, the view is not");
  eq(viewed.views[0].sort, { field: "status", dir: "desc" });
  eq(viewed.views[0].show, ["status"]);
  eq(viewed.views[0].hide, ["Done"]);
  eq(viewed.views[1].kind, "table");
  eq(viewed.views[1].show, null, "a view nobody has narrowed shows every field");
  // Equal state, equal bytes — and a view carrying nothing keeps the bytes it
  // has always had.
  eq(
    serializeStoreDef(viewed),
    serializeStoreDef(parseStoreDef(serializeStoreDef(viewed))),
    "a view round-trips",
  );
  ok(
    serializeStoreDef({ ...viewed, views: [newView("b", "kanban", "Board", "status")] }).includes(
      '{"t":"view","id":"b","kind":"kanban","name":"Board","groupBy":"status"}',
    ),
    "an unfiltered, unsorted view writes exactly what version 1 wrote",
  );

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
  eq(fenceEmbed("kanban", "store: ./P"), "```kanban\nstore: ./P\n```");
  eq(fenceEmbed("table", "store: ./P"), "```table\nstore: ./P\n```");
  eq(fenceEmbed("kanban", ""), "```kanban\n```", "an empty embed is still a fence");
  eq(KANBAN_LANG, "kanban");
  eq(TABLE_LANG, "table");
  eq(langOf("kanban"), "kanban");
  eq(langOf("table"), "table");
  // A config carrying a backtick run can't break out of its own fence: the
  // fence grows past the longest run, exactly as a markdown serializer's does.
  eq(
    fenceEmbed("kanban", "store: ./``x"),
    "```kanban\nstore: ./``x\n```",
    "a short run needs no growth",
  );
  eq(fenceEmbed("kanban", "a\n```\nb"), "````kanban\na\n```\nb\n````");
  eq(fenceEmbed("kanban", "````"), "`````kanban\n````\n`````");

  // Which fences the app claims, and as what. Strict on purpose: anything
  // else stays an ordinary code block, which round-trips byte for byte.
  eq(embedKind("kanban", null), "kanban");
  eq(embedKind("kanban", ""), "kanban");
  eq(embedKind("table", null), "table");
  eq(embedKind("Kanban", null), null, "case matters");
  eq(embedKind("kanban", "tight"), null, "a fence with meta is not ours");
  eq(embedKind("mermaid", null), null);
  eq(embedKind(null, null), null, "a bare fence is not ours");
}


/* ============ finding the fences in a document ============
   A share push has only the file's bytes — no parsed document — so it scans
   for ```kanban fences itself. The scan has to agree with the editor's
   parser about what IS a fence. */
{
  const texts = (md) => storeFences(md).map((f) => f.text);
  eq(storeFences("no fences here\n"), []);
  eq(storeFences("```kanban\nstore: ./P\n```\n"), [{ kind: "kanban", text: "store: ./P" }]);
  eq(storeFences("```table\nstore: ./P\n```\n"), [{ kind: "table", text: "store: ./P" }]);
  eq(
    storeFences("# Hi\n\n```kanban\nstore: ./A\n```\n\ntext\n\n```table\nstore: ./B\n```\n"),
    [
      { kind: "kanban", text: "store: ./A" },
      { kind: "table", text: "store: ./B" },
    ],
    "every fence, in document order, each as what its language says",
  );
  eq(texts("```js\nstore: ./P\n```\n"), [], "another language is not ours");
  eq(texts("```kanban tight\nstore: ./P\n```\n"), [], "a fence with meta is not ours");
  eq(texts("```Kanban\nstore: ./P\n```\n"), [], "case matters");
  eq(texts("```kanban\n```\n"), [""], "an empty fence is still a fence");
  eq(texts("```kanban\nstore: ./P\n"), ["store: ./P"], "an unclosed fence ends at EOF");
  // A kanban fence written INSIDE a longer fence is an example, not a board.
  eq(
    texts("````markdown\n```kanban\nstore: ./P\n```\n````\n"),
    [],
    "a fence inside a fence is text",
  );
  // A longer opener needs a closer at least as long.
  eq(texts("````kanban\nstore: ./P\n```\nmore\n````\n"), ["store: ./P\n```\nmore"]);
  // Indentation: up to three spaces opens a fence, and the body is dedented
  // by as much as the opener carried.
  eq(texts("  ```kanban\n  store: ./P\n  ```\n"), ["store: ./P"]);
  eq(texts("    ```kanban\n    store: ./P\n    ```\n"), [], "four spaces is code, not a fence");
  eq(texts("```kanban\r\nstore: ./P\r\n```\r\n"), ["store: ./P"], "CRLF");
  eq(texts("~~~kanban\nstore: ./P\n~~~\n"), ["store: ./P"], "tildes fence too");

  // The key a fence and its snapshot are matched by; a worker that renders
  // a published page must normalize the same way (docs/cloud.md).
  eq(fenceKeyOf("store: ./P"), "store: ./P");
  eq(fenceKeyOf("store: ./P\n\n"), "store: ./P");
  eq(fenceKeyOf("store: ./P\r\n"), "store: ./P");
  ok(
    snapKeyOf("kanban", "store: ./P") !== snapKeyOf("table", "store: ./P"),
    "the same config in two languages is two different views",
  );
  eq(snapKeyOf("kanban", "store: ./P\n"), snapKeyOf("kanban", "store: ./P"));
  eq(snapKind({ fence: "", name: "", columns: [] }), "kanban", "no kind means kanban");
  eq(snapKind({ fence: "", name: "", kind: "table", fields: [], rows: [] }), "table");
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
    views: [newView("board", "kanban", "Board", "status")],
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
    boardColumns(def, cards, "status", { hide: ["Done", ""] }).map((c) => c.key),
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
  eq(columnCards(def, cards, "status", "").map((c) => c.title), ["Idea"]);
  eq(
    cols.map((c) => c.adoptable),
    [false, false, false, false, true],
    "only a stray value of a select field is something to declare",
  );
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
  const snap = boardSnapshot("store: ./Projects", "kanban", def, cards, (p) => pages[p]);
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
    boardSnapshot("store: ./P", "kanban", def, [cards[0]], () => undefined).columns.map(
      (c) => c.name,
    ),
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
    boardSnapshot("store: ./P\nhide: [Done, Shipped?]", "kanban", def, cards, () =>
      undefined,
    ).columns.map((c) => c.name),
    ["No status", "Backlog", "In progress"],
  );
  eq(
    boardSnapshot("store: ./P\ngroup: owner", "kanban", def, cards, () => undefined).columns.map(
      (c) => c.name,
    ),
    ["No owner", "Ada"],
  );

  // Caps: a page is a document, not a database export — and what is cut is
  // counted, never silently dropped.
  const many = Array.from({ length: 260 }, (_, i) =>
    card(`C${String(i).padStart(3, "0")}`, { status: "Backlog", rank: `a${i}` }),
  );
  const big = boardSnapshot("store: ./P", "kanban", def, many, () => undefined);
  const backlog = big.columns.find((c) => c.name === "Backlog");
  eq(backlog.cards.length, 200);
  eq(backlog.more, 60);

  // A definition with no groupable field at all has no board to draw.
  eq(
    boardSnapshot(
      "store: ./P",
      "kanban",
      { ...def, fields: [], options: [], views: [] },
      [],
      () => undefined,
    ),
    null,
  );
}

/* ============ what a VIEW does to the cards ============
   Filter, sort, and which fields show. All of it pure, all of it shared by
   the board tab, a note's embed and the picture a published page carries. */
{
  const def = {
    name: "Work",
    fields: [
      { id: "status", name: "Status", type: "select" },
      { id: "tags", name: "Tags", type: "multi_select" },
      { id: "due", name: "Due", type: "date" },
      { id: "size", name: "Size", type: "number" },
    ],
    options: [
      { field: "status", name: "Todo", rank: "a0", color: "grey" },
      { field: "status", name: "Done", rank: "a1", color: "green" },
      { field: "tags", name: "bug", rank: "a0", color: "red" },
      { field: "tags", name: "auth", rank: "a1" },
    ],
    views: [newView("b", "kanban", "Board", "status")],
    foreign: [],
  };
  const card = (title, props) => ({
    path: `/w/Work/${title}.md`,
    name: `${title}.md`,
    title,
    snapshot: { mtime_ms: 0, size: 0 },
    props,
    opaque: [],
  });
  const cards = [
    card("Alpha", { status: "Todo", tags: ["bug", "auth"], due: "2026-09-12", size: 10, rank: "a0" }),
    card("Beta", { status: "Done", tags: ["auth"], due: "2026-09-02", size: 2, rank: "a1" }),
    card("Gamma", { status: "Todo", rank: "a2" }),
  ];
  const titles = (list) => list.map((c) => c.title);

  /* ---- filter ---- */
  const pass = (op, value, field = "status") =>
    titles(applyFilter(def, cards, [{ field, op, value }]));
  eq(pass("is", "Todo"), ["Alpha", "Gamma"]);
  eq(pass("is", "todo"), ["Alpha", "Gamma"], "a value's case is not the point");
  eq(pass("is_not", "Todo"), ["Beta"]);
  eq(pass("empty", "", "due"), ["Gamma"]);
  eq(pass("not_empty", "", "due"), ["Alpha", "Beta"]);
  eq(pass("has", "aut", "tags"), ["Alpha", "Beta"], "has looks inside a multi-select");
  eq(
    pass("is", ""),
    ["Alpha", "Beta", "Gamma"],
    "a clause with no value yet passes everything — half a filter must not blank a board",
  );
  eq(
    titles(
      applyFilter(def, cards, [
        { field: "status", op: "is", value: "Todo" },
        { field: "tags", op: "not_empty", value: "" },
      ]),
    ),
    ["Alpha"],
    "clauses are ANDed",
  );
  ok(cardPasses(def, cards[0], { field: "tags", op: "is", value: "auth" }),
    "is on a multi-select means one of its values");

  /* ---- sort ---- */
  eq(titles(sortCards(def, cards, { field: "due", dir: "asc" })), ["Beta", "Alpha", "Gamma"]);
  eq(
    titles(sortCards(def, cards, { field: "due", dir: "desc" })),
    ["Alpha", "Beta", "Gamma"],
    "an empty value sorts last in BOTH directions — a card nobody dated is not the earliest",
  );
  eq(
    titles(sortCards(def, cards, { field: "size", dir: "asc" })),
    ["Beta", "Alpha", "Gamma"],
    "a number sorts as a number",
  );
  eq(titles(sortCards(def, cards, null)), ["Alpha", "Beta", "Gamma"], "no sort, no reorder");
  eq(
    titles(viewCards(def, cards, newView("t", "table", "T", ""))),
    ["Alpha", "Beta", "Gamma"],
    "a table with no opinion is in title order",
  );

  /* ---- which fields show ---- */
  eq(visibleFields(def, null).map((f) => f.id), ["status", "tags", "due", "size"]);
  eq(visibleFields(def, ["due", "status"]).map((f) => f.id), ["status", "due"],
    "shown fields keep the store's order, not the tick order");
  eq(chipFieldsOf(def, "status", ["status", "tags"]).map((f) => f.id), ["tags"],
    "the group-by field is never a chip — the column already says it");

  /* ---- grouping by a multi-select: one card, several columns ---- */
  const byTag = boardColumns(def, cards, "tags");
  eq(byTag.map((c) => c.key), ["", "bug", "auth"]);
  eq(titles(byTag[0].cards), ["Gamma"], "a card with no tags is in the empty column");
  eq(titles(byTag[1].cards), ["Alpha"]);
  eq(titles(byTag[2].cards), ["Alpha", "Beta"], "a card is in a column for EVERY value it carries");
  eq(cardValues(cards[0], def.fields[1], "tags"), ["bug", "auth"]);
  eq(cardValues(cards[0], def.fields[0], "status"), ["Todo"], "one value for anything else");

  /* ---- grouping by a date: the columns ARE the data ---- */
  const byDue = boardColumns(def, cards, "due");
  eq(byDue.map((c) => c.key), ["", "2026-09-02", "2026-09-12"],
    "dates in order — sorting ISO dates as text IS chronological");
  eq(byDue.map((c) => c.adoptable), [false, false, false],
    "a date has no options, so there is nothing to declare");
  eq(byDue[0].label, "No due");

  /* ---- a published table ---- */
  const pages = { "/w/Work/Alpha.md": "page-alpha" };
  const view = { ...newView("t", "table", "T", ""), show: ["status", "tags"] };
  const table = boardSnapshot("store: ./W\nview: t", "table", { ...def, views: [view] }, cards, (p) => pages[p]);
  eq(table.kind, "table");
  eq(table.fields, ["Status", "Tags"], "the columns a view shows, named as the store names them");
  eq(table.rows.length, 3);
  eq(table.rows[0], {
    title: "Alpha",
    page: "page-alpha",
    cells: [[{ text: "Todo", color: "grey" }], [{ text: "bug", color: "red" }, { text: "auth" }]],
  });
  ok(!("page" in table.rows[2]), "a card with no page of its own isn't a link");
  eq(table.rows[2].cells, [[{ text: "Todo", color: "grey" }], []], "an empty cell is empty, not missing");
  // The same store, the same config, two languages: two different views.
  eq(boardSnapshot("store: ./W", "kanban", def, cards, () => undefined).kind, undefined);

  const sorted = boardSnapshot(
    "store: ./W",
    "table",
    { ...def, views: [{ ...newView("t", "table", "T", ""), sort: { field: "due", dir: "asc" } }] },
    cards,
    () => undefined,
  );
  eq(sorted.rows.map((r) => r.title), ["Beta", "Alpha", "Gamma"], "the view's sort is what it publishes");

  const filtered = boardSnapshot(
    "store: ./W",
    "table",
    {
      ...def,
      views: [
        { ...newView("t", "table", "T", ""), filter: [{ field: "status", op: "is", value: "Done" }] },
      ],
    },
    cards,
    () => undefined,
  );
  eq(filtered.rows.map((r) => r.title), ["Beta"], "a view's filter travels with it");

  // Rows beyond the cap are counted, never silently dropped.
  const many = Array.from({ length: 240 }, (_, i) =>
    card(`C${String(i).padStart(3, "0")}`, { status: "Todo", rank: `a${i}` }),
  );
  const big = boardSnapshot("store: ./W", "table", def, many, () => undefined);
  eq(big.rows.length, 200);
  eq(big.more, 40);
}

/* ============ a view, as a spreadsheet ============ */
{
  eq(csvField("plain"), "plain");
  eq(csvField("a,b"), '"a,b"');
  eq(csvField('say "hi"'), '"say ""hi"""');
  eq(csvField("two\nlines"), '"two\nlines"');
  eq(csvField(" padded "), '" padded "', "a reader would otherwise eat the spaces");
  eq(toCsv([["a", "b"], ["c", "d"]]), "a,b\r\nc,d\r\n", "CRLF, as every spreadsheet expects");

  const fields = [
    { id: "status", name: "Status", type: "select" },
    { id: "tags", name: "Tags", type: "multi_select" },
  ];
  const card = (title, props) => ({
    path: `/w/W/${title}.md`,
    name: `${title}.md`,
    title,
    snapshot: { mtime_ms: 0, size: 0 },
    props,
    opaque: [],
  });
  eq(
    storeCsv([card("Hull", { status: "Todo", tags: ["bug", "auth"] }), card("Sails", {})], fields),
    'Title,Status,Tags\r\nHull,Todo,"bug, auth"\r\nSails,,\r\n',
  );
  eq(csvFileName("Projects"), "Projects.csv");
  eq(csvFileName("a/b:c"), "a-b-c.csv", "nothing a path separator could make something of");
  eq(csvFileName("  "), "Store.csv");
}

console.log(`store.test.mjs: ${checks} checks passed`);
