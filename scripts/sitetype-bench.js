#!/usr/bin/env node
"use strict";

/**
 * Site-type benchmark: RV parks, campgrounds, marinas, and fairgrounds.
 *
 * Each site is exported locally with the page defaults (foliage, parking,
 * walls, poles, RVs and terrain on; cars and water off) on the dev host.
 *
 * Canopy recall is the canopy bench's number for that export.
 *
 * Solid clutter is scored against USGS 3DEP lidar. A lidar cell is a solid
 * object when its class-6 building returns, or its flat single-return
 * patch, stand at least 1.5 m over ground (or over the water surface on a
 * lake or harbour). Vegetation returns are not solid. Objects are split by
 * connected size: under 150 m² is small (RVs, trailers, boats, sheds), larger
 * is big (buildings, barns, grandstands). Recall is the share of those cells
 * an emitted non-vegetation area covers within 2 m. Precision is the share of
 * emitted solid area with a lidar return of at least 1.5 m within 2 m. Lidar
 * and imagery are years apart, so a parked vehicle or a moored boat can
 * move between them. The lidar survey is named on every row.
 *
 * Site score = mean of canopy recall (when the site has canopy), the small
 * object F1, and the big object F1. The set score is the mean of the sites.
 *
 *   node scripts/sitetype-bench.js [--site id] [--skip-export]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = process.env.SITETYPE_BENCH_DIR || path.join(os.tmpdir(), "sitetype-bench");
process.env.CANOPY_BENCH_DIR = OUT;
process.env.CANOPY_BENCH_ART = process.env.CANOPY_BENCH_ART || path.join(OUT, "art");
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/sitetype-sites.json"), "utf8"));
const { esriContentExtent, geoFrame, imagePxToLl, llToPx } = require("../netlify/lib/geo-frame");
const { fetchUsgsLidar, groundAt, mercator, rankProjects } = require("../netlify/lib/usgs-lidar");
const { isVegetationOiName } = require("../netlify/lib/materials");
const { rasterRings, loadZip, scoreSite } = require("./canopy-bench");

const SMALL_M2 = 150;
const SOLID_MIN_M = 1.5;
const NEAR_M = 2;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function pct(a, b) {
  return b > 0 ? Math.round((1000 * a) / b) / 10 : null;
}

function f1(r, p) {
  if (r == null || p == null) return null;
  if (r + p <= 0) return 0;
  return Math.round((20 * r * p) / (r + p)) / 10;
}

function solidName(name) {
  if (!name) return false;
  if (isVegetationOiName(name) || /^foliage/i.test(name)) return false;
  if (/water|wall|fence|pole|hedge|terrain|ground/i.test(name)) return false;
  return true;
}

async function exportSite(site) {
  const zipPath = path.join(OUT, site.id + ".zip");
  if (process.argv.includes("--skip-export") && fs.existsSync(zipPath)) return zipPath;
  const { runBackgroundExport } = require("../netlify/functions/clutter");
  const body = {
    west: site.west,
    south: site.south,
    east: site.east,
    north: site.north,
    name: site.name,
    includeFoliage: true,
    includeWater: false,
    includeParking: true,
    includeWalls: true,
    includePoles: true,
    includeRvs: true,
    includeCars: false,
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
  const res = await runBackgroundExport(event, () => {});
  const payload = JSON.parse(res.body);
  if (!payload.zipBase64) throw new Error(site.id + " export failed: " + (payload.error || "no zip"));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(zipPath, Buffer.from(payload.zipBase64, "base64"));
  if (payload.terrainClipboard) {
    fs.writeFileSync(path.join(OUT, site.id + ".terrain.json"), JSON.stringify(payload.terrainClipboard));
  }
  fs.writeFileSync(
    path.join(OUT, site.id + "-stats.json"),
    JSON.stringify({ warnings: payload.warnings, stats: payload.stats }, null, 2)
  );
  return zipPath;
}

function percentile(arr, p) {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/**
 * Lidar solid-object raster for the frame. Cached per bbox in OUT, since
 * the reference does not change between code versions.
 */
async function objectReference(site, frame) {
  const key = [frame.west, frame.south, frame.east, frame.north].map((v) => v.toFixed(6)).join("_");
  const cache = path.join(OUT, "ref-" + site.id + ".json");
  if (fs.existsSync(cache)) {
    const c = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (c.key === key) {
      c.obj = Uint8Array.from(Buffer.from(c.obj, "base64"));
      c.high = Uint8Array.from(Buffer.from(c.high, "base64"));
      return c;
    }
  }
  const ranked = rankProjects(frame).slice(0, 5);
  if (!ranked.length) return null;
  // The newest survey can be a coastal strip that clips the draw. The
  // reference uses the newest survey with ground under most of the draw.
  const sw0 = mercator(frame.west, frame.south);
  const ne0 = mercator(frame.east, frame.north);
  let lidar = null;
  let bestCover = -1;
  for (let i = 0; i < ranked.length; i++) {
    const got = await fetchUsgsLidar(frame, {
      maxMs: 150000,
      maxPoints: 14000000,
      maxBytes: 160 * 1024 * 1024,
      maxTiles: 400,
      index: [ranked[i]],
    });
    if (!got || got.skipped || !got.grid) continue;
    const g = got.grid;
    const total = Math.max(1, ((ne0[0] - sw0[0]) / g.cell) * ((ne0[1] - sw0[1]) / g.cell));
    let n = 0;
    for (const rec of g.cells.values()) if (rec.n > 0) n++;
    const cover = n / total;
    console.log(site.id, "lidar ref", ranked[i][0], "cover", cover.toFixed(2));
    if (cover > bestCover) {
      bestCover = cover;
      lidar = got;
    }
    if (cover >= 0.8) break;
  }
  if (!lidar) return null;
  const grid = lidar.grid;
  // Open water has no class-2 ground. Water-only cells (first returns and
  // nothing else) give the surface a boat or a dock stands on.
  const waterZ = [];
  for (const rec of grid.cells.values()) {
    if (rec.g == null && rec.fc > 0 && rec.uc === 0 && rec.bc === 0 && rec.vc === 0 && rec.fMax != null) waterZ.push(rec.fMax);
  }
  const water = waterZ.length >= 50 ? percentile(waterZ, 0.3) : null;
  const sw = mercator(frame.west, frame.south);
  const ne = mercator(frame.east, frame.north);
  const width = Math.ceil((ne[0] - grid.originX) / grid.cell);
  const height = Math.ceil((ne[1] - grid.originY) / grid.cell);
  const obj = new Uint8Array(width * height);
  const high = new Uint8Array(width * height);
  // Class-2 ground, spread up to 80 m under a wide roof that has none.
  const ground = new Float64Array(width * height).fill(NaN);
  for (const rec of grid.cells.values()) {
    if (rec.g == null || rec.ix < 0 || rec.iy < 0 || rec.ix >= width || rec.iy >= height) continue;
    ground[rec.iy * width + rec.ix] = rec.g;
  }
  const spread = Math.ceil(80 / (grid.cellGroundM || grid.cell));
  for (let it = 0; it < spread; it++) {
    let changed = 0;
    const next = ground.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!Number.isNaN(ground[i])) continue;
        let best = NaN;
        if (x > 0 && !(ground[i - 1] >= best)) best = Number.isNaN(ground[i - 1]) ? best : ground[i - 1];
        if (x < width - 1 && !Number.isNaN(ground[i + 1]) && !(ground[i + 1] >= best)) best = ground[i + 1];
        if (y > 0 && !Number.isNaN(ground[i - width]) && !(ground[i - width] >= best)) best = ground[i - width];
        if (y < height - 1 && !Number.isNaN(ground[i + width]) && !(ground[i + width] >= best)) best = ground[i + width];
        if (!Number.isNaN(best)) {
          next[i] = best;
          changed++;
        }
      }
    }
    ground.set(next);
    if (!changed) break;
  }
  const wet = new Uint8Array(width * height);
  for (const rec of grid.cells.values()) {
    if (rec.ix < 0 || rec.iy < 0 || rec.ix >= width || rec.iy >= height) continue;
    if (rec.g == null && rec.fc > 0 && rec.uc === 0 && rec.bc === 0 && rec.vc === 0) wet[rec.iy * width + rec.ix] = 1;
  }
  const waterNear = dilate(wet, width, height, 3);
  let covered = 0;
  for (const rec of grid.cells.values()) {
    if (rec.ix < 0 || rec.iy < 0 || rec.ix >= width || rec.iy >= height) continue;
    let g = groundAt(grid, rec.ix, rec.iy);
    if (g == null) {
      // Open water: the surface, else the spread ground.
      if (water != null && waterNear[rec.iy * width + rec.ix]) g = water;
      else if (!Number.isNaN(ground[rec.iy * width + rec.ix])) g = ground[rec.iy * width + rec.ix];
    }
    if (g == null) continue;
    covered++;
    const idx = (height - 1 - rec.iy) * width + rec.ix;
    let solid = false;
    if (rec.bc >= 1 && rec.b.length) {
      const z = percentile(rec.b, 0.9);
      if (z - g >= SOLID_MIN_M) solid = true;
    }
    if (!solid && rec.uc >= 2 && rec.vegN === 0 && rec.vc === 0 && rec.uMax - rec.uMin <= 6) {
      const z = percentile(rec.u, 0.9);
      if (z - g >= SOLID_MIN_M && z - g <= 40) solid = true;
    }
    if (solid) obj[idx] = 1;
    if (solid || (rec.fMax != null && rec.fMax - g >= SOLID_MIN_M)) high[idx] = 1;
  }
  // Connected size splits small objects from buildings.
  const cellM = grid.cellGroundM || grid.cell;
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let i = 0; i < obj.length; i++) {
    if (!obj[i] || seen[i]) continue;
    const comp = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      const x = k % width;
      const y = (k / width) | 0;
      const nb = [k - 1, k + 1, k - width, k + width];
      const ok = [x > 0, x < width - 1, y > 0, y < height - 1];
      for (let q = 0; q < 4; q++) {
        if (!ok[q]) continue;
        const j = nb[q];
        if (obj[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const m2 = comp.length * cellM * cellM;
    const cls = m2 < SMALL_M2 ? 1 : 2;
    for (const k of comp) obj[k] = cls;
  }
  const out = {
    key,
    project: lidar.project,
    collected: lidar.collected || null,
    originX: grid.originX,
    originY: grid.originY,
    cell: grid.cell,
    cellM,
    width,
    height,
    water,
    covered,
    obj,
    high,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    cache,
    JSON.stringify(Object.assign({}, out, { obj: Buffer.from(obj).toString("base64"), high: Buffer.from(high).toString("base64") }))
  );
  return out;
}

function refIndex(ref, lon, lat) {
  const m = mercator(lon, lat);
  const ix = Math.floor((m[0] - ref.originX) / ref.cell);
  const iy = Math.floor((m[1] - ref.originY) / ref.cell);
  if (ix < 0 || iy < 0 || ix >= ref.width || iy >= ref.height) return -1;
  return (ref.height - 1 - iy) * ref.width + ix;
}

function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || dx * dx + dy * dy > r * r) continue;
          out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

async function scoreObjects(site, zipPath) {
  const loaded = loadZip(zipPath, path.join(OUT, "obj-" + site.id));
  const fp = loaded.json.floorplans[0];
  const pxDim = (fp.dimensions || []).find((d) => d.unit === "pixels");
  const mDim = (fp.dimensions || []).find((d) => d.unit === "meters");
  const imgW = pxDim.width;
  const imgH = pxDim.length;
  const mpu = mDim.width / pxDim.width;
  const ext = esriContentExtent(site, imgW, imgH);
  const frame = geoFrame(ext, { imgW, imgH, maxSpanM: 8000, minSpanM: 1 });
  const small = [];
  const big = [];
  const kinds = {};
  for (const a of fp.attenuation_areas || []) {
    const name = (a.area_material && a.area_material.name) || "";
    if (!solidName(name)) continue;
    const coords = a.area && a.area.coordinates;
    if (!coords || coords.length < 3) continue;
    const ring = coords.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
    let acc = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      acc += p[0] * q[1] - q[0] * p[1];
    }
    const m2 = Math.abs(acc) * 0.5 * mpu * mpu;
    (m2 < SMALL_M2 ? small : big).push(ring);
    const kind = name.split(/[ -]/)[0];
    kinds[kind] = (kinds[kind] || 0) + 1;
  }
  const ref = await objectReference(site, frame);
  if (!ref) return { objRef: "none", kinds };
  const step = Math.max(1, Math.round(1 / mpu));
  const sm = rasterRings(small, imgW, imgH, step);
  const bg = rasterRings(big, imgW, imgH, step);
  const w = sm.w;
  const h = sm.h;
  const any = new Uint8Array(w * h);
  for (let i = 0; i < any.length; i++) any[i] = sm.mask[i] || bg.mask[i] ? 1 : 0;
  const r = Math.max(1, Math.round(NEAR_M / (step * mpu)));
  const anyNear = dilate(any, w, h, r);
  // Recall: walk the lidar cells.
  let refS = 0;
  let hitS = 0;
  let refB = 0;
  let hitB = 0;
  const rc = Math.max(1, Math.round(NEAR_M / ref.cellM));
  const highNear = dilate(ref.high, ref.width, ref.height, rc);
  const objNear = dilate(ref.obj, ref.width, ref.height, rc);
  for (let y = 0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const v = ref.obj[y * ref.width + x];
      if (!v) continue;
      const mx = ref.originX + (x + 0.5) * ref.cell;
      const my = ref.originY + (ref.height - 1 - y + 0.5) * ref.cell;
      const lon = (mx / 20037508.342789244) * 180;
      const lat = (Math.atan(Math.exp((my / 20037508.342789244) * Math.PI)) * 360) / Math.PI - 90;
      const px = ((lon - frame.west) / (frame.east - frame.west)) * imgW;
      const py = ((frame.north - lat) / (frame.north - frame.south)) * imgH;
      if (px < 0 || py < 0 || px >= imgW || py >= imgH) continue;
      const k = Math.floor(py / step) * w + Math.floor(px / step);
      const hit = anyNear[k] === 1;
      if (v === 1) {
        refS++;
        if (hit) hitS++;
      } else {
        refB++;
        if (hit) hitB++;
      }
    }
  }
  // Precision: walk the emitted samples.
  let predS = 0;
  let tpS = 0;
  let predB = 0;
  let tpB = 0;
  let predOut = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!any[i]) continue;
      const [lon, lat] = imagePxToLl(x * step + step / 2, y * step + step / 2, frame);
      const k = refIndex(ref, lon, lat);
      if (k < 0) {
        predOut++;
        continue;
      }
      const ok = highNear[k] === 1 || objNear[k] === 1;
      if (sm.mask[i]) {
        predS++;
        if (ok) tpS++;
      } else {
        predB++;
        if (ok) tpB++;
      }
    }
  }
  const smallRecall = pct(hitS, refS);
  const bigRecall = pct(hitB, refB);
  const smallPrecision = pct(tpS, predS);
  const bigPrecision = pct(tpB, predB);
  return {
    objRef: ref.project,
    objCollected: ref.collected,
    lidarCellM: Math.round(ref.cellM * 10) / 10,
    waterLevel: ref.water != null,
    smallRefCells: refS,
    bigRefCells: refB,
    smallRecall,
    smallPrecision: predS ? smallPrecision : refS ? 0 : null,
    smallF1: refS >= 30 ? f1(smallRecall, predS ? smallPrecision : 0) : null,
    bigRecall,
    bigPrecision,
    bigF1: refB >= 30 ? f1(bigRecall, bigPrecision == null ? 0 : bigPrecision) : null,
    kinds,
  };
}

function siteScore(r) {
  const parts = [];
  if (r.canopyRecall != null && r.canopyRefPx >= 2000) parts.push(r.canopyRecall);
  if (r.smallF1 != null) parts.push(r.smallF1);
  if (r.bigF1 != null) parts.push(r.bigF1);
  return parts.length ? Math.round((10 * parts.reduce((s, v) => s + v, 0)) / parts.length) / 10 : null;
}

function writeBoard() {
  const dir = path.join(OUT, "sitetype-results");
  const rows = SITES.map((s) => {
    const p = path.join(dir, s.id + ".json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  }).filter(Boolean);
  const scored = rows.filter((r) => r.score != null);
  const mean = scored.length ? Math.round((100 * scored.reduce((s, r) => s + r.score, 0)) / scored.length) / 100 : null;
  const lines = [
    "# Site-type scoreboard",
    "",
    "RV parks, campgrounds, marinas, and fairgrounds, exported with the page defaults. Canopy recall is the canopy bench measure. Small and big objects are solid USGS 3DEP lidar cells (class-6 or flat single-return patches at least 1.5 m over ground or water), split at 150 m² connected size. Recall is the share an emitted non-vegetation area covers within 2 m; precision is the share of emitted solid area with a lidar return of at least 1.5 m within 2 m. Lidar predates the imagery, so moved vehicles and boats count against both. Site score is the mean of canopy recall (sites with canopy), small F1, and big F1.",
    "",
    "| Site | Kind | Canopy recall | Small recall | Small precision | Big recall | Big precision | Score | Lidar |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const f = (v) => (v == null ? "n/a" : String(v));
  for (const r of rows) {
    lines.push(
      "| " + [r.name, r.kind, f(r.canopyRecall), f(r.smallRecall), f(r.smallPrecision), f(r.bigRecall), f(r.bigPrecision), f(r.score), r.objRef || "none"].join(" | ") + " |"
    );
  }
  for (const r of rows) if (r.objRefStale) lines.push("", r.name + ": " + r.objRefStale);
  lines.push("");
  lines.push("Set mean: **" + f(mean) + "** over " + scored.length + " sites.");
  lines.push("");
  fs.writeFileSync(path.join(OUT, "sitetype-scoreboard.md"), lines.join("\n"));
  if (process.argv.includes("--write-board")) {
    fs.writeFileSync(path.join(ROOT, "bench", "sitetype-scoreboard.md"), lines.join("\n"));
  }
  return mean;
}

async function main() {
  const only = arg("--site");
  const sites = SITES.filter((s) => !only || s.id === only);
  if (!sites.length) throw new Error("no site " + only);
  fs.mkdirSync(path.join(OUT, "sitetype-results"), { recursive: true });
  for (const site of sites) {
    const zipPath = await exportSite(site);
    let canopy = null;
    if (!process.argv.includes("--objects-only")) {
      try {
        canopy = await scoreSite(site, zipPath);
      } catch (e) {
        console.log(site.id, "canopy", e && e.message);
      }
    } else {
      const p = path.join(OUT, "results", site.id + ".json");
      if (fs.existsSync(p)) canopy = JSON.parse(fs.readFileSync(p, "utf8"));
    }
    const obj = await scoreObjects(site, zipPath);
    const row = Object.assign(
      {
        id: site.id,
        name: site.name,
        kind: site.kind,
        version: require(path.join(ROOT, "package.json")).version,
        canopyRecall: canopy ? canopy.recall : null,
        canopyPrecision: canopy ? canopy.precision : null,
        canopyRefPx: canopy ? canopy.refPx : null,
      },
      obj
    );
    if (site.objRefStale) {
      row.objRefStale = site.objRefStale;
      row.score = siteScore(Object.assign({}, row, { smallF1: null, bigF1: null }));
    } else row.score = siteScore(row);
    fs.writeFileSync(path.join(OUT, "sitetype-results", site.id + ".json"), JSON.stringify(row, null, 2));
    console.log("SITETYPE", JSON.stringify(row));
  }
  console.log("SETMEAN", writeBoard());
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { solidName, siteScore, f1 };
