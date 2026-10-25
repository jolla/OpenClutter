"use strict";

/**
 * Worst-case RV pads (site types, /dev hosts).
 *
 * An RV park or campground is drawn with an RV on every pad, occupied or
 * not, so an RF plan sees the fullest park. A pad needs evidence:
 *
 * - the RVs already found along an internal road (mapped pitches, RV-sized
 *   footprints, roofs the photo shows) give that road side's pad spacing,
 *   setback, angle and size;
 * - the gaps between them, and the run past the last one, are filled at that
 *   spacing where the photo shows open pad: not a roof, not water, not the
 *   road, not tree crown or lawn, and inside the mapped park.
 *
 * A road side with too few RVs borrows its park's pattern, and a park with
 * too few RVs gets nothing, so a road is never lined with boxes on a guess.
 * Everything works in pixel rings (y up, as the planner uses).
 */

const SIDE_MIN_EVIDENCE = 3;
const ZONE_MIN_EVIDENCE = 6;
const SETBACK_M = [2, 18];
const SPACING_M = [4, 20];
const LEN_M = [6.5, 12];
const WID_M = [2.4, 3.2];
const ROAD_CLEAR_M = 2.5;
/** Pads on a side with no RV need this many open slots in a row. */
const RUN_MIN = 3;
const GREEN_MAX = 0.3;
const OPEN_MIN = 0.55;
/**
 * A pad is the park's own pad surface. The ground right around the RVs
 * already found gives that surface's colour; a slot whose ground does not
 * match it (open desert, sand or dirt past the pads) is not a pad.
 */
const PAD_GROUND_MIN = 80;
const PAD_MATCH_DIST = 40;
const PAD_MATCH_MIN = 0.5;
const FILL_CAP = 1500;
const ROAD_CAP = 400;

function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((ring[j][0] - ring[i][0]) * (y - yi)) / (yj - yi || 1e-20) + ring[i][0]) inside = !inside;
  }
  return inside;
}

function toM(ring, mx, my) {
  return ring.map((p) => [p[0] * mx, p[1] * my]);
}

function bboxOf(ring) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

/** Long axis, centre and size of a ring in metres. */
function boxOf(ringM) {
  const n = ringM.length;
  let cx = 0;
  let cy = 0;
  for (const p of ringM) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = ringM[i];
    const b = ringM[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L;
    const uy = (b[1] - a[1]) / L;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of ringM) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const long = u1 - u0 >= v1 - v0;
      best = { area, len: Math.max(u1 - u0, v1 - v0), wid: Math.min(u1 - u0, v1 - v0), ux: long ? ux : -uy, uy: long ? uy : ux };
    }
  }
  return best ? { cx, cy, len: best.len, wid: best.wid, ux: best.ux, uy: best.uy } : null;
}

/** Arc-length table for a road polyline in metres. */
function lineTable(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  return { line, cum, length: cum[cum.length - 1] };
}

function pointAt(tab, t) {
  const { line, cum } = tab;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < t) i++;
  const seg = cum[i] - cum[i - 1] || 1e-9;
  const f = Math.max(0, Math.min(1, (t - cum[i - 1]) / seg));
  const ux = (line[i][0] - line[i - 1][0]) / seg;
  const uy = (line[i][1] - line[i - 1][1]) / seg;
  return { x: line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, y: line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f, ux, uy };
}

/** Nearest station on a polyline: arc length, signed offset (left +), tangent. */
function project(tab, x, y) {
  const { line, cum } = tab;
  let best = null;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0];
    const ay = line[i - 1][1];
    const dx = line[i][0] - ax;
    const dy = line[i][1] - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const qx = ax + dx * f;
    const qy = ay + dy * f;
    const d = Math.hypot(x - qx, y - qy);
    if (!best || d < best.d) {
      const L = Math.sqrt(L2);
      const side = (dx * (y - ay) - dy * (x - ax)) / L;
      best = { d, t: cum[i - 1] + f * L, off: side, ux: dx / L, uy: dy / L, interior: f > 0 && f < 1 };
    }
  }
  return best;
}

function rectM(cx, cy, ux, uy, len, wid) {
  const hl = len / 2;
  const hw = wid / 2;
  const px = -uy;
  const py = ux;
  return [
    [cx + ux * hl + px * hw, cy + uy * hl + py * hw],
    [cx - ux * hl + px * hw, cy - uy * hl + py * hw],
    [cx - ux * hl - px * hw, cy - uy * hl - py * hw],
    [cx + ux * hl - px * hw, cy + uy * hl - py * hw],
  ];
}

/** Sample points inside a rectangle, about one per metre. */
function samplesIn(cx, cy, ux, uy, len, wid) {
  const pts = [];
  const nl = Math.max(2, Math.round(len));
  const nw = Math.max(2, Math.round(wid));
  for (let i = 0; i < nl; i++) {
    for (let j = 0; j < nw; j++) {
      const a = ((i + 0.5) / nl - 0.5) * len;
      const b = ((j + 0.5) / nw - 0.5) * wid;
      pts.push([cx + ux * a - uy * b, cy + uy * a + ux * b]);
    }
  }
  return pts;
}

/** Bucketed rings for fast point tests. */
function ringIndex(rings, cell) {
  const map = new Map();
  rings.forEach((ring, idx) => {
    const b = bboxOf(ring);
    for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) {
      for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) {
        const k = gx + "," + gy;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(idx);
      }
    }
  });
  return {
    hit(x, y) {
      const list = map.get(Math.floor(x / cell) + "," + Math.floor(y / cell));
      if (!list) return false;
      for (const idx of list) if (pointInRing(x, y, rings[idx])) return true;
      return false;
    },
    add(ring) {
      rings.push(ring);
      const idx = rings.length - 1;
      const b = bboxOf(ring);
      for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) {
        for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) {
          const k = gx + "," + gy;
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(idx);
        }
      }
    },
  };
}

/** Share of photo samples that are open pad, and that are green. */
function photoShares(pts, plate, frame, mx, my) {
  if (!plate) return { open: 1, green: 0 };
  let n = 0;
  let open = 0;
  let green = 0;
  for (const p of pts) {
    const x = Math.floor(p[0] / mx);
    const y = Math.floor(frame.imgH - p[1] / my);
    if (x < 0 || y < 0 || x >= plate.width || y >= plate.height) continue;
    const i = (y * plate.width + x) * 4;
    const r = plate.data[i];
    const g = plate.data[i + 1];
    const b = plate.data[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    n++;
    // Green or dry grass (excess green), and deep shade, are not a pad.
    // Dry grass reads olive: excess green and darker than bare gravel.
    const veg = (g > r + 6 && g > b + 6) || (2 * g - r - b > 12 && luma < 125);
    // Gravel, concrete, and asphalt are low-chroma; playgrounds and roofs are not.
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (veg || luma < 45) green++;
    else if (luma >= 70 && luma <= 250 && chroma < 70) open++;
  }
  if (!n) return { open: 0, green: 1 };
  return { open: open / n, green: green / n };
}

function pixelAt(p, plate, frame, mx, my) {
  const x = Math.floor(p[0] / mx);
  const y = Math.floor(frame.imgH - p[1] / my);
  if (x < 0 || y < 0 || x >= plate.width || y >= plate.height) return null;
  const i = (y * plate.width + x) * 4;
  return [plate.data[i], plate.data[i + 1], plate.data[i + 2]];
}

/** Colour distance with hue (red and blue against green) weighted over brightness. */
function groundDistance(c, q) {
  const hue = Math.abs(c[0] - c[1] - (q[0] - q[1])) + Math.abs(c[2] - c[1] - (q[2] - q[1]));
  const luma = Math.abs(0.299 * (c[0] - q[0]) + 0.587 * (c[1] - q[1]) + 0.114 * (c[2] - q[2]));
  return 1.5 * hue + 0.8 * luma;
}

function clamp(v, r) {
  return Math.max(r[0], Math.min(r[1], v));
}

/**
 * @param {object} o
 * @param {Array} o.zones pixel rings of RV parks, campgrounds, mobile-home parks
 * @param {Array} o.roads pixel polylines of internal roads
 * @param {Array} o.evidence pixel rings of RVs already placed (boxes and RV footprints)
 * @param {Array} o.obstacles pixel rings never covered (roofs, water)
 * @param {object} [o.context] the rest of the park read past the draw:
 *   {evidence, roads}, used only when the draw holds too few RVs
 * @returns {{rings: Array, added: number}} new RV rings in pixels
 */
function fillPads(o) {
  const frame = o.frame;
  const mx = frame.mpuX > 0 ? frame.mpuX : 0.3;
  const my = frame.mpuY > 0 ? frame.mpuY : mx;
  const zones = (o.zones || []).filter((z) => z && z.length >= 3).map((z) => toM(z, mx, my));
  if (!zones.length) return { rings: [], added: 0 };
  const inZone = (x, y) => zones.some((z) => pointInRing(x, y, z));
  // A draw that holds too few RVs to learn its park's pads borrows the
  // whole park's RVs and roads (park-context.js), the way a road side with
  // too few RVs borrows its park's pattern.
  const ctx = o.context;
  if (ctx && ((ctx.evidence && ctx.evidence.length) || (ctx.roads && ctx.roads.length))) {
    let own = 0;
    for (const ring of o.evidence || []) {
      if (!ring || ring.length < 3) continue;
      const b = boxOf(toM(ring, mx, my));
      if (b && b.len >= 4 && b.len <= 16 && inZone(b.cx, b.cy)) own++;
    }
    if (own < ZONE_MIN_EVIDENCE) {
      o = Object.assign({}, o, {
        roads: (o.roads || []).concat(ctx.roads || []),
        evidence: (o.evidence || []).concat(ctx.evidence || []),
        context: null,
      });
    }
  }
  // Every road keeps pads clear of its pavement; pads are only looked for
  // along roads that run mostly inside a park.
  const roads = [];
  const clear = [];
  const clearRoads = [];
  for (const r of (o.roads || []).concat(o.clearRoads || [])) {
    const line = Array.isArray(r) ? r : r && r.line;
    if (!line || line.length < 2 || clearRoads.length >= ROAD_CAP * 2) continue;
    const m = toM(line, mx, my);
    const tab = lineTable(m);
    if (!(tab.length > 0)) continue;
    const half = r && Number.isFinite(r.halfWidthM) ? r.halfWidthM : 0;
    clearRoads.push(tab);
    clear.push(Math.max(ROAD_CLEAR_M, half + 1));
    if (r && r.clearOnly) continue;
    let inside = 0;
    for (const p of m) if (inZone(p[0], p[1])) inside++;
    if (inside * 2 < m.length || tab.length < 10 || roads.length >= ROAD_CAP) continue;
    roads.push(tab);
  }
  const clearOf = (k) => clear[k];
  if (!roads.length) return { rings: [], added: 0 };
  const boxes = [];
  for (const ring of o.evidence || []) {
    if (!ring || ring.length < 3) continue;
    const b = boxOf(toM(ring, mx, my));
    if (b && b.len >= 4 && b.len <= 16 && inZone(b.cx, b.cy)) boxes.push(b);
  }
  if (boxes.length < ZONE_MIN_EVIDENCE) return { rings: [], added: 0 };
  // Each RV votes for the road side it faces.
  const sides = new Map();
  const zoneVotes = { spacing: [], setback: [], cross: [], len: [], wid: [] };
  for (const b of boxes) {
    let best = null;
    let bestRoad = -1;
    roads.forEach((tab, r) => {
      const p = project(tab, b.cx, b.cy);
      if (p && (!best || p.d < best.d)) {
        best = p;
        bestRoad = r;
      }
    });
    if (!best || best.d < SETBACK_M[0] || best.d > SETBACK_M[1]) continue;
    const key = bestRoad + (best.off >= 0 ? "+" : "-");
    if (!sides.has(key)) sides.set(key, { road: bestRoad, sign: best.off >= 0 ? 1 : -1, items: [] });
    const cross = Math.abs(b.ux * best.uy - b.uy * best.ux);
    sides.get(key).items.push({ t: best.t, d: best.d, cross, len: b.len, wid: b.wid });
    zoneVotes.setback.push(best.d);
    zoneVotes.cross.push(cross);
    zoneVotes.len.push(b.len);
    zoneVotes.wid.push(b.wid);
  }
  const pattern = (items) => {
    const ts = items.map((it) => it.t).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) {
      const g = ts[i] - ts[i - 1];
      if (g >= SPACING_M[0] && g <= SPACING_M[1]) gaps.push(g);
    }
    return {
      spacing: median(gaps),
      setback: median(items.map((it) => it.d)),
      cross: median(items.map((it) => it.cross)),
      len: clamp(median(items.map((it) => it.len)), LEN_M),
      wid: clamp(median(items.map((it) => it.wid)), WID_M),
    };
  };
  for (const s of sides.values()) {
    const p = pattern(s.items);
    if (Number.isFinite(p.spacing)) zoneVotes.spacing.push(p.spacing);
  }
  const zonePattern = {
    spacing: median(zoneVotes.spacing),
    setback: median(zoneVotes.setback),
    cross: median(zoneVotes.cross),
    len: clamp(median(zoneVotes.len), LEN_M),
    wid: clamp(median(zoneVotes.wid), WID_M),
  };
  const occupied = ringIndex(
    (o.evidence || []).filter((r) => r && r.length >= 3).map((r) => toM(r, mx, my)),
    20
  );
  const blocked = ringIndex(
    (o.obstacles || []).filter((r) => r && r.length >= 3).map((r) => toM(r, mx, my)),
    20
  );
  // Pad ground colour: a band one to three metres around each RV found in
  // the photo, off any roof, road, lawn or crown.
  let padGround = null;
  if (o.plate) {
    const rs = [];
    const gs = [];
    const bs = [];
    for (const b of boxes) {
      for (const grow of [2, 4, 6]) {
        const L = b.len + grow;
        const W = b.wid + grow;
        const per = Math.max(8, Math.round((L + W) * 2));
        for (let k = 0; k < per; k++) {
          const f = k / per;
          let a;
          let c;
          const e = f * 2 * (L + W);
          if (e < L) [a, c] = [e - L / 2, W / 2];
          else if (e < L + W) [a, c] = [L / 2, W / 2 - (e - L)];
          else if (e < 2 * L + W) [a, c] = [L / 2 - (e - L - W), -W / 2];
          else [a, c] = [-L / 2, -W / 2 + (e - 2 * L - W)];
          const p = [b.cx + b.ux * a - b.uy * c, b.cy + b.uy * a + b.ux * c];
          if (!inZone(p[0], p[1]) || occupied.hit(p[0], p[1]) || blocked.hit(p[0], p[1])) continue;
          let onRoad = false;
          for (let r = 0; r < clearRoads.length && !onRoad; r++) {
            const q = project(clearRoads[r], p[0], p[1]);
            if (q && q.d < clearOf(r)) onRoad = true;
          }
          if (onRoad) continue;
          const px = pixelAt(p, o.plate, frame, mx, my);
          if (!px) continue;
          const luma = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
          const veg = (px[1] > px[0] + 6 && px[1] > px[2] + 6) || (2 * px[1] - px[0] - px[2] > 12 && luma < 125);
          if (veg || luma < 45) continue;
          rs.push(px[0]);
          gs.push(px[1]);
          bs.push(px[2]);
        }
      }
    }
    if (rs.length >= PAD_GROUND_MIN) padGround = [median(rs), median(gs), median(bs)];
  }
  const out = [];
  const tryPlace = (tab, sign, t, pat, dry) => {
    if (out.length >= FILL_CAP) return false;
    if (t < 0 || t > tab.length) return false;
    const st = pointAt(tab, t);
    const nx = -st.uy * sign;
    const ny = st.ux * sign;
    const cx = st.x + nx * pat.setback;
    const cy = st.y + ny * pat.setback;
    if (!inZone(cx, cy)) return false;
    // Long axis: across the road for a back-in pad, along it for a parallel one.
    const across = pat.cross >= 0.5;
    const ux = across ? nx : st.ux;
    const uy = across ? ny : st.uy;
    const pts = samplesIn(cx, cy, ux, uy, pat.len, pat.wid);
    for (const p of pts) {
      if (!inZone(p[0], p[1])) return false;
      if (blocked.hit(p[0], p[1]) || occupied.hit(p[0], p[1])) return false;
      for (let k = 0; k < clearRoads.length; k++) {
        const q = project(clearRoads[k], p[0], p[1]);
        if (q && q.d < clearOf(k)) return false;
      }
    }
    const shares = photoShares(pts, o.plate, frame, mx, my);
    if (shares.green > GREEN_MAX || shares.open < OPEN_MIN) return false;
    if (padGround) {
      let n = 0;
      let match = 0;
      for (const p of pts) {
        const px = pixelAt(p, o.plate, frame, mx, my);
        if (!px) continue;
        n++;
        if (groundDistance(px, padGround) < PAD_MATCH_DIST) match++;
      }
      if (n && match < n * PAD_MATCH_MIN) return false;
    }
    const ring = rectM(cx, cy, ux, uy, pat.len, pat.wid);
    if (dry) return true;
    occupied.add(ring);
    out.push(ring.map((p) => [p[0] / mx, p[1] / my]));
    return true;
  };
  for (let r = 0; r < roads.length; r++) {
    for (const sign of [1, -1]) {
      const s = sides.get(r + (sign > 0 ? "+" : "-"));
      const own = s && s.items.length >= SIDE_MIN_EVIDENCE ? pattern(s.items) : null;
      const pat = own && Number.isFinite(own.spacing) ? own : zonePattern;
      if (!Number.isFinite(pat.spacing) || !Number.isFinite(pat.setback)) continue;
      const tab = roads[r];
      const ts = s ? s.items.map((it) => it.t).sort((a, b) => a - b) : [];
      if (!ts.length) {
        // No RV on this side: the park's pattern, only where the photo shows
        // a run of RUN_MIN or more open pads at that spacing in a row.
        let run = [];
        const flush = () => {
          if (run.length >= RUN_MIN) for (const t of run) tryPlace(tab, sign, t, pat);
          run = [];
        };
        for (let t = pat.spacing / 2; t <= tab.length; t += pat.spacing) {
          if (tryPlace(tab, sign, t, pat, true)) run.push(t);
          else flush();
        }
        flush();
        continue;
      }
      for (let k = 1; ts[0] - k * pat.spacing >= 0; k++) tryPlace(tab, sign, ts[0] - k * pat.spacing, pat);
      for (let i = 1; i < ts.length; i++) {
        const gap = ts[i] - ts[i - 1];
        const n = Math.round(gap / pat.spacing) - 1;
        for (let k = 1; k <= n; k++) tryPlace(tab, sign, ts[i - 1] + (gap * k) / (n + 1), pat);
      }
      const last = ts[ts.length - 1];
      for (let k = 1; last + k * pat.spacing <= tab.length; k++) tryPlace(tab, sign, last + k * pat.spacing, pat);
    }
  }
  return { rings: out, added: out.length };
}

module.exports = { fillPads, boxOf, project, lineTable };
