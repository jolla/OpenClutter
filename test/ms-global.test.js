"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const {
  quadkeysForBbox,
  urlsForBbox,
  featuresFromGzip,
  mergeFootprintFeatures,
  fetchMsGlobalFootprints,
  globalSkipWarning,
  MAX_GZIP_BYTES,
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

  it("copies a covered USA height onto the primary footprint that lacks one", () => {
    const globalF = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[
          [-87.918, 42.899],
          [-87.917, 42.899],
          [-87.917, 42.9],
          [-87.918, 42.9],
          [-87.918, 42.899],
        ]],
      },
    };
    const usa = poly([
      [-87.9179, 42.8991],
      [-87.9171, 42.8991],
      [-87.9171, 42.8999],
      [-87.9179, 42.8999],
      [-87.9179, 42.8991],
    ]);
    usa.properties.height = 7.4;
    const merged = mergeFootprintFeatures([globalF], [usa]);
    assert.equal(merged.added, 0);
    assert.equal(merged.features.length, 1);
    assert.equal(merged.heightsTransferred, 1);
    assert.equal(merged.features[0].properties.height, 7.4);
  });

  it("does not download a quadkey gzip over the export size limit", async () => {
    assert.ok(MAX_GZIP_BYTES >= 70 * 1024 * 1024);
    assert.ok(MAX_GZIP_BYTES < 100 * 1024 * 1024);
    let bodyReads = 0;
    const pack = await fetchMsGlobalFootprints(OAK, async () => ({
      ok: true,
      headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(179 * 1024 * 1024) : null) },
      arrayBuffer: async () => {
        bodyReads++;
        return new ArrayBuffer(8);
      },
      body: { cancel: async () => {} },
    }));
    assert.equal(bodyReads, 0);
    assert.equal(pack.features.length, 0);
    assert.equal(pack.skipped, 1);
    const warning = globalSkipWarning(pack);
    assert.match(warning, /omitted/);
    assert.match(warning, /179 MB/);
    assert.equal(/esri/i.test(warning), false);
    assert.equal(/smaller box/i.test(warning), false);
  });

  it("still parses a gzip under the size limit", async () => {
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inside) + "\n"));
    const pack = await fetchMsGlobalFootprints(OAK, async () => ({
      ok: true,
      headers: { get: () => String(gz.length) },
      arrayBuffer: async () => gz,
    }));
    assert.equal(pack.skipped, 0);
    assert.equal(pack.features.length, 1);
    assert.equal(globalSkipWarning(pack), "");
  });
});
