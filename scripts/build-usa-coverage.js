"use strict";

/**
 * Rebuild netlify/lib/usa-coverage.json.gz from Natural Earth 50m
 * admin-0 countries (public domain). Only Canada and Mexico rings that
 * overlap the expanded CONUS box are kept, so USA Structures can skip
 * silently in southern Canada and northern Mexico when the export
 * country is not already known.
 *
 *   node scripts/build-usa-coverage.js [ne_50m_admin_0_countries.geojson] [out.gz]
 *
 * Default source:
 *   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const DEFAULT_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";
const DEFAULT_OUT = path.join(ROOT, "netlify/lib/usa-coverage.json.gz");
const CLIP = { west: -126, south: 23, east: -65, north: 51 };

function ringOverlapsClip(ring) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of ring) {
    const lon = +p[0], lat = +p[1];
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return !(maxLon < CLIP.west || minLon > CLIP.east || maxLat < CLIP.south || minLat > CLIP.north);
}

function roundRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = [Math.round(+p[0] * 10000) / 10000, Math.round(+p[1] * 10000) / 10000];
    if (!out.length || out[out.length - 1][0] !== q[0] || out[out.length - 1][1] !== q[1]) out.push(q);
  }
  if (out.length >= 4 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push([out[0][0], out[0][1]]);
  }
  return out.length >= 4 ? out : null;
}

function clipCountry(geojson, iso) {
  const feat = (geojson.features || []).find((f) => String((f.properties || {}).ISO_A2 || "") === iso);
  if (!feat) throw new Error("missing country " + iso);
  const g = feat.geometry;
  const coords = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  const kept = [];
  for (const poly of coords) {
    if (!poly || !poly[0] || !ringOverlapsClip(poly[0])) continue;
    const cleaned = [];
    for (const ring of poly) {
      const r = roundRing(ring);
      if (r) cleaned.push(r);
    }
    if (cleaned.length) kept.push(cleaned);
  }
  return kept;
}

async function main() {
  const src = process.argv[2];
  const dest = path.resolve(process.argv[3] || DEFAULT_OUT);
  let text;
  if (src && !/^https?:/i.test(src)) {
    text = fs.readFileSync(path.resolve(src), "utf8");
  } else {
    const url = src || DEFAULT_URL;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Natural Earth HTTP " + res.status + " " + url);
    text = await res.text();
  }
  const geojson = JSON.parse(text);
  const payload = { ca: clipCountry(geojson, "CA"), mx: clipCountry(geojson, "MX") };
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zlib.gzipSync(raw, { level: 9 }));
  console.log(
    "wrote " + dest + " (CA " + payload.ca.length + " rings, MX " + payload.mx.length + " rings)"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
