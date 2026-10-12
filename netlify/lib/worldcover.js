"use strict";

/**
 * ESA WorldCover 10 m (2021 v200), anonymous COG.
 * Class 10 is tree cover. A site reads one 3-degree tile window, not the
 * whole map. Nodata and a failed read leave the canopy grid unchanged.
 */

const TREE = 10;
const SHRUB = 20;
const GRASS = 30;
const CROP = 40;
const WATER = 80;

function worldcoverTile(lat, lon) {
  const latS = Math.floor(+lat / 3) * 3;
  const lonW = Math.floor(+lon / 3) * 3;
  const ns = latS >= 0 ? "N" : "S";
  const ew = lonW >= 0 ? "E" : "W";
  const la = String(Math.abs(latS)).padStart(2, "0");
  const lo = String(Math.abs(lonW)).padStart(3, "0");
  return ns + la + ew + lo;
}

function worldcoverUrl(lat, lon) {
  return (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/" +
    "ESA_WorldCover_10m_2021_v200_" +
    worldcoverTile(lat, lon) +
    "_Map.tif"
  );
}

function valuesOf(raster) {
  if (!raster) return null;
  if (raster.data) return raster.data;
  if (ArrayBuffer.isView(raster)) return raster;
  if (raster[0] && ArrayBuffer.isView(raster[0])) return raster[0];
  return raster;
}

/**
 * @returns {Promise<{sample:(lon:number,lat:number)=>number}|null>}
 * sample returns the WorldCover class, or 0 outside the window.
 */
async function fetchWorldCoverTrees(frame, opts) {
  const { timeSpan } = require("./stage-clock");
  return timeSpan("worldcover", () => fetchWorldCoverTreesWork(frame, opts));
}

async function fetchWorldCoverTreesWork(frame, opts) {
  if (!frame) return null;
  const signal = (opts && opts.signal) || AbortSignal.timeout(8000);
  if (signal.aborted) return null;
  const lat = ((+frame.south) + (+frame.north)) / 2;
  const lon = ((+frame.west) + (+frame.east)) / 2;
  const geotiff = (opts && opts.loader) || require("geotiff");
  const tiff = await geotiff.fromUrl(worldcoverUrl(lat, lon), { cacheSize: 8 }, signal);
  const image = await tiff.getImage();
  const bbox = image.getBoundingBox();
  const iw = image.getWidth();
  const ih = image.getHeight();
  const minX = bbox[0];
  const minY = bbox[1];
  const maxX = bbox[2];
  const maxY = bbox[3];
  const px = (x) => ((x - minX) / (maxX - minX || 1)) * iw;
  const py = (y) => ((maxY - y) / (maxY - minY || 1)) * ih;
  let left = Math.floor(Math.min(px(frame.west), px(frame.east)));
  let right = Math.ceil(Math.max(px(frame.west), px(frame.east)));
  let top = Math.floor(Math.min(py(frame.north), py(frame.south)));
  let bottom = Math.ceil(Math.max(py(frame.north), py(frame.south)));
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(iw, right);
  bottom = Math.min(ih, bottom);
  if (right - left < 2 || bottom - top < 2) return null;
  const ras = await image.readRasters({
    window: [left, top, right, bottom],
    interleave: true,
    signal,
  });
  const data = valuesOf(ras);
  const w = right - left;
  const h = bottom - top;
  if (!data || data.length < w * h) return null;
  return {
    sample(slon, slat) {
      if (!Number.isFinite(slon) || !Number.isFinite(slat)) return 0;
      const x = Math.floor(px(slon)) - left;
      const y = Math.floor(py(slat)) - top;
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      return data[y * w + x] | 0;
    },
  };
}

module.exports = {
  TREE,
  SHRUB,
  GRASS,
  CROP,
  WATER,
  worldcoverTile,
  worldcoverUrl,
  fetchWorldCoverTrees,
};
