"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { Readable } = require("stream");
const {
  quadkeysForBbox,
  urlsForBbox,
  featuresFromGzip,
  featuresFromGzipBuffer,
  mergeFootprintFeatures,
  fetchMsGlobalFootprints,
  setMsCacheDir,
  setMsCacheLimits,
  parsedCacheKey,
  MS_CACHE_MAX_BYTES,
  MS_CACHE_TTL_MS,
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

describe("Microsoft global building footprints", { concurrency: 1 }, () => {
  it("maps Oak Creek to the United States quadkey that holds the white roofs", () => {
    const keys = quadkeysForBbox(OAK.west, OAK.south, OAK.east, OAK.north);
    assert.equal(QUADKEY_ZOOM, 9);
    assert.deepEqual(keys, ["030222210"]);
    const { urls } = urlsForBbox(OAK.west, OAK.south, OAK.east, OAK.north);
    assert.equal(urls.length, 1);
    assert.match(urls[0].url, /quadkey=030222210/);
    assert.match(urls[0].url, /^https:\/\//);
    assert.match(urls[0].url, /2026-07-24/);
    assert.match(urls[0].url, /RegionName=UnitedStates/);
  });

  it("resolves international Global ML tiles, including a border quadkey with more than one region file", () => {
    const { MS_INDEX_RELEASE } = require("../netlify/lib/ms-global");
    assert.equal(MS_INDEX_RELEASE, "2026-07-24");
    const london = urlsForBbox(-0.100, 51.508, -0.085, 51.517);
    assert.equal(london.keys[0], "031313131");
    assert.ok(london.urls.length >= 1);
    assert.ok(london.urls.some((u) => /RegionName=UnitedKingdom/.test(u.url) && /quadkey=031313131/.test(u.url)));
    const mumbai = urlsForBbox(72.825, 18.927, 72.840, 18.936);
    assert.equal(mumbai.keys[0], "123300311");
    const locs = mumbai.urls.map((u) => (/RegionName=([^/]+)/.exec(u.url) || [])[1]);
    assert.ok(locs.includes("India"));
    assert.ok(locs.includes("Asia"));
    assert.ok(mumbai.urls.length >= 2);
    const tokyo = urlsForBbox(139.693, 35.685, 139.708, 35.694);
    assert.ok(tokyo.urls.some((u) => /RegionName=Japan/.test(u.url)));
    const toronto = urlsForBbox(-79.388, 43.643, -79.373, 43.652);
    assert.ok(toronto.urls.some((u) => /RegionName=Canada/.test(u.url)));
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

  it("keeps the larger roof when a tile has more buildings than the export can hold", () => {
    const small = poly([
      [-87.9182, 42.8992],
      [-87.9181, 42.8992],
      [-87.9181, 42.8993],
      [-87.9182, 42.8993],
      [-87.9182, 42.8992],
    ]);
    const large = poly([
      [-87.919, 42.898],
      [-87.916, 42.898],
      [-87.916, 42.901],
      [-87.919, 42.901],
      [-87.919, 42.898],
    ]);
    const gz = zlib.gzipSync(Buffer.from([small, large].map((f) => JSON.stringify(f)).join("\n")));
    const feats = featuresFromGzip(gz, OAK, { keep: 1 });
    assert.equal(feats.length, 1);
    const xs = feats[0].geometry.coordinates[0].map((p) => p[0]);
    assert.ok(Math.min(...xs) < -87.9185);
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

  it("keeps a runaway size guard above the Los Angeles tile and below 1 GB", async () => {
    // Los Angeles is ~179 MB. New York, Chicago, Houston, and Phoenix
    // are all just over the old 120 MB cap and must also fit.
    assert.ok(MAX_GZIP_BYTES >= 200 * 1024 * 1024);
    assert.ok(MAX_GZIP_BYTES <= 1024 * 1024 * 1024);
  });

  it("does not download a quadkey gzip over the runaway size guard", async () => {
    let bodyReads = 0;
    const pack = await fetchMsGlobalFootprints(OAK, async () => ({
      ok: true,
      headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(600 * 1024 * 1024) : null) },
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
    assert.match(warning, /600 MB/);
    assert.equal(/esri/i.test(warning), false);
    assert.equal(/smaller box/i.test(warning), false);
  });

  it("stream-downloads a 179 MB Los Angeles-sized tile without buffering the body", async () => {
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inside) + "\n"));
    let bodyReads = 0;
    const pack = await fetchMsGlobalFootprints(OAK, async () => ({
      ok: true,
      headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(179 * 1024 * 1024) : null) },
      arrayBuffer: async () => {
        bodyReads++;
        return gz;
      },
      body: Readable.from(gz),
    }));
    assert.equal(bodyReads, 0);
    assert.equal(pack.skipped, 0);
    assert.equal(pack.features.length, 1);
    assert.equal(globalSkipWarning(pack), "");
  });

  it("downloads an 84 MB Minneapolis-sized tile that the old 80 MB cap skipped", async () => {
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inside) + "\n"));
    let bodyReads = 0;
    const pack = await fetchMsGlobalFootprints(OAK, async () => ({
      ok: true,
      headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(84 * 1024 * 1024) : null) },
      arrayBuffer: async () => {
        bodyReads++;
        return gz;
      },
      body: Readable.from(gz),
    }));
    assert.equal(bodyReads, 0);
    assert.equal(pack.skipped, 0);
    assert.equal(pack.features.length, 1);
    assert.equal(globalSkipWarning(pack), "");
  });

  it("stream-parses a gzip to the same footprints as the all-at-once reader", async () => {
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
    const gz = zlib.gzipSync(Buffer.from([inside, outside].map((f) => JSON.stringify(f)).join("\n")));
    const direct = featuresFromGzip(gz, OAK);
    const streamed = await featuresFromGzipBuffer(gz, OAK);
    assert.equal(direct.length, 1);
    assert.equal(streamed.length, 1);
    assert.deepEqual(streamed[0].geometry, direct[0].geometry);
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

  it("retries a brief Microsoft tile failure once", async () => {
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inside) + "\n"));
    let calls = 0;
    const pack = await fetchMsGlobalFootprints(OAK, async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, headers: { get: () => String(gz.length) }, arrayBuffer: async () => gz };
    });
    assert.equal(calls, 2);
    assert.equal(pack.features.length, 1);
  });

  it("reuses a cached Microsoft gzip so a second read does not hit the network", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-ms-cache-"));
    setMsCacheDir(dir);
    setMsCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    assert.equal(MS_CACHE_MAX_BYTES, 512 * 1024 * 1024);
    assert.equal(MS_CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inside) + "\n"));
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return { ok: true, headers: { get: () => String(gz.length) }, arrayBuffer: async () => gz };
    };
    try {
      const first = await fetchMsGlobalFootprints(OAK, fetchFn, { diskCache: true });
      const second = await fetchMsGlobalFootprints(OAK, fetchFn, { diskCache: true });
      assert.equal(calls, 1);
      assert.equal(first.features.length, 1);
      assert.equal(second.features.length, 1);
    } finally {
      setMsCacheDir(undefined);
      setMsCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses a parsed bbox-filtered Microsoft cache without reading the gzip again", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-ms-parsed-"));
    setMsCacheDir(dir);
    setMsCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    const inside = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inside) + "\n"));
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls > 1) throw new Error("should not download again");
      return { ok: true, headers: { get: () => String(gz.length) }, arrayBuffer: async () => gz };
    };
    try {
      const first = await fetchMsGlobalFootprints(OAK, fetchFn, { diskCache: true });
      assert.equal(first.features.length, 1);
      const second = await fetchMsGlobalFootprints(OAK, async () => {
        throw new Error("parsed cache should skip the gzip and the network");
      }, { diskCache: true });
      assert.equal(second.features.length, 1);
      assert.equal(calls, 1);
    } finally {
      setMsCacheDir(undefined);
      setMsCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses a streamed gzip cache for a second bbox in the same tile", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-ms-stream-"));
    setMsCacheDir(dir);
    setMsCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    const a = poly([
      [-87.918, 42.899],
      [-87.917, 42.899],
      [-87.917, 42.900],
      [-87.918, 42.900],
      [-87.918, 42.899],
    ]);
    const b = poly([
      [-87.920, 42.897],
      [-87.919, 42.897],
      [-87.919, 42.898],
      [-87.920, 42.898],
      [-87.920, 42.897],
    ]);
    const gz = zlib.gzipSync(Buffer.from([a, b].map((f) => JSON.stringify(f)).join("\n") + "\n"));
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return {
        ok: true,
        headers: { get: () => String(gz.length) },
        arrayBuffer: async () => {
          throw new Error("must stream the body, not buffer it");
        },
        body: Readable.from(gz),
      };
    };
    const firstBox = {
      west: -87.9185,
      south: 42.8985,
      east: -87.9165,
      north: 42.9005,
    };
    const nearby = {
      west: -87.9217,
      south: 42.896,
      east: -87.9185,
      north: 42.8985,
    };
    try {
      const first = await fetchMsGlobalFootprints(firstBox, fetchFn, { diskCache: true });
      const second = await fetchMsGlobalFootprints(nearby, fetchFn, { diskCache: true });
      assert.equal(calls, 1);
      assert.equal(first.features.length, 1);
      assert.equal(second.features.length, 1);
      assert.notEqual(first.features[0].geometry.coordinates[0][0][0], second.features[0].geometry.coordinates[0][0][0]);
    } finally {
      setMsCacheDir(undefined);
      setMsCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
