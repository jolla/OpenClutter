"use strict";

/**
 * seaWater (/dev): water areas from shore lines that cross the draw.
 *
 * The street-map read returns only the ways inside the draw, so the sea
 * (natural=coastline, water on the right) and a large river or lake mapped as
 * a multipolygon (natural=water with outer ways mostly outside the draw)
 * arrive as open lines. Each line, closed along the draw edge on its right,
 * is one half of the draw; crossing any shore flips water and land, so the
 * water is the symmetric difference of those halves (or its complement).
 * A coastline knows its side. A multipolygon's ways have no common
 * direction, so the side with far fewer roads and buildings is the water,
 * and a side that is not clearly emptier is left out: no water is better
 * than water drawn over a street.
 */

const polygonClipping = require("polygon-clipping");

const MAX_RING_VERTS = 36;
// Land marks per square kilometre: the water side must be this much emptier.
const SIDE_RATIO = 4;

function boxPoly(box) {
  return [[[box.west, box.south], [box.east, box.south], [box.east, box.north], [box.west, box.north], [box.west, box.south]]];
}

function ringAreaDeg(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
}

function multiAreaDeg(multi) {
  let a = 0;
  for (const poly of multi || []) {
    if (!poly || !poly.length) continue;
    a += ringAreaDeg(poly[0]);
    for (let h = 1; h < poly.length; h++) a -= ringAreaDeg(poly[h]);
  }
  return a;
}

function inRing(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-15) + a[0]) c = !c;
  }
  return c;
}

function inMulti(pt, multi) {
  for (const poly of multi || []) {
    if (!poly || !poly.length || !inRing(pt, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(pt, poly[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

function countIn(points, multi) {
  let n = 0;
  for (let i = 0; i < points.length; i++) if (inMulti(points[i], multi)) n++;
  return n;
}

function perp2(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

function dp(pts, eps2) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perp2(pts[i], pts[a], pts[b]);
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (bi > 0 && best > eps2) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Closed ring under maxVerts corners (Douglas-Peucker, growing tolerance). */
function capRing(ring, maxVerts, spanDeg) {
  let open = ring.slice(0, -1);
  if (open.length <= maxVerts) return ring;
  let eps = spanDeg * 0.001;
  for (let k = 0; k < 24 && open.length > maxVerts; k++) {
    // Split the ring at its far point so the line simplifier keeps both sides.
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
    open = a.concat(b.slice(1, -1));
    eps *= 1.6;
  }
  if (open.length > maxVerts || open.length < 3) return null;
  return open.concat([open[0]]);
}

/** Hole-free pieces: a piece with a hole is cut through the hole's middle. */
function holeFree(multi, cell, depth, out) {
  let part;
  try {
    part = polygonClipping.intersection(multi, boxPoly(cell));
  } catch {
    return;
  }
  for (const poly of part) {
    if (!poly || !poly[0]) continue;
    if (poly.length === 1 || depth >= 8) {
      out.push(poly[0]);
      continue;
    }
    const hole = poly[1];
    let cx = 0;
    for (let i = 0; i < hole.length; i++) cx += hole[i][0];
    cx /= hole.length;
    const pcell = boxOf(poly[0]);
    holeFree([poly], { west: pcell.west, east: cx, south: pcell.south, north: pcell.north }, depth + 1, out);
    holeFree([poly], { west: cx, east: pcell.east, south: pcell.south, north: pcell.north }, depth + 1, out);
  }
}

function boxOf(ring) {
  let w = Infinity;
  let e = -Infinity;
  let so = Infinity;
  let n = -Infinity;
  for (const p of ring) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < so) so = p[1];
    if (p[1] > n) n = p[1];
  }
  return { west: w, east: e, south: so, north: n };
}

/** Pieces of a water multipolygon as simple closed rings for OpenIntent. */
function waterPieces(multi, box) {
  const out = [];
  let verts = 0;
  for (const poly of multi) for (const r of poly) verts += r.length;
  const n = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(verts / 28))));
  const dx = (box.east - box.west) / n;
  const dy = (box.north - box.south) / n;
  const span = Math.max(box.east - box.west, box.north - box.south);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cell = { west: box.west + i * dx, east: box.west + (i + 1) * dx, south: box.south + j * dy, north: box.south + (j + 1) * dy };
      const rings = [];
      holeFree(multi, cell, 0, rings);
      for (const r of rings) {
        if (!r || r.length < 4) continue;
        if (ringAreaDeg(r) < span * span * 1e-5) continue;
        const capped = capRing(r, MAX_RING_VERTS, span);
        if (capped) out.push(capped);
      }
    }
  }
  return out;
}

/** Join coastline ways end to start, keeping their direction (water right). */
function chainForward(parts) {
  const left = parts.filter((p) => p && p.length >= 2).map((p) => p.slice());
  const out = [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (left.length) {
    let chain = left.pop();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        if (same(chain[chain.length - 1], p[0])) {
          chain = chain.concat(p.slice(1));
        } else if (same(p[p.length - 1], chain[0])) {
          chain = p.concat(chain.slice(1));
        } else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}

/**
 * groups: [{ chains: [[lon,lat]...], oriented: bool }]; oriented chains have
 * water on their right (coastline). Closed oriented chains are islands.
 * helpers: { clipLineRuns(pts, box), closeRight(run, box) }.
 * landPts: [lon,lat] marks on land (road and building nodes).
 * Returns { multi, side } per group, or null when the side is not clear.
 */
function groupWater(group, box, landPts, helpers) {
  const halves = [];
  let open = 0;
  let probe = null;
  for (const chain of group.chains || []) {
    if (!chain || chain.length < 2) continue;
    const first = chain[0];
    const last = chain[chain.length - 1];
    const closed = chain.length >= 4 && first[0] === last[0] && first[1] === last[1];
    if (closed) {
      if (!group.oriented) continue;
      try {
        const isle = polygonClipping.intersection([[chain]], boxPoly(box));
        if (isle.length) halves.push(isle);
      } catch {
        /* skip a broken island */
      }
      continue;
    }
    const runs = helpers.clipLineRuns(chain, box);
    for (const run of runs) {
      const ring = helpers.closeRight(run, box);
      if (ring && ring.length >= 4) {
        halves.push([[ring]]);
        open++;
        if (!probe && run.length >= 2) {
          const k = Math.floor((run.length - 1) / 2);
          const p = run[k];
          const q = run[k + 1];
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (len > 0) {
            const off = Math.max(box.east - box.west, box.north - box.south) * 1e-4;
            const mx = (p[0] + q[0]) / 2;
            const my = (p[1] + q[1]) / 2;
            probe = [mx + ((q[1] - p[1]) / len) * off, my - ((q[0] - p[0]) / len) * off];
          }
        }
      }
    }
  }
  if (!halves.length) return null;
  let water;
  try {
    // Odd crossings from one side: water or land, whichever holds the probe.
    water = halves.length === 1 ? halves[0] : polygonClipping.xor(...halves);
    if (group.oriented) {
      // Water lies just right of a coastline; with islands only, the rest is sea.
      const flip = open === 0 ? true : probe ? !inMulti(probe, water) : false;
      if (flip) water = polygonClipping.xor(boxPoly(box), water);
    }
  } catch {
    return null;
  }
  let land;
  try {
    land = polygonClipping.difference(boxPoly(box), water);
  } catch {
    return null;
  }
  const aW = multiAreaDeg(water);
  const aL = multiAreaDeg(land);
  const boxA = (box.east - box.west) * (box.north - box.south);
  if (!(aW > boxA * 1e-4)) return null;
  const marks = (landPts || []).filter((p) => p[0] > box.west && p[0] < box.east && p[1] > box.south && p[1] < box.north);
  const nW = countIn(marks, water);
  const nL = marks.length - nW;
  const dW = nW / Math.max(aW, 1e-12);
  const dL = nL / Math.max(aL, 1e-12);
  if (group.oriented) {
    // A coastline drawn the wrong way round, or cut short, puts the sea on
    // the streets. Keep it only when its side is emptier.
    if (nW <= 2 || (aL > boxA * 1e-4 && dW * SIDE_RATIO <= dL)) return { multi: water, side: "right" };
    return null;
  }
  if (!(aL > boxA * 1e-4)) return null;
  if (nW <= 2 && nL >= 8) return { multi: water, side: "right" };
  if (nL <= 2 && nW >= 8) return { multi: land, side: "left" };
  if (dW * SIDE_RATIO <= dL && nL >= 8) return { multi: water, side: "right" };
  if (dL * SIDE_RATIO <= dW && nW >= 8) return { multi: land, side: "left" };
  return null;
}

/**
 * Water in multi not already covered by done (a list of multipolygons).
 * Null when less than 2% of it is new.
 */
function subtractDone(multi, done) {
  if (!multi || !multi.length) return null;
  if (!done || !done.length) return multi;
  const before = multiAreaDeg(multi);
  let left = multi;
  try {
    left = polygonClipping.difference(multi, ...done);
  } catch (e) {
    return null;
  }
  if (!left.length || multiAreaDeg(left) < before * 0.02) return null;
  return left;
}

/** Closed lon/lat rings, unioned and clipped to the box. Null when empty. */
function clipRingsToBox(rings, box) {
  try {
    const polys = rings.filter((r) => r && r.length >= 4).map((r) => [r]);
    if (!polys.length) return null;
    const u = polygonClipping.union(...polys);
    const got = polygonClipping.intersection(u, boxPoly(box));
    return got.length ? got : null;
  } catch (e) {
    return null;
  }
}

function unionAll(multis) {
  const list = multis.filter((m) => m && m.length);
  if (list.length <= 1) return list[0] || null;
  try {
    return polygonClipping.union(...list);
  } catch (e) {
    return list[0];
  }
}

module.exports = { clipRingsToBox, unionAll, chainForward, groupWater, waterPieces, capRing, boxPoly, multiAreaDeg, subtractDone, SIDE_RATIO };
