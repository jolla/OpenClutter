"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, expandOiCoordTriples, oiPixelCoords, validateOiCoords } = require("../netlify/lib/pipeline");
const { buildingCatalog, OI_BUILDING_NAMES, isVegetationOiName, isPoisonedOiName } = require("../netlify/lib/materials");

const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/hamina-native/attenuation-area-sample.json"), "utf8")
);

const GOLD_BUILDING_NAMES = [
  "Building - One Floor",
  "Building - Two Floor",
  "Building - Five Floor",
  "Building - Ten Floor",
];

describe("Hamina-native OpenIntent gold shape", () => {
  it("parses Jerry's Hamina export: triples, isotropic dims, Building-* only, empty markers", () => {
    assert.equal(SAMPLE.openintent_version, "2.0.1");
    assert.match(SAMPLE.map_uri, /^file:\/\/images\//);
    assert.deepEqual(SAMPLE.reference_markers, []);
    const px = SAMPLE.dimensions.find((d) => d.unit === "pixels");
    const m = SAMPLE.dimensions.find((d) => d.unit === "meters");
    assert.ok(Math.abs(px.width / px.length - m.width / m.length) < 1e-9);
    const goldNames = SAMPLE.area_materials.map((mat) => mat.name);
    assert.deepEqual(goldNames, GOLD_BUILDING_NAMES);
    for (const mat of SAMPLE.area_materials) {
      assert.deepEqual(Object.keys(mat), ["name", "rf_properties", "top_height", "display_color"]);
      assert.equal("itu_material_type" in mat, false);
      assert.ok(GOLD_BUILDING_NAMES.includes(mat.name));
    }
    const coords = SAMPLE.attenuation_area.area.coordinates;
    assert.equal(coords.length % 3, 0);
    for (let i = 0; i < coords.length; i += 3) {
      assert.equal(coords[i].coordinate_xyz.unit, "pixels");
      assert.equal(coords[i + 1].coordinate_xyz.unit, "meters");
      assert.equal(coords[i + 2].coordinate_xyz.unit, "feet");
    }
    const mpu = m.width / px.width;
    const p0 = coords[0].coordinate_xyz;
    const m0 = coords[1].coordinate_xyz;
    assert.ok(Math.abs(m0.x - p0.x * mpu) < 1e-4);
    assert.ok(Math.abs(m0.y - p0.y * mpu) < 1e-4);
  });

  it("emits tree areas on custom vegetation materials and keeps the gold building prefix", () => {
    const frame = geoFrame({
      west: -87.93,
      south: 42.89,
      east: -87.91,
      north: 42.91,
      name: "Native",
    });
    assert.ok(Math.abs(frame.imgW / frame.imgH - frame.widthM / frame.lengthM) < 0.02);
    const dLon = (frame.east - frame.west) * 0.05;
    const dLat = (frame.north - frame.south) * 0.04;
    const lon0 = frame.west + (frame.east - frame.west) * 0.3;
    const lat0 = frame.south + (frame.north - frame.south) * 0.3;
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [
          {
            type: "Feature",
            properties: { height: 5 },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [lon0, lat0],
                [lon0 + dLon, lat0],
                [lon0 + dLon, lat0 + dLat],
                [lon0, lat0 + dLat],
                [lon0, lat0],
              ]],
            },
          },
        ],
      },
      treePoints: [{ lon: lon0 + dLon * 2, lat: lat0 + dLat * 2, pct: 50 }],
      name: "Native",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const fp = built.openintent.floorplans[0];
    assert.deepEqual(fp.reference_markers, []);
    const meters = fp.dimensions.find((d) => d.unit === "meters");
    const pixels = fp.dimensions.find((d) => d.unit === "pixels");
    const feet = fp.dimensions.find((d) => d.unit === "feet");
    assert.equal(meters.height, 2.5);
    assert.equal(feet.height, 8.202);
    assert.ok(Math.abs(pixels.height - 2.5 / frame.mpuX) < 1e-9);
    const names = built.openintent.area_materials.map((m) => m.name);
    assert.deepEqual(names.slice(0, 4), OI_BUILDING_NAMES);
    assert.deepEqual(OI_BUILDING_NAMES, GOLD_BUILDING_NAMES);
    assert.deepEqual(built.openintent.area_materials.slice(0, 4), buildingCatalog());
    const extra = names.slice(4);
    assert.ok(extra.length >= 1);
    for (const n of extra) assert.equal(isVegetationOiName(n), true, n);
    for (const mat of built.openintent.area_materials) {
      assert.deepEqual(Object.keys(mat), ["name", "rf_properties", "top_height", "display_color"]);
    }
    assert.equal(built.stats.openIntentBuildingAreas, 1);
    assert.ok(built.stats.openIntentTreeAreas >= 1);
    assert.equal(fp.attenuation_areas.length, 1 + built.stats.openIntentTreeAreas);
    let vegetationAreas = 0;
    for (const a of fp.attenuation_areas) {
      const name = a.area_material.name;
      assert.ok(GOLD_BUILDING_NAMES.includes(name) || isVegetationOiName(name), name);
      if (isVegetationOiName(name)) vegetationAreas++;
      const coords = a.area.coordinates;
      assert.equal(coords.length % 3, 0);
      assert.ok(coords.length >= 12);
      for (let i = 0; i < coords.length; i += 3) {
        assert.equal(coords[i].coordinate_xyz.unit, "pixels");
        assert.equal(coords[i + 1].coordinate_xyz.unit, "meters");
        assert.equal(coords[i + 2].coordinate_xyz.unit, "feet");
      }
      assert.equal(validateOiCoords(coords, frame.imgW, frame.imgH).ok, true);
      const pixels = oiPixelCoords(coords);
      assert.ok(pixels.length >= 4);
      const again = expandOiCoordTriples(pixels, frame.mpuX);
      assert.equal(again.length, coords.length);
    }
    assert.ok(vegetationAreas >= 1);
    const dumped = JSON.stringify(built.openintent);
    assert.ok(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
    assert.ok(dumped.includes("Tree Foliage"));
    assert.ok(dumped.includes("Tree Wood"));
    assert.ok(built.clipboard.attenuatingZones.length >= 3);
    assert.ok(
      built.clipboard.attenuatingZones.some(
        (z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("foliage") === 0 || String(z.typeId).indexOf("trunk") === 0
      )
    );
  });
});
