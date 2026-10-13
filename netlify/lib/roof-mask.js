"use strict";

/**
 * Imagery roof fill for large commercial roofs missing from Microsoft Global ML,
 * MSBFP2, and FEMA USA Structures.
 *
 * Method (validated in eval by deleting the known Oak Creek white-roof polygon
 * and requiring the mask to put it back on the Esri JPEG):
 *   1. Keep pixels that are bright, low-saturation, and locally smooth
 *      (membrane / metal roofs, not textured canopy, not car-filled asphalt).
 *   2. Connected components whose area is at least ~900 m² (bright) or
 *      ~1100 m² (smooth gray membrane). Car-textured lots stay out.
 *   3. Reject long thin components (roads) and low fill (speckle).
 *   4. If existing footprint rings already cover most of the component, skip it.
 *   5. Otherwise emit the convex hull as a GeoJSON polygon. A much smaller
 *      vector whose centroid sits inside that hull is a partial stub and is
 *      dropped so the full outline replaces it.
 *   6. Dark pixels are not a roof. Tower shadow, roads, and trees share
 *      that luminance, so this module does not emit a building from them.
 * OSM building rings are not read.
 */

const { featureExteriorRings, ringAreaM2, simplifyDP } = require("./pipeline");

const MIN_ROOF_M2 = 900;
/** Smooth gray membranes (clubhouse, hotel wing) below the bright-roof gate. */
const MIN_MEMBRANE_M2 = 1100;
const MAX_MEMBRANE_M2 = 12000;
const MAX_ASPECT = 3.6;
const MIN_FILL = 0.62;
const MAX_COVER = 0.45;

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function imagePxToLl(x, yDown, frame) {
  const lon = frame.west + (x / frame.imgW) * (frame.east - frame.west);
  const lat = frame.north - (yDown / frame.imgH) * (frame.north - frame.south);
  return [lon, lat];
}

function llToImage(lon, lat, frame) {
  const x = ((lon - frame.west) / (frame.east - frame.west)) * frame.imgW;
  const y = ((frame.north - lat) / (frame.north - frame.south)) * frame.imgH;
  return [x, y];
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts.slice();
  const lower = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function ringPxArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function existingImageRings(features, frame) {
  const rings = [];
  const list = features || [];
  for (let i = 0; i < list.length; i++) {
    const exteriors = featureExteriorRings(list[i] && list[i].geometry);
    for (let r = 0; r < exteriors.length; r++) {
      const px = [];
      for (let k = 0; k < exteriors[r].length; k++) {
        px.push(llToImage(exteriors[r][k][0], exteriors[r][k][1], frame));
      }
      rings.push({ index: i, lonlat: exteriors[r], px });
    }
  }
  return rings;
}

function ringCentroid(ring) {
  const open =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  if (!open.length) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < open.length; i++) {
    sx += open[i][0];
    sy += open[i][1];
  }
  return [sx / open.length, sy / open.length];
}

/** Nearest measured footprint within 150 m. Used when the imagery roof has no stub height. */
function nearestMeasuredHeight(features, ringLonLat, frame) {
  const c = ringCentroid(ringLonLat);
  if (!c || !frame || !frame.mpd) return 0;
  let best = 0;
  let bestD = 150 * 150;
  for (let i = 0; i < (features || []).length; i++) {
    const h = featureHeight(features[i]);
    if (!h) continue;
    const rings = featureExteriorRings(features[i].geometry);
    for (let r = 0; r < rings.length; r++) {
      const rc = ringCentroid(rings[r]);
      if (!rc) continue;
      const dx = (rc[0] - c[0]) * frame.mpd.lon;
      const dy = (rc[1] - c[1]) * frame.mpd.lat;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = h;
      }
    }
  }
  return best;
}

function featureHeight(feature) {
  const p = feature && feature.properties;
  const h = Number(p && (p.height != null ? p.height : p.Height != null ? p.Height : p.HEIGHT));
  return h > 2 && h < 400 ? h : 0;
}

function roofCells(raw, step, mode) {
  const membrane = mode === "membrane";
  const w = raw.width;
  const h = raw.height;
  const data = raw.data;
  const cells = [];
  const set = new Set();
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const Y = luma(r, g, b);
      if (membrane) {
        if (Y < 132 || Y > 184) continue;
      } else if (Y < 186) continue;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      if (sat > (membrane ? 0.14 : 0.12)) continue;
      if (g > r + 10 && g > b + 6) continue;
      let n = 0;
      let sum = 0;
      let sum2 = 0;
      for (let dy = -step; dy <= step; dy += step) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -step; dx <= step; dx += step) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 4;
          const yv = luma(data[j], data[j + 1], data[j + 2]);
          n++;
          sum += yv;
          sum2 += yv * yv;
        }
      }
      const mean = n ? sum / n : 0;
      const std = Math.sqrt(Math.max(0, (n ? sum2 / n : 0) - mean * mean));
      if (membrane) {
        if (std > 5.2 || mean < 128 || mean > 186) continue;
      } else if (std > 9.5 || mean < 182) continue;
      const key = x + "," + y;
      set.add(key);
      cells.push([x, y]);
    }
  }
  return { cells, set };
}

function componentsOf(cells, set, step) {
  const seen = new Set();
  const comps = [];
  for (let i = 0; i < cells.length; i++) {
    const start = cells[i];
    const sk = start[0] + "," + start[1];
    if (seen.has(sk)) continue;
    const q = [start];
    seen.add(sk);
    const comp = [];
    while (q.length) {
      const c = q.pop();
      comp.push(c);
      const nbrs = [
        [c[0] + step, c[1]],
        [c[0] - step, c[1]],
        [c[0], c[1] + step],
        [c[0], c[1] - step],
      ];
      for (let k = 0; k < nbrs.length; k++) {
        const nk = nbrs[k][0] + "," + nbrs[k][1];
        if (set.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          q.push(nbrs[k]);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function hullRingPx(comp, step) {
  const pts = [];
  const half = step / 2;
  for (let i = 0; i < comp.length; i++) {
    const x = comp[i][0];
    const y = comp[i][1];
    pts.push([x - half, y - half]);
    pts.push([x + half, y - half]);
    pts.push([x + half, y + half]);
    pts.push([x - half, y + half]);
  }
  let hull = convexHull(pts);
  if (hull.length < 3) return null;
  const closed = hull.concat([hull[0]]);
  const simple = simplifyDP(closed, 9);
  if (!simple || simple.length < 4) return hull.concat([hull[0]]);
  const a = simple[0];
  const b = simple[simple.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) simple.push(simple[0]);
  return simple;
}

/**
 * @param {{data:Uint8Array,width:number,height:number}} raw decoded RGBA
 * @param {object} frame geo frame
 * @param {object[]} features existing footprint features
 * @returns {{features:object[], dropIndexes:number[]}}
 */
function imageryRoofFeatures(raw, frame, features, mode) {
  if (!raw || !raw.data || !frame || !(raw.width > 8) || !(raw.height > 8)) {
    return { features: [], dropIndexes: [] };
  }
  const membrane = mode === "membrane";
  const minArea = membrane ? MIN_MEMBRANE_M2 : MIN_ROOF_M2;
  const maxArea = membrane ? MAX_MEMBRANE_M2 : 150000;
  const maxAspect = membrane ? 3.2 : MAX_ASPECT;
  const minFill = membrane ? 0.68 : MIN_FILL;
  const step = Math.max(raw.width, raw.height) > 1400 ? 4 : 3;
  const { cells, set } = roofCells(raw, step, membrane ? "membrane" : "bright");
  if (!cells.length) return { features: [], dropIndexes: [] };
  const rings = existingImageRings(features, frame);
  const m2PerCell = step * step * frame.mpuX * frame.mpuY;
  const comps = componentsOf(cells, set, step);
  const out = [];
  const drop = new Set();
  for (let c = 0; c < comps.length; c++) {
    const comp = comps[c];
    const areaM = comp.length * m2PerCell;
    if (areaM < minArea || areaM > maxArea) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < comp.length; i++) {
      if (comp[i][0] < minX) minX = comp[i][0];
      if (comp[i][1] < minY) minY = comp[i][1];
      if (comp[i][0] > maxX) maxX = comp[i][0];
      if (comp[i][1] > maxY) maxY = comp[i][1];
    }
    const bw = Math.max(step, maxX - minX + step);
    const bh = Math.max(step, maxY - minY + step);
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (aspect > maxAspect) continue;
    const fill = (comp.length * step * step) / (bw * bh);
    if (fill < minFill) continue;
    let covered = 0;
    const sampleN = comp.length > 280 ? 280 : comp.length;
    const stride = Math.max(1, Math.floor(comp.length / sampleN));
    let sampled = 0;
    for (let i = 0; i < comp.length; i += stride) {
      sampled++;
      const pt = comp[i];
      for (let r = 0; r < rings.length; r++) {
        if (pointInRing(pt, rings[r].px)) {
          covered++;
          break;
        }
      }
    }
    if (sampled && covered / sampled >= MAX_COVER) continue;
    const hull = hullRingPx(comp, step);
    if (!hull || hull.length < 4) continue;
    if (ringPxArea(hull) <= 0) continue;
    const lonlat = hull.map(([x, y]) => imagePxToLl(x, y, frame));
    const areaHull = ringAreaM2(lonlat, frame.mpd);
    if (areaHull < minArea || areaHull > maxArea) continue;
    let borrowed = 0;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const area = ringAreaM2(ring.lonlat, frame.mpd);
      if (!(area > 0) || area > areaHull * 0.65) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      const open = ring.lonlat;
      const end =
        open.length > 1 && open[0][0] === open[open.length - 1][0] && open[0][1] === open[open.length - 1][1]
          ? open.length - 1
          : open.length;
      for (let i = 0; i < end; i++) {
        sx += open[i][0];
        sy += open[i][1];
        n++;
      }
      if (!n) continue;
      if (!pointInRing([sx / n, sy / n], lonlat)) continue;
      drop.add(ring.index);
      const h = featureHeight(features[ring.index]);
      if (h && !borrowed) borrowed = h;
    }
    if (!borrowed) borrowed = nearestMeasuredHeight(features, lonlat, frame);
    const props = { source: "imagery-roof" };
    if (borrowed) props.height = borrowed;
    out.push({
      type: "Feature",
      properties: props,
      geometry: { type: "Polygon", coordinates: [lonlat] },
    });
  }
  return { features: out, dropIndexes: Array.from(drop) };
}

/**
 * A dark panel roof is a solid rectangle, not the convex hull of every
 * dark pixel nearby. A campus shadow connects panels, roads, and trees
 * into one low-fill blob; the hull of that blob covers the golf course.
 * The rectangle has to sit against a footprint that is already on the map.
 * A tower height is not copied onto it.
 */
const DARK_RECT_MIN_M2 = 4500;
const DARK_RECT_MAX_M2 = 20000;
const DARK_RECT_MAX_ASPECT = 2.3;
const DARK_RECT_MIN_SIDE_M = 48;
const DARK_RECT_MAX_SIDE_M = 176;
const DARK_RECT_MIN_OCC = 0.68;
const DARK_RECT_MAX_Y = 64;
const DARK_RECT_MAX_COVER = 0.45;
const DARK_RECT_TOUCH_M = 40;
const DARK_RECT_CAP = 4;
const DARK_RECT_HEIGHT_M = 18;

function darkCell(rgb) {
  if (!rgb) return "skip";
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  const y = luma(r, g, b);
  if (g > r + 10 && g > b + 6 && g > 70) return "green";
  if (b > r + 12 && b > g + 4 && b > 45) return "water";
  if (y < 78) return "dark";
  return "other";
}

function meterRingsOf(features, frame) {
  const rings = [];
  const list = features || [];
  for (let i = 0; i < list.length; i++) {
    const exteriors = featureExteriorRings(list[i] && list[i].geometry);
    for (let r = 0; r < exteriors.length; r++) {
      const ring = exteriors[r];
      if (!ring || ring.length < 4) continue;
      const meters = [];
      for (let k = 0; k < ring.length; k++) {
        meters.push([(ring[k][0] - frame.west) * frame.mpd.lon, (ring[k][1] - frame.south) * frame.mpd.lat]);
      }
      rings.push({ lonlat: ring, meters });
    }
  }
  return rings;
}

function distPointSegM(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c2 = vx * vx + vy * vy;
  const t = c2 > 0 ? Math.max(0, Math.min(1, (vx * wx + vy * wy) / c2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function ringTouches(rectMeters, neighbors, touchM) {
  if (!neighbors.length) return false;
  for (let n = 0; n < neighbors.length; n++) {
    const ring = neighbors[n].meters;
    const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
    for (let i = 0; i < rectMeters.length; i++) {
      const p = rectMeters[i];
      if (pointInRing(p, ring)) return true;
      for (let k = 0; k < open; k++) {
        if (distPointSegM(p, ring[k], ring[(k + 1) % open]) <= touchM) return true;
      }
    }
    for (let k = 0; k < open; k++) {
      if (pointInRing(ring[k], rectMeters)) return true;
    }
  }
  return false;
}

function coverFraction(ringLonLat, neighbors) {
  const a = ringLonLat[0];
  const b = ringLonLat[1];
  const c = ringLonLat[2];
  const d = ringLonLat[3];
  if (!a || !b || !c || !d) return 1;
  let inside = 0;
  let n = 0;
  for (let i = 1; i <= 5; i++) {
    for (let j = 1; j <= 5; j++) {
      const u = i / 6;
      const v = j / 6;
      const lon = a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * u * v + d[0] * (1 - u) * v;
      const lat = a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * u * v + d[1] * (1 - u) * v;
      n++;
      for (let k = 0; k < neighbors.length; k++) {
        if (pointInRing([lon, lat], neighbors[k].lonlat)) {
          inside++;
          break;
        }
      }
    }
  }
  return n ? inside / n : 1;
}

function prefixSums(src, cols, rows) {
  const stride = cols + 1;
  const acc = new Float64Array((rows + 1) * stride);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      acc[(r + 1) * stride + (c + 1)] =
        (src[r * cols + c] || 0) + acc[r * stride + (c + 1)] + acc[(r + 1) * stride + c] - acc[r * stride + c];
    }
  }
  return acc;
}

function prefixRect(acc, cols, r0, r1, c0, c1) {
  const stride = cols + 1;
  return acc[r1 * stride + c1] - acc[r0 * stride + c1] - acc[r1 * stride + c0] + acc[r0 * stride + c0];
}

function closeDark(mask, cols, rows) {
  const n = cols * rows;
  const dil = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const rr = r + dy;
          const cc = c + dx;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          if (mask[rr * cols + cc]) on = 1;
        }
      }
      dil[r * cols + c] = on;
    }
  }
  const out = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let on = 1;
      for (let dy = -1; dy <= 1 && on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const rr = r + dy;
          const cc = c + dx;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || !dil[rr * cols + cc]) on = 0;
        }
      }
      out[r * cols + c] = on;
    }
  }
  return out;
}

function darkComponents(mask, cols, rows) {
  const seen = new Uint8Array(mask.length);
  const comps = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const q = [i];
    seen[i] = 1;
    const comp = [];
    while (q.length) {
      const k = q.pop();
      comp.push(k);
      const r = (k / cols) | 0;
      const c = k - r * cols;
      const nbrs = [k + 1, k - 1, k + cols, k - cols];
      const cs = [c + 1, c - 1, c, c];
      const rs = [r, r, r + 1, r - 1];
      for (let d = 0; d < 4; d++) {
        if (cs[d] < 0 || cs[d] >= cols || rs[d] < 0 || rs[d] >= rows) continue;
        const nk = nbrs[d];
        if (mask[nk] && !seen[nk]) {
          seen[nk] = 1;
          q.push(nk);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function searchDarkGrid(minE, maxE, minN, maxN, stepM, ux, uy, sampleAt) {
  const px = -uy;
  const py = ux;
  const corners = [
    [minE, minN],
    [maxE, minN],
    [maxE, maxN],
    [minE, maxN],
  ];
  let amin = Infinity;
  let amax = -Infinity;
  let pmin = Infinity;
  let pmax = -Infinity;
  for (let i = 0; i < corners.length; i++) {
    const along = corners[i][0] * ux + corners[i][1] * uy;
    const perp = corners[i][0] * px + corners[i][1] * py;
    if (along < amin) amin = along;
    if (along > amax) amax = along;
    if (perp < pmin) pmin = perp;
    if (perp > pmax) pmax = perp;
  }
  amin -= stepM;
  pmin -= stepM;
  const rows = Math.ceil((amax - amin) / stepM);
  const cols = Math.ceil((pmax - pmin) / stepM);
  if (rows < 8 || cols < 8 || rows > 48 || cols > 48) return null;
  const n = rows * cols;
  const dark = new Float64Array(n);
  const ysum = new Float64Array(n);
  const water = new Float64Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const along = amin + (r + 0.5) * stepM;
      const perp = pmin + (c + 0.5) * stepM;
      const east = along * ux + perp * px;
      const north = along * uy + perp * py;
      const sample = sampleAt(east, north);
      if (!sample) continue;
      const k = r * cols + c;
      ysum[k] = sample.y;
      if (sample.dark) dark[k] = 1;
      if (sample.water) water[k] = 1;
    }
  }
  const darkSum = prefixSums(dark, cols, rows);
  const ySum = prefixSums(ysum, cols, rows);
  const waterSum = prefixSums(water, cols, rows);
  const minCells = Math.ceil(DARK_RECT_MIN_SIDE_M / stepM);
  const maxCells = Math.floor(DARK_RECT_MAX_SIDE_M / stepM);
  let best = null;
  for (let r0 = 0; r0 < rows; r0++) {
    const r1Max = Math.min(rows, r0 + maxCells);
    for (let r1 = r0 + minCells; r1 <= r1Max; r1++) {
      const height = (r1 - r0) * stepM;
      for (let c0 = 0; c0 < cols; c0++) {
        const c1Max = Math.min(cols, c0 + maxCells);
        for (let c1 = c0 + minCells; c1 <= c1Max; c1++) {
          const width = (c1 - c0) * stepM;
          const aspect = Math.max(width, height) / Math.min(width, height);
          if (aspect > DARK_RECT_MAX_ASPECT) continue;
          const area = width * height;
          if (area < DARK_RECT_MIN_M2 || area > DARK_RECT_MAX_M2) continue;
          if (best && area <= best.area) continue;
          const cellsN = (r1 - r0) * (c1 - c0);
          const occ = prefixRect(darkSum, cols, r0, r1, c0, c1) / cellsN;
          if (occ < DARK_RECT_MIN_OCC) continue;
          const meanY = prefixRect(ySum, cols, r0, r1, c0, c1) / cellsN;
          if (meanY > DARK_RECT_MAX_Y) continue;
          const waterFrac = prefixRect(waterSum, cols, r0, r1, c0, c1) / cellsN;
          if (waterFrac > 0.1) continue;
          best = { r0, r1, c0, c1, area, occ, meanY, amin, pmin, ux, uy, px, py, stepM };
        }
      }
    }
  }
  return best;
}

function rectLonLat(rect, frame) {
  const corners = [
    [rect.r0, rect.c0],
    [rect.r1, rect.c0],
    [rect.r1, rect.c1],
    [rect.r0, rect.c1],
  ];
  const ring = [];
  for (let i = 0; i < corners.length; i++) {
    const along = rect.amin + corners[i][0] * rect.stepM;
    const perp = rect.pmin + corners[i][1] * rect.stepM;
    const east = along * rect.ux + perp * rect.px;
    const north = along * rect.uy + perp * rect.py;
    ring.push([frame.west + east / frame.mpd.lon, frame.south + north / frame.mpd.lat]);
  }
  ring.push(ring[0].slice());
  return ring;
}

function darkRectRoofs(raw, frame, features) {
  // Dark pixels are tower shadow, roads, and trees as often as a roof.
  // This pass must not invent a building from them.
  void raw;
  void frame;
  void features;
  return { features: [] };
}

/** Dark pixels are not a roof. A skipped 6 MP decode does not invent one. */
function darkPanelsWhenRoofFillSkipped(decoded, roofRaw, frame, features) {
  if (decoded) return { features: [] };
  return darkRectRoofs(roofRaw, frame, features);
}

function supplementFootprints(raw, frame, features) {
  const found = imageryRoofFeatures(raw, frame, features || []);
  const drop = new Set(found.dropIndexes || []);
  const kept = [];
  const list = features || [];
  for (let i = 0; i < list.length; i++) {
    if (!drop.has(i)) kept.push(list[i]);
  }
  const withBright = kept.concat(found.features);
  const membrane = imageryRoofFeatures(raw, frame, withBright, "membrane");
  const membraneDrop = new Set(membrane.dropIndexes || []);
  const afterMembrane = [];
  for (let i = 0; i < withBright.length; i++) {
    if (!membraneDrop.has(i)) afterMembrane.push(withBright[i]);
  }
  const dark = darkRectRoofs(raw, frame, afterMembrane);
  return {
    features: afterMembrane.concat(membrane.features, dark.features),
    imageryRoofs: found.features.length + membrane.features.length + dark.features.length,
    droppedStubs: (found.dropIndexes || []).length + membraneDrop.size,
  };
}

module.exports = {
  MIN_ROOF_M2,
  MIN_MEMBRANE_M2,
  imageryRoofFeatures,
  darkRectRoofs,
  darkPanelsWhenRoofFillSkipped,
  supplementFootprints,
  imagePxToLl,
  pointInRing,
};
