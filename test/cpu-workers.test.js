"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const jobs = require("../netlify/lib/export-jobs");
const { handler: statusHandler } = require("../netlify/functions/export-status");
const { startHeartbeatTimer } = require("../fly/worker");
const { runOne, closePool, threadCount } = require("../netlify/lib/cpu-pool");
const { treePairsFromPoints } = require("../netlify/lib/vegetation");
const { treePairsParallel } = require("../netlify/lib/detect-parallel");

function memoryStore() {
  const map = new Map();
  return {
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async set(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

describe("cpu workers", () => {
  after(async () => {
    jobs.setExportStoreForTests(null);
    await closePool();
  });

  it("uses one thread per CPU", () => {
    const n = os.cpus().length;
    assert.equal(threadCount(), n > 0 ? n : 1);
    assert.ok(threadCount() >= 1);
  });

  it("fires the heartbeat while a worker thread is busy", async () => {
    jobs.setExportStoreForTests(memoryStore());
    const id = "44444444-4444-4444-8444-444444444444";
    await jobs.createJob(id);
    const marks = [];
    const orig = jobs.writeHeartbeat;
    jobs.writeHeartbeat = async (jobId, stage) => {
      marks.push(Date.now());
      return orig.call(jobs, jobId, stage);
    };
    const started = Date.now();
    const timer = startHeartbeatTimer(id, () => "Trees", 25);
    try {
      await runOne("spin", { ms: 280 });
      const during = marks.filter((t) => t >= started + 30);
      assert.ok(during.length >= 2, "beats during spin " + marks.length);
      const job = await jobs.readJob(id);
      assert.equal(job.heartbeatStage, "Trees");
    } finally {
      clearInterval(timer);
      jobs.writeHeartbeat = orig;
    }
  });

  it("keeps tree counts in the same band when crowns are split by tile", async () => {
    const width = 220;
    const height = 180;
    const values = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const woods = x > 20 && x < 90 && y > 15 && y < 150 && (x + y) % 4 !== 0;
        if (woods) values[y * width + x] = 8 + ((x + y) % 9);
        const clump = (x - 150) * (x - 150) + (y - 80) * (y - 80) < 140;
        if (clump) values[y * width + x] = 12;
      }
    }
    const frame = {
      west: -115.17,
      south: 36.12,
      east: -115.15,
      north: 36.13,
      imgW: 800,
      imgH: 640,
      mpuX: 0.8,
      mpuY: 0.8,
    };
    const grid = {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
      width,
      height,
      values,
      nonzero: 1,
    };
    const opts = { chmGrid: grid, buildingRings: [], maxPolygons: 720 };
    const serial = treePairsFromPoints([], frame, [], null, opts);
    const parallel = await treePairsParallel([], frame, [], null, opts);
    assert.ok(serial.count > 0, "serial crowns");
    assert.ok(parallel.count > 0, "parallel crowns");
    assert.ok(parallel.count <= serial.count * 2 + 30, parallel.count + " vs " + serial.count);
    assert.ok(parallel.count >= Math.floor(serial.count * 0.45), parallel.count + " vs " + serial.count);
    assert.ok(parallel.oiAreas.length < 8000);
    assert.ok(parallel.polygons <= 720);
  });
});

describe("export status worker field", () => {
  after(() => {
    jobs.setExportStoreForTests(null);
  });

  it("returns the Fly worker id, or the last heartbeat stage", async () => {
    jobs.setExportStoreForTests(memoryStore());
    const id = "55555555-5555-4555-8555-555555555555";
    await jobs.createJob(id);
    await jobs.updateJob(id, { state: "running", stage: "Trees", worker: "fly" });
    const res = await statusHandler({
      httpMethod: "GET",
      queryStringParameters: { job: id },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.worker, "fly");

    const other = "66666666-6666-4666-8666-666666666666";
    await jobs.createJob(other);
    await jobs.updateJob(other, { state: "running", stage: "Trees", heartbeatStage: "Trees" });
    const beat = await statusHandler({
      httpMethod: "GET",
      queryStringParameters: { job: other },
    });
    const beatBody = JSON.parse(beat.body);
    assert.equal(beatBody.worker, "Trees");
  });
});
