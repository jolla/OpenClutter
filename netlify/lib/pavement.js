"use strict";

/**
 * Drop building footprints that sit on pavement instead of a roof.
 *
 * Microsoft / Overture / USA Structures sometimes keep a stale outline on a
 * lot that is now only asphalt (Oak Creek: a ~130×70 m ring over parked cars).
 * Aerial RGB is the check. A footprint is pavement when it is large enough to
 * matter, almost none of its interior is a light roof plane, and the interior
 * is gray asphalt rather than a dark membrane or a house roof.
 *
 * Houses stay: they are under MIN_PAVEMENT_AREA_M2 or they are not asphalt.
 * Imagery roof fill (source imagery-roof) is never dropped — those rings were
 * cut from a bright smooth plane. This does not invent a replacement outline.
 */

const { llToImagePx } = require("./geo-frame");
const { featureExteriorRings } = require("./pipeline");

const MIN_PAVEMENT_AREA_M2 = 900;
const MAX_ROOF_FRAC = 0.12;
const MAX_GREEN_FRAC = 0.18;
const DARK_ROOF_LUMA = 96;

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function sat(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx ? (mx - mn) / mx : 0;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * @param {{data:Uint8Array,width:number,height:number}} raw decoded RGBA, Y-down
 * @param {number[][]} ringImg Y-down image pixels
 * @param {number} mpu meters per pixel (isotropic)
 */
function pavementEvidence(raw, ringImg, mpu) {
  const empty = {
    n: 0,
    areaM2: 0,
    roofFrac: 0,
    asphaltFrac: 0,
    greenFrac: 0,
    meanY: 0,
    meanSat: 0,
  };
  if (!raw || !raw.data || !ringImg || ringImg.length < 3) return empty;
  const w = raw.width;
  const h = raw.height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ringImg.length; i++) {
    const p = ringImg[i];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  const m = mpu > 0 ? mpu : 1;
  const areaM2 = bw * bh * m * m;
  if (!(bw > 2) || !(bh > 2)) return Object.assign(empty, { areaM2 });
  const step = areaM2 > 4000 ? 3 : 2;
  let n = 0;
  let roof = 0;
  let asphalt = 0;
  let green = 0;
  let sumY = 0;
  let sumS = 0;
  const data = raw.data;
  const y0 = Math.max(1, minY | 0);
  const y1 = Math.min(h - 2, maxY);
  const x0 = Math.max(1, minX | 0);
  const x1 = Math.min(w - 2, maxX);
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      if (!pointInRing([x, y], ringImg)) continue;
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const Y = luma(r, g, b);
      const S = sat(r, g, b);
      n++;
      sumY += Y;
      sumS += S;
      const isGreen = g > r + 10 && g >= b && S > 0.08;
      if (isGreen) green++;
      else if (Y >= 168 && S < 0.2) roof++;
      else if (Y >= 88 && Y <= 162 && S < 0.18) asphalt++;
    }
  }
  return {
    n,
    areaM2,
    roofFrac: n ? roof / n : 0,
    asphaltFrac: n ? asphalt / n : 0,
    greenFrac: n ? green / n : 0,
    meanY: n ? sumY / n : 0,
    meanSat: n ? sumS / n : 0,
  };
}

function evidenceIsPavement(e) {
  if (!e || e.n < 20) return false;
  if (!(e.areaM2 >= MIN_PAVEMENT_AREA_M2)) return false;
  if (e.roofFrac >= MAX_ROOF_FRAC) return false;
  if (e.greenFrac >= MAX_GREEN_FRAC) return false;
  if (e.meanY < DARK_ROOF_LUMA && e.asphaltFrac < 0.45) return false;
  if (e.asphaltFrac >= 0.38 && e.roofFrac < 0.1 && e.meanY >= 100 && e.meanY <= 150 && e.meanSat < 0.22) {
    return true;
  }
  if (e.areaM2 >= 2500 && e.roofFrac < 0.08 && e.meanY >= 105 && e.meanY <= 145 && e.meanSat < 0.2 && e.greenFrac < 0.1) {
    return true;
  }
  return false;
}

function isPavementFootprint(raw, ringImg, mpu) {
  return evidenceIsPavement(pavementEvidence(raw, ringImg, mpu));
}

function geometryFromRings(rings) {
  if (rings.length === 1) return { type: "Polygon", coordinates: [rings[0]] };
  return { type: "MultiPolygon", coordinates: rings.map((r) => [r]) };
}

/**
 * @returns {{features: object[], dropped: number}}
 */
function rejectPavementFootprints(raw, frame, features) {
  const list = features || [];
  if (!raw || !raw.data || !frame) return { features: list.slice(), dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f) continue;
    if (f.properties && f.properties.source === "imagery-roof") {
      kept.push(f);
      continue;
    }
    const rings = featureExteriorRings(f.geometry);
    if (!rings.length) continue;
    const keepRings = [];
    for (let r = 0; r < rings.length; r++) {
      const img = [];
      for (let k = 0; k < rings[r].length; k++) {
        img.push(llToImagePx(rings[r][k][0], rings[r][k][1], frame));
      }
      if (isPavementFootprint(raw, img, frame.mpuX)) dropped++;
      else keepRings.push(rings[r]);
    }
    if (!keepRings.length) continue;
    if (keepRings.length === rings.length) {
      kept.push(f);
      continue;
    }
    kept.push({
      type: f.type || "Feature",
      properties: f.properties ? Object.assign({}, f.properties) : {},
      geometry: geometryFromRings(keepRings),
    });
  }
  return { features: kept, dropped };
}

module.exports = {
  MIN_PAVEMENT_AREA_M2,
  pavementEvidence,
  evidenceIsPavement,
  isPavementFootprint,
  rejectPavementFootprints,
};
