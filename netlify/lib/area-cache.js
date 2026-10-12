"use strict";

/**
 * Raw source tiles in the export blob store.
 *
 * The key is source + resolution + snapped tile. The value is the bytes
 * that came back from that source, plus a savedAt used as the TTL. Final
 * geometry is refused: a later detector must not replay a cached roof,
 * crown, or vehicle.
 *
 * Missing tiles share one in-process cap. A background export can also
 * split those tiles across a few invocations of the existing background
 * function. Each invocation writes its partial, and the export reads the
 * bytes back from the blob store.
 */

const crypto = require("node:crypto");
const { noteCache, timeSpanSync } = require("./stage-clock");

const FETCH_CONCURRENCY = 4;
const MAX_BACKGROUND_FUNCTIONS = 3;
const AERIAL_STEP_DEG = 0.01;
const OSM_STEP_DEG = 0.02;
const MAX_AERIAL_TILES = 8;
const MAX_CACHE_BYTES = 80 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a raw tile stays usable. Checked on read. Blobs have no server TTL. */
const SOURCE_TTL_MS = {
  osm: 6 * 60 * 60 * 1000,
  overpass: 6 * 60 * 60 * 1000,
  overture: 14 * 24 * 60 * 60 * 1000,
  microsoft: 30 * 24 * 60 * 60 * 1000,
  dem: 30 * 24 * 60 * 60 * 1000,
  canopy: 14 * 24 * 60 * 60 * 1000,
  worldcover: 30 * 24 * 60 * 60 * 1000,
  lidar: 14 * 24 * 60 * 60 * 1000,
  aerial: 7 * 24 * 60 * 60 * 1000,
};

let storeRef = null;
let originalFetch = null;
let remoteWait = new Map();

function enabled() {
  return !!storeRef && process.env.OPENCLUTTER_AREA_CACHE !== "0";
}

function enable(store) {
  if (!store) return false;
  storeRef = store;
  if (!originalFetch && typeof fetch === "function") {
    originalFetch = fetch;
    global.fetch = wrappedFetch;
  }
  return true;
}

function disable() {
  storeRef = null;
  remoteWait = new Map();
  inflight.clear();
  if (originalFetch) {
    global.fetch = originalFetch;
    originalFetch = null;
  }
}

function cacheKey(source, resolution, tile) {
  return "raw/" + safePart(source) + "/" + safePart(resolution) + "/" + safePart(tile);
}

function safePart(value) {
  return String(value || "none")
    .replace(/[^a-zA-Z0-9._=-]+/g, "_")
    .slice(0, 180);
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function tileId(bbox) {
  const f = (n) => (Math.round(+n * 1e5) / 1e5).toFixed(5);
  return "w" + f(bbox.west) + "_s" + f(bbox.south) + "_e" + f(bbox.east) + "_n" + f(bbox.north);
}

function coverCells(bbox, step) {
  const stepDeg = step > 0 ? step : OSM_STEP_DEG;
  const west = +bbox.west;
  const south = +bbox.south;
  const east = +bbox.east;
  const north = +bbox.north;
  const i0 = Math.floor(west / stepDeg + 1e-9);
  const i1 = Math.ceil(east / stepDeg - 1e-9);
  const j0 = Math.floor(south / stepDeg + 1e-9);
  const j1 = Math.ceil(north / stepDeg - 1e-9);
  const cells = [];
  for (let i = i0; i < i1; i++) {
    for (let j = j0; j < j1; j++) {
      cells.push({
        west: round6(i * stepDeg),
        south: round6(j * stepDeg),
        east: round6((i + 1) * stepDeg),
        north: round6((j + 1) * stepDeg),
      });
    }
  }
  return cells;
}

function looksLikeFinalGeometry(body) {
  if (body == null) return false;
  if (typeof body === "object" && !Buffer.isBuffer(body) && !ArrayBuffer.isView(body)) {
    if (body.type === "Feature" || body.type === "FeatureCollection") return true;
    if (Array.isArray(body.features) || Array.isArray(body.areas) || Array.isArray(body.attenuation_areas)) {
      return true;
    }
    if (body.openintent_version || body.openIntent) return true;
    return false;
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const head = buf.slice(0, 280).toString("utf8");
  if (/"openintent_version"/.test(head) || /"attenuation_areas"/.test(head)) return true;
  if (/^\s*\{\s*"type"\s*:\s*"Feature/.test(head)) return true;
  return false;
}

function assertRaw(body) {
  if (looksLikeFinalGeometry(body)) {
    const err = new Error("area cache stores raw source bytes only");
    err.code = "raw-only";
    throw err;
  }
}

async function writeRaw(store, key, body, meta) {
  assertRaw(body);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  assertRaw(buf);
  const target = store || storeRef;
  if (!target) throw new Error("area cache has no store");
  const info = meta || {};
  await target.setJSON(key + "/meta", {
    source: info.source || "",
    resolution: info.resolution || "",
    tile: info.tile || "",
    savedAt: info.savedAt > 0 ? info.savedAt : Date.now(),
    bytes: buf.length,
    status: info.status || 200,
    contentType: info.contentType || "application/octet-stream",
    contentRange: info.contentRange || "",
  });
  await target.set(key + "/body", buf);
  return buf.length;
}

async function readMeta(store, key) {
  const target = store || storeRef;
  if (!target) return null;
  try {
    const meta = await target.get(key + "/meta", { type: "json" });
    if (!meta || typeof meta !== "object") return null;
    return meta;
  } catch {
    return null;
  }
}

function ttlFor(source) {
  const n = SOURCE_TTL_MS[source];
  return n > 0 ? n : DEFAULT_TTL_MS;
}

function freshMeta(meta, now) {
  if (!meta || !(meta.savedAt > 0)) return false;
  const at = now > 0 ? now : Date.now();
  return at <= meta.savedAt + ttlFor(meta.source);
}

async function readRaw(store, key, now) {
  const target = store || storeRef;
  if (!target) return null;
  const meta = await readMeta(target, key);
  if (!freshMeta(meta, now)) return null;
  const raw = await target.get(key + "/body", { type: "arrayBuffer" });
  if (!raw) return null;
  const body = Buffer.from(raw);
  if (!body.length) return null;
  return { body, meta };
}

let activeFetches = 0;
const slotWaiters = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeFetches += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          activeFetches -= 1;
          const next = slotWaiters.shift();
          if (next) next();
        });
    };
    if (activeFetches >= FETCH_CONCURRENCY) slotWaiters.push(run);
    else run();
  });
}

function resetSlotsForTests() {
  activeFetches = 0;
  slotWaiters.length = 0;
}

async function pool(items, limit, fn) {
  const list = items || [];
  let cursor = 0;
  const n = Math.max(1, Math.min(limit > 0 ? limit : FETCH_CONCURRENCY, list.length || 1));
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++;
      if (i >= list.length) return;
      await fn(list[i], i);
    }
  }
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(worker());
  await Promise.all(jobs);
}

const inflight = new Map();

async function loadRaw(spec, fetchImpl, opts) {
  const key = cacheKey(spec.source, spec.resolution, spec.tile);
  const hit = await readRaw(storeRef, key);
  if (hit) {
    noteCache(spec.source, true);
    return {
      body: hit.body,
      status: hit.meta.status || 200,
      contentType: hit.meta.contentType || spec.contentType || "application/octet-stream",
      contentRange: hit.meta.contentRange || "",
    };
  }
  if (!(opts && opts.skipRemote) && remoteWait.has(key)) {
    const waited = await remoteWait.get(key);
    if (waited) {
      noteCache(spec.source, true);
      if (Buffer.isBuffer(waited)) {
        return {
          body: waited,
          status: 200,
          contentType: spec.contentType || "application/octet-stream",
          contentRange: "",
        };
      }
      return waited;
    }
  }
  if (inflight.has(key)) return inflight.get(key);
  const work = withSlot(async () => {
    const again = await readRaw(storeRef, key);
    if (again) {
      noteCache(spec.source, true);
      return {
        body: again.body,
        status: again.meta.status || 200,
        contentType: again.meta.contentType || spec.contentType || "application/octet-stream",
        contentRange: again.meta.contentRange || "",
      };
    }
    const res = await fetchImpl();
    if (!res || res.ok === false) {
      noteCache(spec.source, false);
      const err = new Error("source tile failed");
      err.response = res;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType =
      res.headers && typeof res.headers.get === "function"
        ? res.headers.get("content-type") || spec.contentType || "application/octet-stream"
        : spec.contentType || "application/octet-stream";
    const contentRange =
      res.headers && typeof res.headers.get === "function" ? res.headers.get("content-range") || "" : "";
    const status = res.status || 200;
    noteCache(spec.source, false);
    if (buf.length > 32 && buf.length <= MAX_CACHE_BYTES && !looksLikeFinalGeometry(buf)) {
      await writeRaw(storeRef, key, buf, {
        source: spec.source,
        resolution: spec.resolution,
        tile: spec.tile,
        status,
        contentType,
        contentRange,
      }).catch((err) => {
        if (err && err.code === "raw-only") return;
        throw err;
      });
    }
    return { body: buf, status, contentType, contentRange };
  });
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    if (inflight.get(key) === work) inflight.delete(key);
  }
}

function hashTile(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 20);
}

function headerValue(init, name) {
  const headers = init && init.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name.toLowerCase()) return String(headers[keys[i]] || "");
  }
  return "";
}

function parseBboxParam(url) {
  const m = /[?&]bbox=([^&]+)/.exec(String(url));
  if (!m) return null;
  const p = decodeURIComponent(m[1]).split(",").map(Number);
  if (p.length < 4 || !p.every(Number.isFinite)) return null;
  return { west: p[0], south: p[1], east: p[2], north: p[3] };
}

function classifyFetch(url, init) {
  const u = String(url || "");
  const range = headerValue(init, "range");
  if (u.includes("World_Imagery/MapServer/export") && /[?&]f=image\b/.test(u)) {
    const bbox = parseBboxParam(u);
    if (!bbox) return null;
    const size = /[?&]size=(\d+),(\d+)/.exec(u);
    const imgW = size ? +size[1] : 0;
    const lat = (bbox.south + bbox.north) / 2;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const widthM = Math.abs(bbox.east - bbox.west) * (mLon || 1);
    const mpp = imgW > 0 ? widthM / imgW : 0;
    return {
      source: "aerial",
      resolution: (mpp > 0 ? mpp.toFixed(3) : "jpg") + "m",
      tile: tileId(bbox),
      contentType: "image/jpeg",
    };
  }
  if (u.includes("openstreetmap.org/api/0.6/map")) {
    const bbox = parseBboxParam(u);
    if (!bbox) return null;
    return { source: "osm", resolution: "map", tile: tileId(bbox), contentType: "application/xml" };
  }
  if (u.includes("overpass")) {
    const body = init && init.body ? String(init.body) : u;
    return {
      source: "overpass",
      resolution: "interpreter",
      tile: hashTile(body),
      contentType: "application/json",
    };
  }
  if (u.includes("blob.core.windows.net/release") || u.includes("overturemaps")) {
    return {
      source: "overture",
      resolution: "2026-08-19.0",
      tile: hashTile(u + "|" + range),
      contentType: "application/octet-stream",
    };
  }
  if (u.includes("quadkey=") || u.includes("/global-buildings")) {
    const q = /quadkey=(\d+)/.exec(u);
    return {
      source: "microsoft",
      resolution: "z9",
      tile: q ? q[1] : hashTile(u),
      contentType: "application/gzip",
    };
  }
  if (u.includes("dataforgood-fb-data") || u.includes("/chm/")) {
    const file = /\/([^/]+)\.tif/.exec(u);
    return {
      source: "canopy",
      resolution: "1.2m",
      tile: (file ? file[1] : "cog") + "_" + hashTile(range || u),
      contentType: "image/tiff",
    };
  }
  if (u.includes("esa-worldcover") || u.includes("worldcover")) {
    const file = /ESA_WorldCover[^/]+/.exec(u);
    return {
      source: "worldcover",
      resolution: "10m",
      tile: (file ? file[0] : "cog") + "_" + hashTile(range || u),
      contentType: "image/tiff",
    };
  }
  if (u.includes("elevation.nationalmap.gov") || u.includes("copernicus") || u.includes("glo30") || u.includes("GLO-30")) {
    return {
      source: "dem",
      resolution: u.includes("nationalmap") ? "3dep" : "30m",
      tile: hashTile(u + "|" + range),
      contentType: "application/octet-stream",
    };
  }
  if (u.includes("usgs-lidar") || u.includes("usgs.entwine") || u.includes("rockyweb.usgs.gov")) {
    return {
      source: "lidar",
      resolution: "laz",
      tile: hashTile(u + "|" + range),
      contentType: "application/octet-stream",
    };
  }
  return null;
}

function hasRange(init) {
  const headers = init && init.headers;
  if (!headers) return false;
  if (typeof headers.get === "function") return !!(headers.get("range") || headers.get("Range"));
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] && String(headers[i][0]).toLowerCase() === "range") return true;
    }
    return false;
  }
  return !!headerValue(init, "range");
}

async function wrappedFetch(url, init) {
  if (!enabled()) return originalFetch(url, init);
  // Byte-range reads (Overture, canopy, world cover) must keep the server's
  // own 206 response. Replaying a range as a normal body breaks the reader.
  if (hasRange(init)) return originalFetch(url, init);
  const method = String((init && init.method) || "GET").toUpperCase();
  if (method !== "GET") return originalFetch(url, init);
  const spec = classifyFetch(url, init);
  if (!spec) return originalFetch(url, init);
  try {
    const got = await loadRaw(spec, () => originalFetch(url, init));
    const headers = {
      "content-type": got.contentType || spec.contentType || "application/octet-stream",
      "content-length": String(got.body.length),
    };
    if (got.contentRange) headers["content-range"] = got.contentRange;
    return new Response(got.body, { status: got.status || 200, headers });
  } catch (err) {
    if (err && err.response) return err.response;
    return originalFetch(url, init);
  }
}

function planAerialTiles(frame) {
  if (!frame) return [];
  const cells = coverCells(frame, AERIAL_STEP_DEG);
  if (cells.length < 2 || cells.length > MAX_AERIAL_TILES) return [];
  const lat = ((+frame.south) + (+frame.north)) / 2;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mpp = Math.max(+frame.mpuX || 0, +frame.mpuY || 0, 0.05);
  return cells.map((cell) => {
    const widthM = Math.abs(cell.east - cell.west) * mLon;
    const heightM = Math.abs(cell.north - cell.south) * 110540;
    let imgW = Math.max(64, Math.round(widthM / mpp));
    let imgH = Math.max(64, Math.round(heightM / mpp));
    const side = Math.max(imgW, imgH);
    if (side > 4096) {
      const k = 4096 / side;
      imgW = Math.max(64, Math.round(imgW * k));
      imgH = Math.max(64, Math.round(imgH * k));
    }
    return {
      west: cell.west,
      south: cell.south,
      east: cell.east,
      north: cell.north,
      imgW,
      imgH,
      source: "aerial",
      resolution: mpp.toFixed(3) + "m",
      tile: tileId(cell),
    };
  });
}

function compositeAerial(frame, parts) {
  const jpeg = require("jpeg-js");
  const dw = frame.imgW | 0;
  const dh = frame.imgH | 0;
  if (dw < 2 || dh < 2 || dw * dh > 8192 * 8192) return null;
  const rgba = Buffer.alloc(dw * dh * 4);
  const lonSpan = +frame.east - +frame.west;
  const latSpan = +frame.north - +frame.south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    if (!part || !part.buf || part.buf.length < 100) return null;
    let dec;
    try {
      dec = jpeg.decode(part.buf, { useTArray: true, formatAsRGBA: true });
    } catch {
      return null;
    }
    if (!dec || !(dec.width > 0) || !(dec.height > 0)) return null;
    const spec = part.spec;
    const x0 = ((spec.west - frame.west) / lonSpan) * dw;
    const x1 = ((spec.east - frame.west) / lonSpan) * dw;
    const y0 = ((frame.north - spec.north) / latSpan) * dh;
    const y1 = ((frame.north - spec.south) / latSpan) * dh;
    const ox = Math.round(x0);
    const oy = Math.round(y0);
    const destW = Math.max(1, Math.round(x1) - ox);
    const destH = Math.max(1, Math.round(y1) - oy);
    const same = destW === dec.width && destH === dec.height;
    for (let y = 0; y < destH; y++) {
      const dy = oy + y;
      if (dy < 0 || dy >= dh) continue;
      if (same) {
        const sx0 = 0;
        const dx = ox;
        const copyW = Math.min(destW, dw - dx, dec.width - sx0);
        if (copyW <= 0 || dx < 0) continue;
        const src = Buffer.from(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength);
        src.copy(rgba, (dy * dw + dx) * 4, (y * dec.width) * 4, (y * dec.width + copyW) * 4);
        continue;
      }
      const sy = Math.min(dec.height - 1, Math.floor((y * dec.height) / destH));
      for (let x = 0; x < destW; x++) {
        const dx = ox + x;
        if (dx < 0 || dx >= dw) continue;
        const sx = Math.min(dec.width - 1, Math.floor((x * dec.width) / destW));
        const si = (sy * dec.width + sx) * 4;
        const di = (dy * dw + dx) * 4;
        rgba[di] = dec.data[si];
        rgba[di + 1] = dec.data[si + 1];
        rgba[di + 2] = dec.data[si + 2];
        rgba[di + 3] = 255;
      }
    }
  }
  const encoded = jpeg.encode({ data: rgba, width: dw, height: dh }, 82);
  return Buffer.from(encoded.data);
}

async function stitchAerial(frame, fetchJpeg) {
  const tiles = planAerialTiles(frame);
  if (!tiles.length) return null;
  const parts = new Array(tiles.length);
  await pool(tiles, FETCH_CONCURRENCY, async (spec, i) => {
    const got = await fetchJpeg(spec);
    const buf = Buffer.isBuffer(got) ? got : got && got.body ? got.body : Buffer.from(got);
    parts[i] = { spec, buf };
  });
  return timeSpanSync("aerialStitch", () => compositeAerial(frame, parts));
}

function planSourceTiles(bbox) {
  const tiles = [];
  let urls = [];
  try {
    urls = require("./ms-global").urlsForBbox(bbox.west, bbox.south, bbox.east, bbox.north).urls || [];
  } catch {
    urls = [];
  }
  for (let i = 0; i < urls.length; i++) {
    const item = urls[i];
    tiles.push({
      source: "microsoft",
      resolution: "z9",
      tile: item.quadkey,
      url: item.url,
    });
  }
  const box = {
    west: +bbox.west,
    south: +bbox.south,
    east: +bbox.east,
    north: +bbox.north,
  };
  tiles.push({
    source: "osm",
    resolution: "map",
    tile: tileId(box),
    url: "https://www.openstreetmap.org/api/0.6/map?bbox=" + [box.west, box.south, box.east, box.north].join(","),
    bbox: box,
  });
  return tiles;
}

function splitBatches(items, maxGroups) {
  const list = items || [];
  const groups = [];
  const count = Math.max(1, Math.min(maxGroups > 0 ? maxGroups : MAX_BACKGROUND_FUNCTIONS, list.length || 1));
  for (let i = 0; i < count; i++) groups.push([]);
  for (let i = 0; i < list.length; i++) groups[i % count].push(list[i]);
  return groups.filter((g) => g.length);
}

async function runTileBatch(payload) {
  const tiles = (payload && payload.tiles) || [];
  const parentId = (payload && payload.parentId) || "export";
  const batchId = (payload && payload.batchId) || "0";
  const keys = [];
  await pool(tiles, FETCH_CONCURRENCY, async (spec) => {
    const key = cacheKey(spec.source, spec.resolution, spec.tile);
    const buf = await loadRaw(spec, () => originalFetch(spec.url, { headers: { "user-agent": "openclutter" } }), {
      skipRemote: true,
    });
    keys.push(key);
    return buf;
  });
  if (storeRef) {
    await storeRef.setJSON("partial/" + parentId + "/" + batchId, {
      ok: true,
      keys,
      at: Date.now(),
    });
  }
  return { ok: true, keys };
}

function onNetlify() {
  return !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function fanOut(tiles, opts) {
  const list = [];
  for (let i = 0; i < (tiles || []).length; i++) {
    const spec = tiles[i];
    const key = cacheKey(spec.source, spec.resolution, spec.tile);
    const hit = await readRaw(storeRef, key);
    if (!hit) list.push(spec);
  }
  if (!list.length) return { batches: 0, remote: false, keys: [] };
  const groups = splitBatches(list, MAX_BACKGROUND_FUNCTIONS);
  const parentId = (opts && opts.parentId) || "export";
  const invokeUrl = opts && opts.invokeUrl;
  const remote = !!(opts && opts.invoke) || (onNetlify() && invokeUrl && /^https?:\/\//.test(invokeUrl));
  if (!remote) {
    await Promise.all(
      groups.map((group, i) =>
        runTileBatch({ tiles: group, batchId: String(i), parentId })
      )
    );
    return { batches: groups.length, remote: false };
  }
  await Promise.all(
    groups.map(async (group, i) => {
      const body = { mode: "source-tiles", parentId, batchId: String(i), tiles: group };
      for (let t = 0; t < group.length; t++) {
        const key = cacheKey(group[t].source, group[t].resolution, group[t].tile);
        if (!remoteWait.has(key)) {
          remoteWait.set(
            key,
            waitForRaw(key, 90000).finally(() => remoteWait.delete(key))
          );
        }
      }
      if (opts.invoke) await opts.invoke(invokeUrl || "", body);
      else {
        await originalFetch(invokeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
      }
    })
  );
  return { batches: groups.length, remote: true };
}

async function waitForRaw(key, timeoutMs) {
  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 1000);
  while (Date.now() < deadline) {
    const hit = await readRaw(storeRef, key);
    if (hit) return hit.body;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function readPartial(parentId, batchId) {
  if (!storeRef) return null;
  try {
    return await storeRef.get("partial/" + parentId + "/" + batchId, { type: "json" });
  } catch {
    return null;
  }
}

module.exports = {
  FETCH_CONCURRENCY,
  MAX_BACKGROUND_FUNCTIONS,
  AERIAL_STEP_DEG,
  OSM_STEP_DEG,
  MAX_AERIAL_TILES,
  SOURCE_TTL_MS,
  cacheKey,
  tileId,
  coverCells,
  looksLikeFinalGeometry,
  assertRaw,
  writeRaw,
  readRaw,
  freshMeta,
  ttlFor,
  enable,
  disable,
  enabled,
  classifyFetch,
  planAerialTiles,
  planSourceTiles,
  stitchAerial,
  compositeAerial,
  splitBatches,
  fanOut,
  runTileBatch,
  loadRaw,
  pool,
  withSlot,
  resetSlotsForTests,
  readPartial,
  activeFetchCount: () => activeFetches,
};
