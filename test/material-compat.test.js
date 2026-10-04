"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, validateOiArea, MAX_ATTENUATION_AREAS } = require("../netlify/lib/pipeline");
const fs = require("node:fs");
const path = require("node:path");
const {
  catalogMaterials,
  buildingCatalog,
  COMPATIBILITY_MODE,
  OI_BUILDING_NAMES,
  OI_BUILDING_TYPES,
  materialForVegetation,
  materialForBuilding,
  measuredOiBuildingMaterial,
  buildingColor,
  stockFoliageMaterial,
  isVegetationOiName,
  isPoisonedOiName,
  BUILDING_NEUTRAL_COLOR,
  BUILDING_COLOR_SHORT,
  BUILDING_COLOR_LOW,
  BUILDING_COLOR_MID,
  BUILDING_COLOR_TALL,
  BUILDING_COLOR_TOWER,
  FOLIAGE_HEAVY_NAME,
  FOLIAGE_LIGHT_NAME,
} = require("../netlify/lib/materials");
const { scoreMaterialCompatibility } = require("./eval/score");
const { canopyHitsGrid } = require("./canopy-grid");

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
  it("uses stock Foliage objects and measured-height customs, and rejects poisoned names", () => {
    const heavyStock = materialForVegetation(0, "heavy");
    const lightStock = materialForVegetation(0, "light");
    assert.deepEqual(heavyStock, stockFoliageMaterial("heavy"));
    assert.deepEqual(lightStock, stockFoliageMaterial("light"));
    assert.equal(heavyStock.name, "Foliage - Heavy");
    assert.equal(lightStock.name, "Foliage - Light");
    assert.equal((heavyStock.top_height * 3.280839895).toFixed(2), "19.68");
    assert.equal(lightStock.top_height, heavyStock.top_height);
    assert.equal(heavyStock.rf_properties.attenuation_per_m, 2);
    assert.equal(lightStock.rf_properties.attenuation_per_m, 1);
    assert.equal(heavyStock.display_color, "#3F7D2A");
    assert.equal(lightStock.display_color, "#6FA84A");
    assert.equal(materialForVegetation(6, "heavy").name, "Foliage - Heavy");
    const light = materialForVegetation(9, "light");
    const heavy = materialForVegetation(14.2, "heavy");
    assert.equal(light.name, "Foliage - Light 9.0");
    assert.equal(light.top_height, 9);
    assert.equal(light.rf_properties.attenuation_per_m, 1);
    assert.equal(light.display_color, "#6FA84A");
    assert.equal(heavy.name, "Foliage - Heavy 14.2");
    assert.equal(heavy.top_height, 14.2);
    assert.equal(heavy.rf_properties.attenuation_per_m, 2);
    assert.equal(heavy.display_color, "#3F7D2A");
    assert.notEqual(heavy.display_color, "#9AA5AC");
    assert.notEqual(heavy.display_color, "#9A4159");
    for (const mat of [heavyStock, lightStock, light, heavy]) {
      assert.equal(mat.transparencyEnabled, true);
      assert.deepEqual(Object.keys(mat), ["name", "rf_properties", "top_height", "display_color", "transparencyEnabled"]);
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
    const accepted = validateOiArea(
      { area: { coordinates: coords }, area_material: heavyStock },
      frame.imgW,
      frame.imgH
    );
    assert.equal(accepted.ok, true);
    const driftedStock = validateOiArea(
      {
        area: { coordinates: coords },
        area_material: { ...heavyStock, top_height: 12 },
      },
      frame.imgW,
      frame.imgH
    );
    assert.equal(driftedStock.ok, false);
    assert.equal(driftedStock.reason, "material");
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
    for (const name of ["Tree Trunk", "Foliage 14.2 m", "Tree Trunk 8.0 m", "Building 6.4 m"]) {
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
    const treeLon = lon0 + dLon * 6;
    const withTrees = buildClutter({
      frame,
      footprintsGeojson,
      treePoints: [{ lon: treeLon, lat: lat0, pct: 70, heightM: 14.2, median: true }],
      canopyHits: canopyHitsGrid(frame, treeLon, lat0, { pct: 70 }),
      name: "Bare",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      includeFoliage: true,
      heightSample: () => 14.2,
    });
    assert.deepEqual(bare.openintent.area_materials, buildingCatalog());
    assert.equal(bare.stats.openIntentTreeAreas, 0);
    assert.deepEqual(withTrees.openintent.area_materials.slice(0, 4), bare.openintent.area_materials);
    const extra = withTrees.openintent.area_materials.slice(4).map((m) => m.name);
    assert.deepEqual(extra, ["Foliage - Heavy 14.2"]);
    const foliage = withTrees.openintent.floorplans[0].attenuation_areas.find(
      (a) => a.area_material.name === "Foliage - Heavy 14.2"
    );
    assert.equal(foliage.area_material.top_height, 14.2);
    assert.equal(foliage.area_material.rf_properties.attenuation_per_m, 2);
    assert.equal(foliage.area_material.display_color, "#3F7D2A");
    assert.ok(foliage.area.coordinates.length / 3 <= 40);
    assert.equal(
      withTrees.openintent.floorplans[0].attenuation_areas.some((a) => a.area_material.name === "Tree Trunk"),
      false
    );
    const bareAreas = bare.openintent.floorplans[0].attenuation_areas;
    const both = withTrees.openintent.floorplans[0].attenuation_areas;
    assert.equal(bareAreas.length, 1);
    assert.deepEqual(
      both.slice(0, bareAreas.length).map((a) => a.area_material),
      bareAreas.map((a) => a.area_material)
    );
    assert.ok(both.length > bareAreas.length);
    for (const a of both.slice(0, bareAreas.length)) {
      assert.equal("transparencyEnabled" in a.area_material, false);
    }
    for (const a of both.slice(bareAreas.length)) {
      assert.equal(isVegetationOiName(a.area_material.name), true);
      assert.equal(a.area_material.transparencyEnabled, true);
      assert.deepEqual(Object.keys(a.area_material), ["name", "rf_properties", "top_height", "display_color", "transparencyEnabled"]);
      const cat = withTrees.openintent.area_materials.find((m) => m.name === a.area_material.name);
      assert.deepEqual(a.area_material, cat);
    }
    assert.ok(withTrees.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
  });

  it("imports buildings and stock foliage together when height is unmeasured", () => {
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
      name: "Stock",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const treeLon = lon0 + dLon * 6;
    const withTrees = buildClutter({
      frame,
      footprintsGeojson,
      treePoints: [{ lon: treeLon, lat: lat0, pct: 70, median: true }],
      canopyHits: canopyHitsGrid(frame, treeLon, lat0, { pct: 70 }),
      name: "Stock",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      includeFoliage: true,
    });
    assert.deepEqual(bare.openintent.area_materials, buildingCatalog());
    assert.deepEqual(withTrees.openintent.area_materials.slice(0, 4), bare.openintent.area_materials);
    const extra = withTrees.openintent.area_materials.slice(4);
    assert.equal(extra.length, 1);
    assert.deepEqual(extra[0], stockFoliageMaterial("heavy"));
    const areas = withTrees.openintent.floorplans[0].attenuation_areas;
    const building = areas.find((a) => a.area_material.name === "Building - Two Floor");
    const foliage = areas.find((a) => a.area_material.name === "Foliage - Heavy");
    assert.ok(building);
    assert.deepEqual(building.area_material, bare.openintent.floorplans[0].attenuation_areas[0].area_material);
    assert.ok(foliage);
    assert.deepEqual(foliage.area_material, extra[0]);
    assert.equal("itu_material_type" in foliage.area_material, false);
    assert.equal("bottom_height" in foliage.area_material, false);
    assert.ok(foliage.area.coordinates.length / 3 <= 40);
    assert.equal(areas.some((a) => a.area_material.name === "Tree Trunk"), false);
    assert.ok(withTrees.stats.openIntentBuildingAreas >= 1);
    assert.ok(withTrees.stats.openIntentTreeAreas >= 1);
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
        { lon: lon0 + dLon * 8, lat: lat0, pct: 40, heightM: 7.5, median: true },
        { lon: lon0 + dLon * 8, lat: lat0 + dLat * 3, pct: 80, heightM: 14.2, median: true },
        { lon: lon0 + dLon * 8, lat: lat0 + dLat * 6, pct: 55, heightM: 9.1, median: true },
      ],
      canopyHits: []
        .concat(canopyHitsGrid(frame, lon0 + dLon * 8, lat0, { pct: 40 }))
        .concat(canopyHitsGrid(frame, lon0 + dLon * 8, lat0 + dLat * 3, { pct: 80 }))
        .concat(canopyHitsGrid(frame, lon0 + dLon * 8, lat0 + dLat * 6, { pct: 55 })),
      name: "Compat",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "nlcd-canopy",
      includeFoliage: true,
      heightSample: (lon, lat) => {
        if (lat >= lat0 + dLat * 5) return 9.1;
        if (lat >= lat0 + dLat * 2) return 14.2;
        return 7.5;
      },
    });
    const names = built.openintent.area_materials.map((m) => m.name);
    assert.deepEqual(names.slice(0, 4), OI_BUILDING_NAMES);
    assert.deepEqual(built.openintent.area_materials.slice(0, 4), catalogMaterials());
    const vegNames = names.slice(4);
    assert.deepEqual(vegNames, [
      "Foliage - Heavy 14.2",
      "Foliage - Light 7.5",
      "Foliage - Light 9.1",
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
    assert.equal(compat.materials, 7);
    assert.equal(compat.vegetationHeights, 3);
    assert.equal(compat.vegetationAreas >= 3, true);
    assert.equal(built.stats.compatibilityMode, COMPATIBILITY_MODE);
    assert.equal(built.stats.areaMaterials, 7);
    assert.ok(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
    assert.ok(names.some((n) => n.indexOf("Foliage - Heavy") === 0));
    assert.ok(names.some((n) => n.indexOf("Foliage - Light") === 0));
    assert.equal(names.includes("Tree Trunk"), false);
    const types = built.clipboard.attenuatingZoneTypes;
    assert.ok(types.some((t) => t.id === "bldg-m-6_4" && t.topEdge === 6.4));
    assert.ok(types.some((t) => t.id === "bldg-m-18_2" && t.topEdge === 18.2));
    assert.ok(types.some((t) => t.id === "bldg-m-32_0" && t.topEdge === 32));
    assert.ok(types.some((t) => t.id === "foliage-m-14_2" && t.topEdge === 14.2 && t.transparencyEnabled === true && t.name === "Foliage - Heavy 14.2"));
    for (const t of types) {
      const id = String(t.id || "");
      if (id.indexOf("foliage") === 0) assert.equal(t.transparencyEnabled, true, id);
      if (id.indexOf("bldg") === 0) assert.equal(t.transparencyEnabled, false, id);
    }
    assert.ok(built.stats.exactBuildingHeights >= 3);
    assert.ok(built.stats.exactFoliageHeights >= 3);
    // Buildings stay on the gold prefix. Tree rings use the custom vegetation objects.
    assert.equal(built.stats.openIntentBuildingAreas, 3);
    assert.ok(built.stats.openIntentTreeAreas >= 3);
    assert.equal(
      built.openintent.floorplans[0].attenuation_areas.length,
      3 + built.stats.openIntentTreeAreas
    );
    assert.ok(built.clipboard.attenuatingZones.length >= 3 + 3);
    assert.equal(
      built.clipboard.attenuatingZones.some((z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("trunk") === 0),
      false
    );
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
      if (isVegetationOiName(a.area_material.name)) {
        assert.equal(a.area_material.transparencyEnabled, true);
        assert.deepEqual(Object.keys(a.area_material), [
          "name",
          "rf_properties",
          "top_height",
          "display_color",
          "transparencyEnabled",
        ]);
      } else {
        assert.equal("transparencyEnabled" in a.area_material, false);
        assert.deepEqual(Object.keys(a.area_material), ["name", "rf_properties", "top_height", "display_color"]);
      }
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

  it("colors buildings as one cool gray, lighter when short and darker when tall", () => {
    function channel(hex, i) {
      return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    }
    function luma(hex) {
      return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
    }
    function isCoolGray(hex) {
      const r = channel(hex, 0);
      const g = channel(hex, 1);
      const b = channel(hex, 2);
      assert.ok(b >= g && g >= r, hex);
      assert.ok(b - r <= 16, hex);
      assert.equal(["#377EB8", "#FF7F00", "#984EA3", "#E41A1C", "#F0E442", "#9AA5AC", "#9A4159"].includes(hex), false);
    }
    const stops = [4.5, 7.62, 15.24, 32, 187];
    const colors = stops.map((h) => buildingColor(h));
    assert.equal(new Set(colors).size, 5);
    assert.deepEqual(colors, [
      BUILDING_COLOR_SHORT,
      BUILDING_COLOR_LOW,
      BUILDING_COLOR_MID,
      BUILDING_COLOR_TALL,
      BUILDING_COLOR_TOWER,
    ]);
    for (const c of colors.concat([BUILDING_NEUTRAL_COLOR])) isCoolGray(c);
    const light = colors.map(luma);
    for (let i = 1; i < light.length; i++) assert.ok(light[i] < light[i - 1], colors[i]);
    const span = light[0] - light[light.length - 1];
    assert.ok(span > 20 && span < 60, span);
    const shortMeasured = measuredOiBuildingMaterial(4.5);
    const tower = measuredOiBuildingMaterial(187);
    assert.equal(shortMeasured.display_color, "#C5CBD1");
    assert.equal(tower.name, "Building - 187.0");
    assert.equal(tower.top_height, 187);
    assert.equal(tower.display_color, "#A2A8AE");
    assert.ok(luma(tower.display_color) < luma(shortMeasured.display_color));
    for (const h of [0, 2, NaN, null, undefined]) {
      assert.equal(buildingColor(h), BUILDING_NEUTRAL_COLOR);
    }
    assert.equal(BUILDING_NEUTRAL_COLOR, "#B4BAC0");
    assert.equal(BUILDING_NEUTRAL_COLOR, BUILDING_COLOR_MID);
    for (const t of OI_BUILDING_TYPES) {
      assert.equal(t.color, buildingColor(t.topEdge), t.name);
      assert.equal(t.attenuationDbPerMeter, 5);
    }
    assert.deepEqual(
      OI_BUILDING_TYPES.map((t) => t.name),
      ["Building - One Floor", "Building - Two Floor", "Building - Five Floor", "Building - Ten Floor"]
    );
    assert.deepEqual(OI_BUILDING_TYPES.map((t) => t.topEdge), [4.5, 7.620092660326749, 15.240185320653499, 32]);
    const one = catalogMaterials().find((m) => m.name === "Building - One Floor");
    assert.equal(one.display_color, "#C5CBD1");
    assert.equal(one.top_height, 4.5);
    const stockShort = materialForBuilding(4.5, 80);
    assert.equal(stockShort.material.name, "Building - One Floor");
    assert.equal(stockShort.material.display_color, "#C5CBD1");
    const exactTower = materialForBuilding(187, 80, { exactMetres: true });
    assert.equal(exactTower.material.display_color, "#A2A8AE");
    assert.equal(exactTower.material.name, "Building - 187.0");
    const unknownSmall = materialForBuilding(0, 80);
    const unknownLarge = materialForBuilding(0, 9000);
    assert.equal(unknownSmall.material.name, "Building - One Floor");
    assert.equal(unknownSmall.material.top_height, 4.5);
    assert.equal(unknownLarge.material.name, "Building - Ten Floor");
    assert.equal(unknownLarge.material.top_height, 32);
    // No measured height does not invent a metre value for the color.
    // The stock floor keeps its own gray. A 40 m area guess is not a tower.
    assert.equal(unknownSmall.material.display_color, buildingColor(unknownSmall.material.top_height));
    assert.equal(unknownLarge.material.display_color, buildingColor(unknownLarge.material.top_height));
    assert.equal(buildingColor(0), BUILDING_NEUTRAL_COLOR);
    assert.notEqual(unknownLarge.material.display_color, buildingColor(40));
    assert.notEqual(unknownLarge.material.display_color, BUILDING_COLOR_TOWER);
    const heavy = stockFoliageMaterial("heavy");
    const foliage = stockFoliageMaterial("light");
    assert.equal(heavy.name, FOLIAGE_HEAVY_NAME);
    assert.equal(foliage.name, FOLIAGE_LIGHT_NAME);
    assert.equal(heavy.display_color, "#3F7D2A");
    assert.equal(foliage.display_color, "#6FA84A");
    const buildingColors = new Set(colors.concat([BUILDING_NEUTRAL_COLOR]));
    assert.equal(buildingColors.has(heavy.display_color), false);
    assert.equal(buildingColors.has(foliage.display_color), false);
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    assert.equal(html.includes("building-legend"), false);
    assert.equal(html.includes("height-color"), false);
    assert.equal(app.includes("building-legend"), false);
    assert.equal(app.includes("height-color"), false);
    assert.match(app, /color: "#3fb950"/);
  });
});
