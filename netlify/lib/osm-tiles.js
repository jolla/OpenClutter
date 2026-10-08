"use strict";

/**
 * OpenStreetMap map extracts for a draw. A box about 2.2 km on a side is one
 * request. A larger box is cut into tiles that stay under that span, and a
 * tile that comes back "too many nodes" is split once into quadrants.
 * The short export does not tile: one request, then stop.
 */

const TILE_SPAN_M = 2200;
const MAX_TILES = 16;
const REQUEST_CAP = 28;
const CONCURRENCY = 4;
const OSM_MAP_URL = "https://www.openstreetmap.org/api/0.6/map";

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

function quadrants(bbox) {
  const west = +bbox.west;
  const south = +bbox.south;
  const east = +bbox.east;
  const north = +bbox.north;
  const mx = (west + east) / 2;
  const my = (south + north) / 2;
  return [
    { west, south: my, east: mx, north },
    { west: mx, south: my, east, north },
    { west, south, east: mx, north: my },
    { west: mx, south, east, north: my },
  ];
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
  const xml = text && text.indexOf("<osm") >= 0 ? text : "";
  return {
    ok: !!(r.ok && xml),
    status: r.status,
    xml,
    tooBig: !r.ok && responseTooBig(r.status, text),
  };
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
 * opts.tile true tiles a box over TILE_SPAN_M. Otherwise one request.
 * @returns {Promise<{xmls:string[], tiled:boolean, notes:string[], incomplete:boolean}>}
 */
async function fetchOsmMaps(bbox, opts) {
  const o = opts || {};
  const span = bboxSpanM(bbox);
  const allowTile = o.tile === true && span.sideM > TILE_SPAN_M;
  const tiles = allowTile ? planTiles(bbox) : [{ west: +bbox.west, south: +bbox.south, east: +bbox.east, north: +bbox.north }];
  const xmls = [];
  const notes = [];
  let incomplete = false;
  let used = 0;

  async function pull(tile, depth) {
    if (o.signal && o.signal.aborted) {
      incomplete = true;
      return;
    }
    if (used >= REQUEST_CAP) {
      incomplete = true;
      return;
    }
    used++;
    let res;
    try {
      res = await fetchOne(tile, o);
    } catch (e) {
      incomplete = true;
      return;
    }
    if (res.ok) {
      xmls.push(res.xml);
      return;
    }
    if (res.tooBig && allowTile && depth < 1 && used + 4 <= REQUEST_CAP) {
      const parts = quadrants(tile);
      for (let i = 0; i < parts.length; i++) await pull(parts[i], depth + 1);
      return;
    }
    incomplete = true;
  }

  if (tiles.length === 1) await pull(tiles[0], allowTile ? 0 : 1);
  else await pool(tiles, CONCURRENCY, (tile) => pull(tile, 0));

  if (incomplete && allowTile) {
    notes.push("Part of the street map was left out. The largest roofs are still included.");
  }
  return { xmls, tiled: tiles.length > 1, notes, incomplete };
}

module.exports = {
  TILE_SPAN_M,
  MAX_TILES,
  REQUEST_CAP,
  bboxSpanM,
  planTiles,
  mapUrl,
  ringKey,
  fetchOsmMaps,
};
