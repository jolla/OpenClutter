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
 */

const MAX_RANGE_BYTES = 16 * 1024 * 1024;

function capBytes() {
  const mb = Number(process.env.OPENCLUTTER_PARQUET_CACHE_MB);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 256) * 1024 * 1024;
}

const lengths = new Map();
const metas = new Map();
const ranges = new Map();
let rangeBytes = 0;
const stats = { hits: 0, misses: 0, metaHits: 0, metaMisses: 0 };

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

function cachedSlice(url, buf, start, end) {
  const key = url + "|" + start + "|" + end;
  const hit = ranges.get(key);
  if (hit) {
    stats.hits++;
    touch(ranges, key, hit);
    return hit.promise;
  }
  stats.misses++;
  const entry = { bytes: 0, promise: null };
  entry.promise = Promise.resolve(buf.slice(start, end)).then(
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
    slice: (start, end) => cachedSlice(url, buf, start, end === undefined ? buf.byteLength : end),
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

function resetForTests() {
  lengths.clear();
  metas.clear();
  ranges.clear();
  rangeBytes = 0;
  stats.hits = stats.misses = stats.metaHits = stats.metaMisses = 0;
}

function cacheStats() {
  return Object.assign({ rangeBytes, ranges: ranges.size, files: metas.size }, stats);
}

module.exports = { cachedSource, cachedMetadata, resetForTests, cacheStats, MAX_RANGE_BYTES };
