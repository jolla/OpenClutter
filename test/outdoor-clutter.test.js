"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame, llToPx } = require("../netlify/lib/geo-frame");
const { pointInRing } = require("../netlify/lib/poly-clip");
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
  featuresFromMapXml,
  limitFeatures,
  fitOutdoorBudget,
  planOutdoor,
  rvBoxes,
  RV_LENGTH_M,
  RV_WIDTH_M,
  RV_HEIGHT_M,
  POLE_CAP,
  OUTDOOR_MISS,
  MONORAIL_WIDTH_M,
  RAIL_WIDTH_M,
  MONORAIL_DECK_M,
  GUIDEWAY_THICK_M,
  BRIDGE_DECK_M,
  BRIDGE_THICK_M,
} = require("../netlify/lib/outdoor-clutter");
const { detailFromMapXml } = require("../netlify/lib/building-shape");
const { MAX_OI_RING_VERTS } = require("../netlify/lib/pipeline");

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

function meterSpan(area, mpu) {
  const pts = area.area.coordinates.filter((c) => c.coordinate_xyz.unit === "pixels");
  const scale = mpu > 0 ? mpu : 1;
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
  return {
    w: (maxX - minX) * scale,
    h: (maxY - minY) * scale,
    short: Math.min(maxX - minX, maxY - minY) * scale,
  };
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
      ["water", 0, "Water 0.1", 0.1, "#3D7EA6", false],
      ["guideway", 4.5, "Guideway 4.5", 9, "#6A6560", false],
      ["bridge", 2.1, "Bridge 2.1", 9, "#736E68", false],
      ["rv", 3.5, "RV 3.5", 18, "#8A9098", false],
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

  it("seats water 0.1 m above the terrain and does not emit a negative height", () => {
    const f = frame();
    const ring = [
      [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.55],
      [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.55],
      [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.85],
      [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.85],
      [f.west + (f.east - f.west) * 0.55, f.south + (f.north - f.south) * 0.55],
    ];
    const seated = planOutdoor({
      features: [{ kind: "water", coords: ring, heightM: 2.1, explicitHeight: false }],
      frame: f,
      slopeTop: { seat: () => 6.4 },
    });
    assert.equal(seated.items.length, 1);
    const mat = seated.items[0].material;
    assert.equal(mat.name, "Water 0.1 @ 6.4");
    assert.equal(mat.bottom_height, 6.4);
    assert.equal(mat.top_height, 6.5);
    assert.equal(mat.rf_properties.attenuation_per_m, 0.1);
    assert.ok(mat.top_height > 0);
    assert.ok(mat.bottom_height > 0);
    assert.deepEqual(canonicalAreaMaterial(mat), mat);
    const buried = {
      name: "Water 0.1",
      rf_properties: { attenuation_per_m: 0.1 },
      top_height: -0.2,
      display_color: "#3D7EA6",
    };
    assert.equal(canonicalAreaMaterial(buried), null);
    const zeroBottom = outdoorMaterial("water", 0);
    assert.equal("bottom_height" in zeroBottom, false);
    assert.equal(zeroBottom.top_height, 0.1);
  });

  it("cuts a water sheet off an emitted roof and keeps the pond beside it", () => {
    const f = frame();
    const span = (xa, ya, xb, yb) => [
      [f.west + (f.east - f.west) * xa, f.south + (f.north - f.south) * ya],
      [f.west + (f.east - f.west) * xb, f.south + (f.north - f.south) * ya],
      [f.west + (f.east - f.west) * xb, f.south + (f.north - f.south) * yb],
      [f.west + (f.east - f.west) * xa, f.south + (f.north - f.south) * yb],
      [f.west + (f.east - f.west) * xa, f.south + (f.north - f.south) * ya],
    ];
    const roof = span(0.48, 0.48, 0.62, 0.66);
    const planned = planOutdoor({
      features: [{ kind: "water", coords: span(0.35, 0.35, 0.8, 0.8), heightM: 0.1, explicitHeight: false }],
      frame: f,
      buildings: [{ ringPx: roof.map((p) => llToPx(p[0], p[1], f)) }],
    });
    assert.ok(planned.items.length >= 1);
    const roofCenter = llToPx(
      f.west + (f.east - f.west) * 0.55,
      f.south + (f.north - f.south) * 0.57,
      f
    );
    const pond = llToPx(
      f.west + (f.east - f.west) * 0.72,
      f.south + (f.north - f.south) * 0.72,
      f
    );
    assert.equal(
      planned.items.some((item) => pointInRing(roofCenter, item.ringPx)),
      false
    );
    assert.equal(
      planned.items.some((item) => pointInRing(pond, item.ringPx)),
      true
    );
    const covered = planOutdoor({
      features: [{ kind: "water", coords: span(0.5, 0.5, 0.6, 0.62), heightM: 0.1, explicitHeight: false }],
      frame: f,
      buildings: [{ ringPx: span(0.42, 0.42, 0.7, 0.72).map((p) => llToPx(p[0], p[1], f)) }],
    });
    assert.equal(covered.items.length, 0);
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
    assert.equal(water.area_material.top_height, 0.1);
    assert.equal("bottom_height" in water.area_material, false);
    assert.equal(parking.area_material.name, "Parking 9.0");
    assert.equal(parking.area_material.rf_properties.attenuation_per_m, 2);
    assert.equal(fence.area_material.name, "Fence 2.1");
    assert.equal(fence.area_material.rf_properties.attenuation_per_m, 1);
    assert.ok(meterSpan(fence, f.mpuX).short < 1, "fence short side " + meterSpan(fence, f.mpuX).short);
    assert.ok(meterSpan(fence, f.mpuX).short > 0.05);
    assert.equal(wall.area_material.rf_properties.attenuation_per_m, 8);
    assert.ok(meterSpan(wall, f.mpuX).short < 1);
    assert.equal(pole.area_material.name, "Light pole 9.0");
    assert.equal(pole.area_material.rf_properties.attenuation_per_m, 10);
    assert.ok(meterSpan(pole, f.mpuX).short < 0.6);
    const polePx = pole.area.coordinates.filter((c) => c.coordinate_xyz.unit === "pixels");
    assert.equal(polePx.length, 11);
    assert.match(built.stats.summary, /Water 1\. Parking 1\. Walls 2\. Poles 1\./);
    assert.equal(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)), true);
    assert.equal(/did not finish|timed out/i.test(warnings.join(" ")), false);
  });

  it("keeps water off a roof when parking is off", () => {
    const f = frame();
    const x0 = f.west + (f.east - f.west) * 0.4;
    const x1 = f.west + (f.east - f.west) * 0.58;
    const y0 = f.south + (f.north - f.south) * 0.4;
    const y1 = f.south + (f.north - f.south) * 0.58;
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [square(x0, y0, x1, y1, { height: 18 })] },
      name: "WaterCut",
      warnings: [],
      includeWater: true,
      includeParking: false,
      outdoorFeatures: [
        {
          kind: "water",
          coords: [
            [f.west + (f.east - f.west) * 0.28, f.south + (f.north - f.south) * 0.28],
            [f.west + (f.east - f.west) * 0.78, f.south + (f.north - f.south) * 0.28],
            [f.west + (f.east - f.west) * 0.78, f.south + (f.north - f.south) * 0.78],
            [f.west + (f.east - f.west) * 0.28, f.south + (f.north - f.south) * 0.78],
            [f.west + (f.east - f.west) * 0.28, f.south + (f.north - f.south) * 0.28],
          ],
          heightM: 0.1,
          explicitHeight: false,
        },
      ],
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const water = areas.filter((a) => a.area_material && String(a.area_material.name).indexOf("Water") === 0);
    assert.equal(built.stats.waterAreas, water.length);
    assert.ok(water.length >= 1);
    const roofCenter = llToPx((x0 + x1) / 2, (y0 + y1) / 2, f);
    const pond = llToPx(
      f.west + (f.east - f.west) * 0.7,
      f.south + (f.north - f.south) * 0.7,
      f
    );
    const rings = water.map((a) =>
      a.area.coordinates
        .filter((c) => c.coordinate_xyz.unit === "pixels")
        .map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y])
    );
    assert.equal(rings.some((ring) => pointInRing(roofCenter, ring)), false);
    assert.equal(rings.some((ring) => pointInRing(pond, ring)), true);
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
    const partial = fitOutdoorBudget(
      [{ id: "w1" }, { id: "w2" }, { id: "w3" }],
      ["water", "water", "water"],
      2
    );
    assert.equal(partial.items.length, 2);
    assert.match(partial.notes.join(" "), /1 water area did not fit in the area budget \(2 kept\)/);
    assert.equal(/did not finish|timed out/i.test(OUTDOOR_MISS), false);
  });

  it("reads a map extract and closes a lake shore on the water side", () => {
    const bbox = { west: -73.8285, south: 45.4272, east: -73.8239, north: 45.4305 };
    const xml = [
      "<osm>",
      '<node id="1" lat="45.428266" lon="-73.840000"/>',
      '<node id="2" lat="45.428266" lon="-73.8284748"/>',
      '<node id="3" lat="45.42780" lon="-73.82740"/>',
      '<node id="4" lat="45.4274302" lon="-73.8261874"/>',
      '<node id="5" lat="45.420000" lon="-73.820000"/>',
      '<node id="6" lat="45.4290" lon="-73.8260"><tag k="highway" v="street_lamp"/></node>',
      '<node id="7" lat="45.4292" lon="-73.8262"/>',
      '<node id="8" lat="45.4292" lon="-73.8256"/>',
      '<node id="9" lat="45.4288" lon="-73.8256"/>',
      '<node id="10" lat="45.4288" lon="-73.8262"/>',
      '<way id="20"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/>',
      '<tag k="natural" v="coastline"/></way>',
      '<way id="21"><nd ref="7"/><nd ref="8"/><nd ref="9"/><nd ref="10"/><nd ref="7"/>',
      '<tag k="building" v="parking"/><tag k="height" v="9"/></way>',
      '<way id="22"><nd ref="2"/><nd ref="3"/>',
      '<tag k="barrier" v="fence"/><tag k="height" v="1.8"/></way>',
      '<relation id="30"><member type="way" ref="20" role="outer"/>',
      '<tag k="type" v="multipolygon"/><tag k="natural" v="water"/><tag k="name" v="Lac"/></relation>',
      "</osm>",
    ].join("");
    const parsed = featuresFromMapXml(xml, { water: true, parking: true, walls: true, poles: true }, bbox);
    const water = parsed.features.filter((f) => f.kind === "water");
    const parking = parsed.features.filter((f) => f.kind === "parking");
    const fence = parsed.features.filter((f) => f.kind === "fence");
    const poles = parsed.features.filter((f) => f.kind === "pole");
    assert.equal(water.length, 1);
    assert.equal(parking.length, 1);
    assert.equal(parking[0].heightM, 9);
    assert.equal(fence.length, 1);
    assert.equal(fence[0].heightM, 2.1);
    assert.equal(poles.length, 1);
    const ring = water[0].coords;
    function inside(pt, poly) {
      let inn = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = poly[i][1];
        const yj = poly[j][1];
        const xi = poly[i][0];
        const xj = poly[j][0];
        const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
        if (hit) inn = !inn;
      }
      return inn;
    }
    assert.equal(inside([-73.8282, 45.4274], ring), true);
    assert.equal(inside([-73.8242, 45.4302], ring), false);
  });

  it("keeps an elevated guideway and leaves ground rail out", () => {
    const f = frame();
    const midLat = (f.south + f.north) / 2;
    const x0 = f.west + (f.east - f.west) * 0.15;
    const x1 = f.west + (f.east - f.west) * 0.8;
    const yRail = f.south + (f.north - f.south) * 0.25;
    function line(tags, lat) {
      return {
        type: "way",
        tags,
        geometry: [
          { lon: x0, lat },
          { lon: x1, lat },
        ],
      };
    }
    const parsed = parseOverpass(
      {
        elements: [
          line({ railway: "monorail", bridge: "viaduct", layer: "2", name: "Las Vegas Monorail" }, midLat),
          line({ railway: "rail" }, yRail),
          line({ railway: "light_rail" }, yRail + (f.north - f.south) * 0.05),
          line({ railway: "light_rail", bridge: "yes", tracks: "2" }, yRail + (f.north - f.south) * 0.12),
          line({ railway: "tram", layer: "1" }, yRail + (f.north - f.south) * 0.18),
          line({ railway: "monorail", tunnel: "yes" }, yRail + (f.north - f.south) * 0.24),
          line({ railway: "subway", layer: "-1" }, yRail + (f.north - f.south) * 0.3),
          line({ railway: "rail", bridge: "viaduct", min_height: "9", height: "14" }, yRail + (f.north - f.south) * 0.36),
        ],
      },
      { water: false, parking: false, walls: false, poles: false },
      f
    );
    const guides = parsed.features.filter((feat) => feat.kind === "guideway");
    assert.equal(guides.length, 4);
    const mono = guides.find((feat) => feat.deckM === MONORAIL_DECK_M && feat.widthM === MONORAIL_WIDTH_M);
    assert.ok(mono);
    assert.equal(mono.thicknessM, GUIDEWAY_THICK_M);
    assert.equal(mono.closed, false);
    const light = guides.find((feat) => feat.widthM === RAIL_WIDTH_M && feat.deckM === 6);
    assert.ok(light);
    const tram = guides.find((feat) => feat.widthM === RAIL_WIDTH_M && feat.deckM === 6 && feat !== light);
    assert.ok(tram);
    const tagged = guides.find((feat) => feat.deckM === 9);
    assert.ok(tagged);
    assert.equal(tagged.thicknessM, 5);
    assert.equal(parsed.features.some((feat) => feat.kind !== "guideway"), false);
  });

  it("keeps the page toggles on and the counts off the headline", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    for (const id of ["include-water", "include-parking", "include-walls", "include-poles", "include-rvs"]) {
      assert.match(html, new RegExp('id="' + id + '" checked'));
    }
    assert.match(html, />\s*Water\s*</);
    assert.match(html, />\s*Parking\s*</);
    assert.match(html, />\s*Walls\s*</);
    assert.match(html, />\s*Poles\s*</);
    assert.match(app, /includeWater: clutterChecked\("include-water"\)/);
    assert.match(app, /includePoles: clutterChecked\("include-poles"\)/);
    assert.match(app, /includeRvs: clutterChecked\("include-rvs"\)/);
    assert.match(app, /function clutterChecked\(id\) \{\n  const input = document\.getElementById\(id\);\n  if \(!input\) return true;/);
    assert.match(html, />\s*RVs\s*</);
    const headline = app.slice(app.indexOf("function exportHeadline"), app.indexOf("function setCopyNote"));
    assert.equal(/guideway/i.test(headline), false);
    assert.equal(app.includes("Export did not finish. Try again."), false);
    assert.equal(app.includes("Export failed. Retry."), false);
  });
});

function pixelVerts(area) {
  return area.area.coordinates.filter((c) => c.coordinate_xyz.unit === "pixels").length;
}

describe("elevated rail guideways", () => {
  it("draws a raised monorail strip and a wider light-rail beam", () => {
    const f = frame();
    const midLat = (f.south + f.north) / 2;
    const x0 = f.west + (f.east - f.west) * 0.2;
    const x1 = f.west + (f.east - f.west) * 0.75;
    const monoLat = f.south + (f.north - f.south) * 0.35;
    const railLat = f.south + (f.north - f.south) * 0.62;
    const warnings = [];
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [] },
      name: "Monorail",
      warnings,
      includeGuideways: true,
      guidewayFeatures: [
        {
          kind: "guideway",
          coords: [
            [x0, monoLat],
            [x1, monoLat],
          ],
          closed: false,
          heightM: GUIDEWAY_THICK_M,
          thicknessM: GUIDEWAY_THICK_M,
          deckM: MONORAIL_DECK_M,
          widthM: MONORAIL_WIDTH_M,
          explicitHeight: true,
        },
        {
          kind: "guideway",
          coords: [
            [x0, railLat],
            [x1, railLat],
          ],
          closed: false,
          heightM: GUIDEWAY_THICK_M,
          thicknessM: GUIDEWAY_THICK_M,
          deckM: 6,
          widthM: RAIL_WIDTH_M,
          explicitHeight: true,
        },
      ],
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const strips = areas.filter((a) => String(a.area_material.name).indexOf("Guideway") === 0);
    assert.equal(strips.length, 2);
    assert.equal(built.stats.guidewayAreas, 2);
    assert.match(built.stats.summary, /Guideways 2\./);
    for (let i = 0; i < strips.length; i++) {
      assert.ok(pixelVerts(strips[i]) - 1 <= MAX_OI_RING_VERTS);
      assert.equal(strips[i].area_material.rf_properties.attenuation_per_m, 9);
      const canon = canonicalAreaMaterial(strips[i].area_material);
      assert.deepEqual(canon, strips[i].area_material);
    }
    const mono = strips.find((a) => a.area_material.bottom_height === MONORAIL_DECK_M);
    const rail = strips.find((a) => a.area_material.bottom_height === 6);
    assert.equal(mono.area_material.name, "Guideway 4.5 @ 6.5");
    assert.equal(mono.area_material.top_height, 11);
    assert.ok(meterSpan(mono, f.mpuX).short > 2.2 && meterSpan(mono, f.mpuX).short < 4.2, "monorail width " + meterSpan(mono, f.mpuX).short);
    assert.equal(rail.area_material.name, "Guideway 4.5 @ 6.0");
    assert.equal(rail.area_material.top_height, 10.5);
    assert.ok(meterSpan(rail, f.mpuX).short > 7 && meterSpan(rail, f.mpuX).short < 10.5, "rail width " + meterSpan(rail, f.mpuX).short);
    assert.equal(/Guideway/.test(built.stats.summary.split("Foliage")[0]), false);
  });

  it("seats the beam on the downhill ground and prefers a bridge outline", () => {
    const f = frame();
    const midLat = (f.south + f.north) / 2;
    const x0 = f.west + (f.east - f.west) * 0.25;
    const x1 = f.west + (f.east - f.west) * 0.7;
    const half = (12 / 2) / 110540;
    const poly = [
      [x0, midLat - half],
      [x1, midLat - half],
      [x1, midLat + half],
      [x0, midLat + half],
      [x0, midLat - half],
    ];
    const line = [
      [x0, midLat],
      [(x0 + x1) / 2, midLat],
      [x1, midLat],
    ];
    const parsed = parseOverpass(
      {
        elements: [
          {
            type: "way",
            tags: { railway: "monorail", bridge: "viaduct", layer: "2" },
            geometry: line.map((p) => ({ lon: p[0], lat: p[1] })),
          },
          {
            type: "way",
            tags: { man_made: "bridge", bridge: "viaduct", layer: "2" },
            geometry: poly.map((p) => ({ lon: p[0], lat: p[1] })),
          },
          {
            type: "way",
            tags: { man_made: "bridge", bridge: "yes", "building:min_level": "1", covered: "yes" },
            geometry: [
              [x0, f.south + (f.north - f.south) * 0.05],
              [x1, f.south + (f.north - f.south) * 0.05],
              [x1, f.south + (f.north - f.south) * 0.12],
              [x0, f.south + (f.north - f.south) * 0.12],
              [x0, f.south + (f.north - f.south) * 0.05],
            ].map((p) => ({ lon: p[0], lat: p[1] })),
          },
        ],
      },
      {},
      f
    );
    const guides = parsed.features.filter((feat) => feat.kind === "guideway");
    assert.equal(guides.length, 1);
    assert.equal(guides[0].closed, true);
    const seated = planOutdoor({
      features: guides,
      frame: f,
      slopeTop: { seat: () => 4.2 },
    });
    assert.equal(seated.items.length, 1);
    assert.equal(seated.items[0].material.name, "Guideway 4.5 @ 10.7");
    assert.equal(seated.items[0].material.bottom_height, 10.7);
    assert.equal(seated.items[0].material.top_height, 15.2);
    assert.equal(seated.items[0].material.rf_properties.attenuation_per_m, 9);
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [] },
      name: "Deck",
      guidewayFeatures: guides,
    });
    const area = findArea(built.openintent.floorplans[0].attenuation_areas, "Guideway");
    assert.ok(area);
    const span = meterSpan(area, f.mpuX);
    assert.ok(span.short > 10 && span.short < 14, "deck width " + span.short);
    assert.equal(built.stats.guidewayAreas, 1);
  });

  it("splits a long beam into segments that stay inside the vertex cap", () => {
    const f = frame();
    const coords = [];
    for (let i = 0; i < 25; i++) {
      const t = i / 24;
      coords.push([
        f.west + (f.east - f.west) * (0.08 + 0.84 * t),
        f.south + (f.north - f.south) * (0.4 + 0.08 * Math.sin(t * Math.PI * 2)),
      ]);
    }
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [] },
      name: "Long beam",
      includeGuideways: true,
      guidewayFeatures: [
        {
          kind: "guideway",
          coords,
          closed: false,
          heightM: 4.5,
          thicknessM: 4.5,
          deckM: 6.5,
          widthM: 3,
          explicitHeight: true,
        },
      ],
    });
    assert.ok(built.stats.guidewayAreas >= 2, "segments " + built.stats.guidewayAreas);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.length, built.stats.guidewayAreas);
    for (let i = 0; i < areas.length; i++) {
      assert.ok(pixelVerts(areas[i]) - 1 <= MAX_OI_RING_VERTS);
      assert.equal(areas[i].area_material.bottom_height, 6.5);
      assert.equal(areas[i].area_material.top_height, 11);
    }
    assert.match(built.stats.summary, new RegExp("Guideways " + built.stats.guidewayAreas + "\\."));
  });

  it("keeps guideways ahead of poles and behind buildings", () => {
    const f = frame();
    const x0 = f.west + (f.east - f.west) * 0.3;
    const x1 = f.west + (f.east - f.west) * 0.5;
    const y0 = f.south + (f.north - f.south) * 0.3;
    const y1 = f.south + (f.north - f.south) * 0.5;
    const guide = {
      kind: "guideway",
      coords: [
        [f.west + (f.east - f.west) * 0.15, (f.south + f.north) / 2],
        [f.west + (f.east - f.west) * 0.85, (f.south + f.north) / 2],
      ],
      closed: false,
      heightM: 4.5,
      thicknessM: 4.5,
      deckM: 6.5,
      widthM: 3,
      explicitHeight: true,
    };
    const pole = {
      kind: "pole",
      coords: [[(f.west + f.east) / 2, f.south + (f.north - f.south) * 0.8]],
      heightM: 9,
      explicitHeight: false,
      rank: 0,
    };
    const fit = fitOutdoorBudget([{ id: "g" }, { id: "p" }], ["guideway", "pole"], 1);
    assert.deepEqual(fit.kinds, ["guideway"]);
    assert.match(fit.notes.join(" "), /Light poles left out/);
    const warnings = [];
    const tight = buildClutter({
      frame: f,
      footprintsGeojson: { features: [square(x0, y0, x1, y1, { height: 12 })] },
      name: "Budget",
      warnings,
      includePoles: true,
      includeGuideways: true,
      maxAttenuationAreas: 2,
      outdoorFeatures: [pole],
      guidewayFeatures: [guide],
    });
    assert.equal(tight.stats.openIntentBuildingAreas, 1);
    assert.equal(tight.stats.guidewayAreas, 1);
    assert.equal(tight.stats.poleAreas, 0);
    assert.match(warnings.join(" "), /Light poles left out/);
    const fullNotes = [];
    const full = buildClutter({
      frame: f,
      footprintsGeojson: { features: [square(x0, y0, x1, y1, { height: 12 })] },
      name: "Full",
      warnings: fullNotes,
      includePoles: true,
      maxAttenuationAreas: 1,
      outdoorFeatures: [pole],
      guidewayFeatures: [guide],
    });
    assert.equal(full.stats.openIntentBuildingAreas, 1);
    assert.equal(full.stats.guidewayAreas, 0);
    assert.equal(full.stats.poleAreas, 0);
    assert.match(fullNotes.join(" "), /Guideways left out/);
  });

  it("keeps the guideway when trees would otherwise fill the area cap", () => {
    const w = 48;
    const h = 48;
    const cell = 2.2;
    const values = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 30, y - 30) <= 3.4) values[y * w + x] = 16;
      }
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
    const f = geoFrame({ west, south, east: grid.east, north: grid.north, name: "Tree first" });
    const guide = {
      kind: "guideway",
      coords: [
        [f.west + (f.east - f.west) * 0.15, f.south + (f.north - f.south) * 0.7],
        [f.west + (f.east - f.west) * 0.85, f.south + (f.north - f.south) * 0.7],
      ],
      closed: false,
      heightM: 4.5,
      thicknessM: 4.5,
      deckM: 6.5,
      widthM: 3,
      explicitHeight: true,
    };
    const base = {
      frame: f,
      footprintsGeojson: { features: [] },
      name: "Tree first",
      includeFoliage: true,
      chmGrid: grid,
      treesSource: "chm",
      guidewayFeatures: [guide],
    };
    const wide = buildClutter(Object.assign({}, base, { maxAttenuationAreas: 982 }));
    assert.ok(wide.stats.openIntentTreeAreas >= 1);
    assert.ok(wide.stats.guidewayAreas >= 1);
    const notes = [];
    const tight = buildClutter(
      Object.assign({}, base, {
        maxAttenuationAreas: wide.stats.openIntentBuildingAreas + wide.stats.openIntentTreeAreas,
        warnings: notes,
      })
    );
    assert.ok(tight.stats.guidewayAreas >= 1, "the beam keeps a slot the trees would have taken");
    assert.ok(tight.stats.openIntentTreeAreas < wide.stats.openIntentTreeAreas);
    if (tight.stats.guidewayAreas < wide.stats.guidewayAreas) {
      assert.match(notes.join(" "), /did not fit in the area budget/);
    }
  });

  it("reads the monorail from the same map extract as building parts", () => {
    const bbox = { west: -115.17, south: 36.119, east: -115.16, north: 36.124 };
    const xml = [
      "<osm>",
      '<node id="1" lat="36.1210" lon="-115.1680"/>',
      '<node id="2" lat="36.1212" lon="-115.1640"/>',
      '<node id="3" lat="36.1214" lon="-115.1610"/>',
      '<node id="4" lat="36.1200" lon="-115.1660"/>',
      '<node id="5" lat="36.1202" lon="-115.1630"/>',
      '<way id="43875943">',
      '<nd ref="1"/><nd ref="2"/><nd ref="3"/>',
      '<tag k="railway" v="monorail"/>',
      '<tag k="bridge" v="viaduct"/>',
      '<tag k="layer" v="2"/>',
      '<tag k="name" v="Las Vegas Monorail"/>',
      "</way>",
      '<way id="99">',
      '<nd ref="4"/><nd ref="5"/>',
      '<tag k="railway" v="rail"/>',
      "</way>",
      "</osm>",
    ].join("");
    const detail = detailFromMapXml(xml, bbox);
    assert.equal(detail.guideways.length, 1);
    assert.equal(detail.guideways[0].widthM, 3);
    assert.equal(detail.guideways[0].deckM, 6.5);
    assert.equal(detail.guideways[0].thicknessM, 4.5);
    const outdoor = featuresFromMapXml(xml, { water: true, parking: true, walls: true, poles: true }, bbox);
    assert.equal(outdoor.features.filter((feat) => feat.kind === "guideway").length, 1);
  });

  it("draws a raised road deck, skips a culvert and a short span, and keeps a thin footbridge", () => {
    const f = frame();
    const y = f.south + (f.north - f.south) * 0.4;
    const x0 = f.west + (f.east - f.west) * 0.12;
    const x1 = f.west + (f.east - f.west) * 0.82;
    const mid = (x0 + x1) / 2;
    const mLon = 111320 * Math.cos((y * Math.PI) / 180);
    const shortX1 = x0 + 8 / mLon;
    const yLink = f.south + (f.north - f.south) * 0.55;
    const yFoot = f.south + (f.north - f.south) * 0.7;
    const yCulvert = f.south + (f.north - f.south) * 0.25;
    const geom = (pts) => pts.map((p) => ({ lon: p[0], lat: p[1] }));
    const parsed = parseOverpass(
      {
        elements: [
          {
            type: "way",
            tags: { highway: "primary", bridge: "viaduct", layer: "1", lanes: "3", name: "Wilbur Clark D.I. Road" },
            geometry: geom([[x0, y], [mid, y], [x1, y]]),
          },
          {
            type: "way",
            tags: { highway: "motorway_link", bridge: "yes", layer: "2" },
            geometry: geom([[x0, yLink], [x1, yLink]]),
          },
          {
            type: "way",
            tags: { highway: "service", bridge: "culvert", layer: "1" },
            geometry: geom([[x0, yCulvert], [x1, yCulvert]]),
          },
          {
            type: "way",
            tags: { highway: "service", bridge: "yes", layer: "1" },
            geometry: geom([[x0, y], [shortX1, y]]),
          },
          {
            type: "way",
            tags: { highway: "footway", bridge: "yes", layer: "1" },
            geometry: geom([[x0, yFoot], [x1, yFoot]]),
          },
        ],
      },
      { water: true, parking: true, walls: true, poles: true },
      f
    );
    const bridges = parsed.features.filter((feat) => feat.kind === "bridge");
    const roads = bridges.filter((feat) => !feat.foot);
    const feet = bridges.filter((feat) => feat.foot);
    assert.equal(roads.length, 2, "roads " + roads.map((b) => b.widthM + "@" + b.deckM).join(","));
    assert.equal(feet.length, 1);
    const primary = roads.find((feat) => feat.deckM === BRIDGE_DECK_M);
    const link = roads.find((feat) => feat.deckM === BRIDGE_DECK_M * 2);
    assert.equal(primary.widthM, 12.5);
    assert.equal(primary.thicknessM, BRIDGE_THICK_M);
    assert.equal(link.widthM, 6);
    assert.equal(feet[0].widthM, 2.5);
    const built = buildClutter({
      frame: f,
      footprintsGeojson: { features: [] },
      name: "Overpass",
      includeBridges: true,
      bridgeFeatures: [primary],
    });
    const area = findArea(built.openintent.floorplans[0].attenuation_areas, "Bridge");
    assert.ok(area);
    assert.equal(area.area_material.name, "Bridge 2.1 @ 6.5");
    assert.equal(area.area_material.bottom_height, 6.5);
    assert.equal(area.area_material.top_height, 8.6);
    assert.equal(area.area_material.rf_properties.attenuation_per_m, 9);
    assert.equal(canonicalAreaMaterial(area.area_material).name, area.area_material.name);
    const span = meterSpan(area, f.mpuX);
    assert.ok(span.short > 11 && span.short < 14.5, "deck width " + span.short);
    assert.equal(built.stats.bridgeAreas, 1);
    assert.match(built.stats.summary, /Bridges 1\./);
    assert.match(built.stats.summary, /Byte budget 3\.80 MB\. Sanity cap 5000\./);
  });

  it("fills extra slots above 982 with buildings, trees, bridges, and guideways", () => {
    const f = frame();
    const cols = 36;
    const rows = 32;
    const lonSpan = (f.east - f.west) / cols;
    const latSpan = (f.north - f.south) / rows;
    const features = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r >= rows - 8 && c < 8) continue;
        const lon = f.west + c * lonSpan + lonSpan * 0.12;
        const lat = f.south + r * latSpan + latSpan * 0.12;
        features.push(square(lon, lat, lon + lonSpan * 0.62, lat + latSpan * 0.62, { height: 10 + (c % 7) }));
      }
    }
    const yGuide = f.south + (f.north - f.south) * 0.2;
    const yBridge = f.south + (f.north - f.south) * 0.8;
    const x0 = f.west + (f.east - f.west) * 0.08;
    const x1 = f.west + (f.east - f.west) * 0.92;
    const guide = {
      kind: "guideway",
      coords: [
        [x0, yGuide],
        [x1, yGuide],
      ],
      closed: false,
      heightM: 4.5,
      thicknessM: 4.5,
      deckM: 6.5,
      widthM: 3,
      explicitHeight: true,
    };
    const bridge = {
      kind: "bridge",
      coords: [
        [x0, yBridge],
        [x1, yBridge],
      ],
      closed: false,
      widthM: 12,
      deckM: 6.5,
      foot: false,
    };
    const w = 48;
    const h = 48;
    const values = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 3, y - 2) <= 2.2) values[y * w + x] = 16;
      }
    }
    const grid = {
      west: f.west,
      south: f.south,
      east: f.east,
      north: f.north,
      width: w,
      height: h,
      values,
    };
    const base = {
      frame: f,
      footprintsGeojson: { features },
      name: "Cap",
      includeFoliage: true,
      chmGrid: grid,
      treesSource: "chm",
      includeGuideways: true,
      includeBridges: true,
      guidewayFeatures: [guide],
      bridgeFeatures: [bridge],
    };
    const tight = buildClutter(Object.assign({}, base, { maxAttenuationAreas: 982 }));
    const wide = buildClutter(
      Object.assign({}, base, { maxAttenuationAreas: 1500, areaCapOverride: true })
    );
    assert.ok(tight.stats.openIntentBuildingAreas >= 900, "tight buildings " + tight.stats.openIntentBuildingAreas);
    assert.equal(tight.stats.guidewayAreas, 0);
    assert.equal(tight.stats.bridgeAreas, 0);
    assert.equal(tight.stats.openIntentTreeAreas, 0);
    assert.ok(wide.stats.openIntentBuildingAreas > tight.stats.openIntentBuildingAreas);
    assert.ok(wide.stats.guidewayAreas > tight.stats.guidewayAreas);
    assert.ok(wide.stats.bridgeAreas > tight.stats.bridgeAreas);
    assert.ok(wide.stats.openIntentTreeAreas > tight.stats.openIntentTreeAreas);
    assert.ok(wide.stats.attenuationAreasEmitted > tight.stats.attenuationAreasEmitted);
    assert.ok(wide.stats.attenuationAreasEmitted <= 1500);
    assert.match(wide.stats.summary, /Area cap 1500 \(test override\)\./);
    assert.match(tight.stats.summary, /Area cap 982\./);
    assert.match(wide.stats.summary, new RegExp("Buildings " + wide.stats.openIntentBuildingAreas + " kept"));
    assert.equal(
      wide.stats.openIntentBuildingAreas +
        wide.stats.openIntentTreeAreas +
        wide.stats.guidewayAreas +
        wide.stats.bridgeAreas,
      wide.stats.attenuationAreasEmitted
    );
    assert.equal(/test override/.test(tight.stats.summary), false);
  });
});

function metersAt(lat) {
  return {
    mLon: 111320 * Math.cos((lat * Math.PI) / 180),
    mLat: 110540,
  };
}

function siteRing(lon, lat, widthM, heightM) {
  const m = metersAt(lat);
  const dLon = widthM / m.mLon;
  const dLat = heightM / m.mLat;
  return [
    [lon, lat],
    [lon + dLon, lat],
    [lon + dLon, lat + dLat],
    [lon, lat + dLat],
    [lon, lat],
  ];
}

function boxSizeM(ring) {
  const lat = ring[0][1];
  const m = metersAt(lat);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    const x = ring[i][0] * m.mLon;
    const y = ring[i][1] * m.mLat;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { length: maxX - minX, width: maxY - minY };
}

describe("RV pitches and service-road rows", () => {
  const lat = 36.12;
  const lon = -115.16;
  const site = siteRing(lon, lat, 220, 80);

  it("asks Overpass for sites, pitches, and service roads only when RVs are on", () => {
    const on = overpassQuery(BOX, { rvs: true });
    assert.match(on, /tourism"="caravan_site"/);
    assert.match(on, /tourism"="camp_site"/);
    assert.match(on, /tourism"="camp_pitch"/);
    assert.match(on, /highway/);
    const off = overpassQuery(BOX, { water: true });
    assert.equal(/camp_pitch/.test(off), false);
    assert.equal(/caravan_site/.test(off), false);
  });

  it("drops one metal box on each pitch and lines it up with the road", () => {
    const m = metersAt(lat);
    const road = [
      [lon + 20 / m.mLon, lat + 40 / m.mLat],
      [lon + 180 / m.mLon, lat + 40 / m.mLat],
    ];
    const pitches = [];
    for (let i = 0; i < 4; i++) {
      pitches.push({
        kind: "rv-pitch",
        coords: [[lon + (40 + i * 30) / m.mLon, lat + 48 / m.mLat]],
      });
    }
    pitches.push({
      kind: "rv-pitch",
      coords: [[lon - 50 / m.mLon, lat]],
    });
    const boxes = rvBoxes(
      [{ kind: "rv-site", coords: site, holes: [] }, { kind: "rv-road", coords: road }].concat(pitches)
    );
    assert.equal(boxes.length, 4);
    for (let i = 0; i < boxes.length; i++) {
      const size = boxSizeM(boxes[i].coords);
      assert.ok(Math.abs(size.length - RV_LENGTH_M) < 0.2, "length " + size.length);
      assert.ok(Math.abs(size.width - RV_WIDTH_M) < 0.2, "width " + size.width);
      assert.equal(boxes[i].heightM, RV_HEIGHT_M);
    }
    const parsed = parseOverpass(
      {
        elements: [
          {
            type: "way",
            tags: { tourism: "caravan_site", name: "Oasis" },
            geometry: site.map((p) => ({ lon: p[0], lat: p[1] })),
          },
          {
            type: "way",
            tags: { highway: "service" },
            geometry: road.map((p) => ({ lon: p[0], lat: p[1] })),
          },
          {
            type: "node",
            lon: pitches[0].coords[0][0],
            lat: pitches[0].coords[0][1],
            tags: { tourism: "camp_pitch" },
          },
        ],
      },
      { rvs: true }
    );
    const rvs = parsed.features.filter((f) => f.kind === "rv");
    assert.equal(rvs.length, 1);
    const planned = planOutdoor({
      features: rvs,
      frame: frame(),
      buildings: [],
    });
    assert.equal(planned.items.length, 1);
    assert.equal(planned.items[0].material.name, "RV 3.5");
    assert.equal(planned.items[0].material.rf_properties.attenuation_per_m, 18);
    assert.equal(planned.items[0].thin, true);
  });

  it("grids both sides of the internal road when the site has no pitches", () => {
    const m = metersAt(lat);
    const road = [
      [lon + 10 / m.mLon, lat + 40 / m.mLat],
      [lon + 130 / m.mLon, lat + 40 / m.mLat],
    ];
    const boxes = rvBoxes([
      { kind: "rv-site", coords: site, holes: [] },
      { kind: "rv-road", coords: road },
    ]);
    assert.ok(boxes.length >= 16, "both sides " + boxes.length);
    assert.equal(boxes.length % 2, 0);
    const ys = boxes.map((b) => {
      let s = 0;
      for (let i = 0; i < 4; i++) s += b.coords[i][1];
      return s / 4;
    });
    const north = ys.filter((y) => y > lat + 40 / m.mLat).length;
    const south = ys.filter((y) => y < lat + 40 / m.mLat).length;
    assert.equal(north, south);
    assert.ok(north >= 8);
  });
});
