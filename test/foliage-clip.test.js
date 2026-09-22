"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, llToPx } = require("../netlify/lib/geo-frame");
const { treePairsFromPoints } = require("../netlify/lib/vegetation");
const { buildClutter, oiPixelCoords, footprintsToClutter } = require("../netlify/lib/pipeline");
const { intersectionAreaPx, pointInRing, BUILDING_BUFFER_M } = require("../netlify/lib/poly-clip");
const { isVegetationOiName } = require("../netlify/lib/materials");
const { surfaceMasksFromImage } = require("../netlify/lib/surface-mask");

function rect(x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

function overlapM2(foliage, buildings, frame) {
  let px = 0;
  for (const f of foliage) {
    for (const b of buildings) px += intersectionAreaPx(f, b);
  }
  return px * frame.mpuX * frame.mpuY;
}

function oiFoliageRings(oi) {
  const areas = oi.floorplans[0].attenuation_areas;
  const rings = [];
  for (const a of areas) {
    if (!isVegetationOiName(a.area_material.name)) continue;
    const px = oiPixelCoords(a.area.coordinates);
    rings.push(px.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]));
  }
  return rings;
}

describe("foliage rings stay off buildings and water", () => {
  const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Clip" });

  function canopyHits() {
    const cellLon = 30 / (111320 * Math.cos((42.9 * Math.PI) / 180));
    const cellLat = 30 / 110540;
    const lon0 = frame.west + (frame.east - frame.west) * 0.4;
    const lat0 = frame.south + (frame.north - frame.south) * 0.4;
    const hits = [];
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 4; ix++) hits.push({ lon: lon0 + ix * cellLon, lat: lat0 + iy * cellLat, pct: 80 });
    }
    return { hits, lon0, lat0, cellLon, cellLat };
  }

  it("subtracts a building that sits inside a canopy patch", () => {
    const { hits, lon0, lat0, cellLon, cellLat } = canopyHits();
    const bLon0 = lon0 + cellLon * 1.15;
    const bLat0 = lat0 + cellLat * 0.7;
    const bLon1 = bLon0 + cellLon * 0.7;
    const bLat1 = bLat0 + cellLat * 0.55;
    const ring = [
      [bLon0, bLat0],
      [bLon1, bLat0],
      [bLon1, bLat1],
      [bLon0, bLat1],
      [bLon0, bLat0],
    ];
    const fp = footprintsToClutter(
      [{ type: "Feature", properties: { height: 8 }, geometry: { type: "Polygon", coordinates: [ring] } }],
      frame
    );
    assert.equal(fp.overlayRings.length, 1);
    const pairs = treePairsFromPoints([], frame, fp.aabbs, null, {
      canopyHits: hits,
      buildingRings: fp.overlayRings,
      heightSample: () => 14.2,
    });
    const foliage = pairs.oiAreas.filter((a) => a.kind === "canopy").map((a) => a.ringPx);
    assert.ok(foliage.length >= 1, "canopy around the roof is kept");
    const m2 = overlapM2(foliage, fp.overlayRings, frame);
    assert.ok(m2 < 1, `foliage/building intersection ${m2.toFixed(2)} m²`);
    const [cx, cy] = llToPx((bLon0 + bLon1) / 2, (bLat0 + bLat1) / 2, frame);
    assert.equal(
      foliage.some((r) => pointInRing([cx, cy], r)),
      false,
      "building centroid is inside a foliage ring"
    );
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [{ type: "Feature", properties: { height: 8 }, geometry: { type: "Polygon", coordinates: [ring] } }],
      },
      treePoints: [],
      name: "Clip",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "nlcd-canopy",
      canopyHits: hits,
      heightSample: () => 14.2,
    });
    const emitted = oiFoliageRings(built.openintent);
    assert.ok(emitted.length >= 1);
    const emittedM2 = overlapM2(emitted, fp.overlayRings, frame);
    assert.ok(emittedM2 < 1, `emitted intersection ${emittedM2.toFixed(2)} m²`);
    assert.ok(built.stats.openIntentBuildingAreas >= 1);
    assert.equal(BUILDING_BUFFER_M, 4);
  });

  it("does not cover a water ring that cuts a canopy patch", () => {
    const { hits } = canopyHits();
    const bare = treePairsFromPoints([], frame, [], null, { canopyHits: hits, heightSample: () => 11 });
    const canopy = bare.oiAreas.find((a) => a.shape === "polygon");
    assert.ok(canopy, "unmasked patch is one polygon");
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of canopy.ringPx) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    const water = rect(minX + 8, minY + 8, minX + 28, minY + 26);
    const clipped = treePairsFromPoints([], frame, [], null, {
      canopyHits: hits,
      maskRings: [water],
      heightSample: () => 11,
    });
    const foliage = clipped.oiAreas.filter((a) => a.kind === "canopy").map((a) => a.ringPx);
    assert.ok(foliage.length >= 1);
    const m2 = overlapM2(foliage, [water], frame);
    assert.ok(m2 < 1, `foliage/water intersection ${m2.toFixed(2)} m²`);
    const cx = (water[0][0] + water[2][0]) / 2;
    const cy = (water[0][1] + water[2][1]) / 2;
    assert.equal(foliage.some((r) => pointInRing([cx, cy], r)), false);
  });

  it("notches a canopy that only overlaps the edge of a roof", () => {
    const { hits, lon0, lat0, cellLon, cellLat } = canopyHits();
    const bare = treePairsFromPoints([], frame, [], null, { canopyHits: hits });
    const canopy = bare.oiAreas.find((a) => a.kind === "canopy");
    const bLon0 = lon0 + cellLon * 3.2;
    const bLat0 = lat0 + cellLat * 0.2;
    const ring = [
      [bLon0, bLat0],
      [bLon0 + cellLon * 0.9, bLat0],
      [bLon0 + cellLon * 0.9, bLat0 + cellLat * 0.9],
      [bLon0, bLat0 + cellLat * 0.9],
      [bLon0, bLat0],
    ];
    const fp = footprintsToClutter(
      [{ type: "Feature", properties: { height: 6 }, geometry: { type: "Polygon", coordinates: [ring] } }],
      frame
    );
    const pairs = treePairsFromPoints([], frame, fp.aabbs, null, {
      canopyHits: hits,
      buildingRings: fp.overlayRings,
    });
    const foliage = pairs.oiAreas.map((a) => a.ringPx);
    const before = Math.abs(canopy.ringPx.reduce((s, p, i, arr) => {
      const q = arr[(i + 1) % arr.length];
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2);
    const after = foliage.reduce((s, r) => s + Math.abs(r.reduce((a, p, i, arr) => {
      const q = arr[(i + 1) % arr.length];
      return a + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2), 0);
    assert.ok(after > 100, "foliage outside the roof remains");
    assert.ok(after < before, "the roof bite removes area");
    assert.ok(overlapM2(foliage, fp.overlayRings, frame) < 1);
  });

  it("reads a blue pond and a dark pond out of the aerial and keeps canopy off them", () => {
    const w = 200;
    const h = 160;
    const data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 40;
      data[i + 1] = 95;
      data[i + 2] = 36;
      data[i + 3] = 255;
    }
    for (let y = 60; y < 100; y++) {
      for (let x = 40; x < 90; x++) {
        const i = (y * w + x) * 4;
        data[i] = 30;
        data[i + 1] = 70;
        data[i + 2] = 110;
      }
    }
    for (let y = 20; y < 55; y++) {
      for (let x = 120; x < 170; x++) {
        const i = (y * w + x) * 4;
        data[i] = 22;
        data[i + 1] = 32;
        data[i + 2] = 36;
      }
    }
    const img = { imgW: w, imgH: h, mpuX: 1, mpuY: 1 };
    const masks = surfaceMasksFromImage({ data, width: w, height: h }, img);
    assert.equal(masks.waterRings.length, 2);
    assert.ok(masks.waterM2 > 1500);
    const canopy = [
      [10, 10],
      [180, 10],
      [180, 140],
      [10, 140],
      [10, 10],
    ];
    const { createClipSet, clipFoliageRing } = require("../netlify/lib/poly-clip");
    const pieces = clipFoliageRing(canopy, createClipSet([], masks.waterRings, [], 4));
    assert.ok(pieces.length >= 1);
    assert.ok(overlapM2(pieces, masks.waterRings, img) < 1);
    assert.equal(
      pieces.some((r) => pointInRing([65, 80], r)),
      false
    );
    assert.equal(
      pieces.some((r) => pointInRing([145, 160 - 37], r)),
      false
    );
  });
});
