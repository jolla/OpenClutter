"use strict";

/**
 * Prototype splits for wide foliage stands (feedback #9: large forests read
 * as a grid of 50 m squares in Hamina). Both are behind export-mode switches
 * that are off by default.
 *
 * canopyBands: cut the stand along its own canopy height bands, read from
 * the canopy height grid, so seams follow the real trees.
 * mergeTiles: keep the 50 m tiles but merge neighbours whose heights agree.
 */

const polygonClipping = require("polygon-clipping");
const { pxToLl } = require("./geo-frame");

// canopyBands
const BAND_CELL_M = 2; // grid read every 2 m
const BAND_MAX_CELLS = 60000; // coarser cells on a very large stand
const BAND_M = 3; // one band per 3 m of canopy height
const BAND_MIN_PIECE_M2 = 400; // a piece smaller than about 20 x 20 m joins its neighbour
const BAND_SIMPLIFY_M = 1.5; // outline tolerance
const BAND_MODE_PASSES = 2;
// A wide polygon stand (woods outline, not the canopy grid trace) reads its
// heights from the bilinear canopy sample, so its band edges are noisier.
const BAND_VEG_MIN_PIECE_M2 = 600;
// scrubGaps: open ground inside a stand, at least this big after an
// opening of GAP_OPEN_CELLS cells, is left out of the stand.
const GAP_MIN_M2 = 150;
const GAP_OPEN_CELLS = 2;
// A band or merged piece is cut through any hole this big (see holeFreeGroups).
const HOLE_MIN_M2 = 100;

// mergeTiles
const MERGE_TOL_M = 2.5; // a neighbour joins when its height is within 2.5 m of the first tile

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a) / 2;
}

const snap = (v) => Math.round(v * 100) / 100;

function closeRing(pts) {
  if (!pts || pts.length < 3) return null;
  const out = [];
  for (const p of pts) {
    const q = [snap(p[0]), snap(p[1])];
    const last = out[out.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    out.push(q);
  }
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}

function perpDist2(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = p[0] - (a[0] + t * vx);
  const dy = p[1] - (a[1] + t * vy);
  return dx * dx + dy * dy;
}

function dp(pts, eps2) {
  if (pts.length <= 2) return pts;
  let maxI = 0;
  let maxD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist2(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps2) {
    const l = dp(pts.slice(0, maxI + 1), eps2);
    const r = dp(pts.slice(maxI), eps2);
    return l.slice(0, -1).concat(r);
  }
  return [pts[0], pts[pts.length - 1]];
}

/** Douglas-Peucker on a closed ring, split at the far point so the start corner is not fixed. */
function simplifyClosed(ring, eps) {
  const c = closeRing(ring);
  if (!c) return null;
  const open = c.slice(0, -1);
  if (open.length < 4 || !(eps > 0)) return c;
  let far = 0;
  let fd = -1;
  for (let i = 1; i < open.length; i++) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = dp(open.slice(0, far + 1), eps * eps);
  const b = dp(open.slice(far).concat([open[0]]), eps * eps);
  const out = a.slice(0, -1).concat(b.slice(0, -1));
  return out.length >= 3 ? closeRing(out) : null;
}

/** Split polygons with holes into hole-free pieces with straight cuts through each hole. */
function hollowFree(multi, depth) {
  const out = [];
  for (const poly of multi || []) {
    if (!poly || !poly[0] || poly[0].length < 4) continue;
    if (poly.length === 1) {
      out.push(poly[0]);
      continue;
    }
    if ((depth || 0) > 8) {
      out.push(poly[0]);
      continue;
    }
    const hole = poly[1];
    let cx = 0;
    for (let i = 0; i < hole.length - 1; i++) cx += hole[i][0];
    cx /= Math.max(1, hole.length - 1);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly[0]) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    const box = (x0, x1) => [[[x0, minY - 1], [x1, minY - 1], [x1, maxY + 1], [x0, maxY + 1], [x0, minY - 1]]];
    try {
      const l = polygonClipping.intersection([poly], box(minX - 1, cx));
      const r = polygonClipping.intersection([poly], box(cx, maxX + 1));
      out.push(...hollowFree(l, (depth || 0) + 1), ...hollowFree(r, (depth || 0) + 1));
    } catch {
      out.push(poly[0]);
    }
  }
  return out;
}

/** Cells of a ring on an axis grid, by scanline. */
function rasterRing(ring, minX, minY, sx, sy, nx, ny) {
  const inside = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const py = minY + (y + 0.5) * sy;
    const xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      if (a[1] > py !== b[1] > py) xs.push(a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil((xs[k] - minX) / sx - 0.5));
      const x1 = Math.min(nx - 1, Math.floor((xs[k + 1] - minX) / sx - 0.5));
      for (let x = x0; x <= x1; x++) inside[y * nx + x] = 1;
    }
  }
  return inside;
}

function components(label, nx, ny, skip) {
  const comp = new Int32Array(nx * ny).fill(-1);
  const list = [];
  for (let i = 0; i < label.length; i++) {
    if (comp[i] >= 0 || label[i] === skip) continue;
    const id = list.length;
    const cells = [];
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const x = k % nx;
      const y = (k / nx) | 0;
      const nb = [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1];
      for (const q of nb) {
        if (q >= 0 && comp[q] < 0 && label[q] === label[i]) {
          comp[q] = id;
          stack.push(q);
        }
      }
    }
    list.push({ id, band: label[i], cells });
  }
  return { comp, list };
}

/** Polygon (with holes) of a cell set: row runs, stacked into boxes, then one union. */
function cellsToMulti(cells, nx, minX, minY, sx, sy) {
  const rows = new Map();
  for (const k of cells) {
    const y = (k / nx) | 0;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(k % nx);
  }
  const ys = [...rows.keys()].sort((a, b) => a - b);
  const open = new Map();
  const boxes = [];
  for (const y of ys) {
    const xs = rows.get(y).sort((a, b) => a - b);
    const runs = [];
    let s = xs[0];
    let p = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === p + 1) {
        p = xs[i];
        continue;
      }
      runs.push(s + ":" + p);
      if (i < xs.length) s = p = xs[i];
    }
    const next = new Map();
    for (const r of runs) {
      const prev = open.get(r);
      if (prev && prev.y1 === y - 1) {
        prev.y1 = y;
        next.set(r, prev);
      } else {
        const [a, b] = r.split(":").map(Number);
        const bx = { x0: a, x1: b, y0: y, y1: y };
        boxes.push(bx);
        next.set(r, bx);
      }
    }
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  const polys = boxes.map((b) => {
    const x0 = minX + b.x0 * sx;
    const x1 = minX + (b.x1 + 1) * sx;
    const y0 = minY + b.y0 * sy;
    const y1 = minY + (b.y1 + 1) * sy;
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
  });
  if (!polys.length) return [];
  return polys.length === 1 ? polys : polygonClipping.union(...polys);
}

function simplifyMulti(multi, eps) {
  const out = [];
  for (const poly of multi) {
    const rings = [];
    for (let i = 0; i < poly.length; i++) {
      const r = simplifyClosed(poly[i], eps);
      if (r && r.length >= 4 && ringArea(r) > 0) rings.push(r);
      else if (i === 0) break;
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

function snapMulti(multi) {
  const out = [];
  for (const poly of multi || []) {
    const rings = [];
    for (let i = 0; i < poly.length; i++) {
      const r = closeRing(poly[i]);
      if (r && r.length >= 4) rings.push(r);
      else if (i === 0) break;
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

function median(vals) {
  if (!vals.length) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Canopy band pieces for one wide stand. Returns null when the grid cannot
 * say (the caller keeps its tiles). Each piece: { ringPx, bandH } where
 * bandH is the median canopy height over the piece (0 when unknown).
 */
function bandPieces(ringPx, frame, heightSample, o) {
  const opts = o || {};
  if (typeof heightSample !== "function" || !ringPx || ringPx.length < 4) return null;
  const mpuX = frame.mpuX || frame.mpu || 1;
  const mpuY = frame.mpuY || mpuX;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ringPx) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const wM = (maxX - minX) * mpuX;
  const hM = (maxY - minY) * mpuY;
  let cellM = BAND_CELL_M;
  if ((wM / cellM) * (hM / cellM) > BAND_MAX_CELLS) cellM = Math.sqrt((wM * hM) / BAND_MAX_CELLS);
  const nx = Math.max(2, Math.ceil(wM / cellM));
  const ny = Math.max(2, Math.ceil(hM / cellM));
  const sx = (maxX - minX) / nx;
  const sy = (maxY - minY) / ny;
  const cellM2 = sx * mpuX * sy * mpuY;
  const inside = rasterRing(ringPx, minX, minY, sx, sy, nx, ny);
  const OUT = 255;
  const GAP = 0;
  const label = new Uint8Array(nx * ny).fill(OUT);
  const hv = new Float32Array(nx * ny);
  let known = 0;
  let total = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const k = y * nx + x;
      if (!inside[k]) continue;
      total++;
      const ll = pxToLl(minX + (x + 0.5) * sx, minY + (y + 0.5) * sy, frame);
      const h = Number(heightSample(ll[0], ll[1])) || 0;
      hv[k] = h;
      if (h > 0) {
        known++;
        label[k] = Math.max(1, Math.min(250, Math.floor(h / BAND_M)));
      } else label[k] = GAP;
    }
  }
  if (total < 4 || known < total * 0.2) return null;
  // Open ground inside the stand (scrubGaps): gap cells that survive an
  // opening, in a patch of at least GAP_MIN_M2.
  const removed = new Uint8Array(nx * ny);
  let gapsRemoved = 0;
  if (opts.scrubGaps) {
    const isGap = (x, y) => x >= 0 && y >= 0 && x < nx && y < ny && label[y * nx + x] === GAP;
    const r = GAP_OPEN_CELLS;
    const eroded = new Uint8Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!isGap(x, y)) continue;
        let ok = true;
        for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r && ok; dx++) if (dx * dx + dy * dy <= r * r && !isGap(x + dx, y + dy)) ok = false;
        if (ok) eroded[y * nx + x] = 1;
      }
    }
    const opened = new Uint8Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!eroded[y * nx + x]) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (dx * dx + dy * dy <= r * r && X >= 0 && Y >= 0 && X < nx && Y < ny && label[Y * nx + X] === GAP) opened[Y * nx + X] = 1;
          }
        }
      }
    }
    const lab = new Uint8Array(nx * ny);
    for (let i = 0; i < lab.length; i++) lab[i] = opened[i] ? 1 : 0;
    const { list } = components(lab, nx, ny, 0);
    for (const c of list) {
      if (c.cells.length * cellM2 < GAP_MIN_M2) continue;
      for (const k of c.cells) {
        removed[k] = 1;
        label[k] = OUT;
      }
      gapsRemoved += c.cells.length * cellM2;
    }
  }
  // Small gaps and unknown cells take the band around them.
  for (let pass = 0; pass < 6; pass++) {
    let left = 0;
    const next = label.slice();
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const k = y * nx + x;
        if (label[k] !== GAP) continue;
        const votes = new Map();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
            const b = label[Y * nx + X];
            if (b === GAP || b === OUT) continue;
            votes.set(b, (votes.get(b) || 0) + 1);
          }
        }
        let best = GAP;
        let bv = 0;
        for (const [b, v] of votes) if (v > bv) { bv = v; best = b; }
        next[k] = best;
        if (best === GAP) left++;
      }
    }
    label.set(next);
    if (!left) break;
  }
  for (let i = 0; i < label.length; i++) if (label[i] === GAP) label[i] = 1;
  // Majority filter so single cells do not make speckle.
  for (let pass = 0; pass < BAND_MODE_PASSES; pass++) {
    const next = label.slice();
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const k = y * nx + x;
        if (label[k] === OUT) continue;
        const votes = new Map();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
            const b = label[Y * nx + X];
            if (b === OUT) continue;
            votes.set(b, (votes.get(b) || 0) + 1);
          }
        }
        let best = label[k];
        let bv = votes.get(best) || 0;
        for (const [b, v] of votes) if (v > bv + 1) { bv = v; best = b; }
        next[k] = best;
      }
    }
    label.set(next);
  }
  // Pieces under the minimum join the neighbour band they share most edge with.
  const standM2 = total * cellM2;
  const minCells = Math.max(4, Math.round(Math.max(BAND_VEG_MIN_PIECE_M2, standM2 / 40) / cellM2));
  let comps = components(label, nx, ny, OUT);
  for (let it = 0; it < 8; it++) {
    const small = comps.list.filter((c) => c.cells.length < minCells).sort((a, b) => a.cells.length - b.cells.length);
    if (!small.length) break;
    let changed = 0;
    for (const c of small) {
      const votes = new Map();
      for (const k of c.cells) {
        const x = k % nx;
        const y = (k / nx) | 0;
        const nb = [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1];
        for (const q of nb) {
          if (q < 0 || label[q] === OUT || comps.comp[q] === c.id) continue;
          votes.set(label[q], (votes.get(label[q]) || 0) + 1);
        }
      }
      let best = -1;
      let bv = 0;
      for (const [b, v] of votes) if (v > bv) { bv = v; best = b; }
      if (best < 0 || best === c.band) continue;
      for (const k of c.cells) label[k] = best;
      changed++;
    }
    comps = components(label, nx, ny, OUT);
    if (!changed) break;
  }
  const list = comps.list.slice().sort((a, b) => a.cells.length - b.cells.length);
  if (list.length <= 1 && !gapsRemoved) {
    const hs = [];
    for (let i = 0; i < hv.length; i++) if (inside[i] && hv[i] > 0) hs.push(hv[i]);
    return { pieces: [{ ringPx, bandH: median(hs) }], gapsRemovedM2: 0, bands: 1 };
  }
  const eps = BAND_SIMPLIFY_M / Math.max(mpuX, mpuY);
  const seat = [[closeRing(ringPx)]];
  let used = [];
  if (gapsRemoved) {
    const gapCells = [];
    for (let i = 0; i < removed.length; i++) if (removed[i]) gapCells.push(i);
    used = simplifyMulti(cellsToMulti(gapCells, nx, minX, minY, sx, sy), eps);
  }
  const pieces = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const hs = [];
    for (const k of c.cells) if (hv[k] > 0) hs.push(hv[k]);
    const h = median(hs);
    let geom;
    try {
      if (i === list.length - 1) {
        geom = used.length ? polygonClipping.difference(seat, used) : seat;
      } else {
        const raw = simplifyMulti(cellsToMulti(c.cells, nx, minX, minY, sx, sy), eps);
        if (!raw.length) continue;
        geom = polygonClipping.intersection(raw, seat);
        if (used.length) geom = polygonClipping.difference(geom, used);
      }
      geom = snapMulti(geom);
      if (!geom || !geom.length) continue;
      used = used.length ? snapMulti(polygonClipping.union(used, geom)) : geom;
    } catch (e) {
      // The last piece cannot be skipped (it is the rest of the stand).
      if (i === list.length - 1) throw e;
      continue;
    }
    for (const r of hollowFree(geom)) pieces.push({ ringPx: r, bandH: h });
  }
  return { pieces, gapsRemovedM2: Math.round(gapsRemoved), bands: list.length };
}

/**
 * Merge neighbouring 50 m tiles of one stand whose heights agree within
 * MERGE_TOL_M of the first tile of the group. tiles: [{ ringPx, gx, gy, h }]
 * with h the canopy height read at the tile (0 when unknown). Returns
 * [{ ringPx, bandH, members }].
 */
function mergeTilePieces(tiles, frame) {
  const n = tiles.length;
  const byCell = new Map();
  for (let i = 0; i < n; i++) {
    const key = tiles[i].gx + "," + tiles[i].gy;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(i);
  }
  const area = tiles.map((t) => ringArea(t.ringPx));
  const order = [...Array(n).keys()].sort((a, b) => area[b] - area[a]);
  const group = new Int32Array(n).fill(-1);
  const groups = [];
  const fits = (seedH, h) => (seedH > 0 ? h > 0 && Math.abs(h - seedH) <= MERGE_TOL_M : !(h > 0));
  for (const s of order) {
    if (group[s] >= 0) continue;
    const id = groups.length;
    const members = [s];
    group[s] = id;
    const seedH = tiles[s].h;
    const queue = [s];
    while (queue.length) {
      const t = queue.shift();
      const { gx, gy } = tiles[t];
      const nbKeys = [gx + "," + gy, gx - 1 + "," + gy, gx + 1 + "," + gy, gx + "," + (gy - 1), gx + "," + (gy + 1)];
      for (const key of nbKeys) {
        for (const q of byCell.get(key) || []) {
          if (group[q] >= 0 || !fits(seedH, tiles[q].h)) continue;
          group[q] = id;
          members.push(q);
          queue.push(q);
        }
      }
    }
    groups.push(members);
  }
  const out = [];
  for (const members of groups) {
    let aSum = 0;
    let hSum = 0;
    for (const m of members) {
      if (tiles[m].h > 0) {
        aSum += area[m];
        hSum += area[m] * tiles[m].h;
      }
    }
    const h = aSum > 0 ? hSum / aSum : 0;
    if (members.length === 1) {
      out.push({ ringPx: tiles[members[0]].ringPx, bandH: h, members: 1 });
      continue;
    }
    let geom;
    try {
      geom = polygonClipping.union(...members.map((m) => [closeRing(tiles[m].ringPx)]));
    } catch {
      for (const m of members) out.push({ ringPx: tiles[m].ringPx, bandH: tiles[m].h, members: 1 });
      continue;
    }
    // Shared tile edges leave points in a straight line; drop them.
    const eps = 0.05 / Math.max(frame.mpuX || 1, frame.mpuY || frame.mpuX || 1);
    for (const r of hollowFree(simplifyMulti(geom, eps))) out.push({ ringPx: r, bandH: h, members: members.length });
  }
  return out;
}

module.exports = { bandPieces, mergeTilePieces, hollowFree, simplifyClosed, MERGE_TOL_M, BAND_M, BAND_MIN_PIECE_M2, BAND_SIMPLIFY_M, GAP_MIN_M2 };

// ---- Pixel versions, for the canopy grid trace (canopy-height.js) ----

/** 4-connected parts of a pixel list. */
function pixelParts(pixels, w) {
  const id = new Map();
  for (let i = 0; i < pixels.length; i++) id.set(pixels[i][1] * w + pixels[i][0], i);
  const seen = new Uint8Array(pixels.length);
  const parts = [];
  for (let i = 0; i < pixels.length; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const part = [];
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      const p = pixels[k];
      part.push(p);
      const nb = [[p[0] - 1, p[1]], [p[0] + 1, p[1]], [p[0], p[1] - 1], [p[0], p[1] + 1]];
      for (const q of nb) {
        if (q[0] < 0 || q[0] >= w) continue;
        const j = id.get(q[1] * w + q[0]);
        if (j === undefined || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    parts.push(part);
  }
  return parts;
}

function groupMedian(group, at, minH) {
  const hs = [];
  for (const p of group) {
    const v = at(p[0], p[1]);
    if (v >= minH) hs.push(v);
  }
  return median(hs);
}

/**
 * canopyBands on the canopy grid: one stand's pixels cut along 3 m height
 * bands, smoothed, with pieces under the minimum joined to the neighbour
 * band they share most edge with. Returns pixel groups, or null.
 */
function bandPixelGroups(pixels, at, w, mPerX, mPerY, areaM2) {
  if (!pixels || pixels.length < 8) return null;
  const cellM2 = mPerX * mPerY;
  // About as many pieces as the 42 m grid made at most, never under 20 x 20 m.
  const minM2 = Math.max(BAND_MIN_PIECE_M2, areaM2 / 100);
  const minCells = Math.max(4, Math.round(minM2 / cellM2));
  const idx = new Map();
  for (let i = 0; i < pixels.length; i++) idx.set(pixels[i][1] * w + pixels[i][0], i);
  const n = pixels.length;
  let label = new Int16Array(n);
  for (let i = 0; i < n; i++) label[i] = Math.max(0, Math.floor(at(pixels[i][0], pixels[i][1]) / BAND_M));
  const nbr8 = (p) => [
    [p[0] - 1, p[1]], [p[0] + 1, p[1]], [p[0], p[1] - 1], [p[0], p[1] + 1],
    [p[0] - 1, p[1] - 1], [p[0] + 1, p[1] - 1], [p[0] - 1, p[1] + 1], [p[0] + 1, p[1] + 1],
  ];
  for (let pass = 0; pass < BAND_MODE_PASSES; pass++) {
    const next = label.slice();
    for (let i = 0; i < n; i++) {
      const votes = new Map();
      votes.set(label[i], 1);
      for (const q of nbr8(pixels[i])) {
        if (q[0] < 0 || q[0] >= w) continue;
        const j = idx.get(q[1] * w + q[0]);
        if (j === undefined) continue;
        votes.set(label[j], (votes.get(label[j]) || 0) + 1);
      }
      let best = label[i];
      let bv = votes.get(best);
      for (const [b, v] of votes) if (v > bv + 1) { bv = v; best = b; }
      next[i] = best;
    }
    label = next;
  }
  const comps = () => {
    const comp = new Int32Array(n).fill(-1);
    const list = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] >= 0) continue;
      const cid = list.length;
      const cells = [];
      const stack = [i];
      comp[i] = cid;
      while (stack.length) {
        const k = stack.pop();
        cells.push(k);
        const p = pixels[k];
        for (const q of [[p[0] - 1, p[1]], [p[0] + 1, p[1]], [p[0], p[1] - 1], [p[0], p[1] + 1]]) {
          if (q[0] < 0 || q[0] >= w) continue;
          const j = idx.get(q[1] * w + q[0]);
          if (j === undefined || comp[j] >= 0 || label[j] !== label[i]) continue;
          comp[j] = cid;
          stack.push(j);
        }
      }
      list.push({ id: cid, band: label[i], cells });
    }
    return { comp, list };
  };
  let c = comps();
  for (let it = 0; it < 12; it++) {
    const small = c.list.filter((x) => x.cells.length < minCells).sort((a, b) => a.cells.length - b.cells.length);
    if (!small.length) break;
    let changed = 0;
    const touched = new Set();
    for (const s of small) {
      if (touched.has(s.id)) continue;
      const votes = new Map();
      for (const k of s.cells) {
        const p = pixels[k];
        for (const q of [[p[0] - 1, p[1]], [p[0] + 1, p[1]], [p[0], p[1] - 1], [p[0], p[1] + 1]]) {
          if (q[0] < 0 || q[0] >= w) continue;
          const j = idx.get(q[1] * w + q[0]);
          if (j === undefined || c.comp[j] === s.id) continue;
          const key = c.comp[j];
          votes.set(key, (votes.get(key) || 0) + 1);
        }
      }
      let best = -1;
      let bv = 0;
      for (const [k, v] of votes) if (v > bv) { bv = v; best = k; }
      if (best < 0) continue;
      const band = c.list[best].band;
      for (const k of s.cells) label[k] = band;
      touched.add(best);
      changed++;
    }
    c = comps();
    if (!changed) break;
  }
  if (c.list.length < 2) return null;
  return c.list.map((x) => x.cells.map((k) => pixels[k]));
}

/**
 * mergeTiles on the canopy grid: neighbouring blocks whose median height is
 * within MERGE_TOL_M of the first block of the group join it.
 */
function mergePixelGroups(groups, at, w, minH) {
  if (!groups || groups.length < 2) return groups;
  const owner = new Map();
  for (let g = 0; g < groups.length; g++) for (const p of groups[g]) owner.set(p[1] * w + p[0], g);
  const adj = groups.map(() => new Set());
  for (let g = 0; g < groups.length; g++) {
    for (const p of groups[g]) {
      for (const q of [[p[0] + 1, p[1]], [p[0], p[1] + 1]]) {
        if (q[0] >= w) continue;
        const o = owner.get(q[1] * w + q[0]);
        if (o !== undefined && o !== g) {
          adj[g].add(o);
          adj[o].add(g);
        }
      }
    }
  }
  const hs = groups.map((gr) => groupMedian(gr, at, minH));
  const order = groups.map((_, i) => i).sort((a, b) => groups[b].length - groups[a].length);
  const of = new Int32Array(groups.length).fill(-1);
  const out = [];
  for (const s of order) {
    if (of[s] >= 0) continue;
    const id = out.length;
    of[s] = id;
    const members = [s];
    const queue = [s];
    while (queue.length) {
      const t = queue.shift();
      for (const q of adj[t]) {
        if (of[q] >= 0) continue;
        if (!(Math.abs(hs[q] - hs[s]) <= MERGE_TOL_M)) continue;
        of[q] = id;
        members.push(q);
        queue.push(q);
      }
    }
    let px = [];
    for (const m of members) px = px.concat(groups[m]);
    out.push(px);
  }
  return out;
}

/**
 * scrubGaps: a group with clear open ground inside it (a hole of at least
 * GAP_MIN_M2 that is still there after a one-cell opening) is cut through the
 * hole, so the traced outline goes around the open ground instead of across it.
 */
function scrubPixelGroups(groups, standSet, w, mPerX, mPerY, depth, minHoleM2) {
  const out = [];
  const cellM2 = mPerX * mPerY;
  const minCells = Math.max(4, Math.round((minHoleM2 || GAP_MIN_M2) / cellM2));
  for (const g of groups) {
    if ((depth || 0) > 10 || g.length < minCells * 2) {
      out.push(g);
      continue;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    const bw = x1 - x0 + 3;
    const bh = y1 - y0 + 3;
    const mine = new Uint8Array(bw * bh);
    for (const p of g) mine[(p[1] - y0 + 1) * bw + (p[0] - x0 + 1)] = 1;
    // Outside: flood from the border over cells not in this group.
    const outside = new Uint8Array(bw * bh);
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
      const k = stack.pop();
      const x = k % bw;
      const y = (k / bw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx;
        const Y = y + dy;
        if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
        const q = Y * bw + X;
        if (outside[q] || mine[q]) continue;
        outside[q] = 1;
        stack.push(q);
      }
    }
    // Holes that are open ground (not canopy of another piece), opened by one cell.
    const open = new Uint8Array(bw * bh);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const k = y * bw + x;
        if (mine[k] || outside[k]) continue;
        if (standSet.has((y + y0 - 1) * w + (x + x0 - 1))) continue;
        open[k] = 1;
      }
    }
    const er = new Uint8Array(bw * bh);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const k = y * bw + x;
        if (open[k] && open[k - 1] && open[k + 1] && open[k - bw] && open[k + bw]) er[k] = 1;
      }
    }
    let best = null;
    const seenH = new Uint8Array(bw * bh);
    for (let k = 0; k < er.length; k++) {
      if (!er[k] || seenH[k]) continue;
      const cells = [];
      const st = [k];
      seenH[k] = 1;
      while (st.length) {
        const a = st.pop();
        cells.push(a);
        for (const d of [1, -1, bw, -bw]) {
          const b = a + d;
          if (b >= 0 && b < er.length && er[b] && !seenH[b]) {
            seenH[b] = 1;
            st.push(b);
          }
        }
      }
      // Opened area: each kept cell stands for itself plus its ring.
      if (cells.length * 2 >= minCells && (!best || cells.length > best.length)) best = cells;
    }
    if (!best) {
      out.push(g);
      continue;
    }
    let cx = 0;
    for (const k of best) cx += k % bw;
    const cutX = Math.round(cx / best.length) + x0 - 1;
    const left = g.filter((p) => p[0] < cutX);
    const right = g.filter((p) => p[0] >= cutX);
    if (!left.length || !right.length) {
      out.push(g);
      continue;
    }
    const parts = pixelParts(left, w).concat(pixelParts(right, w));
    const again = scrubPixelGroups(parts, standSet, w, mPerX, mPerY, (depth || 0) + 1, minHoleM2);
    for (const a of again) out.push(a);
  }
  return out;
}

module.exports.bandPixelGroups = bandPixelGroups;
module.exports.mergePixelGroups = mergePixelGroups;
module.exports.scrubPixelGroups = scrubPixelGroups;

/**
 * A band or merged piece can wrap around a city block or another piece (a
 * ring of street trees). Its traced outline would fill the middle. A piece
 * with a hole of HOLE_MIN_M2 or more is cut through the hole instead.
 */
function holeFreeGroups(groups, w, mPerX, mPerY) {
  return scrubPixelGroups(groups, new Set(), w, mPerX, mPerY, 0, HOLE_MIN_M2);
}

module.exports.holeFreeGroups = holeFreeGroups;
