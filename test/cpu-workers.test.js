"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const jobs = require("../netlify/lib/export-jobs");
const { handler: statusHandler } = require("../netlify/functions/export-status");
const { startHeartbeatTimer } = require("../fly/worker");
const {
  runOne,
  runTiles,
  closePool,
  threadCount,
  poolSize,
  cpuStartLine,
  tileTimingLine,
  setExportLog,
} = require("../netlify/lib/cpu-pool");
const { treePairsFromPoints } = require("../netlify/lib/vegetation");
const { treePairsParallel, bandsForGrid } = require("../netlify/lib/detect-parallel");

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
    delete process.env.OPENCLUTTER_CPU_COUNT;
    delete process.env.FLY_MACHINE_CPUS;
    setExportLog(null);
    await closePool();
  });

  it("uses one thread per CPU when no CPU env is set", () => {
    delete process.env.OPENCLUTTER_CPU_COUNT;
    delete process.env.FLY_MACHINE_CPUS;
    const avail = typeof os.availableParallelism === "function" ? os.availableParallelism() : 0;
    const n = avail > 0 ? avail : os.cpus().length;
    assert.equal(threadCount(), n > 0 ? n : 1);
    assert.match(cpuStartLine(), new RegExp("os\\.cpus " + os.cpus().length));
    assert.match(cpuStartLine(), /pool \d+/);
  });

  it("pool size follows the CPU env when set", async () => {
    const want = os.cpus().length === 3 ? 5 : 3;
    process.env.FLY_MACHINE_CPUS = "2";
    process.env.OPENCLUTTER_CPU_COUNT = "7";
    try {
      assert.equal(threadCount(), 7);
      delete process.env.OPENCLUTTER_CPU_COUNT;
      process.env.FLY_MACHINE_CPUS = String(want);
      assert.equal(threadCount(), want);
      assert.notEqual(threadCount(), os.cpus().length);
      await closePool();
      await runOne("spin", { ms: 20 });
      assert.equal(poolSize(), want);
    } finally {
      delete process.env.OPENCLUTTER_CPU_COUNT;
      delete process.env.FLY_MACHINE_CPUS;
      await closePool();
    }
  });

  it("logs one timing line per tile and overlapping tiles", async () => {
    delete process.env.OPENCLUTTER_CPU_COUNT;
    delete process.env.FLY_MACHINE_CPUS;
    await closePool();
    const lines = [];
    setExportLog("3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21", (line) => lines.push(line));
    assert.equal(
      tileTimingLine("job", "canopy-0", 1, 41200, 12400),
      "export job stage tile canopy-0 thread 1 start 41.2s duration 12.4s"
    );
    await runTiles("spin", [
      { ms: 400, tileId: "canopy-0" },
      { ms: 400, tileId: "canopy-1" },
    ]);
    assert.equal(lines.length, 2);
    for (let i = 0; i < lines.length; i++) {
      assert.match(
        lines[i],
        /^export 3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21 stage tile canopy-\d thread \d+ start \d+\.\d+s duration \d+\.\ds$/
      );
    }
    const span = (line) => {
      const m = /start (\d+\.\d+)s duration (\d+\.\d+)s/.exec(line);
      const start = Number(m[1]);
      return [start, start + Number(m[2])];
    };
    const a = span(lines[0]);
    const b = span(lines[1]);
    const overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
    assert.ok(overlap > 0, lines.join(" | "));
    setExportLog(null);
  });

  it("splits a dominant canopy band finer than the CPU count", () => {
    const height = 622;
    const width = 40;
    const values = new Uint8Array(width * height);
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < width; x++) values[y * width + x] = 12;
    }
    const grid = { west: 0, south: 0, east: 1, north: 1, width, height, values, nonzero: 1 };
    const bands = bandsForGrid(grid, 4);
    assert.ok(bands.length > 4, "dominant bands " + bands.length);
    assert.ok(bands.length <= 16);
    const even = new Uint8Array(width * height);
    even.fill(8);
    const evenBands = bandsForGrid(Object.assign({}, grid, { values: even }), 4);
    assert.equal(evenBands.length, 4);
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
