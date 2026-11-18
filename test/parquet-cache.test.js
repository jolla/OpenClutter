"use strict";

// 1.3.41: Overture range reads, file lengths and footers are kept per process.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const pc = require("../netlify/lib/parquet-cache");

function fakeReader(len) {
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
    assert.equal(r.calls.slices, 2);
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
});
