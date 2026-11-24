"use strict";

/**
 * Download name for an OpenIntent zip: a short place, the city or region,
 * the drawn area, and the UTC date. Inner OpenIntent file names stay on
 * the existing site slug; only the .zip download name uses this.
 *
 * A picked search result or a prior /api/reverse label is preferred. If
 * neither is usable, a 2 s Photon reverse (several nearby hits) plus a
 * coarser Nominatim reverse of the box centre name the area. The largest
 * named enclosing site that covers most of the box wins: a resort, theme
 * park, campus, park, airport, stadium, golf course, RV park, or
 * campground. Roads, paths, and buildings are skipped unless nothing
 * better exists. Otherwise the name is the city and region. Street
 * addresses are never used. A miss falls back to rounded coordinates.
 */

const { metersPerDeg } = require("./geo-frame");
const { nominatimReverse } = require("./nominatim");
const { userAgent: defaultUserAgent } = require("./version");
const { normalizeCountry, regionCode } = require("./usage-place");

const MAX_FILENAME = 60;
const LOOKUP_TIMEOUT_MS = 2000;
const PHOTON_REVERSE = "https://photon.komoot.io/reverse";

const ROAD_NAME =
  /\b(road|street|avenue|blvd|boulevard|drive|lane|way|hwy|highway|loop|trail|path|court|circle|place|terrace|alley|parkway|pkwy|freeway|expressway|bend)\b/i;

const FEATURE_KEYS = new Set([
  "tourism",
  "leisure",
  "amenity",
  "aeroway",
  "natural",
  "historic",
  "landuse",
  "man_made",
  "geological",
  "aerodrome",
  "campus",
  "park",
  "golf_course",
  "theme_park",
  "attraction",
  "museum",
  "zoo",
  "stadium",
  "university",
  "college",
  "resort",
  "camp_site",
  "caravan_site",
]);

/** Site types that may name the zip when they cover most of the box. */
const ENCLOSING_VALUES = new Set([
  "theme_park",
  "camp_site",
  "caravan_site",
  "resort",
  "zoo",
  "park",
  "golf_course",
  "stadium",
  "nature_reserve",
  "sports_centre",
  "recreation_ground",
  "university",
  "college",
  "aerodrome",
  "campus",
]);

/** Hotels and casinos only name the zip if they enclose most of the box. */
const LARGE_ONLY_VALUES = new Set(["hotel", "motel", "hostel", "casino"]);

const ROAD_KEYS = new Set(["highway", "road", "street", "path", "footway", "cycleway"]);
const ROAD_VALUES = new Set([
  "service",
  "residential",
  "unclassified",
  "tertiary",
  "secondary",
  "primary",
  "motorway",
  "trunk",
  "living_street",
  "path",
  "footway",
  "cycleway",
  "track",
  "pedestrian",
]);

const SKIP_FEATURE = new Set([
  "house",
  "residential",
  "yes",
  "road",
  "street",
  "highway",
  "building",
  "address",
  "house_number",
  "information",
  "parking",
  "fuel",
  "toilets",
]);

const COUNTRY_NAMES = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  canada: "CA",
  australia: "AU",
  brazil: "BR",
  france: "FR",
  germany: "DE",
  finland: "FI",
  japan: "JP",
  mexico: "MX",
  spain: "ES",
  italy: "IT",
  portugal: "PT",
  netherlands: "NL",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  ireland: "IE",
  "new zealand": "NZ",
  "south africa": "ZA",
  india: "IN",
  china: "CN",
  "south korea": "KR",
  korea: "KR",
  switzerland: "CH",
  austria: "AT",
  belgium: "BE",
  poland: "PL",
  chile: "CL",
  argentina: "AR",
  colombia: "CO",
  peru: "PE",
  singapore: "SG",
  "hong kong": "HK",
  taiwan: "TW",
  "united arab emirates": "AE",
  "saudi arabia": "SA",
};

let lookupOverride = null;

function setLookupForTests(fn) {
  lookupOverride = fn === undefined ? null : fn;
}

function bboxAreaM2(box) {
  if (!box) return 0;
  if (Number.isFinite(box.areaM2) && box.areaM2 > 0) return box.areaM2;
  const south = Number(box.south);
  const west = Number(box.west);
  const north = Number(box.north);
  const east = Number(box.east);
  if (![south, west, north, east].every(Number.isFinite)) return 0;
  if (!(south < north) || !(west < east)) return 0;
  const mpd = metersPerDeg((south + north) / 2);
  return Math.max(0, (east - west) * mpd.lon * (north - south) * mpd.lat);
}

function boxCenter(box) {
  if (!box) return null;
  const south = Number(box.south);
  const west = Number(box.west);
  const north = Number(box.north);
  const east = Number(box.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return { lat: (south + north) / 2, lon: (west + east) / 2 };
}

function formatAreaSize(areaM2) {
  const a = Number(areaM2);
  if (!Number.isFinite(a) || a <= 0) return "";
  if (a < 1000) return Math.max(1, Math.round(a)) + "m2";
  if (a < 10000) return Math.round(a / 10) * 10 + "m2";
  if (a < 1000000) {
    const ha = a / 10000;
    const n = ha < 10 ? Math.round(ha * 10) / 10 : Math.round(ha);
    return String(n).replace(/\.0$/, "") + "ha";
  }
  const km2 = a / 1000000;
  const n = km2 < 10 ? Math.round(km2 * 10) / 10 : Math.round(km2);
  return String(n).replace(/\.0$/, "") + "km2";
}

function formatDateUTC(now) {
  const d = now instanceof Date ? now : now ? new Date(now) : new Date();
  if (Number.isNaN(d.getTime())) return formatDateUTC(new Date());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return String(y) + m + day;
}

function coordFallback(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return "";
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return "";
  const alat = Math.abs(la).toFixed(2);
  const alon = Math.abs(lo).toFixed(2);
  return alat + (la >= 0 ? "N" : "S") + "_" + alon + (lo >= 0 ? "E" : "W");
}

function slugPart(text, maxLen) {
  const raw = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ");
  let slug = raw.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return "";
  if (maxLen && slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-+$/g, "");
  return slug;
}

function isGenericName(text) {
  const s = String(text || "").trim().toLowerCase();
  return !s || s === "site" || s === "openclutter" || s === "export";
}

function isStreetAddress(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/^\d+[A-Za-z]?\s+\S/.test(s)) return true;
  if (/\b\d{3,5}\b/.test(s) && ROAD_NAME.test(s)) return true;
  return false;
}

function usablePlaceName(text) {
  if (isGenericName(text) || isStreetAddress(text)) return "";
  return String(text || "").trim();
}

function countryCodeFromName(raw) {
  const s = String(raw || "").trim();
  if (/^[A-Za-z]{2}$/.test(s)) return normalizeCountry(s);
  const mapped = COUNTRY_NAMES[s.toLowerCase()];
  return mapped || "";
}

function compactLocality(text) {
  if (!text || typeof text !== "object" && !String(text).trim()) return "";
  if (text && typeof text === "object") {
    const city = String(
      text.city || text.town || text.village || text.municipality || text.hamlet || text.suburb || text.neighbourhood || ""
    ).trim();
    const cc = normalizeCountry(text.countryCode || text.country_code || text.countrycode);
    const region = cc && cc !== "unknown" ? regionCode(cc, text) : "";
    const regionShort = region && region.includes("-") ? region.split("-")[1] : "";
    if (city && regionShort) return slugPart(city + "-" + regionShort);
    if (city && cc && cc !== "unknown") return slugPart(city + "-" + cc);
    if (regionShort) return slugPart(regionShort);
    if (cc && cc !== "unknown") return cc;
    return slugPart(city);
  }
  const parts = String(text)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  let country = "";
  let region = "";
  let city = "";
  const lastCode = countryCodeFromName(parts[parts.length - 1]);
  if (lastCode && lastCode !== "unknown") {
    country = lastCode;
    parts.pop();
  }
  if (parts.length) {
    const maybeRegion = parts[parts.length - 1];
    if (/^[A-Za-z]{2,3}$/.test(maybeRegion)) {
      region = maybeRegion.toUpperCase();
      parts.pop();
    } else {
      const guessed = country
        ? regionCode(country, { state: maybeRegion, country_code: country.toLowerCase() })
        : regionCode("US", { state: maybeRegion }) || regionCode("CA", { state: maybeRegion }) || regionCode("AU", { state: maybeRegion });
      if (guessed && guessed.includes("-")) {
        region = guessed.split("-")[1];
        if (!country) country = guessed.split("-")[0];
        parts.pop();
      }
    }
  }
  city = parts[0] || "";
  if (city && region) return slugPart(city + "-" + region);
  if (city && country) return slugPart(city + "-" + country);
  if (region && country) return slugPart(region + "-" + country);
  if (city) return slugPart(city);
  if (region) return slugPart(region);
  return country || "";
}

function parseNamedLabel(raw) {
  const text = usablePlaceName(raw);
  if (!text) return { place: "", locality: "" };
  const split = text.split(/\s+-\s+/);
  if (split.length >= 2) {
    const place = usablePlaceName(split[0]);
    const locality = compactLocality(split.slice(1).join(", "));
    if (place) return { place: slugPart(place), locality };
  }
  return { place: slugPart(text), locality: "" };
}

function placeFromPicked(picked) {
  if (!picked || typeof picked !== "object") return { place: "", locality: "" };
  const place = slugPart(usablePlaceName(picked.name || picked.place || picked.label || ""));
  const locality = compactLocality(
    picked.locality ||
      {
        city: picked.city,
        town: picked.town,
        state: picked.state,
        province: picked.province,
        country_code: picked.countryCode || picked.country_code || picked.countrycode,
        country: picked.country,
        "ISO3166-2-lvl4": picked.iso || picked["ISO3166-2-lvl4"],
      }
  );
  return { place, locality };
}

function isFeatureType(key, value) {
  const k = String(key || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  if (SKIP_FEATURE.has(k) || SKIP_FEATURE.has(v)) return false;
  if (FEATURE_KEYS.has(k) || FEATURE_KEYS.has(v)) return true;
  return false;
}

function isRoadOrPath(props) {
  const p = props && (props.properties || props);
  if (!p || typeof p !== "object") {
    return ROAD_NAME.test(String(props || ""));
  }
  const key = String(p.osm_key || p.key || p.class || "").toLowerCase();
  const val = String(p.osm_value || p.value || "").toLowerCase();
  const typ = String(p.type || p.addresstype || "").toLowerCase();
  if (ROAD_KEYS.has(key) || ROAD_VALUES.has(val) || typ === "street" || typ === "road" || typ === "path") return true;
  const name = String(p.name || p.label || "");
  if (ROAD_NAME.test(name) && !isEnclosingType(key, val)) return true;
  return false;
}

function isBuildingHit(props) {
  const p = props && (props.properties || props);
  if (!p || typeof p !== "object") return false;
  const key = String(p.osm_key || p.key || p.class || "").toLowerCase();
  const val = String(p.osm_value || p.value || "").toLowerCase();
  if (key === "building" || val === "building") return true;
  if (key === "place" && (val === "house" || val === "isolated_dwelling")) return true;
  return false;
}

function isEnclosingType(key, value) {
  const k = String(key || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  if (SKIP_FEATURE.has(k) || SKIP_FEATURE.has(v)) return false;
  if (ENCLOSING_VALUES.has(v)) return true;
  if (k === "aeroway" && (v === "aerodrome" || v === "airport")) return true;
  if (k === "leisure" && ENCLOSING_VALUES.has(v)) return true;
  if (k === "tourism" && ENCLOSING_VALUES.has(v)) return true;
  if (k === "amenity" && ENCLOSING_VALUES.has(v)) return true;
  if (k === "landuse" && v === "recreation_ground") return true;
  return false;
}

function isLargeOnlyType(key, value) {
  const v = String(value || "").toLowerCase();
  return LARGE_ONLY_VALUES.has(v);
}

function extentBox(extent) {
  if (!Array.isArray(extent) || extent.length < 4) return null;
  const nums = extent.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const west = Math.min(nums[0], nums[2]);
  const east = Math.max(nums[0], nums[2]);
  const south = Math.min(nums[1], nums[3]);
  const north = Math.max(nums[1], nums[3]);
  if (!(south < north) || !(west < east)) return null;
  return { west, south, east, north };
}

function nominatimBoundingBox(raw) {
  const b = raw && (raw.boundingbox || raw.bbox);
  if (!Array.isArray(b) || b.length < 4) return null;
  const nums = b.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  // Nominatim boundingbox is [south, north, west, east].
  return extentBox([nums[2], nums[0], nums[3], nums[1]]);
}

function overlapShare(featBox, drawBox) {
  if (!featBox || !drawBox) return 0;
  const south = Math.max(featBox.south, drawBox.south);
  const north = Math.min(featBox.north, drawBox.north);
  const west = Math.max(featBox.west, drawBox.west);
  const east = Math.min(featBox.east, drawBox.east);
  if (!(south < north) || !(west < east)) return 0;
  const over = bboxAreaM2({ south, west, north, east });
  const box = bboxAreaM2(drawBox);
  if (!(box > 0)) return 0;
  return over / box;
}

function photonCity(p) {
  const city = String((p && p.city) || "").trim();
  const district = String((p && p.district) || "").trim();
  // Photon sometimes stores a truncated typo in city (KIss) beside a
  // good district (Bay Lake). Prefer the district in that case.
  const titled = /^[A-ZÀ-Ö][a-zà-ö'’]+(?:[ \-][A-ZÀ-Ö][a-zà-ö'’]+)*$/.test(city);
  const allCaps = /^[A-Z]{2,5}$/.test(city);
  if (city && district && !titled && !allCaps) return district;
  return city || district || String((p && (p.town || p.village)) || "").trim();
}

function localityFromPhotonProps(p) {
  return compactLocality({
    city: photonCity(p),
    state: p.state,
    country_code: p.countrycode || p.country_code,
    country: p.country,
  });
}

function photonProps(feature) {
  if (!feature || typeof feature !== "object") return null;
  return feature.properties || feature;
}

function enclosingScore(feature, box) {
  const p = photonProps(feature);
  if (!p) return -1;
  const key = p.osm_key || p.key || p.class || "";
  const val = p.osm_value || p.value || p.type || "";
  if (!usablePlaceName(p.name || p.label || "")) return -1;
  if (isRoadOrPath(p) || isBuildingHit(p)) return -1;
  const enclosing = isEnclosingType(key, val);
  const largeOnly = isLargeOnlyType(key, val);
  if (!enclosing && !largeOnly) return -1;
  const featBox = extentBox(p.extent) || nominatimBoundingBox(p) || nominatimBoundingBox(feature);
  const share = overlapShare(featBox, box);
  if (largeOnly && share < 0.5) return -1;
  if (enclosing && featBox && share < 0.2 && bboxAreaM2(featBox) < 0.5 * (bboxAreaM2(box) || 0)) return -1;
  let s = 50;
  if (enclosing) s += 100;
  if (largeOnly) s += 40;
  s += Math.round(share * 80);
  if (featBox && box) {
    const featA = bboxAreaM2(featBox);
    const boxA = bboxAreaM2(box);
    if (featA > 0 && boxA > 0) {
      const fit = Math.min(featA, boxA) / Math.max(featA, boxA);
      s += Math.round(fit * 40);
    }
  } else if (enclosing) {
    // A preferred site near the centre with no extent (a campground node).
    s += 25;
  }
  return s;
}

function pickEnclosingPlace(features, box) {
  const list = Array.isArray(features) ? features : features ? [features] : [];
  let best = null;
  let bestScore = 0;
  let locality = "";
  for (let i = 0; i < list.length; i++) {
    const feat = list[i];
    const p = photonProps(feat);
    if (p && !locality) locality = localityFromPhotonProps(p);
    const s = enclosingScore(feat, box);
    if (s < 0) continue;
    if (!best || s > bestScore) {
      best = feat;
      bestScore = s;
    }
  }
  if (best) {
    const p = photonProps(best);
    const place = slugPart(usablePlaceName(p.name || p.label || ""));
    const loc = localityFromPhotonProps(p) || locality;
    if (place) return { place, locality: loc };
  }
  return { place: "", locality };
}

function cityFallback(features, nom) {
  const list = Array.isArray(features) ? features : [];
  for (let i = 0; i < list.length; i++) {
    const loc = localityFromPhotonProps(photonProps(list[i]) || {});
    if (loc) return { place: "", locality: loc };
  }
  if (nom && typeof nom === "object") {
    const parsed = placeFromNominatim(nom);
    return { place: "", locality: parsed.locality || "" };
  }
  return { place: "", locality: "" };
}

function placeFromPhoton(feature) {
  if (!feature || typeof feature !== "object") return { place: "", locality: "" };
  const picked = pickEnclosingPlace([feature], null);
  if (picked.place) return picked;
  const p = photonProps(feature) || {};
  return { place: "", locality: localityFromPhotonProps(p) };
}

function placeFromNominatim(data) {
  if (!data || typeof data !== "object") return { place: "", locality: "" };
  const a = data.address && typeof data.address === "object" ? data.address : {};
  const type = data.addresstype || data.type || data.category || data.class || "";
  const rawName = usablePlaceName(data.name || a.tourism || a.leisure || a.amenity || a.aeroway || "");
  const useName = rawName && !isStreetAddress(rawName) && !SKIP_FEATURE.has(String(type).toLowerCase());
  const feature = useName && isFeatureType(data.class, type) ? rawName : useName && !ROAD_NAME.test(rawName) ? rawName : "";
  const neighbourhood = a.neighbourhood || a.suburb || a.quarter || a.city_district || "";
  const city = a.city || a.town || a.village || a.municipality || a.hamlet || "";
  const locality = compactLocality({
    city: city || neighbourhood,
    state: a.state,
    province: a.province,
    country_code: a.country_code || data.country_code,
    country: a.country,
    "ISO3166-2-lvl4": a["ISO3166-2-lvl4"],
    state_code: a.state_code,
  });
  const place = slugPart(feature || (neighbourhood && neighbourhood !== city ? neighbourhood : ""));
  if (place && locality && slugPart(place) === slugPart(city)) {
    return { place: "", locality };
  }
  return { place, locality };
}

const GENERIC_TAIL = new Set([
  "resort",
  "resorts",
  "campground",
  "campgrounds",
  "hotel",
  "hotels",
  "casino",
  "casinos",
  "complex",
  "center",
  "centre",
  "international",
  "recreation",
  "area",
  "and",
]);

function trimGenericTail(slug) {
  const parts = String(slug || "").split("-").filter(Boolean);
  while (parts.length > 1 && GENERIC_TAIL.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
  return parts.join("-");
}

function clipSlug(slug, maxLen) {
  const s = String(slug || "");
  if (!maxLen || s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const hyphen = cut.lastIndexOf("-");
  if (hyphen >= Math.min(4, maxLen)) return cut.slice(0, hyphen);
  return cut.replace(/-+$/g, "");
}

function fitFilename(place, locality, size, date, maxLen) {
  const limit = maxLen || MAX_FILENAME;
  const tailParts = [size, date].filter(Boolean);
  const tail = tailParts.join("_");
  const tailLen = tail ? tail.length + 1 : 0;
  const suffix = ".zip";
  const budget = Math.max(8, limit - tailLen - suffix.length);
  let placePart = String(place || "");
  let locPart = String(locality || "");
  let left = [placePart, locPart].filter(Boolean).join("_");
  if (left.length > budget) {
    const shorter = trimGenericTail(placePart);
    if (shorter && shorter !== placePart) placePart = shorter;
    left = [placePart, locPart].filter(Boolean).join("_");
  }
  if (left.length > budget) {
    const locBudget = locPart ? Math.min(locPart.length, Math.max(4, Math.floor(budget * 0.4))) : 0;
    locPart = locPart ? clipSlug(locPart, locBudget) : "";
    const placeBudget = budget - (locPart ? locPart.length + 1 : 0);
    placePart = clipSlug(placePart, Math.max(4, placeBudget));
    left = [placePart, locPart].filter(Boolean).join("_");
    if (left.length > budget) left = clipSlug(left, budget);
  }
  const body = [left, tail].filter(Boolean).join("_");
  return (body || "openclutter") + suffix;
}

function buildExportZipName(opts) {
  const o = opts || {};
  const area = bboxAreaM2(o);
  const size = formatAreaSize(area);
  const date = formatDateUTC(o.now);
  const center = boxCenter(o) || { lat: o.lat, lon: o.lon };
  const coords = coordFallback(center && center.lat, center && center.lon);
  let place = slugPart(o.place || "");
  let locality = typeof o.locality === "string" && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(o.locality)
    ? o.locality
    : compactLocality(o.locality || "");
  if (place && locality && place === locality) locality = "";
  if (place && locality && locality.startsWith(place + "-")) {
    locality = locality.slice(place.length + 1);
  }
  if (!place && !locality) place = coords;
  return fitFilename(place, locality, size, date, o.maxLen);
}

function withTimeout(promise, ms) {
  const budget = Math.max(0, ms);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), budget);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

async function photonReverse(lat, lon, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || fetch;
  const limit = Math.max(1, Math.min(15, Number(o.limit) || 10));
  const url =
    PHOTON_REVERSE +
    "?lon=" +
    encodeURIComponent(lon) +
    "&lat=" +
    encodeURIComponent(lat) +
    "&limit=" +
    limit;
  const r = await fetchImpl(url, {
    headers: { "user-agent": o.userAgent || defaultUserAgent, accept: "application/json" },
    signal: AbortSignal.timeout(o.timeoutMs || LOOKUP_TIMEOUT_MS),
  });
  if (!r.ok) return [];
  const data = await r.json();
  if (data && Array.isArray(data.features)) return data.features;
  if (data && typeof data === "object") return [data];
  return [];
}

function skipLiveLookup(opts) {
  // node --test sets NODE_TEST_CONTEXT. Skip the live Photon/Nominatim
  // call unless a test injected a fetch or lookup, so the suite does not
  // wait on Nominatim's 1 request/s slot.
  if (typeof lookupOverride === "function") return false;
  if (opts && opts.fetch) return false;
  return !!process.env.NODE_TEST_CONTEXT;
}

async function lookupPlace(lat, lon, opts) {
  const o = opts || {};
  if (typeof lookupOverride === "function") return lookupOverride(lat, lon, o);
  if (skipLiveLookup(o)) return { place: "", locality: "" };
  const timeoutMs = o.timeoutMs || LOOKUP_TIMEOUT_MS;
  // Leave a little slack so a late Nominatim wait cannot outrun the
  // outer 2 s cap and drop a Photon hit already in hand.
  const budget = Math.max(100, timeoutMs - 150);
  const started = Date.now();
  const remaining = () => Math.max(0, budget - (Date.now() - started));
  const box = o.west != null ? { west: o.west, south: o.south, east: o.east, north: o.north } : null;
  const photonP = withTimeout(
    photonReverse(lat, lon, {
      fetch: o.fetch,
      userAgent: o.userAgent,
      timeoutMs: budget,
      limit: 10,
    }),
    budget
  );
  const nomP = withTimeout(
    nominatimReverse(lat, lon, {
      fetch: o.fetch,
      env: o.env,
      userAgent: o.userAgent || defaultUserAgent,
      timeoutMs: budget,
    }),
    budget
  );
  const photon = await photonP;
  const features = Array.isArray(photon) ? photon : photon ? [photon] : [];
  let picked;
  try {
    picked = pickEnclosingPlace(features, box);
  } catch {
    picked = { place: "", locality: "" };
  }
  if (picked.place && picked.locality) return picked;
  const cityFromPhoton = cityFallback(features, null);
  if (picked.place && cityFromPhoton.locality) {
    picked.locality = cityFromPhoton.locality;
    return picked;
  }
  if (!picked.place && cityFromPhoton.locality) return cityFromPhoton;
  const left = remaining();
  if (left < 80) return picked.place ? picked : cityFromPhoton;
  const nom = await withTimeout(nomP, left);
  const nomData = nom && nom.ok ? nom.data : null;
  if (picked.place) {
    if (!picked.locality && nomData) {
      picked.locality = placeFromNominatim(nomData).locality || "";
    }
    return picked;
  }
  return cityFallback(features, nomData);
}

async function resolveExportZipName(opts) {
  const o = opts || {};
  try {
    const picked = placeFromPicked(o.pickedPlace);
    const named = parseNamedLabel(o.name);
    let place = picked.place || named.place;
    let locality = picked.locality || named.locality;
    const center = boxCenter(o) || { lat: o.lat, lon: o.lon };
    const needLookup = (!place || !locality) && center && Number.isFinite(center.lat) && Number.isFinite(center.lon);
    if (needLookup) {
      const found = await withTimeout(lookupPlace(center.lat, center.lon, o), o.timeoutMs || LOOKUP_TIMEOUT_MS);
      if (found) {
        if (!place) place = found.place;
        if (!locality) locality = found.locality;
      }
    }
    return buildExportZipName({
      place,
      locality,
      south: o.south,
      west: o.west,
      north: o.north,
      east: o.east,
      areaM2: o.areaM2,
      lat: center && center.lat,
      lon: center && center.lon,
      now: o.now,
      maxLen: o.maxLen,
    });
  } catch {
    const center = boxCenter(o) || { lat: o.lat, lon: o.lon };
    return buildExportZipName({
      south: o.south,
      west: o.west,
      north: o.north,
      east: o.east,
      areaM2: o.areaM2,
      lat: center && center.lat,
      lon: center && center.lon,
      now: o.now,
      maxLen: o.maxLen,
    });
  }
}

function safeZipFilename(name) {
  const raw = String(name || "openclutter.zip").replace(/[^A-Za-z0-9._-]+/g, "-");
  return raw.endsWith(".zip") ? raw : raw + ".zip";
}

module.exports = {
  MAX_FILENAME,
  LOOKUP_TIMEOUT_MS,
  PHOTON_REVERSE,
  bboxAreaM2,
  boxCenter,
  formatAreaSize,
  formatDateUTC,
  coordFallback,
  slugPart,
  isStreetAddress,
  isGenericName,
  usablePlaceName,
  compactLocality,
  parseNamedLabel,
  placeFromPicked,
  placeFromPhoton,
  placeFromNominatim,
  isRoadOrPath,
  pickEnclosingPlace,
  overlapShare,
  extentBox,
  buildExportZipName,
  resolveExportZipName,
  safeZipFilename,
  setLookupForTests,
};
