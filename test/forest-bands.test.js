"use strict";

// Feedback #9 prototype: wide stands cut along canopy height bands
// (canopyBands), dev-gated and off by default.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const exportMode = require("../netlify/lib/export-mode");
const standSplit = require("../netlify/lib/stand-split");

describe("feedback #9 canopyBands prototype", () => {
  it("is off by default and never on a production host", () => {
    assert.equal(exportMode.isCanopyBands(), false);
    assert.equal(exportMode.isScrubGaps(), false);
    assert.equal(exportMode.protoWanted(false, { canopyBands: true }, "canopyBands", "OC_CANOPY_BANDS"), false);
    assert.equal(exportMode.protoWanted(true, {}, "canopyBands", "OC_CANOPY_BANDS_UNSET_FOR_TEST"), false);
    assert.equal(exportMode.protoWanted(true, { canopyBands: true }, "canopyBands", "OC_CANOPY_BANDS"), true);
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /exportMode\.setCanopyBands\(exportMode\.protoWanted\(testHost, body, "canopyBands", "OC_CANOPY_BANDS"\)\);/);
  });

  it("cuts a two-height stand along the height step, not on a grid", () => {
    const w = 120;
    const h = 60;
    const pixels = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push([x, y]);
    // West 40 columns 6 m, the rest 13 m.
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : x < 40 ? 6 : 13);
    const groups = standSplit.bandPixelGroups(pixels, at, w, 2, 2, w * h * 4);
    assert.ok(groups);
    assert.equal(groups.length, 2);
    const sizes = groups.map((g) => g.length).sort((a, b) => a - b);
    assert.deepEqual(sizes, [40 * h, 80 * h]);
    for (const g of groups) {
      const tall = g.filter((p) => p[0] >= 40).length;
      assert.ok(tall === 0 || tall === g.length, "a piece stays on one side of the step");
    }
  });

  it("keeps one even stand whole and folds small patches into their neighbour", () => {
    const w = 100;
    const h = 100;
    const pixels = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push([x, y]);
    // One 4 x 4 cell taller patch (64 m2) is under the minimum piece.
    const at = (x, y) => (x >= 50 && x < 54 && y >= 50 && y < 54 ? 14 : 7);
    assert.equal(standSplit.bandPixelGroups(pixels, at, w, 2, 2, w * h * 4), null);
  });

  it("cuts a polygon stand by its sampled bands with no overlap", () => {
    const frame = { west: 0, east: 0.01, south: 0, north: 0.01, imgW: 1000, imgH: 1000, mpuX: 1, mpuY: 1 };
    const ring = [[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]];
    // Pixel x < 100 is 5 m, the rest 14 m (lon grows with x).
    const sample = (lon) => (lon < 0.001 ? 5 : 14);
    const cut = standSplit.bandPieces(ring, frame, sample, {});
    assert.ok(cut && cut.pieces.length >= 2);
    let total = 0;
    for (const p of cut.pieces) {
      let a = 0;
      for (let i = 0, j = p.ringPx.length - 1; i < p.ringPx.length; j = i++) a += (p.ringPx[j][0] + p.ringPx[i][0]) * (p.ringPx[j][1] - p.ringPx[i][1]);
      total += Math.abs(a) / 2;
    }
    assert.ok(Math.abs(total - 20000) < 200, "pieces cover the stand once: " + total);
    const hs = cut.pieces.map((p) => p.bandH).sort((a, b) => a - b);
    assert.equal(hs[0], 5);
    assert.equal(hs[hs.length - 1], 14);
  });
});
