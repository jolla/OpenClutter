"use strict";

/**
 * Copernicus DEM GLO-30 public COG (AWS Open Data). Geographic degree tiles,
 * not Web Mercator. Each name is the southwest corner of a 1°×1° tile.
 * Pixel size is about 30 m: longitude spacing changes with latitude, so the
 * reader uses the GeoTIFF origin and resolution instead of a fixed 3600 grid.
 *
 * This is a surface DSM (EGM2008), not bare earth. Callers tag kind "surface".
 * That tag skips the bare-earth 20 m ski-hill gate. Attenuating objects still
 * sit on the sampled elevation.
 *
 * Example (Trafalgar Square, confirmed HTTP 200):
 * https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N51_00_W001_00_DEM/Copernicus_DSM_COG_10_N51_00_W001_00_DEM.tif
 */

const GLO30_BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com";
/** Required credit when a derived mesh from GLO-30 is distributed. */
const GLO30_CREDIT =
  "© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved";
const MAX_TILES = 4;
/**
 * Used only when the caller did not pass a signal. A 2s default aborted the
 * COG before the first range read finished. This stays under the terrain
 * hard cap so a direct read can still return a grid.
 */
const GLO30_FETCH_MS = 8000;

/** Pause before the one retry of a failed tile read. */
const GLO30_RETRY_MS = 400;

function pauseUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

function glo30TileId(latSw, lonSw) {
  const lat = latSw | 0;
  const lon = lonSw | 0;
  const latHem = lat >= 0 ? "N" : "S";
  const lonHem = lon >= 0 ? "E" : "W";
  const latStr = String(Math.abs(lat)).padStart(2, "0");
  const lonStr = String(Math.abs(lon)).padStart(3, "0");
  return `Copernicus_DSM_COG_10_${latHem}${latStr}_00_${lonHem}${lonStr}_00_DEM`;
}

function glo30TileUrl(latSw, lonSw) {
  const id = glo30TileId(latSw, lonSw);
  return GLO30_BUCKET + "/" + id + "/" + id + ".tif";
}

/** Southwest-corner tile that contains this lon/lat. */
function glo30TileUrlForPoint(lat, lon) {
  return glo30TileUrl(Math.floor(+lat), Math.floor(+lon));
}

function glo30TilesForFrame(frame) {
  const south = Math.floor(+frame.south);
  const north = Math.floor(Math.max(+frame.south, +frame.north - 1e-12));
  const west = Math.floor(+frame.west);
  const east = Math.floor(Math.max(+frame.west, +frame.east - 1e-12));
  const urls = [];
  for (let lat = south; lat <= north; lat++) {
    for (let lon = west; lon <= east; lon++) urls.push(glo30TileUrl(lat, lon));
  }
  return urls;
}

function rasterValues(ras) {
  if (!ras) return null;
  if (ArrayBuffer.isView(ras)) return ras;
  if (ras.data && ArrayBuffer.isView(ras.data)) return ras.data;
  if (Array.isArray(ras) && ArrayBuffer.isView(ras[0]) && ras.length === 1) return ras[0];
  return null;
}

function sampleBilinear(values, width, height, x, y) {
  if (!values || !(width > 0) || !(height > 0)) return NaN;
  const xc = Math.min(width - 1, Math.max(0, x));
  const yc = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = xc - x0;
  const ty = yc - y0;
  const v00 = +values[y0 * width + x0];
  const v10 = +values[y0 * width + x1];
  const v01 = +values[y1 * width + x0];
  const v11 = +values[y1 * width + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

function usableElevation(z, nodata) {
  const v = +z;
  if (!Number.isFinite(v)) return false;
  if (nodata != null && Number.isFinite(+nodata) && Math.abs(v - +nodata) < 1e-3) return false;
  if (v <= -32767) return false;
  if (v < -500 || v > 9000) return false;
  return true;
}

/**
 * GLO-30 overviews carry no geo tags of their own. geotiff.js throws "does
 * not have an affine transformation" on them, which used to drop terrain on
 * any draw big enough to step past full resolution. An overview shares the
 * full image origin, and its pixel size scales by the width ratio.
 */
function imageGeo(image, ref) {
  try {
    return { origin: image.getOrigin(), res: image.getResolution() };
  } catch (e) {
    if (!ref || ref === image) throw e;
    return { origin: ref.getOrigin(), res: image.getResolution(ref) };
  }
}

function rasterWindow(image, frame, ref) {
  const { origin, res } = imageGeo(image, ref);
  const iw = image.getWidth();
  const ih = image.getHeight();
  if (!origin || !res || !(res[0] > 0) || !(res[1] < 0) || !(iw > 1) || !(ih > 1)) return null;
  const px = (lon) => (lon - origin[0]) / res[0];
  const py = (lat) => (lat - origin[1]) / res[1];
  let left = Math.floor(Math.min(px(frame.west), px(frame.east))) - 1;
  let right = Math.ceil(Math.max(px(frame.west), px(frame.east))) + 1;
  let top = Math.floor(Math.min(py(frame.south), py(frame.north))) - 1;
  let bottom = Math.ceil(Math.max(py(frame.south), py(frame.north))) + 1;
  if (right <= 0 || bottom <= 0 || left >= iw || top >= ih) return null;
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(iw, right);
  bottom = Math.min(ih, bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    left,
    top,
    right,
    bottom,
    origin,
    res,
    longSide: Math.max(right - left, bottom - top),
  };
}

/**
 * Full resolution when that window fits maxSide. A larger draw steps to a
 * coarser overview so the range read can finish. Small sites never list
 * overviews — that IFD walk is extra requests.
 */
async function chooseGlo30Image(tiff, frame, maxSide) {
  const cap = maxSide > 0 ? maxSide : 128;
  const full = await tiff.getImage(0);
  const fullWin = rasterWindow(full, frame);
  if (!fullWin) return null;
  if (fullWin.longSide <= cap || typeof tiff.getImageCount !== "function") {
    return { image: full, win: fullWin };
  }
  let count = 1;
  try {
    const n = await tiff.getImageCount();
    if (n > 1 && n < 16) count = n;
  } catch {
    return { image: full, win: fullWin };
  }
  let coarsest = { image: full, win: fullWin };
  for (let i = 1; i < count; i++) {
    let image;
    try {
      image = await tiff.getImage(i);
    } catch {
      break;
    }
    let win;
    try {
      win = rasterWindow(image, frame, full);
    } catch {
      break;
    }
    if (!win) continue;
    coarsest = { image, win };
    if (win.longSide <= cap) return coarsest;
  }
  return coarsest;
}

async function readGlo30Window(geotiff, url, frame, signal, maxRasterSide) {
  const tiff = await geotiff.fromUrl(url, { cacheSize: 16 }, signal);
  const chosen = await chooseGlo30Image(tiff, frame, maxRasterSide);
  if (!chosen) return null;
  const { image, win } = chosen;
  const ras = await image.readRasters({
    window: [win.left, win.top, win.right, win.bottom],
    interleave: true,
    signal,
  });
  const data = rasterValues(ras);
  const width = ras && ras.width ? ras.width : win.right - win.left;
  const height = ras && ras.height ? ras.height : win.bottom - win.top;
  if (!data || data.length < width * height || width < 1 || height < 1) return null;
  const nodata = typeof image.getGDALNoData === "function" ? image.getGDALNoData() : null;
  return {
    data,
    width,
    height,
    left: win.left,
    top: win.top,
    origin: win.origin,
    res: win.res,
    nodata: Number.isFinite(+nodata) ? +nodata : null,
  };
}

function sampleTile(tile, lon, lat) {
  const px = (lon - tile.origin[0]) / tile.res[0];
  const py = (lat - tile.origin[1]) / tile.res[1];
  const x = px - tile.left;
  const y = py - tile.top;
  if (x < -0.51 || y < -0.51 || x > tile.width - 0.49 || y > tile.height - 0.49) return null;
  const z = sampleBilinear(tile.data, tile.width, tile.height, x, y);
  if (!usableElevation(z, tile.nodata)) return null;
  return z;
}

function sampleLatticeSide(sampleCount) {
  const n = Math.round(Math.sqrt(Math.max(4, sampleCount | 0)));
  return Math.max(2, Math.min(25, n));
}

/**
 * @param {object} frame west/south/east/north in degrees
 * @param {{sampleCount?: number, signal?: AbortSignal, geotiff?: object}} [opts]
 * @returns {Promise<{lon:number,lat:number,z:number}[]>}
 */
async function fetchCopernicusDemSamples(frame, opts) {
  if (!frame || !Number.isFinite(+frame.west) || !Number.isFinite(+frame.south)) {
    throw new Error("GLO-30 frame");
  }
  const urls = glo30TilesForFrame(frame);
  if (!urls.length || urls.length > MAX_TILES) throw new Error("GLO-30 tile span");
  const geotiff = (opts && opts.geotiff) || require("geotiff");
  const signal = (opts && opts.signal) || AbortSignal.timeout(GLO30_FETCH_MS);
  const maxRasterSide = opts && opts.maxRasterSide > 0 ? opts.maxRasterSide : 128;
  const tiles = [];
  let firstError = null;
  await Promise.all(
    urls.map(async (url) => {
      // One more read after a short pause when a tile read fails for a
      // reason other than the caller's stop. A single dropped S3 range read
      // (seen on a freshly started worker, Kalgoorlie Oct 30) used to leave
      // the whole export without terrain.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const tile = await readGlo30Window(geotiff, url, frame, signal, maxRasterSide);
          if (tile) tiles.push(tile);
          return;
        } catch (e) {
          if (signal.aborted) throw e;
          if (attempt === 0) {
            await pauseUnlessAborted(GLO30_RETRY_MS, signal);
            if (signal.aborted) throw e;
            continue;
          }
          if (!firstError) firstError = e;
        }
      }
    })
  );
  if (!tiles.length) {
    const msg = firstError ? String(firstError.message || firstError) : "no tile";
    throw new Error("GLO-30 " + msg);
  }
  const side = sampleLatticeSide(opts && opts.sampleCount);
  const out = [];
  for (let r = 0; r < side; r++) {
    const lat = +frame.south + ((r + 0.5) / side) * (+frame.north - +frame.south);
    for (let c = 0; c < side; c++) {
      const lon = +frame.west + ((c + 0.5) / side) * (+frame.east - +frame.west);
      let z = null;
      for (let i = 0; i < tiles.length; i++) {
        z = sampleTile(tiles[i], lon, lat);
        if (z != null) break;
      }
      if (z == null) continue;
      out.push({ lon, lat, z });
    }
  }
  if (out.length < 4) throw new Error("GLO-30 did not return a usable grid");
  const fineMax = opts && opts.fineGridSide > 0 ? opts.fineGridSide | 0 : 0;
  if (fineMax > 0) {
    const fine = glo30FineGrid(tiles, frame, fineMax);
    if (fine) Object.defineProperty(out, "fineGrid", { value: fine, enumerable: false, writable: true });
  }
  return out;
}

/**
 * Node lattice at the raster's own posting (capped at maxSide per axis), for
 * the adaptive terrain mesh. Nodes run edge to edge of the frame. A node with
 * no usable value takes the nearest usable node on its row, then column.
 */
function glo30FineGrid(tiles, frame, maxSide) {
  let resLon = Infinity;
  let resLat = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    resLon = Math.min(resLon, Math.abs(tiles[i].res[0]));
    resLat = Math.min(resLat, Math.abs(tiles[i].res[1]));
  }
  if (!(resLon > 0) || !(resLat > 0) || !Number.isFinite(resLon)) return null;
  const spanLon = +frame.east - +frame.west;
  const spanLat = +frame.north - +frame.south;
  const cols = Math.max(2, Math.min(maxSide, Math.ceil(spanLon / resLon - 1e-6) + 1));
  const rows = Math.max(2, Math.min(maxSide, Math.ceil(spanLat / resLat - 1e-6) + 1));
  const z = new Float32Array(cols * rows);
  let good = 0;
  for (let r = 0; r < rows; r++) {
    const lat = +frame.south + (r / (rows - 1)) * spanLat;
    for (let c = 0; c < cols; c++) {
      const lon = +frame.west + (c / (cols - 1)) * spanLon;
      let v = null;
      for (let i = 0; i < tiles.length && v == null; i++) v = sampleTile(tiles[i], lon, lat);
      z[r * cols + c] = v == null ? NaN : v;
      if (v != null) good++;
    }
  }
  if (good < cols * rows * 0.9) return null;
  fillGaps(z, cols, rows);
  return { west: +frame.west, south: +frame.south, east: +frame.east, north: +frame.north, cols, rows, z };
}

function fillGaps(z, cols, rows) {
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!Number.isNaN(z[r * cols + c])) continue;
        let best = NaN;
        for (let d = 1; d < Math.max(cols, rows) && Number.isNaN(best); d++) {
          const cand = [
            [c - d, r],
            [c + d, r],
            [c, r - d],
            [c, r + d],
          ];
          for (let k = 0; k < cand.length; k++) {
            const [cc, rr] = cand[k];
            if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
            const v = z[rr * cols + cc];
            if (!Number.isNaN(v)) {
              best = v;
              break;
            }
          }
        }
        z[r * cols + c] = best;
      }
    }
  }
}

module.exports = {
  GLO30_BUCKET,
  GLO30_CREDIT,
  GLO30_FETCH_MS,
  MAX_TILES,
  glo30TileId,
  glo30TileUrl,
  glo30TileUrlForPoint,
  glo30TilesForFrame,
  fetchCopernicusDemSamples,
  glo30FineGrid,
};
