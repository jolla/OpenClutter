"use strict";

/**
 * Building height for Hamina from NLS laser scanning (roof minus ground).
 *
 * Buildings 3D (LoD2 CityGML) does not cover Hamina. The coverage map
 * https://tilannekartta.maanmittauslaitos.fi/3drakennukset had no production
 * area containing 60.57°N, 27.20°E on 2026-09-25. FEMA is US-only. Microsoft
 * Global ML heights on the Finland quadkey are −1. Copernicus GLO-30 is a
 * surface DSM already used for terrain; it is not a building height.
 *
 * NLS WCS and the OGC API Processes file service answer 401 unless the
 * caller sends HTTP Basic credentials. The env var is NLS_API_KEY. Do not
 * invent a key. korkeusmalli_2m behind that key is bare earth, so it cannot
 * supply roof height on its own. This module does not call those APIs.
 *
 * The heights here are the open Funet copy of NLS Laser scanning data
 * 2008–2019, tile L5211C3 (2009), EPSG:3067, CC BY 4.0:
 * https://www.nic.funet.fi/pub/sci/geo/geodata/mml/laserkeilaus/2008_latest/2009/L521/2/L5211C3.laz
 * Class 2 is ground. Class 1 (unclassified; this product has no building
 * class) minus that ground, 2 m cells, stored as decimetres. Sampling is
 * limited to the footprint so forest returns outside a roof are ignored.
 * Rebuild with scripts/build-nls-hamina-ndsm.py.
 *
 * Dev host only. Production does not call applyNlsBuildingHeights.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { exteriorRings, featureHeight } = require("./ms-global");

const NLS_API_KEY_ENV = "NLS_API_KEY";
const NLS_CREDIT =
  "Contains data from the National Land Survey of Finland Laser scanning data 2008–2019, tile L5211C3 (2009), CC BY 4.0.";
const HEIGHT_SOURCE = "nls-laser";
const ORIGIN_E = 509000;
const ORIGIN_N = 6714000;
const CELL_M = 2;
const COLS = 1500;
const ROWS = 1500;
const MIN_CELLS = 4;
const MAX_CELL_TESTS = 8000;

/** Sources that already beat a laser nDSM. Floor counts and empty rings do not. */
const PROTECT_HEIGHT = { overture: true, "ms-global": true, fema: true };

let grid = null;
/** Test-only. Production leaves this null and searches nlsGridPaths(). */
let gridPathOverride = null;

function nlsApiKey() {
  const k = process.env[NLS_API_KEY_ENV];
  return k && String(k).trim() ? String(k).trim() : "";
}

const GRID_FILENAME = "nls-hamina-ndsm.gz";

/**
 * Local tests read the gzip beside this module. The deployed function is
 * esbuild output at netlify/functions/clutter.js; included_files places the
 * gzip at netlify/lib/ inside the lambda (/var/task).
 */
function nlsGridPaths() {
  const roots = [
    __dirname,
    path.join(__dirname, "..", "lib"),
    path.join(process.env.LAMBDA_TASK_ROOT || "", "netlify", "lib"),
    path.join(process.cwd(), "netlify", "lib"),
  ];
  const out = [];
  for (let i = 0; i < roots.length; i++) {
    const p = path.join(roots[i], GRID_FILENAME);
    if (out.indexOf(p) === -1) out.push(p);
  }
  return out;
}

function setNlsGridPathForTests(filePath) {
  gridPathOverride = filePath == null || filePath === "" ? null : String(filePath);
  grid = null;
}

function readGridGzip() {
  const paths = gridPathOverride ? [gridPathOverride] : nlsGridPaths();
  let last = null;
  for (let i = 0; i < paths.length; i++) {
    try {
      return fs.readFileSync(paths[i]);
    } catch (e) {
      last = e;
      if (!e || e.code !== "ENOENT") throw e;
    }
  }
  const err = new Error("Finland laser grid missing");
  err.code = "ENOENT";
  if (last) err.cause = last;
  throw err;
}

function loadGrid() {
  if (grid) return grid;
  const gz = readGridGzip();
  const buf = zlib.gunzipSync(gz);
  if (buf.length !== COLS * ROWS * 2) throw new Error("bad Hamina nDSM");
  const aligned = buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf);
  grid = new Uint16Array(aligned.buffer, aligned.byteOffset, COLS * ROWS);
  return grid;
}

/** ETRS89 / TM35FIN (EPSG:3067). Matches PROJ to well under a millimetre. */
function lonLatToTm35(lon, lat) {
  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const lon0 = (27 * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const n = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const A = (lam - lon0) * Math.cos(phi);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));
  const k0 = 0.9996;
  const east =
    500000 +
    k0 *
      n *
      (A +
        ((1 - t + c) * A ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * A ** 5) / 120);
  const north =
    k0 *
    (M +
      n *
        Math.tan(phi) *
        ((A * A) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * A ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * A ** 6) / 720));
  return [east, north];
}

function cellMetres(col, row) {
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return 0;
  const dm = loadGrid()[row * COLS + col];
  return dm > 0 ? dm / 10 : 0;
}

function pointInRingEN(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function openRingEN(ringLonLat) {
  const out = [];
  for (const p of ringLonLat || []) {
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
    out.push(lonLatToTm35(+p[0], +p[1]));
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

/** Cells inside the ring, in EN metres, with their laser height (h >= 2). */
function ringCells(ring) {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const p of ring) {
    if (p[0] < minE) minE = p[0];
    if (p[0] > maxE) maxE = p[0];
    if (p[1] < minN) minN = p[1];
    if (p[1] > maxN) maxN = p[1];
  }
  let c0 = Math.floor((minE - ORIGIN_E) / CELL_M);
  let c1 = Math.floor((maxE - ORIGIN_E) / CELL_M);
  let r0 = Math.floor((minN - ORIGIN_N) / CELL_M);
  let r1 = Math.floor((maxN - ORIGIN_N) / CELL_M);
  if (c1 < 0 || r1 < 0 || c0 >= COLS || r0 >= ROWS) return { cells: [], step: 1 };
  c0 = Math.max(0, c0);
  r0 = Math.max(0, r0);
  c1 = Math.min(COLS - 1, c1);
  r1 = Math.min(ROWS - 1, r1);
  let step = 1;
  const spanC = c1 - c0 + 1;
  const spanR = r1 - r0 + 1;
  while (Math.ceil(spanC / step) * Math.ceil(spanR / step) > MAX_CELL_TESTS) step += 1;
  const cells = [];
  for (let row = r0; row <= r1; row += step) {
    const north = ORIGIN_N + (row + 0.5) * CELL_M;
    for (let col = c0; col <= c1; col += step) {
      const h = cellMetres(col, row);
      if (!(h >= 2)) continue;
      const east = ORIGIN_E + (col + 0.5) * CELL_M;
      if (!pointInRingEN(east, north, ring)) continue;
      cells.push({ col, row, h });
    }
  }
  return { cells, step };
}

function percentile(vals, q) {
  if (!vals.length) return 0;
  const sorted = vals.slice().sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))];
}

function roundHeight(h) {
  const rounded = Math.round(h * 10) / 10;
  return rounded > 2 && rounded < 80 ? rounded : 0;
}

/**
 * 75th percentile of 2 m roof-minus-ground cells inside the ring (or q).
 * A mapped building:part is one mass (a tower, a drum, a wing), so it reads
 * the 90th percentile; 2 m cells on a small tower's edge land on the roof
 * below and pull the 75th down.
 * Fewer than 4 elevated cells is not a measured roof.
 * @returns {number} metres to 0.1, or 0
 */
function heightForRing(ringLonLat, q) {
  const ring = openRingEN(ringLonLat);
  if (ring.length < 3) return 0;
  const { cells } = ringCells(ring);
  if (cells.length < MIN_CELLS) return 0;
  return roundHeight(percentile(cells.map((c) => c.h), q > 0 ? q : 0.75));
}

/**
 * A tower, spire, dome drum, or belfry: a compact cluster of laser cells
 * that rises well above the rest of the same roof. Measured, never guessed.
 * The cluster has to be at least TIER_MIN_CELLS connected cells, at least
 * TIER_DELTA_M above the roof median, and under TIER_MAX_SHARE of the roof.
 * The lower roof then takes the 75th percentile of the cells outside the
 * cluster, so a dome no longer lifts the whole nave.
 */
const PART_Q = 0.9;
const TIER_DELTA_M = 5;
const TIER_MIN_CELLS = 3;
const TIER_MAX_SHARE = 0.4;
const TIER_MIN_ROOF_CELLS = 20;
const TIER_SPILL_SHARE = 0.5;
const TIER_ROUND_FILL = 0.88;

function tierForRing(ringLonLat) {
  const ring = openRingEN(ringLonLat);
  if (ring.length < 3) return null;
  const { cells, step } = ringCells(ring);
  if (step !== 1 || cells.length < TIER_MIN_ROOF_CELLS) return null;
  const median = percentile(cells.map((c) => c.h), 0.5);
  const cut = Math.max(median + TIER_DELTA_M, median * 1.3);
  const tall = new Map();
  for (const c of cells) if (c.h >= cut) tall.set(c.col + "," + c.row, c);
  if (tall.size < TIER_MIN_CELLS) return null;
  // Largest 8-connected cluster.
  const seen = new Set();
  let best = null;
  for (const [key, c] of tall) {
    if (seen.has(key)) continue;
    const comp = [];
    const stack = [c];
    seen.add(key);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          const k = cur.col + dc + "," + (cur.row + dr);
          if (seen.has(k) || !tall.has(k)) continue;
          seen.add(k);
          stack.push(tall.get(k));
        }
      }
    }
    if (!best || comp.length > best.length) best = comp;
  }
  if (!best || best.length < TIER_MIN_CELLS || best.length > cells.length * TIER_MAX_SHARE) return null;
  let c0 = Infinity;
  let c1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  for (const c of best) {
    if (c.col < c0) c0 = c.col;
    if (c.col > c1) c1 = c.col;
    if (c.row < r0) r0 = c.row;
    if (c.row > r1) r1 = c.row;
  }
  // A sparse box is a ridge line or two chimneys, not one mass.
  const boxCells = (c1 - c0 + 1) * (r1 - r0 + 1);
  if (best.length < boxCells * 0.5) return null;
  const inCluster = new Set(best.map((c) => c.col + "," + c.row));
  // A crown overhanging the roof keeps going past the wall. A tower stops
  // at its own walls. Count tall cells just outside the outline that touch
  // the cluster; as many as half the cluster is a tree, not a tower.
  const inRing = new Set(cells.map((c) => c.col + "," + c.row));
  const outside = new Set();
  for (const c of best) {
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -2; dr <= 2; dr++) {
        const col = c.col + dc;
        const row = c.row + dr;
        const k = col + "," + row;
        if (inRing.has(k) || outside.has(k)) continue;
        const east = ORIGIN_E + (col + 0.5) * CELL_M;
        const north = ORIGIN_N + (row + 0.5) * CELL_M;
        if (pointInRingEN(east, north, ring)) continue;
        if (cellMetres(col, row) >= cut) outside.add(k);
      }
    }
  }
  if (outside.size >= best.length * TIER_SPILL_SHARE) return null;
  const rest = cells.filter((c) => !inCluster.has(c.col + "," + c.row)).map((c) => c.h);
  const roof = roundHeight(percentile(rest, 0.75));
  const top = roundHeight(percentile(best.map((c) => c.h), 0.9));
  if (!(roof > 2) || !(top >= roof + TIER_DELTA_M)) return null;
  const e0 = ORIGIN_E + c0 * CELL_M;
  const e1 = ORIGIN_E + (c1 + 1) * CELL_M;
  const n0 = ORIGIN_N + r0 * CELL_M;
  const n1 = ORIGIN_N + (r1 + 1) * CELL_M;
  const toLL = enToLonLatNear(ringLonLat);
  if (!toLL) return null;
  const box = [
    [e0, n0],
    [e1, n0],
    [e1, n1],
    [e0, n1],
  ];
  // A round drum or a dome fills about pi/4 of its box. Chamfer the corners
  // to an octagon so the tier does not reach past the drum.
  let outline = box;
  const fill = best.length / boxCells;
  if (boxCells >= 9 && fill < TIER_ROUND_FILL) {
    const cw = (box[1][0] - box[0][0]) * 0.29;
    const ch = (box[2][1] - box[1][1]) * 0.29;
    const [x0, y0] = box[0];
    const [x1, y1] = box[2];
    outline = [
      [x0 + cw, y0],
      [x1 - cw, y0],
      [x1, y0 + ch],
      [x1, y1 - ch],
      [x1 - cw, y1],
      [x0 + cw, y1],
      [x0, y1 - ch],
      [x0, y0 + ch],
    ];
  }
  const ll = outline.map((p) => toLL(p[0], p[1]));
  ll.push(ll[0].slice());
  return { ring: ll, roof, top, cells: best.length };
}

/** Local affine EN -> lon/lat fitted on the ring itself (a few hundred metres at most). */
function enToLonLatNear(ringLonLat) {
  const pts = (ringLonLat || []).filter((p) => p && Number.isFinite(+p[0]) && Number.isFinite(+p[1]));
  if (pts.length < 3) return null;
  const lon0 = +pts[0][0];
  const lat0 = +pts[0][1];
  const [e0, n0] = lonLatToTm35(lon0, lat0);
  const d = 0.001;
  const [eA, nA] = lonLatToTm35(lon0 + d, lat0);
  const [eB, nB] = lonLatToTm35(lon0, lat0 + d);
  // [dE dN] = J [dLon dLat]
  const a = (eA - e0) / d;
  const b = (eB - e0) / d;
  const c = (nA - n0) / d;
  const dd = (nB - n0) / d;
  const det = a * dd - b * c;
  if (!(Math.abs(det) > 0)) return null;
  return (e, n) => {
    const de = e - e0;
    const dn = n - n0;
    return [lon0 + (dd * de - b * dn) / det, lat0 + (-c * de + a * dn) / det];
  };
}

function ringCentroidLL(ring) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const p of ring || []) {
    x += +p[0];
    y += +p[1];
    n++;
  }
  return n ? [x / n, y / n] : null;
}

function pointInRingLL(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Fill footprints that do not already have an overture / MS / FEMA height.
 * Mutates features. A roof with a measured tower gets the tower as its own
 * upper part (appended to `features`) unless a mapped building:part already
 * draws it. Returns how many received a laser height, and the range.
 */
function sampleNlsBuildingHeights(features) {
  let applied = 0;
  let min = 0;
  let max = 0;
  let tiers = 0;
  const list = features || [];
  const partRings = [];
  for (const f of list) {
    if (f && f.geometry && f.properties && f.properties.buildingPart) {
      for (const ring of exteriorRings(f.geometry)) partRings.push(ring);
    }
  }
  const added = [];
  for (const f of list) {
    if (!f || !f.geometry) continue;
    const props = f.properties || {};
    const src = props.heightSource || "";
    const had = featureHeight(f);
    if (had && (PROTECT_HEIGHT[src] || !src)) continue;
    let best = 0;
    let tier = null;
    for (const ring of exteriorRings(f.geometry)) {
      const h = heightForRing(ring, props.buildingPart ? PART_Q : 0);
      if (h > best) best = h;
      if (!props.buildingPart) {
        const t = tierForRing(ring);
        if (t && (!tier || t.top > tier.top)) tier = t;
      }
    }
    if (!(best > 2)) continue;
    if (tier) {
      const c = ringCentroidLL(tier.ring);
      let mapped = false;
      for (const pr of partRings) {
        const pc = ringCentroidLL(pr);
        if ((c && pointInRingLL(c, pr)) || (pc && pointInRingLL(pc, tier.ring))) {
          // a part that is only the whole roof again is not the tower
          if (featureAreaLL(pr) < featureAreaLL(exteriorRings(f.geometry)[0] || []) * 0.6) mapped = true;
        }
        if (mapped) break;
      }
      if (!mapped) {
        best = tier.roof;
        added.push({
          type: "Feature",
          properties: {
            geomSource: "nls-tier",
            buildingPart: true,
            height: tier.top,
            heightSource: HEIGHT_SOURCE,
          },
          geometry: { type: "Polygon", coordinates: [tier.ring] },
        });
        tiers++;
      }
    }
    if (!f.properties) f.properties = {};
    f.properties.height = best;
    f.properties.heightSource = HEIGHT_SOURCE;
    applied++;
    if (!min || best < min) min = best;
    if (best > max) max = best;
  }
  for (const t of added) list.push(t);
  return { applied, tiers, min: applied ? min : 0, max: applied ? max : 0, source: HEIGHT_SOURCE };
}

function featureAreaLL(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

/**
 * Laser heights are optional. A missing grid used to throw out of the export
 * and the gateway showed that as Export failed (502). Omit the heights instead.
 */
function applyNlsBuildingHeights(features) {
  try {
    return sampleNlsBuildingHeights(features);
  } catch (e) {
    return {
      applied: 0,
      min: 0,
      max: 0,
      source: HEIGHT_SOURCE,
      omitted: true,
      reason: e && e.message ? String(e.message) : "laser grid unavailable",
    };
  }
}

module.exports = {
  NLS_API_KEY_ENV,
  NLS_CREDIT,
  HEIGHT_SOURCE,
  ORIGIN_E,
  ORIGIN_N,
  CELL_M,
  COLS,
  ROWS,
  GRID_FILENAME,
  nlsApiKey,
  nlsGridPaths,
  setNlsGridPathForTests,
  lonLatToTm35,
  cellMetres,
  heightForRing,
  tierForRing,
  applyNlsBuildingHeights,
};
