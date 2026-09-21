"use strict";

/**
 * Meta / WRI canopy height (CHM v2), ~1.2 m uint8 metres, anonymous COG.
 * One zoom-10 Web-Mercator quadkey covers a commercial site. The reader
 * requests only the pixel window over the export bbox (resampled), so the
 * ~200 MB tile is not downloaded. NLCD still decides where trees go.
 * A sample ≥ 2 m replaces the NLCD-informed top_height. 0 / nodata keeps it.
 * Trees are still rejected on roofs and pavement by the existing placer.
 */

const { quadkeysForBbox } = require("./ms-global");

const CHM_ZOOM = 10;
const MAX_TILES = 4;
const MAX_DIM = 180;

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
  const dLon = Math.abs(frame.east - frame.west) || 1e-6;
  const dLat = Math.abs(frame.north - frame.south) || 1e-6;
  const aspect = dLat / dLon;
  let width = MAX_DIM;
  let height = Math.max(8, Math.round(MAX_DIM * aspect));
  if (height > MAX_DIM) {
    height = MAX_DIM;
    width = Math.max(8, Math.round(MAX_DIM / aspect));
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

async function readTileWindow(image, frame, width, height) {
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
  const covers = left >= 0 && top >= 0 && right <= iw && bottom <= ih;
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(iw, right);
  bottom = Math.min(ih, bottom);
  if (right - left < 2 || bottom - top < 2) return null;
  const ras = await image.readRasters({
    window: [left, top, right, bottom],
    width: covers ? width : Math.min(width, right - left),
    height: covers ? height : Math.min(height, bottom - top),
    resampleMethod: "bilinear",
    interleave: true,
  });
  const data = valuesOf(ras);
  return {
    covers,
    data,
    width: covers ? width : ras.width || Math.min(width, right - left),
    height: covers ? height : ras.height || Math.min(height, bottom - top),
    left,
    top,
    right,
    bottom,
    origin,
    res,
  };
}

function paintPartial(target, tile, frame) {
  const { width, height } = target;
  for (let j = 0; j < height; j++) {
    const lat = frame.north - ((j + 0.5) / height) * (frame.north - frame.south);
    for (let i = 0; i < width; i++) {
      const lon = frame.west + ((i + 0.5) / width) * (frame.east - frame.west);
      const [x, y] = mercator(lon, lat);
      const px = (x - tile.origin[0]) / tile.res[0];
      const py = (y - tile.origin[1]) / tile.res[1];
      if (px < tile.left || px > tile.right || py < tile.top || py > tile.bottom) continue;
      const tx = ((px - tile.left) / (tile.right - tile.left || 1)) * (tile.width - 1);
      const ty = ((py - tile.top) / (tile.bottom - tile.top || 1)) * (tile.height - 1);
      const v = sampleBilinear(tile.data, tile.width, tile.height, tx, ty);
      if (v >= 1 && v < 80) target.values[j * width + i] = Math.round(v);
    }
  }
}

async function fetchChmGrid(frame) {
  const keys = quadkeysForBbox(frame.west, frame.south, frame.east, frame.north, CHM_ZOOM);
  if (!keys.length || keys.length > MAX_TILES) return null;
  const geotiff = require("geotiff");
  const { width, height } = gridSize(frame);
  const values = new Uint8Array(width * height);
  const signal = AbortSignal.timeout(7000);
  for (const key of keys) {
    const tiff = await geotiff.fromUrl(chmUrl(key), { cacheSize: 16 }, signal);
    const image = await tiff.getImage();
    const tile = await readTileWindow(image, frame, width, height);
    if (!tile || !tile.data) continue;
    if (tile.covers && keys.length === 1) {
      const n = Math.min(values.length, tile.data.length);
      for (let i = 0; i < n; i++) {
        const v = tile.data[i];
        if (v >= 1 && v < 80) values[i] = Math.round(v);
      }
    } else {
      paintPartial({ values, width, height }, tile, frame);
    }
  }
  let nz = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= 2) nz++;
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

module.exports = {
  CHM_ZOOM,
  MAX_DIM,
  chmUrl,
  mercator,
  sampleChmGrid,
  applyChmToTrees,
  gridToJson,
  fetchChmGrid,
  gridSize,
};
