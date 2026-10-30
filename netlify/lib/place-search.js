"use strict";

/**
 * Place search for the search box. Photon (komoot, OpenStreetMap data) is
 * fuzzy and catches typos such as "caesers palace" and "golden gate brige".
 * It is asked once, biased to the map center, and ranked by how well the
 * label matches the typed words plus distance from the view. The anonymous
 * Esri World Geocoding calls were removed: that service needs an ArcGIS
 * token under Esri's terms. Search results (c) OpenStreetMap contributors.
 *
 * "City, ST" and "City State" ask for the town itself. Photon lists POIs
 * with the short state ("Sherman, TX") and towns with the long one
 * ("Travis, Texas"), so "Austin, Tx" matched Austin College on every word
 * but the city of Austin on only half. The state is now read as a state on
 * both sides, a second Photon call asks for places only, and a town whose
 * name is the typed name, in the typed state, goes first.
 */

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => ABBR[w] || w)
    .join(" ");
}

const ABBR = {
  bldg: "building", intl: "international", ctr: "center", centre: "center",
  mt: "mount", ft: "fort", pkwy: "parkway", hwy: "highway", univ: "university",
};

const STATES = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California",
  co: "Colorado", ct: "Connecticut", de: "Delaware", dc: "District of Columbia",
  fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois",
  in: "Indiana", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana",
  me: "Maine", md: "Maryland", ma: "Massachusetts", mi: "Michigan", mn: "Minnesota",
  ms: "Mississippi", mo: "Missouri", mt: "Montana", ne: "Nebraska", nv: "Nevada",
  nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico", ny: "New York",
  nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon",
  pa: "Pennsylvania", ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota",
  tn: "Tennessee", tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia",
  wa: "Washington", wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming",
  pr: "Puerto Rico",
  ab: "Alberta", bc: "British Columbia", mb: "Manitoba", nb: "New Brunswick",
  nl: "Newfoundland and Labrador", ns: "Nova Scotia", on: "Ontario",
  pe: "Prince Edward Island", qc: "Quebec", sk: "Saskatchewan",
};
const STATE_NAMES = Object.values(STATES)
  .map((n) => ({ n, k: norm(n) }))
  .sort((a, b) => b.k.length - a.k.length);

/** "TX" -> "Texas"; a full name or anything else comes back as is. */
function stateName(s) {
  const t = String(s || "").trim();
  return /^[A-Za-z]{2}$/.test(t) && STATES[t.toLowerCase()] ? STATES[t.toLowerCase()] : t;
}

/**
 * "Austin, Tx", "Austin TX", "Austin Texas" -> { place: "Austin", state: "Texas" }.
 * Without a comma, a code that is also a word ("Allow me", "open late ok")
 * needs capitals. Null when the query does not end in a state, is only a
 * state ("West Virginia"), or leaves no place name.
 */
const WORDLIKE = new Set(["al", "co", "de", "ga", "hi", "id", "in", "la", "ma", "me", "mi", "mo", "ms", "mt", "ne", "oh", "ok", "on", "or", "pa", "pe", "ut", "va", "wa"]);
function stateQuery(raw) {
  const q = String(raw || "").replace(/\s+/g, " ").trim();
  const nq = norm(q.replace(/,/g, " "));
  if (STATE_NAMES.some((s) => s.k === nq)) return null;
  const m = /^(.*?)(?:,\s*([A-Za-z]{2})|\s([A-Za-z]{2}))\.?$/.exec(q);
  if (m) {
    const code = (m[2] || m[3]).toLowerCase();
    const place = m[1].replace(/[\s,]+$/, "");
    const ok = m[2] || /^[A-Z]{2}$/.test(m[3]) || !WORDLIKE.has(code);
    if (STATES[code] && ok && norm(place)) return { place, state: STATES[code] };
  }
  for (const { n, k } of STATE_NAMES) {
    if (!nq.endsWith(" " + k)) continue;
    const words = k.split(" ").length;
    const place = q.replace(/,/g, " ").trim().split(/\s+/).slice(0, -words).join(" ").trim();
    if (norm(place)) return { place, state: n };
  }
  return null;
}

const SETTLEMENT = new Set(["city", "town", "village", "hamlet", "municipality", "borough", "suburb", "locality"]);

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}

const STOP = new Set(["the", "of", "and", "st", "ave", "rd", "dr", "blvd", "usa"]);

/** Share of typed words found in the label (prefix, or one typo per 5 letters). */
function textScore(query, label, typos = true) {
  const q = norm(query).split(" ").filter((w) => w && !STOP.has(w));
  if (!q.length) return 0;
  const words = norm(label).split(" ");
  let hit = 0;
  q.forEach((w, idx) => {
    const last = idx === q.length - 1;
    const ok = words.some((x) => {
      if (x === w) return true;
      if ((last ? w.length >= 2 : w.length >= 3) && x.startsWith(w)) return true;
      if (last && w.length >= 4 && x.startsWith(w.slice(0, -1))) return true;
      const allowed = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
      return typos && allowed > 0 && editDistance(w, x) <= allowed;
    });
    if (ok) hit++;
  });
  return hit / q.length;
}

function km(a, b, c, d) {
  const r = Math.PI / 180;
  const x = (d - b) * r * Math.cos(((a + c) / 2) * r);
  const y = (c - a) * r;
  return 6371 * Math.hypot(x, y);
}

function validView(view) {
  return view && Number.isFinite(view.lat) && Number.isFinite(view.lon) &&
    Math.abs(view.lat) <= 90 && Math.abs(view.lon) <= 180 ? view : null;
}

function photonDetail(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  return [street, p.city || p.district || p.county, stateName(p.state), p.country]
    .filter((x, i, a) => x && a.indexOf(x) === i && x !== p.name)
    .join(", ");
}

async function photonSearch(q, view, fetchFn, signal, userAgent, placesOnly = false) {
  let url = `https://photon.komoot.io/api/?limit=${placesOnly ? 5 : 6}&q=${encodeURIComponent(q)}`;
  if (placesOnly) url += "&osm_tag=place";
  if (view) url += `&lat=${view.lat}&lon=${view.lon}`;
  const r = await fetchFn(url, { signal, headers: { "user-agent": userAgent } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.features || [])
    .filter((f) => f && f.geometry && Array.isArray(f.geometry.coordinates))
    .map((f, i) => {
      const p = f.properties || {};
      const street = [p.housenumber, p.street].filter(Boolean).join(" ");
      const label = p.name || street || p.city || "";
      return {
        label,
        detail: photonDetail({ ...p, name: label }),
        text: [label, photonDetail({ ...p, name: label })].filter(Boolean).join(", "),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        source: "photon",
        rank: i,
        kind: p.osm_key === "place" ? p.osm_value || "" : "",
        state: stateName(p.state),
      };
    })
    .filter((x) => x.label);
}

/** Merge, score, and dedupe. Exported for tests. */
function rankPlaces(qIn, view, esri, photon) {
  const sq = stateQuery(qIn);
  const q = sq ? `${sq.place}, ${sq.state}` : qIn;
  const all = [...(esri || []), ...(photon || [])].map((c) => {
    const match = Math.max(textScore(q, c.text), 0.7 * textScore(q, c.text) + 0.3 * textScore(q, c.label));
    const named = 0.7 * textScore(q, c.text) + 0.3 * textScore(q, c.label);
    const extra = Math.max(0, norm(c.label).split(" ").length - norm(sq ? sq.place : q).split(" ").length);
    let near = 0;
    if (view && Number.isFinite(c.lat)) {
      near = 0.25 * Math.exp(-km(view.lat, view.lon, c.lat, c.lon) / 50);
    } else if (view && c.source === "esri") {
      near = 0.1; // Esri already sorts by distance to location.
    }
    const order = 0.08 * Math.exp(-c.rank / 2);
    const source = c.source === "esri" ? 0.04 : 0;
    // The town itself, in the typed state, beats POIs that share its name.
    const town = sq && SETTLEMENT.has(c.kind) && norm(c.label) === norm(sq.place) &&
      norm(c.state) === norm(sq.state) ? 0.6 : 0;
    return { ...c, exact: textScore(q, c.text, false), score: named + near + order + source + town - 0.02 * Math.min(extra, 5), match };
  });
  all.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of all) {
    const dup = out.some((o) => {
      if (norm(o.label) !== norm(c.label)) return false;
      if (Number.isFinite(o.lat) && Number.isFinite(c.lat)) return km(o.lat, o.lon, c.lat, c.lon) < 0.5;
      return norm(o.detail).split(" ")[0] === norm(c.detail).split(" ")[0] || o.source !== c.source;
    });
    if (!dup) out.push(c);
  }
  return out;
}

async function suggestPlaces(q, viewIn, { fetchFn = fetch, userAgent = "openclutter", timeoutMs = 4000 } = {}) {
  const view = validView(viewIn);
  const signal = AbortSignal.timeout(timeoutMs);
  const sq = stateQuery(q);
  const [photon, towns] = await Promise.all([
    photonSearch(q, view, fetchFn, signal, userAgent).catch(() => []),
    sq && sq.place.split(/\s+/).length <= 4 && !/\d/.test(sq.place)
      ? photonSearch(`${sq.place}, ${sq.state}`, view, fetchFn, signal, userAgent, true).catch(() => [])
      : [],
  ]);
  return rankPlaces(q, view, [], [...photon, ...towns]).slice(0, 6).map((c) => ({
    label: c.label,
    detail: c.detail,
    text: c.text,
    source: c.source,
    match: Math.round(c.match * 100) / 100,
    exact: Math.round(c.exact * 100) / 100,
    lat: c.lat,
    lon: c.lon,
  }));
}

/**
 * Enter with no pick: best ranked place, resolved to a point. Returns null
 * when nothing matches most of the typed words, so the caller can fall back.
 */
async function bestPlace(q, view, opts = {}) {
  const list = await suggestPlaces(q, view, opts);
  for (const c of list.slice(0, 3)) {
    if (c.match < 0.6) break;
    if (Number.isFinite(c.lat)) return { lat: c.lat, lon: c.lon, display_name: c.text, match: c.match, exact: c.exact };
  }
  return null;
}

module.exports = { suggestPlaces, bestPlace, rankPlaces, textScore, norm, stateQuery };
