"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, oiPixelCoords } = require("../netlify/lib/pipeline");
const { isVegetationOiName, isTrunkOiName, isPoisonedOiName } = require("../netlify/lib/materials");

function pointInRing(pt, ring) {
  const pts =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function ringArea(ring) {
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : ring.length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

function oiRing(area) {
  return oiPixelCoords(area.area.coordinates).map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
}

/** One round crown and one woods block on a ~2.2 m CHM grid. */
function treeAndWoods() {
  const w = 48;
  const h = 48;
  const cell = 2.2;
  const values = new Uint8Array(w * h);
  const treeH = 16;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.hypot(x - 30, y - 30) <= 3.4) values[y * w + x] = treeH;
    }
  }
  for (let y = 2; y <= 7; y++) {
    for (let x = 2; x <= 16; x++) values[y * w + x] = 12;
  }
  const midLat = 42.9;
  const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const west = -87.93;
  const south = 42.89;
  const grid = {
    west,
    south,
    east: west + (w * cell) / mLon,
    north: south + (h * cell) / 110540,
    width: w,
    height: h,
    values,
  };
  const frame = geoFrame({ west, south, east: grid.east, north: grid.north, name: "One tree" });
  return { grid, frame, treeH };
}

function square(lon, lat, dLon, dLat, height) {
  return {
    type: "Feature",
    properties: { height },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [lon, lat],
        [lon + dLon, lat],
        [lon + dLon, lat + dLat],
        [lon, lat + dLat],
        [lon, lat],
      ]],
    },
  };
}

describe("an individual tree has a stem and a raised crown", () => {
  it("exports a trunk under the crown, with the crown top at the measured height", () => {
    const { grid, frame, treeH } = treeAndWoods();
    const dLon = (frame.east - frame.west) * 0.06;
    const dLat = (frame.north - frame.south) * 0.06;
    const lon0 = frame.west + (frame.east - frame.west) * 0.02;
    const lat0 = frame.south + (frame.north - frame.south) * 0.02;
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [square(lon0, lat0, dLon, dLat, 8)] },
      treePoints: [],
      name: "One tree",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      chmGrid: grid,
      includeFoliage: true,
      treesSource: "nlcd-canopy",
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const buildings = areas.filter((a) => !isVegetationOiName(a.area_material.name) && !isTrunkOiName(a.area_material.name));
    const crowns = areas.filter((a) => isVegetationOiName(a.area_material.name));
    const trunks = areas.filter((a) => isTrunkOiName(a.area_material.name));
    assert.equal(buildings.length, 1);
    assert.equal("transparencyEnabled" in buildings[0].area_material, false);
    assert.equal("bottom_height" in buildings[0].area_material, false);
    assert.equal(trunks.length, 1, "one discrete tree, one stem");
    assert.ok(crowns.length >= 2, "the tree crown and the woods");
    const trunk = trunks[0];
    const trunkRing = oiRing(trunk);
    let sx = 0;
    let sy = 0;
    const n = trunkRing.length > 1 && trunkRing[0][0] === trunkRing[trunkRing.length - 1][0] ? trunkRing.length - 1 : trunkRing.length;
    for (let i = 0; i < n; i++) {
      sx += trunkRing[i][0];
      sy += trunkRing[i][1];
    }
    const trunkCenter = [sx / n, sy / n];
    const treeBands = crowns.filter((a) => pointInRing(trunkCenter, oiRing(a)));
    assert.ok(treeBands.length >= 2 && treeBands.length <= 4, "crown layers " + treeBands.length);
    const tip = treeBands.find((a) => a.area_material.top_height === treeH);
    assert.ok(tip, "crown top stays the measured height");
    const lowest = Math.min(...treeBands.map((a) => a.area_material.bottom_height));
    assert.ok(lowest >= 2.5);
    assert.equal(trunk.area_material.top_height, lowest);
    const fullest = treeBands.reduce((a, b) => (ringArea(oiRing(a)) >= ringArea(oiRing(b)) ? a : b));
    assert.ok(ringArea(oiRing(tip)) < ringArea(oiRing(fullest)), "the top band steps inward");
    for (const band of treeBands) {
      assert.equal(band.area_material.transparencyEnabled, true);
      assert.equal(band.area_material.rf_properties.attenuation_per_m, 1.5);
      assert.ok(band.area_material.bottom_height < band.area_material.top_height);
    }
    assert.equal("bottom_height" in trunk.area_material, false);
    assert.equal(trunk.area_material.transparencyEnabled, true);
    assert.equal(isPoisonedOiName(trunk.area_material.name), false);
    assert.equal(trunk.area_material.name.indexOf("Tree Trunk"), -1);
    const crownRing = oiRing(fullest);
    assert.ok(ringArea(trunkRing) < ringArea(crownRing));
    assert.equal(pointInRing(trunkCenter, crownRing), true);
    assert.equal(trunk.area_material.rf_properties.attenuation_per_m, 3);
    assert.ok(n >= 12, "stem corners " + n);
    let axis = true;
    for (let i = 0; i < n; i++) {
      const p = trunkRing[i];
      const q = trunkRing[(i + 1) % n];
      if (p[0] !== q[0] && p[1] !== q[1]) axis = false;
    }
    assert.equal(axis, false, "stem is a round footprint, not a square");
    const tw = Math.max(...trunkRing.map((p) => p[0])) - Math.min(...trunkRing.map((p) => p[0]));
    const th = Math.max(...trunkRing.map((p) => p[1])) - Math.min(...trunkRing.map((p) => p[1]));
    const trunkM = Math.max(tw * frame.mpuX, th * frame.mpuY);
    const crownW = (Math.max(...crownRing.map((p) => p[0])) - Math.min(...crownRing.map((p) => p[0]))) * frame.mpuX;
    const crownH = (Math.max(...crownRing.map((p) => p[1])) - Math.min(...crownRing.map((p) => p[1]))) * frame.mpuY;
    assert.ok(trunkM <= 1.05, "stem width m " + trunkM);
    assert.ok(trunkM >= 0.7, "stem width m " + trunkM);
    assert.ok(trunkM < Math.min(crownW, crownH) * 0.5, "stem " + trunkM + " crown " + crownW + "x" + crownH);
    const woods = crowns.filter((a) => treeBands.indexOf(a) < 0);
    assert.ok(woods.length >= 2, "a canopy mass is two layers");
    const woodsFull = woods.reduce((a, b) => (ringArea(oiRing(a)) >= ringArea(oiRing(b)) ? a : b));
    const woodsTop = woods.reduce((a, b) => (a.area_material.top_height >= b.area_material.top_height ? a : b));
    assert.equal("bottom_height" in woodsFull.area_material, false);
    assert.equal(woodsTop.area_material.top_height, 12);
    assert.ok(ringArea(oiRing(woodsTop)) < ringArea(oiRing(woodsFull)));
    for (const mass of woods) {
      assert.equal(mass.area_material.transparencyEnabled, true);
      assert.equal(mass.area_material.rf_properties.attenuation_per_m, 1.5);
    }
    for (const a of areas) {
      const cat = built.openintent.area_materials.find((m) => m.name === a.area_material.name);
      assert.deepEqual(a.area_material, cat);
    }
    const off = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [{ lon: (frame.west + frame.east) / 2, lat: (frame.south + frame.north) / 2, heightM: 16 }],
      name: "Off",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      chmGrid: grid,
      includeFoliage: false,
    });
    assert.equal(off.stats.openIntentTreeAreas, 0);
    assert.equal(off.stats.includeFoliage, false);
  });

  it("keeps the stem near 1 m on a coarse plate instead of growing it up to the crown", () => {
    const { grid, frame } = treeAndWoods();
    const coarse = geoFrame({
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
      name: "Coarse",
      metersPerPx: 2,
      maxSide: 64,
    });
    const built = buildClutter({
      frame: coarse,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Coarse",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      chmGrid: grid,
      includeFoliage: true,
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const trunks = areas.filter((a) => isTrunkOiName(a.area_material.name));
    const crowns = areas.filter((a) => isVegetationOiName(a.area_material.name) && "bottom_height" in a.area_material);
    assert.equal(trunks.length, 1);
    assert.ok(crowns.length >= 2, "raised bands " + crowns.length);
    const trunkRing = oiRing(trunks[0]);
    const tc = trunkRing.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / trunkRing.length);
    const treeCrowns = crowns.filter((a) => pointInRing(tc, oiRing(a)));
    const crownRing = oiRing(treeCrowns.reduce((a, b) => (ringArea(oiRing(a)) >= ringArea(oiRing(b)) ? a : b)));
    const tipRing = oiRing(treeCrowns.reduce((a, b) => (a.area_material.top_height >= b.area_material.top_height ? a : b)));
    assert.ok(ringArea(tipRing) < ringArea(crownRing));
    const span = (ring) => {
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      return [
        (Math.max(...xs) - Math.min(...xs)) * coarse.mpuX,
        (Math.max(...ys) - Math.min(...ys)) * coarse.mpuY,
      ];
    };
    const [tw, th] = span(trunkRing);
    const [cw, ch] = span(crownRing);
    const trunkM = Math.max(tw, th);
    const crownM = Math.min(cw, ch);
    assert.ok(trunkM <= 1.05, "stem m " + trunkM);
    assert.ok(trunkM < crownM * 0.35, "stem " + trunkM + " crown " + crownM);
    const n = trunkRing.length > 1 && trunkRing[0][0] === trunkRing[trunkRing.length - 1][0] ? trunkRing.length - 1 : trunkRing.length;
    assert.ok(n >= 12, "stem corners " + n);
  });

  it("does not invent a tree from a point or put a stem under a canopy mass", () => {
    const { grid, frame } = treeAndWoods();
    const points = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [{ lon: (frame.west + frame.east) / 2, lat: (frame.south + frame.north) / 2, heightM: 16, median: true }],
      name: "Points",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      includeFoliage: true,
    });
    assert.equal(points.stats.openIntentTreeAreas, 0);
    assert.equal(points.openintent.floorplans[0].attenuation_areas.length, 0);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Woods",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      chmGrid: grid,
      includeFoliage: true,
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const veg = areas.filter((a) => isVegetationOiName(a.area_material.name));
    const masses = veg.filter((a) => !("bottom_height" in a.area_material));
    assert.ok(masses.length >= 1);
    assert.ok(veg.some((a) => a.area_material.top_height === 12));
  });
});
