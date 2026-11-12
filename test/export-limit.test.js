"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const usage = require("../netlify/lib/usage");
const jobs = require("../netlify/lib/export-jobs");
const exportLimit = require("../netlify/lib/export-limit");
const { handler: statusHandler } = require("../netlify/functions/export-status");

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IP = "203.0.113.9";
const OTHER_IP = "198.51.100.20";
const NOON = Date.parse("2026-11-12T16:00:00Z");

function uuid(n) {
  const hex = String(n).padStart(12, "0");
  return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
}

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

function browser(extra) {
  return Object.assign(
    { host: "openclutter.com", "user-agent": CHROME, "x-nf-client-connection-ip": IP },
    extra || {}
  );
}

afterEach(() => {
  usage.setStoreForTests(undefined);
  usage.setNowForTests(null);
  usage.resetSweepForTests();
  jobs.setExportStoreForTests(null);
  jobs.setInvokeFetchForTests(null);
});

describe("per-user export limit", { concurrency: 1 }, () => {
  it("lets the first two jobs start and holds a third with a clear queued label", async () => {
    const usageStore = memoryStore();
    const jobStore = memoryStore();
    usage.setStoreForTests(usageStore);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(jobStore);
    const headers = browser();
    const a = await jobs.createJob(uuid(1), { headers, now: NOON });
    const b = await jobs.createJob(uuid(2), { headers, now: NOON });
    const c = await jobs.createJob(uuid(3), { headers, now: NOON });
    assert.equal(a.concurrencyWait, undefined);
    assert.equal(b.concurrencyWait, undefined);
    assert.equal(c.concurrencyWait, true);
    assert.equal(c.queueReason, "user-limit");
    assert.equal(c.stageLabel, exportLimit.USER_WAIT_LABEL);
    assert.equal(c.state, "queued");
    assert.equal(a.usageVisitor, c.usageVisitor);
    assert.ok(a.usageVisitor);
  });

  it("does not limit a visitor with a different IP, or a job with no visitor", async () => {
    const usageStore = memoryStore();
    const jobStore = memoryStore();
    usage.setStoreForTests(usageStore);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(jobStore);
    const headers = browser();
    await jobs.createJob(uuid(1), { headers, now: NOON });
    await jobs.createJob(uuid(2), { headers, now: NOON });
    const other = await jobs.createJob(uuid(3), {
      headers: browser({ "x-nf-client-connection-ip": OTHER_IP }),
      now: NOON,
    });
    const bare = await jobs.createJob(uuid(4));
    assert.equal(other.concurrencyWait, undefined);
    assert.equal(bare.concurrencyWait, undefined);
    assert.equal(bare.usageVisitor, undefined);
  });

  it("starts the waiting job when one of the two active jobs finishes", async () => {
    const usageStore = memoryStore();
    const jobStore = memoryStore();
    usage.setStoreForTests(usageStore);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(jobStore);
    const calls = [];
    jobs.setInvokeFetchForTests(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { status: 202 };
    });
    const headers = browser();
    const first = await jobs.createJob(uuid(1), { headers, now: NOON });
    await jobs.createJob(uuid(2), { headers, now: NOON });
    const third = await jobs.createJob(uuid(3), { headers, now: NOON });
    await jobs.saveInvoke(third.id, {
      url: "https://openclutter.com/.netlify/functions/clutter-export-background",
      payload: { jobId: third.id, event: { body: "{}" } },
    });
    assert.equal(third.concurrencyWait, true);
    assert.equal(calls.length, 0);
    await jobs.updateJob(first.id, { state: "done", stage: "Zip ready" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.jobId, third.id);
    const started = await jobs.readJob(third.id);
    assert.equal(started.concurrencyWait, false);
    assert.equal(started.queueReason, null);
    assert.equal(started.stageLabel, "Waiting for a worker");
    assert.ok(started.invokeStartedAt);
  });

  it("starts the waiting job when an active job is cancelled", async () => {
    const usageStore = memoryStore();
    const jobStore = memoryStore();
    usage.setStoreForTests(usageStore);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(jobStore);
    const calls = [];
    jobs.setInvokeFetchForTests(async () => {
      calls.push(1);
      return { status: 202 };
    });
    const headers = browser();
    const first = await jobs.createJob(uuid(1), { headers, now: NOON });
    await jobs.createJob(uuid(2), { headers, now: NOON });
    const third = await jobs.createJob(uuid(3), { headers, now: NOON });
    await jobs.saveInvoke(third.id, {
      url: "https://openclutter.com/.netlify/functions/clutter-export-background",
      payload: { jobId: third.id, event: { body: "{}" } },
    });
    await jobs.cancelJob(first.id);
    assert.equal(calls.length, 1);
    const started = await jobs.readJob(third.id);
    assert.equal(started.concurrencyWait, false);
    assert.ok(started.invokeStartedAt);
  });

  it("status keeps the waiting label and does not start a third job early", async () => {
    const usageStore = memoryStore();
    const jobStore = memoryStore();
    usage.setStoreForTests(usageStore);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(jobStore);
    const calls = [];
    jobs.setInvokeFetchForTests(async () => {
      calls.push(1);
      return { status: 202 };
    });
    const headers = browser();
    await jobs.createJob(uuid(1), { headers, now: NOON });
    await jobs.createJob(uuid(2), { headers, now: NOON });
    const third = await jobs.createJob(uuid(3), { headers, now: NOON });
    await jobs.saveInvoke(third.id, {
      url: "https://openclutter.com/.netlify/functions/clutter-export-background",
      payload: { jobId: third.id, event: { body: "{}" } },
    });
    const res = await statusHandler({
      httpMethod: "GET",
      queryStringParameters: { job: third.id },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.state, "queued");
    assert.equal(body.stageLabel, exportLimit.USER_WAIT_LABEL);
    assert.equal(body.concurrencyWait, true);
    assert.equal(body.queueReason, "user-limit");
    assert.equal(calls.length, 0);
  });
});
