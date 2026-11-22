"use strict";

/**
 * Persistent copy of a successful Overture buildings read.
 *
 * Live Azure parquet is still preferred. This store is only consulted after
 * both live attempts fail, so a later outage can reuse the last good
 * footprints for the same box and pinned release. Failed and empty reads
 * are not stored. Off under NODE_TEST_CONTEXT (createDiskCache).
 */

const zlib = require("node:zlib");
const BUILDING_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const BUILDING_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const buildingCache = require("./disk-cache").createDiskCache({
  envPrefix: "OPENCLUTTER_OVERTURE_CACHE",
  maxBytes: BUILDING_CACHE_MAX_BYTES,
  ttlMs: BUILDING_CACHE_TTL_MS,
  subdir: "overture-buildings",
});

let testStore = undefined;

function setBuildingCacheDir(dir) {
  buildingCache.setDir(dir);
}

function setBuildingCacheLimits(opts) {
  buildingCache.setLimits(opts);
}

function roundedBox(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((n) => (Math.round(+n * 1e5) / 1e5).toFixed(5))
    .join(",");
}

function pinnedRelease() {
  return require("./overture").RELEASE;
}

function cacheKey(bbox, release) {
  const rel = String(release || pinnedRelease() || "release").trim() || "release";
  return rel + "|" + roundedBox(bbox);
}

function payloadOk(value) {
  return value && Array.isArray(value.features) && value.features.length > 0 && value.partial !== true;
}

function cacheNote(entry) {
  const at = entry && entry.savedAt > 0 ? entry.savedAt : 0;
  const day = at
    ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "an earlier date";
  return (
    "Building footprints read from a saved Overture copy dated " +
    day +
    " (the live servers did not answer), so map changes after that date are missing."
  );
}

function frameBox(frame) {
  return {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
  };
}

function readTestStore(key) {
  if (testStore === undefined) return undefined;
  if (!testStore) return null;
  const got = testStore.get(key);
  if (!payloadOk(got)) return null;
  return got;
}

function writeTestStore(key, value) {
  if (testStore === undefined) return false;
  if (!testStore) return true;
  testStore.set(key, value);
  return true;
}

function cacheEnabled(opts) {
  if (opts && opts.diskCache === false) return false;
  if (opts && opts.reader && opts.diskCache !== true) return false;
  return true;
}

async function readBuildingCache(frame, opts) {
  if (!cacheEnabled(opts)) return null;
  const key = cacheKey(frameBox(frame), opts && opts.release);
  const fromTest = readTestStore(key);
  if (fromTest !== undefined) return fromTest;
  try {
    const buf = await buildingCache.read(key);
    if (!buf || !buf.length) return null;
    const value = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
    if (!payloadOk(value)) return null;
    if (value.release && opts && opts.release && value.release !== opts.release) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeBuildingCache(frame, result, opts) {
  if (!cacheEnabled(opts)) return false;
  if (!payloadOk(result)) return false;
  const release = (opts && opts.release) || result.release || pinnedRelease();
  const key = cacheKey(frameBox(frame), release);
  const value = {
    features: result.features,
    rowGroups: result.rowGroups || 0,
    groupsRead: result.groupsRead || 0,
    release,
    savedAt: Date.now(),
  };
  if (writeTestStore(key, value)) return true;
  try {
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
    if (!buf.length) return false;
    await buildingCache.write(key, buf);
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  testStore = undefined;
}

function setStoreForTests(store) {
  testStore = store;
}

module.exports = {
  BUILDING_CACHE_TTL_MS,
  BUILDING_CACHE_MAX_BYTES,
  cacheKey,
  cacheNote,
  payloadOk,
  readBuildingCache,
  writeBuildingCache,
  setBuildingCacheDir,
  setBuildingCacheLimits,
  resetForTests,
  setStoreForTests,
};
