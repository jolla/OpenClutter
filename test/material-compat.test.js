"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { ZONE_TYPES } = require("../netlify/lib/hamina-clipboard");
const { buildClutter, validateOiArea, MAX_ATTENUATION_AREAS } = require("../netlify/lib/pipeline");
const { catalogMaterials, COMPATIBILITY_MODE } = require("../netlify/lib/materials");
const { scoreMaterialCompatibility } = require("./eval/score");

const BBOX = { west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Compat" };

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

describe("Hamina OpenIntent material compatibility", () => {
  it("keeps a six-name stock catalog and exact heights on the clipboard", () => {
    const frame = geoFrame(BBOX);
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.03;
    const lon0 = frame.west + (frame.east - frame.west) * 0.2;
    const lat0 = frame.south + (frame.north - frame.south) * 0.2;
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [
          square(lon0, lat0, dLon, dLat, 6.41),
          square(lon0 + dLon * 3, lat0, dLon * 2, dLat * 2, 18.2),
          square(lon0, lat0 + dLat * 4, dLon * 4, dLat * 3, 32),
        ],
      },
      treePoints: [
        { lon: lon0 + dLon * 8, lat: lat0, pct: 40, heightM: 7.5 },
        { lon: lon0 + dLon * 8, lat: lat0 + dLat * 3, pct: 80, heightM: 14.2 },
        { lon: lon0 + dLon * 8, lat: lat0 + dLat * 6, pct: 55, heightM: 9.1 },
      ],
      name: "Compat",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "nlcd-canopy",
    });
    const names = built.openintent.area_materials.map((m) => m.name);
    assert.deepEqual(names, ZONE_TYPES.map((t) => t.name));
    assert.equal(built.openintent.area_materials.length, 6);
    assert.deepEqual(built.openintent.area_materials, catalogMaterials());
    for (let i = 0; i < ZONE_TYPES.length; i++) {
      assert.equal(built.openintent.area_materials[i].top_height, ZONE_TYPES[i].topEdge);
      assert.equal(
        built.openintent.area_materials[i].rf_properties.attenuation_per_m,
        ZONE_TYPES[i].attenuationDbPerMeter
      );
    }
    const compat = scoreMaterialCompatibility(built.openintent);
    assert.equal(compat.mode, COMPATIBILITY_MODE);
    assert.equal(compat.stockOnly, true);
    assert.equal(compat.consistent, true);
    assert.equal(compat.materials, 6);
    assert.equal(built.stats.compatibilityMode, COMPATIBILITY_MODE);
    assert.equal(built.stats.areaMaterials, 6);
    const dumped = JSON.stringify(built.openintent);
    assert.equal(/Building \d/.test(dumped), false);
    assert.equal(/Foliage \d/.test(dumped), false);
    const types = built.clipboard.attenuatingZoneTypes;
    assert.ok(types.some((t) => t.id === "bldg-m-6_4" && t.topEdge === 6.4));
    assert.ok(types.some((t) => t.id === "bldg-m-18_2" && t.topEdge === 18.2));
    assert.ok(types.some((t) => t.id === "bldg-m-32_0" && t.topEdge === 32));
    assert.ok(types.some((t) => t.id === "foliage-m-14_2" && t.topEdge === 14.2));
    assert.ok(built.stats.exactBuildingHeights >= 3);
    assert.ok(built.stats.exactFoliageHeights >= 3);
    assert.ok(built.openintent.floorplans[0].attenuation_areas.length >= 3);
  });

  it("rejects the custom catalog that Hamina dropped, and treats 1377 areas as a full emit", () => {
    const buildings = 129;
    const trees = 624;
    const areas = buildings + trees * 2;
    assert.equal(areas, 1377);
    assert.ok(areas < MAX_ATTENUATION_AREAS);
    assert.ok(areas > 982);
    const frame = { imgW: 100, imgH: 100 };
    const coords = [
      { coordinate_xyz: { x: 0, y: 0, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 0, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 10, unit: "pixels" } },
      { coordinate_xyz: { x: 0, y: 0, unit: "pixels" } },
    ];
    const custom = validateOiArea(
      {
        area: { coordinates: coords },
        area_material: {
          name: "Building 6.4 m",
          display_color: "#C4C4C4",
          top_height: 6.4,
          itu_material_type: "ITU_R_UNKNOWN",
          rf_properties: { attenuation_per_m: 5 },
        },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(custom.ok, false);
    assert.equal(custom.reason, "material");
    const drifted = validateOiArea(
      {
        area: { coordinates: coords },
        area_material: {
          name: "Building - One Floor",
          display_color: "#C4C4C4",
          top_height: 6.4,
          itu_material_type: "ITU_R_UNKNOWN",
          rf_properties: { attenuation_per_m: 5 },
        },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(drifted.ok, false);
    assert.equal(drifted.reason, "material");
    const stock = catalogMaterials().find((m) => m.name === "Building - One Floor");
    const ok = validateOiArea({ area: { coordinates: coords }, area_material: stock }, frame.imgW, frame.imgH);
    assert.equal(ok.ok, true);
  });
});
