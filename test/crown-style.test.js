"use strict";

// forest=crowns prototype (/dev only): stemmed trees as stacked faceted
// crowns on one axis, inside their measured outline.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const exportMode = require("../netlify/lib/export-mode");
const { facetCrownParts, openEdgeShare, planSceneFacets } = require("../netlify/lib/vegetation");

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

// lon/lat equal pixel x/y, 0.5 m pixels.
const frame = { west: 0, east: 1000, south: 0, north: 1000, imgW: 1000, imgH: 1000, mpuX: 0.5, mpuY: 0.5 };

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
    assert.equal(facetCrownParts(parts, row, frame, false, true), true);
    const sides = parts.map((p) => p.ringPx.length - 1);
    assert.deepEqual(sides, [10, 10, 10]);
    // The middle band is widest and none spills far past the measured crown.
    assert.ok(area(parts[1].ringPx) > area(parts[0].ringPx));
    assert.ok(area(parts[0].ringPx) > area(parts[2].ringPx));
    assert.ok(area(parts[1].ringPx) <= area(outline) * 1.3);
    // One axis: every band, and the stem moved under them, share one centre.
    const st = row.trunk.ringPx;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < st.length - 1; i++) {
      sx += st[i][0];
      sy += st[i][1];
    }
    const cx = sx / (st.length - 1);
    const cy = sy / (st.length - 1);
    assert.ok(Math.hypot(cx - 100, cy - 100) < 1);
    for (const p of parts) {
      const n = p.ringPx.length - 1;
      let x = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        x += p.ringPx[i][0];
        y += p.ringPx[i][1];
      }
      assert.ok(Math.abs(x / n - cx) < 1e-6 && Math.abs(y / n - cy) < 1e-6);
    }
  });

  it("leaves a crown alone when a facet would leave its measured outline", () => {
    // A thin L-shaped crown: no centred polygon of its area fits inside it.
    const outline = [[0, 0], [60, 0], [60, 6], [6, 6], [6, 60], [0, 60], [0, 0]];
    const before = outline.map((p) => p.slice());
    const parts = [{ ringPx: outline }];
    const row = { area: { ringPx: outline }, trunk: { ringPx: circle(3, 3, 0.6, 8) } };
    assert.equal(facetCrownParts(parts, row, frame, false, true), false);
    assert.deepEqual(parts[0].ringPx, before);
  });

  it("facets a small clump with no stem, but not a wide one, a stand, a palm or a tile", () => {
    const ring = circle(50, 50, 10, 16);
    const small = [{ ringPx: ring }];
    assert.equal(facetCrownParts(small, { area: { ringPx: ring } }, frame, false, true), true);
    assert.equal(small[0].ringPx.length - 1, 10);
    const wide = circle(100, 100, 50, 24); // 25 m across at 0.5 m per pixel
    assert.equal(facetCrownParts([{ ringPx: wide }], { area: { ringPx: wide } }, frame, false, true), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring } }, frame, false, false), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring } }, frame, true, true), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring }, slopePiece: true }, frame, false, true), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring }, trunk: { ringPx: circle(50, 50, 1, 8) }, palm: true }, frame, false, true), false);
    assert.equal(facetCrownParts([{ ringPx: ring }], { area: { ringPx: ring }, trunk: { ringPx: circle(50, 50, 1, 8) }, tile: true }, frame, false, true), false);
  });

  it("calls a crown lone only when its edge borders open ground", () => {
    const ring = circle(100, 100, 10, 16);
    // Open ground everywhere except the crown itself.
    const lone = (x, y) => (Math.hypot(x - 100, y - 100) <= 10 ? 8 : 0);
    assert.ok(openEdgeShare(ring, frame, lone) >= 0.95);
    // Canopy all around: closed forest.
    assert.equal(openEdgeShare(ring, frame, () => 12), 0);
    assert.equal(openEdgeShare(ring, frame, null), 0);
  });

  it("plans lone crowns that never fuse, keeps closed canopy and drops scraps beside a crown", () => {
    const stem = (x, y) => ({ ringPx: circle(x, y, 0.6, 8) });
    const a = { area: { ringPx: circle(100, 100, 10, 24) }, trunk: stem(100, 100) };
    // Touches a: shrinks to clear it.
    const b = { area: { ringPx: circle(120, 100, 9, 24) }, trunk: stem(120, 100) };
    // Inside a woods: kept as traced.
    const c = { area: { ringPx: circle(400, 400, 10, 24) }, trunk: stem(400, 400) };
    // A 3 m2 scrap just off a's edge.
    const d = { area: { ringPx: circle(100, 113, 2, 12) } };
    const pending = [a, b, c, d];
    const plans = pending.map(() => ({ stand: false }));
    const h = (x, y) => {
      if (Math.hypot(x - 400, y - 400) < 60) return 15;
      if (Math.hypot(x - 100, y - 100) <= 10 || Math.hypot(x - 120, y - 100) <= 9) return 8;
      return 0;
    };
    const out = planSceneFacets(pending, plans, frame, h);
    assert.ok(out.plans[0] && out.plans[1]);
    assert.equal(out.plans[2], null);
    const gap = Math.hypot(out.plans[0].c[0] - out.plans[1].c[0], 0) * 0.5;
    assert.ok(out.plans[0].rM + out.plans[1].rM <= gap);
    assert.deepEqual(out.drop, [false, false, false, true]);
  });
});

describe("crown style column fragments", () => {
  const { columnCrown } = require("../netlify/lib/vegetation");
  const { materialForVegetation } = require("../netlify/lib/materials");
  const frame = { west: 0, east: 800, south: 0, north: 800, imgW: 800, imgH: 800, mpuX: 0.25, mpuY: 0.25 };
  const sq = (x, y, h) => [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]];
  it("turns a lone pillar into a small crown on a stem and floats one at a canopy edge", () => {
    const pillar = () => ({ ringPx: sq(400, 400, 5), material: materialForVegetation(20, "heavy") });
    const open = () => 0;
    const lone = columnCrown(pillar(), 0, frame, open);
    assert.ok(lone && lone.trunk && lone.ringPx.length >= 8);
    assert.ok(lone.crownMat.bottom_height >= 15 && lone.crownMat.top_height === 20);
    assert.equal(lone.trunk.material.top_height, lone.crownMat.bottom_height);
    const woods = () => 18;
    const edge = columnCrown(pillar(), 0, frame, woods);
    assert.ok(edge && !edge.trunk && edge.ringPx === null);
    assert.ok(edge.crownMat.bottom_height >= 15);
  });
  it("leaves real crowns and short clumps alone", () => {
    const open = () => 0;
    assert.equal(columnCrown({ ringPx: sq(400, 400, 20), material: materialForVegetation(20, "heavy") }, 0, frame, open), null);
    assert.equal(columnCrown({ ringPx: sq(400, 400, 5), material: materialForVegetation(5, "heavy") }, 0, frame, open), null);
  });
});
