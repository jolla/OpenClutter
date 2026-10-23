"use strict";

/**
 * Park context for worst-case pads (1.2.26, /dev hosts with site types).
 *
 * rv-pads.js learns a park's pad pattern (spacing, setback, angle, size)
 * from the RVs it already found and needs six of them before it fills a
 * single pad. Those RVs used to be counted inside the draw only, so a small
 * draw in a big park saw two or three RVs, learned nothing, and drew no pads,
 * while a whole-park draw filled the same ground. The park did not change,
 * only the frame did.
 *
 * When a mapped RV park or campground runs past the draw, this reads the rest
 * of the park: its internal roads and pitches from a second street-map read
 * over the park, and its RVs from a second photo at the draw's own scale
 * (capped in size), with the same detectors the draw uses. What it finds is
 * evidence for the pad pattern, plus the park roads the draw did not fetch so
 * pads keep clear of them. Nothing here is drawn, and every pad still needs
 * open ground on the draw's own photo.
 */

const vt = require("./vehicle-track");
const { geoFrame, capEsriExportFrame } = require("./geo-frame");

/** Context photo is at most this many pixels on its long side. */
const CTX_MAX_SIDE_PX = 2400;
/** And covers at most this much ground on a side, metres. */
const CTX_MAX_M = 1500;
/** Read context only when this share of a park's outline box is outside the draw. */
const CTX_MIN_OUTSIDE = 0.15;
/** Candidate pads read on the context photo. */
const CTX_CANDIDATE_CAP = 1500;

function boxOf(coords) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const c of coords || []) {
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    if (c[0] < w) w = c[0];
    if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1];
    if (c[1] > n) n = c[1];
  }
  return Number.isFinite(w) && e > w && n > s ? { west: w, south: s, east: e, north: n } : null;
}

function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.east, b.east) - Math.max(a.west, b.west));
  const h = Math.max(0, Math.min(a.north, b.north) - Math.max(a.south, b.south));
  return w * h;
}

function inBox(p, b) {
  return p && p[0] >= b.west && p[0] <= b.east && p[1] >= b.south && p[1] <= b.north;
}

function mPerDeg(lat) {
  return { lon: 111320 * Math.cos((lat * Math.PI) / 180), lat: 110540 };
}

/**
 * The ground to read: the draw plus every park outline that runs past it,
 * held to CTX_MAX_M a side around the draw. Null when every park sits inside
 * the draw (nothing to learn that the draw cannot see).
 */
function contextBox(features, frame) {
  if (!frame) return null;
  const draw = { west: +frame.west, south: +frame.south, east: +frame.east, north: +frame.north };
  let box = null;
  for (const f of features || []) {
    if (!f || f.kind !== "camp-zone" || f.tentOnly) continue;
    const z = boxOf(f.coords);
    if (!z) continue;
    const area = (z.east - z.west) * (z.north - z.south);
    if (!(area > 0) || overlapArea(z, draw) <= 0) continue;
    if (1 - overlapArea(z, draw) / area < CTX_MIN_OUTSIDE) continue;
    box = box
      ? { west: Math.min(box.west, z.west), south: Math.min(box.south, z.south), east: Math.max(box.east, z.east), north: Math.max(box.north, z.north) }
      : z;
  }
  if (!box) return null;
  box = { west: Math.min(box.west, draw.west), south: Math.min(box.south, draw.south), east: Math.max(box.east, draw.east), north: Math.max(box.north, draw.north) };
  const cLon = (draw.west + draw.east) / 2;
  const cLat = (draw.south + draw.north) / 2;
  const m = mPerDeg(cLat);
  const halfLon = Math.max(CTX_MAX_M / 2 / m.lon, (draw.east - draw.west) / 2);
  const halfLat = Math.max(CTX_MAX_M / 2 / m.lat, (draw.north - draw.south) / 2);
  return {
    west: Math.max(box.west, cLon - halfLon),
    east: Math.min(box.east, cLon + halfLon),
    south: Math.max(box.south, cLat - halfLat),
    north: Math.min(box.north, cLat + halfLat),
  };
}

/**
 * Mapped pitches and road-side pad strips across the whole park, inside the
 * draw too, so the pattern comes from one read of the park whatever part of
 * it the draw covers.
 */
function contextCandidates(features, frame, box) {
  const out = [];
  for (const f of features || []) {
    if (!f || (f.kind !== "rv" && f.kind !== "trailer-candidate")) continue;
    const ring = f.pad && f.pad.length >= 3 ? f.pad : f.coords;
    const c = vt.centroidLL(ring);
    if (!c || !inBox(c, box)) continue;
    out.push(f);
    if (out.length >= CTX_CANDIDATE_CAP) break;
  }
  return out;
}

/** Frame for the context photo, at the draw's scale or coarser to fit the cap. */
function contextFrame(box, frame) {
  const mpu = Math.max(frame.mpuX || 0, frame.mpuY || 0, 0.1);
  return capEsriExportFrame(geoFrame(box, { metersPerPx: mpu, maxSide: CTX_MAX_SIDE_PX, maxSpanM: CTX_MAX_M * 2, minSpanM: 1 }));
}

/**
 * RVs the context photo shows, as "rv-context" evidence features. The same
 * vehicle pass the draw runs (pitches and road-side roofs), on the context
 * frame and photo.
 */
function contextEvidence(candidates, ctxFrame, plate) {
  if (!candidates.length || !ctxFrame || !plate || !(plate.width > 1)) return [];
  const found = vt.finalizeVehicles(
    candidates,
    (ring) => vt.pitchVehicle(ring, ctxFrame, plate),
    (ring) => vt.roadsideVehicles(ring, ctxFrame, plate, [])
  );
  const out = [];
  for (const f of found) {
    if (!f || (f.kind !== "rv" && f.kind !== "trailer") || !f.coords || f.coords.length < 4) continue;
    out.push({ kind: "rv-context", coords: f.coords, closed: true, heightM: 0, explicitHeight: false, rank: 0 });
  }
  return out;
}

function roadKey(coords) {
  return (coords || []).map((c) => c[0].toFixed(7) + "," + c[1].toFixed(7)).join(";");
}

/**
 * Park roads from the context read that the draw's own read did not return,
 * kept as camp roads so the pad pattern can vote on them and pads keep
 * clear of them.
 */
function contextRoads(features, ctxFeatures) {
  const have = new Set();
  for (const f of features || []) if (f && f.kind === "camp-road") have.add(roadKey(f.coords));
  const out = [];
  for (const f of ctxFeatures || []) {
    if (!f || f.kind !== "camp-road" || !f.coords || f.coords.length < 2) continue;
    const k = roadKey(f.coords);
    if (have.has(k)) continue;
    have.add(k);
    out.push(Object.assign({}, f, { parkContext: true }));
  }
  return out;
}

/**
 * Read the rest of every park that runs past the draw.
 * @param {object} o
 * @param {Array} o.features the draw's outdoor features (camp-zone, rv candidates)
 * @param {object} o.frame the draw's frame
 * @param {Array} [o.ctxFeatures] outdoor features read over the context box
 * @param {function} o.fetchPlate async (frame) => JPEG buffer
 * @param {function} [o.placePlate] (frame, buf) => {frame, buf} with the photo's real extent
 * @returns {Promise<{features: Array, roads: number, frame: object|null, candidates: number}>}
 */
async function readParkContext(o) {
  const empty = { features: [], roads: 0, frame: null, candidates: 0 };
  const box = contextBox(o.features, o.frame);
  if (!box) return empty;
  const source = o.ctxFeatures && o.ctxFeatures.length ? o.ctxFeatures : o.features;
  const roads = o.ctxFeatures ? contextRoads(o.features, o.ctxFeatures) : [];
  const candidates = contextCandidates(source, o.frame, box);
  if (!candidates.length) return Object.assign({}, empty, { features: roads, roads: roads.length });
  let ctxFrame;
  try {
    ctxFrame = contextFrame(box, o.frame);
  } catch {
    return Object.assign({}, empty, { features: roads, roads: roads.length });
  }
  let plate = null;
  let photo = "";
  try {
    const buf = await o.fetchPlate(ctxFrame);
    // The photo's real extent and scale, the same way the draw's map is
    // placed (an Esri export pads a degree-square image past the asked box).
    if (o.placePlate) {
      const placed = o.placePlate(ctxFrame, buf);
      ctxFrame = placed.frame;
      plate = vt.decodePlate(placed.buf);
    } else {
      plate = vt.decodePlate(buf);
    }
    if (!plate) photo = "undecodable";
  } catch (err) {
    photo = String((err && err.message) || err).slice(0, 80);
  }
  const rvs = plate ? contextEvidence(candidates, ctxFrame, plate) : [];
  const out = { features: roads.concat(rvs), roads: roads.length, rvs: rvs.length, frame: ctxFrame, candidates: candidates.length };
  if (photo) out.photoMiss = photo;
  return out;
}

module.exports = {
  CTX_MAX_SIDE_PX,
  CTX_MAX_M,
  CTX_MIN_OUTSIDE,
  contextBox,
  contextCandidates,
  contextFrame,
  contextEvidence,
  contextRoads,
  readParkContext,
};
