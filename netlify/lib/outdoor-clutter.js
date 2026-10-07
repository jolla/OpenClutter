"use strict";

/**
 * Outdoor clutter for Wi-Fi and AFC links: water, parking structures,
 * walls and fences, and light poles.
 *
 * One Overpass query, clipped to the drawn box the same way buildings are.
 * Overture building class/subtype is not a parquet column. Adding it can
 * fail the Vegas read when the field is absent. A footprint that already
 * carries class or subtype "parking" is recolored instead of drawn twice.
 *
 * Attenuation is 5 GHz dB/m, documented on the materials next to buildings.
 * OpenIntent has no reflection field. Water is a shallow volume at the
 * shortest custom height (just over 2 m), near-zero loss, not a mirror.
 * A chain-link fence is about 1.8 m in the field. A custom under or equal
 * to 2 m does not import, so the fence is 2.1 m.
 */

const { llToPx } = require("./geo-frame");
const { intersectionAreaPx } = require("./poly-clip");
const { LIFT_LOCAL_M } = require("./terrain");
const { outdoorMaterial, liftedOutdoorMaterial } = require("./materials");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const FETCH_MS = 3200;
const POLE_CAP = 48;
const WALL_CAP = 80;
const WATER_CAP = 12;
const PARKING_CAP = 20;
const POLE_SIDES = 10;
const POLE_DIAMETER_M = 0.3;
const POLE_HEIGHT_M = 9;

const THICK_M = { wall: 0.4, fence: 0.15, retaining: 0.5, hedge: 0.6 };
const LINE_KINDS = { wall: true, fence: true, retaining: true, hedge: true };

const OUTDOOR_MISS = "Outdoor clutter did not return. Export again.";

function wantAny(want) {
  return !!(want && (want.water || want.parking || want.walls || want.poles));
}

function overpassQuery(bbox, want) {
  const s = +bbox.south;
  const w = +bbox.west;
  const n = +bbox.north;
  const e = +bbox.east;
  const box = s + "," + w + "," + n + "," + e;
  const parts = [];
  if (want.water) {
    parts.push('way["natural"="water"](' + box + ");");
    parts.push('way["water"](' + box + ");");
    parts.push('way["waterway"="riverbank"](' + box + ");");
    parts.push('way["landuse"="reservoir"](' + box + ");");
  }
  if (want.parking) {
    parts.push('way["amenity"="parking"]["parking"="multi-storey"](' + box + ");");
    parts.push('way["building"="parking"](' + box + ");");
  }
  if (want.walls) {
    parts.push('way["barrier"~"^(wall|fence|retaining_wall|hedge|city_wall)$"](' + box + ");");
  }
  if (want.poles) {
    parts.push('node["highway"="street_lamp"](' + box + ");");
    parts.push('node["man_made"~"^(mast|pole|lighting)$"](' + box + ");");
  }
  return "[out:json][timeout:6];(" + parts.join("") + ");out geom;";
}

function parseMeters(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().toLowerCase();
  if (!s) return 0;
  const ft = s.match(/(-?\d+(?:\.\d+)?)\s*(ft|feet|foot|')/);
  if (ft) return Number(ft[1]) * 0.3048;
  const m = s.match(/(-?\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]);
}

function parseLevels(tags) {
  const n = Number(tags["building:levels"] || tags.levels || tags["parking:levels"]);
  if (!(n >= 1 && n <= 40)) return 0;
  return n;
}

function isClosed(coords) {
  if (!coords || coords.length < 4) return false;
  const a = coords[0];
  const b = coords[coords.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

function wayCoords(el) {
  const geom = el && el.geometry;
  if (!Array.isArray(geom)) return [];
  const out = [];
  for (let i = 0; i < geom.length; i++) {
    const lon = +geom[i].lon;
    const lat = +geom[i].lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    out.push([lon, lat]);
  }
  return out;
}

function inBox(lon, lat, bbox) {
  return lon >= +bbox.west && lon <= +bbox.east && lat >= +bbox.south && lat <= +bbox.north;
}

function anyInBox(coords, bbox) {
  if (!bbox) return true;
  for (let i = 0; i < coords.length; i++) {
    if (inBox(coords[i][0], coords[i][1], bbox)) return true;
  }
  return false;
}

function barrierKind(tags) {
  const b = tags.barrier;
  if (b === "fence") return "fence";
  if (b === "retaining_wall") return "retaining";
  if (b === "hedge") return "hedge";
  if (b === "wall" || b === "city_wall") return "wall";
  return "";
}

function defaultHeight(kind, tags) {
  if (kind === "parking") return 9;
  if (kind === "wall" && tags && tags.barrier === "city_wall") return 6;
  if (kind === "wall") return 2.5;
  if (kind === "fence") return 2.1;
  if (kind === "retaining") return 3;
  if (kind === "hedge") return 2.1;
  if (kind === "pole") return POLE_HEIGHT_M;
  if (kind === "water") return 2.1;
  return 0;
}

function heightFor(kind, tags) {
  const explicit = parseMeters(tags && tags.height);
  if (kind === "parking") {
    if (explicit > 2) return { heightM: explicit, explicitHeight: true };
    const levels = parseLevels(tags || {});
    if (levels) return { heightM: levels * 3, explicitHeight: true };
    return { heightM: 9, explicitHeight: false };
  }
  if (kind === "water") return { heightM: 2.1, explicitHeight: false };
  if (kind === "pole") {
    if (explicit >= 8 && explicit <= 12) return { heightM: explicit, explicitHeight: true };
    return { heightM: POLE_HEIGHT_M, explicitHeight: false };
  }
  if (explicit > 2) return { heightM: explicit, explicitHeight: true };
  return { heightM: defaultHeight(kind, tags), explicitHeight: false };
}

function poleRank(tags) {
  if (tags.highway === "street_lamp") return 0;
  if (tags.man_made === "lighting") return 1;
  if (tags.man_made === "pole") return 2;
  return 3;
}

function isParkingWay(tags) {
  if (!tags) return false;
  if (tags.parking === "underground" || tags.location === "underground") return false;
  if (tags.amenity === "parking" && tags.parking === "multi-storey") return true;
  if (tags.building === "parking") return true;
  return false;
}

function isWaterWay(tags) {
  if (!tags) return false;
  if (tags.natural === "water") return true;
  if (tags.waterway === "riverbank") return true;
  if (tags.landuse === "reservoir") return true;
  if (tags.water && tags.waterway !== "river" && tags.waterway !== "stream" && tags.waterway !== "ditch") return true;
  return false;
}

function isPoleNode(tags) {
  if (!tags) return false;
  if (tags.highway === "street_lamp") return true;
  if (tags.man_made === "mast" || tags.man_made === "pole" || tags.man_made === "lighting") return true;
  return false;
}

function isParkingClass(props) {
  if (!props) return false;
  const raw = String(props.class || props.subtype || props.buildingClass || "").toLowerCase();
  return raw === "parking" || raw === "parking_garage" || raw === "garage";
}

/**
 * Overpass elements to clutter features. `want` drops types the page turned off.
 * `bbox` drops a way that never touches the drawn box.
 */
function parseOverpass(payload, want, bbox) {
  const on = want || { water: true, parking: true, walls: true, poles: true };
  const elements = (payload && payload.elements) || [];
  const features = [];
  let openWater = 0;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tags = (el && el.tags) || {};
    if (el.type === "node" && on.poles && isPoleNode(tags)) {
      const lon = +el.lon;
      const lat = +el.lat;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (bbox && !inBox(lon, lat, bbox)) continue;
      const h = heightFor("pole", tags);
      features.push({
        kind: "pole",
        coords: [[lon, lat]],
        closed: false,
        heightM: h.heightM,
        explicitHeight: h.explicitHeight,
        rank: poleRank(tags),
      });
      continue;
    }
    if (el.type !== "way") continue;
    const coords = wayCoords(el);
    if (coords.length < 2) continue;
    if (bbox && !anyInBox(coords, bbox)) continue;
    if (on.parking && isParkingWay(tags)) {
      if (!isClosed(coords)) continue;
      const h = heightFor("parking", tags);
      features.push({
        kind: "parking",
        coords,
        closed: true,
        heightM: h.heightM,
        explicitHeight: h.explicitHeight,
        rank: 0,
      });
      continue;
    }
    if (on.water && isWaterWay(tags)) {
      if (!isClosed(coords)) {
        openWater++;
        continue;
      }
      const h = heightFor("water", tags);
      features.push({
        kind: "water",
        coords,
        closed: true,
        heightM: h.heightM,
        explicitHeight: false,
        rank: 0,
      });
      continue;
    }
    if (on.walls && barrierKind(tags)) {
      const kind = barrierKind(tags);
      const h = heightFor(kind, tags);
      const line = isClosed(coords) ? coords.slice(0, -1) : coords.slice();
      if (line.length < 2) continue;
      features.push({
        kind,
        coords: line,
        closed: false,
        heightM: h.heightM,
        explicitHeight: h.explicitHeight,
        rank: 0,
      });
    }
  }
  return { features, openWater };
}

function ringAreaAbs(coords) {
  let a = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    a += coords[j][0] * coords[i][1] - coords[i][0] * coords[j][1];
  }
  return Math.abs(a / 2);
}

function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    d += Math.hypot(dx, dy);
  }
  return d;
}

function dedupeKey(coords) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const lon = coords[i][0];
    const lat = coords[i][1];
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat].map((n) => n.toFixed(5)).join(",");
}

function keepLargest(list, cap) {
  const sorted = list.slice().sort((a, b) => ringAreaAbs(b.coords) - ringAreaAbs(a.coords));
  const seen = new Set();
  const out = [];
  for (let i = 0; i < sorted.length && out.length < cap; i++) {
    const key = dedupeKey(sorted[i].coords);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sorted[i]);
  }
  return { kept: out, capped: sorted.length > out.length };
}

function spreadPoles(poles, bbox, cap) {
  const sorted = poles.slice().sort((a, b) => a.rank - b.rank || a.coords[0][0] - b.coords[0][0]);
  if (sorted.length <= cap) return { kept: sorted, capped: false };
  const west = +bbox.west;
  const south = +bbox.south;
  const east = +bbox.east;
  const north = +bbox.north;
  const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
  const rows = Math.max(1, Math.ceil(cap / cols));
  const cw = (east - west) / cols || 1;
  const ch = (north - south) / rows || 1;
  const cells = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const lon = sorted[i].coords[0][0];
    const lat = sorted[i].coords[0][1];
    const c = Math.min(cols - 1, Math.max(0, Math.floor((lon - west) / cw)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((lat - south) / ch)));
    const key = r + "," + c;
    if (!cells.has(key)) cells.set(key, sorted[i]);
  }
  let kept = Array.from(cells.values());
  if (kept.length > cap) kept = kept.slice(0, cap);
  return { kept, capped: true };
}

/** Caps so a downtown lamp grid or a long fence cannot fill the element budget. */
function limitFeatures(features, bbox) {
  const water = [];
  const parking = [];
  const walls = [];
  const poles = [];
  for (let i = 0; i < (features || []).length; i++) {
    const f = features[i];
    if (!f) continue;
    if (f.kind === "water") water.push(f);
    else if (f.kind === "parking") parking.push(f);
    else if (f.kind === "pole") poles.push(f);
    else if (LINE_KINDS[f.kind]) walls.push(f);
  }
  const w = keepLargest(water, WATER_CAP);
  const p = keepLargest(parking, PARKING_CAP);
  const wallSorted = walls.slice().sort((a, b) => lineLength(b.coords) - lineLength(a.coords));
  const wallKept = wallSorted.slice(0, WALL_CAP);
  const pole = spreadPoles(poles, bbox || { west: -180, south: -90, east: 180, north: 90 }, POLE_CAP);
  const notes = [];
  if (w.capped) notes.push("Water capped at " + WATER_CAP + ".");
  if (p.capped) notes.push("Parking capped at " + PARKING_CAP + ".");
  if (wallSorted.length > wallKept.length) notes.push("Walls capped at " + WALL_CAP + ".");
  if (pole.capped) notes.push("Light poles capped at " + POLE_CAP + ".");
  return {
    features: w.kept.concat(p.kept, wallKept, pole.kept),
    notes,
  };
}

async function fetchOutdoorClutter(bbox, want, opts) {
  if (!wantAny(want)) return { ok: true, features: [], notes: [] };
  const timeoutMs = (opts && opts.timeoutMs) || FETCH_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = opts && opts.signal;
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const q = overpassQuery(bbox, want);
    const r = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "user-agent": (opts && opts.ua) || "openclutter",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "data=" + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, features: [], notes: [] };
    const json = await r.json();
    const parsed = parseOverpass(json, want, bbox);
    const limited = limitFeatures(parsed.features, bbox);
    if (parsed.openWater) limited.notes.push("Open water lines were left out.");
    return { ok: true, features: limited.features, notes: limited.notes };
  } catch {
    return { ok: false, features: [], notes: [] };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onAbort);
  }
}

function closePx(ring) {
  if (!ring || ring.length < 3) return ring || [];
  const out = [];
  for (let i = 0; i < ring.length; i++) out.push([ring[i][0], ring[i][1]]);
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out;
}

function lonLatRingToPx(ring, frame) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = llToPx(ring[i][0], ring[i][1], frame);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    out.push(p);
  }
  if (out.length >= 3) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  }
  return out;
}

function ringAreaPx(ring) {
  let a = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

function overlapFraction(aPx, bPx) {
  if (!aPx || !bPx || aPx.length < 4 || bPx.length < 4) return 0;
  const inter = intersectionAreaPx(aPx, bPx);
  const denom = Math.min(ringAreaPx(aPx), ringAreaPx(bPx));
  if (!(denom > 1e-6)) return 0;
  return inter / denom;
}

function thicknessOf(material) {
  if (!material) return 0;
  const top = Number(material.top_height);
  const bottom = Number(material.bottom_height) >= LIFT_LOCAL_M ? Number(material.bottom_height) : 0;
  const t = top - bottom;
  return t > 2 ? Math.round(t * 10) / 10 : 0;
}

function seatBottom(slopeTop, ring) {
  if (!slopeTop || typeof slopeTop.seat !== "function" || !ring || ring.length < 3) return 0;
  const z = Number(slopeTop.seat(ring));
  return z >= LIFT_LOCAL_M ? z : 0;
}

function materialForKind(kind, heightM, lonlatRing, slopeTop, bottomOverride) {
  const base = outdoorMaterial(kind, heightM);
  if (!base) return null;
  const bottom = bottomOverride >= LIFT_LOCAL_M ? bottomOverride : seatBottom(slopeTop, lonlatRing);
  if (bottom >= LIFT_LOCAL_M) return liftedOutdoorMaterial(base, bottom) || base;
  return base;
}

function toMeters(pt, frame) {
  return [pt[0] * frame.mpuX, pt[1] * frame.mpuY];
}

function fromMeters(pt, frame) {
  return [pt[0] / frame.mpuX, pt[1] / frame.mpuY];
}

function subsample(pts, max) {
  if (pts.length <= max) return pts;
  const out = [];
  const last = pts.length - 1;
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * last) / (max - 1));
    const p = pts[idx];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  return out;
}

function segsCross(a, b, c, d) {
  function ccw(p, q, r) {
    return (r[1] - p[1]) * (q[0] - p[0]) > (q[1] - p[1]) * (r[0] - p[0]);
  }
  if (a[0] === c[0] && a[1] === c[1]) return false;
  if (a[0] === d[0] && a[1] === d[1]) return false;
  if (b[0] === c[0] && b[1] === c[1]) return false;
  if (b[0] === d[0] && b[1] === d[1]) return false;
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function selfCross(ring) {
  const open =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  const n = open.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if ((i + 1) % n === j || i === (j + 1) % n) continue;
      const c = open[j];
      const d = open[(j + 1) % n];
      if (segsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function bufferLineMeters(pts, half) {
  const n = pts.length;
  if (n < 2) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    left.push([pts[i][0] - dy * half, pts[i][1] + dx * half]);
    right.push([pts[i][0] + dy * half, pts[i][1] - dx * half]);
  }
  const ring = left.concat(right.reverse());
  ring.push(ring[0]);
  return ring;
}

function segmentQuad(a, b, half) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.4) return null;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  return [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
    [a[0] + nx, a[1] + ny],
  ];
}

function lineRingsPx(coords, frame, halfM) {
  const px = [];
  for (let i = 0; i < coords.length; i++) px.push(llToPx(coords[i][0], coords[i][1], frame));
  const simple = subsample(px, 12);
  const meters = simple.map((p) => toMeters(p, frame));
  const buffered = bufferLineMeters(meters, halfM);
  if (buffered && !selfCross(buffered)) {
    return [buffered.map((p) => fromMeters(p, frame))];
  }
  const quads = [];
  const step = Math.max(1, Math.ceil((meters.length - 1) / 4));
  for (let i = 0; i < meters.length - 1 && quads.length < 4; i += step) {
    const j = Math.min(meters.length - 1, i + step);
    const q = segmentQuad(meters[i], meters[j], halfM);
    if (q) quads.push(q.map((p) => fromMeters(p, frame)));
  }
  return quads;
}

function circlePx(lon, lat, frame) {
  const c = llToPx(lon, lat, frame);
  const rx = POLE_DIAMETER_M / 2 / frame.mpuX;
  const ry = POLE_DIAMETER_M / 2 / frame.mpuY;
  const ring = [];
  for (let i = 0; i < POLE_SIDES; i++) {
    const a = (2 * Math.PI * i) / POLE_SIDES - Math.PI / POLE_SIDES;
    ring.push([c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

function parkingMaterialFor(feat, buildingMat, slopeTop, lonlatRing) {
  const explicit = feat && feat.explicitHeight && feat.heightM > 2 ? feat.heightM : 0;
  const fromBuilding = thicknessOf(buildingMat);
  const h = explicit || fromBuilding || (feat && feat.heightM) || 9;
  const bottom =
    buildingMat && Number(buildingMat.bottom_height) >= LIFT_LOCAL_M
      ? Number(buildingMat.bottom_height)
      : seatBottom(slopeTop, lonlatRing);
  return materialForKind("parking", h, lonlatRing, null, bottom);
}

/**
 * Pixel rings plus a parking recolor of buildings that already cover a garage.
 * A matched garage is not drawn a second time.
 */
function planOutdoor({ features, frame, slopeTop, buildings, parkingRings }) {
  const list = features || [];
  const parkingFeats = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].kind === "parking") parkingFeats.push(list[i]);
  }
  const classRings = parkingRings || [];
  const consumed = new Set();
  const updates = [];
  let reclass = 0;
  for (let b = 0; b < (buildings || []).length; b++) {
    const building = buildings[b];
    if (!building || (!(building.ringPx && building.ringPx.length >= 3) && !(building.ring && building.ring.length >= 3))) continue;
    const bPx = building.ringPx && building.ringPx.length >= 3 ? closePx(building.ringPx) : lonLatRingToPx(building.ring, frame);
    let match = null;
    for (let i = 0; i < parkingFeats.length; i++) {
      const pPx = lonLatRingToPx(parkingFeats[i].coords, frame);
      if (overlapFraction(bPx, pPx) >= 0.4) {
        match = parkingFeats[i];
        break;
      }
    }
    if (!match) {
      for (let i = 0; i < classRings.length; i++) {
        const raw = classRings[i];
        const ring = raw && raw.ring ? raw.ring : raw;
        const pPx = lonLatRingToPx(ring, frame);
        if (overlapFraction(bPx, pPx) >= 0.4) {
          const tagged = raw && Number(raw.heightM) > 2 ? Number(raw.heightM) : 0;
          match = { kind: "parking", heightM: tagged, explicitHeight: tagged > 2, coords: ring };
          break;
        }
      }
    }
    if (!match) continue;
    const mat = parkingMaterialFor(match, building.material, slopeTop, building.ring);
    if (!mat) continue;
    if (match.coords && parkingFeats.indexOf(match) >= 0) consumed.add(match);
    updates.push({ index: building.index, material: mat });
    reclass++;
  }
  const items = [];
  let shortWalls = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f) continue;
    if (f.kind === "parking" && consumed.has(f)) continue;
    if (f.kind === "pole") {
      const lon = f.coords[0][0];
      const lat = f.coords[0][1];
      if (!inBox(lon, lat, frame)) continue;
      const ringPx = circlePx(lon, lat, frame);
      const material = materialForKind("pole", f.heightM, f.coords, slopeTop, 0);
      if (!material) continue;
      items.push({ ringPx, material, kind: "pole", thin: true });
      continue;
    }
    if (LINE_KINDS[f.kind]) {
      if (lineLength(f.coords) * 111000 < 2) {
        shortWalls++;
        continue;
      }
      const rings = lineRingsPx(f.coords, frame, THICK_M[f.kind] / 2);
      const material = materialForKind(f.kind, f.heightM, f.coords, slopeTop, 0);
      if (!material) continue;
      for (let r = 0; r < rings.length; r++) {
        items.push({ ringPx: rings[r], material, kind: f.kind, thin: true });
      }
      continue;
    }
    if (f.kind === "water" || f.kind === "parking") {
      const ringPx = lonLatRingToPx(f.coords, frame);
      const material = materialForKind(f.kind, f.heightM, f.coords, slopeTop, 0);
      if (!material || ringPx.length < 4) continue;
      items.push({ ringPx, material, kind: f.kind, thin: false });
    }
  }
  const notes = [];
  if (shortWalls) notes.push("Short walls were left out.");
  return { items, updates, notes, reclass };
}

const BUDGET_ORDER = ["parking", "water", "wall", "retaining", "hedge", "fence", "pole"];

function budgetNote(kind) {
  if (kind === "pole") return "Light poles left out to stay inside the area budget.";
  if (kind === "water") return "Water left out to stay inside the area budget.";
  if (kind === "parking") return "Parking left out to stay inside the area budget.";
  return "Walls left out to stay inside the area budget.";
}

/** Parking and water stay ahead of poles when the attenuation cap is tight. */
function fitOutdoorBudget(items, kinds, room) {
  const groups = new Map();
  for (let i = 0; i < BUDGET_ORDER.length; i++) groups.set(BUDGET_ORDER[i], []);
  for (let i = 0; i < items.length; i++) {
    const kind = kinds[i] || items[i].kind;
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(items[i]);
  }
  const kept = [];
  const keptKinds = [];
  const notes = [];
  let left = Math.max(0, room | 0);
  const noted = new Set();
  for (let i = 0; i < BUDGET_ORDER.length; i++) {
    const kind = BUDGET_ORDER[i];
    const list = groups.get(kind) || [];
    const take = list.slice(0, left);
    for (let t = 0; t < take.length; t++) {
      kept.push(take[t]);
      keptKinds.push(kind);
    }
    left -= take.length;
    if (list.length > take.length) {
      const note = budgetNote(kind);
      if (!noted.has(note)) {
        noted.add(note);
        notes.push(note);
      }
    }
  }
  return { items: kept, kinds: keptKinds, notes };
}

module.exports = {
  OVERPASS_URL,
  FETCH_MS,
  POLE_CAP,
  WALL_CAP,
  WATER_CAP,
  PARKING_CAP,
  POLE_SIDES,
  POLE_DIAMETER_M,
  POLE_HEIGHT_M,
  THICK_M,
  OUTDOOR_MISS,
  overpassQuery,
  parseOverpass,
  limitFeatures,
  fetchOutdoorClutter,
  isParkingClass,
  planOutdoor,
  fitOutdoorBudget,
};
