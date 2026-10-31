"use strict";
const test = require("node:test");
const assert = require("node:assert");
const u = require("../netlify/lib/understory-style");
const exportMode = require("../netlify/lib/export-mode");
const { understoryOiMaterial } = require("../netlify/lib/materials");

const frame = { mpuX: 0.25, mpuY: 0.25 };
const area = (r) => {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(s / 2);
};

test("tuck steps the understory in 1.5 m from open ground and keeps an edge shared with canopy", () => {
  const ring = [[0, 0], [100, 0], [100, 60], [0, 60], [0, 0]];
  const nb = [[100, 0], [200, 0], [200, 60], [100, 60], [100, 0]];
  const idx = u.footprintIndex([ring, nb], 40);
  const r = u.shapeUnderstory(ring, frame, { style: "tuck", index: idx });
  assert.strictEqual(r.length, 1);
  const xs = r[0].ringPx.map((p) => p[0]);
  const ys = r[0].ringPx.map((p) => p[1]);
  assert.strictEqual(Math.min(...xs), 6);
  assert.strictEqual(Math.max(...xs), 100);
  assert.strictEqual(Math.min(...ys), 6);
  assert.strictEqual(Math.max(...ys), 54);
});

test("tuck output is plain rings under the vertex cap and inside the outline", () => {
  const ring = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const rr = 120 + (i % 2 ? 25 : 0);
    ring.push([300 + rr * Math.cos(a), 300 + rr * Math.sin(a)]);
  }
  ring.push(ring[0]);
  const idx = u.footprintIndex([ring], 40);
  const r = u.shapeUnderstory(ring, frame, { style: "tuck", index: idx });
  assert.ok(r && r.length >= 1);
  for (const p of r) {
    assert.ok(p.ringPx.length - 1 <= 40);
    assert.ok(area(p.ringPx) < area(ring));
  }
});

test("a strip too narrow to tuck keeps its traced outline", () => {
  const ring = [[0, 0], [400, 0], [400, 8], [0, 8], [0, 0]];
  const idx = u.footprintIndex([ring], 40);
  assert.strictEqual(u.shapeUnderstory(ring, frame, { style: "tuck", index: idx }), null);
});

test("understory is tuck by default under forest=crowns, off outside it or with OC_UNDERSTORY=off", () => {
  const prev = process.env.OC_UNDERSTORY;
  process.env.OC_UNDERSTORY = "tuck";
  exportMode.setCrownStyle(false);
  assert.strictEqual(exportMode.understoryStyle(), "");
  assert.strictEqual(understoryOiMaterial(3, 0).display_color, "#A4B56A");
  exportMode.setCrownStyle(true);
  assert.strictEqual(exportMode.understoryStyle(), "tuck");
  assert.strictEqual(understoryOiMaterial(3, 0).display_color, "#3B5530");
  assert.strictEqual(understoryOiMaterial(3, 0).rf_properties.attenuation_per_m, 0.6);
  process.env.OC_UNDERSTORY = "";
  assert.strictEqual(exportMode.understoryStyle(), "tuck");
  process.env.OC_UNDERSTORY = "off";
  assert.strictEqual(exportMode.understoryStyle(), "");
  assert.strictEqual(understoryOiMaterial(3, 0).display_color, "#A4B56A");
  exportMode.setCrownStyle(false);
  if (prev == null) delete process.env.OC_UNDERSTORY;
  else process.env.OC_UNDERSTORY = prev;
});
