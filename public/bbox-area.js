/**
 * Square-foot area of a lon/lat bounding box.
 *
 * Width and height use the same mid-latitude meters-per-degree as
 * netlify/lib/geo-frame.js (111320·cos(lat) east-west, 110540 north-south).
 * A flat degree grid would be badly short at Vegas (~36°N) and Wisconsin
 * (~43°N). Square feet are that area in meters² × 10.7639.
 *
 * Browser + Node. Not used by the OpenIntent export path.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterArea = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** International square feet per square meter (Jerry: ×10.7639). */
  const SQFT_PER_M2 = 10.7639;

  function metersPerDeg(lat) {
    const rad = (lat * Math.PI) / 180;
    return { lon: 111320 * Math.cos(rad), lat: 110540 };
  }

  function bboxAreaM2(bbox) {
    if (!bbox) return NaN;
    const south = +bbox.south;
    const north = +bbox.north;
    const west = +bbox.west;
    const east = +bbox.east;
    if (![south, north, west, east].every(Number.isFinite)) return NaN;
    const mpd = metersPerDeg((south + north) / 2);
    return Math.abs(east - west) * mpd.lon * Math.abs(north - south) * mpd.lat;
  }

  function bboxAreaSqFt(bbox) {
    return bboxAreaM2(bbox) * SQFT_PER_M2;
  }

  /** US grouping, nearest square foot. Empty when there is nothing to show. */
  function formatSqFt(sqft) {
    if (!Number.isFinite(sqft) || sqft < 0.5) return "";
    return Math.round(sqft).toLocaleString("en-US") + " sq ft";
  }

  function formatBboxSqFt(bbox) {
    return formatSqFt(bboxAreaSqFt(bbox));
  }

  return {
    SQFT_PER_M2: SQFT_PER_M2,
    metersPerDeg: metersPerDeg,
    bboxAreaM2: bboxAreaM2,
    bboxAreaSqFt: bboxAreaSqFt,
    formatSqFt: formatSqFt,
    formatBboxSqFt: formatBboxSqFt,
  };
});
