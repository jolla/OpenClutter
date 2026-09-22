"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, validateOiArea, MAX_ATTENUATION_AREAS } = require("../netlify/lib/pipeline");
const {
  catalogMaterials,
  buildingCatalog,
  COMPATIBILITY_MODE,
  OI_BUILDING_NAMES,
  OI_BUILDING_TYPES,
  materialForVegetation,
  isVegetationOiName,
  isPoisonedOiName,
  foliageDbPerM,
} = require("../netlify/lib/materials");
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
  it("uses fixed custom vegetation objects and rejects poisoned names", () => {
    const light = materialForVegetation(9, "canopy");
    const heavy = materialForVegetation(14.2, "canopy");
    const wood = materialForVegetation(14.2, "trunk");
    assert.equal(light.name, "Tree Foliage 9.0");
    assert.equal(light.top_height, 9);
    assert.equal(light.rf_properties.attenuation_per_m, foliageDbPerM(9));
    assert.equal(heavy.name, "Tree Foliage 14.2");
    assert.equal(heavy.top_height, 14.2);
    assert.equal(heavy.rf_properties.attenuation_per_m, foliageDbPerM(14.2));
    assert.ok(heavy.rf_properties.attenuation_per_m < 3);
    assert.notEqual(heavy.display_color, "#9AA5AC");
    assert.notEqual(heavy.display_color, "#9A4159");
    assert.equal(wood.name, "Tree Wood 14.2");
    assert.equal(wood.top_height, 14.2);
    assert.equal(wood.rf_properties.attenuation_per_m, 10);
    assert.equal(wood.display_color, "#937E75");
    for (const mat of [light, heavy, wood]) {
      assert.deepEqual(Object.keys(mat), ["name", "rf_properties", "top_height", "display_color"]);
      assert.equal(isVegetationOiName(mat.name), true);
      assert.equal(isPoisonedOiName(mat.name), false);
      assert.equal("itu_material_type" in mat, false);
      assert.equal("bottom_height" in mat, false);
    }
    const frame = { imgW: 100, imgH: 100 };
    const coords = [
      { coordinate_xyz: { x: 0, y: 0, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 0, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 10, unit: "pixels" } },
      { coordinate_xyz: { x: 0, y: 0, unit: "pixels" } },
    ];
    const accepted = validateOiArea({ area: { coordinates: coords }, area_material: light }, frame.imgW, frame.imgH);
    assert.equal(accepted.ok, true);
    const drifted = validateOiArea(
      {
        area: { coordinates: coords },
        area_material: { ...light, top_height: 14.2 },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(drifted.ok, false);
    assert.equal(drifted.reason, "material");
    for (const name of ["Foliage - Heavy", "Tree Trunk", "Foliage 14.2 m", "Tree Trunk 8.0 m", "Building 6.4 m"]) {
      const rejected = validateOiArea(
        {
          area: { coordinates: coords },
          area_material: {
            name,
            rf_properties: { attenuation_per_m: 1 },
            top_height: 12,
            display_color: "#509D33",
          },
        },
        frame.imgW,
        frame.imgH
      );
      assert.equal(rejected.ok, false, name);
      assert.equal(rejected.reason, "material");
    }
  });

  it("keeps a buildings-only catalog identical to gold and adds customs only with trees", () => {
    const frame = geoFrame(BBOX);
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.03;
    const lon0 = frame.west + (frame.east - frame.west) * 0.2;
    const lat0 = frame.south + (frame.north - frame.south) * 0.2;
    const footprintsGeojson = {
      features: [square(lon0, lat0, dLon, dLat, 6.41)],
    };
    const bare = buildClutter({
      frame,
      footprintsGeojson,
      treePoints: [],
      name: "Bare",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const withTrees = buildClutter({
      frame,
      footprintsGeojson,
      treePoints: [{ lon: lon0 + dLon * 6, lat: lat0, pct: 70, heightM: 14.2 }],
      name: "Bare",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.deepEqual(bare.openintent.area_materials, buildingCatalog());
    assert.equal(bare.stats.openIntentTreeAreas, 0);
    assert.deepEqual(withTrees.openintent.area_materials.slice(0, 4), bare.openintent.area_materials);
    const extra = withTrees.openintent.area_materials.slice(4).map((m) => m.name);
    assert.deepEqual(extra, ["Tree Foliage 14.2", "Tree Wood 14.2"]);
    const foliage = withTrees.openintent.floorplans[0].attenuation_areas.find(
      (a) => a.area_material.name === "Tree Foliage 14.2"
    );
    assert.equal(foliage.area_material.top_height, 14.2);
    const bareAreas = bare.openintent.floorplans[0].attenuation_areas;
    const both = withTrees.openintent.floorplans[0].attenuation_areas;
    assert.equal(bareAreas.length, 1);
    assert.deepEqual(
      both.slice(0, bareAreas.length).map((a) => a.area_material),
      bareAreas.map((a) => a.area_material)
    );
    assert.ok(both.length > bareAreas.length);
    for (const a of both.slice(bareAreas.length)) {
      assert.equal(isVegetationOiName(a.area_material.name), true);
      assert.deepEqual(Object.keys(a.area_material), ["name", "rf_properties", "top_height", "display_color"]);
      const cat = withTrees.openintent.area_materials.find((m) => m.name === a.area_material.name);
      assert.deepEqual(a.area_material, cat);
    }
    assert.ok(withTrees.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
  });

  it("keeps the gold Building-* OI catalog and exact heights on the clipboard", () => {
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
    assert.deepEqual(names.slice(0, 4), OI_BUILDING_NAMES);
    assert.deepEqual(built.openintent.area_materials.slice(0, 4), catalogMaterials());
    const vegNames = names.slice(4);
    assert.deepEqual(vegNames, [
      "Tree Foliage 7.5",
      "Tree Foliage 9.1",
      "Tree Foliage 14.2",
      "Tree Wood 7.5",
      "Tree Wood 9.1",
      "Tree Wood 14.2",
    ]);
    assert.ok(vegNames.every((n) => isVegetationOiName(n)));
    for (let i = 0; i < OI_BUILDING_TYPES.length; i++) {
      assert.equal(built.openintent.area_materials[i].top_height, OI_BUILDING_TYPES[i].topEdge);
      assert.equal(
        built.openintent.area_materials[i].rf_properties.attenuation_per_m,
        OI_BUILDING_TYPES[i].attenuationDbPerMeter
      );
    }
    const compat = scoreMaterialCompatibility(built.openintent);
    assert.equal(compat.mode, COMPATIBILITY_MODE);
    assert.equal(compat.stockOnly, true);
    assert.equal(compat.consistent, true);
    assert.equal(compat.materials, 10);
    assert.equal(compat.vegetationHeights, 3);
    assert.equal(compat.vegetationAreas >= 3, true);
    assert.equal(built.stats.compatibilityMode, COMPATIBILITY_MODE);
    assert.equal(built.stats.areaMaterials, 10);
    assert.ok(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
    assert.ok(names.some((n) => n.indexOf("Tree Foliage") === 0));
    assert.ok(names.some((n) => n.indexOf("Tree Wood") === 0));
    const types = built.clipboard.attenuatingZoneTypes;
    assert.ok(types.some((t) => t.id === "bldg-m-6_4" && t.topEdge === 6.4));
    assert.ok(types.some((t) => t.id === "bldg-m-18_2" && t.topEdge === 18.2));
    assert.ok(types.some((t) => t.id === "bldg-m-32_0" && t.topEdge === 32));
    assert.ok(types.some((t) => t.id === "foliage-m-14_2" && t.topEdge === 14.2));
    assert.ok(built.stats.exactBuildingHeights >= 3);
    assert.ok(built.stats.exactFoliageHeights >= 3);
    // Buildings stay on the gold prefix. Tree rings use the custom vegetation objects.
    assert.equal(built.stats.openIntentBuildingAreas, 3);
    assert.ok(built.stats.openIntentTreeAreas >= 3);
    assert.equal(
      built.openintent.floorplans[0].attenuation_areas.length,
      3 + built.stats.openIntentTreeAreas
    );
    assert.ok(built.clipboard.attenuatingZones.length >= 3 + 3 * 2);
    assert.equal(built.openintent.openintent_version, "2.0.1");
    assert.deepEqual(Object.keys(built.openintent).sort(), [
      "area_materials",
      "floorplans",
      "openintent_version",
      "switches",
      "wall_materials",
    ]);
    const fp = built.openintent.floorplans[0];
    assert.deepEqual(Object.keys(fp).sort(), [
      "attenuation_areas",
      "closets",
      "coverage_areas",
      "dimensions",
      "floor_id",
      "map_uri",
      "name",
      "project_name",
      "reference_markers",
      "rotation",
    ]);
    assert.match(fp.map_uri, /^file:\/\/images\//);
    assert.deepEqual(
      fp.dimensions.map((d) => d.unit),
      ["pixels", "meters", "feet"]
    );
    assert.deepEqual(fp.reference_markers, []);
    for (const a of fp.attenuation_areas) {
      assert.deepEqual(Object.keys(a).sort(), ["area", "area_material"]);
      const cat = built.openintent.area_materials.find((m) => m.name === a.area_material.name);
      assert.deepEqual(a.area_material, cat);
      assert.deepEqual(Object.keys(a.area_material), ["name", "rf_properties", "top_height", "display_color"]);
      assert.ok(
        OI_BUILDING_NAMES.includes(a.area_material.name) || isVegetationOiName(a.area_material.name)
      );
      assert.equal("itu_material_type" in a.area_material, false);
      assert.equal("bottom_height" in a.area_material, false);
      const coords = a.area.coordinates;
      assert.ok(coords.length >= 12);
      assert.equal(coords.length % 3, 0);
      for (let i = 0; i < coords.length; i += 3) {
        assert.equal(coords[i].coordinate_xyz.unit, "pixels");
        assert.equal(coords[i + 1].coordinate_xyz.unit, "meters");
        assert.equal(coords[i + 2].coordinate_xyz.unit, "feet");
      }
    }
  });

  it("embeds catalog materials and caps at the last import that showed clutter", () => {
    const buildings = 129;
    const trees = 624;
    const areas = buildings + trees * 2;
    assert.equal(areas, 1377);
    assert.equal(MAX_ATTENUATION_AREAS, 982);
    assert.ok(areas > MAX_ATTENUATION_AREAS);
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
          rf_properties: { attenuation_per_m: 5 },
          top_height: 6.4,
          display_color: "#C4C4C4",
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
          rf_properties: { attenuation_per_m: 5 },
          top_height: 6.4,
          display_color: "#C4C4C4",
        },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(drifted.ok, false);
    assert.equal(drifted.reason, "material");
    const stock = catalogMaterials().find((m) => m.name === "Building - One Floor");
    const embedded = validateOiArea({ area: { coordinates: coords }, area_material: stock }, frame.imgW, frame.imgH);
    assert.equal(embedded.ok, true);
    const named = validateOiArea({ area: { coordinates: coords }, area_material: stock.name }, frame.imgW, frame.imgH);
    assert.equal(named.ok, false);
    assert.equal(named.reason, "material");
    const withItu = validateOiArea(
      {
        area: { coordinates: coords },
        area_material: { ...stock, itu_material_type: "ITU_R_UNKNOWN" },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(withItu.ok, false);
    assert.equal(withItu.reason, "material");
    const withBottom = validateOiArea(
      {
        area: { coordinates: coords },
        area_material: { ...stock, bottom_height: 0 },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(withBottom.ok, false);
    assert.equal(withBottom.reason, "material");
  });
});
