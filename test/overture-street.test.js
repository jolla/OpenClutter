"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  RELEASE,
  STREET_DEADLINE_MS,
  groupsForThemeBbox,
  tagsFromInfrastructure,
  tagsFromWater,
  tagsFromLand,
  tagsFromLandUse,
  tagsFromSegment,
  flagValues,
  levelFromRules,
  asGeometry,
  wkbToGeom,
  bboxHitsCoords,
  ringHitsBbox,
  elementsFromRows,
  elementsFromGeometry,
} = require("../netlify/lib/overture-street");

const KOA = { west: -112.15926, south: 35.32465, east: -112.15474, north: 35.32957 };
const WAL = { west: -90.5276, south: 41.5786, east: -90.523, north: 41.5823 };

describe("Overture street index", () => {
  it("gives the Azure read 30 seconds before falling back to Overpass", () => {
    assert.equal(STREET_DEADLINE_MS, 30000);
  });

  it("pins the same release as buildings and finds KOA and Walmart row groups", () => {
    assert.equal(RELEASE, "2026-10-21.0");
    const roadKoa = groupsForThemeBbox("segment", KOA);
    const parkWal = groupsForThemeBbox("infrastructure", WAL);
    const landKoa = groupsForThemeBbox("land", KOA);
    assert.ok(roadKoa.length >= 1 && roadKoa.length <= 8, "koa road groups " + roadKoa.length);
    assert.ok(parkWal.length >= 1 && parkWal.length <= 8, "wal infra groups " + parkWal.length);
    assert.ok(landKoa.length >= 1, "koa land groups " + landKoa.length);
    for (const g of roadKoa) {
      assert.ok(g.xmax >= KOA.west && g.xmin <= KOA.east);
      assert.ok(g.ymax >= KOA.south && g.ymin <= KOA.north);
      assert.ok(g.file && g.rowCount > 0);
    }
  });
});

describe("Overture street tag mapping", () => {
  it("copies source_tags for a fence and a parking lot, and skips a power line", () => {
    const fence = tagsFromInfrastructure({
      class: "fence",
      source_tags: { barrier: "fence", height: "1.8" },
    });
    assert.equal(fence.barrier, "fence");
    assert.equal(fence.height, "1.8");
    const parking = tagsFromInfrastructure({ class: "parking", source_tags: { amenity: "parking" } });
    assert.equal(parking.amenity, "parking");
    const lamp = tagsFromInfrastructure({ class: "street_lamp" });
    assert.equal(lamp.highway, "street_lamp");
    const line = tagsFromInfrastructure({ class: "power_line", source_tags: { power: "line" } });
    assert.equal(line, null);
  });

  it("maps water from source_tags or a known class, and skips a label-only class", () => {
    const stream = tagsFromWater({ class: "stream", source_tags: { waterway: "stream" } });
    assert.equal(stream.waterway, "stream");
    const lake = tagsFromWater({ class: "lake" });
    assert.equal(lake.natural, "water");
    assert.equal(lake.water, "lake");
    const physical = tagsFromWater({ class: "physical", subtype: "physical" });
    assert.equal(physical, null);
  });

  it("keeps a mapped wood only when source_tags confirm it", () => {
    const wood = tagsFromLand({
      class: "wood",
      source_tags: { natural: "wood", leaf_type: "needleleaved" },
    });
    assert.equal(wood.natural, "wood");
    assert.equal(wood.leaf_type, "needleleaved");
    const bareForest = tagsFromLandUse({ class: "forest", subtype: "protected" });
    assert.equal(bareForest, null);
    const taggedForest = tagsFromLandUse({ class: "forest", source_tags: { landuse: "forest" } });
    assert.equal(taggedForest.landuse, "forest");
    const piste = tagsFromLandUse({ source_tags: { "piste:type": "downhill" } });
    assert.equal(piste["piste:type"], "downhill");
  });

  it("maps road classes, link flags, bridges, and rail, and skips an unknown non-road", () => {
    const res = tagsFromSegment({ subtype: "road", class: "residential" });
    assert.equal(res.highway, "residential");
    const link = tagsFromSegment({ subtype: "road", class: "motorway", road_flags: { values: ["is_link"] } });
    assert.equal(link.highway, "motorway_link");
    const bridge = tagsFromSegment({
      subtype: "road",
      class: "primary",
      road_flags: ["is_bridge"],
      level_rules: [{ value: 1 }],
    });
    assert.equal(bridge.highway, "primary");
    assert.equal(bridge.bridge, "yes");
    assert.equal(bridge.layer, "1");
    const rail = tagsFromSegment({ subtype: "rail", class: "light_rail" });
    assert.equal(rail.railway, "light_rail");
    const unknownRoad = tagsFromSegment({ subtype: "road", class: "unknown" });
    assert.equal(unknownRoad.highway, "unclassified");
    const skip = tagsFromSegment({ subtype: "water", class: "ferry" });
    assert.equal(skip, null);
  });

  it("reads road flag objects and level rules", () => {
    assert.deepEqual(flagValues({ values: ["is_link", "is_bridge"] }), ["is_link", "is_bridge"]);
    assert.deepEqual(flagValues(["is_tunnel"]), ["is_tunnel"]);
    assert.equal(levelFromRules([{ value: 0 }, { value: 2 }]), 2);
    assert.equal(levelFromRules([{ value: -1 }]), -1);
  });
});

describe("Overture street geometry", () => {
  it("turns a line and a ring into Overpass-shaped elements that hit the bbox", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [-112.16, 35.326],
        [-112.155, 35.326],
      ],
    };
    const els = elementsFromGeometry("r1", { highway: "residential" }, line, KOA);
    assert.equal(els.length, 1);
    assert.equal(els[0].type, "way");
    assert.equal(els[0].tags.highway, "residential");
    assert.equal(els[0].geometry.length, 2);
    assert.equal(els[0].geometry[0].lon, -112.16);
    const poly = {
      type: "Polygon",
      coordinates: [[
        [-112.158, 35.326],
        [-112.157, 35.326],
        [-112.157, 35.327],
        [-112.158, 35.327],
        [-112.158, 35.326],
      ]],
    };
    const ponds = elementsFromGeometry("w1", { natural: "water" }, poly, KOA);
    assert.equal(ponds.length, 1);
    assert.equal(ponds[0].type, "way");
    assert.ok(bboxHitsCoords(poly.coordinates[0], KOA));
  });

  it("decodes little-endian WKB points", () => {
    const buf = Buffer.alloc(21);
    buf.writeUInt8(1, 0);
    buf.writeUInt32LE(1, 1);
    buf.writeDoubleLE(-90.525, 5);
    buf.writeDoubleLE(41.58, 13);
    const g = wkbToGeom(buf);
    assert.equal(g.type, "Point");
    assert.equal(Math.round(g.coordinates[0] * 1000), -90525);
    assert.equal(Math.round(g.coordinates[1] * 100), 4158);
    const viaAs = asGeometry(buf);
    assert.equal(viaAs.type, "Point");
  });

  it("drops rows whose class is unused even when geometry is present", () => {
    const els = elementsFromRows(
      "infrastructure",
      [
        {
          id: "p1",
          class: "power_line",
          bbox: { xmin: -90.526, xmax: -90.525, ymin: 41.58, ymax: 41.581 },
          geometry: { type: "LineString", coordinates: [[-90.526, 41.58], [-90.525, 41.581]] },
        },
        {
          id: "pk1",
          class: "parking",
          source_tags: { amenity: "parking" },
          bbox: { xmin: -90.526, xmax: -90.525, ymin: 41.58, ymax: 41.581 },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [-90.526, 41.58],
              [-90.525, 41.58],
              [-90.525, 41.581],
              [-90.526, 41.581],
              [-90.526, 41.58],
            ]],
          },
        },
      ],
      WAL
    );
    assert.equal(els.length, 1);
    assert.equal(els[0].tags.amenity, "parking");
  });

  it("keeps a wood that only covers the south-west corner of the draw", () => {
    const poly = {
      type: "Polygon",
      coordinates: [[
        [-112.1595, 35.3244],
        [-112.1590, 35.3244],
        [-112.1590, 35.3248],
        [-112.1595, 35.3248],
        [-112.1595, 35.3244],
      ]],
    };
    const els = elementsFromGeometry("wood-sw", { natural: "wood" }, poly, KOA);
    assert.equal(els.length, 1);
    assert.equal(true, ringHitsBbox(poly.coordinates[0], KOA));
  });
});
