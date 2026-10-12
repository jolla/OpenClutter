"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../netlify/lib/area-cache");
const { exportSummaryLines } = require("../public/export-client");

function memoryStore() {
  const map = new Map();
  return {
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async set(key, value) {
      map.set(key, Buffer.from(value));
    },
    async get(key, opts) {
      if (!map.has(key)) return null;
      const value = map.get(key);
      if (opts && opts.type === "arrayBuffer") {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      if (opts && opts.type === "json" && typeof value === "string") return JSON.parse(value);
      return value;
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

describe("area cache", () => {
  afterEach(() => {
    cache.disable();
    cache.resetSlotsForTests();
  });

  it("keys a tile by source, resolution, and the snapped cell", () => {
    const cells = cache.coverCells(
      { west: -115.16942, south: 36.11944163, east: -115.153863, north: 36.13182737 },
      cache.AERIAL_STEP_DEG
    );
    assert.ok(cells.length >= 2);
    const id = cache.tileId(cells[0]);
    assert.match(id, /^w-?\d+\.\d+_s-?\d+\.\d+_e-?\d+\.\d+_n-?\d+\.\d+$/);
    assert.equal(cache.tileId(cells[0]), cache.tileId(cells[0]));
    const key = cache.cacheKey("aerial", "0.171m", id);
    assert.equal(key, "raw/aerial/0.171m/" + id);
    const again = cache.coverCells(
      { west: -115.16942, south: 36.11944163, east: -115.153863, north: 36.13182737 },
      0.01
    );
    assert.equal(cache.tileId(again[0]), id);
  });

  it("drops a tile after its source TTL", async () => {
    const store = memoryStore();
    const key = cache.cacheKey("aerial", "0.171m", "w-115.17000_s36.11000_e-115.16000_n36.12000");
    const savedAt = 1_000_000;
    await cache.writeRaw(store, key, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
      source: "aerial",
      resolution: "0.171m",
      tile: "w-115.17000_s36.11000_e-115.16000_n36.12000",
      savedAt,
    });
    const ttl = cache.SOURCE_TTL_MS.aerial;
    assert.equal(cache.SOURCE_TTL_MS.osm, 6 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.overpass, 6 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.overture, 14 * 24 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.microsoft, 30 * 24 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.dem, 30 * 24 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.canopy, 14 * 24 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.worldcover, 30 * 24 * 60 * 60 * 1000);
    assert.equal(cache.SOURCE_TTL_MS.lidar, 14 * 24 * 60 * 60 * 1000);
    const fresh = await cache.readRaw(store, key, savedAt + ttl - 1);
    assert.ok(fresh && fresh.body.length === 4);
    const stale = await cache.readRaw(store, key, savedAt + ttl + 1);
    assert.equal(stale, null);
  });

  it("stores raw bytes and refuses final geometry", async () => {
    const store = memoryStore();
    const key = cache.cacheKey("microsoft", "z9", "023013100");
    await cache.writeRaw(store, key, Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]), {
      source: "microsoft",
      resolution: "z9",
      tile: "023013100",
    });
    const hit = await cache.readRaw(store, key, Date.now());
    assert.equal(hit.body[0], 0x1f);
    assert.throws(() => cache.assertRaw({ type: "FeatureCollection", features: [] }), /raw source bytes only/);
    assert.throws(
      () => cache.assertRaw(Buffer.from('{"type":"Feature","geometry":{"type":"Polygon"}}')),
      /raw source bytes only/
    );
    assert.throws(
      () => cache.assertRaw(Buffer.from('{"openintent_version":"1","attenuation_areas":[]}')),
      /raw source bytes only/
    );
    await assert.rejects(
      () => cache.writeRaw(store, cache.cacheKey("trees", "detect", "a"), { type: "Feature", geometry: {} }),
      /raw source bytes only/
    );
  });

  it("fetches missing tiles with a concurrency cap and merges background partials", async () => {
    const store = memoryStore();
    let active = 0;
    let peak = 0;
    const tiles = [];
    for (let i = 0; i < 8; i++) {
      tiles.push({
        source: "dem",
        resolution: "3dep",
        tile: "cell-" + i,
        url: "https://elevation.nationalmap.gov/sample?i=" + i,
      });
    }
    const original = global.fetch;
    global.fetch = async (url) => {
      active += 1;
      if (active > peak) peak = active;
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      const body = Buffer.from("dem-" + String(url));
      return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    };
    cache.enable(store);
    try {
      const started = cache.fanOut(tiles, {
        parentId: "job",
        invokeUrl: "https://example.test/background",
        invoke: async (_url, payload) => {
          await cache.runTileBatch(payload);
        },
      });
      const result = await started;
      assert.ok(result.batches >= 2 && result.batches <= cache.MAX_BACKGROUND_FUNCTIONS);
      assert.ok(peak <= cache.FETCH_CONCURRENCY, "peak " + peak);
      const partial = await cache.readPartial("job", "0");
      assert.ok(partial && partial.ok && partial.keys.length >= 1);
      const first = await cache.readRaw(store, cache.cacheKey("dem", "3dep", "cell-0"));
      assert.ok(first && first.body.length > 3);
      assert.equal(cache.looksLikeFinalGeometry(first.body), false);
    } finally {
      cache.disable();
      global.fetch = original;
    }
  });

  it("does not cache a byte-range response", async () => {
    const store = memoryStore();
    let writes = 0;
    const setJSON = store.setJSON;
    store.setJSON = async (key, value) => {
      writes += 1;
      return setJSON(key, value);
    };
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => {
      calls += 1;
      return new Response(Buffer.from("range-bytes-0123456789"), {
        status: 206,
        headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-19/100" },
      });
    };
    cache.enable(store);
    try {
      const res = await fetch("https://overturemapswestus2.blob.core.windows.net/release/2026-08-19.0/file.parquet", {
        headers: { Range: "bytes=0-19" },
      });
      assert.equal(res.status, 206);
      assert.equal(calls, 1);
      assert.equal(writes, 0);
    } finally {
      cache.disable();
      global.fetch = original;
    }
  });

  it("does not cache a HEAD request", async () => {
    const store = memoryStore();
    let writes = 0;
    const setJSON = store.setJSON;
    store.setJSON = async (key, value) => {
      writes += 1;
      return setJSON(key, value);
    };
    const original = global.fetch;
    global.fetch = async () =>
      new Response(null, { status: 200, headers: { "content-length": "42", "content-type": "image/jpeg" } });
    cache.enable(store);
    try {
      const res = await fetch("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=-115.17,36.12,-115.16,36.13&size=64,64&f=image", {
        method: "HEAD",
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-length"), "42");
      assert.equal(writes, 0);
    } finally {
      cache.disable();
      global.fetch = original;
    }
  });

  it("adds a cached note to the finish breakdown", () => {
    const lines = exportSummaryLines(
      { stats: { buildings: 2, cachedSources: ["aerial", "canopy"] } },
      { foliageOn: false, terrainOn: false }
    );
    assert.equal(lines[lines.length - 1], "Cached aerial, canopy.");
    assert.equal(lines.join("\n").includes("\u2014"), false);
  });
});
