"use strict";

// A stand over 6000 m2 is cut into ~50 m tiles. Those tiles used to keep
// the parent stand's ground, so a piece that landed on a lower plate
// floated (arizona-desert: Foliage - Light 2.2 @ 52.8 on a 48 m plate).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, llToPx } = require("../netlify/lib/geo-frame");
const { assembleFoliage, reseatAssembledFoliage } = require("../netlify/lib/vegetation");
const { materialForVegetation } = require("../netlify/lib/materials");

function rectPx(frame, west, south, east, north) {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ].map((p) => llToPx(p[0], p[1], frame));
  return ring;
}

describe("foliage tiles sit on the ground under each piece", () => {
  it("a downhill tile does not keep the parent stand's uphill seat", () => {
    const west = -111.17;
    const south = 32.25;
    const east = west + 250 / (111320 * Math.cos((south * Math.PI) / 180));
    const north = south + 250 / 110540;
    const frame = geoFrame({ west, south, east, north, name: "Desert step" });
    const midLon = (west + east) / 2;
    // Sampler for a wide parent ring misses the low plate (only the high
    // side is seen). A tile that lives on the low plate must still sit at 48.
    function extent(ring) {
      if (!ring || !ring.length) return { min: 0, max: 0 };
      let lo = Infinity;
      let hi = -Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < ring.length; i++) {
        const lon = +ring[i][0];
        if (lon < minX) minX = lon;
        if (lon > maxX) maxX = lon;
        const z = lon < midLon ? 48 : 56;
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      }
      if (maxX - minX > (east - west) * 0.4) return { min: 56, max: 56 };
      return { min: lo, max: hi };
    }
    const slopeTop = (ring) => extent(ring).max;
    slopeTop.seat = (ring) => extent(ring).min;

    const material = materialForVegetation(4, "light");
    assert.ok(material);
    const stand = {
      ringPx: rectPx(frame, west + (east - west) * 0.05, south + (north - south) * 0.05, east - (east - west) * 0.05, north - (north - south) * 0.05),
      material,
      kind: "canopy",
      shape: "polygon",
    };
    const pack = assembleFoliage([stand], frame, null, null, { slopeTop }, {});
    const areas = pack.oiAreas || [];
    assert.ok(areas.length >= 2, "expected tiles, got " + areas.length);
    const bottoms = areas.map((a) => Number(a.material && a.material.bottom_height) || 0);
    const lows = bottoms.filter((z) => z > 0 && z < 52);
    const highs = bottoms.filter((z) => z >= 54);
    assert.ok(lows.length >= 1, "downhill tiles should sit near 48 m, bottoms " + bottoms.join(","));
    assert.equal(lows.every((z) => Math.abs(z - 48) <= 0.15), true, "lows " + lows.join(","));
    assert.ok(
      highs.length === 0 || highs.every((z) => Math.abs(z - 56) <= 0.15),
      "uphill tiles if lifted should sit near 56 m, bottoms " + bottoms.join(",")
    );
    assert.equal(
      bottoms.some((z) => z >= 52 && z < 54),
      false,
      "no tile should keep a mid / parent datum, bottoms " + bottoms.join(",")
    );
  });

  it("snaps an unstemmed crown to the plate under its shipped ring", () => {
    const west = -111.17;
    const south = 32.25;
    const east = west + 80 / (111320 * Math.cos((south * Math.PI) / 180));
    const north = south + 80 / 110540;
    const frame = geoFrame({ west, south, east, north, name: "One plate" });
    const slopeTop = () => 48;
    slopeTop.seat = () => 48;
    const { liftFoliagePair, materialForVegetation } = require("../netlify/lib/materials");
    const base = materialForVegetation(2.2, "light");
    const lifted = liftFoliagePair(base, 52.8);
    assert.ok(lifted && lifted.material);
    assert.equal(lifted.material.bottom_height, 52.8);
    const ringPx = rectPx(frame, west + 0.0001, south + 0.0001, east - 0.0001, north - 0.0001);
    const areas = [{ ringPx, material: lifted.material, kind: "canopy", shape: "polygon" }];
    const n = reseatAssembledFoliage(areas, slopeTop, frame);
    assert.equal(n, 1);
    assert.equal(areas[0].material.bottom_height, 48);
    assert.match(areas[0].material.name, /@ 48\.0$/);
    assert.equal(areas[0].material.top_height, 50.2);
  });

  it("moves a stem and crown by the same delta so treetop height is unchanged", () => {
    const west = -111.17;
    const south = 32.25;
    const east = west + 80 / (111320 * Math.cos((south * Math.PI) / 180));
    const north = south + 80 / 110540;
    const frame = geoFrame({ west, south, east, north, name: "Stacked tree" });
    const slopeTop = () => 48;
    slopeTop.seat = () => 48;
    const { liftFoliagePair, materialForVegetation, trunkOiMaterial } = require("../netlify/lib/materials");
    const trunkMat = trunkOiMaterial(6.8, 52.8);
    const crownMat = liftFoliagePair(materialForVegetation(8.0, "light"), 59.6);
    assert.ok(trunkMat && crownMat && crownMat.material);
    const ringPx = rectPx(frame, west + 0.0001, south + 0.0001, east - 0.0001, north - 0.0001);
    // Narrow stem under the same crown.
    const stemPx = rectPx(frame, west + 0.00025, south + 0.00025, east - 0.00025, north - 0.00025);
    const areas = [
      { ringPx: stemPx, material: trunkMat, kind: "trunk", shape: "polygon" },
      { ringPx, material: crownMat.material, kind: "canopy", shape: "polygon" },
    ];
    const hTopBefore = areas[1].material.top_height - areas[0].material.bottom_height;
    const n = reseatAssembledFoliage(areas, slopeTop, frame);
    assert.ok(n >= 2, "expected the whole stack to move, moved " + n);
    assert.equal(areas[0].material.bottom_height, 48);
    assert.equal(areas[1].material.bottom_height, 54.8);
    assert.equal(areas[1].material.top_height - areas[0].material.bottom_height, hTopBefore);
  });

  it("does not treat a nearby stand as the same stack when snapping a floating mass", () => {
    const west = -111.17;
    const south = 32.25;
    const east = west + 80 / (111320 * Math.cos((south * Math.PI) / 180));
    const north = south + 80 / 110540;
    const frame = geoFrame({ west, south, east, north, name: "Neighbor" });
    const slopeTop = () => 48;
    slopeTop.seat = () => 48;
    const { liftFoliagePair, materialForVegetation } = require("../netlify/lib/materials");
    const midLon = (west + east) / 2;
    const midLat = (south + north) / 2;
    const dLon = (east - west) * 0.18;
    const floatRing = rectPx(frame, west + 0.00005, south + 0.00005, midLon - dLon, midLat - 0.00005);
    const nearRing = rectPx(frame, midLon + dLon, midLat + 0.00005, east - 0.00005, north - 0.00005);
    const areas = [
      { ringPx: nearRing, material: liftFoliagePair(materialForVegetation(2.2, "light"), 50.6).material, kind: "canopy", shape: "polygon" },
      { ringPx: floatRing, material: liftFoliagePair(materialForVegetation(2.2, "light"), 52.8).material, kind: "canopy", shape: "polygon" },
    ];
    const n = reseatAssembledFoliage(areas, slopeTop, frame);
    assert.ok(n >= 1, "floating mass should snap, moved " + n);
    assert.equal(areas[1].material.bottom_height, 48);
    // The neighbour may also snap if it is 3 m above the plate.
    assert.ok(areas[0].material.bottom_height === 48 || areas[0].material.bottom_height === 50.6);
  });

  it("lowers a contained cap with its stand, not off the stand", () => {
    const west = -111.17;
    const south = 32.25;
    const east = west + 80 / (111320 * Math.cos((south * Math.PI) / 180));
    const north = south + 80 / 110540;
    const frame = geoFrame({ west, south, east, north, name: "Contained cap" });
    const slopeTop = () => 48;
    slopeTop.seat = () => 48;
    const { liftFoliagePair, materialForVegetation } = require("../netlify/lib/materials");
    const standRing = rectPx(frame, west + 0.00005, south + 0.00005, east - 0.00005, north - 0.00005);
    const capRing = rectPx(frame, west + 0.0002, south + 0.0002, west + (east - west) * 0.35, south + (north - south) * 0.35);
    const areas = [
      { ringPx: standRing, material: liftFoliagePair(materialForVegetation(2.2, "light"), 50.6).material, kind: "canopy", shape: "polygon" },
      { ringPx: capRing, material: liftFoliagePair(materialForVegetation(2.2, "light"), 52.8).material, kind: "canopy", shape: "polygon" },
    ];
    const hTopBefore = areas[1].material.top_height - areas[0].material.bottom_height;
    const n = reseatAssembledFoliage(areas, slopeTop, frame);
    assert.ok(n >= 2, "expected the stand and cap to move together, moved " + n);
    assert.equal(areas[0].material.bottom_height, 48);
    assert.equal(areas[1].material.bottom_height, 50.2);
    assert.equal(areas[1].material.top_height - areas[0].material.bottom_height, hTopBefore);
  });

  it("does not drop a raised crown off a trunk that already sits on the plate", () => {
    const west = -111.17;
    const south = 32.25;
    const east = west + 80 / (111320 * Math.cos((south * Math.PI) / 180));
    const north = south + 80 / 110540;
    const frame = geoFrame({ west, south, east, north, name: "Seated tree" });
    const slopeTop = () => 48;
    slopeTop.seat = () => 48;
    const { liftFoliagePair, materialForVegetation, trunkOiMaterial } = require("../netlify/lib/materials");
    const trunkMat = trunkOiMaterial(6.8, 48);
    const crownMat = liftFoliagePair(materialForVegetation(8.0, "light"), 54.8);
    const ringPx = rectPx(frame, west + 0.0001, south + 0.0001, east - 0.0001, north - 0.0001);
    const stemPx = rectPx(frame, west + 0.00025, south + 0.00025, east - 0.00025, north - 0.00025);
    const areas = [
      { ringPx: stemPx, material: trunkMat, kind: "trunk", shape: "polygon" },
      { ringPx, material: crownMat.material, kind: "canopy", shape: "polygon" },
    ];
    const n = reseatAssembledFoliage(areas, slopeTop, frame);
    assert.equal(n, 0);
    assert.equal(areas[0].material.bottom_height, 48);
    assert.equal(areas[1].material.bottom_height, 54.8);
    assert.equal(areas[1].material.top_height, 62.8);
  });
});
