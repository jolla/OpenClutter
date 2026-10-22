"use strict";

const { userAgent: UA } = require("../lib/version");
const { suggestPlaces } = require("../lib/place-search");

/** Autocomplete for the search box: Photon (OpenStreetMap), ranked near the view. */
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
  try {
    const list = await suggestPlaces(q, view, { userAgent: UA, timeoutMs: 3000 });
    return { statusCode: 200, headers, body: JSON.stringify(list) };
  } catch {
    return { statusCode: 200, headers, body: "[]" };
  }
};
