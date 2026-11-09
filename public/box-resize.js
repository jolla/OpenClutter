/**
 * Resize a finished rectangular selection from one corner.
 *
 * The rectangle is the export frame: center, ground width, ground length,
 * and a bearing (degrees clockwise from north, 0 when the box is north-up).
 * That is the same frame the turned-box export uses (rotate-export.js):
 * west/south/east/north are the box before it is turned, plus the bearing.
 *
 * Dragging a corner keeps the opposite corner fixed and keeps the bearing.
 * The pointer is free in both axes. If it crosses the anchored corner, or
 * lands closer than MIN_SIDE_M, that side stops at the minimum instead of
 * flipping or collapsing. A preview always starts from the rectangle at
 * pointer-down, so repeating a move does not walk the anchor.
 *
 * Distances are meters at the anchor latitude (111320·cos(lat), 110540),
 * the same scale as bbox-area.js and geo-frame.js. Browser + Node.
 *
 * A move keeps that same rectangle and changes only the center. Width,
 * length, and bearing are copied from the rectangle at pointer-down, so
 * they cannot drift. The pointer may grab anywhere inside; the center
 * moves by the same lat/lng delta as the pointer. A center shift under
 * the same threshold as a corner resize (about 1 cm) is not a new area.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterBoxResize = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Smallest side while resizing. Under the 40 m export minimum, so a box
   * can still be too small to export, but it stays a rectangle the handles
   * can grab. Crossing the opposite corner clamps here instead of inverting.
   */
  const MIN_SIDE_M = 2;

  /** Local signs from the center: 0 SW, 1 SE, 2 NE, 3 NW. Same order as the map outline. */
  const CORNER_SIGN = [
    { a: -1, b: -1 },
    { a: 1, b: -1 },
    { a: 1, b: 1 },
    { a: -1, b: 1 },
  ];

  function metersPerDeg(lat) {
    const rad = (lat * Math.PI) / 180;
    return { lon: 111320 * Math.cos(rad), lat: 110540 };
  }

  function cloneRect(rect) {
    return {
      lon0: rect.lon0,
      lat0: rect.lat0,
      widthM: rect.widthM,
      lengthM: rect.lengthM,
      deg: rect.deg,
    };
  }

  function rectFromBBox(bbox, deg) {
    if (!bbox) return null;
    const west = +bbox.west;
    const south = +bbox.south;
    const east = +bbox.east;
    const north = +bbox.north;
    if (![west, south, east, north].every(Number.isFinite)) return null;
    if (!(east > west) || !(north > south)) return null;
    const lon0 = (west + east) / 2;
    const lat0 = (south + north) / 2;
    const mpd = metersPerDeg(lat0);
    const bearing = +deg;
    return {
      lon0: lon0,
      lat0: lat0,
      widthM: (east - west) * mpd.lon,
      lengthM: (north - south) * mpd.lat,
      deg: Number.isFinite(bearing) ? bearing : 0,
    };
  }

  function bboxFromRect(rect) {
    if (!rect) return null;
    if (![rect.lon0, rect.lat0, rect.widthM, rect.lengthM].every(Number.isFinite)) return null;
    if (!(rect.widthM > 0) || !(rect.lengthM > 0)) return null;
    const mpd = metersPerDeg(rect.lat0);
    const dLon = rect.widthM / 2 / mpd.lon;
    const dLat = rect.lengthM / 2 / mpd.lat;
    return {
      west: rect.lon0 - dLon,
      east: rect.lon0 + dLon,
      south: rect.lat0 - dLat,
      north: rect.lat0 + dLat,
    };
  }

  function localOffset(deg, a, b) {
    const t = (deg * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return { east: a * cos + b * sin, north: -a * sin + b * cos };
  }

  function cornerLatLng(rect, index) {
    if (!rect || index < 0 || index > 3) return null;
    const sign = CORNER_SIGN[index];
    const off = localOffset(rect.deg, (sign.a * rect.widthM) / 2, (sign.b * rect.lengthM) / 2);
    const mpd = metersPerDeg(rect.lat0);
    return { lat: rect.lat0 + off.north / mpd.lat, lng: rect.lon0 + off.east / mpd.lon };
  }

  function minSide(minSideM) {
    const n = +minSideM;
    return Number.isFinite(n) && n > 0 ? n : MIN_SIDE_M;
  }

  /** Keep the corner on its own side of the anchor, at least `min` meters away. */
  function clampAxis(delta, sign, min) {
    if (Math.abs(delta) >= min && Math.sign(delta) === sign) return sign * Math.abs(delta);
    return sign * min;
  }

  /**
   * New rectangle with `corner` moved toward (lat, lng) and the opposite
   * corner anchored. Bearing is unchanged. Null when the input is unusable.
   */
  function resizeFromCorner(rect, corner, lat, lng, minSideM) {
    if (!rect || corner < 0 || corner > 3) return null;
    if (!Number.isFinite(+lat) || !Number.isFinite(+lng)) return null;
    if (![rect.lon0, rect.lat0, rect.widthM, rect.lengthM, rect.deg].every(Number.isFinite)) return null;
    if (!(rect.widthM > 0) || !(rect.lengthM > 0)) return null;
    const anchor = cornerLatLng(rect, (corner + 2) % 4);
    const sign = CORNER_SIGN[corner];
    const mpd = metersPerDeg(anchor.lat);
    const east = (+lng - anchor.lng) * mpd.lon;
    const north = (+lat - anchor.lat) * mpd.lat;
    const t = (rect.deg * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const min = minSide(minSideM);
    const da = clampAxis(cos * east - sin * north, sign.a, min);
    const db = clampAxis(sin * east + cos * north, sign.b, min);
    const widthM = Math.abs(da);
    const lengthM = Math.abs(db);
    const opp = CORNER_SIGN[(corner + 2) % 4];
    const off = localOffset(rect.deg, (opp.a * widthM) / 2, (opp.b * lengthM) / 2);
    let lat0 = anchor.lat;
    let scale = metersPerDeg(lat0);
    for (let i = 0; i < 4; i++) {
      lat0 = anchor.lat - off.north / scale.lat;
      scale = metersPerDeg(lat0);
    }
    return {
      lon0: anchor.lng - off.east / scale.lon,
      lat0: lat0,
      widthM: widthM,
      lengthM: lengthM,
      deg: rect.deg,
    };
  }

  /** Local east/north meters of (lat, lng) inside the rectangle's own axes. */
  function localMeters(rect, lat, lng) {
    const mpd = metersPerDeg(rect.lat0);
    const east = (+lng - rect.lon0) * mpd.lon;
    const north = (+lat - rect.lat0) * mpd.lat;
    const t = (rect.deg * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return { a: cos * east - sin * north, b: sin * east + cos * north };
  }

  function usableRect(rect) {
    if (!rect) return false;
    if (![rect.lon0, rect.lat0, rect.widthM, rect.lengthM, rect.deg].every(Number.isFinite)) return false;
    return rect.widthM > 0 && rect.lengthM > 0;
  }

  /**
   * True when (lat, lng) is inside the rectangle, including the edge.
   * A fifth of a meter of slack keeps a press on the stroke inside.
   * Corner handles are a separate hit target and win over this test.
   */
  function containsPoint(rect, lat, lng) {
    if (!usableRect(rect) || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return false;
    const p = localMeters(rect, lat, lng);
    const slack = 0.2;
    return Math.abs(p.a) <= rect.widthM / 2 + slack && Math.abs(p.b) <= rect.lengthM / 2 + slack;
  }

  /**
   * Screen point `pad` pixels past `tip`, away from `origin`.
   * Used to park the clear control just outside a corner.
   */
  function pointBeyond(origin, tip, pad) {
    if (!origin || !tip) return null;
    if (![origin.x, origin.y, tip.x, tip.y].every(Number.isFinite)) return null;
    const dist = +pad;
    if (!Number.isFinite(dist) || dist < 0) return null;
    const dx = tip.x - origin.x;
    const dy = tip.y - origin.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: tip.x + (dx / len) * dist, y: tip.y + (dy / len) * dist };
  }

  /**
   * Move session. `lat`/`lng` are the pointer at press, not the center,
   * so a grab away from the middle still tracks the pointer one for one.
   * The center moves by the pointer's lat/lng delta.
   */
  function beginMove(rect, lat, lng) {
    if (!usableRect(rect) || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return null;
    return {
      start: cloneRect(rect),
      current: cloneRect(rect),
      moved: false,
      lat: +lat,
      lng: +lng,
    };
  }

  function updateMove(session, lat, lng) {
    if (!session) return null;
    if (!Number.isFinite(+lat) || !Number.isFinite(+lng)) return session.current;
    const next = {
      lon0: session.start.lon0 + (+lng - session.lng),
      lat0: session.start.lat0 + (+lat - session.lat),
      widthM: session.start.widthM,
      lengthM: session.start.lengthM,
      deg: session.start.deg,
    };
    session.current = next;
    session.moved = changed(session.start, next);
    return next;
  }

  function changed(a, b) {
    if (!a || !b) return true;
    if (a.deg !== b.deg) return true;
    if (Math.abs(a.widthM - b.widthM) >= 0.05) return true;
    if (Math.abs(a.lengthM - b.lengthM) >= 0.05) return true;
    if (Math.abs(a.lat0 - b.lat0) >= 1e-7) return true;
    if (Math.abs(a.lon0 - b.lon0) >= 1e-7) return true;
    return false;
  }

  function begin(rect, corner) {
    if (!rect || corner < 0 || corner > 3) return null;
    const start = cloneRect(rect);
    return { corner: corner, start: start, current: cloneRect(rect), moved: false };
  }

  function update(session, lat, lng, minSideM) {
    if (!session) return null;
    const next = resizeFromCorner(session.start, session.corner, lat, lng, minSideM);
    if (!next) return session.current;
    session.current = next;
    session.moved = changed(session.start, next);
    return next;
  }

  function cancel(session) {
    if (!session) return null;
    session.current = cloneRect(session.start);
    session.moved = false;
    return cloneRect(session.start);
  }

  /**
   * Bearing used to place corners and to build the resize frame.
   * The export sends a bearing only when the rotate switch is on
   * (?rotate=1). A leftover nonzero degree on any other page would
   * draw corners the request does not turn, so the switch off means 0.
   */
  function bearingForPage(rotateOn, deg) {
    const n = +deg;
    if (!rotateOn || !Number.isFinite(n)) return 0;
    return n;
  }

  /**
   * The box an export should send if a corner drag or a move is still down.
   * Commit keeps the preview the pointer is on. Anything else, including
   * a press that has not moved, is the box from pointer-down. The returned
   * rect is a copy, so a later cancel cannot change what was sent.
   */
  function settledRect(session, commit) {
    if (!session) return null;
    if (commit && session.moved) return cloneRect(session.current);
    return cancel(session);
  }

  /** Corner handles belong to a plain rectangle. A polygon readout does not. */
  function cornerHandlesFor(label) {
    return label == null;
  }

  return {
    MIN_SIDE_M: MIN_SIDE_M,
    CORNER_SIGN: CORNER_SIGN,
    rectFromBBox: rectFromBBox,
    bboxFromRect: bboxFromRect,
    cornerLatLng: cornerLatLng,
    resizeFromCorner: resizeFromCorner,
    begin: begin,
    update: update,
    cancel: cancel,
    containsPoint: containsPoint,
    pointBeyond: pointBeyond,
    beginMove: beginMove,
    updateMove: updateMove,
    bearingForPage: bearingForPage,
    settledRect: settledRect,
    cornerHandlesFor: cornerHandlesFor,
  };
});
