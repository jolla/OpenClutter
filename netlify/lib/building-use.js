"use strict";

/**
 * Per-type wall attenuation for OpenIntent buildings (1.3.42).
 * Classify from existing footprint and OSM/Overture tag fields. Unknown
 * types stay at the stock 5 dB/m. Masonry is also 5 dB/m, so those roofs
 * keep the gold Building - One/Two/Five/Ten Floor objects. Parking
 * structures stay 2 dB/m on the existing outdoor-clutter path as well.
 */

const TYPES = {
  wood: { id: "wood", label: "Wood frame", db: 3 },
  shed: { id: "shed", label: "Shed", db: 2 },
  carport: { id: "carport", label: "Carport", db: 0.5 },
  masonry: { id: "masonry", label: "Masonry", db: 5 },
  bigbox: { id: "bigbox", label: "Big-box", db: 6 },
  civic: { id: "civic", label: "Civic", db: 6 },
  glass: { id: "glass", label: "Glass tower", db: 6 },
  metal: { id: "metal", label: "Metal warehouse", db: 8 },
  parking: { id: "parking", label: "Parking", db: 2 },
};

const TYPE_BY_ID = TYPES;
const TYPE_BY_LABEL = Object.fromEntries(Object.values(TYPES).map((t) => [t.label, t]));

const TAG_KEYS = [
  "building",
  "amenity",
  "man_made",
  "shop",
  "office",
  "industrial",
  "name",
  "material",
  "building:material",
  "building:use",
  "parking",
  "tourism",
  "leisure",
  "landuse",
  "class",
  "subtype",
];

function lower(v) {
  return v == null ? "" : String(v).trim().toLowerCase();
}

function tagsFrom(props) {
  if (!props || typeof props !== "object") return {};
  const src = props.tags || props.osmTags || props;
  const out = {};
  for (let i = 0; i < TAG_KEYS.length; i++) {
    const k = TAG_KEYS[i];
    const v = src[k] != null ? src[k] : props[k];
    if (v != null && v !== "") out[k] = v;
  }
  if (props.buildingClass && !out.class) out.class = props.buildingClass;
  if (props.partName && !out.name) out.name = props.partName;
  return out;
}

function materialOf(tags) {
  return lower(tags["building:material"] || tags.material);
}

function isWoodMaterial(mat) {
  return mat === "wood" || mat === "timber" || mat === "weatherboard" || mat === "wood_frame" || mat === "frame";
}

function isMasonryMaterial(mat) {
  return (
    mat === "brick" ||
    mat === "stone" ||
    mat === "masonry" ||
    mat === "concrete" ||
    mat === "concrete_block" ||
    mat === "plaster" ||
    mat === "cement_block" ||
    mat === "block"
  );
}

function isMetalMaterial(mat) {
  return mat === "metal" || mat === "steel" || mat === "metal_sheet" || mat === "corrugated_metal" || mat === "iron";
}

function isGlassMaterial(mat) {
  return mat === "glass" || mat === "curtain_wall" || mat === "mirror";
}

function isParkingTags(tags, props) {
  const building = lower(tags.building);
  const parking = lower(tags.parking);
  const cls = lower(tags.class || tags.subtype || (props && (props.class || props.subtype || props.buildingClass)));
  if (cls === "parking") return true;
  if (building === "parking") return true;
  if (parking === "multi-storey" || parking === "multi_storey" || parking === "garage") return true;
  return false;
}

const HOUSE_BUILDINGS = new Set([
  "house",
  "detached",
  "semidetached_house",
  "semi-detached_house",
  "terraced",
  "terrace",
  "residential",
  "bungalow",
  "villa",
  "cabin",
  "cottage",
  "duplex",
  "apartments",
  "farm",
]);

const SHED_BUILDINGS = new Set([
  "shed",
  "garage",
  "garages",
  "outbuilding",
  "hut",
  "allotment_house",
  "boathouse",
  "greenhouse",
]);

const CIVIC_BUILDINGS = new Set([
  "school",
  "university",
  "college",
  "kindergarten",
  "hospital",
  "civic",
  "public",
  "government",
  "fire_station",
  "police",
  "townhall",
  "courthouse",
  "community_centre",
  "community_center",
  "library",
  "museum",
  "clinic",
]);

const CIVIC_AMENITY = new Set([
  "school",
  "university",
  "college",
  "kindergarten",
  "hospital",
  "clinic",
  "doctors",
  "fire_station",
  "police",
  "townhall",
  "courthouse",
  "community_centre",
  "community_center",
  "library",
  "public_building",
  "social_facility",
]);

const METAL_BUILDINGS = new Set([
  "warehouse",
  "industrial",
  "hangar",
  "factory",
  "manufacture",
  "works",
]);

const BIGBOX_BUILDINGS = new Set(["retail", "supermarket", "commercial", "mall", "store"]);
const BIGBOX_SHOP = new Set(["supermarket", "mall", "department_store", "wholesale", "doityourself", "warehouse"]);
const BIGBOX_NAME = /\b(walmart|wal-mart|supercenter|super centre|target|costco|sam'?s club|home depot|lowe'?s|ikea|best buy|menards|bj'?s wholesale)\b/i;

function heightM(props, tags) {
  const h = Number((props && (props.height || props.Height)) || 0);
  if (h > 2) return h;
  const floors = Number((props && props.numFloors) || (tags && (tags["building:levels"] || tags.levels)) || 0);
  if (floors >= 1) return floors * 3.2;
  return 0;
}

/**
 * Return a type from TYPES, or null when the footprint should keep the
 * stock 5 dB/m Building - * Floor (or measured Building - H.H) object.
 */
function classifyBuildingUse(props) {
  const tags = tagsFrom(props);
  const building = lower(tags.building);
  const amenity = lower(tags.amenity);
  const shop = lower(tags.shop);
  const mat = materialOf(tags);
  const name = tags.name ? String(tags.name) : "";

  if (isParkingTags(tags, props)) return TYPES.parking;
  if (building === "carport" || amenity === "carport") return TYPES.carport;
  if (SHED_BUILDINGS.has(building)) return TYPES.shed;

  if (METAL_BUILDINGS.has(building) || lower(tags.industrial) === "warehouse" || lower(tags.man_made) === "works") {
    return TYPES.metal;
  }
  if (isMetalMaterial(mat) && (building === "yes" || building === "industrial" || !building)) {
    return TYPES.metal;
  }

  if (building === "skyscraper" || isGlassMaterial(mat) || (building === "office" && heightM(props, tags) >= 24)) {
    return TYPES.glass;
  }

  if (CIVIC_BUILDINGS.has(building) || CIVIC_AMENITY.has(amenity)) return TYPES.civic;

  if (BIGBOX_BUILDINGS.has(building) || BIGBOX_SHOP.has(shop) || BIGBOX_NAME.test(name)) return TYPES.bigbox;

  if (HOUSE_BUILDINGS.has(building) || isWoodMaterial(mat)) return TYPES.wood;

  if (isMasonryMaterial(mat)) return TYPES.masonry;

  return null;
}

function dbForBuildingUse(type) {
  return type && type.db != null ? type.db : 5;
}

/** True when the type needs a custom OpenIntent object (dB/m is not the stock 5). */
function usesCustomBuildingMaterial(type) {
  return !!(type && type.db !== 5);
}

const USE_LABELS = Object.values(TYPES)
  .filter((t) => t.db !== 5)
  .map((t) => t.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const USE_NAME = new RegExp("^Building - (" + USE_LABELS + ") (\\d+\\.\\d)$");
const LIFTED_USE_NAME = new RegExp("^Building - (" + USE_LABELS + ") (\\d+\\.\\d) @ (\\d+\\.\\d)$");

function isUseBuildingName(name) {
  return USE_NAME.test(name || "");
}

function isLiftedUseBuildingName(name) {
  return LIFTED_USE_NAME.test(name || "");
}

function typeFromUseName(name) {
  const m = USE_NAME.exec(name || "") || LIFTED_USE_NAME.exec(name || "");
  return m ? TYPE_BY_LABEL[m[1]] || null : null;
}

function copyOsmUseTags(features, osmRings) {
  const tagged = [];
  for (let i = 0; i < (osmRings || []).length; i++) {
    const ring = osmRings[i];
    const tags = ring && ring.osmTags;
    if (!tags || !ring || ring.length < 3) continue;
    tagged.push({ ring, tags });
  }
  if (!tagged.length) return 0;
  let n = 0;
  const list = features || [];
  for (let f = 0; f < list.length; f++) {
    const feat = list[f];
    if (!feat || !feat.geometry) continue;
    const props = feat.properties || (feat.properties = {});
    if (props.building || props.amenity || props.class || props.subtype) continue;
    const exteriors = exteriorsOf(feat);
    let best = null;
    let bestFrac = 0;
    for (let e = 0; e < exteriors.length; e++) {
      const area = ringAreaAbs(exteriors[e]);
      if (!(area > 0)) continue;
      for (let t = 0; t < tagged.length; t++) {
        const inter = intersectionAreaApprox(exteriors[e], tagged[t].ring);
        const frac = inter / area;
        if (frac > bestFrac) {
          bestFrac = frac;
          best = tagged[t];
        }
      }
    }
    if (!best || bestFrac < 0.5) continue;
    const tags = best.tags;
    for (let k = 0; k < TAG_KEYS.length; k++) {
      const key = TAG_KEYS[k];
      if (props[key] == null && tags[key] != null && tags[key] !== "") props[key] = tags[key];
    }
    n++;
  }
  return n;
}

function exteriorsOf(feature) {
  const g = feature && feature.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates && g.coordinates[0] ? [g.coordinates[0]] : [];
  if (g.type === "MultiPolygon") {
    const out = [];
    const polys = g.coordinates || [];
    for (let i = 0; i < polys.length; i++) {
      if (polys[i] && polys[i][0]) out.push(polys[i][0]);
    }
    return out;
  }
  return [];
}

function ringAreaAbs(ring) {
  if (!ring || ring.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += +ring[j][0] * +ring[i][1] - +ring[i][0] * +ring[j][1];
  }
  return Math.abs(a) / 2;
}

// Bounding-box overlap as a cheap lower bound, then a vertex-in-ring sample
// for the cover fraction. Good enough to copy tags; not used for geometry.
function intersectionAreaApprox(a, b) {
  const ba = bbox(a);
  const bb = bbox(b);
  if (!ba || !bb || ba.maxX < bb.minX || ba.minX > bb.maxX || ba.maxY < bb.minY || ba.minY > bb.maxY) return 0;
  const areaA = ringAreaAbs(a);
  const areaB = ringAreaAbs(b);
  if (!(areaA > 0) || !(areaB > 0)) return 0;
  const insideA = countInside(a, b);
  const insideB = countInside(b, a);
  const fracA = insideA / Math.max(1, a.length);
  const fracB = insideB / Math.max(1, b.length);
  if (fracA >= 0.6) return areaA * Math.min(1, fracA);
  if (fracB >= 0.6) return areaB * Math.min(1, fracB);
  return Math.min(areaA, areaB) * Math.max(fracA, fracB);
}

function bbox(ring) {
  if (!ring || !ring.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = +ring[i][0];
    const y = +ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function countInside(pts, host) {
  let n = 0;
  for (let i = 0; i < (pts || []).length; i++) {
    if (pointInRing(pts[i], host)) n++;
  }
  return n;
}

function pointInRing(pt, ring) {
  if (!pt || !ring) return false;
  const x = +pt[0];
  const y = +pt[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = +ring[i][0];
    const yi = +ring[i][1];
    const xj = +ring[j][0];
    const yj = +ring[j][1];
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

module.exports = {
  TYPES,
  TAG_KEYS,
  classifyBuildingUse,
  dbForBuildingUse,
  usesCustomBuildingMaterial,
  tagsFrom,
  isUseBuildingName,
  isLiftedUseBuildingName,
  typeFromUseName,
  USE_NAME,
  LIFTED_USE_NAME,
  copyOsmUseTags,
};
