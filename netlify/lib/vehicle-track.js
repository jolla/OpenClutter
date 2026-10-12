"use strict";

/**
 * Vehicles and mobile structures.
 *
 * OSM supplies the pad, the slip, the truck lot, or the surface lot.
 * The aerial says whether a light vehicle is sitting on a camp pad.
 * A metal RV or travel trailer is a solid box at 12 dB/m.
 * Cars in a dense lot are one 1.5 m layer, not one area per car.
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
const SEMI_CAP = 80;
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
 * grass, belongs to the next site and does not count.
 */
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
    let sx = 0;
    let sy = 0;
    for (let c = 0; c < cells.length; c++) {
      const x = x0 + (cells[c] % bw) + 0.5;
      const y = y0 + ((cells[c] / bw) | 0) + 0.5;
      sx += x;
      sy += y;
      dmin = Math.min(dmin, distM(x, y));
    }
    if (dmin > ROOF_TOUCH_M) continue;
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
  boatBoxes,
  mergeDenseCars,
  scoreVehicles,
};
