"use strict";
// Terrain demo fixes (2026-11-10): lidar canopy on steep slopes, canopy on
// steep bare ground, and one level surface per water body.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { gridFromPoints, mercator, groundAt } = require("../netlify/lib/usgs-lidar");
const { lidarCells, canopyGroundAt } = require("../netlify/lib/lidar-canopy");
const { steepTerrainZone, planeSlope, steepCanopyNote } = require("../netlify/lib/steep-canopy");
const { levelWaterItems } = require("../netlify/lib/outdoor-clutter");

const frame = { west: -111.03, south: 35.02, east: -111.028, north: 35.0215 };

/** A bare slope (rise per metre `grade` toward +x) with low shrubs on it. */
function slopeCloud(grade, shrubM, tree) {
  const pts = [];
  const a = mercator(frame.west, frame.south);
  const b = mercator(frame.east, frame.north);
  const k = Math.cos((35.02 * Math.PI) / 180);
  for (let x = a[0]; x < b[0]; x += 1.1) {
    for (let y = a[1]; y < b[1]; y += 1.1) {
      const g = 1600 + grade * (x - a[0]) * k;
      pts.push({ x, y, z: g, cls: 2, ret: 1, nret: 1 });
      // Rock and shrubs: one first return just above the ground, split.
      pts.push({ x: x + 0.5, y: y + 0.5, z: g + grade * 0.5 * k + shrubM, cls: 1, ret: 1, nret: 2 });
      pts.push({ x: x + 0.5, y: y + 0.5, z: g + grade * 0.5 * k, cls: 1, ret: 2, nret: 2 });
      if (tree && x < a[0] + 30 && y < a[1] + 30) {
        const top = 12 + 3 * Math.sin((x - a[0]) / 3) * Math.cos((y - a[1]) / 3);
        pts.push({ x: x + 0.3, y: y + 0.3, z: g + top, cls: 1, ret: 1, nret: 3 });
        pts.push({ x: x + 0.3, y: y + 0.3, z: g + 8, cls: 1, ret: 2, nret: 3 });
      }
    }
  }
  return gridFromPoints(pts, frame, { spacingM: 4 });
}

function canopyCells(grid) {
  let n = 0;
  for (const c of lidarCells(grid, {}).cells.values()) if (c.h >= 3) n++;
  return n;
}

describe("lidar canopy on steep slopes", () => {
  it("does not read a bare crater wall with low shrubs as canopy", () => {
    const steep = slopeCloud(1.2, 0.5, false);
    // The old ground (cell minimum, or a few cells downhill) turned the wall into crowns.
    let old = 0;
    for (const rec of steep.cells.values()) {
      const g = groundAt(steep, rec.ix, rec.iy);
      if (g != null && rec.tMax != null && rec.tMax - g >= 3) old++;
    }
    assert.ok(old > 50, "old ground read the slope as canopy (" + old + ")");
    assert.equal(canopyCells(steep), 0);
  });

  it("keeps a real crown on the same steep slope", () => {
    const steep = slopeCloud(1.2, 0.5, true);
    assert.ok(canopyCells(steep) >= 20);
  });

  it("leaves flat ground on the cell minimum", () => {
    const flat = slopeCloud(0.05, 0.5, true);
    for (const rec of flat.cells.values()) {
      if (rec.g == null) continue;
      assert.equal(canopyGroundAt(flat, rec.ix, rec.iy), groundAt(flat, rec.ix, rec.iy));
    }
    assert.ok(canopyCells(flat) >= 20);
  });
});

describe("steep terrain zone", () => {
  const box = { west: -112.18, south: 40.5, east: -112.16, north: 40.514 };
  function samples(zAt) {
    const out = [];
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) {
        const lon = box.west + ((c + 0.5) / 24) * (box.east - box.west);
        const lat = box.south + ((r + 0.5) / 24) * (box.north - box.south);
        out.push({ lon, lat, z: zAt(lon, lat) });
      }
    }
    return out;
  }
  const mx = 111320 * Math.cos((40.507 * Math.PI) / 180);

  it("fits a plane slope", () => {
    const pts = [];
    for (let x = 0; x < 50; x += 10) for (let y = 0; y < 50; y += 10) pts.push([x, y, 0.3 * x + 0.4 * y]);
    assert.ok(Math.abs(planeSlope(pts) - 0.5) < 1e-9);
  });

  it("is null on flat or gentle ground", () => {
    assert.equal(steepTerrainZone(samples(() => 1500), box), null);
    assert.equal(steepTerrainZone(samples((lon) => 1500 + 0.2 * (lon - box.west) * mx), box), null);
  });

  it("marks only the steep half of a draw", () => {
    const mid = (box.west + box.east) / 2;
    const zone = steepTerrainZone(
      samples((lon) => 1500 + (lon > mid ? 0.8 * (lon - mid) * mx : 0)),
      box
    );
    assert.ok(zone);
    assert.equal(zone(box.east - 0.002, (box.south + box.north) / 2), true);
    assert.equal(zone(box.west + 0.002, (box.south + box.north) / 2), false);
    assert.equal(zone(box.east + 1, box.north), false);
  });

  it("names what it left out", () => {
    assert.equal(steepCanopyNote(0), "");
    assert.match(steepCanopyNote(3), /Left out 3 canopy pieces on steep ground/);
  });
});

describe("water bodies are level", () => {
  const sq = (x0, y0, s) => [
    [x0, y0],
    [x0 + s, y0],
    [x0 + s, y0 + s],
    [x0, y0 + s],
    [x0, y0],
  ];
  const mat = (b) => (b ? { name: "Water 0.1 @ " + b.toFixed(1), bottom_height: b, top_height: b + 0.1 } : { name: "Water", top_height: 0.1 });

  it("puts overlapping and touching lake pieces at the lowest seat", () => {
    const items = [
      { kind: "water", ringPx: sq(0, 0, 100), material: mat(0) },
      { kind: "water", ringPx: sq(90, 0, 40), material: mat(6) },
      { kind: "water", ringPx: sq(130, 0, 20), material: mat(18) },
      { kind: "water", ringPx: sq(500, 500, 20), material: mat(24) },
      { kind: "parking", ringPx: sq(0, 0, 50), material: { name: "Parking", bottom_height: 6 } },
    ];
    const moved = levelWaterItems(items);
    assert.equal(moved, 2);
    assert.equal(items[1].material.bottom_height, undefined);
    assert.equal(items[2].material.name, "Water");
    // A separate pond keeps its own seat; parking is untouched.
    assert.equal(items[3].material.bottom_height, 24);
    assert.equal(items[4].material.bottom_height, 6);
  });

  it("leaves a river that runs downhill on its own seats", () => {
    const items = [
      { kind: "water", ringPx: sq(0, 0, 100), material: mat(2), flowing: true },
      { kind: "water", ringPx: sq(90, 0, 40), material: mat(9), flowing: true },
    ];
    assert.equal(levelWaterItems(items), 0);
    assert.equal(items[1].material.bottom_height, 9);
  });
});
