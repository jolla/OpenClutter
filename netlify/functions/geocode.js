const { userAgent: UA } = require("../lib/version");
const { geocodeQueries } = require("../lib/geocode-query");
const { looksLikeVenueName, addressFromVenueText } = require("../lib/venue-address");

async function nominatim(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { ok: false, status: r.status, data: [] };
  const data = await r.json();
  return { ok: true, status: 200, data: Array.isArray(data) ? data : [] };
}

/** Public search page. Used only after Nominatim has no point for a venue name. */
async function venueSnippet(q) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; OpenClutter; +https://github.com/jolla/OpenClutter)",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return "";
  return r.text();
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
  async function firstHit(list) {
    for (let i = 0; i < list.length; i++) {
      const hit = await nominatim(list[i]);
      lastStatus = hit.status;
      if (hit.ok) sawOk = true;
      if (hit.ok && hit.data.length) return hit.data;
    }
    return null;
  }
  const found = await firstHit(queries);
  if (found) {
    return {
      statusCode: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(found),
    };
  }
  // Casa Evexia is not an OpenStreetMap point. A snippet that prints
  // "298 Lakeshore, Pointe-Claire, QC" is geocoded with the address path.
  if (looksLikeVenueName(q)) {
    try {
      const snippet = await venueSnippet(q);
      const address = addressFromVenueText(q, snippet);
      if (address) {
        const placed = await firstHit(geocodeQueries(address));
        if (placed) {
          return {
            statusCode: 200,
            headers: { ...cors, "content-type": "application/json" },
            body: JSON.stringify(placed),
          };
        }
      }
    } catch {
      // A missed snippet still returns the empty Nominatim result.
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
