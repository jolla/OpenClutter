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
const CROWN_CAP = 800;
const BULK_POLYGONS = 480;
/** A fairway tree, not a woods mass. Extra slots stay available for these. */
const COMPACT_AREA_M2 = 180;
const COMPACT_MIN_H = 5;
/** Native samples at or above the canopy floor required before a cell is real. */
const MIN_PEAK_SAMPLES = 2;
/** Rows per canopy read. Short enough that an abort can stop the next strip. */
const CHM_STRIP_ROWS = 256;
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
async function readPeakStrips(image, frame, dstW, dstH, max, count, signal) {
  const win = tileWindow(image, frame);
  if (!win) return false;
  const width = win.right - win.left;
  for (let row = win.top; row < win.bottom; row += CHM_STRIP_ROWS) {
    if (signal && signal.aborted) return false;
    const row1 = Math.min(win.bottom, row + CHM_STRIP_ROWS);
    const ras = await image.readRasters({
      window: [win.left, row, win.right, row1],
      interleave: true,
      signal,
    });
    const data = valuesOf(ras);
    accumulatePeaks(
      max,
      count,
      {
        data,
        width,
        height: row1 - row,
        left: win.left,
        top: row,
        origin: win.origin,
        res: win.res,
      },
      frame,
      dstW,
      dstH
    );
    await new Promise((resolve) => setImmediate(resolve));
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
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
  if (signal.aborted) return null;
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
  try {
    for (const key of keys) {
      if (signal.aborted) return pack();
      let finished = false;
      try {
        finished = await readKey(key);
      } catch (e) {
        if (aborted(e)) return pack();
        try {
          finished = await readKey(key);
        } catch (e2) {
          if (aborted(e2)) return pack();
          throw e2;
        }
      }
      if (!finished) return pack();
    }
  } catch (e) {
    if (aborted(e)) return pack();
    throw e;
  }
  return pack();
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

function crownFromPixels(pixels, values, w, grid, mPerX, mPerY, hintH) {
  const area = pixels.length * mPerX * mPerY;
  let maxH = 0;
  let px = pixels[0][0];
  let py = pixels[0][1];
  for (let i = 0; i < pixels.length; i++) {
    const v = values[pixels[i][1] * w + pixels[i][0]] || 0;
    if (v > maxH) {
      maxH = v;
      px = pixels[i][0];
      py = pixels[i][1];
    }
  }
  const heightM = Math.round(Math.max(maxH, hintH || 0) * 10) / 10;
  if (!(heightM >= CROWN_MIN_H) || heightM >= 80) return null;
  // A lone short pixel is CHM noise. A real small tree is taller, or wider.
  // The export grid is about 2 m, so a street tree is often one or two cells
  // and used to miss the 12 m² floor.
  if (pixels.length < 2 && heightM < 5) return null;
  if (pixels.length >= 2 && heightM < 5 && pixels.length < 3 && area < CROWN_MIN_AREA_M2) return null;
  let ring = tracePixels(pixels);
  if (!ring) return null;
  let open = simplifyContour(dropCollinearPx(ring), CROWN_MAX_VERTS);
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
function crownsFromChm(grid) {
  const values = gridValues(grid);
  if (!values) return [];
  const w = grid.width | 0;
  const h = grid.height | 0;
  const { mPerX, mPerY } = gridMeters(grid);
  if (!(mPerX >= 0.5) || !(mPerY >= 0.5) || mPerX > 30 || mPerY > 30) return [];
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : values[y * w + x] || 0);
  const seen = new Uint8Array(w * h);
  const crowns = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (seen[idx] || at(x, y) < CROWN_MIN_H) continue;
      const pixels = flood(w, h, x, y, (px, py) => {
        const id = py * w + px;
        return !seen[id] && at(px, py) >= CROWN_MIN_H;
      });
      if (!pixels) continue;
      for (let i = 0; i < pixels.length; i++) seen[pixels[i][1] * w + pixels[i][0]] = 1;
      const crown = crownFromPixels(pixels, values, w, grid, mPerX, mPerY, 0);
      if (crown) crowns.push(crown);
    }
  }
  crowns.sort((a, b) => b.areaM2 - a.areaM2 || b.heightM - a.heightM);
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
  return bulk.concat(extra.slice(0, limit - bulk.length));
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
function crownsForExport(grid, opts) {
  const prepared = maskChmGrid(grid, opts);
  if (!prepared || !(prepared.nonzero > 0)) return { crowns: [], coarsened: false, stride: 1 };
  const max = opts && opts.maxPolygons > 0 ? opts.maxPolygons | 0 : BULK_POLYGONS;
  let crowns = crownsFromChm(prepared);
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
  MAX_DIM,
  chmUrl,
  mercator,
  lonLatFromMercator,
  sampleChmGrid,
  applyChmToTrees,
  gridToJson,
  fetchChmGrid,
  gridSize,
  crownsFromChm,
  maskChmGrid,
  poolChmGrid,
  peakPool,
  selectCrownsForExport,
  crownsForExport,
};
