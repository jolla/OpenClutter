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
    const crown = crowns.find((a) => a.area_material.top_height === treeH);
    assert.ok(crown, "crown top stays the measured height");
    assert.ok(crown.area_material.bottom_height >= 2.5);
    assert.ok(crown.area_material.bottom_height < crown.area_material.top_height);
    assert.equal("transparencyEnabled" in crown.area_material, false);
    const trunk = trunks[0];
    assert.equal(trunk.area_material.top_height, crown.area_material.bottom_height);
    assert.equal("bottom_height" in trunk.area_material, false);
    assert.equal("transparencyEnabled" in trunk.area_material, false);
    assert.equal(isPoisonedOiName(trunk.area_material.name), false);
    assert.equal(trunk.area_material.name.indexOf("Tree Trunk"), -1);
    const crownRing = oiRing(crown);
    const trunkRing = oiRing(trunk);
    assert.ok(ringArea(trunkRing) < ringArea(crownRing));
    let sx = 0;
    let sy = 0;
    const n = trunkRing.length > 1 && trunkRing[0][0] === trunkRing[trunkRing.length - 1][0] ? trunkRing.length - 1 : trunkRing.length;
    for (let i = 0; i < n; i++) {
      sx += trunkRing[i][0];
      sy += trunkRing[i][1];
    }
    assert.equal(pointInRing([sx / n, sy / n], crownRing), true);
    const woods = crowns.filter((a) => a !== crown);
    assert.ok(woods.length >= 1);
    for (const mass of woods) {
      assert.equal("bottom_height" in mass.area_material, false, mass.area_material.name);
      assert.equal("transparencyEnabled" in mass.area_material, false);
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
    const masses = areas.filter((a) => isVegetationOiName(a.area_material.name) && !("bottom_height" in a.area_material));
    assert.ok(masses.length >= 1);
    assert.ok(masses.some((a) => a.area_material.top_height === 12));
  });
});
