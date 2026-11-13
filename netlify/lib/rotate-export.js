"use strict";

/**
 * Feedback #18 prototype (/dev hosts only, off unless the request sends
 * rotate): export a drawn box that is turned on the map, so the zip's map
 * image and every object come out square to that box instead of north-up.
 *
 * The request keeps west/south/east/north as the box before it was turned
 * (its center and its ground width and length) and adds rotate, the bearing
 * of the box's top edge direction in degrees clockwise from north. The
 * export runs north-up on the smallest north-up box that holds the turned
 * box (expandedBounds), then rotateResult cuts the turned box out of that
 * result:
 *   - map image: resampled onto a grid square to the turned box (bilinear),
 *     ground meters per pixel the same as the north-up frame's east-west;
 *   - OpenIntent attenuation areas: every pixel coordinate goes through the
 *     same affine map, then each area is clipped to the new image;
 *   - Copy terrain paste and the GPS paste (meters, northeast corner 0,0):
 *     raised and sloped floors (with their heights), zones and map notes go
 *     through the same map and are clipped, notes past the edge dropped;
 *   - tie points: the turned box's southwest and northeast corners with their
 *     real lat/lon, so a two-point GPS anchor carries the turn.
 * Hamina's OpenIntent floor rotation field stays 0 (Hamina does not read it;
 * its own advice is to rotate the image before import).
 */

const { zipStore, unzipStore } = require("./zip-store");
const polygonClipping = require("polygon-clipping");

const MARGIN_M = 3;

function metersPerDeg(lat) {
  const rad = (lat * Math.PI) / 180;
  return { lon: 111320 * Math.cos(rad), lat: 110540 };
}

/** Degrees in (-180, 180]; 0 when missing, not a number, or under 0.05. */
function normalizeRotate(raw) {
  const n = +raw;
  if (raw == null || raw === "" || raw === false || !Number.isFinite(n)) return 0;
  let d = ((n % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return Math.abs(d) < 0.05 ? 0 : +d.toFixed(2);
}

/** The turned box from a request: center, ground size, bearing. */
function rotatedRect(body, deg) {
  const west = +body.west, south = +body.south, east = +body.east, north = +body.north;
  if (![west, south, east, north].every(Number.isFinite) || !(east > west) || !(north > south)) return null;
  const lon0 = (west + east) / 2;
  const lat0 = (south + north) / 2;
  const mpd = metersPerDeg(lat0);
  return { lon0, lat0, widthM: (east - west) * mpd.lon, lengthM: (north - south) * mpd.lat, deg };
}

/** Box-local meters (a right, b up, from the center) to lon/lat. */
function rectToLl(rect, a, b) {
  const t = (rect.deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const e = a * c + b * s;
  const n = -a * s + b * c;
  const mpd = metersPerDeg(rect.lat0);
  return [rect.lon0 + e / mpd.lon, rect.lat0 + n / mpd.lat];
}

/** Smallest north-up bounds holding the turned box, plus MARGIN_M. */
function expandedBounds(rect) {
  const t = (rect.deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const he = (rect.widthM / 2) * c + (rect.lengthM / 2) * s + MARGIN_M;
  const hn = (rect.widthM / 2) * s + (rect.lengthM / 2) * c + MARGIN_M;
  const mpd = metersPerDeg(rect.lat0);
  return {
    west: rect.lon0 - he / mpd.lon,
    east: rect.lon0 + he / mpd.lon,
    south: rect.lat0 - hn / mpd.lat,
    north: rect.lat0 + hn / mpd.lat,
  };
}

/**
 * Affine maps between the output grid (pixels, Y-up from the southwest, the
 * OpenIntent convention) and the north-up frame's Y-up pixels.
 * fwd: output -> frame (image sampling); inv: frame -> output (objects).
 */
function outputGrid(rect, frame) {
  const mOut = frame.widthM / frame.imgW;
  const outW = Math.max(2, Math.round(rect.widthM / mOut));
  const outH = Math.max(2, Math.round(rect.lengthM / mOut));
  const wM = outW * mOut, lM = outH * mOut;
  const toFrame = (u, v) => {
    const ll = rectToLl(rect, u * mOut - wM / 2, v * mOut - lM / 2);
    return [
      ((ll[0] - frame.west) / (frame.east - frame.west)) * frame.imgW,
      ((ll[1] - frame.south) / (frame.north - frame.south)) * frame.imgH,
    ];
  };
  const o = toFrame(0, 0), ux = toFrame(1, 0), vy = toFrame(0, 1);
  const fwd = [ux[0] - o[0], vy[0] - o[0], o[0], ux[1] - o[1], vy[1] - o[1], o[1]];
  const det = fwd[0] * fwd[4] - fwd[1] * fwd[3];
  const inv = [
    fwd[4] / det, -fwd[1] / det, 0,
    -fwd[3] / det, fwd[0] / det, 0,
  ];
  inv[2] = -(inv[0] * fwd[2] + inv[1] * fwd[5]);
  inv[5] = -(inv[3] * fwd[2] + inv[4] * fwd[5]);
  return { mOut, outW, outH, wM, lM, fwd, inv, toLl: (u, v) => rectToLl(rect, u * mOut - wM / 2, v * mOut - lM / 2) };
}

function apply(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** Bilinear resample of the north-up JPEG (Y-down rows) onto the output grid. */
function rotateImage(jpegBuf, frame, grid, quality) {
  const jpeg = require("jpeg-js");
  const src = jpeg.decode(jpegBuf, { useTArray: true, maxResolutionInMP: 40, formatAsRGBA: true });
  const sw = src.width, sh = src.height, sd = src.data;
  // The JPEG can differ from imgW x imgH by a pixel; scale to it.
  const kx = sw / frame.imgW, ky = sh / frame.imgH;
  const { outW, outH, fwd } = grid;
  const out = Buffer.alloc(outW * outH * 4);
  for (let r = 0; r < outH; r++) {
    const v = outH - r - 0.5;
    for (let c = 0; c < outW; c++) {
      const u = c + 0.5;
      const fx = (fwd[0] * u + fwd[1] * v + fwd[2]) * kx - 0.5;
      const fyDown = (frame.imgH - (fwd[3] * u + fwd[4] * v + fwd[5])) * ky - 0.5;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(sh - 2, Math.floor(fyDown)));
      const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fyDown - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (r * outW + c) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] * (1 - ax) + sd[i10 + ch] * ax;
        const bot = sd[i01 + ch] * (1 - ax) + sd[i11 + ch] * ax;
        out[o + ch] = Math.round(top * (1 - ay) + bot * ay);
      }
      out[o + 3] = 255;
    }
  }
  const enc = jpeg.encode({ data: out, width: outW, height: outH }, quality || 85);
  return Buffer.from(enc.data);
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a) / 2;
}

/** Sutherland-Hodgman against [x0,x1] x [y0,y1]; extra coordinates (z) interpolate. */
function clipRingToBox(ring, x0, y0, x1, y1) {
  let pts = ring.slice();
  if (pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) pts.pop();
  }
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cuts = [
    (a, b) => (x0 - a[0]) / (b[0] - a[0]), (a, b) => (x1 - a[0]) / (b[0] - a[0]),
    (a, b) => (y0 - a[1]) / (b[1] - a[1]), (a, b) => (y1 - a[1]) / (b[1] - a[1]),
  ];
  const lerp = (a, b, t) => a.map((v, k) => v + ((b[k] != null ? b[k] : v) - v) * t);
  for (let e = 0; e < 4 && pts.length; e++) {
    const inside = edges[e];
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) next.push(lerp(prev, cur, cuts[e](prev, cur)));
        next.push(cur);
      } else if (pi) next.push(lerp(prev, cur, cuts[e](prev, cur)));
    }
    pts = next;
  }
  return pts.length >= 3 ? pts : null;
}

function round(n, d) {
  return +(+n).toFixed(d);
}

/** OpenIntent areas: map, clip to the image (exact polygon intersection), drop slivers. */
function rotateOpenIntent(oi, grid) {
  const fp = oi && oi.floorplans && oi.floorplans[0];
  if (!fp) return { before: 0, after: 0 };
  const areas = fp.attenuation_areas || [];
  const box = [[[0, 0], [grid.outW, 0], [grid.outW, grid.outH], [0, grid.outH], [0, 0]]];
  const out = [];
  for (const a of areas) {
    const coords = a && a.area && a.area.coordinates;
    if (!Array.isArray(coords) || coords.length < 3) continue;
    const z = coords[0].coordinate_xyz ? coords[0].coordinate_xyz.z : undefined;
    const ring = coords.map((c) => apply(grid.inv, +c.coordinate_xyz.x, +c.coordinate_xyz.y));
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    if (maxX <= 0 || maxY <= 0 || minX >= grid.outW || minY >= grid.outH) continue;
    let pieces;
    if (minX >= 0 && minY >= 0 && maxX <= grid.outW && maxY <= grid.outH) pieces = [ring];
    else {
      try {
        const closed = ring.concat([ring[0]]);
        pieces = polygonClipping.intersection([closed], box).map((poly) => poly[0].slice(0, -1));
      } catch {
        const p = clipRingToBox(ring, 0, 0, grid.outW, grid.outH);
        pieces = p ? [p] : [];
      }
    }
    for (const piece of pieces) {
      if (!piece || piece.length < 3 || ringArea(piece) < 0.5) continue;
      out.push({
        area: {
          coordinates: piece.map((p) => ({
            coordinate_xyz: z != null
              ? { x: round(p[0], 2), y: round(p[1], 2), z, unit: "pixels" }
              : { x: round(p[0], 2), y: round(p[1], 2), unit: "pixels" },
          })),
        },
        area_material: a.area_material,
      });
    }
  }
  fp.attenuation_areas = out;
  const dims = fp.dimensions || [];
  for (const d of dims) {
    if (d.unit === "pixels") { d.width = grid.outW; d.length = grid.outH; }
    else if (d.unit === "meters") { d.width = grid.wM; d.length = grid.lM; }
    else if (d.unit === "feet") { d.width = grid.wM / 0.3048; d.length = grid.lM / 0.3048; }
  }
  fp.rotation = 0;
  return { before: areas.length, after: out.length };
}

/** Clipboard meters (northeast 0,0) of the north-up frame -> output clipboard meters. */
function clipPointMapper(frame, grid) {
  return (x, y) => {
    const fxUp = (x + frame.widthM) / frame.mpuX;
    const fyUp = (y + frame.lengthM) / frame.mpuY;
    const p = apply(grid.inv, fxUp, fyUp);
    return [p[0] * grid.mOut - grid.wM, p[1] * grid.mOut - grid.lM];
  };
}

/**
 * Feedback #21: Planner Plus takes a sloped floor only as an open ring of
 * exactly four xyz corners, the first edge at one low z and the opposite edge
 * at one higher z ("Sloped floor coordinates are not valid!" otherwise).
 * Raised floors from Copy terrain are open four-corner rings too. Cutting a
 * turned quad at the box edge leaves a triangle, pentagon or hexagon, and the
 * old code also repeated the first corner, so every turned sloped floor was
 * rejected. A cut piece is sliced into bands between its corner levels (z for
 * a sloped floor, x for a raised one). Each band is a four-corner piece; a
 * band that ends in a point gets a 5 cm edge there so it keeps four corners.
 */
const TIP_M = 0.05;

function sameXy2(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Hamina's sloped-floor rule (same as terrain.planarSlopedRamp). */
function validSlopedRing(ring) {
  if (!ring || ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    if (!p || p.length !== 3 || !p.every(Number.isFinite)) return false;
    if (sameXy2(p, ring[(i + 1) % 4])) return false;
  }
  if (ring[0][2] !== ring[1][2] || ring[2][2] !== ring[3][2]) return false;
  if (!(ring[2][2] > ring[0][2])) return false;
  return Math.abs(signedArea(ring)) > 5e-5;
}

function validFlatRing(ring) {
  if (!ring || ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    if (!p || !p.every(Number.isFinite)) return false;
    if (sameXy2(p, ring[(i + 1) % 4])) return false;
  }
  return Math.abs(signedArea(ring)) > 5e-5;
}

/** Keep the part of a ring where key(p) lies in [lo, hi]; extra coordinates interpolate. */
function clipRingByKey(ring, key, lo, hi) {
  let pts = ring;
  const lerp = (a, b, t) => a.map((v, k) => v + ((b[k] != null ? b[k] : v) - v) * t);
  for (const [inside, level] of [[(p) => key(p) >= lo, lo], [(p) => key(p) <= hi, hi]]) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      const cross = () => {
        const kp = key(prev), kc = key(cur);
        const p = lerp(prev, cur, (level - kp) / (kc - kp));
        return p;
      };
      if (ci) {
        if (!pi) next.push(cross());
        next.push(cur);
      } else if (pi) next.push(cross());
    }
    pts = next;
    if (!pts.length) break;
  }
  return pts;
}

/**
 * Slice a convex piece into four-corner bands between its distinct levels.
 * level(p) is the band key; dir is the direction along a level (unit xy).
 * setLevel(p, L) returns p with the band key fixed to exactly L (z for a
 * sloped floor). Each band ring is [lo a, lo b, hi b, hi a], counterclockwise.
 */
function sliceIntoBands(ring, level, dir, setLevel) {
  const levels = Array.from(new Set(ring.map(level))).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < levels.length; i++) {
    const lo = levels[i], hi = levels[i + 1];
    const band = clipRingByKey(ring, level, lo, hi);
    if (band.length < 3) continue;
    const ends = [lo, hi].map((L) => {
      const span = Math.max(1e-6, (hi - lo) * 1e-6);
      const pts = band.filter((p) => Math.abs(level(p) - L) <= span);
      if (!pts.length) return null;
      let a = pts[0], b = pts[0];
      const t = (p) => p[0] * dir[0] + p[1] * dir[1];
      for (const p of pts) {
        if (t(p) < t(a)) a = p;
        if (t(p) > t(b)) b = p;
      }
      if (t(b) - t(a) < TIP_M / 2) {
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        a = a.slice(); b = b.slice();
        a[0] = mx - (dir[0] * TIP_M) / 2; a[1] = my - (dir[1] * TIP_M) / 2;
        b[0] = mx + (dir[0] * TIP_M) / 2; b[1] = my + (dir[1] * TIP_M) / 2;
      }
      return [setLevel(a, L), setLevel(b, L)];
    });
    if (!ends[0] || !ends[1]) continue;
    let q = [ends[0][0], ends[0][1], ends[1][1], ends[1][0]];
    if (signedArea(q) < 0) q = [ends[0][1], ends[0][0], ends[1][0], ends[1][1]];
    out.push(q);
  }
  return out;
}

/** Plane fit z = gx*x + gy*y + c; returns the unit direction along a contour. */
function contourDir(ring) {
  const n = ring.length;
  let sx = 0, sy = 0, sz = 0;
  for (const p of ring) { sx += p[0]; sy += p[1]; sz += p[2]; }
  const mx = sx / n, my = sy / n, mz = sz / n;
  let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
  for (const p of ring) {
    const dx = p[0] - mx, dy = p[1] - my, dz = p[2] - mz;
    xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz;
  }
  const det = xx * yy - xy * xy;
  let gx, gy;
  if (Math.abs(det) > 1e-12) {
    gx = (xz * yy - yz * xy) / det;
    gy = (yz * xx - xz * xy) / det;
  } else {
    // Fall back to the first edge, which is the low contour of a Hamina ramp.
    const ex = ring[1][0] - ring[0][0], ey = ring[1][1] - ring[0][1];
    const len = Math.hypot(ex, ey) || 1;
    return [ex / len, ey / len];
  }
  const len = Math.hypot(gx, gy);
  if (!(len > 0)) return [1, 0];
  return [-gy / len, gx / len];
}

function roundPt(p) {
  return p.map((v, i) => round(v, i < 2 ? 4 : 3));
}

/** One mapped floor ring (open, xy or xyz) -> pasteable open four-corner rings. */
function floorPieces(outer, grid, sloped) {
  const cut = clipRingToBox(outer, -grid.wM, -grid.lM, 0, 0);
  if (!cut || ringArea(cut) < 0.01) return [];
  const whole = cut.length === 4 && outer.length === 4 && cut.every((p, i) => p === outer[i]);
  let pieces;
  if (whole) pieces = [cut];
  else if (sloped) {
    const r3 = cut.map((p) => p.slice(0, 2).concat([round(p[2], 3)]));
    pieces = sliceIntoBands(r3, (p) => p[2], contourDir(r3), (p, L) => [p[0], p[1], L]);
  } else {
    pieces = sliceIntoBands(cut, (p) => p[0], [0, 1], (p, L) => [L].concat(p.slice(1)));
  }
  const out = [];
  // A 5 cm tip edge at the box edge stays on the map.
  const clamp = (p) => [Math.min(0, Math.max(-grid.wM, p[0])), Math.min(0, Math.max(-grid.lM, p[1]))].concat(p.slice(2));
  for (const piece of pieces) {
    const ring = piece.map((p) => roundPt(clamp(p)));
    if (sloped ? validSlopedRing(ring) : validFlatRing(ring)) out.push(ring);
  }
  return out;
}

function rotateClipboard(clip, frame, grid) {
  if (!clip) return clip;
  const map = clipPointMapper(frame, grid);
  const counts = {};
  for (const k of ["raisedFloorZones", "slopedFloors", "attenuatingZones", "scopeZones", "holeInFloorZones"]) {
    const list = clip[k];
    if (!Array.isArray(list) || !list.length) continue;
    const floor = k === "raisedFloorZones" || k === "slopedFloors";
    const next = [];
    for (const item of list) {
      const rings = item && item.area && item.area.coordinates;
      if (!Array.isArray(rings) || !Array.isArray(rings[0])) continue;
      let src = rings[0];
      if (floor && src.length > 1 && sameXy2(src[0], src[src.length - 1])) src = src.slice(0, -1);
      const outer = src.map((pt) => {
        const q = map(+pt[0], +pt[1]);
        return pt.length > 2 ? [q[0], q[1]].concat(pt.slice(2)) : q;
      });
      if (floor) {
        // Copy terrain floors stay open rings of four corners.
        for (const ring of floorPieces(outer, grid, k === "slopedFloors")) {
          next.push(Object.assign({}, item, { area: Object.assign({}, item.area, { coordinates: [ring] }) }));
        }
        continue;
      }
      const cut = clipRingToBox(outer, -grid.wM, -grid.lM, 0, 0);
      if (!cut || ringArea(cut) < 0.01) continue;
      const ring = cut.map(roundPt);
      ring.push(ring[0].slice());
      next.push(Object.assign({}, item, { area: Object.assign({}, item.area, { coordinates: [ring] }) }));
    }
    counts[k] = [list.length, next.length];
    clip[k] = next;
  }
  if (Array.isArray(clip.mapNotes)) {
    const before = clip.mapNotes.length;
    clip.mapNotes = clip.mapNotes
      .map((n) => {
        const q = map(+n.x, +n.y);
        return Object.assign({}, n, { x: round(q[0], 4), y: round(q[1], 4) });
      })
      .filter((n) => n.x >= -grid.wM && n.x <= 0 && n.y >= -grid.lM && n.y <= 0);
    counts.mapNotes = [before, clip.mapNotes.length];
  }
  clip.tiePoints = tiePoints(grid);
  return counts;
}

function tiePoints(grid) {
  const sw = grid.toLl(0, 0), ne = grid.toLl(grid.outW, grid.outH);
  return [
    { lat: sw[1], lon: sw[0], x: round(-grid.wM, 6), y: round(-grid.lM, 6) },
    { lat: ne[1], lon: ne[0], x: 0, y: 0 },
  ];
}

/** The frame the page and the status show for a turned export. */
function rotatedFrame(rect, frame, grid) {
  const c = (u, v) => grid.toLl(u, v).map((n) => +n.toFixed(7));
  return {
    rotateDeg: rect.deg,
    widthM: grid.wM,
    lengthM: grid.lM,
    imgW: grid.outW,
    imgH: grid.outH,
    mpuX: grid.mOut,
    mpuY: grid.mOut,
    origin: frame.origin,
    corners: { sw: c(0, 0), se: c(grid.outW, 0), ne: c(grid.outW, grid.outH), nw: c(0, grid.outH) },
    northUpFrame: { west: frame.west, south: frame.south, east: frame.east, north: frame.north, imgW: frame.imgW, imgH: frame.imgH },
    clipboardCorners: { sw: [round(-grid.wM, 6), round(-grid.lM, 6)], se: [0, round(-grid.lM, 6)], nw: [round(-grid.wM, 6), 0], ne: [0, 0] },
  };
}

/**
 * Turn a finished north-up bundle result (the parsed JSON body) into the
 * turned box. Returns the new body object; leaves anything it cannot read as is.
 */
function rotateResult(payload, rect, opts) {
  if (!payload || !payload.frame || !rect) return payload;
  const frame = payload.frame;
  if (![frame.west, frame.east, frame.south, frame.north, frame.imgW, frame.imgH, frame.widthM, frame.lengthM, frame.mpuX, frame.mpuY].every((n) => Number.isFinite(+n))) {
    return payload;
  }
  const grid = outputGrid(rect, frame);
  const out = Object.assign({}, payload);
  const rotation = { deg: rect.deg, northUpImg: [frame.imgW, frame.imgH], img: [grid.outW, grid.outH] };
  if (payload.zipBase64) {
    const files = unzipStore(Buffer.from(payload.zipBase64, "base64"));
    const names = Object.keys(files);
    const oiName = names.find((n) => /^openIntent_.*\.json$/i.test(n));
    const imgName = names.find((n) => /^images\/.*\.jpe?g$/i.test(n));
    if (!oiName || !imgName) return payload;
    const oi = JSON.parse(files[oiName].toString("utf8"));
    rotation.areas = rotateOpenIntent(oi, grid);
    const img = rotateImage(files[imgName], frame, grid, (opts && opts.quality) || 85);
    const order = [oiName, imgName].concat(names.filter((n) => n !== oiName && n !== imgName));
    const data = { [oiName]: Buffer.from(JSON.stringify(oi)), [imgName]: img };
    const zip = zipStore(order.map((n) => ({ name: n, data: data[n] || files[n] })));
    out.zipBase64 = zip.toString("base64");
    rotation.oiJsonBytes = data[oiName].length;
    rotation.imageBytes = img.length;
    rotation.zipBytes = zip.length;
  }
  rotation.clipboard = {};
  if (out.terrainClipboard) rotation.clipboard.terrain = rotateClipboard(out.terrainClipboard, frame, grid);
  if (out.gpsClipboard) rotation.clipboard.gps = rotateClipboard(out.gpsClipboard, frame, grid);
  out.frame = rotatedFrame(rect, frame, grid);
  out.stats = Object.assign({}, out.stats || {}, { rotation });
  out.warnings = (out.warnings || []).concat([
    "Turned export (prototype): map and objects are square to the box drawn at " + rect.deg + " degrees.",
  ]);
  return out;
}

module.exports = {
  normalizeRotate,
  rotatedRect,
  rectToLl,
  expandedBounds,
  outputGrid,
  rotateResult,
  rotateOpenIntent,
  rotateClipboard,
  clipRingToBox,
  floorPieces,
  validSlopedRing,
  MARGIN_M,
};
