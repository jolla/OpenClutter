"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const exportMode = require("../netlify/lib/export-mode");
const { crownsFromChm } = require("../netlify/lib/canopy-height");

function diagonalStand() {
  const w = 60;
  const h = 60;
  const values = new Float32Array(w * h);
  // A stand whose edge runs at 45 degrees across the 2 m grid.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x + y > 30 && x + y < 80 && x > 4 && y > 4 && x < 55 && y < 55) values[y * w + x] = 14;
  return { west: 24.8, east: 24.8 + (w * 2) / 55400, north: 60.2, south: 60.2 - (h * 2) / 111320, width: w, height: h, values, nonzero: 0 };
}

function axisShare(ringLonLat, grid) {
  let all = 0;
  let axis = 0;
  for (let i = 0; i + 1 < ringLonLat.length; i++) {
    const dx = ((ringLonLat[i + 1][0] - ringLonLat[i][0]) / (grid.east - grid.west)) * grid.width;
    const dy = ((ringLonLat[i + 1][1] - ringLonLat[i][1]) / (grid.north - grid.south)) * grid.height;
    const len = Math.hypot(dx, dy);
    all += len;
    if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) axis += len;
  }
  return axis / all;
}

describe("smoothEdges (tree edges follow the crowns, not grid stair steps)", () => {
  afterEach(() => exportMode.setSmoothEdges(false));

  it("is on for /dev hosts only and can be turned off there", () => {
    assert.equal(exportMode.smoothEdgesWanted(false, {}), false);
    assert.equal(exportMode.smoothEdgesWanted(true, {}), true);
    assert.equal(exportMode.smoothEdgesWanted(true, { smoothEdges: false }), false);
  });

  it("traces a diagonal stand edge as diagonals, with the same area", () => {
    const grid = diagonalStand();
    exportMode.setSmoothEdges(false);
    const stairs = crownsFromChm(grid);
    exportMode.setSmoothEdges(true);
    const smooth = crownsFromChm(grid);
    assert.equal(stairs.length, smooth.length);
    const a = stairs.sort((p, q) => q.areaM2 - p.areaM2)[0];
    const b = smooth.sort((p, q) => q.areaM2 - p.areaM2)[0];
    assert.ok(axisShare(a.ringLonLat, grid) > 0.5, "off keeps the grid steps " + axisShare(a.ringLonLat, grid));
    assert.ok(axisShare(b.ringLonLat, grid) < 0.2, "on runs along the edge " + axisShare(b.ringLonLat, grid));
    assert.ok(b.ringLonLat.length <= 40, "a short outline " + b.ringLonLat.length);
    assert.equal(b.areaM2, a.areaM2, "the same canopy cells");
  });
});
