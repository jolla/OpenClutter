"use strict";

/**
 * Vehicles and mobile structures.
 *
 * OSM supplies the pad, the slip, the truck lot, or the surface lot.
 * The aerial says whether a light vehicle is sitting on a camp pad.
 * A metal RV or travel trailer is a solid box at 12 dB/m.
 * Cars in a dense lot are one 1.5 m layer, not one area per car.
 * A truck lot, and the dock apron of a large warehouse, keep a metal semi
 * where the aerial shows a trailer. Empty pavement stays empty.
 * A boat is about 3.5 m. A mobile home is a building at about 4 m
 * and is emitted on the building path, not here.
 *
 * A light pixel is not a survey. Dark vehicles on dark pavement are easy
 * to miss. The scoreboard says which labels were checked by eye.
 */

const { llToImagePx } = require("./geo-frame");

const RV_LENGTH_M = 12;
const RV_WIDTH_M = 2.6;
const RV_HEIGHT_M = 3.5;
const RV_DB = 12;

const TRAILER_LENGTH_M = 8.5;
const TRAILER_WIDTH_M = 2.5;
const TRAILER_HEIGHT_M = 3.2;
const TRAILER_DB = 12;

const SEMI_LENGTH_M = 16.2;
const SEMI_WIDTH_M = 2.6;
const SEMI_HEIGHT_M = 4.1;
const SEMI_DB = 12;

const BOAT_LENGTH_M = 8;
const BOAT_WIDTH_M = 2.8;
const BOAT_HEIGHT_M = 3.5;
const BOAT_DB = 6;

const CAR_LENGTH_M = 4.5;
const CAR_WIDTH_M = 1.8;
const CAR_LAYER_M = 1.5;
const CAR_DB = 6;

const MOBILE_HOME_M = 4;

/** A light roof on the pad, in square metres. Smaller is gravel. Larger is a building or a woods. */
const OCCUPIED_LO = 6;
const OCCUPIED_HI = 180;
/** A white roof has to touch the pad. A few meters of grass is the next site. */
const ROOF_TOUCH_M = 3;
const ROOF_MIN_M2 = 1.4;
const CAR_MERGE_MIN = 8;
const SEMI_CAP = 320;
/**
 * A parked semi sits out from the dock wall, often in more than one row.
 * Six trailer lengths covers a yard beside a long wall. Empty pavement
 * still has to show a trailer body and a row.
 */
const DOCK_DEPTH_M = 96;
const DOCK_MIN_EDGE_M = 28;
const DOCK_MIN_ROOF_M2 = 8000;
const BOAT_CAP = 200;

const BOX = {
  rv: { kind: "rv", length: RV_LENGTH_M, width: RV_WIDTH_M, height: RV_HEIGHT_M },
  trailer: { kind: "trailer", length: TRAILER_LENGTH_M, width: TRAILER_WIDTH_M, height: TRAILER_HEIGHT_M },
  semi: { kind: "semi", length: SEMI_LENGTH_M, width: SEMI_WIDTH_M, height: SEMI_HEIGHT_M },
  boat: { kind: "boat", length: BOAT_LENGTH_M, width: BOAT_WIDTH_M, height: BOAT_HEIGHT_M },
  car: { kind: "car", length: CAR_LENGTH_M, width: CAR_WIDTH_M, height: CAR_LAYER_M },
};

function pitchClass(name, tags) {
  const raw = String(name || (tags && (tags.name || tags.ref)) || "").trim();
  const upper = raw.toUpperCase();
  if (/^RV(\b|\d)/.test(upper)) return "rv";
  if (/^TS(\b|\d)/.test(upper) || /^TENT\b/.test(upper)) return "tent";
  return "";
}

function isTruckLotTags(tags) {
  if (!tags) return false;
  if (tags.parking === "truck" || tags.parking === "hgv") return true;
  if (tags.hgv === "yes" || tags.hgv === "designated") return true;
  if (/truck/i.test(String(tags.name || ""))) return true;
  return false;
}

function isMarinaTags(tags) {
  if (!tags) return false;
  return tags.leisure === "marina" || tags.landuse === "harbour";
}

function isMooringTags(tags) {
  if (!tags) return false;
  if (tags.mooring) return true;
  if (tags.leisure === "slipway") return true;
  const seamark = String(tags["seamark:type"] || "");
  return seamark === "mooring";
}

/**
 * A light neutral roof. Green lawn and orange fall leaves are not a vehicle.
 * @returns {boolean}
 */
function vehiclePixel(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 135 || y > 250) return false;
  if (g > r + 12 && g > b + 8) return false;
  if (r > b + 40 && r > g + 6) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= 55;
}

function pointInRing(pt, ring) {
  if (!pt || !ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    const xi = ring[i][0];
    const xj = ring[j][0];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function pixelAreaM2(frame) {
  if (!frame || !(frame.imgW > 1) || !(frame.imgH > 1)) return 0;
  if (frame.mpuX > 0 && frame.mpuY > 0) return frame.mpuX * frame.mpuY;
  const lat = ((+frame.south || 0) + (+frame.north || 0)) / 2;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mpuX = (Math.abs(+frame.east - +frame.west) * mLon) / frame.imgW;
  const mpuY = (Math.abs(+frame.north - +frame.south) * 110540) / frame.imgH;
  return mpuX * mpuY;
}

/** Largest connected light roof inside the ring, in square metres. */
function vehicleBlobM2(ring, frame, plate) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return null;
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return null;
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(plate.width - 1, Math.ceil(maxX));
  const y1 = Math.min(plate.height - 1, Math.ceil(maxY));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 2 || bh < 2 || bw * bh > 250000) return null;
  const mask = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInRing([x + 0.5, y + 0.5], poly)) continue;
      const i = (y * plate.width + x) * 4;
      if (vehiclePixel(plate.data[i], plate.data[i + 1], plate.data[i + 2])) mask[(y - y0) * bw + (x - x0)] = 1;
    }
  }
  const seen = new Uint8Array(bw * bh);
  let best = 0;
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      n++;
      const x = k % bw;
      const y = (k / bw) | 0;
      const nbrs = [x - 1, x + 1, x, x];
      const nbry = [y, y, y - 1, y + 1];
      for (let q = 0; q < 4; q++) {
        const nx = nbrs[q];
        const ny = nbry[q];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!mask[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (n > best) best = n;
  }
  const area = pixelAreaM2(frame);
  if (!(area > 0)) return null;
  return best * area;
}

function ringFraction(ring, frame, plate) {
  return vehicleBlobM2(ring, frame, plate);
}

function isWhiteRoofPixel(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 165 || y > 252) return false;
  if (g > r + 10 && g > b + 6) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 50;
}

/**
 * The white roof has to sit on the pad. A roof a few meters away, across
 * grass, belongs to the next site and does not count. A neighbor roof that
 * only clips the pad is kept out when it is a wide sheet mostly outside the
 * pad, or a short blob that is not elongated like an RV. A real roof can
 * sit about 3 m off the spur and still count when it is long and narrow.
 */
function roofExtent(cells, x0, y0, bw, frame) {
  const lat0 = ((+frame.south || 0) + (+frame.north || 0)) / 2;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i < cells.length; i++) {
    const x = x0 + (cells[i] % bw) + 0.5;
    const y = y0 + ((cells[i] / bw) | 0) + 0.5;
    const lon = frame.west + (x / frame.imgW) * (frame.east - frame.west);
    const lat = frame.north - (y / frame.imgH) * (frame.north - frame.south);
    pts.push([lon * mLon, lat * 110540]);
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < pts.length; i++) {
    sx += pts[i][0];
    sy += pts[i][1];
  }
  sx /= pts.length;
  sy /= pts.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - sx;
    const dy = pts[i][1] - sy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const tr = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const major = tr / 2 + disc;
  const ang = Math.abs(xy) + Math.abs(major - xx) < 1e-6 ? 0 : Math.atan2(major - xx, xy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - sx;
    const dy = pts[i][1] - sy;
    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { len: maxU - minU, wid: maxV - minV, ux, uy, cx: sx, cy: sy, mLon };
}

/** Degrees between the roof's long axis and the nearest pad edge. */
function edgeAngleDeg(extent, ring) {
  let bestD = 1e18;
  let eux = 1;
  let euy = 0;
  for (let k = 0; k < ring.length - 1; k++) {
    const ax = ring[k][0] * extent.mLon;
    const ay = ring[k][1] * 110540;
    const bx = ring[k + 1][0] * extent.mLon;
    const by = ring[k + 1][1] * 110540;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 4) continue;
    let t = ((extent.cx - ax) * dx + (extent.cy - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ex = extent.cx - (ax + t * dx);
    const ey = extent.cy - (ay + t * dy);
    const d = ex * ex + ey * ey;
    if (d < bestD) {
      bestD = d;
      const len = Math.sqrt(len2);
      eux = dx / len;
      euy = dy / len;
    }
  }
  const dot = Math.abs(extent.ux * eux + extent.uy * euy);
  return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

function pitchVehicle(ring, frame, plate) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return null;
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return { m2: 0, lon: null, lat: null };
  const mpu = Math.min(frame.mpuX || 1, frame.mpuY || 1);
  const mpuX = frame.mpuX > 0 ? frame.mpuX : mpu;
  const mpuY = frame.mpuY > 0 ? frame.mpuY : mpu;
  const padPx = Math.max(2, Math.round(ROOF_TOUCH_M / Math.min(mpuX, mpuY)) + 2);
  const x0 = Math.max(0, Math.floor(minX) - padPx);
  const y0 = Math.max(0, Math.floor(minY) - padPx);
  const x1 = Math.min(plate.width - 1, Math.ceil(maxX) + padPx);
  const y1 = Math.min(plate.height - 1, Math.ceil(maxY) + padPx);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 2 || bh < 2 || bw * bh > 400000) return { m2: 0, lon: null, lat: null };
  function distM(px, py) {
    if (pointInRing([px, py], poly)) return 0;
    let d2 = 1e18;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = px - (a[0] + t * dx);
      const ey = py - (a[1] + t * dy);
      d2 = Math.min(d2, ex * ex + ey * ey);
    }
    return Math.sqrt(d2) * Math.min(mpuX, mpuY);
  }
  const mask = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * plate.width + x) * 4;
      if (!isWhiteRoofPixel(plate.data[i], plate.data[i + 1], plate.data[i + 2])) continue;
      if (distM(x + 0.5, y + 0.5) > ROOF_TOUCH_M + 0.5) continue;
      mask[(y - y0) * bw + (x - x0)] = 1;
    }
  }
  const seen = new Uint8Array(bw * bh);
  const stack = [];
  let best = null;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const cells = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const x = k % bw;
      const y = (k / bw) | 0;
      const nbrs = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
        [x - 1, y - 1],
        [x + 1, y - 1],
        [x - 1, y + 1],
        [x + 1, y + 1],
      ];
      for (let q = 0; q < nbrs.length; q++) {
        const nx = nbrs[q][0];
        const ny = nbrs[q][1];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!mask[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    const m2 = cells.length * mpuX * mpuY;
    if (m2 < ROOF_MIN_M2) continue;
    let dmin = 1e9;
    let inside = 0;
    for (let c = 0; c < cells.length; c++) {
      const x = x0 + (cells[c] % bw) + 0.5;
      const y = y0 + ((cells[c] / bw) | 0) + 0.5;
      const d = distM(x, y);
      if (d < dmin) dmin = d;
      if (d <= 0) inside++;
    }
    if (dmin > ROOF_TOUCH_M) continue;
    const extent = roofExtent(cells, x0, y0, bw, frame);
    const aspect = extent.wid > 0.25 ? extent.len / extent.wid : 99;
    const inFrac = inside / cells.length;
    // A wide sheet that mostly belongs to the next roof is not this pad.
    if (extent.wid >= 10 && inFrac < 0.35) continue;
    // A short blob that is not stretched along the roof is gravel or a corner.
    if (aspect < 1.7 && m2 < 12 && inFrac < 0.4) continue;
    // A small roof has to run along the pad edge, not across it.
    if (m2 < 8 && edgeAngleDeg(extent, ring) > 35) continue;
    if (!best || m2 > best.m2) best = { m2, touch: dmin <= 0.4 };
  }
  if (!best) return { m2: 0, lon: null, lat: null };
  const c = centroidLL(ring);
  if (!c) return { m2: OCCUPIED_LO + 1, lon: null, lat: null, onPad: best.touch };
  return { m2: OCCUPIED_LO + 1, lon: c[0], lat: c[1], onPad: best.touch };
}

/**
 * Largest light roof inside the pad or within radiusM of it.
 * Returns null when the plate cannot be read.
 */
function vehicleNear(ring, frame, plate, radiusM) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return null;
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return null;
  const lat = ((+frame.south || 0) + (+frame.north || 0)) / 2;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mpuX = frame.mpuX > 0 ? frame.mpuX : (Math.abs(+frame.east - +frame.west) * mLon) / frame.imgW;
  const mpuY = frame.mpuY > 0 ? frame.mpuY : (Math.abs(+frame.north - +frame.south) * 110540) / frame.imgH;
  const rad = Math.max(2, Math.round((radiusM > 0 ? radiusM : 8) / Math.min(mpuX, mpuY)));
  const x0 = Math.max(0, Math.floor(minX) - rad);
  const y0 = Math.max(0, Math.floor(minY) - rad);
  const x1 = Math.min(plate.width - 1, Math.ceil(maxX) + rad);
  const y1 = Math.min(plate.height - 1, Math.ceil(maxY) + rad);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 2 || bh < 2 || bw * bh > 400000) return null;
  const near = new Uint8Array(bw * bh);
  const rad2 = rad * rad;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let ok = pointInRing([px, py], poly);
      if (!ok) {
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k];
          const b = poly[(k + 1) % poly.length];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const ex = px - (a[0] + t * dx);
          const ey = py - (a[1] + t * dy);
          if (ex * ex + ey * ey <= rad2) {
            ok = true;
            break;
          }
        }
      }
      if (ok) near[(y - y0) * bw + (x - x0)] = 1;
    }
  }
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < near.length; i++) {
    if (!near[i]) continue;
    const x = x0 + (i % bw);
    const y = y0 + ((i / bw) | 0);
    const p = (y * plate.width + x) * 4;
    if (vehiclePixel(plate.data[p], plate.data[p + 1], plate.data[p + 2])) mask[i] = 1;
  }
  const seen = new Uint8Array(bw * bh);
  let bestN = 0;
  let bestCells = null;
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const cells = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const x = k % bw;
      const y = (k / bw) | 0;
      const nbrs = [x - 1, x + 1, x, x];
      const nbry = [y, y, y - 1, y + 1];
      for (let q = 0; q < 4; q++) {
        const nx = nbrs[q];
        const ny = nbry[q];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!mask[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (cells.length > bestN) {
      bestN = cells.length;
      bestCells = cells;
    }
  }
  const area = mpuX * mpuY;
  if (!(area > 0)) return null;
  if (!bestCells) return { m2: 0, lon: null, lat: null };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < bestCells.length; i++) {
    sx += x0 + (bestCells[i] % bw) + 0.5;
    sy += y0 + ((bestCells[i] / bw) | 0) + 0.5;
  }
  const cx = sx / bestCells.length;
  const cy = sy / bestCells.length;
  const lon = frame.west + (cx / frame.imgW) * (frame.east - frame.west);
  const lat2 = frame.north - (cy / frame.imgH) * (frame.north - frame.south);
  return { m2: bestN * area, lon, lat: lat2 };
}

function recenterBox(feature, lon, lat) {
  if (!feature || !feature.coords || !Number.isFinite(lon) || !Number.isFinite(lat)) return feature;
  const spec = feature.kind === "trailer-candidate" || feature.kind === "trailer" ? BOX.trailer : BOX.rv;
  const proj = projectAt(lat);
  const pts = [];
  for (let i = 0; i < feature.coords.length; i++) pts.push(proj.to(feature.coords[i][0], feature.coords[i][1]));
  const heading = longHeading(pts);
  const xy = proj.to(lon, lat);
  const next = Object.assign({}, feature, {
    coords: orientedRing(proj, xy[0], xy[1], heading, spec.length, spec.width),
  });
  return next;
}

function occupiedCall(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return null;
  return fraction >= OCCUPIED_LO && fraction <= OCCUPIED_HI;
}

/**
 * @param {string} use rv | tent | pitch | road | ""
 * @param {number|null} fraction
 * @returns {""|"rv"|"trailer"}
 */
function decidePitch(use, fraction) {
  const occupied = occupiedCall(fraction);
  if (use === "road" || use === "") return "rv";
  if (use === "tent") return occupied === true ? "trailer" : "";
  if (occupied === false) return "";
  return "rv";
}

function finalizeVehicles(features, fractionFor) {
  return require("./stage-clock").timeSpanSync("vehicle", () => finalizeVehiclesWork(features, fractionFor));
}

function finalizeVehiclesWork(features, fractionFor) {
  const out = [];
  const list = features || [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f) continue;
    if (f.kind !== "rv" && f.kind !== "trailer-candidate") {
      out.push(f);
      continue;
    }
    const use = f.pitchUse || "";
    if (f.kind === "rv" && (use === "" || use === "road")) {
      out.push(f);
      continue;
    }
    let fraction = null;
    let found = null;
    if (typeof fractionFor === "function") {
      const ring = f.pad && f.pad.length >= 3 ? f.pad : f.coords;
      found = fractionFor(ring);
      fraction = found && typeof found === "object" ? found.m2 : found;
    }
    const cls = decidePitch(use, fraction);
    if (cls === "trailer" && f.kind === "trailer-candidate") {
      if (!found || found.onPad !== true) continue;
      let next = Object.assign({}, f, { kind: "trailer" });
      if (found && Number.isFinite(found.lon)) next = recenterBox(next, found.lon, found.lat);
      out.push(next);
      continue;
    }
    if (cls === "rv" && f.kind === "rv") {
      let next = f;
      if (found && Number.isFinite(found.lon)) next = recenterBox(f, found.lon, found.lat);
      out.push(next);
    }
  }
  return out;
}

function decodePlate(buf) {
  if (!buf || buf.length < 20) return null;
  try {
    const jpeg = require("jpeg-js");
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    if (!img || !(img.width > 1) || !img.data) return null;
    return { width: img.width, height: img.height, data: img.data };
  } catch (err) {
    return null;
  }
}

function needsPitchImage(features) {
  for (let i = 0; i < (features || []).length; i++) {
    const f = features[i];
    if (!f) continue;
    if (f.kind === "trailer-candidate") return true;
    if (f.kind === "marina" || f.kind === "mobile-park" || f.kind === "truck-lot" || f.kind === "car") return true;
    if (f.kind === "rv" && (f.pitchUse === "rv" || f.pitchUse === "tent" || f.pitchUse === "pitch")) return true;
  }
  return false;
}

function projectAt(lat) {
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return {
    to(lon, lat2) {
      return [lon * mLon, lat2 * 110540];
    },
    from(x, y) {
      return [x / mLon, y / 110540];
    },
  };
}

function centroidLL(coords) {
  if (!coords || !coords.length) return null;
  let n = coords.length;
  const a = coords[0];
  const b = coords[n - 1];
  if (n > 1 && Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) n--;
  if (n < 1) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += coords[i][0];
    sy += coords[i][1];
  }
  return [sx / n, sy / n];
}

function longHeading(pts) {
  let best = 0;
  let ux = 1;
  let uy = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const d = dx * dx + dy * dy;
      if (d > best) {
        best = d;
        const len = Math.sqrt(d) || 1;
        ux = dx / len;
        uy = dy / len;
      }
    }
  }
  return { ux, uy };
}

function orientedRing(proj, x, y, heading, lengthM, widthM) {
  const hl = lengthM / 2;
  const hw = widthM / 2;
  const px = -heading.uy;
  const py = heading.ux;
  const corners = [
    [x + heading.ux * hl + px * hw, y + heading.uy * hl + py * hw],
    [x - heading.ux * hl + px * hw, y - heading.uy * hl + py * hw],
    [x - heading.ux * hl - px * hw, y - heading.uy * hl - py * hw],
    [x + heading.ux * hl - px * hw, y + heading.uy * hl - py * hw],
  ];
  const ring = [];
  for (let i = 0; i < corners.length; i++) ring.push(proj.from(corners[i][0], corners[i][1]));
  ring.push(ring[0]);
  return ring;
}

function semiBoxes(lots) {
  const out = [];
  const spec = BOX.semi;
  for (let i = 0; i < (lots || []).length && out.length < SEMI_CAP; i++) {
    const lot = lots[i];
    if (!lot || !lot.coords || lot.coords.length < 4) continue;
    const origin = centroidLL(lot.coords);
    if (!origin) continue;
    const proj = projectAt(origin[1]);
    const pts = [];
    for (let k = 0; k < lot.coords.length; k++) pts.push(proj.to(lot.coords[k][0], lot.coords[k][1]));
    const heading = longHeading(pts);
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    const px = -heading.uy;
    const py = heading.ux;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k][0] * heading.ux + pts[k][1] * heading.uy;
      const b = pts[k][0] * px + pts[k][1] * py;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const along = spec.length + 2;
    const across = spec.width + 1.6;
    for (let a = minA + spec.length / 2 + 1; a <= maxA - spec.length / 2 && out.length < SEMI_CAP; a += along) {
      for (let b = minB + spec.width / 2 + 1; b <= maxB - spec.width / 2 && out.length < SEMI_CAP; b += across) {
        const x = heading.ux * a + px * b;
        const y = heading.uy * a + py * b;
        if (!pointInRing([x, y], pts)) continue;
        const ring = orientedRing(proj, x, y, heading, spec.length, spec.width);
        out.push({
          kind: "semi",
          coords: ring,
          closed: true,
          heightM: spec.height,
          explicitHeight: true,
          rank: 0,
        });
      }
    }
  }
  return out;
}

function boatBoxes(features) {
  const marinas = [];
  const moorings = [];
  for (let i = 0; i < (features || []).length; i++) {
    const f = features[i];
    if (!f) continue;
    if (f.kind === "marina" && f.coords && f.coords.length >= 4) marinas.push(f);
    else if (f.kind === "mooring" && f.coords && f.coords.length) moorings.push(f);
  }
  const out = [];
  const spec = BOX.boat;
  for (let i = 0; i < moorings.length && out.length < BOAT_CAP; i++) {
    const m = moorings[i];
    const center = m.coords.length === 1 ? m.coords[0] : centroidLL(m.coords);
    if (!center) continue;
    if (marinas.length) {
      let inside = false;
      for (let k = 0; k < marinas.length; k++) {
        if (pointInRing(center, marinas[k].coords)) inside = true;
      }
      if (!inside) continue;
    }
    const proj = projectAt(center[1]);
    let heading = { ux: 1, uy: 0 };
    if (m.coords.length >= 2) {
      const pts = [];
      for (let k = 0; k < m.coords.length; k++) pts.push(proj.to(m.coords[k][0], m.coords[k][1]));
      heading = longHeading(pts);
    }
    const xy = proj.to(center[0], center[1]);
    out.push({
      kind: "boat",
      coords: orientedRing(proj, xy[0], xy[1], heading, spec.length, spec.width),
      closed: true,
      heightM: spec.height,
      explicitHeight: true,
      rank: 0,
    });
  }
  return out;
}

function clusterRows(pts) {
  if (!pts.length) return [];
  const heading = longHeading(pts);
  const px = -heading.uy;
  const py = heading.ux;
  const tagged = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i][0] * heading.ux + pts[i][1] * heading.uy;
    const b = pts[i][0] * px + pts[i][1] * py;
    tagged.push({ a, b, x: pts[i][0], y: pts[i][1] });
  }
  tagged.sort((p, q) => p.b - q.b || p.a - q.a);
  const rows = [];
  for (let i = 0; i < tagged.length; i++) {
    const prev = rows[rows.length - 1];
    if (!prev || Math.abs(tagged[i].b - prev.b) > 3.2) rows.push({ b: tagged[i].b, items: [tagged[i]] });
    else {
      prev.items.push(tagged[i]);
      prev.b = (prev.b * (prev.items.length - 1) + tagged[i].b) / prev.items.length;
    }
  }
  return { heading, px, py, rows };
}

/**
 * Fewer than 8 cars stay individual boxes. A denser lot becomes one layer per row.
 * @param {Array<[number, number]>} lonlat
 */
function mergeDenseCars(lonlat) {
  const points = lonlat || [];
  if (!points.length) return [];
  const origin = points[0];
  const proj = projectAt(origin[1]);
  const pts = [];
  for (let i = 0; i < points.length; i++) pts.push(proj.to(points[i][0], points[i][1]));
  if (points.length < CAR_MERGE_MIN) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      out.push({
        kind: "car",
        coords: orientedRing(proj, pts[i][0], pts[i][1], { ux: 1, uy: 0 }, CAR_LENGTH_M, CAR_WIDTH_M),
        closed: true,
        heightM: CAR_LAYER_M,
        explicitHeight: true,
        merged: false,
        rank: 0,
      });
    }
    return out;
  }
  const clustered = clusterRows(pts);
  const out = [];
  for (let r = 0; r < clustered.rows.length; r++) {
    const row = clustered.rows[r];
    let minA = Infinity;
    let maxA = -Infinity;
    for (let i = 0; i < row.items.length; i++) {
      if (row.items[i].a < minA) minA = row.items[i].a;
      if (row.items[i].a > maxA) maxA = row.items[i].a;
    }
    const midA = (minA + maxA) / 2;
    const len = Math.max(CAR_LENGTH_M, maxA - minA + CAR_LENGTH_M);
    const x = clustered.heading.ux * midA + clustered.px * row.b;
    const y = clustered.heading.uy * midA + clustered.py * row.b;
    out.push({
      kind: "car",
      coords: orientedRing(proj, x, y, clustered.heading, len, CAR_WIDTH_M + 0.6),
      closed: true,
      heightM: CAR_LAYER_M,
      explicitHeight: true,
      merged: true,
      rank: 0,
    });
  }
  return out;
}

/**
 * Where cars sit in a row, grow one layer around that row.
 * An empty stall with no car beside it stays out. Fewer than 8
 * cars in rows keeps the caller on the full lot.
 * @returns {Array<Array<[number, number]>>}
 */
function occupiedCarLayer(ring, frame, plate) {
  return require("./stage-clock").timeSpanSync("vehicle", () => occupiedCarLayerWork(ring, frame, plate));
}

function occupiedCarLayerWork(ring, frame, plate, hitsOnlyYs) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return [];
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return [];
  const W = plate.width;
  const H = plate.height;
  const data = plate.data;
  if (W < 32 || H < 32) return [];
  function yAt(x, y) {
    x = x | 0;
    y = y | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return 180;
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  function greenAt(x, y) {
    x = x | 0;
    y = y | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    return g > r + 12 && g > b + 8;
  }
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    const stride = (y + 1) * (W + 1);
    const prev = y * (W + 1);
    for (let x = 0; x < W; x++) {
      row += yAt(x, y);
      I[stride + x + 1] = I[prev + x + 1] + row;
    }
  }
  function mean(xa, ya, xb, yb) {
    xa = Math.max(0, xa | 0);
    ya = Math.max(0, ya | 0);
    xb = Math.min(W, xb | 0);
    yb = Math.min(H, yb | 0);
    if (xb <= xa || yb <= ya) return 0;
    const S = W + 1;
    const s = I[yb * S + xb] - I[ya * S + xb] - I[yb * S + xa] + I[ya * S + xa];
    return s / ((xb - xa) * (yb - ya));
  }
  const hits = [];
  const yLo = Math.max(16, Math.floor(minY));
  const yHi = Math.min(H - 16, Math.ceil(maxY));
  const xLo = Math.max(16, Math.floor(minX));
  const xHi = Math.min(W - 16, Math.ceil(maxX));
  const rowList = [];
  if (hitsOnlyYs) {
    for (let i = 0; i < hitsOnlyYs.length; i++) rowList.push(hitsOnlyYs[i]);
  } else {
    for (let y = yLo; y < yHi; y += 3) rowList.push(y);
  }
  for (let yi = 0; yi < rowList.length; yi++) {
    const y = rowList[yi];
    for (let x = xLo; x < xHi; x += 3) {
      if (!pointInRing([x, y], poly) || greenAt(x, y)) continue;
      let best = 0;
      let vert = true;
      const bodyV = mean(x - 3, y - 7, x + 3, y + 7);
      const left = mean(x - 10, y - 7, x - 5, y + 7);
      const right = mean(x + 5, y - 7, x + 10, y + 7);
      const cV = Math.abs(bodyV - (left + right) / 2);
      if (cV >= 20 && Math.abs(left - right) < 28) {
        best = cV;
        vert = true;
      }
      const bodyH = mean(x - 7, y - 3, x + 7, y + 3);
      const up = mean(x - 7, y - 10, x + 7, y - 5);
      const dn = mean(x - 7, y + 5, x + 7, y + 10);
      const cH = Math.abs(bodyH - (up + dn) / 2);
      if (cH > best && Math.abs(up - dn) < 28) {
        best = cH;
        vert = false;
      }
      if (best < 20) continue;
      hits.push({ x, y, score: best, vert });
    }
  }
  if (hitsOnlyYs) return hits;
  return finishCarLayer(hits, frame, { poly, minX, minY, maxX, maxY, W, H });
}

function carHitRows(ring, frame, plate) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return null;
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return null;
  const W = plate.width;
  const H = plate.height;
  if (W < 32 || H < 32 || !plate.data) return null;
  const yLo = Math.max(16, Math.floor(minY));
  const yHi = Math.min(H - 16, Math.ceil(maxY));
  const xLo = Math.max(16, Math.floor(minX));
  const xHi = Math.min(W - 16, Math.ceil(maxX));
  const ys = [];
  for (let y = yLo; y < yHi; y += 3) ys.push(y);
  return { ys, poly, minX, minY, maxX, maxY, W, H, xLo, xHi };
}

function finishCarLayer(hitsIn, frame, box) {
  const hits = (hitsIn || []).slice();
  const poly = box.poly;
  const minX = box.minX;
  const minY = box.minY;
  const maxX = box.maxX;
  const maxY = box.maxY;
  const W = box.W;
  const H = box.H;
  hits.sort((a, b) => b.score - a.score);
  const nms = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    let clash = false;
    for (let k = 0; k < nms.length; k++) {
      const dx = h.x - nms[k].x;
      const dy = h.y - nms[k].y;
      if (dx * dx + dy * dy < 121) {
        clash = true;
        break;
      }
    }
    if (!clash) nms.push(h);
  }
  const rowed = [];
  for (let i = 0; i < nms.length; i++) {
    const h = nms[i];
    let n = 0;
    for (let k = 0; k < nms.length; k++) {
      if (k === i) continue;
      const dx = Math.abs(nms[k].x - h.x);
      const dy = Math.abs(nms[k].y - h.y);
      if (h.vert) {
        if (dy < 8 && dx >= 10 && dx <= 26) n++;
      } else if (dx < 8 && dy >= 10 && dy <= 26) n++;
      if (n >= 2) break;
    }
    if (n >= 2) rowed.push(h);
  }
  if (rowed.length < CAR_MERGE_MIN) return [];
  const mpu = Math.min(frame.mpuX > 0 ? frame.mpuX : 0.4, frame.mpuY > 0 ? frame.mpuY : 0.4);
  const rad = Math.max(4, Math.ceil(8 / mpu));
  const x0 = Math.max(0, Math.floor(minX) - rad);
  const y0 = Math.max(0, Math.floor(minY) - rad);
  const x1 = Math.min(W - 1, Math.ceil(maxX) + rad);
  const y1 = Math.min(H - 1, Math.ceil(maxY) + rad);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 8 || bh < 8 || bw * bh > 2500000) return [];
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < rowed.length; i++) {
    const h = rowed[i];
    for (let dy = -rad; dy <= rad; dy++) {
      const yy = (h.y | 0) + dy;
      if (yy < y0 || yy > y1) continue;
      const lim = Math.sqrt(Math.max(0, rad * rad - dy * dy)) | 0;
      for (let dx = -lim; dx <= lim; dx++) {
        const xx = (h.x | 0) + dx;
        if (xx < x0 || xx > x1) continue;
        if (!pointInRing([xx, yy], poly)) continue;
        mask[(yy - y0) * bw + (xx - x0)] = 1;
      }
    }
  }
  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    function cross(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    const lower = [];
    for (let i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }
  const seen = new Uint8Array(bw * bh);
  const stack = [];
  const rings = [];
  for (let i = 0; i < mask.length && rings.length < 24; i++) {
    if (!mask[i] || seen[i]) continue;
    stack.push(i);
    seen[i] = 1;
    const pts = [];
    while (stack.length) {
      const k = stack.pop();
      const X = k % bw;
      const Y = (k / bw) | 0;
      if (X % 4 === 0 && Y % 4 === 0) pts.push([x0 + X, y0 + Y]);
      for (let e = 0; e < 4; e++) {
        const nx = X + (e === 0 ? -1 : e === 1 ? 1 : 0);
        const ny = Y + (e === 2 ? -1 : e === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!mask[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (pts.length < 3) continue;
    const h = hull(pts);
    if (h.length < 3) continue;
    const ringLL = [];
    for (let p = 0; p < h.length; p++) {
      const lon = frame.west + (h[p][0] / frame.imgW) * (frame.east - frame.west);
      const lat = frame.north - (h[p][1] / frame.imgH) * (frame.north - frame.south);
      ringLL.push([lon, lat]);
    }
    ringLL.push(ringLL[0]);
    rings.push(ringLL);
  }
  return rings;
}

function metersBetween(a, b) {
  if (!a || !b) return Infinity;
  const lat = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (a[0] - b[0]) * 111320 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

function labelCenter(item) {
  if (!item) return null;
  if (item.center) return item.center;
  return centroidLL(item.ring);
}

function nearLabel(pred, label, matchM) {
  const pc = labelCenter(pred);
  const lc = labelCenter(label);
  if (pc && label.ring && label.ring.length >= 3 && pointInRing(pc, label.ring)) return true;
  if (lc && pred.ring && pred.ring.length >= 3 && pointInRing(lc, pred.ring)) return true;
  return metersBetween(pc, lc) <= matchM;
}

/**
 * White boats on dark water inside a marina outline. OSM moorings are not
 * required. A shore roof with no water beside it is left out. Height is
 * set by the caller at about 3.5 m.
 */
function boatsOnWater(ring, frame, plate) {
  return require("./stage-clock").timeSpanSync("vehicle", () => boatsOnWaterWork(ring, frame, plate));
}

function boatsOnWaterWork(ring, frame, plate) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return [];
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return [];
  const mpuX = frame.mpuX > 0 ? frame.mpuX : 0.3;
  const mpuY = frame.mpuY > 0 ? frame.mpuY : 0.3;
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(plate.width - 1, Math.ceil(maxX));
  const y1 = Math.min(plate.height - 1, Math.ceil(maxY));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4 || bw * bh > 2000000) return [];
  const water = new Uint8Array(bw * bh);
  const boat = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInRing([x + 0.5, y + 0.5], poly)) continue;
      const i = (y * plate.width + x) * 4;
      const r = plate.data[i];
      const g = plate.data[i + 1];
      const b = plate.data[i + 2];
      const yl = 0.299 * r + 0.587 * g + 0.114 * b;
      const k = (y - y0) * bw + (x - x0);
      if (yl < 90 && b + 15 >= r) water[k] = 1;
      else if (yl >= 175 && Math.max(r, g, b) - Math.min(r, g, b) <= 40) boat[k] = 1;
    }
  }
  const seen = new Uint8Array(bw * bh);
  const stack = [];
  const out = [];
  const areaPx = mpuX * mpuY;
  for (let i = 0; i < boat.length; i++) {
    if (!boat[i] || seen[i]) continue;
    const cells = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const x = k % bw;
      const y = (k / bw) | 0;
      const nbrs = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (let q = 0; q < nbrs.length; q++) {
        const nx = nbrs[q][0];
        const ny = nbrs[q][1];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!boat[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    let wet = false;
    for (let c = 0; c < cells.length && !wet; c++) {
      const x = cells[c] % bw;
      const y = (cells[c] / bw) | 0;
      for (let dy = -3; dy <= 3 && !wet; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          if (water[ny * bw + nx]) wet = true;
        }
      }
    }
    const m2 = cells.length * areaPx;
    if (!wet || m2 < 6 || m2 > 160) continue;
    const copies = m2 <= 50 ? 1 : m2 <= 100 ? 2 : 3;
    let sx = 0;
    let sy = 0;
    let minx = 1e9;
    let miny = 1e9;
    let maxx = -1e9;
    let maxy = -1e9;
    for (let c = 0; c < cells.length; c++) {
      const x = x0 + (cells[c] % bw) + 0.5;
      const y = y0 + ((cells[c] / bw) | 0) + 0.5;
      sx += x;
      sy += y;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    const dx = (maxx - minx) * mpuX;
    const dy = (maxy - miny) * mpuY;
    const alongX = dx >= dy;
    for (let n = 0; n < copies && out.length < 200; n++) {
      const t = (n + 0.5) / copies;
      const cx = alongX ? minx + (maxx - minx) * t : sx / cells.length;
      const cy = alongX ? sy / cells.length : miny + (maxy - miny) * t;
      const lon = frame.west + (cx / frame.imgW) * (frame.east - frame.west);
      const lat = frame.north - (cy / frame.imgH) * (frame.north - frame.south);
      const proj = projectAt(lat);
      const heading = alongX ? { ux: 1, uy: 0 } : { ux: 0, uy: 1 };
      const xy = proj.to(lon, lat);
      out.push({
        kind: "boat",
        coords: orientedRing(proj, xy[0], xy[1], heading, BOX.boat.length, BOX.boat.width),
        closed: true,
        heightM: BOX.boat.height,
        explicitHeight: true,
        center: [lon, lat],
        rank: 0,
      });
    }
  }
  return out;
}

/**
 * White manufactured-home roofs inside a park outline. OSM may call the
 * park residential or a caravan site. Each roof is the building footprint.
 * The caller sets the height at about 4 m.
 */
function mobileHomesInRing(ring, frame, plate) {
  return require("./stage-clock").timeSpanSync("vehicle", () => mobileHomesInRingWork(ring, frame, plate));
}

function mobileHomesInRingWork(ring, frame, plate) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return [];
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return [];
  const mpuX = frame.mpuX > 0 ? frame.mpuX : 0.4;
  const mpuY = frame.mpuY > 0 ? frame.mpuY : 0.4;
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(plate.width - 1, Math.ceil(maxX));
  const y1 = Math.min(plate.height - 1, Math.ceil(maxY));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4 || bw * bh > 2000000) return [];
  const mask = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInRing([x + 0.5, y + 0.5], poly)) continue;
      const i = (y * plate.width + x) * 4;
      const r = plate.data[i];
      const g = plate.data[i + 1];
      const b = plate.data[i + 2];
      const yl = 0.299 * r + 0.587 * g + 0.114 * b;
      if (yl < 175 || yl > 250) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 35) continue;
      mask[(y - y0) * bw + (x - x0)] = 1;
    }
  }
  const seen = new Uint8Array(bw * bh);
  const stack = [];
  const out = [];
  const areaPx = mpuX * mpuY;
  for (let i = 0; i < mask.length && out.length < 400; i++) {
    if (!mask[i] || seen[i]) continue;
    const cells = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const x = k % bw;
      const y = (k / bw) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!mask[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    const m2 = cells.length * areaPx;
    if (m2 < 40 || m2 > 130) continue;
    let minx = 1e9;
    let miny = 1e9;
    let maxx = -1e9;
    let maxy = -1e9;
    for (let c = 0; c < cells.length; c++) {
      const x = x0 + (cells[c] % bw);
      const y = y0 + ((cells[c] / bw) | 0);
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    const pad = 8;
    const extra = [];
    for (let y = Math.max(y0, miny - pad); y <= Math.min(y1, maxy + pad); y++) {
      for (let x = Math.max(x0, minx - pad); x <= Math.min(x1, maxx + pad); x++) {
        const j = (y - y0) * bw + (x - x0);
        if (mask[j]) continue;
        const pi = (y * plate.width + x) * 4;
        const r = plate.data[pi];
        const g = plate.data[pi + 1];
        const b = plate.data[pi + 2];
        const yl = 0.299 * r + 0.587 * g + 0.114 * b;
        if (yl < 248) continue;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) continue;
        extra.push(j);
      }
    }
    if ((cells.length + extra.length) * areaPx <= 150) {
      for (let e = 0; e < extra.length; e++) cells.push(extra[e]);
    }
    let sx = 0;
    let sy = 0;
    minx = 1e9;
    miny = 1e9;
    maxx = -1e9;
    maxy = -1e9;
    for (let c = 0; c < cells.length; c++) {
      const x = x0 + (cells[c] % bw);
      const y = y0 + ((cells[c] / bw) | 0);
      sx += x;
      sy += y;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    const corners = [
      [minx, miny],
      [maxx, miny],
      [maxx, maxy],
      [minx, maxy],
    ];
    const coords = [];
    for (let c = 0; c < corners.length; c++) {
      const lon = frame.west + (corners[c][0] / frame.imgW) * (frame.east - frame.west);
      const lat = frame.north - (corners[c][1] / frame.imgH) * (frame.north - frame.south);
      coords.push([lon, lat]);
    }
    coords.push(coords[0]);
    const lon = frame.west + (sx / cells.length / frame.imgW) * (frame.east - frame.west);
    const lat = frame.north - (sy / cells.length / frame.imgH) * (frame.north - frame.south);
    out.push({
      kind: "mobile-home",
      coords,
      closed: true,
      heightM: 4,
      explicitHeight: true,
      center: [lon, lat],
      rank: 0,
    });
  }
  const seenBright = new Uint8Array(bw * bh);
  for (let i = 0; i < mask.length && out.length < 400; i++) {
    const x = x0 + (i % bw);
    const y = y0 + ((i / bw) | 0);
    const pi = (y * plate.width + x) * 4;
    const r = plate.data[pi];
    const g = plate.data[pi + 1];
    const b = plate.data[pi + 2];
    const yl = 0.299 * r + 0.587 * g + 0.114 * b;
    if (yl < 248 || Math.max(r, g, b) - Math.min(r, g, b) > 18) continue;
    if (!pointInRing([x + 0.5, y + 0.5], poly)) continue;
    if (seenBright[i] || mask[i]) continue;
    const cells = [];
    stack.push(i);
    seenBright[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const X = k % bw;
      const Y = (k / bw) | 0;
      for (const [nx, ny] of [[X - 1, Y], [X + 1, Y], [X, Y - 1], [X, Y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (seenBright[j]) continue;
        const xx = x0 + nx;
        const yy = y0 + ny;
        const qi = (yy * plate.width + xx) * 4;
        const rr = plate.data[qi];
        const gg = plate.data[qi + 1];
        const bb = plate.data[qi + 2];
        const y2 = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        if (y2 < 248 || Math.max(rr, gg, bb) - Math.min(rr, gg, bb) > 18) continue;
        seenBright[j] = 1;
        stack.push(j);
      }
    }
    const brightM2 = cells.length * areaPx;
    if (brightM2 < 25 || brightM2 > 110) continue;
    let sx = 0;
    let sy = 0;
    let minx = 1e9;
    let miny = 1e9;
    let maxx = -1e9;
    let maxy = -1e9;
    for (let c = 0; c < cells.length; c++) {
      const xx = x0 + (cells[c] % bw);
      const yy = y0 + ((cells[c] / bw) | 0);
      sx += xx;
      sy += yy;
      if (xx < minx) minx = xx;
      if (yy < miny) miny = yy;
      if (xx > maxx) maxx = xx;
      if (yy > maxy) maxy = yy;
    }
    const lon = frame.west + (sx / cells.length / frame.imgW) * (frame.east - frame.west);
    const lat = frame.north - (sy / cells.length / frame.imgH) * (frame.north - frame.south);
    let dup = false;
    for (let u = 0; u < out.length; u++) {
      const c = out[u].center;
      const mid = (((c[1] + lat) / 2) * Math.PI) / 180;
      const dx = (c[0] - lon) * 111320 * Math.cos(mid);
      const dy = (c[1] - lat) * 110540;
      if (dx * dx + dy * dy < 64) dup = true;
    }
    if (dup) continue;
    const corners = [
      [minx, miny],
      [maxx, miny],
      [maxx, maxy],
      [minx, maxy],
    ];
    const coords = [];
    for (let c = 0; c < corners.length; c++) {
      coords.push([
        frame.west + (corners[c][0] / frame.imgW) * (frame.east - frame.west),
        frame.north - (corners[c][1] / frame.imgH) * (frame.north - frame.south),
      ]);
    }
    coords.push(coords[0]);
    out.push({
      kind: "mobile-home",
      coords,
      closed: true,
      heightM: 4,
      explicitHeight: true,
      center: [lon, lat],
      rank: 0,
    });
  }
  return out;
}

/**
 * Two oriented boxes overlap (separating-axis test). Each box is a center,
 * a unit long axis, and half length / half width in the same units.
 */
function boxesOverlap(a, b) {
  const axes = [
    [a.ux, a.uy],
    [-a.uy, a.ux],
    [b.ux, b.uy],
    [-b.uy, b.ux],
  ];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (let i = 0; i < axes.length; i++) {
    const [ax, ay] = axes[i];
    const ra = a.hl * Math.abs(a.ux * ax + a.uy * ay) + a.hw * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);
    if (Math.abs(dx * ax + dy * ay) > ra + rb) return false;
  }
  return true;
}

/**
 * A parked semi is a bright body about one trailer long, with a dark
 * shadow on one flank. A building roof is wide on both sides, so it is
 * left out. Each kept trailer is one oriented metal box.
 */
function semisInLot(ring, frame, plate, holes, opts) {
  return require("./stage-clock").timeSpanSync("vehicle", () => semisInLotWork(ring, frame, plate, holes, opts));
}

function semisInLotWork(ring, frame, plate, holes, opts) {
  if (!ring || ring.length < 3 || !frame || !plate || !(plate.width > 1)) return [];
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return [];
  const holePolys = [];
  for (let h = 0; h < (holes || []).length; h++) {
    const hp = [];
    const hole = holes[h];
    let hx0 = Infinity;
    let hy0 = Infinity;
    let hx1 = -Infinity;
    let hy1 = -Infinity;
    for (let i = 0; i < hole.length; i++) {
      const xy = llToImagePx(hole[i][0], hole[i][1], frame);
      if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
      hp.push(xy);
      if (xy[0] < hx0) hx0 = xy[0];
      if (xy[1] < hy0) hy0 = xy[1];
      if (xy[0] > hx1) hx1 = xy[0];
      if (xy[1] > hy1) hy1 = xy[1];
    }
    if (hp.length < 3) continue;
    if (hx1 < minX || hx0 > maxX || hy1 < minY || hy0 > maxY) continue;
    holePolys.push(hp);
  }
  const W = plate.width;
  const H = plate.height;
  const data = plate.data;
  function yAt(x, y) {
    x = x | 0;
    y = y | 0;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return 0;
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const allow = opts && opts.allow;
  function inLot(x, y) {
    if (allow) {
      if (!allow(x, y)) return false;
    } else if (!pointInRing([x, y], poly)) return false;
    for (let h = 0; h < holePolys.length; h++) {
      if (pointInRing([x, y], holePolys[h])) return false;
    }
    return true;
  }
  // Pixel windows were tuned on a 0.4 m plate. Scale them so a 16 m trailer
  // is the same physical size on a 1 m export.
  const mpu = frame.mpuX > 0 ? frame.mpuX : 0.4;
  const px = (meters) => Math.max(1, (meters / mpu));
  const cell = Math.max(8, px(16));
  const step = Math.max(1, px(0.8));
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const ori = new Float32Array(cols * rows);
  const strength = new Float32Array(cols * rows);
  const xLo = Math.max(2, Math.floor(minX));
  const yLo = Math.max(2, Math.floor(minY));
  const xHi = Math.min(W - 3, Math.ceil(maxX));
  const yHi = Math.min(H - 3, Math.ceil(maxY));
  for (let cy = (yLo / cell) | 0; cy <= (yHi / cell) && cy < rows; cy++) {
    for (let cx = (xLo / cell) | 0; cx <= (xHi / cell) && cx < cols; cx++) {
      const bins = new Float64Array(18);
      const ox = cx * cell;
      const oy = cy * cell;
      let sum = 0;
      let bi = 0;
      for (let y = oy + step; y < oy + cell - 1 && y < H - 1; y += step) {
        for (let x = ox + step; x < ox + cell - 1 && x < W - 1; x += step) {
          if (!inLot(x, y)) continue;
          const gx = yAt(x + 1, y) - yAt(x - 1, y);
          const gy = yAt(x, y + 1) - yAt(x, y - 1);
          const mag = gx * gx + gy * gy;
          if (mag < 600) continue;
          let a = Math.atan2(gy, gx);
          if (a < 0) a += Math.PI;
          const b = Math.min(17, (a / Math.PI * 18) | 0);
          const w = Math.sqrt(mag);
          bins[b] += w;
          sum += w;
          if (bins[b] > bins[bi]) bi = b;
        }
      }
      ori[cy * cols + cx] = ((bi + 0.5) / 18) * Math.PI;
      strength[cy * cols + cx] = sum > 0 ? bins[bi] / sum : 0;
    }
  }
  const margin = px(9.6);
  const scan = Math.max(1, px(1.2));
  function axisHit(x, y, ang) {
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    const tx = -ny;
    const ty = nx;
    let sum = 0;
    let n = 0;
    let hi = 0;
    const half = px(4.8);
    const alongStep = Math.max(1, px(0.8));
    for (let t = -half; t <= half + 0.01; t += alongStep) {
      const v = yAt(x + tx * t, y + ty * t);
      sum += v;
      n++;
      if (v > 175) hi++;
    }
    const body = sum / n;
    if (hi < Math.max(3, Math.round(n * 0.45)) || body < 175) return null;
    const endPx = px(8);
    const end1 = yAt(x - tx * endPx, y - ty * endPx);
    const end2 = yAt(x + tx * endPx, y + ty * endPx);
    if (body < end1 + 16 || body < end2 + 16) return null;
    let sh = 0;
    let sh2 = 0;
    for (let s = 0; s < 3; s++) {
      const t = px(2) + s * px(0.8);
      sh += yAt(x + nx * t, y + ny * t);
      sh2 += yAt(x - nx * t, y - ny * t);
    }
    sh /= 3;
    sh2 /= 3;
    const usePos = sh <= sh2;
    const shadow = usePos ? sh : sh2;
    const other = usePos ? sh2 : sh;
    if (shadow > 100 || body - shadow < 45 || other < 120) return null;
    const farPx = px(6.4);
    const farS = usePos ? yAt(x + nx * farPx, y + ny * farPx) : yAt(x - nx * farPx, y - ny * farPx);
    const farO = usePos ? yAt(x - nx * farPx, y - ny * farPx) : yAt(x + nx * farPx, y + ny * farPx);
    if (farS > body - 15 && farO > body - 15) return null;
    let bestV = -1;
    let bestT = 0;
    const nudge = px(2.4);
    for (let t = -nudge; t <= nudge + 0.01; t += Math.max(1, px(0.4))) {
      const v = yAt(x + nx * t, y + ny * t);
      if (v > bestV) {
        bestV = v;
        bestT = t;
      }
    }
    return {
      x: x + nx * bestT,
      y: y + ny * bestT,
      score: body - shadow,
      tx,
      ty,
      nx,
      ny,
    };
  }
  // A packed dock row has no shadow strip: the next trailer is half a metre
  // away. Read it as its own pattern. The body is bright for most of a
  // trailer length, still bright 0.8 m to either side of the axis, and the
  // across profile dips at a 2.7 to 4.6 m pitch and comes back up on at
  // least one neighbor. A painted stall line is too thin, a car too short,
  // and a roof has no dips.
  // The gap between packed trailers is about half a metre. A plate coarser
  // than 0.5 m per pixel cannot show it, so the row reader stays off there.
  const packedOn = mpu <= 0.5;
  function packedHit(x0, y0, ang) {
    if (!packedOn) return null;
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    const tx = -ny;
    const ty = nx;
    const alongStep = Math.max(1, px(0.8));
    const fine = Math.max(1, px(0.25));
    const lineMean = (ox, oy, half) => {
      let sum = 0;
      let n = 0;
      for (let t = -half; t <= half + 0.01; t += alongStep) {
        sum += yAt(ox + tx * t, oy + ty * t);
        n++;
      }
      return n ? sum / n : 0;
    };
    // Across: find the darkest line 0.6 to 2.3 m out on each side. That is
    // the gap to the next trailer or the shadow. Center between the two.
    const gapOn = (sign) => {
      let best = null;
      for (let d = px(0.6); d <= px(2.3) + 0.01; d += fine) {
        const v = lineMean(x0 + nx * d * sign, y0 + ny * d * sign, px(4));
        if (!best || v < best.v) best = { v, d };
      }
      return best;
    };
    const gA = gapOn(1);
    const gB = gapOn(-1);
    const shift = (gA.d - gB.d) / 2;
    const x1 = x0 + nx * shift;
    const y1 = y0 + ny * shift;
    const widthM = (gA.d + gB.d) * mpu;
    if (widthM < 1.8 || widthM > 3.8) return null;
    const body = lineMean(x1, y1, px(4.8));
    if (body < 175) return null;
    if (lineMean(x1 + nx * px(0.7), y1 + ny * px(0.7), px(4)) < body - 25) return null;
    if (lineMean(x1 - nx * px(0.7), y1 - ny * px(0.7), px(4)) < body - 25) return null;
    // Sun puts a dark strip on one side. The lit side gap can be narrow.
    const gap = Math.min(gA.v, gB.v);
    if (gap > body - 25 || Math.max(gA.v, gB.v) > body - 8) return null;
    // A neighbor trailer, 2.7 to 4.6 m pitch, on at least one side.
    let nb = 0;
    for (let sign = -1; sign <= 1; sign += 2) {
      for (let d = px(2.7); d <= px(4.6) + 0.01; d += fine) {
        const v = lineMean(x1 + nx * d * sign, y1 + ny * d * sign, px(4));
        if (v > nb) nb = v;
      }
    }
    if (nb < body - 25 || nb < gap + 20) return null;
    // Along: walk out to where the body ends and center on it.
    const bodyAt = (t) => {
      let sum = 0;
      let n = 0;
      for (let d = -px(0.6); d <= px(0.6) + 0.01; d += fine) {
        sum += yAt(x1 + tx * t + nx * d, y1 + ty * t + ny * d);
        n++;
      }
      return sum / n;
    };
    const cut = body - 30;
    const reach = (sign) => {
      let last = 0;
      let miss = 0;
      for (let t = 0; t <= px(20); t += fine) {
        if (bodyAt(t * sign) >= cut) {
          last = t;
          miss = 0;
        } else if (++miss * fine > px(0.9)) break;
      }
      return last;
    };
    const ra = reach(1);
    const rb = reach(-1);
    const lenM = (ra + rb) * mpu;
    if (lenM < 10 || lenM > 19) return null;
    // One flat roof. A trailer top reads almost one tone for 12 m (spread
    // under 3 levels on the Lebanon yard). A row of cars, or cars on light
    // concrete, swings by 10 or more between glass, paint, and pavement.
    {
      const mid0 = (ra - rb) / 2;
      let n = 0;
      let sum = 0;
      let sum2 = 0;
      for (let t = mid0 - px(6); t <= mid0 + px(6) + 0.01; t += fine) {
        const v = bodyAt(t);
        sum += v;
        sum2 += v * v;
        n++;
      }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      if (sd > 7) return null;
    }
    const mid = (ra - rb) / 2;
    return { x: x1 + tx * mid, y: y1 + ty * mid, score: body - gap, tx, ty, nx, ny, pitch: gA.d + gB.d, ang };
  }
  const hits = [];
  for (let y = Math.max(margin, yLo); y < Math.min(H - margin, yHi); y += scan) {
    for (let x = Math.max(margin, xLo); x < Math.min(W - margin, xHi); x += scan) {
      if (!inLot(x, y)) continue;
      const ci = ((y / cell) | 0) * cols + ((x / cell) | 0);
      if (strength[ci] < 0.16) continue;
      // A yard's strong edge is often the row, not the trailer. Try that
      // axis too, so a packed row is not read as a wide roof.
      const ang = ori[ci];
      const hit =
        axisHit(x, y, ang) ||
        axisHit(x, y, ang + Math.PI / 2) ||
        packedHit(x, y, ang) ||
        packedHit(x, y, ang + Math.PI / 2);
      if (hit) hits.push(hit);
    }
  }
  // Walk each packed row one pitch at a time. The scan grid lands on only
  // some trailers in a tight row. Each step re-reads the aerial, so the row
  // stops at the first slot that is not a trailer.
  const seeds = hits.filter((h) => h.pitch > 0);
  for (let i = 0; i < seeds.length && hits.length < 4000; i++) {
    const seed = seeds[i];
    for (let sign = -1; sign <= 1; sign += 2) {
      let cur = seed;
      for (let k = 0; k < 40; k++) {
        const nxp = cur.x + cur.nx * cur.pitch * sign;
        const nyp = cur.y + cur.ny * cur.pitch * sign;
        if (nxp < margin || nyp < margin || nxp >= W - margin || nyp >= H - margin) break;
        if (!inLot(nxp, nyp)) break;
        const next = packedHit(nxp, nyp, seed.ang);
        if (!next) break;
        const moved = (next.x - cur.x) * cur.nx + (next.y - cur.y) * cur.ny;
        if (Math.abs(moved) < px(2)) break;
        // A row stays in line. A step that slides far along the trailer is
        // a staircase off a tilted seed, not the next trailer.
        const slid = (next.x - cur.x) * cur.tx + (next.y - cur.y) * cur.ty;
        if (Math.abs(slid) > px(2.5)) break;
        hits.push(next);
        cur = next;
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const kept = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    let clash = false;
    for (let k = 0; k < kept.length; k++) {
      const prev = kept[k];
      const dx = h.x - prev.x;
      const dy = h.y - prev.y;
      const along = Math.abs(dx * prev.tx + dy * prev.ty);
      const across = Math.abs(dx * prev.nx + dy * prev.ny);
      // A box turned against its neighbor overlaps it. Only parallel boxes
      // can sit a trailer width apart.
      const parallel = Math.abs(h.tx * prev.tx + h.ty * prev.ty) > 0.97;
      const overlap = parallel
        ? along < px(8) && across < px(2.3)
        : boxesOverlap(
            { x: h.x, y: h.y, ux: h.tx, uy: h.ty, hl: px(8), hw: px(1.2) },
            { x: prev.x, y: prev.y, ux: prev.tx, uy: prev.ty, hl: px(8), hw: px(1.2) }
          );
      if (overlap) {
        clash = true;
        break;
      }
    }
    if (!clash) kept.push(h);
    if (kept.length >= 400) break;
  }
  const rowed = [];
  for (let i = 0; i < kept.length; i++) {
    const h = kept[i];
    let neighbor = false;
    for (let k = 0; k < kept.length; k++) {
      if (k === i) continue;
      const other = kept[k];
      const dx = h.x - other.x;
      const dy = h.y - other.y;
      const along = Math.abs(dx * h.tx + dy * h.ty);
      const across = Math.abs(dx * h.nx + dy * h.ny);
      // Side by side, the gap is across the trailer. On a 1 m plate the
      // long edges are only a few pixels, so the row can be read as the
      // long axis. Either arrangement is a dock row. A lone bright spot is not.
      const sideBySide = across >= px(2.4) && across <= px(11.2) && along <= px(8.8);
      const alongRow = along >= px(2.4) && along <= px(18) && across <= px(4);
      if (sideBySide || alongRow) {
        neighbor = true;
        break;
      }
    }
    if (neighbor) rowed.push(h);
  }
  const mpuX = frame.mpuX > 0 ? frame.mpuX : 0.4;
  const mpuY = frame.mpuY > 0 ? frame.mpuY : 0.4;
  const out = [];
  for (let i = 0; i < rowed.length; i++) {
    const h = rowed[i];
    // Recentering can slide a box off the lot. Its final center has to be
    // on the lot too, not on the roof beside it.
    if (!inLot(h.x, h.y)) continue;
    const lon = frame.west + (h.x / frame.imgW) * (frame.east - frame.west);
    const lat = frame.north - (h.y / frame.imgH) * (frame.north - frame.south);
    const mx = h.tx * mpuX;
    const my = -h.ty * mpuY;
    const len = Math.hypot(mx, my) || 1;
    const proj = projectAt(lat);
    const xy = proj.to(lon, lat);
    out.push({
      kind: "semi",
      coords: orientedRing(proj, xy[0], xy[1], { ux: mx / len, uy: my / len }, BOX.semi.length, BOX.semi.width),
      closed: true,
      heightM: BOX.semi.height,
      explicitHeight: true,
      center: [lon, lat],
      rank: 0,
    });
  }
  return out;
}

function pxAreaM2(ring, frame) {
  if (!ring || ring.length < 3 || !frame) return 0;
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  const mx = frame.mpuX > 0 ? frame.mpuX : 1;
  const my = frame.mpuY > 0 ? frame.mpuY : mx;
  return (Math.abs(a) / 2) * mx * my;
}

/** A large roof can have trailers at the doors even when OSM has no truck lot. */
function roofWantsDocks(ringsPx, frame) {
  for (let i = 0; i < (ringsPx || []).length; i++) {
    if (pxAreaM2(ringsPx[i], frame) >= DOCK_MIN_ROOF_M2) return true;
  }
  return false;
}

/**
 * Strips outside each long wall. The building centroid stays out of the strip,
 * so the roof itself is not a trailer.
 */
function dockAprons(ring, depthM) {
  const depth = depthM > 0 ? depthM : DOCK_DEPTH_M;
  if (!ring || ring.length < 4) return [];
  let n = ring.length;
  const a0 = ring[0];
  const last = ring[n - 1];
  if (Math.abs(a0[0] - last[0]) < 1e-12 && Math.abs(a0[1] - last[1]) < 1e-12) n--;
  if (n < 3) return [];
  const open = ring.slice(0, n);
  const c = centroidLL(open);
  if (!c) return [];
  const proj = projectAt(c[1]);
  const pts = [];
  for (let i = 0; i < open.length; i++) pts.push(proj.to(open[i][0], open[i][1]));
  const cxy = proj.to(c[0], c[1]);
  const aprons = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < DOCK_MIN_EDGE_M) continue;
    let nx = -dy / len;
    let ny = dx / len;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (nx * (mx - cxy[0]) + ny * (my - cxy[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const corners = [
      a,
      b,
      [b[0] + nx * depth, b[1] + ny * depth],
      [a[0] + nx * depth, a[1] + ny * depth],
    ];
    const ll = [];
    for (let k = 0; k < corners.length; k++) ll.push(proj.from(corners[k][0], corners[k][1]));
    ll.push(ll[0]);
    aprons.push(ll);
  }
  return aprons;
}

/**
 * Even-odd fill that matches pointInRing for integer pixels. One pass
 * over the edges, not one point-in-ring test per pixel.
 */
function rasterInside(poly, x0, y0, cw, ch) {
  const mask = new Uint8Array(cw * ch);
  const n = poly.length;
  if (n < 3 || !(cw > 0) || !(ch > 0)) return mask;
  const x1 = x0 + cw - 1;
  for (let row = 0; row < ch; row++) {
    const py = y0 + row;
    const hits = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[i][1];
      const yj = poly[j][1];
      if ((yi > py) === (yj > py)) continue;
      const xi = poly[i][0];
      const xj = poly[j][0];
      hits.push(((xj - xi) * (py - yi)) / (yj - yi || 1e-20) + xi);
    }
    if (hits.length < 2) continue;
    hits.sort((a, b) => a - b);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      let xa = Math.ceil(hits[k]);
      let xb = Math.floor(hits[k + 1] - 1e-9);
      if (xa < x0) xa = x0;
      if (xb > x1) xb = x1;
      const base = row * cw - x0;
      for (let x = xa; x <= xb; x++) mask[base + x] = 1;
    }
  }
  return mask;
}

/** Euclidean disk around set pixels. limit, when set, keeps only those cells. */
function dilateDisk(src, w, h, rad, limit) {
  const out = new Uint8Array(w * h);
  const r = rad | 0;
  if (r < 1) {
    for (let i = 0; i < src.length; i++) {
      if (src[i] && (!limit || limit[i])) out[i] = 1;
    }
    return out;
  }
  const r2 = r * r;
  const reach = new Int16Array(r + 1);
  for (let dy = 0; dy <= r; dy++) reach[dy] = Math.floor(Math.sqrt(r2 - dy * dy));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      while (x < w && !src[row + x]) x++;
      if (x >= w) break;
      let x2 = x + 1;
      while (x2 < w && src[row + x2]) x2++;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const dx = reach[dy < 0 ? -dy : dy];
        let xa = x - dx;
        let xb = x2 - 1 + dx;
        if (xa < 0) xa = 0;
        if (xb >= w) xb = w - 1;
        const dest = yy * w;
        for (let xx = xa; xx <= xb; xx++) {
          if (limit && !limit[dest + xx]) continue;
          out[dest + xx] = 1;
        }
      }
      x = x2;
    }
  }
  return out;
}

/**
 * A light membrane, including the panel grid on a white roof, is not a yard.
 * A bright trailer row inside a gray footprint is pavement the outline swallowed.
 * The row has to show a light body beside a darker flank, and it cannot be
 * most of the footprint.
 */
function yardInsideFootprint(ring, frame, plate) {
  const empty = { yardM2: 0, roofShare: 0, bright: 0, allow: null };
  if (!ring || ring.length < 4 || !frame || !plate || !(plate.width > 1) || !plate.data) return empty;
  const W = plate.width | 0;
  const H = plate.height | 0;
  const data = plate.data;
  const poly = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = llToImagePx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    poly.push(xy);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  if (poly.length < 3) return empty;
  const x0 = Math.max(1, Math.floor(minX));
  const y0 = Math.max(1, Math.floor(minY));
  const x1 = Math.min(W - 2, Math.ceil(maxX));
  const y1 = Math.min(H - 2, Math.ceil(maxY));
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  if (cw < 12 || ch < 12 || cw * ch > 2500000) return empty;
  const mpu = Math.min(frame.mpuX > 0 ? frame.mpuX : 1, frame.mpuY > 0 ? frame.mpuY : 1);
  const cellM2 = Math.max(mpu * mpu, 0.04);
  function Yat(x, y) {
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  function greenAt(x, y) {
    const i = (y * W + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    return g >= r + 18 && g >= b + 8 && 2 * g - r - b >= 30;
  }
  const step = 1;
  const rawInside = rasterInside(poly, x0, y0, cw, ch);
  const inside = new Uint8Array(cw * ch);
  const bright = new Uint8Array(cw * ch);
  let inN = 0;
  let brightN = 0;
  for (let y = 0; y < ch; y += step) {
    const ay = y0 + y;
    for (let x = 0; x < cw; x += step) {
      if (!rawInside[y * cw + x]) continue;
      const ax = x0 + x;
      if (greenAt(ax, ay)) continue;
      const k = y * cw + x;
      inside[k] = 1;
      inN++;
      if (Yat(ax, ay) >= 186) {
        bright[k] = 1;
        brightN++;
      }
    }
  }
  if (inN < 40) return empty;
  const brightFrac = brightN / inN;
  const seen = new Uint8Array(cw * ch);
  let best = [];
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      const start = y * cw + x;
      if (!bright[start] || seen[start]) continue;
      const comp = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        const cx = c % cw;
        const cy = (c / cw) | 0;
        const nbr = [cx - step, cx + step, cx, cx];
        const nby = [cy, cy, cy - step, cy + step];
        for (let n = 0; n < 4; n++) {
          const nx = nbr[n];
          const ny = nby[n];
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nk = ny * cw + nx;
          if (!bright[nk] || seen[nk]) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
      if (comp.length > best.length) best = comp;
    }
  }
  let roof = new Uint8Array(cw * ch);
  const bestM2 = best.length * cellM2 * step * step;
  if (bestM2 >= 2500) {
    const rad = Math.max(step, Math.round(10 / Math.max(mpu, 0.2)));
    const comp = new Uint8Array(cw * ch);
    for (let i = 0; i < best.length; i++) comp[best[i]] = 1;
    roof = dilateDisk(comp, cw, ch, rad, inside);
    let roofN = 0;
    for (let i = 0; i < roof.length; i += step) if (roof[i]) roofN++;
    const roofShare = roofN / inN;
    // A panel roof fills the outline once the white aisles spread over the panels.
    if (roofShare >= 0.7) return { yardM2: 0, roofShare, bright: brightFrac, allow: null };
    // A bright trailer block is large, but it is not the membrane. Leave it searchable.
    if (roofShare < 0.4) roof.fill(0);
  }
  const radBody = Math.max(step, Math.round(4 / Math.max(mpu, 0.2)));
  const pad = radBody;
  const pw = cw + pad * 2;
  const ph = ch + pad * 2;
  const dark = new Uint8Array(pw * ph);
  const dx0 = Math.max(1, x0 - pad);
  const dy0 = Math.max(1, y0 - pad);
  const dx1 = Math.min(W - 2, x1 + pad);
  const dy1 = Math.min(H - 2, y1 + pad);
  for (let y = dy0; y <= dy1; y += step) {
    for (let x = dx0; x <= dx1; x += step) {
      if (Yat(x, y) > 115) continue;
      const lx = x - (x0 - pad);
      const ly = y - (y0 - pad);
      if (lx < 0 || ly < 0 || lx >= pw || ly >= ph) continue;
      dark[ly * pw + lx] = 1;
    }
  }
  const nearDark = dilateDisk(dark, pw, ph, radBody, null);
  const seed = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      const k = y * cw + x;
      if (!inside[k] || roof[k]) continue;
      if (Yat(x0 + x, y0 + y) < 158) continue;
      if (nearDark[(y + pad) * pw + (x + pad)]) seed[k] = 1;
    }
  }
  const radYard = Math.max(step, Math.round(6 / Math.max(mpu, 0.2)));
  const grown = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      if (!seed[y * cw + x]) continue;
      for (let dy = -radYard; dy <= radYard; dy += step) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -radYard; dx <= radYard; dx += step) {
          if (dx * dx + dy * dy > radYard * radYard) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= cw) continue;
          const k = yy * cw + xx;
          if (!inside[k] || roof[k]) continue;
          grown[k] = 1;
        }
      }
    }
  }
  const seenY = new Uint8Array(cw * ch);
  const keep = new Uint8Array(cw * ch);
  let yardCells = 0;
  const minCells = Math.max(8, Math.round(400 / Math.max(cellM2 * step * step, 0.25)));
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      const start = y * cw + x;
      if (!grown[start] || seenY[start]) continue;
      const comp = [];
      const stack = [start];
      seenY[start] = 1;
      let touch = false;
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        const cx = c % cw;
        const cy = (c / cw) | 0;
        const ix = x0 + cx;
        const iy = y0 + cy;
        // The plate edge counts. A yard cut by the draw still touches that edge.
        if (ix <= x0 + step * 2 || iy <= y0 + step * 2 || ix >= x1 - step * 2 || iy >= y1 - step * 2) touch = true;
        if (
          !pointInRing([ix - step * 2, iy], poly) ||
          !pointInRing([ix + step * 2, iy], poly) ||
          !pointInRing([ix, iy - step * 2], poly) ||
          !pointInRing([ix, iy + step * 2], poly)
        ) {
          touch = true;
        }
        const nbr = [
          [cx - step, cy],
          [cx + step, cy],
          [cx, cy - step],
          [cx, cy + step],
        ];
        for (let n = 0; n < nbr.length; n++) {
          const nx = nbr[n][0];
          const ny = nbr[n][1];
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nk = ny * cw + nx;
          if (!grown[nk] || seenY[nk]) continue;
          seenY[nk] = 1;
          stack.push(nk);
        }
      }
      if (comp.length < minCells) continue;
      if (!touch && comp.length * cellM2 * step * step < 1500) continue;
      for (let i = 0; i < comp.length; i++) keep[comp[i]] = 1;
      yardCells += comp.length;
    }
  }
  let keepN = 0;
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) if (keep[y * cw + x]) keepN++;
  }
  const yardM2 = yardCells * cellM2 * step * step;
  const share = inN ? keepN / inN : 0;
  if (!(yardM2 >= 400) || share >= 0.8) {
    return { yardM2: 0, roofShare: 1 - brightFrac, bright: brightFrac, allow: null };
  }
  function allow(x, y) {
    const xx = (x | 0) - x0;
    const yy = (y | 0) - y0;
    if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) return false;
    const sx = xx - (xx % step);
    const sy = yy - (yy % step);
    return keep[sy * cw + sx] === 1;
  }
  return { yardM2, roofShare: 1 - share, bright: brightFrac, allow };
}

function semisAtDocks(rings, frame, plate, holes) {
  return require("./stage-clock").timeSpanSync("vehicle", () => semisAtDocksWork(rings, frame, plate, holes));
}

function semisAtDocksWork(rings, frame, plate, holes) {
  const profile = require("./profile-log");
  const profiling = profile.profileOn();
  const out = [];
  const used = [];
  // Two boxes clash when they overlap as trailers: closer than a trailer
  // length along the first box and closer than a trailer width across it.
  // A plain 8 m radius dropped every other trailer in a packed dock row.
  function axisOf(item) {
    const r = item.coords;
    if (!r || r.length < 2) return null;
    const k = Math.cos((r[0][1] * Math.PI) / 180) * 111320;
    const ex = (r[0][0] - r[1][0]) * k;
    const ey = (r[0][1] - r[1][1]) * 110540;
    const len = Math.hypot(ex, ey);
    return len > 0 ? [ex / len, ey / len] : null;
  }
  function take(found) {
    for (let i = 0; i < found.length; i++) {
      const c = found[i].center;
      if (!c) continue;
      const ax = axisOf(found[i]);
      let clash = false;
      for (let u = 0; u < used.length; u++) {
        const dlon = (c[0] - used[u][0]) * 111320 * Math.cos((c[1] * Math.PI) / 180);
        const dlat = (c[1] - used[u][1]) * 110540;
        const d2 = dlon * dlon + dlat * dlat;
        const uax = used[u][2];
        if (!ax || !uax) {
          if (d2 < 64) {
            clash = true;
            break;
          }
          continue;
        }
        const along = Math.abs(dlon * uax[0] + dlat * uax[1]);
        const across = Math.abs(-dlon * uax[1] + dlat * uax[0]);
        const parallel = Math.abs(ax[0] * uax[0] + ax[1] * uax[1]) > 0.97;
        const overlap = parallel
          ? along < 8 && across < 2.3
          : boxesOverlap(
              { x: 0, y: 0, ux: uax[0], uy: uax[1], hl: 8, hw: 1.2 },
              { x: dlon, y: dlat, ux: ax[0], uy: ax[1], hl: 8, hw: 1.2 }
            );
        if (overlap) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      used.push([c[0], c[1], ax]);
      out.push(found[i]);
      if (out.length >= SEMI_CAP) return true;
    }
    return false;
  }
  for (let r = 0; r < (rings || []).length; r++) {
    let tProf = profiling ? profile.now() : 0;
    const aprons = dockAprons(rings[r], DOCK_DEPTH_M);
    for (let a = 0; a < aprons.length; a++) {
      if (take(semisInLot(aprons[a], frame, plate, holes))) {
        if (profiling) profile.add("apron-scan", profile.msSince(tProf));
        return out;
      }
    }
    if (profiling) profile.add("apron-scan", profile.msSince(tProf));
    tProf = profiling ? profile.now() : 0;
    const yard = yardInsideFootprint(rings[r], frame, plate);
    if (profiling) profile.add("yard-scan", profile.msSince(tProf));
    if (!yard.allow) continue;
    const other = [];
    for (let h = 0; h < (holes || []).length; h++) {
      if (holes[h] !== rings[r]) other.push(holes[h]);
    }
    if (take(semisInLot(rings[r], frame, plate, other, { allow: yard.allow }))) return out;
  }
  return out;
}

function scoreClass(labels, preds, cls, matchM) {
  const dist = matchM > 0 ? matchM : 12;
  const lab = [];
  const pr = [];
  const checked = [];
  for (let i = 0; i < (labels || []).length; i++) {
    const item = labels[i];
    if (!item) continue;
    checked.push(item);
    if (item.class === cls && item.ring && item.ring.length >= 3) lab.push(item);
  }
  for (let i = 0; i < (preds || []).length; i++) {
    if (preds[i] && preds[i].class === cls) pr.push(preds[i]);
  }
  const used = new Set();
  let matched = 0;
  for (let i = 0; i < lab.length; i++) {
    for (let j = 0; j < pr.length; j++) {
      if (used.has(j)) continue;
      if (!nearLabel(pr[j], lab[i], dist)) continue;
      used.add(j);
      matched++;
      break;
    }
  }
  let considered = 0;
  let tp = 0;
  for (let j = 0; j < pr.length; j++) {
    const pc = labelCenter(pr[j]);
    let nearest = null;
    let best = Infinity;
    for (let i = 0; i < checked.length; i++) {
      const lc = labelCenter(checked[i]);
      const d = metersBetween(pc, lc);
      if (d < best) {
        best = d;
        nearest = checked[i];
      }
    }
    if (!(best <= dist)) continue;
    considered++;
    if (nearest && nearest.class === cls) tp++;
  }
  return {
    class: cls,
    labels: lab.length,
    predictions: considered,
    matched,
    recall: lab.length ? matched / lab.length : null,
    precision: considered ? tp / considered : null,
  };
}

const SCORE_CLASSES = ["rv", "trailer", "semi", "car", "boat", "mobile-home"];

function scoreVehicles(labels, preds, matchM) {
  const rows = [];
  for (let i = 0; i < SCORE_CLASSES.length; i++) {
    const row = scoreClass(labels, preds, SCORE_CLASSES[i], matchM);
    if (row.labels || row.predictions) rows.push(row);
  }
  return rows;
}

/**
 * Area score for one merged car layer.
 * Recall is how much of the checked parked area the layer covers.
 * Precision is how much of the layer that lands on a checked label
 * is parked cars rather than empty pavement or a building.
 * Checked ground the layer misses does not count. Unreviewed ground
 * does not count.
 */
function scoreLayerOverlap(labels, predRings, cellM) {
  const cell = cellM > 0 ? cellM : 2;
  const parked = [];
  const checked = [];
  for (let i = 0; i < (labels || []).length; i++) {
    const item = labels[i];
    if (!item || !item.ring || item.ring.length < 3) continue;
    checked.push(item);
    if (item.class === "car") parked.push(item);
  }
  const preds = predRings || [];
  if (!parked.length) {
    return { class: "car", labels: 0, predictions: preds.length, matched: 0, recall: null, precision: null, buildingCovered: null };
  }
  let origin = null;
  for (let i = 0; i < checked.length && !origin; i++) origin = checked[i].ring[0];
  const mLon = 111320 * Math.cos((origin[1] * Math.PI) / 180);
  function xy(lon, lat) {
    return [(lon - origin[0]) * mLon, (lat - origin[1]) * 110540];
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const parkedM = [];
  const checkedM = [];
  const predM = [];
  function stash(ring, bucket) {
    const pts = [];
    for (let i = 0; i < ring.length; i++) {
      const p = xy(ring[i][0], ring[i][1]);
      pts.push(p);
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    bucket.push(pts);
  }
  for (let i = 0; i < parked.length; i++) stash(parked[i].ring, parkedM);
  for (let i = 0; i < checked.length; i++) stash(checked[i].ring, checkedM);
  for (let i = 0; i < preds.length; i++) stash(preds[i], predM);
  let parkedCells = 0;
  let parkedHit = 0;
  let coveredChecked = 0;
  let coveredCar = 0;
  let buildingCells = 0;
  let buildingHit = 0;
  for (let y = minY + cell / 2; y <= maxY; y += cell) {
    for (let x = minX + cell / 2; x <= maxX; x += cell) {
      const lon = origin[0] + x / mLon;
      const lat = origin[1] + y / 110540;
      const pt = [lon, lat];
      let onParked = false;
      for (let i = 0; i < parked.length; i++) {
        if (pointInRing(pt, parked[i].ring)) onParked = true;
      }
      let onBuilding = false;
      let onChecked = false;
      for (let i = 0; i < checked.length; i++) {
        if (!pointInRing(pt, checked[i].ring)) continue;
        onChecked = true;
        if (checked[i].class === "building") onBuilding = true;
      }
      let covered = false;
      for (let i = 0; i < preds.length; i++) {
        if (pointInRing(pt, preds[i])) covered = true;
      }
      if (onParked) {
        parkedCells++;
        if (covered) parkedHit++;
      }
      if (onBuilding) {
        buildingCells++;
        if (covered) buildingHit++;
      }
      if (covered && onChecked) {
        coveredChecked++;
        if (onParked) coveredCar++;
      }
    }
  }
  return {
    class: "car",
    labels: parked.length,
    predictions: preds.length,
    matched: parkedHit,
    recall: parkedCells ? parkedHit / parkedCells : null,
    precision: coveredChecked ? coveredCar / coveredChecked : null,
    buildingCovered: buildingCells ? buildingHit / buildingCells : null,
  };
}

module.exports = {
  RV_LENGTH_M,
  RV_WIDTH_M,
  RV_HEIGHT_M,
  RV_DB,
  TRAILER_LENGTH_M,
  TRAILER_WIDTH_M,
  TRAILER_HEIGHT_M,
  TRAILER_DB,
  SEMI_LENGTH_M,
  SEMI_WIDTH_M,
  SEMI_HEIGHT_M,
  SEMI_DB,
  BOAT_LENGTH_M,
  BOAT_WIDTH_M,
  BOAT_HEIGHT_M,
  BOAT_DB,
  CAR_LENGTH_M,
  CAR_WIDTH_M,
  CAR_LAYER_M,
  CAR_DB,
  MOBILE_HOME_M,
  OCCUPIED_LO,
  OCCUPIED_HI,
  CAR_MERGE_MIN,
  BOX,
  pitchClass,
  isTruckLotTags,
  isMarinaTags,
  isMooringTags,
  vehiclePixel,
  pointInRing,
  ringFraction,
  vehicleBlobM2,
  vehicleNear,
  pitchVehicle,
  occupiedCarLayerWork,
  carHitRows,
  finishCarLayer,
  boatsOnWaterWork,
  mobileHomesInRingWork,
  semisInLotWork,
  semisAtDocksWork,
  boatsOnWater,
  mobileHomesInRing,
  recenterBox,
  occupiedCall,
  decidePitch,
  finalizeVehicles,
  decodePlate,
  needsPitchImage,
  projectAt,
  centroidLL,
  orientedRing,
  semiBoxes,
  semisInLot,
  DOCK_DEPTH_M,
  DOCK_MIN_ROOF_M2,
  roofWantsDocks,
  dockAprons,
  yardInsideFootprint,
  semisAtDocks,
  boatBoxes,
  mergeDenseCars,
  occupiedCarLayer,
  scoreVehicles,
  scoreLayerOverlap,
};
