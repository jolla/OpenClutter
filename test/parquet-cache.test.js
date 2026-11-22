"use strict";

// 1.3.41: Overture range reads, file lengths and footers are kept per process.
// 1.3.75: cap in-flight Azure ranges and retry a dropped one.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const pc = require("../netlify/lib/parquet-cache");

function fakeReader(len, hooks) {
  const calls = { open: 0, slices: 0, meta: 0, withLength: 0 };
  const reader = {
    calls,
    async asyncBufferFromUrl(opts) {
      calls.open++;
      if (opts.byteLength) calls.withLength++;
      return {
        byteLength: len,
        slice: async (s, e) => {
          calls.slices++;
          if (hooks && hooks.slice) await hooks.slice(s, e, calls);
          if (s === 13) throw new Error("network");
          const b = new Uint8Array(e - s);
          for (let i = 0; i < b.length; i++) b[i] = (s + i) & 255;
          return b.buffer;
        },
      };
    },
    async parquetMetadataAsync(src) {
      calls.meta++;
      await src.slice(len - 8, len);
      return { rows: 7 };
    },
  };
  return reader;
}

describe("parquet process cache", () => {
  beforeEach(() => pc.resetForTests());
  afterEach(() => {
    delete process.env.OPENCLUTTER_PARQUET_CACHE_MB;
    pc.resetForTests();
  });

  it("reads each range, length and footer once and returns the same bytes", async () => {
    const r = fakeReader(1000);
    const a = await pc.cachedSource(r, "u1", null);
    const x = new Uint8Array(await a.slice(10, 20));
    const b = await pc.cachedSource(r, "u1", null);
    const y = new Uint8Array(await b.slice(10, 20));
    assert.deepEqual([...x], [...y]);
    assert.equal(x[0], 10);
    assert.equal(r.calls.slices, 1);
    assert.equal(r.calls.withLength, 1);
    const m1 = await pc.cachedMetadata(r, "u1", a);
    const m2 = await pc.cachedMetadata(r, "u1", b);
    assert.equal(m1, m2);
    assert.equal(r.calls.meta, 1);
  });

  it("drops a failed read so the next export asks again", async () => {
    const r = fakeReader(1000);
    const a = await pc.cachedSource(r, "u2", null);
    await assert.rejects(a.slice(13, 20));
    await assert.rejects(a.slice(13, 20));
    assert.equal(r.calls.slices, pc.RANGE_ATTEMPTS * 2);
  });

  it("evicts the oldest ranges past the byte cap", async () => {
    process.env.OPENCLUTTER_PARQUET_CACHE_MB = String(1500 / (1024 * 1024));
    const r = fakeReader(100000);
    const a = await pc.cachedSource(r, "u3", null);
    await a.slice(0, 1000);
    await a.slice(1000, 2000);
    assert.ok(pc.cacheStats().rangeBytes <= 1500);
    await a.slice(1000, 2000);
    assert.equal(r.calls.slices, 2);
    await a.slice(0, 1000);
    assert.equal(r.calls.slices, 3);
  });

  it("treats a dropped range as transient and an abort as final", () => {
    assert.equal(pc.isTransientRangeError(new TypeError("fetch failed")), true);
    assert.equal(pc.isTransientRangeError(new Error("ECONNRESET")), true);
    assert.equal(pc.isTransientRangeError(new Error("HTTP 503")), true);
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    assert.equal(pc.isTransientRangeError(abort), false);
    assert.equal(pc.isTransientRangeError(new Error("The operation was aborted due to timeout")), false);
    assert.equal(pc.isTransientRangeError(new Error("OVERTURE_RELEASE_GONE")), false);
  });

  it("retries a first-attempt fetch failed and keeps the bytes", async () => {
    pc.setRangeLimits({ attempts: 2, retryMs: 5 });
    const fails = new Map();
    const r = fakeReader(1000, {
      slice: async (s) => {
        if (s === 40) {
          const n = (fails.get(s) || 0) + 1;
          fails.set(s, n);
          if (n === 1) throw new TypeError("fetch failed");
        }
      },
    });
    const a = await pc.cachedSource(r, "u5", null);
    const got = new Uint8Array(await a.slice(40, 50));
    assert.equal(got[0], 40);
    assert.equal(r.calls.slices, 2);
    assert.equal(pc.cacheStats().retries, 1);
    const again = new Uint8Array(await a.slice(40, 50));
    assert.deepEqual([...again], [...got]);
    assert.equal(r.calls.slices, 2);
  });

  it("does not retry an aborted range read", async () => {
    pc.setRangeLimits({ attempts: 3, retryMs: 5 });
    const r = fakeReader(1000, {
      slice: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const a = await pc.cachedSource(r, "u6", null);
    await assert.rejects(a.slice(0, 10), (err) => err && err.name === "AbortError");
    assert.equal(r.calls.slices, 1);
    assert.equal(pc.cacheStats().retries, 0);
  });

  it("caps in-flight range reads", async () => {
    pc.setRangeLimits({ concurrency: 4, attempts: 1, retryMs: 0 });
    let inflight = 0;
    let max = 0;
    const r = fakeReader(100000, {
      slice: async () => {
        inflight++;
        if (inflight > max) max = inflight;
        await new Promise((resolve) => setTimeout(resolve, 20));
        inflight--;
      },
    });
    const a = await pc.cachedSource(r, "u7", null);
    await Promise.all(Array.from({ length: 20 }, (_, i) => a.slice(i * 10, i * 10 + 10)));
    assert.ok(max <= 4, "max in flight " + max);
    assert.ok(pc.cacheStats().maxActive <= 4, "stats maxActive " + pc.cacheStats().maxActive);
    assert.equal(r.calls.slices, 20);
  });

  it("unblocks a queued range when the caller aborts, and frees the slot after a hung slice aborts", async () => {
    pc.setRangeLimits({ concurrency: 1, attempts: 1, retryMs: 0 });
    let releaseHang;
    const hang = new Promise((resolve) => {
      releaseHang = resolve;
    });
    const r = fakeReader(100000, {
      slice: async (s) => {
        if (s === 0) await hang;
      },
    });
    const a = await pc.cachedSource(r, "u8", null);
    const first = a.slice(0, 10);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ctrl = new AbortController();
    const queued = pc.cachedSource(r, "u8", ctrl.signal).then((b) => b.slice(20, 30));
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(queued, (err) => err && err.name === "AbortError");
    assert.ok(Date.now() - started < 200, "queued abort waited " + (Date.now() - started) + " ms");
    const hungCtrl = new AbortController();
    const hungSrc = await pc.cachedSource(r, "u9", hungCtrl.signal);
    const hung = hungSrc.slice(0, 10); // different url, but concurrency still held by first
    // The u9 slice is also queued behind the hung u8 slice. Abort it too,
    // then abort/finish the holder and confirm a new slice can acquire a slot.
    setTimeout(() => hungCtrl.abort(), 10);
    await assert.rejects(hung, (err) => err && err.name === "AbortError");
    releaseHang();
    await first;
    const after = await a.slice(40, 50);
    assert.equal(new Uint8Array(after)[0], 40);
  });

  it("stops waiting on a hung slice when the signal aborts", async () => {
    pc.setRangeLimits({ concurrency: 1, attempts: 1, retryMs: 0 });
    const r = fakeReader(1000, {
      slice: () => new Promise(() => {}),
    });
    const ctrl = new AbortController();
    const a = await pc.cachedSource(r, "u10", ctrl.signal);
    const p = a.slice(0, 10);
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(p, (err) => err && err.name === "AbortError");
    assert.ok(Date.now() - started < 200, "hung slice abort waited " + (Date.now() - started) + " ms");
    assert.equal(pc.cacheStats().rangeActive, 0);
    assert.equal(pc.cacheStats().rangeWaiters, 0);
  });
});
