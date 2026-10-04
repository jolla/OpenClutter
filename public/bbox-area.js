/**
 * Draw-chip size of a lon/lat box.
 *
 * Each side uses the same mid-latitude meters-per-degree as
 * netlify/lib/geo-frame.js (111320·cos(lat) east-west, 110540 north-south).
 * A flat degree grid would be badly short at Vegas (~36°N) and Wisconsin (~43°N).
 *
 * The chip leads with how far across the draw is. Under a kilometer that is
 * meters, with feet beside it. A campus (about a kilometer, such as Wynn at
 * about 2 km) is kilometers, with miles beside it. Area follows on the same
 * line: square meters, with square feet quieter, or hectares and acres when
 * the square-meter figure is huge. No unit toggle.
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

  /**
   * Hectares and acres. Whole numbers from 100 up. One decimal below that,
   * without a trailing .0.
   */
  function formatStepped(n) {
    if (!Number.isFinite(n) || n < 0.05) return "";
    if (n >= 100) return Math.round(n).toLocaleString("en-US");
    const tenths = Math.round(n * 10) / 10;
    if (Math.abs(tenths - Math.round(tenths)) < 1e-9) return String(Math.round(tenths));
    return tenths.toFixed(1);
  }

  /** Longer side. A kilometer or more reads as km and miles. */
  const SPAN_CAMPUS_M = 1000;
  /** Square meters at which the area figure steps up to hectares. */
  const AREA_HECTARE_M2 = 100000;
  const SQ_FT_PER_ACRE = 43560;

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
    if (m2 >= AREA_HECTARE_M2) {
      const ha = m2 / 10000;
      const acres = (m2 * FEET_PER_M * FEET_PER_M) / SQ_FT_PER_ACRE;
      const metric = formatStepped(ha);
      const imperial = formatStepped(acres);
      if (!metric || !imperial) return null;
      return { metric: metric + " ha", imperial: imperial + " acres" };
    }
    const metric = formatCount(m2);
    const imperial = formatCount(m2 * FEET_PER_M * FEET_PER_M);
    if (!metric || !imperial) return null;
    return { metric: metric + " m²", imperial: imperial + " sq ft" };
  }

  function joinReadout(span, area) {
    if (!span || !area) return null;
    return {
      text: span.metric + " · " + span.imperial + " · " + area.metric + " · " + area.imperial,
      html:
        span.metric +
        ' · <span class="area-quiet">' +
        span.imperial +
        "</span> · " +
        area.metric +
        ' · <span class="area-quiet">' +
        area.imperial +
        "</span>",
    };
  }

  function bboxReadout(bbox) {
    const sides = bboxSidesM(bbox);
    if (!sides) return null;
    return joinReadout(formatSpan(Math.max(sides.widthM, sides.lengthM)), formatArea(sides.widthM * sides.lengthM));
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
    let south = Infinity;
    let north = -Infinity;
    let west = Infinity;
    let east = -Infinity;
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      if (!v) return null;
      const lat = +v.lat;
      const lng = +(v.lng != null ? v.lng : v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
    const sides = bboxSidesM({ west: west, south: south, east: east, north: north });
    if (!sides) return null;
    return joinReadout(formatSpan(Math.max(sides.widthM, sides.lengthM)), formatArea(area));
  }

  return {
    FEET_PER_M: FEET_PER_M,
    SPAN_CAMPUS_M: SPAN_CAMPUS_M,
    AREA_HECTARE_M2: AREA_HECTARE_M2,
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
