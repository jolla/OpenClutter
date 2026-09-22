"use strict";

/**
 * Clip foliage rings so they do not cover building footprints or mask polygons
 * (water, and large smooth pavement when the caller supplies it).
 *
 * Buildings are expanded by a few metres first. The difference is a polygon
 * that may contain holes (a roof completely inside a canopy patch). Each hole
 * is opened to the exterior with a narrow corridor so Hamina receives a simple
 * ring — OpenIntent has no hole rings, and a zero-width bridge is a
 * self-touching ring that can fail import. Rings are then kept under the
 * Hamina vertex cap. A piece that still intersects an original building is
 * dropped rather than drawn across the roof.
 */

const polygonClipping = require("polygon-clipping");

const BUILDING_BUFFER_M = 4;
const MAX_FOLIAGE_VERTS = 36;
const OVERLAP_DROP_PX2 = 1;

function signedArea(ring) {
  const n = ring.length && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : ring.length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function openRing(ring) {
  if (!ring || !ring.length) return [];
  const closed =
    ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const src = closed ? ring.slice(0, -1) : ring.slice();
  const out = [];
  for (const p of src) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.04) continue;
    out.push([p[0], p[1]]);
  }
  if (out.length >= 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.04) {
    out.pop();
  }
  return out;
}

function closeRing(open) {
  if (!open || open.length < 3) return [];
  return open.concat([[open[0][0], open[0][1]]]);
}

function bounds(ring) {
  const pts = openRing(ring);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function bboxHit(a, b, pad) {
  const p = pad || 0;
  return !(a.maxX + p < b.minX || a.minX - p > b.maxX || a.maxY + p < b.minY || a.minY - p > b.maxY);
}

function pointInRing(pt, ring) {
  const pts = openRing(ring);
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function orientPositive(ring) {
  const open = openRing(ring);
  if (open.length < 3) return [];
  if (signedArea(open) < 0) open.reverse();
  return closeRing(open);
}

function segsCross(a, b, c, d) {
  if (a[0] === c[0] && a[1] === c[1]) return false;
  if (a[0] === d[0] && a[1] === d[1]) return false;
  if (b[0] === c[0] && b[1] === c[1]) return false;
  if (b[0] === d[0] && b[1] === d[1]) return false;
  const ccw = (p, q, r) => (r[1] - p[1]) * (q[0] - p[0]) > (q[1] - p[1]) * (r[0] - p[0]);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function ringSelfIntersects(ring) {
  const open = openRing(ring);
  const n = open.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segsCross(a, b, open[j], open[(j + 1) % n])) return true;
    }
  }
  return false;
}

function outwardNormal(a, b, ccw) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return ccw ? [dy / len, -dx / len] : [-dy / len, dx / len];
}

function miterBuffer(ring, dist) {
  const open = openRing(ring);
  if (open.length < 3 || !(dist > 0)) return null;
  const ccw = signedArea(open) > 0;
  const out = [];
  const n = open.length;
  for (let i = 0; i < n; i++) {
    const prev = open[(i + n - 1) % n];
    const cur = open[i];
    const next = open[(i + 1) % n];
    const n1 = outwardNormal(prev, cur, ccw);
    const n2 = outwardNormal(cur, next, ccw);
    let bx = n1[0] + n2[0];
    let by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-8) {
      out.push([cur[0] + n1[0] * dist, cur[1] + n1[1] * dist]);
      continue;
    }
    bx /= bl;
    by /= bl;
    const denom = bx * n1[0] + by * n1[1];
    let scale = denom > 0.25 ? dist / denom : dist;
    if (scale > dist * 2) scale = dist * 2;
    if (!(scale > 0)) scale = dist;
    out.push([cur[0] + bx * scale, cur[1] + by * scale]);
  }
  const closed = closeRing(out);
  if (closed.length < 4 || ringSelfIntersects(closed)) return null;
  if (Math.abs(signedArea(closed)) <= Math.abs(signedArea(open))) return null;
  const step = Math.max(1, Math.ceil(open.length / 8));
  for (let i = 0; i < open.length; i += step) {
    if (!pointInRing(open[i], closed)) return null;
  }
  return [[orientPositive(closed)]];
}

function unionAll(geoms) {
  let list = (geoms || []).filter((g) => g && g.length);
  if (!list.length) return [];
  while (list.length > 1) {
    const next = [];
    for (let i = 0; i < list.length; i += 2) {
      if (i + 1 >= list.length) {
        next.push(list[i]);
        continue;
      }
      try {
        next.push(polygonClipping.union(list[i], list[i + 1]));
      } catch {
        next.push(list[i]);
      }
    }
    if (next.length === list.length) break;
    list = next;
  }
  return list[0] || [];
}

function quadBuffer(ring, dist) {
  const open = openRing(ring);
  if (open.length < 3) return [[orientPositive(ring)]];
  const closed = orientPositive(ring);
  const geoms = [[closed]];
  const ccw = true;
  for (let i = 0; i < open.length; i++) {
    const a = open[i];
    const b = open[(i + 1) % open.length];
    const n = outwardNormal(a, b, signedArea(open) > 0 ? ccw : false);
    const a2 = [a[0] + n[0] * dist, a[1] + n[1] * dist];
    const b2 = [b[0] + n[0] * dist, b[1] + n[1] * dist];
    geoms.push([[orientPositive([a, b, b2, a2, a])]]);
  }
  for (const p of open) {
    const s = dist;
    geoms.push([
      [
        [p[0] - s, p[1] - s],
        [p[0] + s, p[1] - s],
        [p[0] + s, p[1] + s],
        [p[0] - s, p[1] + s],
        [p[0] - s, p[1] - s],
      ],
    ]);
  }
  try {
    const merged = unionAll(geoms);
    if (merged && merged.length) return merged;
  } catch {
    /* fall through */
  }
  return [[closed]];
}

function bufferGeom(ring, dist) {
  if (!(dist > 0)) return [[orientPositive(ring)]];
  return miterBuffer(ring, dist) || quadBuffer(ring, dist);
}

function perpDist2(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-18) {
    const dx = p[0] - a[0];
    const dy = p[1] - a[1];
    return dx * dx + dy * dy;
  }
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = p[0] - (a[0] + t * vx);
  const dy = p[1] - (a[1] + t * vy);
  return dx * dx + dy * dy;
}

function simplifyDP(pts, eps2) {
  if (pts.length <= 2) return pts;
  let maxI = 0;
  let maxD = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist2(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps2) {
    const left = simplifyDP(pts.slice(0, maxI + 1), eps2);
    const right = simplifyDP(pts.slice(maxI), eps2);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function simplifyRingPx(ring, eps) {
  const open = openRing(ring);
  if (open.length < 3) return null;
  if (!(eps > 0)) return closeRing(open);
  const simplified = simplifyDP(open.concat([open[0]]), eps * eps);
  const out = [];
  for (const p of simplified) {
    if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.05) out.push(p);
  }
  if (out.length >= 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.05) {
    out.pop();
  }
  if (out.length < 3) return null;
  return closeRing(out);
}

function clipHalfPlane(ring, inside, intersect) {
  const pts = openRing(ring);
  if (pts.length < 3) return null;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i];
    const prev = pts[(i + pts.length - 1) % pts.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur.slice());
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  const clean = [];
  for (const p of out) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = clean[clean.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.04) continue;
    clean.push(p);
  }
  if (clean.length >= 2 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 0.04) {
    clean.pop();
  }
  if (clean.length < 3) return null;
  return closeRing(clean);
}

function splitRing(ring) {
  const bb = bounds(ring);
  if (!(bb.w > 1) || !(bb.h > 1)) return [];
  const vertical = bb.w >= bb.h;
  const mid = vertical ? (bb.minX + bb.maxX) / 2 : (bb.minY + bb.maxY) / 2;
  const insideA = vertical ? (p) => p[0] <= mid : (p) => p[1] <= mid;
  const insideB = vertical ? (p) => p[0] >= mid : (p) => p[1] >= mid;
  const intersect = vertical
    ? (a, b) => {
        const dx = b[0] - a[0] || 1e-12;
        const t = (mid - a[0]) / dx;
        return [mid, a[1] + t * (b[1] - a[1])];
      }
    : (a, b) => {
        const dy = b[1] - a[1] || 1e-12;
        const t = (mid - a[1]) / dy;
        return [a[0] + t * (b[0] - a[0]), mid];
      };
  const a = clipHalfPlane(ring, insideA, intersect);
  const b = clipHalfPlane(ring, insideB, intersect);
  const an = a ? openRing(a).length : 0;
  const bn = b ? openRing(b).length : 0;
  const n = openRing(ring).length;
  if (an >= 3 && bn >= 3 && an < n && bn < n) return [a, b];
  return [];
}

function usablePiece(ring, maxVerts) {
  const open = openRing(ring);
  if (open.length < 3 || open.length > maxVerts) return false;
  const bb = bounds(open);
  if (bb.w < 4 || bb.h < 4) return false;
  if (Math.abs(signedArea(open)) < 8) return false;
  if (ringSelfIntersects(closeRing(open))) return false;
  return true;
}

function piecesUnderCap(ring, maxVerts, maxEps) {
  const out = [];
  const stack = [{ ring, depth: 0 }];
  let guard = 0;
  while (stack.length && guard++ < 48) {
    const item = stack.pop();
    const open = openRing(item.ring);
    if (open.length < 3) continue;
    if (Math.abs(signedArea(open)) < 8) continue;
    const bb = bounds(open);
    if (bb.w < 4 || bb.h < 4) continue;
    if (open.length <= maxVerts && !ringSelfIntersects(item.ring)) {
      out.push(closeRing(open));
      continue;
    }
    const eps = Math.min(maxEps, 0.55 + item.depth * 0.35);
    const simplified = simplifyRingPx(item.ring, eps);
    if (simplified && usablePiece(simplified, maxVerts)) {
      out.push(simplified);
      continue;
    }
    if (item.depth < 8) {
      const parts = splitRing(item.ring);
      if (parts.length === 2) {
        stack.push({ ring: parts[0], depth: item.depth + 1 }, { ring: parts[1], depth: item.depth + 1 });
        continue;
      }
    }
    const forced = simplifyRingPx(item.ring, maxEps);
    if (forced && usablePiece(forced, maxVerts)) out.push(forced);
  }
  return out;
}

function segmentInRegion(a, b, outer, holes) {
  for (let s = 1; s <= 6; s++) {
    const t = s / 7;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!pointInRing(p, outer)) return false;
    for (const h of holes) {
      if (pointInRing(p, h)) return false;
    }
  }
  return true;
}

function closestBridge(outer, hole, holes) {
  const o = openRing(outer);
  const h = openRing(hole);
  let best = Infinity;
  let pair = null;
  const oStep = Math.max(1, Math.ceil(o.length / 24));
  const hStep = Math.max(1, Math.ceil(h.length / 24));
  for (let i = 0; i < o.length; i += oStep) {
    for (let j = 0; j < h.length; j += hStep) {
      const dx = o[i][0] - h[j][0];
      const dy = o[i][1] - h[j][1];
      const d = dx * dx + dy * dy;
      if (d >= best) continue;
      if (!segmentInRegion(h[j], o[i], outer, holes)) continue;
      best = d;
      pair = [h[j], o[i]];
    }
  }
  return pair;
}

function corridorQuad(outer, hole, holes) {
  const pair = closestBridge(outer, hole, holes);
  if (!pair) return null;
  const hp = pair[0];
  const op = pair[1];
  let dx = op[0] - hp[0];
  let dy = op[1] - hp[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let start = null;
  for (let step = 0.4; step <= 8; step += 0.4) {
    const cand = [hp[0] - ux * step, hp[1] - uy * step];
    if (pointInRing(cand, hole)) {
      start = cand;
      break;
    }
  }
  if (!start) start = [hp[0] - ux * 1.2, hp[1] - uy * 1.2];
  let end = null;
  for (let step = 0.6; step <= 10; step += 0.6) {
    const cand = [op[0] + ux * step, op[1] + uy * step];
    if (!pointInRing(cand, outer)) {
      end = cand;
      break;
    }
  }
  if (!end) end = [op[0] + ux * 2, op[1] + uy * 2];
  const px = -uy * 0.6;
  const py = ux * 0.6;
  return orientPositive([
    [start[0] + px, start[1] + py],
    [end[0] + px, end[1] + py],
    [end[0] - px, end[1] - py],
    [start[0] - px, start[1] - py],
  ]);
}

function countHoles(polys) {
  let n = 0;
  for (const p of polys || []) n += Math.max(0, (p ? p.length : 0) - 1);
  return n;
}

function openHoles(multi) {
  let polys = (multi || []).slice();
  const simples = [];
  let guard = 0;
  while (polys.length && guard++ < 80) {
    const poly = polys.pop();
    if (!poly || !poly[0] || poly[0].length < 4) continue;
    if (poly.length === 1) {
      simples.push(poly[0]);
      continue;
    }
    const corridor = corridorQuad(poly[0], poly[1], poly.slice(1));
    if (!corridor) continue;
    let opened;
    try {
      opened = polygonClipping.difference([poly], [[corridor]]);
    } catch {
      continue;
    }
    if (!opened || !opened.length) continue;
    if (countHoles(opened) >= poly.length - 1) continue;
    for (const p of opened) polys.push(p);
  }
  return simples;
}

function intersectionAreaPx(ringA, ringB) {
  const a = orientPositive(ringA);
  const b = orientPositive(ringB);
  if (a.length < 4 || b.length < 4) return 0;
  if (!bboxHit(bounds(a), bounds(b), 0)) return 0;
  try {
    const inter = polygonClipping.intersection([[a]], [[b]]);
    let area = 0;
    for (const poly of inter || []) {
      if (!poly[0]) continue;
      area += Math.abs(signedArea(poly[0]));
      for (let i = 1; i < poly.length; i++) area -= Math.abs(signedArea(poly[i]));
    }
    return area > 0 ? area : 0;
  } catch {
    return 0;
  }
}

function createClipSet(buildingRings, maskRings, maskPolygons, bufferPx) {
  const buildings = [];
  for (const ring of buildingRings || []) {
    const closed = orientPositive(ring);
    if (closed.length < 4) continue;
    buildings.push({ ring: closed, bbox: bounds(closed), geom: null });
  }
  const extras = [];
  const waterPad = Math.min(2.5, Math.max(1.2, (bufferPx || 4) * 0.35));
  for (const ring of maskRings || []) {
    const closed = orientPositive(ring);
    if (closed.length < 4) continue;
    extras.push({
      bbox: bounds(closed),
      geom: bufferGeom(closed, waterPad),
      ring: closed,
      kind: "water",
    });
  }
  for (const poly of maskPolygons || []) {
    if (!poly || !poly[0]) continue;
    const rings = [];
    for (const ring of poly) {
      const closed = closeRing(openRing(ring));
      if (closed.length >= 4) rings.push(closed);
    }
    if (!rings.length) continue;
    extras.push({
      bbox: bounds(rings[0]),
      geom: [rings],
      ring: orientPositive(rings[0]),
      kind: "pavement",
    });
  }
  if (!buildings.length && !extras.length) return null;
  return { buildings, extras, bufferPx: bufferPx > 0 ? bufferPx : BUILDING_BUFFER_M };
}

function geomForBuilding(b, bufferPx) {
  if (b.geom) return b.geom;
  b.geom = bufferGeom(b.ring, bufferPx);
  return b.geom;
}

function overlapsRing(ring, other, limit) {
  return intersectionAreaPx(ring, other) > (limit == null ? OVERLAP_DROP_PX2 : limit);
}

function clipFoliageRing(ring, clipSet) {
  const closed = orientPositive(ring);
  if (closed.length < 4) return [];
  if (!clipSet) return [closed];
  const bb = bounds(closed);
  const geoms = [];
  const buildingHits = [];
  for (const b of clipSet.buildings) {
    if (!bboxHit(bb, b.bbox, clipSet.bufferPx)) continue;
    const g = geomForBuilding(b, clipSet.bufferPx);
    if (g && g.length) {
      geoms.push(g);
      buildingHits.push(b);
    }
  }
  const waterHits = [];
  for (const extra of clipSet.extras) {
    if (!bboxHit(bb, extra.bbox, clipSet.bufferPx)) continue;
    if (extra.geom && extra.geom.length) geoms.push(extra.geom);
    if (extra.kind === "water") waterHits.push(extra);
  }
  if (!geoms.length) return [closed];
  let mask;
  try {
    mask = unionAll(geoms);
  } catch {
    mask = null;
  }
  let diff = null;
  if (mask && mask.length) {
    try {
      diff = polygonClipping.difference([[closed]], mask);
    } catch {
      diff = null;
    }
  }
  if (!diff) {
    const hitsBuilding = buildingHits.some((b) => overlapsRing(closed, b.ring, OVERLAP_DROP_PX2));
    const hitsWater = waterHits.some((w) => overlapsRing(closed, w.ring, OVERLAP_DROP_PX2));
    return hitsBuilding || hitsWater ? [] : [closed];
  }
  const raw = openHoles(diff);
  const maxEps = Math.max(1.1, Math.min(2.2, clipSet.bufferPx * 0.4));
  const pieces = [];
  for (const s of raw) {
    for (const piece of piecesUnderCap(s, MAX_FOLIAGE_VERTS, maxEps)) {
      let blocked = false;
      for (const b of buildingHits) {
        if (overlapsRing(piece, b.ring, OVERLAP_DROP_PX2)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const w of waterHits) {
        if (overlapsRing(piece, w.ring, OVERLAP_DROP_PX2)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) pieces.push(piece);
    }
  }
  return pieces;
}

module.exports = {
  BUILDING_BUFFER_M,
  MAX_FOLIAGE_VERTS,
  OVERLAP_DROP_PX2,
  signedArea,
  openRing,
  closeRing,
  bounds,
  pointInRing,
  bufferGeom,
  intersectionAreaPx,
  createClipSet,
  clipFoliageRing,
};
