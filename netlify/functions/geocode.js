const { userAgent: UA } = require("../lib/version");
const { geocodePlace } = require("../lib/geocode-place");

function viewFrom(params) {
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
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
  const started = Date.now();
  const result = await geocodePlace(q, viewFrom(params), { userAgent: UA });
  const headers = {
    ...cors,
    "content-type": "application/json",
    "x-oc-search-ms": String(Date.now() - started),
    "x-oc-search-cache": result.cached ? "hit" : "miss",
  };
  if (result.source) headers["x-oc-search-provider"] = result.source;
  if (result.ok && result.hits.length) {
    headers["cache-control"] = "public, max-age=300";
    return { statusCode: 200, headers, body: JSON.stringify(result.hits) };
  }
  headers["cache-control"] = "no-store";
  if (!result.ok) {
    return {
      statusCode: result.status || 502,
      headers,
      body: JSON.stringify({ error: "geocode failed" }),
    };
  }
  return { statusCode: 200, headers, body: "[]" };
};
