"use strict";

// Feedback #23: part of the Encore complex (Las Vegas Strip) had no roof.
// A split roof piece was dropped as a "wedge" although its sides are
// square, a triangle piece lost its clipboard zone, and a piece whose
// simplified outline crossed itself failed the OpenIntent check.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const exportMode = require("../netlify/lib/export-mode");
const { pxToLl } = require("../netlify/lib/geo-frame");
const { footprintsToClutter, squareSideShare, despikeDegRing, ringAreaM2 } = require("../netlify/lib/pipeline");
const { clipZone } = require("../netlify/lib/hamina-clipboard");

const FIX = path.join(__dirname, "fixtures/encore-23");

function pointInRingLL(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The export frame of the reported draw (W -115.17025, S 36.11931,
// E -115.15485, N 36.13056) on the dev host.
function encoreFrame() {
  return JSON.parse(fs.readFileSync(path.join(FIX, "frame.json"), "utf8"));
}

function roofsAt(built, frame, pt) {
  let hit = 0;
  for (let i = 0; i < built.overlayRings.length; i++) {
    const ring = built.overlayRings[i].map((p) => pxToLl(p[0], p[1], frame));
    if (pointInRingLL(pt, ring)) hit++;
  }
  return hit;
}

describe("feedback #23 roof repair", () => {
  afterEach(() => exportMode.setRoofRepair(false));

  it("is on for /dev hosts only and roofRepair:false turns it off", () => {
    assert.equal(exportMode.roofRepairWanted(false, {}), false);
    assert.equal(exportMode.roofRepairWanted(true, {}), true);
    assert.equal(exportMode.roofRepairWanted(true, { roofRepair: false }), false);
    assert.equal(exportMode.roofRepairWanted(true, { roofRepair: "0" }), false);
    assert.equal(exportMode.isRoofRepair(), false);
  });

  it("clutter.js sets it from the test host", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /exportMode\.setRoofRepair\(exportMode\.roofRepairWanted\(testHost, body\)\);/);
  });

  it("keeps the square-sided garage half of the Encore outline", () => {
    const fc = JSON.parse(fs.readFileSync(path.join(FIX, "encore-overture.geojson"), "utf8"));
    const garage = [-115.1631, 36.1287];
    const wing = [-115.1640, 36.1272];
    const frame = encoreFrame();
    exportMode.setRoofRepair(false);
    const before = footprintsToClutter(JSON.parse(JSON.stringify(fc.features)), frame);
    exportMode.setRoofRepair(true);
    const after = footprintsToClutter(JSON.parse(JSON.stringify(fc.features)), frame);
    assert.equal(roofsAt(before, frame, garage), 0);
    assert.equal(roofsAt(before, frame, wing), 0);
    assert.ok(roofsAt(after, frame, garage) >= 1, "garage roof missing");
    assert.ok(roofsAt(after, frame, wing) >= 1, "south wing roof missing");
    assert.ok(after.stats.buildings > before.stats.buildings);
  });

  it("still finds a slanted slab less square than an L", () => {
    const mpd = { lon: 89960, lat: 110950 };
    const slab = [
      [-115.168634, 36.126992],
      [-115.168124, 36.126321],
      [-115.168124, 36.126772],
      [-115.16759, 36.126772],
      [-115.167513, 36.127556],
      [-115.168634, 36.126992],
    ];
    const ell = [
      [0, 0],
      [0.002, 0],
      [0.002, 0.001],
      [0.0008, 0.001],
      [0.0008, 0.003],
      [0, 0.003],
      [0, 0],
    ].map((p) => [-115.165 + p[0], 36.126 + p[1]]);
    assert.ok(squareSideShare(slab, mpd) < 0.75);
    assert.ok(squareSideShare(ell, mpd) > 0.99);
  });

  it("closes an open triangle zone only for roof repair", () => {
    const tri = [
      [-10, -10],
      [-30, -10],
      [-20, -25],
    ];
    assert.equal(clipZone("bldg-one", tri), null);
    const z = clipZone("bldg-one", tri, { openTriangle: true });
    assert.ok(z);
    assert.equal(z.area.coordinates[0].length, 4);
  });

  it("takes zero-width spikes off a terrain-split garage piece without changing its area", () => {
    const { spikeRing } = JSON.parse(fs.readFileSync(path.join(FIX, "garage-spike-piece.json"), "utf8"));
    const mpd = encoreFrame().mpd;
    const clean = despikeDegRing(spikeRing, mpd);
    assert.ok(clean.length < spikeRing.length);
    const a0 = ringAreaM2(spikeRing, mpd);
    const a1 = ringAreaM2(clean, mpd);
    assert.ok(Math.abs(a1 - a0) < 1, "area " + a0 + " -> " + a1);
  });
});
