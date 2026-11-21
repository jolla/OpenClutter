"use strict";

/**
 * Coarse place codes for anonymous usage totals. The only stored values are
 * ISO country codes, and ISO 3166-2 region codes for the US, Canada, and
 * Australia. Coordinates, addresses, and finer place names are not kept.
 *
 * Export location comes from a Nominatim reverse of the drawn area's
 * center, the same free source used to name the box on the map. Visitor
 * country comes from Netlify's request geo (context.geo.country.code).
 * A failed lookup is recorded as "unknown".
 */

const { nominatimReverse } = require("./nominatim");
const { userAgent } = require("./version");

const UNKNOWN = "unknown";
const REGION_COUNTRIES = new Set(["US", "CA", "AU"]);
const LOOKUP_TIMEOUT_MS = 1500;

const REGION_ABBR = {
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
  yukon: "YT",
  "northwest territories": "NT",
  nunavut: "NU",
  "new south wales": "NSW",
  victoria: "VIC",
  queensland: "QLD",
  "south australia": "SA",
  "western australia": "WA",
  tasmania: "TAS",
  "northern territory": "NT",
  "australian capital territory": "ACT",
};

let lookupOverride = null;

function setLookupForTests(fn) {
  lookupOverride = fn === undefined ? null : fn;
}

function normalizeCountry(code) {
  let c = String(code || "").trim().toUpperCase();
  if (c === "UK") c = "GB";
  if (c === "UNKNOWN") return UNKNOWN;
  if (!/^[A-Z]{2}$/.test(c)) return UNKNOWN;
  return c;
}

function visitorCountryFrom(geo) {
  if (!geo || typeof geo !== "object") return UNKNOWN;
  const raw = geo.country && typeof geo.country === "object" ? geo.country.code : geo.country;
  return normalizeCountry(raw);
}

function isCountryKey(key) {
  return key === UNKNOWN || /^[A-Z]{2}$/.test(String(key || ""));
}

function isRegionKey(key) {
  return /^[A-Z]{2}-[A-Z]{2,3}$/.test(String(key || ""));
}

function regionCode(country, address) {
  const cc = normalizeCountry(country);
  if (!REGION_COUNTRIES.has(cc)) return "";
  const a = address && typeof address === "object" ? address : {};
  const iso = String(a["ISO3166-2-lvl4"] || a["ISO3166-2-lvl3"] || a["iso3166-2-lvl4"] || "").toUpperCase();
  const isoMatch = /^([A-Z]{2})-([A-Z]{2,3})$/.exec(iso);
  if (isoMatch && isoMatch[1] === cc) return isoMatch[1] + "-" + isoMatch[2];
  const raw = String(a.state_code || a.state || a.province || a.region || "").trim();
  if (/^[A-Za-z]{2,3}$/.test(raw)) return cc + "-" + raw.toUpperCase();
  const abbr = REGION_ABBR[raw.toLowerCase()];
  if (abbr) return cc + "-" + abbr;
  return "";
}

function codesFromAddress(data) {
  const a = data && data.address && typeof data.address === "object" ? data.address : {};
  const country = normalizeCountry(a.country_code || a.country_code_iso || (data && data.country_code));
  const region = country === UNKNOWN ? "" : regionCode(country, a);
  return { country, region };
}

function parseExportBox(input) {
  if (!input || typeof input !== "object") return null;
  const south = Number(input.south);
  const west = Number(input.west);
  const north = Number(input.north);
  const east = Number(input.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (!(south < north) || !(west < east)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { south, west, north, east };
}

function boxCenter(box) {
  const b = parseExportBox(box);
  if (!b) return null;
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

const UNKNOWN_PLACE = { country: UNKNOWN, region: "" };

async function lookupExportPlace(input, opts) {
  if (typeof lookupOverride === "function") return lookupOverride(input, opts);
  const center = boxCenter(input);
  if (!center) return Object.assign({}, UNKNOWN_PLACE);
  const o = opts || {};
  try {
    const res = await nominatimReverse(center.lat, center.lon, {
      fetch: o.fetch,
      env: o.env,
      userAgent: o.userAgent || userAgent,
      timeoutMs: o.timeoutMs || LOOKUP_TIMEOUT_MS,
    });
    if (!res || !res.ok || !res.data) return Object.assign({}, UNKNOWN_PLACE);
    return codesFromAddress(res.data);
  } catch {
    return Object.assign({}, UNKNOWN_PLACE);
  }
}

module.exports = {
  UNKNOWN,
  REGION_COUNTRIES,
  LOOKUP_TIMEOUT_MS,
  normalizeCountry,
  visitorCountryFrom,
  isCountryKey,
  isRegionKey,
  regionCode,
  codesFromAddress,
  parseExportBox,
  boxCenter,
  lookupExportPlace,
  setLookupForTests,
};
