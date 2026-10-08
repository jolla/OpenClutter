"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, pxToLl } = require("../netlify/lib/geo-frame");
const { footprintsToClutter, capOiRingPx, ringAreaPx } = require("../netlify/lib/pipeline");
const {
  parseBuildingDetail,
  shapeBuildings,
  footprintRings,
  pointInRingLL,
  centroidLL,
} = require("../netlify/lib/building-shape");

function metersBox(lon, lat, widthM, heightM, props) {
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLon = widthM / mx;
  const dLat = heightM / 110540;
  return {
    type: "Feature",
    properties: Object.assign({}, props),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [lon - dLon / 2, lat - dLat / 2],
        [lon + dLon / 2, lat - dLat / 2],
        [lon + dLon / 2, lat + dLat / 2],
        [lon - dLon / 2, lat + dLat / 2],
        [lon - dLon / 2, lat - dLat / 2],
      ]],
    },
  };
}

function ringOf(feature) {
  return feature.geometry.coordinates[0];
}

describe("building outlines", () => {
  const lon = -115.165;
  const lat = 36.128;

  it("opens a courtyard hole instead of filling it", () => {
    const outer = metersBox(lon, lat, 80, 60);
    const hole = metersBox(lon, lat, 20, 16);
    const feature = {
      type: "Feature",
      properties: { height: 12, heightSource: "overture" },
      geometry: {
        type: "Polygon",
        coordinates: [ringOf(outer), ringOf(hole)],
      },
    };
    const rings = footprintRings(feature.geometry);
    assert.ok(rings.length >= 1);
    const court = centroidLL(ringOf(hole));
    for (let i = 0; i < rings.length; i++) {
      assert.equal(pointInRingLL(court, rings[i]), false, "courtyard centroid is inside a roof");
    }
  });

  it("notches a pool out of a complex outline and keeps a part height", () => {
    const parent = metersBox(lon, lat, 180, 120, {
      height: 14,
      heightSource: "overture",
      geomSource: "overture",
    });
    const pool = metersBox(lon, lat + 0.00015, 36, 18);
    const wing = metersBox(lon - 0.00035, lat, 50, 40, {
      height: 16,
      heightSource: "osm",
      geomSource: "osm-part",
      buildingPart: true,
      levelBaseM: 4,
    });
    const shaped = shapeBuildings([parent], { parts: [wing], openings: [ringOf(pool)] });
    assert.equal(shaped.stats.parts, 1);
    assert.equal(shaped.stats.openings, 1);
    const poolAt = centroidLL(ringOf(pool));
    for (let i = 0; i < shaped.features.length; i++) {
      const rings = footprintRings(shaped.features[i].geometry);
      for (let r = 0; r < rings.length; r++) {
        assert.equal(pointInRingLL(poolAt, rings[r]), false);
      }
    }
    const part = shaped.features.find((f) => f.properties && f.properties.buildingPart);
    assert.ok(part);
    assert.equal(part.properties.levelBaseM, 4);
    assert.equal(part.properties.height, 16);
    const frame = geoFrame({
      west: lon - 0.002,
      south: lat - 0.0015,
      east: lon + 0.002,
      north: lat + 0.0015,
      name: "Pool",
    });
    const built = footprintsToClutter(shaped.features, frame, null);
    assert.ok(built.stats.buildings >= 1);
    let covered = 0;
    for (let i = 0; i < built.overlayRings.length; i++) {
      const ring = built.overlayRings[i].map((p) => pxToLl(p[0], p[1], frame));
      if (pointInRingLL(poolAt, ring)) covered++;
    }
    assert.equal(covered, 0);
  });

  it("reads an OSM part height and min_height, and a pool as an opening", () => {
    const parsed = parseBuildingDetail({
      elements: [
        {
          type: "way",
          tags: { "building:part": "yes", height: "112 m", min_height: "18", name: "Sphere" },
          geometry: [
            { lon: -115.16, lat: 36.12 },
            { lon: -115.159, lat: 36.12 },
            { lon: -115.159, lat: 36.121 },
            { lon: -115.16, lat: 36.121 },
            { lon: -115.16, lat: 36.12 },
          ],
        },
        {
          type: "way",
          tags: { leisure: "swimming_pool" },
          geometry: [
            { lon: -115.1647, lat: 36.1256 },
            { lon: -115.1645, lat: 36.1256 },
            { lon: -115.1645, lat: 36.1258 },
            { lon: -115.1647, lat: 36.1258 },
            { lon: -115.1647, lat: 36.1256 },
          ],
        },
        {
          type: "way",
          tags: { building: "hotel", name: "Encore" },
          geometry: [
            { lon: -115.17, lat: 36.12 },
            { lon: -115.169, lat: 36.12 },
            { lon: -115.169, lat: 36.121 },
            { lon: -115.17, lat: 36.121 },
            { lon: -115.17, lat: 36.12 },
          ],
        },
      ],
    });
    assert.equal(parsed.parts.length, 1);
    assert.equal(parsed.parts[0].properties.height, 112);
    assert.equal(parsed.parts[0].properties.levelBaseM, 18);
    assert.equal(parsed.parts[0].properties.buildingPart, true);
    assert.equal(parsed.openings.length, 1);
  });

  it("does not let the vertex cap fill a courtyard", () => {
    const pts = [];
    for (let x = 0; x <= 40; x += 2) pts.push([x, 0]);
    for (let y = 0; y <= 50; y += 2) pts.push([40, y]);
    for (let x = 40; x <= 160; x += 2) pts.push([x, 50]);
    for (let y = 50; y >= 0; y -= 2) pts.push([160, y]);
    for (let x = 160; x <= 200; x += 2) pts.push([x, 0]);
    for (let y = 0; y <= 80; y += 2) pts.push([200, y]);
    for (let x = 200; x >= 0; x -= 2) pts.push([x, 80]);
    for (let y = 80; y >= 0; y -= 2) pts.push([0, y]);
    pts.push(pts[0]);
    const before = ringAreaPx(pts);
    const capped = capOiRingPx(pts, 40, { maxEpsPx: 2, keepOutPx: [[100, 20]] });
    assert.ok(capped.length >= 4);
    const after = ringAreaPx(capped);
    assert.ok(after <= before * 1.08, `area ${after} grew from ${before}`);
    assert.equal(pointInRingLL([100, 20], capped), false);
  });
});
