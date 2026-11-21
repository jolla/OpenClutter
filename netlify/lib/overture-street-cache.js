"use strict";

/**
 * Persistent copy of a successful Overture street-map read.
 *
 * Live Azure parquet is still preferred. This store is only consulted after
 * both live attempts fail, so a later outage can reuse the last good street
 * map for the same box and release. Raw Range/206 parquet tiles are not
 * stored here (area-cache skips those on purpose). The value is the already
 * decoded Overpass-shaped elements.
 *
 * Writes go to Netlify Blobs when the export area-cache store is enabled,
 * and to disk when OPENCLUTTER_OVERPASS_CACHE_DIR is set (benches and
 * official gates). Either store is optional; a miss just falls through.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const areaCache = require("./area-cache");
const { RELEASE } = require("./overture");

const STREET_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DISK_KIND = "overture-street";

let testStore = undefined;

function ttlMs() {
  return STREET_TTL_MS;
}

function diskDir() {
  return String(process.env.OPENCLUTTER_OVERPASS_CACHE_DIR || "").trim();
}

function roundedBox(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((n) => (Math.round(+n * 1e5) / 1e5).toFixed(5))
    .join(",");
}

function cacheKey(bbox, release) {
  const rel = String(release || RELEASE || "release").trim() || "release";
  return rel + "|" + roundedBox(bbox);
}

function blobKey(key) {
  return areaCache.cacheKey("overture", "street", areaCache.tileId(keyToBbox(key)) + "_" + key.split("|")[0]);
}

function keyToBbox(key) {
  const box = String(key).split("|")[1] || "";
  const p = box.split(",").map(Number);
  if (p.length < 4 || !p.every(Number.isFinite)) {
    return { west: 0, south: 0, east: 0, north: 0 };
  }
  return { west: p[0], south: p[1], east: p[2], north: p[3] };
}

function diskPathFor(key) {
  const dir = diskDir();
  if (!dir) return "";
  const hash = crypto.createHash("sha256").update(DISK_KIND + "\n" + key).digest("hex");
  return path.join(dir, DISK_KIND, hash.slice(0, 2), hash + ".gz");
}

function payloadOk(value) {
  return value && Array.isArray(value.elements) && value.elements.length > 0;
}

function fresh(savedAt, now) {
  if (!(savedAt > 0)) return false;
  const at = now > 0 ? now : Date.now();
  return at <= savedAt + STREET_TTL_MS;
}

function cacheNote(entry) {
  const at = entry && entry.savedAt > 0 ? entry.savedAt : 0;
  const day = at
    ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "an earlier date";
  return (
    "Street map read from a saved Overture copy dated " +
    day +
    " (the live servers did not answer), so map changes after that date are missing."
  );
}

function readTestStore(key) {
  if (testStore === undefined) return undefined;
  if (!testStore) return null;
  const got = testStore.get(key);
  if (!payloadOk(got) || !fresh(got.savedAt)) return null;
  return got;
}

function writeTestStore(key, value) {
  // undefined: no test hook, use Blobs/disk. null: tests disabled
  // shared stores so a mock read cannot pollute the official cache dir.
  if (testStore === undefined) return false;
  if (!testStore) return true;
  testStore.set(key, value);
  return true;
}

function readDisk(key) {
  const file = diskPathFor(key);
  if (!file) return null;
  try {
    const got = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    if (!payloadOk(got) || !fresh(got.savedAt)) return null;
    return got;
  } catch {
    return null;
  }
}

function writeDisk(key, value) {
  const file = diskPathFor(key);
  if (!file || !payloadOk(value)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

async function readBlobs(key) {
  if (!areaCache.enabled()) return null;
  try {
    const got = await areaCache.readRaw(null, blobKey(key));
    if (!got || !got.body || !got.body.length) return null;
    const value = JSON.parse(got.body.toString("utf8"));
    if (!payloadOk(value)) return null;
    const savedAt = value.savedAt > 0 ? value.savedAt : got.meta && got.meta.savedAt;
    if (!fresh(savedAt)) return null;
    if (!(value.savedAt > 0) && savedAt > 0) value.savedAt = savedAt;
    return value;
  } catch {
    return null;
  }
}

async function writeBlobs(key, value) {
  if (!areaCache.enabled() || !payloadOk(value)) return false;
  try {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    await areaCache.writeRaw(null, blobKey(key), body, {
      source: "overture",
      resolution: "street",
      tile: key,
      savedAt: value.savedAt,
      contentType: "application/json",
    });
    return true;
  } catch {
    return false;
  }
}

async function readStreetCache(bbox, opts) {
  const key = cacheKey(bbox, opts && opts.release);
  const fromTest = readTestStore(key);
  if (fromTest !== undefined) return fromTest;
  const blob = await readBlobs(key);
  if (blob) return blob;
  return readDisk(key);
}

async function writeStreetCache(bbox, result, opts) {
  if (!result || !Array.isArray(result.elements) || !result.elements.length) return false;
  const release = (opts && opts.release) || result.release || RELEASE;
  const key = cacheKey(bbox, release);
  const value = {
    elements: result.elements,
    themes: result.themes || {},
    release,
    savedAt: Date.now(),
  };
  if (writeTestStore(key, value)) return true;
  let ok = false;
  try {
    if (await writeBlobs(key, value)) ok = true;
  } catch {
    /* disk may still take it */
  }
  if (writeDisk(key, value)) ok = true;
  return ok;
}

function resetForTests() {
  testStore = undefined;
}

function setStoreForTests(store) {
  testStore = store;
}

module.exports = {
  STREET_TTL_MS,
  cacheKey,
  cacheNote,
  readStreetCache,
  writeStreetCache,
  resetForTests,
  setStoreForTests,
};
