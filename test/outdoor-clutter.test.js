"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter } = require("../netlify/lib/pipeline");
const {
  outdoorMaterial,
  canonicalAreaMaterial,
  documentMaterials,
  isPoisonedOiName,
  isVegetationOiName,
} = require("../netlify/lib/materials");
const {
  overpassQuery,
  parseOverpass,
  limitFeatures,
  fitOutdoorBudget,
  POLE_CAP,
  OUTDOOR_MISS,
} = require("../netlify/lib/outdoor-clutter");

const BOX = { west: -73.57, south: 45.5, east: -73.565, north: 45.5035 };

function frame() {
  return geoFrame(BOX, { maxSide: 400, metersPerPx: 0.5 });
}

function square(lon0, lat0, lon1, lat1, props) {
  return {
    type: "Feature",
    properties: props || {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon0, lat0],
          [lon1, lat0],
          [lon1, lat1],
          [lon0, lat1],
          [lon0, lat0],
        ],
      ],
    },
  };
}

function meterSpan(area) {
  const pts = area.area.coordinates.filter((c) => c.coordinate_xyz.unit === "meters");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].coordinate_xyz;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { w: maxX - minX, h: maxY - minY, short: Math.min(maxX - minX, maxY - minY) };
}

function findArea(areas, name) {
  return areas.find((a) => a.area_material && String(a.area_material.name).indexOf(name) === 0);
}

describe("outdoor clutter materials", () => {
  it("documents 5 GHz rates next to the building materials and keeps them canonical", () => {
    const samples = [
      ["parking", 9, "Parking 9.0", 2, "#B0B8C0", false],
      ["wall", 2.5, "Wall 2.5", 8, "#8E8680", false],
      ["fence", 1.8, "Fence 2.1", 1, "#9AA3AD", false],
      ["retaining", 3, "Retaining wall 3.0", 6, "#7A736C", false],
      ["hedge", 2.1, "Hedge 2.1", 1, "#6FA84A", true],
      ["pole", 9, "Light pole 9.0", 10, "#6E7378", false],
      ["water", 0, "Water 2.1", 0.1, "#3D7EA6", false],
    ];
    for (let i = 0; i < samples.length; i++) {
      const [kind, height, name, db, color, transparent] = samples[i];
      const mat = outdoorMaterial(kind, height);
      assert.equal(mat.name, name);
      assert.equal(mat.rf_properties.attenuation_per_m, db);
      assert.equal(mat.display_color, color);
      assert.equal(mat.transparencyEnabled === true, transparent);
      assert.equal("itu_material_type" in mat, false);
      assert.equal(isPoisonedOiName(mat.name), false);
      assert.equal(isVegetationOiName(mat.name), false);
      const canon = canonicalAreaMaterial(mat);
      assert.deepEqual(canon, mat);
      const doc = documentMaterials([{ area_material: mat }]);
      const listed = doc.find((m) => m.name === name);
      assert.deepEqual(listed, mat);
    }
  });
});

describe("outdoor clutter geometry", () => {
  it("draws water, parking, walls, and a capped pole without stretching them to 3 m", () => {
    const f = frame();
    const midLat = (f.south + f.north) / 2;
    const x0 = f.west + (f.east - f.west) * 0.15;
    const x1 = f.west + (f.east - f.west) * 0.4;
    const y0 = f.south + (f.north - f.south) * 0.15;
    const y1 = f.south + (f.north - f.south) * 0.4;
    const warnings = [];
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [square(x0, y0, x1, y1, { height: 12 })] },
      name: "Outdoor",
      warnings,
      includeWater: true,
      includeParking: true,
      includeWalls: true,
      includePoles: true,
      outdoorFeatures: [
        {
          kind: "water",
          coords: [
            [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.55],
            [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.55],
            [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.85],
            [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.85],
            [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.55],
          ],
          heightM: 2.1,
          explicitHeight: false,
        },
        {
          kind: "parking",
          coords: [
            [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.15],
            [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.15],
            [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.4],
            [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.4],
            [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.15],
          ],
          heightM: 9,
          explicitHeight: true,
        },
        {
          kind: "fence",
          coords: [
            [f.west + (f.east - f.west) * 0.2, midLat],
            [f.west + (f.east - f.west) * 0.8, midLat],
          ],
          heightM: 1.8,
          explicitHeight: false,
        },
        {
          kind: "wall",
          coords: [
            [f.west + (f.east - f.west) * 0.5, f.south + (f.north - f.south) * 0.2],
            [f.west + (f.east - f.west) * 0.5, f.south + (f.north - f.south) * 0.8],
          ],
          heightM: 2.5,
          explicitHeight: true,
        },
        {
          kind: "pole",
          coords: [[(f.west + f.east) / 2, (f.south + f.north) / 2 + (f.north - f.south) * 0.05]],
          heightM: 9,
          explicitHeight: false,
          rank: 0,
        },
      ],
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(built.stats.openIntentBuildingAreas, 1);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.equal(areas.length, built.stats.openIntentBuildingAreas + built.stats.openIntentTreeAreas + built.stats.waterAreas + built.stats.parkingAreas + built.stats.wallAreas + built.stats.poleAreas);
    const water = findArea(areas, "Water");
    const parking = findArea(areas, "Parking");
    const fence = findArea(areas, "Fence");
    const wall = findArea(areas, "Wall");
    const pole = findArea(areas, "Light pole");
    assert.equal(water.area_material.rf_properties.attenuation_per_m, 0.1);
    assert.equal(water.area_material.top_height, 2.1);
    assert.equal(parking.area_material.name, "Parking 9.0");
    assert.equal(parking.area_material.rf_properties.attenuation_per_m, 2);
    assert.equal(fence.area_material.name, "Fence 2.1");
    assert.equal(fence.area_material.rf_properties.attenuation_per_m, 1);
    assert.ok(meterSpan(fence).short < 1, "fence short side " + meterSpan(fence).short);
    assert.ok(meterSpan(fence).short > 0.05);
    assert.equal(wall.area_material.rf_properties.attenuation_per_m, 8);
    assert.ok(meterSpan(wall).short < 1);
    assert.equal(pole.area_material.name, "Light pole 9.0");
    assert.equal(pole.area_material.rf_properties.attenuation_per_m, 10);
    assert.ok(meterSpan(pole).short < 0.6);
    const polePx = pole.area.coordinates.filter((c) => c.coordinate_xyz.unit === "pixels");
    assert.equal(polePx.length, 11);
    assert.match(built.stats.summary, /Water 1\. Parking 1\. Walls 2\. Poles 1\./);
    assert.equal(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)), true);
    assert.equal(/did not finish|timed out/i.test(warnings.join(" ")), false);
  });

  it("recolors an overlapping building as parking and does not draw it twice", () => {
    const f = frame();
    const x0 = f.west + (f.east - f.west) * 0.3;
    const x1 = f.west + (f.east - f.west) * 0.55;
    const y0 = f.south + (f.north - f.south) * 0.3;
    const y1 = f.south + (f.north - f.south) * 0.55;
    const ring = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [square(x0, y0, x1, y1, { height: 12 })] },
      name: "Garage",
      includeParking: true,
      outdoorFeatures: [{ kind: "parking", coords: ring, heightM: 12, explicitHeight: true }],
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.length, 1);
    assert.equal(areas[0].area_material.name, "Parking 12.0");
    assert.equal(areas[0].area_material.rf_properties.attenuation_per_m, 2);
    assert.equal(built.stats.parkingAreas, 1);
    assert.equal(built.stats.openIntentBuildingAreas, 1);
  });

  it("recolors an Overture parking class without a second polygon", () => {
    const f = frame();
    const x0 = f.west + (f.east - f.west) * 0.3;
    const x1 = f.west + (f.east - f.west) * 0.55;
    const y0 = f.south + (f.north - f.south) * 0.3;
    const y1 = f.south + (f.north - f.south) * 0.55;
    const built = buildClutter({
      frame: f,
      footprintsGeojson: {
        features: [square(x0, y0, x1, y1, { height: 9, class: "parking" })],
      },
      name: "Class",
      includeParking: true,
      outdoorFeatures: [],
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.length, 1);
    assert.equal(areas[0].area_material.name, "Parking 9.0");
    assert.equal(areas[0].area_material.rf_properties.attenuation_per_m, 2);
  });
});

describe("outdoor clutter fetch", () => {
  it("asks Overpass for the drawn box and caps light poles", () => {
    const q = overpassQuery(BOX, { water: true, parking: true, walls: true, poles: true });
    assert.match(q, /45\.5,-73\.57,45\.5035,-73\.565/);
    assert.match(q, /natural"="water"/);
    assert.match(q, /parking"="multi-storey"/);
    assert.match(q, /building"="parking"/);
    assert.match(q, /barrier"/);
    assert.match(q, /street_lamp"/);
    assert.match(q, /man_made"/);
    const elements = [];
    for (let i = 0; i < 60; i++) {
      const lon = BOX.west + ((i % 10) + 0.5) * (BOX.east - BOX.west) / 10;
      const lat = BOX.south + (Math.floor(i / 10) + 0.5) * (BOX.north - BOX.south) / 6;
      elements.push({ type: "node", lon, lat, tags: { highway: "street_lamp" } });
    }
    elements.push({
      type: "way",
      tags: { barrier: "fence", height: "1.8" },
      geometry: [
        { lon: BOX.west + 0.001, lat: BOX.south + 0.001 },
        { lon: BOX.east - 0.001, lat: BOX.south + 0.001 },
      ],
    });
    const parsed = parseOverpass({ elements }, { water: true, parking: true, walls: true, poles: true }, BOX);
    assert.equal(parsed.features.filter((f) => f.kind === "pole").length, 60);
    assert.equal(parsed.features.find((f) => f.kind === "fence").heightM, 2.1);
    const limited = limitFeatures(parsed.features, BOX);
    const poles = limited.features.filter((f) => f.kind === "pole");
    assert.ok(poles.length <= POLE_CAP);
    assert.ok(poles.length >= 30);
    assert.match(limited.notes.join(" "), /Light poles capped at 48/);
    const fit = fitOutdoorBudget([{ id: "pole" }, { id: "park" }], ["pole", "parking"], 1);
    assert.deepEqual(fit.kinds, ["parking"]);
    assert.match(fit.notes.join(" "), /Light poles left out to stay inside the area budget/);
    assert.equal(/did not finish|timed out/i.test(OUTDOOR_MISS), false);
  });

  it("keeps the page toggles on and the counts off the headline", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    for (const id of ["include-water", "include-parking", "include-walls", "include-poles"]) {
      assert.match(html, new RegExp('id="' + id + '" checked'));
    }
    assert.match(html, />\s*Water\s*</);
    assert.match(html, />\s*Parking\s*</);
    assert.match(html, />\s*Walls\s*</);
    assert.match(html, />\s*Poles\s*</);
    assert.match(app, /includeWater: document\.getElementById\("include-water"\)\.checked/);
    assert.match(app, /includePoles: document\.getElementById\("include-poles"\)\.checked/);
    assert.equal(app.includes("Export did not finish. Try again."), false);
    assert.equal(app.includes("Export failed. Retry."), false);
  });
});
