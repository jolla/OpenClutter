"use strict";

/**
 * Optional OSM tree *nodes* only. Off by default.
 * Never fetch building ways or wood/forest/golf rings — those broke Hamina v8
 * attenuation_areas imports.
 */
async function fetchOsmTreeNodes(west, south, east, north, ua) {
  const q = `[out:json][timeout:6];node["natural"="tree"](${south},${west},${north},${east});out;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return [];
  const j = await r.json();
  const out = [];
  for (const el of j.elements || []) {
    if (el.type === "node" && Number.isFinite(+el.lon) && Number.isFinite(+el.lat)) {
      out.push({ lon: +el.lon, lat: +el.lat });
    }
  }
  return out;
}

module.exports = { fetchOsmTreeNodes };
