const { userAgent: UA } = require("../lib/version");
const { geocodeQueries } = require("../lib/geocode-query");
const { looksLikeVenueName, addressFromVenueText } = require("../lib/venue-address");
const { bestPlace, resolveMagicKey } = require("../lib/place-search");

function viewFrom(params) {
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

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
  // A picked Esri suggestion carries its magicKey.
  if (params.magicKey && params.magicKey.length < 400) {
    const p = await resolveMagicKey(q, params.magicKey).catch(() => null);
    if (p) return json([p]);
  }
  // Esri + Photon, ranked near the map view. A clean word-for-word match wins.
  // A typo-only match lets a venue name try its search snippet first, so
  // "Casa Evexia" is not swapped for a similarly spelled place abroad.
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
  if (ranked && looksLikeVenueName(q)) {
    try {
      const address = addressFromVenueText(q, await venueSnippet(q));
      const placed = address ? await firstHit(geocodeQueries(address)) : null;
      if (placed) return json(placed);
    } catch {
      // Keep the ranked place.
    }
    return json([ranked]);
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
