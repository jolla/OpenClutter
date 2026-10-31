"use strict";

/**
 * forest=crowns understory prototype (local wip-understory only).
 *
 * The 1.3.7 understory is the stand's full traced outline from the ground to
 * about 3 m. From the side it reads as one pale slab skirting every woods.
 *
 *   tuck:  the understory stays under the crown. Every edge that faces open
 *          ground steps in by TUCK_M, so the crown overhangs it the way a real
 *          forest edge does. Edges shared with a neighbouring canopy piece stay.
 *   patch: tuck, then only where the height model shows tree canopy (gaps and
 *          clearings drop out), cut into a few irregular patches whose tops
 *          vary a little below the crown base.
 *
 * Pure geometry on image pixels. Each piece is a plain extruded ring that
 * clears the 3 m / 4 px floor and keeps at most MAX_VERTS corners.
 */

const { pointInRing } = require("./poly-clip");
const { pxToLl } = require("./geo-frame");
const polygonClipping = require("polygon-clipping");

const TUCK_M = Number(process.env.OC_UNDERSTORY_TUCK) > 0 ? Number(process.env.OC_UNDERSTORY_TUCK) : 1.5;
const MAX_VERTS = 36;
const MAX_PATCHES = 4;
const MIN_PATCH_M2 = 40;
/** The patch keeps canopy cells at least this tall in the height model. */
const PATCH_MIN_CHM_M = 5;

function ringBox(r) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of r) {
    if (p[0] < a) a = p[0];
    if (p[1] < b) b = p[1];
    if (p[0] > c) c = p[0];
    if (p[1] > d) d = p[1];
  }
  return [a, b, c, d];
}

function ringArea(r) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(s / 2);
}

function closed(r) {
  const o = r.map((p) => [p[0], p[1]]);
  const a = o[0], b = o[o.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) o.push([a[0], a[1]]);
  return o;
}

/** A coarse bucket index of every canopy footprint in the scene. */
function footprintIndex(rings, cellPx) {
  const cell = Math.max(8, cellPx);
  const grid = new Map();
  const items = [];
  for (const r of rings) {
    if (!r || r.length < 4) continue;
    const box = ringBox(r);
    const id = items.length;
    items.push({ ring: r, box });
    for (let gx = Math.floor(box[0] / cell); gx <= Math.floor(box[2] / cell); gx++)
      for (let gy = Math.floor(box[1] / cell); gy <= Math.floor(box[3] / cell); gy++) {
        const k = gx + "," + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(id);
      }
  }
  return {
    covers(p, own) {
      if (own && pointInRing(p, own)) return true;
      const ids = grid.get(Math.floor(p[0] / cell) + "," + Math.floor(p[1] / cell));
      if (!ids) return false;
      for (const id of ids) {
        const it = items[id];
        const b = it.box;
        if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
        if (pointInRing(p, it.ring)) return true;
      }
      return false;
    },
  };
}

/** Outer boundary of one 4-connected cell set, as grid-corner points. */
function traceCells(cells, nx) {
  const on = new Set(cells);
  const has = (x, y) => x >= 0 && x < nx && on.has(y * nx + x);
  const next = new Map();
  const add = (x0, y0, x1, y1) => next.set(x0 + "," + y0, [x1, y1, x0, y0]);
  for (const k of cells) {
    const x = k % nx, y = (k / nx) | 0;
    if (!has(x, y - 1)) add(x, y, x + 1, y);
    if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!has(x - 1, y)) add(x, y + 1, x, y);
  }
  // Start at the top-left corner, which is on the outer boundary.
  let start = null;
  for (const k of cells) {
    const x = k % nx, y = (k / nx) | 0;
    if (!start || y < start[1] || (y === start[1] && x < start[0])) start = [x, y];
  }
  if (!start) return null;
  const out = [[start[0], start[1]]];
  let cur = start.join(",");
  for (let guard = 0; guard < next.size + 2; guard++) {
    const e = next.get(cur);
    if (!e) return null;
    const key = e[0] + "," + e[1];
    if (key === start.join(",")) break;
    out.push([e[0], e[1]]);
    cur = key;
  }
  out.push([start[0], start[1]]);
  return out.length >= 4 ? out : null;
}

/** Drop collinear corners, then thin evenly to `max`. */
function simplify(ring, max) {
  let pts = ring.slice(0, -1);
  const keep = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) keep.push(b);
  }
  pts = keep;
  if (pts.length > max) {
    const step = pts.length / max;
    const t = [];
    for (let i = 0; i < max; i++) t.push(pts[Math.floor(i * step)]);
    pts = t;
  }
  if (pts.length < 3) return null;
  return closed(pts);
}

function hash01(x, y) {
  let h = (Math.round(x * 7) * 374761393 + Math.round(y * 7) * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Douglas-Peucker on a closed ring until it has at most `max` corners. */
function dpRing(ring, max) {
  let pts = ring.slice(0, -1);
  if (pts.length <= max) return ring;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
  };
  let tol = 0.25;
  for (let it = 0; it < 30 && pts.length > max; it++) {
    const keep = new Array(pts.length).fill(false);
    keep[0] = true;
    let far = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > fd) { fd = d; far = i; }
    }
    keep[far] = true;
    const segs = [[0, far], [far, pts.length]];
    while (segs.length) {
      const [a, b] = segs.pop();
      const pb = pts[b % pts.length];
      let best = -1, bd = tol;
      for (let i = a + 1; i < b; i++) {
        const d = dist(pts[i], pts[a], pb);
        if (d > bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        keep[best] = true;
        segs.push([a, best], [best, b]);
      }
    }
    const next = pts.filter((_, i) => keep[i]);
    if (next.length <= max) { pts = next; break; }
    tol *= 1.5;
  }
  if (pts.length > max) return null;
  return closed(pts);
}

/**
 * tuck, as vector geometry: every edge of the traced outline whose outside is
 * open ground (no canopy piece there) gives up a TUCK_M strip; edges shared
 * with neighbouring canopy keep their line. Returns pieces or null.
 */
function tuckRings(ring, frame, index) {
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || mpuX;
  const R = closed(ring);
  let sgn = 0;
  for (let i = 0; i < R.length - 1; i++) sgn += R[i][0] * R[i + 1][1] - R[i + 1][0] * R[i][1];
  sgn = sgn > 0 ? 1 : -1;
  const cuts = [];
  for (let i = 0; i < R.length - 1; i++) {
    const a = R[i], b = R[i + 1];
    const ex = (b[0] - a[0]) * mpuX, ey = (b[1] - a[1]) * mpuY;
    const L = Math.hypot(ex, ey);
    if (!(L > 0.05)) continue;
    // Inward normal in metres (left of travel for a ccw ring in these axes).
    const nx = (-ey / L) * sgn, ny = (ex / L) * sgn;
    let open = 0, n = 0;
    for (const t of [0.2, 0.5, 0.8]) {
      const q = [a[0] + (b[0] - a[0]) * t - (nx * 0.8) / mpuX, a[1] + (b[1] - a[1]) * t - (ny * 0.8) / mpuY];
      n++;
      if (!(index ? index.covers(q, null) : false)) open++;
    }
    if (open < 2) continue;
    const ix = (nx * TUCK_M) / mpuX, iy = (ny * TUCK_M) / mpuY;
    // A little past each end so neighbouring strips overlap at corners.
    const ux = (ex / L) * (TUCK_M * 0.5) / mpuX, uy = (ey / L) * (TUCK_M * 0.5) / mpuY;
    const ox = (-nx * 0.2) / mpuX, oy = (-ny * 0.2) / mpuY;
    cuts.push([closed([
      [a[0] - ux + ox, a[1] - uy + oy],
      [b[0] + ux + ox, b[1] + uy + oy],
      [b[0] + ux + ix, b[1] + uy + iy],
      [a[0] - ux + ix, a[1] - uy + iy],
    ])]);
  }
  if (!cuts.length) return null;
  let geom;
  try {
    geom = polygonClipping.difference([R], ...cuts);
  } catch {
    return null;
  }
  const floorPx = Math.max(4, 3 / Math.max(mpuX, 0.01));
  const pieces = [];
  for (const poly of geom || []) {
    const r = poly && poly[0];
    if (!r || r.length < 4) continue;
    if (ringArea(r) * mpuX * mpuY < 10) continue;
    let rr = r.length - 1 > MAX_VERTS ? dpRing(r, MAX_VERTS) : r;
    if (!rr) continue;
    if (rr !== r) {
      try {
        const inter = polygonClipping.intersection([rr], [R]);
        let best = null;
        for (const pp of inter || []) if (pp[0] && pp[0].length >= 4 && (!best || ringArea(pp[0]) > ringArea(best))) best = pp[0];
        if (!best) continue;
        rr = best.length - 1 > MAX_VERTS + 4 ? dpRing(best, MAX_VERTS) || best : best;
      } catch {
        continue;
      }
    }
    const b = ringBox(rr);
    if (b[2] - b[0] < floorPx || b[3] - b[1] < floorPx) continue;
    pieces.push(rr);
  }
  pieces.sort((x, y) => ringArea(y) - ringArea(x));
  return pieces.slice(0, 4);
}

/**
 * Understory pieces for one stand. Returns [{ ringPx, heightScale }] (possibly
 * empty), or null to keep the traced outline as is.
 */
function shapeUnderstory(ring, frame, opts) {
  const style = opts && opts.style;
  if (style !== "tuck" && style !== "patch") return null;
  if (!ring || ring.length < 4) return null;
  if (style === "tuck") {
    const t = tuckRings(ring, frame, opts.index);
    return t && t.length ? t.map((r) => ({ ringPx: r, heightScale: 1 })) : null;
  }
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || mpuX;
  const box = ringBox(ring);
  const wM = (box[2] - box[0]) * mpuX, hM = (box[3] - box[1]) * mpuY;
  const cellM = Math.max(1.0, Math.sqrt((wM * hM) / 40000));
  const nx = Math.max(1, Math.ceil(wM / cellM)), ny = Math.max(1, Math.ceil(hM / cellM));
  const sx = (box[2] - box[0]) / nx, sy = (box[3] - box[1]) / ny;
  const tx = TUCK_M / mpuX, ty = TUCK_M / mpuY;
  const dirs = [];
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  const index = opts.index;
  const hs = opts.heightSample;
  const on = [];
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const p = [box[0] + (x + 0.5) * sx, box[1] + (y + 0.5) * sy];
      if (!pointInRing(p, ring)) continue;
      let deep = true;
      for (const d of dirs) {
        for (const f of [0.5, 1]) {
          const q = [p[0] + d[0] * tx * f, p[1] + d[1] * ty * f];
          if (!(index ? index.covers(q, ring) : pointInRing(q, ring))) {
            deep = false;
            break;
          }
        }
        if (!deep) break;
      }
      if (!deep) continue;
      if (style === "patch" && typeof hs === "function") {
        const ll = pxToLl(p[0], p[1], frame);
        const v = Number(hs(ll[0], ll[1])) || 0;
        if (!(v >= PATCH_MIN_CHM_M)) continue;
      }
      on.push(y * nx + x);
    }
  // Components.
  const set = new Set(on), seen = new Set(), comps = [];
  for (const k of on) {
    if (seen.has(k)) continue;
    const st = [k], cells = [];
    seen.add(k);
    while (st.length) {
      const c = st.pop();
      cells.push(c);
      const x = c % nx, y = (c / nx) | 0;
      for (const q of [x > 0 ? c - 1 : -1, x < nx - 1 ? c + 1 : -1, y > 0 ? c - nx : -1, y < ny - 1 ? c + nx : -1])
        if (q >= 0 && set.has(q) && !seen.has(q)) {
          seen.add(q);
          st.push(q);
        }
    }
    comps.push(cells);
  }
  comps.sort((a, b) => b.length - a.length);
  const cellM2 = sx * sy * mpuX * mpuY;
  const floorPx = Math.max(4, 3 / Math.max(mpuX, 0.01));
  const out = [];
  const limit = style === "patch" ? MAX_PATCHES : 2;
  for (const cells of comps) {
    if (out.length >= limit) break;
    if (cells.length * cellM2 < MIN_PATCH_M2) break;
    const t = traceCells(cells, nx);
    if (!t) continue;
    if (ringArea(t) < cells.length * 0.5) continue;
    const px = simplify(t.map(([x, y]) => [box[0] + x * sx, box[1] + y * sy]), MAX_VERTS);
    if (!px) continue;
    let piece = null;
    try {
      const inter = polygonClipping.intersection([closed(ring)], [px]);
      for (const poly of inter || []) {
        const r = poly && poly[0];
        if (r && r.length >= 4 && (!piece || ringArea(r) > ringArea(piece))) piece = r;
      }
    } catch {
      piece = null;
    }
    if (!piece) continue;
    if (piece.length - 1 > MAX_VERTS + 4) piece = simplify(piece, MAX_VERTS) || piece;
    const b = ringBox(piece);
    if (b[2] - b[0] < floorPx || b[3] - b[1] < floorPx) continue;
    const c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    // Patch tops step down 0, 15 or 30% below the crown base (never under 2.1 m).
    const heightScale = style === "patch" ? [1, 0.85, 0.7][Math.floor(hash01(c[0], c[1]) * 3)] : 1;
    out.push({ ringPx: piece, heightScale });
  }
  // Never empty a stand: a strip too narrow to tuck keeps its traced outline,
  // and patches that keep too little fall back to the tucked outline.
  const kept = out.reduce((a, p) => a + ringArea(p.ringPx), 0);
  if (style === "patch" && kept < ringArea(closed(ring)) * 0.4) {
    return shapeUnderstory(ring, frame, Object.assign({}, opts, { style: "tuck" }));
  }
  if (!out.length) return null;
  return out;
}

module.exports = { shapeUnderstory, footprintIndex, TUCK_M };
