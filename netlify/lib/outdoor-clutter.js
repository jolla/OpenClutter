"use strict";

/**
 * Outdoor clutter for Wi-Fi and AFC links: water, parking structures,
 * walls and fences, light poles, and elevated rail guideways.
 *
 * One Overpass query, clipped to the drawn box the same way buildings are.
 * Overture building class/subtype is not a parquet column. Adding it can
 * fail the Vegas read when the field is absent. A footprint that already
 * carries class or subtype "parking" is recolored instead of drawn twice.
 *
 * An RV park (tourism=caravan_site or camp_site) gets one metal box per
 * mapped pitch. With no pitches, boxes sit on both sides of the internal
 * roads, about 12 m apart. A static caravan stays a building.
 *
 * A surface parking lot is a 2.1 m car layer. A multi-storey garage or
 * building=parking stays about 9 m and can recolor a footprint that already
 * covers it. An underground lot is left out.
 *
 * Attenuation is 5 GHz dB/m, documented on the materials next to buildings.
 * OpenIntent has no reflection field. Water is a 0.1 m sheet at 0.1 dB/m,
 * not a mirror. OpenIntent top and bottom heights are minimum 0, so the
 * sheet cannot extend below the floor. On a slope its top is 0.1 m above
 * the terrain seat. A water polygon is cut back where an emitted building
 * covers it, including a dark panel roof, so the sheet never sits on that
 * roof. A chain-link fence is about 1.8 m in the field. A
 * custom under or equal to 2 m does not import, so the fence is 2.1 m.
 */

const { llToPx, pxToLl } = require("./geo-frame");
const { fetchOsmMaps, ringKey, bboxSpanM, TILE_SPAN_M } = require("./osm-tiles");
const { intersectionAreaPx, ringsMinus } = require("./poly-clip");
const { LIFT_LOCAL_M } = require("./terrain");
const { outdoorMaterial, liftedOutdoorMaterial } = require("./materials");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const FETCH_MS = 3200;
const POLE_CAP = 48;
const WALL_CAP = 80;
const WATER_CAP = 12;
const PARKING_CAP = 20;
const GUIDEWAY_CAP = 40;
/** Segments kept for one beam. A 3 km monorail is more than one strip. */
const GUIDEWAY_SEGMENT_CAP = 80;
const BRIDGE_CAP = 40;
const BRIDGE_SEGMENT_CAP = 40;
const FOOTBRIDGE_SEGMENT_CAP = 12;
const BRIDGE_MIN_M = 10;
const BRIDGE_DECK_M = 6.5;
const BRIDGE_THICK_M = 2.1;
const POLE_SIDES = 10;
const POLE_DIAMETER_M = 0.3;
const POLE_HEIGHT_M = 9;
/** Monorail beam plus the train. Double-track light rail is wider. */
const MONORAIL_WIDTH_M = 3;
const RAIL_WIDTH_M = 8.5;
const SINGLE_TRACK_WIDTH_M = 4.5;
const MONORAIL_DECK_M = 6.5;
const RAIL_DECK_M = 6;
const GUIDEWAY_THICK_M = 4.5;
/** Centerline points per strip. The buffer stays under the 40 vertex cap. */
const GUIDEWAY_CHUNK = 8;

/** One trailer. 12 by 2.6 m in plan, 3.5 m tall, metal shell. */
const RV_LENGTH_M = 12;
const RV_WIDTH_M = 2.6;
const RV_HEIGHT_M = 3.5;
const RV_SPACING_M = 12;
const RV_ROAD_OFFSET_M = 4;
const RV_DEDUPE_M = 8;
/** A mapped campground can pass 400 pitches. The cap used to drop the last row. */
const RV_CAP = 800;
const RV_ROAD_SEARCH_M = 40;
const RV_ROADS = { service: true, track: true, living_street: true, residential: true, unclassified: true };

const RAIL_TYPES = { monorail: true, light_rail: true, subway: true, rail: true, tram: true };

const THICK_M = { wall: 0.4, fence: 0.15, retaining: 0.5, hedge: 0.6 };
const LINE_KINDS = { wall: true, fence: true, retaining: true, hedge: true };

const OUTDOOR_MISS = "Outdoor clutter did not return. Export again.";

function wantAny(want) {
  return !!(want && (want.water || want.parking || want.walls || want.poles || want.rvs));
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
    parts.push('way["amenity"="parking"](' + box + ");");
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
  if (want.rvs) {
    parts.push('way["tourism"="caravan_site"](' + box + ");");
    parts.push('relation["tourism"="caravan_site"](' + box + ");");
    parts.push('way["tourism"="camp_site"](' + box + ");");
    parts.push('relation["tourism"="camp_site"](' + box + ");");
    parts.push('node["tourism"="camp_pitch"](' + box + ");");
    parts.push('way["tourism"="camp_pitch"](' + box + ");");
    parts.push('way["highway"~"^(service|track|living_street|residential|unclassified)$"](' + box + ");");
  }
  parts.push('way["railway"~"^(monorail|light_rail|subway|rail|tram)$"](' + box + ");");
  parts.push('way["highway"]["bridge"~"^(yes|viaduct|covered)$"](' + box + ");");
  parts.push('way["highway"]["layer"~"^[1-9]"](' + box + ");");
  parts.push('way["man_made"="bridge"](' + box + ");");
  parts.push('way["bridge"="viaduct"](' + box + ");");
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

/** Closed ways stay as rings. Open pieces of a multipolygon are stitched. */
function closedRingsFromLines(lines) {
  const rings = [];
  const open = [];
  for (let i = 0; i < (lines || []).length; i++) {
    const coords = lines[i];
    if (!coords || coords.length < 2) continue;
    if (isClosed(coords)) rings.push(coords);
    else open.push(coords);
  }
  if (open.length) {
    const chains = stitchChains(open);
    for (let i = 0; i < chains.length; i++) {
      if (isClosed(chains[i])) rings.push(chains[i]);
    }
  }
  return rings;
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
  if (kind === "water") return 0.1;
  return 0;
}

function heightFor(kind, tags) {
  const explicit = parseMeters(tags && tags.height);
  if (kind === "parking") {
    if (explicit > 2) return { heightM: explicit, explicitHeight: true };
    const levels = parseLevels(tags || {});
    if (levels) return { heightM: levels * 3, explicitHeight: true };
    if (parkingStructure(tags)) return { heightM: 9, explicitHeight: false };
    return { heightM: 2.1, explicitHeight: false };
  }
  if (kind === "water") return { heightM: 0.1, explicitHeight: false };
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

function parkingStructure(tags) {
  if (!tags) return false;
  return tags.parking === "multi-storey" || tags.building === "parking";
}

function isParkingWay(tags) {
  if (!tags) return false;
  if (tags.parking === "underground" || tags.location === "underground") return false;
  if (tags.amenity === "parking") return true;
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

function railType(tags) {
  const kind = tags && tags.railway;
  return RAIL_TYPES[kind] ? kind : "";
}

function layerOf(tags) {
  const n = Number(tags && tags.layer);
  return Number.isFinite(n) ? n : 0;
}

function isBuried(tags) {
  if (!tags) return false;
  const tunnel = tags.tunnel;
  if (tunnel && tunnel !== "no") return true;
  if (tags.location === "underground") return true;
  if (layerOf(tags) < 0) return true;
  return false;
}

function isElevatedTag(tags) {
  const bridge = String((tags && tags.bridge) || "");
  if (bridge === "yes" || bridge === "viaduct" || bridge === "covered") return true;
  return layerOf(tags) >= 1;
}

/** Monorail is a beam. Other rail counts only on a bridge or an upper layer. */
function isGuidewayRail(tags) {
  const kind = railType(tags);
  if (!kind || isBuried(tags)) return false;
  if (kind === "monorail") return true;
  return isElevatedTag(tags);
}

/** A building or skywalk with levels stays a building. It is not a rail deck. */
function isStructureNotDeck(tags) {
  if (!tags) return false;
  if (tags.building || tags["building:part"]) return true;
  if (tags["building:levels"] || tags["building:min_level"]) return true;
  return false;
}

function isBridgeOutlineTags(tags) {
  if (!tags || isBuried(tags) || isStructureNotDeck(tags)) return false;
  if (tags.man_made === "bridge") return true;
  if (tags.bridge === "viaduct") return true;
  return false;
}

function levelMeters(raw) {
  const n = Number(raw);
  if (!(n >= 1 && n <= 40)) return 0;
  return n * 3;
}

function explicitDeck(tags) {
  const t = tags || {};
  if (parseMeters(t.min_height || t["building:min_height"]) > 1) return true;
  if (levelMeters(t["building:min_level"] != null ? t["building:min_level"] : t.min_level) > 0) return true;
  if (levelMeters(t.level) > 0) return true;
  if (parseMeters(t.height || t["building:height"]) > 2) return true;
  return false;
}

function guidewayDeckM(tags) {
  const t = tags || {};
  const minH = parseMeters(t.min_height || t["building:min_height"]);
  const minLevel = levelMeters(t["building:min_level"] != null ? t["building:min_level"] : t.min_level);
  const level = levelMeters(t.level);
  const explicit = minH > 1 ? minH : minLevel > 0 ? minLevel : level > 0 ? level : 0;
  if (explicit > 0) return Math.round(explicit * 10) / 10;
  const height = parseMeters(t.height || t["building:height"]);
  if (height > 2 && height < 40) return Math.round(height * 10) / 10;
  return railType(t) === "monorail" ? MONORAIL_DECK_M : RAIL_DECK_M;
}

function guidewayThicknessM(tags) {
  const t = tags || {};
  const height = parseMeters(t.height || t["building:height"]);
  const minH = parseMeters(t.min_height || t["building:min_height"]);
  if (height > 2 && minH > 0 && height > minH + 2) {
    const span = Math.round((height - minH) * 10) / 10;
    if (span > 2 && span < 20) return span;
  }
  return GUIDEWAY_THICK_M;
}

function guidewayWidthM(tags) {
  if (railType(tags) === "monorail") return MONORAIL_WIDTH_M;
  const tracks = Number(String((tags && tags.tracks) || "").split(/[;,]/)[0]);
  if (tracks === 1) return SINGLE_TRACK_WIDTH_M;
  return RAIL_WIDTH_M;
}

function pointInRing(pt, ring) {
  if (!pt || !ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    const xi = ring[i][0];
    const xj = ring[j][0];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function lineMostlyInside(line, ring) {
  if (!line || line.length < 2 || !ring || ring.length < 4) return false;
  let hit = 0;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (i === line.length - 1 && nearPt(line[i], line[0])) continue;
    n++;
    if (pointInRing(line[i], ring)) hit++;
  }
  return n > 0 && hit / n >= 0.6;
}

function lineTouchesRing(line, ring) {
  if (!line || !ring) return false;
  for (let i = 0; i < line.length; i++) {
    if (pointInRing(line[i], ring)) return true;
  }
  return false;
}

function makeGuidewayFeature(tags, coords, closed) {
  const deck = guidewayDeckM(tags);
  const thick = guidewayThicknessM(tags);
  let ring = coords;
  if (closed) {
    const open = isClosed(coords) ? coords.slice(0, -1) : coords.slice();
    const thin = open.length > 32 ? subsample(open, 32) : open;
    if (thin.length >= 3) {
      ring = thin.slice();
      ring.push(ring[0]);
    }
  }
  return {
    kind: "guideway",
    coords: ring,
    closed: !!closed,
    heightM: thick,
    thicknessM: thick,
    deckM: deck,
    widthM: closed ? 0 : guidewayWidthM(tags),
    explicitHeight: true,
    rank: 0,
  };
}

/**
 * Elevated rail only. A monorail beam is included. Other rail needs a bridge
 * or layer at or above 1. A bridge polygon replaces the buffered centerline
 * when the beam runs through that outline. A pedestrian skywalk stays a building.
 */
function guidewayFeatures(records, bbox, cap) {
  const lines = [];
  const polygons = [];
  const list = records || [];
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (!rec || !rec.coords || rec.coords.length < 2) continue;
    const tags = rec.tags || {};
    if (bbox && !anyInBox(rec.coords, bbox)) continue;
    const closed = isClosed(rec.coords);
    if (closed && isGuidewayRail(tags)) {
      polygons.push({ tags, coords: rec.coords, rail: true });
      continue;
    }
    if (closed && isBridgeOutlineTags(tags)) {
      polygons.push({ tags, coords: rec.coords, rail: false });
      continue;
    }
    if (!closed && isGuidewayRail(tags)) lines.push({ tags, coords: rec.coords });
  }
  const keptPolys = [];
  for (let i = 0; i < polygons.length; i++) {
    const poly = polygons[i];
    if (poly.rail) {
      keptPolys.push(poly);
      continue;
    }
    for (let k = 0; k < lines.length; k++) {
      if (lineTouchesRing(lines[k].coords, poly.coords)) {
        keptPolys.push(poly);
        break;
      }
    }
  }
  const features = [];
  for (let i = 0; i < keptPolys.length; i++) {
    let coords = keptPolys[i].coords;
    if (bbox && !fullyInside(coords, bbox)) {
      const clipped = clipClosedRing(coords, bbox);
      if (!clipped.length) continue;
      coords = clipped[0];
    }
    let tags = keptPolys[i].tags;
    if (!explicitDeck(tags) && railType(tags) !== "monorail") {
      for (let k = 0; k < lines.length; k++) {
        if (railType(lines[k].tags) === "monorail" && lineTouchesRing(lines[k].coords, keptPolys[i].coords)) {
          tags = Object.assign({}, tags, { railway: "monorail" });
          break;
        }
      }
    }
    features.push(makeGuidewayFeature(tags, coords, true));
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let covered = false;
    for (let p = 0; p < keptPolys.length; p++) {
      if (lineMostlyInside(line.coords, keptPolys[p].coords)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const runs = bbox ? clipLineRuns(line.coords, bbox) : [line.coords];
    for (let r = 0; r < runs.length; r++) {
      if (runs[r].length < 2) continue;
      features.push(makeGuidewayFeature(line.tags, runs[r], false));
    }
  }
  const limit = cap > 0 ? cap | 0 : GUIDEWAY_CAP;
  if (features.length <= limit) return features;
  const sorted = features.slice().sort((a, b) => lineLength(b.coords) - lineLength(a.coords));
  return sorted.slice(0, limit);
}

function isFootHighway(tags) {
  const hw = String((tags && tags.highway) || "");
  return (
    hw === "footway" ||
    hw === "path" ||
    hw === "pedestrian" ||
    hw === "steps" ||
    hw === "cycleway" ||
    hw === "corridor" ||
    hw === "bridleway"
  );
}

/** A road deck. Culverts and tunnels are not overpasses. */
function isRoadBridgeWay(tags) {
  if (!tags || !tags.highway || isBuried(tags) || isStructureNotDeck(tags)) return false;
  if (tags.bridge === "culvert" || tags.bridge === "no") return false;
  if (tags.bridge === "yes" || tags.bridge === "viaduct" || tags.bridge === "covered") return true;
  return layerOf(tags) >= 1;
}

function isRoadDeckPolygon(tags) {
  if (!isBridgeOutlineTags(tags) || railType(tags)) return false;
  return true;
}

function spanMeters(coords) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const lon = coords[i][0];
    const lat = coords[i][1];
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLon)) return 0;
  const mid = (minLat + maxLat) / 2;
  const mLon = 111320 * Math.cos((mid * Math.PI) / 180);
  return Math.max((maxLon - minLon) * mLon, (maxLat - minLat) * 110540);
}

function bridgeDeckM(tags) {
  const t = tags || {};
  const minH = parseMeters(t.min_height || t["building:min_height"]);
  if (minH > 1) return Math.round(minH * 10) / 10;
  const minLevel = levelMeters(t["building:min_level"] != null ? t["building:min_level"] : t.min_level);
  if (minLevel > 0) return minLevel;
  const layer = layerOf(t);
  const n = layer >= 1 ? layer : 1;
  return Math.round(n * BRIDGE_DECK_M * 10) / 10;
}

function bridgeWidthM(tags) {
  const t = tags || {};
  const tagged = parseMeters(t.width);
  if (tagged >= 2 && tagged <= 45) return Math.round(tagged * 10) / 10;
  const lanes = Number(String(t.lanes || "").split(/[;,]/)[0]);
  const hw = String(t.highway || "");
  const foot = isFootHighway(t);
  if (lanes >= 1 && lanes <= 14) {
    const shoulder =
      foot ? 0 : hw === "motorway" || hw === "trunk" || hw === "motorway_link" || hw === "trunk_link" ? 3 : 2;
    return Math.round((lanes * 3.5 + shoulder) * 10) / 10;
  }
  if (hw === "motorway" || hw === "trunk") return 14;
  if (/_link$/.test(hw) || hw === "ramp") return 6;
  if (foot) return 2.5;
  if (hw === "primary") return 12;
  if (hw === "secondary") return 9;
  return 8;
}

function makeBridgeFeature(tags, coords, closed) {
  const deck = bridgeDeckM(tags);
  let ring = coords;
  if (closed) {
    const open = isClosed(coords) ? coords.slice(0, -1) : coords.slice();
    const thin = open.length > 32 ? subsample(open, 32) : open;
    if (thin.length >= 3) {
      ring = thin.slice();
      ring.push(ring[0]);
    }
  }
  return {
    kind: "bridge",
    coords: ring,
    closed: !!closed,
    heightM: BRIDGE_THICK_M,
    thicknessM: BRIDGE_THICK_M,
    deckM: deck,
    widthM: closed ? 0 : bridgeWidthM(tags),
    explicitHeight: true,
    foot: isFootHighway(tags),
    rank: 0,
  };
}

/**
 * Road overpasses. A highway with bridge=yes or viaduct, or layer at or
 * above 1. A man_made=bridge polygon replaces the centerline it covers.
 * A polygon the monorail already uses stays a guideway. Culverts and
 * spans under 10 m are left out. A footbridge is thin and optional.
 */
function bridgeFeatures(records, bbox, cap) {
  const lines = [];
  const polygons = [];
  const rails = [];
  const list = records || [];
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (!rec || !rec.coords || rec.coords.length < 2) continue;
    const tags = rec.tags || {};
    if (bbox && !anyInBox(rec.coords, bbox)) continue;
    const closed = isClosed(rec.coords);
    if (!closed && isGuidewayRail(tags)) rails.push(rec);
    if (closed && isRoadDeckPolygon(tags)) {
      if (spanMeters(rec.coords) < BRIDGE_MIN_M) continue;
      polygons.push({ tags, coords: rec.coords });
      continue;
    }
    if (!closed && isRoadBridgeWay(tags) && spanMeters(rec.coords) >= BRIDGE_MIN_M) {
      lines.push({ tags, coords: rec.coords });
    }
  }
  const keptPolys = [];
  for (let i = 0; i < polygons.length; i++) {
    let railDeck = false;
    for (let k = 0; k < rails.length; k++) {
      if (lineMostlyInside(rails[k].coords, polygons[i].coords)) {
        railDeck = true;
        break;
      }
    }
    if (!railDeck) keptPolys.push(polygons[i]);
  }
  const decks = [];
  for (let i = 0; i < keptPolys.length; i++) {
    let coords = keptPolys[i].coords;
    if (bbox && !fullyInside(coords, bbox)) {
      const clipped = clipClosedRing(coords, bbox);
      if (!clipped.length) continue;
      coords = clipped[0];
    }
    if (spanMeters(coords) < BRIDGE_MIN_M) continue;
    decks.push(makeBridgeFeature(keptPolys[i].tags, coords, true));
  }
  const roads = [];
  const feet = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let covered = false;
    for (let p = 0; p < keptPolys.length; p++) {
      if (lineMostlyInside(line.coords, keptPolys[p].coords)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const runs = bbox ? clipLineRuns(line.coords, bbox) : [line.coords];
    for (let r = 0; r < runs.length; r++) {
      if (runs[r].length < 2 || spanMeters(runs[r]) < BRIDGE_MIN_M) continue;
      const feat = makeBridgeFeature(line.tags, runs[r], false);
      if (feat.foot) feet.push(feat);
      else roads.push(feat);
    }
  }
  const features = decks.concat(roads, feet);
  const limit = cap > 0 ? cap | 0 : BRIDGE_CAP;
  if (features.length <= limit) return features;
  const roadsFirst = features.filter((f) => !f.foot);
  const footLast = features.filter((f) => f.foot);
  roadsFirst.sort((a, b) => lineLength(b.coords) - lineLength(a.coords));
  return roadsFirst.concat(footLast).slice(0, limit);
}

function fullyInside(coords, bbox) {
  for (let i = 0; i < coords.length; i++) {
    if (!inBox(coords[i][0], coords[i][1], bbox)) return false;
  }
  return true;
}

function guidewaysFromElements(elements, bbox, cap) {
  const records = [];
  const list = elements || [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!el || el.type !== "way") continue;
    const coords = wayCoords(el);
    if (coords.length < 2) continue;
    records.push({ tags: el.tags || {}, coords });
  }
  return guidewayFeatures(records, bbox, cap);
}

function bridgesFromElements(elements, bbox, cap) {
  const records = [];
  const list = elements || [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!el || el.type !== "way") continue;
    const coords = wayCoords(el);
    if (coords.length < 2) continue;
    records.push({ tags: el.tags || {}, coords });
  }
  return bridgeFeatures(records, bbox, cap);
}

function bridgesFromParsedWays(ways, nodes, bbox, cap) {
  const records = [];
  for (const way of ways.values()) {
    const coords = [];
    const refs = way.refs || [];
    for (let i = 0; i < refs.length; i++) {
      const node = nodes.get(refs[i]);
      if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) continue;
      const prev = coords[coords.length - 1];
      if (prev && prev[0] === node.lon && prev[1] === node.lat) continue;
      coords.push([node.lon, node.lat]);
    }
    if (coords.length >= 2) records.push({ tags: way.tags || {}, coords });
  }
  return bridgeFeatures(records, bbox, cap);
}

function guidewaysFromParsedWays(ways, nodes, bbox, cap) {
  const records = [];
  for (const way of ways.values()) {
    const coords = [];
    const refs = way.refs || [];
    for (let i = 0; i < refs.length; i++) {
      const node = nodes.get(refs[i]);
      if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) continue;
      const prev = coords[coords.length - 1];
      if (prev && prev[0] === node.lon && prev[1] === node.lat) continue;
      coords.push([node.lon, node.lat]);
    }
    if (coords.length >= 2) records.push({ tags: way.tags || {}, coords });
  }
  return guidewayFeatures(records, bbox, cap);
}

function isParkingClass(props) {
  if (!props) return false;
  const raw = String(props.class || props.subtype || props.buildingClass || "").toLowerCase();
  return raw === "parking" || raw === "parking_garage" || raw === "garage";
}

function isRvSiteTags(tags) {
  const tourism = tags && tags.tourism;
  return tourism === "caravan_site" || tourism === "camp_site";
}

function isRvPitchTags(tags) {
  return !!(tags && tags.tourism === "camp_pitch");
}

function isRvRoadTags(tags) {
  if (!tags || !RV_ROADS[tags.highway]) return false;
  if (tags.tunnel && tags.tunnel !== "no") return false;
  const layer = Number(tags.layer);
  if (Number.isFinite(layer) && layer < 0) return false;
  const bridge = tags.bridge;
  if (bridge === "yes" || bridge === "viaduct" || bridge === "covered") return false;
  return true;
}

function rvProject(lat) {
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return {
    to(lon, lat2) {
      return [lon * mLon, lat2 * 110540];
    },
    from(x, y) {
      return [x / mLon, y / 110540];
    },
  };
}

function ringCentroidLL(coords) {
  if (!coords || !coords.length) return null;
  let n = coords.length;
  const a = coords[0];
  const b = coords[n - 1];
  if (n > 1 && Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) n--;
  if (n < 1) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += coords[i][0];
    sy += coords[i][1];
  }
  return [sx / n, sy / n];
}

function pointInSite(pt, site) {
  if (!pointInRing(pt, site.coords)) return false;
  const holes = site.holes || [];
  for (let i = 0; i < holes.length; i++) {
    if (pointInRing(pt, holes[i])) return false;
  }
  return true;
}

function roadInsideSite(coords, site) {
  let inside = 0;
  let n = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i === coords.length - 1 && coords.length > 1) {
      const a = coords[i];
      const b = coords[0];
      if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) continue;
    }
    n++;
    if (pointInSite(coords[i], site)) inside++;
  }
  return inside >= 2 || (n > 0 && inside / n >= 0.6);
}

function rvRect(proj, x, y, ux, uy) {
  const hl = RV_LENGTH_M / 2;
  const hw = RV_WIDTH_M / 2;
  const px = -uy;
  const py = ux;
  const corners = [
    [x + ux * hl + px * hw, y + uy * hl + py * hw],
    [x - ux * hl + px * hw, y - uy * hl + py * hw],
    [x - ux * hl - px * hw, y - uy * hl - py * hw],
    [x + ux * hl - px * hw, y + uy * hl - py * hw],
  ];
  const ring = [];
  for (let i = 0; i < corners.length; i++) ring.push(proj.from(corners[i][0], corners[i][1]));
  ring.push(ring[0]);
  return ring;
}

function nearestRoadHeading(x, y, roads) {
  let best = null;
  let bestD = RV_ROAD_SEARCH_M * RV_ROAD_SEARCH_M;
  for (let r = 0; r < roads.length; r++) {
    const line = roads[r];
    for (let i = 1; i < line.length; i++) {
      const ax = line[i - 1][0];
      const ay = line[i - 1][1];
      const bx = line[i][0];
      const by = line[i][1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.25) continue;
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const ddx = x - px;
      const ddy = y - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD) {
        bestD = d2;
        const len = Math.sqrt(len2);
        best = { ux: dx / len, uy: dy / len };
      }
    }
  }
  return best;
}

function pitchHeading(coords, proj) {
  const pts = [];
  let n = coords.length;
  if (n > 1 && coords[0][0] === coords[n - 1][0] && coords[0][1] === coords[n - 1][1]) n--;
  for (let i = 0; i < n; i++) pts.push(proj.to(coords[i][0], coords[i][1]));
  let best = 0;
  let ux = 1;
  let uy = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const d = dx * dx + dy * dy;
      if (d > best) {
        best = d;
        const len = Math.sqrt(d) || 1;
        ux = dx / len;
        uy = dy / len;
      }
    }
  }
  return { ux, uy };
}

function tooNear(x, y, placed) {
  const lim = RV_DEDUPE_M * RV_DEDUPE_M;
  for (let i = 0; i < placed.length; i++) {
    const dx = x - placed[i].x;
    const dy = y - placed[i].y;
    if (dx * dx + dy * dy < lim) return true;
  }
  return false;
}

function pushRv(out, placed, proj, x, y, heading) {
  if (out.length >= RV_CAP) return false;
  if (tooNear(x, y, placed)) return false;
  const ring = rvRect(proj, x, y, heading.ux, heading.uy);
  placed.push({ x, y });
  out.push({
    kind: "rv",
    coords: ring,
    closed: true,
    heightM: RV_HEIGHT_M,
    explicitHeight: true,
    rank: 0,
  });
  return true;
}

function roadStations(line, spacing) {
  const stations = [];
  if (!line || line.length < 2) return stations;
  let carry = spacing * 0.5;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0];
    const ay = line[i - 1][1];
    const bx = line[i][0];
    const by = line[i][1];
    const dx = bx - ax;
    const dy = by - ay;
    const seg = Math.hypot(dx, dy);
    if (seg < 0.5) continue;
    const ux = dx / seg;
    const uy = dy / seg;
    let dist = carry;
    while (dist <= seg + 1e-6) {
      stations.push({ x: ax + ux * dist, y: ay + uy * dist, ux, uy });
      dist += spacing;
    }
    carry = dist - seg;
  }
  return stations;
}

/**
 * One metal box per pitch inside a caravan or camp site.
 * A site with no pitches gets a box every ~12 m on both sides of an internal road.
 */
function rvBoxes(features) {
  const sites = [];
  const pitches = [];
  const roads = [];
  for (let i = 0; i < (features || []).length; i++) {
    const f = features[i];
    if (!f) continue;
    if (f.kind === "rv-site" && f.coords && f.coords.length >= 4) sites.push(f);
    else if (f.kind === "rv-pitch" && f.coords && f.coords.length) pitches.push(f);
    else if (f.kind === "rv-road" && f.coords && f.coords.length >= 2) roads.push(f);
  }
  const boxes = [];
  if (!sites.length) return boxes;
  const usedPitch = new Set();
  for (let s = 0; s < sites.length && boxes.length < RV_CAP; s++) {
    const site = sites[s];
    const origin = ringCentroidLL(site.coords);
    if (!origin) continue;
    const proj = rvProject(origin[1]);
    const insidePitches = [];
    for (let p = 0; p < pitches.length; p++) {
      if (usedPitch.has(p)) continue;
      const pitch = pitches[p];
      const center = pitch.coords.length === 1 ? pitch.coords[0] : ringCentroidLL(pitch.coords);
      if (!center || !pointInSite(center, site)) continue;
      usedPitch.add(p);
      insidePitches.push({ pitch, center });
    }
    const siteRoads = [];
    for (let r = 0; r < roads.length; r++) {
      if (!roadInsideSite(roads[r].coords, site)) continue;
      const line = [];
      for (let k = 0; k < roads[r].coords.length; k++) {
        line.push(proj.to(roads[r].coords[k][0], roads[r].coords[k][1]));
      }
      if (line.length >= 2) siteRoads.push(line);
    }
    const placed = [];
    if (insidePitches.length) {
      for (let p = 0; p < insidePitches.length && boxes.length < RV_CAP; p++) {
        const item = insidePitches[p];
        const xy = proj.to(item.center[0], item.center[1]);
        let heading = nearestRoadHeading(xy[0], xy[1], siteRoads);
        if (!heading) heading = pitchHeading(item.pitch.coords, proj);
        pushRv(boxes, placed, proj, xy[0], xy[1], heading);
      }
      continue;
    }
    for (let r = 0; r < siteRoads.length && boxes.length < RV_CAP; r++) {
      const stations = roadStations(siteRoads[r], RV_SPACING_M);
      for (let i = 0; i < stations.length && boxes.length < RV_CAP; i++) {
        const st = stations[i];
        const heading = { ux: st.ux, uy: st.uy };
        const ox = -st.uy * RV_ROAD_OFFSET_M;
        const oy = st.ux * RV_ROAD_OFFSET_M;
        const sides = [
          [st.x + ox, st.y + oy],
          [st.x - ox, st.y - oy],
        ];
        for (let side = 0; side < sides.length && boxes.length < RV_CAP; side++) {
          const ll = proj.from(sides[side][0], sides[side][1]);
          if (!pointInSite(ll, site)) continue;
          pushRv(boxes, placed, proj, sides[side][0], sides[side][1], heading);
        }
      }
    }
  }
  return boxes;
}

/**
 * Overpass elements to clutter features. `want` drops types the page turned off.
 * `bbox` drops a way that never touches the drawn box.
 */
function parseOverpass(payload, want, bbox, deckCap) {
  const on = want || { water: true, parking: true, walls: true, poles: true };
  const elements = (payload && payload.elements) || [];
  const features = [];
  const railRecords = [];
  let openWater = 0;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tags = (el && el.tags) || {};
    if (el.type === "node") {
      const lon = +el.lon;
      const lat = +el.lat;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (bbox && !inBox(lon, lat, bbox)) continue;
      if (on.poles && isPoleNode(tags)) {
        const h = heightFor("pole", tags);
        features.push({
          kind: "pole",
          coords: [[lon, lat]],
          closed: false,
          heightM: h.heightM,
          explicitHeight: h.explicitHeight,
          rank: poleRank(tags),
        });
      } else if (on.rvs && isRvPitchTags(tags)) {
        features.push({
          kind: "rv-pitch",
          coords: [[lon, lat]],
          closed: false,
          heightM: RV_HEIGHT_M,
          explicitHeight: true,
          rank: 0,
        });
      }
      continue;
    }
    if (el.type === "relation") {
      if (on.rvs && isRvSiteTags(tags)) {
        const outerLines = [];
        const innerLines = [];
        const members = el.members || [];
        for (let m = 0; m < members.length; m++) {
          const mem = members[m];
          if (mem.type && mem.type !== "way") continue;
          const memberCoords = wayCoords(mem);
          if (memberCoords.length < 2) continue;
          if (mem.role === "inner") innerLines.push(memberCoords);
          else outerLines.push(memberCoords);
        }
        const outers = closedRingsFromLines(outerLines);
        const inners = closedRingsFromLines(innerLines);
        for (let o = 0; o < outers.length; o++) {
          if (bbox && !anyInBox(outers[o], bbox)) continue;
          features.push({
            kind: "rv-site",
            coords: outers[o],
            holes: inners,
            closed: true,
            heightM: 0,
            explicitHeight: false,
            rank: 0,
          });
        }
      }
      continue;
    }
    if (el.type !== "way") continue;
    const coords = wayCoords(el);
    if (coords.length < 2) continue;
    if (bbox && !anyInBox(coords, bbox)) continue;
    railRecords.push({ tags, coords });
    if (on.parking && isParkingWay(tags)) {
      if (!isClosed(coords)) continue;
      const h = heightFor("parking", tags);
      features.push({
        kind: "parking",
        coords,
        closed: true,
        heightM: h.heightM,
        explicitHeight: h.explicitHeight,
        structure: parkingStructure(tags),
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
      if (line.length >= 2) {
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
    if (on.rvs && isRvSiteTags(tags) && isClosed(coords)) {
      features.push({
        kind: "rv-site",
        coords,
        holes: [],
        closed: true,
        heightM: 0,
        explicitHeight: false,
        rank: 0,
      });
    }
    if (on.rvs && isRvPitchTags(tags)) {
      features.push({
        kind: "rv-pitch",
        coords,
        closed: isClosed(coords),
        heightM: RV_HEIGHT_M,
        explicitHeight: true,
        rank: 0,
      });
    }
    if (on.rvs && isRvRoadTags(tags)) {
      const line = isClosed(coords) ? coords.slice(0, -1) : coords.slice();
      if (line.length >= 2) {
        features.push({
          kind: "rv-road",
          coords: line,
          closed: false,
          heightM: 0,
          explicitHeight: false,
          rank: 0,
        });
      }
    }
  }
  const boxes = on.rvs ? rvBoxes(features) : [];
  const plain = [];
  for (let i = 0; i < features.length; i++) {
    const kind = features[i] && features[i].kind;
    if (kind === "rv-site" || kind === "rv-pitch" || kind === "rv-road") continue;
    plain.push(features[i]);
  }
  const guides = guidewayFeatures(railRecords, bbox, deckCap);
  const bridges = bridgeFeatures(railRecords, bbox, deckCap);
  return { features: plain.concat(boxes, guides, bridges), openWater };
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
function limitFeatures(features, bbox, deckCap) {
  const water = [];
  const parking = [];
  const walls = [];
  const poles = [];
  const guideways = [];
  const bridges = [];
  const rvs = [];
  for (let i = 0; i < (features || []).length; i++) {
    const f = features[i];
    if (!f) continue;
    if (f.kind === "water") water.push(f);
    else if (f.kind === "parking") parking.push(f);
    else if (f.kind === "pole") poles.push(f);
    else if (f.kind === "guideway") guideways.push(f);
    else if (f.kind === "bridge") bridges.push(f);
    else if (f.kind === "rv") rvs.push(f);
    else if (LINE_KINDS[f.kind]) walls.push(f);
  }
  const w = keepLargest(water, WATER_CAP);
  const p = keepLargest(parking, PARKING_CAP);
  const wallSorted = walls.slice().sort((a, b) => lineLength(b.coords) - lineLength(a.coords));
  const wallKept = wallSorted.slice(0, WALL_CAP);
  const pole = spreadPoles(poles, bbox || { west: -180, south: -90, east: 180, north: 90 }, POLE_CAP);
  const guideLimit = deckCap > 0 ? deckCap | 0 : GUIDEWAY_CAP;
  const bridgeLimit = deckCap > 0 ? deckCap | 0 : BRIDGE_CAP;
  const guideSorted = guideways.slice().sort((a, b) => lineLength(b.coords) - lineLength(a.coords));
  const guideKept = guideSorted.slice(0, guideLimit);
  const bridgeRoads = bridges.filter((f) => !f.foot).sort((a, b) => lineLength(b.coords) - lineLength(a.coords));
  const bridgeFeet = bridges.filter((f) => f.foot);
  const bridgeKept = bridgeRoads.concat(bridgeFeet).slice(0, bridgeLimit);
  const notes = [];
  if (w.capped) notes.push("Water capped at " + WATER_CAP + ".");
  if (p.capped) notes.push("Parking capped at " + PARKING_CAP + ".");
  if (wallSorted.length > wallKept.length) notes.push("Walls capped at " + WALL_CAP + ".");
  if (pole.capped) notes.push("Light poles capped at " + POLE_CAP + ".");
  if (guideSorted.length > guideKept.length) notes.push("Guideways capped at " + guideLimit + ".");
  if (bridges.length > bridgeKept.length) notes.push("Bridges capped at " + bridgeLimit + ".");
  const rvKept = rvs.slice(0, RV_CAP);
  if (rvs.length > rvKept.length) notes.push("RVs capped at " + RV_CAP + ".");
  return {
    features: w.kept.concat(p.kept, wallKept, pole.kept, guideKept, bridgeKept, rvKept),
    notes,
  };
}

function decodeXml(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tagAttrs(fragment) {
  const tags = {};
  const re = /<tag k="([^"]*)" v="([^"]*)"\s*\/>/g;
  let m;
  while ((m = re.exec(fragment))) tags[decodeXml(m[1])] = decodeXml(m[2]);
  return tags;
}

function startTag(xml, i) {
  const end = xml.indexOf(">", i);
  if (end < 0) return null;
  return xml.slice(i, end + 1);
}

function attr(tag, name) {
  const m = new RegExp("\\s" + name + '="([^"]*)"').exec(tag);
  return m ? m[1] : "";
}

/** OSM map XML to Overpass-shaped elements, with lake shores closed inside the box. */
function elementsFromMapXml(xml, bbox) {
  const text = String(xml || "");
  const nodes = new Map();
  const ways = new Map();
  const relations = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<node ", lt)) {
      const open = startTag(text, lt);
      if (!open) break;
      const id = attr(open, "id");
      const lat = +attr(open, "lat");
      const lon = +attr(open, "lon");
      if (open.endsWith("/>")) {
        if (id) nodes.set(id, { lon, lat, tags: {} });
        i = lt + open.length;
        continue;
      }
      const close = text.indexOf("</node>", lt);
      const body = close > lt ? text.slice(lt, close) : "";
      if (id && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, { lon, lat, tags: tagAttrs(body) });
      i = close > lt ? close + 7 : lt + open.length;
      continue;
    }
    if (text.startsWith("<way ", lt)) {
      const close = text.indexOf("</way>", lt);
      if (close < 0) break;
      const body = text.slice(lt, close);
      const id = attr(startTag(text, lt) || "", "id");
      const refs = [];
      const nd = /<nd ref="(\d+)"\s*\/>/g;
      let m;
      while ((m = nd.exec(body))) refs.push(m[1]);
      if (id) ways.set(id, { refs, tags: tagAttrs(body) });
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
      relations.push({ members, tags: tagAttrs(body) });
      i = close + 11;
      continue;
    }
    i = lt + 1;
  }
  const elements = [];
  function wayPoints(way) {
    const pts = [];
    for (let n = 0; n < way.refs.length; n++) {
      const node = nodes.get(way.refs[n]);
      if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) continue;
      const prev = pts[pts.length - 1];
      if (prev && prev[0] === node.lon && prev[1] === node.lat) continue;
      pts.push([node.lon, node.lat]);
    }
    return pts;
  }
  function pushWay(tags, pts) {
    if (!pts || pts.length < 2) return;
    const geometry = [];
    for (let p = 0; p < pts.length; p++) geometry.push({ lon: pts[p][0], lat: pts[p][1] });
    elements.push({ type: "way", tags, geometry });
  }
  const waterWayIds = new Set();
  for (const [id, way] of ways) {
    const tags = way.tags || {};
    if (isWaterWay(tags) || isParkingWay(tags)) waterWayIds.add(id);
    const pts = wayPoints(way);
    if (isWaterWay(tags) || isParkingWay(tags)) {
      const closed = isClosed(pts);
      const rings = closed ? clipClosedRing(pts, bbox) : closeOpenWater(pts, bbox);
      for (let r = 0; r < rings.length; r++) pushWay(tags, rings[r]);
      continue;
    }
    if (railType(tags) || isBridgeOutlineTags(tags) || (tags.man_made === "bridge" && !isBuried(tags))) {
      pushWay(tags, pts);
      continue;
    }
    if (barrierKind(tags)) pushWay(tags, pts);
    if (isRvSiteTags(tags) || isRvPitchTags(tags) || isRvRoadTags(tags)) pushWay(tags, pts);
  }
  for (const node of nodes.values()) {
    if (isPoleNode(node.tags) || isRvPitchTags(node.tags)) {
      elements.push({ type: "node", lon: node.lon, lat: node.lat, tags: node.tags });
    }
  }
  for (let r = 0; r < relations.length; r++) {
    const rel = relations[r];
    const tags = rel.tags || {};
    const water = isWaterWay(tags);
    const parking = isParkingWay(tags);
    if (isRvSiteTags(tags)) {
      const parts = [];
      const holeParts = [];
      for (let m = 0; m < rel.members.length; m++) {
        const member = rel.members[m];
        if (member.type !== "way") continue;
        const way = ways.get(member.ref);
        if (!way) continue;
        const pts = wayPoints(way);
        if (pts.length < 2) continue;
        if (member.role === "inner") holeParts.push(pts);
        else parts.push(pts);
      }
      const members = [];
      const outerChains = stitchChains(parts);
      const innerChains = stitchChains(holeParts);
      for (let c = 0; c < outerChains.length; c++) {
        if (!isClosed(outerChains[c])) continue;
        const geometry = [];
        for (let p = 0; p < outerChains[c].length; p++) {
          geometry.push({ lon: outerChains[c][p][0], lat: outerChains[c][p][1] });
        }
        members.push({ type: "way", role: "outer", geometry });
      }
      for (let c = 0; c < innerChains.length; c++) {
        if (!isClosed(innerChains[c])) continue;
        const geometry = [];
        for (let p = 0; p < innerChains[c].length; p++) {
          geometry.push({ lon: innerChains[c][p][0], lat: innerChains[c][p][1] });
        }
        members.push({ type: "way", role: "inner", geometry });
      }
      if (members.length) elements.push({ type: "relation", tags, members });
      continue;
    }
    if (!water && !parking) continue;
    if (tags.type && tags.type !== "multipolygon") continue;
    const parts = [];
    let tagged = 0;
    for (let m = 0; m < rel.members.length; m++) {
      const member = rel.members[m];
      if (member.type !== "way" || (member.role && member.role !== "outer")) continue;
      const way = ways.get(member.ref);
      if (!way) continue;
      if (waterWayIds.has(member.ref) || (parking && isParkingWay(way.tags))) tagged++;
      const pts = wayPoints(way);
      if (pts.length >= 2) parts.push(pts);
    }
    if (!parts.length || tagged === parts.length) continue;
    const chains = stitchChains(parts);
    for (let c = 0; c < chains.length; c++) {
      const closed = isClosed(chains[c]);
      const rings = closed ? clipClosedRing(chains[c], bbox) : closeOpenWater(chains[c], bbox);
      for (let k = 0; k < rings.length; k++) pushWay(tags, rings[k]);
    }
  }
  return elements;
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

function nearPt(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

function clipSegment(a, b, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - box.west, box.east - a[0], a[1] - box.south, box.north - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-15) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  if (t0 > t1) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

function clipLineRuns(pts, box) {
  const runs = [];
  let cur = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSegment(pts[i], pts[i + 1], box);
    if (!seg) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    if (!cur.length) cur.push(seg[0]);
    else if (!nearPt(cur[cur.length - 1], seg[0])) {
      if (cur.length >= 2) runs.push(cur);
      cur = [seg[0]];
    }
    if (!nearPt(cur[cur.length - 1], seg[1])) cur.push(seg[1]);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

function edgeT(pt, box) {
  const w = box.east - box.west;
  const h = box.north - box.south;
  if (!(w > 0) || !(h > 0)) return null;
  const dN = Math.abs(pt[1] - box.north);
  const dE = Math.abs(pt[0] - box.east);
  const dS = Math.abs(pt[1] - box.south);
  const dW = Math.abs(pt[0] - box.west);
  const m = Math.min(dN, dE, dS, dW);
  const eps = Math.max(w, h) * 0.04 + 1e-8;
  if (m > eps) return null;
  if (dN <= m + 1e-12 && pt[1] >= box.north - eps) return (pt[0] - box.west) / w;
  if (dE <= m + 1e-12 && pt[0] <= box.east + eps) return 1 + (box.north - pt[1]) / h;
  if (dS <= m + 1e-12 && pt[1] <= box.south + eps) return 2 + (box.east - pt[0]) / w;
  if (dW <= m + 1e-12) return 3 + (pt[1] - box.south) / h;
  return null;
}

function cornerAt(t, box) {
  const k = ((t % 4) + 4) % 4;
  if (k === 0) return [box.west, box.north];
  if (k === 1) return [box.east, box.north];
  if (k === 2) return [box.east, box.south];
  return [box.west, box.south];
}

/** Water sits to the right of the shore. Close along the box, clockwise. */
function closeWaterRing(line, box) {
  if (!line || line.length < 2) return null;
  const t0 = edgeT(line[0], box);
  const t1 = edgeT(line[line.length - 1], box);
  if (t0 == null || t1 == null) return null;
  let dest = t0;
  if (dest <= t1) dest += 4;
  const extra = [];
  for (let c = 1; c <= 4; c++) {
    let cc = c === 4 ? 4 : c;
    if (cc <= t1) cc += 4;
    if (cc > t1 + 1e-6 && cc < dest - 1e-6) extra.push(cornerAt(c === 4 ? 0 : c, box));
  }
  const ring = line.concat(extra);
  if (ring.length < 3) return null;
  ring.push(ring[0]);
  return subsample(ring, 36);
}

function closeOpenWater(pts, box) {
  const runs = clipLineRuns(pts, box);
  const rings = [];
  for (let i = 0; i < runs.length; i++) {
    const simple = subsample(runs[i], 28);
    const ring = closeWaterRing(simple, box);
    if (ring && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function clipClosedRing(pts, box) {
  let ring = pts.slice();
  if (ring.length >= 2 && nearPt(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
  if (ring.length < 3) return [];
  const edges = [
    [(p) => p[0] >= box.west - 1e-12, (a, b) => hitX(a, b, box.west)],
    [(p) => p[0] <= box.east + 1e-12, (a, b) => hitX(a, b, box.east)],
    [(p) => p[1] >= box.south - 1e-12, (a, b) => hitY(a, b, box.south)],
    [(p) => p[1] <= box.north + 1e-12, (a, b) => hitY(a, b, box.north)],
  ];
  for (let e = 0; e < edges.length; e++) {
    const inside = edges[e][0];
    const cross = edges[e][1];
    const next = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const ain = inside(a);
      const bin = inside(b);
      if (ain && bin) next.push(b);
      else if (ain && !bin) next.push(cross(a, b));
      else if (!ain && bin) {
        next.push(cross(a, b));
        next.push(b);
      }
    }
    ring = next.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (ring.length < 3) return [];
  }
  ring.push(ring[0]);
  return [subsample(ring, 36)];
}

function hitX(a, b, x) {
  const dx = b[0] - a[0] || 1e-12;
  const t = (x - a[0]) / dx;
  return [x, a[1] + t * (b[1] - a[1])];
}

function hitY(a, b, y) {
  const dy = b[1] - a[1] || 1e-12;
  const t = (y - a[1]) / dy;
  return [a[0] + t * (b[0] - a[0]), y];
}

function featuresFromMapXml(xml, want, bbox, deckCap) {
  const elements = elementsFromMapXml(xml, bbox);
  return parseOverpass({ elements }, want, bbox, deckCap);
}

function dedupeOutdoor(features) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < features.length; i++) {
    const feat = features[i];
    const key = (feat && feat.kind) + "|" + ringKey(feat && feat.coords);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(feat);
  }
  return out;
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
  const ua = (opts && opts.ua) || "openclutter";
  const tile = !!(opts && opts.tile);
  const deckCap = opts && opts.deckCap > 0 ? opts.deckCap | 0 : 0;
  try {
    const maps = await fetchOsmMaps(bbox, {
      signal: ctrl.signal,
      ua,
      tile,
      fetchImpl: opts && opts.fetchImpl,
    });
    if (maps.elements && maps.elements.length) {
      const parsed = parseOverpass({ elements: maps.elements }, want, bbox, deckCap);
      const limited = limitFeatures(dedupeOutdoor(parsed.features || []), bbox, deckCap);
      if (parsed.openWater) limited.notes.push("Open water lines were left out.");
      for (let i = 0; i < maps.notes.length; i++) limited.notes.push(maps.notes[i]);
      return { ok: true, features: limited.features, notes: limited.notes };
    }
    if (maps.xmls.length) {
      let features = [];
      let openWater = false;
      for (let i = 0; i < maps.xmls.length; i++) {
        const parsed = featuresFromMapXml(maps.xmls[i], want, bbox, deckCap);
        features = features.concat(parsed.features || []);
        if (parsed.openWater) openWater = true;
      }
      const limited = limitFeatures(dedupeOutdoor(features), bbox, deckCap);
      if (openWater) limited.notes.push("Open water lines were left out.");
      for (let i = 0; i < maps.notes.length; i++) limited.notes.push(maps.notes[i]);
      return { ok: true, features: limited.features, notes: limited.notes };
    }
    if (bboxSpanM(bbox).sideM > TILE_SPAN_M) {
      return { ok: true, features: [], notes: maps.notes };
    }
    if (ctrl.signal.aborted) return { ok: false, features: [], notes: [] };
    const q = overpassQuery(bbox, want);
    const r = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, features: [], notes: [] };
    const json = await r.json();
    const parsed = parseOverpass(json, want, bbox, deckCap);
    const limited = limitFeatures(parsed.features, bbox, deckCap);
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
  if (!slopeTop || typeof slopeTop.seat !== "function" || !ring || ring.length < 2) return 0;
  let sample = ring;
  if (ring.length < 3 && ring[0] && ring[1]) {
    const mid = [(+ring[0][0] + +ring[1][0]) / 2, (+ring[0][1] + +ring[1][1]) / 2];
    sample = [ring[0], mid, ring[1]];
  }
  if (sample.length < 3) return 0;
  const z = Number(slopeTop.seat(sample));
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

function splitPolyline(pts, chunk) {
  const n = pts.length;
  if (n <= chunk) return [pts.slice()];
  const out = [];
  const step = Math.max(1, chunk - 1);
  for (let i = 0; i < n - 1; i += step) {
    const slice = pts.slice(i, Math.min(n, i + chunk));
    if (slice.length >= 2) out.push(slice);
    if (i + chunk >= n) break;
  }
  return out;
}

function guidewayLineRings(coords, frame, halfM, maxRings) {
  const segCap = maxRings > 0 ? maxRings | 0 : GUIDEWAY_SEGMENT_CAP;
  const chunks = splitPolyline(coords, GUIDEWAY_CHUNK);
  const rings = [];
  for (let c = 0; c < chunks.length && rings.length < segCap; c++) {
    const chunk = chunks[c];
    const px = [];
    for (let i = 0; i < chunk.length; i++) px.push(llToPx(chunk[i][0], chunk[i][1], frame));
    const meters = px.map((p) => toMeters(p, frame));
    const buffered = bufferLineMeters(meters, halfM);
    if (buffered && !selfCross(buffered)) {
      rings.push({ ringPx: buffered.map((p) => fromMeters(p, frame)), coords: chunk });
      continue;
    }
    for (let i = 0; i < meters.length - 1 && rings.length < segCap; i++) {
      const q = segmentQuad(meters[i], meters[i + 1], halfM);
      if (q) rings.push({ ringPx: q.map((p) => fromMeters(p, frame)), coords: [chunk[i], chunk[Math.min(chunk.length - 1, i + 1)]] });
    }
  }
  return rings;
}

/** Closed areas that climb a hill become one piece per downhill seat. */
function slopeAreaParts(slopeTop, coords) {
  if (!coords || coords.length < 4) return [];
  const parts = slopeTop && typeof slopeTop.split === "function" ? slopeTop.split(coords) : null;
  if (parts && parts.length >= 2) return parts;
  return [coords];
}

function guidewaySeat(slopeTop, coords) {
  if (!slopeTop || typeof slopeTop.seat !== "function" || !coords || coords.length < 2) return 0;
  const z = Number(slopeTop.seat(coords));
  return Number.isFinite(z) && z >= LIFT_LOCAL_M ? z : 0;
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

function buildingRingsPx(buildings, frame) {
  const cuts = [];
  for (let b = 0; b < (buildings || []).length; b++) {
    const building = buildings[b];
    if (!building) continue;
    const ring =
      building.ringPx && building.ringPx.length >= 3
        ? closePx(building.ringPx)
        : building.ring && building.ring.length >= 3
          ? lonLatRingToPx(building.ring, frame)
          : null;
    if (ring && ring.length >= 4) cuts.push(ring);
  }
  return cuts;
}

function pxRingToLonLat(ring, frame) {
  const out = [];
  for (let i = 0; i < ring.length; i++) out.push(pxToLl(ring[i][0], ring[i][1], frame));
  return out;
}

/**
 * Pixel rings plus a parking recolor of buildings that already cover a garage.
 * A matched garage is not drawn a second time. Water is cut against those
 * same roofs so a pond or a mis-tagged panel block does not cover them.
 */
function planOutdoor({ features, frame, slopeTop, buildings, parkingRings, segmentCaps }) {
  const guideCap = segmentCaps && segmentCaps.guideway > 0 ? segmentCaps.guideway | 0 : GUIDEWAY_SEGMENT_CAP;
  const bridgeCap = segmentCaps && segmentCaps.bridge > 0 ? segmentCaps.bridge | 0 : BRIDGE_SEGMENT_CAP;
  const footCap = segmentCaps && segmentCaps.footbridge > 0 ? segmentCaps.footbridge | 0 : FOOTBRIDGE_SEGMENT_CAP;
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
      if (parkingFeats[i].structure === false) continue;
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
  let guidewaySegs = 0;
  let bridgeSegs = 0;
  let footSegs = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f) continue;
    if (f.kind === "parking" && consumed.has(f)) continue;
    if (f.kind === "guideway") {
      if (!f.closed && lineLength(f.coords) * 111000 < 8) continue;
      if (guidewaySegs >= guideCap) continue;
      const half = (f.widthM > 0 ? f.widthM : MONORAIL_WIDTH_M) / 2;
      const rings = f.closed
        ? [{ ringPx: lonLatRingToPx(f.coords, frame), coords: f.coords }]
        : guidewayLineRings(f.coords, frame, half, guideCap);
      const deck = f.deckM > 0 ? f.deckM : MONORAIL_DECK_M;
      const thick = f.thicknessM > 2 ? f.thicknessM : GUIDEWAY_THICK_M;
      for (let r = 0; r < rings.length; r++) {
        if (guidewaySegs >= guideCap) break;
        const seg = rings[r];
        if (!seg || !seg.ringPx || seg.ringPx.length < 4) continue;
        const material = materialForKind(
          "guideway",
          thick,
          seg.coords || f.coords,
          null,
          guidewaySeat(slopeTop, seg.coords || f.coords) + deck
        );
        if (!material) continue;
        items.push({ ringPx: seg.ringPx, material, kind: "guideway", thin: true });
        guidewaySegs++;
      }
      continue;
    }
    if (f.kind === "bridge") {
      const foot = !!f.foot;
      if (foot) {
        if (footSegs >= footCap) continue;
      } else if (bridgeSegs >= bridgeCap) continue;
      const half = (f.widthM > 0 ? f.widthM : 8) / 2;
      const rings = f.closed
        ? [{ ringPx: lonLatRingToPx(f.coords, frame), coords: f.coords }]
        : guidewayLineRings(f.coords, frame, half, foot ? footCap : bridgeCap);
      const deck = f.deckM > 0 ? f.deckM : BRIDGE_DECK_M;
      for (let r = 0; r < rings.length; r++) {
        if (foot ? footSegs >= footCap : bridgeSegs >= bridgeCap) break;
        const seg = rings[r];
        if (!seg || !seg.ringPx || seg.ringPx.length < 4) continue;
        const material = materialForKind(
          "bridge",
          BRIDGE_THICK_M,
          seg.coords || f.coords,
          null,
          guidewaySeat(slopeTop, seg.coords || f.coords) + deck
        );
        if (!material) continue;
        items.push({ ringPx: seg.ringPx, material, kind: foot ? "footbridge" : "bridge", thin: true });
        if (foot) footSegs++;
        else bridgeSegs++;
      }
      continue;
    }
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
      const chunks = splitPolyline(f.coords, 4);
      const seats = chunks.map((c) => guidewaySeat(slopeTop, c));
      let lo = seats[0] || 0;
      let hi = lo;
      for (let i = 1; i < seats.length; i++) {
        if (seats[i] < lo) lo = seats[i];
        if (seats[i] > hi) hi = seats[i];
      }
      const vary = chunks.length >= 2 && hi - lo > 2.5;
      const parts = vary ? chunks : [f.coords];
      for (let c = 0; c < parts.length; c++) {
        const rings = lineRingsPx(parts[c], frame, THICK_M[f.kind] / 2);
        const material = materialForKind(f.kind, f.heightM, parts[c], slopeTop, 0);
        if (!material) continue;
        for (let r = 0; r < rings.length; r++) {
          items.push({ ringPx: rings[r], material, kind: f.kind, thin: true });
        }
      }
      continue;
    }
    if (f.kind === "rv") {
      const ringPx = lonLatRingToPx(f.coords, frame);
      const material = materialForKind("rv", f.heightM || RV_HEIGHT_M, f.coords, slopeTop, 0);
      if (!material || ringPx.length < 4) continue;
      items.push({ ringPx, material, kind: "rv", thin: true });
      continue;
    }
    if (f.kind === "water" || f.kind === "parking") {
      const parts = slopeAreaParts(slopeTop, f.coords);
      const cuts =
        f.kind === "water" || (f.kind === "parking" && f.structure === false)
          ? buildingRingsPx(buildings, frame)
          : null;
      for (let p = 0; p < parts.length; p++) {
        const basePx = lonLatRingToPx(parts[p], frame);
        const pieces = cuts ? ringsMinus(basePx, cuts) : [basePx];
        const untouched = pieces.length === 1 && pieces[0] === basePx;
        for (let s = 0; s < pieces.length; s++) {
          const ringPx = pieces[s];
          if (!ringPx || ringPx.length < 4) continue;
          const lonlat = untouched ? parts[p] : pxRingToLonLat(ringPx, frame);
          const material = materialForKind(f.kind, f.heightM, lonlat, slopeTop, 0);
          if (!material) continue;
          items.push({ ringPx, material, kind: f.kind, thin: false });
        }
      }
    }
  }
  const notes = [];
  if (shortWalls) notes.push("Short walls were left out.");
  return { items, updates, notes, reclass };
}

const BUDGET_ORDER = ["parking", "water", "guideway", "bridge", "rv", "wall", "retaining", "hedge", "fence", "footbridge", "pole"];

function budgetNote(kind, keptCount, skipped) {
  const label =
    kind === "pole"
      ? "light pole"
      : kind === "water"
        ? "water area"
        : kind === "parking"
          ? "parking area"
          : kind === "guideway"
            ? "guideway"
            : kind === "bridge"
              ? "bridge"
              :     kind === "footbridge"
      ? "footbridge"
      : kind === "rv"
        ? "RV"
        : "wall";
  if (!(keptCount > 0)) {
    if (kind === "pole") return "Light poles left out to stay inside the area budget.";
    if (kind === "water") return "Water left out to stay inside the area budget.";
    if (kind === "parking") return "Parking left out to stay inside the area budget.";
    if (kind === "guideway") return "Guideways left out to stay inside the area budget.";
    if (kind === "bridge") return "Bridges left out to stay inside the area budget.";
    if (kind === "footbridge") return "Footbridges left out to stay inside the area budget.";
    if (kind === "rv") return "RVs left out to stay inside the area budget.";
    return "Walls left out to stay inside the area budget.";
  }
  const noun = skipped === 1 ? label : label + "s";
  return skipped + " " + noun + " did not fit in the area budget (" + keptCount + " kept).";
}

/** Parking and water stay ahead of poles when the attenuation cap is tight. */
function fitOutdoorBudget(items, kinds, room, opts) {
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
  // Water and parking share this prefix so a crowd of ponds cannot spend
  // the slots held for guideways and bridges. Omitted, they share `room`.
  let frontLeft = opts && Number.isFinite(opts.front) ? Math.max(0, opts.front | 0) : left;
  const noted = new Set();
  for (let i = 0; i < BUDGET_ORDER.length; i++) {
    const kind = BUDGET_ORDER[i];
    const list = groups.get(kind) || [];
    const capped = kind === "parking" || kind === "water" ? Math.min(left, frontLeft) : left;
    const take = list.slice(0, capped);
    for (let t = 0; t < take.length; t++) {
      kept.push(take[t]);
      keptKinds.push(kind);
    }
    left -= take.length;
    if (kind === "parking" || kind === "water") frontLeft -= take.length;
    if (list.length > take.length) {
      const note = budgetNote(kind, take.length, list.length - take.length);
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
  MONORAIL_WIDTH_M,
  RAIL_WIDTH_M,
  MONORAIL_DECK_M,
  RAIL_DECK_M,
  GUIDEWAY_THICK_M,
  GUIDEWAY_CAP,
  BRIDGE_DECK_M,
  BRIDGE_THICK_M,
  BRIDGE_MIN_M,
  RV_LENGTH_M,
  RV_WIDTH_M,
  RV_HEIGHT_M,
  RV_SPACING_M,
  RV_CAP,
  OUTDOOR_MISS,
  overpassQuery,
  rvBoxes,
  parseOverpass,
  featuresFromMapXml,
  guidewayFeatures,
  guidewaysFromElements,
  guidewaysFromParsedWays,
  bridgeFeatures,
  bridgesFromElements,
  bridgesFromParsedWays,
  limitFeatures,
  fetchOutdoorClutter,
  isParkingClass,
  planOutdoor,
  fitOutdoorBudget,
};
