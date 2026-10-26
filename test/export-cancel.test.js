"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jobs = require("../netlify/lib/export-jobs");
const clutter = require("../netlify/functions/clutter");
const { completeExportJob } = require("../netlify/lib/export-run");
const { handOffExport, cancelOnWorker, cancelUrl, setHandoffDepsForTests } = require("../netlify/lib/fly-handoff");
const cancelFn = require("../netlify/functions/export-cancel");
const { handler: backgroundHandler } = require("../netlify/functions/clutter-export-background");
const {
  handleWorkerRequest,
  startHeartbeatTimer,
  setExportRunnerForTests,
  jobInFlight,
} = require("../fly/worker");
const { startServer, useIdleExit, setCancelExitForTests } = require("../fly/server");

const JOB = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ENV_KEYS = [
  "OPENCLUTTER_WORKER_SECRET",
  "NETLIFY_SITE_ID",
  "NETLIFY_AUTH_TOKEN",
  "FLY_WORKER_URL",
  "FLY_WORKER_SECRET",
  "FLY_MACHINE_ID",
];

function memoryStore() {
  const map = new Map();
  return {
    map,
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

function innerEvent() {
  return { httpMethod: "POST", headers: { host: "dev--openclutter.netlify.app" }, body: "{}" };
}

function auth(extra) {
  return Object.assign({ "content-type": "application/json", authorization: "Bearer test-secret" }, extra || {});
}

const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
const realRun = clutter.runBackgroundExport;

afterEach(() => {
  jobs.setExportStoreForTests(null);
  setExportRunnerForTests(null);
  setHandoffDepsForTests(null);
  cancelFn.setWorkerCancelForTests(null);
  setCancelExitForTests(null);
  useIdleExit(null);
  clutter.runBackgroundExport = realRun;
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function workerEnv() {
  process.env.OPENCLUTTER_WORKER_SECRET = "test-secret";
  process.env.NETLIFY_SITE_ID = "site";
  process.env.NETLIFY_AUTH_TOKEN = "token";
}

describe("export cancel: job store", { concurrency: 1 }, () => {
  it("marks a running job cancelled, terminal, and keeps that state", async () => {
    jobs.setExportStoreForTests(memoryStore());
    await jobs.createJob(JOB);
    await jobs.updateJob(JOB, { state: "running", worker: "fly", stage: "Detecting trees" });
    const job = await jobs.cancelJob(JOB);
    assert.equal(job.state, "cancelled");
    assert.equal(job.stage, jobs.CANCEL_STAGE);
    assert.ok(jobs.isTerminalState("cancelled"));
    assert.equal(await jobs.jobCancelled(JOB), true);
    const later = await jobs.updateJob(JOB, { state: "done", stage: "Zip ready", zipBytes: 9 });
    assert.equal(later.state, "cancelled");
    assert.equal(later.zipBytes, 0);
    const staged = await jobs.updateJob(JOB, { stage: "Building zip", tilesDone: 1, tilesTotal: 2 });
    assert.equal(staged.stage, jobs.CANCEL_STAGE);
    const beat = await jobs.writeHeartbeat(JOB, "Building zip");
    assert.equal(beat.state, "cancelled");
    assert.equal(beat.heartbeatAt, undefined);
  });

  it("leaves a finished job alone and ignores bad or missing ids", async () => {
    jobs.setExportStoreForTests(memoryStore());
    await jobs.createJob(JOB);
    await jobs.updateJob(JOB, { state: "done", stage: "Zip ready" });
    const job = await jobs.cancelJob(JOB);
    assert.equal(job.state, "done");
    assert.equal(await jobs.cancelJob("nope"), null);
    assert.equal(await jobs.cancelJob(OTHER), null);
  });
});

describe("export cancel: completeExportJob", { concurrency: 1 }, () => {
  it("runs nothing for a job cancelled before it started", async () => {
    jobs.setExportStoreForTests(memoryStore());
    await jobs.createJob(JOB);
    await jobs.cancelJob(JOB);
    let ran = false;
    clutter.runBackgroundExport = async () => {
      ran = true;
      return { statusCode: 200, body: "{}" };
    };
    const out = await completeExportJob(JOB, innerEvent(), { worker: "fly" });
    assert.equal(out.cancelled, true);
    assert.equal(ran, false);
  });

  it("stores no zip when the job is cancelled while it runs", async () => {
    const store = memoryStore();
    jobs.setExportStoreForTests(store);
    await jobs.createJob(JOB);
    clutter.runBackgroundExport = async () => {
      await jobs.cancelJob(JOB);
      return {
        statusCode: 200,
        body: JSON.stringify({ zipBase64: Buffer.from("zip").toString("base64"), zipFilename: "a.zip" }),
      };
    };
    const out = await completeExportJob(JOB, innerEvent(), { worker: "netlify" });
    assert.equal(out.cancelled, true);
    assert.equal(store.map.has("job/" + JOB + "/zip"), false);
    const job = await jobs.readJob(JOB);
    assert.equal(job.state, "cancelled");
    assert.equal(job.zipFilename, null);
  });
});

describe("export cancel: Netlify paths", { concurrency: 1 }, () => {
  it("does not hand a cancelled job to the worker or run it here", async () => {
    jobs.setExportStoreForTests(memoryStore());
    process.env.FLY_WORKER_URL = "https://worker.example";
    process.env.FLY_WORKER_SECRET = "test-secret";
    await jobs.createJob(JOB);
    await jobs.cancelJob(JOB);
    let calls = 0;
    const out = await handOffExport(JOB, innerEvent(), async () => {
      calls += 1;
      return { status: 202, text: async () => "" };
    });
    assert.equal(out.handed, true);
    assert.equal(out.reason, "cancelled");
    assert.equal(calls, 0);
    let ran = false;
    clutter.runBackgroundExport = async () => {
      ran = true;
      return { statusCode: 500, body: "{}" };
    };
    const res = await backgroundHandler({ body: JSON.stringify({ jobId: JOB, event: innerEvent() }) });
    assert.equal(res.statusCode, 202);
    assert.equal(ran, false);
  });

  it("export-cancel marks the job and pokes the machine running it", async () => {
    jobs.setExportStoreForTests(memoryStore());
    await jobs.createJob(JOB);
    await jobs.updateJob(JOB, { state: "running", worker: "fly", flyMachine: "abc123def456" });
    const seen = [];
    cancelFn.setWorkerCancelForTests(async (id, machine) => {
      seen.push([id, machine]);
      return { sent: true, status: 200 };
    });
    const res = await cancelFn.handler({ httpMethod: "POST", queryStringParameters: { job: JOB } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.cancelled, true);
    assert.equal(body.workerStatus, 200);
    assert.deepEqual(seen, [[JOB, "abc123def456"]]);
    assert.equal((await jobs.readJob(JOB)).state, "cancelled");
    const again = JSON.parse((await cancelFn.handler({ httpMethod: "POST", body: JSON.stringify({ jobId: JOB }) })).body);
    assert.equal(again.state, "cancelled");
  });

  it("export-cancel rejects GET, bad ids and unknown jobs", async () => {
    jobs.setExportStoreForTests(memoryStore());
    assert.equal((await cancelFn.handler({ httpMethod: "GET", queryStringParameters: { job: JOB } })).statusCode, 405);
    assert.equal((await cancelFn.handler({ httpMethod: "POST", queryStringParameters: { job: "x" } })).statusCode, 400);
    assert.equal((await cancelFn.handler({ httpMethod: "POST", queryStringParameters: { job: OTHER } })).statusCode, 404);
  });

  it("cancelOnWorker posts to /cancel with the secret and the machine pin", async () => {
    process.env.FLY_WORKER_URL = "https://worker.example/export";
    process.env.FLY_WORKER_SECRET = "s3";
    assert.equal(cancelUrl("https://w.example/"), "https://w.example/cancel");
    let got = null;
    const out = await cancelOnWorker(JOB, "abc123def456", async (url, init) => {
      got = { url, init };
      return { status: 200 };
    });
    assert.deepEqual(out, { sent: true, status: 200 });
    assert.equal(got.url, "https://worker.example/cancel");
    assert.equal(got.init.headers.authorization, "Bearer s3");
    assert.equal(got.init.headers["fly-force-instance-id"], "abc123def456");
    assert.deepEqual(JSON.parse(got.init.body), { jobId: JOB });
    delete process.env.FLY_WORKER_URL;
    assert.deepEqual(await cancelOnWorker(JOB, "", async () => ({ status: 200 })), { sent: false, status: 0 });
  });
});

describe("export cancel: Fly worker", { concurrency: 1 }, () => {
  it("POST /cancel needs the secret and a matching running job", async () => {
    workerEnv();
    assert.equal(
      (await handleWorkerRequest({ method: "POST", url: "/cancel", headers: {}, body: JSON.stringify({ jobId: JOB }) })).statusCode,
      401
    );
    const idle = await handleWorkerRequest({ method: "POST", url: "/cancel", headers: auth(), body: JSON.stringify({ jobId: JOB }) });
    assert.equal(idle.statusCode, 404);
    const bad = await handleWorkerRequest({ method: "POST", url: "/cancel", headers: auth(), body: JSON.stringify({ jobId: "x" }) });
    assert.equal(bad.statusCode, 400);
  });

  it("a heartbeat that reads a cancelled job calls back", async () => {
    jobs.setExportStoreForTests(memoryStore());
    await jobs.createJob(JOB);
    await jobs.cancelJob(JOB);
    let why = "";
    const timer = startHeartbeatTimer(JOB, "Detecting trees", 1000, (w) => {
      why = w;
    });
    try {
      for (let i = 0; i < 50 && !why; i++) await new Promise((r) => setTimeout(r, 5));
    } finally {
      clearInterval(timer);
    }
    assert.equal(why, "job cancelled");
  });

  it("cancel stops the held export, answers cancelled, exits, and frees the slot", async () => {
    workerEnv();
    process.env.FLY_MACHINE_ID = "abc123def456";
    jobs.setExportStoreForTests(memoryStore());
    await jobs.createJob(JOB);
    let exits = 0;
    setCancelExitForTests(() => {
      exits += 1;
    });
    let stored = false;
    setExportRunnerForTests(async () => {
      await new Promise(() => {});
      stored = true;
    });
    const server = await startServer(0);
    const base = "http://127.0.0.1:" + server.address().port;
    try {
      const res = await fetch(base + "/export", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ jobId: JOB, event: innerEvent() }),
      });
      assert.equal(res.status, 202);
      assert.equal(jobInFlight(), true);
      const text = res.text();
      const wrong = await fetch(base + "/cancel", { method: "POST", headers: auth(), body: JSON.stringify({ jobId: OTHER }) });
      assert.equal(wrong.status, 404);
      const ok = await fetch(base + "/cancel", { method: "POST", headers: auth(), body: JSON.stringify({ jobId: JOB }) });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).cancelled, true);
      const last = JSON.parse((await text).trim().split("\n").pop());
      assert.equal(last.cancelled, true);
      assert.equal(last.ok, true);
      for (let i = 0; i < 50 && exits === 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(exits, 1);
      assert.equal(jobInFlight(), false);
      assert.equal(stored, false);
      assert.equal((await jobs.readJob(JOB)).flyMachine, "abc123def456");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("export cancel: page", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  it("Cancel calls the server on every page (1.2.41)", () => {
    const fn = /function stopServerExport\(jobId\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(fn, "stopServerExport is defined");
    assert.match(fn[1], /if \(!jobId \|\| !serverCancelWanted\(\)\) return;/);
    assert.doesNotMatch(fn[1], /devPage\(\)/);
    const wanted = /function serverCancelWanted\(\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(wanted, "serverCancelWanted is defined");
    assert.match(wanted[1], /return true;/);
    assert.match(fn[1], /\/api\/export-cancel\?job=/);
    assert.match(fn[1], /method: "POST"/);
    const cancel = /function cancelExport\(\) \{([\s\S]*?)\n\}/.exec(app);
    assert.match(cancel[1], /stopServerExport\(run\.jobId\)/);
    assert.match(app, /run\.jobId = queued\.jobId;/);
  });
});
