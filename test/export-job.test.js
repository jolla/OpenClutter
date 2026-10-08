"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jobs = require("../netlify/lib/export-jobs");
const { setEnvironmentContext } = require("@netlify/blobs");
const { unzipStore } = require("../netlify/lib/zip-store");
const { EXPORT_PAYLOAD_BUDGET, estimateBundlePayload } = require("../netlify/lib/terrain");
const { handleClutter, backgroundImagerySteps, runBackgroundExport, setFetchTerrainDemForTests, setFetchOvertureForTests } = require("../netlify/functions/clutter");
const { handler: backgroundHandler } = require("../netlify/functions/clutter-export-background");
const { handler: fileHandler } = require("../netlify/functions/export-file");
const jpeg = require("jpeg-js");
const { compressJpegToMax, jpegSize } = require("../netlify/lib/geo-frame");

function memoryStore() {
  const map = new Map();
  return {
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async set(key, value) {
      map.set(key, value);
    },
    async get(key, opts) {
      if (!map.has(key)) return null;
      const value = map.get(key);
      if (opts && opts.type === "arrayBuffer") {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      return value;
    },
    async delete(key) {
      map.delete(key);
    },
    has(key) {
      return map.has(key);
    },
  };
}

const BOX = {
  west: -73.58,
  south: 45.49,
  east: -73.56,
  north: 45.5,
  name: "Montreal",
  format: "bundle",
};

describe("export jobs", { concurrency: 1 }, () => {
  afterEach(() => {
    jobs.setExportStoreForTests(null);
    setEnvironmentContext({ siteID: "", token: "" });
  });

  it("keeps stages and drops a job after an hour", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const id = "11111111-1111-4111-8111-111111111111";
    await jobs.createJob(id);
    await jobs.updateJob(id, { state: "running", stage: "Buildings 112" });
    await jobs.updateJob(id, { stage: "Trees 55" });
    await jobs.updateJob(id, { stage: "Trees 55" });
    const job = await jobs.readJob(id);
    assert.deepEqual(job.stages, ["Fetching aerial", "Buildings 112", "Trees 55"]);
    assert.equal(job.stage, "Trees 55");
    job.expiresAt = Date.now() - 1000;
    await store.setJSON("job/" + id, job);
    assert.equal(await jobs.readJob(id), null);
    assert.equal(store.has("job/" + id), false);
  });

  it("returns the zip once, then says it was already downloaded", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const id = "22222222-2222-4222-8222-222222222222";
    await jobs.createJob(id);
    await jobs.saveZip(id, Buffer.from("PK zip"));
    const first = await jobs.takeZip(id);
    assert.equal(Buffer.from(first).toString(), "PK zip");
    assert.equal(await jobs.takeZip(id), null);
  });

  it("ignores a function event that has no Blobs credentials", () => {
    assert.equal(jobs.bindBlobs(null), false);
    assert.equal(jobs.bindBlobs({ headers: {} }), false);
  });

  it("connects Blobs from the Lambda-style event", () => {
    const blobs = Buffer.from(JSON.stringify({ url: "https://example.test/blobs", token: "tok" })).toString("base64");
    assert.equal(
      jobs.bindBlobs({
        blobs,
        headers: { "X-Nf-Site-Id": "site-1", "X-Nf-Deploy-Id": "dep-1" },
      }),
      true
    );
  });

  it("falls back when Blobs are not configured", async () => {
    setEnvironmentContext({ siteID: "", token: "" });
    const res = await handleClutter({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify(Object.assign({ async: true }, BOX)),
    });
    const data = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(data.fallback, true);
    assert.match(data.note, /short path/);
    assert.equal(data.jobId, undefined);
  });

  it("asks the background path for a Sharp or 4K plate without the 400 px step", () => {
    const sharp = backgroundImagerySteps(true, Object.assign({ imageryQuality: "sharp" }, BOX));
    assert.equal(sharp[0].maxSide, 2048);
    assert.equal(sharp[0].metersPerPx, 0.25);
    assert.ok(sharp[0].attemptMs >= 60000);
    assert.equal(sharp.some((step) => step.maxSide === 400), false);
    const four = backgroundImagerySteps(true, Object.assign({ imageryQuality: "4k" }, BOX));
    assert.equal(four[0].maxSide, 4096);
    assert.equal(four[0].metersPerPx, 0.15);
    const auto = backgroundImagerySteps(true, BOX);
    assert.equal(auto[0].maxSide, 2048);
    assert.equal(auto[0].metersPerPx, 0.5);
    assert.equal(auto.some((step) => step.maxSide === 400), false);
  });

  it("plans the full DEM lattice on the background path and keeps the short-path cap", async () => {
    const seen = [];
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(120, 1), Buffer.from([0xff, 0xd9])]);
    const prev = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return { ok: true, json: async () => ({ width: 64, height: 64, extent: { xmin: -115.18, ymin: 36.11, xmax: -115.17, ymax: 36.12 } }) };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    setFetchTerrainDemForTests(async (_frame, _fetchFn, opts) => {
      seen.push({
        backgroundDem: !!(opts && opts.backgroundDem),
        fitAnswerClock: !!(opts && opts.fitAnswerClock),
      });
      return {
        samples: [
          { lon: -115.176, lat: 36.112, z: 640 },
          { lon: -115.172, lat: 36.112, z: 642 },
          { lon: -115.176, lat: 36.116, z: 650 },
          { lon: -115.172, lat: 36.116, z: 655 },
        ],
        kind: "bare-earth",
        attribution: "USGS 3DEP",
        notes: [],
      };
    });
    const box = { west: -115.178, south: 36.11, east: -115.17, north: 36.118, name: "Strip" };
    try {
      const background = await runBackgroundExport(
        {
          httpMethod: "POST",
          headers: { host: "deploy-preview-115--openclutter.netlify.app" },
          body: JSON.stringify(Object.assign({ format: "bundle", includeFoliage: false, imageryQuality: "low" }, box)),
        },
        () => {}
      );
      assert.equal(background.statusCode, 200, String(background.body).slice(0, 400));
      const bg = JSON.parse(background.body);
      assert.equal(seen.some((s) => s.backgroundDem && s.fitAnswerClock), true);
      assert.match(bg.terrainStatus, /4 DEM samples/);
      seen.length = 0;
      const sync = await handleClutter({
        httpMethod: "POST",
        headers: { host: "deploy-preview-115--openclutter.netlify.app" },
        body: JSON.stringify(Object.assign({ format: "bundle", includeFoliage: false, imageryQuality: "low" }, box)),
      });
      assert.equal(sync.statusCode, 200, String(sync.body).slice(0, 400));
      assert.equal(seen.some((s) => s.backgroundDem), false);
      assert.equal(seen.some((s) => s.fitAnswerClock), true);
    } finally {
      global.fetch = prev;
      setFetchTerrainDemForTests(null);
    }
  });

  it("keeps the sloped paste on a background job when the zip would crowd a sync response", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(4350000, 7),
      Buffer.from([0xff, 0xd9]),
    ]);
    const prev = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: -112.16, ymin: 40.51, xmax: -112.14, ymax: 40.53 },
          }),
        };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const samples = [];
    for (let r = 0; r <= 8; r++) {
      for (let c = 0; c <= 8; c++) {
        samples.push({ lon: -112.16 + c * 0.0025, lat: 40.51 + r * 0.0025, z: 1400 + r * 12 + c * 3 });
      }
    }
    setFetchTerrainDemForTests(async () => ({
      samples,
      kind: "bare-earth",
      attribution: "USGS 3DEP",
      notes: [],
    }));
    const id = "33333333-3333-4333-8333-333333333333";
    const box = {
      west: -112.16,
      south: 40.51,
      east: -112.14,
      north: 40.53,
      name: "Bingham",
      format: "bundle",
      includeFoliage: false,
      includeTerrain: true,
      terrainStyle: "sloped",
      imageryQuality: "low",
    };
    try {
      await jobs.createJob(id);
      const res = await backgroundHandler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          jobId: id,
          event: {
            httpMethod: "POST",
            headers: { host: "dev--openclutter.netlify.app" },
            body: JSON.stringify(box),
          },
        }),
      });
      assert.equal(res.statusCode, 202);
      const job = await jobs.readJob(id);
      assert.equal(job.state, "done", job && job.error);
      const clip = job.terrainClipboard;
      assert.ok(clip, job.terrainStatus);
      // Jerry's v1.1.79 4K status was "Terrain paste omitted: 20×20 quads will
      // not fit in the export response." That guard is the sync bundle. The
      // background job stores the paste in Blobs and must keep the full mesh.
      assert.equal(clip.slopedFloors.length, 400, job.terrainStatus);
      assert.equal((clip.raisedFloorZones || []).length, 0);
      assert.equal(clip.tiePoints.length, 2);
      assert.equal(clip.tiePoints[1].x, 0);
      assert.equal(clip.tiePoints[1].y, 0);
      assert.match(job.terrainStatus, /20×20/);
      assert.match(job.terrainStatus, /Use Copy terrain/);
      assert.doesNotMatch(job.terrainStatus, /will not fit in the export response/);
      assert.doesNotMatch((job.warnings || []).join("\n"), /will not fit in the export response/);
      const zip = await jobs.takeZip(id);
      const files = unzipStore(Buffer.from(zip));
      assert.equal(files["terrain-clipboard.json"], undefined);
      assert.ok(Object.keys(files).some((name) => name.endsWith(".json")));
      assert.ok(Object.keys(files).some((name) => name.startsWith("images/")));
      const zipBytes = Buffer.from(zip).length;
      assert.ok(
        estimateBundlePayload(zipBytes, JSON.stringify(clip)) > EXPORT_PAYLOAD_BUDGET,
        "zip " + zipBytes + " did not crowd the sync budget"
      );
    } finally {
      global.fetch = prev;
      setFetchTerrainDemForTests(null);
    }
  });

  it("keeps every roof on a background job when the zip would have been shortened", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(4300000, 9),
      Buffer.from([0xff, 0xd9]),
    ]);
    const prev = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: -115.172, ymin: 36.12, xmax: -115.16, ymax: 36.128 },
          }),
        };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const features = [];
    for (let i = 0; i < 12; i++) {
      const lon = -115.171 + (i % 4) * 0.0022;
      const lat = 36.121 + Math.floor(i / 4) * 0.002;
      features.push({
        type: "Feature",
        properties: { height: 18, heightSource: "overture", geomSource: "overture" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [lon, lat],
            [lon + 0.0007, lat],
            [lon + 0.0007, lat + 0.0006],
            [lon, lat + 0.0006],
            [lon, lat],
          ]],
        },
      });
    }
    setFetchOvertureForTests(async () => ({ features, rowGroups: 1, groupsRead: 1, release: "test" }));
    const id = "44444444-4444-4444-8444-444444444444";
    try {
      await jobs.createJob(id);
      const res = await backgroundHandler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          jobId: id,
          event: {
            httpMethod: "POST",
            headers: { host: "dev--openclutter.netlify.app" },
            body: JSON.stringify({
              west: -115.172,
              south: 36.12,
              east: -115.16,
              north: 36.128,
              name: "Wynn",
              format: "bundle",
              includeFoliage: false,
              includeTerrain: false,
              imageryQuality: "low",
            }),
          },
        }),
      });
      assert.equal(res.statusCode, 202);
      const job = await jobs.readJob(id);
      assert.equal(job.state, "done", job && job.error);
      const notes = (job.warnings || []).join("\n");
      assert.doesNotMatch(notes, /largest roofs/);
      assert.equal(job.stats.fetched, 12);
      assert.equal(job.stats.buildings, 12);
    } finally {
      global.fetch = prev;
      setFetchOvertureForTests(null);
    }
  });

  it("compresses a heavy plate without changing its pixel size", () => {
    const width = 160;
    const height = 120;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = (i * 17) % 251;
      rgba[i + 1] = (i * 9) % 251;
      rgba[i + 2] = (i * 3) % 251;
      rgba[i + 3] = 255;
    }
    const big = Buffer.from(jpeg.encode({ data: rgba, width, height }, 100).data);
    const small = compressJpegToMax(big, Math.floor(big.length / 2));
    assert.ok(small.length < big.length);
    assert.ok(small.length <= Math.floor(big.length / 2));
    const size = jpegSize(small);
    assert.equal(size.width, width);
    assert.equal(size.height, height);
    assert.equal(compressJpegToMax(Buffer.from([0xff, 0xd8, 0, 0xff, 0xd9]), 10).length, 5);
  });

  it("leaves an oversized zip stored and names the download limit", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const id = "55555555-5555-4555-8555-555555555555";
    await jobs.createJob(id);
    await jobs.updateJob(id, { state: "done", stage: "Zip ready" });
    await jobs.saveZip(id, Buffer.alloc(5000000, 1));
    const res = await fileHandler({
      httpMethod: "GET",
      queryStringParameters: { job: id },
      headers: {},
    });
    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.body);
    assert.match(body.error, /too large to download/);
    assert.equal(/not ready/i.test(body.error), false);
    assert.equal((await jobs.readZip(id)).length, 5000000);
  });

  it("downloads a small zip once, then says it was already downloaded", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const id = "66666666-6666-4666-8666-666666666666";
    await jobs.createJob(id);
    await jobs.updateJob(id, { state: "done", stage: "Zip ready", zipFilename: "site-openintent.zip" });
    await jobs.saveZip(id, Buffer.from("PK tiny"));
    const res = await fileHandler({
      httpMethod: "GET",
      queryStringParameters: { job: id },
      headers: {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.isBase64Encoded, true);
    assert.equal(Buffer.from(res.body, "base64").toString(), "PK tiny");
    const again = await fileHandler({
      httpMethod: "GET",
      queryStringParameters: { job: id },
      headers: {},
    });
    assert.equal(again.statusCode, 410);
    assert.match(JSON.parse(again.body).error, /already downloaded/);
  });

  it("records a plain error when the export does not return a zip", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    const id = "77777777-7777-4777-8777-777777777777";
    await jobs.createJob(id);
    const res = await backgroundHandler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({
        jobId: id,
        event: {
          httpMethod: "POST",
          headers: { host: "dev--openclutter.netlify.app" },
          body: "{",
        },
      }),
    });
    assert.equal(res.statusCode, 202);
    const job = await jobs.readJob(id);
    assert.equal(job.state, "error");
    assert.match(job.error, /invalid json/);
    assert.equal(/not ready/i.test(job.error), false);
  });

  it("returns the handler result from the background runner", async () => {
    const res = await runBackgroundExport(
      {
        httpMethod: "POST",
        headers: { host: "example.com" },
        body: "{",
      },
      () => {}
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /invalid json/);
  });
});
