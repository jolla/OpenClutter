"use strict";

// 1.3.95: the silence rule can fail a live Netlify run whose main thread is
// busy. Only that same job and attempt may later replace the error with done.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jobs = require("../netlify/lib/export-jobs");
const usage = require("../netlify/lib/usage");
const watchdog = require("../netlify/lib/job-watchdog");
const { handler: statusHandler } = require("../netlify/functions/export-status");
const progress = require("../public/export-progress");

function memoryStore() {
  const map = new Map();
  let seq = 0;
  return {
    map,
    async setJSON(key, value, opts) {
      if (opts && opts.onlyIfNew && map.has(key)) return { modified: false };
      if (opts && opts.onlyIfMatch) {
        const cur = map.get(key);
        if (!cur || cur.etag !== opts.onlyIfMatch) return { modified: false };
      }
      const etag = String(++seq);
      map.set(key, { etag, value: JSON.parse(JSON.stringify(value)) });
      return { modified: true, etag };
    },
    async set(key, value) {
      map.set(key, { etag: String(++seq), value });
    },
    async get(key) {
      const row = map.get(key);
      return row ? row.value : null;
    },
    async getWithMetadata(key) {
      const row = map.get(key);
      if (!row) return null;
      return { data: row.value, etag: row.etag, metadata: {} };
    },
    async delete(key) {
      map.delete(key);
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

const ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";

async function status(id) {
  const res = await statusHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { job: id } });
  return JSON.parse(res.body);
}

async function quietRun(id, attempt) {
  const now = Date.now();
  await jobs.updateJob(id, {
    state: "running",
    stage: "Trees",
    worker: "netlify",
    netlifyAttempt: attempt,
    netlifyStartedAt: now - 6 * 60 * 1000,
    netlifyBeatAt: now - watchdog.NETLIFY_SILENCE_MS - 1000,
  });
}

const done = (attempt) => ({ state: "done", stage: "Zip ready", error: null, zipFilename: "a.zip", zipBytes: 10, netlifyAttempt: attempt });

afterEach(() => {
  jobs.setExportStoreForTests(null);
  usage.setStoreForTests(undefined);
});

describe("late done after the silence rule (1.3.95)", () => {
  function setup() {
    jobs.setExportStoreForTests(memoryStore());
    usage.setStoreForTests(memoryStore());
  }

  it("the status read fails the quiet run but tells the page to keep watching", async () => {
    setup();
    await quietRun(ID, "attempt-A");
    const s = await status(ID);
    assert.equal(s.state, "error");
    assert.match(s.error, /^The export worker stopped during Trees\./);
    assert.ok(s.lateDoneWaitMs > 0 && s.lateDoneWaitMs <= 10 * 60 * 1000);
    assert.equal(progress.lateDoneWait(s), true);
    assert.ok(!("stoppedAttempt" in s) && !("netlifyAttempt" in s), "attempt id is never exposed");
  });

  it("only the same attempt replaces the error; another attempt or a Fly write does not", async () => {
    setup();
    await quietRun(ID, "attempt-A");
    await status(ID);
    await jobs.updateJob(ID, done("attempt-B"));
    await jobs.updateJob(ID, { state: "done", stage: "Zip ready", worker: "fly" });
    let s = await status(ID);
    assert.equal(s.state, "error");
    await jobs.updateJob(ID, done("attempt-A"));
    s = await status(ID);
    assert.equal(s.state, "done");
    assert.equal(s.error, null);
    assert.equal(s.lateDone, true);
    assert.equal(s.lateDoneWaitMs, 0);
    assert.equal(s.zipBytes, 10);
  });

  it("a new job is separate: the old attempt never touches it", async () => {
    setup();
    await quietRun(ID, "attempt-A");
    await status(ID);
    await jobs.updateJob(OTHER, { state: "running", stage: "Buildings", worker: "fly" });
    await jobs.updateJob(OTHER, done("attempt-A"));
    const other = await jobs.readJob(OTHER);
    assert.equal(other.lateDone, undefined);
    assert.equal((await status(ID)).state, "error");
  });

  it("errors that are not a silent beat never come back", async () => {
    setup();
    for (const reason of ["netlify-retry", "deadline", "export-deadline"]) {
      await jobs.updateJob(ID, { state: "error", stage: "Export failed", error: "x", stoppedReason: reason, stoppedAttempt: "attempt-A", netlifyStartedAt: Date.now() });
      await jobs.updateJob(ID, done("attempt-A"));
      const s = await status(ID);
      assert.equal(s.state, "error", reason);
      assert.equal(s.lateDoneWaitMs, 0, reason);
      jobs.setExportStoreForTests(memoryStore());
    }
  });

  it("Cancel while the page watches stops a late finish from bringing the job back", async () => {
    setup();
    await quietRun(ID, "attempt-A");
    await status(ID);
    await jobs.cancelJob(ID);
    let s = await status(ID);
    assert.equal(s.lateDoneWaitMs, 0);
    assert.equal(progress.lateDoneWait(s), false);
    await jobs.updateJob(ID, done("attempt-A"));
    s = await status(ID);
    assert.equal(s.state, "error");
  });

  it("the page stops waiting once the attempt's 16 minute clock is gone", () => {
    const job = { state: "error", stoppedReason: "heartbeat-stale", stoppedAttempt: "A", netlifyStartedAt: 1000 };
    assert.equal(watchdog.lateDoneWindowMs(job, 1000 + watchdog.NETLIFY_LIMIT_MS + 1), 0);
    assert.ok(watchdog.lateDoneWindowMs(job, 1000 + 60000) > 0);
    assert.equal(progress.lateDoneWait({ state: "error", lateDoneWaitMs: 0 }), false);
    assert.equal(progress.lateDoneWait({ state: "running", lateDoneWaitMs: 5 }), false);
  });
});

describe("Netlify attempt tagging in completeExportJob (1.3.95)", () => {
  it("a busy run failed by the silence rule still finishes as done", async () => {
    jobs.setExportStoreForTests(memoryStore());
    usage.setStoreForTests(memoryStore());
    const clutter = require("../netlify/functions/clutter");
    const { completeExportJob } = require("../netlify/lib/export-run");
    const keep = clutter.runBackgroundExport;
    let release;
    const gate = new Promise((r) => (release = r));
    clutter.runBackgroundExport = async (_inner, onProgress) => {
      await onProgress({ stage: "Trees" });
      await gate;
      return { statusCode: 200, body: JSON.stringify({ zipBase64: Buffer.from("zip").toString("base64"), zipFilename: "s.zip", warnings: [] }) };
    };
    try {
      await jobs.updateJob(ID, { state: "queued" });
      const run = completeExportJob(ID, { body: "{}" }, { worker: "netlify", netlifyBeat: true });
      for (let i = 0; i < 50; i++) {
        const j = await jobs.readJob(ID);
        if (j && j.stage === "Trees") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const live = await jobs.readJob(ID);
      assert.ok(live.netlifyAttempt && live.netlifyAttempt.length >= 32);
      // The silence rule fires while the run is still busy.
      await jobs.updateJob(ID, (cur) => watchdog.stalledJobPatch(cur, Date.now() + watchdog.NETLIFY_SILENCE_MS + 20000));
      const failed = await jobs.readJob(ID);
      assert.equal(failed.state, "error");
      assert.equal(failed.stoppedAttempt, live.netlifyAttempt);
      release();
      const out = await run;
      assert.equal(out.finished, true);
      const fin = await jobs.readJob(ID);
      assert.equal(fin.state, "done");
      assert.equal(fin.error, null);
      assert.equal(fin.zipBytes, 3);
    } finally {
      clutter.runBackgroundExport = keep;
    }
  });
});
