"use strict";

/**
 * Meta / WRI canopy height (CHM v2), ~1.2 m uint8 metres, anonymous COG.
 * One zoom-10 Web-Mercator quadkey covers a commercial site. The reader
 * requests only the pixel window over the export bbox, so the ~200 MB tile
 * is not downloaded. Each export cell keeps the tallest measured sample in
 * it, and only when two or more samples are canopy. Averaging those samples
 * was flattening a narrow crown into the grass. One spike is not a tree.
 * NLCD percent can add a cell only where cover is denser and a measured
 * height is already on the grid. It does not invent a height. A sample ≥ 2 m
 * is a measured top. 0 / nodata is not.
 * crownsFromChm traces each connected canopy as one simplified polygon: the
 * ring follows the CHM edge, and the height is the measured top inside it.
 * It does not emit grid squares, circles, trunks, or a point scatter.
 */

const { quadkeysForBbox } = require("./ms-global");
const profile = require("./profile-log");
const exportMode = require("./export-mode");
const standSplit = require("./stand-split");

const CHM_ZOOM = 10;
const MAX_TILES = 4;
/** Long side of the resampled window. Cells stay near 2 m so a crown has an edge. */
const MAX_DIM = 720;
const TARGET_CELL_M = 2.2;
const MIN_CELL_M = 1.4;
/** Pixels below this are ground, not canopy. */
const CROWN_MIN_H = 3;
const CROWN_MIN_AREA_M2 = 12;
const CROWN_MAX_VERTS = 32;
/**
 * Safety cap before the export budget. The largest masses fill the first
 * 480 slots (the previous budget). Further slots are compact measured crowns,
 * so a busy site does not spend the whole cap on woods and drop every tree.
 */
const CROWN_CAP = 1400;
const BULK_POLYGONS = 480;
/** A fairway tree, not a woods mass. Extra slots stay available for these. */
const COMPACT_AREA_M2 = 180;
const COMPACT_MIN_H = 5;
/** Native samples at or above the canopy floor required before a cell is real. */
const MIN_PEAK_SAMPLES = 2;
/** Rows per canopy read. Short enough that an abort can stop the next strip. */
const CHM_STRIP_ROWS = 256;
/** In-flight canopy windows. The main thread stays free for the heartbeat. */
const STRIP_CONCURRENCY = 4;
const RASTER_MAGIC = "CHM1";
const RASTER_HEADER = 44;
/**
 * Long side of a full-site overview. Native strips walk north to south, so an
 * abort used to keep only the north band and leave the rest of a course empty.
 * One overview covers the whole draw first. Strips then sharpen it.
 */
const SURVEY_MAX_SIDE = 1400;

function chmUrl(quadkey) {
  return (
    "https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm/" +
    quadkey +
    ".tif"
  );
}

function mercator(lon, lat) {
  const R = 20037508.342789244;
  const x = (lon * R) / 180;
  const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * (R / Math.PI);
  return [x, y];
}

function gridSize(frame) {
  const lat = ((+frame.south) + (+frame.north)) / 2;
  const widthM = Math.abs(+frame.east - +frame.west) * 111320 * Math.cos((lat * Math.PI) / 180);
  const heightM = Math.abs(+frame.north - +frame.south) * 110540;
  let width = Math.max(8, Math.round((widthM || 1) / TARGET_CELL_M));
  let height = Math.max(8, Math.round((heightM || 1) / TARGET_CELL_M));
  const over = Math.max(width / MAX_DIM, height / MAX_DIM, 1);
  width = Math.max(8, Math.round(width / over));
  height = Math.max(8, Math.round(height / over));
  const cell = widthM / width;
  if (cell > 0 && cell < MIN_CELL_M) {
    width = Math.max(8, Math.round(widthM / MIN_CELL_M));
    height = Math.max(8, Math.round(heightM / MIN_CELL_M));
  }
  return { width, height };
}

function valuesOf(raster) {
  if (!raster) return null;
  if (raster.data) return raster.data;
  if (ArrayBuffer.isView(raster)) return raster;
  if (raster[0] && ArrayBuffer.isView(raster[0]) && raster.length === 1) return raster[0];
  return raster;
}

function sampleBilinear(values, width, height, x, y) {
  if (!values || x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const v00 = values[y0 * width + x0] || 0;
  const v10 = values[y0 * width + x1] || 0;
  const v01 = values[y1 * width + x0] || 0;
  const v11 = values[y1 * width + x1] || 0;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

function sampleChmGrid(grid, lon, lat) {
  if (!grid || !Number.isFinite(lon) || !Number.isFinite(lat)) return 0;
  if (lon < grid.west || lon > grid.east || lat < grid.south || lat > grid.north) return 0;
  const values = typeof grid.values === "string" ? Buffer.from(grid.values, "base64") : grid.values;
  const width = grid.width;
  const height = grid.height;
  if (!values || values.length < width * height) return 0;
  const x = ((lon - grid.west) / (grid.east - grid.west || 1e-9)) * (width - 1);
  const y = ((grid.north - lat) / (grid.north - grid.south || 1e-9)) * (height - 1);
  const v = sampleBilinear(values, width, height, x, y);
  if (!(v > 2) || v >= 80) return 0;
  return Math.round(v * 10) / 10;
}

function applyChmToTrees(trees, sampleFn) {
  const out = [];
  let applied = 0;
  const list = trees || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    const h = sampleFn(t.lon, t.lat);
    if (h > 2 && h <= 50) {
      applied++;
      out.push(Object.assign({}, t, { heightM: h, heightSource: "chm" }));
    } else {
      out.push(t);
    }
  }
  return { trees: out, applied };
}

function gridToJson(grid) {
  return {
    west: grid.west,
    south: grid.south,
    east: grid.east,
    north: grid.north,
    width: grid.width,
    height: grid.height,
    values: Buffer.from(grid.values).toString("base64"),
  };
}

function lonLatFromMercator(x, y) {
  const R = 20037508.342789244;
  // Inverse of mercator() above. That Y is the web-mercator Y divided by π,
  // which is the CRS on the Meta canopy tiles.
  const lon = (x * 180) / R;
  const lat = (Math.atan(Math.exp((y * Math.PI) / R)) * 360) / Math.PI - 90;
  return [lon, lat];
}

function tileWindow(image, frame) {
  const origin = image.getOrigin();
  const res = image.getResolution();
  const px = (x) => (x - origin[0]) / res[0];
  const py = (y) => (y - origin[1]) / res[1];
  const [xW, yS] = mercator(frame.west, frame.south);
  const [xE, yN] = mercator(frame.east, frame.north);
  let left = Math.floor(Math.min(px(xW), px(xE)));
  let right = Math.ceil(Math.max(px(xW), px(xE)));
  let top = Math.floor(Math.min(py(yS), py(yN)));
  let bottom = Math.ceil(Math.max(py(yS), py(yN)));
  const iw = image.getWidth();
  const ih = image.getHeight();
  if (right <= 0 || bottom <= 0 || left >= iw || top >= ih) return null;
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(iw, right);
  bottom = Math.min(ih, bottom);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, right, bottom, origin, res };
}

/**
 * Read the native canopy window in short strips. One full-frame decode held
 * the function until the gateway returned an empty 502, and the abort on
 * that read was ignored. A strip that is still running stops when the export
 * aborts, and the event loop can finish the zip between strips.
 */
function canopyRasterSpec(frame) {
  const { tileId } = require("./area-cache");
  return {
    source: "canopy",
    resolution: "1.2m",
    tile: tileId({
      west: +frame.west,
      south: +frame.south,
      east: +frame.east,
      north: +frame.north,
    }),
  };
}

/** Decoded height window. Not a polygon, a ring, or an OpenIntent area. */
function encodeCanopyRaster(grid) {
  const values = Buffer.from(grid.values);
  const header = Buffer.alloc(RASTER_HEADER);
  header.write(RASTER_MAGIC, 0, 4, "ascii");
  header.writeUInt32LE(grid.width | 0, 4);
  header.writeUInt32LE(grid.height | 0, 8);
  header.writeDoubleLE(+grid.west, 12);
  header.writeDoubleLE(+grid.south, 20);
  header.writeDoubleLE(+grid.east, 28);
  header.writeDoubleLE(+grid.north, 36);
  return Buffer.concat([header, values]);
}

function decodeCanopyRaster(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (buf.length < RASTER_HEADER || buf.toString("ascii", 0, 4) !== RASTER_MAGIC) return null;
  const width = buf.readUInt32LE(4);
  const height = buf.readUInt32LE(8);
  if (!(width > 1) || !(height > 1) || buf.length < RASTER_HEADER + width * height) return null;
  const values = new Uint8Array(buf.subarray(RASTER_HEADER, RASTER_HEADER + width * height));
  let nz = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= CROWN_MIN_H) nz++;
  if (!nz) return null;
  return {
    west: buf.readDoubleLE(12),
    south: buf.readDoubleLE(20),
    east: buf.readDoubleLE(28),
    north: buf.readDoubleLE(36),
    width,
    height,
    values,
    nonzero: nz,
  };
}

async function loadCanopyRaster(frame) {
  const areaCache = require("./area-cache");
  if (!areaCache.enabled() || !frame) return null;
  const spec = canopyRasterSpec(frame);
  const key = areaCache.cacheKey(spec.source, spec.resolution, spec.tile);
  const hit = await areaCache.readRaw(null, key);
  if (!hit || !hit.body) return null;
  return decodeCanopyRaster(hit.body);
}

async function saveCanopyRaster(frame, grid) {
  const areaCache = require("./area-cache");
  if (!areaCache.enabled() || !frame || !grid || !grid.values) return false;
  const body = encodeCanopyRaster(grid);
  areaCache.assertRaw(body);
  const spec = canopyRasterSpec(frame);
  const key = areaCache.cacheKey(spec.source, spec.resolution, spec.tile);
  await areaCache.writeRaw(null, key, body, {
    source: "canopy",
    resolution: spec.resolution,
    tile: spec.tile,
    contentType: "application/octet-stream",
  });
  return true;
}

/**
 * Read every canopy window with a concurrency cap. Each read yields, so a
 * 10 second heartbeat on the main thread still fires during the prefetch.
 * A window that has not started does not start after abort.
 */
async function prefetchCanopyWindows(image, windows, opts) {
  const list = windows || [];
  const out = new Array(list.length);
  if (!list.length || !image || typeof image.readRasters !== "function") return out;
  const limit = opts && opts.concurrency > 0 ? opts.concurrency | 0 : STRIP_CONCURRENCY;
  const signal = opts && opts.signal;
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, list.length));
  const stopped = (err) =>
    (signal && signal.aborted) || /abort|timeout/i.test(String(err && err.message ? err.message : err));
  async function worker() {
    while (cursor < list.length) {
      if (signal && signal.aborted) return;
      const i = cursor++;
      if (i >= list.length) return;
      const win = list[i];
      try {
        out[i] = await image.readRasters({
          window: [win.left, win.top, win.right, win.bottom],
          interleave: true,
          signal,
        });
      } catch (err) {
        if (stopped(err)) return;
        throw err;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function readPeakStrips(image, frame, dstW, dstH, max, count, signal) {
  const win = tileWindow(image, frame);
  if (!win) return false;
  const width = win.right - win.left;
  const windows = [];
  for (let row = win.top; row < win.bottom; row += CHM_STRIP_ROWS) {
    const row1 = Math.min(win.bottom, row + CHM_STRIP_ROWS);
    windows.push({ left: win.left, top: row, right: win.right, bottom: row1 });
  }
  const rasters = await prefetchCanopyWindows(image, windows, { signal, concurrency: STRIP_CONCURRENCY });
  for (let i = 0; i < windows.length; i++) {
    const ras = rasters[i];
    if (!ras) continue;
    const row = windows[i];
    accumulatePeaks(
      max,
      count,
      {
        data: valuesOf(ras),
        width,
        height: row.bottom - row.top,
        left: row.left,
        top: row.top,
        origin: win.origin,
        res: win.res,
      },
      frame,
      dstW,
      dstH
    );
  }
  return !(signal && signal.aborted);
}

/** Finest overview that still covers the whole draw in one read. Null when strips are enough. */
async function surveyImage(tiff, fullImage, frame, signal) {
  const full = tileWindow(fullImage, frame);
  if (!full || !tiff || typeof tiff.getImageCount !== "function") return null;
  const fullSide = Math.max(full.right - full.left, full.bottom - full.top);
  if (fullSide <= SURVEY_MAX_SIDE) return null;
  let n = 1;
  try {
    const count = await tiff.getImageCount();
    if (count > 1 && count < 12) n = count;
  } catch {
    return null;
  }
  let coarsest = null;
  for (let i = 1; i < n; i++) {
    if (signal && signal.aborted) return coarsest;
    let image;
    try {
      image = await tiff.getImage(i);
    } catch {
      break;
    }
    const win = tileWindow(image, frame);
    if (!win) continue;
    const side = Math.max(win.right - win.left, win.bottom - win.top);
    if (side < 8) continue;
    coarsest = { image, win };
    if (side <= SURVEY_MAX_SIDE) return coarsest;
  }
  return coarsest;
}

/**
 * One full-draw read before the native strips. Peaks from this pass stay if
 * the strip walk is aborted, so the south of a course is not left empty.
 */
async function readSurveyPeaks(tiff, fullImage, frame, dstW, dstH, max, count, signal) {
  const chosen = await surveyImage(tiff, fullImage, frame, signal);
  if (!chosen) return true;
  if (signal && signal.aborted) return false;
  const win = chosen.win;
  const ras = await chosen.image.readRasters({
    window: [win.left, win.top, win.right, win.bottom],
    interleave: true,
    signal,
  });
  accumulatePeaks(
    max,
    count,
    {
      data: valuesOf(ras),
      width: win.right - win.left,
      height: win.bottom - win.top,
      left: win.left,
      top: win.top,
      origin: win.origin,
      res: win.res,
    },
    frame,
    dstW,
    dstH,
    { confirmTall: true, fillFootprint: true }
  );
  await new Promise((resolve) => setImmediate(resolve));
  return !(signal && signal.aborted);
}

/**
 * Collapse a finer canopy raster onto the export grid by index.
 * A cell keeps its tallest sample only when two or more samples are at
 * least 3 m. Grass (under 3 m) and a one-pixel spike do not become a cell.
 */
function peakPool(src, srcW, srcH, dstW, dstH) {
  const dw = dstW | 0;
  const dh = dstH | 0;
  const sw = srcW | 0;
  const sh = srcH | 0;
  const max = new Uint8Array(dw * dh);
  const count = new Uint16Array(dw * dh);
  if (!src || dw < 1 || dh < 1 || sw < 1 || sh < 1) return max;
  for (let y = 0; y < sh; y++) {
    const dy = Math.min(dh - 1, Math.floor((y * dh) / sh));
    const row = y * sw;
    for (let x = 0; x < sw; x++) {
      const v = src[row + x] || 0;
      if (v < CROWN_MIN_H || v >= 80) continue;
      const dx = Math.min(dw - 1, Math.floor((x * dw) / sw));
      const i = dy * dw + dx;
      count[i]++;
      if (v > max[i]) max[i] = v;
    }
  }
  const out = new Uint8Array(dw * dh);
  for (let i = 0; i < out.length; i++) {
    if (count[i] >= MIN_PEAK_SAMPLES) out[i] = max[i];
  }
  return out;
}

function accumulatePeaks(max, count, tile, frame, dstW, dstH, opts) {
  const data = tile.data;
  const sw = tile.width | 0;
  const sh = tile.height | 0;
  if (!data || sw < 1 || sh < 1) return;
  // An overview pixel is already a pooled sample. A tall one is a crown even
  // when it lands in a single export cell. A short speck still needs a neighbor.
  // Fill that pixel's ground footprint so a coarser overview does not shatter
  // one crown into a scatter of squares.
  const confirmTall = !!(opts && opts.confirmTall);
  const fillFootprint = !!(opts && opts.fillFootprint);
  const dLon = +frame.east - +frame.west || 1e-9;
  const dLat = +frame.north - +frame.south || 1e-9;
  const west = +frame.west;
  const east = +frame.east;
  const south = +frame.south;
  const north = +frame.north;
  const resX = tile.res[0];
  const resY = tile.res[1];
  const lonEdge = new Float64Array(sw + 1);
  for (let x = 0; x <= sw; x++) {
    const mx = tile.origin[0] + (tile.left + x + (fillFootprint ? 0 : 0.5)) * resX;
    lonEdge[x] = lonLatFromMercator(mx, 0)[0];
  }
  const ixOf = (lon) => Math.min(dstW - 1, Math.max(0, Math.floor(((lon - west) / dLon) * dstW)));
  const iyOf = (lat) => Math.min(dstH - 1, Math.max(0, Math.floor(((north - lat) / dLat) * dstH)));
  const stamp = (ix, iy, v) => {
    if (ix < 0 || iy < 0 || ix >= dstW || iy >= dstH) return;
    const i = iy * dstW + ix;
    if (confirmTall && v >= 5) {
      if (count[i] < MIN_PEAK_SAMPLES) count[i] = MIN_PEAK_SAMPLES;
    } else {
      count[i]++;
    }
    if (v > max[i]) max[i] = v;
  };
  for (let y = 0; y < sh; y++) {
    const yEdge = tile.top + y;
    const lat0 = lonLatFromMercator(0, tile.origin[1] + (yEdge + (fillFootprint ? 0 : 0.5)) * resY)[1];
    const lat1 = fillFootprint ? lonLatFromMercator(0, tile.origin[1] + (yEdge + 1) * resY)[1] : lat0;
    if (Math.max(lat0, lat1) < south || Math.min(lat0, lat1) > north) continue;
    const row = y * sw;
    for (let x = 0; x < sw; x++) {
      const v = data[row + x] || 0;
      if (v < CROWN_MIN_H || v >= 80) continue;
      if (!fillFootprint) {
        const lon = lonEdge[x];
        if (lon < west || lon > east || lat0 < south || lat0 > north) continue;
        stamp(ixOf(lon), iyOf(lat0), v);
        continue;
      }
      const lon0 = lonEdge[x];
      const lon1 = lonEdge[x + 1];
      if (Math.max(lon0, lon1) < west || Math.min(lon0, lon1) > east) continue;
      let x0 = ixOf(Math.min(lon0, lon1));
      let x1 = ixOf(Math.max(lon0, lon1));
      let y0 = iyOf(Math.max(lat0, lat1));
      let y1 = iyOf(Math.min(lat0, lat1));
      if (x1 < x0) {
        const swap = x0;
        x0 = x1;
        x1 = swap;
      }
      if (y1 < y0) {
        const swap = y0;
        y0 = y1;
        y1 = swap;
      }
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) stamp(ix, iy, v);
      }
    }
  }
}

function packPeakGrid(frame, width, height, max, count) {
  const values = new Uint8Array(width * height);
  let nz = 0;
  for (let i = 0; i < values.length; i++) {
    if (count[i] >= MIN_PEAK_SAMPLES && max[i] >= CROWN_MIN_H && max[i] < 80) {
      values[i] = max[i];
      nz++;
    }
  }
  if (!nz) return null;
  return {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
    width,
    height,
    values,
    nonzero: nz,
  };
}

async function fetchChmGrid(frame, opts) {
  const { timeSpan } = require("./stage-clock");
  return timeSpan("canopy", () => fetchChmGridWork(frame, opts));
}

async function fetchChmGridWork(frame, opts) {
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
  if (signal.aborted) return null;
  const useCache = !(opts && opts.loader);
  if (useCache) {
    const cached = await loadCanopyRaster(frame);
    if (cached) return cached;
  }
  const keys = quadkeysForBbox(frame.west, frame.south, frame.east, frame.north, CHM_ZOOM);
  if (!keys.length || keys.length > MAX_TILES) return null;
  const geotiff = (opts && opts.loader) || require("geotiff");
  const { width, height } = gridSize(frame);
  const max = new Uint8Array(width * height);
  const count = new Uint16Array(width * height);
  // An abort used to throw away every strip already read, and the export
  // then drew NLCD cell squares. Peaks in hand are enough to trace those crowns.
  const pack = () => packPeakGrid(frame, width, height, max, count);
  const aborted = (e) =>
    signal.aborted || /abort|timeout/i.test(String(e && e.message ? e.message : e));
  async function readKey(key) {
    const tiff = await geotiff.fromUrl(chmUrl(key), { cacheSize: 16 }, signal);
    const image = await tiff.getImage();
    const surveyed = await readSurveyPeaks(tiff, image, frame, width, height, max, count, signal);
    if (!surveyed) return false;
    return readPeakStrips(image, frame, width, height, max, count, signal);
  }
  let complete = true;
  try {
    let cursor = 0;
    const n = Math.max(1, Math.min(STRIP_CONCURRENCY, keys.length));
    async function worker() {
      while (cursor < keys.length) {
        if (signal.aborted) {
          complete = false;
          return;
        }
        const key = keys[cursor++];
        let finished = false;
        try {
          finished = await readKey(key);
        } catch (e) {
          if (aborted(e)) {
            complete = false;
            return;
          }
          try {
            finished = await readKey(key);
          } catch (e2) {
            if (aborted(e2)) {
              complete = false;
              return;
            }
            throw e2;
          }
        }
        if (!finished) {
          complete = false;
          return;
        }
      }
    }
    await Promise.all(Array.from({ length: n }, () => worker()));
  } catch (e) {
    if (aborted(e)) return pack();
    throw e;
  }
  const grid = pack();
  if (useCache && complete && !(signal && signal.aborted) && grid) {
    await saveCanopyRaster(frame, grid).catch((err) => {
      if (err && err.code === "raw-only") return;
    });
  }
  return grid;
}

function gridValues(grid) {
  if (!grid || !(grid.width > 1) || !(grid.height > 1)) return null;
  const values = typeof grid.values === "string" ? Buffer.from(grid.values, "base64") : grid.values;
  if (!values || values.length < grid.width * grid.height) return null;
  return values;
}

function gridMeters(grid) {
  const lat = (+grid.south + +grid.north) / 2;
  const mPerX =
    (Math.abs(+grid.east - +grid.west) * 111320 * Math.cos((lat * Math.PI) / 180)) / grid.width;
  const mPerY = (Math.abs(+grid.north - +grid.south) * 110540) / grid.height;
  return { mPerX, mPerY };
}

function polyArea(ring) {
  let a = 0;
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function dropCollinearPx(ring) {
  const open =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  const out = [];
  for (let i = 0; i < open.length; i++) {
    const prev = open[(i + open.length - 1) % open.length];
    const cur = open[i];
    const next = open[(i + 1) % open.length];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) > 1e-9) out.push(cur);
  }
  return out.length >= 3 ? out : open;
}

function douglas(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const pair = stack.pop();
    const a = pair[0];
    const b = pair[1];
    const ax = pts[a][0];
    const ay = pts[a][1];
    const bx = pts[b][0];
    const by = pts[b][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (len2 < 1e-12) {
        const ex = pts[i][0] - ax;
        const ey = pts[i][1] - ay;
        d = ex * ex + ey * ey;
      } else {
        const t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2;
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        const ex = pts[i][0] - qx;
        const ey = pts[i][1] - qy;
        d = ex * ex + ey * ey;
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx > a && maxD > eps2) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function isAxisRect(open) {
  if (!open || open.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = open[i];
    const b = open[(i + 1) % 4];
    const dx = Math.abs(a[0] - b[0]);
    const dy = Math.abs(a[1] - b[1]);
    if (dx > 1e-6 && dy > 1e-6) return false;
  }
  return true;
}

function dpClosed(open, eps) {
  if (open.length < 4) return open.slice();
  let start = 0;
  for (let i = 1; i < open.length; i++) {
    if (open[i][0] < open[start][0] || (open[i][0] === open[start][0] && open[i][1] < open[start][1])) start = i;
  }
  const rot = open.slice(start).concat(open.slice(0, start));
  const simple = douglas(rot.concat([rot[0]]), eps);
  const out = simple.length > 1 ? simple.slice(0, -1) : simple;
  return out.length >= 3 ? out : open.slice();
}

/**
 * Drop pixel stair-steps. Stop before an irregular canopy becomes a rectangle,
 * and before the vertex cap turns a traced edge into a box.
 */
function simplifyContour(open, maxVerts) {
  if (!open || open.length < 3) return open ? open.slice() : [];
  const irregular = !isAxisRect(open);
  let cur = open.slice();
  let eps = 0.62;
  while (eps < 8) {
    const next = dpClosed(cur, eps);
    if (next.length < 3) break;
    if (irregular && isAxisRect(next)) break;
    if (next.length >= cur.length) {
      if (cur.length <= maxVerts) break;
      eps *= 1.5;
      continue;
    }
    cur = next;
    if (cur.length <= maxVerts) break;
    eps *= 1.4;
  }
  if (cur.length > maxVerts) {
    const step = Math.ceil(cur.length / maxVerts);
    const thin = [];
    for (let i = 0; i < cur.length && thin.length < maxVerts; i += step) thin.push(cur[i]);
    if (thin.length >= 3 && !(irregular && isAxisRect(thin))) cur = thin;
  }
  return cur.length >= 3 ? cur : open.slice();
}

/**
 * Outer edge ring of a 4-connected set of CHM pixels. Shared interior edges
 * cancel, so the ring is the crown footprint, not a circle around the peak.
 */
function tracePixels(pixels) {
  const set = new Set();
  for (let i = 0; i < pixels.length; i++) set.add(pixels[i][0] + "," + pixels[i][1]);
  const has = (x, y) => set.has(x + "," + y);
  const edges = [];
  const addEdge = (x0, y0, x1, y1) => {
    const id = x0 + "," + y0 + "," + x1 + "," + y1;
    const rev = x1 + "," + y1 + "," + x0 + "," + y0;
    const idx = edges.findIndex((e) => e.id === rev);
    if (idx >= 0) edges.splice(idx, 1);
    else edges.push({ id, x0, y0, x1, y1 });
  };
  for (let i = 0; i < pixels.length; i++) {
    const x = pixels[i][0];
    const y = pixels[i][1];
    if (!has(x, y - 1)) addEdge(x, y, x + 1, y);
    if (!has(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
    if (!has(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
    if (!has(x - 1, y)) addEdge(x, y + 1, x, y);
  }
  if (edges.length < 4) return null;
  const from = new Map();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const k = e.x0 + "," + e.y0;
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(e);
  }
  const used = new Set();
  const rings = [];
  for (let i = 0; i < edges.length; i++) {
    const e0 = edges[i];
    if (used.has(e0.id)) continue;
    const ring = [[e0.x0, e0.y0]];
    let cur = e0;
    used.add(cur.id);
    for (let guard = 0; guard < edges.length + 2; guard++) {
      if (cur.x1 === ring[0][0] && cur.y1 === ring[0][1]) break;
      const opts = from.get(cur.x1 + "," + cur.y1) || [];
      let next = null;
      for (let k = 0; k < opts.length; k++) {
        if (!used.has(opts[k].id)) {
          next = opts[k];
          break;
        }
      }
      if (!next) break;
      used.add(next.id);
      ring.push([next.x0, next.y0]);
      cur = next;
    }
    if (cur.x1 === ring[0][0] && cur.y1 === ring[0][1] && ring.length >= 4) {
      ring.push([ring[0][0], ring[0][1]]);
      rings.push(ring);
    }
  }
  if (!rings.length) return null;
  rings.sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
  return rings[0];
}

function flood(w, h, seedX, seedY, accept) {
  if (!accept(seedX, seedY)) return null;
  const pixels = [];
  const stack = [[seedX, seedY]];
  const seen = new Uint8Array(w * h);
  seen[seedY * w + seedX] = 1;
  while (stack.length) {
    const cur = stack.pop();
    const x = cur[0];
    const y = cur[1];
    pixels.push(cur);
    const nbrs = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (let i = 0; i < nbrs.length; i++) {
      const nx = nbrs[i][0];
      const ny = nbrs[i][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const idx = ny * w + nx;
      if (seen[idx] || !accept(nx, ny)) continue;
      seen[idx] = 1;
      stack.push([nx, ny]);
    }
  }
  return pixels;
}

function pointInOpen(open, x, y) {
  let inside = false;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    const yi = open[i][1];
    const yj = open[j][1];
    if ((yi > y) === (yj > y)) continue;
    const xi = open[i][0];
    const xj = open[j][0];
    if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fraction of canopy cells whose centers sit inside the simplified outline. */
function cellCoverage(open, pixels) {
  if (!open || open.length < 3 || !pixels.length) return 0;
  let hit = 0;
  let seen = 0;
  const step = pixels.length > 2500 ? 3 : pixels.length > 800 ? 2 : 1;
  for (let i = 0; i < pixels.length; i += step) {
    seen++;
    if (pointInOpen(open, pixels[i][0] + 0.5, pixels[i][1] + 0.5)) hit++;
  }
  return seen ? hit / seen : 0;
}

/** A woods this large is split when its canopy heights actually differ. */
const SUBSTAND_AREA_M2 = 2500;
/** Above this, one height is cut into local blocks so the top is not a slab. */
const TILE_AREA_M2 = 12000;
const TILE_M = 42;

function heightBin(v) {
  if (v < 8) return 0;
  if (v < 12) return 1;
  if (v < 16) return 2;
  if (v < 20) return 3;
  if (v < 26) return 4;
  if (v < 32) return 5;
  return 6;
}

function medianOf(list) {
  if (!list.length) return 0;
  const hs = list.slice().sort((a, b) => a - b);
  return hs[hs.length >> 1];
}

/**
 * Block size for one stand. A kilometre of woods cut every 42 m is more
 * outlines than the export keeps, and the outlines that do not fit are holes
 * in the forest. Coarser blocks still carry a local height, and every block
 * is emitted. A stand just over the tile floor stays near 42 m.
 */
function tileMeters(areaM2) {
  const side = Math.sqrt(Math.max(areaM2, 1) / 80);
  return Math.max(TILE_M, Math.min(180, side));
}

/**
 * Cut a large stand into blocks. Each block keeps the canopy height measured
 * inside it, so a hillside is not one flat top. Scraps smaller than a few
 * cells join the nearest block.
 */
function tilePixels(pixels, mPerX, mPerY, tileM) {
  const span = tileM > 0 ? tileM : TILE_M;
  const tileX = Math.max(8, Math.round(span / mPerX));
  const tileY = Math.max(8, Math.round(span / mPerY));
  const buckets = new Map();
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const key = (Math.floor(p[0] / tileX) << 16) ^ (Math.floor(p[1] / tileY) & 0xffff);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(p);
  }
  const cellM = mPerX * mPerY;
  const minCells = Math.max(6, Math.round(80 / Math.max(cellM, 0.25)));
  const groups = [];
  const small = [];
  for (const list of buckets.values()) {
    if (list.length >= minCells) groups.push(list);
    else small.push(list);
  }
  if (groups.length < 2) return null;
  for (let s = 0; s < small.length; s++) {
    const list = small[s];
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < list.length; i++) {
      sx += list[i][0];
      sy += list[i][1];
    }
    sx /= list.length;
    sy /= list.length;
    let best = 0;
    let bestD = Infinity;
    for (let g = 0; g < groups.length; g++) {
      const q = groups[g];
      const mid = q[q.length >> 1];
      const d = (mid[0] - sx) * (mid[0] - sx) + (mid[1] - sy) * (mid[1] - sy);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    for (let i = 0; i < list.length; i++) groups[best].push(list[i]);
  }
  return groups;
}


/** Lidar tree segmentation. Components under this area are cut into trees. */
const SEG_MAX_M2 = 100000;
const ESTIMATED_SEG_MAX_M2 = 2000;
const SEG_MIN_M2 = 40;
const SEG_TOP_MIN_H = 5;
/** A segmented tree smaller than this joins its neighbour (the sliver floor). */
const SEG_PIECE_MIN_M2 = 30;

/**
 * Individual trees in one canopy component, from the height model only.
 * Treetops are local maxima at least 5 m tall. Two tops closer than about a
 * quarter of the taller one's height, or joined by a saddle that dips less
 * than 1.5 m (or 15% of the lower top), are one tree. Every cell then flows
 * to a top by a marker watershed, highest cells first, so each tree keeps
 * the cells that slope down from its own top. Null when the component is
 * one tree. Nothing is added: the trees partition the measured cells.
 */
function segmentTrees(pixels, at, w, mPerX, mPerY, minM2) {
  const area = pixels.length * mPerX * mPerY;
  // An estimated split (minM2 set) is for a blob a few crowns across, not a
  // forest: a woods stays one stand there.
  const maxM2 = minM2 > 0 ? ESTIMATED_SEG_MAX_M2 : SEG_MAX_M2;
  if (area < Math.max(SEG_MIN_M2, minM2 || 0) || area > maxM2) return null;
  const cell = Math.sqrt(mPerX * mPerY);
  const inSet = new Map();
  for (let i = 0; i < pixels.length; i++) inSet.set(pixels[i][1] * w + pixels[i][0], i);
  const tops = [];
  for (let i = 0; i < pixels.length; i++) {
    const [x, y] = pixels[i];
    const v = at(x, y);
    if (v < SEG_TOP_MIN_H) continue;
    let top = true;
    for (let dy = -1; dy <= 1 && top; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const u = at(x + dx, y + dy);
        if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) {
          top = false;
          break;
        }
      }
    }
    if (top) tops.push({ x, y, v });
  }
  if (tops.length < 2) return null;
  tops.sort((a, b) => b.v - a.v);
  const kept = [];
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i];
    let merge = false;
    for (let k = 0; k < kept.length && !merge; k++) {
      const q = kept[k];
      const d = Math.hypot(q.x - t.x, q.y - t.y) * cell;
      const minD = Math.max(3, Math.min(8, 0.25 * q.v));
      if (d < minD) {
        merge = true;
        break;
      }
      if (d > 30) continue;
      // Lowest point on the straight line between the two tops.
      const n = Math.max(2, Math.ceil(d / cell));
      let low = Infinity;
      for (let s2 = 1; s2 < n; s2++) {
        const x = Math.round(t.x + ((q.x - t.x) * s2) / n);
        const y = Math.round(t.y + ((q.y - t.y) * s2) / n);
        const u = inSet.has(y * w + x) ? at(x, y) : 0;
        if (u < low) low = u;
      }
      if (t.v - low < Math.max(1.5, 0.15 * t.v)) merge = true;
    }
    if (!merge) kept.push(t);
  }
  if (kept.length < 2) return null;
  // Marker watershed: grow every tree from its top, highest cells first.
  const label = new Int32Array(pixels.length).fill(-1);
  const heap = [];
  const push = (idx, pri) => {
    heap.push([pri, idx]);
    let c = heap.length - 1;
    while (c > 0) {
      const p2 = (c - 1) >> 1;
      if (heap[p2][0] >= heap[c][0]) break;
      [heap[p2], heap[c]] = [heap[c], heap[p2]];
      c = p2;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  for (let k = 0; k < kept.length; k++) {
    const i = inSet.get(kept[k].y * w + kept[k].x);
    label[i] = k;
    push(i, kept[k].v);
  }
  while (heap.length) {
    const [, i] = pop();
    const [x, y] = pixels[i];
    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (let j = 0; j < 4; j++) {
      const id = inSet.get(nb[j][1] * w + nb[j][0]);
      if (id == null || label[id] >= 0) continue;
      label[id] = label[i];
      push(id, at(nb[j][0], nb[j][1]));
    }
  }
  // A tree too small to survive as its own crown joins the neighbour it
  // shares the longest edge with, so no measured canopy is lost.
  const minCells = Math.ceil(SEG_PIECE_MIN_M2 / (mPerX * mPerY));
  for (let pass = 0; pass < 3; pass++) {
    const size = new Array(kept.length).fill(0);
    for (let i = 0; i < pixels.length; i++) if (label[i] >= 0) size[label[i]]++;
    const order = size.map((n, k) => k).filter((k) => size[k] > 0 && size[k] < minCells);
    if (!order.length) break;
    order.sort((a, b) => size[a] - size[b]);
    for (const k of order) {
      const edge = new Map();
      for (let i = 0; i < pixels.length; i++) {
        if (label[i] !== k) continue;
        const [x, y] = pixels[i];
        const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (let j = 0; j < 4; j++) {
          const id = inSet.get(nb[j][1] * w + nb[j][0]);
          if (id == null || label[id] < 0 || label[id] === k) continue;
          edge.set(label[id], (edge.get(label[id]) || 0) + 1);
        }
      }
      let best = -1;
      let bestN = 0;
      for (const [l, n] of edge) if (n > bestN) [best, bestN] = [l, n];
      if (best < 0) continue;
      for (let i = 0; i < pixels.length; i++) if (label[i] === k) label[i] = best;
    }
  }
  const groups = kept.map(() => []);
  for (let i = 0; i < pixels.length; i++) if (label[i] >= 0) groups[label[i]].push(pixels[i]);
  const out = groups.filter((g) => g.length >= 1);
  return out.length >= 2 ? out : null;
}

function crownFromPixels(pixels, values, w, grid, mPerX, mPerY, hintH, medianTop) {
  const area = pixels.length * mPerX * mPerY;
  let maxH = 0;
  let px = pixels[0][0];
  let py = pixels[0][1];
  const hs = [];
  for (let i = 0; i < pixels.length; i++) {
    const v = values[pixels[i][1] * w + pixels[i][0]] || 0;
    if (v >= CROWN_MIN_H) hs.push(v);
    if (v > maxH) {
      maxH = v;
      px = pixels[i][0];
      py = pixels[i][1];
    }
  }
  let top = maxH;
  // A small crown's top is its tallest cell. A large stand uses the middle
  // of its own band, so one spike does not raise the whole woods.
  if (medianTop && hs.length >= 12) {
    hs.sort((a, b) => a - b);
    top = hs[hs.length >> 1];
  } else if (hs.length >= 12) {
    // A few cells far above the rest of a crown are a mast, a sign, or a
    // facade return. They do not lift the whole crown: it keeps its 90th
    // percentile.
    const sorted = hs.slice().sort((a, b) => a - b);
    const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)];
    if (maxH > p90 + Math.max(6, p90 * 0.4)) top = p90;
  }
  const heightM = Math.round(Math.max(top, hintH || 0) * 10) / 10;
  if (!(heightM >= CROWN_MIN_H) || heightM >= 80) return null;
  // A lone short pixel is CHM noise. A real small tree is taller, or wider.
  // The export grid is about 2 m, so a street tree is often one or two cells
  // and used to miss the 12 m² floor.
  if (pixels.length < 2 && heightM < 5) return null;
  if (pixels.length >= 2 && heightM < 5 && pixels.length < 3 && area < CROWN_MIN_AREA_M2) return null;
  const prof = profile.profileOn();
  if (prof) profile.add("crown-pixels", pixels.length);
  let tProf = prof ? profile.now() : 0;
  let ring = tracePixels(pixels);
  if (prof) profile.add("trace", profile.msSince(tProf));
  if (!ring) return null;
  // A large stand needs a longer edge. 32 vertices chord across a woods.
  // Shoelace area can look full while the chord sits outside the cells and
  // the bays are uncovered, so the test is the cells themselves.
  if (prof) tProf = profile.now();
  const traced = dropCollinearPx(ring);
  let maxVerts = CROWN_MAX_VERTS;
  let open = simplifyContour(traced, maxVerts);
  if (prof) profile.add("simplify", profile.msSince(tProf));
  if (pixels.length > 24) {
    let guard = 0;
    while (guard++ < 5 && maxVerts < 160) {
      if (prof) tProf = profile.now();
      const cover = cellCoverage(open, pixels);
      if (prof) profile.add("coverage", profile.msSince(tProf));
      const spill = Math.abs(polyArea(open)) / pixels.length;
      if (cover >= 0.92 && spill <= 1.035) break;
      const nextVerts = Math.min(160, Math.max(maxVerts + 8, Math.round(maxVerts * 1.5)));
      if (nextVerts <= maxVerts) break;
      if (prof) tProf = profile.now();
      const next = simplifyContour(traced, nextVerts);
      if (prof) profile.add("simplify", profile.msSince(tProf));
      if (!next || next.length < 3) break;
      if (prof) tProf = profile.now();
      const nextCover = cellCoverage(next, pixels);
      if (prof) profile.add("coverage", profile.msSince(tProf));
      const nextSpill = Math.abs(polyArea(next)) / pixels.length;
      if (nextCover + 0.004 < cover && nextSpill >= spill) break;
      maxVerts = nextVerts;
      open = next;
    }
  }
  if (open.length < 3) return null;
  const dLon = +grid.east - +grid.west;
  const dLat = +grid.north - +grid.south;
  const ringLonLat = open.map(([ix, iy]) => [
    +grid.west + (ix / grid.width) * dLon,
    +grid.north - (iy / grid.height) * dLat,
  ]);
  ringLonLat.push(ringLonLat[0]);
  return {
    ringLonLat,
    heightM,
    peakLon: +grid.west + ((px + 0.5) / grid.width) * dLon,
    peakLat: +grid.north - ((py + 0.5) / grid.height) * dLat,
    areaM2: Math.round(area),
  };
}

/**
 * Connected canopy from a Meta CHM window.
 * Each component above the height floor is one simplified polygon. The ring
 * is the traced CHM edge, not a grid square and not a peak sliced out of a
 * tree line. Height is the measured top inside that outline.
 * @returns {{ringLonLat:number[][], heightM:number, peakLon:number, peakLat:number, areaM2:number}[]}
 */
function componentTouchesClip(pixels, clipY0, clipY1, gridH) {
  const northCut = clipY0 > 0;
  const southCut = clipY1 < gridH;
  if (!northCut && !southCut) return false;
  for (let i = 0; i < pixels.length; i++) {
    const y = pixels[i][1];
    if (northCut && y === clipY0) return true;
    if (southCut && y === clipY1 - 1) return true;
  }
  return false;
}

function crownsFromChm(grid, opts) {
  const values = gridValues(grid);
  if (!values) return [];
  const w = grid.width | 0;
  const h = grid.height | 0;
  const { mPerX, mPerY } = gridMeters(grid);
  if (!(mPerX >= 0.5) || !(mPerY >= 0.5) || mPerX > 30 || mPerY > 30) return [];
  const opt = opts || {};
  const seedY0 = opt.seedY0 > 0 ? Math.min(h, opt.seedY0 | 0) : 0;
  const seedY1 = opt.seedY1 > 0 ? Math.min(h, opt.seedY1 | 0) : h;
  const halo = opt.halo > 0 ? opt.halo | 0 : 0;
  const clipY0 = halo ? Math.max(0, seedY0 - halo) : 0;
  const clipY1 = halo ? Math.min(h, seedY1 + halo) : h;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : values[y * w + x] || 0);
  const seen = new Uint8Array(w * h);
  const crowns = [];
  let segSeq = (opt.segBase | 0) * 100000;
  const prof = profile.profileOn();
  const acceptRows = (y0, y1) => (px, py) => {
    if (py < y0 || py >= y1) return false;
    const id = py * w + px;
    return !seen[id] && at(px, py) >= CROWN_MIN_H;
  };
  for (let y = seedY0; y < seedY1; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (seen[idx] || at(x, y) < CROWN_MIN_H) continue;
      let pixels = null;
      const clipped = halo > 0 && (clipY0 > 0 || clipY1 < h);
      let tProf = prof ? profile.now() : 0;
      if (clipped) {
        pixels = flood(w, h, x, y, acceptRows(clipY0, clipY1));
        if (pixels && componentTouchesClip(pixels, clipY0, clipY1, h)) pixels = null;
      }
      if (!pixels) pixels = flood(w, h, x, y, acceptRows(0, h));
      if (prof) profile.add("flood", profile.msSince(tProf));
      if (!pixels) continue;
      let top = pixels[0][1];
      for (let i = 1; i < pixels.length; i++) if (pixels[i][1] < top) top = pixels[i][1];
      for (let i = 0; i < pixels.length; i++) seen[pixels[i][1] * w + pixels[i][0]] = 1;
      if (top < seedY0 || top >= seedY1) continue;
      const area = pixels.length * mPerX * mPerY;
      const groups = [];
      if (opt.segment) {
        const trees = segmentTrees(pixels, at, w, mPerX, mPerY, opt.segMinM2);
        if (trees) {
          const whole = area < TILE_AREA_M2 ? crownFromPixels(pixels, values, w, grid, mPerX, mPerY, 0, area >= SUBSTAND_AREA_M2) : null;
          const segId = segSeq++;
          let first = true;
          for (let g = 0; g < trees.length; g++) {
            const crown = crownFromPixels(trees[g], values, w, grid, mPerX, mPerY, 0, false);
            if (!crown) continue;
            crown.segId = segId;
            crown.segTree = true;
            if (first && whole) crown.whole = whole;
            first = false;
            crowns.push(crown);
          }
          if (!first) continue;
        }
      }
      // A large stand is cut on a grid first. Splitting it by height cell
      // before that turned a forest into thousands of specks, and the export
      // cap then dropped most of them.
      if (area >= TILE_AREA_M2) {
        if (prof) tProf = profile.now();
        let blocks = null;
        blocks = tilePixels(pixels, mPerX, mPerY, tileMeters(area));
        // Feedback #9 prototype (off by default): neighbouring blocks of about
        // one height merge into one piece.
        if (blocks && exportMode.isMergeTiles()) blocks = standSplit.mergePixelGroups(blocks, at, w, CROWN_MIN_H);
        if (prof) profile.add("tile-split", profile.msSince(tProf));
        if (blocks) {
          for (let b = 0; b < blocks.length; b++) groups.push(blocks[b]);
        }
      } else if (area >= SUBSTAND_AREA_M2 && pixels.length >= 80) {
        const bins = new Map();
        for (let i = 0; i < pixels.length; i++) {
          const p = pixels[i];
          const b = heightBin(at(p[0], p[1]));
          if (!bins.has(b)) bins.set(b, []);
          bins.get(b).push(p);
        }
        let loMed = Infinity;
        let hiMed = 0;
        for (const group of bins.values()) {
          const hs = [];
          for (let i = 0; i < group.length; i++) hs.push(at(group[i][0], group[i][1]));
          const med = medianOf(hs);
          if (med < loMed) loMed = med;
          if (med > hiMed) hiMed = med;
        }
        // A comb of nearly one height stays one outline. A short stand beside
        // a tall stand does not share a top.
        if (bins.size >= 2 && hiMed - loMed >= 5) {
          for (const group of bins.values()) {
            const local = new Uint8Array(w * h);
            for (let i = 0; i < group.length; i++) local[group[i][1] * w + group[i][0]] = 1;
            const used = new Uint8Array(w * h);
            for (let i = 0; i < group.length; i++) {
              const sx = group[i][0];
              const sy = group[i][1];
              if (used[sy * w + sx]) continue;
              if (prof) tProf = profile.now();
              const part = flood(w, h, sx, sy, (px, py) => {
                const id = py * w + px;
                return local[id] && !used[id];
              });
              if (prof) profile.add("flood", profile.msSince(tProf));
              if (!part) continue;
              for (let k = 0; k < part.length; k++) used[part[k][1] * w + part[k][0]] = 1;
              groups.push(part);
            }
          }
        }
      }
      if (!groups.length) groups.push(pixels);
      const tiled = groups;
      const split = tiled.length > 1;
      const banded = exportMode.isMergeTiles() && area >= TILE_AREA_M2;
      for (let g = 0; g < tiled.length; g++) {
        const crown = crownFromPixels(tiled[g], values, w, grid, mPerX, mPerY, 0, split || area >= SUBSTAND_AREA_M2);
        if (crown && banded) crown.banded = true;
        if (crown) crowns.push(crown);
      }
    }
  }
  crowns.sort((a, b) => b.areaM2 - a.areaM2 || b.heightM - a.heightM);
  if (opt.noCap) return crowns;
  return crowns.length > CROWN_CAP ? selectCrownsForExport(crowns, CROWN_CAP) : crowns;
}

function ringOpen(ring) {
  if (!ring || ring.length < 2) return ring || [];
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  return closed ? ring.slice(0, -1) : ring;
}

/** Largest traced canopies, then the tallest small boxes, up to `max`. */
function selectBulk(crowns, max) {
  const traced = [];
  const boxes = [];
  for (let i = 0; i < crowns.length; i++) {
    const open = ringOpen(crowns[i].ringLonLat);
    if (isAxisRect(open) && crowns[i].areaM2 < 140) boxes.push(crowns[i]);
    else traced.push(crowns[i]);
  }
  traced.sort((a, b) => b.areaM2 - a.areaM2 || b.heightM - a.heightM);
  boxes.sort((a, b) => b.heightM - a.heightM || b.areaM2 - a.areaM2);
  return traced.concat(boxes).slice(0, max);
}

/**
 * Under the old 480 budget, keep the largest canopies (same set as before).
 * Above that, the extra slots are compact measured crowns — individual trees
 * and small groups — tallest first. A short speck never reaches this list.
 */
function selectCrownsForExport(crowns, max) {
  const limit = max > 0 ? max | 0 : BULK_POLYGONS;
  const list = crowns || [];
  if (list.length <= limit) return list;
  const bulk = selectBulk(list, Math.min(limit, BULK_POLYGONS));
  if (bulk.length >= limit) return bulk;
  const seen = new Set(bulk);
  const extra = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (seen.has(c)) continue;
    if (c.heightM >= COMPACT_MIN_H && c.areaM2 <= COMPACT_AREA_M2) extra.push(c);
  }
  extra.sort((a, b) => b.heightM - a.heightM || b.areaM2 - a.areaM2);
  const picked = bulk.concat(extra.slice(0, limit - bulk.length));
  if (picked.length >= limit) return picked;
  // Slots left after the compact crowns go to the next largest canopies.
  // A mid-size crown was dropped here even when the cap had room for it.
  const taken = new Set(picked);
  const rest = list.filter((c) => !taken.has(c)).sort((a, b) => b.areaM2 - a.areaM2);
  return picked.concat(rest.slice(0, limit - picked.length));
}

function copyGrid(grid, values, nonzero) {
  return {
    west: +grid.west,
    south: +grid.south,
    east: +grid.east,
    north: +grid.north,
    width: grid.width | 0,
    height: grid.height | 0,
    values,
    nonzero,
  };
}

/**
 * Copy a CHM window, drop cells the caller marks as roof or pavement, and
 * let dense NLCD percent promote only cells that already have a measured
 * height (or sit on a measured neighbor). Percent never becomes a height.
 */
function maskChmGrid(grid, opts) {
  const src = gridValues(grid);
  if (!src) return null;
  const w = grid.width | 0;
  const h = grid.height | 0;
  const values = new Uint8Array(w * h);
  const n = Math.min(values.length, src.length);
  for (let i = 0; i < n; i++) values[i] = src[i] || 0;
  const blocked = opts && opts.blocked;
  const dLon = +grid.east - +grid.west || 1e-9;
  const dLat = +grid.north - +grid.south || 1e-9;
  const lonAt = (x) => +grid.west + ((x + 0.5) / w) * dLon;
  const latAt = (y) => +grid.north - ((y + 0.5) / h) * dLat;
  if (typeof blocked === "function") {
    for (let y = 0; y < h; y++) {
      const lat = latAt(y);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (values[i] < 2) continue;
        if (blocked(lonAt(x), lat)) values[i] = 0;
      }
    }
  }
  const hits = (opts && opts.hits) || [];
  for (let nHit = 0; nHit < hits.length; nHit++) {
    const hit = hits[nHit];
    if (!hit) continue;
    const pct = hit.pct != null ? +hit.pct : (hit.score || 0) * 100;
    if (!(pct >= 50) || !Number.isFinite(+hit.lon) || !Number.isFinite(+hit.lat)) continue;
    const x = Math.round(((+hit.lon - +grid.west) / dLon) * w - 0.5);
    const y = Math.round(((+grid.north - +hit.lat) / dLat) * h - 0.5);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (typeof blocked === "function" && blocked(lonAt(x), latAt(y))) continue;
    if (values[i] >= 2 && values[i] < 3) values[i] = 3;
    if (values[i] >= 3 || pct < 60) continue;
    let best = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = values[ny * w + nx] || 0;
        if (v > best) best = v;
      }
    }
    if (best >= 4) values[i] = best;
  }
  let nz = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= 2) nz++;
  if (!nz) return copyGrid(grid, values, 0);
  return copyGrid(grid, values, nz);
}

/** Max-pool so a large draw becomes fewer, still measured, canopy cells. */
function poolChmGrid(grid, stride) {
  const src = gridValues(grid);
  if (!src) return null;
  const step = Math.max(2, stride | 0);
  const w = grid.width | 0;
  const h = grid.height | 0;
  const w2 = Math.max(2, Math.ceil(w / step));
  const h2 = Math.max(2, Math.ceil(h / step));
  const values = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let m = 0;
      for (let dy = 0; dy < step; dy++) {
        const sy = y * step + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < step; dx++) {
          const sx = x * step + dx;
          if (sx >= w) break;
          const v = src[sy * w + sx] || 0;
          if (v > m) m = v;
        }
      }
      values[y * w2 + x] = m;
    }
  }
  let nz = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= 2) nz++;
  return {
    west: +grid.west,
    south: +grid.south,
    east: +grid.east,
    north: +grid.north,
    width: w2,
    height: h2,
    values,
    nonzero: nz,
  };
}

/**
 * Canopy outlines for an export. Roof and pavement cells are cleared first.
 * The first 480 slots stay the largest canopies. A higher budget fills the
 * rest with compact measured crowns instead of dropping every small tree.
 * The grid is not max-pooled after this: that merge turned canopy edges into
 * squares and erased crowns that did not survive the coarser cell. The fetch
 * already kept each cell's peak.
 */

/**
 * Per-tree crowns cost more outlines than the canopy they cut. When the
 * export would have to drop crowns, a segmented canopy goes back to its
 * whole outline, the most-cut first, so the canopy stays and only the
 * per-tree detail is lost.
 */
function fitSegments(crowns, max) {
  if (!(max > 0) || crowns.length <= max) return crowns;
  const bySeg = new Map();
  for (let i = 0; i < crowns.length; i++) {
    const c = crowns[i];
    if (c.segId == null) continue;
    if (!bySeg.has(c.segId)) bySeg.set(c.segId, []);
    bySeg.get(c.segId).push(c);
  }
  const groups = [...bySeg.values()].filter((g) => g.some((c) => c.whole)).sort((a, b) => b.length - a.length);
  const drop = new Set();
  const add = [];
  let n = crowns.length;
  for (let i = 0; i < groups.length && n > max; i++) {
    const g = groups[i];
    const whole = g.find((c) => c.whole).whole;
    for (const c of g) drop.add(c);
    add.push(whole);
    n -= g.length - 1;
  }
  const out = crowns.filter((c) => !drop.has(c)).concat(add);
  out.sort((a, b) => b.areaM2 - a.areaM2 || b.heightM - a.heightM);
  return out;
}

function crownsForExport(grid, opts) {
  const prepared = maskChmGrid(grid, opts);
  if (!prepared || !(prepared.nonzero > 0)) return { crowns: [], coarsened: false, stride: 1 };
  const max = opts && opts.maxPolygons > 0 ? opts.maxPolygons | 0 : BULK_POLYGONS;
  let crowns = fitSegments(crownsFromChm(prepared, { segment: !!(opts && opts.segment), segMinM2: (opts && opts.segMinM2) || 0 }), max);
  const before = crowns.length;
  let trimmed = false;
  if (crowns.length > max) {
    trimmed = true;
    crowns = selectCrownsForExport(crowns, max);
  }
  return {
    crowns,
    coarsened: trimmed,
    stride: 1,
    dropped: before > crowns.length ? before - crowns.length : 0,
  };
}

module.exports = {
  CHM_ZOOM,
  dpClosed,
  MAX_DIM,
  chmUrl,
  mercator,
  lonLatFromMercator,
  sampleChmGrid,
  applyChmToTrees,
  gridToJson,
  fetchChmGrid,
  STRIP_CONCURRENCY,
  prefetchCanopyWindows,
  encodeCanopyRaster,
  decodeCanopyRaster,
  loadCanopyRaster,
  saveCanopyRaster,
  canopyRasterSpec,
  gridSize,
  CROWN_CAP,
  crownsFromChm,
  maskChmGrid,
  poolChmGrid,
  peakPool,
  selectCrownsForExport,
  crownsForExport,
  tracePixels,
  segmentTrees,
  fitSegments,
};
