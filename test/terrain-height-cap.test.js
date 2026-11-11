"use strict";
// Feedback #19: Hamina rejects a Copy terrain paste with a floor above 1000 m
// ("Too big: expected number to be <=1000 [raisedFloorZones.15.height]").
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const {
  terrainFromSamples,
  terrainBundleFields,
  demUnderFootprint,
  capPasteHeights,
  planarSlopedRamp,
  HAMINA_FLOOR_MAX_M,
} = require("../netlify/lib/terrain");

function gridSamples(frame, n, zAt) {
  const samples = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const lon = frame.west + ((c + 0.5) / n) * (frame.east - frame.west);
      const lat = frame.south + ((r + 0.5) / n) * (frame.north - frame.south);
      samples.push({ lon, lat, z: zAt(r / (n - 1), c / (n - 1)) });
    }
  }
  return samples;
}

function maxHeight(clip) {
  let max = 0;
  for (const z of clip.raisedFloorZones || []) max = Math.max(max, z.height);
  for (const z of clip.slopedFloors || []) for (const p of z.area.coordinates[0]) max = Math.max(max, p[2]);
  return max;
}

const frame = geoFrame({ west: -112.16, south: 40.5, east: -112.13, north: 40.52, name: "Pit" });
// 1,500 m of relief: a pit floor at 1,265 m in the south-east, a ridge at 2,765 m.
const pit = (r, c) => 1265 + 1500 * Math.max(r, 1 - c) ** 1.3;

describe("Copy terrain height cap (feedback #19)", () => {
  it("is Hamina's 1000 m floor limit", () => {
    assert.equal(HAMINA_FLOOR_MAX_M, 1000);
  });

  for (const style of ["sloped", "raised"]) {
    it(style + ": no floor above 1000 m on a 1,500 m relief draw", () => {
      const terrain = terrainFromSamples(gridSamples(frame, 24, pit), frame, { terrainStyle: style });
      assert.ok(terrain && terrain.clipboard);
      assert.ok(terrain.reliefM > 1400, "relief " + terrain.reliefM);
      assert.ok(maxHeight(terrain.clipboard) <= 1000, "max " + maxHeight(terrain.clipboard));
      assert.equal(terrain.heightCapM, 1000);
      assert.equal(terrain.raised, terrain.clipboard.raisedFloorZones.length);
      assert.equal(terrain.sloped, (terrain.clipboard.slopedFloors || []).length);
      for (const z of terrain.clipboard.slopedFloors || []) assert.equal(planarSlopedRamp(z.area.coordinates[0]), true);
      const fields = terrainBundleFields(terrain, []);
      assert.match(fields.terrainStatus, /pasted flat at 1000 m/);
      // Objects on the high ground seat on the 1000 m plateau, not above it.
      const seat = demUnderFootprint(terrain);
      const lon = frame.west + 0.0005;
      const lat = frame.north - 0.0005;
      const ring = [[lon, lat], [lon + 0.0002, lat], [lon + 0.0002, lat - 0.0002], [lon, lat - 0.0002], [lon, lat]];
      assert.ok(seat.seat(ring) <= 1000, "seat " + seat.seat(ring));
    });
  }

  it("leaves a draw under 1000 m of relief unchanged", () => {
    const low = (r, c) => 1265 + 600 * Math.max(r, 1 - c);
    const terrain = terrainFromSamples(gridSamples(frame, 24, low), frame);
    assert.equal(terrain.heightCapM, undefined);
    assert.doesNotMatch(terrainBundleFields(terrain, []).terrainStatus, /pasted flat/);
    const before = JSON.stringify(terrain.clipboard);
    assert.equal(capPasteHeights(terrain.clipboard, "sloped", 1000), 0);
    assert.equal(JSON.stringify(terrain.clipboard), before);
  });

  it("ends a crossing ramp at the cap and turns a ramp above it into a pad", () => {
    const ramp = (lo, hi) => ({
      area: { type: "Polygon", coordinates: [[[0, 0, lo], [10, 0, lo], [10, 10, hi], [0, 10, hi]]] },
      attenuationDbPerMeter: 20,
      slabOnly: false,
    });
    const clip = {
      raisedFloorZones: [{ area: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5]]] }, height: 1200 }],
      slopedFloors: [ramp(900, 1100), ramp(1050, 1200), ramp(100, 200)],
    };
    assert.equal(capPasteHeights(clip, "sloped", 1000), 3);
    assert.equal(clip.slopedFloors.length, 2);
    assert.deepEqual(clip.slopedFloors[0].area.coordinates[0].map((p) => p[2]), [900, 900, 1000, 1000]);
    assert.deepEqual(clip.slopedFloors[1].area.coordinates[0].map((p) => p[2]), [100, 100, 200, 200]);
    assert.deepEqual(clip.raisedFloorZones.map((z) => z.height), [1000, 1000]);
  });

  it("raised layers keep one plate at the cap instead of stacking copies", () => {
    const plate = (h) => ({ area: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5]]] }, height: h });
    const clip = { raisedFloorZones: [plate(0), plate(900), plate(1100), plate(1300)], slopedFloors: [] };
    assert.equal(capPasteHeights(clip, "raised", 1000), 2);
    assert.deepEqual(clip.raisedFloorZones.map((z) => z.height), [0, 900, 1000]);
  });
});
