// The flowchart renderer (src/flowchart/) against the shared cases in
// verify-harness/flowchart-fixture.json: each is a Mermaid source, the frame
// it is laid out for, and the scene that must come out, number for number.
// The iPhone app decodes the same scenes (its side of scene.ts), so a change
// to a scene's shape shows up on both sides. Run:
//
//   node verify-harness/flowchart.test.mjs           # compare
//   node verify-harness/flowchart.test.mjs --write   # write the scenes the code draws now
//
// After --write, look at the pictures before keeping the file
// (verify-harness/shot-flowchart.mjs): the fixture pins what the renderer
// draws, not that it is right.
//
// Also here: the rules a scene must keep whatever it shows — boxes of one
// rank stay in written order (why the layout engine is pinned), the SVG holds
// nothing a ```svg drawing may not, and a source that is not drawn says why
// in a sentence.
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const harness = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(harness, "flowchart-fixture.json");
const out = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    target: "es2022",
    lib: { entry: path.join(harness, "flowchart-entry.ts"), formats: ["es"], fileName: "flowchart" },
  },
});
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
const { FRAME, isFlowchart, layoutFlowchart, sceneSvg, sanitizeDrawing } = await import(
  `data:text/javascript,${encodeURIComponent(chunk.code)}`
);

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

if (process.argv.includes("--write")) {
  for (const c of fixture.cases) {
    const result = layoutFlowchart(c.source, c.frame);
    assert.ok(result.ok, `${c.name}: ${result.message}`);
    c.scene = result.scene;
  }
  // One item to a line, so a change to one box is a change to one line.
  const scene = (s) =>
    `{"width":${s.width},"height":${s.height},"label":${JSON.stringify(s.label)},"items":[\n${s.items
      .map((it) => `    ${JSON.stringify(it)}`)
      .join(",\n")}\n   ]}`;
  const cases = fixture.cases
    .map(
      (c) =>
        `  {\n   "name": ${JSON.stringify(c.name)},\n   "frame": ${c.frame},\n   "source": ${JSON.stringify(c.source)},\n   "scene": ${scene(c.scene)}\n  }`,
    )
    .join(",\n");
  const refused = fixture.refused.map((r) => `  ${JSON.stringify(r)}`).join(",\n");
  writeFileSync(fixturePath, `{\n "cases": [\n${cases}\n ],\n "refused": [\n${refused}\n ]\n}\n`);
  console.log(`wrote ${fixture.cases.length} scenes to verify-harness/flowchart-fixture.json`);
  process.exit(0);
}

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`ok   ${name}`);
};

for (const c of fixture.cases) {
  test(`${c.name} at ${c.frame}: the scene is the fixture's`, () => {
    assert.ok(isFlowchart(c.source));
    const result = layoutFlowchart(c.source, c.frame);
    assert.ok(result.ok, result.message);
    // Through JSON, as the fixture went: an absent key and an undefined one are the same scene.
    assert.deepEqual(JSON.parse(JSON.stringify(result.scene)), c.scene);
    assert.deepEqual(layoutFlowchart(c.source, c.frame).scene, result.scene, "the same source lays out the same twice");
    assert.ok(result.scene.width >= c.frame, "a scene is at least as wide as its frame");
  });

  test(`${c.name} at ${c.frame}: its SVG holds nothing a drawing may not`, () => {
    const svg = sceneSvg(c.scene);
    const names = new Set([...svg.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]));
    for (const name of names) assert.ok(["svg", "rect", "path", "text", "tspan"].includes(name), `<${name}>`);
    for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
      assert.match(m[1], /^(none|var\(--dg-(ink|ink-2|rule|grid|accent|good|warn|bad)\)|var\(--sheet\))$/, m[1]);
    }
    assert.ok(!/NaN|Infinity|undefined/.test(svg), "every number is a number");
    const through = sanitizeDrawing(svg, "t-");
    assert.ok(through.ok, through.message);
    // The sanitizer writes an empty element with a closing tag; nothing else may differ.
    assert.ok(through.svg.replace(/><\/(?:rect|path)>/g, "/>") === svg, "the drawing sanitizer changes nothing in it");
  });
}

for (const r of fixture.refused) {
  test(`${r.name}: not drawn, and it says why`, () => {
    const result = layoutFlowchart(r.source, FRAME);
    assert.deepEqual(result, { ok: false, why: r.why, message: r.message });
    assert.match(result.message, /^[A-Z].*\.$/s, "a sentence");
  });
}

test("boxes of one rank come out in the order they were written", () => {
  const result = layoutFlowchart(
    `flowchart TB
  mac([Mac]) --> worker
  phone([Phone]) --> worker
  browser([Browser]) --> worker
  worker[Worker] --> d1[(D1)]
  worker --> r2[(Bucket)]
  worker -.-> cache[Cache]`,
    FRAME,
  );
  assert.ok(result.ok);
  const at = (word) => result.scene.items.find((it) => it.t === "text" && it.runs[0].s === word).x;
  assert.deepEqual(["Mac", "Phone", "Browser"].map(at), ["Mac", "Phone", "Browser"].map(at).sort((a, b) => a - b));
  assert.deepEqual(["D1", "Bucket", "Cache"].map(at), ["D1", "Bucket", "Cache"].map(at).sort((a, b) => a - b));
});

test("a flowchart laid out for a phone's width is no wider than one laid out for the page", () => {
  for (const c of fixture.cases.filter((x) => x.frame === FRAME)) {
    const narrow = layoutFlowchart(c.source, 360);
    assert.ok(narrow.ok, c.name);
    assert.ok(narrow.scene.width <= c.scene.width, c.name);
  }
});

test("a flowchart that would be shown too small is turned the other way, and only then", () => {
  const boxes = (frame, name, words) => {
    const result = layoutFlowchart(fixture.cases.find((c) => c.name === name).source, frame);
    assert.ok(result.ok, name);
    return words.map((word) => result.scene.items.find((it) => it.t === "text" && it.runs[0].s === word));
  };
  const rising = (list) => list.every((v, i) => i === 0 || v > list[i - 1]);
  const same = (list) => list.every((v) => v === list[0]);
  // A row of boxes: across the page, down a phone.
  const steps = ["Stranger", "Looker", "Shortlister", "Buyer"];
  const page = boxes(FRAME, "chain", steps);
  assert.ok(rising(page.map((it) => it.x)) && same(page.map((it) => it.y)), "left to right at the page's width");
  const phone = boxes(360, "chain", steps);
  assert.ok(rising(phone.map((it) => it.y)) && same(phone.map((it) => it.x)), "top to bottom at a phone's");
  // Six boxes side by side: a column of them on a phone.
  const desks = ["Billing", "Shipping", "Returns", "Repairs", "Sales"];
  assert.ok(same(boxes(FRAME, "fan", desks).map((it) => it.y)), "side by side at the page's width");
  assert.ok(rising(boxes(360, "fan", desks).map((it) => it.y)), "one under the other at a phone's");
});

console.log(`\n${passed} passed`);
