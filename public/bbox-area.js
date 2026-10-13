/**
 * Draw-chip size of a lon/lat box.
 *
 * Each side uses the same mid-latitude meters-per-degree as
 * netlify/lib/geo-frame.js (111320·cos(lat) east-west, 110540 north-south).
 * A flat degree grid would be badly short at Vegas (~36°N) and Wisconsin (~43°N).
 *
 * The chip leads with area: square meters, then square feet. A large site
 * stays in those units, with thousands separators. The side lengths are not
 * on the label. No unit toggle.
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

  /** US grouping, nearest whole number. Empty when there is nothing to show. */
  function formatCount(n) {
    if (!Number.isFinite(n) || n < 0.5) return "";
    return Math.round(n).toLocaleString("en-US");
  }

  function formatFeet(feet) {
    return formatCount(feet);
  }

  /** One decimal. Used for kilometers and miles. */
  function formatOneDecimal(n) {
    if (!Number.isFinite(n) || n < 0) return "";
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  /** Longer side. A kilometer or more reads as km and miles. */
  const SPAN_CAMPUS_M = 1000;

  function formatSpan(meters) {
    if (!(meters >= 1)) return null;
    if (meters >= SPAN_CAMPUS_M) {
      const km = meters / 1000;
      const mi = (meters * FEET_PER_M) / 5280;
      return { metric: formatOneDecimal(km) + " km", imperial: formatOneDecimal(mi) + " mi" };
    }
    const metric = formatCount(meters);
    const imperial = formatCount(meters * FEET_PER_M);
    if (!metric || !imperial) return null;
    return { metric: metric + " m", imperial: imperial + " ft" };
  }

  function formatArea(m2) {
    if (!(m2 > 0)) return null;
    const metric = formatCount(m2);
    const imperial = formatCount(m2 * FEET_PER_M * FEET_PER_M);
    if (!metric || !imperial) return null;
    return { metric: metric + " m²", imperial: imperial + " ft²" };
  }

  function areaLine(area) {
    if (!area) return null;
    return {
      text: area.metric + " · " + area.imperial,
      html: area.metric + ' · <span class="area-quiet">' + area.imperial + "</span>",
    };
  }

  function bboxReadout(bbox) {
    const sides = bboxSidesM(bbox);
    if (!sides) return null;
    return areaLine(formatArea(sides.widthM * sides.lengthM));
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

  function polygonReadout(vertices) {
    const area = ringAreaM2(vertices);
    if (!Number.isFinite(area)) return null;
    return areaLine(formatArea(area));
  }

  return {
    FEET_PER_M: FEET_PER_M,
    SPAN_CAMPUS_M: SPAN_CAMPUS_M,
    metersPerDeg: metersPerDeg,
    bboxSidesM: bboxSidesM,
    bboxSidesFt: bboxSidesFt,
    formatFeet: formatFeet,
    formatSpan: formatSpan,
    formatArea: formatArea,
    bboxReadout: bboxReadout,
    ringAreaM2: ringAreaM2,
    polygonReadout: polygonReadout,
  };
});
