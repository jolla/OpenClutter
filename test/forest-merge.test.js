"use strict";

// Feedback #9 prototype: neighbouring stand blocks of about one height merge
// (mergeTiles), dev-gated and off by default.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const exportMode = require("../netlify/lib/export-mode");
const standSplit = require("../netlify/lib/stand-split");

function blockPixels(x0, y0, n) {
  const out = [];
  for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) out.push([x, y]);
  return out;
}

describe("feedback #9 mergeTiles prototype", () => {
  it("is off by default and never on a production host", () => {
    assert.equal(exportMode.isMergeTiles(), false);
    assert.equal(exportMode.protoWanted(false, { mergeTiles: true }, "mergeTiles", "OC_MERGE_TILES"), false);
    assert.equal(exportMode.protoWanted(true, { mergeTiles: true }, "mergeTiles", "OC_MERGE_TILES"), true);
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /exportMode\.setMergeTiles\(forest === "merge"\);/);
  });

  it("merges neighbouring blocks within 2.5 m and keeps a taller block apart", () => {
    const w = 60;
    // Three blocks in a row: 8 m, 9.5 m, 15 m.
    const groups = [blockPixels(0, 0, 20), blockPixels(20, 0, 20), blockPixels(40, 0, 20)];
    const at = (x) => (x < 20 ? 8 : x < 40 ? 9.5 : 15);
    const merged = standSplit.mergePixelGroups(groups, at, w, 2);
    assert.equal(merged.length, 2);
    const sizes = merged.map((g) => g.length).sort((a, b) => a - b);
    assert.deepEqual(sizes, [400, 800]);
  });

  it("does not chain a slow height ramp into one slab", () => {
    const w = 100;
    const groups = [0, 1, 2, 3, 4].map((k) => blockPixels(k * 20, 0, 20));
    // 6, 8, 10, 12, 14 m: each step is 2 m, but the group is held to its first block.
    const at = (x) => 6 + 2 * Math.floor(x / 20);
    const merged = standSplit.mergePixelGroups(groups, at, w, 2);
    assert.ok(merged.length >= 2);
  });

  it("unions merged polygon tiles into one ring with no seam", () => {
    const frame = { mpuX: 1, mpuY: 1 };
    const sq = (x, y) => [[x, y], [x + 50, y], [x + 50, y + 50], [x, y + 50], [x, y]];
    const tiles = [
      { ringPx: sq(0, 0), gx: 0, gy: 0, h: 9 },
      { ringPx: sq(50, 0), gx: 1, gy: 0, h: 10 },
      { ringPx: sq(100, 0), gx: 2, gy: 0, h: 18 },
    ];
    const out = standSplit.mergeTilePieces(tiles, frame);
    assert.equal(out.length, 2);
    const big = out.find((o) => o.members === 2);
    assert.ok(big);
    assert.equal(big.ringPx.length, 5, "a 100 x 50 rectangle has four corners");
    assert.ok(Math.abs(big.bandH - 9.5) < 1e-9);
  });

  it("cuts a piece that wraps around a hole so the outline does not fill it", () => {
    const w = 60;
    const pixels = [];
    // A 60 x 60 ring of street trees, 6 cells wide, around a 48 x 48 block.
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) if (x < 6 || x >= 54 || y < 6 || y >= 54) pixels.push([x, y]);
    const out = standSplit.holeFreeGroups([pixels], w, 2, 2);
    assert.ok(out.length >= 2);
    let total = 0;
    for (const g of out) total += g.length;
    assert.equal(total, pixels.length);
  });
});
