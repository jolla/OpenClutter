const { userAgent: UA } = require("../lib/version");
const { geocodeQueries } = require("../lib/geocode-query");

async function nominatim(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { ok: false, status: r.status, data: [] };
  const data = await r.json();
  return { ok: true, status: 200, data: Array.isArray(data) ? data : [] };
}

exports.handler = async (event) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  const q = (event.queryStringParameters || {}).q || "";
  if (!q || q.length > 200) {
    return { statusCode: 400, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ error: "q required" }) };
  }
  const queries = geocodeQueries(q);
  let sawOk = false;
  let lastStatus = 502;
  for (let i = 0; i < queries.length; i++) {
    const hit = await nominatim(queries[i]);
    lastStatus = hit.status;
    if (hit.ok) sawOk = true;
    if (hit.ok && hit.data.length) {
      return {
        statusCode: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify(hit.data),
      };
    }
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
