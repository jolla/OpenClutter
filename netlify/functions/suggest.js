"use strict";

const { userAgent: UA } = require("../lib/version");
const { suggestPlaces, SUGGEST_TIMEOUT_MS } = require("../lib/place-search");
const { cacheGet, cacheSet } = require("../lib/search-cache");

/** Autocomplete for the search box: Photon (OpenStreetMap) only, ranked near the view. */
exports.handler = async (event) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  const params = event.queryStringParameters || {};
  const q = String(params.q || "").trim();
  const headers = { ...cors, "content-type": "application/json", "cache-control": "public, max-age=300" };
  if (q.length < 2 || q.length > 200) return { statusCode: 200, headers, body: "[]" };
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  const view = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  const started = Date.now();
  try {
    const cached = await cacheGet("suggest", q, view);
    if (cached) {
      headers["x-oc-search-cache"] = "hit";
      headers["x-oc-search-ms"] = String(Date.now() - started);
      return { statusCode: 200, headers, body: JSON.stringify(cached) };
    }
    const list = await suggestPlaces(q, view, { userAgent: UA, timeoutMs: SUGGEST_TIMEOUT_MS });
    headers["x-oc-search-cache"] = "miss";
    headers["x-oc-search-ms"] = String(Date.now() - started);
    // Do not cache an empty miss: a timeout or a brief Photon gap would stick.
    if (!list.length) {
      headers["cache-control"] = "no-store";
      return { statusCode: 200, headers, body: "[]" };
    }
    await cacheSet("suggest", q, view, list);
    return { statusCode: 200, headers, body: JSON.stringify(list) };
  } catch {
    headers["cache-control"] = "no-store";
    headers["x-oc-search-cache"] = "miss";
    headers["x-oc-search-ms"] = String(Date.now() - started);
    return { statusCode: 200, headers, body: "[]" };
  }
};
