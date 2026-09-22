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
 * Pass: HTTP 200, wall clock under 10s, attenuation_areas > 0 and ≤ 982,
 * exactly the six stock area_materials, every area_material a catalog-equal
 * object (a name string is Invalid OpenIntent format), JPEG SOI, clipboard
 * vertices inside the meter frame, and VERIFY.txt / export-stats.json
 * agreeing with that length. When ajv is installed, the OpenIntent JSON is
 * also checked against google/openintent 2.0.1.
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
    const areaList = (oi.floorplans[0] && oi.floorplans[0].attenuation_areas) || [];
    const byName = new Map((oi.area_materials || []).map((m) => [m.name, m]));
    let strings = 0;
    let mismatches = 0;
    for (const a of areaList) {
      const m = a && a.area_material;
      if (typeof m === "string") {
        strings++;
        continue;
      }
      const cat = m && byName.get(m.name);
      if (!cat || JSON.stringify(m) !== JSON.stringify(cat) || "bottom_height" in m) mismatches++;
    }
    if (!(areas > 0)) failures.push("attenuation_areas.length is " + areas);
    if (areas > 982) failures.push("attenuation_areas " + areas + " above the last accepted import (982)");
    if (materials.length !== 6) failures.push("area_materials count " + materials.length);
    const custom = materials.filter((n) => /Building \d/.test(n) || /Foliage \d/.test(n) || !STOCK_NAMES.includes(n));
    if (custom.length) failures.push("non-stock materials: " + custom.join(", "));
    if (STOCK_NAMES.some((n) => !materials.includes(n))) failures.push("stock set mismatch: " + materials.join(" | "));
    if (strings) failures.push("string area_material (Invalid OpenIntent format): " + strings);
    if (mismatches) failures.push("area_material not equal to catalog entry: " + mismatches);
    const fp = oi.floorplans[0] || {};
    const rootKeys = Object.keys(oi).sort().join(",");
    if (rootKeys !== "area_materials,floorplans,openintent_version,switches,wall_materials") {
      failures.push("root keys " + rootKeys);
    }
    if (oi.openintent_version !== "2.0.1") failures.push("openintent_version " + oi.openintent_version);
    if (!String(fp.map_uri || "").startsWith("file://images/")) failures.push("map_uri " + fp.map_uri);
    const sample = areaList[0] && areaList[0].area_material;
    if (sample && ("itu_material_type" in sample || "bottom_height" in sample)) {
      failures.push("sample material drifted from Hamina-native keys");
    }
    const matKeys = sample && Object.keys(sample);
    if (matKeys && matKeys.join(",") !== "name,rf_properties,top_height,display_color") {
      failures.push("material key order/shape " + matKeys.join(","));
    }
    let badTriples = 0;
    let aspectFail = false;
    const px = (fp.dimensions || []).find((d) => d.unit === "pixels");
    const meters = (fp.dimensions || []).find((d) => d.unit === "meters");
    if (px && meters) {
      const pixelAspect = px.width / px.length;
      const meterAspect = meters.width / meters.length;
      if (Math.abs(pixelAspect - meterAspect) > 0.002) {
        aspectFail = true;
        failures.push("aspect px " + pixelAspect.toFixed(4) + " != m " + meterAspect.toFixed(4));
      }
    }
    if (fp.reference_markers && fp.reference_markers.length) {
      failures.push("reference_markers should be empty (Hamina-native)");
    }
    for (const a of areaList) {
      const coords = a.area && a.area.coordinates;
      if (!coords || coords.length < 12 || coords.length % 3 !== 0) {
        badTriples++;
        continue;
      }
      for (let i = 0; i < Math.min(coords.length, 12); i += 3) {
        if (
          coords[i].coordinate_xyz.unit !== "pixels" ||
          coords[i + 1].coordinate_xyz.unit !== "meters" ||
          coords[i + 2].coordinate_xyz.unit !== "feet"
        ) {
          badTriples++;
          break;
        }
      }
    }
    if (badTriples) failures.push("attenuation rings missing pixels+meters+feet triples: " + badTriples);
    void aspectFail;
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
    oi: oiName ? JSON.parse(files[oiName].toString("utf8")) : null,
    warnings: files["export-warnings.json"] ? JSON.parse(files["export-warnings.json"].toString("utf8")).warnings : [],
    clipboard,
  };
}

const OI_SCHEMA_URL =
  "https://raw.githubusercontent.com/google/openintent/2.0.1/release/2.0.0/models/oi-wifi.schema.json";

function loadAjv() {
  const roots = [path.join(__dirname, "..", "node_modules"), "/tmp/oi-ajv/node_modules"];
  for (const root of roots) {
    try {
      return {
        Ajv: require(path.join(root, "ajv/dist/2020")),
        addFormats: require(path.join(root, "ajv-formats")),
      };
    } catch {
      /* try the next install */
    }
  }
  return null;
}

async function loadOiSchema() {
  const cached = "/tmp/oi-schema/oi-wifi.schema.json";
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, "utf8"));
  const res = await fetch(OI_SCHEMA_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("schema HTTP " + res.status);
  const text = await res.text();
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, text);
  return JSON.parse(text);
}

async function schemaCheck(oi) {
  const loaded = loadAjv();
  if (!loaded) return { ok: false, error: "ajv not installed" };
  const schema = await loadOiSchema();
  const ajv = new loaded.Ajv({ allErrors: true, strict: false });
  loaded.addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(oi);
  const errors = (validate.errors || []).slice(0, 12).map((e) => (e.instancePath || "/") + " " + e.message);
  return { ok: !!ok, errors, schema: "google/openintent 2.0.1 oi-wifi" };
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
    if (zip.oi) {
      try {
        report.schema = await schemaCheck(zip.oi);
        if (!report.schema.ok) {
          report.failures.push(
            "OpenIntent schema: " + (report.schema.error || (report.schema.errors || []).slice(0, 4).join("; "))
          );
        }
      } catch (e) {
        report.schema = { ok: false, error: e.message };
        report.failures.push("OpenIntent schema: " + e.message);
      }
    }
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
