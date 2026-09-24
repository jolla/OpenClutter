"use strict";

/**
 * Meta / WRI canopy height (CHM v2), ~1.2 m uint8 metres, anonymous COG.
 * One zoom-10 Web-Mercator quadkey covers a commercial site. The reader
 * requests only the pixel window over the export bbox (resampled), so the
 * ~200 MB tile is not downloaded. NLCD still decides where a coarse canopy
 * polygon may fall when this grid cannot resolve a crown.
 * A sample ≥ 2 m replaces an NLCD-informed top_height. 0 / nodata keeps it.
 * crownsFromChm turns the same grid into individual crown outlines: each
 * ring is the CHM footprint of one peaked (or compact) canopy, at the
 * measured top height. It does not emit circles, trunks, or a point scatter.
 */

const { quadkeysForBbox } = require("./ms-global");

const CHM_ZOOM = 10;
const MAX_TILES = 4;
/** Long side of the resampled window. ~3–5 m on a commercial block, still a bbox read. */
const MAX_DIM = 320;
/** Pixels below this are ground, not a crown. */
const CROWN_MIN_H = 3;
/** A seed must stand at least this far above the canopy around it. */
const CROWN_PROM_M = 1;
const CROWN_RADIUS_M = 14;
const CROWN_MIN_AREA_M2 = 12;
const CROWN_MAX_AREA_M2 = 900;
/** Isolated clumps with no internal peak, small enough to be one crown. */
const CROWN_CLUMP_M2 = 650;
const CROWN_MAX_VERTS = 32;
const CROWN_RELATIVE = 0.42;
/** Keep the tallest crowns inside the OpenIntent area budget. */
const CROWN_CAP = 800;

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

async function fetchChmGrid(frame, opts) {
  const keys = quadkeysForBbox(frame.west, frame.south, frame.east, frame.north, CHM_ZOOM);
  if (!keys.length || keys.length > MAX_TILES) return null;
  const geotiff = require("geotiff");
  const { width, height } = gridSize(frame);
  const values = new Uint8Array(width * height);
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
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

function simplifyOpen(points, maxVerts) {
  let cur = points;
  let eps = 0.35;
  while (cur.length > maxVerts && eps < 8) {
    const next = douglas(cur, eps);
    if (next.length >= cur.length) break;
    cur = next;
    eps *= 1.45;
  }
  if (cur.length > maxVerts) {
    const step = Math.ceil(cur.length / maxVerts);
    const next = [];
    for (let i = 0; i < cur.length; i += step) next.push(cur[i]);
    cur = next.length >= 3 ? next : cur.slice(0, maxVerts);
  }
  return cur;
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

function crownFromPixels(pixels, values, w, grid, mPerX, mPerY, hintH, maxArea) {
  const area = pixels.length * mPerX * mPerY;
  const cap = maxArea > 0 ? maxArea : CROWN_MAX_AREA_M2;
  if (!(area >= CROWN_MIN_AREA_M2) || area > cap) return null;
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
  // A lone 4 m pixel is CHM noise. A real small tree is taller, or wider.
  if (heightM < 5 && pixels.length < 2) return null;
  let ring = tracePixels(pixels);
  if (!ring) return null;
  let open = dropCollinearPx(ring);
  if (open.length > CROWN_MAX_VERTS) open = simplifyOpen(open, CROWN_MAX_VERTS);
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
 * Individual canopy crowns from a Meta CHM window.
 * A local height peak becomes one crown whose ring is the CHM cells that
 * belong to that peak (real outline, measured top). A compact clump with no
 * internal peak is one outline. A flat woods is not sliced into a point grid.
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
  const rad = Math.max(1, Math.min(4, Math.round(8 / Math.min(mPerX, mPerY))));
  const peaks = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      if (v < 4) continue;
      let taller = false;
      let sum = 0;
      let n = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (!dx && !dy) continue;
          const dist = Math.hypot(dx * mPerX, dy * mPerY);
          if (dist > 9) continue;
          const o = at(x + dx, y + dy);
          if (o > v) taller = true;
          // Ground beside a woods edge is not a saddle. Compare to canopy only.
          if (o >= CROWN_MIN_H) {
            sum += o;
            n++;
          }
        }
      }
      if (taller) continue;
      if (!n) {
        if (v >= 5) peaks.push({ x, y, h: v, prom: v });
        continue;
      }
      const prom = v - sum / n;
      if (prom < CROWN_PROM_M) continue;
      peaks.push({ x, y, h: v, prom });
    }
  }
  peaks.sort((a, b) => b.h - a.h || b.prom - a.prom || a.y - b.y || a.x - b.x);
  const kept = [];
  const minDist = 7.5;
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    let close = false;
    for (let k = 0; k < kept.length; k++) {
      const dx = (p.x - kept[k].x) * mPerX;
      const dy = (p.y - kept[k].y) * mPerY;
      if (dx * dx + dy * dy < minDist * minDist) {
        close = true;
        break;
      }
    }
    if (!close) kept.push(p);
  }

  const cellM = CROWN_RADIUS_M;
  const buckets = new Map();
  const bkey = (x, y) => Math.floor((x * mPerX) / cellM) + ":" + Math.floor((y * mPerY) / cellM);
  for (let i = 0; i < kept.length; i++) {
    const k = bkey(kept[i].x, kept[i].y);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  const labels = new Int32Array(w * h);
  labels.fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      if (v < CROWN_MIN_H) continue;
      const bx = Math.floor((x * mPerX) / cellM);
      const by = Math.floor((y * mPerY) / cellM);
      let best = -1;
      let bestD = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = buckets.get(bx + ox + ":" + (by + oy));
          if (!list) continue;
          for (let n = 0; n < list.length; n++) {
            const i = list[n];
            const p = kept[i];
            const dx = (x - p.x) * mPerX;
            const dy = (y - p.y) * mPerY;
            const d2 = dx * dx + dy * dy;
            if (d2 > CROWN_RADIUS_M * CROWN_RADIUS_M) continue;
            if (v + 0.15 < Math.max(CROWN_MIN_H, p.h * CROWN_RELATIVE)) continue;
            if (d2 < bestD) {
              bestD = d2;
              best = i;
            }
          }
        }
      }
      if (best >= 0) labels[y * w + x] = best;
    }
  }

  const crowns = [];
  for (let i = 0; i < kept.length; i++) {
    const pixels = flood(w, h, kept[i].x, kept[i].y, (x, y) => labels[y * w + x] === i);
    if (!pixels) continue;
    const crown = crownFromPixels(pixels, values, w, grid, mPerX, mPerY, kept[i].h);
    if (crown) crowns.push(crown);
  }

  const seen = new Uint8Array(w * h);
  const clumps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (seen[idx] || labels[idx] >= 0 || at(x, y) < 4) continue;
      const pixels = flood(w, h, x, y, (px, py) => {
        const id = py * w + px;
        // Pixels already given to a peaked crown stay with that crown, including
        // diagonal orphans. They are not a second outline.
        return labels[id] < 0 && !seen[id] && at(px, py) >= 4;
      });
      if (!pixels) continue;
      for (let p = 0; p < pixels.length; p++) seen[pixels[p][1] * w + pixels[p][0]] = 1;
      const area = pixels.length * mPerX * mPerY;
      const limit = crowns.length ? CROWN_CLUMP_M2 : 200000;
      if (area < CROWN_MIN_AREA_M2 || area > limit) continue;
      let minX = w;
      let minY = h;
      let maxX = 0;
      let maxY = 0;
      for (let p = 0; p < pixels.length; p++) {
        if (pixels[p][0] < minX) minX = pixels[p][0];
        if (pixels[p][1] < minY) minY = pixels[p][1];
        if (pixels[p][0] > maxX) maxX = pixels[p][0];
        if (pixels[p][1] > maxY) maxY = pixels[p][1];
      }
      let blocked = false;
      for (let k = 0; k < kept.length && !blocked; k++) {
        if (kept[k].x >= minX - 1 && kept[k].x <= maxX + 1 && kept[k].y >= minY - 1 && kept[k].y <= maxY + 1) {
          blocked = true;
        }
      }
      if (blocked) continue;
      const crown = crownFromPixels(pixels, values, w, grid, mPerX, mPerY, 0, limit);
      if (crown) clumps.push(crown);
    }
  }

  const out = crowns.concat(clumps);
  out.sort((a, b) => b.heightM - a.heightM || b.areaM2 - a.areaM2);
  return out.length > CROWN_CAP ? out.slice(0, CROWN_CAP) : out;
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
  crownsFromChm,
};
