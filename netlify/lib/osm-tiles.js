"use strict";

/**
 * Street-map reads for a draw. A box about 2.2 km on a side is one map
 * extract from Overpass's map call (the same OSM XML the editing API
 * returns; OSMF policy keeps the editing API for editors, not data reads). A larger background draw is cut into tiles and each tile is a
 * selective Overpass query (parts, water, parking, barriers, lamps, rail),
 * not a full map extract. The short export does not tile: one map request,
 * then stop. A map body too large to scan is left unread.
 */

const overpass = require("./overpass");
const { isResilient, isTiledOsm } = require("./export-mode");

const TILE_SPAN_M = 2200;
/** Resilient tile read: retries and fallback inside this window. */
const TILE_RESILIENT_MS = 45000;
/** Resilient map read when the caller names no window. */
const MAP_RESILIENT_MS = 100000;
const MAX_TILES = 16;
/** tiledOsm (1.2.31): one window shared by every tile of a large draw. */
const TILED_BUDGET_MS = 105000;
/** tiledOsm: tiles in flight (overpass-api.de gives one caller two slots). */
const TILED_CONCURRENCY = 2;
/** tiledOsm: a server silent this long counts as failed for that tile. */
const TILED_SLOW_FAIL_MS = 20000;
/** tiledOsm: a retry or split pass starts only with this much window left. */
const TILED_MIN_LEFT_MS = 8000;
const TILED_MISSING_NOTE_KINDS = "RVs, parking, walls, light poles, water and bridges";
const OVERPASS_CONCURRENCY = 3;
const TILE_FETCH_MS = 10000;
const MAP_XML_CAP = 6000000;
const TILE_CACHE_MS = 120000;
const OSM_MAP_URLS = [
  "https://overpass-api.de/api/map",
  "https://overpass.kumi.systems/api/map",
];
const OSM_MAP_URL = OSM_MAP_URLS[0];
const TILE_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function bboxSpanM(bbox) {
  const south = +bbox.south;
  const north = +bbox.north;
  const west = +bbox.west;
  const east = +bbox.east;
  const lat = (south + north) / 2;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const widthM = Math.abs(east - west) * mLon;
  const lengthM = Math.abs(north - south) * 110540;
  return { widthM, lengthM, sideM: Math.max(widthM, lengthM) };
}

function tileBbox(bbox, cols, rows) {
  const west = +bbox.west;
  const south = +bbox.south;
  const dw = (+bbox.east - west) / cols;
  const dh = (+bbox.north - south) / rows;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        west: west + c * dw,
        south: south + r * dh,
        east: west + (c + 1) * dw,
        north: south + (r + 1) * dh,
      });
    }
  }
  return tiles;
}

function planTiles(bbox) {
  const span = bboxSpanM(bbox);
  if (!(span.sideM > TILE_SPAN_M)) {
    return [{ west: +bbox.west, south: +bbox.south, east: +bbox.east, north: +bbox.north }];
  }
  let cols = Math.max(1, Math.ceil(span.widthM / TILE_SPAN_M));
  let rows = Math.max(1, Math.ceil(span.lengthM / TILE_SPAN_M));
  while (cols * rows > MAX_TILES) {
    if (cols >= rows && cols > 1) cols--;
    else if (rows > 1) rows--;
    else break;
  }
  return tileBbox(bbox, cols, rows);
}

function mapUrl(bbox, base) {
  return (
    (base || OSM_MAP_URL) +
    "?bbox=" +
    [bbox.west, bbox.south, bbox.east, bbox.north].map((n) => +n).join(",")
  );
}

function responseTooBig(status, text) {
  if (status !== 400) return false;
  const t = String(text || "");
  if (/too many nodes|bbox/i.test(t)) return true;
  return t.length < 500;
}

function ringKey(ring) {
  if (!ring || !ring.length) return "";
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round(+ring[i][0] * 1e5) / 1e5;
    const y = Math.round(+ring[i][1] * 1e5) / 1e5;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push(x + "," + y);
  }
  pts.sort();
  return pts.join(";");
}

async function fetchOne(bbox, opts) {
  const { timeSpan } = require("./stage-clock");
  return timeSpan("osm", () => fetchOneWork(bbox, opts));
}

async function fetchOneWork(bbox, opts) {
  if (isResilient() && !(opts && opts.fetchImpl)) return fetchOneResilient(bbox, opts);
  let last = null;
  for (let u = 0; u < OSM_MAP_URLS.length; u++) {
    if (opts && opts.signal && opts.signal.aborted) break;
    try {
      last = await fetchMapFrom(OSM_MAP_URLS[u], bbox, opts);
    } catch (e) {
      if (opts && opts.signal && opts.signal.aborted) throw e;
      last = null;
      continue;
    }
    // A box too large to answer is too large on the mirror as well.
    if (last.ok || last.tooBig) return last;
  }
  return last || { ok: false, status: 0, xml: "", tooBig: false };
}

async function fetchOneResilient(bbox, opts) {
  const o = opts || {};
  const res = await overpass.request({
    kind: "map",
    bbox,
    signal: o.signal,
    ua: o.ua,
    deadlineMs: o.deadlineMs > 0 ? o.deadlineMs : MAP_RESILIENT_MS,
    tag: o.tag,
  });
  if (res.ok) {
    if (res.text.length > MAP_XML_CAP) return { ok: false, status: res.status, xml: "", tooBig: true };
    return { ok: true, status: res.status, xml: res.text, tooBig: false };
  }
  const status = typeof res.status === "number" ? res.status : 0;
  return { ok: false, status, xml: "", tooBig: status === 400 && responseTooBig(400, res.text) };
}

async function fetchMapFrom(base, bbox, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const t0 = Date.now();
  let r;
  try {
    r = await fetchImpl(mapUrl(bbox, base), {
      headers: { "user-agent": (opts && opts.ua) || "openclutter", accept: "application/xml,text/xml,*/*" },
      signal: opts && opts.signal,
    });
  } catch (e) {
    overpass.logLegacy(base, "map", "neterr", Date.now() - t0);
    throw e;
  }
  const text = await r.text();
  overpass.logLegacy(base, "map", r.status, Date.now() - t0);
  if (text && text.length > MAP_XML_CAP) {
    return { ok: false, status: r.status, xml: "", tooBig: true };
  }
  const xml = text && text.indexOf("<osm") >= 0 ? text : "";
  return {
    ok: !!(r.ok && xml),
    status: r.status,
    xml,
    tooBig: !r.ok && responseTooBig(r.status, text),
  };
}

function tileQuery(bbox) {
  const box = [+bbox.south, +bbox.west, +bbox.north, +bbox.east].join(",");
  return (
    "[out:json][timeout:15];(" +
    'way["building:part"](' + box + ");" +
    'way["building"](' + box + ");" +
    'way["leisure"="swimming_pool"](' + box + ");" +
    'way["natural"="water"](' + box + ");" +
    'way["water"](' + box + ");" +
    'way["waterway"="riverbank"](' + box + ");" +
    'way["landuse"="reservoir"](' + box + ");" +
    'relation["building:part"](' + box + ");" +
    'relation["type"="multipolygon"]["building"](' + box + ");" +
    'way["amenity"="parking"](' + box + ");" +
    'way["amenity"="parking"]["parking"="multi-storey"](' + box + ");" +
    'way["building"="parking"](' + box + ");" +
    'way["barrier"~"^(wall|fence|retaining_wall|hedge|city_wall)$"](' + box + ");" +
    'node["highway"="street_lamp"](' + box + ");" +
    'node["man_made"~"^(mast|pole|lighting)$"](' + box + ");" +
    'way["railway"~"^(monorail|light_rail|subway|rail|tram)$"](' + box + ");" +
    'way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](' + box + ");" +
    'way["highway"]["bridge"~"^(yes|viaduct|covered)$"](' + box + ");" +
    'way["highway"]["layer"~"^[1-9]"](' + box + ");" +
    'way["man_made"="bridge"](' + box + ");" +
    'way["bridge"="viaduct"](' + box + ");" +
    'way["tourism"="caravan_site"](' + box + ");" +
    'relation["tourism"="caravan_site"](' + box + ");" +
    'way["tourism"="camp_site"](' + box + ");" +
    'relation["tourism"="camp_site"](' + box + ");" +
    'node["tourism"="camp_pitch"](' + box + ");" +
    'way["tourism"="camp_pitch"](' + box + ");" +
    'way["highway"~"^(service|track|living_street|residential|unclassified)$"](' + box + ");" +
    'way["building"~"^(static_caravan|mobile_home|caravan)$"](' + box + ");" +
    'relation["building"~"^(static_caravan|mobile_home|caravan)$"](' + box + ");" +
    ");out geom;"
  );
}

async function readJson(r) {
  if (r && typeof r.json === "function") return r.json();
  const text = typeof r.text === "function" ? await r.text() : "";
  return JSON.parse(text || "{}");
}

async function fetchOverpassTile(bbox, opts) {
  const { timeSpan } = require("./stage-clock");
  return timeSpan("overpass", () => fetchOverpassTileWork(bbox, opts));
}

async function fetchOverpassTileWork(bbox, opts) {
  if (opts && opts.slowFailMs > 0 && !opts.fetchImpl) {
    const res = await overpass.request({
      kind: "interpreter",
      query: tileQuery(bbox),
      ua: opts.ua,
      deadlineMs: Math.max(1000, opts.deadlineMs | 0),
      slowFailMs: opts.slowFailMs,
      tag: opts.tag,
    });
    if (!res.ok) return null;
    try {
      const json = JSON.parse(res.text);
      return json && Array.isArray(json.elements) ? json.elements : null;
    } catch {
      return null;
    }
  }
  if (isResilient() && !(opts && opts.fetchImpl)) {
    const res = await overpass.request({
      kind: "interpreter",
      query: tileQuery(bbox),
      ua: opts && opts.ua,
      deadlineMs: TILE_RESILIENT_MS,
    });
    if (!res.ok) return null;
    try {
      const json = JSON.parse(res.text);
      return json && Array.isArray(json.elements) ? json.elements : null;
    } catch {
      return null;
    }
  }
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const body = "data=" + encodeURIComponent(tileQuery(bbox));
  const headers = {
    "user-agent": (opts && opts.ua) || "openclutter",
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  for (let u = 0; u < TILE_OVERPASS_URLS.length; u++) {
    try {
      const r = await fetchImpl(TILE_OVERPASS_URLS[u], {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(TILE_FETCH_MS),
      });
      if (!r.ok) continue;
      const json = await readJson(r);
      const elements = json && json.elements;
      if (!Array.isArray(elements)) continue;
      return elements;
    } catch {
      return null;
    }
  }
  return null;
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

const tileCache = new Map();
const implIds = new WeakMap();
let implSeq = 1;

function implId(fetchImpl) {
  if (!fetchImpl || fetchImpl === fetch) return "default";
  let id = implIds.get(fetchImpl);
  if (!id) {
    id = String(implSeq++);
    implIds.set(fetchImpl, id);
  }
  return id;
}

function cacheKey(bbox, fetchImpl) {
  const box = [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((n) => (Math.round(+n * 1e5) / 1e5).toFixed(5))
    .join(",");
  return box + "|" + implId(fetchImpl);
}

async function fetchTiledOverpass(bbox, opts) {
  const tiles = planTiles(bbox);
  const batches = [];
  let incomplete = false;
  await pool(tiles, OVERPASS_CONCURRENCY, async (tile) => {
    const elements = await fetchOverpassTile(tile, opts);
    if (!elements) {
      incomplete = true;
      return;
    }
    batches.push(elements);
  });
  const notes = [];
  if (incomplete) {
    notes.push("Part of the street map was left out. The largest roofs are still included.");
  }
  return {
    xmls: [],
    elements: dedupeElements(batches),
    tiled: tiles.length > 1,
    notes,
    incomplete,
  };
}

/** Four equal sub-tiles of one tile. */
function splitTile(tile) {
  return tileBbox(tile, 2, 2);
}

/**
 * tiledOsm read of a large draw. Every tile shares one window. Two tiles
 * run at a time; each read moves to the next server after a 20 s silence and
 * to the last resort once two regular servers failed or went slow. Tiles
 * still missing get one retry pass, then a 2x2 split, while the window lasts.
 */
async function fetchTiledOverpassShared(bbox, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const deadlineAt = now() + (o.budgetMs > 0 ? o.budgetMs : TILED_BUDGET_MS);
  const slowFailMs = o.slowFailMs > 0 ? o.slowFailMs : TILED_SLOW_FAIL_MS;
  const minLeft = o.minLeftMs >= 0 ? o.minLeftMs : TILED_MIN_LEFT_MS;
  const read = o.readTile || ((tile, left) => fetchOverpassTile(tile, { ua: o.ua, deadlineMs: left, slowFailMs, tag: "tile" }));
  const tiles = planTiles(bbox);
  const batches = [];
  const stats = { total: tiles.length, missing: 0, retried: 0, split: 0, splitMissing: 0 };
  async function runPass(list) {
    const missed = [];
    await pool(list, TILED_CONCURRENCY, async (tile) => {
      const left = deadlineAt - now();
      if (left < 1000) {
        missed.push(tile);
        return;
      }
      let elements = null;
      try {
        elements = await read(tile, left);
      } catch {
        elements = null;
      }
      if (elements) batches.push(elements);
      else missed.push(tile);
    });
    return missed;
  }
  let missing = await runPass(tiles);
  if (missing.length && deadlineAt - now() >= minLeft) {
    stats.retried = missing.length;
    missing = await runPass(missing);
  }
  if (missing.length && deadlineAt - now() >= minLeft) {
    const parts = [];
    for (let i = 0; i < missing.length; i++) parts.push.apply(parts, splitTile(missing[i]));
    stats.split = missing.length;
    const partMissed = await runPass(parts);
    stats.splitMissing = partMissed.length;
    // A split tile counts as missing when any of its quarters is.
    const still = [];
    for (let i = 0; i < missing.length; i++) {
      const quarters = parts.slice(i * 4, i * 4 + 4);
      if (quarters.some((q) => partMissed.indexOf(q) >= 0)) still.push(missing[i]);
    }
    missing = still;
  }
  stats.missing = missing.length;
  const notes = [];
  if (missing.length) {
    notes.push(
      "Street map: " + missing.length + " of " + tiles.length + " map tiles did not load, so " + TILED_MISSING_NOTE_KINDS + " are missing in " + (missing.length === 1 ? "that part" : "those parts") + " of the draw."
    );
  }
  return {
    xmls: [],
    elements: dedupeElements(batches),
    tiled: tiles.length > 1,
    notes,
    incomplete: missing.length > 0,
    osmTiles: stats,
  };
}

function sharedTiles(bbox, opts) {
  const key = cacheKey(bbox, opts && opts.fetchImpl) + (isTiledOsm() ? "|tiled" : "");
  const hit = tileCache.get(key);
  if (hit) return hit;
  const work =
    isTiledOsm() && !(opts && opts.fetchImpl)
      ? fetchTiledOverpassShared(bbox, { ua: opts && opts.ua })
      : fetchTiledOverpass(bbox, { ua: opts && opts.ua, fetchImpl: opts && opts.fetchImpl });
  tileCache.set(key, work);
  const clear = () => {
    const timer = setTimeout(() => {
      if (tileCache.get(key) === work) tileCache.delete(key);
    }, TILE_CACHE_MS);
    if (typeof timer.unref === "function") timer.unref();
  };
  work.then(clear, () => {
    if (tileCache.get(key) === work) tileCache.delete(key);
  });
  return work;
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

async function pool(items, limit, fn) {
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(worker());
  await Promise.all(jobs);
}

/**
 * opts.tile true uses Overpass tiles above TILE_SPAN_M. Otherwise one map
 * request. A caller's abort does not cancel a tiled read another caller
 * is still waiting on.
 * @returns {Promise<{xmls:string[], elements:object[], tiled:boolean, notes:string[], incomplete:boolean}>}
 */
async function fetchOsmMaps(bbox, opts) {
  const o = opts || {};
  const span = bboxSpanM(bbox);
  const allowTile = o.tile === true && span.sideM > TILE_SPAN_M;
  if (allowTile) return waitUnlessAborted(sharedTiles(bbox, o), o.signal);

  const tile = { west: +bbox.west, south: +bbox.south, east: +bbox.east, north: +bbox.north };
  const xmls = [];
  let incomplete = false;
  if (!(o.signal && o.signal.aborted)) {
    try {
      const res = await fetchOne(tile, o);
      if (res.ok) xmls.push(res.xml);
      else incomplete = true;
    } catch (e) {
      incomplete = true;
    }
  } else {
    incomplete = true;
  }
  return { xmls, elements: [], tiled: false, notes: [], incomplete };
}

module.exports = {
  TILE_SPAN_M,
  MAX_TILES,
  TILED_BUDGET_MS,
  TILED_CONCURRENCY,
  TILED_SLOW_FAIL_MS,
  fetchTiledOverpassShared,
  splitTile,
  MAP_XML_CAP,
  bboxSpanM,
  planTiles,
  mapUrl,
  OSM_MAP_URLS,
  ringKey,
  fetchOsmMaps,
};
