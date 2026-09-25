"use strict";

/**
 * USGS 3DEP bare-earth DEM → a HaminaClipboard JSON for Planner Plus paste.
 * OpenIntent has no raisedFloorZones / slopedFloors. Copy terrain is the paste
 * path. The same JSON is stored in the OpenIntent zip when 3DEP hits; Export
 * does not download it as a second file.
 *
 * Clipboard meters match hamina-clipboard.js: NE is (0, 0), SW is
 * (−widthM, −lengthM). z on sloped floors is meters above the lowest sample.
 * Flat ground stays a 2×2 pad. A mild rise uses a 4×3 lattice. Medium relief
 * under 20 m stays 6×5. Ski-hill relief (about 20 m or more, Granite Peak
 * scale) uses the export's terrain resolution. Auto is the default: cell size
 * follows the draw, about 1 m on a small hill and coarser on a large one, at
 * most 20×20, with a 3DEP count denser than that mesh. Default is ~80 m quads,
 * at most 12×12, from 144 samples. Fine is ~40 m, at most 16×16, from 324
 * samples. Finest is ~25 m, at most 20×20, from 576 samples. The sample grid
 * stays denser than the paste nodes so a finer mesh is not a stretched
 * 144-point surface. The paste cap is 20×20 quads.
 *
 * Hamina clipboard rings are open: the first vertex is not repeated.
 * raisedFloorZones are xy quads. slopedFloors are xyz quads whose first edge
 * is the low side and whose opposite edge is the high side (one z per edge).
 * A closed triangle has no opposite edges and repeats a vertex, which Planner
 * Plus rejects as "Sloped floor coordinates are not valid!".
 */

const { llToClipboard } = require("./geo-frame");
const { emptyClipboard } = require("./hamina-clipboard");

const DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const TERRAIN_FILENAME = "terrain-clipboard.json";
const FLAT_M = 0.5;
/**
 * Ski-hill paste presets. Auto is the default and sizes cells from the draw.
 * Default matches the v1.1.5 lattice. Fine and Finest are fixed manual
 * overrides. Only relief at or above LIFT_RELIEF_M changes. Flat, mild, and
 * medium ladders stay 2×2, 4×3, and 6×5. sampleCount is the 3DEP getSamples
 * request: a square count denser than the paste nodes so bilinear is not
 * stretching a sparse DEM. ABSOLUTE_MAX_GRID / ABSOLUTE_MAX_SAMPLES refuse
 * anything past the Hamina paste cap.
 */
const ABSOLUTE_MAX_GRID = 20;
const ABSOLUTE_MAX_SAMPLES = 625;
/** Auto will not paste cells smaller than this, even on a tiny hill. */
const MIN_CELL_M = 1;
const TERRAIN_RESOLUTIONS = {
  auto: { id: "auto", label: "Auto", cellM: null, maxGrid: ABSOLUTE_MAX_GRID, sampleCount: null },
  default: { id: "default", label: "Default", cellM: 80, maxGrid: 12, sampleCount: 144 },
  fine: { id: "fine", label: "Fine", cellM: 40, maxGrid: 16, sampleCount: 324 },
  finest: { id: "finest", label: "Finest", cellM: 25, maxGrid: 20, sampleCount: 576 },
};
const SAMPLE_COUNT = TERRAIN_RESOLUTIONS.default.sampleCount;
/** Quads per side on the default ski-hill lattice. Finest cannot pass ABSOLUTE_MAX_GRID. */
const MAX_GRID = TERRAIN_RESOLUTIONS.default.maxGrid;
const TARGET_CELL_M = TERRAIN_RESOLUTIONS.default.cellM;

function normalizeTerrainResolution(id) {
  const key = String(id == null ? "" : id).trim().toLowerCase();
  return TERRAIN_RESOLUTIONS[key] || TERRAIN_RESOLUTIONS.auto;
}

/**
 * Quads along one side for Auto on a ski hill. Fill the 20×20 paste budget,
 * but keep cells at least MIN_CELL_M. A span that can hold the historical
 * 6-quad floor at that size still does. A tinier span stays near 1 m instead
 * of inventing oversized cells to force 6×6.
 */
function autoAxisCount(spanM) {
  const span = spanM > 0 ? spanM : 800;
  const cellM = Math.max(MIN_CELL_M, span / ABSOLUTE_MAX_GRID);
  let n = Math.round(span / cellM);
  if (!Number.isFinite(n)) n = ABSOLUTE_MAX_GRID;
  n = Math.max(1, Math.min(ABSOLUTE_MAX_GRID, n));
  // Rounding onto the paste cap can land a hair under 1 m. Keep that quad.
  // A span that cannot hold the count at about 1 m steps down instead.
  while (n > 1 && span / n < MIN_CELL_M - 0.05) n -= 1;
  if (span >= 6 * MIN_CELL_M) n = Math.max(6, Math.min(ABSOLUTE_MAX_GRID, n));
  return n;
}

/** Square 3DEP count for Auto: denser than the paste nodes, never past the cap. */
function autoSampleCount(cols, rows) {
  const nodes = (cols + 1) * (rows + 1);
  const long = Math.max(cols | 0, rows | 0, 1);
  let side = long + 4;
  let count = side * side;
  if (count <= nodes) {
    side += 1;
    count = side * side;
  }
  return Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, count));
}

function sampleCountForResolution(resolution, frame) {
  const preset = normalizeTerrainResolution(resolution);
  if (preset.id !== "auto") {
    return Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, preset.sampleCount | 0));
  }
  const [cols, rows] = chooseGrid(LIFT_RELIEF_M, frame, "auto");
  return autoSampleCount(cols, rows);
}

function formatCellM(m) {
  const n = Number(m);
  if (!(n > 0)) return "1";
  const tenth = Math.round(n * 10) / 10;
  if (Math.abs(tenth - Math.round(tenth)) < 1e-6) return String(Math.round(tenth));
  return tenth.toFixed(1);
}

/**
 * Lift building bottoms only when the DEM rises this far above its lowest
 * sample. Oak Creek (~6 m), Long Meadow (~15 m), and the Las Vegas Sphere
 * box (~17 m) stay on the floor. Granite Peak (~200 m) lifts.
 */
const LIFT_RELIEF_M = 20;
/** Local ground under this is bottom height from floor ≈ 0 (field omitted). */
const LIFT_LOCAL_M = 1;

const RAISED_KEYS = ["area", "height", "attenuationDbPerMeter", "slabOnly"];
const SLOPED_KEYS = [
  "area",
  "attenuationDbPerMeter",
  "crowdEnabled",
  "drawStairs",
  "slabOnly",
  "crowdHeight",
  "crowdAttenuationDbPerMeter",
];

function idw(samples, lon, lat) {
  let wsum = 0;
  let zsum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dx = s.lon - lon;
    const dy = s.lat - lat;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-18) return s.z;
    const w = 1 / d2;
    wsum += w;
    zsum += s.z * w;
  }
  return wsum ? zsum / wsum : samples[0].z;
}

function coordKey(n) {
  return Math.round(n * 1e7) / 1e7;
}

/**
 * Bilinear on a 3DEP sample lattice when the points form a grid. Clamping to
 * the outer samples keeps the frame edge from extrapolating a reverse slope.
 * Scattered points fall back to IDW inside that same hull.
 */
function buildElevation(samples) {
  const lonMap = new Map();
  const latMap = new Map();
  for (let i = 0; i < samples.length; i++) {
    lonMap.set(coordKey(samples[i].lon), samples[i].lon);
    latMap.set(coordKey(samples[i].lat), samples[i].lat);
  }
  const lons = Array.from(lonMap.values()).sort((a, b) => a - b);
  const lats = Array.from(latMap.values()).sort((a, b) => a - b);
  const cells = lons.length * lats.length;
  let grid = null;
  if (lons.length >= 2 && lats.length >= 2 && samples.length >= cells * 0.9) {
    grid = new Map();
    for (let i = 0; i < samples.length; i++) {
      grid.set(coordKey(samples[i].lon) + "," + coordKey(samples[i].lat), samples[i].z);
    }
    for (let j = 0; j < lats.length; j++) {
      for (let i = 0; i < lons.length; i++) {
        const k = coordKey(lons[i]) + "," + coordKey(lats[j]);
        if (!grid.has(k)) grid.set(k, idw(samples, lons[i], lats[j]));
      }
    }
  }
  const bounds = {
    west: lons[0],
    east: lons[lons.length - 1],
    south: lats[0],
    north: lats[lats.length - 1],
  };
  return function elevationAt(lon, lat) {
    const x = Math.min(bounds.east, Math.max(bounds.west, lon));
    const y = Math.min(bounds.north, Math.max(bounds.south, lat));
    if (!grid) return idw(samples, x, y);
    let i = 0;
    while (i < lons.length - 2 && lons[i + 1] < x) i++;
    let j = 0;
    while (j < lats.length - 2 && lats[j + 1] < y) j++;
    const x0 = lons[i];
    const x1 = lons[Math.min(lons.length - 1, i + 1)];
    const y0 = lats[j];
    const y1 = lats[Math.min(lats.length - 1, j + 1)];
    const z00 = grid.get(coordKey(x0) + "," + coordKey(y0));
    const z10 = grid.get(coordKey(x1) + "," + coordKey(y0));
    const z01 = grid.get(coordKey(x0) + "," + coordKey(y1));
    const z11 = grid.get(coordKey(x1) + "," + coordKey(y1));
    const tx = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    const ty = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
    return z00 + (z10 - z00) * tx + (z01 - z00) * ty + (z00 - z10 - z01 + z11) * tx * ty;
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function sameXy(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Pasteable Hamina quad: exactly 4 corners, open ring, strictly convex, CCW
 * in clipboard meters (y north). Collinear, zero-area, and bowtie rings are
 * rejected — those are the degenerate facets a slope validator throws on.
 */
function pasteableQuad(ring) {
  if (!ring || ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    if (!p || p.some((v) => !Number.isFinite(v))) return false;
    if (sameXy(p, ring[(i + 1) % 4])) return false;
  }
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    const c = ring[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (!(cross > 1e-4)) return false;
  }
  return true;
}

function chooseGrid(relief, frame, resolution) {
  if (!(relief >= 1)) return [2, 2];
  if (relief < 8) return [4, 3];
  if (relief < LIFT_RELIEF_M) return [6, 5];
  const preset = normalizeTerrainResolution(resolution);
  const width = frame && frame.widthM > 0 ? frame.widthM : 800;
  const length = frame && frame.lengthM > 0 ? frame.lengthM : 800;
  if (preset.id === "auto") return [autoAxisCount(width), autoAxisCount(length)];
  const cellM = preset.cellM > 0 ? preset.cellM : TARGET_CELL_M;
  const cap = Math.max(6, Math.min(ABSOLUTE_MAX_GRID, preset.maxGrid | 0));
  let cols = Math.round(width / cellM);
  let rows = Math.round(length / cellM);
  cols = Math.max(6, Math.min(cap, cols));
  rows = Math.max(6, Math.min(cap, rows));
  return [cols, rows];
}

function lattice(samples, frame, cols, rows, elevationAt) {
  const nodes = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const lon = frame.west + (c / cols) * (frame.east - frame.west);
      const lat = frame.south + (r / rows) * (frame.north - frame.south);
      const z = elevationAt(lon, lat);
      const [x, y] = llToClipboard(lon, lat, frame);
      nodes.push({ x: round3(x), y: round3(y), z });
    }
  }
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const n of nodes) {
    if (n.z < minZ) minZ = n.z;
    if (n.z > maxZ) maxZ = n.z;
  }
  for (const n of nodes) n.zRel = round1(n.z - minZ);
  return { nodes, cols, rows, minZ, maxZ, relief: maxZ - minZ };
}

function at(grid, c, r) {
  return grid.nodes[r * (grid.cols + 1) + c];
}

function xy(n) {
  return [n.x, n.y];
}

function zoneArea(ring) {
  return { type: "Polygon", coordinates: [ring.map((p) => p.slice())] };
}

function raisedZone(sw, se, ne, nw, height) {
  const ring = [xy(sw), xy(se), xy(ne), xy(nw)];
  if (!pasteableQuad(ring)) return null;
  return {
    area: zoneArea(ring),
    height,
    attenuationDbPerMeter: 0,
    // false matches a Hamina-native paste: Planner Plus draws a solid floor.
    // true is the thin "slab only" sheet. Attenuation stays 0 either way.
    slabOnly: false,
  };
}

function xyzAt(n, z) {
  return [n.x, n.y, z];
}

function edgeRunM(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Rise over run. A zero-length edge is infinitely steep when it still rises. */
function riseOverRun(rise, run) {
  if (!(run > 0)) return rise > 0 ? Infinity : 0;
  return rise / run;
}

/**
 * One ramp per cell, along the steeper axis. Hamina stores a sloped floor as
 * a low edge (two vertices, one z) and the opposite high edge — not a triangle
 * and not an independent z on every corner.
 *
 * The axis is rise/run, not raw |Δz|:
 *   nsSlope = |zN − zS| / northSouthEdgeLengthM
 *   ewSlope = |zE − zW| / eastWestEdgeLengthM
 * A wide cell can rise more east-west and still be gentler than the short
 * north-south face. Equal slopes keep the north-south ramp (the same tie the
 * old |Δz| compare used on a square cell).
 *
 * Clipboard y increases north, so the low edge is walked with the cell
 * interior on the left. That is the one counterclockwise low-first order for
 * each grade. The other low-first order is clockwise, and pasteableQuad
 * rejects it (the cell would paste as a flat pad):
 *   south low, north high: sw, se, ne, nw
 *   north low, south high: ne, nw, sw, se
 *   west low, east high:   nw, sw, se, ne
 *   east low, west high:   se, ne, nw, sw
 */
function slopedRing(sw, se, ne, nw) {
  const zS = round1((sw.zRel + se.zRel) / 2);
  const zN = round1((nw.zRel + ne.zRel) / 2);
  const zW = round1((sw.zRel + nw.zRel) / 2);
  const zE = round1((se.zRel + ne.zRel) / 2);
  const northSouthEdgeLengthM = (edgeRunM(sw, nw) + edgeRunM(se, ne)) / 2;
  const eastWestEdgeLengthM = (edgeRunM(sw, se) + edgeRunM(nw, ne)) / 2;
  const nsSlope = riseOverRun(Math.abs(zN - zS), northSouthEdgeLengthM);
  const ewSlope = riseOverRun(Math.abs(zE - zW), eastWestEdgeLengthM);
  if (nsSlope >= ewSlope && zN !== zS) {
    return zS <= zN
      ? [xyzAt(sw, zS), xyzAt(se, zS), xyzAt(ne, zN), xyzAt(nw, zN)]
      : [xyzAt(ne, zN), xyzAt(nw, zN), xyzAt(sw, zS), xyzAt(se, zS)];
  }
  if (zE !== zW) {
    return zW <= zE
      ? [xyzAt(nw, zW), xyzAt(sw, zW), xyzAt(se, zE), xyzAt(ne, zE)]
      : [xyzAt(se, zE), xyzAt(ne, zE), xyzAt(nw, zW), xyzAt(sw, zW)];
  }
  return null;
}

function slopedZone(ring) {
  if (!pasteableQuad(ring)) return null;
  if (ring.some((p) => p.length !== 3)) return null;
  if (ring[0][2] !== ring[1][2] || ring[2][2] !== ring[3][2]) return null;
  if (!(ring[2][2] > ring[0][2])) return null;
  return {
    area: zoneArea(ring),
    attenuationDbPerMeter: 0,
    crowdEnabled: false,
    drawStairs: false,
    // Solid volume, same flag as the native sloped-floor paste. Open quads stay.
    slabOnly: false,
    crowdHeight: 0,
    crowdAttenuationDbPerMeter: 0,
  };
}

/**
 * @param {{lon:number,lat:number,z:number}[]} samples
 * @param {object} frame geo frame with west/south/east/north and meter scale
 * @param {{terrainResolution?: string}} [opts]
 */
function terrainFromSamples(samples, frame, opts) {
  const pts = (samples || []).filter(
    (s) => s && Number.isFinite(+s.lon) && Number.isFinite(+s.lat) && Number.isFinite(+s.z)
  );
  if (pts.length < 4 || !frame) return null;
  const clean = pts.map((s) => ({ lon: +s.lon, lat: +s.lat, z: +s.z }));
  let minS = Infinity;
  let maxS = -Infinity;
  for (const s of clean) {
    if (s.z < minS) minS = s.z;
    if (s.z > maxS) maxS = s.z;
  }
  const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
  const reliefM = maxS - minS;
  const [cols, rows] = chooseGrid(reliefM, frame, preset.id);
  const widthM = frame && frame.widthM > 0 ? frame.widthM : 800;
  const lengthM = frame && frame.lengthM > 0 ? frame.lengthM : 800;
  const cellM =
    preset.id === "auto" && reliefM >= LIFT_RELIEF_M
      ? (widthM / cols + lengthM / rows) / 2
      : preset.cellM;
  const elevationAt = buildElevation(clean);
  const grid = lattice(clean, frame, cols, rows, elevationAt);
  const raised = [];
  const sloped = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sw = at(grid, c, r);
      const se = at(grid, c + 1, r);
      const ne = at(grid, c + 1, r + 1);
      const nw = at(grid, c, r + 1);
      const zs = [sw.zRel, se.zRel, ne.zRel, nw.zRel];
      const z0 = Math.min(...zs);
      const z1 = Math.max(...zs);
      const height = round1((z0 + z1) / 2);
      if (z1 - z0 < FLAT_M) {
        const pad = raisedZone(sw, se, ne, nw, height);
        if (pad) raised.push(pad);
      } else {
        const ramp = slopedZone(slopedRing(sw, se, ne, nw));
        if (ramp) sloped.push(ramp);
        else {
          const pad = raisedZone(sw, se, ne, nw, height);
          if (pad) raised.push(pad);
        }
      }
    }
  }
  if (!raised.length && !sloped.length) return null;
  const clip = emptyClipboard();
  clip.raisedFloorZones = raised;
  clip.slopedFloors = sloped;
  clip.attenuatingZones = [];
  return {
    clipboard: clip,
    raised: raised.length,
    sloped: sloped.length,
    reliefM: Math.round((maxS - minS) * 10) / 10,
    minZ: Math.round(minS * 10) / 10,
    maxZ: Math.round(maxS * 10) / 10,
    terrainResolution: preset.id,
    cellM,
    gridCols: cols,
    gridRows: rows,
    // z = 0 on sloped floors is the lowest lattice node, not the raw sample min.
    datumZ: grid.minZ,
    samples: clean,
    elevationAt,
  };
}

/** Meters above the terrain clipboard's z = 0. Same datum as sloped-floor z. */
function terrainGroundM(terrain, lon, lat) {
  if (!terrain || !Number.isFinite(terrain.datumZ)) return 0;
  const z = terrain.elevationAt ? terrain.elevationAt(+lon, +lat) : terrain.samples ? idw(terrain.samples, +lon, +lat) : NaN;
  if (!Number.isFinite(z)) return 0;
  return Math.max(0, round1(z - terrain.datumZ));
}

/**
 * Top of the slope under a lon/lat ring: the highest DEM sample on the
 * vertices and the centroid, in terrain-clipboard meters.
 */
function slopeTopUnderRing(terrain, ring) {
  if (!terrain || !ring || ring.length < 3) return 0;
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const end = closed ? ring.length - 1 : ring.length;
  let max = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < end; i++) {
    const z = terrainGroundM(terrain, ring[i][0], ring[i][1]);
    if (z > max) max = z;
    sx += +ring[i][0];
    sy += +ring[i][1];
  }
  if (end > 0) {
    const zc = terrainGroundM(terrain, sx / end, sy / end);
    if (zc > max) max = zc;
  }
  return max;
}

/** True when this export's terrain clipboard is a ski-hill-scale DEM. */
function siteWarrantsLift(terrain) {
  if (!terrain || !(terrain.reliefM >= LIFT_RELIEF_M)) return false;
  return (terrain.raised || 0) + (terrain.sloped || 0) > 0;
}

/**
 * Bundle fields for the export API. The OpenIntent zip stays the only download.
 * terrainClipboard is the in-memory Planner Plus paste for Copy terrain.
 * terrainFilename names that JSON inside the zip, or both are null when 3DEP misses.
 */
function terrainBundleFields(terrain, warnings) {
  const ready = !!(
    terrain &&
    terrain.clipboard &&
    ((terrain.raised || 0) > 0 || (terrain.sloped || 0) > 0)
  );
  if (ready) {
    const preset = normalizeTerrainResolution(terrain.terrainResolution);
    let mesh = "";
    if (terrain.reliefM >= LIFT_RELIEF_M) {
      const shown = preset.id === "auto" && terrain.cellM > 0 ? terrain.cellM : preset.cellM;
      mesh = ", " + preset.label + " ~" + formatCellM(shown) + " m";
    } else if (preset.id !== "default") {
      mesh = ", " + preset.label + " (relief under 20 m keeps the coarse mesh)";
    }
    return {
      terrainFilename: TERRAIN_FILENAME,
      terrainClipboard: terrain.clipboard,
      terrainStatus:
        "Terrain ready (" +
        terrain.raised +
        " raised, " +
        terrain.sloped +
        " sloped" +
        mesh +
        "). Use Copy terrain and paste it in Planner Plus. Do not import it as OpenIntent.",
    };
  }
  const omitted = (warnings || []).map(String).find((w) => /terrain omitted/i.test(w));
  const why = omitted || "Terrain omitted: USGS 3DEP did not return a usable grid";
  const tail = /openintent zip is unchanged/i.test(why) ? "" : " OpenIntent zip is unchanged.";
  return {
    terrainFilename: null,
    terrainClipboard: null,
    terrainStatus: why.replace(/\.\s*$/, "") + "." + tail,
  };
}

function noteMissingTerrain(terrain, warnings) {
  const ready = !!(terrain && ((terrain.raised || 0) > 0 || (terrain.sloped || 0) > 0));
  if (ready) return;
  if ((warnings || []).some((w) => /terrain omitted/i.test(String(w)))) return;
  warnings.push("Terrain omitted: USGS 3DEP did not return a usable grid");
}

function parseDemSamples(body) {
  const samples = body && Array.isArray(body.samples) ? body.samples : [];
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const row = samples[i];
    const loc = row && row.location;
    const z = Number(row && row.value);
    const lon = loc && +loc.x;
    const lat = loc && +loc.y;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(z)) continue;
    if (z < -500 || z > 9000) continue;
    out.push({ lon, lat, z });
  }
  return out;
}

async function fetchDemSamples(frame, fetchFn, opts) {
  const fetchImpl = fetchFn || fetch;
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
  const sampleCount = sampleCountForResolution(opts && opts.terrainResolution, frame);
  const geometry = JSON.stringify({
    xmin: +frame.west,
    ymin: +frame.south,
    xmax: +frame.east,
    ymax: +frame.north,
    spatialReference: { wkid: 4326 },
  });
  const url =
    DEM_URL +
    "?" +
    new URLSearchParams({
      geometry,
      geometryType: "esriGeometryEnvelope",
      sampleCount: String(sampleCount),
      interpolation: "RSP_BilinearInterpolation",
      f: "json",
    });
  const res = await fetchImpl(url, { signal });
  if (!res || res.ok === false) throw new Error("3DEP HTTP " + (res && res.status));
  const body = await res.json();
  if (body && body.error) throw new Error("3DEP " + (body.error.message || "query"));
  return parseDemSamples(body);
}

module.exports = {
  DEM_URL,
  TERRAIN_FILENAME,
  FLAT_M,
  SAMPLE_COUNT,
  MAX_GRID,
  TARGET_CELL_M,
  TERRAIN_RESOLUTIONS,
  ABSOLUTE_MAX_GRID,
  ABSOLUTE_MAX_SAMPLES,
  MIN_CELL_M,
  LIFT_RELIEF_M,
  LIFT_LOCAL_M,
  RAISED_KEYS,
  SLOPED_KEYS,
  terrainFromSamples,
  pasteableQuad,
  slopedRing,
  terrainGroundM,
  slopeTopUnderRing,
  siteWarrantsLift,
  terrainBundleFields,
  noteMissingTerrain,
  parseDemSamples,
  fetchDemSamples,
  chooseGrid,
  normalizeTerrainResolution,
  sampleCountForResolution,
  formatCellM,
  autoAxisCount,
};
