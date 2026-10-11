#!/usr/bin/env node
"use strict";

/**
 * Hamina-style oblique preview for an OpenIntent zip.
 *
 *   node scripts/hamina-preview.js --zip site.zip --terrain paste.json --out preview.png
 *   node scripts/hamina-preview.js --zip site.zip --site lancaster-nh --out preview.png
 *   node scripts/hamina-preview.js --all --zip-dir /tmp/canopy-bench-live --out-dir /tmp/hamina-preview
 *
 * --terrain is the Copy terrain paste (HaminaClipboard JSON). Without it,
 * --site looks the draw up in bench/canopy-sites.json, rebuilds the aerial
 * frame, and fetches the same sloped DEM the export pastes. The renderer
 * drapes that aerial on the floors and extrudes each attenuation area from
 * bottom height to top height.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { esriContentExtent, geoFrame, unifyFrameMpu } = require("../netlify/lib/geo-frame");
const { fetchTerrainDem, terrainFromSamples } = require("../netlify/lib/terrain");
const { isTrunkOiName, isUnderstoryOiName, isVegetationOiName } = require("../netlify/lib/materials");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function loadZip(zipPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
  const names = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else names.push(p);
    }
  }
  walk(dir);
  const jsonPath = names.find((n) => n.endsWith(".json"));
  const jpgPath = names.find((n) => /\.jpe?g$/i.test(n));
  if (!jsonPath || !jpgPath) throw new Error("zip needs an OpenIntent json and a jpeg");
  return { json: JSON.parse(fs.readFileSync(jsonPath, "utf8")), jpgPath };
}

function metersOf(floorplan) {
  const dims = floorplan.dimensions || [];
  const px = dims.find((d) => d.unit === "pixels") || dims[0];
  const m = dims.find((d) => d.unit === "meters") || dims[1];
  return {
    imgW: px.width,
    imgH: px.length,
    widthM: m.width,
    lengthM: m.length,
  };
}

function frameFor(site, imgW, imgH, widthM, lengthM) {
  const ext = esriContentExtent(site, imgW, imgH);
  const frame = geoFrame(ext, { imgW, imgH, maxSpanM: 8000, minSpanM: 1 });
  const locked = unifyFrameMpu(Object.assign(frame, { widthM, imgW, imgH }));
  if (Math.abs(locked.lengthM - lengthM) > 1) {
    return Object.assign(locked, {
      lengthM,
      mpuX: widthM / imgW,
      mpuY: lengthM / imgH,
      mpu: widthM / imgW,
    });
  }
  return locked;
}

function kindOf(name) {
  if (isVegetationOiName(name)) return "tree";
  if (isUnderstoryOiName(name) || /understory/i.test(name)) return "tree";
  if (isTrunkOiName(name) || /tree trunk/i.test(name)) return "trunk";
  if (/^water/i.test(name)) return "water";
  if (/building/i.test(name)) return "building";
  return "other";
}

function roleOf(name) {
  if (isUnderstoryOiName(name) || /understory/i.test(name)) return "understory";
  if (isTrunkOiName(name) || /tree trunk/i.test(name)) return "trunk";
  if (isVegetationOiName(name)) return "crown";
  return "";
}

function hexColor(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function sceneFrom(loaded, clipboard, name) {
  const fp = loaded.json.floorplans[0];
  const dim = metersOf(fp);
  const mpuX = dim.widthM / dim.imgW;
  const mpuY = dim.lengthM / dim.imgH;
  const objects = [];
  for (const area of fp.attenuation_areas || []) {
    const material = area.area_material || {};
    const nameM = material.name || "";
    const coords = area.area && area.area.coordinates;
    if (!coords || coords.length < 3) continue;
    const ring = coords.map((c) => {
      const p = c.coordinate_xyz || c;
      return [p.x * mpuX - dim.widthM, p.y * mpuY - dim.lengthM];
    });
    const bottom = Number.isFinite(+material.bottom_height) ? +material.bottom_height : 0;
    let top = Number.isFinite(+material.top_height) ? +material.top_height : bottom;
    if (!(top > bottom)) top = bottom + 0.15;
    objects.push({
      kind: kindOf(nameM),
      role: roleOf(nameM),
      color: hexColor(material.display_color),
      ring,
      bottom,
      top,
    });
  }
  const floors = [];
  const slopes = (clipboard && clipboard.slopedFloors) || [];
  const raised = (clipboard && clipboard.raisedFloorZones) || [];
  for (const zone of slopes) {
    const ring = zone.area && zone.area.coordinates && zone.area.coordinates[0];
    if (ring && ring.length >= 3) floors.push({ kind: "slope", ring });
  }
  for (const zone of raised) {
    const ring = zone.area && zone.area.coordinates && zone.area.coordinates[0];
    if (ring && ring.length >= 3) floors.push({ kind: "raised", ring, height: zone.height || 0 });
  }
  return {
    name: name || (fp.name || "Site"),
    widthM: dim.widthM,
    lengthM: dim.lengthM,
    image: loaded.jpgPath,
    objects,
    floors,
  };
}

async function pasteFor(site, loaded) {
  const dim = metersOf(loaded.json.floorplans[0]);
  const frame = frameFor(site, dim.imgW, dim.imgH, dim.widthM, dim.lengthM);
  const pack = await fetchTerrainDem(frame, null, {
    terrainResolution: "auto",
    terrainStyle: "sloped",
    allowSurfaceFallback: true,
    signal: AbortSignal.timeout(180000),
  });
  const samples = (pack && pack.samples) || [];
  if (samples.length < 4) throw new Error(site.id + " terrain did not return");
  const terrain = terrainFromSamples(samples, frame, {
    terrainResolution: "auto",
    terrainStyle: "sloped",
  });
  if (!terrain || !terrain.clipboard) throw new Error(site.id + " terrain mesh was empty");
  return terrain.clipboard;
}

function renderScene(scene, outPath) {
  const scenePath = outPath.replace(/\.png$/i, ".scene.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(scenePath, JSON.stringify(scene));
  execFileSync("python3", [path.join(__dirname, "hamina_preview.py"), scenePath, outPath], {
    stdio: "inherit",
  });
}

async function one(zipPath, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamina-"));
  const loaded = loadZip(zipPath, dir);
  let clipboard = null;
  if (opts.terrainPath) {
    clipboard = JSON.parse(fs.readFileSync(opts.terrainPath, "utf8"));
  } else if (opts.site) {
    clipboard = await pasteFor(opts.site, loaded);
    if (opts.terrainOut) {
      fs.mkdirSync(path.dirname(opts.terrainOut), { recursive: true });
      fs.writeFileSync(opts.terrainOut, JSON.stringify(clipboard));
    }
  }
  const scene = sceneFrom(loaded, clipboard, opts.name || (opts.site && opts.site.name));
  renderScene(scene, opts.out);
}

async function main() {
  if (process.argv.includes("--all")) {
    const sites = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/canopy-sites.json"), "utf8"));
    const zipDir = arg("--zip-dir");
    const outDir = arg("--out-dir") || path.join(ROOT, "bench/hamina-preview");
    if (!zipDir) throw new Error("--all needs --zip-dir");
    for (const site of sites) {
      const zipPath = path.join(zipDir, site.id + ".zip");
      if (!fs.existsSync(zipPath)) {
        console.log("skip", site.id, "no zip");
        continue;
      }
      const out = path.join(outDir, site.id + ".png");
      const terrainOut = path.join(outDir, site.id + ".terrain.json");
      console.log("preview", site.id);
      await one(zipPath, { site, name: site.name, out, terrainOut });
    }
    return;
  }
  const zipPath = arg("--zip");
  if (!zipPath) throw new Error("need --zip or --all");
  const sites = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/canopy-sites.json"), "utf8"));
  const site = sites.find((s) => s.id === arg("--site")) || null;
  const out = arg("--out") || path.join(os.tmpdir(), "hamina-preview.png");
  await one(zipPath, {
    site,
    name: arg("--name") || (site && site.name),
    terrainPath: arg("--terrain"),
    terrainOut: arg("--terrain-out"),
    out,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
