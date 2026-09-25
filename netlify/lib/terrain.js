"use strict";

/**
 * USGS 3DEP bare-earth DEM → a HaminaClipboard JSON for Planner Plus paste.
 * On the dev host, fetchTerrainDem tries Copernicus DEM GLO-30 when 3DEP
 * returns no usable grid. A frame outside 3DEP coverage (Finland and the
 * rest of Europe) only probes 3DEP briefly, with a tiny sample count, so
 * the rest of the DEM budget can finish a GLO-30 grid — coarser when little
 * time is left. The handler can skip that probe on a follow-up read and pass
 * budgetMs for the slice still left after the aerial. GLO-30 is a surface DSM.
 * kind "surface" does not use the bare-earth 20 m ski-hill gate. Attenuating objects still take bottom
 * height from the DEM under the footprint. Production callers leave that
 * fallback off and never call GLO-30. A US 3DEP hit is still preferred.
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
 * samples. Finest is ~25 m, at most 20×20, from 576 samples. Stops at 20, 15,
 * 10, 5, and 1 m may paste past that 20×20 expectation so a large hill can
 * keep the cell size. A mesh that will not fit beside the zip in one response
 * is coarsened until Copy terrain still returns with the download, and that
 * reduction is named in the export status. If it still cannot, the paste is
 * left out and the zip still returns. DEM samples for those stops step down
 * when the budget is short.
 *
 * Hamina clipboard rings are open: the first vertex is not repeated.
 * raisedFloorZones are xy quads. slopedFloors are xyz quads whose first edge
 * is the low side and whose opposite edge is the high side (one z per edge).
 * A closed triangle has no opposite edges and repeats a vertex, which Planner
 * Plus rejects as "Sloped floor coordinates are not valid!".
 */

const { llToClipboard } = require("./geo-frame");
const { emptyClipboard } = require("./hamina-clipboard");
const { fetchCopernicusDemSamples, GLO30_CREDIT } = require("./copernicus-dem");

const DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const USGS_3DEP_ATTRIBUTION = "USGS 3DEP";
const TERRAIN_FILENAME = "terrain-clipboard.json";
const FLAT_M = 0.5;
/**
 * Ski-hill paste presets. Auto is the default and sizes cells from the draw.
 * Default matches the v1.1.5 lattice. Fine and Finest are fixed manual
 * overrides. Only relief at or above LIFT_RELIEF_M changes. Flat, mild, and
 * medium ladders stay 2×2, 4×3, and 6×5. sampleCount is the 3DEP getSamples
 * request: a square count denser than the paste nodes so bilinear is not
 * stretching a sparse DEM. Auto, Default, Fine, and Finest stay inside the
 * older Hamina paste size (PASTE_SOFT_GRID). Experimental stops may pass it,
 * up to ABSOLUTE_MAX_GRID. ABSOLUTE_MAX_SAMPLES is the DEM read ceiling;
 * the old ceiling was 625.
 */
/** Older Hamina clipboard size. Auto and the named manuals stay inside it. */
const PASTE_SOFT_GRID = 20;
/**
 * Quads on one side for a 2.5 km draw at 5 m (the export span limit).
 * A 1 m mesh on that draw is coarser than 1 m so the paste still fits.
 */
const ABSOLUTE_MAX_GRID = 500;
/** DEM samples. 625 was the old hard ceiling (Finest uses 576). */
const ABSOLUTE_MAX_SAMPLES = 2500;
/**
 * Lambda rejects a synchronous response above 6 MiB. The runtime error cites
 * 6291556 bytes. A decimal reading of "6 MB" is 6000000. Crossing either one
 * is a gateway 502 with an empty body, which the page shows as Export failed
 * (502). Stay under both.
 */
const LAMBDA_SYNC_PAYLOAD_MAX = 6 * 1024 * 1024;
const EXPORT_PAYLOAD_BUDGET = 5800000;
/**
 * Bundle keys, frame, stats, and warnings, plus slack so the estimate is
 * not tighter than JSON.stringify of the function return.
 */
const BUNDLE_ENVELOPE_BYTES = 64 * 1024;
/**
 * One clipboard byte is stored in the zip (then base64'd by 4/3) and repeated
 * in the bundle body. Lambda JSON-encodes that body, so each quote grows by a
 * byte. Sloped quads are about 7.5% quotes; 1.08 leaves a little slack.
 */
const PASTE_RESPONSE_BYTE_COST = 4 / 3 + 1.08;

/**
 * Clipboard JSON bytes that can sit beside the rest of the zip without
 * pushing the synchronous response over EXPORT_PAYLOAD_BUDGET.
 * companionZipBytes is the zip with the terrain member removed.
 */
function maxPasteJsonForCompanion(companionZipBytes, extraBodyBytes) {
  const other = Math.max(0, companionZipBytes | 0);
  const extra =
    extraBodyBytes != null && extraBodyBytes !== "" && Number.isFinite(+extraBodyBytes)
      ? Math.max(0, +extraBodyBytes)
      : BUNDLE_ENVELOPE_BYTES;
  const b64Other = 4 * Math.ceil(other / 3);
  const room = EXPORT_PAYLOAD_BUDGET - b64Other - extra;
  if (!(room > 0)) return 0;
  return Math.max(0, Math.floor(room / PASTE_RESPONSE_BYTE_COST));
}

/**
 * Largest clipboard that still fits beside a small aerial (~200 KB). The
 * handler passes a tighter pasteJsonMax when the real zip is heavier.
 * A mesh past this is coarsened. The handler drops the paste only when even
 * that smaller grid cannot ride along with the zip.
 */
const TERRAIN_PASTE_JSON_MAX = maxPasteJsonForCompanion(200 * 1024);
/**
 * Do not allocate a lattice denser than this. The byte check is the hard
 * response budget; this only stops a 200×200 request from being built first.
 */
const PASTE_BUILD_MAX_QUADS = 12000;

function pasteJsonCeiling(opts) {
  if (opts && opts.pasteJsonMax != null && opts.pasteJsonMax !== "" && Number.isFinite(+opts.pasteJsonMax)) {
    return Math.max(0, Math.floor(+opts.pasteJsonMax));
  }
  return TERRAIN_PASTE_JSON_MAX;
}

/** Estimated Lambda payload for a bundle that repeats clipboardJson beside the zip. */
function estimateBundlePayload(zipLength, clipboardJson) {
  const b64 = 4 * Math.ceil(Math.max(0, zipLength | 0) / 3);
  let quotes = 0;
  const clip = clipboardJson || "";
  for (let i = 0; i < clip.length; i++) {
    const c = clip.charCodeAt(i);
    if (c === 34 || c === 92) quotes++;
  }
  return b64 + clip.length + quotes + BUNDLE_ENVELOPE_BYTES;
}

/** Bytes Lambda counts: JSON.stringify of the function's return value. */
function lambdaPayloadBytes(handlerResult) {
  if (!handlerResult) return 0;
  return Buffer.byteLength(JSON.stringify(handlerResult), "utf8");
}
/** Auto will not paste cells smaller than this, even on a tiny hill. */
const MIN_CELL_M = 1;
const TERRAIN_RESOLUTIONS = {
  auto: { id: "auto", label: "Auto", cellM: null, maxGrid: PASTE_SOFT_GRID, sampleCount: null },
  default: { id: "default", label: "Default", cellM: 80, maxGrid: 12, sampleCount: 144 },
  fine: { id: "fine", label: "Fine", cellM: 40, maxGrid: 16, sampleCount: 324 },
  finest: { id: "finest", label: "Finest", cellM: 25, maxGrid: 20, sampleCount: 576 },
  // maxGrid fills a 2.5 km side at that cell size. 1 m shares the hard cap.
  "20": { id: "20", label: "20 m", cellM: 20, maxGrid: 125, sampleCount: null, experimental: true },
  "15": { id: "15", label: "15 m", cellM: 15, maxGrid: 167, sampleCount: null, experimental: true },
  "10": { id: "10", label: "10 m", cellM: 10, maxGrid: 250, sampleCount: null, experimental: true },
  "5": { id: "5", label: "5 m", cellM: 5, maxGrid: 500, sampleCount: null, experimental: true },
  "1": { id: "1", label: "1 m", cellM: 1, maxGrid: 500, sampleCount: null, experimental: true },
};
const SAMPLE_COUNT = TERRAIN_RESOLUTIONS.default.sampleCount;
/** Quads per side on the default ski-hill lattice. */
const MAX_GRID = TERRAIN_RESOLUTIONS.default.maxGrid;
const TARGET_CELL_M = TERRAIN_RESOLUTIONS.default.cellM;

function normalizeTerrainResolution(id) {
  let key = String(id == null ? "" : id)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (key.endsWith("m") && TERRAIN_RESOLUTIONS[key.slice(0, -1)]) key = key.slice(0, -1);
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
  const cellM = Math.max(MIN_CELL_M, span / PASTE_SOFT_GRID);
  let n = Math.round(span / cellM);
  if (!Number.isFinite(n)) n = PASTE_SOFT_GRID;
  n = Math.max(1, Math.min(PASTE_SOFT_GRID, n));
  // Rounding onto the paste cap can land a hair under 1 m. Keep that quad.
  // A span that cannot hold the count at about 1 m steps down instead.
  while (n > 1 && span / n < MIN_CELL_M - 0.05) n -= 1;
  if (span >= 6 * MIN_CELL_M) n = Math.max(6, Math.min(PASTE_SOFT_GRID, n));
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

/** Square DEM count for an experimental paste: denser than the nodes, never past the ceiling. */
function experimentalSampleCount(cols, rows) {
  const long = Math.max(cols | 0, rows | 0, 1);
  const sideCap = Math.floor(Math.sqrt(ABSOLUTE_MAX_SAMPLES));
  const side = Math.max(2, Math.min(sideCap, long + 4));
  return Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, side * side));
}

function sampleCountForResolution(resolution, frame) {
  const preset = normalizeTerrainResolution(resolution);
  if (preset.experimental) {
    const [cols, rows] = chooseGrid(LIFT_RELIEF_M, frame, preset.id);
    return experimentalSampleCount(cols, rows);
  }
  if (preset.id !== "auto") {
    return Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, preset.sampleCount | 0));
  }
  const [cols, rows] = chooseGrid(LIFT_RELIEF_M, frame, "auto");
  return autoSampleCount(cols, rows);
}

/** True when the frame center can get a USGS 3DEP grid. */
function frameHas3dep(frame) {
  if (!frame) return false;
  const lon = (+frame.west + +frame.east) / 2;
  const lat = (+frame.south + +frame.north) / 2;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  for (let i = 0; i < DEP3_COVERAGE.length; i++) {
    const box = DEP3_COVERAGE[i];
    if (lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north) return true;
  }
  return false;
}

function demSampleCount(opts, frame) {
  if (opts && Number.isFinite(+opts.sampleCount) && +opts.sampleCount > 0) {
    return Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, opts.sampleCount | 0));
  }
  const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
  const requested = sampleCountForResolution(preset.id, frame);
  if (!preset.experimental) return requested;
  return glo30SamplePlan(requested, demRemainingMs(opts)).sampleCount;
}

/** Milliseconds left for the DEM read. budgetMs wins over a deadline. */
function demRemainingMs(opts) {
  if (!opts) return null;
  if (opts.budgetMs != null && opts.budgetMs !== "" && Number.isFinite(+opts.budgetMs)) {
    return Math.max(0, +opts.budgetMs);
  }
  if (opts.deadlineMs != null && Number.isFinite(+opts.deadlineMs)) {
    return Math.max(0, +opts.deadlineMs - Date.now());
  }
  return null;
}

/**
 * Square GLO-30 lattice that can finish in the time left. Unknown time keeps
 * the requested count. A short budget steps down to a 4×4 grid rather than
 * asking for a 24×24 read that will be aborted empty.
 */
function glo30SamplePlan(requested, remainingMs) {
  const want = Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, requested | 0 || SAMPLE_COUNT));
  let cap = ABSOLUTE_MAX_SAMPLES;
  let maxRasterSide = 128;
  if (remainingMs != null && Number.isFinite(+remainingMs)) {
    const ms = Math.max(0, +remainingMs);
    if (ms >= 6000) {
      cap = ABSOLUTE_MAX_SAMPLES;
      maxRasterSide = 128;
    } else if (ms >= 3500) {
      cap = 144;
      maxRasterSide = 96;
      // Requests above the old 625 ceiling (the sub-25 m stops) keep a
      // denser lattice when a few seconds remain. Counts at or under 625
      // stay on the 144 cap so a short Finland read does not grow.
      if (ms >= 4500 && want > 625) {
        cap = 1024;
        maxRasterSide = 128;
      }
    } else if (ms >= 1800) {
      cap = 64;
      maxRasterSide = 64;
    } else {
      cap = 16;
      maxRasterSide = 48;
    }
  }
  let side = Math.round(Math.sqrt(Math.min(want, cap)));
  if (!Number.isFinite(side) || side < 2) side = 2;
  let count = side * side;
  if (count > cap || count > want) {
    side = Math.max(2, Math.floor(Math.sqrt(Math.min(want, cap))));
    count = side * side;
  }
  return { sampleCount: Math.max(4, count), maxRasterSide };
}

/** Child abort. Does not abort the parent. The timer is cleared by done(). */
function linkAbort(parent, ms) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  let timer = null;
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  if (ms > 0) timer = setTimeout(abort, ms);
  return {
    signal: ctrl.signal,
    done() {
      if (timer) clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", abort);
    },
  };
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
/**
 * USGS 3DEP Elevation ImageServer has data here. A center outside every box
 * cannot succeed, so the dev host must not spend the DEM budget on it.
 * The rectangle includes some border water; a US hit is still preferred.
 */
const DEP3_COVERAGE = [
  { west: -125.5, south: 24.0, east: -66.0, north: 49.6 },
  { west: -170.0, south: 51.0, east: -129.0, north: 71.6 },
  { west: -160.3, south: 18.8, east: -154.7, north: 22.3 },
  { west: -67.5, south: 17.6, east: -64.5, north: 18.6 },
  { west: 144.6, south: 13.2, east: 145.0, north: 13.7 },
  { west: -170.9, south: -14.4, east: -169.4, north: -14.2 },
];
/** Outside coverage, give 3DEP this long, then read GLO-30. */
const DEP3_OUTSIDE_MS = 400;
/** Probe count. A 576-point getSamples is what makes an out-of-coverage miss slow. */
const DEP3_PROBE_SAMPLES = 4;

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

/**
 * Largest cols×rows at most wantCols×wantRows whose product is <= maxQuads,
 * close to the requested aspect. The request is returned unchanged when it
 * already fits. One extra quad on either axis would pass the cap or the
 * request.
 */
function fitPasteAxes(wantCols, wantRows, maxQuads) {
  const wantC = Math.max(1, wantCols | 0);
  const wantR = Math.max(1, wantRows | 0);
  const cap = Math.max(1, maxQuads | 0);
  if (wantC * wantR <= cap) return [wantC, wantR];
  const aspect = wantC / wantR;
  const scale = Math.sqrt(cap / (wantC * wantR));
  let cols = Math.max(1, Math.min(wantC, Math.floor(wantC * scale)));
  let rows = Math.max(1, Math.min(wantR, Math.floor(wantR * scale)));
  while (true) {
    const canC = cols < wantC && (cols + 1) * rows <= cap;
    const canR = rows < wantR && cols * (rows + 1) <= cap;
    if (!canC && !canR) break;
    if (canC && canR) {
      const errC = Math.abs((cols + 1) / rows - aspect);
      const errR = Math.abs(cols / (rows + 1) - aspect);
      if (errC <= errR) cols += 1;
      else rows += 1;
    } else if (canC) cols += 1;
    else rows += 1;
  }
  return [cols, rows];
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
  const hard = preset.experimental ? ABSOLUTE_MAX_GRID : PASTE_SOFT_GRID;
  const cap = Math.max(6, Math.min(hard, preset.maxGrid | 0));
  let cols = Math.round(width / cellM);
  let rows = Math.round(length / cellM);
  cols = Math.max(6, Math.min(cap, cols));
  rows = Math.max(6, Math.min(cap, rows));
  return [cols, rows];
}

function pasteReducedNote(terrain) {
  const preset = normalizeTerrainResolution(terrain.terrainResolution);
  let cells = "";
  if (preset.cellM > 0 && terrain.cellM > preset.cellM + 0.5) {
    cells =
      " (about " +
      formatCellM(terrain.cellM) +
      " m cells, not " +
      formatCellM(preset.cellM) +
      " m)";
  }
  return (
    "Terrain paste reduced from " +
    (terrain.requestedGridCols | 0) +
    "×" +
    (terrain.requestedGridRows | 0) +
    " to " +
    (terrain.gridCols | 0) +
    "×" +
    (terrain.gridRows | 0) +
    " quads" +
    cells +
    " so it fits in the export response. OpenIntent zip is unchanged."
  );
}

/**
 * Notes for export-warnings when an experimental stop passes the old 20×20
 * paste, coarsens because of the mesh cap, or is reduced to fit the response.
 */
function terrainResolutionNotes(terrain, frame) {
  const notes = [];
  if (!terrain) return notes;
  const preset = normalizeTerrainResolution(terrain.terrainResolution);
  if (!preset.experimental) return notes;
  if (!(terrain.reliefM >= LIFT_RELIEF_M)) return notes;
  const cols = terrain.gridCols | 0;
  const rows = terrain.gridRows | 0;
  const width = frame && frame.widthM > 0 ? frame.widthM : 0;
  const length = frame && frame.lengthM > 0 ? frame.lengthM : 0;
  const reqC = terrain.requestedGridCols > 0 ? terrain.requestedGridCols | 0 : cols;
  const reqR = terrain.requestedGridRows > 0 ? terrain.requestedGridRows | 0 : rows;
  if (preset.cellM > 0 && width > 0 && length > 0) {
    const wantC = Math.max(6, Math.round(width / preset.cellM));
    const wantR = Math.max(6, Math.round(length / preset.cellM));
    if (wantC > reqC || wantR > reqR) {
      const cover = Math.round((preset.maxGrid > 0 ? preset.maxGrid : reqC) * preset.cellM);
      let tail = " The paste covers the whole draw at the cap instead of hanging.";
      if (reqC !== cols || reqR !== rows) {
        tail = " The export response then coarsens that mesh further. The paste still covers the whole draw.";
      }
      notes.push(
        "Terrain cell size is about " +
          formatCellM(terrain.cellM) +
          " m, not " +
          formatCellM(preset.cellM) +
          " m: this draw wants " +
          wantC +
          "×" +
          wantR +
          " quads and the mesh cap is " +
          preset.maxGrid +
          ". At " +
          formatCellM(preset.cellM) +
          " m that cap covers about " +
          cover +
          "×" +
          cover +
          " m." +
          tail
      );
    }
  }
  if (terrain.pasteOmitted) {
    notes.push(
      "Terrain paste omitted: " +
        cols +
        "×" +
        rows +
        " quads will not fit in the export response. Hamina's older paste expectation is about 20×20. The OpenIntent zip still exported."
    );
    return notes;
  }
  if (terrain.pasteReduced) notes.push(pasteReducedNote(terrain));
  if (cols > PASTE_SOFT_GRID || rows > PASTE_SOFT_GRID) {
    notes.push(
      "Terrain paste is " +
        cols +
        "×" +
        rows +
        " quads, past the 20×20 Hamina clipboard expectation. Planner Plus may reject it."
    );
  }
  return notes;
}

/** When the DEM lattice is coarser than an experimental paste, say so. */
function demDensityNote(preset, frame, sampleCount) {
  if (!preset || !preset.experimental) return null;
  const count = sampleCount | 0;
  if (!(count > 0) || !frame) return null;
  let [cols, rows] = chooseGrid(LIFT_RELIEF_M, frame, preset.id);
  if (preset.experimental) {
    const fitted = fitPasteAxes(cols, rows, PASTE_BUILD_MAX_QUADS);
    cols = fitted[0];
    rows = fitted[1];
  }
  const nodes = (cols + 1) * (rows + 1);
  if (count >= nodes) return null;
  return (
    "DEM samples stepped down to " +
    count +
    " for a " +
    cols +
    "×" +
    rows +
    " paste so the read can finish. Elevations between samples are interpolated."
  );
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

function buildTerrainClipboard(samples, frame, cols, rows, elevationAt) {
  const grid = lattice(samples, frame, cols, rows, elevationAt);
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
  return { grid, clip, raised: raised.length, sloped: sloped.length };
}

/**
 * @param {{lon:number,lat:number,z:number}[]} samples
 * @param {object} frame geo frame with west/south/east/north and meter scale
 * @param {{terrainResolution?: string, kind?: string, attribution?: string}} [opts]
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
  let [cols, rows] = chooseGrid(reliefM, frame, preset.id);
  const requestedCols = cols;
  const requestedRows = rows;
  const skiExperimental = !!(preset.experimental && reliefM >= LIFT_RELIEF_M);
  const widthM = frame && frame.widthM > 0 ? frame.widthM : 800;
  const lengthM = frame && frame.lengthM > 0 ? frame.lengthM : 800;
  const kind = opts && opts.kind === "surface" ? "surface" : "bare-earth";
  const attribution =
    (opts && opts.attribution) || (kind === "surface" ? GLO30_CREDIT : USGS_3DEP_ATTRIBUTION);
  const elevationAt = buildElevation(clean);
  const jsonMax = pasteJsonCeiling(opts);
  // A zero ceiling means the zip already fills the response. Skip the lattice.
  if (skiExperimental && jsonMax <= 0 && cols * rows > PASTE_SOFT_GRID * PASTE_SOFT_GRID) {
    return omittedPaste({
      clean,
      frame,
      preset,
      reliefM,
      minS,
      maxS,
      cols,
      rows,
      elevationAt,
      kind,
      attribution,
      mesh: null,
      requestedCols,
      requestedRows,
    });
  }
  // Plan under the allocation cap and under a rough bytes-per-quad reading of
  // the JSON ceiling so a 200×200 request is never built. A tight ceiling may
  // land coarser than 20×20. The byte loop below still confirms the clipboard.
  if (skiExperimental && jsonMax > 0) {
    const rough = Math.max(1, Math.floor(jsonMax / 240));
    const cap = Math.min(PASTE_BUILD_MAX_QUADS, rough);
    if (cols * rows > cap) {
      const fitted = fitPasteAxes(cols, rows, cap);
      cols = fitted[0];
      rows = fitted[1];
    }
  }
  let mesh = buildTerrainClipboard(clean, frame, cols, rows, elevationAt);
  if (!mesh) return null;
  function omitFields() {
    return {
      clean,
      frame,
      preset,
      reliefM,
      minS,
      maxS,
      cols,
      rows,
      elevationAt,
      kind,
      attribution,
      mesh,
      requestedCols,
      requestedRows,
    };
  }
  if (skiExperimental) {
    let guard = 0;
    let jsonLen = JSON.stringify(mesh.clip).length;
    while (jsonLen > jsonMax) {
      if (guard >= 8 || !(jsonMax > 0)) {
        return omittedPaste(omitFields());
      }
      const ratio = jsonMax / jsonLen;
      let nextMax = Math.floor(cols * rows * ratio * 0.98);
      if (!(nextMax < cols * rows)) nextMax = cols * rows - 1;
      const fitted = fitPasteAxes(cols, rows, Math.max(1, nextMax));
      if (fitted[0] === cols && fitted[1] === rows) {
        return omittedPaste(omitFields());
      }
      cols = fitted[0];
      rows = fitted[1];
      mesh = buildTerrainClipboard(clean, frame, cols, rows, elevationAt);
      if (!mesh) return null;
      jsonLen = JSON.stringify(mesh.clip).length;
      guard += 1;
    }
  }
  const cellM =
    (preset.id === "auto" || preset.experimental) && reliefM >= LIFT_RELIEF_M
      ? (widthM / cols + lengthM / rows) / 2
      : preset.cellM;
  const pasteReduced = skiExperimental && (cols !== requestedCols || rows !== requestedRows);
  return {
    reliefM: Math.round((maxS - minS) * 10) / 10,
    minZ: Math.round(minS * 10) / 10,
    maxZ: Math.round(maxS * 10) / 10,
    terrainResolution: preset.id,
    cellM,
    gridCols: cols,
    gridRows: rows,
    requestedGridCols: requestedCols,
    requestedGridRows: requestedRows,
    pasteReduced: pasteReduced || undefined,
    samples: clean,
    elevationAt,
    kind,
    attribution,
    clipboard: mesh.clip,
    raised: mesh.raised,
    sloped: mesh.sloped,
    frame,
    // z = 0 on sloped floors is the lowest lattice node, not the raw sample min.
    datumZ: mesh.grid.minZ,
  };
}

function omittedPaste(src) {
  const widthM = src.frame && src.frame.widthM > 0 ? src.frame.widthM : 800;
  const lengthM = src.frame && src.frame.lengthM > 0 ? src.frame.lengthM : 800;
  const cellM =
    (src.preset.id === "auto" || src.preset.experimental) && src.reliefM >= LIFT_RELIEF_M
      ? (widthM / src.cols + lengthM / src.rows) / 2
      : src.preset.cellM;
  return {
    reliefM: Math.round(src.reliefM * 10) / 10,
    minZ: Math.round(src.minS * 10) / 10,
    maxZ: Math.round(src.maxS * 10) / 10,
    terrainResolution: src.preset.id,
    cellM,
    gridCols: src.cols,
    gridRows: src.rows,
    requestedGridCols: src.requestedCols,
    requestedGridRows: src.requestedRows,
    samples: src.clean,
    elevationAt: src.elevationAt,
    kind: src.kind,
    attribution: src.attribution,
    clipboard: null,
    pasteOmitted: true,
    raised: src.mesh ? src.mesh.raised : 0,
    sloped: src.mesh ? src.mesh.sloped : 0,
    frame: src.frame,
    datumZ: src.mesh ? src.mesh.grid.minZ : src.minS,
  };
}

/** Meters above the terrain clipboard's z = 0. Same datum as sloped-floor z. */
function terrainGroundM(terrain, lon, lat) {
  if (!terrain || !Number.isFinite(terrain.datumZ)) return 0;
  const z = terrain.elevationAt ? terrain.elevationAt(+lon, +lat) : terrain.samples ? idw(terrain.samples, +lon, +lat) : NaN;
  if (!Number.isFinite(z)) return 0;
  return Math.max(0, round1(z - terrain.datumZ));
}

function ringPointCount(ring) {
  if (!ring || ring.length < 2) return ring ? ring.length : 0;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a && b && a[0] === b[0] && a[1] === b[1]) return ring.length - 1;
  return ring.length;
}

function pointInOrOnRing(x, y, ring) {
  const n = ringPointCount(ring);
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const dx = xj - xi;
    const dy = yj - yi;
    const cross = (x - xi) * dy - (y - yi) * dx;
    if (Math.abs(cross) <= 1e-4 * Math.max(1, Math.hypot(dx, dy))) {
      const dot = (x - xi) * dx + (y - yi) * dy;
      const len2 = dx * dx + dy * dy;
      if (dot >= -1e-4 && dot <= len2 + 1e-4) return true;
    }
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function segmentHit(a, b, c, d) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** Vertices of the intersection of two rings. A linear floor is highest at one of these. */
function overlapVertices(a, b) {
  const na = ringPointCount(a);
  const nb = ringPointCount(b);
  const out = [];
  for (let i = 0; i < na; i++) {
    if (pointInOrOnRing(a[i][0], a[i][1], b)) out.push(a[i]);
  }
  for (let i = 0; i < nb; i++) {
    if (pointInOrOnRing(b[i][0], b[i][1], a)) out.push(b[i]);
  }
  for (let i = 0; i < na; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      const hit = segmentHit(a0, a1, b[j], b[(j + 1) % nb]);
      if (hit) out.push(hit);
    }
  }
  return out;
}

function boundsOverlap(a, b) {
  let aL = Infinity;
  let aR = -Infinity;
  let aB = Infinity;
  let aT = -Infinity;
  let bL = Infinity;
  let bR = -Infinity;
  let bB = Infinity;
  let bT = -Infinity;
  const na = ringPointCount(a);
  const nb = ringPointCount(b);
  for (let i = 0; i < na; i++) {
    if (a[i][0] < aL) aL = a[i][0];
    if (a[i][0] > aR) aR = a[i][0];
    if (a[i][1] < aB) aB = a[i][1];
    if (a[i][1] > aT) aT = a[i][1];
  }
  for (let i = 0; i < nb; i++) {
    if (b[i][0] < bL) bL = b[i][0];
    if (b[i][0] > bR) bR = b[i][0];
    if (b[i][1] < bB) bB = b[i][1];
    if (b[i][1] > bT) bT = b[i][1];
  }
  return aL <= bR && aR >= bL && aB <= bT && aT >= bB;
}

/**
 * Pasted floor height at one clipboard point. A ramp stores one z on the low
 * edge and one z on the opposite edge, so the plane can sit above a corner DEM.
 */
function pastedFloorZ(zone, x, y) {
  const ring = zone.area && zone.area.coordinates && zone.area.coordinates[0];
  if (!ring || ring.length < 4) return 0;
  if (ring[0].length < 3) return Number(zone.height) || 0;
  const z0 = ring[0][2];
  const z1 = ring[2][2];
  const horizontal = Math.abs(ring[0][1] - ring[1][1]) <= 0.002;
  let t = 0;
  if (horizontal) {
    const y0 = ring[0][1];
    const y1 = ring[2][1];
    t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
  } else {
    const x0 = ring[0][0];
    const x1 = ring[2][0];
    t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  }
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return z0 + t * (z1 - z0);
}

function ringToClipboard(ring, frame) {
  const n = ringPointCount(ring);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
    out.push(llToClipboard(+p[0], +p[1], frame));
  }
  return out;
}

/** Highest pasted floor inside the footprint, in the same meters as sloped-floor z. */
function pastedFloorTopUnderRing(terrain, ring) {
  const clip = terrain && terrain.clipboard;
  const frame = terrain && terrain.frame;
  if (!clip || !frame || !ring) return 0;
  const xy = ringToClipboard(ring, frame);
  if (xy.length < 3) return 0;
  const zones = [];
  const sloped = clip.slopedFloors || [];
  const raised = clip.raisedFloorZones || [];
  for (let i = 0; i < sloped.length; i++) zones.push(sloped[i]);
  for (let i = 0; i < raised.length; i++) zones.push(raised[i]);
  let max = 0;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const quad = zone.area && zone.area.coordinates && zone.area.coordinates[0];
    if (!quad || quad.length < 4 || !boundsOverlap(xy, quad)) continue;
    const pts = overlapVertices(xy, quad);
    for (let k = 0; k < pts.length; k++) {
      const z = pastedFloorZ(zone, pts[k][0], pts[k][1]);
      if (z > max) max = z;
    }
  }
  return max;
}

/**
 * Top of the slope under a lon/lat ring, in terrain-clipboard meters.
 * DEM samples at the vertices and centroid, and the pasted floor inside the
 * footprint. A coarse ramp can sit above those samples; the higher one is
 * the surface the object has to rest on.
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
  const floor = pastedFloorTopUnderRing(terrain, ring);
  if (floor > max) max = floor;
  return round1(max);
}

/** True when this export's terrain clipboard is a ski-hill-scale bare-earth DEM.
 *  Surface DEMs stay false. The 20 m gate is not applied to Copernicus.
 */
function siteWarrantsLift(terrain) {
  if (!terrain || terrain.kind === "surface") return false;
  if (!(terrain.reliefM >= LIFT_RELIEF_M)) return false;
  return (terrain.raised || 0) + (terrain.sloped || 0) > 0;
}

/**
 * Ring → meters above the terrain datum for attenuating-object bottoms.
 * Null when objects stay on the floor.
 * Bare earth uses the ski-hill gate (relief at least 20 m).
 * A surface DEM skips that gate and still samples the mesh, including relief
 * under 20 m. The value is the slope top under the ring, not a flat 20 m.
 * Ground under LIFT_LOCAL_M still omits bottom_height inside the lifters.
 */
function demUnderFootprint(terrain) {
  if (!terrain) return null;
  const zones = (terrain.raised || 0) + (terrain.sloped || 0);
  if (zones <= 0 && !terrain.pasteOmitted) return null;
  if (terrain.pasteOmitted) {
    if (terrain.kind !== "surface" && !(terrain.reliefM >= LIFT_RELIEF_M)) return null;
    return (ring) => slopeTopUnderRing(terrain, ring);
  }
  if (terrain.kind === "surface" || siteWarrantsLift(terrain)) {
    return (ring) => slopeTopUnderRing(terrain, ring);
  }
  return null;
}

function terrainSourceLabel(terrain) {
  if (terrain && terrain.kind === "surface") return "Copernicus DEM GLO-30 surface";
  return "USGS 3DEP bare-earth";
}

/**
 * Bundle fields for the export API. The OpenIntent zip stays the only download.
 * terrainClipboard is the in-memory Planner Plus paste for Copy terrain.
 * terrainFilename names that JSON inside the zip, or both are null when 3DEP misses.
 */
function terrainBundleFields(terrain, warnings) {
  if (terrain && terrain.pasteOmitted) {
    return {
      terrainFilename: null,
      terrainClipboard: null,
      terrainStatus:
        "Terrain paste omitted: " +
        (terrain.gridCols || 0) +
        "×" +
        (terrain.gridRows || 0) +
        " quads will not fit in the export response. Hamina's older paste expectation is about 20×20. OpenIntent zip is unchanged.",
    };
  }
  const ready = !!(
    terrain &&
    terrain.clipboard &&
    ((terrain.raised || 0) > 0 || (terrain.sloped || 0) > 0)
  );
  if (ready) {
    const preset = normalizeTerrainResolution(terrain.terrainResolution);
    let mesh = "";
    if (terrain.reliefM >= LIFT_RELIEF_M) {
      const shown =
        preset.experimental || (preset.id === "auto" && terrain.cellM > 0) ? terrain.cellM : preset.cellM;
      mesh = ", " + preset.label + " ~" + formatCellM(shown) + " m";
      if (preset.experimental && (terrain.gridCols > PASTE_SOFT_GRID || terrain.gridRows > PASTE_SOFT_GRID)) {
        mesh += " (" + terrain.gridCols + "×" + terrain.gridRows + ", past 20×20)";
      }
    } else if (preset.id !== "default") {
      mesh = ", " + preset.label + " (relief under 20 m keeps the coarse mesh)";
    }
    const reduced = terrain.pasteReduced ? " " + pasteReducedNote(terrain) : "";
    return {
      terrainFilename: TERRAIN_FILENAME,
      terrainClipboard: terrain.clipboard,
      terrainStatus:
        "Terrain ready (" +
        terrainSourceLabel(terrain) +
        ", " +
        terrain.raised +
        " raised, " +
        terrain.sloped +
        " sloped" +
        mesh +
        ")." +
        reduced +
        " Use Copy terrain and paste it in Planner Plus. Do not import it as OpenIntent.",
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
  if (terrain && terrain.pasteOmitted) return;
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
  const sampleCount = demSampleCount(opts, frame);
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

function usableDemSamples(samples) {
  return (samples || []).filter(
    (s) => s && Number.isFinite(+s.lon) && Number.isFinite(+s.lat) && Number.isFinite(+s.z)
  );
}

/**
 * Dev-host gate, same host/path check as the terrain-resolution slider.
 * Accepts a Netlify event or a headers object.
 */
function isDevDemHost(eventOrHeaders) {
  const event =
    eventOrHeaders && (eventOrHeaders.headers || eventOrHeaders.httpMethod || eventOrHeaders.path)
      ? eventOrHeaders
      : { headers: eventOrHeaders || {} };
  const headers = event.headers || {};
  const host = String(headers.host || headers.Host || "")
    .trim()
    .toLowerCase();
  const path = String(event.path || event.rawPath || "");
  return (
    host.startsWith("dev--") ||
    host.startsWith("deploy-preview-") ||
    path === "/dev" ||
    path.startsWith("/dev/")
  );
}

/**
 * Try USGS 3DEP. On the dev host, a miss reads Copernicus GLO-30 for the same
 * frame. 3DEP success never calls GLO-30. Both failures keep today's omission.
 * @returns {Promise<{samples:{lon:number,lat:number,z:number}[], kind:string, attribution:string}>}
 */
async function fetchTerrainDem(frame, fetchFn, opts) {
  const allowSurface = !!(opts && opts.allowSurfaceFallback);
  const parent = opts && opts.signal;
  const outside = allowSurface && !frameHas3dep(frame);
  // The Finland follow-up already probed 3DEP. A second probe would spend
  // the reserved slice on a request that cannot succeed.
  const skipProbe = outside && !!(opts && opts.skip3depProbe);
  // Outside coverage a full getSamples often hangs until the shared abort,
  // which used to cancel GLO-30 before it started. Probe briefly instead.
  const probe = outside && !skipProbe ? linkAbort(parent, DEP3_OUTSIDE_MS) : null;
  let samples = [];
  if (!skipProbe) {
    try {
      const demOpts = probe
        ? Object.assign({}, opts, { signal: probe.signal, sampleCount: DEP3_PROBE_SAMPLES })
        : opts;
      samples = await fetchDemSamples(frame, fetchFn, demOpts);
    } catch (e) {
      if (parent && parent.aborted) throw e;
      if (!allowSurface) throw e;
    } finally {
      if (probe) probe.done();
    }
  }
  const usable = usableDemSamples(samples);
  if (usable.length >= 4) {
    const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
    const note = demDensityNote(preset, frame, usable.length);
    return {
      samples: usable,
      kind: "bare-earth",
      attribution: USGS_3DEP_ATTRIBUTION,
      notes: note ? [note] : [],
    };
  }
  if (!allowSurface) {
    return { samples: samples || [], kind: "bare-earth", attribution: USGS_3DEP_ATTRIBUTION };
  }
  if (parent && parent.aborted) {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "AbortError";
    throw err;
  }
  const requested = sampleCountForResolution(opts && opts.terrainResolution, frame);
  const plan = glo30SamplePlan(requested, demRemainingMs(opts));
  try {
    const glo = await fetchCopernicusDemSamples(frame, {
      signal: parent,
      geotiff: opts && opts.geotiff,
      sampleCount: plan.sampleCount,
      maxRasterSide: plan.maxRasterSide,
    });
    const gloUsable = usableDemSamples(glo);
    if (gloUsable.length < 4) throw new Error("GLO-30 short");
    const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
    const notes = [];
    const density = demDensityNote(preset, frame, gloUsable.length);
    if (density) notes.push(density);
    else if (plan.sampleCount < requested) {
      notes.push(
        "DEM samples stepped down to " +
          gloUsable.length +
          " so the elevation read can finish. Elevations between samples are interpolated."
      );
    }
    return {
      samples: gloUsable,
      kind: "surface",
      attribution: GLO30_CREDIT,
      notes,
    };
  } catch (e) {
    if (parent && parent.aborted) throw e;
    if (e && e.name === "AbortError") throw e;
    // Same warning the zip already uses when 3DEP misses.
    throw new Error("USGS 3DEP did not return a usable grid");
  }
}

module.exports = {
  DEM_URL,
  USGS_3DEP_ATTRIBUTION,
  GLO30_CREDIT,
  TERRAIN_FILENAME,
  FLAT_M,
  SAMPLE_COUNT,
  MAX_GRID,
  TARGET_CELL_M,
  TERRAIN_RESOLUTIONS,
  PASTE_SOFT_GRID,
  ABSOLUTE_MAX_GRID,
  ABSOLUTE_MAX_SAMPLES,
  TERRAIN_PASTE_JSON_MAX,
  PASTE_BUILD_MAX_QUADS,
  LAMBDA_SYNC_PAYLOAD_MAX,
  EXPORT_PAYLOAD_BUDGET,
  BUNDLE_ENVELOPE_BYTES,
  maxPasteJsonForCompanion,
  estimateBundlePayload,
  lambdaPayloadBytes,
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
  demUnderFootprint,
  terrainBundleFields,
  noteMissingTerrain,
  parseDemSamples,
  fetchDemSamples,
  fetchTerrainDem,
  isDevDemHost,
  frameHas3dep,
  glo30SamplePlan,
  DEP3_OUTSIDE_MS,
  DEP3_PROBE_SAMPLES,
  chooseGrid,
  fitPasteAxes,
  normalizeTerrainResolution,
  sampleCountForResolution,
  terrainResolutionNotes,
  formatCellM,
  autoAxisCount,
};
