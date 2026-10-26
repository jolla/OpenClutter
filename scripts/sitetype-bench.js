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
 * Worst-case pad fills (rv-pads.js: an RV drawn on an RV pad the photo
 * shows empty, so a coverage plan sees the full park) are not detections.
 * They are left out of object recall and precision and scored on their own:
 * how many, and what the lidar shows under them (a solid object, tree
 * crown, a building, or nothing within 2 m, which is a gravel pad, bare
 * ground, a road or water). The export lists them by OpenIntent pixel
 * centre in stats.padFills when OC_BENCH_PAD_FILLS is set, which this
 * script sets.
 *
 * Site score = mean of canopy recall (when the site has canopy), the small
 * object F1 (the hand-label RV F1 where a site has hand labels, see
 * scoreHandLabels), and the big object F1. The set score is the mean of
 * the sites.
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

function ringCentre(ring) {
  let n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

/** Pad-fill centres the export listed (stats.padFills), else none. */
function padFillCentres(site) {
  const p = path.join(OUT, site.id + "-stats.json");
  if (!fs.existsSync(p)) return null;
  const st = JSON.parse(fs.readFileSync(p, "utf8")).stats || {};
  return Array.isArray(st.padFills) ? st.padFills : null;
}

function isPadFill(ring, centres) {
  if (!centres || !centres.length) return false;
  const c = ringCentre(ring);
  for (const q of centres) {
    if (Math.abs(q[0] - c[0]) <= 0.6 && Math.abs(q[1] - c[1]) <= 0.6) return true;
  }
  return false;
}

/**
 * Hand-label RV scoring. Sites whose lidar predates the photo by years
 * (Silver View: 2018 lidar, 2025 photo) name a hand-label set in
 * bench/sitetype-sites.json ("handLabels"). The labels are boxes drawn on
 * the current Esri plate around every RV, trailer and park model in a
 * label window, plus "uncertain" boxes. They carry Esri imagery, so they
 * live outside the repo: OC_GT_DIR/<handLabels>/labels.geojson (lon/lat,
 * window in properties.window). Without them the site falls back to lidar.
 *
 * Predictions are the exported RV and trailer areas, pad fills excluded
 * (they are scored on their own), stacked slabs merged, clipped to the
 * window. Building areas count only as a match for a park-model label.
 * Predictions centred in an uncertain box are dropped. Matching is one to
 * one, greedy by IoU: IoU >= 0.2, or the label holds the centre of a
 * prediction under 40 m². RV recall = matched labels / labels, RV
 * precision = matched predictions / RV predictions. The RV F1 replaces the
 * lidar small-object F1 in the site score; big objects stay on lidar.
 */
const HAND_CELL_M = 0.2;

function handLabelSet(site) {
  if (!site.handLabels || !process.env.OC_GT_DIR) return null;
  const p = path.join(process.env.OC_GT_DIR, site.handLabels, "labels.geojson");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function polyCells(pts, grid) {
  // pts: [[mx, my]] in window metres (x east, y south). Returns sorted cell ids.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const c = HAND_CELL_M;
  const i0 = Math.max(0, Math.floor(x0 / c));
  const i1 = Math.min(grid.w - 1, Math.ceil(x1 / c));
  const j0 = Math.max(0, Math.floor(y0 / c));
  const j1 = Math.min(grid.h - 1, Math.ceil(y1 / c));
  const out = [];
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * c;
    for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * c;
      let inside = false;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const pa = pts[a];
        const pb = pts[b];
        if (pa[1] > y !== pb[1] > y && x < ((pb[0] - pa[0]) * (y - pa[1])) / (pb[1] - pa[1]) + pa[0]) inside = !inside;
      }
      if (inside) out.push(j * grid.w + i);
    }
  }
  return out;
}

function cellsInter(a, b) {
  const s = a.length < b.length ? new Set(a) : new Set(b);
  const o = a.length < b.length ? b : a;
  let n = 0;
  for (const k of o) if (s.has(k)) n++;
  return n;
}

function cellsCentre(cells, grid) {
  let x = 0;
  let y = 0;
  for (const k of cells) {
    x += k % grid.w;
    y += Math.floor(k / grid.w);
  }
  return Math.floor(y / cells.length) * grid.w + Math.floor(x / cells.length);
}

/** rings: [{ring (OpenIntent px, y up), cls: "rv" | "building"}]. */
function scoreHandLabels(fc, rings, frame, imgW, imgH) {
  const win = fc.properties.window;
  const lat0 = (win.north + win.south) / 2;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110540;
  const toM = (lon, lat) => [(lon - win.west) * mx, (win.north - lat) * my];
  const grid = { w: Math.ceil(((win.east - win.west) * mx) / HAND_CELL_M), h: Math.ceil(((win.north - win.south) * my) / HAND_CELL_M) };
  const cellM2 = HAND_CELL_M * HAND_CELL_M;
  const labels = [];
  const unc = new Set();
  for (const f of fc.features) {
    const cls = f.properties.class;
    if (cls !== "rv_trailer" && cls !== "uncertain") continue;
    const cells = polyCells(f.geometry.coordinates[0].map((c) => toM(c[0], c[1])), grid);
    if (!cells.length) continue;
    if (cls === "uncertain") for (const k of cells) unc.add(k);
    else labels.push({ cells, set: new Set(cells), park: f.properties.subtype === "park_model" });
  }
  // Predictions in window cells, stacked slabs of one class merged.
  const raw = [];
  for (const r of rings) {
    const pts = r.ring.map((p) => {
      const ll = imagePxToLl(p[0], imgH - p[1], frame);
      return toM(ll[0], ll[1]);
    });
    const cells = polyCells(pts, grid);
    if (cells.length * cellM2 < 0.5) continue;
    raw.push({ cls: r.cls, cells });
  }
  raw.sort((a, b) => b.cells.length - a.cells.length);
  const used = new Array(raw.length).fill(false);
  const preds = [];
  for (let i = 0; i < raw.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    for (let j = i + 1; j < raw.length; j++) {
      if (used[j] || raw[j].cls !== raw[i].cls) continue;
      if (cellsInter(raw[i].cells, raw[j].cells) > 0.8 * raw[j].cells.length) used[j] = true;
    }
    if (unc.has(cellsCentre(raw[i].cells, grid))) continue;
    preds.push(raw[i]);
  }
  const rv = preds.filter((p) => p.cls === "rv");
  const alt = preds.filter((p) => p.cls === "building" && labels.some((l) => l.park && cellsInter(l.cells, p.cells) > 0));
  const cand = rv.concat(alt.map((p) => Object.assign({ alt: true }, p)));
  const pairs = [];
  labels.forEach((l, i) => {
    cand.forEach((p, j) => {
      if (p.alt && !l.park) return;
      const inter = cellsInter(l.cells, p.cells);
      if (!inter) return;
      const iou = inter / (l.cells.length + p.cells.length - inter);
      const small = p.cells.length * cellM2 < 40;
      if (iou >= 0.2 || (small && l.set.has(cellsCentre(p.cells, grid)))) pairs.push([iou, i, j]);
    });
  });
  pairs.sort((a, b) => b[0] - a[0]);
  const ul = new Set();
  const up = new Set();
  let altTp = 0;
  for (const [, i, j] of pairs) {
    if (ul.has(i) || up.has(j)) continue;
    ul.add(i);
    up.add(j);
    if (cand[j].alt) altTp++;
  }
  const tp = ul.size;
  const npred = rv.length + altTp;
  const recall = pct(tp, labels.length);
  const precision = npred ? pct(tp, npred) : null;
  return {
    rvLabels: labels.length,
    rvPreds: npred,
    rvTp: tp,
    rvRecall: recall,
    rvPrecision: precision,
    rvF1: labels.length ? f1(recall, precision == null ? 0 : precision) : null,
    rvRef: "hand labels, " + (fc.properties.imagery && fc.properties.imagery[0] ? fc.properties.imagery[0].vendor + " " + fc.properties.imagery[0].date : "current photo"),
  };
}

/**
 * Hand-label tree scoring. A site whose lidar caught RVs that have moved
 * since reads them as canopy, so canopy recall against that lidar rewards
 * crowns drawn over RV rows. Such a site can name a tree hand-label set
 * ("treeLabels"): crowns traced on the current Esri plate, "uncertain"
 * patches (palms, hedges, scrub) and a "window" polygon, at
 * OC_GT_DIR/<treeLabels>/labels.geojson, kept outside the repo. The exported
 * Heavy, Light and Understory foliage is rasterised on a 0.2 m grid inside
 * the window, uncertain cells ignored. Precision is the share of foliage
 * within 1 m of a labelled crown, recall the share of labelled crown within
 * 1 m of foliage. The tree F1 replaces canopy recall in the site score.
 */
function treeLabelSet(site) {
  if (!site.treeLabels || !process.env.OC_GT_DIR) return null;
  const p = path.join(process.env.OC_GT_DIR, site.treeLabels, "labels.geojson");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function scoreTreeLabels(fc, rings, frame, imgW, imgH) {
  const winF = fc.features.find((f) => f.properties && f.properties.class === "window");
  if (!winF) return { treeRef: "tree labels have no window, lidar used" };
  const wr = winF.geometry.coordinates[0];
  const win = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  for (const c of wr) {
    win.west = Math.min(win.west, c[0]);
    win.east = Math.max(win.east, c[0]);
    win.south = Math.min(win.south, c[1]);
    win.north = Math.max(win.north, c[1]);
  }
  const lat0 = (win.north + win.south) / 2;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110540;
  const toM = (lon, lat) => [(lon - win.west) * mx, (win.north - lat) * my];
  const grid = { w: Math.ceil(((win.east - win.west) * mx) / HAND_CELL_M), h: Math.ceil(((win.north - win.south) * my) / HAND_CELL_M) };
  const n = grid.w * grid.h;
  const inWin = new Uint8Array(n);
  const gt = new Uint8Array(n);
  const pred = new Uint8Array(n);
  for (const k of polyCells(wr.map((c) => toM(c[0], c[1])), grid)) inWin[k] = 1;
  for (const f of fc.features) {
    const cls = f.properties && f.properties.class;
    if (cls !== "tree" && cls !== "uncertain") continue;
    for (const k of polyCells(f.geometry.coordinates[0].map((c) => toM(c[0], c[1])), grid)) {
      if (cls === "uncertain") inWin[k] = 0;
      else gt[k] = 1;
    }
  }
  for (const ring of rings) {
    const pts = ring.map((p) => {
      const ll = imagePxToLl(p[0], imgH - p[1], frame);
      return toM(ll[0], ll[1]);
    });
    for (const k of polyCells(pts, grid)) pred[k] = 1;
  }
  for (let k = 0; k < n; k++) if (!inWin[k]) gt[k] = 0;
  const r = Math.round(1 / HAND_CELL_M);
  const gtNear = dilate(gt, grid.w, grid.h, r);
  const predNear = dilate(pred, grid.w, grid.h, r);
  let ev = 0;
  let np = 0;
  let tp = 0;
  let ng = 0;
  let hit = 0;
  for (let k = 0; k < n; k++) {
    if (!inWin[k]) continue;
    ev++;
    if (pred[k]) {
      np++;
      if (gtNear[k]) tp++;
    }
    if (gt[k]) {
      ng++;
      if (predNear[k]) hit++;
    }
  }
  const precision = np ? Math.round((1000 * tp) / np) / 10 : null;
  const recall = ng ? Math.round((1000 * hit) / ng) / 10 : null;
  return {
    treeRef: "tree hand labels, " + (fc.properties && fc.properties.imagery ? fc.properties.imagery : "current photo"),
    treeCoverPct: ev ? Math.round((1000 * np) / ev) / 10 : null,
    treeLabelCoverPct: ev ? Math.round((1000 * ng) / ev) / 10 : null,
    treePrecision: precision,
    treeRecall: recall,
    treeF1: recall != null ? f1(recall, precision == null ? 0 : precision) : null,
  };
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
  const pads = [];
  const water = [];
  const kinds = {};
  const centres = padFillCentres(site);
  const handRings = [];
  const foliageRings = [];
  for (const a of fp.attenuation_areas || []) {
    const name = (a.area_material && a.area_material.name) || "";
    const coords = a.area && a.area.coordinates;
    if (!coords || coords.length < 3) continue;
    const ring = coords.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
    if (/^Foliage - (Heavy|Light|Understory)/.test(name)) foliageRings.push(ring);
    if (/water/i.test(name)) water.push(ring);
    if (!solidName(name)) continue;
    if (isPadFill(ring, centres)) {
      pads.push(ring);
      continue;
    }
    if (/^(rv|trailer)/i.test(name)) handRings.push({ ring, cls: "rv" });
    else if (/^building/i.test(name)) handRings.push({ ring, cls: "building" });
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
  const fc = handLabelSet(site);
  const hand = fc ? scoreHandLabels(fc, handRings, frame, imgW, imgH) : site.handLabels ? { rvRef: "hand labels missing (set OC_GT_DIR), lidar used" } : {};
  const tfc = treeLabelSet(site);
  if (tfc) Object.assign(hand, scoreTreeLabels(tfc, foliageRings, frame, imgW, imgH));
  else if (site.treeLabels) hand.treeRef = "tree hand labels missing (set OC_GT_DIR), lidar canopy used";
  const ref = await objectReference(site, frame);
  if (!ref) return Object.assign({ objRef: "none", kinds, padFills: centres ? centres.length : null }, hand);
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
  // Pad fills: what the lidar shows under each emitted sample.
  const pad = { n: 0, object: 0, building: 0, crown: 0, near: 0, empty: 0, water: 0, out: 0 };
  if (pads.length) {
    const pm = rasterRings(pads, imgW, imgH, step);
    const wm = water.length ? rasterRings(water, imgW, imgH, step).mask : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!pm.mask[i]) continue;
        const [lon, lat] = imagePxToLl(x * step + step / 2, y * step + step / 2, frame);
        const k = refIndex(ref, lon, lat);
        if (k < 0) {
          pad.out++;
          continue;
        }
        pad.n++;
        if (wm && wm[i]) pad.water++;
        if (ref.obj[k] === 2) pad.building++;
        else if (ref.obj[k] === 1) pad.object++;
        else if (ref.high[k]) pad.crown++;
        else if (highNear[k] === 1 || objNear[k] === 1) pad.near++;
        else pad.empty++;
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
    padFills: centres ? pads.length : null,
    padOnObjectPct: pad.n ? pct(pad.object + pad.near, pad.n) : null,
    padLidarEmptyPct: pad.n ? pct(pad.empty, pad.n) : null,
    padOnBuildingPct: pad.n ? pct(pad.building, pad.n) : null,
    padOnCrownPct: pad.n ? pct(pad.crown, pad.n) : null,
    padOnWaterPct: pad.n ? pct(pad.water, pad.n) : null,
    ...hand,
  };
}

function siteScore(r) {
  const parts = [];
  if (r.treeF1 != null) parts.push(r.treeF1);
  else if (r.canopyRecall != null && r.canopyRefPx >= 2000) parts.push(r.canopyRecall);
  if (r.rvF1 != null) parts.push(r.rvF1);
  else if (r.smallF1 != null) parts.push(r.smallF1);
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
    "RV parks, campgrounds, marinas, and fairgrounds, exported with the page defaults. Canopy recall is the canopy bench measure. Small and big objects are solid USGS 3DEP lidar cells (class-6 or flat single-return patches at least 1.5 m over ground or water), split at 150 m² connected size. Recall is the share an emitted non-vegetation area covers within 2 m; precision is the share of emitted solid area with a lidar return of at least 1.5 m within 2 m. Lidar predates the imagery, so moved vehicles and boats count against both. Site score is the mean of canopy recall (sites with canopy), small F1, and big F1. Worst-case pad fills (RVs drawn on pads the photo shows empty) are not in recall or precision; the pad columns count them and give the share of their area over a lidar solid object (within 2 m), over nothing within 2 m (gravel pad, bare ground, road or water), on a building roof, on a tree crown, and on mapped water. Sites marked with hand labels (lidar years older than the photo) score RVs against boxes drawn on the current photo instead of lidar small objects: one-to-one match at IoU 0.2 or a label holding the centre of a prediction under 40 m², pad fills excluded, uncertain boxes ignored, a building area matching a park model counts; the RV F1 replaces the small F1 in the score.",
    "",
    "| Site | Kind | Canopy recall | Small recall | Small precision | Big recall | Big precision | Score | Pad fills | Pad on object % | Pad lidar-empty % | Pad on roof % | Pad on crown % | Pad on water % | Lidar |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const f = (v) => (v == null ? "n/a" : String(v));
  for (const r of rows) {
    lines.push(
      "| " + [r.name, r.kind, f(r.canopyRecall), f(r.smallRecall), f(r.smallPrecision), f(r.bigRecall), f(r.bigPrecision), f(r.score), f(r.padFills), f(r.padOnObjectPct), f(r.padLidarEmptyPct), f(r.padOnBuildingPct), f(r.padOnCrownPct), f(r.padOnWaterPct), r.objRef || "none"].join(" | ") + " |"
    );
  }
  for (const r of rows) {
    if (r.rvLabels != null) lines.push("", r.name + ": RVs vs " + r.rvRef + ": " + r.rvLabels + " labels, " + r.rvPreds + " predictions, " + r.rvTp + " matched, recall " + r.rvRecall + ", precision " + f(r.rvPrecision) + ", F1 " + f(r.rvF1) + " (replaces the lidar small F1).");
    else if (r.rvRef) lines.push("", r.name + ": " + r.rvRef + ".");
    if (r.treeF1 != null) lines.push("", r.name + ": trees vs " + r.treeRef + ": foliage cover " + r.treeCoverPct + "% vs " + r.treeLabelCoverPct + "% labelled, precision " + f(r.treePrecision) + ", recall " + r.treeRecall + ", F1 " + r.treeF1 + " (replaces the lidar canopy recall " + f(r.canopyRecall) + ").");
    else if (r.treeRef) lines.push("", r.name + ": " + r.treeRef + ".");
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
  process.env.OC_BENCH_PAD_FILLS = "1";
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

module.exports = { solidName, siteScore, f1, isPadFill, ringCentre, scoreHandLabels };
