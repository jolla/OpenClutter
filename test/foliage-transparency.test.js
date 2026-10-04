"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const jpeg = require("jpeg-js");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter } = require("../netlify/lib/pipeline");
const { isVegetationOiName, measuredTrunkMaterial } = require("../netlify/lib/materials");
const { ZONE_TYPES } = require("../netlify/lib/hamina-clipboard");
const { treesFromJpeg, CANOPY, TRUNK } = require("../netlify/functions/trees");
const { canopyHitsGrid } = require("./canopy-grid");

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

function vegType(type) {
  const id = String((type && type.id) || "");
  const name = String((type && type.name) || "");
  return id.indexOf("foliage") === 0 || id.indexOf("trunk") === 0 || /foliage|tree/i.test(name);
}

describe("foliage and trees are transparent in 3D", () => {
  it("exports canopy with transparency on and leaves buildings opaque", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Canopy" });
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.03;
    const lon0 = frame.west + (frame.east - frame.west) * 0.25;
    const lat0 = frame.south + (frame.north - frame.south) * 0.25;
    const treeLon = lon0 + dLon * 6;
    const treeLat = lat0 + dLat * 2;
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [square(lon0, lat0, dLon, dLat, 8)] },
      treePoints: [{ lon: treeLon, lat: treeLat, pct: 70, heightM: 14.2, median: true }],
      canopyHits: canopyHitsGrid(frame, treeLon, treeLat, { pct: 70, heightM: 14.2 }),
      name: "Canopy",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      includeFoliage: true,
      heightSample: () => 14.2,
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const veg = areas.filter((a) => isVegetationOiName(a.area_material.name));
    const buildings = areas.filter((a) => !isVegetationOiName(a.area_material.name));
    assert.ok(veg.length >= 1, "canopy area missing");
    assert.ok(buildings.length >= 1, "building area missing");
    for (const a of veg) {
      assert.equal(a.area_material.transparencyEnabled, true, a.area_material.name);
    }
    for (const a of buildings) {
      assert.equal("transparencyEnabled" in a.area_material, false, a.area_material.name);
    }
    const types = built.clipboard.attenuatingZoneTypes;
    const vegTypes = types.filter(vegType);
    assert.ok(vegTypes.length >= 1);
    for (const t of vegTypes) assert.equal(t.transparencyEnabled, true, t.id);
    for (const t of types) {
      if (!vegType(t)) assert.equal(t.transparencyEnabled, false, t.id);
    }
  });

  it("keeps a buildings-only export opaque", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Bare" });
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.03;
    const lon0 = frame.west + (frame.east - frame.west) * 0.25;
    const lat0 = frame.south + (frame.north - frame.south) * 0.25;
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [square(lon0, lat0, dLon, dLat, 8)] },
      treePoints: [],
      name: "Bare",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.ok(areas.length >= 1);
    for (const a of areas) assert.equal("transparencyEnabled" in a.area_material, false);
    for (const t of built.clipboard.attenuatingZoneTypes) {
      assert.equal(t.transparencyEnabled, false, t.id);
    }
  });

  it("flags tree trunk types as transparent and leaves building types opaque", () => {
    assert.equal(ZONE_TYPES.find((t) => t.id === "tree-trunk").transparencyEnabled, true);
    assert.equal(ZONE_TYPES.find((t) => t.id === "foliage-heavy").transparencyEnabled, true);
    assert.equal(ZONE_TYPES.find((t) => t.id === "bldg-one").transparencyEnabled, false);
    const trunk = measuredTrunkMaterial(8);
    assert.equal(trunk.clipType.transparencyEnabled, true);
    assert.equal(CANOPY.transparencyEnabled, true);
    assert.equal(TRUNK.transparencyEnabled, true);
    const raw = Buffer.alloc(8 * 8 * 4, 0);
    const encoded = jpeg.encode({ data: raw, width: 8, height: 8 }, 50);
    const packed = treesFromJpeg(Buffer.from(encoded.data), 8, 8, 1, (x, y) => ({
      coordinate_xyz: { x, y, unit: "pixels" },
    }));
    assert.equal(packed.clipboardTypes.length, 2);
    for (const t of packed.clipboardTypes) assert.equal(t.transparencyEnabled, true, t.name);
    for (const a of packed.areas) assert.equal(a.area_material.transparencyEnabled, true, a.area_material.name);
  });
});
