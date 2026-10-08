"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jobs = require("../netlify/lib/export-jobs");
const { setEnvironmentContext } = require("@netlify/blobs");
const { handleClutter, backgroundImagerySteps, runBackgroundExport } = require("../netlify/functions/clutter");

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
