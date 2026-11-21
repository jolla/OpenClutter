"use strict";

/**
 * FEMA / Oak Ridge USA Structures (Living Atlas).
 *
 * MSBFP2 and the July/August 2026 Global ML quadkey both miss large roofs
 * inside the Oak Creek corridor. This layer has some of those polygons
 * (ORNL / NGA). An envelope query that returns geometry times out on this
 * service, so the fetch is object ids first, then geometry by id.
 * Callers merge these only when the centroid is not already inside a
 * Microsoft footprint. OSM building ways are not read here; the export
 * fills uncovered OSM footprints after this layer is merged.
 */

const LAYER =
  "https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0/query";

const ID_CAP = 500;
const CHUNK = 50;
const POOL = 4;
const USA_ATTEMPT_MS = 8000;
const USA_RETRIES = 2;
const USA_RETRY_WAIT_MS = 250;
const USA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const USA_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const usaCache = require("./disk-cache").createDiskCache({
  envPrefix: "OPENCLUTTER_USA_CACHE",
  maxBytes: USA_CACHE_MAX_BYTES,
  ttlMs: USA_CACHE_TTL_MS,
  subdir: "usa",
});

function setUsaCacheDir(dir) {
  usaCache.setDir(dir);
}

function setUsaCacheLimits(opts) {
  usaCache.setLimits(opts);
}

function usaCacheEnabled(fetchFn, opts) {
  if (!usaCache.dir()) return false;
  if (opts && opts.diskCache === false) return false;
  if (opts && opts.diskCache === true) return true;
  return !fetchFn || fetchFn === fetch;
}

function cacheKey(frame) {
  return [
    "usa-v1",
    LAYER,
    +frame.west,
    +frame.south,
    +frame.east,
    +frame.north,
  ].join("|");
}

function usableHeight(attrs) {
  const h = Number(attrs && attrs.HEIGHT);
  return h > 2 && h < 400 ? h : 0;
}

/** Esri polygon: first ring is the exterior, later rings are holes. */
function esriFeaturesToGeojson(features) {
  const out = [];
  const list = Array.isArray(features) ? features : [];
  for (let i = 0; i < list.length; i++) {
    const rings = list[i] && list[i].geometry && list[i].geometry.rings;
    if (!rings || !rings[0] || rings[0].length < 4) continue;
    const height = usableHeight(list[i].attributes);
    const properties = { geomSource: "usa" };
    if (height) {
      properties.height = height;
      properties.heightSource = "fema";
    }
    out.push({
      type: "Feature",
      properties,
      geometry: { type: "Polygon", coordinates: [rings[0]] },
    });
  }
  return out;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort|timeout/i.test(String(err.message || err));
}

function abortError(message) {
  const err = new Error(message || "The operation was aborted");
  err.name = "AbortError";
  return err;
}

function emptyReasonOf(err) {
  if (isAbortError(err)) return "timeout";
  return "error";
}

function failedPack(reason, partial) {
  return { features: [], partial: !!partial, failed: true, emptyReason: reason || "error" };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(worker());
  await Promise.all(jobs);
  return out;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAttempt(fetchFn, url, attemptMs, outerSignal) {
  if (outerSignal && outerSignal.aborted) throw abortError();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), attemptMs);
  const onAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener("abort", onAbort, { once: true });
  try {
    const work = Promise.resolve(fetchFn(url, ctrl.signal));
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(abortError());
      if (ctrl.signal.aborted) fail();
      else ctrl.signal.addEventListener("abort", fail, { once: true });
    });
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
  }
}

async function fetchWithRetry(fetchFn, url, opts) {
  const attemptMs = opts.attemptMs;
  const retries = opts.retries;
  const outerSignal = opts.signal;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (outerSignal && outerSignal.aborted) throw lastErr || abortError();
    try {
      const res = await fetchAttempt(fetchFn, url, attemptMs, outerSignal);
      if (!res || res.ok === false) {
        throw new Error("usa structures HTTP " + (res && res.status));
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (outerSignal && outerSignal.aborted) throw err;
      if (attempt >= retries) throw err;
      if (opts.retryWaitMs > 0) await wait(opts.retryWaitMs);
    }
  }
  throw lastErr || new Error("usa structures");
}

async function readIdPack(frame, fetchFn, opts) {
  const geometry = [frame.west, frame.south, frame.east, frame.north].join(",");
  const idUrl =
    LAYER +
    "?" +
    new URLSearchParams({
      where: "1=1",
      geometry,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnIdsOnly: "true",
      f: "json",
    });
  const idRes = await fetchWithRetry(fetchFn, idUrl, opts);
  const idJson = await idRes.json();
  if (idJson && idJson.error) {
    throw new Error("usa structures " + (idJson.error.message || "ids"));
  }
  return (idJson.objectIds || []).slice(0, ID_CAP);
}

async function readChunk(fetchFn, chunk, opts) {
  const url =
    LAYER +
    "?" +
    new URLSearchParams({
      objectIds: chunk.join(","),
      outFields: "HEIGHT",
      outSR: "4326",
      returnGeometry: "true",
      f: "json",
    });
  const res = await fetchWithRetry(fetchFn, url, {
    attemptMs: opts.attemptMs,
    retries: 1,
    retryWaitMs: opts.retryWaitMs,
    signal: opts.signal,
  });
  const body = await res.json();
  if (body && body.error) {
    throw new Error("usa structures " + (body.error.message || "query"));
  }
  return esriFeaturesToGeojson(body.features);
}

async function fetchUsaStructuresWork(frame, fetchFn, opts) {
  const ids = await readIdPack(frame, fetchFn, opts);
  if (!ids.length) return { features: [], partial: false, failed: false, emptyReason: "none" };
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  let partial = false;
  const parts = await mapPool(chunks, POOL, async (chunk) => {
    try {
      return await readChunk(fetchFn, chunk, opts);
    } catch (e) {
      partial = true;
      if (isAbortError(e) && opts.signal && opts.signal.aborted) return [];
      return [];
    }
  });
  const features = [];
  for (const part of parts) {
    for (const feature of part || []) features.push(feature);
  }
  if (!features.length) {
    return failedPack(partial ? "timeout" : "error", partial);
  }
  return { features, partial, failed: false };
}

async function fetchUsaStructures(frame, fetchFn, opts) {
  const attemptMs =
    opts && Number.isFinite(+opts.attemptMs) && +opts.attemptMs > 0
      ? Math.max(50, +opts.attemptMs)
      : USA_ATTEMPT_MS;
  const retries =
    opts && Number.isFinite(+opts.retries) && +opts.retries >= 0
      ? Math.max(0, +opts.retries | 0)
      : USA_RETRIES;
  const retryWaitMs =
    opts && Number.isFinite(+opts.retryWaitMs)
      ? Math.max(0, +opts.retryWaitMs)
      : USA_RETRY_WAIT_MS;
  const request = { attemptMs, retries, retryWaitMs, signal: opts && opts.signal };
  const fetchImpl = fetchFn || fetch;
  const useCache = usaCacheEnabled(fetchFn, opts);
  const key = cacheKey(frame);
  if (useCache) {
    const buf = await usaCache.read(key);
    if (buf && buf.length) {
      try {
        const pack = JSON.parse(buf.toString("utf8"));
        if (pack && Array.isArray(pack.features) && pack.features.length) {
          usaCache.note("usaStructures", true);
          return { features: pack.features, partial: false, failed: false, cached: true };
        }
      } catch {
        /* a corrupt entry is a miss */
      }
    }
    usaCache.note("usaStructures", false);
  }
  try {
    const pack = await fetchUsaStructuresWork(frame, fetchImpl, request);
    if (useCache && pack && pack.features && pack.features.length && !pack.partial && !pack.failed) {
      await usaCache.write(key, Buffer.from(JSON.stringify({ features: pack.features }), "utf8"));
    }
    return pack;
  } catch (err) {
    return failedPack(emptyReasonOf(err));
  }
}

function boxesOverlap(frame, west, south, east, north) {
  if (!frame) return false;
  return !(+frame.east < west || +frame.west > east || +frame.north < south || +frame.south > north);
}

/** CONUS, Alaska, Hawaii, Puerto Rico / USVI, Guam, American Samoa. */
function intersectsUsaStructures(frame) {
  if (!frame) return false;
  return (
    boxesOverlap(frame, -125, 24, -66, 50) ||
    boxesOverlap(frame, -180, 51, -129, 72) ||
    boxesOverlap(frame, -170, 51, -129, 72) ||
    boxesOverlap(frame, -161, 18, -154, 23) ||
    boxesOverlap(frame, -68, 17, -64, 19) ||
    boxesOverlap(frame, 144, 13, 146, 16) ||
    boxesOverlap(frame, -171, -15, -169, -14)
  );
}

function usaEmptyWarning(pack, opts) {
  const n = pack && Array.isArray(pack.features) ? pack.features.length : 0;
  if (n) return "";
  const frame = opts && opts.frame;
  if (frame && !intersectsUsaStructures(frame)) return "";
  const failed = !pack || pack.failed || (pack.emptyReason && pack.emptyReason !== "none");
  const others = opts && opts.otherFootprints > 0;
  if (!failed && !others) return "";
  return "USA Structures omitted: the building outlines were not returned. Microsoft and OpenStreetMap footprints are still included.";
}

module.exports = {
  LAYER,
  ID_CAP,
  USA_ATTEMPT_MS,
  USA_RETRIES,
  USA_CACHE_MAX_BYTES,
  USA_CACHE_TTL_MS,
  esriFeaturesToGeojson,
  fetchUsaStructures,
  setUsaCacheDir,
  setUsaCacheLimits,
  usaEmptyWarning,
  intersectsUsaStructures,
};
