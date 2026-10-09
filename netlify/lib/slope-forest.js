"use strict";

/**
 * Woods and ski runs for a slope export.
 * A hill-sized natural=wood ring is not one attenuation area. The caller
 * cuts it on the terrain mesh and seats each piece on local ground.
 * piste:type=downhill is open ground. landuse=winter_sports is a run only
 * when it is smaller than the resort; the lease polygon would erase the woods.
 */

const polygonClipping = require("polygon-clipping");

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const PISTE_HALF_M = 28;
const WOOD_MIN_M2 = 800;
const WOOD_CAP = 24;
const PISTE_CAP = 80;
const RESORT_FRACTION = 0.4;

function bboxBox(bbox) {
  return +bbox.south + "," + +bbox.west + "," + +bbox.north + "," + +bbox.east;
}

function bboxAreaM2(bbox) {
  const mid = ((+bbox.south) + (+bbox.north)) / 2;
  const mLon = 111320 * Math.cos((mid * Math.PI) / 180);
  const width = Math.abs(+bbox.east - +bbox.west) * mLon;
  const height = Math.abs(+bbox.north - +bbox.south) * 110540;
  return width * height;
}

function queryFor(bbox) {
  const box = bboxBox(bbox);
  const parts = [
    'way["piste:type"="downhill"](' + box + ");",
    'way["landuse"="winter_sports"](' + box + ");",
    'way["natural"="wood"](' + box + ");",
    'way["landuse"="forest"](' + box + ");",
    'relation["piste:type"="downhill"](' + box + ");",
    'relation["landuse"="winter_sports"](' + box + ");",
    'relation["natural"="wood"](' + box + ");",
    'relation["landuse"="forest"](' + box + ");",
  ];
  return "[out:json][timeout:25];(" + parts.join("") + ");out geom;";
}

function coordsOf(geom) {
  const out = [];
  for (let i = 0; i < (geom || []).length; i++) {
    const p = geom[i];
    const lon = +(p.lon != null ? p.lon : p[0]);
    const lat = +(p.lat != null ? p.lat : p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    out.push([lon, lat]);
  }
  return out;
}

function near(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

function isClosed(coords) {
  return coords.length >= 4 && near(coords[0], coords[coords.length - 1]);
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat = ring[0][1];
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mLat = 110540;
  const n = near(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * mLon * (q[1] * mLat) - q[0] * mLon * (p[1] * mLat);
  }
  return Math.abs(a) / 2;
}

function stitchLines(lines) {
  const unused = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] && lines[i].length >= 2) unused.push(lines[i].slice());
  }
  const rings = [];
  while (unused.length) {
    let cur = unused.pop();
    if (isClosed(cur)) {
      rings.push(cur);
      continue;
    }
    let guard = 0;
    while (guard++ < 80) {
      const end = cur[cur.length - 1];
      let found = -1;
      let flip = false;
      for (let i = 0; i < unused.length; i++) {
        if (near(unused[i][0], end)) {
          found = i;
          break;
        }
        if (near(unused[i][unused[i].length - 1], end)) {
          found = i;
          flip = true;
          break;
        }
      }
      if (found < 0) break;
      const next = unused.splice(found, 1)[0];
      if (flip) next.reverse();
      cur = cur.concat(next.slice(1));
      if (isClosed(cur)) {
        rings.push(cur);
        cur = null;
        break;
      }
    }
  }
  return rings;
}

function ringsFromMembers(members) {
  const outers = [];
  const inners = [];
  const openOuter = [];
  for (let i = 0; i < (members || []).length; i++) {
    const m = members[i];
    if (!m || m.type === "node") continue;
    const coords = coordsOf(m.geometry);
    if (coords.length < 2) continue;
    const role = m.role === "inner" ? "inner" : "outer";
    if (isClosed(coords)) {
      if (role === "inner") inners.push(coords);
      else outers.push(coords);
    } else if (role !== "inner") openOuter.push(coords);
  }
  return { outers: outers.concat(stitchLines(openOuter)), inners };
}

function cutInners(outers, inners) {
  if (!inners || !inners.length) return outers;
  const out = [];
  for (let i = 0; i < outers.length; i++) {
    let geom = [[outers[i]]];
    for (let k = 0; k < inners.length; k++) {
      try {
        geom = polygonClipping.difference(geom, [[inners[k]]]);
      } catch {
        geom = [];
        break;
      }
    }
    for (let p = 0; p < (geom || []).length; p++) {
      const ring = geom[p] && geom[p][0];
      if (ring && ring.length >= 4) out.push(ring);
    }
  }
  return out;
}

function heightOf(tags) {
  const raw = tags && (tags.height || tags.est_height);
  const n = parseFloat(raw);
  if (n > 2 && n < 60) return Math.round(n * 10) / 10;
  return 12;
}

function kindOf(tags) {
  if (!tags) return "";
  if (tags["piste:type"] === "downhill") return "piste";
  if (tags.landuse === "winter_sports") return "winter";
  if (tags.natural === "wood" || tags.landuse === "forest") return "wood";
  return "";
}

function bufferCenterline(coords, halfM) {
  if (!coords || coords.length < 2) return null;
  const lat = coords[0][1];
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mLat = 110540;
  const pts = coords.map((p) => [p[0] * mLon, p[1] * mLat]);
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    left.push([pts[i][0] - dy * halfM, pts[i][1] + dx * halfM]);
    right.push([pts[i][0] + dy * halfM, pts[i][1] - dx * halfM]);
  }
  const ring = left.concat(right.reverse());
  const ll = ring.map((p) => [p[0] / mLon, p[1] / mLat]);
  ll.push(ll[0]);
  return ll;
}

/**
 * @returns {{ok:boolean, wood:object[], pistes:number[][][], notes:string[]}}
 */
function forestFromElements(json, bbox) {
  const wood = [];
  const pistes = [];
  const notes = [];
  const site = bboxAreaM2(bbox);
  const elements = (json && json.elements) || [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el) continue;
    const tags = el.tags || {};
    const kind = kindOf(tags);
    if (!kind) continue;
    let outers = [];
    let lines = [];
    if (el.type === "way") {
      const coords = coordsOf(el.geometry);
      if (isClosed(coords)) outers = [coords];
      else if (coords.length >= 2) lines = [coords];
    } else if (el.type === "relation") {
      const parts = ringsFromMembers(el.members);
      outers = cutInners(parts.outers, parts.inners);
    }
    if (kind === "wood") {
      for (let r = 0; r < outers.length; r++) {
        const area = ringAreaM2(outers[r]);
        if (area < WOOD_MIN_M2) continue;
        wood.push({ ringLonLat: outers[r], heightM: heightOf(tags), areaM2: Math.round(area) });
      }
      continue;
    }
    for (let r = 0; r < outers.length; r++) {
      const area = ringAreaM2(outers[r]);
      if (kind === "winter" && site > 0 && area > site * RESORT_FRACTION) {
        const note = "The winter-sports lease stays out of the canopy mask so the woods remain.";
        if (notes.indexOf(note) < 0) notes.push(note);
        continue;
      }
      if (area < 200) continue;
      pistes.push(outers[r]);
    }
    for (let r = 0; r < lines.length; r++) {
      const buf = bufferCenterline(lines[r], PISTE_HALF_M);
      if (buf && ringAreaM2(buf) >= 200) pistes.push(buf);
    }
  }
  wood.sort((a, b) => b.areaM2 - a.areaM2);
  const keptWood = wood.slice(0, WOOD_CAP);
  const keptPistes = pistes.slice(0, PISTE_CAP);
  return { ok: true, wood: keptWood, pistes: keptPistes, notes };
}

async function fetchSlopeForest(bbox, opts) {
  const timeoutMs = (opts && opts.timeoutMs) > 0 ? opts.timeoutMs : 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = opts && opts.signal;
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const ua = (opts && opts.ua) || "openclutter";
  const q = queryFor(bbox);
  try {
    let last = null;
    for (let i = 0; i < OVERPASS_URLS.length; i++) {
      if (ctrl.signal.aborted) return { ok: false, wood: [], pistes: [], notes: [] };
      try {
        const r = await fetch(OVERPASS_URLS[i], {
          method: "POST",
          headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q),
          signal: ctrl.signal,
        });
        if (!r.ok) {
          last = r.status;
          continue;
        }
        const json = await r.json();
        return forestFromElements(json, bbox);
      } catch (e) {
        last = e;
        if (ctrl.signal.aborted) break;
      }
    }
    void last;
    return { ok: false, wood: [], pistes: [], notes: [] };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onAbort);
  }
}

module.exports = {
  PISTE_HALF_M,
  WOOD_MIN_M2,
  RESORT_FRACTION,
  forestFromElements,
  fetchSlopeForest,
  bufferCenterline,
  ringAreaM2,
};
