"use strict";

/**
 * Water and major-pavement masks from the Esri World Imagery JPEG already
 * decoded for roof fill.
 *
 * NLCD Tree Canopy Cover is a percent, not a land-cover class, and the public
 * NLCD land-cover ImageServer requires a token. Open water is therefore read
 * from the aerial: blue/teal pixels, plus dark smooth ponds that are clearly
 * bluer than a building shadow. A charcoal panel roof is dark and only
 * slightly blue, so it stays out of the water mask. Woody wetland stays
 * canopy — it is trees.
 *
 * Major pavement is optional suppression, not a footprint. Smooth mid-gray
 * regions above ~2000 m² (empty asphalt / concrete) are subtracted. Car-filled
 * stalls and mixed 30 m canopy cells stay; that leftover hardscape bleed is
 * expected.
 */

const STRIDE = 2;
const MIN_WATER_M2 = 220;
const MIN_DARK_WATER_M2 = 550;
const MIN_PAVEMENT_M2 = 2000;

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function localStd(data, w, h, x, y) {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  const offs = [
    [0, 0],
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
    [3, 3],
    [-3, 2],
  ];
  for (let k = 0; k < offs.length; k++) {
    const xx = x + offs[k][0];
    const yy = y + offs[k][1];
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const i = (yy * w + xx) * 4;
    const Y = luma(data[i], data[i + 1], data[i + 2]);
    n++;
    sum += Y;
    sum2 += Y * Y;
  }
  if (!n) return 99;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

/**
 * Dark spruce and a shadowed conifer. Green stays above blue, so a pond
 * that is actually blue does not match. A uniform dark crown still matches:
 * texture is not required here.
 */
function coniferPixel(r, g, b) {
  const Y = luma(r, g, b);
  const exg = 2 * g - r - b;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc ? (maxc - minc) / maxc : 0;
  return Y >= 28 && Y <= 80 && g >= r + 6 && g >= b + 6 && exg >= 18 && sat >= 0.18 && b + 2 < g;
}

/**
 * Smooth open ground: a mown lawn, a tan RV pitch or dirt track, or pavement.
 * A dark conifer and a textured crown are not open ground. The caller passes
 * the local luma spread so a rough canopy is not read as grass.
 * @returns {""|"lawn"|"pitch"|"road"}
 */
function openGroundPixel(r, g, b, std) {
  if (coniferPixel(r, g, b)) return "";
  if (std >= 11) return "";
  const Y = luma(r, g, b);
  const exg = 2 * g - r - b;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc ? (maxc - minc) / maxc : 0;
  if (Y >= 108 && Y <= 198 && sat < 0.13 && exg < 7 && std < 10.5) return "road";
  if (Y >= 70 && Y <= 190 && r + 10 >= g && g >= b + 8 && exg < 22 && sat >= 0.08 && sat <= 0.62 && r >= 70 && std < 11) {
    return "pitch";
  }
  if (Y >= 78 && Y <= 220 && g >= r + 4 && g + 2 >= b && exg >= 14 && sat >= 0.06 && std < 9) return "lawn";
  return "";
}

function classifyPixel(r, g, b, std) {
  const Y = luma(r, g, b);
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc ? (maxc - minc) / maxc : 0;
  const exg = 2 * g - r - b;
  // A dark green crown is canopy. It is not a pond and not a building shadow.
  if (coniferPixel(r, g, b)) return 0;
  if (g >= b && g > r + 4 && exg > 8 && std >= 8) return 0;
  const blue = b > r + 10 && b + 3 >= g && g + 8 >= r && Y > 22 && Y < 130 && sat > 0.1 && exg < 24;
  if (blue && std < 18) return 1;
  const darkPond =
    Y >= 24 &&
    Y <= 62 &&
    b > r + 8 &&
    b > g + 2 &&
    g + 4 >= r &&
    exg < 10 &&
    sat < 0.5 &&
    sat > 0.08 &&
    std < 8;
  if (darkPond) return 1;
  const pavement = Y >= 108 && Y <= 198 && sat < 0.13 && exg < 7 && std < 10.5 && b < r + 14;
  if (pavement) return 2;
  return 0;
}

function keepSupported(grid, cols, rows, cls) {
  const out = new Uint8Array(grid.length);
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      if (grid[i] !== cls) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (grid[(y + dy) * cols + (x + dx)] === cls) n++;
        }
      }
      if (n >= 4) out[i] = cls;
    }
  }
  return out;
}

function flood(grid, cols, rows, cls) {
  const labels = new Int32Array(grid.length);
  const comps = [];
  let next = 1;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== cls || labels[i]) continue;
    const cells = [];
    const stack = [i];
    labels[i] = next;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const x = c % cols;
      const y = (c / cols) | 0;
      const nbr = [];
      if (x > 0) nbr.push(c - 1);
      if (x + 1 < cols) nbr.push(c + 1);
      if (y > 0) nbr.push(c - cols);
      if (y + 1 < rows) nbr.push(c + cols);
      for (let k = 0; k < nbr.length; k++) {
        const n = nbr[k];
        if (grid[n] === cls && !labels[n]) {
          labels[n] = next;
          stack.push(n);
        }
      }
    }
    comps.push(cells);
    next++;
  }
  return comps;
}

function chainRings(cells, cols, rows) {
  const set = new Set(cells);
  const edges = [];
  const addEdge = (x0, y0, x1, y1) => {
    edges.push({ id: x0 + "," + y0 + "," + x1 + "," + y1, x0, y0, x1, y1 });
  };
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const x = c % cols;
    const y = (c / cols) | 0;
    // Circuit around the cell so a missing neighbor leaves one directed edge.
    if (y === 0 || !set.has(c - cols)) addEdge(x, y, x + 1, y);
    if (x + 1 === cols || !set.has(c + 1)) addEdge(x + 1, y, x + 1, y + 1);
    if (y + 1 === rows || !set.has(c + cols)) addEdge(x + 1, y + 1, x, y + 1);
    if (x === 0 || !set.has(c - 1)) addEdge(x, y + 1, x, y);
  }
  return chainEdges(edges);
}

function chainEdges(edges) {
  const from = new Map();
  for (const e of edges) {
    const k = e.x0 + "," + e.y0;
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(e);
  }
  const used = new Set();
  const rings = [];
  for (const e0 of edges) {
    if (used.has(e0.id)) continue;
    const ring = [[e0.x0, e0.y0]];
    let cur = e0;
    used.add(e0.id);
    let closed = false;
    for (let guard = 0; guard < edges.length + 2; guard++) {
      if (cur.x1 === ring[0][0] && cur.y1 === ring[0][1]) {
        closed = true;
        break;
      }
      const opts = from.get(cur.x1 + "," + cur.y1) || [];
      let next = null;
      for (const cand of opts) {
        if (!used.has(cand.id)) {
          next = cand;
          break;
        }
      }
      if (!next) break;
      used.add(next.id);
      ring.push([next.x0, next.y0]);
      cur = next;
    }
    if (closed && ring.length >= 4) {
      ring.push(ring[0]);
      rings.push(ring);
    }
  }
  return rings;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

function simplifyClosed(ring, eps, maxVerts) {
  // Local Douglas–Peucker so this file does not depend on the clip module's
  // private simplifier. eps is in pixels.
  const open =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  if (open.length <= maxVerts) return open.concat([open[0]]);
  let cur = open.concat([open[0]]);
  let tol = eps;
  for (let k = 0; k < 8 && cur.length - 1 > maxVerts; k++) {
    cur = dp(cur, tol * tol);
    tol *= 1.6;
  }
  if (cur.length - 1 > maxVerts) {
    const step = Math.ceil((cur.length - 1) / maxVerts);
    const thin = [];
    for (let i = 0; i < cur.length - 1 && thin.length < maxVerts; i += step) thin.push(cur[i]);
    cur = thin.concat([thin[0]]);
  }
  return cur;
}

function dp(pts, eps2) {
  if (pts.length <= 2) return pts;
  let maxI = 0;
  let maxD = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1e-12;
    let t = ((pts[i][0] - a[0]) * vx + (pts[i][1] - a[1]) * vy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const dx = pts[i][0] - (a[0] + t * vx);
    const dy = pts[i][1] - (a[1] + t * vy);
    const d = dx * dx + dy * dy;
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps2) {
    const left = dp(pts.slice(0, maxI + 1), eps2);
    const right = dp(pts.slice(maxI), eps2);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function toYUpRing(indexRing, stride, imgH) {
  const pts = indexRing.map(([ix, iy]) => [ix * stride, imgH - iy * stride]);
  if (signedArea(pts) < 0) {
    const open = pts.slice(0, -1).reverse();
    return open.concat([open[0]]);
  }
  return pts;
}

function componentPolygon(cells, cols, rows, stride, imgH, data, width) {
  const indexRings = chainRings(cells, cols, rows);
  if (!indexRings.length) return null;
  const yUp = indexRings
    .map((r) => toYUpRing(r, stride, imgH))
    .filter((r) => r.length >= 4 && Math.abs(signedArea(r)) > 4);
  if (!yUp.length) return null;
  yUp.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  const outer = simplifyClosed(yUp[0], 1.8, 32);
  if (outer.length < 4) return null;
  const holes = [];
  for (let i = 1; i < yUp.length; i++) {
    const hole = simplifyClosed(yUp[i], 1.8, 20);
    if (Math.abs(signedArea(hole)) < 30) continue;
    // Opposite winding from the outer ring.
    if (signedArea(hole) > 0) {
      const open = hole.slice(0, -1).reverse();
      holes.push(open.concat([open[0]]));
    } else holes.push(hole);
  }
  let blue = 0;
  let ySum = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(cells.length / 10));
  for (let i = 0; i < cells.length; i += step) {
    const c = cells[i];
    const x = (c % cols) * stride + (stride >> 1);
    const y = ((c / cols) | 0) * stride + (stride >> 1);
    if (x < 0 || y < 0 || x >= width || y >= data.length / (width * 4)) continue;
    const pi = (y * width + x) * 4;
    const r = data[pi];
    const g = data[pi + 1];
    const b = data[pi + 2];
    blue += b - r;
    ySum += luma(r, g, b);
    n++;
  }
  const bb = ringBounds(outer);
  return {
    polygon: [outer].concat(holes),
    areaPx: Math.abs(signedArea(outer)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0),
    bbox: bb,
    meanY: n ? ySum / n : 0,
    meanBlue: n ? blue / n : 0,
  };
}

function ringBounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * @param {{data: Uint8Array, width: number, height: number}} decoded JPEG RGBA
 * @param {{imgW: number, imgH: number, mpuX: number, mpuY: number}} frame
 */
function surfaceMasksFromImage(decoded, frame) {
  const empty = { waterRings: [], pavementPolygons: [], waterM2: 0, pavementM2: 0 };
  if (!decoded || !decoded.data || !frame) return empty;
  const width = decoded.width;
  const height = decoded.height;
  if (width !== frame.imgW || height !== frame.imgH) return empty;
  const cols = Math.ceil(width / STRIDE);
  const rows = Math.ceil(height / STRIDE);
  const raw = new Uint8Array(cols * rows);
  const data = decoded.data;
  for (let y = 0; y < rows; y++) {
    const py = Math.min(height - 1, y * STRIDE + (STRIDE >> 1));
    for (let x = 0; x < cols; x++) {
      const px = Math.min(width - 1, x * STRIDE + (STRIDE >> 1));
      const i = (py * width + px) * 4;
      const std = localStd(data, width, height, px, py);
      raw[y * cols + x] = classifyPixel(data[i], data[i + 1], data[i + 2], std);
    }
  }
  const waterGrid = keepSupported(raw, cols, rows, 1);
  const paveGrid = keepSupported(raw, cols, rows, 2);
  const m2PerCell = STRIDE * STRIDE * (frame.mpuX || 1) * (frame.mpuY || 1);
  const waterRings = [];
  let waterM2 = 0;
  for (const cells of flood(waterGrid, cols, rows, 1)) {
    const areaM2 = cells.length * m2PerCell;
    const comp = componentPolygon(cells, cols, rows, STRIDE, frame.imgH, data, width);
    if (!comp || comp.areaPx < 20) continue;
    const fill = comp.bbox.w > 0 && comp.bbox.h > 0 ? comp.areaPx / (comp.bbox.w * comp.bbox.h) : 0;
    if (comp.bbox.w < 8 || comp.bbox.h < 8 || fill < 0.28) continue;
    const dark = comp.meanY <= 70;
    if (dark) {
      if (areaM2 < MIN_DARK_WATER_M2 || comp.meanBlue < 2) continue;
    } else if (areaM2 < MIN_WATER_M2 || comp.meanBlue < 6) continue;
    waterRings.push(comp.polygon[0]);
    waterM2 += areaM2;
  }
  const pavementPolygons = [];
  let pavementM2 = 0;
  for (const cells of flood(paveGrid, cols, rows, 2)) {
    const areaM2 = cells.length * m2PerCell;
    if (areaM2 < MIN_PAVEMENT_M2) continue;
    const comp = componentPolygon(cells, cols, rows, STRIDE, frame.imgH, data, width);
    if (!comp) continue;
    const fill = comp.bbox.w > 0 && comp.bbox.h > 0 ? comp.areaPx / (comp.bbox.w * comp.bbox.h) : 0;
    if (fill < 0.35 || comp.bbox.w < 18 || comp.bbox.h < 12) continue;
    pavementPolygons.push(comp.polygon);
    pavementM2 += areaM2;
  }
  return { waterRings, pavementPolygons, waterM2, pavementM2 };
}

// Feedback #13: a mapped pond whose photo water is green (algae) reads as a
// dark conifer, and its OSM outline can sit metres off the photo pond, so
// shoreline canopy stood in the water. The photo water connected to each
// mapped water outline becomes a water ring that foliage is cut around.
const SEED_PAD_M = 20;
const SEED_SHARE = 0.2;
const SEED_MIN_M2 = 50;
const SEED_COLOR_DIST = 35;
const SEED_STD_MAX = 12;
const SEED_MAX_POLYS = 40;

/** Pond water colour: algae green with almost no red, or blue to teal. */
function pondWaterPixel(r, g, b) {
  const Y = luma(r, g, b);
  if (g > r + 25 && g > b + 25 && r < 60 && Y < 110) return true;
  return b > r + 10 && b + 3 >= g && Y < 130;
}

function ringInsidePx(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Photo water around mapped water outlines. Inside each outline the pixels
 * that look like pond water (at least SEED_SHARE of it and SEED_MIN_M2) give
 * the pond's colour; from them the region grows over smooth pixels of that
 * colour up to SEED_PAD_M past the outline. A crown on the bank is textured
 * and not pond coloured, so it stays.
 * @param {{data: Uint8Array, width: number, height: number}} decoded JPEG RGBA
 * @param {object} frame geo frame (west, east, south, north, imgW, imgH, mpuX, mpuY)
 * @param {Array<Array<Array<[number, number]>>>} waterPolys [outer, ...inner] lon/lat rings
 * @returns {Array<Array<[number, number]>>} OI (y-up) pixel rings
 */
function osmWaterRings(decoded, frame, waterPolys) {
  if (!decoded || !decoded.data || !frame || !Array.isArray(waterPolys) || !waterPolys.length) return [];
  const width = decoded.width;
  const height = decoded.height;
  if (width !== frame.imgW || height !== frame.imgH) return [];
  const { llToImagePx } = require("./geo-frame");
  const mpu = Math.max(0.05, Math.min(frame.mpuX || 1, frame.mpuY || 1));
  const data = decoded.data;
  const cellM2 = STRIDE * STRIDE * (frame.mpuX || mpu) * (frame.mpuY || mpu);
  const padPx = Math.round(SEED_PAD_M / mpu);
  const polys = [];
  for (let i = 0; i < waterPolys.length; i++) {
    const rings = waterPolys[i];
    if (!Array.isArray(rings) || !rings[0] || rings[0].length < 4) continue;
    const px = rings.map((r) => r.map((p) => llToImagePx(p[0], p[1], frame)));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of px[0]) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    x0 = Math.max(0, Math.floor(x0) - padPx);
    y0 = Math.max(0, Math.floor(y0) - padPx);
    x1 = Math.min(width - 1, Math.ceil(x1) + padPx);
    y1 = Math.min(height - 1, Math.ceil(y1) + padPx);
    if (x1 - x0 < 8 || y1 - y0 < 8) continue;
    polys.push({ px, x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) });
  }
  polys.sort((a, b) => a.area - b.area);
  const out = [];
  for (let pi = 0; pi < polys.length && pi < SEED_MAX_POLYS; pi++) {
    const P = polys[pi];
    const cols = Math.ceil((P.x1 - P.x0 + 1) / STRIDE);
    const rows = Math.ceil((P.y1 - P.y0 + 1) / STRIDE);
    if (cols * rows > 1500000) continue;
    const R = new Float32Array(cols * rows);
    const G = new Float32Array(cols * rows);
    const B = new Float32Array(cols * rows);
    const smooth = new Uint8Array(cols * rows);
    const cand = new Uint8Array(cols * rows);
    const inside = new Uint8Array(cols * rows);
    let nIn = 0;
    let nSeed = 0;
    for (let y = 0; y < rows; y++) {
      const py = Math.min(height - 1, P.y0 + y * STRIDE + (STRIDE >> 1));
      for (let x = 0; x < cols; x++) {
        const px = Math.min(width - 1, P.x0 + x * STRIDE + (STRIDE >> 1));
        // Mean colour over 5 x 5 pixels: the photo's grain on a pond is
        // a few levels either way.
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        let s1 = 0;
        let s2 = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = px + dx;
            if (xx < 0 || xx >= width) continue;
            const i = (yy * width + xx) * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            const Y = luma(data[i], data[i + 1], data[i + 2]);
            s1 += Y;
            s2 += Y * Y;
            n++;
          }
        }
        const k = y * cols + x;
        R[k] = r / n;
        G[k] = g / n;
        B[k] = b / n;
        const m = s1 / n;
        smooth[k] = Math.sqrt(Math.max(0, s2 / n - m * m)) < SEED_STD_MAX ? 1 : 0;
        cand[k] = pondWaterPixel(R[k], G[k], B[k]) ? 1 : 0;
        let ins = ringInsidePx(px, py, P.px[0]);
        for (let h = 1; ins && h < P.px.length; h++) if (P.px[h].length >= 4 && ringInsidePx(px, py, P.px[h])) ins = false;
        if (ins) {
          inside[k] = 1;
          nIn++;
          if (cand[k]) nSeed++;
        }
      }
    }
    if (!nIn || nSeed / nIn < SEED_SHARE || nSeed * cellM2 < SEED_MIN_M2) continue;
    // Pond colour: the median of the seeds inside the outline.
    const rs = [];
    const gs = [];
    const bs = [];
    for (let k = 0; k < cols * rows; k++) {
      if (inside[k] && cand[k]) {
        rs.push(R[k]);
        gs.push(G[k]);
        bs.push(B[k]);
      }
    }
    const med = (a) => a.sort((u, v) => u - v)[a.length >> 1];
    const ref = [med(rs), med(gs), med(bs)];
    const grow = new Uint8Array(cols * rows);
    for (let k = 0; k < cols * rows; k++) {
      if (!smooth[k]) continue;
      const d = Math.hypot(R[k] - ref[0], G[k] - ref[1], B[k] - ref[2]);
      if (cand[k] || d < SEED_COLOR_DIST) grow[k] = 1;
    }
    // Opening by one cell drops one-cell bridges into the bank.
    const opened = new Uint8Array(cols * rows);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const k = y * cols + x;
        if (grow[k] && grow[k - 1] && grow[k + 1] && grow[k - cols] && grow[k + cols]) opened[k] = 1;
      }
    }
    const water = new Uint8Array(cols * rows);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const k = y * cols + x;
        if (grow[k] && (opened[k] || opened[k - 1] || opened[k + 1] || opened[k - cols] || opened[k + cols])) water[k] = 1;
      }
    }
    for (const cells of flood(water, cols, rows, 1)) {
      let seeded = 0;
      for (let c = 0; c < cells.length; c++) if (inside[cells[c]] && cand[cells[c]]) seeded++;
      if (seeded * cellM2 < SEED_MIN_M2) continue;
      const comp = componentPolygon(cells, cols, rows, STRIDE, P.y1 - P.y0 + 1, data, width);
      if (!comp) continue;
      // componentPolygon works in the window; move it to the full image (y up).
      const ring = comp.polygon[0].map(([x, yUp]) => [x + P.x0, height - (P.y1 - P.y0 + 1 - yUp) - P.y0]);
      out.push(ring);
    }
  }
  return out;
}

/**
 * Share of a ring's aerial pixels that read as open ground (lawn, paving,
 * pitch). Ring is OI pixels, y measured up from the image bottom.
 */
function openShareSampler(image) {
  if (!image || !image.data || !(image.width > 0) || !(image.height > 0)) return null;
  const { data, width: w, height: h } = image;
  return function openShare(ring) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 14));
    let n = 0;
    let open = 0;
    for (let y = Math.ceil(y0); y <= y1; y += step) {
      for (let x = Math.ceil(x0); x <= x1; x += step) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (!inside) continue;
        const row = h - 1 - Math.round(y);
        const col = Math.round(x);
        if (row < 0 || row >= h || col < 0 || col >= w) continue;
        const k = (row * w + col) * 4;
        n++;
        if (openGroundPixel(data[k], data[k + 1], data[k + 2], localStd(data, w, h, col, row))) open++;
      }
    }
    return n >= 6 ? open / n : 0;
  };
}

/**
 * Thin-shadow test for a pole at OI pixel (x, y), y up. Walks rays from the
 * foot out to about the pole's height and keeps the darkest one: a pole casts
 * a line a few pixels wide that is clearly darker than the ground either side.
 * Returns that contrast (0 to 1), or null if the photo is too coarse.
 */
function poleShadowContrast(image, x, y, heightM, mpp) {
  if (!image || !image.data || !(mpp > 0) || mpp > 0.35) return null;
  const { data, width: w, height: h } = image;
  const lum = (xx, yy) => {
    const col = Math.round(xx);
    const row = h - 1 - Math.round(yy);
    if (col < 0 || row < 0 || col >= w || row >= h) return null;
    const k = (row * w + col) * 4;
    return 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  };
  const r0 = 0.6 / mpp;
  const r1 = Math.max(3, 0.7 * Math.min(heightM, 25)) / mpp;
  // An evergreen beside the spot: a tree, not a pole.
  const rg = 2 / mpp;
  let gn = 0;
  let gg = 0;
  for (let yy = Math.floor(y - rg); yy <= y + rg; yy += 2) {
    for (let xx = Math.floor(x - rg); xx <= x + rg; xx += 2) {
      if ((xx - x) * (xx - x) + (yy - y) * (yy - y) > rg * rg) continue;
      const col = xx;
      const row = h - 1 - yy;
      if (col < 0 || row < 0 || col >= w || row >= h) continue;
      const k = (row * w + col) * 4;
      const R = data[k], G = data[k + 1], B = data[k + 2];
      gn++;
      if ((G >= 25 && G >= R * 1.08 && G >= B * 1.08) || (G >= R + 6 && G >= B + 6 && 2 * G - R - B >= 14)) gg++;
    }
  }
  if (gn && gg / gn >= 0.1) return 0;
  const side = 1.2 / mpp;
  let best = 0;
  for (let t = 0; t < 360; t++) {
    const a = (Math.PI * 2 * t) / 360;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let on = 0;
    let off = 0;
    let n = 0;
    let dark = 0;
    for (let r = r0; r <= r1; r += 1) {
      const px = x + ux * r;
      const py = y + uy * r;
      // The line is a few pixels wide: take the darkest pixel across it.
      let c = null;
      for (let q = -2; q <= 2; q++) {
        const v = lum(px - uy * q, py + ux * q);
        if (v != null && (c == null || v < c)) c = v;
      }
      const s1 = lum(px - uy * side, py + ux * side);
      const s2 = lum(px + uy * side, py - ux * side);
      if (c == null || s1 == null || s2 == null) continue;
      n++;
      on += c;
      off += (s1 + s2) / 2;
      if (c < 0.85 * Math.min(s1, s2)) dark++;
    }
    if (n < 8 || !(off > 0)) continue;
    // Most of the ray must be darker than both sides, not one dark patch.
    if (dark < 0.4 * n) continue;
    const contrast = 1 - on / off;
    if (contrast > best) best = contrast;
  }
  return best;
}

module.exports = {
  osmWaterRings,
  pondWaterPixel,
  poleShadowContrast,
  openShareSampler,
  surfaceMasksFromImage,
  MIN_WATER_M2,
  MIN_PAVEMENT_M2,
  classifyPixel,
  coniferPixel,
  openGroundPixel,
  localStd,
  luma,
};
