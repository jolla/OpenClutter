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
 * A smooth gray membrane stays too: that is a roof, not a car-filled lot.
 * A distribution warehouse is that membrane at tens of thousands of square
 * metres, often with no source height. Cars and stall paint raise the local
 * deviation, so a textured lot still drops. A floor count of two or more
 * stays as well. Cars on a parking deck are not a surface lot. Imagery roof
 * fill (source imagery-roof) is never dropped. Those rings were cut from a
 * smooth plane. This does not invent a replacement outline.
 */

const { llToImagePx } = require("./geo-frame");
const { featureExteriorRings } = require("./pipeline");

const MIN_PAVEMENT_AREA_M2 = 900;
const MAX_ROOF_FRAC = 0.12;
const MAX_GREEN_FRAC = 0.18;
const DARK_ROOF_LUMA = 96;
/** Two decks at about 3 m. A surface lot does not carry a floor count. */
const STRUCTURE_FLOOR_M = 6;
/** A warehouse membrane is smoother than a parked row. Above this it is a lot. */
const MEMBRANE_STD = 5;
/** One roof, not a town-sized pad. Same band as the hotel mega cap. */
const MEMBRANE_MAX_M2 = 400000;
/** A large roof with no measured height. Low industrial buildings sit near 12 m. */
const WAREHOUSE_HEIGHT_M = 12;

function countedStructure(heightM, heightSource) {
  if (!(heightM >= STRUCTURE_FLOOR_M)) return false;
  return heightSource === "overture-floors" || heightSource === "osm" || heightSource === "osm-part";
}

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
function localStdAt(data, w, h, x, y) {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let dy = -3; dy <= 3; dy += 3) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -3; dx <= 3; dx += 3) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const j = (yy * w + xx) * 4;
      const Y = luma(data[j], data[j + 1], data[j + 2]);
      n++;
      sum += Y;
      sum2 += Y * Y;
    }
  }
  if (!n) return 99;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

function medianOf(values) {
  if (!values.length) return 99;
  const s = values.slice().sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}

function pavementEvidence(raw, ringImg, mpu) {
  const empty = {
    n: 0,
    areaM2: 0,
    roofFrac: 0,
    asphaltFrac: 0,
    greenFrac: 0,
    meanY: 0,
    meanSat: 0,
    medianStd: 99,
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
  const stds = [];
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
      stds.push(localStdAt(data, w, h, x, y));
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
    medianStd: medianOf(stds),
  };
}

/**
 * Smooth gray roofs sit in the same luma band as asphalt. Cars and stall
 * paint raise the local deviation; a membrane does not. A measured height
 * is a building source. A compact very-smooth pad without a height can be
 * a small roof. A large smooth lot without a height stays pavement.
 */
function smoothMembrane(e, heightM) {
  if (!e || !(e.medianStd < 7.5)) return false;
  if (e.greenFrac >= MAX_GREEN_FRAC) return false;
  // A distribution warehouse is a smooth gray plane well above 25,000 m².
  // The deviation gate is what separates it from a car lot. A pad larger
  // than one roof stays pavement.
  if (e.medianStd < MEMBRANE_STD && e.areaM2 >= 20000 && e.areaM2 < MEMBRANE_MAX_M2) return true;
  // A measured height plus a smooth plane is a roof, including a large gray
  // hotel wing. The area cap keeps a town-sized smooth pad from coming back.
  if (heightM >= 3.5 && e.areaM2 < 25000) return true;
  return e.areaM2 < 1800 && e.medianStd < MEMBRANE_STD;
}

/**
 * The asphalt rules, ignoring the membrane exception. A gray warehouse
 * matches these and is kept only because the plane is smooth.
 */
function pavementDespiteMembrane(e, heightM) {
  if (!e || e.n < 20) return false;
  if (!(e.areaM2 >= MIN_PAVEMENT_AREA_M2)) return false;
  if (e.roofFrac >= MAX_ROOF_FRAC) return false;
  if (e.greenFrac >= MAX_GREEN_FRAC) return false;
  if (heightM >= 3.5 && e.greenFrac >= 0.05 && e.medianStd >= 10) return false;
  if (e.meanY < DARK_ROOF_LUMA && e.asphaltFrac < 0.45) return false;
  if (e.asphaltFrac >= 0.38 && e.roofFrac < 0.1 && e.meanY >= 100 && e.meanY <= 150 && e.meanSat < 0.22) return true;
  if (e.areaM2 >= 2500 && e.roofFrac < 0.08 && e.meanY >= 105 && e.meanY <= 145 && e.meanSat < 0.2 && e.greenFrac < 0.1) {
    return true;
  }
  return false;
}

function evidenceIsPavement(e, heightM, heightSource) {
  if (!e || e.n < 20) return false;
  if (!(e.areaM2 >= MIN_PAVEMENT_AREA_M2)) return false;
  // A floor count is the deck. Cars on that roof sit in the same luma band
  // as a surface lot, and the deviation is not a reason to drop it.
  if (countedStructure(Number(heightM) || 0, heightSource)) return false;
  if (smoothMembrane(e, heightM)) return false;
  if (e.roofFrac >= MAX_ROOF_FRAC) return false;
  if (e.greenFrac >= MAX_GREEN_FRAC) return false;
  // Pointe-Claire's convent is a measured roof under trees. At 2 m/px those
  // trees sit in the asphalt luma band and only a few pixels count as green.
  // A parking lot in the same test is grayer than that. Keep the building.
  if (heightM >= 3.5 && e.greenFrac >= 0.05 && e.medianStd >= 10) return false;
  if (e.meanY < DARK_ROOF_LUMA && e.asphaltFrac < 0.45) return false;
  if (e.asphaltFrac >= 0.38 && e.roofFrac < 0.1 && e.meanY >= 100 && e.meanY <= 150 && e.meanSat < 0.22) {
    return true;
  }
  if (e.areaM2 >= 2500 && e.roofFrac < 0.08 && e.meanY >= 105 && e.meanY <= 145 && e.meanSat < 0.2 && e.greenFrac < 0.1) {
    return true;
  }
  return false;
}

function isPavementFootprint(raw, ringImg, mpu, heightM, heightSource) {
  return evidenceIsPavement(pavementEvidence(raw, ringImg, mpu), heightM, heightSource);
}

function llAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  let n = ring.length;
  const a0 = ring[0];
  const last = ring[n - 1];
  if (Math.abs(a0[0] - last[0]) < 1e-12 && Math.abs(a0[1] - last[1]) < 1e-12) n--;
  if (n < 3) return 0;
  let lat = 0;
  for (let i = 0; i < n; i++) lat += ring[i][1];
  lat /= n;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * mLon * ring[i][1] * 110540 - ring[i][0] * mLon * ring[j][1] * 110540;
  }
  return Math.abs(a) / 2;
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
    let seatWarehouse = false;
    const props0 = f.properties || {};
    let heightM = Number(props0.height != null ? props0.height : props0.Height || props0.HEIGHT);
    let heightSource = props0.heightSource || "";
    const floors = Number(props0.numFloors);
    let wroteFloors = false;
    if (floors >= 2 && floors <= 60) {
      if (!(heightM >= STRUCTURE_FLOOR_M)) {
        heightM = floors * 3;
        wroteFloors = true;
      }
      if (!countedStructure(heightM, heightSource)) {
        heightSource = "overture-floors";
        wroteFloors = true;
      }
    }
    for (let r = 0; r < rings.length; r++) {
      const img = [];
      for (let k = 0; k < rings[r].length; k++) {
        img.push(llToImagePx(rings[r][k][0], rings[r][k][1], frame));
      }
      const evidence = pavementEvidence(raw, img, frame.mpuX);
      if (isPavementFootprint(raw, img, frame.mpuX, heightM, heightSource)) dropped++;
      else {
        keepRings.push(rings[r]);
        const polyM2 = llAreaM2(rings[r]);
        const unmeasured = !(heightM > 2) && !countedStructure(heightM, heightSource);
        const grayMembrane =
          unmeasured && smoothMembrane(evidence, 0) && pavementDespiteMembrane(evidence, heightM);
        // A distribution roof with no source height is about 12 m. The area
        // bin would call the same outline ten floors. A floor count wins.
        const largeRoof = unmeasured && polyM2 >= 20000 && polyM2 < MEMBRANE_MAX_M2;
        if (grayMembrane || largeRoof) seatWarehouse = true;
      }
    }
    if (!keepRings.length) continue;
    const props = f.properties ? Object.assign({}, f.properties) : {};
    if (wroteFloors && !seatWarehouse) {
      props.height = heightM;
      props.heightSource = heightSource;
      props.numFloors = floors;
    }
    if (seatWarehouse) {
      props.height = WAREHOUSE_HEIGHT_M;
      props.heightSource = "warehouse";
    }
    const sameGeom = keepRings.length === rings.length;
    kept.push({
      type: f.type || "Feature",
      properties: props,
      geometry: sameGeom ? f.geometry : geometryFromRings(keepRings),
    });
  }
  return { features: kept, dropped };
}

module.exports = {
  MIN_PAVEMENT_AREA_M2,
  STRUCTURE_FLOOR_M,
  pavementEvidence,
  evidenceIsPavement,
  countedStructure,
  smoothMembrane,
  pavementDespiteMembrane,
  WAREHOUSE_HEIGHT_M,
  isPavementFootprint,
  rejectPavementFootprints,
};
