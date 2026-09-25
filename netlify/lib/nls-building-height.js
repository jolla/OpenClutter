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

/**
 * 75th percentile of 2 m roof-minus-ground cells inside the ring.
 * Fewer than 4 elevated cells is not a measured roof.
 * @returns {number} metres to 0.1, or 0
 */
function heightForRing(ringLonLat) {
  const ring = openRingEN(ringLonLat);
  if (ring.length < 3) return 0;
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
  if (c1 < 0 || r1 < 0 || c0 >= COLS || r0 >= ROWS) return 0;
  c0 = Math.max(0, c0);
  r0 = Math.max(0, r0);
  c1 = Math.min(COLS - 1, c1);
  r1 = Math.min(ROWS - 1, r1);
  let step = 1;
  const spanC = c1 - c0 + 1;
  const spanR = r1 - r0 + 1;
  while (Math.ceil(spanC / step) * Math.ceil(spanR / step) > MAX_CELL_TESTS) step += 1;
  const vals = [];
  for (let row = r0; row <= r1; row += step) {
    const north = ORIGIN_N + (row + 0.5) * CELL_M;
    for (let col = c0; col <= c1; col += step) {
      const h = cellMetres(col, row);
      if (!(h >= 2)) continue;
      const east = ORIGIN_E + (col + 0.5) * CELL_M;
      if (!pointInRingEN(east, north, ring)) continue;
      vals.push(h);
    }
  }
  if (vals.length < MIN_CELLS) return 0;
  vals.sort((a, b) => a - b);
  const i = Math.floor(0.75 * (vals.length - 1));
  const rounded = Math.round(vals[i] * 10) / 10;
  return rounded > 2 && rounded < 80 ? rounded : 0;
}

/**
 * Fill footprints that do not already have an overture / MS / FEMA height.
 * Mutates features. Returns how many received a laser height, and the range.
 */
function sampleNlsBuildingHeights(features) {
  let applied = 0;
  let min = 0;
  let max = 0;
  for (const f of features || []) {
    if (!f || !f.geometry) continue;
    const props = f.properties || {};
    const src = props.heightSource || "";
    const had = featureHeight(f);
    if (had && (PROTECT_HEIGHT[src] || !src)) continue;
    let best = 0;
    for (const ring of exteriorRings(f.geometry)) {
      const h = heightForRing(ring);
      if (h > best) best = h;
    }
    if (!(best > 2)) continue;
    if (!f.properties) f.properties = {};
    f.properties.height = best;
    f.properties.heightSource = HEIGHT_SOURCE;
    applied++;
    if (!min || best < min) min = best;
    if (best > max) max = best;
  }
  return { applied, min: applied ? min : 0, max: applied ? max : 0, source: HEIGHT_SOURCE };
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
  applyNlsBuildingHeights,
};
