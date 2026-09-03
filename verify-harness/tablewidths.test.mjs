// Unit tests for persisted table column widths (src/tableWidths.ts) — the
// content-addressed identity model that lets a `tcols` meta record find its
// table again after a restart, and the read/apply pair that moves widths
// between a ProseMirror document and that record. Run:
//
//   node verify-harness/tablewidths.test.mjs
//
// (Compiles through vite, mirroring metafile.test.mjs; the entry adds a
// schema + document builders — see tablewidths-entry.ts.)
import { build } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const harness = path.dirname(fileURLToPath(import.meta.url));
const out = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    target: "es2022",
    lib: {
      entry: path.join(harness, "tablewidths-entry.ts"),
      formats: ["es"],
      fileName: "tw",
    },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const mod = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
const {
  readTableWidths,
  applyTableWidths,
  tableWidthsKey,
  tableSignature,
  deriveId,
  table,
  para,
  quote,
  doc,
  colwidthsOf,
} = mod;

const h = (text) => ({ text });
const w = (text, colwidth) => ({ text, colwidth });

/* ---------- reading: only resized tables produce records ---------- */
{
  const d = doc(table([h("Name"), h("Role")], [h("Ada"), h("Engineer")]));
  assert.deepEqual(readTableWidths(d), [], "an untouched table stores nothing");
}
{
  const d = doc(
    table([w("Name", [220]), h("Role")], [h("Ada"), h("Engineer")]),
  );
  const [rec] = readTableWidths(d);
  assert.deepEqual(rec.cols, [220, 0], "column 2 is auto, and says so");
  assert.equal(typeof rec.id, "string");
  assert.equal(rec.id.length, 8);
}

/* ---------- the round trip ---------- */
{
  const sized = doc(
    para("intro"),
    table([w("Name", [220]), w("Role", [140])], [h("Ada"), h("Engineer")]),
  );
  const records = readTableWidths(sized);
  // A fresh parse of the same markdown has no widths at all.
  const fresh = doc(para("intro"), table([h("Name"), h("Role")], [h("Ada"), h("Engineer")]));
  assert.deepEqual(readTableWidths(fresh), []);
  const restored = applyTableWidths(fresh, records);
  assert.deepEqual(
    readTableWidths(restored),
    records,
    "apply∘read is the identity on the record set",
  );
  assert.deepEqual(colwidthsOf(restored), [
    [[220], [140]],
    [[220], [140]],
  ], "every row's cells carry the column width, not just the header");
  assert.equal(readTableWidths(fresh).length, 0, "the input document is untouched");
}

/* ---------- identity: what survives, what doesn't ---------- */
const idOf = (d) => readTableWidths(d)[0].id;
const sizedTable = (headers) =>
  doc(table(headers.map((t, i) => (i === 0 ? w(t, [220]) : h(t))), headers.map(() => h("x"))));

{
  // Body edits, extra rows, and surrounding prose don't move the id.
  const a = doc(table([w("Name", [220]), h("Role")], [h("Ada"), h("Engineer")]));
  const b = doc(
    para("a new paragraph above"),
    table(
      [w("Name", [220]), h("Role")],
      [h("Grace"), h("Admiral")],
      [h("Ada"), h("Engineer")],
    ),
  );
  assert.equal(idOf(a), idOf(b), "content and position below the header are irrelevant");
}
{
  // Whitespace in a header is normalized (a reflowed markdown source is the
  // same table).
  assert.equal(idOf(sizedTable(["Name", "Role"])), idOf(sizedTable(["Name ", " Role"])));
}
{
  // Renaming a header or changing the column count DOES move it — that's the
  // documented, graceful failure: the old record no longer matches.
  assert.notEqual(idOf(sizedTable(["Name", "Role"])), idOf(sizedTable(["Name", "Title"])));
  assert.notEqual(
    idOf(sizedTable(["Name", "Role"])),
    idOf(sizedTable(["Name", "Role", "Location"])),
  );
  const renamed = sizedTable(["Name", "Title"]);
  assert.deepEqual(
    colwidthsOf(applyTableWidths(sizedTable(["Name", "Title"]), readTableWidths(sizedTable(["Name", "Role"])))),
    colwidthsOf(renamed),
    "a record whose table changed shape applies nothing",
  );
}
{
  // Two identical tables are told apart by occurrence, and an unrelated
  // table inserted before them doesn't shift which record is whose.
  const twin = (first, second) =>
    doc(
      table([w("Name", [first]), h("Role")], [h("Ada"), h("Engineer")]),
      table([w("Name", [second]), h("Role")], [h("Grace"), h("Admiral")]),
    );
  const records = readTableWidths(twin(220, 300));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id);
  const restored = applyTableWidths(twin(0, 0), records);
  assert.deepEqual(readTableWidths(restored), records, "each twin keeps its own width");

  const withUnrelated = doc(
    table([h("Other"), h("Cols")], [h("x"), h("y")]),
    table([h("Name"), h("Role")], [h("Ada"), h("Engineer")]),
    table([h("Name"), h("Role")], [h("Grace"), h("Admiral")]),
  );
  const shifted = readTableWidths(applyTableWidths(withUnrelated, records));
  assert.deepEqual(
    shifted.map((r) => r.cols),
    [
      [220, 0],
      [300, 0],
    ],
    "a differently-shaped table added above doesn't renumber the twins",
  );
}

/* ---------- nesting ---------- */
{
  const d = doc(
    para("before"),
    quote(table([w("Name", [180])], [h("Ada")])),
    para("after"),
  );
  const records = readTableWidths(d);
  assert.equal(records.length, 1, "tables inside block containers are found");
  const fresh = doc(para("before"), quote(table([h("Name")], [h("Ada")])), para("after"));
  assert.deepEqual(readTableWidths(applyTableWidths(fresh, records)), records);
}

/* ---------- spans ---------- */
{
  // A colspan-2 header over two single-width body columns: the record is
  // per-COLUMN, and applying it writes into the right slot of the spanning
  // cell.
  const spanned = (widths) =>
    doc(
      table(
        [{ text: "Wide", colspan: 2, colwidth: widths }],
        [h("a"), h("b")],
        [h("c"), h("d")],
      ),
    );
  const records = readTableWidths(spanned([160, 240]));
  assert.deepEqual(records[0].cols, [160, 240]);
  const restored = applyTableWidths(spanned(null), records);
  assert.deepEqual(colwidthsOf(restored)[0], [[160, 240]]);
  assert.deepEqual(colwidthsOf(restored)[1], [[160], [240]]);
}
{
  // A rowspanning cell is one node in two rows — it must be written once,
  // with the correct width, and not corrupted by the second visit.
  const d = doc(
    table(
      [w("Left", [150]), h("Right")],
      [{ text: "tall", rowspan: 2 }, h("b")],
      [h("d")],
    ),
  );
  const records = readTableWidths(d);
  assert.deepEqual(records[0].cols, [150, 0]);
  const fresh = doc(
    table([h("Left"), h("Right")], [{ text: "tall", rowspan: 2 }, h("b")], [h("d")]),
  );
  const restored = applyTableWidths(fresh, records);
  assert.deepEqual(colwidthsOf(restored), [
    [[150], null],
    [[150], null],
    [null],
  ]);
}

/* ---------- defensive: junk records can't corrupt a document ---------- */
{
  const fresh = doc(table([h("Name"), h("Role")], [h("Ada"), h("Engineer")]));
  assert.equal(applyTableWidths(fresh, []), fresh, "no records: the same doc object back");
  const unknown = applyTableWidths(fresh, [{ id: "zzzzzzzz", cols: [200, 200] }]);
  assert.deepEqual(colwidthsOf(unknown), [
    [null, null],
    [null, null],
  ]);
  // A record with the right id but a stale column count applies what it can.
  const good = readTableWidths(
    doc(table([w("Name", [220]), h("Role")], [h("Ada"), h("Engineer")])),
  )[0];
  const short = applyTableWidths(fresh, [{ id: good.id, cols: [220] }]);
  assert.deepEqual(colwidthsOf(short), [
    [[220], null],
    [[220], null],
  ]);
  const zeros = applyTableWidths(fresh, [{ id: good.id, cols: [0, 0] }]);
  assert.deepEqual(colwidthsOf(zeros), [
    [null, null],
    [null, null],
  ], "0 means auto, not a zero-width column");
}

/* ---------- the cross-implementation contract ----------
   A public page's reading view (the cloud worker, docs/cloud-redesign.md
   §5.6) re-derives these ids from its markdown renderer's tokens to attach
   widths to server-rendered HTML, so the identity function gets a second
   implementation in a file this one can't import. These literals are the
   contract: the worker's own suite must publish pages whose records carry
   exactly these ids and assert it finds the right tables. Change the hash or
   the signature and BOTH suites fail — which is the alarm. Never "fix" a
   literal here without re-pinning it there. */
{
  const id = (cols, headers, nth = 0) => deriveId(tableSignature(cols, headers), nth);
  assert.equal(id(3, ["Name", "Role", "Location"]), "yh4epk11");
  assert.equal(id(3, ["Q3", "id", "docs"]), "10ekmx0x");
  assert.equal(id(2, ["Name", "Role"], 0), "1sv41y41");
  assert.equal(id(2, ["Name", "Role"], 1), "c02mbb1j");
  assert.equal(id(2, ["R&D", "Owner"]), "1c480k21");
  // Header identity is PLAIN text — that's what makes the worker's mirror
  // (which sees marked's tokens, not ProseMirror's) able to agree.
  assert.equal(tableSignature(2, ["  Q3\n report ", "Owner"]), tableSignature(2, ["Q3 report", "Owner"]));
  // …and a real document with those headers derives the same id as the
  // literal above, so the pinning covers the doc path too, not just the
  // string function.
  const fromDoc = readTableWidths(
    doc(table([w("Name", [260]), h("Role"), h("Location")], [h("Ada"), h("Eng"), h("London")])),
  );
  assert.equal(fromDoc[0].id, "yh4epk11");
}

/* ---------- the change key ---------- */
{
  const a = readTableWidths(doc(table([w("Name", [220])], [h("Ada")])));
  const b = readTableWidths(doc(table([w("Name", [220])], [h("Grace")])));
  const c = readTableWidths(doc(table([w("Name", [221])], [h("Ada")])));
  assert.equal(tableWidthsKey(a), tableWidthsKey(b), "same widths, same key");
  assert.notEqual(tableWidthsKey(a), tableWidthsKey(c));
  assert.equal(tableWidthsKey([]), "");
}

console.log("PASS tablewidths.test.mjs");
