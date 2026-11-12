"use strict";

/**
 * Enter-to-search: ask Photon and Nominatim at the same time and take
 * the first good result. Nominatim is one request per search, paced to
 * 1 request per second, never used for autocomplete. Hits are cached;
 * empty and error replies are not.
 */

const { preferredNominatimQuery } = require("./geocode-query");
const { bestPlace, GEOCODE_PHOTON_TIMEOUT_MS } = require("./place-search");
const { nominatimSearch } = require("./nominatim");
const { cacheGet, cacheSet } = require("./search-cache");

function withSource(hits, source) {
  return (hits || []).map((h) => (h && h.source === source ? h : { ...h, source }));
}

function goodPhoton(hit) {
  return hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon);
}

function goodNominatim(res) {
  return !!(res && res.ok && Array.isArray(res.data) && res.data.length && Number.isFinite(+res.data[0].lat));
}

async function raceProviders(q, view, opts) {
  const o = opts || {};
  const ac = new AbortController();
  const photonOpts = {
    fetchFn: o.fetch || fetch,
    userAgent: o.userAgent,
    timeoutMs: o.photonTimeoutMs || GEOCODE_PHOTON_TIMEOUT_MS,
    signal: ac.signal,
  };
  const nomiOpts = {
    fetch: o.fetch || fetch,
    userAgent: o.userAgent,
    env: o.env,
    timeoutMs: o.nominatimTimeoutMs,
  };
  const query = preferredNominatimQuery(q);

  let photonHit = null;
  let photonDone = false;
  let photonFailed = false;
  let nomiRes = null;
  let nomiDone = false;

  const photonP = Promise.resolve()
    .then(() => bestPlace(q, view, photonOpts))
    .then((hit) => {
      photonHit = hit;
      photonDone = true;
    })
    .catch(() => {
      photonFailed = true;
      photonDone = true;
    });

  const nomiP = Promise.resolve()
    .then(() => nominatimSearch(query, nomiOpts))
    .then((res) => {
      nomiRes = res;
      nomiDone = true;
    })
    .catch(() => {
      nomiDone = true;
    });

  function finishPhoton() {
    ac.abort();
    const hits = withSource(
      [
        {
          lat: photonHit.lat,
          lon: photonHit.lon,
          display_name: photonHit.display_name,
          match: photonHit.match,
          exact: photonHit.exact,
        },
      ],
      "photon"
    );
    return { ok: true, status: 200, hits, source: "photon", cached: false };
  }

  function finishNominatim() {
    ac.abort();
    return {
      ok: true,
      status: 200,
      hits: withSource(nomiRes.data, "nominatim"),
      source: "nominatim",
      cached: false,
    };
  }

  while (!photonDone || !nomiDone) {
    await Promise.race([
      photonDone ? new Promise(() => {}) : photonP,
      nomiDone ? new Promise(() => {}) : nomiP,
    ]);
    if (photonDone && goodPhoton(photonHit)) return finishPhoton();
    if (nomiDone && goodNominatim(nomiRes)) return finishNominatim();
  }

  if (nomiRes && nomiRes.ok) {
    return { ok: true, status: 200, hits: [], source: "", cached: false };
  }
  if (!photonFailed && !nomiRes) {
    return { ok: true, status: 200, hits: [], source: "", cached: false };
  }
  return {
    ok: false,
    status: (nomiRes && nomiRes.status) || 502,
    hits: [],
    source: "",
    cached: false,
  };
}

async function geocodePlace(q, view, opts) {
  const cached = await cacheGet("geocode", q, view);
  if (cached) {
    const source = cached[0] && cached[0].source ? cached[0].source : "";
    return { ok: true, status: 200, hits: cached, source, cached: true };
  }
  const result = await raceProviders(q, view, opts);
  if (result.ok && result.hits.length) await cacheSet("geocode", q, view, result.hits);
  return result;
}

module.exports = { geocodePlace, withSource };
