/**
 * Site outline gestures.
 *
 * Drag commits a box. A click (no drag) adds a polygon vertex. The caller
 * maps right-click / contextmenu to finish(), and Escape to cancel().
 * finish() with fewer than 3 vertices discards the ring — an unfinished
 * shape is not a site. A drag after vertices have been placed commits a
 * box and drops the open ring.
 *
 * Distances are container pixels. DRAG_PX is the click/drag split.
 * Browser + Node. The export path still sends the axis-aligned box.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterDraw = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Pointer travel at or above this many pixels is a box, not a vertex. */
  const DRAG_PX = 6;

  function createSession() {
    return {
      armed: false,
      phase: "idle",
      down: null,
      dragged: false,
      vertices: [],
    };
  }

  function dist2(a, b) {
    const dx = +a.x - +b.x;
    const dy = +a.y - +b.y;
    return dx * dx + dy * dy;
  }

  function copyVerts(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push({ lat: list[i].lat, lng: list[i].lng });
    }
    return out;
  }

  function arm(session) {
    session.armed = true;
    session.phase = "armed";
    session.down = null;
    session.dragged = false;
    session.vertices = [];
    return { type: "armed" };
  }

  function pointerDown(session, pt) {
    if (!session.armed || !pt) return { type: "ignore" };
    if (pt.button != null && pt.button !== 0) return { type: "ignore" };
    if (pt.ctrlKey) return { type: "ignore" };
    const lat = +pt.lat;
    const lng = +pt.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { type: "ignore" };
    session.down = { x: +pt.x, y: +pt.y, lat: lat, lng: lng };
    session.dragged = false;
    return { type: "down" };
  }

  function pointerMove(session, pt) {
    if (!session.armed || !session.down || !pt) return { type: "ignore" };
    if (!session.dragged && Number.isFinite(+pt.x) && Number.isFinite(+pt.y)) {
      if (dist2(session.down, pt) >= DRAG_PX * DRAG_PX) session.dragged = true;
    }
    if (!session.dragged) return { type: "ignore" };
    const lat = +pt.lat;
    const lng = +pt.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { type: "ignore" };
    return {
      type: "drag",
      start: { lat: session.down.lat, lng: session.down.lng },
      end: { lat: lat, lng: lng },
    };
  }

  function nearLastVertex(session, pt) {
    const prev = session.vertices[session.vertices.length - 1];
    if (!prev || !pt) return false;
    if (![pt.x, pt.y, prev.x, prev.y].every(Number.isFinite)) return false;
    return dist2(prev, pt) < DRAG_PX * DRAG_PX;
  }

  function pointerUp(session, pt) {
    if (!session.armed || !session.down) return { type: "ignore" };
    const start = { lat: session.down.lat, lng: session.down.lng };
    const endLat = pt && Number.isFinite(+pt.lat) ? +pt.lat : start.lat;
    const endLng = pt && Number.isFinite(+pt.lng) ? +pt.lng : start.lng;
    const end = { lat: endLat, lng: endLng };
    let dragged = session.dragged;
    if (!dragged && pt && Number.isFinite(+pt.x) && Number.isFinite(+pt.y)) {
      dragged = dist2(session.down, pt) >= DRAG_PX * DRAG_PX;
    }
    const downPt = session.down;
    session.down = null;
    session.dragged = false;
    if (dragged) {
      session.vertices = [];
      session.phase = "idle";
      session.armed = false;
      return { type: "commit-box", start: start, end: end };
    }
    const candidate = {
      lat: end.lat,
      lng: end.lng,
      x: pt && Number.isFinite(+pt.x) ? +pt.x : downPt.x,
      y: pt && Number.isFinite(+pt.y) ? +pt.y : downPt.y,
    };
    if (nearLastVertex(session, candidate)) return { type: "ignore" };
    session.vertices.push(candidate);
    session.phase = "polygon";
    return { type: "vertex", vertices: copyVerts(session.vertices) };
  }

  function abortPress(session) {
    if (!session.down) return { type: "ignore" };
    session.down = null;
    session.dragged = false;
    return { type: "abort-press" };
  }

  /** Right-click. Fewer than 3 corners discards the ring and stops drawing. */
  function finish(session) {
    if (!session.armed || session.phase !== "polygon" || session.down) return { type: "ignore" };
    if (!session.vertices.length) return { type: "ignore" };
    if (session.vertices.length < 3) {
      const count = session.vertices.length;
      session.vertices = [];
      session.phase = "idle";
      session.armed = false;
      session.down = null;
      session.dragged = false;
      return { type: "discard", count: count };
    }
    const vertices = copyVerts(session.vertices);
    session.vertices = [];
    session.phase = "idle";
    session.armed = false;
    return { type: "commit-polygon", vertices: vertices, bounds: boundsOf(vertices) };
  }

  /** Escape. Drops an open ring and leaves draw mode. Does not touch a finished site. */
  function cancel(session) {
    if (!session.armed && !session.down && session.vertices.length === 0) return { type: "ignore" };
    const discarded = session.vertices.length;
    session.vertices = [];
    session.down = null;
    session.dragged = false;
    session.armed = false;
    session.phase = "idle";
    return { type: "cancel", discarded: discarded };
  }

  function setVertexPixels(session, points) {
    if (!session || !Array.isArray(points)) return;
    const n = Math.min(session.vertices.length, points.length);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
      session.vertices[i].x = +p.x;
      session.vertices[i].y = +p.y;
    }
  }

  function boundsOf(vertices) {
    if (!Array.isArray(vertices) || !vertices.length) return null;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      if (!v) return null;
      const lat = +v.lat;
      const lng = +(v.lng != null ? v.lng : v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    return { west: west, south: south, east: east, north: north };
  }

  return {
    DRAG_PX: DRAG_PX,
    createSession: createSession,
    arm: arm,
    pointerDown: pointerDown,
    pointerMove: pointerMove,
    pointerUp: pointerUp,
    abortPress: abortPress,
    finish: finish,
    cancel: cancel,
    setVertexPixels: setVertexPixels,
    boundsOf: boundsOf,
  };
});
