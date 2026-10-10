"use strict";

/**
 * Building outlines for Hamina.
 *
 * Overture and OSM `building=*` ways are often one complex: the ring runs
 * around towers, the podium, and the open pool deck. OpenIntent has no hole
 * ring, so a courtyard has to be a gap in the outline. A `building:part`
 * keeps its own height. min_height lifts that part only when the source
 * says it is a small bridge, skywalk, roof, or canopy. A parent stays
 * when its parts do not reach the ground.
 *
 * Simplification stays near a metre. A convex hull that fills the courtyard
 * is not a candidate.
 */

const polygonClipping = require("polygon-clipping");
const { guidewaysFromElements, guidewaysFromParsedWays, bridgesFromElements, bridgesFromParsedWays } = require("./outdoor-clutter");
const { fetchOsmMaps, ringKey, bboxSpanM, TILE_SPAN_M } = require("./osm-tiles");
const { placesFromElements } = require("./map-notes");

const OVERPASS_URLS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const MIN_PIECE_M2 = 25;
const CORRIDOR_M = 8;
const PART_COVER = 0.75;
/** A skywalk can be long and narrow. A parking garage is larger than this. */
const FLOAT_MAX_M2 = 8000;
const LEVEL_HEIGHT_M = 3;

function buildingDetailQuery(bbox) {
  const box = [+bbox.south, +bbox.west, +bbox.north, +bbox.east].join(",");
  return (
    "[out:json][timeout:12];(" +
    'way["building:part"](' + box + ");" +
    'way["building"](' + box + ");" +
    'way["leisure"="swimming_pool"](' + box + ");" +
    'way["natural"="water"](' + box + ");" +
    'way["water"](' + box + ");" +
    'way["landuse"="reservoir"](' + box + ");" +
    'relation["building:part"](' + box + ");" +
    'relation["type"="multipolygon"]["building"](' + box + ");" +
    'way["railway"~"^(monorail|light_rail|subway|rail|tram)$"](' + box + ");" +
    'way["highway"]["bridge"~"^(yes|viaduct|covered)$"](' + box + ");" +
    'way["highway"]["layer"~"^[1-9]"](' + box + ");" +
    'way["man_made"="bridge"](' + box + ");" +
    'way["bridge"="viaduct"](' + box + ");" +
    'way["building"~"^(static_caravan|mobile_home|caravan)$"](' + box + ");" +
    'relation["building"~"^(static_caravan|mobile_home|caravan)$"](' + box + ");" +
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

function bridgeLike(tags) {
  if (!tags) return false;
  const building = String(tags.building || "").toLowerCase();
  const part = String(tags["building:part"] || "").toLowerCase();
  const made = String(tags.man_made || "").toLowerCase();
  const bridge = String(tags.bridge || "").toLowerCase();
  if (building === "bridge" || building === "roof" || building === "canopy") return true;
  if (part === "bridge" || part === "roof" || part === "canopy" || part === "skywalk") return true;
  if (made === "bridge" || made === "canopy" || made === "skywalk") return true;
  if (bridge === "yes" || bridge === "covered" || bridge === "viaduct") return true;
  if (tags.skywalk || tags["building:skywalk"]) return true;
  return false;
}

function heightTags(tags) {
  const top = parseMeters(tags.height || tags["building:height"]);
  let minH = parseMeters(tags.min_height || tags["building:min_height"]);
  const levels = Number(tags["building:levels"] || tags.levels);
  const minLevel = Number(tags["building:min_level"]);
  const levelBottom = minLevel >= 1 && minLevel <= 40 ? minLevel * LEVEL_HEIGHT_M : 0;
  if (!(minH > 0) && levelBottom > 0) minH = levelBottom;
  let height = top;
  if (!(height > 2) && levels >= 1 && levels <= 80) height = levels * LEVEL_HEIGHT_M;
  if (!(height > 2) && levelBottom > 0) height = levelBottom + LEVEL_HEIGHT_M;
  // building:levels is the deck itself when the bottom is building:min_level.
  if (height > 2 && minH >= height && levelBottom > 0 && !(top > 2)) {
    const deck = levels >= 1 && levels <= 80 ? levels * LEVEL_HEIGHT_M : LEVEL_HEIGHT_M;
    height = minH + deck;
  }
  if (!(height > 2 && height < 400)) height = 0;
  if (!(minH > 0 && minH < 400)) minH = 0;
  if (height && minH >= height) minH = 0;
  return { height, minH };
}

function isStaticCaravanTags(tags) {
  const building = String((tags && tags.building) || "").toLowerCase();
  return building === "static_caravan" || building === "mobile_home" || building === "caravan";
}

function caravanFeature(rings, tags) {
  const feature = partFeature(rings, tags);
  if (!feature) return null;
  feature.properties.staticCaravan = true;
  if (!(Number(feature.properties.height) > 2)) {
    feature.properties.height = 3.5;
    feature.properties.heightSource = "static-caravan";
  }
  return feature;
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
  // A large part with min_height is the whole mass down to the ground.
  // Only a small bridge, skywalk, roof, or canopy keeps the air underneath.
  const area = meterArea(exterior);
  if (h.minH > 0 && bridgeLike(tags) && area > 0 && area <= FLOAT_MAX_M2 && (!h.height || h.minH < h.height)) {
    properties.levelBaseM = Math.round(h.minH * 10) / 10;
    properties.floatSpan = true;
  }
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
 * multipolygon inner rings become openings. A `building=*` outer becomes a
 * footprint only when no emitted roof already covers it, so a cabin or a
 * bathhouse the other sources missed still appears.
 */
function parseBuildingDetail(payload, bbox) {
  const elements = (payload && payload.elements) || [];
  const parts = [];
  const openings = [];
  const buildings = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tags = (el && el.tags) || {};
    if (el.type === "way") {
      const ring = wayCoords(el);
      if (!ring) continue;
      if (bbox && !ringHitsBox(ring, bbox)) continue;
      if (isStaticCaravanTags(tags)) {
        const feature = caravanFeature([ring], tags);
        if (feature) parts.push(feature);
        continue;
      }
      if (tags["building:part"] || bridgeLike(tags)) {
        const feature = partFeature([ring], tags);
        // A bridge with no height is a road deck, not a second building.
        if (feature && (tags["building:part"] || feature.properties.height || feature.properties.levelBaseM)) {
          parts.push(feature);
        }
        continue;
      }
      if (isOpeningTags(tags)) {
        openings.push(ring);
        continue;
      }
      if (tags.building) buildings.push(ring);
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
    if (isStaticCaravanTags(tags)) {
      for (let o = 0; o < outers.length; o++) {
        const feature = caravanFeature([outers[o]].concat(inners), tags);
        if (feature && (!bbox || ringHitsBox(outers[o], bbox))) parts.push(feature);
      }
      continue;
    }
    if (tags.building && !tags["building:part"]) {
      for (let o = 0; o < outers.length; o++) {
        if (!bbox || ringHitsBox(outers[o], bbox)) buildings.push(outers[o]);
      }
      for (let n = 0; n < inners.length; n++) {
        if (!bbox || ringHitsBox(inners[n], bbox)) openings.push(inners[n]);
      }
    }
  }
  return { parts, openings, buildings, places: placesFromElements(elements) };
}

function ringHitsBox(ring, bbox) {
  for (let i = 0; i < ring.length; i++) {
    const lon = ring[i][0];
    const lat = ring[i][1];
    if (lon >= +bbox.west && lon <= +bbox.east && lat >= +bbox.south && lat <= +bbox.north) return true;
  }
  return false;
}

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
 * The map extract is one request for a draw up to about 2.2 km. A larger
 * background draw is tiled Overpass elements. Overpass for the whole box
 * is only the fallback for a small extract. Only parts, pools, water, and
 * courtyard inners are kept. A plain building outer is not a new footprint.
 */
function detailFromMapXml(xml, bbox, deckCap) {
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
  const parsed = parseBuildingDetail({ elements }, bbox);
  parsed.guideways = guidewaysFromParsedWays(ways, nodes, bbox, deckCap);
  parsed.bridges = bridgesFromParsedWays(ways, nodes, bbox, deckCap);
  parsed.roads = roadsFromWays(ways, nodes);
  return parsed;
}

/** A mapped road, not an indoor corridor drawn through a lobby. */
function roadsFromWays(ways, nodes) {
  const roads = [];
  for (const way of ways.values()) {
    const kind = way && way.tags && way.tags.highway;
    if (!kind || kind === "corridor" || kind === "proposed" || kind === "construction" || kind === "elevator") continue;
    const pts = refsToPts(way.refs, nodes);
    if (pts.length >= 2) roads.push(pts);
  }
  return roads;
}

function mergeBuildingDetail(packs) {
  const parts = [];
  const openings = [];
  const buildings = [];
  const guideways = [];
  const bridges = [];
  const roads = [];
  const places = [];
  const seenP = new Set();
  const seenO = new Set();
  const seenBuildings = new Set();
  const seenG = new Set();
  const seenB = new Set();
  for (let p = 0; p < packs.length; p++) {
    const pack = packs[p] || {};
    const partList = pack.parts || [];
    for (let i = 0; i < partList.length; i++) {
      const feature = partList[i];
      const ring = feature && feature.geometry && feature.geometry.coordinates && feature.geometry.coordinates[0];
      const key = ringKey(ring);
      if (key && seenP.has(key)) continue;
      if (key) seenP.add(key);
      parts.push(feature);
    }
    const opens = pack.openings || [];
    for (let i = 0; i < opens.length; i++) {
      const key = ringKey(opens[i]);
      if (key && seenO.has(key)) continue;
      if (key) seenO.add(key);
      openings.push(opens[i]);
    }
    const outlines = pack.buildings || [];
    for (let i = 0; i < outlines.length; i++) {
      const key = ringKey(outlines[i]);
      if (key && seenBuildings.has(key)) continue;
      if (key) seenBuildings.add(key);
      buildings.push(outlines[i]);
    }
    const guides = pack.guideways || [];
    for (let i = 0; i < guides.length; i++) {
      const key = ringKey(guides[i] && guides[i].coords);
      if (key && seenG.has(key)) continue;
      if (key) seenG.add(key);
      guideways.push(guides[i]);
    }
    const decks = pack.bridges || [];
    for (let i = 0; i < decks.length; i++) {
      const key = ringKey(decks[i] && decks[i].coords);
      if (key && seenB.has(key)) continue;
      if (key) seenB.add(key);
      bridges.push(decks[i]);
    }
    const lines = pack.roads || [];
    for (let i = 0; i < lines.length; i++) {
      const key = ringKey(lines[i]);
      if (key && seenB.has("road:" + key)) continue;
      if (key) seenB.add("road:" + key);
      roads.push(lines[i]);
    }
    const spots = pack.places || [];
    for (let i = 0; i < spots.length; i++) places.push(spots[i]);
  }
  return { parts, openings, buildings, guideways, bridges, roads, places };
}

async function fetchBuildingDetail(bbox, opts) {
  const empty = { ok: false, parts: [], openings: [], buildings: [], roads: [], guideways: [], bridges: [] };
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
  const tile = !!(opts && opts.tile);
  const deckCap = opts && opts.deckCap > 0 ? opts.deckCap | 0 : 0;
  try {
    if (!ctrl.signal.aborted) {
      try {
        const maps = await fetchOsmMaps(bbox, {
          signal: ctrl.signal,
          ua,
          tile,
          fetchImpl: opts && opts.fetchImpl,
        });
        if (maps.elements && maps.elements.length) {
          const parsed = parseBuildingDetail({ elements: maps.elements }, bbox);
          return {
            ok: true,
            parts: parsed.parts,
            openings: parsed.openings,
            buildings: parsed.buildings || [],
            roads: [],
            guideways: guidewaysFromElements(maps.elements, bbox, deckCap),
            bridges: bridgesFromElements(maps.elements, bbox, deckCap),
            notes: maps.notes,
            places: parsed.places || [],
          };
        }
        if (maps.xmls.length) {
          const packs = [];
          for (let i = 0; i < maps.xmls.length; i++) packs.push(detailFromMapXml(maps.xmls[i], bbox, deckCap));
          const merged = mergeBuildingDetail(packs);
          return {
            ok: true,
            parts: merged.parts,
            openings: merged.openings,
            buildings: merged.buildings || [],
            roads: merged.roads || [],
            guideways: merged.guideways,
            bridges: merged.bridges,
            notes: maps.notes,
            places: merged.places || [],
          };
        }
        if (bboxSpanM(bbox).sideM > TILE_SPAN_M) {
          return { ok: true, parts: [], openings: [], buildings: [], roads: [], guideways: [], bridges: [], notes: maps.notes };
        }
      } catch (e) {
        if (ctrl.signal.aborted) return empty;
      }
    }
    if (bboxSpanM(bbox).sideM > TILE_SPAN_M) {
      return { ok: true, parts: [], openings: [], buildings: [], roads: [], guideways: [], bridges: [], notes: [] };
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
        return {
          ok: true,
          parts: parsed.parts,
          openings: parsed.openings,
          buildings: parsed.buildings || [],
          roads: [],
          guideways: guidewaysFromElements(json.elements, bbox, deckCap),
          bridges: bridgesFromElements(json.elements, bbox, deckCap),
          places: parsed.places || [],
        };
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
    const roof = meterArea(exterior);
    if (!split.length) {
      // A failed cut must not erase a large roof. The pool stays in the
      // outline only when subtraction itself returns nothing.
      if (roof >= 1000) {
        pieces.push(featureWithRing(feature, exterior, feature.properties && feature.properties.keepOut));
      }
      continue;
    }
    const use = split;
    for (let s = 0; s < use.length; s++) {
      const prev = (feature.properties && feature.properties.keepOut) || [];
      pieces.push(featureWithRing(feature, use[s], prev.concat(keepOut)));
    }
  }
  return pieces.length ? pieces : [feature];
}

function subtractSameHeightParts(features, notes) {
  const ringsOf = features.map((f) => exteriorsOf(f));
  const replace = new Map();
  const drop = new Set();
  for (let i = 0; i < features.length; i++) {
    const parent = features[i];
    if (parent.properties && (parent.properties.buildingPart || parent.properties.roofCore)) continue;
    const cuts = [];
    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const part = features[j];
      if (!(part.properties && part.properties.buildingPart)) continue;
      if (isTallPart(part, parent)) continue;
      // A raised part does not replace the floors under it.
      if (Number(part.properties.levelBaseM) > 0 || part.properties.floatSpan) continue;
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
      let parentArea = 0;
      for (let b = 0; b < ringsOf[i].length; b++) parentArea += meterArea(ringsOf[i][b]);
      noteLargeDrop(notes, parentArea, "same-height parts replaced the parent");
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

function dropParentsOverOpenings(features, openings, notes) {
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
      if (Number(other.properties.levelBaseM) > 0 || other.properties.floatSpan) continue;
      const partRings = exteriorsOf(other);
      for (let a = 0; a < partRings.length && parts < 1; a++) {
        for (let b = 0; b < rings.length; b++) {
          if (mostlyInside(partRings[a], rings[b])) parts++;
        }
      }
    }
    if (parts < 1) continue;
    let parentArea = 0;
    for (let r = 0; r < rings.length; r++) parentArea += meterArea(rings[r]);
    let covered = 0;
    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const other = features[j];
      if (!(other.properties && other.properties.buildingPart)) continue;
      if (Number(other.properties.levelBaseM) > 0 || other.properties.floatSpan) continue;
      const partRings = exteriorsOf(other);
      for (let a = 0; a < partRings.length; a++) {
        for (let b = 0; b < rings.length; b++) {
          if (!mostlyInside(partRings[a], rings[b])) continue;
          covered += meterArea(partRings[a]);
        }
      }
    }
    if (parentArea - covered >= 1000) continue;
    drop.add(i);
    noteLargeDrop(notes, parentArea, "a pool cut removed the parent because parts replaced it");
  }
  if (!drop.size) return { features, dropped: 0 };
  return { features: features.filter((_, i) => !drop.has(i)), dropped: drop.size };
}

function ringAreaDeg(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}

/**
 * A huge outline whose three extreme corners already cover the polygon.
 * That is the Overture copy of a concave podium: the real retail ring is
 * not a triangle, and the copied ring is.
 */
function ringTriRatio(ring) {
  const closed = closeRing(ring);
  if (!closed) return 0;
  const open = closed.slice(0, -1);
  if (open.length < 3) return 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < open.length; i++) {
    cx += open[i][0];
    cy += open[i][1];
  }
  cx /= open.length;
  cy /= open.length;
  const ranked = open.slice().sort((a, b) => {
    const da = (a[0] - cx) * (a[0] - cx) + (a[1] - cy) * (a[1] - cy);
    const db = (b[0] - cx) * (b[0] - cx) + (b[1] - cy) * (b[1] - cy);
    return db - da;
  });
  let best = 0;
  const n = Math.min(12, ranked.length);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = ranked[i];
        const b = ranked[j];
        const c = ranked[k];
        const t = Math.abs(a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2;
        if (t > best) best = t;
      }
    }
  }
  const poly = ringAreaDeg(open);
  return poly > 0 ? best / poly : 0;
}

function coarseWedge(ring) {
  const area = meterArea(ring);
  if (!(area >= 5000)) return false;
  return ringTriRatio(ring) >= 0.9;
}

/**
 * A carved piece whose corners already cover it. Below the coarse-triangle
 * cutoff, so a 0.87 slab was still being drawn as a diagonal podium.
 */
function diagonalCut(ring) {
  const area = meterArea(ring);
  if (!(area >= 5000)) return false;
  return ringTriRatio(ring) >= 0.82;
}

/**
 * The street-map outline this footprint belongs to, including a ring much
 * larger than a carved fragment. A coarse triangle is not the host.
 */
function osmHostRing(source, osmRings) {
  const host = meterArea(source);
  let best = null;
  let bestInter = 0;
  for (let i = 0; i < (osmRings || []).length; i++) {
    const closed = closeRing(osmRings[i]);
    if (!closed || coarseWedge(closed)) continue;
    const oa = meterArea(closed);
    if (oa < 8000) continue;
    const inter = intersectionArea(closed, source);
    if (!(inter >= 2000)) continue;
    if (inter / oa < 0.25 && inter / Math.max(host, 1) < 0.35) continue;
    if (inter > bestInter) {
      bestInter = inter;
      best = closed;
    }
  }
  return best;
}

function ringBbox(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return [minX, minY, maxX, maxY];
}

function bboxHits(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function bestOsmReplacement(wedge, osmRings) {
  const host = meterArea(wedge);
  if (!(host > 0)) return null;
  let best = null;
  let bestInter = 0;
  for (let i = 0; i < (osmRings || []).length; i++) {
    const closed = closeRing(osmRings[i]);
    if (!closed || coarseWedge(closed)) continue;
    const oa = meterArea(closed);
    if (!(oa > 0)) continue;
    const ratio = oa / host;
    if (ratio < 0.7 || ratio > 1.45) continue;
    const inter = intersectionArea(closed, wedge);
    if (!(inter / host >= 0.75)) continue;
    if (inter > bestInter) {
      bestInter = inter;
      best = closed;
    }
  }
  return best;
}

/** Metres of a road polyline whose midpoints sit inside the ring. */
function roadLengthInside(line, ring) {
  if (!line || line.length < 2 || !ring) return 0;
  const proj = projectionFor([ring, line]);
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!pointInRingLL(mid, ring)) continue;
    const ax = (a[0] - proj.lon0) * proj.mx;
    const ay = (a[1] - proj.lat0) * proj.my;
    const bx = (b[0] - proj.lon0) * proj.mx;
    const by = (b[1] - proj.lat0) * proj.my;
    total += Math.hypot(bx - ax, by - ay);
  }
  return total;
}

/**
 * A huge triangle that blankets a pool, a pond, or a mapped road is not a
 * roof. Indoor corridors are not roads.
 */
function wedgeCoversGround(ring, ground) {
  const openings = (ground && ground.openings) || [];
  for (let i = 0; i < openings.length; i++) {
    const opening = openings[i];
    const oa = meterArea(opening);
    if (!(oa >= 400)) continue;
    const inter = intersectionArea(opening, ring);
    if (oa > 0 && inter / oa >= 0.5) return true;
  }
  const roads = (ground && ground.roads) || [];
  let length = 0;
  for (let i = 0; i < roads.length; i++) {
    length += roadLengthInside(roads[i], ring);
    if (length >= 80) return true;
  }
  return false;
}

/**
 * A coarse triangular copy is replaced by the OSM outline of that same
 * building. A wedge that blankets other roofs, pools, water, or roads is
 * left out. A triangular building with nothing else under it stays.
 */
function repairCoarseWedges(features, osmRings, ground, notes) {
  const drop = new Set();
  const replace = new Map();
  let replaced = 0;
  let dropped = 0;
  for (let i = 0; i < features.length; i++) {
    const rings = exteriorsOf(features[i]);
    if (rings.length !== 1 || !coarseWedge(rings[0])) continue;
    const osm = bestOsmReplacement(rings[0], osmRings);
    if (osm) {
      replace.set(i, osm);
      replaced++;
      continue;
    }
    const bodies = realBuildingBody(rings[0], osmRings).filter(function (ring) {
      return ring && !coarseWedge(ring) && !sameRing(ring, rings[0]);
    });
    if (bodies.length) {
      replace.set(i, bodies);
      replaced++;
      continue;
    }
    const host = meterArea(rings[0]);
    let others = 0;
    for (let j = 0; j < features.length; j++) {
      if (j === i) continue;
      const outs = exteriorsOf(features[j]);
      for (let k = 0; k < outs.length; k++) {
        const other = outs[k];
        if (coarseWedge(other)) continue;
        const oa = meterArea(other);
        if (oa < 400 || oa > host * 0.85) continue;
        const inter = intersectionArea(other, rings[0]);
        if (oa > 0 && inter / oa >= 0.5) others++;
      }
    }
    if (others >= 1 || wedgeCoversGround(rings[0], ground)) {
      const trimmed = trimTaperedRing(rings[0]);
      const kept = [];
      for (let t = 0; t < trimmed.length; t++) {
        if (sameRing(trimmed[t], rings[0])) continue;
        if (coarseWedge(trimmed[t])) continue;
        if (wedgeCoversGround(trimmed[t], ground)) continue;
        if (meterArea(trimmed[t]) < 4000) continue;
        kept.push(trimmed[t]);
      }
      if (kept.length) {
        replace.set(i, kept);
        replaced++;
        continue;
      }
      const cleaned = cleanedSourceBody(rings[0]);
      if (cleaned.length) {
        replace.set(i, cleaned);
        replaced++;
        continue;
      }
      // The Overture copy of way 111413431 is this wedge. Its own trim
      // fails, and the street-map ring is also triangular, so the usual
      // replacement skips it. Seat that outline instead of dropping the roof.
      const outlined = streetOutlineForWedge(rings[0], osmRings);
      if (outlined && outlined.length) {
        replace.set(i, outlined);
        replaced++;
        continue;
      }
      drop.add(i);
      dropped++;
      noteLargeDrop(notes, host, "triangular outline covered open ground");
    }
  }
  const out = [];
  for (let i = 0; i < features.length; i++) {
    if (drop.has(i)) continue;
    if (replace.has(i)) {
      const next = replace.get(i);
      const many = Array.isArray(next[0]) && Array.isArray(next[0][0]);
      const rings = many ? next : [next];
      for (let r = 0; r < rings.length; r++) {
        const feature = featureWithRing(features[i], rings[r], features[i].properties && features[i].properties.keepOut);
        // A trimmed low-rise body of a dropped wedge sits with the other blocks.
        if (many && !(heightOf(feature) >= 15)) {
          feature.properties.height = 18;
          if (!feature.properties.heightSource) feature.properties.heightSource = "overture";
        }
        out.push(feature);
      }
    } else out.push(features[i]);
  }
  return { features: out, replaced, dropped };
}

/**
 * Wall-aligned fill. A rectangle scores near 1. A campus that wanders
 * across open ground scores well under that.
 */
function wallAlignedFill(open) {
  const axis = dominantWallAxis(open);
  if (!axis) return 1;
  const axes = [axis, [-axis[1], axis[0]]];
  let best = 0;
  let shoelace = 0;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    shoelace += open[j][0] * open[i][1] - open[i][0] * open[j][1];
  }
  const area = Math.abs(shoelace) / 2;
  if (!(area > 0)) return 1;
  for (let a = 0; a < axes.length; a++) {
    const ux = axes[a][0];
    const uy = axes[a][1];
    const px = -uy;
    const py = ux;
    let minA = Infinity;
    let maxA = -Infinity;
    let minP = Infinity;
    let maxP = -Infinity;
    for (let i = 0; i < open.length; i++) {
      const along = open[i][0] * ux + open[i][1] * uy;
      const perp = open[i][0] * px + open[i][1] * py;
      if (along < minA) minA = along;
      if (along > maxA) maxA = along;
      if (perp < minP) minP = perp;
      if (perp > maxP) maxP = perp;
    }
    const box = (maxA - minA) * (maxP - minP);
    if (box > 0 && area / box > best) best = area / box;
  }
  return best;
}

function closeBinary(mask, cols, rows) {
  const n = cols * rows;
  const dil = new Uint8Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= rows || xx >= cols) continue;
          if (mask[yy * cols + xx]) on = 1;
        }
      }
      dil[y * cols + x] = on;
    }
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let on = 1;
      for (let dy = -1; dy <= 1 && on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= rows || xx >= cols || !dil[yy * cols + xx]) on = 0;
        }
      }
      out[y * cols + x] = on;
    }
  }
  return out;
}

function sampleImagery(imagery, lon, lat) {
  const frame = imagery.frame;
  const spanX = frame.east - frame.west;
  const spanY = frame.north - frame.south;
  if (!(spanX > 0) || !(spanY > 0)) return null;
  const x = ((lon - frame.west) / spanX) * imagery.width;
  const y = ((frame.north - lat) / spanY) * imagery.height;
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 1 || yi < 1 || xi >= imagery.width - 1 || yi >= imagery.height - 1) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const data = imagery.data;
  const w = imagery.width;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = ((yi + dy) * w + (xi + dx)) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

function prefixGrid(src, cols, rows) {
  const stride = cols + 1;
  const acc = new Float64Array((rows + 1) * stride);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = src[r * cols + c] || 0;
      acc[(r + 1) * stride + (c + 1)] =
        v + acc[r * stride + (c + 1)] + acc[(r + 1) * stride + c] - acc[r * stride + c];
    }
  }
  return acc;
}

function prefixBox(acc, cols, r0, r1, c0, c1) {
  const stride = cols + 1;
  return acc[r1 * stride + c1] - acc[r0 * stride + c1] - acc[r1 * stride + c0] + acc[r0 * stride + c0];
}

/**
 * Largest wall-aligned block of one roof tone. A dark block has to be
 * solid. A warm block may have a few panel gaps, still mostly that tone,
 * and still inside the parent outline.
 */
function largestToneRect(mask, raw, cols, rows, step, parentArea, minSolid) {
  const minCells = Math.ceil(48 / step);
  const maxCells = Math.floor(200 / step);
  const maskSum = prefixGrid(mask, cols, rows);
  const toneSum = prefixGrid(raw.tone, cols, rows);
  const greenSum = prefixGrid(raw.green, cols, rows);
  const inSum = prefixGrid(raw.inside, cols, rows);
  const ySum = prefixGrid(raw.y, cols, rows);
  let best = null;
  for (let r0 = 0; r0 < rows; r0++) {
    const r1Max = Math.min(rows, r0 + maxCells);
    for (let r1 = r0 + minCells; r1 <= r1Max; r1++) {
      const height = (r1 - r0) * step;
      for (let c0 = 0; c0 < cols; c0++) {
        const c1Max = Math.min(cols, c0 + maxCells);
        for (let c1 = c0 + minCells; c1 <= c1Max; c1++) {
          const width = (c1 - c0) * step;
          const aspect = Math.max(width, height) / Math.min(width, height);
          if (aspect > 2.2) continue;
          const area = width * height;
          if (area < 5000 || area > 14000 || area >= parentArea * 0.28) continue;
          if (best && area <= best.area) continue;
          const n = (r1 - r0) * (c1 - c0);
          if (prefixBox(maskSum, cols, r0, r1, c0, c1) / n < minSolid) continue;
          if (prefixBox(inSum, cols, r0, r1, c0, c1) / n < 0.9) continue;
          if (prefixBox(greenSum, cols, r0, r1, c0, c1) / n > 0.1) continue;
          if (prefixBox(toneSum, cols, r0, r1, c0, c1) / n < 0.72) continue;
          const meanY = prefixBox(ySum, cols, r0, r1, c0, c1) / n;
          const toneOk = raw.kind === "dark" ? meanY < 80 : meanY > 168;
          if (!toneOk) continue;
          best = { r0, r1, c0, c1, width, height, area, meanY };
        }
      }
    }
  }
  return best;
}

function rectRing(rect, grid) {
  const step = grid.step;
  const corners = [
    [rect.r0, rect.c0],
    [rect.r1, rect.c0],
    [rect.r1, rect.c1],
    [rect.r0, rect.c1],
  ];
  const ring = [];
  for (let i = 0; i < corners.length; i++) {
    const along = grid.amin + corners[i][0] * step;
    const perp = grid.pmin + corners[i][1] * step;
    const x = along * grid.ux + perp * grid.px;
    const y = along * grid.uy + perp * grid.py;
    ring.push([x / grid.mx + grid.lon0, y / grid.my + grid.lat0]);
  }
  ring.push(ring[0].slice());
  return ring;
}

/**
 * Two rectangular roofs inside one sprawling low-rise outline: a dark
 * block and a warm block, separate in the aerial. A tower, a round roof,
 * and a single-tone building stay as they are. The two blocks are the
 * cores. The rest of the real outline stays. Only open ground that the
 * coarse triangle added is left out.
 */
function twinRoofCores(ring, imagery, parentArea) {
  const closed = closeRing(ring);
  if (!closed || !imagery || !imagery.data || !imagery.frame) return null;
  const proj = projectionFor([closed]);
  const meters = toMeters(closed, proj);
  if (!meters) return null;
  const open = meters.slice(0, -1);
  const axis = dominantWallAxis(open);
  if (!axis) return null;
  const ux = axis[0];
  const uy = axis[1];
  const px = -uy;
  const py = ux;
  let amin = Infinity;
  let amax = -Infinity;
  let pmin = Infinity;
  let pmax = -Infinity;
  for (let i = 0; i < open.length; i++) {
    const along = open[i][0] * ux + open[i][1] * uy;
    const perp = open[i][0] * px + open[i][1] * py;
    if (along < amin) amin = along;
    if (along > amax) amax = along;
    if (perp < pmin) pmin = perp;
    if (perp > pmax) pmax = perp;
  }
  const step = 8;
  amin -= step;
  pmin -= step;
  amax += step;
  pmax += step;
  const rows = Math.floor((amax - amin) / step);
  const cols = Math.floor((pmax - pmin) / step);
  if (rows < 8 || cols < 8 || rows > 80 || cols > 80) return null;
  const n = rows * cols;
  const dark = new Uint8Array(n);
  const warm = new Uint8Array(n);
  const yv = new Uint8Array(n);
  const green = new Uint8Array(n);
  const inside = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const along = amin + (r + 0.5) * step;
      const perp = pmin + (c + 0.5) * step;
      const x = along * ux + perp * px;
      const y = along * uy + perp * py;
      const lon = x / proj.mx + proj.lon0;
      const lat = y / proj.my + proj.lat0;
      const k = r * cols + c;
      if (!pointInRingLL([lon, lat], closed)) continue;
      inside[k] = 1;
      const rgb = sampleImagery(imagery, lon, lat);
      if (!rgb) continue;
      const yy = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      yv[k] = Math.max(0, Math.min(255, Math.round(yy)));
      const isGreen = rgb[1] > rgb[0] + 12 && rgb[1] > rgb[2] + 8 && rgb[1] > 80;
      if (isGreen) {
        green[k] = 1;
        continue;
      }
      if (yy < 82) dark[k] = 1;
      if (rgb[0] - rgb[2] > 12 && yy > 150) warm[k] = 1;
    }
  }
  const grid = {
    step,
    amin,
    pmin,
    ux,
    uy,
    px,
    py,
    mx: proj.mx,
    my: proj.my,
    lon0: proj.lon0,
    lat0: proj.lat0,
  };
  const darkRect = largestToneRect(closeBinary(dark, cols, rows), {
    kind: "dark",
    tone: dark,
    y: yv,
    green,
    inside,
  }, cols, rows, step, parentArea, 1);
  const warmRect = largestToneRect(closeBinary(warm, cols, rows), {
    kind: "warm",
    tone: warm,
    y: yv,
    green,
    inside,
  }, cols, rows, step, parentArea, 0.88);
  if (!darkRect || !warmRect) return null;
  const darkRing = rectRing(darkRect, grid);
  const warmRing = rectRing(warmRect, grid);
  const overlap = intersectionArea(darkRing, warmRing);
  const smaller = Math.min(darkRect.area, warmRect.area);
  if (!(smaller > 0) || overlap / smaller > 0.2) return null;
  return [darkRing, warmRing];
}

function noteLargeDrop(notes, area, reason) {
  if (!(area >= 1000) || !notes) return;
  notes.push("Dropped building " + Math.round(area) + " m2: " + reason + ".");
}

/**
 * The OSM outline of this footprint, or the source when that source is
 * already a real ring. A coarse triangle is not the body. A convex hull
 * is never the body.
 */
function realBuildingBody(source, osmRings) {
  const host = meterArea(source);
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < (osmRings || []).length; i++) {
    const closed = closeRing(osmRings[i]);
    if (!closed || coarseWedge(closed)) continue;
    const oa = meterArea(closed);
    if (oa < 1000) continue;
    const ratio = oa / Math.max(host, 1);
    // A fragment of this campus must not pull the whole outline back in.
    if (ratio < 0.55 || ratio > 1.6) continue;
    const inter = intersectionArea(closed, source);
    if (!(inter >= 1000)) continue;
    if (inter / oa < 0.45 || inter / host < 0.45) continue;
    if (oa > bestArea) {
      best = closed;
      bestArea = oa;
    }
  }
  if (best) return [best];
  const closed = closeRing(source);
  if (!closed || coarseWedge(closed)) return [];
  return [closed];
}

/**
 * A cleaned copy of a coarse triangle: the thick body after a taper cut.
 * Never a convex hull, and never the triangle itself.
 */
/**
 * The street-map ring for a coarse wedge, including a ring that is itself
 * triangular. A traced outline (many corners) is the roof. A 3-point
 * triangle is not.
 */
function streetOutlineForWedge(wedge, osmRings) {
  const host = meterArea(wedge);
  if (!(host > 0)) return null;
  let best = null;
  let bestInter = 0;
  for (let i = 0; i < (osmRings || []).length; i++) {
    const closed = closeRing(osmRings[i]);
    if (!closed) continue;
    const oa = meterArea(closed);
    const ratio = oa / host;
    if (ratio < 0.7 || ratio > 1.45) continue;
    const inter = intersectionArea(closed, wedge);
    if (!(inter / host >= 0.75)) continue;
    if (inter > bestInter) {
      bestInter = inter;
      best = closed;
    }
  }
  if (!best) return null;
  const cleaned = cleanedSourceBody(best);
  if (cleaned.length) return cleaned;
  const open =
    best.length > 1 && best[0][0] === best[best.length - 1][0] && best[0][1] === best[best.length - 1][1]
      ? best.length - 1
      : best.length;
  if (open >= 40) return [best];
  return null;
}

function cleanedSourceBody(source) {
  const closed = closeRing(source);
  if (!closed) return [];
  const trimmed = trimTaperedRing(closed, true);
  const kept = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (!trimmed[i] || coarseWedge(trimmed[i])) continue;
    if (sameRing(trimmed[i], closed)) continue;
    if (meterArea(trimmed[i]) < 1000) continue;
    kept.push(trimmed[i]);
  }
  return kept;
}

function seatLowRise(feature, ring, keepOut) {
  const next = featureWithRing(feature, ring, keepOut);
  next.properties.buildingBody = true;
  if (!(heightOf(next) >= 15)) {
    next.properties.height = 18;
    if (!next.properties.heightSource) next.properties.heightSource = "overture";
  }
  return next;
}

function bodyFeatures(feature, source, osmRings, coreRings, keepOut) {
  const bodies = realBuildingBody(source, osmRings);
  const out = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    if (!body || coarseWedge(body)) continue;
    let remain = [body];
    if (coreRings && coreRings.length) {
      const cut = subtractHolesLL(body, coreRings).filter(function (ring) {
        return meterArea(ring) >= 1000;
      });
      if (cut.length) remain = cut;
    }
    for (let r = 0; r < remain.length; r++) {
      if (meterArea(remain[r]) < 1000) continue;
      out.push(seatLowRise(feature, remain[r], keepOut));
    }
  }
  return out;
}

function carveTwinRoofs(features, imagery, ground, osmRings, notes) {
  if (!imagery || !imagery.data || !(imagery.width > 16) || !(imagery.height > 16)) {
    return { features, carved: 0 };
  }
  const out = [];
  let carved = 0;
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (feature.properties && feature.properties.buildingPart) {
      out.push(feature);
      continue;
    }
    if (heightOf(feature) >= 30) {
      out.push(feature);
      continue;
    }
    const rings = exteriorsOf(feature);
    if (rings.length !== 1) {
      out.push(feature);
      continue;
    }
    const area = meterArea(rings[0]);
    if (!(area >= 30000)) {
      out.push(feature);
      continue;
    }
    const closed = closeRing(rings[0]);
    const proj = closed ? projectionFor([closed]) : null;
    const meters = closed && proj ? toMeters(closed, proj) : null;
    const open = meters ? meters.slice(0, -1) : null;
    const fill = open ? wallAlignedFill(open) : 1;
    const sprawling =
      open &&
      fill < 0.62 &&
      (open.length > 80 || coarseWedge(closed) || wedgeCoversGround(closed, ground));
    if (!sprawling) {
      out.push(feature);
      continue;
    }
    const cores = twinRoofCores(closed, imagery, area);
    if (!cores) {
      out.push(feature);
      continue;
    }
    const pieces = [];
    for (let c = 0; c < cores.length; c++) {
      if (wedgeCoversGround(cores[c], ground)) continue;
      if (meterArea(cores[c]) < 4000) continue;
      const next = featureWithRing(feature, cores[c], feature.properties && feature.properties.keepOut);
      next.properties.roofCore = true;
      if (!(heightOf(next) >= 15)) {
        next.properties.height = 18;
        if (!next.properties.heightSource) next.properties.heightSource = "overture";
      }
      pieces.push(next);
    }
    const keepOut = feature.properties && feature.properties.keepOut;
    if (pieces.length < 2) {
      if (coarseWedge(closed) || wedgeCoversGround(closed, ground)) {
        const bodies = bodyFeatures(feature, closed, osmRings, [], keepOut);
        if (bodies.length) {
          for (let b = 0; b < bodies.length; b++) out.push(bodies[b]);
          continue;
        }
      }
      out.push(feature);
      continue;
    }
    const coreRings = [];
    for (let c = 0; c < pieces.length; c++) coreRings.push(pieces[c].geometry.coordinates[0]);
    const bodies = bodyFeatures(feature, closed, osmRings, coreRings, keepOut);
    const emitted = [];
    for (let b = 0; b < bodies.length; b++) emitted.push(bodies[b]);
    for (let c = 0; c < pieces.length; c++) emitted.push(pieces[c]);
    let dirty = false;
    for (let e = 0; e < emitted.length && !dirty; e++) {
      const rings = exteriorsOf(emitted[e]);
      if (rings.length === 1 && diagonalCut(rings[0])) dirty = true;
    }
    // A diagonal slab is not a roof. Keep the street-map ring whole.
    if (dirty) {
      const host = osmHostRing(closed, osmRings) || (!coarseWedge(closed) ? closed : null);
      if (host) {
        out.push(seatLowRise(feature, host, keepOut));
        continue;
      }
      let keptAny = false;
      for (let e = 0; e < emitted.length; e++) {
        const rings = exteriorsOf(emitted[e]);
        if (rings.length === 1 && diagonalCut(rings[0])) continue;
        out.push(emitted[e]);
        keptAny = true;
      }
      if (!keptAny) out.push(feature);
      continue;
    }
    if (!bodies.length) noteLargeDrop(notes, area, "roof cores replaced the outline");
    carved++;
    for (let e = 0; e < emitted.length; e++) out.push(emitted[e]);
  }
  return { features: out, carved };
}

/**
 * Add OSM parts, open pools and courtyards, and keep a part that is the
 * detailed footprint of a same-height wing. A tower stays on its podium.
 * A triangular copy of a concave building takes that building's outline.
 * A roof-core carve that leaves a diagonal wedge is dropped and the
 * street-map ring is kept whole. A diagonal slab in the notch beside that
 * ring is left out. A sprawling outline with two clean roof tones still
 * becomes those two blocks.
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
  const ground = {
    openings,
    roads: (detail && detail.roads) || [],
  };
  const largeDrops = [];
  const osmRings = (detail && detail.buildings) || [];
  const carved = carveTwinRoofs(list, detail && detail.imagery, ground, osmRings, largeDrops);
  const repaired = repairCoarseWedges(carved.features, osmRings, ground, largeDrops);
  const coreRings = [];
  for (let i = 0; i < repaired.features.length; i++) {
    if (!(repaired.features[i].properties && repaired.features[i].properties.roofCore)) continue;
    const rings = exteriorsOf(repaired.features[i]);
    for (let r = 0; r < rings.length; r++) coreRings.push(rings[r]);
  }
  const keptParts = [];
  for (let i = 0; i < partFeatures.length; i++) {
    const part = partFeatures[i];
    if (heightOf(part) >= 24) {
      keptParts.push(part);
      continue;
    }
    const rings = exteriorsOf(part);
    let covered = false;
    for (let a = 0; a < rings.length && !covered; a++) {
      for (let b = 0; b < coreRings.length && !covered; b++) {
        if (mostlyInside(rings[a], coreRings[b])) covered = true;
      }
    }
    if (!covered) keptParts.push(part);
  }
  const withParts = repaired.features.concat(keptParts);
  let notched = 0;
  const opened = [];
  for (let i = 0; i < withParts.length; i++) {
    const before = exteriorsOf(withParts[i]).length;
    const pieces = withParts[i].properties && withParts[i].properties.roofCore
      ? [withParts[i]]
      : notchFeature(withParts[i], openings);
    if (pieces.length !== before || (pieces[0] && pieces[0] !== withParts[i] && pieces[0].properties && pieces[0].properties.keepOut)) {
      notched++;
    }
    for (let p = 0; p < pieces.length; p++) opened.push(pieces[p]);
  }
  const cut = subtractSameHeightParts(opened, largeDrops);
  const dropped = dropParentsOverOpenings(cut, openings, largeDrops);
  const trimmed = trimTaperedFootprints(dropped.features);
  const notches = dropDiagonalNotches(trimmed.features, osmRings);
  const filled = fillMissingOsmFootprints(notches.features, osmRings);
  return {
    features: filled.features,
    stats: {
      parts: keptParts.length,
      openings: openings.length,
      notched,
      parentsDropped: dropped.dropped,
      wedgesReplaced: repaired.replaced,
      wedgesDropped: repaired.dropped + notches.dropped,
      coresCarved: carved.carved,
      tapersCut: trimmed.cut,
      pieces: filled.features.length,
      osmFilled: filled.added,
      largeDrops: largeDrops,
    },
  };
}

/**
 * Street-map buildings the footprint sources missed. A cabin or a bathhouse
 * with no overlapping roof is added at one floor. A ring that already sits
 * on an emitted roof stays out, so a motel wing is not drawn twice. A shed
 * under 25 m² and a complex over 2500 m² stay out.
 */
const OSM_FILL_MIN_M2 = 25;
const OSM_FILL_MAX_M2 = 2500;
const OSM_FILL_COVER = 0.12;

function fillMissingOsmFootprints(features, osmRings) {
  const list = features || [];
  const rings = osmRings || [];
  if (!rings.length) return { features: list, added: 0 };
  const existing = [];
  for (let i = 0; i < list.length; i++) {
    const ext = exteriorsOf(list[i]);
    for (let k = 0; k < ext.length; k++) existing.push(ext[k]);
  }
  const out = list.slice();
  let added = 0;
  for (let i = 0; i < rings.length; i++) {
    const closed = closeRing(rings[i]);
    if (!closed || closed.length < 4) continue;
    const area = meterArea(closed);
    if (!(area >= OSM_FILL_MIN_M2 && area <= OSM_FILL_MAX_M2)) continue;
    let covered = false;
    for (let e = 0; e < existing.length && !covered; e++) {
      const inter = intersectionArea(closed, existing[e]);
      if (area > 0 && inter / area >= OSM_FILL_COVER) covered = true;
    }
    if (covered) continue;
    out.push({
      type: "Feature",
      properties: { height: 4.5, heightSource: "osm", geomSource: "osm-building" },
      geometry: { type: "Polygon", coordinates: [closed] },
    });
    existing.push(closed);
    added++;
  }
  return { features: out, added };
}

/**
 * A diagonal slab parked in the notch of a large street-map outline is the
 * carve, not a roof. The outline itself stays. A lone triangle with no
 * large outline beside it stays.
 */
function dropDiagonalNotches(features, osmRings) {
  const hosts = [];
  for (let i = 0; i < (osmRings || []).length; i++) {
    const closed = closeRing(osmRings[i]);
    if (!closed || coarseWedge(closed)) continue;
    if (meterArea(closed) < 25000) continue;
    hosts.push(closed);
  }
  if (!hosts.length) return { features, dropped: 0 };
  const hostBoxes = [];
  for (let i = 0; i < hosts.length; i++) hostBoxes.push(ringBbox(hosts[i]));
  const out = [];
  let dropped = 0;
  const restore = [];
  for (let i = 0; i < features.length; i++) {
    const rings = exteriorsOf(features[i]);
    if (rings.length !== 1 || !diagonalCut(rings[0])) {
      out.push(features[i]);
      continue;
    }
    const area = meterArea(rings[0]);
    if (!(area <= 15000)) {
      out.push(features[i]);
      continue;
    }
    const box = ringBbox(rings[0]);
    const ratio = ringTriRatio(rings[0]);
    let hostAt = -1;
    let notch = false;
    for (let h = 0; h < hosts.length; h++) {
      if (!bboxHits(box, hostBoxes[h])) continue;
      const inter = intersectionArea(rings[0], hosts[h]);
      // A slab in the notch, or a carve that is already a triangle over the ring.
      if (inter / area < 0.5 || ratio >= 0.9) {
        hostAt = h;
        notch = true;
        break;
      }
    }
    if (!notch) {
      out.push(features[i]);
      continue;
    }
    dropped++;
    if (hostAt >= 0 && restore.indexOf(hostAt) < 0) restore.push(hostAt);
  }
  // The street-map ring replaces the slab. Low-rise fragments of that ring
  // would draw a second podium, so they come out with the slab.
  for (let r = 0; r < restore.length; r++) {
    const host = hosts[restore[r]];
    const hostArea = meterArea(host);
    const kept = [];
    let template = null;
    for (let i = 0; i < out.length; i++) {
      const feature = out[i];
      if (heightOf(feature) >= 30) {
        kept.push(feature);
        continue;
      }
      const rings = exteriorsOf(feature);
      let inside = false;
      for (let k = 0; k < rings.length && !inside; k++) {
        const part = meterArea(rings[k]);
        if (!(part > 0) || part > hostArea * 0.85) continue;
        const inter = intersectionArea(rings[k], host);
        if (inter / part >= 0.7) inside = true;
      }
      if (inside) {
        if (!template) template = feature;
        dropped++;
        continue;
      }
      kept.push(feature);
    }
    let already = false;
    for (let i = 0; i < kept.length && !already; i++) {
      const rings = exteriorsOf(kept[i]);
      for (let k = 0; k < rings.length && !already; k++) {
        const part = meterArea(rings[k]);
        if (part < hostArea * 0.7) continue;
        const inter = intersectionArea(rings[k], host);
        if (inter / hostArea >= 0.7) already = true;
      }
    }
    if (!already) {
      const base = template || {
        type: "Feature",
        properties: { height: 12, heightSource: "overture" },
        geometry: { type: "Polygon", coordinates: [host] },
      };
      kept.push(seatLowRise(base, host, base.properties && base.properties.keepOut));
    }
    out.length = 0;
    for (let i = 0; i < kept.length; i++) out.push(kept[i]);
  }
  return { features: out, dropped };
}

/**
 * A campus outline that runs out to a point is not a roof over that point.
 * Cut a narrow end off a large low-rise footprint and keep the thick body.
 * A tower is left alone. A trimmed low-rise with no measured height above
 * 15 m is seated at 18 m, in the range of these blocks.
 */
function trimTaperedFootprints(features) {
  const out = [];
  let cut = 0;
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const h = heightOf(feature);
    if (h >= 30 || (feature.properties && feature.properties.roofCore)) {
      out.push(feature);
      continue;
    }
    const rings = exteriorsOf(feature);
    if (rings.length !== 1) {
      out.push(feature);
      continue;
    }
    const pieces = trimTaperedRing(rings[0]);
    if (pieces.length === 1 && sameRing(pieces[0], rings[0])) {
      out.push(feature);
      continue;
    }
    cut++;
    for (let p = 0; p < pieces.length; p++) {
      const next = featureWithRing(feature, pieces[p], feature.properties && feature.properties.keepOut);
      const ph = heightOf(next);
      if (!(ph >= 15)) {
        next.properties.height = 18;
        if (!next.properties.heightSource) next.properties.heightSource = "overture";
      }
      out.push(next);
    }
  }
  return { features: out, cut };
}

function sameRing(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const n = Math.min(6, a.length);
  for (let i = 0; i < n; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

/** Wall direction with the most edge length, as a unit vector in meters. */
function dominantWallAxis(open) {
  const bins = 36;
  const hist = new Array(bins).fill(0);
  for (let i = 0; i < open.length; i++) {
    const a = open[i];
    const b = open[(i + 1) % open.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 6) continue;
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 180;
    if (deg >= 180) deg -= 180;
    hist[Math.min(bins - 1, Math.floor(deg / 5))] += len;
  }
  let best = 0;
  let at = 0;
  for (let i = 0; i < bins; i++) {
    if (hist[i] > best) {
      best = hist[i];
      at = i;
    }
  }
  if (!(best >= 40)) return null;
  const rad = ((at * 5 + 2.5) * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

function widthAlong(open, ux, uy) {
  let minA = Infinity;
  let maxA = -Infinity;
  for (let i = 0; i < open.length; i++) {
    const a = open[i][0] * ux + open[i][1] * uy;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }
  const len = maxA - minA;
  if (!(len >= 80)) return null;
  const px = -uy;
  const py = ux;
  const samples = 48;
  const widths = [];
  const poss = [];
  for (let s = 1; s < samples - 1; s++) {
    const t = minA + ((s + 0.5) / samples) * len;
    const hits = [];
    for (let i = 0; i < open.length; i++) {
      const a = open[i];
      const b = open[(i + 1) % open.length];
      const aa = a[0] * ux + a[1] * uy;
      const ba = b[0] * ux + b[1] * uy;
      if ((aa <= t && ba > t) || (ba <= t && aa > t)) {
        const u = (t - aa) / (ba - aa || 1e-9);
        const ay = a[0] * px + a[1] * py;
        const by = b[0] * px + b[1] * py;
        hits.push(ay + u * (by - ay));
      }
    }
    hits.sort((p, q) => p - q);
    let w = 0;
    for (let i = 0; i + 1 < hits.length; i += 2) w += hits[i + 1] - hits[i];
    widths.push(w);
    poss.push(t);
  }
  return { minA, len, widths, poss };
}

/**
 * Cut a narrow end off when it runs at least 45 m before the outline
 * reaches the thick body. The axis is the long walls, not the two
 * corners farthest apart, so a spike beside a rectangle is removed.
 */
function taperCuts(profile) {
  if (!profile || profile.widths.length < 8) return null;
  const ranked = profile.widths.slice().sort((p, q) => p - q);
  const plateau = ranked[Math.floor(ranked.length * 0.72)] || 0;
  if (!(plateau >= 36)) return null;
  const body = plateau * 0.72;
  const widths = profile.widths;
  const poss = profile.poss;
  let lo = null;
  for (let i = 0; i < widths.length - 2; i++) {
    if (widths[i] >= body && widths[i + 1] >= body && widths[i + 2] >= body) {
      lo = i;
      break;
    }
  }
  let hi = null;
  for (let i = widths.length - 1; i >= 2; i--) {
    if (widths[i] >= body && widths[i - 1] >= body && widths[i - 2] >= body) {
      hi = i;
      break;
    }
  }
  const endLo = widths[0];
  const endHi = widths[widths.length - 1];
  const runLo = lo == null ? 0 : poss[lo] - profile.minA;
  const runHi = hi == null ? 0 : profile.minA + profile.len - poss[hi];
  // A wing that is still tens of metres wide is a building. Only a point is cut.
  const cutLo = lo != null && runLo >= 45 && endLo < body * 0.45 && endLo < 28;
  const cutHi = hi != null && runHi >= 45 && endHi < body * 0.45 && endHi < 28;
  if (!cutLo && !cutHi) return null;
  return {
    keep0: cutLo ? poss[lo] : profile.minA,
    keep1: cutHi ? poss[hi] : profile.minA + profile.len,
    removed: (cutLo ? runLo : 0) + (cutHi ? runHi : 0),
  };
}

function clipMetersSlab(meters, proj, origin, ux, uy, keep0, keep1) {
  const px = -uy;
  const py = ux;
  const pad = Math.max(400, Math.abs(keep1 - keep0) * 3);
  const at = (along, perp) => [origin[0] + along * ux + perp * px, origin[1] + along * uy + perp * py];
  const slab = orient(
    [at(keep0, -pad), at(keep1, -pad), at(keep1, pad), at(keep0, pad), at(keep0, -pad)],
    true
  );
  const subject = orient(meters, true);
  if (!slab || !subject) return null;
  let multi;
  try {
    multi = polygonClipping.intersection([[subject]], [[slab]]);
  } catch {
    return null;
  }
  const out = [];
  for (let i = 0; i < (multi || []).length; i++) {
    const outer = multi[i] && multi[i][0];
    if (!outer || Math.abs(signedArea(outer)) < 800) continue;
    const ll = toLonLat(outer, proj);
    if (ll && meterArea(ll) >= 800) out.push(ll);
  }
  return out.length ? out : null;
}

function trimTaperedRing(ring, allowLarge) {
  const closed = closeRing(ring);
  const area = closed ? meterArea(closed) : 0;
  // A full block like Encore stays whole. A coarse wedge may be trimmed
  // at any size, and that trim is never a convex hull.
  if (!closed || area < 15000) return closed ? [closed] : [];
  if (!allowLarge && area >= 25000) return [closed];
  const proj = projectionFor([closed]);
  const meters = toMeters(closed, proj);
  if (!meters) return [closed];
  const open = meters.slice(0, -1);
  // A near-rectangular roof is not a spike over open ground.
  if (wallAlignedFill(open) >= 0.62) return [closed];
  const axis = dominantWallAxis(open);
  if (!axis) return [closed];
  const axes = [
    axis,
    [-axis[1], axis[0]],
  ];
  let best = null;
  for (let a = 0; a < axes.length; a++) {
    const profile = widthAlong(open, axes[a][0], axes[a][1]);
    const cut = taperCuts(profile);
    if (!cut) continue;
    if (!best || cut.removed > best.cut.removed) best = { axis: axes[a], cut };
  }
  if (!best || !(best.cut.keep1 - best.cut.keep0 >= 40)) return [closed];
  const pieces = clipMetersSlab(meters, proj, [0, 0], best.axis[0], best.axis[1], best.cut.keep0, best.cut.keep1);
  if (!pieces) return [closed];
  let kept = 0;
  for (let i = 0; i < pieces.length; i++) kept += meterArea(pieces[i]);
  if (!(kept > 0) || kept > meterArea(closed) * 0.97) return [closed];
  return pieces;
}

module.exports = {
  CORRIDOR_M,
  buildingDetailQuery,
  parseBuildingDetail,
  detailFromMapXml,
  fetchBuildingDetail,
  footprintRings,
  shapeBuildings,
  subtractHolesLL,
  pointInRingLL,
  centroidLL,
};
