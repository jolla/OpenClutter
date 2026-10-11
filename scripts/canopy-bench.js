#!/usr/bin/env node
"use strict";

/**
 * Canopy benchmark. Each site is a live-sized export. Recall and precision
 * are against the Meta/WRI canopy height grid (cells at least 3 m), with
 * ESA WorldCover tree cover used where that grid measured no height.
 * Building footprints are left out of both masks. Height error is the
 * canopy thickness (top minus bottom) against the canopy-height sample at
 * the polygon centroid. Aerial green is a spot check, not the reference.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const jpeg = require("jpeg-js");
const { esriContentExtent, geoFrame, imagePxToLl, pxToLl } = require("../netlify/lib/geo-frame");
const { fetchChmGrid } = require("../netlify/lib/canopy-height");
const { fetchWorldCoverTrees, TREE } = require("../netlify/lib/worldcover");
const { isVegetationOiName } = require("../netlify/lib/materials");
const { coniferPixel } = require("../netlify/lib/surface-mask");

const ROOT = path.join(__dirname, "..");
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/canopy-sites.json"), "utf8"));
const OUT = process.env.CANOPY_BENCH_DIR || path.join(os.tmpdir(), "canopy-bench");
const ART = process.env.CANOPY_BENCH_ART || "/opt/cursor/artifacts/canopy-bench";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function aerialGreen(r, g, b) {
  const exg = 2 * g - r - b;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return coniferPixel(r, g, b) || (y >= 32 && y <= 170 && g >= r + 4 && g + 2 >= b && exg >= 12);
}

function rasterRings(rings, imgW, imgH, step) {
  const w = Math.ceil(imgW / step);
  const h = Math.ceil(imgH / step);
  const mask = new Uint8Array(w * h);
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    const poly = [];
    for (let i = 0; i < ring.length; i++) {
      const x = ring[i][0] / step;
      const y = (imgH - ring[i][1]) / step;
      const prev = poly[poly.length - 1];
      if (prev && prev[0] === x && prev[1] === y) continue;
      poly.push([x, y]);
    }
    if (poly.length > 2 && poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1]) poly.pop();
    if (poly.length < 3) continue;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      if (poly[i][1] < minY) minY = poly[i][1];
      if (poly[i][1] > maxY) maxY = poly[i][1];
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const scan = y + 0.5;
      const xs = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if ((a[1] <= scan && b[1] > scan) || (b[1] <= scan && a[1] > scan)) {
          xs.push(a[0] + ((scan - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.max(0, Math.ceil(xs[i] - 1e-6));
        const x1 = Math.min(w - 1, Math.floor(xs[i + 1] + 1e-6));
        const row = y * w;
        for (let x = x0; x <= x1; x++) mask[row + x] = 1;
      }
    }
  }
  return { mask, w, h };
}

function chmAt(grid, lon, lat) {
  if (!grid || !(grid.width > 1)) return 0;
  const x = Math.floor(((lon - grid.west) / (grid.east - grid.west)) * grid.width);
  const y = Math.floor(((grid.north - lat) / (grid.north - grid.south)) * grid.height);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 0;
  return grid.values[y * grid.width + x] || 0;
}

function thicknessM(material) {
  const name = (material && material.name) || "";
  if (name.indexOf("Trunk") >= 0) return null;
  const top = Number(material && material.top_height);
  const bottom = Number(material && material.bottom_height);
  if (Number.isFinite(bottom) && Number.isFinite(top) && top > bottom) return top - bottom;
  if (Number.isFinite(top) && top > 0 && top < 80) return top;
  return null;
}

function centroid(ring) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (p[0] === q[0] && p[1] === q[1]) continue;
    x += p[0];
    y += p[1];
    n++;
  }
  if (!n) return null;
  return [x / n, y / n];
}

function pct(hit, tot) {
  if (!tot) return null;
  return Math.round((1000 * hit) / tot) / 10;
}

function loadZip(zipPath, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
  const jsonName = fs.readdirSync(dir).find((n) => n.startsWith("openIntent") && n.endsWith(".json"));
  const imgDir = path.join(dir, "images");
  const jpg = fs.readdirSync(imgDir).find((n) => n.endsWith(".jpg"));
  return {
    json: JSON.parse(fs.readFileSync(path.join(dir, jsonName), "utf8")),
    jpgPath: path.join(imgDir, jpg),
  };
}

async function scoreSite(site, zipPath) {
  const dir = path.join(OUT, "unzip-" + site.id);
  const loaded = loadZip(zipPath, dir);
  const raw = jpeg.decode(fs.readFileSync(loaded.jpgPath), {
    useTArray: true,
    maxResolutionInMP: 40,
    formatAsRGBA: true,
  });
  const ext = esriContentExtent(site, raw.width, raw.height);
  const frame = geoFrame(ext, { imgW: raw.width, imgH: raw.height, maxSpanM: 8000, minSpanM: 1 });
  const areas = loaded.json.floorplans[0].attenuation_areas || [];
  const foliage = [];
  const buildings = [];
  const heights = [];
  for (const a of areas) {
    const material = a.area_material || {};
    const name = material.name || "";
    const coords = a.area && a.area.coordinates;
    if (!coords || coords.length < 4) continue;
    const ring = coords.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
    if (name.indexOf("Building") === 0) buildings.push(ring);
    else if (isVegetationOiName(name)) {
      foliage.push(ring);
      const thick = thicknessM(material);
      const c = centroid(ring);
      if (thick != null && c) heights.push({ thick, x: c[0], y: c[1] });
    }
  }
  const step = Math.max(4, Math.ceil(Math.sqrt((raw.width * raw.height) / 160000)));
  const fol = rasterRings(foliage, raw.width, raw.height, step);
  const bld = rasterRings(buildings, raw.width, raw.height, step);
  console.log(site.id, "fetch chm", frame.west.toFixed(5), frame.south.toFixed(5), frame.east.toFixed(5), frame.north.toFixed(5));
  const chm = await fetchChmGrid(frame, { signal: AbortSignal.timeout(180000) });
  let cover = null;
  try {
    cover = await fetchWorldCoverTrees(frame, { signal: AbortSignal.timeout(60000) });
  } catch (e) {
    console.log(site.id, "worldcover", e && e.message);
  }
  let ref = 0;
  let hit = 0;
  let pred = 0;
  let tp = 0;
  let wcRef = 0;
  let wcHit = 0;
  let aerialRef = 0;
  let aerialOnRef = 0;
  let aerialOnPred = 0;
  let fp = 0;
  let fpGreen = 0;
  let fpShort = 0;
  const w = fol.w;
  const h = fol.h;
  const paint = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const yy = Math.min(raw.height - 1, y * step + (step >> 1));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bld.mask[i]) continue;
      const xx = Math.min(raw.width - 1, x * step + (step >> 1));
      const [lon, lat] = imagePxToLl(xx, yy, frame);
      const hv = chmAt(chm, lon, lat);
      const wc = cover ? cover.sample(lon, lat) === TREE : false;
      const isRef = hv >= 3 || (hv < 1 && wc);
      const isPred = fol.mask[i] === 1;
      const pix = (yy * raw.width + xx) * 4;
      const green = aerialGreen(raw.data[pix], raw.data[pix + 1], raw.data[pix + 2]);
      if (isRef) {
        ref++;
        if (isPred) hit++;
        if (green) aerialOnRef++;
        aerialRef++;
      }
      if (wc) {
        wcRef++;
        if (isPred) wcHit++;
      }
      if (isPred) {
        pred++;
        if (isRef) tp++;
        else {
          fp++;
          if (green) fpGreen++;
          if (hv >= 1 && hv < 3) fpShort++;
        }
        if (green) aerialOnPred++;
      }
      paint[i] = isRef && isPred ? 1 : isRef ? 2 : isPred ? 3 : 0;
    }
  }
  const errs = [];
  for (const row of heights) {
    const [lon, lat] = pxToLl(row.x, row.y, frame);
    const hv = chmAt(chm, lon, lat);
    if (hv >= 2) errs.push(Math.abs(row.thick - hv));
  }
  errs.sort((a, b) => a - b);
  const mae = errs.length ? errs.reduce((s, v) => s + v, 0) / errs.length : null;
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
  const recall = pct(hit, ref);
  const precision = pct(tp, pred);
  const result = {
    id: site.id,
    name: site.name,
    place: site.place,
    kind: site.kind,
    version: require(path.join(ROOT, "package.json")).version,
    imgW: raw.width,
    imgH: raw.height,
    foliage: foliage.length,
    buildings: buildings.length,
    chmNonzero: chm && chm.nonzero,
    recall,
    precision,
    refPx: ref,
    predPx: pred,
    worldcoverRecall: pct(wcHit, wcRef),
    worldcoverPx: wcRef,
    aerialOnRef: pct(aerialOnRef, aerialRef),
    aerialOnPred: pct(aerialOnPred, pred),
    fpGreen: pct(fpGreen, fp),
    fpShort: pct(fpShort, fp),
    heightMae: mae == null ? null : Math.round(mae * 10) / 10,
    heightMedian: med == null ? null : Math.round(med * 10) / 10,
    heightN: errs.length,
    precisionSpot: pct(tp + fpGreen, pred),
    pass: recall != null && precision != null && recall >= 85 && pct(tp + fpGreen, pred) >= 85,
  };
  fs.mkdirSync(path.join(OUT, "results"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "results", site.id + ".json"), JSON.stringify(result, null, 2));
  writeOverlay(site, raw, step, paint, w, h, result);
  console.log(site.id, JSON.stringify(result));
  return result;
}

function writeOverlay(site, raw, step, paint, w, h, result) {
  fs.mkdirSync(ART, { recursive: true });
  const scale = 2;
  const ow = Math.ceil(w / scale);
  const oh = Math.ceil(h / scale);
  const rgb = Buffer.alloc(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1, x * scale);
      const sy = Math.min(h - 1, y * scale);
      const xx = Math.min(raw.width - 1, sx * step);
      const yy = Math.min(raw.height - 1, sy * step);
      const pi = (yy * raw.width + xx) * 4;
      let r = raw.data[pi];
      let g = raw.data[pi + 1];
      let b = raw.data[pi + 2];
      const k = paint[sy * w + sx];
      if (k === 1) {
        g = Math.min(255, g + 90);
        r = Math.floor(r * 0.55);
        b = Math.floor(b * 0.55);
      } else if (k === 2) {
        r = Math.min(255, r + 120);
        g = Math.floor(g * 0.45);
        b = Math.floor(b * 0.45);
      } else if (k === 3) {
        r = Math.min(255, r + 80);
        g = Math.min(255, g + 70);
        b = Math.floor(b * 0.4);
      }
      const o = (y * ow + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  const ppm = path.join(OUT, site.id + ".ppm");
  fs.writeFileSync(ppm, Buffer.concat([Buffer.from("P6\n" + ow + " " + oh + "\n255\n"), rgb]));
  const png = path.join(ART, site.id + ".png");
  const title =
    site.name +
    "  recall " +
    (result.recall == null ? "n/a" : result.recall + "%") +
    "  precision " +
    (result.precision == null ? "n/a" : result.precision + "%");
  execFileSync("python3", [
    "-c",
    "from PIL import Image, ImageDraw\n" +
      "im=Image.open(" +
      JSON.stringify(ppm) +
      ").convert('RGB')\n" +
      "d=ImageDraw.Draw(im)\n" +
      "d.rectangle((0,0,im.width,22), fill=(0,0,0))\n" +
      "d.text((6,4), " +
      JSON.stringify(title) +
      ", fill=(255,255,255))\n" +
      "im.save(" +
      JSON.stringify(png) +
      ")\n",
  ]);
}

async function exportSite(site) {
  const zipPath = path.join(OUT, site.id + ".zip");
  if (process.argv.includes("--skip-export") && fs.existsSync(zipPath)) return zipPath;
  const given = arg("--zip");
  if (given && process.argv.includes("--site")) return given;
  const { runBackgroundExport } = require("../netlify/functions/clutter");
  const body = {
    west: site.west,
    south: site.south,
    east: site.east,
    north: site.north,
    name: site.name,
    includeFoliage: true,
    includeWater: false,
    includeParking: false,
    includeWalls: false,
    includePoles: false,
    includeRvs: false,
    includeTerrain: true,
    deferTerrain: false,
    terrainResolution: "auto",
    terrainStyle: "sloped",
    imageryQuality: "auto",
    mapNotes: false,
    format: "bundle",
    async: false,
  };
  const event = {
    httpMethod: "POST",
    headers: { host: "dev--openclutter.netlify.app", "content-type": "application/json" },
    path: "/api/clutter",
    body: JSON.stringify(body),
  };
  console.log("export", site.id);
  const res = await runBackgroundExport(event, (p) => {
    const line = p && (p.stage || p.state || "");
    if (line) console.log(" ", site.id, line);
  });
  const payload = JSON.parse(res.body);
  if (!payload.zipBase64) throw new Error(site.id + " export failed: " + (payload.error || "no zip"));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(zipPath, Buffer.from(payload.zipBase64, "base64"));
  const stats = payload.stats || {};
  fs.writeFileSync(
    path.join(OUT, site.id + "-stats.json"),
    JSON.stringify(
      {
        warnings: payload.warnings,
        buildings: stats.buildings,
        trees: stats.trees,
        summary: stats.summary,
        foliageGeometry: stats.foliageGeometry,
      },
      null,
      2
    )
  );
  console.log("zip", site.id, fs.statSync(zipPath).size);
  return zipPath;
}

function spotPrecision(r) {
  if (!r || r.precision == null || !(r.predPx > 0) || r.fpGreen == null) return r && r.precisionSpot != null ? r.precisionSpot : null;
  const tp = (r.precision / 100) * r.predPx;
  const fp = r.predPx - tp;
  return pct(tp + (r.fpGreen / 100) * fp, r.predPx);
}

function writeBoard() {
  const dir = path.join(OUT, "results");
  if (!fs.existsSync(dir)) return;
  const rows = SITES.map((s) => {
    const p = path.join(dir, s.id + ".json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  }).filter(Boolean);
  const header = [
    "id",
    "name",
    "version",
    "recall",
    "precision",
    "worldcoverRecall",
    "aerialOnRef",
    "aerialOnPred",
    "heightMae",
    "heightMedian",
    "heightN",
    "refPx",
    "predPx",
    "foliage",
    "buildings",
    "pass",
  ];
  const csv = [header.join(",")].concat(
    rows.map((r) => header.map((k) => (r[k] == null ? "" : r[k])).join(","))
  );
  const benchDir = path.join(ROOT, "bench");
  fs.writeFileSync(path.join(benchDir, "canopy-scoreboard.csv"), csv.join("\n") + "\n");
  const lines = [
    "# Canopy scoreboard",
    "",
    "Recall uses the Meta/WRI canopy height grid. A cell of at least 3 m is canopy. Where that grid measured no height, ESA WorldCover tree cover is also canopy. Roof pixels are ignored. Precision (spot) counts a drawn crown as correct when that reference agrees or the aerial pixel is green, because a dark stand the 10 m map missed is still a tree. Strict precision is the reference alone. Green on the overlay is reference canopy the export drew. Red is reference canopy still missing. Yellow is canopy the export drew that the reference does not call trees.",
    "",
    "Height error is metres of canopy thickness versus the canopy-height sample at the polygon centroid, for polygons that sit on a measured crown.",
    "",
    "| Site | Recall | Precision (spot) | Precision (strict) | WorldCover recall | Height MAE | Crowns | Pass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const r of rows) {
    const spot = r.precisionSpot != null ? r.precisionSpot : spotPrecision(r);
    const pass = r.recall != null && spot != null && r.recall >= 85 && spot >= 85;
    lines.push(
      "| " +
        r.name +
        " | " +
        (r.recall == null ? "—" : r.recall + "%") +
        " | " +
        (spot == null ? "—" : spot + "%") +
        " | " +
        (r.precision == null ? "—" : r.precision + "%") +
        " | " +
        (r.worldcoverRecall == null ? "—" : r.worldcoverRecall + "%") +
        " | " +
        (r.heightMae == null ? "—" : r.heightMae + " m") +
        " | " +
        r.foliage +
        " | " +
        (pass ? "yes" : "no") +
        " |"
    );
  }
  lines.push("");
  fs.writeFileSync(path.join(benchDir, "canopy-scoreboard.md"), lines.join("\n"));
}

async function main() {
  const only = arg("--site");
  const sites = SITES.filter((s) => !only || s.id === only);
  if (!sites.length) throw new Error("no site " + only);
  fs.mkdirSync(OUT, { recursive: true });
  for (const site of sites) {
    const zipPath = await exportSite(site);
    await scoreSite(site, zipPath);
    writeBoard();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
