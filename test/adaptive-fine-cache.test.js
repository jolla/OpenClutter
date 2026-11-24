"use strict";

// A warm DEM cache must give the same adaptive mesh as a cold read: the
// native 3DEP fine grid is cached beside the samples and reattached.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const geotiff = require("geotiff");
const { geoFrame } = require("../netlify/lib/geo-frame");
const terrain = require("../netlify/lib/terrain");
const exportMode = require("../netlify/lib/export-mode");

const BOX = { west: -115.17025, south: 36.11931, east: -115.15485, north: 36.13056 };
const frame = geoFrame(BOX, { imgW: 1400, imgH: 1500 });
const zAt = (lon, lat) => 620 + (lon - BOX.west) * 4000 + (lat - BOX.south) * 1500;

function tiffFor(url) {
  const q = new URL(url).searchParams;
  const [w, h] = q.get("size").split(",").map(Number);
  const [west, south, east, north] = q.get("bbox").split(",").map(Number);
  const sx = (east - west) / w;
  const sy = (north - south) / h;
  const values = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) values[r * w + c] = zAt(west + (c + 0.5) * sx, north - (r + 0.5) * sy);
  }
  return geotiff.writeArrayBuffer(values, {
    height: h,
    width: w,
    ModelPixelScale: [sx, sy, 0],
    ModelTiepoint: [0, 0, 0, west, north, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    SampleFormat: [3],
    BitsPerSample: [32],
  });
}

function samplesBody() {
  const out = [];
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 20; c++) {
      const lon = BOX.west + ((c + 0.5) / 20) * (BOX.east - BOX.west);
      const lat = BOX.south + ((r + 0.5) / 20) * (BOX.north - BOX.south);
      out.push({ location: { x: lon, y: lat }, value: String(zAt(lon, lat)) });
    }
  }
  return { samples: out };
}

function withCache(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fine-cache-"));
    terrain.setDemCacheDir(dir);
    const prevFetch = global.fetch;
    exportMode.setAdaptiveTerrain(true);
    try {
      await fn(dir);
    } finally {
      global.fetch = prevFetch;
      exportMode.setAdaptiveTerrain(false);
      terrain.setDemCacheDir(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const opts = { backgroundDem: true, terrainResolution: "auto", dep3RetryWaitMs: 5, fineRetryWaitMs: 5 };

test("a warm DEM cache keeps the adaptive fine grid", withCache(async () => {
  let fineReads = 0;
  global.fetch = async (url) => {
    if (/exportImage/.test(String(url))) {
      fineReads++;
      const buf = tiffFor(String(url));
      return { ok: true, arrayBuffer: async () => buf };
    }
    return { ok: true, json: async () => samplesBody() };
  };
  const cold = await terrain.fetchTerrainDem(frame, null, opts);
  assert.ok(cold.samples.fineGrid, "cold read attaches the fine grid");
  assert.equal(fineReads, 1);
  global.fetch = async () => {
    throw new Error("no live read on a warm cache");
  };
  const warm = await terrain.fetchTerrainDem(frame, null, opts);
  assert.ok(warm.samples.fineGrid, "warm read attaches the cached fine grid");
  assert.equal(warm.samples.fineGrid.cols, cold.samples.fineGrid.cols);
  assert.equal(warm.samples.fineGrid.rows, cold.samples.fineGrid.rows);
  const a = cold.samples.fineGrid.z;
  const b = warm.samples.fineGrid.z;
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  assert.equal(maxDiff, 0);
}));

test("a fine-grid miss is not cached and is read again next time", withCache(async () => {
  let fineReads = 0;
  let fail = true;
  global.fetch = async (url) => {
    if (/exportImage/.test(String(url))) {
      fineReads++;
      if (fail) return { ok: false, status: 502 };
      const buf = tiffFor(String(url));
      return { ok: true, arrayBuffer: async () => buf };
    }
    return { ok: true, json: async () => samplesBody() };
  };
  const first = await terrain.fetchTerrainDem(frame, null, opts);
  assert.equal(first.samples.fineGrid, undefined);
  assert.equal(fineReads, 2, "one quick retry after a 502");
  fail = false;
  const second = await terrain.fetchTerrainDem(frame, null, opts);
  assert.ok(second.samples.fineGrid, "a cached samples hit still reads the fine grid live");
  assert.equal(fineReads, 3);
}));

test("a transient fine-grid 502 is retried once in the same export", withCache(async () => {
  let fineReads = 0;
  global.fetch = async (url) => {
    if (/exportImage/.test(String(url))) {
      fineReads++;
      if (fineReads === 1) return { ok: false, status: 502 };
      const buf = tiffFor(String(url));
      return { ok: true, arrayBuffer: async () => buf };
    }
    return { ok: true, json: async () => samplesBody() };
  };
  const got = await terrain.fetchTerrainDem(frame, null, opts);
  assert.ok(got.samples.fineGrid);
  assert.equal(fineReads, 2);
}));

test("fine grid encode and decode round-trip", () => {
  const z = Float32Array.from([1.5, 2.25, -3, 4096.125]);
  const fine = Object.assign({ cols: 2, rows: 2, z }, BOX);
  const back = terrain.decodeFineGrid(terrain.encodeFineGrid(fine));
  assert.deepStrictEqual(Array.from(back.z), Array.from(z));
  assert.equal(back.cols, 2);
  assert.equal(terrain.decodeFineGrid(Buffer.from('{"cols":2,"rows":2,"z":"AAAA"}')), null);
});
