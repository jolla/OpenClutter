"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jobs = require("../netlify/lib/export-jobs");
const { BACKGROUND_PLATFORM_MS, BACKGROUND_ANSWER_MS } = require("../netlify/functions/clutter");
const {
  FALLBACK_NOTE,
  RERUN_NOTE,
  RERUN_MIN_MS,
  PAGE_MS,
  FUNCTION_ANSWER_MS,
  HEARTBEAT_STALE_MS,
  handOffExport,
  setHandoffDepsForTests,
  workerStoppedMessage,
  heartbeatIsStale,
  rerunHasRoom,
} = require("../netlify/lib/fly-handoff");
const { handler: backgroundHandler } = require("../netlify/functions/clutter-export-background");
const {
  HEARTBEAT_MS,
  handleWorkerRequest,
  createStageLogger,
  createWorkerSession,
  startHeartbeatTimer,
} = require("../fly/worker");
const { startServer } = require("../fly/server");

const JOB = "11111111-1111-4111-8111-111111111111";
const root = path.join(__dirname, "..");

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
  };
}

function innerEvent() {
  return {
    httpMethod: "POST",
    headers: { host: "dev--openclutter.netlify.app" },
    body: "{",
  };
}

describe("fly worker handoff", { concurrency: 1 }, () => {
  const prev = {};

  afterEach(() => {
    jobs.setExportStoreForTests(null);
    setHandoffDepsForTests(null);
    for (const key of ["FLY_WORKER_URL", "FLY_WORKER_SECRET", "OPENCLUTTER_WORKER_SECRET", "NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"]) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  function saveEnv() {
    for (const key of ["FLY_WORKER_URL", "FLY_WORKER_SECRET", "OPENCLUTTER_WORKER_SECRET", "NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"]) {
      prev[key] = process.env[key];
    }
  }

  it("skips the handoff when the worker URL is missing", async () => {
    saveEnv();
    delete process.env.FLY_WORKER_URL;
    process.env.FLY_WORKER_SECRET = "local-secret";
    let called = false;
    const result = await handOffExport(JOB, innerEvent(), async () => {
      called = true;
      throw new Error("fetch should not run");
    });
    assert.equal(called, false);
    assert.equal(result.skipped, true);
    assert.equal(result.handed, false);
    assert.equal(result.fallback, false);
  });

  it("skips the handoff when the shared secret is missing", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
    delete process.env.FLY_WORKER_SECRET;
    let called = false;
    const result = await handOffExport(JOB, innerEvent(), async () => {
      called = true;
      throw new Error("fetch should not run");
    });
    assert.equal(called, false);
    assert.equal(result.skipped, true);
    assert.equal(result.handed, false);
  });

  it("keeps the Netlify background path when the worker does not accept the job", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
    process.env.FLY_WORKER_SECRET = "local-secret";
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    let seen = null;
    const fakeFetch = async (url, init) => {
      seen = { url: String(url), authorization: init.headers.authorization };
      return { status: 503, text: async () => "" };
    };
    const result = await handOffExport(JOB, innerEvent(), fakeFetch);
    assert.equal(seen.url, "https://openclutter-export.fly.dev/export");
    assert.equal(seen.authorization, "Bearer local-secret");
    assert.equal(result.fallback, true);
    assert.equal(result.handed, false);

    const prevFetch = global.fetch;
    global.fetch = fakeFetch;
    let res;
    try {
      res = await backgroundHandler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
      });
    } finally {
      global.fetch = prevFetch;
    }
    assert.equal(res.statusCode, 202);
    const job = await jobs.readJob(JOB);
    assert.equal(job.state, "error");
    assert.match(job.error, /invalid json/);
    assert.ok(job.warnings.indexOf(FALLBACK_NOTE) >= 0);
    assert.match(FALLBACK_NOTE, /Netlify background path/);
  });

  it("does not run the local pipeline when the worker accepts the job", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev/";
    process.env.FLY_WORKER_SECRET = "local-secret";
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    const prevFetch = global.fetch;
    global.fetch = async () => ({
      status: 202,
      text: async () => "\n" + JSON.stringify({ ok: true, done: true }) + "\n",
    });
    try {
      const res = await backgroundHandler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
      });
      assert.equal(res.statusCode, 202);
      const job = await jobs.readJob(JOB);
      assert.equal(job.state, "queued");
      assert.equal(job.warnings.indexOf(FALLBACK_NOTE), -1);
    } finally {
      global.fetch = prevFetch;
    }
  });

  function postJob() {
    return backgroundHandler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
    });
  }

  it("keeps a fresh heartbeat on the worker", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
    process.env.FLY_WORKER_SECRET = "local-secret";
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    const t0 = Date.now();
    let now = t0;
    await jobs.updateJob(JOB, {
      state: "running",
      worker: "fly",
      stage: "Trees",
      heartbeatAt: t0,
      heartbeatStage: "Trees",
    });
    let polls = 0;
    let fetched = false;
    let dropBody = function () {};
    const body = new Promise((resolve, reject) => {
      dropBody = reject;
    });
    const prevFetch = global.fetch;
    global.fetch = async () => {
      fetched = true;
      return { status: 202, text: () => body };
    };
    setHandoffDepsForTests({
      now: () => now,
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        now += 10 * 1000;
        if (polls === 1) {
          await jobs.updateJob(JOB, {
            state: "running",
            worker: "fly",
            stage: "Trees",
            heartbeatAt: now,
            heartbeatStage: "Trees",
          });
          dropBody(new Error("socket hang up"));
          return;
        }
        await jobs.updateJob(JOB, {
          state: "done",
          stage: "Zip ready",
          worker: "fly",
          heartbeatAt: now,
          heartbeatStage: "Trees",
          error: null,
        });
      },
    });
    try {
      const res = await postJob();
      assert.equal(res.statusCode, 202);
      assert.equal(fetched, true);
      assert.ok(polls >= 2);
      const job = await jobs.readJob(JOB);
      assert.equal(job.state, "done");
      assert.equal(job.stage, "Zip ready");
      assert.equal(job.error, null);
      assert.equal((job.warnings || []).indexOf(RERUN_NOTE), -1);
      assert.equal((job.warnings || []).indexOf(FALLBACK_NOTE), -1);
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("re-runs on Netlify when the heartbeat is older than 45 seconds", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
    process.env.FLY_WORKER_SECRET = "local-secret";
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    await jobs.updateJob(JOB, {
      state: "running",
      worker: "fly",
      stage: "Trees",
      heartbeatAt: Date.now() - 46 * 1000,
      heartbeatStage: "Trees",
    });
    let fetched = false;
    const prevFetch = global.fetch;
    global.fetch = async () => {
      fetched = true;
      return { status: 202, text: () => new Promise(() => {}) };
    };
    try {
      const res = await postJob();
      assert.equal(res.statusCode, 202);
      assert.equal(fetched, true);
      const job = await jobs.readJob(JOB);
      assert.equal(job.state, "error");
      assert.match(job.error, /invalid json/);
      assert.ok(job.warnings.indexOf(RERUN_NOTE) >= 0);
      assert.equal(job.warnings.indexOf(FALLBACK_NOTE), -1);
      assert.equal(RERUN_NOTE, "The export worker stopped. The job was run here instead.");
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("fails the job when a dead worker has no time left to re-run", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
    process.env.FLY_WORKER_SECRET = "local-secret";
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    const now = Date.now();
    await jobs.updateJob(JOB, {
      state: "running",
      worker: "fly",
      stage: "Trees",
      heartbeatStage: "Trees",
      heartbeatAt: now - 50 * 1000,
      createdAt: now - (PAGE_MS - 30 * 1000),
    });
    const prevFetch = global.fetch;
    global.fetch = async () => ({ status: 202, text: () => new Promise(() => {}) });
    try {
      const res = await postJob();
      assert.equal(res.statusCode, 202);
      const job = await jobs.readJob(JOB);
      assert.equal(job.state, "error");
      assert.equal(job.error, "The export worker stopped during Trees. Export again.");
      assert.equal(job.error, workerStoppedMessage("Trees"));
      assert.equal((job.warnings || []).indexOf(RERUN_NOTE), -1);
      assert.equal(job.error.includes("invalid json"), false);
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("falls back after 45 seconds when the worker never writes a heartbeat", async () => {
    saveEnv();
    process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
    process.env.FLY_WORKER_SECRET = "local-secret";
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    let now = Date.now();
    let fetchedAt = 0;
    setHandoffDepsForTests({
      now: () => now,
      pollMs: 1,
      sleep: async () => {
        now += HEARTBEAT_STALE_MS;
      },
    });
    const prevFetch = global.fetch;
    global.fetch = async () => {
      const job = await jobs.readJob(JOB);
      assert.equal(job.heartbeatAt, undefined);
      fetchedAt = now;
      return { status: 202, text: () => new Promise(() => {}) };
    };
    try {
      const res = await postJob();
      assert.equal(res.statusCode, 202);
      assert.ok(fetchedAt > 0);
      const job = await jobs.readJob(JOB);
      assert.equal(job.state, "error");
      assert.ok(job.warnings.indexOf(RERUN_NOTE) >= 0);
      assert.equal(job.warnings.indexOf(FALLBACK_NOTE), -1);
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("keeps the current path when the worker URL or secret is missing", async () => {
    saveEnv();
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    await jobs.updateJob(JOB, {
      state: "running",
      worker: "fly",
      stage: "Trees",
      heartbeatAt: Date.now() - 60 * 1000,
      heartbeatStage: "Trees",
    });
    let called = false;
    const prevFetch = global.fetch;
    global.fetch = async () => {
      called = true;
      throw new Error("fetch should not run");
    };
    try {
      delete process.env.FLY_WORKER_URL;
      process.env.FLY_WORKER_SECRET = "local-secret";
      let res = await postJob();
      assert.equal(res.statusCode, 202);
      assert.equal(called, false);
      let job = await jobs.readJob(JOB);
      assert.equal(job.state, "error");
      assert.match(job.error, /invalid json/);
      assert.equal((job.warnings || []).indexOf(RERUN_NOTE), -1);
      assert.equal((job.warnings || []).indexOf(FALLBACK_NOTE), -1);

      await jobs.createJob(JOB);
      await jobs.updateJob(JOB, {
        state: "running",
        worker: "fly",
        stage: "Trees",
        heartbeatAt: Date.now() - 60 * 1000,
        heartbeatStage: "Trees",
      });
      process.env.FLY_WORKER_URL = "https://openclutter-export.fly.dev";
      delete process.env.FLY_WORKER_SECRET;
      res = await postJob();
      assert.equal(res.statusCode, 202);
      assert.equal(called, false);
      job = await jobs.readJob(JOB);
      assert.equal(job.state, "error");
      assert.match(job.error, /invalid json/);
      assert.equal((job.warnings || []).indexOf(RERUN_NOTE), -1);
      assert.equal((job.warnings || []).indexOf(FALLBACK_NOTE), -1);
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("treats a heartbeat as stale at 45 seconds and leaves room for a re-run", () => {
    assert.equal(PAGE_MS, BACKGROUND_PLATFORM_MS);
    assert.equal(FUNCTION_ANSWER_MS, BACKGROUND_ANSWER_MS);
    assert.equal(HEARTBEAT_STALE_MS, 45 * 1000);
    assert.equal(RERUN_MIN_MS, 2 * 60 * 1000);
    const started = 1_000_000;
    assert.equal(heartbeatIsStale(started, started + 44_999, started), false);
    assert.equal(heartbeatIsStale(started, started + 45_000, started), true);
    assert.equal(heartbeatIsStale(null, started + 44_999, started), false);
    assert.equal(heartbeatIsStale(null, started + 45_000, started), true);
    assert.equal(rerunHasRoom({ createdAt: started }, started + 45_000, started), true);
    assert.equal(rerunHasRoom({ createdAt: started }, started + 12 * 60 * 1000, started), true);
    assert.equal(rerunHasRoom({ createdAt: started }, started + 12 * 60 * 1000 + 1, started), false);
    const pageEdge = started + PAGE_MS - RERUN_MIN_MS;
    assert.equal(rerunHasRoom({ createdAt: started }, pageEdge, pageEdge), true);
    assert.equal(rerunHasRoom({ createdAt: started }, pageEdge + 1, pageEdge + 1), false);
    assert.equal(workerStoppedMessage(""), "The export worker stopped. Export again.");
    assert.equal(workerStoppedMessage("Trees"), "The export worker stopped during Trees. Export again.");
    assert.equal(RERUN_NOTE.includes("\u2014"), false);
    assert.equal(workerStoppedMessage("Trees").includes("\u2014"), false);
  });

  it("logs a stage start and finish with elapsed and duration", async () => {
    let t = 5_000;
    const lines = [];
    const logger = createStageLogger(JOB, {
      now: () => t,
      log: (line) => lines.push(line),
    });
    logger.note("Fetching aerial");
    t = 8_200;
    logger.note("Buildings 112");
    t = 16_600;
    logger.note("Trees");
    t = 21_100;
    logger.finish();
    assert.deepEqual(lines, [
      "export " + JOB + " stage start Fetching aerial elapsed 0.0s",
      "export " + JOB + " stage done Fetching aerial duration 3.2s",
      "export " + JOB + " stage start Buildings 112 elapsed 3.2s",
      "export " + JOB + " stage done Buildings 112 duration 8.4s",
      "export " + JOB + " stage start Trees elapsed 11.6s",
      "export " + JOB + " stage done Trees duration 4.5s",
    ]);

    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    const sessionLines = [];
    let stageTime = 1_000;
    const session = createWorkerSession(JOB, {
      now: () => stageTime,
      log: (line) => sessionLines.push(line),
    });
    assert.equal(session.stageName(), "Fetching aerial");
    stageTime = 2_000;
    await session.onProgress({ stage: "Trees" });
    const job = await jobs.readJob(JOB);
    assert.equal(job.heartbeatStage, "Trees");
    assert.equal(typeof job.heartbeatAt, "number");
    assert.equal(job.state, "queued");
    session.finish();
    assert.match(sessionLines.join("\n"), /stage start Fetching aerial elapsed 0\.0s/);
    assert.match(sessionLines.join("\n"), /stage done Fetching aerial duration 1\.0s/);
    assert.match(sessionLines.join("\n"), /stage start Trees elapsed 1\.0s/);
    assert.match(sessionLines.join("\n"), /stage done Trees duration 0\.0s/);

    await jobs.updateJob(JOB, { state: "queued", stage: "Fetching aerial" });
    const timer = startHeartbeatTimer(JOB, () => "Packing zip", 60_000);
    let beating;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      beating = await jobs.readJob(JOB);
    } finally {
      clearInterval(timer);
    }
    assert.equal(beating.state, "queued");
    assert.equal(beating.heartbeatStage, "Packing zip");
    assert.equal(typeof beating.heartbeatAt, "number");
    assert.equal(HEARTBEAT_MS, 10 * 1000);
    assert.equal(jobs.HEARTBEAT_MS, HEARTBEAT_MS);

    await jobs.updateJob(JOB, { state: "done", stage: "Zip ready" });
    const frozen = await jobs.readJob(JOB);
    const returned = await jobs.writeHeartbeat(JOB, "Trees");
    assert.equal(returned.state, "done");
    assert.equal(returned.heartbeatStage, frozen.heartbeatStage);
    assert.equal(returned.heartbeatAt, frozen.heartbeatAt);
  });
});

describe("fly worker auth", { concurrency: 1 }, () => {
  const prevSecret = process.env.OPENCLUTTER_WORKER_SECRET;

  afterEach(() => {
    if (prevSecret == null) delete process.env.OPENCLUTTER_WORKER_SECRET;
    else process.env.OPENCLUTTER_WORKER_SECRET = prevSecret;
    delete process.env.NETLIFY_SITE_ID;
    delete process.env.NETLIFY_AUTH_TOKEN;
  });

  it("rejects a request without the secret", async () => {
    process.env.OPENCLUTTER_WORKER_SECRET = "test-secret";
    const missing = await handleWorkerRequest({
      method: "POST",
      url: "/export",
      headers: {},
      body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
    });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.job, undefined);
    assert.match(missing.body.error, /Unauthorized/);

    const wrong = await handleWorkerRequest({
      method: "POST",
      url: "/export",
      headers: { authorization: "Bearer other-secret" },
      body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.job, undefined);
  });

  it("rejects a request on the HTTP server when the secret is absent", async () => {
    process.env.OPENCLUTTER_WORKER_SECRET = "test-secret";
    const server = await startServer(0);
    const port = server.address().port;
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /Unauthorized/);
      const health = await fetch("http://127.0.0.1:" + port + "/health");
      assert.equal(health.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("fly worker config", () => {
  it("stops when idle and uses one shared 2 GB machine", () => {
    const toml = fs.readFileSync(path.join(root, "fly.toml"), "utf8");
    const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
    assert.match(toml, /auto_stop_machines = "stop"/);
    assert.match(toml, /min_machines_running = 0/);
    assert.match(toml, /size = "shared-cpu-1x"/);
    assert.match(toml, /memory = "2gb"/);
    assert.match(toml, /internal_port = 8080/);
    assert.equal(/performance-1x/.test(toml), false);
    assert.match(docker, /node:22\.14\.0-bookworm-slim/);
    assert.equal(/^\s*FROM\s+bun/im.test(docker), false);
    assert.equal(/["']bun["']/.test(docker), false);
    assert.match(docker, /fly\/server\.js/);
  });
});
