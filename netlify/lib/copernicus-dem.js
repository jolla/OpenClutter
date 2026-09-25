"use strict";

/**
 * Copernicus DEM GLO-30 public COG (AWS Open Data). Geographic degree tiles,
 * not Web Mercator. Each name is the southwest corner of a 1°×1° tile.
 * Pixel size is about 30 m: longitude spacing changes with latitude, so the
 * reader uses the GeoTIFF origin and resolution instead of a fixed 3600 grid.
 *
 * This is a surface DSM (EGM2008), not bare earth. Callers tag kind "surface"
 * and must not lift building bottoms onto it.
 *
 * Example (Trafalgar Square, confirmed HTTP 200):
 * https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N51_00_W001_00_DEM/Copernicus_DSM_COG_10_N51_00_W001_00_DEM.tif
 */

const GLO30_BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com";
/** Required credit when a derived mesh from GLO-30 is distributed. */
const GLO30_CREDIT =
  "© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved";
const MAX_TILES = 4;

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

async function readGlo30Window(geotiff, url, frame, signal) {
  const tiff = await geotiff.fromUrl(url, { cacheSize: 16 }, signal);
  const image = await tiff.getImage();
  const origin = image.getOrigin();
  const res = image.getResolution();
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
  const ras = await image.readRasters({
    window: [left, top, right, bottom],
    interleave: true,
  });
  const data = rasterValues(ras);
  const width = ras && ras.width ? ras.width : right - left;
  const height = ras && ras.height ? ras.height : bottom - top;
  if (!data || data.length < width * height || width < 1 || height < 1) return null;
  const nodata = typeof image.getGDALNoData === "function" ? image.getGDALNoData() : null;
  return {
    data,
    width,
    height,
    left,
    top,
    origin,
    res,
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
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
  const tiles = [];
  let firstError = null;
  await Promise.all(
    urls.map(async (url) => {
      try {
        const tile = await readGlo30Window(geotiff, url, frame, signal);
        if (tile) tiles.push(tile);
      } catch (e) {
        if (signal.aborted) throw e;
        if (!firstError) firstError = e;
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
  return out;
}

module.exports = {
  GLO30_BUCKET,
  GLO30_CREDIT,
  MAX_TILES,
  glo30TileId,
  glo30TileUrl,
  glo30TileUrlForPoint,
  glo30TilesForFrame,
  fetchCopernicusDemSamples,
};
