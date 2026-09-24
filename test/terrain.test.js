"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, cornerClipboard } = require("../netlify/lib/geo-frame");
const {
  terrainFromSamples,
  parseDemSamples,
  terrainBundleFields,
  noteMissingTerrain,
  chooseGrid,
  RAISED_KEYS,
  SLOPED_KEYS,
  TERRAIN_FILENAME,
  MAX_GRID,
  LIFT_RELIEF_M,
  siteWarrantsLift,
} = require("../netlify/lib/terrain");
const { buildClutter } = require("../netlify/lib/pipeline");
const { unzipStore } = require("../netlify/lib/zip-store");
const { canopyHitsGrid } = require("./canopy-grid");
const pasteSample = require("./fixtures/hamina-raised-sloped-clipboard-sample.json");

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Jerry's working Planner Plus paste: open convex CCW quads, not closed GeoJSON rings. */
function assertOpenQuad(ring, dim) {
  assert.equal(ring.length, 4);
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % 4];
    assert.equal(p.length, dim);
    assert.ok(p[0] !== q[0] || p[1] !== q[1]);
    const r = ring[(i + 2) % 4];
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    assert.ok(cross > 0, "convex CCW corner");
  }
  assert.ok(signedArea(ring) > 0);
}

/** Sloped floors are ramps: first edge one z, opposite edge a higher z. */
function assertSlopedRamp(ring) {
  assertOpenQuad(ring, 3);
  assert.equal(ring[0][2], ring[1][2]);
  assert.equal(ring[2][2], ring[3][2]);
  assert.ok(ring[2][2] > ring[0][2]);
  for (const p of ring) assert.ok(p[2] >= 0);
}

function gridSamples(frame, zAt) {
  const samples = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const lon = frame.west + ((c + 0.5) / 6) * (frame.east - frame.west);
      const lat = frame.south + ((r + 0.5) / 6) * (frame.north - frame.south);
      samples.push({ lon, lat, z: zAt(r, c, lon, lat) });
    }
  }
  return samples;
}

function assertFrameSpan(zones, frame) {
  const corners = cornerClipboard(frame);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const z of zones) {
    for (const p of z.area.coordinates[0]) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  assert.ok(Math.abs(maxX - corners.ne[0]) < 0.05, "NE x " + maxX);
  assert.ok(Math.abs(maxY - corners.ne[1]) < 0.05, "NE y " + maxY);
  assert.ok(Math.abs(minX - corners.sw[0]) < 0.05, "SW x " + minX);
  assert.ok(Math.abs(minY - corners.sw[1]) < 0.05, "SW y " + minY);
}

describe("3DEP terrain clipboard", () => {
  it("turns a flat DEM into raisedFloorZones on the clipboard meter frame", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Flat" });
    const terrain = terrainFromSamples(gridSamples(frame, () => 214.2), frame);
    assert.ok(terrain);
    assert.equal(terrain.sloped, 0);
    const [cols, rows] = chooseGrid(terrain.reliefM);
    assert.equal(terrain.raised, cols * rows);
    assert.ok(terrain.raised <= 4);
    assert.equal(terrain.reliefM, 0);
    assert.equal(terrain.clipboard.header.type, "HaminaClipboard");
    assert.equal(terrain.clipboard.attenuatingZones.length, 0);
    assert.equal(terrain.clipboard.slopedFloors.length, 0);
    for (const z of terrain.clipboard.raisedFloorZones) {
      assert.deepEqual(Object.keys(z), RAISED_KEYS);
      assert.equal(z.area.type, "Polygon");
      assert.equal(z.height, 0);
      assert.equal(z.attenuationDbPerMeter, 0);
      assert.equal(z.slabOnly, false);
      assertOpenQuad(z.area.coordinates[0], 2);
    }
    assertFrameSpan(terrain.clipboard.raisedFloorZones, frame);
    const fields = terrainBundleFields(terrain, []);
    assert.equal(fields.terrainFilename, TERRAIN_FILENAME);
    assert.equal(fields.terrainClipboard.raisedFloorZones.length, terrain.raised);
    assert.match(fields.terrainStatus, /Copy terrain/);
    assert.match(fields.terrainStatus, /paste it in Planner Plus/);
    assert.match(fields.terrainStatus, /Do not import it as OpenIntent/);
    assert.equal(/terrain-clipboard\.json/.test(fields.terrainStatus), false);
  });

  it("requests solid floors, not slab-only, on pads and sloped ramps", () => {
    assert.equal(pasteSample.raisedFloorZones[0].slabOnly, false);
    assert.equal(pasteSample.slopedFloors[0].slabOnly, false);
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Solid" });
    const flat = terrainFromSamples(gridSamples(frame, () => 200), frame);
    const sloped = terrainFromSamples(gridSamples(frame, (r) => 180 + r * 8), frame);
    assert.ok(flat.clipboard.raisedFloorZones.length >= 1);
    assert.equal(flat.clipboard.slopedFloors.length, 0);
    for (const z of flat.clipboard.raisedFloorZones) assert.equal(z.slabOnly, false);
    assert.ok(sloped.clipboard.slopedFloors.length >= 1);
    for (const z of sloped.clipboard.slopedFloors) {
      assert.equal(z.slabOnly, false);
      assertSlopedRamp(z.area.coordinates[0]);
    }
    for (const z of sloped.clipboard.raisedFloorZones) assert.equal(z.slabOnly, false);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Solid",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: sloped,
    });
    const readme = unzipStore(built.zip)["README.txt"].toString();
    assert.match(readme, /slabOnly is false/);
    assert.match(readme, /solid floor/);
    const clip = JSON.parse(unzipStore(built.zip)["terrain-clipboard.json"].toString());
    const zones = clip.raisedFloorZones.concat(clip.slopedFloors);
    assert.ok(zones.length >= 1);
    assert.ok(zones.every((z) => z.slabOnly === false));
  });

  it("turns a sloped DEM into slopedFloors with xyz vertices", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Slope" });
    const terrain = terrainFromSamples(
      gridSamples(frame, (r) => 180 + r * 4),
      frame
    );
    assert.ok(terrain);
    assert.ok(terrain.reliefM > 2);
    const [cols, rows] = chooseGrid(terrain.reliefM, frame);
    assert.equal(terrain.raised + terrain.sloped, cols * rows);
    assert.ok(terrain.sloped > 9);
    assert.ok(terrain.sloped <= MAX_GRID * MAX_GRID);
    for (const z of terrain.clipboard.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      assert.equal(z.area.type, "Polygon");
      assert.equal(z.attenuationDbPerMeter, 0);
      assert.equal(z.crowdEnabled, false);
      assert.equal(z.drawStairs, false);
      assert.equal(z.slabOnly, false);
      assert.equal(z.crowdHeight, 0);
      assert.equal(z.crowdAttenuationDbPerMeter, 0);
      assertSlopedRamp(z.area.coordinates[0]);
      const ring = z.area.coordinates[0];
      const lowY = Math.min(ring[0][1], ring[1][1]);
      const highY = Math.min(ring[2][1], ring[3][1]);
      assert.ok(lowY < highY, "north-rising slope starts on the south edge");
    }
    assertFrameSpan(terrain.clipboard.slopedFloors.concat(terrain.clipboard.raisedFloorZones), frame);
  });

  it("notes a soft miss without a terrain file", () => {
    const warnings = [];
    noteMissingTerrain(null, warnings);
    assert.match(warnings[0], /Terrain omitted/);
    noteMissingTerrain(null, warnings);
    assert.equal(warnings.length, 1);
    const fields = terrainBundleFields(null, ["Terrain omitted: timed out"]);
    assert.equal(fields.terrainFilename, null);
    assert.equal(fields.terrainClipboard, null);
    assert.match(fields.terrainStatus, /Terrain omitted: timed out/);
    assert.match(fields.terrainStatus, /OpenIntent zip is unchanged/);
  });

  it("turns a sloped sample grid into a few raised pads or xyz facets", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Oak" });
    const samples = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        samples.push({
          lon: frame.west + ((c + 0.5) / 6) * (frame.east - frame.west),
          lat: frame.south + ((r + 0.5) / 6) * (frame.north - frame.south),
          z: 210 + r * 1.1 + c * 0.15,
        });
      }
    }
    const terrain = terrainFromSamples(samples, frame);
    assert.ok(terrain);
    assert.ok(terrain.reliefM > 2);
    assert.ok(terrain.sloped >= 1);
    const [mildCols, mildRows] = chooseGrid(terrain.reliefM, frame);
    assert.equal(terrain.raised + terrain.sloped, mildCols * mildRows);
    assert.ok(terrain.raised + terrain.sloped <= MAX_GRID * MAX_GRID);
    assert.equal(terrain.clipboard.header.type, "HaminaClipboard");
    assert.equal(terrain.clipboard.attenuatingZones.length, 0);
    for (const z of terrain.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      assert.equal(z.slabOnly, false);
      assert.equal(z.crowdEnabled, false);
      assert.equal(z.drawStairs, false);
      assert.equal(z.attenuationDbPerMeter, 0);
      for (const p of ring) {
        assert.ok(p[0] <= 0.001 && p[0] >= -frame.widthM - 0.01);
        assert.ok(p[1] <= 0.001 && p[1] >= -frame.lengthM - 0.01);
      }
    }
    for (const z of terrain.clipboard.raisedFloorZones) {
      assertOpenQuad(z.area.coordinates[0], 2);
      assert.equal(z.slabOnly, false);
      assert.ok(z.height >= 0);
    }
  });

  it("uses the same open-quad conventions as a paste that Planner Plus accepts", () => {
    for (const z of pasteSample.raisedFloorZones) {
      assert.deepEqual(Object.keys(z), RAISED_KEYS);
      assertOpenQuad(z.area.coordinates[0], 2);
    }
    for (const z of pasteSample.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      assertSlopedRamp(z.area.coordinates[0]);
    }
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "EW" });
    const terrain = terrainFromSamples(
      gridSamples(frame, (r, c) => 150 + c * 3),
      frame
    );
    assert.equal(terrain.raised, 0);
    const [cols, rows] = chooseGrid(terrain.reliefM, frame);
    assert.equal(terrain.sloped, cols * rows);
    assert.ok(terrain.sloped > 9);
    assert.ok(terrain.sloped <= MAX_GRID * MAX_GRID);
    for (const z of terrain.clipboard.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      const lowX = Math.min(ring[0][0], ring[1][0]);
      const highX = Math.min(ring[2][0], ring[3][0]);
      assert.ok(lowX < highX, "east-rising slope starts on the west edge");
    }
    for (const z of terrain.clipboard.raisedFloorZones) assertOpenQuad(z.area.coordinates[0], 2);

    const towardWest = terrainFromSamples(
      gridSamples(frame, (r, c) => 400 - c * 4),
      frame
    );
    assert.ok(towardWest.sloped > 9);
    for (const z of towardWest.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      const lowX = (ring[0][0] + ring[1][0]) / 2;
      const highX = (ring[2][0] + ring[3][0]) / 2;
      assert.ok(lowX > highX, "low edge is the east side");
    }
    const towardSouth = terrainFromSamples(
      gridSamples(frame, (r) => 400 - r * 4),
      frame
    );
    assert.ok(towardSouth.sloped > 9);
    for (const z of towardSouth.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      const lowY = (ring[0][1] + ring[1][1]) / 2;
      const highY = (ring[2][1] + ring[3][1]) / 2;
      assert.ok(lowY > highY, "low edge is the north side");
    }
  });

  it("parses 3DEP getSamples and keeps terrain out of the OpenIntent zip path", () => {
    const parsed = parseDemSamples({
      samples: [
        { location: { x: -87.92, y: 42.9 }, value: "215.2" },
        { location: { x: 0, y: 0 }, value: "nope" },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].z, 215.2);
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "T" });
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push({
        lon: frame.west + (i % 4) * 0.004,
        lat: frame.south + Math.floor(i / 4) * 0.008,
        z: 200 + i,
      });
    }
    const terrain = terrainFromSamples(samples, frame);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Terrain",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
    });
    const files = unzipStore(built.zip);
    assert.ok(files["terrain-clipboard.json"]);
    assert.equal(built.clipboard.raisedFloorZones.length, 0);
    assert.equal(built.clipboard.slopedFloors.length, 0);
    const oi = JSON.stringify(built.openintent);
    assert.equal(oi.includes("raisedFloorZones"), false);
    assert.match(files["README.txt"].toString(), /terrain-clipboard\.json/);
    assert.match(files["README.txt"].toString(), /bottom height from floor/);
    assert.match(files["README.txt"].toString(), /Do not import/);
    const clip = JSON.parse(files["terrain-clipboard.json"].toString());
    assert.ok(clip.raisedFloorZones.length + clip.slopedFloors.length >= 1);
    assert.equal(clip.header.type, "HaminaClipboard");
  });
});

function squareFeature(west, south, east, north, props) {
  return {
    type: "Feature",
    properties: props || {},
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}

describe("building height from floor on a slope", () => {
  const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Granite Peak" });

  function buildOn(zAt, features) {
    const terrain = terrainFromSamples(gridSamples(frame, zAt), frame);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features },
      treePoints: [],
      name: "Granite Peak",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
    });
    return { terrain, built };
  }

  it("keeps bottom height on the floor when relief is below the ski-hill gate", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const lat0 = frame.south + span * 0.7;
    const lon0 = frame.west + spanLon * 0.4;
    const lat1 = lat0 + span * 0.012;
    const lon1 = lon0 + spanLon * 0.012;
    const { terrain, built } = buildOn(
      (r, c, lon, lat) => 400 + ((lat - frame.south) / span) * 12,
      [squareFeature(lon0, lat0, lon1, lat1)]
    );
    assert.ok(terrain.reliefM < LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), false);
    assert.equal(built.stats.buildingsLifted, 0);
    const area = built.openintent.floorplans[0].attenuation_areas[0];
    assert.equal(area.area_material.name, "Building - One Floor");
    assert.equal("bottom_height" in area.area_material, false);
    assert.equal(area.area_material.top_height, 4.5);
    const zone = built.clipboard.attenuatingZones[0];
    const type = built.clipboard.attenuatingZoneTypes.find((t) => t.id === zone.typeId);
    assert.equal(type.bottomEdge, null);
    assert.equal(type.topEdge, 4.5);
    assert.ok(terrain.raised + terrain.sloped > 9);
    for (const z of terrain.clipboard.slopedFloors) assertSlopedRamp(z.area.coordinates[0]);
    for (const z of terrain.clipboard.raisedFloorZones) assertOpenQuad(z.area.coordinates[0], 2);
  });

  it("sets bottom height from floor to the slope top and top height to bottom plus building height", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const dLat = span * 0.012;
    const dLon = spanLon * 0.012;
    const southB = squareFeature(
      frame.west + spanLon * 0.2,
      frame.south + span * 0.02,
      frame.west + spanLon * 0.2 + dLon,
      frame.south + span * 0.02 + dLat
    );
    const northB = squareFeature(
      frame.west + spanLon * 0.5,
      frame.south + span * 0.75,
      frame.west + spanLon * 0.5 + dLon,
      frame.south + span * 0.75 + dLat,
      { height: 6.4 }
    );
    const { terrain, built } = buildOn((r, c, lon, lat) => {
      const t = (lat - frame.south) / span;
      return t < 0.35 ? 300 : 300 + ((t - 0.35) / 0.65) * 180;
    }, [southB, northB]);
    assert.ok(terrain.reliefM >= LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), true);
    assert.ok(terrain.sloped > 9);
    assert.ok(terrain.sloped <= MAX_GRID * MAX_GRID);
    for (const z of terrain.clipboard.slopedFloors) assertSlopedRamp(z.area.coordinates[0]);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.length, 2);
    const valley = areas.find((a) => a.area_material.name === "Building - One Floor");
    const hill = areas.find((a) => String(a.area_material.name).indexOf("Building - Two Floor ") === 0);
    assert.ok(valley, "valley building stays on the floor");
    assert.equal("bottom_height" in valley.area_material, false);
    assert.equal(valley.area_material.top_height, 4.5);
    assert.ok(hill);
    assert.ok(hill.area_material.bottom_height >= 50, "bottom " + hill.area_material.bottom_height);
    assert.equal(
      hill.area_material.top_height,
      Math.round((hill.area_material.bottom_height + 7.620092660326749) * 10) / 10
    );
    assert.equal(hill.area_material.name, "Building - Two Floor " + hill.area_material.bottom_height.toFixed(1));
    assert.deepEqual(Object.keys(hill.area_material), [
      "name",
      "rf_properties",
      "top_height",
      "bottom_height",
      "display_color",
    ]);
    const gold = built.openintent.area_materials.slice(0, 4).map((m) => m.name);
    assert.deepEqual(gold, ["Building - One Floor", "Building - Two Floor", "Building - Five Floor", "Building - Ten Floor"]);
    assert.ok(built.openintent.area_materials.some((m) => m.name === hill.area_material.name));
    assert.equal(JSON.stringify(built.openintent).includes("raisedFloorZones"), false);
    const hillZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("-b") > 0);
    const hillType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === hillZone.typeId);
    assert.equal(hillType.bottomEdge, hill.area_material.bottom_height);
    assert.equal(hillType.topEdge, Math.round((hillType.bottomEdge + 6.4) * 10) / 10);
    assert.ok(hillType.topEdge > hillType.bottomEdge);
    assert.equal(built.stats.buildingsLifted, 1);
  });
});

describe("foliage height from floor on a slope", () => {
  const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Granite Peak" });

  function buildFoliage(zAt, hits, heightSample) {
    const terrain = terrainFromSamples(gridSamples(frame, zAt), frame);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Granite Peak",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
      canopyHits: hits,
      heightSample,
      includeFoliage: true,
    });
    return { terrain, built };
  }

  it("leaves foliage on the floor when relief is below the ski-hill gate", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const lat = frame.south + span * 0.7;
    const lon = frame.west + spanLon * 0.4;
    const { terrain, built } = buildFoliage(
      (r, c, lon0, lat0) => 400 + ((lat0 - frame.south) / span) * 12,
      canopyHitsGrid(frame, lon, lat, { pct: 80 }),
      () => 14.2
    );
    assert.ok(terrain.reliefM < LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), false);
    assert.equal(built.stats.foliageLifted, 0);
    assert.equal(built.stats.includeFoliage, true);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.ok(areas.length >= 1);
    for (const area of areas) {
      assert.equal(area.area_material.name, "Foliage - Heavy 14.2");
      assert.equal("bottom_height" in area.area_material, false);
      assert.equal(area.area_material.top_height, 14.2);
    }
    const zone = built.clipboard.attenuatingZones[0];
    const type = built.clipboard.attenuatingZoneTypes.find((t) => t.id === zone.typeId);
    assert.equal(type.id.indexOf("foliage-m-"), 0);
    assert.equal(type.bottomEdge, 3.5);
    assert.equal(type.topEdge, 14.2);
    assert.equal(built.openintent.area_materials.slice(0, 4).some((m) => "bottom_height" in m), false);
  });

  it("sets foliage bottom height from floor to the slope top and top height to bottom plus canopy height", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const valleyHits = canopyHitsGrid(frame, frame.west + spanLon * 0.2, frame.south + span * 0.05, { pct: 40 });
    const stockHill = canopyHitsGrid(frame, frame.west + spanLon * 0.25, frame.south + span * 0.78, { pct: 40 });
    const measuredHill = canopyHitsGrid(frame, frame.west + spanLon * 0.7, frame.south + span * 0.78, { pct: 80 });
    const { terrain, built } = buildFoliage(
      (r, c, lon, lat) => {
        const t = (lat - frame.south) / span;
        return t < 0.35 ? 300 : 300 + ((t - 0.35) / 0.65) * 180;
      },
      valleyHits.concat(stockHill, measuredHill),
      (lon, lat) => {
        if ((lat - frame.south) / span < 0.35) return 14.2;
        return (lon - frame.west) / spanLon < 0.45 ? 6 : 14.2;
      }
    );
    assert.ok(terrain.reliefM >= LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), true);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const valley = areas.filter((a) => a.area_material.name === "Foliage - Heavy 14.2");
    const hill = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Light @ ") === 0);
    const thick = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Heavy 14.2 @ ") === 0);
    assert.ok(valley.length >= 1, "valley canopy stays on the floor");
    assert.ok(hill.length >= 1, "uphill stock canopy is lifted");
    assert.ok(thick.length >= 1, "uphill measured canopy is lifted");
    for (const area of valley) {
      assert.equal("bottom_height" in area.area_material, false);
      assert.equal(area.area_material.top_height, 14.2);
    }
    const stockTop = 19.68 / 3.280839895;
    const hillMat = hill[0].area_material;
    assert.ok(hillMat.bottom_height >= 50, "bottom " + hillMat.bottom_height);
    assert.equal(hillMat.top_height, Math.round((hillMat.bottom_height + stockTop) * 10) / 10);
    assert.equal(hillMat.name, "Foliage - Light @ " + hillMat.bottom_height.toFixed(1));
    assert.deepEqual(Object.keys(hillMat), ["name", "rf_properties", "top_height", "bottom_height", "display_color"]);
    assert.equal(hillMat.rf_properties.attenuation_per_m, 1);
    assert.equal(hillMat.display_color, "#6FA84A");
    const gold = built.openintent.area_materials.slice(0, 4).map((m) => m.name);
    assert.deepEqual(gold, ["Building - One Floor", "Building - Two Floor", "Building - Five Floor", "Building - Ten Floor"]);
    assert.ok(built.openintent.area_materials.some((m) => m.name === hillMat.name));
    const hillZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("foliage-light-b") === 0);
    const hillType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === hillZone.typeId);
    assert.equal(hillType.bottomEdge, hillMat.bottom_height);
    assert.equal(hillType.topEdge, hillMat.top_height);
    assert.ok(hillType.topEdge > hillType.bottomEdge);
    assert.equal(hillType.transparencyEnabled, true);
    const stockLight = built.clipboard.attenuatingZoneTypes.find((t) => t.id === "foliage-light");
    assert.equal(stockLight, undefined);
    const thickMat = thick[0].area_material;
    assert.ok(thickMat.bottom_height >= 50);
    assert.equal(thickMat.top_height, Math.round((thickMat.bottom_height + 14.2) * 10) / 10);
    assert.equal(thickMat.name, "Foliage - Heavy 14.2 @ " + thickMat.bottom_height.toFixed(1));
    assert.equal(thickMat.rf_properties.attenuation_per_m, 2);
    const thickZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("foliage-m-14_2-b") === 0);
    const thickType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === thickZone.typeId);
    assert.equal(thickType.bottomEdge, thickMat.bottom_height);
    assert.equal(thickType.topEdge, thickMat.top_height);
    const valleyZone = built.clipboard.attenuatingZones.find((z) => z.typeId === "foliage-m-14_2");
    const valleyType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === valleyZone.typeId);
    assert.equal(valleyType.bottomEdge, 3.5);
    assert.equal(valleyType.topEdge, 14.2);
    assert.equal(built.stats.foliageLifted, hill.length + thick.length);
    assert.equal(built.stats.buildingsLifted, 0);
    assert.equal(JSON.stringify(built.openintent).includes("Foliage 14.2 m"), false);
  });
});
