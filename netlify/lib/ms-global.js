"use strict";

/**
 * Microsoft Global ML Building Footprints (quadkey gzip geojsonl).
 *
 * Esri MSBFP2 was last edited 2022-04-13 and only returns a handful of
 * footprints for Oak Creek's commercial block — the large white roofs are
 * absent from that layer, not dropped by pagination or the area filters.
 * The global release is one ~40 MB gzip per zoom-9 quadkey. We needle-filter
 * lines to the site bbox and keep polygons that actually intersect it.
 * MSBFP2 is still merged in underneath so a missing quadkey cannot erase
 * footprints the ArcGIS layer does have. OSM building ways are not read.
 *
 * Tiles are stream-downloaded and stream-parsed so the compressed gzip
 * and the decompressed GeoJSONL are never held in memory. Only features
 * that hit the draw bbox are kept, and that filtered set is cached.
 * Oak Creek is ~37 MB, Las Vegas ~57 MB, Minneapolis ~84 MB, Chicago
 * ~122 MB, New York ~127 MB, Phoenix ~127 MB, Houston ~139 MB, and
 * Los Angeles (Universal Hollywood) ~179 MB (171 MiB). All of those
 * must parse. The byte cap is a runaway guard, not a memory cap.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Readable, Writable, PassThrough, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const QUADKEY_ZOOM = 9;
const MS_INDEX_RELEASE = "2026-07-24";
const MS_INDEX_FILENAME = "ms-buildings-index.txt.gz";
const MS_INDEX_BASE =
  "https://bfppub.z5.web.core.windows.net/" +
  MS_INDEX_RELEASE +
  "/global-buildings.geojsonl/";

/**
 * Compact Global ML index (all regions, zoom 9). Rebuilt from Microsoft's
 * free dataset-links.csv by scripts/build-ms-buildings-index.js. A border
 * quadkey can have more than one URL (one file per region).
 */
let msIndex = null;

function msIndexPaths() {
  const roots = [
    __dirname,
    path.join(__dirname, "..", "lib"),
    path.join(process.env.LAMBDA_TASK_ROOT || "", "netlify", "lib"),
    path.join(process.cwd(), "netlify", "lib"),
  ];
  const out = [];
  for (let i = 0; i < roots.length; i++) {
    const p = path.join(roots[i], MS_INDEX_FILENAME);
    if (out.indexOf(p) === -1) out.push(p);
  }
  return out;
}

function loadMsIndex() {
  if (msIndex) return msIndex;
  const paths = msIndexPaths();
  let buf = null;
  let last = null;
  for (let i = 0; i < paths.length; i++) {
    try {
      buf = fs.readFileSync(paths[i]);
      last = null;
      break;
    } catch (err) {
      last = err;
      if (!err || err.code !== "ENOENT") throw err;
    }
  }
  if (!buf) {
    const err = new Error("Microsoft footprint index missing");
    err.code = "ENOENT";
    if (last) err.cause = last;
    throw err;
  }
  const map = new Map();
  const text = zlib.gunzipSync(buf).toString("utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.charAt(0) === "#") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const key = parts[0];
    const loc = parts[1];
    const part = parts[2];
    const url = MS_INDEX_BASE + "RegionName=" + loc + "/quadkey=" + key + "/" + part;
    const list = map.get(key);
    if (list) list.push(url);
    else map.set(key, [url]);
  }
  msIndex = map;
  return msIndex;
}

/**
 * Zoom-9 quadkeys are one gzip for a whole tile, not the drawn box.
 * Streamed reads keep memory flat, so this cap is only a runaway
 * guard (time and disk), not a RAM limit. It must clear Los Angeles
 * at ~179 MB, plus New York, Chicago, Houston, and Phoenix, which
 * all sit just above the old 120 MB cap.
 */
const MAX_GZIP_BYTES = 512 * 1024 * 1024;
const MS_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const MS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const msCache = require("./disk-cache").createDiskCache({
  envPrefix: "OPENCLUTTER_MS_CACHE",
  maxBytes: MS_CACHE_MAX_BYTES,
  ttlMs: MS_CACHE_TTL_MS,
  subdir: "microsoft",
  // Keep parsed bbox results (tiny) when a raw 179 MB gzip would fill the cap.
  protectUnderBytes: 1024 * 1024,
});

function setMsCacheDir(dir) {
  msCache.setDir(dir);
}

function setMsCacheLimits(opts) {
  msCache.setLimits(opts);
}

function msCacheEnabled(fetchFn, opts) {
  if (!msCache.dir()) return false;
  if (opts && opts.diskCache === false) return false;
  if (opts && opts.diskCache === true) return true;
  return !fetchFn || fetchFn === fetch;
}

// A 10 km Las Vegas tile matches tens of thousands of roofs. Holding every
// ring, plus the decompressed tile, runs the background function out of
// memory before the export can finish. The zip only keeps the largest.
const FOOTPRINT_KEEP = 4000;

function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((+lon + 180) / 360) * n);
  const latRad = (+lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}

function tileToQuadkey(x, y, zoom) {
  let q = "";
  for (let i = zoom; i > 0; i--) {
    let b = 0;
    const mask = 1 << (i - 1);
    if (x & mask) b += 1;
    if (y & mask) b += 2;
    q += String(b);
  }
  return q;
}

function quadkeysForBbox(west, south, east, north, zoom) {
  const z = zoom || QUADKEY_ZOOM;
  const [xW, yS] = lonLatToTile(west, south, z);
  const [xE, yN] = lonLatToTile(east, north, z);
  const keys = [];
  for (let x = Math.min(xW, xE); x <= Math.max(xW, xE); x++) {
    for (let y = Math.min(yN, yS); y <= Math.max(yN, yS); y++) {
      keys.push(tileToQuadkey(x, y, z));
    }
  }
  return keys;
}

function urlsForBbox(west, south, east, north) {
  const keys = quadkeysForBbox(west, south, east, north);
  const index = loadMsIndex();
  const urls = [];
  for (const key of keys) {
    const list = index.get(key);
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      urls.push({ quadkey: key, url: list[i] });
    }
  }
  return { keys, urls };
}

/** Decimal prefixes that appear in coordinates inside [min, max] ± pad. */
function spanNeedles(min, max, pad) {
  const a = Math.floor((min - pad) * 100) / 100;
  const b = Math.ceil((max + pad) * 100) / 100;
  const out = [];
  for (let x = a; x <= b + 1e-9; x += 0.01) {
    const s = (Math.round(x * 100) / 100).toFixed(2);
    out.push(Buffer.from(s));
  }
  return out;
}

function hasAny(line, needles) {
  for (let i = 0; i < needles.length; i++) {
    if (line.includes(needles[i])) return true;
  }
  return false;
}

function usableHeight(props) {
  const h = Number(
    props && (props.height != null ? props.height : props.Height != null ? props.Height : props.HEIGHT)
  );
  return h > 2 && h < 400 ? h : 0;
}

function featureHeight(feature) {
  return usableHeight(feature && feature.properties);
}

function setFeatureHeight(feature, height) {
  if (!feature.properties) feature.properties = {};
  feature.properties.height = height;
}

function exteriorRings(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates[0];
    return ring && ring.length >= 4 ? [ring] : [];
  }
  if (geometry.type === "MultiPolygon") {
    const out = [];
    for (const poly of geometry.coordinates) {
      if (poly && poly[0] && poly[0].length >= 4) out.push(poly[0]);
    }
    return out;
  }
  return [];
}

function ringBBoxHits(ring, bbox) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = +ring[i][0];
    const y = +ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return !(maxX < bbox.west || minX > bbox.east || maxY < bbox.south || minY > bbox.north);
}

function geometryHitsBbox(geometry, bbox) {
  const rings = exteriorRings(geometry);
  for (let i = 0; i < rings.length; i++) {
    if (ringBBoxHits(rings[i], bbox)) return true;
  }
  return false;
}

function segsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * A traced roof is a simple ring. Global ML sometimes follows a tower's cast
 * shadow across a whole block and returns a bow-tie ring with long spikes.
 * Clipping later splits that into slabs that cover the courtyard and cut the
 * trees under it, so a crossing ring is dropped at the source.
 */
function ringSelfIntersects(ring) {
  if (!Array.isArray(ring)) return false;
  let pts = ring;
  const n0 = pts.length;
  if (n0 > 1 && pts[0][0] === pts[n0 - 1][0] && pts[0][1] === pts[n0 - 1][1]) pts = pts.slice(0, -1);
  const n = pts.length;
  if (n < 4 || n > 600) return false;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

function geometrySelfIntersects(geometry) {
  const rings = exteriorRings(geometry);
  for (let i = 0; i < rings.length; i++) {
    if (ringSelfIntersects(rings[i])) return true;
  }
  return false;
}

/** Over this a Global ML ring with several needle corners is a shadow trace. */
const SPIDER_MIN_M2 = 20000;
const SPIDER_ACUTE_DEG = 30;
const SPIDER_MIN_ACUTE = 3;

/**
 * Global ML sometimes traces a tower's cast shadow and the plazas around it
 * into one block-sized ring with needle spikes (Wynn west podium: 208,000 m²,
 * four corners under 30°). A real roof that large is drawn with square
 * corners. Small rings keep their acute corners; Boston row houses have them.
 */
function isSpiderRing(ring) {
  if (!Array.isArray(ring) || ring.length < 5) return false;
  let pts = ring;
  const n0 = pts.length;
  if (pts[0][0] === pts[n0 - 1][0] && pts[0][1] === pts[n0 - 1][1]) pts = pts.slice(0, -1);
  const lat0 = +pts[0][1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110950;
  const m = pts.map((p) => [+p[0] * kx, +p[1] * ky]);
  const n = m.length;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += m[j][0] * m[i][1] - m[i][0] * m[j][1];
  if (Math.abs(a) / 2 < SPIDER_MIN_M2) return false;
  let acute = 0;
  for (let i = 0; i < n; i++) {
    const p = m[(i + n - 1) % n];
    const b = m[i];
    const c = m[(i + 1) % n];
    const ux = p[0] - b[0];
    const uy = p[1] - b[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const den = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (!(den > 0)) continue;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / den));
    if ((Math.acos(cos) * 180) / Math.PI < SPIDER_ACUTE_DEG) acute++;
  }
  return acute >= SPIDER_MIN_ACUTE;
}

function normalizeFeature(obj) {
  if (!obj || !obj.geometry) return null;
  if (geometrySelfIntersects(obj.geometry)) return null;
  const rings = exteriorRings(obj.geometry);
  for (let i = 0; i < rings.length; i++) {
    if (isSpiderRing(rings[i])) return null;
  }
  const height = usableHeight(obj.properties);
  const properties = { geomSource: "ms-global" };
  if (height) {
    properties.height = height;
    properties.heightSource = "ms-global";
  }
  return {
    type: "Feature",
    properties,
    geometry: obj.geometry,
  };
}

function ringAreaAbs(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += +ring[j][0] * +ring[i][1] - +ring[i][0] * +ring[j][1];
  }
  return Math.abs(a);
}

function footprintScore(feature) {
  const geom = feature && feature.geometry;
  let area = 0;
  if (geom && geom.type === "Polygon" && geom.coordinates && geom.coordinates[0]) {
    area = ringAreaAbs(geom.coordinates[0]);
  } else if (geom && geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    for (let i = 0; i < polys.length; i++) {
      if (polys[i] && polys[i][0]) area += ringAreaAbs(polys[i][0]);
    }
  }
  const h = Number(feature && feature.properties && feature.properties.height);
  const height = h > 2 && h < 400 ? h : 0;
  return area * Math.max(1, height / 10);
}

function keepLargestFootprints(features, keep) {
  const n = keep | 0;
  if (!(n > 0) || features.length <= n) return features;
  const scored = new Array(features.length);
  for (let i = 0; i < features.length; i++) scored[i] = { f: features[i], s: footprintScore(features[i]) };
  scored.sort((a, b) => b.s - a.s);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = scored[i].f;
  return out;
}

function trimFootprints(features, keep) {
  if (features.length <= keep) return features;
  const kept = keepLargestFootprints(features, keep);
  features.length = 0;
  for (let i = 0; i < kept.length; i++) features.push(kept[i]);
  return features;
}

function createGzipParseState(bbox, opts) {
  const keep = opts && opts.keep > 0 ? opts.keep | 0 : FOOTPRINT_KEEP;
  return {
    keep,
    lonNeedles: spanNeedles(+bbox.west, +bbox.east, 0.03),
    latNeedles: spanNeedles(+bbox.south, +bbox.north, 0.03),
    features: [],
    accept(line) {
      if (!line || line.length < 40) return;
      if (!hasAny(line, this.lonNeedles) || !hasAny(line, this.latNeedles)) return;
      let obj;
      try {
        obj = JSON.parse(line.toString("utf8"));
      } catch {
        return;
      }
      if (!geometryHitsBbox(obj.geometry, bbox)) return;
      const feature = normalizeFeature(obj);
      if (!feature) return;
      this.features.push(feature);
      if (this.features.length >= this.keep * 2) trimFootprints(this.features, this.keep);
    },
    finish() {
      return trimFootprints(this.features, this.keep);
    },
  };
}

/**
 * @param {Buffer} gz gzip of newline-delimited GeoJSON
 * @param {{west:number,south:number,east:number,north:number}} bbox
 * @param {{keep?:number}} [opts]
 */
function featuresFromGzip(gz, bbox, opts) {
  const state = createGzipParseState(bbox, opts);
  const text = zlib.gunzipSync(gz);
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== 10) continue;
    state.accept(text.subarray(start, i));
    start = i + 1;
  }
  return state.finish();
}

/**
 * Stream-inflate a gzip tile and keep only bbox lines. The full
 * compressed tile and decompressed GeoJSONL are never held, so a
 * 179 MB Los Angeles tile can parse on an 8 GB worker and on the
 * Netlify fallback.
 *
 * @param {import("stream").Readable} source
 * @param {{west:number,south:number,east:number,north:number}} bbox
 * @param {{keep?:number}} [opts]
 */
async function featuresFromGzipStream(source, bbox, opts) {
  const state = createGzipParseState(bbox, opts);
  let leftover = Buffer.alloc(0);
  let lastYield = Date.now();
  const sink = new Writable({
    write(chunk, _enc, cb) {
      leftover = leftover.length ? Buffer.concat([leftover, chunk]) : Buffer.from(chunk);
      let start = 0;
      for (let i = 0; i < leftover.length; i++) {
        if (leftover[i] !== 10) continue;
        state.accept(leftover.subarray(start, i));
        start = i + 1;
      }
      leftover = start ? leftover.subarray(start) : leftover;
      // Yield so a 179 MB parse does not stall lidar decode on the same event loop.
      if (Date.now() - lastYield >= 15) {
        lastYield = Date.now();
        setImmediate(cb);
        return;
      }
      cb();
    },
    final(cb) {
      if (leftover.length) state.accept(leftover);
      cb();
    },
  });
  await pipeline(source, zlib.createGunzip(), sink);
  return state.finish();
}

async function featuresFromGzipBuffer(gz, bbox, opts) {
  return featuresFromGzipStream(Readable.from(gz), bbox, opts);
}

function centroid(ring) {
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += +ring[i][0];
    sy += +ring[i][1];
  }
  return [sx / n, sy / n];
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = +ring[i][0];
    const yi = +ring[i][1];
    const xj = +ring[j][0];
    const yj = +ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Keep every primary footprint, then add secondary footprints whose centroid
 * is not already inside one. When a secondary ring is already covered, copy
 * its measured height onto the primary feature that contains the centroid
 * (FEMA USA Structures HEIGHT is otherwise thrown away by the dedupe).
 */
function mergeFootprintFeatures(primary, secondary) {
  const base = Array.isArray(primary) ? primary.slice() : [];
  const extraSrc = Array.isArray(secondary) ? secondary : [];
  const owners = [];
  for (const f of base) {
    const ex = exteriorRings(f && f.geometry);
    for (const r of ex) owners.push({ ring: r, feature: f });
  }
  let added = 0;
  let heightsTransferred = 0;
  for (const f of extraSrc) {
    const ex = exteriorRings(f && f.geometry);
    if (!ex.length) continue;
    const h = featureHeight(f);
    let covered = true;
    for (const ring of ex) {
      const c = centroid(ring);
      const owner = c && owners.find((o) => pointInRing(c, o.ring));
      if (!owner) {
        covered = false;
        continue;
      }
      if (h && !featureHeight(owner.feature)) {
        setFeatureHeight(owner.feature, h);
        heightsTransferred++;
      }
    }
    if (covered) continue;
    base.push(f);
    for (const r of ex) owners.push({ ring: r, feature: f });
    added++;
  }
  return { features: base, added, heightsTransferred };
}

function contentLength(res) {
  const headers = res && res.headers;
  if (!headers || typeof headers.get !== "function") return 0;
  const n = Number(headers.get("content-length") || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function releaseBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === "function") await res.body.cancel();
  } catch {
    /* the socket is already closed */
  }
}

function nodeReadableFromResponse(res) {
  const body = res && res.body;
  if (body && typeof body.pipe === "function") return body;
  if (body && typeof Readable.fromWeb === "function" && typeof body.getReader === "function") {
    try {
      return Readable.fromWeb(body);
    } catch {
      /* test doubles and odd runtimes fall through */
    }
  }
  return null;
}

/**
 * Prefer a real body stream so a 179 MB tile is never buffered. Test
 * doubles that only expose arrayBuffer still work when the payload is
 * under the runaway cap.
 */
async function readableFromResponse(res, len) {
  const stream = nodeReadableFromResponse(res);
  if (stream) return stream;
  if (res && typeof res.arrayBuffer === "function") {
    if (len > MAX_GZIP_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_GZIP_BYTES) return null;
    return Readable.from(buf);
  }
  return null;
}

function createByteLimit(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (maxBytes > 0 && seen > maxBytes) {
        const err = new Error("microsoft tile over size limit");
        err.code = "MS_TILE_TOO_LARGE";
        err.bytes = seen;
        cb(err);
        return;
      }
      cb(null, chunk);
    },
  });
}

function teeReadable(source) {
  const a = new PassThrough();
  const b = new PassThrough();
  source.on("error", (err) => {
    a.destroy(err);
    b.destroy(err);
  });
  source.pipe(a);
  source.pipe(b);
  return [a, b];
}

function parsedCacheKey(url, bbox, keep) {
  return [
    "ms-parsed-v1",
    url,
    +bbox.west,
    +bbox.south,
    +bbox.east,
    +bbox.north,
    keep > 0 ? keep : FOOTPRINT_KEEP,
  ].join("|");
}

async function readParsedFeatures(url, bbox, keep) {
  const buf = await msCache.read(parsedCacheKey(url, bbox, keep));
  if (!buf || !buf.length) return null;
  try {
    const features = JSON.parse(buf.toString("utf8"));
    return Array.isArray(features) ? features : null;
  } catch {
    return null;
  }
}

async function writeParsedFeatures(url, bbox, keep, features) {
  try {
    await msCache.write(
      parsedCacheKey(url, bbox, keep),
      Buffer.from(JSON.stringify(features || []), "utf8")
    );
  } catch {
    /* a missed parsed write only means the next run parses the gzip again */
  }
}

async function fetchMsGlobalFootprints(frame, fetchFn, opts) {
  const { timeSpan } = require("./stage-clock");
  return timeSpan("microsoft", () => fetchMsGlobalFootprintsWork(frame, fetchFn, opts));
}

async function fetchMsGlobalFootprintsWork(frame, fetchFn, opts) {
  const { keys, urls } = urlsForBbox(frame.west, frame.south, frame.east, frame.north);
  const bbox = {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
  };
  const features = [];
  let skipped = 0;
  let skippedBytes = 0;
  let skippedErrors = 0;
  const useCache = msCacheEnabled(fetchFn, opts);
  const fetchImpl = fetchFn || fetch;
  const keep = FOOTPRINT_KEEP;
  for (const item of urls) {
    if (useCache) {
      const parsed = await readParsedFeatures(item.url, bbox, keep);
      if (parsed) {
        msCache.note("microsoft", true);
        for (const f of parsed) features.push(f);
        continue;
      }
    }
    let source = null;
    let fromDisk = false;
    let expectedBytes = 0;
    if (useCache) {
      source = await msCache.createReadStream(item.url);
      if (source) {
        fromDisk = true;
        msCache.note("microsoft", true);
      } else {
        msCache.note("microsoft", false);
      }
    }
    if (!source) {
      let res = await fetchImpl(item.url);
      if (!res || res.ok === false) {
        // One short retry: these tiles are large and a brief 5xx is common.
        res = await fetchImpl(item.url);
      }
      if (!res || res.ok === false) {
        throw new Error("global footprints HTTP " + (res && res.status));
      }
      const len = contentLength(res);
      expectedBytes = len;
      if (len > MAX_GZIP_BYTES) {
        skipped++;
        skippedBytes += len;
        await releaseBody(res);
        continue;
      }
      source = await readableFromResponse(res, len);
      if (!source) {
        skipped++;
        skippedBytes += len;
        skippedErrors += len > MAX_GZIP_BYTES ? 0 : 1;
        await releaseBody(res);
        continue;
      }
    }
    const limiter = createByteLimit(MAX_GZIP_BYTES);
    let parseSource = limiter;
    let writeP = Promise.resolve();
    if (useCache && !fromDisk) {
      const [toFile, toParse] = teeReadable(limiter);
      // A cache that cannot be written (a read-only home on Netlify) must not
      // stop the parse: an unread tee side holds back the other (1.3.93).
      const drain = () => {
        if (!toFile.readableEnded && !toFile.destroyed) toFile.resume();
      };
      writeP = msCache.writeFromStream(item.url, toFile).then(
        (n) => {
          drain();
          return n;
        },
        () => {
          drain();
          return 0;
        }
      );
      parseSource = toParse;
    }
    // A dropped or timed-out body fails this tile instead of crashing the
    // process with an unhandled stream error (1.3.93).
    source.on("error", (err) => limiter.destroy(err));
    source.pipe(limiter);
    let chunk;
    try {
      chunk = await featuresFromGzipStream(parseSource, bbox, { keep });
      await writeP;
    } catch (err) {
      try {
        source.destroy();
      } catch {
        /* already closed */
      }
      await writeP;
      skipped++;
      skippedBytes += (err && err.bytes) || expectedBytes;
      if (!err || err.code !== "MS_TILE_TOO_LARGE") skippedErrors++;
      continue;
    }
    if (useCache) await writeParsedFeatures(item.url, bbox, keep, chunk);
    for (const f of chunk) features.push(f);
  }
  return { features, quadkeys: keys, files: urls.length, skipped, skippedBytes, skippedErrors };
}

function megabytes(bytes) {
  return Math.max(1, Math.round((bytes || 0) / (1024 * 1024)));
}

function globalSkipWarning(pack) {
  if (!pack || !pack.skipped) return "";
  const mb = megabytes(pack.skippedBytes);
  const limit = megabytes(MAX_GZIP_BYTES);
  const parseFail = pack.skippedErrors > 0 && !(pack.skippedBytes > MAX_GZIP_BYTES);
  if (parseFail) {
    return (
      "Microsoft building footprints omitted: the footprint tile could not be parsed. Other building sources are included."
    );
  }
  if (pack.features && pack.features.length) {
    return (
      "Microsoft building footprints partial: kept " +
      pack.features.length +
      " and left out a " +
      mb +
      " MB tile (limit " +
      limit +
      " MB). Other building sources are included."
    );
  }
  return (
    "Microsoft building footprints omitted: the footprint tile is " +
    mb +
    " MB, over the " +
    limit +
    " MB export limit. Other building sources are included."
  );
}

module.exports = {
  isSpiderRing,
  ringSelfIntersects,
  geometrySelfIntersects,
  normalizeFeature,
  QUADKEY_ZOOM,
  lonLatToTile,
  tileToQuadkey,
  quadkeysForBbox,
  urlsForBbox,
  loadMsIndex,
  MS_INDEX_RELEASE,
  spanNeedles,
  featuresFromGzip,
  featuresFromGzipStream,
  featuresFromGzipBuffer,
  mergeFootprintFeatures,
  MAX_GZIP_BYTES,
  FOOTPRINT_KEEP,
  fetchMsGlobalFootprints,
  setMsCacheDir,
  setMsCacheLimits,
  parsedCacheKey,
  MS_CACHE_MAX_BYTES,
  MS_CACHE_TTL_MS,
  globalSkipWarning,
  exteriorRings,
  pointInRing,
  centroid,
  featureHeight,
  setFeatureHeight,
};
