/**
 * Draw-chip size of a lon/lat bounding box, in feet.
 *
 * Each side uses the same mid-latitude meters-per-degree as
 * netlify/lib/geo-frame.js (111320·cos(lat) east-west, 110540 north-south),
 * then × 3.280839895. A flat degree grid would be badly short at Vegas
 * (~36°N) and Wisconsin (~43°N).
 *
 * Browser + Node. Not used by the OpenIntent export path.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterArea = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** International feet per meter (Jerry: ×3.280839895). */
  const FEET_PER_M = 3.280839895;

  function metersPerDeg(lat) {
    const rad = (lat * Math.PI) / 180;
    return { lon: 111320 * Math.cos(rad), lat: 110540 };
  }

  function bboxSidesM(bbox) {
    if (!bbox) return null;
    const south = +bbox.south;
    const north = +bbox.north;
    const west = +bbox.west;
    const east = +bbox.east;
    if (![south, north, west, east].every(Number.isFinite)) return null;
    const mpd = metersPerDeg((south + north) / 2);
    return {
      widthM: Math.abs(east - west) * mpd.lon,
      lengthM: Math.abs(north - south) * mpd.lat,
    };
  }

  function bboxSidesFt(bbox) {
    const sides = bboxSidesM(bbox);
    if (!sides) return null;
    return {
      widthFt: sides.widthM * FEET_PER_M,
      lengthFt: sides.lengthM * FEET_PER_M,
    };
  }

  /** US grouping, nearest foot. Empty when there is nothing to show. */
  function formatFeet(feet) {
    if (!Number.isFinite(feet) || feet < 0.5) return "";
    return Math.round(feet).toLocaleString("en-US");
  }

  // Chip order is map X×Y: east–west width × north–south length, in feet.
  function formatBboxFeet(bbox) {
    const sides = bboxSidesFt(bbox);
    if (!sides) return "";
    const width = formatFeet(sides.widthFt);
    const length = formatFeet(sides.lengthFt);
    if (!width || !length) return "";
    return width + " × " + length + " ft";
  }

  /**
   * Polygon area in square metres, equirectangular at the ring’s mean latitude
   * (same meters-per-degree as a bbox chip). A repeated closing vertex is ignored.
   */
  function ringAreaM2(vertices) {
    if (!Array.isArray(vertices) || vertices.length < 3) return null;
    const pts = [];
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      if (!v) return null;
      const lat = +v.lat;
      const lng = +(v.lng != null ? v.lng : v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      pts.push({ lat: lat, lng: lng });
    }
    const closed =
      pts.length >= 2 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng;
    const n = closed ? pts.length - 1 : pts.length;
    if (n < 3) return null;
    let latSum = 0;
    for (let i = 0; i < n; i++) latSum += pts[i].lat;
    const mpd = metersPerDeg(latSum / n);
    let twice = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      twice += p.lng * mpd.lon * (q.lat * mpd.lat) - q.lng * mpd.lon * (p.lat * mpd.lat);
    }
    return Math.abs(twice) / 2;
  }

  /** Polygon chip: area in square feet, not the box’s L×W. */
  function formatPolygonSqFt(vertices) {
    const m2 = ringAreaM2(vertices);
    if (!Number.isFinite(m2)) return "";
    const text = formatFeet(m2 * FEET_PER_M * FEET_PER_M);
    if (!text) return "";
    return text + " sq ft";
  }

  return {
    FEET_PER_M: FEET_PER_M,
    metersPerDeg: metersPerDeg,
    bboxSidesM: bboxSidesM,
    bboxSidesFt: bboxSidesFt,
    formatFeet: formatFeet,
    formatBboxFeet: formatBboxFeet,
    ringAreaM2: ringAreaM2,
    formatPolygonSqFt: formatPolygonSqFt,
  };
});
