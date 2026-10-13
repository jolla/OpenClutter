"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter } = require("../netlify/lib/pipeline");
const { standUnderstoryM, isUnderstoryOiName, isTrunkOiName, canonicalAreaMaterial, UNDERSTORY_DB } = require("../netlify/lib/materials");

function grid(height, w, h) {
  const values = new Uint8Array(w * h);
  values.fill(height);
  const cell = 2.2;
  const midLat = 42.9;
  const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const west = -87.93;
  const south = 42.89;
  return {
    west,
    south,
    east: west + (w * cell) / mLon,
    north: south + (h * cell) / 110540,
    width: w,
    height: h,
    values,
  };
}

function exportStand(height) {
  const chm = grid(height, 40, 40);
  const frame = geoFrame({ west: chm.west, south: chm.south, east: chm.east, north: chm.north, name: "Stand" });
  const built = buildClutter({
    frame,
    footprintsGeojson: { features: [] },
    treePoints: [],
    name: "Stand",
    imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    chmGrid: chm,
    includeFoliage: true,
    treesSource: "nlcd-canopy",
  });
  return built.openintent.floorplans[0].attenuation_areas;
}

describe("a large stand is an understory and a raised crown", () => {
  it("keeps deciduous and open woods raised over about 3 m", () => {
    assert.equal(standUnderstoryM(8, "light"), 3);
    assert.equal(standUnderstoryM(14, "heavy"), 3);
    assert.equal(standUnderstoryM(4, "light"), 0);
  });

  it("starts a tall conifer higher, at 30–40% of the canopy", () => {
    const base = standUnderstoryM(30, "heavy");
    assert.ok(base >= 9 && base <= 12, "base " + base);
  });

  it("emits the light zone from the ground and the foliage crown above it", () => {
    const areas = exportStand(8);
    const under = areas.filter((a) => isUnderstoryOiName(a.area_material.name));
    const crowns = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Light") === 0);
    assert.ok(under.length >= 1, "understory");
    assert.ok(crowns.length >= 1, "crown");
    assert.equal(areas.some((a) => isTrunkOiName(a.area_material.name)), false);
    for (const area of under) {
      const mat = area.area_material;
      assert.equal(mat.rf_properties.attenuation_per_m, UNDERSTORY_DB);
      assert.equal("bottom_height" in mat, false);
      assert.ok(mat.top_height >= 2.5 && mat.top_height <= 3.2);
      assert.equal(JSON.stringify(canonicalAreaMaterial(mat)), JSON.stringify(mat));
    }
    for (const area of crowns) {
      const mat = area.area_material;
      assert.equal(mat.rf_properties.attenuation_per_m, 1);
      assert.ok(mat.bottom_height >= 2.5, "crown bottom " + mat.bottom_height);
      assert.equal(mat.top_height, 8);
      assert.equal(JSON.stringify(canonicalAreaMaterial(mat)), JSON.stringify(mat));
    }
  });

  it("lifts both layers onto a tall conifer and keeps the measured top", () => {
    const areas = exportStand(30);
    const under = areas.filter((a) => isUnderstoryOiName(a.area_material.name));
    const crowns = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Heavy") === 0);
    assert.ok(under.length >= 1 && crowns.length >= 1);
    const u = under[0].area_material;
    const c = crowns[0].area_material;
    const uThick = u.top_height - (u.bottom_height || 0);
    assert.ok(uThick >= 9 && uThick <= 12, "understory " + uThick);
    assert.equal(u.rf_properties.attenuation_per_m, 0.6);
    assert.equal(c.rf_properties.attenuation_per_m, 1.5);
    assert.equal(c.top_height, 30);
    assert.ok(Math.abs(c.bottom_height - u.top_height) < 0.2);
  });
});
