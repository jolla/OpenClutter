"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jobs = require("../netlify/lib/export-jobs");
const { FALLBACK_NOTE, handOffExport } = require("../netlify/lib/fly-handoff");
const { handler: backgroundHandler } = require("../netlify/functions/clutter-export-background");
const { handleWorkerRequest } = require("../fly/worker");
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
