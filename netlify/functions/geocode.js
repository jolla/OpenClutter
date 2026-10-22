const { userAgent: UA } = require("../lib/version");
const { geocodeQueries } = require("../lib/geocode-query");
const { bestPlace } = require("../lib/place-search");
const { nominatimSearch } = require("../lib/nominatim");

function viewFrom(params) {
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function nominatim(q) {
  return nominatimSearch(q, { userAgent: UA });
}

exports.handler = async (event) => {
  return require("../lib/stage-clock").timeSpan("geocode", () => geocodeHandler(event));
};

async function geocodeHandler(event) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  const params = event.queryStringParameters || {};
  const q = params.q || "";
  if (!q || q.length > 200) {
    return { statusCode: 400, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ error: "q required" }) };
  }
  const json = (body) => ({
    statusCode: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Photon (OpenStreetMap), ranked near the map view. A clean word-for-word
  // match wins. Otherwise Nominatim, paced to 1 request per second app-wide.
  let ranked = null;
  try {
    ranked = await bestPlace(q, viewFrom(params), { userAgent: UA });
  } catch {
    ranked = null;
  }
  if (ranked && ranked.exact >= 0.99) return json([ranked]);
  const queries = geocodeQueries(q);
  let sawOk = false;
  let lastStatus = 502;
  async function firstHit(list) {
    for (let i = 0; i < list.length; i++) {
      const hit = await nominatim(list[i]);
      lastStatus = hit.status;
      if (hit.ok) sawOk = true;
      if (hit.ok && hit.data.length) return hit.data;
    }
    return null;
  }
  if (ranked) return json([ranked]);
  const found = await firstHit(queries);
  if (found) {
    return {
      statusCode: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(found),
    };
  }
  if (!sawOk) {
    return {
      statusCode: lastStatus || 502,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "geocode failed" }),
    };
  }
  return {
    statusCode: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify([]),
  };
};
