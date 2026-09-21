"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { terrainFromSamples, parseDemSamples } = require("../netlify/lib/terrain");
const { buildClutter } = require("../netlify/lib/pipeline");
const { unzipStore } = require("../netlify/lib/zip-store");

describe("3DEP terrain clipboard", () => {
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
