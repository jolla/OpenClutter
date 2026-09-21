"use strict";

/**
 * Imagery roof fill for large commercial roofs missing from Microsoft Global ML,
 * MSBFP2, and FEMA USA Structures.
 *
 * Method (validated in eval by deleting the known Oak Creek white-roof polygon
 * and requiring the mask to put it back on the Esri JPEG):
 *   1. Keep pixels that are bright, low-saturation, and locally smooth
 *      (membrane / metal roofs, not textured canopy, not car-filled asphalt).
 *   2. Connected components whose area is at least ~2500 m².
 *   3. Reject long thin components (roads) and low fill (speckle).
 *   4. If existing footprint rings already cover most of the component, skip it.
 *   5. Otherwise emit the convex hull as a GeoJSON polygon. A much smaller
 *      vector whose centroid sits inside that hull is a partial stub and is
 *      dropped so the full outline replaces it.
 * OSM building rings are not read.
 */

const { featureExteriorRings, ringAreaM2, simplifyDP } = require("./pipeline");

const MIN_ROOF_M2 = 2500;
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

function roofCells(raw, step) {
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
      if (Y < 186) continue;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      if (sat > 0.12) continue;
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
      if (std > 9.5 || mean < 182) continue;
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
function imageryRoofFeatures(raw, frame, features) {
  if (!raw || !raw.data || !frame || !(raw.width > 8) || !(raw.height > 8)) {
    return { features: [], dropIndexes: [] };
  }
  const step = Math.max(raw.width, raw.height) > 1400 ? 4 : 3;
  const { cells, set } = roofCells(raw, step);
  if (!cells.length) return { features: [], dropIndexes: [] };
  const rings = existingImageRings(features, frame);
  const m2PerCell = step * step * frame.mpuX * frame.mpuY;
  const comps = componentsOf(cells, set, step);
  const out = [];
  const drop = new Set();
  for (let c = 0; c < comps.length; c++) {
    const comp = comps[c];
    const areaM = comp.length * m2PerCell;
    if (areaM < MIN_ROOF_M2) continue;
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
    if (aspect > MAX_ASPECT) continue;
    const fill = (comp.length * step * step) / (bw * bh);
    if (fill < MIN_FILL) continue;
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
    if (areaHull < MIN_ROOF_M2 || areaHull > 150000) continue;
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

function supplementFootprints(raw, frame, features) {
  const found = imageryRoofFeatures(raw, frame, features || []);
  const drop = new Set(found.dropIndexes || []);
  const kept = [];
  const list = features || [];
  for (let i = 0; i < list.length; i++) {
    if (!drop.has(i)) kept.push(list[i]);
  }
  return {
    features: kept.concat(found.features),
    imageryRoofs: found.features.length,
    droppedStubs: drop.size,
  };
}

module.exports = {
  MIN_ROOF_M2,
  imageryRoofFeatures,
  supplementFootprints,
  imagePxToLl,
  pointInRing,
};
