"use strict";

/**
 * Street-map reads for a draw. A box about 2.2 km on a side is one map
 * extract. A larger background draw is cut into tiles and each tile is a
 * selective Overpass query (parts, water, parking, barriers, lamps, rail),
 * not a full map extract. The short export does not tile: one map request,
 * then stop. A map body too large to scan is left unread.
 */

const TILE_SPAN_M = 2200;
const MAX_TILES = 16;
const OVERPASS_CONCURRENCY = 3;
const TILE_FETCH_MS = 10000;
const MAP_XML_CAP = 6000000;
const TILE_CACHE_MS = 120000;
const OSM_MAP_URL = "https://www.openstreetmap.org/api/0.6/map";
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

function mapUrl(bbox) {
  return (
    OSM_MAP_URL +
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
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const r = await fetchImpl(mapUrl(bbox), {
    headers: { "user-agent": (opts && opts.ua) || "openclutter", accept: "application/xml,text/xml,*/*" },
    signal: opts && opts.signal,
  });
  const text = await r.text();
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

function sharedTiles(bbox, opts) {
  const key = cacheKey(bbox, opts && opts.fetchImpl);
  const hit = tileCache.get(key);
  if (hit) return hit;
  const work = fetchTiledOverpass(bbox, { ua: opts && opts.ua, fetchImpl: opts && opts.fetchImpl });
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
  MAP_XML_CAP,
  bboxSpanM,
  planTiles,
  mapUrl,
  ringKey,
  fetchOsmMaps,
};
