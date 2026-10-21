"use strict";

/**
 * Place search for the search box. Photon (komoot, OpenStreetMap data) is
 * fuzzy and catches typos such as "caesers palace" and "golden gate brige".
 * It is asked once, biased to the map center, and ranked by how well the
 * label matches the typed words plus distance from the view. The anonymous
 * Esri World Geocoding calls were removed: that service needs an ArcGIS
 * token under Esri's terms. Search results (c) OpenStreetMap contributors.
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
  return [street, p.city || p.district || p.county, p.state, p.country]
    .filter((x, i, a) => x && a.indexOf(x) === i && x !== p.name)
    .join(", ");
}

async function photonSearch(q, view, fetchFn, signal, userAgent) {
  let url = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}`;
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
      };
    })
    .filter((x) => x.label);
}

/** Merge, score, and dedupe. Exported for tests. */
function rankPlaces(q, view, esri, photon) {
  const all = [...(esri || []), ...(photon || [])].map((c) => {
    const match = Math.max(textScore(q, c.text), 0.7 * textScore(q, c.text) + 0.3 * textScore(q, c.label));
    const named = 0.7 * textScore(q, c.text) + 0.3 * textScore(q, c.label);
    const extra = Math.max(0, norm(c.label).split(" ").length - norm(q).split(" ").length);
    let near = 0;
    if (view && Number.isFinite(c.lat)) {
      near = 0.25 * Math.exp(-km(view.lat, view.lon, c.lat, c.lon) / 50);
    } else if (view && c.source === "esri") {
      near = 0.1; // Esri already sorts by distance to location.
    }
    const order = 0.08 * Math.exp(-c.rank / 2);
    const source = c.source === "esri" ? 0.04 : 0;
    return { ...c, exact: textScore(q, c.text, false), score: named + near + order + source - 0.02 * Math.min(extra, 5), match };
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
  const photon = await photonSearch(q, view, fetchFn, AbortSignal.timeout(timeoutMs), userAgent).catch(() => []);
  return rankPlaces(q, view, [], photon).slice(0, 6).map((c) => ({
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

module.exports = { suggestPlaces, bestPlace, rankPlaces, textScore, norm };
