#!/usr/bin/env node
"use strict";

/**
 * One-shot Oak Creek commercial export check. Hits the live Esri / NLCD /
 * Microsoft sources through this branch's function, or a deployed URL.
 *
 *   node scripts/verify-oak-creek.js
 *   node scripts/verify-oak-creek.js --url https://openclutter.netlify.app
 *   node scripts/verify-oak-creek.js --url https://deploy-preview-N--openclutter.netlify.app --out /tmp/oak-creek-verify.json
 *
 * Equivalent production curl (after this branch is merged):
 *
 *   curl -sS -D /tmp/oak-headers.txt -o /tmp/oak-creek-bundle.json \
 *     -w "http:%{http_code} time:%{time_total}\n" \
 *     -X POST "https://openclutter.netlify.app/api/clutter" \
 *     -H "content-type: application/json" \
 *     --max-time 12 \
 *     -d '{"west":-87.92259693145752,"south":42.89043196008693,"east":-87.91184663772584,"north":42.90325386116256,"name":"Oak Creek WI commercial","trees":[],"format":"bundle"}'
 *
 * Pass: HTTP 200, wall clock under 10s, attenuation_areas > 0 (this corridor
 * is about 1000+), exactly the six stock area_materials, JPEG SOI, and
 * VERIFY.txt / export-stats.json agreeing with that length.
 */

const fs = require("fs");
const path = require("path");
const { unzipStore } = require("../netlify/lib/zip-store");
const { ZONE_TYPES } = require("../netlify/lib/hamina-clipboard");

const BBOX = {
  west: -87.92259693145752,
  south: 42.89043196008693,
  east: -87.91184663772584,
  north: 42.90325386116256,
  name: "Oak Creek WI commercial",
  trees: [],
  format: "bundle",
};

const STOCK_NAMES = ZONE_TYPES.map((z) => z.name);
const BUDGET_MS = 10000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function parseVerify(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function checkZip(zipBuf) {
  const files = unzipStore(zipBuf);
  const oiName = Object.keys(files).find((n) => /^openIntent_.*\.json$/.test(n));
  const jpegName = Object.keys(files).find((n) => /\.jpe?g$/i.test(n));
  const failures = [];
  if (!oiName) failures.push("missing openIntent JSON");
  if (!jpegName) failures.push("missing JPEG");
  if (!files["VERIFY.txt"]) failures.push("missing VERIFY.txt");
  if (!files["export-stats.json"]) failures.push("missing export-stats.json");
  let areas = 0;
  let materials = [];
  let verifyAreas = null;
  let statsAreas = null;
  let statsMaterials = null;
  let compatibilityMode = null;
  let clipboard = null;
  if (oiName) {
    const oi = JSON.parse(files[oiName].toString("utf8"));
    areas = (oi.floorplans && oi.floorplans[0] && oi.floorplans[0].attenuation_areas && oi.floorplans[0].attenuation_areas.length) || 0;
    materials = (oi.area_materials || []).map((m) => m.name);
    const areaRefs = ((oi.floorplans[0] && oi.floorplans[0].attenuation_areas) || []).map((a) => a.area_material);
    if (!(areas > 0)) failures.push("attenuation_areas.length is " + areas);
    if (areas > 982) failures.push("attenuation_areas " + areas + " above the last accepted import (982)");
    if (materials.length !== 6) failures.push("area_materials count " + materials.length);
    const custom = materials.filter((n) => /Building \d/.test(n) || /Foliage \d/.test(n) || !STOCK_NAMES.includes(n));
    if (custom.length) failures.push("non-stock materials: " + custom.join(", "));
    if (STOCK_NAMES.some((n) => !materials.includes(n))) failures.push("stock set mismatch: " + materials.join(" | "));
    const embedded = areaRefs.filter((m) => typeof m !== "string");
    if (embedded.length) failures.push("embedded area_material objects: " + embedded.length);
    const unknownRef = areaRefs.filter((m) => typeof m === "string" && !STOCK_NAMES.includes(m));
    if (unknownRef.length) failures.push("unknown area_material names: " + unknownRef.slice(0, 4).join(", "));
  }
  if (jpegName) {
    const jpeg = files[jpegName];
    if (!(jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8)) failures.push("JPEG missing SOI");
  }
  if (files["VERIFY.txt"]) {
    const v = parseVerify(files["VERIFY.txt"].toString("utf8"));
    verifyAreas = Number(v.attenuation_areas);
    if (verifyAreas !== areas) failures.push("VERIFY attenuation_areas " + verifyAreas + " != JSON " + areas);
    if (Number(v.area_materials) !== 6) failures.push("VERIFY area_materials " + v.area_materials);
  }
  if (files["hamina-clipboard.json"] && oiName) {
    const clip = JSON.parse(files["hamina-clipboard.json"].toString("utf8"));
    const meters = (JSON.parse(files[oiName].toString("utf8")).floorplans[0].dimensions || []).find((d) => d.unit === "meters");
    let oob = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const z of clip.attenuatingZones || []) {
      const ring = z.area && z.area.coordinates && z.area.coordinates[0];
      if (!ring) continue;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (meters && (x < -meters.width - 0.05 || x > 0.05 || y < -meters.length - 0.05 || y > 0.05)) oob++;
      }
    }
    clipboard = { zones: (clip.attenuatingZones || []).length, types: (clip.attenuatingZoneTypes || []).length, minX, maxX, minY, maxY, oob };
    if (oob) failures.push("clipboard vertices outside the meter frame: " + oob);
  }
  if (files["export-stats.json"]) {
    const stats = JSON.parse(files["export-stats.json"].toString("utf8"));
    statsAreas = stats.attenuationAreasEmitted;
    statsMaterials = stats.areaMaterials;
    compatibilityMode = stats.compatibilityMode;
    if (statsAreas !== areas) failures.push("export-stats attenuationAreasEmitted " + statsAreas + " != JSON " + areas);
    if (statsMaterials !== 6) failures.push("export-stats areaMaterials " + statsMaterials);
    if (compatibilityMode !== "stock-openintent") failures.push("compatibilityMode " + compatibilityMode);
  }
  return {
    failures,
    areas,
    materials,
    verifyAreas,
    statsAreas,
    statsMaterials,
    compatibilityMode,
    jpegName: jpegName || null,
    jpegBytes: jpegName ? files[jpegName].length : 0,
    oiName: oiName || null,
    warnings: files["export-warnings.json"] ? JSON.parse(files["export-warnings.json"].toString("utf8")).warnings : [],
    clipboard,
  };
}

async function requestLocal() {
  const { handler } = require("../netlify/functions/clutter");
  const t0 = Date.now();
  const res = await handler({ httpMethod: "POST", body: JSON.stringify(BBOX) });
  return { status: res.statusCode, ms: Date.now() - t0, body: res.body };
}

async function requestUrl(base) {
  const url = base.replace(/\/$/, "") + "/api/clutter";
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BBOX),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, body: text, url };
}

async function main() {
  const base = arg("--url");
  const out = arg("--out");
  const req = base ? await requestUrl(base) : await requestLocal();
  const report = {
    target: base || "local-handler",
    url: req.url || null,
    status: req.status,
    ms: req.ms,
    budgetMs: BUDGET_MS,
    bbox: { west: BBOX.west, south: BBOX.south, east: BBOX.east, north: BBOX.north },
    ok: false,
    failures: [],
  };
  let parsed = null;
  try {
    parsed = JSON.parse(req.body || "{}");
  } catch {
    report.failures.push("response is not JSON");
  }
  if (req.status !== 200) report.failures.push("HTTP " + req.status + (parsed && parsed.error ? " " + parsed.error : ""));
  if (req.ms >= BUDGET_MS) report.failures.push("wall clock " + req.ms + "ms exceeds " + BUDGET_MS + "ms");
  if (parsed && parsed.zipBase64) {
    const zip = checkZip(Buffer.from(parsed.zipBase64, "base64"));
    report.areas = zip.areas;
    report.materials = zip.materials;
    report.verifyAreas = zip.verifyAreas;
    report.statsAreas = zip.statsAreas;
    report.compatibilityMode = zip.compatibilityMode;
    report.jpeg = { name: zip.jpegName, bytes: zip.jpegBytes };
    report.warnings = zip.warnings;
    report.clipboard = zip.clipboard;
    report.statsSummary = parsed.stats && parsed.stats.summary;
    report.buildings = parsed.stats && parsed.stats.buildingsKept;
    report.trees = parsed.stats && parsed.stats.treesKept;
    report.failures.push.apply(report.failures, zip.failures);
  } else if (parsed) {
    report.failures.push(parsed.error || "no zipBase64");
  }
  report.ok = report.failures.length === 0;
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text + "\n");
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
