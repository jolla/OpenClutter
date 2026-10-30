"use strict";

/**
 * A summer (leaf-on) orthophoto from a national mapping agency, resampled
 * onto the export frame. The Esri world photo is often a spring or winter
 * flight: bare deciduous crowns, long shadows. Where a country publishes a
 * leaf-on photo, a crown drawn from an estimated canopy height map can be
 * checked for actual foliage.
 *
 * Finland: National Land Survey orthophoto (CC BY 4.0), open WMTS, needs a
 * free key in NLS_API_KEY. Without the key, or outside coverage, this returns
 * null and nothing changes.
 */

const jpeg = require("jpeg-js");

const NLS_KEY_ENV = "NLS_API_KEY";
const NLS_URL = "https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/";
const TILE_Z = 17;
const MAX_TILES = 196;
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

/** Rough national extents. A tile outside the agency's coverage comes back blank and is caught later. */
const PROVIDERS = [
  { id: "nls-fi", label: "National Land Survey of Finland orthophoto (CC BY 4.0)", west: 19.0, east: 31.6, south: 59.6, north: 70.1, env: NLS_KEY_ENV, url: NLS_URL },
];

function providerFor(frame, env) {
  const e = env || process.env;
  if (!frame) return null;
  const lon = (frame.west + frame.east) / 2;
  const lat = (frame.south + frame.north) / 2;
  for (const p of PROVIDERS) {
    if (lon < p.west || lon > p.east || lat < p.south || lat > p.north) continue;
    const key = e[p.env];
    if (!key) return null;
    return { ...p, key: String(key).trim() };
  }
  return null;
}

function lonToTileX(lon, n) {
  return ((lon + 180) / 360) * n;
}
function latToTileY(lat, n) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
}

async function fetchTile(url, fetchImpl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Mosaic the provider tiles onto the frame grid (imgW x imgH, row 0 north).
 * Returns { width, height, data (RGBA), have (Uint8Array, 1 where a tile
 * covered the pixel), source } or null.
 */
async function fetchLeafOnPhoto(frame, opts) {
  const o = opts || {};
  const p = o.provider || providerFor(frame, o.env);
  if (!p || !frame || !(frame.imgW > 0) || !(frame.imgH > 0)) return null;
  const fetchImpl = o.fetch || globalThis.fetch;
  const n = 2 ** TILE_Z;
  const tx0 = Math.floor(lonToTileX(frame.west, n));
  const tx1 = Math.floor(lonToTileX(frame.east, n));
  const ty0 = Math.floor(latToTileY(frame.north, n));
  const ty1 = Math.floor(latToTileY(frame.south, n));
  const count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  if (!(count > 0) || count > MAX_TILES) return null;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
  const tiles = new Map();
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      const img = await fetchTile(p.url + TILE_Z + "/" + j.ty + "/" + j.tx + ".jpg?api-key=" + encodeURIComponent(p.key), fetchImpl);
      if (img && img.width > 0) tiles.set(j.tx + "," + j.ty, img);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!tiles.size) return null;
  const W = frame.imgW, H = frame.imgH;
  const data = new Uint8Array(W * H * 4);
  const have = new Uint8Array(W * H);
  const colTx = new Float64Array(W);
  for (let c = 0; c < W; c++) colTx[c] = lonToTileX(frame.west + ((c + 0.5) / W) * (frame.east - frame.west), n);
  let covered = 0;
  for (let r = 0; r < H; r++) {
    const fy = latToTileY(frame.north - ((r + 0.5) / H) * (frame.north - frame.south), n);
    const ty = Math.floor(fy);
    for (let c = 0; c < W; c++) {
      const fx = colTx[c];
      const tx = Math.floor(fx);
      const img = tiles.get(tx + "," + ty);
      if (!img) continue;
      const px = Math.min(img.width - 1, Math.floor((fx - tx) * img.width));
      const py = Math.min(img.height - 1, Math.floor((fy - ty) * img.height));
      const s = (py * img.width + px) * 4;
      const d = (r * W + c) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
      have[r * W + c] = 1;
      covered++;
    }
  }
  // A blank or flat image is no coverage: outside the country the service
  // returns empty tiles.
  let sum = 0, sum2 = 0, k = 0;
  for (let i = 0; i < W * H; i += 37) {
    if (!have[i]) continue;
    const l = data[i * 4 + 1];
    sum += l;
    sum2 += l * l;
    k++;
  }
  const sd = k ? Math.sqrt(Math.max(0, sum2 / k - (sum / k) ** 2)) : 0;
  if (covered < 0.5 * W * H || sd < 6) return null;
  return { width: W, height: H, data, have, source: p.label, providerId: p.id };
}

/**
 * Summer foliage or lawn on a white-balanced pixel: green well above red and
 * not below blue. Shaded crowns keep a little blue, so blue gets slack.
 * Aerial photos carry a blue haze, so each channel is first scaled to the
 * photo's own mean grey (gray world).
 */
function leafOnGreenPixel(r, g, b) {
  return g >= r + 8 && g >= b - 3;
}

function grayWorldGains(photo) {
  const { data, have, width: w, height: h } = photo;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < w * h; i += 7) {
    if (!have[i]) continue;
    sr += data[i * 4];
    sg += data[i * 4 + 1];
    sb += data[i * 4 + 2];
    n++;
  }
  if (!n || !(sr > 0) || !(sg > 0) || !(sb > 0)) return [1, 1, 1];
  const m = (sr + sg + sb) / 3;
  return [m / sr, m / sg, m / sb];
}

/**
 * Share of a ring (OI px, y up) that shows foliage on the leaf-on photo.
 * Returns null when the photo does not cover enough of the ring.
 */
/** Foliage within this distance of a crown pixel counts: a shaded crown is lit at its edge. */
const LEAF_ON_REACH_M = 1.5;

function greenMask(photo) {
  const { data, have, width: w, height: h } = photo;
  const [gr, gg, gb] = grayWorldGains(photo);
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!have[i]) continue;
    const k = i * 4;
    if (leafOnGreenPixel(data[k] * gr, data[k + 1] * gg, data[k + 2] * gb)) m[i] = 1;
  }
  return m;
}

/** Square dilation by r pixels, rows then columns. */
function dilate(mask, w, h, r) {
  if (!(r > 0)) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) last = x; else if (x - last <= r) tmp[y * w + x] = 1;
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) if (mask[y * w + x]) { last = x; tmp[y * w + x] = 1; } else if (last - x <= r) tmp[y * w + x] = 1;
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) if (tmp[y * w + x]) last = y; else if (y - last <= r) out[y * w + x] = 1;
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) if (tmp[y * w + x]) { last = y; out[y * w + x] = 1; } else if (last - y <= r) out[y * w + x] = 1;
  }
  return out;
}

/**
 * Share of a ring (OI px, y up) that has summer foliage on or next to it on
 * the leaf-on photo. Returns null when the photo does not cover the ring.
 * mpp is the frame's metres per pixel.
 */
function leafOnGreenSampler(photo, mpp, reachM) {
  if (!photo || !photo.data) return null;
  const { have, width: w, height: h } = photo;
  const reach = mpp > 0 ? Math.round((reachM >= 0 ? reachM : LEAF_ON_REACH_M) / mpp) : 0;
  const green = dilate(greenMask(photo), w, h, reach);
  return function greenShare(ring) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 20));
    let n = 0, insideN = 0, g = 0;
    for (let y = Math.ceil(y0); y <= y1; y += step) {
      for (let x = Math.ceil(x0); x <= x1; x += step) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (!inside) continue;
        insideN++;
        const row = h - 1 - Math.round(y);
        const col = Math.round(x);
        if (row < 0 || row >= h || col < 0 || col >= w || !have[row * w + col]) continue;
        n++;
        if (green[row * w + col]) g++;
      }
    }
    if (n < 6 || n < 0.7 * insideN) return null;
    return g / n;
  };
}

module.exports = { grayWorldGains, providerFor, fetchLeafOnPhoto, leafOnGreenSampler, leafOnGreenPixel, NLS_KEY_ENV };
