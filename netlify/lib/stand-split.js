"use strict";

/**
 * Prototype for wide foliage stands (feedback #9: large forests read as a
 * grid of 50 m squares in Hamina), behind the export-mode switch mergeTiles,
 * off by default: keep the block cut but merge neighbours whose heights agree.
 */

const polygonClipping = require("polygon-clipping");

// mergeTiles
// A merged piece is cut through any hole this big (see holeFreeGroups).
const HOLE_MIN_M2 = 100;
const GAP_MIN_M2 = HOLE_MIN_M2;
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

function median(vals) {
  if (!vals.length) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
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

module.exports = { mergeTilePieces, hollowFree, simplifyClosed, MERGE_TOL_M };

// ---- Pixel versions, for the canopy grid trace (canopy-height.js) ----

function groupMedian(group, at, minH) {
  const hs = [];
  for (const p of group) {
    const v = at(p[0], p[1]);
    if (v >= minH) hs.push(v);
  }
  return median(hs);
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

module.exports.mergePixelGroups = mergePixelGroups;

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

/**
 * A group with a clear hole inside it (a hole of at least
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

/**
 * A band or merged piece can wrap around a city block or another piece (a
 * ring of street trees). Its traced outline would fill the middle. A piece
 * with a hole of HOLE_MIN_M2 or more is cut through the hole instead.
 */
function holeFreeGroups(groups, w, mPerX, mPerY) {
  return scrubPixelGroups(groups, new Set(), w, mPerX, mPerY, 0, HOLE_MIN_M2);
}

module.exports.holeFreeGroups = holeFreeGroups;
