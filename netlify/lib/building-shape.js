"use strict";

/**
 * Building outlines for Hamina.
 *
 * Overture and OSM `building=*` ways are often one complex: the ring runs
 * around towers, the podium, and the open pool deck. OpenIntent has no hole
 * ring, so a courtyard has to be a gap in the outline. A `building:part`
 * keeps its own height and min_height. A parent that still covers a pool
 * after that cut is dropped when a part already describes the building.
 *
 * Simplification stays near a metre. A convex hull that fills the courtyard
 * is not a candidate.
 */

const polygonClipping = require("polygon-clipping");

const OVERPASS_URLS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const MIN_PIECE_M2 = 25;
const CORRIDOR_M = 8;
const PART_COVER = 0.75;

function buildingDetailQuery(bbox) {
  const box = [+bbox.south, +bbox.west, +bbox.north, +bbox.east].join(",");
  return (
    "[out:json][timeout:12];(" +
    'way["building:part"](' + box + ");" +
    'way["leisure"="swimming_pool"](' + box + ");" +
    'way["natural"="water"](' + box + ");" +
    'way["water"](' + box + ");" +
    'way["landuse"="reservoir"](' + box + ");" +
    'relation["building:part"](' + box + ");" +
    'relation["type"="multipolygon"]["building"](' + box + ");" +
    ");out geom;"
  );
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

function closeRing(ring) {
  if (!ring || ring.length < 3) return null;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const x = +ring[i][0];
    const y = +ring[i][1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - x) < 1e-12 && Math.abs(prev[1] - y) < 1e-12) continue;
    out.push([x, y]);
  }
  if (out.length < 3) return null;
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}

function wayCoords(el) {
  const geom = el && el.geometry;
  if (!Array.isArray(geom)) return [];
  const out = [];
  for (let i = 0; i < geom.length; i++) {
    const lon = +geom[i].lon;
    const lat = +geom[i].lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push([lon, lat]);
  }
  return closeRing(out);
}

function memberRings(el, role) {
  const members = (el && el.members) || [];
  const rings = [];
  for (let i = 0; i < members.length; i++) {
    const mem = members[i];
    if (role && mem.role && mem.role !== role) continue;
    if (role && !mem.role) continue;
    const ring = wayCoords(mem);
    if (ring) rings.push(ring);
  }
  return rings;
}

function heightTags(tags) {
  const top = parseMeters(tags.height || tags["building:height"]);
  let minH = parseMeters(tags.min_height || tags["building:min_height"]);
  const levels = Number(tags["building:levels"] || tags.levels);
  let height = top;
  if (!(height > 2) && levels >= 1 && levels <= 80) height = levels * 3;
  if (!(height > 2 && height < 400)) height = 0;
  if (!(minH > 0 && minH < 400)) minH = 0;
  if (height && minH >= height) minH = 0;
  return { height, minH };
}

function isOpeningTags(tags) {
  if (!tags) return false;
  if (tags.leisure === "swimming_pool") return true;
  if (tags.natural === "water") return true;
  if (tags.landuse === "reservoir") return true;
  if (tags.water && tags.waterway !== "river" && tags.waterway !== "stream" && tags.waterway !== "ditch") return true;
  return false;
}

function partFeature(rings, tags) {
  const exterior = rings[0];
  if (!exterior) return null;
  const holes = [];
  for (let i = 1; i < rings.length; i++) {
    const c = centroidLL(rings[i]);
    if (c && pointInRingLL(c, exterior)) holes.push(rings[i]);
  }
  const h = heightTags(tags || {});
  const properties = { geomSource: "osm-part", buildingPart: true };
  if (h.height) {
    properties.height = Math.round(h.height * 10) / 10;
    properties.heightSource = "osm";
  }
  if (h.minH > 0) properties.levelBaseM = Math.round(h.minH * 10) / 10;
  const name = tags && (tags.name || tags["building:part"]);
  if (name && name !== "yes") properties.partName = String(name).slice(0, 80);
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [exterior].concat(holes) },
  };
}

/**
 * OSM building:part ways and relations become footprints. Pools, water, and
 * multipolygon inner rings become openings. A `building=*` outer is not a
 * new footprint: Overture already has that complex outline.
 */
function parseBuildingDetail(payload, bbox) {
  const elements = (payload && payload.elements) || [];
  const parts = [];
  const openings = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tags = (el && el.tags) || {};
    if (el.type === "way") {
      const ring = wayCoords(el);
      if (!ring) continue;
      if (bbox && !ringHitsBox(ring, bbox)) continue;
      if (tags["building:part"]) {
        const feature = partFeature([ring], tags);
        if (feature) parts.push(feature);
        continue;
      }
      if (isOpeningTags(tags)) openings.push(ring);
      continue;
    }
    if (el.type !== "relation") continue;
    const outers = memberRings(el, "outer");
    const inners = memberRings(el, "inner");
    if (tags["building:part"]) {
      for (let o = 0; o < outers.length; o++) {
        const feature = partFeature([outers[o]].concat(inners), tags);
        if (feature && (!bbox || ringHitsBox(outers[o], bbox))) parts.push(feature);
      }
      continue;
    }
    if (isOpeningTags(tags)) {
      for (let o = 0; o < outers.length; o++) {
        if (!bbox || ringHitsBox(outers[o], bbox)) openings.push(outers[o]);
      }
      continue;
    }
    if (tags.building) {
      for (let n = 0; n < inners.length; n++) {
        if (!bbox || ringHitsBox(inners[n], bbox)) openings.push(inners[n]);
      }
    }
  }
  return { parts, openings };
}

function ringHitsBox(ring, bbox) {
  for (let i = 0; i < ring.length; i++) {
    const lon = ring[i][0];
    const lat = ring[i][1];
    if (lon >= +bbox.west && lon <= +bbox.east && lat >= +bbox.south && lat <= +bbox.north) return true;
  }
  return false;
}

const OSM_MAP_URL = "https://www.openstreetmap.org/api/0.6/map";

function xmlAttr(tag, name) {
  const m = new RegExp("\\s" + name + '="([^"]*)"').exec(tag);
  return m ? m[1] : "";
}

function xmlTags(fragment) {
  const tags = {};
  const re = /<tag k="([^"]*)" v="([^"]*)"\s*\/>/g;
  let m;
  while ((m = re.exec(fragment))) {
    tags[m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")] = m[2]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }
  return tags;
}

function nearPt(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

function stitchChains(parts) {
  const unused = parts.map((p) => p.slice());
  const chains = [];
  while (unused.length) {
    let chain = unused.pop();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < unused.length; i++) {
        const w = unused[i];
        const a = chain[0];
        const b = chain[chain.length - 1];
        const c = w[0];
        const d = w[w.length - 1];
        if (nearPt(b, c)) chain = chain.concat(w.slice(1));
        else if (nearPt(b, d)) chain = chain.concat(w.slice(0, -1).reverse());
        else if (nearPt(a, d)) chain = w.slice(0, -1).concat(chain);
        else if (nearPt(a, c)) chain = w.slice().reverse().slice(0, -1).concat(chain);
        else continue;
        unused.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

function refsToPts(refs, nodes) {
  const pts = [];
  for (let i = 0; i < refs.length; i++) {
    const node = nodes.get(refs[i]);
    if (!node) continue;
    const prev = pts[pts.length - 1];
    if (prev && prev[0] === node.lon && prev[1] === node.lat) continue;
    pts.push([node.lon, node.lat]);
  }
  return pts;
}

function closedFromPts(pts) {
  if (!pts || pts.length < 4) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (Math.abs(a[0] - b[0]) > 1e-7 || Math.abs(a[1] - b[1]) > 1e-7) return null;
  return closeRing(pts);
}

/**
 * The map extract is one request for the drawn box. Overpass is the fallback
 * when that extract is missing. Only parts, pools, water, and courtyard
 * inners are kept. A plain building outer is not a new footprint.
 */
function detailFromMapXml(xml, bbox) {
  const text = String(xml || "");
  const nodes = new Map();
  const ways = new Map();
  const relations = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<node ", lt)) {
      const end = text.indexOf(">", lt);
      const open = end > lt ? text.slice(lt, end + 1) : "";
      const id = xmlAttr(open, "id");
      const lat = +xmlAttr(open, "lat");
      const lon = +xmlAttr(open, "lon");
      if (open.endsWith("/>")) {
        if (id) nodes.set(id, { lon, lat });
        i = lt + open.length;
        continue;
      }
      const close = text.indexOf("</node>", lt);
      if (id && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, { lon, lat });
      i = close > lt ? close + 7 : lt + 1;
      continue;
    }
    if (text.startsWith("<way ", lt)) {
      const close = text.indexOf("</way>", lt);
      if (close < 0) break;
      const body = text.slice(lt, close);
      const id = xmlAttr(body.slice(0, body.indexOf(">") + 1), "id");
      const refs = [];
      const nd = /<nd ref="(\d+)"\s*\/>/g;
      let m;
      while ((m = nd.exec(body))) refs.push(m[1]);
      if (id) ways.set(id, { refs, tags: xmlTags(body) });
      i = close + 6;
      continue;
    }
    if (text.startsWith("<relation ", lt)) {
      const close = text.indexOf("</relation>", lt);
      if (close < 0) break;
      const body = text.slice(lt, close);
      const members = [];
      const mem = /<member type="([^"]+)" ref="(\d+)" role="([^"]*)"\s*\/>/g;
      let m;
      while ((m = mem.exec(body))) members.push({ type: m[1], ref: m[2], role: m[3] });
      relations.push({ members, tags: xmlTags(body) });
      i = close + 11;
      continue;
    }
    i = lt + 1;
  }
  const inRelation = new Set();
  for (let r = 0; r < relations.length; r++) {
    const tags = relations[r].tags || {};
    const members = relations[r].members || [];
    const partOrOpening = !!(tags["building:part"] || isOpeningTags(tags));
    const building = !!tags.building && !tags["building:part"];
    if (!partOrOpening && !building) continue;
    for (let m = 0; m < members.length; m++) {
      if (members[m].type !== "way") continue;
      if (building && members[m].role !== "inner") continue;
      inRelation.add(members[m].ref);
    }
  }
  const elements = [];
  for (const [id, way] of ways) {
    if (inRelation.has(id)) continue;
    const pts = refsToPts(way.refs, nodes);
    const ring = closedFromPts(pts);
    if (!ring) continue;
    const geometry = ring.map((p) => ({ lon: p[0], lat: p[1] }));
    elements.push({ type: "way", tags: way.tags, geometry });
  }
  for (let r = 0; r < relations.length; r++) {
    const rel = relations[r];
    const tags = rel.tags || {};
    const want =
      tags["building:part"] ||
      tags.building ||
      isOpeningTags(tags);
    if (!want) continue;
    const grouped = { outer: [], inner: [] };
    for (let m = 0; m < rel.members.length; m++) {
      const member = rel.members[m];
      if (member.type !== "way") continue;
      const role = member.role === "inner" ? "inner" : member.role === "outer" ? "outer" : "";
      if (!role) continue;
      const way = ways.get(member.ref);
      if (!way) continue;
      const pts = refsToPts(way.refs, nodes);
      if (pts.length >= 2) grouped[role].push(pts);
    }
    const members = [];
    for (const role of ["outer", "inner"]) {
      const chains = stitchChains(grouped[role]);
      for (let c = 0; c < chains.length; c++) {
        const ring = closedFromPts(chains[c]);
        if (!ring) continue;
        members.push({
          type: "way",
          role,
          geometry: ring.map((p) => ({ lon: p[0], lat: p[1] })),
        });
      }
    }
    if (members.length) elements.push({ type: "relation", tags, members });
  }
  return parseBuildingDetail({ elements }, bbox);
}

async function fetchBuildingDetail(bbox, opts) {
  const empty = { ok: false, parts: [], openings: [] };
  if (!bbox) return empty;
  const timeoutMs = (opts && opts.timeoutMs) || 4500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = opts && opts.signal;
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const ua = (opts && opts.ua) || "openclutter";
  const q = buildingDetailQuery(bbox);
  try {
    if (!ctrl.signal.aborted) {
      try {
        const mapUrl =
          OSM_MAP_URL +
          "?bbox=" +
          [bbox.west, bbox.south, bbox.east, bbox.north].map((n) => +n).join(",");
        const r = await fetch(mapUrl, {
          headers: { "user-agent": ua, accept: "application/xml,text/xml,*/*" },
          signal: ctrl.signal,
        });
        if (r.ok) {
          const xml = await r.text();
          if (xml && xml.indexOf("<osm") >= 0) {
            const parsed = detailFromMapXml(xml, bbox);
            return { ok: true, parts: parsed.parts, openings: parsed.openings };
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return empty;
      }
    }
    for (let u = 0; u < OVERPASS_URLS.length; u++) {
      if (ctrl.signal.aborted) return empty;
      try {
        const r = await fetch(OVERPASS_URLS[u], {
          method: "POST",
          headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q),
          signal: ctrl.signal,
        });
        if (!r.ok) continue;
        const json = await r.json();
        const parsed = parseBuildingDetail(json, bbox);
        return { ok: true, parts: parsed.parts, openings: parsed.openings };
      } catch (e) {
        if (ctrl.signal.aborted) return empty;
      }
    }
    return empty;
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onAbort);
  }
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function centroidLL(ring) {
  if (!ring || ring.length < 3) return null;
  const end =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  if (end < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < end; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / end, sy / end];
}

function pointInRingLL(pt, ring) {
  if (!pt || !ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonGroups(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function projectionFor(rings) {
  let lat = 0;
  let n = 0;
  let lon0 = 0;
  let lat0 = 0;
  let seeded = false;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r] || [];
    for (let i = 0; i < ring.length; i++) {
      const x = +ring[i][0];
      const y = +ring[i][1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!seeded) {
        lon0 = x;
        lat0 = y;
        seeded = true;
      }
      lat += y;
      n++;
    }
  }
  const mean = n ? lat / n : 0;
  return { mx: 111320 * Math.max(0.2, Math.cos((mean * Math.PI) / 180)), my: 110540, lon0, lat0 };
}

function toMeters(ring, proj) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    out.push([(ring[i][0] - proj.lon0) * proj.mx, (ring[i][1] - proj.lat0) * proj.my]);
  }
  return closeRing(out);
}

function toLonLat(ring, proj) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    out.push([ring[i][0] / proj.mx + proj.lon0, ring[i][1] / proj.my + proj.lat0]);
  }
  return closeRing(out);
}

function orient(ring, positive) {
  const closed = closeRing(ring);
  if (!closed) return null;
  const area = signedArea(closed);
  if (positive && area < 0) closed.reverse();
  if (!positive && area > 0) closed.reverse();
  const a = closed[0];
  const b = closed[closed.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) closed.push([a[0], a[1]]);
  return closed;
}

function boundsOf(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0];
    const y = ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function halfPlanes(bounds, at, vertical) {
  const pad = 30;
  const minX = bounds.minX - pad;
  const minY = bounds.minY - pad;
  const maxX = bounds.maxX + pad;
  const maxY = bounds.maxY + pad;
  if (vertical) {
    return [
      [[minX, minY], [at, minY], [at, maxY], [minX, maxY], [minX, minY]],
      [[at, minY], [maxX, minY], [maxX, maxY], [at, maxY], [at, minY]],
    ];
  }
  return [
    [[minX, minY], [maxX, minY], [maxX, at], [minX, at], [minX, minY]],
    [[minX, at], [maxX, at], [maxX, maxY], [minX, maxY], [minX, at]],
  ];
}

function corridorQuad(outer, hole) {
  const o = outer.slice(0, -1);
  const h = hole.slice(0, -1);
  let best = Infinity;
  let pair = null;
  const oStep = Math.max(1, Math.ceil(o.length / 16));
  const hStep = Math.max(1, Math.ceil(h.length / 16));
  for (let i = 0; i < o.length; i += oStep) {
    for (let j = 0; j < h.length; j += hStep) {
      const dx = o[i][0] - h[j][0];
      const dy = o[i][1] - h[j][1];
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        pair = [h[j], o[i]];
      }
    }
  }
  if (!pair) return null;
  const hp = pair[0];
  const op = pair[1];
  let dx = op[0] - hp[0];
  let dy = op[1] - hp[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const half = CORRIDOR_M / 2;
  const start = [hp[0] - ux * half, hp[1] - uy * half];
  const end = [op[0] + ux * half, op[1] + uy * half];
  const px = -uy * half;
  const py = ux * half;
  return [
    [start[0] + px, start[1] + py],
    [end[0] + px, end[1] + py],
    [end[0] - px, end[1] - py],
    [start[0] - px, start[1] - py],
    [start[0] + px, start[1] + py],
  ];
}

function explodePoly(poly, depth) {
  if (!poly || !poly[0] || poly[0].length < 4) return [];
  if (poly.length === 1) return [poly[0]];
  if (depth > 5) {
    const opened = openWithCorridor([poly]);
    return opened.length ? opened : [poly[0]];
  }
  const hole = poly[1];
  const c = centroidLL(hole);
  if (!c) return openWithCorridor([poly]);
  const bb = boundsOf(poly[0]);
  const vertical = bb.maxX - bb.minX >= bb.maxY - bb.minY;
  const planes = halfPlanes(bb, vertical ? c[0] : c[1], vertical);
  const out = [];
  for (let p = 0; p < planes.length; p++) {
    let cut;
    try {
      cut = polygonClipping.intersection([poly], [[planes[p]]]);
    } catch {
      cut = null;
    }
    for (let i = 0; i < (cut || []).length; i++) {
      const pieces = explodePoly(cut[i], depth + 1);
      for (let k = 0; k < pieces.length; k++) out.push(pieces[k]);
    }
  }
  return out.length ? out : openWithCorridor([poly]);
}

function openWithCorridor(multi) {
  const pending = (multi || []).slice();
  const simples = [];
  let guard = 0;
  while (pending.length && guard++ < 40) {
    const poly = pending.pop();
    if (!poly || !poly[0] || poly[0].length < 4) continue;
    if (poly.length === 1) {
      simples.push(poly[0]);
      continue;
    }
    const corridor = corridorQuad(poly[0], poly[1]);
    if (!corridor) continue;
    let opened;
    try {
      opened = polygonClipping.difference([poly], [[corridor]]);
    } catch {
      continue;
    }
    let holes = 0;
    for (let i = 0; i < (opened || []).length; i++) holes += Math.max(0, opened[i].length - 1);
    if (holes >= poly.length - 1) continue;
    for (let i = 0; i < (opened || []).length; i++) pending.push(opened[i]);
  }
  return simples;
}

function subtractHolesLL(exterior, holes) {
  const ext = closeRing(exterior);
  const cuts = [];
  for (let i = 0; i < (holes || []).length; i++) {
    const h = closeRing(holes[i]);
    if (h) cuts.push(h);
  }
  if (!ext || !cuts.length) return ext ? [ext] : [];
  const proj = projectionFor([ext].concat(cuts));
  const extM = orient(toMeters(ext, proj), true);
  if (!extM) return [ext];
  const holeMs = [];
  for (let i = 0; i < cuts.length; i++) {
    const hm = orient(toMeters(cuts[i], proj), true);
    if (hm && Math.abs(signedArea(hm)) >= MIN_PIECE_M2) holeMs.push(hm);
  }
  if (!holeMs.length) return [ext];
  let geom = [[extM]];
  for (let i = 0; i < holeMs.length; i++) {
    try {
      geom = polygonClipping.difference(geom, [[holeMs[i]]]);
    } catch {
      return [ext];
    }
  }
  const meters = [];
  for (let i = 0; i < (geom || []).length; i++) {
    const pieces = explodePoly(geom[i], 0);
    for (let k = 0; k < pieces.length; k++) meters.push(pieces[k]);
  }
  const out = [];
  for (let i = 0; i < meters.length; i++) {
    if (Math.abs(signedArea(meters[i])) < MIN_PIECE_M2) continue;
    const ll = toLonLat(meters[i], proj);
    if (ll) out.push(ll);
  }
  return out;
}

function exteriorsOf(feature) {
  const groups = polygonGroups(feature && feature.geometry);
  const out = [];
  for (let g = 0; g < groups.length; g++) {
    const ring = closeRing(groups[g][0]);
    if (ring) out.push(ring);
  }
  return out;
}

/**
 * Exterior rings with courtyards opened. A hole becomes two or more pieces
 * so the courtyard is not a roof. Rings that are not holes (a sibling wing)
 * stay.
 */
function footprintRings(geometry) {
  const groups = polygonGroups(geometry);
  const out = [];
  for (let g = 0; g < groups.length; g++) {
    const rings = groups[g] || [];
    const exterior = closeRing(rings[0]);
    if (!exterior) continue;
    const holes = [];
    const siblings = [];
    for (let i = 1; i < rings.length; i++) {
      const ring = closeRing(rings[i]);
      if (!ring) continue;
      const c = centroidLL(ring);
      if (c && pointInRingLL(c, exterior)) holes.push(ring);
      else siblings.push(ring);
    }
    if (!holes.length) out.push(exterior);
    else {
      const pieces = subtractHolesLL(exterior, holes);
      for (let p = 0; p < pieces.length; p++) out.push(pieces[p]);
    }
    for (let s = 0; s < siblings.length; s++) out.push(siblings[s]);
  }
  return out;
}

function cloneFeature(feature, geometry) {
  return {
    type: "Feature",
    properties: Object.assign({}, feature && feature.properties),
    geometry: geometry || (feature && feature.geometry),
  };
}

function featureWithRing(feature, ring, keepOut) {
  const props = Object.assign({}, feature.properties);
  if (keepOut && keepOut.length) props.keepOut = keepOut.map((p) => [p[0], p[1]]);
  return {
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function heightOf(feature) {
  const h = Number(feature && feature.properties && feature.properties.height);
  return h > 2 && h < 400 ? h : 0;
}

function isTallPart(part, parent) {
  const th = heightOf(part);
  const ph = heightOf(parent);
  if (!(th > 2)) return false;
  if (ph > 2) return th >= ph + 6;
  return th >= 40;
}

function meterArea(ring) {
  const proj = projectionFor([ring]);
  const m = toMeters(ring, proj);
  return m ? Math.abs(signedArea(m)) : 0;
}

function intersectionArea(a, b) {
  const proj = projectionFor([a, b]);
  const am = orient(toMeters(a, proj), true);
  const bm = orient(toMeters(b, proj), true);
  if (!am || !bm) return 0;
  try {
    const inter = polygonClipping.intersection([[am]], [[bm]]);
    let area = 0;
    for (let i = 0; i < (inter || []).length; i++) {
      const poly = inter[i];
      if (!poly || !poly[0]) continue;
      area += Math.abs(signedArea(poly[0]));
      for (let h = 1; h < poly.length; h++) area -= Math.abs(signedArea(poly[h]));
    }
    return area > 0 ? area : 0;
  } catch {
    return 0;
  }
}

function mostlyInside(innerRing, outerRing) {
  const ia = meterArea(innerRing);
  const oa = meterArea(outerRing);
  if (!(ia >= 80) || !(oa > ia) || !(ia < oa * 0.92)) return false;
  const inter = intersectionArea(innerRing, outerRing);
  return ia > 0 && inter / ia >= PART_COVER;
}

function ringBounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0];
    const y = ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function boundsHit(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** A point that sits in the opening. The vertex average of a bent pool does not. */
function interiorPoint(ring) {
  const closed = closeRing(ring);
  if (!closed) return null;
  const bounds = ringBounds(closed);
  const steps = 8;
  for (let gy = 1; gy < steps; gy++) {
    for (let gx = 1; gx < steps; gx++) {
      const p = [
        bounds.minX + ((bounds.maxX - bounds.minX) * gx) / steps,
        bounds.minY + ((bounds.maxY - bounds.minY) * gy) / steps,
      ];
      if (pointInRingLL(p, closed)) return p;
    }
  }
  return centroidLL(closed);
}

function openingsHitting(ring, openings) {
  const hits = [];
  const bounds = ringBounds(ring);
  const roof = meterArea(ring);
  if (!(roof >= 1)) return hits;
  for (let i = 0; i < openings.length; i++) {
    const op = closeRing(openings[i]);
    if (!op || !boundsHit(bounds, ringBounds(op))) continue;
    const oa = meterArea(op);
    if (!(oa >= 20)) continue;
    const inter = intersectionArea(op, ring);
    if (!(inter >= 30)) continue;
    if (inter / oa < 0.4 && inter / roof < 0.25) continue;
    hits.push(op);
  }
  return hits;
}

function notchFeature(feature, openings) {
  const groups = polygonGroups(feature && feature.geometry);
  if (!groups.length) return [feature];
  const pieces = [];
  let changed = false;
  for (let g = 0; g < groups.length; g++) {
    const rings = groups[g] || [];
    const exterior = closeRing(rings[0]);
    if (!exterior) continue;
    const holes = [];
    const keepOut = [];
    for (let i = 1; i < rings.length; i++) {
      const ring = closeRing(rings[i]);
      if (!ring) continue;
      const c = centroidLL(ring);
      if (c && pointInRingLL(c, exterior)) {
        holes.push(ring);
        keepOut.push(c);
      }
    }
    const pools = openingsHitting(exterior, openings || []);
    for (let i = 0; i < pools.length; i++) {
      holes.push(pools[i]);
      const c = interiorPoint(pools[i]);
      if (c) keepOut.push(c);
    }
    if (!holes.length) {
      pieces.push(featureWithRing(feature, exterior, feature.properties && feature.properties.keepOut));
      continue;
    }
    changed = true;
    const split = subtractHolesLL(exterior, holes);
    if (!split.length) continue;
    const use = split;
    for (let s = 0; s < use.length; s++) {
      const prev = (feature.properties && feature.properties.keepOut) || [];
      pieces.push(featureWithRing(feature, use[s], prev.concat(keepOut)));
    }
  }
  return pieces.length ? pieces : [feature];
}

function subtractSameHeightParts(features) {
  const ringsOf = features.map((f) => exteriorsOf(f));
  const replace = new Map();
  const drop = new Set();
  for (let i = 0; i < features.length; i++) {
    const parent = features[i];
    if (parent.properties && parent.properties.buildingPart) continue;
    const cuts = [];
    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const part = features[j];
      if (!(part.properties && part.properties.buildingPart)) continue;
      if (isTallPart(part, parent)) continue;
      const partRings = ringsOf[j];
      const parentRings = ringsOf[i];
      let inside = false;
      for (let a = 0; a < partRings.length && !inside; a++) {
        for (let b = 0; b < parentRings.length; b++) {
          if (mostlyInside(partRings[a], parentRings[b])) inside = true;
        }
      }
      if (!inside) continue;
      for (let a = 0; a < partRings.length; a++) cuts.push(partRings[a]);
    }
    if (!cuts.length) continue;
    const next = [];
    for (let b = 0; b < ringsOf[i].length; b++) {
      const pieces = subtractHolesLL(ringsOf[i][b], cuts);
      for (let p = 0; p < pieces.length; p++) next.push(pieces[p]);
    }
    if (!next.length) {
      drop.add(i);
      continue;
    }
    const keepOut = parent.properties && parent.properties.keepOut;
    replace.set(
      i,
      next.map((ring) => featureWithRing(parent, ring, keepOut))
    );
  }
  if (!replace.size && !drop.size) return features;
  const out = [];
  for (let i = 0; i < features.length; i++) {
    if (drop.has(i)) continue;
    if (replace.has(i)) {
      const pieces = replace.get(i);
      for (let p = 0; p < pieces.length; p++) out.push(pieces[p]);
    } else out.push(features[i]);
  }
  return out;
}

function dropParentsOverOpenings(features, openings) {
  if (!openings || !openings.length) return { features, dropped: 0 };
  const drop = new Set();
  for (let i = 0; i < features.length; i++) {
    const parent = features[i];
    if (parent.properties && parent.properties.buildingPart) continue;
    const rings = exteriorsOf(parent);
    let spans = false;
    for (let r = 0; r < rings.length && !spans; r++) {
      if (openingsHitting(rings[r], openings).length) spans = true;
    }
    if (!spans) continue;
    let parts = 0;
    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const other = features[j];
      if (!(other.properties && other.properties.buildingPart)) continue;
      const partRings = exteriorsOf(other);
      for (let a = 0; a < partRings.length && parts < 1; a++) {
        for (let b = 0; b < rings.length; b++) {
          if (mostlyInside(partRings[a], rings[b])) parts++;
        }
      }
    }
    if (parts >= 1) drop.add(i);
  }
  if (!drop.size) return { features, dropped: 0 };
  return { features: features.filter((_, i) => !drop.has(i)), dropped: drop.size };
}

/**
 * Add OSM parts, open pools and courtyards, and keep a part that is the
 * detailed footprint of a same-height wing. A tower stays on its podium.
 */
function shapeBuildings(features, detail) {
  const openings = (detail && detail.openings) || [];
  const parts = (detail && detail.parts) || [];
  const partFeatures = [];
  for (let i = 0; i < parts.length; i++) {
    const src = parts[i];
    if (!src || !src.geometry) continue;
    const feature = cloneFeature(src);
    if (!feature.properties) feature.properties = {};
    feature.properties.buildingPart = true;
    if (!feature.properties.geomSource) feature.properties.geomSource = "osm-part";
    partFeatures.push(feature);
  }
  const list = [];
  const src = features || [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] && src[i].geometry) list.push(cloneFeature(src[i]));
  }
  const withParts = list.concat(partFeatures);
  let notched = 0;
  const opened = [];
  for (let i = 0; i < withParts.length; i++) {
    const before = exteriorsOf(withParts[i]).length;
    const pieces = notchFeature(withParts[i], openings);
    if (pieces.length !== before || (pieces[0] && pieces[0] !== withParts[i] && pieces[0].properties && pieces[0].properties.keepOut)) {
      notched++;
    }
    for (let p = 0; p < pieces.length; p++) opened.push(pieces[p]);
  }
  const cut = subtractSameHeightParts(opened);
  const dropped = dropParentsOverOpenings(cut, openings);
  return {
    features: dropped.features,
    stats: {
      parts: partFeatures.length,
      openings: openings.length,
      notched,
      parentsDropped: dropped.dropped,
      pieces: dropped.features.length,
    },
  };
}

module.exports = {
  CORRIDOR_M,
  buildingDetailQuery,
  parseBuildingDetail,
  fetchBuildingDetail,
  footprintRings,
  shapeBuildings,
  subtractHolesLL,
  pointInRingLL,
  centroidLL,
};
