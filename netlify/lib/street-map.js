"use strict";

/**
 * Street-map read for an export: Overture transportation and base first,
 * with a smaller Overpass query in parallel for features Overture does not
 * cover well (building parts, camp areas and pitches, palms, moorings,
 * area:highway, and a few others). If Overture fails, a recently saved
 * Overture read for the same box is reused when one exists; otherwise the
 * full Overpass path is used, still merged with the gap answer so marina
 * boats and the other gap features are not dropped.
 */

const { fetchOsmMaps, bboxSpanM, TILE_SPAN_M } = require("./osm-tiles");
const overpass = require("./overpass");
const { fetchOvertureStreet } = require("./overture-street");
const streetPersist = require("./overture-street-cache");
const stageClock = require("./stage-clock");

const streetCache = new Map();
const STREET_CACHE_MS = 120000;
const GAP_DEADLINE_MS = 25000;
const STREET_OVERTURE_ATTEMPTS = 2;
const GAP_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const GAP_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const GAP_MISS =
  "OpenStreetMap gap features did not return. Marina boats, moorings, and camp pitches may be missing. The Overture street map is still included.";

const gapCache = require("./disk-cache").createDiskCache({
  envPrefix: "OPENCLUTTER_GAP_CACHE",
  maxBytes: GAP_CACHE_MAX_BYTES,
  ttlMs: GAP_CACHE_TTL_MS,
  subdir: "overpass-gap",
});

function setGapCacheDir(dir) {
  gapCache.setDir(dir);
}

function setGapCacheLimits(opts) {
  gapCache.setLimits(opts);
}

function gapCacheEnabled(opts) {
  if (!gapCache.dir()) return false;
  if (opts && opts.diskCache === false) return false;
  if (opts && opts.diskCache === true) return true;
  if (opts && opts.fetchGapOverpass) return false;
  return true;
}

function gapDiskKey(bbox) {
  return ["gap-v1", +bbox.west, +bbox.south, +bbox.east, +bbox.north].join("|");
}

function gapEmptyWarning(pack) {
  if (pack && pack.ok && Array.isArray(pack.elements)) return "";
  return GAP_MISS;
}

function missedGap(pack) {
  const notes = pack && Array.isArray(pack.notes) ? pack.notes.slice() : [];
  if (notes.indexOf(GAP_MISS) < 0) notes.push(GAP_MISS);
  return { ok: false, elements: [], notes };
}

function gapQuery(bbox) {
  const box = [+bbox.south, +bbox.west, +bbox.north, +bbox.east].join(",");
  return (
    "[out:json][timeout:15];(" +
    'way["building:part"](' + box + ");" +
    'relation["building:part"](' + box + ");" +
    'way["building"](' + box + ");" +
    'relation["type"="multipolygon"]["building"](' + box + ");" +
    'way["leisure"="swimming_pool"](' + box + ");" +
    'way["tourism"="caravan_site"](' + box + ");" +
    'relation["tourism"="caravan_site"](' + box + ");" +
    'way["tourism"="camp_site"](' + box + ");" +
    'relation["tourism"="camp_site"](' + box + ");" +
    'node["tourism"="camp_pitch"](' + box + ");" +
    'way["tourism"="camp_pitch"](' + box + ");" +
    'node["tourism"~"^(caravan_site|camp_site)$"](' + box + ");" +
    'way["area:highway"](' + box + ");" +
    'way["place"="square"](' + box + ");" +
    'node["mooring"](' + box + ");" +
    'way["mooring"](' + box + ");" +
    'node["seamark:type"="mooring"](' + box + ");" +
    'way["residential"="mobile_home"](' + box + ");" +
    'way["leisure"="marina"](' + box + ");" +
    'relation["leisure"="marina"](' + box + ");" +
    'way["landuse"="harbour"](' + box + ");" +
    'way["man_made"="pier"](' + box + ");" +
    'way["natural"="coastline"](' + box + ");" +
    'node["natural"="tree"]["leaf_type"="palm"](' + box + ");" +
    'node["natural"="tree"]["genus"~"phoenix|washingtonia|syagrus|roystonea|sabal|cocos|trachycarpus|butia|livistona|chamaerops|brahea|archontophoenix|dypsis|bismarckia|areca",i](' + box + ");" +
    'node["natural"="tree"]["species"~"phoenix|washingtonia|syagrus|roystonea|sabal|cocos|trachycarpus|butia|livistona|chamaerops|brahea|archontophoenix|dypsis|bismarckia|areca|palm",i](' + box + ");" +
    'node["natural"="tree"]["taxon"~"phoenix|washingtonia|syagrus|roystonea|sabal|cocos|trachycarpus|butia|livistona|chamaerops|brahea|archontophoenix|dypsis|bismarckia|areca|palm",i](' + box + ");" +
    'way["building"~"^(static_caravan|mobile_home|caravan)$"](' + box + ");" +
    'relation["building"~"^(static_caravan|mobile_home|caravan)$"](' + box + ");" +
    ");out geom;"
  );
}

function cacheKey(bbox, opts) {
  const box = [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((n) => (Math.round(+n * 1e5) / 1e5).toFixed(5))
    .join(",");
  const tile = opts && opts.tile ? "1" : "0";
  const ovt = opts && opts.overture === false ? "noovt" : "ovt";
  return box + "|" + tile + "|" + ovt;
}

function dedupeElements(batches) {
  const seen = new Set();
  const out = [];
  for (let b = 0; b < batches.length; b++) {
    const list = batches[b] || [];
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el) continue;
      const key = el.type && el.id != null ? el.type + "/" + el.id : "";
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(el);
    }
  }
  return out;
}

function capGapDeadline(deadlineMs) {
  if (deadlineMs > 0 && deadlineMs < GAP_DEADLINE_MS) return deadlineMs;
  return GAP_DEADLINE_MS;
}

async function readGapCache(bbox) {
  const buf = await gapCache.read(gapDiskKey(bbox));
  if (!buf || !buf.length) return null;
  try {
    const pack = JSON.parse(buf.toString("utf8"));
    if (pack && pack.ok && Array.isArray(pack.elements) && pack.elements.length) return pack;
  } catch {
    /* a corrupt entry is a miss */
  }
  return null;
}

async function fetchGapOverpassWork(bbox, opts) {
  const o = opts || {};
  const q = gapQuery(bbox);
  const deadlineMs = capGapDeadline(o.deadlineMs);
  const started = Date.now();
  const req = (left) =>
    overpass.requestJson(q, {
      signal: o.signal,
      ua: o.ua,
      deadlineMs: left,
      tag: "gap",
    });
  try {
    let json = await req(deadlineMs);
    if (!json || !Array.isArray(json.elements)) {
      const left = deadlineMs - (Date.now() - started);
      // requestJson already retries until deadlineMs. Only try again if
      // that first pass ended early, and stay inside the same budget so a
      // small draw cannot wait two full 25 s gap reads.
      if (left >= 1000) json = await req(left);
    }
    if (!json || !Array.isArray(json.elements)) return missedGap();
    return { ok: true, elements: json.elements };
  } catch {
    return missedGap();
  }
}

async function fetchGapOverpass(bbox, opts) {
  const useCache = gapCacheEnabled(opts);
  if (useCache) {
    const hit = await readGapCache(bbox);
    if (hit) {
      gapCache.note("overpassGap", true);
      return Object.assign({ cached: true }, hit);
    }
    gapCache.note("overpassGap", false);
  }
  const pack = await fetchGapOverpassWork(bbox, opts);
  if (useCache && pack && pack.ok && pack.elements && pack.elements.length) {
    await gapCache.write(gapDiskKey(bbox), Buffer.from(JSON.stringify({ ok: true, elements: pack.elements }), "utf8"));
  }
  return pack;
}

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function waitUnlessAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

function isTransientOvertureError(err) {
  const msg = String(err || "");
  if (!msg) return true;
  return /abort|timeout|timed out|econnreset|etimedout|enotfound|eai_again|econnrefused|socket|network|fetch failed|http 5\d\d|429|503|504/i.test(msg);
}

function overtureFallbackNote(error) {
  const msg = error ? String(error).replace(/\s+/g, " ").trim() : "";
  if (msg) return "Overture street-map read failed (" + msg + "); used the full Overpass path.";
  return "Overture street-map read failed; used the full Overpass path.";
}

/**
 * Shared street-map read. One caller's abort does not cancel work another
 * caller is still waiting on.
 */
async function fetchStreetMapsWork(bbox, opts) {
  const o = opts || {};
  if (o.fetchImpl || o.overture === false) return fetchOsmMaps(bbox, o);

  const ovtFetch = o.fetchOvertureStreet || fetchOvertureStreet;
  const gapFetch = o.fetchGapOverpass || fetchGapOverpass;
  const fullFetch = o.fetchOsmMaps || fetchOsmMaps;

  const ovtWork = stageClock.timeSource("overture", () =>
    ovtFetch(bbox, { signal: null, deadlineMs: o.overtureDeadlineMs })
  );
  const gapDeadline = capGapDeadline(o.deadlineMs);
  const gapWork = stageClock.timeSource("overpass", () =>
    gapFetch(bbox, { ua: o.ua, signal: null, deadlineMs: gapDeadline })
  );

  let ovt = null;
  try {
    ovt = await ovtWork;
  } catch (e) {
    ovt = { ok: false, elements: [], error: String(e && e.message ? e.message : e) };
  }
  for (let attempt = 1; attempt < STREET_OVERTURE_ATTEMPTS && !(ovt && ovt.ok); attempt++) {
    if (!isTransientOvertureError(ovt && ovt.error)) break;
    try {
      ovt = await ovtFetch(bbox, { signal: null, deadlineMs: o.overtureDeadlineMs });
    } catch (e) {
      ovt = { ok: false, elements: [], error: String(e && e.message ? e.message : e) };
    }
  }
  if (ovt && ovt.ok) {
    let gap = { elements: [] };
    try {
      gap = await gapWork;
    } catch {
      gap = missedGap();
    }
    if (gap && gap.ok === false) gap = missedGap(gap);
    try {
      await streetPersist.writeStreetCache(bbox, ovt);
    } catch {
      /* a later export can still fall back to Overpass */
    }
    return {
      xmls: [],
      elements: dedupeElements([ovt.elements || [], (gap && gap.elements) || []]),
      tiled: bboxSpanM(bbox).sideM > TILE_SPAN_M,
      notes: [].concat(ovt.notes || [], (gap && gap.notes) || []),
      incomplete: false,
      source: "overture",
      overtureThemes: ovt.themes || {},
    };
  }
  let gap = { elements: [] };
  try {
    gap = await gapWork;
  } catch {
    gap = missedGap();
  }
  if (gap && gap.ok === false) gap = missedGap(gap);
  let cached = null;
  try {
    cached = await streetPersist.readStreetCache(bbox, { release: ovt && ovt.release });
  } catch {
    cached = null;
  }
  if (cached && cached.elements && cached.elements.length) {
    return {
      xmls: [],
      elements: dedupeElements([cached.elements, (gap && gap.elements) || []]),
      tiled: bboxSpanM(bbox).sideM > TILE_SPAN_M,
      notes: [].concat(cached.notes || [], (gap && gap.notes) || [], [streetPersist.cacheNote(cached)]),
      incomplete: false,
      source: "overture",
      overtureThemes: cached.themes || {},
    };
  }
  const full = await fullFetch(bbox, o);
  const notes = [].concat(full.notes || [], (gap && gap.notes) || [], [overtureFallbackNote(ovt && ovt.error)]);
  return Object.assign({}, full, {
    elements: dedupeElements([full.elements || [], (gap && gap.elements) || []]),
    notes,
    source: full.source || "overpass",
  });
}

async function fetchStreetMaps(bbox, opts) {
  const o = opts || {};
  if (o.fetchImpl || o.overture === false) return fetchOsmMaps(bbox, o);
  const key = cacheKey(bbox, o);
  const hit = streetCache.get(key);
  const work = hit || fetchStreetMapsWork(bbox, o);
  if (!hit) {
    streetCache.set(key, work);
    const clear = () => {
      const timer = setTimeout(() => {
        if (streetCache.get(key) === work) streetCache.delete(key);
      }, STREET_CACHE_MS);
      if (typeof timer.unref === "function") timer.unref();
    };
    work.then(clear, () => {
      if (streetCache.get(key) === work) streetCache.delete(key);
    });
  }
  return waitUnlessAborted(work, o.signal);
}

function resetForTests() {
  streetCache.clear();
}

module.exports = {
  gapQuery,
  GAP_DEADLINE_MS,
  GAP_CACHE_MAX_BYTES,
  GAP_CACHE_TTL_MS,
  GAP_MISS,
  STREET_OVERTURE_ATTEMPTS,
  capGapDeadline,
  isTransientOvertureError,
  fetchGapOverpass,
  fetchStreetMaps,
  gapEmptyWarning,
  setGapCacheDir,
  setGapCacheLimits,
  dedupeElements,
  resetForTests,
};
