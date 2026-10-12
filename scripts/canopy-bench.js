#!/usr/bin/env node
"use strict";

/**
 * Canopy benchmark. Each site is a live-sized export. Recall is the share of
 * reference canopy the export drew: a Meta/WRI cell of at least 3 m, or an
 * ESA WorldCover tree cell where that grid measured no height. Precision
 * samples the emitted canopy on one uniform grid. A sample counts only when
 * the canopy-height model is at least 3 m and the aerial is not an open
 * lawn, mown field, RV pitch, or road. Those open surfaces drawn as canopy
 * are false positives even when the height model says 3 m. A green aerial
 * pixel is not a hit by itself. Building footprints are left out of both masks.
 * Height error compares the canopy top above local ground with the height
 * model. A crown on a trunk or understory counts the whole stack. The
 * understory gap is that ground-to-crown distance against the intended gap
 * for a stand of at least 800 m². The preview counts a floating piece and a
 * flat slab on its own.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const jpeg = require("jpeg-js");
const { esriContentExtent, geoFrame, imagePxToLl, pxToLl } = require("../netlify/lib/geo-frame");
const { fetchChmGrid } = require("../netlify/lib/canopy-height");
const { canopyRaster, fetchUsgsLidar, rankProjects } = require("../netlify/lib/usgs-lidar");
const { fetchWorldCoverTrees, TREE } = require("../netlify/lib/worldcover");
const { isTrunkOiName, isUnderstoryOiName, isVegetationOiName, standUnderstoryM } = require("../netlify/lib/materials");
const { coniferPixel, openGroundPixel, localStd } = require("../netlify/lib/surface-mask");

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

const STAND_LAYER_M2 = 800;

function plateScale(floorplan) {
  const dims = (floorplan && floorplan.dimensions) || [];
  const px = dims.find((d) => d.unit === "pixels");
  const meters = dims.find((d) => d.unit === "meters");
  if (!px || !meters || !(px.width > 0) || !(px.length > 0) || !(meters.width > 0) || !(meters.length > 0)) return null;
  return { mpuX: meters.width / px.width, mpuY: meters.length / px.length };
}

function materialSpan(material) {
  const top = Number(material && material.top_height);
  const bottom = Number(material && material.bottom_height);
  if (Number.isFinite(bottom) && Number.isFinite(top) && top > bottom + 0.05) {
    return { bottom, top, thick: top - bottom };
  }
  if (Number.isFinite(top) && top > 0 && top < 80) return { bottom: 0, top, thick: top };
  return null;
}

function ringAreaM2(ring, mpuX, mpuY) {
  let acc = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    acc += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(acc) * 0.5 * mpuX * mpuY;
}

function partKind(name) {
  if (isUnderstoryOiName(name)) return "understory";
  if (isTrunkOiName(name)) return "trunk";
  if (isVegetationOiName(name)) return "crown";
  return "";
}

function closePart(a, b, mpu) {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  const reach = Math.max(30, (0.55 * Math.sqrt(Math.max(a.area, b.area))) / Math.max(mpu, 0.02));
  return dx * dx + dy * dy <= reach * reach;
}

function supportUnder(part, parts, mpu) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < parts.length; i++) {
    const other = parts[i];
    if (other === part || (other.kind !== "understory" && other.kind !== "trunk")) continue;
    if (Math.abs(other.span.top - part.span.bottom) > 0.35) continue;
    if (other.kind === "understory") {
      const ratio = other.area / part.area;
      if (ratio < 0.7 || ratio > 1.4) continue;
    }
    const dx = other.cx - part.cx;
    const dy = other.cy - part.cy;
    const d = dx * dx + dy * dy;
    if (!closePart(part, other, mpu) || d >= bestD) continue;
    best = other;
    bestD = d;
  }
  return best;
}

function crownAbove(part, parts, mpu) {
  for (let i = 0; i < parts.length; i++) {
    const other = parts[i];
    if (other === part || other.kind !== "crown") continue;
    if (Math.abs(other.span.bottom - part.span.top) > 0.35) continue;
    if (closePart(part, other, mpu)) return other;
  }
  return null;
}

function sitsOnCrown(part, parts, mpu) {
  for (let i = 0; i < parts.length; i++) {
    const other = parts[i];
    if (other === part || other.kind !== "crown") continue;
    if (Math.abs(other.span.top - part.span.bottom) > 0.35) continue;
    if (closePart(part, other, mpu)) return true;
  }
  return false;
}

/**
 * Full canopy height above local ground, and the understory gap under stands.
 * Heights are one sample per stack (the lowest crown, through the top band).
 * Gap error is |actual ground-to-crown minus the intended gap| for stands
 * of at least 800 m² whose height calls for a raised crown.
 */
function shapeOfAreas(areas, mpuX, mpuY) {
  const mpu = Math.max(mpuX || 0.2, mpuY || 0.2) * 0.5 + Math.min(mpuX || 0.2, mpuY || 0.2) * 0.5;
  const parts = [];
  for (const area of areas || []) {
    const material = area.area_material || {};
    const name = material.name || "";
    const kind = partKind(name);
    const coords = area.area && area.area.coordinates;
    if (!kind || !coords || coords.length < 4) continue;
    const span = materialSpan(material);
    const ring = coords.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
    const c = centroid(ring);
    if (!span || !c) continue;
    parts.push({
      kind,
      name,
      tier: /heavy/i.test(name) ? "heavy" : "light",
      span,
      area: ringAreaM2(ring, mpuX, mpuY),
      cx: c[0],
      cy: c[1],
    });
  }
  const heights = [];
  const gapErrs = [];
  let largestCrownM2 = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind !== "crown") continue;
    if (part.area > largestCrownM2) largestCrownM2 = part.area;
    if (sitsOnCrown(part, parts, mpu)) continue;
    let top = part.span.top;
    let guard = 0;
    let above = crownAbove(part, parts, mpu);
    while (above && guard++ < 6) {
      top = above.span.top;
      above = crownAbove(above, parts, mpu);
    }
    const support = supportUnder(part, parts, mpu);
    const ground = support ? support.span.bottom : part.span.bottom;
    const full = top - ground;
    if (!(full > 0.5 && full < 80)) continue;
    heights.push({ thick: full, x: part.cx, y: part.cy });
    if (part.area < STAND_LAYER_M2) continue;
    const expected = standUnderstoryM(full, part.tier);
    if (!(expected >= 2.5)) continue;
    const actual = support && support.kind === "understory" ? support.span.thick : 0;
    gapErrs.push(Math.abs(actual - expected));
  }
  return { heights, gapErrs, largestCrownM2: Math.round(largestCrownM2) };
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
  for (const a of areas) {
    const material = a.area_material || {};
    const name = material.name || "";
    const coords = a.area && a.area.coordinates;
    if (!coords || coords.length < 4) continue;
    const ring = coords.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
    if (name.indexOf("Building") === 0) buildings.push(ring);
    else if (isVegetationOiName(name)) foliage.push(ring);
  }
  // geoFrame's north-south metre length follows the geodesic span, which is
  // longer than the square-pixel plate. Stand area uses the zip's own scale.
  const scale = plateScale(loaded.json.floorplans[0]) || { mpuX: frame.mpuX, mpuY: frame.mpuX };
  const shape = shapeOfAreas(areas, scale.mpuX, scale.mpuY);
  const step = Math.max(4, Math.ceil(Math.sqrt((raw.width * raw.height) / 160000)));
  const fol = rasterRings(foliage, raw.width, raw.height, step);
  const bld = rasterRings(buildings, raw.width, raw.height, step);
  console.log(site.id, "fetch chm", frame.west.toFixed(5), frame.south.toFixed(5), frame.east.toFixed(5), frame.north.toFixed(5));
  const chm = await fetchChmGrid(frame, { signal: AbortSignal.timeout(180000) });
  let refGrid = chm;
  let refSource = "chm";
  try {
    const lidar = await lidarReference(frame);
    if (lidar) {
      refGrid = lidar.raster;
      refSource = "lidar";
      console.log(site.id, "lidar", lidar.project, "cells", lidar.raster.nonzero, "spacing", lidar.spacingM);
    } else {
      console.log(site.id, "lidar skip");
    }
  } catch (e) {
    console.log(site.id, "lidar", e && e.message);
  }
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
  let chmTp = 0;
  let wholeTp = 0;
  let openN = 0;
  let openLawn = 0;
  let openPitch = 0;
  let openRoad = 0;
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
      const hv = chmAt(refGrid, lon, lat);
      const wc = cover ? cover.sample(lon, lat) === TREE : false;
      const isRef = refSource === "lidar" ? hv >= 3 : hv >= 3 || (hv < 1 && wc);
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
      let openFp = false;
      if (isPred) {
        pred++;
        const std = localStd(raw.data, raw.width, raw.height, xx, yy);
        const ground = openGroundPixel(raw.data[pix], raw.data[pix + 1], raw.data[pix + 2], std);
        // A mown field is the lawn class. A tan RV pitch or dirt infield is pitch.
        openFp = ground === "lawn" || ground === "pitch" || ground === "road";
        if (ground === "lawn") openLawn++;
        else if (ground === "pitch") openPitch++;
        else if (ground === "road") openRoad++;
        if (openFp) openN++;
        if (hv >= 3) chmTp++;
        if (hv >= 3 && !openFp) wholeTp++;
        if (isRef) tp++;
        else {
          fp++;
          if (green) fpGreen++;
          if (hv >= 1 && hv < 3) fpShort++;
        }
        if (green) aerialOnPred++;
      }
      const precise = isPred && hv >= 3 && !openFp;
      paint[i] = precise ? 1 : isRef && !isPred ? 2 : isPred ? 3 : 0;
    }
  }
  const errs = [];
  for (const row of shape.heights) {
    const [lon, lat] = pxToLl(row.x, row.y, frame);
    const hv = chmAt(refGrid, lon, lat);
    if (hv >= 2) errs.push(Math.abs(row.thick - hv));
  }
  const gapErrs = shape.gapErrs.slice().sort((a, b) => a - b);
  const gapMae = gapErrs.length ? gapErrs.reduce((s, v) => s + v, 0) / gapErrs.length : null;
  let preview = null;
  try {
    preview = previewStats(site, zipPath);
  } catch (e) {
    console.log(site.id, "preview", e && e.message);
  }
  errs.sort((a, b) => a - b);
  const mae = errs.length ? errs.reduce((s, v) => s + v, 0) / errs.length : null;
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
  const recall = pct(hit, ref);
  const chmPrecision = pct(chmTp, pred);
  const precision = pct(wholeTp, pred);
  const openLeak = pct(openN, pred);
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
    refSource,
    lidarCells: refSource === "lidar" ? refGrid.nonzero : 0,
    recall,
    precision,
    chmPrecision,
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
    understoryGapMae: gapMae == null ? null : Math.round(gapMae * 10) / 10,
    understoryN: gapErrs.length,
    floating: preview ? preview.floatingTrees : null,
    slabs: preview ? preview.slabs : null,
    largestCrownM2: preview ? preview.largestCrownM2 : shape.largestCrownM2,
    precisionSpot: pct(tp + fpGreen, pred),
    openLeak,
    openLawn: pct(openLawn, pred),
    openPitch: pct(openPitch, pred),
    openRoad: pct(openRoad, pred),
    pass: recall != null && precision != null && recall >= 85 && precision >= 85,
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
  if (payload.terrainClipboard) {
    fs.writeFileSync(path.join(OUT, site.id + ".terrain.json"), JSON.stringify(payload.terrainClipboard));
  }
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

async function lidarReference(frame) {
  const ranked = rankProjects(frame).slice(0, 4);
  for (let i = 0; i < ranked.length; i++) {
    const lidar = await fetchUsgsLidar(frame, { maxMs: 45000, index: [ranked[i]] });
    const kept = lidar && lidar.grid ? lidar.grid.kept : 0;
    const raster = lidar && !lidar.skipped && kept > 500 ? canopyRaster(lidar.grid) : null;
    if (raster && raster.nonzero >= 40) {
      return { raster, project: lidar.project, spacingM: lidar.spacingM };
    }
  }
  return null;
}

function previewStats(site, zipPath) {
  const terrainPath = path.join(OUT, site.id + ".terrain.json");
  if (!fs.existsSync(terrainPath)) return null;
  const outDir = path.join(ART, "hamina-preview");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, site.id + ".png");
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "hamina-preview.js"),
      "--zip",
      zipPath,
      "--terrain",
      terrainPath,
      "--site",
      site.id,
      "--out",
      out,
    ],
    { stdio: "inherit", cwd: ROOT, env: Object.assign({}, process.env, { NODE_PATH: path.join(ROOT, "node_modules") }) }
  );
  const statsPath = out.replace(/\.png$/i, ".json");
  if (!fs.existsSync(statsPath)) return null;
  return JSON.parse(fs.readFileSync(statsPath, "utf8"));
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
    "chmPrecision",
    "openLeak",
    "openLawn",
    "openPitch",
    "openRoad",
    "worldcoverRecall",
    "aerialOnRef",
    "aerialOnPred",
    "heightMae",
    "heightMedian",
    "heightN",
    "understoryGapMae",
    "understoryN",
    "floating",
    "slabs",
    "largestCrownM2",
    "refSource",
    "lidarCells",
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
    "Where USGS 3DEP covers the draw, recall uses lidar: first returns minus ground, and a cell of at least 3 m is canopy. Elsewhere recall uses the Meta/WRI canopy height grid the same way, plus ESA WorldCover tree cover where that grid measured no height. Roof pixels are ignored. Precision samples every emitted canopy cell. The cell counts only when that reference is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.",
    "",
    "Height ≥ 3 m is the reference share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m². Where USGS 3DEP covers the draw, recall, precision, and height error use first returns minus ground. A cell counts at 3 m. A site outside that coverage keeps the canopy-height model.",
    "",
    "| Site | Recall | Precision | Height ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Ref | Pass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const r of rows) {
    const pass = r.recall != null && r.precision != null && r.recall >= 85 && r.precision >= 85;
    lines.push(
      "| " +
        r.name +
        " | " +
        (r.recall == null ? "—" : r.recall + "%") +
        " | " +
        (r.precision == null ? "—" : r.precision + "%") +
        " | " +
        (r.chmPrecision == null ? "—" : r.chmPrecision + "%") +
        " | " +
        (r.openLeak == null ? "—" : r.openLeak + "%") +
        " | " +
        (r.heightMae == null ? "—" : r.heightMae + " m") +
        " | " +
        (r.understoryGapMae == null ? "—" : r.understoryGapMae + " m") +
        " | " +
        (r.floating == null ? "—" : String(r.floating)) +
        " | " +
        (r.slabs == null ? "—" : String(r.slabs)) +
        " | " +
        (r.refSource || "chm") +
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

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { plateScale, shapeOfAreas, writeBoard };
