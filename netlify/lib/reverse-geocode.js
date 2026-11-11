"use strict";

/**
 * Name a drawn area for the search box: a notable named feature in or
 * very near the box, then the city and region. Landmarks come from
 * Overpass (one bbox query, not a Nominatim scan). The city comes from
 * a single Nominatim reverse of the box centre, paced with the existing
 * 1 request/s slot and identifying User-Agent. Nothing is stored.
 */

const US_CA_ABBR = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "puerto rico": "PR",
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "nova scotia": "NS",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  saskatchewan: "SK",
};

const SKIP_TOURISM = new Set([
  "information",
  "viewpoint",
  "hotel",
  "motel",
  "guest_house",
  "hostel",
  "apartment",
  "chalet",
]);
const SKIP_AMENITY = new Set(["parking", "toilets", "fuel", "waste_basket"]);
const NOTABLE_LANDUSE = new Set(["quarry", "recreation_ground"]);
const NOTABLE_MAN_MADE = new Set(["mine", "mineshaft", "tailings", "adit", "works"]);
const NOTABLE_NATURAL = new Set([
  "peak",
  "volcano",
  "water",
  "bay",
  "glacier",
  "beach",
  "cape",
  "hot_spring",
]);
const NOTABLE_LEISURE = new Set([
  "park",
  "nature_reserve",
  "golf_course",
  "stadium",
  "recreation_ground",
  "sports_centre",
]);
const NOTABLE_TOURISM = new Set([
  "attraction",
  "camp_site",
  "caravan_site",
  "theme_park",
  "museum",
  "zoo",
  "picnic_site",
]);
const NOTABLE_HISTORIC = new Set([
  "mine",
  "ruins",
  "castle",
  "monument",
  "battlefield",
  "fort",
  "memorial",
  "archaeological_site",
]);
const NOTABLE_AMENITY = new Set(["university", "college"]);
const ROAD_NAME = /\b(road|street|avenue|blvd|boulevard|drive|lane|way|hwy|highway|loop|trail)\b/i;
const MAX_SPAN_DEG = 2;
const MIN_SPAN_DEG = 1e-5;

function parseBbox(params) {
  const p = params || {};
  const south = Number(p.south);
  const west = Number(p.west);
  const north = Number(p.north);
  const east = Number(p.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (!(south < north) || !(west < east)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  const dlat = north - south;
  const dlon = east - west;
  if (dlat > MAX_SPAN_DEG || dlon > MAX_SPAN_DEG) return null;
  if (dlat < MIN_SPAN_DEG && dlon < MIN_SPAN_DEG) return null;
  return { south, west, north, east };
}

function boxCenter(box) {
  return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
}

function boxArea(box) {
  return Math.max(0, box.north - box.south) * Math.max(0, box.east - box.west);
}

function padBbox(box) {
  const padLat = Math.max(0.001, (box.north - box.south) * 0.15);
  const padLon = Math.max(0.001, (box.east - box.west) * 0.15);
  return {
    south: Math.max(-90, box.south - padLat),
    north: Math.min(90, box.north + padLat),
    west: Math.max(-180, box.west - padLon),
    east: Math.min(180, box.east + padLon),
  };
}

function landmarkQuery(box) {
  const b = padBbox(box);
  const span = b.south.toFixed(7) + "," + b.west.toFixed(7) + "," + b.north.toFixed(7) + "," + b.east.toFixed(7);
  return (
    "[out:json][timeout:10];\n(" +
    'nwr["name"]["wikipedia"](' +
    span +
    ");" +
    'nwr["name"]["wikidata"](' +
    span +
    ");" +
    'nwr["name"]["landuse"~"^(quarry|recreation_ground)$"](' +
    span +
    ");" +
    'nwr["name"]["man_made"~"^(mine|mineshaft|tailings|adit|works)$"](' +
    span +
    ");" +
    'nwr["name"]["natural"~"^(peak|volcano|water|bay|glacier|beach|cape|hot_spring)$"](' +
    span +
    ");" +
    'nwr["name"]["leisure"~"^(park|nature_reserve|golf_course|stadium|recreation_ground|sports_centre)$"](' +
    span +
    ");" +
    'nwr["name"]["tourism"~"^(attraction|camp_site|caravan_site|theme_park|museum|zoo|picnic_site)$"](' +
    span +
    ");" +
    'nwr["name"]["historic"~"^(mine|ruins|castle|monument|battlefield|fort|memorial|archaeological_site)$"](' +
    span +
    ");" +
    'nwr["name"]["geological"](' +
    span +
    ");" +
    'nwr["name"]["amenity"~"^(university|college)$"](' +
    span +
    ");" +
    'nwr["name"]["aeroway"="aerodrome"](' +
    span +
    ");" +
    ");\nout bb center tags;"
  );
}

function wikiTitle(tags) {
  const raw = String(tags.wikipedia || tags["wikipedia:en"] || "");
  const m = /^(?:en:)?(.+)$/i.exec(raw);
  if (!m) return "";
  return m[1].replace(/_/g, " ").trim();
}

function displayName(tags) {
  const t = tags || {};
  const name = String(t.name || "").trim();
  const nameEn = String(t["name:en"] || "").trim();
  const title = wikiTitle(t);
  const alts = String(t.alt_name || t.official_name || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (title && (title === name || title === nameEn || alts.some((a) => a === title || a.startsWith(title + " ")))) {
    return title;
  }
  return nameEn || name;
}

function namesEqual(a, b) {
  const n = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const x = n(a);
  const y = n(b);
  return !!x && x === y;
}

function regionAbbrev(address) {
  const a = address || {};
  const iso = String(a["ISO3166-2-lvl4"] || "");
  const m = /^(US|CA|PR)-([A-Z]{2})$/i.exec(iso);
  if (m) return m[2].toUpperCase();
  const raw = String(a.state || a.province || "").trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  const key = raw.toLowerCase();
  return US_CA_ABBR[key] || "";
}

function formatPlace(data) {
  const a = (data && data.address) || {};
  const city = String(a.city || a.town || a.village || a.municipality || a.hamlet || a.county || "").trim();
  const cc = String(a.country_code || "").toLowerCase();
  const region = regionAbbrev(a);
  if (cc === "us" || cc === "ca" || cc === "pr") {
    if (city && region) return city + ", " + region;
    if (city) return city;
    if (region) return region;
    return "";
  }
  const country = String(a.country || "").trim();
  if (city && country) return city + ", " + country;
  return city || country || "";
}

function formatLabel(featureName, placeText) {
  const feature = String(featureName || "").trim();
  const place = String(placeText || "").trim();
  if (!feature) return place;
  if (!place) return feature;
  const city = place.split(",")[0].trim();
  if (namesEqual(feature, place) || namesEqual(feature, city)) return place;
  return feature + " - " + place;
}

function featureBounds(el) {
  const b = el && el.bounds;
  if (!b) return null;
  const south = Number(b.minlat);
  const west = Number(b.minlon);
  const north = Number(b.maxlat);
  const east = Number(b.maxlon);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (!(south <= north) || !(west <= east)) return null;
  return { south, west, north, east };
}

function featureCenter(el) {
  if (el && el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return { lat: el.center.lat, lon: el.center.lon };
  }
  if (el && Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { lat: el.lat, lon: el.lon };
  const b = featureBounds(el);
  return b ? boxCenter(b) : null;
}

function contains(box, pt) {
  return !!pt && pt.lat >= box.south && pt.lat <= box.north && pt.lon >= box.west && pt.lon <= box.east;
}

function overlapArea(a, b) {
  if (!a || !b) return 0;
  const south = Math.max(a.south, b.south);
  const north = Math.min(a.north, b.north);
  const west = Math.max(a.west, b.west);
  const east = Math.min(a.east, b.east);
  if (south >= north || west >= east) return 0;
  return (north - south) * (east - west);
}

function isAdminOrPlace(tags) {
  const t = tags || {};
  if (t.boundary === "administrative" || t.boundary === "political" || t.type === "boundary") return true;
  if (t.place && !NOTABLE_LEISURE.has(t.leisure) && !NOTABLE_TOURISM.has(t.tourism)) return true;
  if (t.boundary === "protected_area" && !isNotable(t)) return true;
  return false;
}

function isNotable(tags) {
  const t = tags || {};
  if (NOTABLE_LANDUSE.has(t.landuse)) return true;
  if (NOTABLE_MAN_MADE.has(t.man_made)) return true;
  if (NOTABLE_NATURAL.has(t.natural)) return true;
  if (NOTABLE_LEISURE.has(t.leisure)) return true;
  if (NOTABLE_TOURISM.has(t.tourism)) return true;
  if (NOTABLE_HISTORIC.has(t.historic)) return true;
  if (t.geological) return true;
  if (NOTABLE_AMENITY.has(t.amenity)) return true;
  if (t.aeroway === "aerodrome") return true;
  return false;
}

function isSkipped(el) {
  const t = (el && el.tags) || {};
  const name = displayName(t);
  if (!name) return true;
  if (isAdminOrPlace(t)) return true;
  if (t.highway || t.waterway || t.railway === "rail") return true;
  if (ROAD_NAME.test(name) && !isNotable(t)) return true;
  if (SKIP_TOURISM.has(t.tourism)) return true;
  if (SKIP_AMENITY.has(t.amenity)) return true;
  return false;
}

function featureScore(el, box) {
  const t = (el && el.tags) || {};
  if (isSkipped(el)) return -1;
  const featBox = featureBounds(el);
  const featA = featBox ? boxArea(featBox) : 0;
  const area = boxArea(box);
  if (featA && area && featA > 8 * area) return -1;
  const padded = padBbox(box);
  const c = featureCenter(el);
  if (c && !contains(padded, c) && !(featBox && overlapArea(featBox, box) > 0)) return -1;
  let s = 0;
  if (t.wikipedia || t["wikipedia:en"]) s += 100;
  if (t.wikidata) s += 40;
  if (isNotable(t)) s += 50;
  if (el.type === "relation") s += 25;
  else if (el.type === "way") s += 20;
  if (c && contains(box, c)) s += 30;
  else if (c && contains(padded, c)) s += 10;
  if (featA && area) s += Math.round(40 * (overlapArea(featBox, box) / featA));
  if (featA > 0.00005) s += 20;
  else if (featA > 0.00001) s += 10;
  return s;
}

function pickFeature(elements, box) {
  let best = null;
  let bestScore = 0;
  const list = Array.isArray(elements) ? elements : [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    const s = featureScore(el, box);
    if (s < 0) continue;
    if (!best || s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (!best || bestScore < 50) return null;
  return { name: displayName(best.tags), score: bestScore, element: best };
}

async function labelForBox(box, opts) {
  const o = opts || {};
  const requestJson = o.requestJson || require("./overpass").requestJson;
  const nominatimReverse = o.nominatimReverse || require("./nominatim").nominatimReverse;
  const ua = o.userAgent;
  const center = boxCenter(box);
  const featP = Promise.resolve()
    .then(() =>
      requestJson(landmarkQuery(box), {
        ua,
        deadlineMs: o.deadlineMs || 10000,
        tag: "reverse-landmark",
      })
    )
    .catch(() => null);
  const nomP = Promise.resolve()
    .then(() =>
      nominatimReverse(center.lat, center.lon, {
        userAgent: ua,
        fetch: o.fetch,
        env: o.env,
        timeoutMs: o.timeoutMs || 8000,
      })
    )
    .catch(() => ({ ok: false, data: null }));
  const [osm, nom] = await Promise.all([featP, nomP]);
  const elements = osm && Array.isArray(osm.elements) ? osm.elements : [];
  const feature = pickFeature(elements, box);
  const place = formatPlace(nom && nom.ok ? nom.data : null);
  const label = formatLabel(feature && feature.name, place);
  return { label, feature: (feature && feature.name) || null, place };
}

module.exports = {
  parseBbox,
  boxCenter,
  padBbox,
  landmarkQuery,
  displayName,
  formatPlace,
  formatLabel,
  namesEqual,
  regionAbbrev,
  featureScore,
  pickFeature,
  labelForBox,
};
