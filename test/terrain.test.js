"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, cornerClipboard } = require("../netlify/lib/geo-frame");
const {
  terrainFromSamples,
  parseDemSamples,
  terrainBundleFields,
  noteMissingTerrain,
  RAISED_KEYS,
  SLOPED_KEYS,
  TERRAIN_FILENAME,
} = require("../netlify/lib/terrain");
const { buildClutter } = require("../netlify/lib/pipeline");
const { unzipStore } = require("../netlify/lib/zip-store");

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
    assert.ok(terrain.raised >= 1);
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
      assert.equal(z.slabOnly, true);
      const ring = z.area.coordinates[0];
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring[ring.length - 1]);
      for (const p of ring) assert.equal(p.length, 2);
    }
    assertFrameSpan(terrain.clipboard.raisedFloorZones, frame);
    const fields = terrainBundleFields(terrain, []);
    assert.equal(fields.terrainFilename, TERRAIN_FILENAME);
    assert.equal(fields.terrainClipboard.raisedFloorZones.length, terrain.raised);
    assert.match(fields.terrainStatus, /Paste it in Planner Plus/);
    assert.match(fields.terrainStatus, /Do not import it as OpenIntent/);
  });

  it("turns a sloped DEM into slopedFloors with xyz vertices", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Slope" });
    const terrain = terrainFromSamples(
      gridSamples(frame, (r) => 180 + r * 4),
      frame
    );
    assert.ok(terrain);
    assert.ok(terrain.reliefM > 2);
    assert.equal(terrain.raised, 0);
    assert.ok(terrain.sloped >= 2);
    assert.ok(terrain.sloped <= 18);
    assert.equal(terrain.clipboard.raisedFloorZones.length, 0);
    for (const z of terrain.clipboard.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      assert.equal(z.area.type, "Polygon");
      assert.equal(z.attenuationDbPerMeter, 0);
      assert.equal(z.crowdEnabled, false);
      assert.equal(z.drawStairs, false);
      assert.equal(z.slabOnly, true);
      assert.equal(z.crowdHeight, 0);
      assert.equal(z.crowdAttenuationDbPerMeter, 0);
      const ring = z.area.coordinates[0];
      assert.equal(ring[0].length, 3);
      assert.deepEqual(ring[0], ring[ring.length - 1]);
      for (const p of ring) {
        assert.equal(p.length, 3);
        assert.ok(p[2] >= 0);
      }
    }
    assertFrameSpan(terrain.clipboard.slopedFloors, frame);
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
    assert.ok(terrain.raised + terrain.sloped <= 18);
    assert.equal(terrain.clipboard.header.type, "HaminaClipboard");
    assert.equal(terrain.clipboard.attenuatingZones.length, 0);
    for (const z of terrain.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assert.equal(ring[0].length, 3);
      assert.equal(ring[0][0], ring[ring.length - 1][0]);
      assert.equal(z.slabOnly, true);
      assert.equal(z.crowdEnabled, false);
      assert.equal(z.drawStairs, false);
      assert.equal(z.attenuationDbPerMeter, 0);
      for (const p of ring) {
        assert.ok(p[0] <= 0.001 && p[0] >= -frame.widthM - 0.01);
        assert.ok(p[1] <= 0.001 && p[1] >= -frame.lengthM - 0.01);
        assert.ok(p[2] >= 0);
      }
    }
    for (const z of terrain.clipboard.raisedFloorZones) {
      assert.equal(z.area.coordinates[0][0].length, 2);
      assert.equal(z.slabOnly, true);
      assert.ok(z.height >= 0);
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
    assert.match(files["README.txt"].toString(), /OpenIntent zip import is unchanged/);
    const clip = JSON.parse(files["terrain-clipboard.json"].toString());
    assert.ok(clip.raisedFloorZones.length + clip.slopedFloors.length >= 1);
    assert.equal(clip.header.type, "HaminaClipboard");
  });
});
