"use strict";

/**
 * USGS 3DEP bare-earth DEM → a HaminaClipboard JSON for Planner Plus paste.
 * On the dev host, fetchTerrainDem tries Copernicus DEM GLO-30 when 3DEP
 * returns no usable grid. parallelSurface starts that read beside a US
 * getSamples, so a first request that runs out of clock still keeps the
 * surface grid. A frame outside 3DEP coverage (Finland and the rest of
 * Europe) only probes 3DEP briefly, with a tiny sample count, so
 * the rest of the DEM budget can finish a GLO-30 grid — coarser when little
 * time is left. The handler can skip that probe on a follow-up read and pass
 * budgetMs for the slice still left after the aerial. GLO-30 is a surface DSM.
 * A pasted mesh lifts attenuating objects on bare earth and on a surface DEM,
 * including relief under 20 m. The old ski-hill gate applies only when the
 * paste was left out. Production callers leave that
 * fallback off and never call GLO-30. A US 3DEP hit is still preferred.
 * OpenIntent has no raisedFloorZones / slopedFloors. Copy terrain is the paste
 * path. The same JSON is stored in the OpenIntent zip when 3DEP hits; Export
 * does not download it as a second file.
 *
 * Clipboard meters match hamina-clipboard.js: NE is (0, 0), SW is
 * (−widthM, −lengthM). Raised-floor height and sloped-floor z are both meters
 * above the lowest sample. Larger z is higher ground, the same way the native
 * open-pit clipboard stores the pit floor at 0 and the rim at 213. The
 * v1.1.79 complement stored the floor as the largest z, which draws that hole
 * as a hill.
 *
 * The page default (terrainStyle "sloped") is the ramp mesh. When Terrain is
 * on, the page also offers terrainStyle "raised": raisedFloorZones only. Each cell takes the high
 * corner, quantized to a height band. Every band is a plate covering every
 * cell that reaches that height, merged into rectangles, so higher plates sit
 * on lower ones. Flat ground is one pad. The stack stays at or under 400
 * floors. There is no resolution control on the page.
 *
 * Auto is the Terrain toggle. It fills the paste budget: about 1 m cells, at
 * most 20×20 quads, and raised layers stay at or under 400 floors. A larger
 * draw gets coarser cells because that budget is the cap, not because a
 * milder hill is dropped to 2×2, 4×3, or 6×5. Those relief steps remain only
 * for the hidden named presets. At Finland latitudes Auto still plans square
 * ground-meter quads, so a long draw hits 20 on the long side and fewer on
 * the short side. A draw that cannot hold the requested cell steps up to a
 * coarser square lattice, and the status reports that size. Default is ~80 m quads,
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
 * raisedFloorZones are xy quads. A cell within 0.05 m of level is one of
 * those pads, the same role as a bench in the native pit. slopedFloors are xyz
 * quads. The first edge is the low side (both corners share that z) and the
 * opposite edge is the high side (both corners share the larger z). A quad
 * whose four corners each keep their own z is not a plane, and Planner Plus
 * rejects it with "Sloped floor coordinates are not valid!". A triangle has
 * no opposite edge, and the same check rejects it. v1.1.77 already stored
 * this positive-up z with the low edge first. Its axis was the steeper
 * rise/run, so a twisted cell ramped across the grade and the shared edge
 * missed. Each cell starts on the axis whose opposite corners already agree,
 * then flips when that makes the shared corners meet more closely.
 */

const { llToClipboard, clipboardToLl, needsGroundMeterImage } = require("./geo-frame");
const polygonClipping = require("polygon-clipping");
const { emptyClipboard, stampGpsTiePoints } = require("./hamina-clipboard");
const { fetchCopernicusDemSamples, GLO30_CREDIT } = require("./copernicus-dem");

const DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const USGS_3DEP_ATTRIBUTION = "USGS 3DEP";
const TERRAIN_FILENAME = "terrain-clipboard.json";
const FLAT_M = 0.5;
/**
 * Sloped style only. A 0.5 m gate turned every cell of a fine mesh into a pad
 * on a gentle hill, so the floor was a staircase instead of ramps. A cell
 * this close to level stays a pad.
 */
const SLOPED_FLAT_M = 0.05;
/**
 * Ski-hill paste presets. Auto fills the 20×20 budget from the draw, including
 * relief under 20 m. Default matches the v1.1.5 lattice. Fine and Finest are
 * fixed manual overrides. Those hidden presets still use the 2×2, 4×3, and
 * 6×5 ladders below 20 m of relief. sampleCount is the 3DEP getSamples
 * request: a square count denser than the paste nodes so bilinear is not
 * stretching a sparse DEM. Auto, Default, Fine, and Finest stay inside the
 * older Hamina paste size (PASTE_SOFT_GRID). Experimental stops may pass it,
 * up to ABSOLUTE_MAX_GRID. ABSOLUTE_MAX_SAMPLES is the DEM read ceiling;
 * the old ceiling was 625.
 */
/** Older Hamina clipboard size. Auto and the named manuals stay inside it. */
const PASTE_SOFT_GRID = 20;
/**
 * Raised-layer paste cap. A ~9k sloped mesh locked Planner Plus. Nested
 * plates stay at or under this many raisedFloorZones.
 */
const RAISED_FLOOR_MAX = PASTE_SOFT_GRID * PASTE_SOFT_GRID;
/** First height band, in meters. Coarser bands are only the cap fallback. */
const RAISED_BAND_M = 1;
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
 * The paste is only in the bundle body. The 4/3 term is leftover slack from
 * when the same JSON was also stored in the zip, so a fine mesh still fits
 * the old response budget. Lambda JSON-encodes the body, so each quote grows
 * by a byte. Sloped quads are about 7.5% quotes; 1.08 leaves a little slack.
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
/**
 * Hamina pastes the mesh in one synchronous pass. A 20×20 grid imported, and
 * Jerry confirmed a Hollywood paste of 1408 floors and 351 KB also imported.
 * The default cap is that size: 1500 floors and about 400 KB. One-meter
 * bands still are not the default: they filled thousands of floors and a
 * multi-megabyte clipboard, and Hamina locked.
 */
const TERRAIN_PASTE_MAX_FLOORS = 1500;
const TERRAIN_PASTE_MAX_BYTES = 400 * 1024;
/** Dev-only ?terrainFloors= probe. Outside this range the default cap stays. */
const TERRAIN_FLOORS_MIN = 100;
const TERRAIN_FLOORS_MAX = 6000;
/** Floor budget for the mesh currently being built. terrainFromSamples sets it. */
let activePasteFloors = TERRAIN_PASTE_MAX_FLOORS;

function terrainPasteFloorCap(opts) {
  const raw = opts && opts.terrainFloors;
  if (raw == null || raw === "" || typeof raw === "boolean") return TERRAIN_PASTE_MAX_FLOORS;
  const text = typeof raw === "number" ? String(raw) : String(raw).trim();
  if (!/^\d+$/.test(text)) return TERRAIN_PASTE_MAX_FLOORS;
  const n = Number(text);
  if (n < TERRAIN_FLOORS_MIN || n > TERRAIN_FLOORS_MAX) return TERRAIN_PASTE_MAX_FLOORS;
  return n;
}

/**
 * Dev-only floor cap from the page query or the export body.
 * An integer from 100 through 6000 is kept. Anything else is ignored
 * so the paste stays at 1500 floors. 99 and 6001 are not clamped.
 */
function parseTerrainFloorOverride(value) {
  if (value == null || value === "" || typeof value === "boolean") return 0;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+$/.test(text)) return 0;
  const n = Number(text);
  if (n < TERRAIN_FLOORS_MIN || n > TERRAIN_FLOORS_MAX) return 0;
  return n;
}

/** Byte ceiling. A floor probe above 1500 may exceed 400 KB so the ceiling can be found. */
function pasteByteCap() {
  if (activePasteFloors > TERRAIN_PASTE_MAX_FLOORS) {
    return Math.max(TERRAIN_PASTE_MAX_BYTES, activePasteFloors * 480);
  }
  return TERRAIN_PASTE_MAX_BYTES;
}

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

/** Sloped ramps are the Terrain-on default. "raised" is the layered alternate. */
function normalizeTerrainStyle(id) {
  const key = String(id == null ? "" : id)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (key === "raised" || key === "raisedlayers" || key === "raisedfloors" || key === "layers") return "raised";
  return "sloped";
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
function pointInBox(lon, lat, box) {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}

function frameHas3dep(frame) {
  if (!frame) return false;
  const lon = (+frame.west + +frame.east) / 2;
  const lat = (+frame.south + +frame.north) / 2;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  let covered = false;
  for (let i = 0; i < DEP3_COVERAGE.length; i++) {
    if (pointInBox(lon, lat, DEP3_COVERAGE[i])) {
      covered = true;
      break;
    }
  }
  if (!covered) return false;
  for (let i = 0; i < DEP3_HOLES.length; i++) {
    if (pointInBox(lon, lat, DEP3_HOLES[i])) return false;
  }
  return true;
}

// A campus getSamples near 576 points took about 6s. The short sync path
// leaves about 5.6s, so that read stays at the lattice that has returned in
// about 4s. A background export has minutes. Plan against up to a minute,
// which is the full-lattice tier and still well inside the 4 minute answer
// and the 15 minute platform limit.
const SYNC_DEM_PLAN_MS = 4500;
const BACKGROUND_DEM_PLAN_MS = 60000;

function demSampleCount(opts, frame) {
  if (opts && Number.isFinite(+opts.sampleCount) && +opts.sampleCount > 0) {
    return Math.max(4, Math.min(ABSOLUTE_MAX_SAMPLES, opts.sampleCount | 0));
  }
  const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
  const requested = sampleCountForResolution(preset.id, frame);
  if (opts && opts.fitAnswerClock) {
    const remaining = demRemainingMs(opts);
    const capMs = opts.backgroundDem ? BACKGROUND_DEM_PLAN_MS : SYNC_DEM_PLAN_MS;
    const budget = remaining == null ? capMs : Math.min(Math.max(0, remaining), capMs);
    return glo30SamplePlan(requested, budget).sampleCount;
  }
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
 * Relief at or above this is a ski hill for grid notes, and for a DEM that
 * was not pasted. A pasted mesh lifts buildings at any relief. Oak Creek
 * (~6 m), Long Meadow (~15 m), and the Las Vegas Sphere box (~17 m) used to
 * stay at bottom 0 while the hill was still pasted, which put them under it.
 */
const LIFT_RELIEF_M = 20;
/** Local ground under this is bottom height from floor ≈ 0 (field omitted). */
const LIFT_LOCAL_M = 1;
/**
 * USGS 3DEP Elevation ImageServer has data here. A center outside every box
 * cannot succeed, so the dev host must not spend the DEM budget on it.
 * The rectangle includes some border water and the southern edge of Canada.
 * DEP3_HOLES are places inside that rectangle where 3DEP has no grid
 * (Montreal, Toronto, Vancouver). Those reads go to Copernicus.
 */
const DEP3_COVERAGE = [
  { west: -125.5, south: 24.0, east: -66.0, north: 49.6 },
  { west: -170.0, south: 51.0, east: -129.0, north: 71.6 },
  { west: -160.3, south: 18.8, east: -154.7, north: 22.3 },
  { west: -67.5, south: 17.6, east: -64.5, north: 18.6 },
  { west: 144.6, south: 13.2, east: 145.0, north: 13.7 },
  { west: -170.9, south: -14.4, east: -169.4, north: -14.2 },
];
const DEP3_HOLES = [
  // Southern Quebec and the Ottawa valley, west of Maine.
  { west: -80.0, south: 45.02, east: -71.25, north: 49.6 },
  // Toronto and the north shore of Lake Ontario.
  { west: -83.2, south: 43.25, east: -78.6, north: 45.02 },
  // Kingston and the Canadian shore of eastern Lake Ontario.
  { west: -77.3, south: 44.05, east: -76.0, north: 45.02 },
  // Windsor.
  { west: -83.12, south: 42.02, east: -82.45, north: 42.55 },
  // Vancouver, Victoria, and the lower mainland.
  { west: -123.7, south: 48.15, east: -122.2, north: 49.45 },
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

/** Clipboard meters, rounded to 1 cm. Shared corners use the same quantize. */
function round3(n) {
  return Math.round(n * 100) / 100;
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

function frameCenterLat(frame) {
  if (!frame) return NaN;
  return ((+frame.south) + (+frame.north)) / 2;
}

/** True when the aerial is resampled onto ground meters (Finland, not CONUS). */
function highLatMeterFrame(frame) {
  const lat = frameCenterLat(frame);
  if (!Number.isFinite(lat)) return false;
  return needsGroundMeterImage(lat);
}

/**
 * cols×rows of about cellM on both axes, in the frame's ground meters.
 * A side past cap scales both axes so the cells stay square.
 */
function squareMeterAxes(widthM, lengthM, cellM, cap) {
  const width = widthM > 0 ? widthM : 800;
  const length = lengthM > 0 ? lengthM : 800;
  const cell = cellM > 0 ? cellM : 1;
  let cols = Math.max(1, Math.round(width / cell));
  let rows = Math.max(1, Math.round(length / cell));
  const limit = Math.max(1, cap | 0);
  if (Math.max(cols, rows) > limit) {
    const scale = limit / Math.max(cols, rows);
    cols = Math.max(1, Math.round(cols * scale));
    rows = Math.max(1, Math.round(rows * scale));
    while ((cols > limit || rows > limit) && cols * rows > 1) {
      if (cols >= rows && cols > 1) cols -= 1;
      else if (rows > 1) rows -= 1;
      else break;
    }
  }
  return [cols, rows];
}

/** US relief ladder. Null once the site is a ski hill and a resolution preset applies. */
function reliefLadder(relief) {
  if (!(relief >= 1)) return [2, 2];
  if (relief < 8) return [4, 3];
  if (relief < LIFT_RELIEF_M) return [6, 5];
  return null;
}

/**
 * Same quad budget as the relief ladder, on the ground-meter aspect.
 * A 6×5 index grid on a degree-square Finland extent is about 2:1 in meters.
 */
function squareReliefAxes(relief, widthM, lengthM) {
  const base = reliefLadder(relief);
  if (!base) return null;
  const quads = base[0] * base[1];
  const width = widthM > 0 ? widthM : 800;
  const length = lengthM > 0 ? lengthM : 800;
  let bestC = 1;
  let bestR = Math.max(1, quads);
  let bestErr = Infinity;
  for (let cols = 1; cols <= quads; cols++) {
    const rows = Math.max(1, Math.round(quads / cols));
    const cellW = width / cols;
    const cellH = length / rows;
    const cellErr = Math.abs(cellW - cellH) / Math.max(cellW, cellH);
    const countErr = Math.abs(cols * rows - quads) / quads;
    const err = cellErr * 4 + countErr;
    if (err < bestErr) {
      bestErr = err;
      bestC = cols;
      bestR = rows;
    }
  }
  return [bestC, bestR];
}

function meterAxes(frame, preset, squareCells) {
  const width = frame && frame.widthM > 0 ? frame.widthM : 800;
  const length = frame && frame.lengthM > 0 ? frame.lengthM : 800;
  if (preset.id === "auto") {
    if (!squareCells) return [autoAxisCount(width), autoAxisCount(length)];
    const cell = Math.max(MIN_CELL_M, Math.max(width, length) / PASTE_SOFT_GRID);
    return squareMeterAxes(width, length, cell, PASTE_SOFT_GRID);
  }
  const cellM = preset.cellM > 0 ? preset.cellM : TARGET_CELL_M;
  const hard = preset.experimental ? ABSOLUTE_MAX_GRID : PASTE_SOFT_GRID;
  const cap = Math.max(6, Math.min(hard, preset.maxGrid | 0));
  if (!squareCells) {
    let cols = Math.round(width / cellM);
    let rows = Math.round(length / cellM);
    cols = Math.max(6, Math.min(cap, cols));
    rows = Math.max(6, Math.min(cap, rows));
    return [cols, rows];
  }
  return squareMeterAxes(width, length, cellM, cap);
}

/**
 * Floors the paste may contain. The hard cap is 1500 floors and about 400 KB.
 * A tight export JSON ceiling can force fewer. A dev floor probe can raise
 * the floor count (and the byte ceiling that goes with it).
 */
function pastePlanQuadBudget(jsonMax) {
  const max =
    jsonMax != null && jsonMax !== "" && Number.isFinite(+jsonMax) ? Math.max(0, +jsonMax) : TERRAIN_PASTE_JSON_MAX;
  const rough = Math.max(1, Math.floor(max / 240));
  const fromBytes = Math.max(1, Math.floor(pasteByteCap() / 240));
  return Math.max(1, Math.min(PASTE_BUILD_MAX_QUADS, rough, activePasteFloors, fromBytes));
}

function reportedCellM(preset, reliefM, highLat, widthM, lengthM, cols, rows) {
  const effective =
    highLat ||
    preset.id === "auto" ||
    (preset.experimental && reliefM >= LIFT_RELIEF_M);
  if (effective && cols > 0 && rows > 0 && widthM > 0 && lengthM > 0) {
    return (widthM / cols + lengthM / rows) / 2;
  }
  return preset.cellM;
}

function chooseGrid(relief, frame, resolution) {
  const preset = normalizeTerrainResolution(resolution);
  const highLat = highLatMeterFrame(frame);
  const width = frame && frame.widthM > 0 ? frame.widthM : 800;
  const length = frame && frame.lengthM > 0 ? frame.lengthM : 800;
  // Auto is the only resolution the page sends. A mild site used to stay on
  // the 2×2 / 4×3 / 6×5 ladder, which is coarser than the 20×20 paste budget
  // the DEM sample count was already planned for. Fill that budget instead.
  // Hidden presets still use the ladder below 20 m of relief.
  if (preset.id === "auto") return meterAxes(frame, preset, highLat);
  const honorMeters = highLat && preset.experimental;
  if (!honorMeters) {
    const ladder = reliefLadder(relief);
    if (ladder) {
      if (highLat) return squareReliefAxes(relief, width, length);
      return ladder;
    }
  }
  return meterAxes(frame, preset, highLat);
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
  // High latitude still names a stepped cell when the town is under 20 m.
  // A US flat site keeps the relief ladder and has no experimental mesh note.
  if (!(terrain.reliefM >= LIFT_RELIEF_M) && !highLatMeterFrame(frame)) return notes;
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
  let maxRel = 0;
  for (const n of nodes) {
    n.zRel = round1(n.z - minZ);
    if (n.zRel > maxRel) maxRel = n.zRel;
  }
  return { nodes, cols, rows, minZ, maxZ, relief: maxZ - minZ, maxRel };
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

/** Stored z for one lattice node: meters above the lowest sample. Larger is higher. */
function haminaZ(n) {
  return round1(n.zRel);
}

/**
 * One planar ramp per cell. Both corners of the low edge share one stored
 * height, and both corners of the opposite edge share the other. Hamina
 * rejects a quad that gives each corner its own z.
 *
 * The axis is the one whose corners already agree. The residual is half the
 * larger difference on a pair of opposite edges. The smaller residual is the
 * closer plane. A tie keeps the steeper rise/run, then north-south:
 *   nsSlope = |zN − zS| / northSouthEdgeLengthM
 *   ewSlope = |zE − zW| / eastWestEdgeLengthM
 *
 * The first edge is the low ground and the opposite edge is the high ground.
 * A north-up grade therefore starts on the south edge.
 *
 * Clipboard y increases north. The low edge is walked with the cell interior
 * on the left (counterclockwise). The clockwise walk pastes as a flat pad:
 *   south low, north high: sw, se, ne, nw
 *   north low, south high: ne, nw, sw, se
 *   west low, east high:   nw, sw, se, ne
 *   east low, west high:   se, ne, nw, sw
 */
function rampChoice(sw, se, ne, nw) {
  const zSW = haminaZ(sw);
  const zSE = haminaZ(se);
  const zNE = haminaZ(ne);
  const zNW = haminaZ(nw);
  const zS = (zSW + zSE) / 2;
  const zN = (zNW + zNE) / 2;
  const zW = (zSW + zNW) / 2;
  const zE = (zSE + zNE) / 2;
  const nsResidual = Math.max(Math.abs(zSW - zSE), Math.abs(zNW - zNE)) / 2;
  const ewResidual = Math.max(Math.abs(zSW - zNW), Math.abs(zSE - zNE)) / 2;
  const northSouthEdgeLengthM = (edgeRunM(sw, nw) + edgeRunM(se, ne)) / 2;
  const eastWestEdgeLengthM = (edgeRunM(sw, se) + edgeRunM(nw, ne)) / 2;
  const nsSlope = riseOverRun(Math.abs(zN - zS), northSouthEdgeLengthM);
  const ewSlope = riseOverRun(Math.abs(zE - zW), eastWestEdgeLengthM);
  const nsFirst =
    nsResidual < ewResidual - 1e-9 ? true : ewResidual < nsResidual - 1e-9 ? false : nsSlope >= ewSlope;
  return {
    ns: nsRamp(sw, se, ne, nw, zS, zN),
    ew: ewRamp(sw, se, ne, nw, zW, zE),
    nsFirst,
  };
}

function slopedRing(sw, se, ne, nw) {
  const choice = rampChoice(sw, se, ne, nw);
  if (choice.nsFirst) return choice.ns || choice.ew;
  return choice.ew || choice.ns;
}

function ringForAxis(choice, nsAxis) {
  if (!choice) return null;
  if (nsAxis) return choice.ns || choice.ew;
  return choice.ew || choice.ns;
}

/** Largest step, and the sum of those steps, where sloped corners share an xy. */
function rampGapScore(rings) {
  const at = new Map();
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    if (!ring) continue;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      const key = p[0].toFixed(3) + "," + p[1].toFixed(3);
      const prev = at.get(key);
      if (prev) {
        if (p[2] < prev.lo) prev.lo = p[2];
        if (p[2] > prev.hi) prev.hi = p[2];
      } else at.set(key, { lo: p[2], hi: p[2] });
    }
  }
  let max = 0;
  let sum = 0;
  for (const span of at.values()) {
    const gap = span.hi - span.lo;
    if (gap > max) max = gap;
    sum += gap;
  }
  return { max, sum };
}

/**
 * Start from the closer plane, then flip a cell onto its other ramp when
 * that cuts the shared-corner step. A cell with only one valid ramp stays.
 */
function relaxRampAxes(choices) {
  const nsAxis = new Array(choices.length);
  const initialOnly = choices.length > PASTE_SOFT_GRID * PASTE_SOFT_GRID;
  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i];
    nsAxis[i] = !!(choice && choice.nsFirst && choice.ns) || !!(choice && !choice.ew);
  }
  if (initialOnly) return nsAxis;
  function ringsFor(axes) {
    const rings = new Array(choices.length);
    for (let i = 0; i < choices.length; i++) rings[i] = ringForAxis(choices[i], axes[i]);
    return rings;
  }
  let best = rampGapScore(ringsFor(nsAxis));
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      if (!choice || !choice.ns || !choice.ew) continue;
      nsAxis[i] = !nsAxis[i];
      const next = rampGapScore(ringsFor(nsAxis));
      if (next.max < best.max - 1e-9 || (next.max <= best.max + 1e-9 && next.sum < best.sum - 1e-9)) {
        best = next;
        changed = true;
      } else nsAxis[i] = !nsAxis[i];
    }
    if (!changed) break;
  }
  return nsAxis;
}

function cornerAt(n, z) {
  return xyzAt(n, round1(z));
}

function nsRamp(sw, se, ne, nw, zS, zN) {
  const south = round1(zS);
  const north = round1(zN);
  if (south === north) return null;
  return south < north
    ? [cornerAt(sw, south), cornerAt(se, south), cornerAt(ne, north), cornerAt(nw, north)]
    : [cornerAt(ne, north), cornerAt(nw, north), cornerAt(sw, south), cornerAt(se, south)];
}

function ewRamp(sw, se, ne, nw, zW, zE) {
  const west = round1(zW);
  const east = round1(zE);
  if (west === east) return null;
  return west < east
    ? [cornerAt(nw, west), cornerAt(sw, west), cornerAt(se, east), cornerAt(ne, east)]
    : [cornerAt(se, east), cornerAt(ne, east), cornerAt(nw, west), cornerAt(sw, west)];
}

/**
 * Hamina's sloped-floor rule, read off the native open-pit clipboard: exactly
 * four points, both corners of the first edge at the low z, both corners of
 * the opposite edge at one higher z, no repeated xy, and a nonzero area.
 * That paste uses both windings, and one quad has a tiny nick, so a same-sign
 * corner test is stricter than the file Hamina saved. A triangle, a closed
 * ring, or four different corner heights fails the same way Planner Plus does
 * ("Sloped floor coordinates are not valid!").
 */
function planarSlopedRamp(ring) {
  if (!ring || ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    if (!p || p.length !== 3) return false;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return false;
    if (sameXy(p, ring[(i + 1) % 4])) return false;
  }
  if (ring[0][2] !== ring[1][2]) return false;
  if (ring[2][2] !== ring[3][2]) return false;
  if (!(ring[2][2] > ring[0][2])) return false;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) > 1e-4;
}

/** Largest stored-z disagreement at one clipboard xy, in meters. */
function slopeCornerGap(floors) {
  const at = new Map();
  for (const zone of floors || []) {
    const ring = zone && zone.area && zone.area.coordinates && zone.area.coordinates[0];
    if (!ring) continue;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (!p || p.length < 3) continue;
      const key = p[0].toFixed(3) + "," + p[1].toFixed(3);
      const prev = at.get(key);
      if (prev) {
        if (p[2] < prev.lo) prev.lo = p[2];
        if (p[2] > prev.hi) prev.hi = p[2];
      } else at.set(key, { lo: p[2], hi: p[2] });
    }
  }
  let worst = 0;
  for (const span of at.values()) worst = Math.max(worst, span.hi - span.lo);
  return round1(worst);
}

function slopedZone(ring) {
  if (!pasteableQuad(ring)) return null;
  if (ring.some((p) => p.length !== 3)) return null;
  const zLow = (ring[0][2] + ring[1][2]) / 2;
  const zHigh = (ring[2][2] + ring[3][2]) / 2;
  if (!(zHigh > zLow)) return null;
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

/** High corner of each cell, meters above the lattice low point. */
function cellHighCorners(grid) {
  const cols = grid.cols;
  const rows = grid.rows;
  const heights = new Array(rows);
  let maxH = 0;
  for (let r = 0; r < rows; r++) {
    heights[r] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const sw = at(grid, c, r);
      const se = at(grid, c + 1, r);
      const ne = at(grid, c + 1, r + 1);
      const nw = at(grid, c, r + 1);
      const h = round1(Math.max(sw.zRel, se.zRel, ne.zRel, nw.zRel));
      heights[r][c] = h;
      if (h > maxH) maxH = h;
    }
  }
  return { heights, maxH };
}

/** Band steps from 1 m up. The last step covers the whole rise as one plate. */
function raisedBandSteps(maxHeight) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100];
  const out = [];
  const maxH = maxHeight > 0 ? maxHeight : 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step < RAISED_BAND_M) continue;
    out.push(step);
    if (maxH > 0 && step >= maxH) return out;
  }
  if (maxH > RAISED_BAND_M) out.push(Math.max(RAISED_BAND_M, Math.ceil(maxH)));
  return out.length ? out : [RAISED_BAND_M];
}

/**
 * Maximal rectangles of a cell mask. Runs with the same column span merge
 * northward into one quad.
 */
function horizontalRects(maskFn, rows, cols) {
  const rects = [];
  let active = new Map();
  for (let r = 0; r < rows; r++) {
    const runs = [];
    let c = 0;
    while (c < cols) {
      if (!maskFn(r, c)) {
        c += 1;
        continue;
      }
      let c1 = c;
      while (c1 + 1 < cols && maskFn(r, c1 + 1)) c1 += 1;
      runs.push([c, c1]);
      c = c1 + 1;
    }
    const next = new Map();
    for (let i = 0; i < runs.length; i++) {
      const c0 = runs[i][0];
      const c1 = runs[i][1];
      const key = c0 + ":" + c1;
      const prev = active.get(key);
      if (prev && prev.r1 === r - 1) {
        prev.r1 = r;
        next.set(key, prev);
      } else {
        next.set(key, { c0, c1, r0: r, r1: r });
      }
    }
    active.forEach((rect, key) => {
      if (!next.has(key)) rects.push(rect);
    });
    active = next;
  }
  active.forEach((rect) => rects.push(rect));
  return rects;
}

function pushRaisedRects(zones, grid, rects, height) {
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const pad = raisedZone(
      at(grid, rect.c0, rect.r0),
      at(grid, rect.c1 + 1, rect.r0),
      at(grid, rect.c1 + 1, rect.r1 + 1),
      at(grid, rect.c0, rect.r1 + 1),
      height
    );
    if (pad) zones.push(pad);
  }
}

/**
 * Nested raised plates for one band step. A cell quantized to H is covered by
 * every plate from the step up through H, so the plates stack. Cells under
 * FLAT_M stay a height-0 pad and are not in those plates.
 */
function raisedLayersForStep(grid, heights, step) {
  const rows = grid.rows;
  const cols = grid.cols;
  const q = new Array(rows);
  let maxB = 0;
  const stepR = round1(step > 0 ? step : RAISED_BAND_M);
  for (let r = 0; r < rows; r++) {
    q[r] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const h = heights[r][c];
      let band = 0;
      if (h >= FLAT_M && stepR > 0) band = round1(Math.ceil((h - 1e-9) / stepR) * stepR);
      q[r][c] = band;
      if (band > maxB) maxB = band;
    }
  }
  const zones = [];
  if (!(maxB > 0)) {
    pushRaisedRects(zones, grid, [{ c0: 0, c1: cols - 1, r0: 0, r1: rows - 1 }], 0);
    return { zones, bandM: stepR };
  }
  pushRaisedRects(
    zones,
    grid,
    horizontalRects((r, c) => q[r][c] === 0, rows, cols),
    0
  );
  for (let h = stepR; h <= maxB + 1e-6; h = round1(h + stepR)) {
    const level = h;
    pushRaisedRects(
      zones,
      grid,
      horizontalRects((r, c) => q[r][c] + 1e-9 >= level, rows, cols),
      level
    );
  }
  return { zones, bandM: stepR };
}

/**
 * Raised-floor terrain. Prefer 1 m bands. Coarser bands are used only when
 * the stack would pass RAISED_FLOOR_MAX. The caller coarsens the lattice if
 * even one band is still over that cap.
 */
function raisedMeshFromGrid(grid, frame) {
  const highs = cellHighCorners(grid);
  const steps = raisedBandSteps(highs.maxH);
  let best = null;
  for (let i = 0; i < steps.length; i++) {
    best = raisedLayersForStep(grid, highs.heights, steps[i]);
    if (best.zones.length <= RAISED_FLOOR_MAX) break;
  }
  if (!best || !best.zones.length) return null;
  const clip = emptyClipboard();
  clip.raisedFloorZones = best.zones;
  clip.slopedFloors = [];
  clip.attenuatingZones = [];
  stampGpsTiePoints(clip, frame);
  return {
    grid,
    clip,
    raised: best.zones.length,
    sloped: 0,
    bandM: best.bandM,
  };
}

/**
 * A pure north-south or east-west grade already shares full edges: every
 * node in a row (or column) is the same height. Those stay one ramp per cell
 * so the low edge is the downhill side. Anything else is contoured.
 */
function axisAlignedGrid(grid) {
  const cols = grid.cols;
  const rows = grid.rows;
  let rowsFlat = true;
  for (let r = 0; r <= rows && rowsFlat; r++) {
    const z0 = at(grid, 0, r).zRel;
    for (let c = 1; c <= cols; c++) {
      if (Math.abs(at(grid, c, r).zRel - z0) > SLOPED_FLAT_M) rowsFlat = false;
    }
  }
  if (rowsFlat) return true;
  for (let c = 0; c <= cols; c++) {
    const z0 = at(grid, c, 0).zRel;
    for (let r = 1; r <= rows; r++) {
      if (Math.abs(at(grid, c, r).zRel - z0) > SLOPED_FLAT_M) return false;
    }
  }
  return true;
}

function quantizeStep(z, step) {
  return round1(Math.round(z / step) * step);
}

function dedupeContour(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = { x: round3(p.x), y: round3(p.y), z: round1(p.z) };
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - q.x) < 1e-3 && Math.abs(prev.y - q.y) < 1e-3) continue;
    out.push(q);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3) out.pop();
  }
  return out;
}

function contourInterp(a, b, z) {
  const dz = b.z - a.z;
  const t = dz === 0 ? 0 : (z - a.z) / dz;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z };
}

function clipBandHalf(poly, limit, above) {
  if (!poly.length) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = above ? a.z >= limit - 1e-6 : a.z <= limit + 1e-6;
    const bIn = above ? b.z >= limit - 1e-6 : b.z <= limit + 1e-6;
    if (aIn && bIn) out.push({ x: b.x, y: b.y, z: b.z });
    else if (aIn && !bIn) out.push(contourInterp(a, b, limit));
    else if (!aIn && bIn) {
      out.push(contourInterp(a, b, limit));
      out.push({ x: b.x, y: b.y, z: b.z });
    }
  }
  return dedupeContour(out);
}

function orientContour(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  if (a < 0) pts.reverse();
  return pts;
}

function contourArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Four points sorted around their center, rotated so the low edge is first. */
function tryRampPoints(pts) {
  if (!pts || pts.length !== 4) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < 4; i++) {
    cx += pts[i].x;
    cy += pts[i].y;
  }
  cx /= 4;
  cy /= 4;
  const ordered = pts.slice().sort(function (a, b) {
    return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
  });
  const base = ordered.map(function (p) {
    return [round3(p.x), round3(p.y), round1(p.z)];
  });
  for (let rot = 0; rot < 4; rot++) {
    const ring = [];
    for (let k = 0; k < 4; k++) ring.push(base[(rot + k) % 4].slice());
    if (planarSlopedRamp(ring) && pasteableQuad(ring)) return ring;
  }
  return null;
}

function bandHeights(pts) {
  const zs = [];
  for (let i = 0; i < pts.length; i++) {
    if (zs.indexOf(pts[i].z) < 0) zs.push(pts[i].z);
  }
  zs.sort(function (a, b) {
    return a - b;
  });
  if (zs.length !== 2) return null;
  return zs;
}

function sameContourPoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
}

function contourEdgeKey(a, b) {
  const k1 = a.x.toFixed(3) + "," + a.y.toFixed(3);
  const k2 = b.x.toFixed(3) + "," + b.y.toFixed(3);
  return k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
}

function mergeContourPolys(a, b) {
  for (let i = 0; i < a.length; i++) {
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b2 = b[(j + 1) % b.length];
      const forward = sameContourPoint(a[i], b[j]) && sameContourPoint(a2, b2);
      const back = sameContourPoint(a[i], b2) && sameContourPoint(a2, b[j]);
      if (!forward && !back) continue;
      const out = [];
      for (let k = 1; k < a.length; k++) out.push(a[(i + k) % a.length]);
      const startB = back ? j : (j + 1) % b.length;
      for (let k = 1; k < b.length; k++) out.push(b[(startB + k) % b.length]);
      return orientContour(dedupeContour(out));
    }
  }
  return null;
}

function collapseColinearContour(pts) {
  if (pts.length <= 4) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i + pts.length - 1) % pts.length];
    const cur = pts[i];
    const next = pts[(i + 1) % pts.length];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > 1e-3) out.push(cur);
  }
  return out.length >= 3 ? out : pts;
}

function resampleContour(chain, segs) {
  let total = 0;
  const segLen = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const d = Math.hypot(chain[i + 1].x - chain[i].x, chain[i + 1].y - chain[i].y);
    segLen.push(d);
    total += d;
  }
  const out = [{ x: chain[0].x, y: chain[0].y, z: chain[0].z }];
  for (let s = 1; s <= segs; s++) {
    const target = total > 0 ? (total * s) / segs : 0;
    let acc = 0;
    let placed = false;
    for (let i = 0; i < segLen.length; i++) {
      if (acc + segLen[i] >= target - 1e-8) {
        const t = segLen[i] === 0 ? 0 : (target - acc) / segLen[i];
        const p = chain[i];
        const q = chain[i + 1];
        out.push({
          x: round3(p.x + (q.x - p.x) * t),
          y: round3(p.y + (q.y - p.y) * t),
          z: round1(p.z + (q.z - p.z) * t),
        });
        placed = true;
        break;
      }
      acc += segLen[i];
    }
    if (!placed) out.push(chain[chain.length - 1]);
  }
  return out;
}

function stitchContourStrip(low, high) {
  if (low.length < 2 || high.length < 2) return null;
  const nSeg = Math.max(low.length - 1, high.length - 1);
  const L = resampleContour(low, nSeg);
  const H = resampleContour(high, nSeg);
  const quads = [];
  for (let i = 0; i < nSeg; i++) {
    const quad = tryRampPoints([L[i], L[i + 1], H[i + 1], H[i]]) || tryRampPoints([L[i], L[i + 1], H[i], H[i + 1]]);
    if (!quad) return null;
    quads.push(quad);
  }
  return quads;
}

function stitchContourPoly(pts) {
  const heights = bandHeights(pts);
  if (!heights || pts.length < 4) return null;
  const lo = heights[0];
  const hi = heights[1];
  const tag = pts.map(function (p) {
    return Math.abs(p.z - lo) <= Math.abs(p.z - hi) ? "L" : "H";
  });
  let start = 0;
  for (let i = 0; i < pts.length; i++) {
    if (tag[i] !== tag[(i + pts.length - 1) % pts.length]) {
      start = i;
      break;
    }
  }
  const runs = [];
  for (let k = 0; k < pts.length; k++) {
    const i = (start + k) % pts.length;
    if (!runs.length || runs[runs.length - 1].tag !== tag[i]) runs.push({ tag: tag[i], pts: [pts[i]] });
    else runs[runs.length - 1].pts.push(pts[i]);
  }
  const lows = runs.filter(function (r) {
    return r.tag === "L";
  });
  const highs = runs.filter(function (r) {
    return r.tag === "H";
  });
  if (lows.length !== 1 || highs.length !== 1) return null;
  if (lows[0].pts.length < 2 || highs[0].pts.length < 2) return null;
  return stitchContourStrip(lows[0].pts, highs[0].pts) || stitchContourStrip(lows[0].pts, highs[0].pts.slice().reverse());
}

function lerpContour(p, q, t) {
  return {
    x: round3(p.x + (q.x - p.x) * t),
    y: round3(p.y + (q.y - p.y) * t),
    z: round1(p.z + (q.z - p.z) * t),
  };
}

/**
 * A one-corner band is a triangle. The base ramp uses the real edge heights,
 * so a neighbor that shares the edge meets it. Two small ramps cover the
 * apex. Their extra corners sit just inside the triangle, so the tip is not
 * left as an open speck and the quads do not spill into the next cell.
 */
function capContourTriangle(pts) {
  let iA = -1;
  for (let i = 0; i < 3; i++) {
    const z1 = pts[(i + 1) % 3].z;
    const z2 = pts[(i + 2) % 3].z;
    if (z1 === z2 && pts[i].z !== z1) iA = i;
  }
  if (iA < 0) return null;
  const A = pts[iA];
  const B = pts[(iA + 1) % 3];
  const C = pts[(iA + 2) % 3];
  const ab = Math.hypot(B.x - A.x, B.y - A.y);
  const ac = Math.hypot(C.x - A.x, C.y - A.y);
  if (!(ab > 0.2) || !(ac > 0.2)) return null;
  const altitude =
    Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / (Math.hypot(C.x - B.x, C.y - B.y) || 1);
  const t = Math.max(0.08, Math.min(0.4, altitude > 0 ? 0.45 / altitude : 0.2));
  const S1 = lerpContour(A, B, t);
  const S2 = lerpContour(A, C, t);
  const ramp = tryRampPoints([S1, S2, B, C]);
  if (!ramp) return null;
  const M = { x: round3((S1.x + S2.x) / 2), y: round3((S1.y + S2.y) / 2), z: S1.z };
  const ix = M.x - A.x;
  const iy = M.y - A.y;
  const il = Math.hypot(ix, iy) || 1;
  const ux = ix / il;
  const uy = iy / il;
  const px = -uy;
  const py = ux;
  const apex = { x: A.x, y: A.y, z: A.z };
  const offsets = [0.04, 0.08, 0.15, 0.3, 0.6];
  let left = null;
  let right = null;
  for (let i = 0; i < offsets.length && (!left || !right); i++) {
    const along = offsets[i];
    const side = offsets[i];
    const P = { x: round3(A.x + ux * along + px * side), y: round3(A.y + uy * along + py * side), z: A.z };
    const Q = { x: round3(A.x + ux * along - px * side), y: round3(A.y + uy * along - py * side), z: A.z };
    left = tryRampPoints([S1, M, P, apex]);
    right = tryRampPoints([S2, M, Q, apex]);
  }
  const ramps = [ramp];
  if (left) ramps.push(left);
  if (right) ramps.push(right);
  return { ramps: ramps };
}

function raisedFromRing(ring, height) {
  if (!pasteableQuad(ring)) return null;
  return {
    area: zoneArea(ring.map(function (p) {
      return [p[0], p[1]];
    })),
    height: round1(height),
    attenuationDbPerMeter: 0,
    slabOnly: false,
  };
}

/**
 * A flat triangle has no fourth corner Hamina would accept as one raised pad.
 * Three quads from the edge midpoints to the centroid cover it with no hole.
 * The shelf ramp is only the fallback when a quad would not be strictly convex.
 */
function coverFlatTriangle(pts, ramps, raised) {
  const z = round1(pts[0].z);
  const mids = [];
  for (let i = 0; i < 3; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 3];
    mids.push({ x: round3((a.x + b.x) / 2), y: round3((a.y + b.y) / 2) });
  }
  const g = {
    x: round3((pts[0].x + pts[1].x + pts[2].x) / 3),
    y: round3((pts[0].y + pts[1].y + pts[2].y) / 3),
  };
  const pads = [];
  for (let i = 0; i < 3; i++) {
    const a = pts[i];
    const mOut = mids[i];
    const mIn = mids[(i + 2) % 3];
    const pad = raisedFromRing(
      [
        [round3(a.x), round3(a.y)],
        [mOut.x, mOut.y],
        [g.x, g.y],
        [mIn.x, mIn.y],
      ],
      z
    );
    if (pad) pads.push(pad);
  }
  if (pads.length === 3 && raised) {
    for (let i = 0; i < pads.length; i++) raised.push(pads[i]);
    return;
  }
  let longest = 0;
  let iB = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.hypot(pts[(i + 1) % 3].x - pts[i].x, pts[(i + 1) % 3].y - pts[i].y);
    if (d > longest) {
      longest = d;
      iB = i;
    }
  }
  const B = pts[iB];
  const C = pts[(iB + 1) % 3];
  const A = pts[(iB + 2) % 3];
  const ab = Math.hypot(B.x - A.x, B.y - A.y);
  const ac = Math.hypot(C.x - A.x, C.y - A.y);
  if (!(ab > 0.2) || !(ac > 0.2)) return;
  const t = Math.max(0.04, Math.min(0.2, 0.35 / Math.min(ab, ac)));
  const hi = round1(B.z + 0.1);
  const S1 = { x: round3(A.x + (B.x - A.x) * t), y: round3(A.y + (B.y - A.y) * t), z: hi };
  const S2 = { x: round3(A.x + (C.x - A.x) * t), y: round3(A.y + (C.y - A.y) * t), z: hi };
  const ramp = tryRampPoints([
    { x: B.x, y: B.y, z: B.z },
    { x: C.x, y: C.y, z: C.z },
    S2,
    S1,
  ]);
  if (!ramp) return;
  const zone = slopedZone(ramp);
  if (zone) ramps.push(zone);
}

function contourPolysForQuad(corners, step) {
  const q = corners.map(function (p) {
    return { x: p.x, y: p.y, z: quantizeStep(p.z, step) };
  });
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < q.length; i++) {
    if (q[i].z < zmin) zmin = q[i].z;
    if (q[i].z > zmax) zmax = q[i].z;
  }
  if (zmax - zmin < SLOPED_FLAT_M) return [{ pts: q, flat: true, h: zmin }];
  const polys = [];
  for (let lo = zmin; lo < zmax - 1e-6; lo = round1(lo + step)) {
    const hi = round1(lo + step);
    let poly = q.map(function (p) {
      return { x: p.x, y: p.y, z: p.z };
    });
    poly = clipBandHalf(poly, lo, true);
    poly = clipBandHalf(poly, hi, false);
    poly = orientContour(dedupeContour(poly));
    if (poly.length >= 3) polys.push({ pts: poly, flat: false });
  }
  return polys;
}

function quadMid(a, b) {
  return {
    x: round3((a.x + b.x) / 2),
    y: round3((a.y + b.y) / 2),
    z: round1((a.z + b.z) / 2),
  };
}

/** |twist| / 4 is how far the bilinear center sits off either triangle plane. */
function quadPlaneError(corners) {
  const z0 = corners[0].z;
  const z1 = corners[1].z;
  const z2 = corners[2].z;
  const z3 = corners[3].z;
  return Math.abs(z0 + z2 - z1 - z3) / 4;
}

function splitPlanarQuad(corners) {
  const sw = corners[0];
  const se = corners[1];
  const ne = corners[2];
  const nw = corners[3];
  const south = quadMid(sw, se);
  const east = quadMid(se, ne);
  const north = quadMid(nw, ne);
  const west = quadMid(sw, nw);
  const center = {
    x: round3((sw.x + se.x + ne.x + nw.x) / 4),
    y: round3((sw.y + se.y + ne.y + nw.y) / 4),
    z: round1((sw.z + se.z + ne.z + nw.z) / 4),
  };
  return [
    [sw, south, center, west],
    [south, se, east, center],
    [center, east, ne, north],
    [west, center, north, nw],
  ];
}

function contourVertexKey(p) {
  return p.x.toFixed(3) + "," + p.y.toFixed(3);
}

/**
 * A coarse quad beside a split neighbor has the neighbor's midpoint on its
 * edge and no vertex of its own there. Split that quad so the shared edge
 * carries the same points. The new vertex is the bilinear midpoint, so the
 * two halves stay on the coarse edge.
 */
function balanceContourJunctions(leaves, leafCap) {
  let guard = 0;
  while (leaves.length + 3 <= leafCap && guard++ < 4000) {
    const verts = new Set();
    for (let i = 0; i < leaves.length; i++) {
      const corners = leaves[i].corners;
      for (let k = 0; k < 4; k++) verts.add(contourVertexKey(corners[k]));
    }
    let hit = -1;
    for (let i = 0; i < leaves.length && hit < 0; i++) {
      if (leaves[i].depth >= 5) continue;
      const corners = leaves[i].corners;
      for (let k = 0; k < 4; k++) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        const mid = quadMid(a, b);
        const key = contourVertexKey(mid);
        if (key === contourVertexKey(a) || key === contourVertexKey(b)) continue;
        if (verts.has(key)) {
          hit = i;
          break;
        }
      }
    }
    if (hit < 0) break;
    const parent = leaves[hit];
    const parts = splitPlanarQuad(parent.corners);
    leaves.splice(hit, 1);
    for (let i = 0; i < parts.length; i++) {
      leaves.push({
        corners: parts[i],
        err: quadPlaneError(parts[i]),
        depth: parent.depth + 1,
      });
    }
  }
}

/**
 * The paste starts from the regular lattice, then spends the remaining quad
 * budget on the worst saddles. A planar fit within about half a meter stops
 * the split. New vertices are the bilinear interpolant. A coarser neighbor
 * is split too when its edge runs into those vertices, so the seam has no
 * T-junction gap.
 */
function refineContourQuads(grid, step, leafCapOverride) {
  const errTarget = 0.5;
  const budget = Math.max(1, pastePlanQuadBudget());
  const baseLeaves = grid.cols * grid.rows;
  const leafCap =
    leafCapOverride > 0
      ? Math.max(baseLeaves, leafCapOverride | 0)
      : Math.max(baseLeaves, Math.min(budget, baseLeaves));
  // Error splits stop short of the leaf cap so a T-junction can still be
  // closed. balanceContourJunctions spends that remainder.
  const extra = Math.max(0, leafCap - baseLeaves);
  const errCap = baseLeaves + Math.floor(extra * 0.7);
  const leaves = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const corners = [at(grid, c, r), at(grid, c + 1, r), at(grid, c + 1, r + 1), at(grid, c, r + 1)].map(
        function (n) {
          return { x: n.x, y: n.y, z: quantizeStep(n.zRel, step) };
        }
      );
      leaves.push({ corners: corners, err: quadPlaneError(corners), depth: 0 });
    }
  }
  let guard = 0;
  while (leaves.length + 3 <= errCap && guard++ < 8000) {
    let worst = -1;
    let worstErr = errTarget;
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].depth >= 5) continue;
      if (leaves[i].err > worstErr) {
        worstErr = leaves[i].err;
        worst = i;
      }
    }
    if (worst < 0) break;
    const parent = leaves[worst];
    const parts = splitPlanarQuad(parent.corners);
    leaves.splice(worst, 1);
    for (let i = 0; i < parts.length; i++) {
      leaves.push({
        corners: parts[i],
        err: quadPlaneError(parts[i]),
        depth: parent.depth + 1,
      });
    }
  }
  // Close every T-junction even when that uses more leaves than the error
  // split asked for. The caller drops the mesh if the floor count then
  // passes the paste budget.
  balanceContourJunctions(leaves, leafCap);
  return leaves.map(function (leaf) {
    return leaf.corners;
  });
}

function mergeRaisedPads(raised) {
  let pads = raised.slice();
  for (let pass = 0; pass < 8; pass++) {
    const buckets = new Map();
    for (let i = 0; i < pads.length; i++) {
      const ring = pads[i].area.coordinates[0];
      if (!ring || ring.length < 4) continue;
      const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
      if (n !== 4) continue;
      for (let k = 0; k < 4; k++) {
        const key =
          pads[i].height.toFixed(1) +
          "|" +
          contourEdgeKey({ x: ring[k][0], y: ring[k][1] }, { x: ring[(k + 1) % 4][0], y: ring[(k + 1) % 4][1] });
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
    }
    const used = new Set();
    const next = [];
    let changed = false;
    for (const ids of buckets.values()) {
      if (ids.length !== 2 || used.has(ids[0]) || used.has(ids[1])) continue;
      const a = pads[ids[0]];
      const b = pads[ids[1]];
      if (a.height !== b.height) continue;
      const pa = a.area.coordinates[0].slice(0, 4).map(function (p) {
        return { x: p[0], y: p[1], z: a.height };
      });
      const pb = b.area.coordinates[0].slice(0, 4).map(function (p) {
        return { x: p[0], y: p[1], z: b.height };
      });
      const uni = mergeContourPolys(pa, pb);
      if (!uni) continue;
      const collapsed = collapseColinearContour(uni);
      if (collapsed.length !== 4) continue;
      const ring = collapsed.map(function (p) {
        return [p.x, p.y];
      });
      if (!pasteableQuad(ring)) continue;
      const area = contourArea(collapsed);
      const sum = contourArea(pa) + contourArea(pb);
      if (Math.abs(area - sum) > Math.max(1, 0.02 * sum)) continue;
      const pad = raisedFromRing(ring, a.height);
      if (!pad) continue;
      used.add(ids[0]);
      used.add(ids[1]);
      next.push(pad);
      changed = true;
    }
    for (let i = 0; i < pads.length; i++) {
      if (!used.has(i)) next.push(pads[i]);
    }
    pads = next;
    if (!changed) break;
  }
  return pads;
}

function pushCap(ramps, raised, cap) {
  const list = cap.ramps || (cap.ramp ? [cap.ramp] : []);
  for (let i = 0; i < list.length; i++) {
    const zone = slopedZone(list[i]);
    if (zone) ramps.push(zone);
  }
  if (cap.raised) {
    const pad = raisedFromRing(cap.raised.ring, cap.raised.h);
    if (pad) raised.push(pad);
  }
}

function contourTriSign(p, a, b) {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

function contourPointInTri(p, a, b, c) {
  const d1 = contourTriSign(p, a, b);
  const d2 = contourTriSign(p, b, c);
  const d3 = contourTriSign(p, c, a);
  const neg = d1 < -1e-8 || d2 < -1e-8 || d3 < -1e-8;
  const pos = d1 > 1e-8 || d2 > 1e-8 || d3 > 1e-8;
  return !(neg && pos);
}

/** Ears stay inside the ring. A fan from one corner would cross a concave band. */
function earClipContour(pts) {
  const poly = pts.slice();
  const tris = [];
  if (poly.length < 3) return tris;
  if (poly.length === 3) return [poly.slice()];
  let guard = poly.length * poly.length;
  while (poly.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length];
      const b = poly[i];
      const c = poly[(i + 1) % poly.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross <= 1e-4) continue;
      let inside = false;
      for (let k = 0; k < poly.length; k++) {
        if (sameContourPoint(poly[k], a) || sameContourPoint(poly[k], b) || sameContourPoint(poly[k], c)) continue;
        if (contourPointInTri(poly[k], a, b, c)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      tris.push([a, b, c]);
      poly.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (poly.length === 3) tris.push(poly.slice());
  return tris;
}

function contourTriFlat(tri) {
  return Math.max(tri[0].z, tri[1].z, tri[2].z) - Math.min(tri[0].z, tri[1].z, tri[2].z) < SLOPED_FLAT_M;
}

/**
 * A band that is not one ramp is cut into triangles. Each triangle keeps a
 * shelf inside itself, so the pieces meet the neighboring band on the shared
 * edge and do not paint the next cell.
 */
function coverContourPoly(pts, ramps, raised) {
  const tris = earClipContour(orientContour(pts.slice()));
  const pending = tris.map(function (t) {
    return { t: t, live: true };
  });
  for (let i = 0; i < pending.length; i++) {
    if (!pending[i].live || !contourTriFlat(pending[i].t)) continue;
    let merged = false;
    for (let j = 0; j < pending.length && !merged; j++) {
      if (i === j || !pending[j].live || contourTriFlat(pending[j].t)) continue;
      const flat = pending[i].t;
      const other = pending[j].t;
      for (let e = 0; e < 3 && !merged; e++) {
        const a = flat[e];
        const b = flat[(e + 1) % 3];
        const c = flat[(e + 2) % 3];
        for (let f = 0; f < 3; f++) {
          const p = other[f];
          const q = other[(f + 1) % 3];
          const shares = (sameContourPoint(a, p) && sameContourPoint(b, q)) || (sameContourPoint(a, q) && sameContourPoint(b, p));
          if (!shares) continue;
          const apex = other[(f + 2) % 3];
          if (apex.z === a.z && apex.z === b.z) continue;
          const left = capContourTriangle([apex, a, c]);
          const right = capContourTriangle([apex, c, b]);
          if (left) pushCap(ramps, raised, left);
          if (right) pushCap(ramps, raised, right);
          pending[i].live = false;
          pending[j].live = false;
          merged = true;
          break;
        }
      }
    }
  }
  for (let i = 0; i < pending.length; i++) {
    if (!pending[i].live || contourTriFlat(pending[i].t)) continue;
    const cap = capContourTriangle(pending[i].t);
    if (cap) pushCap(ramps, raised, cap);
  }
}

function contourPiecesAtStep(grid, step, leafCap) {
  const polys = [];
  const quads = refineContourQuads(grid, step, leafCap);
  for (let i = 0; i < quads.length; i++) {
    const corners = quads[i];
      const zmin = Math.min(corners[0].z, corners[1].z, corners[2].z, corners[3].z);
      const zmax = Math.max(corners[0].z, corners[1].z, corners[2].z, corners[3].z);
      // A saddle is not one plane. Two triangles are, and the shared diagonal
      // is the same line from both sides, so the bands meet instead of stacking.
      const leaves =
        zmax - zmin < SLOPED_FLAT_M
          ? [corners]
          : [
              [corners[0], corners[1], corners[2]],
              [corners[0], corners[2], corners[3]],
            ];
      for (let t = 0; t < leaves.length; t++) {
        const parts = contourPolysForQuad(leaves[t], step);
        for (let k = 0; k < parts.length; k++) polys.push(parts[k]);
      }
  }
  const alive = polys.map(function (p) {
    return { pts: p.pts, flat: p.flat, h: p.h, live: true };
  });
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const buckets = new Map();
    for (let i = 0; i < alive.length; i++) {
      if (!alive[i].live || alive[i].flat) continue;
      const pts = alive[i].pts;
      for (let k = 0; k < pts.length; k++) {
        const key = contourEdgeKey(pts[k], pts[(k + 1) % pts.length]);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
    }
    const used = new Set();
    for (const ids of buckets.values()) {
      if (ids.length !== 2) continue;
      const ia = ids[0];
      const ib = ids[1];
      if (used.has(ia) || used.has(ib) || !alive[ia].live || !alive[ib].live) continue;
      const za = bandHeights(alive[ia].pts);
      const zb = bandHeights(alive[ib].pts);
      if (!za || !zb || za[0] !== zb[0] || za[1] !== zb[1]) continue;
      const uni = mergeContourPolys(alive[ia].pts, alive[ib].pts);
      if (!uni) continue;
      const collapsed = collapseColinearContour(uni);
      if (collapsed.length !== 4 || !tryRampPoints(collapsed)) continue;
      const zu = bandHeights(collapsed);
      if (!zu || zu[0] !== za[0] || zu[1] !== za[1]) continue;
      const aArea = contourArea(alive[ia].pts);
      const bArea = contourArea(alive[ib].pts);
      const uArea = contourArea(collapsed);
      if (Math.abs(uArea - aArea - bArea) > Math.max(1, 0.05 * (aArea + bArea))) continue;
      alive[ia].live = false;
      alive[ib].live = false;
      alive.push({ pts: collapsed, flat: false, live: true });
      used.add(ia);
      used.add(ib);
      changed = true;
    }
    if (!changed) break;
  }
  const ramps = [];
  const raised = [];
  for (let i = 0; i < alive.length; i++) {
    const p = alive[i];
    if (!p.live) continue;
    const flat = p.flat || p.pts.every(function (q) {
      return Math.abs(q.z - p.pts[0].z) < SLOPED_FLAT_M;
    });
    if (flat) {
      if (p.pts.length === 4) {
        const pad = raisedFromRing(
          p.pts.map(function (q) {
            return [q.x, q.y];
          }),
          p.h != null ? p.h : p.pts[0].z
        );
        if (pad) raised.push(pad);
      } else if (p.pts.length === 3) coverFlatTriangle(p.pts, ramps, raised);
      continue;
    }
    const ramp = tryRampPoints(p.pts);
    if (ramp) {
      const zone = slopedZone(ramp);
      if (zone) ramps.push(zone);
      continue;
    }
    const stitched = stitchContourPoly(p.pts);
    if (stitched && stitched.length) {
      for (let k = 0; k < stitched.length; k++) {
        const zone = slopedZone(stitched[k]);
        if (zone) ramps.push(zone);
      }
      continue;
    }
    if (p.pts.length === 3) {
      const cap = capContourTriangle(p.pts);
      if (cap) pushCap(ramps, raised, cap);
      continue;
    }
    coverContourPoly(p.pts, ramps, raised);
  }
  return { ramps: ramps, raised: mergeRaisedPads(raised) };
}

function contourVertexGap(floors) {
  return slopeCornerGap(floors);
}

/**
 * Largest |dz| where a ramp corner sits on another ramp's edge but is not
 * that edge's endpoint. A regular lattice is 0. A split that balance did
 * not meet shows up here.
 */
function contourJunctionGap(floors) {
  const rings = [];
  for (let i = 0; i < (floors || []).length; i++) {
    const ring = floors[i].area && floors[i].area.coordinates && floors[i].area.coordinates[0];
    if (ring && ring.length >= 4 && ring[0].length >= 3) rings.push(ring);
  }
  if (rings.length < 2) return 0;
  const cell = 8;
  const buckets = new Map();
  for (let i = 0; i < rings.length; i++) {
    for (let e = 0; e < 4; e++) {
      const a = rings[i][e];
      const b = rings[i][(e + 1) % 4];
      const minX = Math.min(a[0], b[0]);
      const maxX = Math.max(a[0], b[0]);
      const minY = Math.min(a[1], b[1]);
      const maxY = Math.max(a[1], b[1]);
      for (let x = Math.floor((minX - 0.05) / cell); x <= Math.floor((maxX + 0.05) / cell); x++) {
        for (let y = Math.floor((minY - 0.05) / cell); y <= Math.floor((maxY + 0.05) / cell); y++) {
          const key = x + "," + y;
          let list = buckets.get(key);
          if (!list) {
            list = [];
            buckets.set(key, list);
          }
          list.push(i, e);
        }
      }
    }
  }
  let worst = 0;
  for (let i = 0; i < rings.length; i++) {
    for (let k = 0; k < 4; k++) {
      const p = rings[i][k];
      const cand = buckets.get(Math.floor(p[0] / cell) + "," + Math.floor(p[1] / cell));
      if (!cand) continue;
      for (let e = 0; e < cand.length; e += 2) {
        const ri = cand[e];
        if (ri === i) continue;
        const edge = cand[e + 1];
        const a = rings[ri][edge];
        const b = rings[ri][(edge + 1) % 4];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-4) continue;
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        if (t <= 0.02 || t >= 0.98) continue;
        const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
        if (d > 0.02) continue;
        const dz = Math.abs(p[2] - (a[2] + (b[2] - a[2]) * t));
        if (dz > worst) worst = dz;
      }
    }
  }
  return worst;
}

function contourCellSpan(grid, c, r) {
  const zs = [at(grid, c, r).zRel, at(grid, c + 1, r).zRel, at(grid, c + 1, r + 1).zRel, at(grid, c, r + 1).zRel];
  return Math.max(...zs) - Math.min(...zs);
}

/**
 * Lower bound on pieces at this band: one piece per band per cell. A step
 * whose lower bound already exceeds the floor cap is not built.
 */
function contourStepLoad(grid, step) {
  let n = 0;
  const band = step > 0 ? step : 1;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const span = contourCellSpan(grid, c, r);
      n += span < SLOPED_FLAT_M ? 1 : Math.max(1, Math.ceil(span / band));
    }
  }
  return n;
}

/**
 * Contour bands, the way the native pit paste is built: each ramp's low edge
 * and high edge are one height, and the next ramp picks up that same edge.
 * The finest band is 3 m on a mild hill and 5 m when a cell already spans
 * tens of meters. Steps of 6 to 8 m sit between 5 and 10 so a budget between
 * those bands can still be spent. One-meter bands filled thousands of floors.
 * Coarser steps, including one band for the whole cell, are the fallback
 * inside the floor cap.
 */
function contourStepsForGrid(grid) {
  let maxCell = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const span = contourCellSpan(grid, c, r);
      if (span > maxCell) maxCell = span;
    }
  }
  const ladder = maxCell > 40 ? [5, 6, 7, 8, 10, 20, 40, 80, 160, 320] : [3, 5, 6, 7, 8, 10, 20, 40, 80, 160];
  const cover = Math.max(ladder[0], Math.ceil(maxCell));
  const steps = [];
  for (let i = 0; i < ladder.length; i++) {
    if (ladder[i] < cover) steps.push(ladder[i]);
  }
  steps.push(cover);
  return steps;
}

function contourPieceCount(pieces) {
  if (!pieces) return 0;
  return (pieces.ramps ? pieces.ramps.length : 0) + (pieces.raised ? pieces.raised.length : 0);
}

function contourMeshFromGrid(grid, frame) {
  const budget = Math.max(1, pastePlanQuadBudget());
  const steps = contourStepsForGrid(grid);
  const base = Math.max(1, grid.cols * grid.rows);
  let chosen = null;
  for (let i = 0; i < steps.length; i++) {
    // One piece per band is a lower bound. Merges can land under the cap, so
    // a step is still built when that bound is only somewhat past the budget.
    if (contourStepLoad(grid, steps[i]) > budget * 2) continue;
    let cap = base;
    let pieces = contourPiecesAtStep(grid, steps[i], cap);
    let n = contourPieceCount(pieces);
    if (!n || n > budget) continue;
    // The finest band that fits at the lattice spends leftover floors on the
    // worst saddles. Binary search the leaf cap so one big split does not
    // jump past the budget and leave the spare unused.
    let lo = cap;
    let hi = cap + Math.max(8, (budget - n) * 4);
    let guard = 0;
    while (n < budget && hi > lo + 3 && guard++ < 8) {
      const mid = Math.max(lo + 4, Math.floor((lo + hi) / 2));
      if (mid <= lo) break;
      const trial = contourPiecesAtStep(grid, steps[i], mid);
      const tn = contourPieceCount(trial);
      if (tn > n && tn <= budget && contourJunctionGap(trial.ramps) <= 0.15) {
        pieces = trial;
        n = tn;
        lo = mid;
        cap = mid;
      } else if (!(tn > n)) {
        break;
      } else {
        hi = mid;
      }
    }
    chosen = { pieces: pieces, step: steps[i] };
    break;
  }
  if (!chosen) return null;
  const clip = emptyClipboard();
  clip.raisedFloorZones = chosen.pieces.raised;
  clip.slopedFloors = chosen.pieces.ramps;
  clip.attenuatingZones = [];
  stampGpsTiePoints(clip, frame);
  const err = contourError(grid, chosen.pieces.ramps, chosen.pieces.raised);
  return {
    grid: grid,
    clip: clip,
    raised: chosen.pieces.raised.length,
    sloped: chosen.pieces.ramps.length,
    slopeGapM: contourVertexGap(chosen.pieces.ramps),
    contourStepM: chosen.step,
    vertMeanM: err.mean,
    vertMaxM: err.max,
    cover: err.cover,
  };
}

function bilinearZ(grid, x, y) {
  const cols = grid.cols;
  const rows = grid.rows;
  const x0 = at(grid, 0, 0).x;
  const x1 = at(grid, cols, 0).x;
  const y0 = at(grid, 0, 0).y;
  const y1 = at(grid, 0, rows).y;
  const tx = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  const ty = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
  const fc = Math.max(0, Math.min(cols - 1e-6, tx * cols));
  const fr = Math.max(0, Math.min(rows - 1e-6, ty * rows));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const u = fc - c;
  const v = fr - r;
  const z00 = at(grid, c, r).zRel;
  const z10 = at(grid, c + 1, r).zRel;
  const z01 = at(grid, c, r + 1).zRel;
  const z11 = at(grid, c + 1, r + 1).zRel;
  return z00 + (z10 - z00) * u + (z01 - z00) * v + (z00 - z10 - z01 + z11) * u * v;
}

function ruledRampZ(ring, x, y) {
  const z0 = ring[0][2];
  const z1 = ring[2][2];
  let best = null;
  for (let k = 0; k <= 6; k++) {
    const s = k / 6;
    const ax = ring[0][0] * (1 - s) + ring[1][0] * s;
    const ay = ring[0][1] * (1 - s) + ring[1][1] * s;
    const bx = ring[3][0] * (1 - s) + ring[2][0] * s;
    const by = ring[3][1] * (1 - s) + ring[2][1] * s;
    const dx = bx - ax;
    const dy = by - ay;
    const den = dx * dx + dy * dy;
    const t = den > 0 ? ((x - ax) * dx + (y - ay) * dy) / den : 0;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
    if (!best || d2 < best.d2) best = { d2: d2, t: t };
  }
  const t = Math.max(0, Math.min(1, best.t));
  return z0 + (z1 - z0) * t;
}

function contourPointIn(ring, x, y) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi > y !== yj > y) {
      const xi = ring[i][0];
      const xj = ring[j][0];
      const xint = ((xj - xi) * (y - yi)) / (yj - yi || 1e-20) + xi;
      if (x < xint) hit = !hit;
    }
  }
  return hit;
}

function contourError(grid, ramps, raised) {
  let n = 0;
  let inside = 0;
  let sum = 0;
  let max = 0;
  const cols = grid.cols;
  const rows = grid.rows;
  const sub = 4;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let sr = 0; sr < sub; sr++) {
        for (let sc = 0; sc < sub; sc++) {
          const sw = at(grid, c, r);
          const se = at(grid, c + 1, r);
          const nw = at(grid, c, r + 1);
          const u = (sc + 0.5) / sub;
          const v = (sr + 0.5) / sub;
          const x = sw.x + (se.x - sw.x) * u;
          const y = sw.y + (nw.y - sw.y) * v;
          const zTrue = bilinearZ(grid, x, y);
          let zMesh = null;
          for (let i = 0; i < ramps.length; i++) {
            const ring = ramps[i].area.coordinates[0];
            if (contourPointIn(ring, x, y)) {
              zMesh = ruledRampZ(ring, x, y);
              break;
            }
          }
          if (zMesh == null) {
            for (let i = 0; i < raised.length; i++) {
              const ring = raised[i].area.coordinates[0];
              if (contourPointIn(ring, x, y)) {
                zMesh = raised[i].height;
                break;
              }
            }
          }
          n++;
          if (zMesh == null) continue;
          inside++;
          const e = Math.abs(zMesh - zTrue);
          sum += e;
          if (e > max) max = e;
        }
      }
    }
  }
  return {
    mean: n && inside ? Math.round((sum / inside) * 100) / 100 : 0,
    max: Math.round(max * 100) / 100,
    cover: n ? inside / n : 0,
  };
}

function cellRampMesh(grid, frame) {  const cols = grid.cols;
  const rows = grid.rows;
  const raised = [];
  const pending = [];
  const choices = [];
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
      if (z1 - z0 < SLOPED_FLAT_M) {
        const pad = raisedZone(sw, se, ne, nw, height);
        if (pad) raised.push(pad);
        continue;
      }
      const choice = rampChoice(sw, se, ne, nw);
      if (!choice.ns && !choice.ew) {
        const pad = raisedZone(sw, se, ne, nw, height);
        if (pad) raised.push(pad);
        continue;
      }
      pending.push({ sw, se, ne, nw, height });
      choices.push(choice);
    }
  }
  const axes = relaxRampAxes(choices);
  const sloped = [];
  for (let i = 0; i < pending.length; i++) {
    const cell = pending[i];
    const ramp = slopedZone(ringForAxis(choices[i], axes[i]));
    if (ramp) sloped.push(ramp);
    else {
      const pad = raisedZone(cell.sw, cell.se, cell.ne, cell.nw, cell.height);
      if (pad) raised.push(pad);
    }
  }
  if (!raised.length && !sloped.length) return null;
  const clip = emptyClipboard();
  clip.raisedFloorZones = raised;
  clip.slopedFloors = sloped;
  clip.attenuatingZones = [];
  stampGpsTiePoints(clip, frame);
  return {
    grid,
    clip,
    raised: raised.length,
    sloped: sloped.length,
    slopeGapM: slopeCornerGap(sloped),
  };
}

function buildRaisedLayerClipboard(samples, frame, cols, rows, elevationAt) {
  return raisedMeshFromGrid(lattice(samples, frame, cols, rows, elevationAt), frame);
}

function slopedMeshFromGrid(grid, frame) {
  if (grid && !axisAlignedGrid(grid)) {
    const contoured = contourMeshFromGrid(grid, frame);
    if (contoured && contoured.sloped + contoured.raised > 0) return contoured;
  }
  return cellRampMesh(grid, frame);
}

/**
 * Lower lattice nodes strictly inside a pond to that pond's shoreline.
 * A pond counts only when it covers a whole terrain cell and has a bank
 * outside that cell, so a puddle smaller than the mesh is left alone.
 * Nodes are only lowered. The mesh is rebuilt with the same planar ramps.
 * A ramp that would no longer be planar leaves the paste unchanged.
 * @param {object} terrain
 * @param {number[][][]} rings lon/lat rings
 * @returns {number} nodes lowered
 */
function depressWaterBasins(terrain, rings) {
  if (!terrain || terrain.pasteOmitted || !terrain.clipboard || !terrain.frame) return 0;
  if (!terrain.elevationAt || !terrain.samples) return 0;
  const cols = terrain.gridCols | 0;
  const rows = terrain.gridRows | 0;
  if (cols < 2 || rows < 2) return 0;
  const list = [];
  for (let i = 0; i < (rings || []).length; i++) {
    const ring = rings[i];
    if (ring && ring.length >= 4) list.push(ring);
  }
  if (!list.length) return 0;
  const frame = terrain.frame;
  const grid = lattice(terrain.samples, frame, cols, rows, terrain.elevationAt);
  const inside = new Uint8Array(grid.nodes.length);
  // Clipboard point-in-ring uses a meter epsilon. These nodes are degrees.
  function lonLatInside(lon, lat, ring) {
    let n = ring.length;
    const a = ring[0];
    const b = ring[n - 1];
    if (a && b && a[0] === b[0] && a[1] === b[1]) n -= 1;
    if (n < 3) return false;
    let hit = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i][1];
      const yj = ring[j][1];
      if (yi > lat !== yj > lat) {
        const xi = ring[i][0];
        const xj = ring[j][0];
        const x = ((xj - xi) * (lat - yi)) / (yj - yi || 1e-20) + xi;
        if (lon < x) hit = !hit;
      }
    }
    return hit;
  }
  let lowered = 0;
  for (let i = 0; i < list.length; i++) {
    const ring = list[i];
    inside.fill(0);
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const lon = frame.west + (c / cols) * (frame.east - frame.west);
        const lat = frame.south + (r / rows) * (frame.north - frame.south);
        if (lonLatInside(lon, lat, ring)) inside[r * (cols + 1) + c] = 1;
      }
    }
    let full = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ids = [
          r * (cols + 1) + c,
          r * (cols + 1) + (c + 1),
          (r + 1) * (cols + 1) + (c + 1),
          (r + 1) * (cols + 1) + c,
        ];
        let nIn = 0;
        for (let k = 0; k < 4; k++) if (inside[ids[k]]) nIn++;
        if (nIn === 4) full = true;
      }
    }
    if (!full) continue;
    const stride = cols + 1;
    const shore = new Uint8Array(inside.length);
    let bank = Infinity;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const id = r * stride + c;
        if (!inside[id]) continue;
        const edge =
          (c > 0 && !inside[id - 1]) ||
          (c < cols && !inside[id + 1]) ||
          (r > 0 && !inside[id - stride]) ||
          (r < rows && !inside[id + stride]);
        if (!edge) continue;
        shore[id] = 1;
        const z = grid.nodes[id].zRel;
        if (z < bank) bank = z;
      }
    }
    if (!(bank < Infinity)) continue;
    for (let n = 0; n < inside.length; n++) {
      if (!inside[n] || shore[n]) continue;
      const node = grid.nodes[n];
      if (node.zRel > bank + 1e-6) {
        node.zRel = bank;
        node.z = grid.minZ + bank;
        lowered++;
      }
    }
  }
  if (!lowered) return 0;
  const raisedStyle = terrain.terrainStyle === "raised";
  const mesh = raisedStyle ? raisedMeshFromGrid(grid, frame) : slopedMeshFromGrid(grid, frame);
  if (!mesh || !mesh.clip) return 0;
  const floors = mesh.clip.slopedFloors || [];
  for (let i = 0; i < floors.length; i++) {
    const ring = floors[i].area && floors[i].area.coordinates && floors[i].area.coordinates[0];
    if (ring && !planarSlopedRamp(ring)) return 0;
  }
  terrain.clipboard = mesh.clip;
  terrain.raised = mesh.raised;
  terrain.sloped = mesh.sloped;
  terrain.slopeGapM = mesh.slopeGapM || 0;
  if (mesh.bandM != null) terrain.bandM = mesh.bandM;
  return lowered;
}

/**
 * The planned paste is often 20×20. When the DEM posting is finer, the
 * contour mesh starts on that posting (capped) and the adaptive split spends
 * the paste budget there instead of on the coarse lattice.
 */
function denserContourLattice(samples, frame, cols, rows, elevationAt) {
  const budget = Math.max(1, pastePlanQuadBudget());
  const n = samples && samples.length ? samples.length : 0;
  const side = Math.max(2, Math.round(Math.sqrt(Math.max(4, n))));
  const long = Math.max(cols, rows, 1);
  if (side <= long + 1 || cols * rows >= budget) return lattice(samples, frame, cols, rows, elevationAt);
  const cap = 40;
  const aspect = cols / Math.max(1, rows);
  let c = Math.min(cap, Math.max(cols, Math.round(Math.sqrt(side * side * aspect))));
  let r = Math.min(cap, Math.max(rows, Math.round(side * side / Math.max(1, c))));
  c = Math.max(1, Math.min(cap, c));
  r = Math.max(1, Math.min(cap, r));
  while (c * r > budget && (c > cols || r > rows)) {
    if (c >= r && c > cols) c -= 1;
    else if (r > rows) r -= 1;
    else if (c > cols) c -= 1;
    else break;
  }
  return lattice(samples, frame, c, r, elevationAt);
}

function contourFits(mesh, budget) {
  if (!mesh) return false;
  const n = (mesh.sloped || 0) + (mesh.raised || 0);
  return n > 0 && n <= budget;
}

function buildTerrainClipboard(samples, frame, cols, rows, elevationAt, legacy) {
  const grid = lattice(samples, frame, cols, rows, elevationAt);
  if (!legacy && !axisAlignedGrid(grid)) {
    const budget = Math.max(1, pastePlanQuadBudget());
    const dense = denserContourLattice(samples, frame, cols, rows, elevationAt);
    const sources = dense.cols === grid.cols && dense.rows === grid.rows ? [grid] : [dense, grid];
    let best = null;
    for (let i = 0; i < sources.length; i++) {
      const contoured = contourMeshFromGrid(sources[i], frame);
      if (!contourFits(contoured, budget)) continue;
      if (!best) {
        best = contoured;
        continue;
      }
      const step = contoured.contourStepM || 99;
      const bestStep = best.contourStepM || 99;
      const err = contoured.vertMaxM == null ? 99 : contoured.vertMaxM;
      const bestErr = best.vertMaxM == null ? 99 : best.vertMaxM;
      if (step < bestStep - 1e-6 || (step === bestStep && err < bestErr)) best = contoured;
    }
    if (best) return best;
    // A 20×20 of steep cells can still exceed the floor cap at the coarsest
    // band. Halve the lattice until a watertight contour fits.
    let c = grid.cols;
    let r = grid.rows;
    let guard = 0;
    while (guard++ < 6) {
      const fitted = fitPasteAxes(c, r, Math.max(1, Math.floor((c * r) / 2)));
      if (fitted[0] === c && fitted[1] === r) break;
      c = fitted[0];
      r = fitted[1];
      const coarse = lattice(samples, frame, c, r, elevationAt);
      if (axisAlignedGrid(coarse)) break;
      const mesh = contourMeshFromGrid(coarse, frame);
      if (contourFits(mesh, budget)) return mesh;
    }
  }
  return cellRampMesh(grid, frame);
}

/**
 * @param {{lon:number,lat:number,z:number}[]} samples
 * @param {object} frame geo frame with west/south/east/north and meter scale
 * @param {{terrainResolution?: string, kind?: string, attribution?: string}} [opts]
 */
function terrainFromSamples(samples, frame, opts) {
  const prevPasteFloors = activePasteFloors;
  activePasteFloors = terrainPasteFloorCap(opts);
  try {
    return terrainFromSamplesCapped(samples, frame, opts);
  } finally {
    activePasteFloors = prevPasteFloors;
  }
}

function terrainFromSamplesCapped(samples, frame, opts) {
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
  const style = normalizeTerrainStyle(opts && opts.terrainStyle);
  const reliefM = maxS - minS;
  let [cols, rows] = chooseGrid(reliefM, frame, preset.id);
  const requestedCols = cols;
  const requestedRows = rows;
  const highLat = highLatMeterFrame(frame);
  // A Finland 1 m town is experimental even under 20 m of relief, so the
  // paste budget still coarsens it instead of building a 500-wide lattice.
  const skiExperimental = !!(preset.experimental && (reliefM >= LIFT_RELIEF_M || highLat));
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
      style,
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
  if (jsonMax > 0 && cols * rows > pastePlanQuadBudget(jsonMax)) {
    const cap = pastePlanQuadBudget(jsonMax);
    const fitted = fitPasteAxes(cols, rows, cap);
    cols = fitted[0];
    rows = fitted[1];
  }
  function settleRaised(c, r) {
    let mesh = buildRaisedLayerClipboard(clean, frame, c, r, elevationAt);
    let guard = 0;
    while (mesh && mesh.raised > RAISED_FLOOR_MAX && guard < 8) {
      const fitted = fitPasteAxes(c, r, Math.max(1, Math.floor((c * r) / 4)));
      if (fitted[0] === c && fitted[1] === r) break;
      c = fitted[0];
      r = fitted[1];
      mesh = buildRaisedLayerClipboard(clean, frame, c, r, elevationAt);
      guard += 1;
    }
    return { mesh, cols: c, rows: r };
  }
  function rebuild(c, r) {
    if (style === "sloped") {
      return {
        mesh: buildTerrainClipboard(clean, frame, c, r, elevationAt, opts && opts.legacyMesh),
        cols: c,
        rows: r,
      };
    }
    return settleRaised(c, r);
  }
  let builtMesh = rebuild(cols, rows);
  let mesh = builtMesh.mesh;
  cols = builtMesh.cols;
  rows = builtMesh.rows;
  if (!mesh) return null;
  function omitFields() {
    return {
      clean,
      frame,
      preset,
      style,
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
      builtMesh = rebuild(fitted[0], fitted[1]);
      mesh = builtMesh.mesh;
      cols = builtMesh.cols;
      rows = builtMesh.rows;
      if (!mesh) return null;
      jsonLen = JSON.stringify(mesh.clip).length;
      guard += 1;
    }
  }
  const byteMax = pasteByteCap();
  let byteGuard = 0;
  let pasteBytes = JSON.stringify(mesh.clip).length;
  while (pasteBytes > byteMax && byteGuard < 6) {
    const floors = (mesh.sloped || 0) + (mesh.raised || 0);
    const nextFloors = Math.max(TERRAIN_FLOORS_MIN, Math.floor((floors * byteMax) / pasteBytes * 0.92));
    if (!(nextFloors < floors)) break;
    activePasteFloors = Math.min(activePasteFloors, nextFloors);
    const fitted = fitPasteAxes(cols, rows, Math.max(1, nextFloors));
    if (fitted[0] === cols && fitted[1] === rows) break;
    builtMesh = rebuild(fitted[0], fitted[1]);
    mesh = builtMesh.mesh;
    cols = builtMesh.cols;
    rows = builtMesh.rows;
    if (!mesh || !mesh.clip) return null;
    pasteBytes = JSON.stringify(mesh.clip).length;
    byteGuard += 1;
  }
  const cellM = reportedCellM(preset, reliefM, highLat, widthM, lengthM, cols, rows);
  const pasteReduced = skiExperimental && (cols !== requestedCols || rows !== requestedRows);
  return {
    reliefM: Math.round((maxS - minS) * 10) / 10,
    minZ: Math.round(minS * 10) / 10,
    maxZ: Math.round(maxS * 10) / 10,
    terrainResolution: preset.id,
    terrainStyle: style,
    bandM: mesh.bandM,
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
    slopeGapM: mesh.slopeGapM || 0,
    contourStepM: mesh.contourStepM,
    vertMeanM: mesh.vertMeanM,
    vertMaxM: mesh.vertMaxM,
    frame,
    // datumZ is the lowest DEM sample. Raised floors, sloped-floor z, and
    // building bottoms are meters above it. Larger z is higher ground.
    datumZ: mesh.grid.minZ,
    haminaSlopeDatumM: 0,
  };
}

function omittedPaste(src) {
  const widthM = src.frame && src.frame.widthM > 0 ? src.frame.widthM : 800;
  const lengthM = src.frame && src.frame.lengthM > 0 ? src.frame.lengthM : 800;
  const cellM = reportedCellM(
    src.preset,
    src.reliefM,
    highLatMeterFrame(src.frame),
    widthM,
    lengthM,
    src.cols,
    src.rows
  );
  return {
    reliefM: Math.round(src.reliefM * 10) / 10,
    minZ: Math.round(src.minS * 10) / 10,
    maxZ: Math.round(src.maxS * 10) / 10,
    terrainResolution: src.preset.id,
    terrainStyle: src.style || "sloped",
    bandM: src.mesh && src.mesh.bandM,
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

/**
 * A footprint that only shares a cell edge still has to clear that cell.
 * Lattice nodes are rounded to 1 cm, so a strict box test drops the shared
 * edge and the higher ramp wins in Hamina while the object stays low.
 */
const FLOOR_TOUCH_M = 0.25;

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
  return aL <= bR + FLOOR_TOUCH_M && aR + FLOOR_TOUCH_M >= bL && aB <= bT + FLOOR_TOUCH_M && aT + FLOOR_TOUCH_M >= bB;
}

/**
 * Stored ramp z at one clipboard point. Edge 0–1 is the smaller stored z
 * and edge 2–3 is the larger. Corners on one edge can differ; the height is
 * bilinear between those four values. Opposite of vertex 0 is vertex 3.
 */
function storedRampZ(ring, x, y) {
  const zLo = ring[0][2];
  const zHi = ring[2][2];
  const p = ring[0];
  const q = ring[1];
  const r = ring[2];
  const ux = q[0] - p[0];
  const uy = q[1] - p[1];
  const uz = q[2] - p[2];
  const vx = r[0] - p[0];
  const vy = r[1] - p[1];
  const vz = r[2] - p[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  let z = p[2];
  if (Math.abs(nz) > 1e-8) z = p[2] - (nx * (x - p[0]) + ny * (y - p[1])) / nz;
  if (z < zLo) z = zLo;
  else if (z > zHi) z = zHi;
  return z;
}

/**
 * Visible floor height at one clipboard point, meters above the lowest
 * sample. A raised pad stores that height. A ramp stores the same height:
 * the low edge is the smaller z and the high edge is the larger z.
 */
function pastedFloorZ(zone, x, y) {
  const ring = zone.area && zone.area.coordinates && zone.area.coordinates[0];
  if (!ring || ring.length < 4) return 0;
  if (ring[0].length < 3) return Number(zone.height) || 0;
  return round1(storedRampZ(ring, x, y));
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

function floorZones(terrain) {
  const clip = terrain && terrain.clipboard;
  if (!clip) return [];
  const zones = [];
  const sloped = clip.slopedFloors || [];
  const raised = clip.raisedFloorZones || [];
  for (let i = 0; i < sloped.length; i++) zones.push(sloped[i]);
  for (let i = 0; i < raised.length; i++) zones.push(raised[i]);
  return zones;
}

/**
 * Lattice nodes are rounded to 0.001 m, so a footprint edge that should lie on
 * a cell boundary can sit a fraction of a millimeter off that quad. Hamina
 * still draws the higher ramp or plate through that wall. Treat a gap this
 * small as the floor under the object.
 */
const FLOOR_EDGE_M = 0.05;

function quadBox(quad) {
  const n = Math.min(ringPointCount(quad), 4);
  let L = Infinity;
  let R = -Infinity;
  let B = Infinity;
  let T = -Infinity;
  for (let i = 0; i < n; i++) {
    if (quad[i][0] < L) L = quad[i][0];
    if (quad[i][0] > R) R = quad[i][0];
    if (quad[i][1] < B) B = quad[i][1];
    if (quad[i][1] > T) T = quad[i][1];
  }
  return { L, R, B, T };
}

function dist2ToRing(ring, x, y) {
  if (pointInOrOnRing(x, y, ring)) return 0;
  const n = ringPointCount(ring);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < best) best = d2;
  }
  return best;
}

/**
 * Visible pasted floor at one clipboard point. Raised plates stack, so the
 * floor Hamina draws is the highest plate at that point, not a plate buried
 * under it. A ramp is one z. A point a few centimeters off a quad still uses
 * the height on that edge.
 */
function visiblePastedFloorZ(terrain, zones, x, y) {
  const edge2 = FLOOR_EDGE_M * FLOOR_EDGE_M;
  let best = null;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const quad = zone.area && zone.area.coordinates && zone.area.coordinates[0];
    if (!quad || quad.length < 4) continue;
    const box = quadBox(quad);
    if (x < box.L - FLOOR_EDGE_M || x > box.R + FLOOR_EDGE_M || y < box.B - FLOOR_EDGE_M || y > box.T + FLOOR_EDGE_M) {
      continue;
    }
    // A rotated ramp's box contains the neighbor. Only the quad itself, or a
    // point a few centimeters off its edge, is that floor.
    if (dist2ToRing(quad, x, y) > edge2) continue;
    const z = pastedFloorZ(zone, x, y);
    if (!Number.isFinite(z)) continue;
    if (best == null || z > best) best = z;
  }
  return best;
}

/**
 * Highest and lowest visible pasted floor on the footprint.
 * Hamina draws a sloped cell as a ramp. The stored z is meters above the
 * lowest sample, larger z higher. The low sample is where a building meets
 * the hill. The high
 * sample is the uphill end of the same ramp. A shared boundary uses the
 * height at that edge, not the far corner of the next cell.
 */
function pastedFloorExtent(terrain, xy) {
  const zones = floorZones(terrain);
  if (!zones.length || !xy || xy.length < 3) return null;
  const edge2 = FLOOR_EDGE_M * FLOOR_EDGE_M;
  const pts = [];
  const nv = ringPointCount(xy);
  for (let k = 0; k < nv; k++) pts.push(xy[k]);
  for (let i = 0; i < zones.length; i++) {
    const quad = zones[i].area && zones[i].area.coordinates && zones[i].area.coordinates[0];
    if (!quad || quad.length < 4 || !boundsOverlap(xy, quad)) continue;
    const over = overlapVertices(xy, quad);
    for (let k = 0; k < over.length; k++) pts.push(over[k]);
    const nq = Math.min(ringPointCount(quad), 4);
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < nq; k++) {
      const x = quad[k][0];
      const y = quad[k][1];
      sx += x;
      sy += y;
      // A corner in the middle of the footprint is the high or low point of
      // that quad. The edge test misses it, and the seat then floats or digs.
      if (dist2ToRing(xy, x, y) > edge2 && !pointInOrOnRing(x, y, xy)) continue;
      pts.push([x, y]);
      const b = quad[(k + 1) % nq];
      const mx = (x + b[0]) / 2;
      const my = (y + b[1]) / 2;
      if (pointInOrOnRing(mx, my, xy)) pts.push([mx, my]);
    }
    const cx = sx / nq;
    const cy = sy / nq;
    if (pointInOrOnRing(cx, cy, xy)) pts.push([cx, cy]);
  }
  if (xy.length >= 3) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const nv = ringPointCount(xy);
    for (let i = 0; i < nv; i++) {
      if (xy[i][0] < minX) minX = xy[i][0];
      if (xy[i][0] > maxX) maxX = xy[i][0];
      if (xy[i][1] < minY) minY = xy[i][1];
      if (xy[i][1] > maxY) maxY = xy[i][1];
    }
    const g = 4;
    for (let gy = 0; gy <= g; gy++) {
      for (let gx = 0; gx <= g; gx++) {
        const x = minX + (gx / g) * (maxX - minX);
        const y = minY + (gy / g) * (maxY - minY);
        if (pointInOrOnRing(x, y, xy)) pts.push([x, y]);
      }
    }
  }
  let max = 0;
  let min = Infinity;
  let n = 0;
  for (let k = 0; k < pts.length; k++) {
    const z = visiblePastedFloorZ(terrain, zones, pts[k][0], pts[k][1]);
    if (z == null) continue;
    if (z > max) max = z;
    if (z < min) min = z;
    n++;
  }
  if (!n) return null;
  return { min, max };
}

/**
 * Raw min/max of the floor under a lon/lat ring, before tenth rounding.
 * When a mesh was pasted, this is the ramp or plate Hamina draws, not a DEM
 * sample that sits off that plane. Without a paste, it is the DEM under the
 * ring vertices and the centroid.
 */
function floorExtentUnderRing(terrain, ring) {
  if (!terrain || !ring || ring.length < 3) return { min: 0, max: 0 };
  const frame = terrain.frame;
  const xy = frame ? ringToClipboard(ring, frame) : [];
  const pasted = pastedFloorExtent(terrain, xy);
  if (pasted) return { min: pasted.min, max: pasted.max };
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const end = closed ? ring.length - 1 : ring.length;
  let max = 0;
  let min = Infinity;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < end; i++) {
    const z = terrainGroundM(terrain, ring[i][0], ring[i][1]);
    if (z > max) max = z;
    if (z < min) min = z;
    sx += +ring[i][0];
    sy += +ring[i][1];
  }
  if (end > 0) {
    const zc = terrainGroundM(terrain, sx / end, sy / end);
    if (zc > max) max = zc;
    if (zc < min) min = zc;
  }
  if (!(min < Infinity)) min = 0;
  return { min, max };
}

/** Round a slope top up to the next 0.1 m so the object is not left under the sample. */
function roundUpTenth(n) {
  const down = round1(n);
  if (down + 1e-6 < n) return round1(down + 0.1);
  return down;
}

/**
 * Uphill surface under a lon/lat ring, in terrain-clipboard meters.
 * High end of the ramp under the ring, in meters above the lowest sample,
 * rounded up to 0.1 m. That height is the ground Planner Plus shows. A cell
 * the ring only shares a
 * boundary with counts as the height at that boundary.
 */
function slopeTopUnderRing(terrain, ring) {
  return roundUpTenth(floorExtentUnderRing(terrain, ring).max);
}

/** Round a downhill seat down to 0.1 m so the box meets or enters the hill. */
function roundDownTenth(n) {
  if (!(n > 0)) return 0;
  return Math.floor(n * 10 + 1e-6) / 10;
}

/**
 * Downhill surface under a lon/lat ring. A building bottom at the uphill end
 * of the same ramp floats, and the downhill face hangs above the slope.
 * This seat is where that face meets the hill. Flat ground under 1 m still
 * omits bottom_height in the lifter, so a level pad is not pushed underground.
 */
function slopeSeatUnderRing(terrain, ring) {
  return roundDownTenth(floorExtentUnderRing(terrain, ring).min);
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
 * Split a footprint when the slope under it rises more than this.
 * Each piece then keeps the measured height above its own downhill ground,
 * so the roof is not buried in the uphill side of a long ramp.
 */
const SPLIT_FLOOR_M = 2.5;
const SPLIT_MAX_PIECES = 12;

function closeClipRing(open) {
  if (!open || open.length < 3) return null;
  const ring = open.map((p) => [p[0], p[1]]);
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
  return ring;
}

function meterAreaAbs(ring) {
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : ring.length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function pointInClipQuad(quad, x, y) {
  const n = Math.min(ringPointCount(quad), 4);
  if (n < 3) return false;
  for (let k = 0; k < n; k++) {
    const a = quad[k];
    const b = quad[(k + 1) % n];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const tol = 0.05 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
    if (cross < -tol) return false;
  }
  return true;
}

function terrainFloorCells(terrain) {
  if (terrain._floorCells) return terrain._floorCells;
  const frame = terrain.frame;
  const cols = terrain.gridCols | 0;
  const rows = terrain.gridRows | 0;
  const cells = [];
  if (!frame || cols < 1 || rows < 1) {
    terrain._floorCells = cells;
    return cells;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const corners = [
        [c, r],
        [c + 1, r],
        [c + 1, r + 1],
        [c, r + 1],
      ].map(([cc, rr]) => {
        const lon = frame.west + (cc / cols) * (frame.east - frame.west);
        const lat = frame.south + (rr / rows) * (frame.north - frame.south);
        const xy = llToClipboard(lon, lat, frame);
        return { lon, lat, xy };
      });
      const center = [
        (corners[0].xy[0] + corners[2].xy[0]) / 2,
        (corners[0].xy[1] + corners[2].xy[1]) / 2,
      ];
      let z = terrainGroundM(
        terrain,
        (corners[0].lon + corners[2].lon) / 2,
        (corners[0].lat + corners[2].lat) / 2
      );
      const own = floorZones(terrain);
      for (let i = 0; i < own.length; i++) {
        const quad = own[i].area && own[i].area.coordinates && own[i].area.coordinates[0];
        if (!quad || !pointInClipQuad(quad, center[0], center[1])) continue;
        const samples = [center, corners[0].xy, corners[1].xy, corners[2].xy, corners[3].xy];
        for (let k = 0; k < samples.length; k++) {
          if (k > 0 && !pointInClipQuad(quad, samples[k][0], samples[k][1])) continue;
          const fz = pastedFloorZ(own[i], samples[k][0], samples[k][1]);
          if (fz > z) z = fz;
        }
      }
      const clip = closeClipRing(corners.map((p) => p.xy));
      if (clip) cells.push({ clip, z });
    }
  }
  terrain._floorCells = cells;
  return cells;
}

/** One strip of a pasted ramp, from t0 to t1 along the grade. t = 0 is the low edge. */
function rampStrip(quad, t0, t1) {
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return closeClipRing([
    lerp(quad[0], quad[3], t0),
    lerp(quad[1], quad[2], t0),
    lerp(quad[1], quad[2], t1),
    lerp(quad[0], quad[3], t1),
  ]);
}

/**
 * Sloped cells cut into grade strips of about `band` meters. One coarse cell
 * can still rise many meters, and a building seated on that whole ramp would
 * bury its roof in the uphill end. Raised plates stay one cell high.
 */
function raisedStrips(terrain) {
  const floors = (terrain.clipboard && terrain.clipboard.raisedFloorZones) || [];
  const strips = [];
  for (let i = 0; i < floors.length; i++) {
    const zone = floors[i];
    const quad = zone.area && zone.area.coordinates && zone.area.coordinates[0];
    if (!quad || quad.length < 4) continue;
    const clip = closeClipRing(
      quad.map(function (p) {
        return [p[0], p[1]];
      })
    );
    if (!clip) continue;
    strips.push({ clip: clip, z: round1(Number(zone.height) || 0) });
  }
  return strips;
}

function rampStrips(terrain, band) {
  const floors = (terrain.clipboard && terrain.clipboard.slopedFloors) || [];
  const step = band > 0 ? band : SPLIT_FLOOR_M;
  const strips = [];
  for (let i = 0; i < floors.length; i++) {
    const quad = floors[i].area && floors[i].area.coordinates && floors[i].area.coordinates[0];
    if (!quad || quad.length < 4 || !quad[0] || quad[0].length < 3) continue;
    const zs = [quad[0][2], quad[1][2], quad[2][2], quad[3][2]];
    let zLo = zs[0];
    let zHi = zs[0];
    for (let k = 1; k < 4; k++) {
      if (zs[k] < zLo) zLo = zs[k];
      if (zs[k] > zHi) zHi = zs[k];
    }
    const rise = zHi - zLo;
    if (!(rise > 0)) continue;
    const n = Math.max(1, Math.ceil(rise / step - 1e-9));
    for (let s = 0; s < n; s++) {
      const t0 = s / n;
      const t1 = (s + 1) / n;
      const clip = rampStrip(quad, t0, t1);
      if (!clip) continue;
      // t = 0 is the low edge. The strip's seat is that downhill edge.
      const zA = quad[0][2] * (1 - t0) + quad[3][2] * t0;
      const zB = quad[1][2] * (1 - t0) + quad[2][2] * t0;
      strips.push({ clip, z: round1((zA + zB) / 2) });
    }
  }
  return strips;
}

function ringsFromClipGeom(geom, frame, minArea) {
  const floor = minArea > 0 ? minArea : 30;
  const out = [];
  for (const poly of geom || []) {
    const ring = poly && poly[0];
    if (!ring || ring.length < 4) continue;
    if (meterAreaAbs(ring) < floor) continue;
    const ll = [];
    for (let i = 0; i < ring.length; i++) {
      const p = clipboardToLl(ring[i][0], ring[i][1], frame);
      if (!ll.length || p[0] !== ll[ll.length - 1][0] || p[1] !== ll[ll.length - 1][1]) ll.push(p);
    }
    if (ll.length >= 3 && (ll[0][0] !== ll[ll.length - 1][0] || ll[0][1] !== ll[ll.length - 1][1])) {
      ll.push([ll[0][0], ll[0][1]]);
    }
    if (ll.length >= 4) out.push(ll);
  }
  return out;
}

function pieceClipboardArea(ring, frame) {
  return meterAreaAbs(ringToClipboard(ring, frame));
}

/** Largest pieces first, so a cap keeps the woods instead of a sliver. */
function largestPieces(pieces, maxPieces, frame) {
  const ranked = [];
  for (let i = 0; i < pieces.length; i++) {
    const a = pieceClipboardArea(pieces[i], frame);
    if (a > 0) ranked.push({ ring: pieces[i], a });
  }
  ranked.sort((p, q) => q.a - p.a);
  const out = [];
  const n = Math.min(ranked.length, maxPieces);
  for (let i = 0; i < n; i++) out.push(ranked[i].ring);
  return out;
}

/**
 * One piece per terrain cell is enough for a hill. More than that spends the
 * area cap on one woods. A small mesh still gets several bands.
 */
function canopyPieceCap(terrain) {
  const cells = Math.max(0, (terrain && terrain.gridCols) | 0) * Math.max(0, (terrain && terrain.gridRows) | 0);
  if (!(cells >= 4)) return 160;
  return Math.min(280, Math.max(48, cells));
}

/**
 * One bottom height is the downhill ground under that piece. A footprint
 * that climbs more than SPLIT_FLOOR_M is cut along the pasted ramps so each
 * piece meets its own downhill ground and the roof stays near the measured
 * height above that ground. A mild rise stays one ring. The original ring is
 * returned when a cut would drop most of the footprint.
 * opts.maxPieces raises the cap for a hill-sized canopy. opts.keepPartial
 * keeps those pieces when a woods would otherwise collapse back to one ring
 * seated on the summit.
 */
function splitRingByFloor(terrain, ring, opts) {
  const maxPieces = opts && opts.maxPieces > 1 ? opts.maxPieces | 0 : SPLIT_MAX_PIECES;
  const keepPartial = !!(opts && opts.keepPartial);
  if (!terrain || !ring || ring.length < 4) return [ring];
  const extent = floorExtentUnderRing(terrain, ring);
  if (!(extent.max - extent.min > SPLIT_FLOOR_M)) return [ring];
  const frame = terrain.frame;
  const xy = frame ? ringToClipboard(ring, frame) : [];
  const bldg = closeClipRing(xy);
  if (!bldg) return [ring];
  const hostArea = meterAreaAbs(bldg);
  const useRamps =
    terrain.clipboard && terrain.clipboard.slopedFloors && terrain.clipboard.slopedFloors.length > 0;
  function ringsFromGroups(groups) {
    const pieces = [];
    for (const group of groups.values()) {
      let mask = null;
      for (let i = 0; i < group.length; i++) {
        try {
          mask = mask ? polygonClipping.union(mask, [[group[i].clip]]) : [[group[i].clip]];
        } catch {
          mask = null;
          break;
        }
      }
      if (!mask) continue;
      let hit;
      try {
        hit = polygonClipping.intersection([[bldg]], mask);
      } catch {
        continue;
      }
      const rings = ringsFromClipGeom(hit, frame, keepPartial ? 12 : 30);
      for (let i = 0; i < rings.length; i++) pieces.push(rings[i]);
    }
    return pieces;
  }
  let band = SPLIT_FLOOR_M;
  let groups = null;
  let pieces = null;
  while (band < 80) {
    const cells = (useRamps ? rampStrips(terrain, band).concat(raisedStrips(terrain)) : terrainFloorCells(terrain)).filter(
      (cell) => boundsOverlap(xy, cell.clip)
    );
    if (cells.length < 2) {
      if (!groups) return [ring];
      break;
    }
    groups = new Map();
    for (let i = 0; i < cells.length; i++) {
      const key = Math.round(cells[i].z / band);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cells[i]);
    }
    // One height group can clip into several rings. Widen until the rings
    // that actually ship stay inside the piece cap.
    if (groups.size > maxPieces) {
      band *= 2;
      continue;
    }
    pieces = ringsFromGroups(groups);
    if (pieces.length <= maxPieces) break;
    pieces = null;
    band *= 2;
  }
  if ((!pieces || pieces.length < 2) && groups && groups.size >= 2 && (groups.size <= maxPieces || keepPartial)) {
    pieces = ringsFromGroups(groups);
  }
  if (!pieces || pieces.length < 2) return [ring];
  if (pieces.length > maxPieces) {
    const trimmed = largestPieces(pieces, maxPieces, frame);
    if (trimmed.length < 2) return [ring];
    if (!keepPartial) {
      let covered = 0;
      for (let i = 0; i < trimmed.length; i++) covered += pieceClipboardArea(trimmed[i], frame);
      if (!(covered >= hostArea * 0.7)) return [ring];
    }
    pieces = trimmed;
  }
  const cleaned = [];
  for (let i = 0; i < pieces.length; i++) {
    const clip = closeClipRing(ringToClipboard(pieces[i], frame));
    if (!clip) continue;
    let geom = null;
    try {
      geom = polygonClipping.union([[clip]]);
    } catch {
      geom = null;
    }
    const rings = geom ? ringsFromClipGeom(geom, frame, keepPartial ? 12 : 30) : [pieces[i]];
    for (let k = 0; k < rings.length; k++) cleaned.push(rings[k]);
  }
  if (cleaned.length >= 2 && cleaned.length <= maxPieces) {
    pieces = cleaned;
  } else if (keepPartial && cleaned.length > maxPieces) {
    pieces = largestPieces(cleaned, maxPieces, frame);
  }
  let area = 0;
  for (let i = 0; i < pieces.length; i++) area += pieceClipboardArea(pieces[i], frame);
  const minCover = keepPartial ? 0.35 : 0.7;
  if (area < hostArea * minCover) return [ring];
  return pieces;
}

function slopeSampler(terrain) {
  const fn = (ring) => slopeTopUnderRing(terrain, ring);
  fn.seat = (ring) => slopeSeatUnderRing(terrain, ring);
  fn.split = (ring) => splitRingByFloor(terrain, ring);
  fn.splitCanopy = (ring) =>
    splitRingByFloor(terrain, ring, { maxPieces: canopyPieceCap(terrain), keepPartial: true });
  return fn;
}

/**
 * Ring → meters above the terrain datum for attenuating-object bottoms.
 * Null when objects stay on the floor.
 * A pasted mesh (sloped ramps or raised plates) is sampled for bare earth and
 * for a surface DEM, including relief under 20 m. The ski-hill gate remains
 * only when the paste was left out. The value is the slope top under the
 * ring. fn.seat is the downhill surface, where a building meets the hill.
 * fn() remains the uphill surface. Ground under LIFT_LOCAL_M still omits
 * bottom_height inside the lifters. fn.split cuts a footprint that climbs
 * more than SPLIT_FLOOR_M. fn.splitCanopy does the same for a woods, with
 * one piece per terrain cell, each seated on fn.seat (the local downhill).
 */
function demUnderFootprint(terrain) {
  if (!terrain) return null;
  const zones = (terrain.raised || 0) + (terrain.sloped || 0);
  if (zones > 0) return slopeSampler(terrain);
  if (!terrain.pasteOmitted) return null;
  if (terrain.kind !== "surface" && !(terrain.reliefM >= LIFT_RELIEF_M)) return null;
  return slopeSampler(terrain);
}

function terrainSourceLabel(terrain) {
  if (terrain && terrain.kind === "surface") return "Copernicus DEM GLO-30 surface";
  return "USGS 3DEP bare-earth";
}

/**
 * Bundle fields for the export API. The OpenIntent zip stays the only download.
 * terrainClipboard is the in-memory Planner Plus paste for Copy terrain.
 * terrainFilename names that paste. The zip does not contain the file.
 * Both are null when 3DEP misses.
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
    const cols = terrain.gridCols | 0;
    const rows = terrain.gridRows | 0;
    const highLat = highLatMeterFrame(terrain.frame);
    const showMeters =
      preset.id === "auto" ||
      terrain.reliefM >= LIFT_RELIEF_M ||
      (highLat && preset.experimental);
    let mesh = "";
    if (showMeters) {
      const shown =
        (highLat && terrain.cellM > 0) ||
        preset.experimental ||
        (preset.id === "auto" && terrain.cellM > 0)
          ? terrain.cellM
          : preset.cellM;
      mesh = ", " + preset.label + " ~" + formatCellM(shown) + " m";
      const past = preset.experimental && (cols > PASTE_SOFT_GRID || rows > PASTE_SOFT_GRID);
      if (past || (highLat && cols > 0 && rows > 0)) {
        mesh += " (" + cols + "×" + rows;
        if (past) mesh += ", past 20×20";
        mesh += ")";
      }
    } else if (preset.id !== "default") {
      mesh = ", " + preset.label + " (relief under 20 m keeps the coarse mesh)";
    }
    const reduced = terrain.pasteReduced ? " " + pasteReducedNote(terrain) : "";
    const nSamples = terrain.samples && terrain.samples.length;
    const sampleNote = nSamples >= 4 ? ", " + nSamples + " DEM samples" : "";
    const slopedStyle = terrain.terrainStyle === "sloped";
    const mode = slopedStyle ? "Terrain sloped " + cols + "×" + rows : "Terrain raised layers " + cols + "×" + rows;
    const floors = slopedStyle
      ? terrain.raised + " raised, " + terrain.sloped + " sloped"
      : terrain.raised +
        (terrain.raised === 1 ? " floor" : " floors") +
        (terrain.bandM > 0 ? ", " + formatCellM(terrain.bandM) + " m bands" : "");
    return {
      terrainFilename: TERRAIN_FILENAME,
      terrainClipboard: terrain.clipboard,
      terrainStatus:
        mode +
        " (" +
        terrainSourceLabel(terrain) +
        ", " +
        floors +
        mesh +
        sampleNote +
        ")." +
        reduced +
        (slopedStyle && terrain.slopeGapM > 0
          ? " Shared edges differ by up to " + formatCellM(terrain.slopeGapM) + " m."
          : "") +
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
 * Dev-host gate, same host/path check as the Terrain checkbox.
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

function packSurfaceDem(samples, plan, requested, opts, frame) {
  const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
  const notes = [];
  const density = demDensityNote(preset, frame, samples.length);
  if (density) notes.push(density);
  else if (plan.sampleCount < requested) {
    notes.push(
      "DEM samples stepped down to " +
        samples.length +
        " so the elevation read can finish. Elevations between samples are interpolated."
    );
  }
  return {
    samples,
    kind: "surface",
    attribution: GLO30_CREDIT,
    notes,
  };
}

/**
 * Copernicus beside 3DEP. Its signal is not the caller's abort: that abort
 * is what ends a slow US getSamples, and the surface grid has to survive it.
 */
function beginParallelSurface(frame, opts) {
  if (!(opts && opts.parallelSurface && opts.allowSurfaceFallback && frameHas3dep(frame))) return null;
  const requested = sampleCountForResolution(opts.terrainResolution, frame);
  const plan = glo30SamplePlan(requested, demRemainingMs(opts));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  if (timer.unref) timer.unref();
  const work = fetchCopernicusDemSamples(frame, {
    signal: ctrl.signal,
    geotiff: opts.geotiff,
    sampleCount: plan.sampleCount,
    maxRasterSide: plan.maxRasterSide,
  }).then(
    (samples) => ({ samples }),
    (error) => ({ error })
  );
  return {
    cancel() {
      clearTimeout(timer);
      ctrl.abort();
    },
    async take() {
      clearTimeout(timer);
      const got = await work;
      if (!got || got.error || !got.samples) return null;
      const usable = usableDemSamples(got.samples);
      if (usable.length < 4) return null;
      return packSurfaceDem(usable, plan, requested, opts, frame);
    },
  };
}

function abortedDem() {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "AbortError";
  return err;
}

/**
 * Try USGS 3DEP. On the dev host, a miss reads Copernicus GLO-30 for the same
 * frame. 3DEP success never waits on GLO-30. parallelSurface starts GLO-30
 * with the 3DEP read so a US getSamples that is still out when the caller
 * aborts does not throw away a surface grid that already finished.
 * @returns {Promise<{samples:{lon:number,lat:number,z:number}[], kind:string, attribution:string}>}
 */
async function fetchTerrainDem(frame, fetchFn, opts) {
  const allowSurface = !!(opts && opts.allowSurfaceFallback);
  const parent = opts && opts.signal;
  const surfaceEarly = beginParallelSurface(frame, opts);
  const outside = allowSurface && !frameHas3dep(frame);
  // The Finland follow-up already probed 3DEP. A second probe would spend
  // the reserved slice on a request that cannot succeed.
  const skipProbe = outside && !!(opts && opts.skip3depProbe);
  // Outside coverage a full getSamples often hangs until the shared abort,
  // which used to cancel GLO-30 before it started. Probe briefly instead.
  const probe = outside && !skipProbe ? linkAbort(parent, DEP3_OUTSIDE_MS) : null;
  let samples = [];
  // terrainStyle is intentionally unused here. Sloped and Raised layers share
  // this read; the mesh is built later from the same samples.
  let demOpts = opts;
  if (!skipProbe) {
    try {
      demOpts = probe
        ? Object.assign({}, opts, { signal: probe.signal, sampleCount: DEP3_PROBE_SAMPLES })
        : opts;
      samples = await fetchDemSamples(frame, fetchFn, demOpts);
    } catch (e) {
      if (parent && parent.aborted && !surfaceEarly) throw e;
      if (!allowSurface) throw e;
    } finally {
      if (probe) probe.done();
    }
  }
  const usable = usableDemSamples(samples);
  if (usable.length >= 4) {
    if (surfaceEarly) surfaceEarly.cancel();
    const preset = normalizeTerrainResolution(opts && opts.terrainResolution);
    const notes = [];
    const density = demDensityNote(preset, frame, usable.length);
    if (density) notes.push(density);
    else {
      const asked = demSampleCount(demOpts, frame);
      const requested = sampleCountForResolution(opts && opts.terrainResolution, frame);
      // The outside-coverage probe is 4 samples and is not a step-down.
      if (asked > DEP3_PROBE_SAMPLES && asked < requested) {
        notes.push(
          "DEM samples stepped down to " +
            usable.length +
            " so the elevation read can finish. Elevations between samples are interpolated."
        );
      }
    }
    return {
      samples: usable,
      kind: "bare-earth",
      attribution: USGS_3DEP_ATTRIBUTION,
      notes,
    };
  }
  if (!allowSurface) {
    if (surfaceEarly) surfaceEarly.cancel();
    return { samples: samples || [], kind: "bare-earth", attribution: USGS_3DEP_ATTRIBUTION };
  }
  if (surfaceEarly) {
    const pack = await surfaceEarly.take();
    if (pack) return pack;
    if (parent && parent.aborted) throw abortedDem();
    throw new Error("USGS 3DEP did not return a usable grid");
  }
  if (parent && parent.aborted) throw abortedDem();
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
    return packSurfaceDem(gloUsable, plan, requested, opts, frame);
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
  RAISED_FLOOR_MAX,
  RAISED_BAND_M,
  ABSOLUTE_MAX_GRID,
  ABSOLUTE_MAX_SAMPLES,
  TERRAIN_PASTE_JSON_MAX,
  TERRAIN_PASTE_MAX_FLOORS,
  TERRAIN_PASTE_MAX_BYTES,
  TERRAIN_FLOORS_MIN,
  TERRAIN_FLOORS_MAX,
  PASTE_BUILD_MAX_QUADS,
  parseTerrainFloorOverride,
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
  depressWaterBasins,
  pasteableQuad,
  planarSlopedRamp,
  slopeCornerGap,
  slopedRing,
  terrainGroundM,
  slopeTopUnderRing,
  slopeSeatUnderRing,
  splitRingByFloor,
  SPLIT_FLOOR_M,
  SPLIT_MAX_PIECES,
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
  pastePlanQuadBudget,
  squareMeterAxes,
  highLatMeterFrame,
  normalizeTerrainResolution,
  normalizeTerrainStyle,
  sampleCountForResolution,
  terrainResolutionNotes,
  formatCellM,
  autoAxisCount,
};
