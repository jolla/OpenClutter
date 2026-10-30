"use strict";

// forest=crowns prototype (/dev only): stemmed trees as stacked faceted
// crowns on one axis, inside their measured outline.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const exportMode = require("../netlify/lib/export-mode");
const { facetCrownParts } = require("../netlify/lib/vegetation");

function circle(cx, cy, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  out.push([out[0][0], out[0][1]]);
  return out;
}

function area(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}

const frame = { mpuX: 0.5, mpuY: 0.5 };

describe("forest=crowns prototype", () => {
  it("is off by default and never on a production host", () => {
    const saved = process.env.OC_FOREST_CROWNS;
    delete process.env.OC_FOREST_CROWNS;
    try {
      assert.equal(exportMode.isCrownStyle(), false);
      assert.equal(exportMode.forestMode(false, { forest: "crowns" }), "off");
      assert.equal(exportMode.forestMode(true, { forest: "crowns" }), "crowns");
      assert.equal(exportMode.DEV_FOREST_DEFAULT, "bands");
    } finally {
      if (saved !== undefined) process.env.OC_FOREST_CROWNS = saved;
    }
  });

  it("turns a stemmed tree's bands into coaxial faceted crowns inside the outline", () => {
    // A lumpy 6 m crown (in 0.5 m pixels) with its stem near the middle.
    const outline = [];
    for (let i = 0; i < 24; i++) {
      const a = (2 * Math.PI * i) / 24;
      const r = 12 + (i % 3 === 0 ? 1.5 : -0.5);
      outline.push([100 + r * Math.cos(a), 100 + r * Math.sin(a)]);
    }
    outline.push([outline[0][0], outline[0][1]]);
    const parts = [
      { ringPx: circle(100, 100, 9, 12) },
      { ringPx: outline },
      { ringPx: circle(100, 100, 7, 12) },
    ];
    const row = { area: { ringPx: outline }, trunk: { ringPx: circle(100.5, 99.5, 0.6, 8) } };
    assert.equal(facetCrownParts(parts, row, frame), true);
    const sides = parts.map((p) => p.ringPx.length - 1);
    assert.deepEqual(sides, [10, 10, 10]);
    // The middle band is widest and none spills far past the measured crown.
    assert.ok(area(parts[1].ringPx) > area(parts[0].ringPx));
    assert.ok(area(parts[0].ringPx) > area(parts[2].ringPx));
    assert.ok(area(parts[1].ringPx) <= area(outline) * 1.02);
    // One axis: every band is centred over the stem.
    for (const p of parts) {
      const n = p.ringPx.length - 1;
      let x = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        x += p.ringPx[i][0];
        y += p.ringPx[i][1];
      }
      assert.ok(Math.abs(x / n - 100.5) < 1e-6 && Math.abs(y / n - 99.5) < 1e-6);
    }
  });

  it("leaves a crown alone when a facet would leave its measured outline", () => {
    // A thin L-shaped crown: no centred polygon of its area fits inside it.
    const outline = [[0, 0], [60, 0], [60, 6], [6, 6], [6, 60], [0, 60], [0, 0]];
    const before = outline.map((p) => p.slice());
    const parts = [{ ringPx: outline }];
    const row = { area: { ringPx: outline }, trunk: { ringPx: circle(3, 3, 0.6, 8) } };
    assert.equal(facetCrownParts(parts, row, frame), false);
    assert.deepEqual(parts[0].ringPx, before);
  });

  it("facets a small clump with no stem, but not a wide one, a stand, a palm or a tile", () => {
    const ring = circle(50, 50, 10, 16);
    const small = [{ ringPx: ring }];
    assert.equal(facetCrownParts(small, { area: { ringPx: ring } }, frame), true);
    assert.equal(small[0].ringPx.length - 1, 10);
    const wide = circle(100, 100, 50, 24); // 25 m across at 0.5 m per pixel
    assert.equal(facetCrownParts([{ ringPx: wide }], { area: { ringPx: wide } }, frame), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring } }, frame, true), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring }, slopePiece: true }, frame), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring }, trunk: { ringPx: circle(50, 50, 1, 8) }, palm: true }, frame), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring }, trunk: { ringPx: circle(50, 50, 1, 8) }, tile: true }, frame), false);
  });
});
