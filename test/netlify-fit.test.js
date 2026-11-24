"use strict";

// 1.3.94: Netlify retries a background function whose process died. The
// retry fails the job at once instead of dying the same way twice more.
const test = require("node:test");
const assert = require("node:assert/strict");
const { priorNetlifyAttempt, deadAttemptPatch, NETLIFY_DEAD_BEAT_MS } = require("../netlify/lib/job-watchdog");

const T = 1_800_000_000_000;
const store = (jobs) => async (id) => (typeof jobs === "function" ? jobs() : jobs[id]) || null;

test("a job no Netlify attempt started runs (first invoke, Fly rerun)", async () => {
  const r = await priorNetlifyAttempt(store({ a: { state: "queued" } }), "a", { now: () => T });
  assert.equal(r.verdict, "none");
  const fly = await priorNetlifyAttempt(store({ a: { state: "running", worker: "fly", heartbeatAt: T - 90000 } }), "a", { now: () => T });
  assert.equal(fly.verdict, "none");
});

test("a retry after the attempt went silent fails at once with the clear error", async () => {
  const job = { state: "running", worker: "netlify", stage: "Fetching footprints", netlifyStartedAt: T - 80000, netlifyBeatAt: T - NETLIFY_DEAD_BEAT_MS - 1 };
  let slept = 0;
  const r = await priorNetlifyAttempt(store({ a: job }), "a", { now: () => T, sleep: async () => slept++ });
  assert.equal(r.verdict, "dead");
  assert.equal(slept, 0);
  const p = deadAttemptPatch(r.job);
  assert.equal(p.state, "error");
  assert.equal(p.stoppedReason, "netlify-retry");
  assert.match(p.error, /^The export worker stopped during Fetching footprints \(the backup server ran out of room\)\. Export again\./);
});

test("a recent beat waits one beat window: still beating is left alone, silent is failed", async () => {
  const base = { state: "running", worker: "netlify", stage: "Trees", netlifyStartedAt: T - 30000, netlifyBeatAt: T - 5000 };
  let n = 0;
  const alive = await priorNetlifyAttempt(store(() => (n++ === 0 ? base : Object.assign({}, base, { netlifyBeatAt: T + 6000 }))), "a", { now: () => T, sleep: async () => {} });
  assert.equal(alive.verdict, "alive");
  const dead = await priorNetlifyAttempt(store({ a: base }), "a", { now: () => T, sleep: async () => {} });
  assert.equal(dead.verdict, "dead");
});

test("a finished job is neither failed nor run again by a late retry", async () => {
  const r = await priorNetlifyAttempt(store({ a: { state: "done", netlifyStartedAt: T - 60000, netlifyBeatAt: T - 60000 } }), "a", { now: () => T });
  assert.equal(r.verdict, "finished");
});

function withHost(env, fn) {
  const keep = { m: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE, f: process.env.OPENCLUTTER_LOW_MEMORY };
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", env.mem);
  set("OPENCLUTTER_LOW_MEMORY", env.force);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      set("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", keep.m);
      set("OPENCLUTTER_LOW_MEMORY", keep.f);
    });
}

test("roomy host (Fly, benches): heavy sources start at once, in the same tick, with the same value", () =>
  withHost({}, async () => {
    const { oneHeavySource } = require("../netlify/lib/host-memory");
    const order = [];
    const p = { tag: 1 };
    const a = oneHeavySource(() => (order.push("a"), p));
    oneHeavySource(() => order.push("b"));
    assert.equal(a, p);
    assert.deepEqual(order, ["a", "b"]);
  }));

test("1 GB host: heavy sources run one at a time, and a failure does not stall the queue", () =>
  withHost({ mem: "1024" }, async () => {
    const { oneHeavySource } = require("../netlify/lib/host-memory");
    let open = 0;
    let most = 0;
    const job = (ms, fail) => () =>
      new Promise((res, rej) => {
        open++;
        most = Math.max(most, open);
        setTimeout(() => {
          open--;
          fail ? rej(new Error("x")) : res(ms);
        }, ms);
      });
    const got = await Promise.allSettled([oneHeavySource(job(20)), oneHeavySource(job(5, true)), oneHeavySource(job(10))]);
    assert.equal(most, 1);
    assert.deepEqual(got.map((g) => g.status), ["fulfilled", "rejected", "fulfilled"]);
  }));

function bigTile(bytes) {
  const { Readable } = require("node:stream");
  return async () => ({
    ok: true,
    headers: { get: (n) => (String(n).toLowerCase() === "content-length" ? String(bytes) : null) },
    body: Readable.from([Buffer.alloc(0)]),
  });
}

test("1 GB host: a Microsoft tile over 128 MB is left out with the usual note naming that limit", () =>
  withHost({ mem: "1024" }, async () => {
    const ms = require("../netlify/lib/ms-global");
    const box = { west: -87.9217, south: 42.89544, east: -87.9155, north: 42.90276 };
    const pack = await ms.fetchMsGlobalFootprints(box, bigTile(200 * 1024 * 1024), { diskCache: false });
    assert.equal(pack.skipped, 1);
    assert.equal(pack.capBytes, ms.LOW_MEMORY_GZIP_BYTES);
    assert.equal(
      ms.globalSkipWarning(pack),
      "Microsoft building footprints omitted: the footprint tile is 200 MB, over the 128 MB export limit. Other building sources are included."
    );
  }));

test("roomy host: the same tile is read, the 512 MB guard is unchanged, and the pack has no new field", () =>
  withHost({}, async () => {
    const ms = require("../netlify/lib/ms-global");
    const box = { west: -87.9217, south: 42.89544, east: -87.9155, north: 42.90276 };
    const pack = await ms.fetchMsGlobalFootprints(box, bigTile(200 * 1024 * 1024), { diskCache: false });
    assert.equal(pack.skipped, 1); // an empty body is a parse miss, not a size skip
    assert.equal(pack.skippedErrors, 1);
    assert.ok(!("capBytes" in pack));
    assert.deepEqual(Object.keys(pack), ["features", "quadkeys", "files", "skipped", "skippedBytes", "skippedErrors"]);
    const over = await ms.fetchMsGlobalFootprints(box, bigTile(600 * 1024 * 1024), { diskCache: false });
    assert.match(ms.globalSkipWarning(over), /over the 512 MB export limit/);
  }));

test("background function: a source-tiles batch never reads the job; a dead retry fails without running", async () => {
  const jobs = require("../netlify/lib/export-jobs");
  const areaCache = require("../netlify/lib/area-cache");
  const keep = { readJob: jobs.readJob, updateJob: jobs.updateJob, jobCancelled: jobs.jobCancelled, bindBlobs: jobs.bindBlobs, run: areaCache.runTileBatch };
  const reads = [];
  const updates = [];
  jobs.bindBlobs = () => {};
  jobs.jobCancelled = async () => false;
  jobs.readJob = async (id) => (reads.push(id), { state: "running", worker: "netlify", stage: "Fetching footprints", netlifyStartedAt: Date.now() - 90000, netlifyBeatAt: Date.now() - 60000 });
  jobs.updateJob = async (id, patch) => (updates.push([id, patch]), null);
  areaCache.runTileBatch = async () => {};
  try {
    const { handler } = require("../netlify/functions/clutter-export-background");
    const tiles = await handler({ body: JSON.stringify({ mode: "source-tiles", tiles: [] }) });
    assert.equal(tiles.statusCode, 202);
    assert.equal(reads.length, 0);
    assert.equal(updates.length, 0);
    const id = "0f0f0f0f-1111-4222-8333-444444444444";
    await handler({ body: JSON.stringify({ jobId: id, event: { body: "{}" } }) });
    assert.deepEqual(reads, [id]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0][1].state, "error");
    assert.equal(updates[0][1].stoppedReason, "netlify-retry");
  } finally {
    Object.assign(jobs, { readJob: keep.readJob, updateJob: keep.updateJob, jobCancelled: keep.jobCancelled, bindBlobs: keep.bindBlobs });
    areaCache.runTileBatch = keep.run;
  }
});
