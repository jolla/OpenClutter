"use strict";

/**
 * Process-level cache for Overture GeoParquet range reads (1.3.41).
 *
 * Overture release files are immutable, so a byte range read once is the
 * same bytes for every later export on this machine. Kept here:
 *   - each file's length (skips the HEAD request),
 *   - each file's parsed footer (skips two footer reads per row group),
 *   - the raw range bytes, up to OPENCLUTTER_PARQUET_CACHE_MB (default 256).
 * A repeat export of the same area on a warm worker reads its row groups
 * from memory. These are raw source bytes, never final geometry.
 *
 * hyparquet's page-index path can open hundreds of Azure range requests at
 * once. A shared cap plus a short retry on a dropped range (1.3.75) keeps
 * a dense street or building read from failing the whole theme when one
 * request is reset.
 */

const MAX_RANGE_BYTES = 16 * 1024 * 1024;
const RANGE_CONCURRENCY = 24;
const RANGE_ATTEMPTS = 3;
const RANGE_RETRY_MS = 50;
const SMALL_RANGE_BYTES = 64 * 1024;

function capBytes() {
  const mb = Number(process.env.OPENCLUTTER_PARQUET_CACHE_MB);
  const fallback = require("./host-memory").lowMemoryHost() ? 32 : 256;
  return (Number.isFinite(mb) && mb >= 0 ? mb : fallback) * 1024 * 1024;
}

const lengths = new Map();
const metas = new Map();
const ranges = new Map();
let rangeBytes = 0;
const stats = { hits: 0, misses: 0, metaHits: 0, metaMisses: 0, retries: 0, maxActive: 0 };

let concurrency = RANGE_CONCURRENCY;
let attempts = RANGE_ATTEMPTS;
let retryMs = RANGE_RETRY_MS;
let active = 0;
const waiters = [];

function touch(map, key, value) {
  map.delete(key);
  map.set(key, value);
}

function evict() {
  const cap = capBytes();
  for (const [key, entry] of ranges) {
    if (rangeBytes <= cap) break;
    if (!entry.bytes) continue;
    ranges.delete(key);
    rangeBytes -= entry.bytes;
  }
}

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function isTransientRangeError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return false;
  const msg = String(err && err.message ? err.message : err);
  if (/aborted/i.test(msg)) return false;
  return /timeout|timed out|econnreset|etimedout|enotfound|eai_again|econnrefused|socket|network|fetch failed|http 5\d\d|429|503|504/i.test(msg);
}

function whenAborted(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(abortError());
    if (!signal) return;
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

function acquirePreferSmall(bytes, signal) {
  if (signal && signal.aborted) return Promise.reject(abortError());
  if (active < concurrency) {
    active++;
    if (active > stats.maxActive) stats.maxActive = active;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const item = { resolve, reject, small: bytes < SMALL_RANGE_BYTES };
    const onAbort = () => {
      const i = waiters.indexOf(item);
      if (i >= 0) waiters.splice(i, 1);
      reject(abortError());
    };
    if (signal) {
      item.clearAbort = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (item.small) {
      const i = waiters.findIndex((w) => w && w.small === false);
      if (i >= 0) waiters.splice(i, 0, item);
      else waiters.push(item);
    } else {
      waiters.push(item);
    }
  });
}

function release() {
  if (waiters.length) {
    const next = waiters.shift();
    if (next && typeof next.clearAbort === "function") next.clearAbort();
    (typeof next === "function" ? next : next.resolve)();
  } else {
    active--;
    if (active < 0) active = 0;
  }
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function limitedSlice(buf, start, end, signal) {
  const want = (end == null ? buf.byteLength : end) - start;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) throw abortError();
    await acquirePreferSmall(want, signal);
    try {
      if (signal && signal.aborted) throw abortError();
      const work = Promise.resolve(buf.slice(start, end));
      return signal ? await Promise.race([work, whenAborted(signal)]) : await work;
    } catch (err) {
      lastErr = err;
      if (!isTransientRangeError(err) || attempt >= attempts) throw err;
      stats.retries++;
    } finally {
      release();
    }
    await sleep(retryMs * attempt, signal);
  }
  throw lastErr;
}

function cachedSlice(url, buf, start, end, signal) {
  const key = url + "|" + start + "|" + end;
  const hit = ranges.get(key);
  if (hit) {
    stats.hits++;
    touch(ranges, key, hit);
    // A later caller must not wait out a hung shared read past its own deadline.
    return signal ? Promise.race([hit.promise, whenAborted(signal)]) : hit.promise;
  }
  stats.misses++;
  const entry = { bytes: 0, promise: null };
  entry.promise = limitedSlice(buf, start, end, signal).then(
    (ab) => {
      const n = ab && ab.byteLength ? ab.byteLength : 0;
      if (n > 0 && n <= MAX_RANGE_BYTES && capBytes() > 0 && ranges.get(key) === entry) {
        entry.bytes = n;
        rangeBytes += n;
        evict();
      } else if (ranges.get(key) === entry) {
        ranges.delete(key);
      }
      return ab;
    },
    (err) => {
      if (ranges.get(key) === entry) ranges.delete(key);
      throw err;
    }
  );
  ranges.set(key, entry);
  return entry.promise;
}

/**
 * An AsyncBuffer for url whose slices go through the shared range cache.
 * signal still aborts this export's own network reads.
 */
async function cachedSource(reader, url, signal) {
  const known = lengths.get(url);
  const opts = { url, requestInit: { signal } };
  if (known > 0) opts.byteLength = known;
  const buf = await reader.asyncBufferFromUrl(opts);
  if (buf && buf.byteLength > 0 && !(known > 0)) lengths.set(url, buf.byteLength);
  if (!buf || typeof buf.slice !== "function") return buf;
  return {
    byteLength: buf.byteLength,
    slice: (start, end) => cachedSlice(url, buf, start, end === undefined ? buf.byteLength : end, signal),
  };
}

/** Parsed footer for url, read once per process. Null when the reader cannot parse it. */
async function cachedMetadata(reader, url, source) {
  if (!reader.parquetMetadataAsync) return null;
  const hit = metas.get(url);
  if (hit) {
    stats.metaHits++;
    touch(metas, url, hit);
    return hit;
  }
  stats.metaMisses++;
  const p = Promise.resolve(reader.parquetMetadataAsync(source)).catch((err) => {
    if (metas.get(url) === p) metas.delete(url);
    throw err;
  });
  metas.set(url, p);
  while (metas.size > 64) metas.delete(metas.keys().next().value);
  return p;
}

function setRangeLimits(opts) {
  const o = opts || {};
  if (o.concurrency > 0) concurrency = o.concurrency | 0;
  if (o.attempts > 0) attempts = o.attempts | 0;
  if (o.retryMs >= 0) retryMs = o.retryMs | 0;
}

function resetForTests() {
  lengths.clear();
  metas.clear();
  ranges.clear();
  rangeBytes = 0;
  stats.hits = stats.misses = stats.metaHits = stats.metaMisses = stats.retries = stats.maxActive = 0;
  concurrency = RANGE_CONCURRENCY;
  attempts = RANGE_ATTEMPTS;
  retryMs = RANGE_RETRY_MS;
  while (waiters.length) {
    const next = waiters.shift();
    try {
      if (next && typeof next.clearAbort === "function") next.clearAbort();
      (typeof next === "function" ? next : next.resolve)();
    } catch {
      /* a leftover waiter should not break the next test */
    }
  }
  active = 0;
}

function cacheStats() {
  return Object.assign(
    { rangeBytes, ranges: ranges.size, files: metas.size, rangeActive: active, rangeWaiters: waiters.length, rangeConcurrency: concurrency },
    stats
  );
}

module.exports = {
  cachedSource,
  cachedMetadata,
  resetForTests,
  setRangeLimits,
  cacheStats,
  isTransientRangeError,
  whenAborted,
  MAX_RANGE_BYTES,
  RANGE_CONCURRENCY,
  RANGE_ATTEMPTS,
  RANGE_RETRY_MS,
  SMALL_RANGE_BYTES,
};
