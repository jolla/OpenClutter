"use strict";

/**
 * Download name for an OpenIntent zip: a short place, the city or region,
 * the drawn area, and the UTC date. Inner OpenIntent file names stay on
 * the existing site slug; only the .zip download name uses this.
 *
 * A picked search result or a prior /api/reverse label is preferred. If
 * neither is usable, a Photon (then Nominatim) reverse of the box centre
 * runs with a 2 s cap and must not delay the export. Street addresses are
 * not used. A failed or slow lookup falls back to rounded coordinates.
 */

const { metersPerDeg } = require("./geo-frame");
const { nominatimReverse } = require("./nominatim");
const { userAgent: defaultUserAgent } = require("./version");
const { normalizeCountry, regionCode } = require("./usage-place");

const MAX_FILENAME = 60;
const LOOKUP_TIMEOUT_MS = 2000;
const PHOTON_REVERSE = "https://photon.komoot.io/reverse";

const ROAD_NAME =
  /\b(road|street|avenue|blvd|boulevard|drive|lane|way|hwy|highway|loop|trail|court|circle|place|terrace|alley|parkway|pkwy|freeway|expressway)\b/i;

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

function placeFromPhoton(feature) {
  if (!feature || typeof feature !== "object") return { place: "", locality: "" };
  const p = feature.properties || feature;
  const osmKey = p.osm_key || p.key || "";
  const osmValue = p.osm_value || p.value || p.type || "";
  const rawName = usablePlaceName(p.name || p.label || "");
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const placeName = isFeatureType(osmKey, osmValue) ? rawName : usablePlaceName(rawName && !isStreetAddress(rawName) && rawName !== street ? rawName : "");
  const city = p.city || p.district || p.county || "";
  const locality = compactLocality({
    city,
    state: p.state,
    country_code: p.countrycode || p.country_code,
    country: p.country,
  });
  const place = slugPart(placeName || (city && !placeName ? "" : ""));
  if (place && locality) return { place, locality };
  if (place) return { place, locality };
  if (city) {
    const citySlug = slugPart(city);
    const rest = compactLocality({
      state: p.state,
      country_code: p.countrycode || p.country_code,
      country: p.country,
    });
    if (citySlug && rest && !rest.startsWith(citySlug + "-") && rest !== citySlug) {
      return { place: citySlug, locality: rest };
    }
    return { place: "", locality: locality || citySlug };
  }
  return { place: "", locality };
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
  const url =
    PHOTON_REVERSE +
    "?lon=" +
    encodeURIComponent(lon) +
    "&lat=" +
    encodeURIComponent(lat) +
    "&limit=1";
  const r = await fetchImpl(url, {
    headers: { "user-agent": o.userAgent || defaultUserAgent, accept: "application/json" },
    signal: AbortSignal.timeout(o.timeoutMs || LOOKUP_TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const feature = data && Array.isArray(data.features) ? data.features[0] : data;
  return feature || null;
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
  const started = Date.now();
  const remaining = () => Math.max(100, timeoutMs - (Date.now() - started));
  const photon = await withTimeout(
    photonReverse(lat, lon, {
      fetch: o.fetch,
      userAgent: o.userAgent,
      timeoutMs,
    }),
    timeoutMs
  );
  const fromPhoton = placeFromPhoton(photon);
  if (fromPhoton.place || fromPhoton.locality) return fromPhoton;
  const left = remaining();
  if (left < 150) return { place: "", locality: "" };
  const nom = await withTimeout(
    nominatimReverse(lat, lon, {
      fetch: o.fetch,
      env: o.env,
      userAgent: o.userAgent || defaultUserAgent,
      timeoutMs: Math.min(left, 1500),
    }),
    left
  );
  if (!nom || !nom.ok || !nom.data) return { place: "", locality: "" };
  return placeFromNominatim(nom.data);
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
  buildExportZipName,
  resolveExportZipName,
  safeZipFilename,
  setLookupForTests,
};
