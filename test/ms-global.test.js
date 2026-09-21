"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const {
  quadkeysForBbox,
  urlsForBbox,
  featuresFromGzip,
  mergeFootprintFeatures,
  QUADKEY_ZOOM,
} = require("../netlify/lib/ms-global");

const OAK = {
  west: -87.9217,
  south: 42.89544,
  east: -87.9155,
  north: 42.90276,
};

function poly(ring) {
  return {
    type: "Feature",
    properties: { height: 6 },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

describe("Microsoft global building footprints", () => {
  it("maps Oak Creek to the United States quadkey that holds the white roofs", () => {
    const keys = quadkeysForBbox(OAK.west, OAK.south, OAK.east, OAK.north);
    assert.equal(QUADKEY_ZOOM, 9);
    assert.deepEqual(keys, ["030222210"]);
    const { urls } = urlsForBbox(OAK.west, OAK.south, OAK.east, OAK.north);
    assert.equal(urls.length, 1);
    assert.match(urls[0].url, /quadkey=030222210/);
    assert.match(urls[0].url, /^https:\/\//);
  });

  it("keeps gzip features that intersect the bbox and drops the rest", () => {
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const outside = poly([
      [-87.85, 42.7],
      [-87.84, 42.7],
      [-87.84, 42.71],
      [-87.85, 42.71],
      [-87.85, 42.7],
    ]);
    const edge = poly([
      [-87.9162, 42.8982],
      [-87.9142, 42.8982],
      [-87.9142, 42.8994],
      [-87.9162, 42.8994],
      [-87.9162, 42.8982],
    ]);
    const gz = zlib.gzipSync(Buffer.from([inside, outside, edge].map((f) => JSON.stringify(f)).join("\n")));
    const feats = featuresFromGzip(gz, OAK);
    assert.equal(feats.length, 2);
    assert.equal(feats[0].properties.height, 6);
    const lons = feats.flatMap((f) => f.geometry.coordinates[0].map((p) => p[0]));
    assert.ok(Math.min(...lons) < OAK.east);
    assert.ok(lons.some((x) => x < -87.916));
  });

  it("adds an ArcGIS footprint only when its centroid is outside the global set", () => {
    const globalF = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.9],
      [-87.918, 42.9],
      [-87.918, 42.899],
    ]);
    const dup = poly([
      [-87.9178, 42.8992],
      [-87.9172, 42.8992],
      [-87.9172, 42.8998],
      [-87.9178, 42.8998],
      [-87.9178, 42.8992],
    ]);
    const extra = poly([
      [-87.921, 42.896],
      [-87.920, 42.896],
      [-87.920, 42.897],
      [-87.921, 42.897],
      [-87.921, 42.896],
    ]);
    const merged = mergeFootprintFeatures([globalF], [dup, extra]);
    assert.equal(merged.features.length, 2);
    assert.equal(merged.added, 1);
    assert.equal(merged.features[0], globalF);
  });
});
