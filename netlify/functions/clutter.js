"use strict";

const { userAgent: UA } = require("../lib/version");
// Netlify hobby kills the function around 10s. The JPEG is the long pole
// (Oak Creek ~6s) and must start immediately. Imagery metadata is the same
// Esri export and used to be awaited for up to 7s before that download began,
// so a slow meta response left no time for the JPEG. Meta is now capped and
// overlapped with the JPEG. Footprints keep their own 7s clock and are not
// aborted when the JPEG aborts. Canopy height starts with the footprint
// fetch on its own abort. A timeout leaves foliage out of the zip.
// 3DEP starts once imagery metadata has snapped the extent, overlapping the
// JPEG, so a slow aerial download does not skip the DEM. Overture starts with
// the JPEG, before the Global ML gzip. A finished read is kept even if core
// passed 5s. A read still in flight keeps a grace window until OVERTURE_HARD_MS.
// The live Sphere export spent ~18s on imagery and the other footprint layers;
// a 9s hard cap then aborted Overture, which is the only source of that ring
// (absent from MS Global and USA Structures). Page-index pruning reads the
// center row group first so a late abort can still keep footprints already parsed.
const CORE_FETCH_MS = 7000;
// One full attempt fits in the function. A retry runs only when the first
// failure leaves at least 1.2s under this ceiling (fast reset, not a 8.5s hang).
const IMAGERY_ATTEMPT_MS = 8500;
const IMAGERY_ATTEMPTS = 2;
const IMAGERY_BACKOFF_MS = 400;
// Dev export does not use the production image. 640 px plus the waits after
// it still ran into the 10s gateway and the platform answered 504. The first
// dev image is 400 px for this long, then 256 px. 2400 px is not a request.
const IMAGERY_ATTEMPT_MS_DEV = 2500;
const IMAGERY_STEPDOWN_MS = 6000;
const IMAGERY_STEPDOWN_MS_DEV = 1500;
// High and Sharp wait longer than Auto. A 1040 px plate of the ~850 m
// Wi-Co box missed the 2.5s Auto budget and came back as the same 400 px
// JPEG. These waits stay under the ~10s gateway. 4K did not return in 9s.
const IMAGERY_HIGH_FIRST_MS = 6200;
const IMAGERY_SHARP_FIRST_MS = 5000;
const IMAGERY_SHARP_MID_MS = 1800;
// A nearly square Sharp plate is about 4 MP. That JPEG was still out after
// 7s on downtown Montreal, and the 1.8s left for 1040 was not enough either
// (that plate returned in about 4.5s). Wi-Co at 2048×1281 is under this and
// still returns. Above it, Sharp asks for 1040 first.
const SHARP_HEAVY_PIXELS = 3200000;
const SHARP_HEAVY_FIRST_MS = 5500;
// A later step larger than the production image is skipped once this much
// of the export has already run. The current dev plan has no such step.
const IMAGERY_STEPDOWN_QUICK_MS = 2000;
const IMAGERY_RETURN_MS = 15000;
// Network waits stop here so the zip is the response. The gateway closes a
// silent export around 26s, including cold start. Production may use this
// longer Overture window. The dev host answers sooner (DEV_ANSWER_MS).
const EXPORT_ANSWER_MS = 16000;
// Dev must send the zip inside the platform's default ~10s, including cold
// start. Core stops at DEV_CORE_MS. Optional reads get DEV_OPTIONAL_MS only
// after that core is back, and only when this clock still has room.
const DEV_ANSWER_MS = 6000;
// High and Sharp only. Auto stays on DEV_ANSWER_MS so a campus export
// still answers inside the gateway. 9000 leaves a slice to build the zip
// before the platform closes the request.
const DEV_SHARP_ANSWER_MS = 9000;
const DEV_CORE_MS = 3500;
const DEV_OPTIONAL_MS = 400;
// Live Oak Creek metadata was ~3.0s and pads latitude by ~500 m at the same
// pixel size. The content extent is derived from the drawn box and the JPEG
// pixel size (the same pad export?f=json returns), so a slow JSON cannot
// leave footprints on the drawn box. 4s still overlaps the JPEG; metadata
// replaces that derived extent when it arrives.
const META_MS = 4000;
const OPTIONAL_MS = 2000;
const SKIP_OPTIONAL_AFTER_MS = 5000;
// Live dev (dev--openclutter) still had Overture in flight after an ~18s core
// phase and aborted it because the old hard cap was 9s. The Sphere row group
// is only in that read. Grace continues until this ceiling, which stays under
// a ~26s platform kill when core itself returns.
const OVERTURE_GRACE_MS = 4500;
// A dense campus row group (Universal Hollywood, ~23k rows) still needs about
// 14s after a fast core. The short grace stays for smaller draws so a hung
// read cannot stretch Oak Creek. hardMs cuts the wait at EXPORT_ANSWER_MS
// so a slow aerial still leaves time to return the zip.
const OVERTURE_LARGE_GRACE_MS = 15000;
const LARGE_DRAW_SIDE_M = 1500;
const OVERTURE_HARD_MS = EXPORT_ANSWER_MS;
// Terrain overlaps the JPEG. On the dev host it starts with the JPEG, on the
// predicted content grid, so a slow metadata response does not eat the read.
// Production still waits for that snap. grace/hard match joinOptional.
// Outside 3DEP coverage the read itself fails that probe in a few hundred
// milliseconds and spends the rest on GLO-30; this cap is only the shared abort.
// A large campus keeps fetching footprints well past 9s (dev imagery up to 12s,
// a dense Overture row group until 23s). The old 9s hard cap aborted the DEM
// while that work continued, which is "Terrain omitted: timed out" with a
// finished zip. Raised layers and Sloped share this read; the style is applied
// only after samples exist. The dev host lets the in-flight read ride with
// the buildings, then one coarser retry if it is still open.
const TERRAIN_GRACE_MS = 1500;
const TERRAIN_HARD_MS = 9000;
// A DEM still open when the dev answer clock is up is omitted. Waiting it
// out, then building the zip, is how the gateway returned 504.
const TERRAIN_HARD_MS_DEV = 8000;
// Fast maps still give a full getSamples this long before the coarse retry.
// A map that already ran longer has had that time; the retry is not a second wait.
const TERRAIN_FULL_MS = 4000;
// Coarse 3DEP count for that retry. Dense enough to interpolate a 20×20 paste,
// small enough that a campus getSamples can return inside the rescue slice.
const TERRAIN_COARSE_SAMPLES = 64;
// Finland's ground-meter resample blocks the event loop after the JPEG, so a
// GLO-30 read planned against the 9s cap is often still in flight when core
// ends — and that cap then aborts it empty ("Terrain omitted: timed out").
// Give the in-flight read the same grace joinOptional would have, then if it
// is still open spend one more slice on a coarser lattice. 4s stays under the
// glo30SamplePlan full-lattice tier (6s) so the retry cannot ask for the read
// that just missed. The slice must also end with time left to build the zip
// under the ~26s platform kill.
const TERRAIN_RESERVE_MS = 4000;
const TERRAIN_PLATFORM_MS = EXPORT_ANSWER_MS;
const TERRAIN_RESCUE_MIN_MS = 800;
// Roof fill scans every footprint. On a dense draw that already spent 10s
// fetching, skip it and emit the vector buildings.
const DENSE_FEATURES = 1500;
// Copy terrain is only in the bundle JSON, and a fine paste is fitted
// again against the synchronous payload budget before the response is
// returned. Hamina's import limit is the OpenIntent JSON, not this zip.
// A draw over 2.5 km still exports on the short path, with fewer roofs and a
// smaller plate. The background job covers the full draw.
const SYNC_LARGE_DRAW_M = 2500;
const SYNC_LARGE_ROOFS = 240;
// Background exports are not on the ~10s gateway. Netlify kills the
// function at 15 minutes. Stop one minute early so the zip or an error
// is written. The page polls for that same 15 minutes.
const BACKGROUND_PLATFORM_MS = 15 * 60 * 1000;
const BACKGROUND_ANSWER_MS = BACKGROUND_PLATFORM_MS - 60 * 1000;
// Canopy height, world cover, and lidar start with the map. Each stops on
// its own clock. A miss keeps the buildings. They do not run one after
// another until the page gives up.
const BACKGROUND_CHM_MS = 180 * 1000;
const BACKGROUND_COVER_MS = 60 * 1000;
const BACKGROUND_LIDAR_MS = 45 * 1000;
// Lidar canopy on openclutter.com. Flip to true when dev is promoted.
// The aerial stage budget lives in aerial-fetch.js. A single 10 MP export
// used to hold the job for 90s, then a one-pixel-different cap held it again.
const { AsyncLocalStorage } = require("node:async_hooks");
const exportAls = new AsyncLocalStorage();

function isBackgroundExport() {
  const ctx = exportAls.getStore();
  return !!(ctx && ctx.background);
}

function reportProgress(patch) {
  const ctx = exportAls.getStore();
  if (!ctx || typeof ctx.onProgress !== "function") return;
  const run = () => Promise.resolve(ctx.onProgress(patch)).catch(() => {});
  ctx.tail = (ctx.tail || Promise.resolve()).then(run, run);
}

async function flushProgress() {
  const ctx = exportAls.getStore();
  if (ctx && ctx.tail) await ctx.tail;
}

async function runBackgroundExport(event, onProgress) {
  const ctx = { background: true, onProgress, tail: Promise.resolve() };
  const result = await exportAls.run(ctx, () => handleClutter(event));
  if (ctx.tail) await ctx.tail;
  return result;
}
const imagerySource = require("../lib/imagery-source");
const { normalizeAerial } = require("../lib/aerial-normalize");
const { geoFrame, capEsriExportFrame, llToPx, esriImageryUrl, esriImageryMetaUrl, fitAffine, jpegSize, applyImageryMeta, lockIsotropicImagery, compressJpegToMax, padFootprintBbox, imageryExportPlan, bboxLongSideM, IMAGERY_MAX_SIDE, IMAGERY_MAX_SIDE_DEV } = require("../lib/geo-frame");
const { buildClutter, ALIGNMENT, footprintsToClutter, ringAreaM2, featureExteriorRings, parseAreaCapOverride, parseJsonBudgetOverride, raisedDeckCap, MAX_BUILDINGS, MAX_ATTENUATION_AREAS, DEFAULT_AREA_CAP } = require("../lib/pipeline");
const { fetchOsmTreeNodes } = require("../lib/osm-trees");
const { buildSiteV1 } = require("../lib/site-v1");
const { fetchSlopeForest } = require("../lib/slope-forest");
const { fetchOutdoorClutter, OUTDOOR_MISS } = require("../lib/outdoor-clutter");
/** Wait for the park-context photo (park-context.js); a miss keeps the draw-only pads. */
const PARK_CONTEXT_MS = 20000;
const { fetchBuildingDetail, shapeBuildings } = require("../lib/building-shape");
const { dropStaleCampFootprints } = require("../lib/stale-footprints");
const { fetchUsgsLidar, applyLidarSample, checkSourceHeights, lidarNote, lidarStatusLine, rankProjects, heightForRing } = require("../lib/usgs-lidar");
const { fuseLidarCanopy, keepLidarOpen, clearInside, clearThinLinesGrid, vehicleFeatures, lidarCanopyNote } = require("../lib/lidar-canopy");
const exportJobs = require("../lib/export-jobs");
const stageClock = require("../lib/stage-clock");
const exportMode = require("../lib/export-mode");
const aerialFetch = require("../lib/aerial-fetch");
const areaCache = require("../lib/area-cache");
const { fetchCanopyTrees, normalizeTreesSource, maxTreesForBbox, pickCanopyTrees } = require("../lib/tree-source");
const { fetchMsGlobalFootprints, globalSkipWarning } = require("../lib/ms-global");
const { fetchUsaStructures } = require("../lib/usa-structures");
const { assembleFootprints } = require("../lib/conflate");
const { fetchOvertureFootprints } = require("../lib/overture");
let fetchOvertureImpl = fetchOvertureFootprints;
function setFetchOvertureForTests(fn) {
  fetchOvertureImpl = typeof fn === "function" ? fn : fetchOvertureFootprints;
}
const detectParallel = require("../lib/detect-parallel");
const { fetchChmGrid, applyChmToTrees, sampleChmGrid } = require("../lib/canopy-height");
const { fillCanopyGaps } = require("../lib/canopy-fill");
const { fetchWorldCoverTrees } = require("../lib/worldcover");
const {
  fetchTerrainDem,
  terrainFromSamples,
  terrainBundleFields,
  terrainResolutionNotes,
  noteMissingTerrain,
  normalizeTerrainResolution,
  normalizeTerrainStyle,
  isDevTestHost,
  isQualityHost,
  parseTerrainFloorOverride,
  frameHas3dep,
  ABSOLUTE_MAX_SAMPLES,
  EXPORT_PAYLOAD_BUDGET,
  LAMBDA_SYNC_PAYLOAD_MAX,
  estimateBundlePayload,
  lambdaPayloadBytes,
  maxPasteJsonForCompanion,
  demUnderFootprint,
} = require("../lib/terrain");

let fetchTerrainDemImpl = fetchTerrainDem;
function setFetchTerrainDemForTests(fn) {
  fetchTerrainDemImpl = typeof fn === "function" ? fn : fetchTerrainDem;
}
let fetchChmGridImpl = fetchChmGrid;
function setFetchChmGridForTests(fn) {
  fetchChmGridImpl = typeof fn === "function" ? fn : fetchChmGrid;
}
let fetchWorldCoverImpl = fetchWorldCoverTrees;
function setFetchWorldCoverForTests(fn) {
  fetchWorldCoverImpl = typeof fn === "function" ? fn : fetchWorldCoverTrees;
}
let sourceCapsOverride = null;
function setSourceCapsForTests(caps) {
  sourceCapsOverride = caps || null;
}
const { gpsClipboard, stampGpsTiePoints, fitClipboardToMap } = require("../lib/hamina-clipboard");
const { buildMapNotes, stampMapNotes } = require("../lib/map-notes");
const { treeHitsBuilding } = require("../lib/vegetation");
const { supplementFootprints } = require("../lib/roof-mask");
const { surfaceMasksFromImage, openShareSampler, poleShadowContrast } = require("../lib/surface-mask");
const { fetchLeafOnPhoto, leafOnGreenSampler } = require("../lib/leaf-on-photo");
const { checkCanopyOnPhoto, photoCanopyNote, leafyShareSampler, vehicleZoneTest, zonedShareSampler } = require("../lib/photo-canopy");
const { photoCrownRefiner, photoCrownNote, gridHeightAt } = require("../lib/photo-crowns");
const { createWaterTest, clearWaterCanopy, dropWaterPoints } = require("../lib/water-mask");
const { rejectPavementFootprints } = require("../lib/pavement");
const { rejectShadowless } = require("../lib/cast-shadow");
const { aerialStorageYards } = require("../lib/yard-stacks");
const POLE_SHADOW_MIN = 0.2;
// Taller lone returns are masts, towers or flags, not light poles.
const POLE_MAX_H_M = 40;
// A tall lone return this close to a building outline is a roof edge, parapet or sign.
const POLE_BUILDING_GAP_M = 3;
function nearBuilding(lon, lat, buildings, gapM) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  for (const f of buildings || []) {
    const g = f && f.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      for (const ring of poly || []) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const ax = (ring[j][0] - lon) * kx, ay = (ring[j][1] - lat) * ky;
          const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
          if (ay > 0 !== by > 0 && 0 < ((bx - ax) * (0 - ay)) / (by - ay) + ax) inside = !inside;
          const dx = bx - ax, dy = by - ay;
          const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
          if (Math.hypot(ax + t * dx, ay + t * dy) < gapM) return true;
        }
        if (inside) return true;
      }
    }
  }
  return false;
}
function json(status, cors, obj) {
  return {
    statusCode: status,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function isTimeout(err) {
  const msg = String(err && err.message ? err.message : err || "");
  return /abort|timeout/i.test(msg);
}

function fail(source, message) {
  const err = new Error(message);
  err.source = source;
  return err;
}

async function fetchOk(url, source, timeoutMs) {
  let last = "fetch failed";
  let timedOut = false;
  const ms = timeoutMs > 0 ? timeoutMs : CORE_FETCH_MS;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
      if (r.ok) return r;
      last = "HTTP " + r.status;
      if (r.status < 500) break;
    } catch (e) {
      last = String(e.message || e);
      timedOut = isTimeout(e);
      // A timeout already used the core window. A second attempt would blow the function.
      if (timedOut) break;
    }
  }
  throw fail(source || "export", timedOut ? "The operation was aborted due to timeout" : last);
}

/** Extent JSON is optional. A slow response must not hold the JPEG. */
async function fetchImageryMeta(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(META_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Production keeps 8.5s. Dev's first image is shorter so the zip can still be sent. */
function imageryAttemptMs(devHost) {
  return devHost ? IMAGERY_ATTEMPT_MS_DEV : IMAGERY_ATTEMPT_MS;
}

function imageryRoomKind(quality) {
  const q = String(quality || "")
    .trim()
    .toLowerCase();
  if (q === "sharp" || q === "2048" || q === "2k" || fourKQuality(q)) return "sharp";
  if (q === "high" || q === "higher" || q === "1040") return "high";
  // Auto asks for the 4K-class plate, then steps down. The short path still
  // uses DEV_ANSWER_MS. The background job is what waits for that plate.
  return "";
}

function sharpFrameHeavy(bbox) {
  try {
    const frame = geoFrame(bbox, { maxSide: IMAGERY_MAX_SIDE_DEV, metersPerPx: 0.4 });
    return frame.imgW * frame.imgH > SHARP_HEAVY_PIXELS;
  } catch {
    return false;
  }
}

function fourKQuality(quality) {
  const q = String(quality || "")
    .trim()
    .toLowerCase();
  return q === "4k" || q === "4096" || q === "ultra";
}

function eightKQuality(quality) {
  const q = String(quality || "")
    .trim()
    .toLowerCase();
  return q === "8k" || q === "8192" || q === "max";
}

/**
 * The background clock can wait for the plate that was asked for.
 * Auto starts at the 8192 px plate, scaled to the site. Sharp, 4K, and 8K
 * are real long sides. A smaller plate runs only when the first request fails.
 */
function backgroundImagerySteps(devHost, bbox) {
  const quality = String((bbox && bbox.imageryQuality) || "")
    .trim()
    .toLowerCase();
  let plan;
  if (!devHost) {
    plan = [{ maxSide: IMAGERY_MAX_SIDE, metersPerPx: 1 }];
  } else if (quality === "low" || quality === "lower" || quality === "256") {
    plan = [{ maxSide: 256, metersPerPx: 2 }];
  } else if (quality === "standard" || quality === "640") {
    plan = [{ maxSide: 640, metersPerPx: 1 }];
  } else if (quality === "high" || quality === "higher" || quality === "1040") {
    plan = [{ maxSide: IMAGERY_MAX_SIDE, metersPerPx: 0.5 }];
  } else if (quality === "sharp" || quality === "2048" || quality === "2k") {
    plan = [
      { maxSide: IMAGERY_MAX_SIDE_DEV, metersPerPx: 0.25 },
      { maxSide: IMAGERY_MAX_SIDE, metersPerPx: 0.5 },
    ];
  } else if (fourKQuality(quality)) {
    plan = [
      { maxSide: 4096, metersPerPx: 0.15 },
      { maxSide: IMAGERY_MAX_SIDE_DEV, metersPerPx: 0.25 },
    ];
  } else if (eightKQuality(quality)) {
    plan = [
      { maxSide: 8192, metersPerPx: 0.075 },
      { maxSide: 4096, metersPerPx: 0.15 },
    ];
  } else {
    plan = imageryExportPlan(true, bbox, "auto").filter((step) => step.maxSide >= IMAGERY_MAX_SIDE);
  }
  return plan.map((step) => Object.assign({ attemptMs: aerialFetch.aerialBudgetMs() }, step));
}

function imagerySteps(devHost, bbox) {
  if (isBackgroundExport()) return backgroundImagerySteps(devHost, bbox);
  if (bboxLongSideM(bbox) > SYNC_LARGE_DRAW_M) {
    const first = devHost ? IMAGERY_ATTEMPT_MS_DEV : IMAGERY_ATTEMPT_MS;
    const next = devHost ? IMAGERY_STEPDOWN_MS_DEV : IMAGERY_ATTEMPT_MS;
    return [
      { maxSide: 640, metersPerPx: 2, attemptMs: first },
      { maxSide: 400, metersPerPx: 2, attemptMs: next },
    ];
  }
  let quality = devHost && bbox ? bbox.imageryQuality : undefined;
  if (devHost && (fourKQuality(quality) || eightKQuality(quality))) quality = "sharp";
  let plan = imageryExportPlan(devHost, bbox, quality);
  // 4K and 8K plates do not return on the short clock. Drop them before the
  // waits are assigned, so the Sharp plate that is actually fetched gets
  // the first-plate budget. The background job keeps the finer steps.
  if (devHost) {
    const shortPlan = plan.filter((step) => step.maxSide <= IMAGERY_MAX_SIDE_DEV);
    if (shortPlan.length) plan = shortPlan;
  }
  const kind = devHost ? imageryRoomKind(quality) : "";
  if (!devHost) {
    return plan.map((step) => Object.assign({ attemptMs: IMAGERY_ATTEMPT_MS }, step));
  }
  let steps = plan.map((step, i) => {
    let attemptMs = i === 0 ? IMAGERY_ATTEMPT_MS_DEV : IMAGERY_STEPDOWN_MS_DEV;
    if (kind === "high") attemptMs = i === 0 ? IMAGERY_HIGH_FIRST_MS : IMAGERY_STEPDOWN_MS_DEV;
    if (kind === "sharp") {
      attemptMs = i === 0 ? IMAGERY_SHARP_FIRST_MS : i === 1 ? IMAGERY_SHARP_MID_MS : IMAGERY_STEPDOWN_MS_DEV;
    }
    return Object.assign({ attemptMs }, step);
  });
  const named = String(quality || "")
    .trim()
    .toLowerCase();
  const namedSharp = named === "sharp" || named === "2048" || named === "2k" || fourKQuality(named);
  if (namedSharp && bbox && sharpFrameHeavy(bbox)) {
    steps = steps.filter((step) => step.maxSide <= IMAGERY_MAX_SIDE);
    if (steps[0]) {
      steps[0] = Object.assign({}, steps[0], { attemptMs: SHARP_HEAVY_FIRST_MS, sharpCapped: true });
    }
  }
  return steps;
}

/**
 * Budget for a later, smaller JPEG. A fast failure keeps that step's own
 * wait. A late abort gets only the time left under IMAGERY_RETURN_MS, so the
 * function can still answer. 0 means do not start another image.
 */
function imageryStepBudget(elapsed, attemptMs) {
  if (isBackgroundExport()) return aerialFetch.aerialBudgetMs();
  const elapsedMs = Math.max(0, +elapsed || 0);
  const attempt = attemptMs > 0 ? attemptMs : IMAGERY_ATTEMPT_MS;
  if (elapsedMs < IMAGERY_STEPDOWN_QUICK_MS) return attempt;
  const room = IMAGERY_RETURN_MS - elapsedMs;
  if (room < 1500) return 0;
  return Math.min(attempt, room);
}

/**
 * Same drawn box, smaller image when the first one misses. There is no
 * third fetch after the plan. That extra wait ran into the gateway.
 */
async function fetchImageryStepped(bbox, steps, srcCtx) {
  let last;
  let refusedAll = true;
  const started = Date.now();
  let askedSide = 0;
  const prepared = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const plate = imageryFrame(bbox, step);
    if (prepared.some((entry) => aerialFetch.sameExportPlate(entry.plate, plate))) continue;
    if (!askedSide) askedSide = Math.max(plate.imgW, plate.imgH);
    prepared.push({ step, plate });
  }
  const sharpCapped = !!(prepared[0] && prepared[0].step.sharpCapped);
  if (isBackgroundExport()) {
    return fetchImageryWithinBudget(prepared, askedSide, sharpCapped, srcCtx);
  }
  for (let n = 0; n < prepared.length; n++) {
    const entry = prepared[n];
    const elapsed = Date.now() - started;
    if (!isBackgroundExport() && n > 0 && elapsed >= IMAGERY_STEPDOWN_QUICK_MS && entry.step.maxSide > 1040) {
      refusedAll = false;
      continue;
    }
    let attemptMs = entry.step.attemptMs;
    if (n > 0) {
      attemptMs = imageryStepBudget(elapsed, entry.step.attemptMs);
      if (!(attemptMs >= 1500)) break;
    }
    try {
      const got = await tryImageryPlate(entry.plate, attemptMs, srcCtx);
      return plateResult(got, askedSide, n > 0, sharpCapped, n > 0 && refusedAll);
    } catch (e) {
      last = e;
      if (!aerialFetch.refusedBySource(e)) refusedAll = false;
    }
  }
  throw last;
}

/**
 * Background exports race every distinct plate and stop at the stage
 * budget. The sharpest JPEG that has arrived is the one kept. A plate
 * near the Esri pixel cap is fetched as tiles so one request cannot sit
 * for 90s.
 */
async function fetchImageryWithinBudget(prepared, askedSide, sharpCapped, srcCtx) {
  const resilient = exportMode.isResilient();
  let unitTotal = 0;
  let unitDone = 0;
  function noteAerial() {
    reportProgress({
      stage: "Fetching aerial",
      tilesDone: unitDone,
      tilesTotal: unitTotal > 0 ? unitTotal : 1,
    });
  }
  let got;
  try {
    got = await stageClock.timeSpan("aerialFetch", () =>
      aerialFetch.racePlates(
        prepared.map((entry, i) => ({
          plate: entry.plate,
          tile: resilient
            ? aerialFetch.shouldTilePlate(entry.plate, aerialFetch.AERIAL_TILE_MIN_SIDE_RESILIENT)
            : i === 0 && aerialFetch.shouldTilePlate(entry.plate),
        })),
        {
          budgetMs: aerialFetch.aerialBudgetMs(),
          tileMinSide: resilient ? aerialFetch.AERIAL_TILE_MIN_SIDE_RESILIENT : 0,
          sharperGraceMs: resilient ? aerialFetch.AERIAL_SHARPER_GRACE_MS : 0,
          onUnits: (total) => {
            unitTotal = total;
            noteAerial();
          },
          onUnit: () => {
            unitDone += 1;
            noteAerial();
          },
          fetchImage: (frame, signal) =>
            imagerySource.fetchPlateWith(srcCtx, frame, aerialFetch.aerialBudgetMs(), signal, (f, ms, sig) =>
              fetchImageryJpegBody(esriImageryUrl(f), ms, sig)
            ),
        }
      )
    );
  } catch (err) {
    if (err && err.source) throw err;
    throw fail("imagery", "The operation was aborted due to timeout");
  }
  const plate = prepared[got.index] ? prepared[got.index].plate : prepared[0].plate;
  try {
    console.log(
      "aerial plates " + prepared.map((e) => Math.max(e.plate.imgW, e.plate.imgH)).join(",") +
        " kept " + Math.max(plate.imgW, plate.imgH) + " index " + got.index + (resilient ? " resilient" : " legacy")
    );
  } catch {
    /* logging is optional */
  }
  return plateResult({ buf: got.buf, plate }, askedSide, got.index > 0, sharpCapped, !!got.noFiner);
}

function imageryFrame(bbox, step) {
  const raw = geoFrame(bbox, { maxSide: step.maxSide, metersPerPx: step.metersPerPx });
  const plate = capEsriExportFrame(raw);
  return Object.assign({}, plate, {
    pixelCapped: plate.imgW !== raw.imgW || plate.imgH !== raw.imgH,
  });
}

function plateResult(got, askedSide, stepped, sharpCapped, noFiner) {
  return {
    buf: got.buf,
    stepped: !!stepped,
    noFiner: !!(stepped && noFiner),
    imgW: got.plate.imgW,
    imgH: got.plate.imgH,
    askedSide: askedSide,
    sharpCapped: !!sharpCapped,
  };
}

async function tryImageryPlate(plate, attemptMs, srcCtx) {
  try {
    const buf =
      srcCtx && srcCtx.source !== imagerySource.ESRI
        ? await stageClock.timeSpan("aerialFetch", () =>
            imagerySource.fetchPlateWith(srcCtx, plate, attemptMs, null, (f, ms, sig) =>
              fetchImageryJpegBody(esriImageryUrl(f), ms, sig)
            )
          )
        : await fetchImageryJpeg(esriImageryUrl(plate), attemptMs);
    return { buf, plate };
  } catch (err) {
    const safe = capEsriExportFrame(plate);
    const smaller = safe && (safe.imgW !== plate.imgW || safe.imgH !== plate.imgH);
    if (!smaller) throw err;
    const buf = await fetchImageryJpeg(esriImageryUrl(safe), Math.min(attemptMs, 45000));
    return { buf, plate: safe };
  }
}

/**
 * Headers and JPEG body share one deadline. Aborting the socket is not enough:
 * a fetch that ignores the signal used to sit until the gateway returned 504.
 * The race rejects on that deadline either way, and the next smaller image
 * can still run.
 */
function imageryDeadline(ms, ctrl) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }));
    }, ms);
  });
  return {
    timeout: timeout,
    clear: () => clearTimeout(timer),
  };
}

async function fetchImageryJpeg(url, attemptMs, signal) {
  return stageClock.timeSpan("aerialFetch", () => fetchImageryJpegBody(url, attemptMs, signal));
}

async function fetchImageryJpegBody(url, attemptMs, signal) {
  const ceiling = attemptMs > 0 ? attemptMs : IMAGERY_ATTEMPT_MS;
  let last = "aerial imagery failed";
  let timedOut = false;
  const started = Date.now();
  for (let attempt = 0; attempt < IMAGERY_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) break;
    const budget = Math.min(ceiling, ceiling - (Date.now() - started));
    if (budget < 1200) break;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const deadline = imageryDeadline(budget, ctrl);
    const work = (async () => {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
      if (!r.ok) {
        const err = fail("imagery", "HTTP " + r.status);
        if (r.status < 500) throw err;
        throw Object.assign(new Error("HTTP " + r.status), { httpStatus: r.status });
      }
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8) throw fail("imagery", "imagery not jpeg");
      return body;
    })();
    // The deadline can win while the body is still open. Swallow that
    // rejection so it cannot fail the export after a smaller image arrives.
    work.catch(() => {});
    try {
      return await Promise.race([work, deadline.timeout]);
    } catch (e) {
      if (e && e.source) throw e;
      last = String(e && e.message ? e.message : e);
      timedOut = isTimeout(e) || !(e && e.httpStatus);
    } finally {
      deadline.clear();
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    if (signal && signal.aborted) break;
    if (attempt + 1 >= IMAGERY_ATTEMPTS) break;
    const pause = IMAGERY_BACKOFF_MS * (attempt + 1);
    if (Date.now() - started + pause > ceiling - 1200) break;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw fail("imagery", timedOut || isTimeout(last) ? "The operation was aborted due to timeout" : last);
}

function describeCoreFailure(e) {
  const msg = String(e && e.message ? e.message : e);
  const source = e && e.source;
  const timedOut = isTimeout(e) || isTimeout(msg);
  if (source === "imagery") {
    return timedOut ? "Aerial imagery timed out. Retry the export." : "Aerial imagery failed (" + msg + "). Retry the export.";
  }
  if (source === "footprints") {
    return timedOut
      ? "Building footprints timed out. Retry the export."
      : "Building footprints failed (" + msg + "). Retry the export.";
  }
  if (timedOut) return "Export timed out. Retry the export.";
  return msg + " — export failed. Retry the export.";
}

const TIMED_OUT = Symbol("timed-out");

/** One quad per segment of a road or rail line, its mapped width across, in pixels. */
function corridorMaskPolygons(corridors, frame, mpu, measured) {
  const out = [];
  for (let i = 0; i < (corridors || []).length; i++) {
    const c = corridors[i];
    // Town streets and squares cut an estimated canopy height map, which
    // smears crowns over narrow streets. Measured lidar keeps its crowns.
    if (c.street && measured) continue;
    if (c.area) {
      const ring = c.coords.map((q) => llToPx(q[0], q[1], frame));
      if (ring.length >= 4) out.push([ring]);
      continue;
    }
    const half = (c.widthM || 0) / 2 / mpu;
    if (!(half > 0)) continue;
    const pts = c.coords.map((q) => llToPx(q[0], q[1], frame));
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;
      // Extend each end by half the width so the joints close.
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy * half;
      const ny = ux * half;
      const ax = a[0] - ux * half;
      const ay = a[1] - uy * half;
      const bx = b[0] + ux * half;
      const by = b[1] + uy * half;
      // The -1 third value marks a road or ground-level rail corridor: it blocks canopy seeds where the
      // height model reads the road, but it does not cut traced crowns, so a
      // median palm the canopy shows inside a wide mapped road stays.
      // An elevated guideway is the exception: its beam reads as a crown in
      // the lidar, so it cuts measured crowns too.
      const ring = [
        c.elevated || c.street ? [ax + nx, ay + ny] : [ax + nx, ay + ny, -1],
        [bx + nx, by + ny],
        [bx - nx, by - ny],
        [ax - nx, ay - ny],
        [ax + nx, ay + ny],
      ];
      out.push([ring]);
    }
  }
  return out;
}

/**
 * Start an optional fetch on its own abort signal. Call this during the core
 * phase (Overture), then joinOptional after core. Do not pass the imagery
 * signal — a parquet hang must not cancel the JPEG.
 */
function beginOptional(fn) {
  const ctrl = new AbortController();
  let workError = null;
  let settled = false;
  const work = Promise.resolve()
    .then(() => fn(ctrl.signal))
    .then((value) => {
      settled = true;
      if (ctrl.signal.aborted) {
        // A center row group may already be parsed when the abort fires.
        // Dropping it is how the Sphere disappeared behind a slow map fetch.
        // A DEM pack that resolved on that same edge is the terrain paste.
        const kept = keptOptionalResult(value);
        if (kept) return kept;
        return TIMED_OUT;
      }
      return value;
    })
    .catch((e) => {
      settled = true;
      workError = e;
      return TIMED_OUT;
    });
  return {
    ctrl,
    work,
    isSettled: () => settled,
    error: () => workError,
  };
}

function optionalMissWarning(label, job) {
  const err = job.error();
  const msg = err ? String(err.message || err) : "";
  const timedOut = !err || job.ctrl.signal.aborted || isTimeout(err);
  return label + (timedOut ? " omitted: timed out" : " omitted: " + msg);
}

function keptOptionalResult(result) {
  if (!result || result === TIMED_OUT) return null;
  if (Array.isArray(result.features) && result.features.length) return result;
  if (result && Array.isArray(result.samples) && result.samples.length >= 4) return result;
  if (result && result.values && result.width > 1 && result.height > 1 && result.nonzero > 0) return result;
  return null;
}

function keptFootprints(result) {
  return keptOptionalResult(result);
}

/** After an abort, keep rows the reader already returned (center group first). */
async function flushOptional(job, waitMs) {
  if (job.isSettled()) return keptOptionalResult(await job.work);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
  });
  try {
    return keptOptionalResult(await Promise.race([job.work, timeout]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long joinOptional would still wait for terrain before aborting.
 * Outside 3DEP, a read that misses this window gets one coarser retry
 * instead of "Terrain omitted: timed out".
 */
function terrainSettleMs(elapsed) {
  const ms = Math.max(0, +elapsed || 0);
  if (ms < SKIP_OPTIONAL_AFTER_MS) {
    return Math.min(OPTIONAL_MS, Math.max(400, SKIP_OPTIONAL_AFTER_MS - ms));
  }
  const hardLeft = TERRAIN_HARD_MS - ms;
  if (hardLeft < 200) return 0;
  return Math.min(TERRAIN_GRACE_MS, hardLeft);
}

/** Milliseconds for a coarser GLO-30 follow-up. 0 means do not start one. */
function terrainRescueBudget(elapsed) {
  const ms = Math.max(0, +elapsed || 0);
  const reserve = Math.min(TERRAIN_RESERVE_MS, TERRAIN_PLATFORM_MS - ms);
  if (!(reserve >= TERRAIN_RESCUE_MIN_MS)) return 0;
  return Math.floor(reserve);
}

/**
 * A settled optional DEM job. pack is a usable grid. timedOut means the read
 * was aborted, so one coarser retry can still finish. A clean miss (no grid,
 * not an abort) is not a timeout and is not retried.
 */
async function finishedTerrain(job) {
  if (!job || !job.isSettled()) return null;
  const result = await job.work;
  const pack = keptOptionalResult(result);
  if (pack) return { pack, timedOut: false };
  const err = job.error();
  const timedOut = result === TIMED_OUT && (!err || job.ctrl.signal.aborted || isTimeout(err));
  return { pack: null, timedOut };
}

/**
 * Abort a read that is still open and start one shorter DEM fetch.
 * fetchOpts is skip3depProbe for GLO-30, or sampleCount for a coarse 3DEP.
 * Returns { job, join, preset }.
 */
async function rescueTerrain(terrainJob, started, frame, terrainResolution, terrainStyle, fetchOpts) {
  const giveUp = { graceMs: TERRAIN_GRACE_MS, hardMs: TERRAIN_HARD_MS };
  const budgetMs = terrainRescueBudget(Date.now() - started);
  if (!budgetMs) return { job: terrainJob, join: giveUp, preset: null };
  if (terrainJob && !terrainJob.isSettled()) {
    terrainJob.ctrl.abort();
    const flushed = await flushOptional(terrainJob, 250);
    if (flushed && Array.isArray(flushed.samples) && flushed.samples.length >= 4) {
      return { job: null, join: giveUp, preset: flushed };
    }
  }
  const elapsed = Date.now() - started;
  const job = beginOptional((signal) =>
    fetchTerrainDemImpl(
      frame,
      null,
      Object.assign(
        {
          signal,
          terrainResolution,
          terrainStyle,
          allowSurfaceFallback: true,
          budgetMs,
        },
        fetchOpts || {}
      )
    )
  );
  return {
    job,
    preset: null,
    join: {
      graceMs: budgetMs,
      hardMs: elapsed + budgetMs + 400,
      reserveMs: budgetMs,
    },
  };
}

/**
 * Keep a DEM grid that finished during the aerial. If it is still open, or it
 * was aborted, read once more with a coarser lattice in the slice that is left.
 * Outside 3DEP that retry skips the probe and reads GLO-30. Inside coverage it
 * is one short 3DEP getSamples, not another 576-point read and not a second
 * style-specific fetch. Raised layers and Sloped both use this.
 * Returns { job, join, preset }. preset is a finished DEM pack to use as-is.
 */
async function followUpTerrain(terrainJob, started, frame, devHost, terrainResolution, terrainStyle) {
  const join = {
    graceMs: devHost ? TERRAIN_HARD_MS_DEV : TERRAIN_GRACE_MS,
    hardMs: devHost ? TERRAIN_HARD_MS_DEV : TERRAIN_HARD_MS,
  };
  if (!terrainJob || !devHost || !frame) {
    return { job: terrainJob, join: { graceMs: TERRAIN_GRACE_MS, hardMs: TERRAIN_HARD_MS }, preset: null };
  }
  const outside = !frameHas3dep(frame);
  if (!terrainJob.isSettled()) {
    const elapsed = Date.now() - started;
    const wait = outside
      ? terrainSettleMs(elapsed)
      : Math.min(TERRAIN_HARD_MS_DEV, Math.max(TERRAIN_FULL_MS, elapsed + TERRAIN_GRACE_MS)) - elapsed;
    if (wait >= 200) await flushOptional(terrainJob, wait);
  }
  const done = await finishedTerrain(terrainJob);
  if (done && done.pack) return { job: null, join, preset: done.pack };
  if (done && !done.timedOut) return { job: terrainJob, join, preset: null };
  if (devHost && Date.now() - started >= TERRAIN_HARD_MS_DEV) {
    if (terrainJob && !terrainJob.isSettled()) terrainJob.ctrl.abort();
    return { job: null, join, preset: null };
  }
  return rescueTerrain(
    terrainJob,
    started,
    frame,
    terrainResolution,
    terrainStyle,
    outside ? { skip3depProbe: true } : { sampleCount: TERRAIN_COARSE_SAMPLES }
  );
}

/**
 * Collect a fetch started with beginOptional.
 * A read that already finished is kept even when the core phase used the
 * 5s optional-start budget — discarding it dropped the Las Vegas Sphere,
 * which is in Overture and absent from MS Global / USA Structures.
 * Work still running after that budget is aborted unless opts.graceMs allows
 * a wait that must end by opts.hardMs. Overture's hard cap stays past a slow
 * Netlify core (~18s); a 9s cap aborted the Sphere read while it was in flight.
 */
async function joinOptional(warnings, started, label, job, opts) {
  const graceMs = opts && opts.graceMs > 0 ? opts.graceMs : 0;
  const hardMs = opts && opts.hardMs > 0 ? opts.hardMs : 9000;
  if (job.isSettled()) {
    const result = await job.work;
    if (result === TIMED_OUT) {
      warnings.push(optionalMissWarning(label, job));
      return null;
    }
    return result;
  }
  const elapsed = Date.now() - started;
  const flushMs = opts && opts.flushMs != null ? opts.flushMs : null;
  let budget = 0;
  if (opts && opts.budgetMs != null) {
    budget = Math.max(0, opts.budgetMs);
  } else if (opts && opts.reserveMs > 0) {
    // A follow-up DEM slice. The 5s optional window and the 9s hard cap
    // already passed with the aerial; this wait is the coarsened read.
    budget = Math.min(opts.reserveMs, Math.max(0, hardMs - elapsed));
  } else if (graceMs > SKIP_OPTIONAL_AFTER_MS) {
    // A dense campus read is allowed to outlast a fast core. The short
    // optional window (grace at or under 5s) still aborts quickly so a hung
    // read on a small draw cannot eat the export. hardMs ends either wait.
    budget = Math.min(graceMs, Math.max(0, hardMs - elapsed));
  } else if (elapsed < SKIP_OPTIONAL_AFTER_MS) {
    budget = Math.min(OPTIONAL_MS, Math.max(400, SKIP_OPTIONAL_AFTER_MS - elapsed));
  } else if (graceMs) {
    budget = Math.min(graceMs, Math.max(0, hardMs - elapsed));
  }
  if (budget < 200) {
    const hardLeft = hardMs - elapsed;
    if (opts && opts.keepOpen && hardLeft >= 200 && !job.isSettled()) {
      const flushedOpen = await flushOptional(job, Math.max(150, Math.min(hardLeft - 80, 2000)));
      if (flushedOpen) return flushedOpen;
    }
    job.ctrl.abort();
    const flushed = await flushOptional(job, flushMs != null ? flushMs : 1200);
    if (flushed) {
      if (Array.isArray(flushed.features)) {
        warnings.push(label + " partial: kept " + flushed.features.length + " footprints already read");
      }
      return flushed;
    }
    warnings.push(label + " omitted: export budget spent on the map and footprints");
    return null;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      job.ctrl.abort();
      resolve(TIMED_OUT);
    }, budget);
  });
  try {
    const result = await Promise.race([job.work, timeout]);
    if (result === TIMED_OUT) {
      const flushed = await flushOptional(job, flushMs != null ? flushMs : 1500);
      if (flushed) {
        if (Array.isArray(flushed.features)) {
          warnings.push(label + " partial: kept " + flushed.features.length + " footprints already read");
        }
        return flushed;
      }
      warnings.push(optionalMissWarning(label, job));
      return null;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function runOptional(warnings, started, label, fn) {
  const elapsed = Date.now() - started;
  if (elapsed >= SKIP_OPTIONAL_AFTER_MS) {
    warnings.push(label + " omitted: export budget spent on the map and footprints");
    return null;
  }
  return joinOptional(warnings, started, label, beginOptional(fn));
}

function parseFormat(body) {
  if (body.format === "hamina-clipboard" || body.clipboard === true || body.output === "clipboard") {
    return "hamina-clipboard";
  }
  if (body.format === "zip" || body.output === "zip") return "zip";
  if (body.format === "site-v1") return "site-v1";
  return "bundle";
}

/** True when every plate of this export came from a non-Esri source. */
function levelForAnalysis(ctx) {
  return !!(ctx && ctx.source !== imagerySource.ESRI && !ctx.failed && ctx.altPlates > 0 && !ctx.esriPlates);
}

function decodeImagery(imgBuf) {
  // 2048² is 4.2 MP. A live 2048 px JPEG was about 1 MB, under both limits.
  if (!imgBuf || imgBuf.length < 100 || imgBuf.length > 3500000) return null;
  try {
    const jpeg = require("jpeg-js");
    const raw = jpeg.decode(imgBuf, { useTArray: true, maxResolutionInMP: 6, formatAsRGBA: true });
    if (!raw || !raw.data || !(raw.width > 16) || !(raw.height > 16)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Roof cores and dark panel rectangles on a 4K plate. The 6 MP roof fill stays separate. */
function decodeRoofImagery(imgBuf) {
  if (!imgBuf || imgBuf.length < 100 || imgBuf.length > 12000000) return null;
  try {
    const jpeg = require("jpeg-js");
    const raw = jpeg.decode(imgBuf, { useTArray: true, maxResolutionInMP: 20, formatAsRGBA: true });
    if (!raw || !raw.data || !(raw.width > 16) || !(raw.height > 16)) return null;
    return raw;
  } catch {
    return null;
  }
}

function featureAreaM2(feature, mpd) {
  const rings = featureExteriorRings(feature && feature.geometry);
  let area = 0;
  for (let i = 0; i < rings.length; i++) area += ringAreaM2(rings[i], mpd);
  return area;
}

/** Largest and tallest roofs first. A shortened export should keep the towers. */
function largestFeatures(features, n, mpd) {
  const list = Array.isArray(features) ? features : [];
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const feature = list[i];
    const area = featureAreaM2(feature, mpd);
    const props = (feature && feature.properties) || {};
    const h = Number(props.height || props.Height || props.HEIGHT || 0);
    const height = h > 2 && h < 400 ? h : 0;
    scored.push({ feature, area, height, score: area * Math.max(1, height / 10) });
  }
  scored.sort((a, b) => b.score - a.score || b.height - a.height || b.area - a.area);
  const keep = Math.max(0, n | 0);
  const out = [];
  for (let i = 0; i < scored.length && out.length < keep; i++) out.push(scored[i].feature);
  return out;
}

function overtureWait(frame) {
  const side = Math.max(+frame.widthM || 0, +frame.lengthM || 0);
  const large = side >= LARGE_DRAW_SIDE_M;
  return {
    graceMs: large ? OVERTURE_LARGE_GRACE_MS : OVERTURE_GRACE_MS,
    hardMs: OVERTURE_HARD_MS,
  };
}

/**
 * Canopy height on dev keeps running until the answer clock, minus a slice
 * to build the zip. It is not the 400 ms Overture slice: that window starts
 * too late to trace a crown, and the miss was exported as NLCD squares.
 */
function devChmWait(started, answerMs) {
  const clock = answerMs > 0 ? answerMs : DEV_ANSWER_MS;
  const left = clock - (Date.now() - started);
  const budget = Math.max(0, left - 400);
  return { graceMs: budget, hardMs: clock, budgetMs: budget, flushMs: 80 };
}

/**
 * A slow source stops on its own clock, measured from the export start.
 * The background answer clock is longer. One source must not spend it and
 * then leave the next source to run after the page has given up.
 */
function sourceWait(started, capMs) {
  const cap = capMs > 0 ? capMs : 0;
  const left = cap - (Date.now() - started);
  const budget = Math.max(0, left);
  return { graceMs: budget, hardMs: cap, budgetMs: budget, flushMs: 80 };
}

function cappedMs(background, key, backgroundMs, syncMs) {
  const over = sourceCapsOverride && sourceCapsOverride[key];
  if (over > 0) return over;
  return background ? backgroundMs : syncMs;
}

function chmJoinWait(started, background, answerMs) {
  if (background) return sourceWait(started, cappedMs(true, "chmMs", BACKGROUND_CHM_MS, BACKGROUND_CHM_MS));
  return devChmWait(started, answerMs);
}

function coverJoinWait(started, background) {
  return sourceWait(started, cappedMs(background, "coverMs", BACKGROUND_COVER_MS, 8000));
}

/**
 * Canopy outline cap for one export. 720 was sized for a dense site. Each
 * building left out of a 2000-building ceiling frees JSON room, so a site
 * with few roofs keeps up to 1200 outlines. The byte budget is still final.
 */
const SEGMENT_CAP_SCALE = 1.6;
/** An estimated crown smaller than this is one tree and is never split. */
const ESTIMATED_SPLIT_MIN_M2 = 150;
// Lidar tree segmentation is opt-in until it stops costing canopy cover
// (bench: Chicago, Colorado and Florida lost 5-15 points of recall).
const SEGMENT_TREES = process.env.OC_SEGMENT_TREES !== "0";

const SITE_V1_FOLIAGE_MAX = 3600;

function foliageCapFor(buildings) {
  const n = Math.max(0, buildings | 0);
  return Math.max(720, Math.min(1200, Math.round(1200 - n * 0.4)));
}

function lidarCapMs(background) {
  return cappedMs(background, "lidarMs", BACKGROUND_LIDAR_MS, 8000);
}

async function joinQuiet(job, started, opts) {
  const ignored = [];
  return joinOptional(ignored, started, "World cover", job, opts);
}

/** Name the slow read that is still open so the progress bar matches the work. */
function watchSlowStages(rows) {
  let shown = "";
  const tick = () => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.open()) continue;
      if (row.label === shown) return;
      shown = row.label;
      reportProgress({ stage: row.label });
      return;
    }
  };
  const timer = setInterval(tick, 400);
  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * In-flight DEM on the dev host. The read starts with the map, so this wait
 * is only the slice still inside the answer clock. keepOpen means a grid
 * that resolves in that slice is kept; it is not aborted just because the
 * optional-start reserve has already passed.
 */
function devTerrainWait(started, answerMs) {
  const clock = answerMs > 0 ? answerMs : DEV_ANSWER_MS;
  const left = clock - (Date.now() - started);
  const budget = Math.max(0, left - 250);
  return { graceMs: budget, hardMs: clock, budgetMs: budget, flushMs: 150, keepOpen: true };
}

function mapImageNote(plate, frame, jpegBuf) {
  const sized = jpegSize(jpegBuf);
  const side = sized
    ? Math.max(sized.width, sized.height)
    : Math.max(+plate.imgW || 0, +plate.imgH || 0);
  let mpp = "";
  if (sized && frame && frame.mpuX > 0) {
    const n = frame.mpuX >= 1 ? frame.mpuX.toFixed(1) : frame.mpuX.toFixed(2);
    mpp = ", " + n + " m per pixel";
  }
  const capped = plate.sharpCapped ? " A 2048 px plate does not fit this draw." : "";
  if (plate.stepped) {
    const asked = plate.askedSide > 0 ? plate.askedSide : side;
    // Esri refused every sharper plate: this is the finest imagery it has
    // here, not a slow fetch. Site types (/dev) say so.
    if (plate.noFiner && exportMode.isSiteTypes()) {
      return "Map image " + side + " px" + mpp + ": the finest Esri imagery here (sharper plates up to " + asked + " px are not served for this spot)." + capped;
    }
    return "Map stepped down to " + side + " px from " + asked + " px." + capped;
  }
  return "Map image " + side + " px" + mpp + "." + capped;
}

/** Dev stops optional reads at DEV_ANSWER_MS so the zip is the response. */
function capDevWait(devHost, started, opts) {
  if (!devHost || !opts) return opts;
  const hardMs = Math.min(opts.hardMs > 0 ? opts.hardMs : DEV_ANSWER_MS, DEV_ANSWER_MS);
  const graceMs = Math.min(opts.graceMs > 0 ? opts.graceMs : 0, hardMs);
  const capped = { graceMs: graceMs, hardMs: hardMs };
  if (opts.reserveMs > 0) {
    const left = Math.max(0, hardMs - (Date.now() - started));
    capped.reserveMs = Math.min(opts.reserveMs, left);
  }
  return capped;
}

function wantOsm(body) {
  return body.osmTrees === true || body.osm === true;
}

/**
 * Body wins when it names a resolution. Otherwise the query string. Empty or
 * unknown values normalize to auto.
 */
function terrainResolutionFromRequest(event, body) {
  const q = (event && event.queryStringParameters) || {};
  let raw = "";
  if (body && body.terrainResolution != null && String(body.terrainResolution).trim() !== "") {
    raw = body.terrainResolution;
  } else if (q.terrainResolution != null && String(q.terrainResolution).trim() !== "") {
    raw = q.terrainResolution;
  }
  return normalizeTerrainResolution(raw).id;
}

/** Sloped ramps unless the body or query asks for raised layers. */
function terrainStyleFromRequest(event, body) {
  const q = (event && event.queryStringParameters) || {};
  let raw = "";
  if (body && body.terrainStyle != null && String(body.terrainStyle).trim() !== "") {
    raw = body.terrainStyle;
  } else if (q.terrainStyle != null && String(q.terrainStyle).trim() !== "") {
    raw = q.terrainStyle;
  }
  return normalizeTerrainStyle(raw);
}

/** Outdoor clutter is off unless the body or query explicitly turns that type on. */
function wantOutdoorFlag(event, body, key) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body[key] != null ? body[key] : q[key];
  return raw === true || raw === 1 || raw === "1" || raw === "true";
}

/** Include foliage is off unless the body or query explicitly turns it on. */
function wantFoliage(event, body) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body.includeFoliage != null ? body.includeFoliage : q.includeFoliage;
  return raw === true || raw === 1 || raw === "1" || raw === "true";
}

/** Map notes stay on unless the body or query explicitly turns them off. */
function wantMapNotes(event, body) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body.mapNotes != null ? body.mapNotes : q.mapNotes;
  if (raw == null || raw === "") return true;
  return !(raw === false || raw === 0 || raw === "0" || raw === "false");
}

/** Terrain stays on unless the body or query explicitly turns it off. */
function wantTerrain(event, body) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body.includeTerrain != null ? body.includeTerrain : q.includeTerrain;
  if (raw == null || raw === "") return true;
  return !(raw === false || raw === 0 || raw === "0" || raw === "false");
}

// The zip and the elevation read no longer share one clock. This request
// does only the DEM, so a slow plate or canopy cannot abort it.
const TERRAIN_ASIDE_MS = 8000;

async function respondTerrainAside(frame, body, event, cors) {
  const terrainResolution = terrainResolutionFromRequest(event, body);
  const terrainStyle = terrainStyleFromRequest(event, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, TERRAIN_ASIDE_MS - 400));
  const warnings = [];
  let demPack = null;
  try {
    demPack = await fetchTerrainDemImpl(frame, null, {
      signal: ctrl.signal,
      terrainResolution,
      terrainStyle,
      allowSurfaceFallback: true,
      // A US getSamples at this count often misses the first clock and
      // returns on the next try. Copernicus starts beside it and is the
      // paste when bare earth is still out. Sites outside 3DEP ignore this
      // and keep the GLO-30-only read.
      parallelSurface: true,
      budgetMs: 4500,
      fitAnswerClock: true,
      skip3depProbe: !frameHas3dep(frame),
    });
  } catch {
    demPack = null;
  } finally {
    clearTimeout(timer);
  }
  const samples = demPack && (Array.isArray(demPack) ? demPack : demPack.samples);
  const kind = demPack && !Array.isArray(demPack) ? demPack.kind : null;
  const attribution = demPack && !Array.isArray(demPack) ? demPack.attribution : null;
  if (demPack && !Array.isArray(demPack) && Array.isArray(demPack.notes)) {
    for (let i = 0; i < demPack.notes.length; i++) warnings.push(demPack.notes[i]);
  }
  let terrain = null;
  if (samples && samples.length && frame) {
    try {
      terrain = terrainFromSamples(samples, frame, {
        terrainResolution,
        terrainStyle,
        kind,
        attribution,
        terrainFloors: isDevTestHost(event) ? parseTerrainFloorOverride(body && body.terrainFloors) : 0,
      });
    } catch {
      terrain = null;
    }
  }
  const ready = !!(terrain && ((terrain.raised || 0) > 0 || (terrain.sloped || 0) > 0) && terrain.clipboard);
  if (!ready) {
    return json(200, cors, {
      ok: false,
      terrainFilename: null,
      terrainClipboard: null,
      terrainStatus: "Terrain did not return. Export again.",
      warnings: ["Terrain did not return. Export again."],
    });
  }
  const fields = terrainBundleFields(terrain, warnings);
  return json(200, cors, {
    ok: true,
    terrainFilename: fields.terrainFilename,
    terrainClipboard: fields.terrainClipboard,
    terrainStatus: fields.terrainStatus,
    // The zip does not read this DEM. These are the samples the mesh used,
    // so each building bottom can sit on that same ground.
    liftSamples: liftSamplePayload(samples),
    liftKind: kind === "surface" ? "surface" : "bare-earth",
    warnings,
  });
}

function liftSamplePayload(samples) {
  const out = [];
  const list = samples || [];
  const n = Math.min(list.length, ABSOLUTE_MAX_SAMPLES);
  for (let i = 0; i < n; i++) {
    const s = list[i];
    if (!s) continue;
    const lon = +s.lon;
    const lat = +s.lat;
    const z = +s.z;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(z)) continue;
    out.push({ lon, lat, z });
  }
  return out;
}

function normalizeLiftSamples(raw) {
  return liftSamplePayload(raw);
}

/** Client-supplied NLCD hits, capped. Used to re-place trees off rooftops. */
function normalizeCanopyHits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const n = Math.min(raw.length, 5000);
  for (let i = 0; i < n; i++) {
    const h = raw[i];
    if (!h) continue;
    const lon = +(h.lon != null ? h.lon : h.lng);
    const lat = +h.lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const pct = h.pct != null ? +h.pct : h.score != null ? +h.score * 100 : 40;
    if (!Number.isFinite(pct) || pct < 18 || pct > 100) continue;
    out.push({ lon, lat, pct, score: pct / 100 });
  }
  return out;
}

function backgroundInvokeUrl(event) {
  const headers = (event && event.headers) || {};
  const forwarded = String(headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || "")
    .split(",")[0]
    .trim();
  const host = forwarded || headers.host || headers.Host || "";
  const proto = headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https";
  if (host && host.indexOf(".") !== -1) {
    return proto + "://" + host + "/.netlify/functions/clutter-export-background";
  }
  const base = process.env.DEPLOY_URL || process.env.DEPLOY_PRIME_URL || process.env.URL || "";
  return String(base).replace(/\/$/, "") + "/.netlify/functions/clutter-export-background";
}

/**
 * Validate, store a job, and invoke the background function. The zip is not
 * built here. If Blobs or the invoke is unavailable, the page runs the
 * short sync export instead.
 */
function fallbackExport(cors, reason) {
  return json(200, cors, {
    ok: false,
    fallback: true,
    reason: reason,
    note: "Background export is unavailable. This export uses the short path.",
  });
}

async function enqueueBackgroundExport(event, body, cors) {
  const bound = exportJobs.bindBlobs(event);
  let frame;
  try {
    const steps = imagerySteps(false, body);
    frame = geoFrame(body, { maxSide: steps[0].maxSide, metersPerPx: steps[0].metersPerPx });
  } catch (e) {
    return json(400, cors, { error: String(e.message || e) });
  }
  void frame;
  const id = require("node:crypto").randomUUID();
  const innerBody = Object.assign({}, body, { async: false, deferTerrain: false });
  const inner = {
    httpMethod: "POST",
    headers: event.headers || {},
    path: event.path || "",
    rawPath: event.rawPath || "",
    body: JSON.stringify(innerBody),
  };
  try {
    await exportJobs.createJob(id);
  } catch (err) {
    const name = err && err.name ? err.name : "blobs-write";
    return fallbackExport(cors, bound ? name : "event-has-no-blobs");
  }
  const url = backgroundInvokeUrl(event);
  if (!/^https?:\/\//.test(url)) {
    await exportJobs.deleteJob(id).catch(() => {});
    return fallbackExport(cors, "no-deploy-url");
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: id, event: inner }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 202 && res.status !== 200) {
      await exportJobs.deleteJob(id).catch(() => {});
      return fallbackExport(cors, "invoke-" + res.status);
    }
  } catch {
    await exportJobs.deleteJob(id).catch(() => {});
    return fallbackExport(cors, "invoke-failed");
  }
  return json(200, cors, { ok: true, async: true, jobId: id });
}

async function handleClutter(event) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers":
      "content-disposition, x-hamina-width-m, x-hamina-length-m, x-hamina-mpu, x-hamina-alignment",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "POST only" };
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, cors, { error: "invalid json" });
  }

  // devHost is the quality gate (dev, previews and production). testHost
  // gates the testing overrides, which stay off the public site.
  const devHost = isQualityHost(event);
  const testHost = isDevTestHost(event);
  // Overpass retries and fallback, and the sharper-plate wait, run on every
  // host. On /dev hosts legacyFetch:true replays the earlier paths.
  exportMode.setResilient(!(testHost && body.legacyFetch === true));
  // Production batch 1 (1.2.41): the /dev export rules run on every host.
  // Each switch stays, so putting one back on /dev only is a one-line change
  // (pass testHost again). The request opt-outs rvShell:false and
  // parkContext:false still work on every host.
  // 1.2.18 RV park and marina rules (with the later RV detection fixes).
  exportMode.setSiteTypes(true);
  // From 1.2.25 RVs and trailers are hollow shells (four walls and a roof
  // slab). rvShell:false exports the solid 9 dB/m block.
  exportMode.setRvShell(exportMode.rvShellWanted(testHost, body));
  // From 1.2.26 worst-case pads learn the pad pattern from the whole park
  // when a mapped park runs past the draw. parkContext:false turns it off.
  exportMode.setParkContext(exportMode.parkContextWanted(testHost, body));
  // From 1.2.29 the raised Hamina budget: 5.8 MB of JSON and 9.7 MB of JSON
  // plus map image (production used 4.9 MB of JSON before 1.2.41).
  exportMode.setBigBudget(true);
  // 1.2.37 lidar canopy checked on the photo runs on every host. The 1.2.39
  // photo-shaped crowns stay on /dev hosts: their stale-lidar test fired in
  // a leafy campground (Traverse City KOA) and cut real dense canopy.
  exportMode.setPhotoCanopy(true);
  // Production batch 2 (1.3.0): photo-shaped crowns (1.2.39 to 1.2.48), stale
  // pad footprints and shaded trailers (1.2.44 to 1.2.46) and the stale tower
  // guard (1.2.57) run on every host. Pass testHost again to put one back on
  // /dev hosts only.
  exportMode.setPhotoCrowns(true);
  exportMode.setStaleFootprints(true);
  exportMode.setShadowTrailers(true);
  exportMode.setStaleTowers(true);
  // 1.3.5 bug fix (feedback #11): the photo canopy check keeps lidar canopy
  // 12 m and taller that the photo shows dark, on every host.
  exportMode.setTallCanopyKeep(true);
  // 1.3.2 adaptive terrain: native-resolution DEM and a mesh that spends the
  // paste's floors on steep ground. /dev hosts only (adaptiveTerrain:false
  // or ?adaptiveTerrain=0 turns it off there). Production stays off.
  exportMode.setAdaptiveTerrain(exportMode.adaptiveTerrainWanted(testHost, body));
  // Feedback #9 forest prototypes: /dev hosts only (forest=bands|merge|off,
  // default bands); production keeps the 1.3.1 blocks.
  const forest = exportMode.forestMode(testHost, body);
  exportMode.setCanopyBands(forest === "bands");
  exportMode.setMergeTiles(forest === "merge");
  exportMode.setScrubGaps(exportMode.protoWanted(testHost, {}, "scrubGaps", "OC_SCRUB_GAPS"));
  // From 1.2.31 large draws read the street-map tiles in one shared window
  // with a slow-fail chain, a retry pass and a split (export-mode tiledOsm).
  exportMode.setTiledOsm(exportMode.tiledOsmWanted(testHost));
  const areaCapOverride = testHost ? parseAreaCapOverride(body.areaCap) : 0;
  const jsonBudgetOverride = testHost ? parseJsonBudgetOverride(body.jsonBudget) : 0;
  const terrainFloors = testHost ? parseTerrainFloorOverride(body.terrainFloors) : 0;
  const deckCap = raisedDeckCap(areaCapOverride);
  if (body.async === true || body.async === "true") {
    return enqueueBackgroundExport(event, body, cors);
  }
  const background = isBackgroundExport();
  const steps = imagerySteps(devHost, body);
  const maxSide = steps[0].maxSide;
  let frame;
  try {
    frame = geoFrame(body, { maxSide: steps[0].maxSide, metersPerPx: steps[0].metersPerPx });
  } catch (e) {
    return json(400, cors, { error: String(e.message || e) });
  }

  let affine = null;
  if (Array.isArray(body.controlPoints) && body.controlPoints.length) {
    if (body.controlPoints.length < 3) {
      return json(400, cors, { error: "calibration needs 3+ control points {lon,lat,xM,yM}" });
    }
    try {
      affine = fitAffine(body.controlPoints);
    } catch (e) {
      return json(400, cors, { error: String(e.message || e) });
    }
  }

  const format = parseFormat(body);
  const needImage = format !== "hamina-clipboard";
  const terrainResolution = terrainResolutionFromRequest(event, body);
  const terrainStyle = terrainStyleFromRequest(event, body);
  const imgMetaUrl = esriImageryMetaUrl(frame);
  const includeFoliage = wantFoliage(event, body);
  const lidarOn =
    devHost && (body.lidar === true || body.lidar === "true" || body.lidar === 1 || body.lidar === "1");
  // Where a USGS 3DEP cloud covers the draw, tree canopy is traced from it,
  // on every host. Building heights from that cloud stay on the dev request above.
  let lidarCanopyOn = false;
  if (
    includeFoliage &&
    needImage &&
    body.lidarCanopy !== false &&
    body.lidarCanopy !== "false"
  ) {
    try {
      lidarCanopyOn = rankProjects(frame).length > 0;
    } catch {
      lidarCanopyOn = false;
    }
  }
  const includeWater = wantOutdoorFlag(event, body, "includeWater");
  const includeParking = wantOutdoorFlag(event, body, "includeParking");
  const includeWalls = wantOutdoorFlag(event, body, "includeWalls");
  const includePoles = wantOutdoorFlag(event, body, "includePoles");
  const includeRvs = wantOutdoorFlag(event, body, "includeRvs");
  const includeCars = wantOutdoorFlag(event, body, "includeCars");
  const outdoorOn = includeWater || includeParking || includeWalls || includePoles || includeRvs || includeCars;
  const includeTerrain = wantTerrain(event, body);
  // The dev page sets this and reads elevation on its own request. The zip
  // then does not start a DEM, so the map cannot omit it.
  const deferTerrain = devHost && (body.deferTerrain === true || body.deferTerrain === "true");
  const readTerrain = includeTerrain && !deferTerrain;
  // The dev page already fetched this grid for Copy terrain. The zip uses it
  // only to set building bottoms, and does not start another DEM.
  const clientLift = deferTerrain ? normalizeLiftSamples(body.liftSamples) : [];
  const clientLiftKind = body.liftKind === "surface" ? "surface" : "bare-earth";
  if (body.format === "terrain") {
    if (!devHost) return json(404, cors, { error: "not found" });
    return respondTerrainAside(frame, body, event, cors);
  }

  let treePoints = includeFoliage && Array.isArray(body.trees) ? body.trees.slice() : [];
  let treesSource = includeFoliage && ["nlcd-canopy", "imagery-rgb", "none"].includes(body.treesSource)
    ? body.treesSource
    : includeFoliage
      ? null
      : "none";

  let imgBuf = null;
  let imageryPlate = null;
  let imageryCtx = null;
  let gj;
  let imgMeta = null;
  let globalFeatures = [];
  let usaFeatures = [];
  let serverCanopyHits = null;
  let overturePack = { features: [] };
  let demSamples = null;
  let chmGrid = null;
  let photoCrowns = null;
  let coverJob = null;
  let coverPromise = null;
  let lidarPromise = null;
  let lidarSettled = true;
  let worldCover = null;
  const warnings = [];
  const started = Date.now();
  stageClock.enter(stageClock.createClock());
  const sharpRoom = devHost && imageryRoomKind(body.imageryQuality) !== "";
  const answerMs = background ? BACKGROUND_ANSWER_MS : sharpRoom ? DEV_SHARP_ANSWER_MS : DEV_ANSWER_MS;
  let overtureJob = null;
  let terrainJob = null;
  let chmJob = null;
  let outdoorJob = null;
  let parkContextJob = null;
  let forestJob = null;
  let detailJob = null;
  let overtureFrame = null;
  try {
    reportProgress({ stage: "Fetching aerial" });
    imageryCtx = needImage ? imagerySource.createImageryContext(testHost ? body.imagerySource : "esri", body) : null;
    // Capture date and vendor of the Esri mosaics, for ATTRIBUTION.txt. Read
    // beside the map, never in front of it: a miss only leaves the date out.
    if (imageryCtx) {
      imagerySource.readEsriCitation(imageryCtx, frame, {
        level: imagerySource.esriLevelFor(frame, frame.imgW > 0 ? frame.widthM / frame.imgW : 1),
      });
    }
    // JPEG and Overture together. Meta may confirm the footprint query, but it
    // must not gate the image or the Overture read — the Las Vegas row group
    // loses if it starts only after metadata, behind the Global ML gzip.
    // The JPEG URL stays the drawn box (Esri pads that request). The frame
    // footprints are projected in is the content grid, derived here so a
    // metadata timeout cannot bake rings onto the drawn box. That timeout
    // is a Y scale about the draw center: the Sphere stays, other roofs move.
    const requestBbox = {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
    };
    if (areaCache.enabled() && background) {
      // The resilient Overpass client reads the street map itself, through
      // the same cache key, so the fan-out does not send a second request.
      const work = areaCache
        .planSourceTiles(requestBbox)
        .filter((spec) => !(exportMode.isResilient() && spec.source === "osm"));
      areaCache
        .fanOut(work, { parentId: "export", invokeUrl: backgroundInvokeUrl(event) })
        .catch(() => {});
    }
    if (outdoorOn) {
      outdoorJob = beginOptional((signal) =>
        fetchOutdoorClutter(requestBbox, {
          water: includeWater,
          parking: includeParking,
          walls: includeWalls,
          poles: includePoles,
          rvs: includeRvs,
          cars: includeCars,
          trees: includeFoliage,
        }, { signal, ua: UA, timeoutMs: background ? 150000 : 4500, tile: background, deckCap })
      );
    }
    if (outdoorJob && includeRvs === true && exportMode.isParkContext()) {
      // A mapped park that runs past the draw: read its roads and pitches
      // over the whole park while the rest of the export runs.
      const outdoorWork = outdoorJob.work;
      parkContextJob = Promise.resolve(outdoorWork)
        .then((pack) => {
          if (!pack || pack === TIMED_OUT || pack.ok === false) return null;
          const box = require("../lib/park-context").contextBox(pack.features, requestBbox);
          if (!box) return null;
          return fetchOutdoorClutter(box, { rvs: true }, { ua: UA, timeoutMs: background ? 90000 : 4500, tile: background }).then(
            (got) => (got && got.ok ? got.features || [] : null)
          );
        })
        .catch(() => null);
    }
    if (includeFoliage) {
      forestJob = beginOptional((signal) =>
        fetchSlopeForest(requestBbox, { signal, ua: UA, timeoutMs: background ? 25000 : 8000 })
      );
    }
    detailJob = beginOptional((signal) =>
      fetchBuildingDetail(requestBbox, { signal, ua: UA, timeoutMs: background ? 150000 : 4500, tile: background, deckCap })
    );
    if (needImage) {
      frame = applyImageryMeta(frame, null, { width: frame.imgW, height: frame.imgH }, { requestBbox });
    }
    // The elevation read is network-bound and starts with the map on every
    // quality, on the predicted content grid. Waiting until a High or Sharp
    // plate returns left the DEM a few hundred milliseconds, which is
    // "Terrain omitted: export budget spent on the map and footprints".
    // Buildings and canopy height start with that same plate. Waiting for a
    // 2048 JPEG on a downtown box used the whole clock, so the zip kept
    // 0 buildings and 0 trees.
    if (devHost && readTerrain && needImage && !terrainJob) {
      terrainJob = beginOptional((signal) =>
        fetchTerrainDemImpl(frame, null, {
          signal,
          terrainResolution,
          terrainStyle,
          allowSurfaceFallback: true,
          deadlineMs: started + answerMs - 250,
          fitAnswerClock: true,
          backgroundDem: background,
          skip3depProbe: !frameHas3dep(frame),
        })
      );
    }
    let imagerySettled = !needImage;
    const imageryJob = needImage
      ? fetchImageryStepped(requestBbox, steps, imageryCtx).then((got) => {
          imagerySettled = true;
          imageryPlate = got;
          return got && got.buf;
        })
      : Promise.resolve(null);
    overtureFrame = {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
    };
    const coreBudget = background ? 45000 : devHost ? DEV_CORE_MS : CORE_FETCH_MS;
    // Every quality starts Overture with the JPEG, including a long US draw
    // and a Sharp downtown box. The Vegas group is a few seconds. Waiting
    // until the aerial was back and then allowing 400 ms dropped those roofs.
    // Waiting out a 2048 plate on downtown Montreal did the same: the plate
    // never returned, and roofs and canopy never started. The join still
    // stops at the answer clock, so a parse that runs long is omitted and
    // the zip returns.
    // Canopy height starts with the JPEG on every host and every quality.
    // The strip reader yields between strips, and an abort keeps peaks
    // already read. Production still starts Overture with the JPEG. The dev
    // DEM already started with the map, including High and Sharp.
    let metaDone = false;
    let metaReady = null;
    if (!devHost) {
      overtureJob = beginOptional((signal) =>
        fetchOvertureImpl(overtureFrame, { signal, filter: padFootprintBbox(overtureFrame) })
      );
      if (needImage) {
        imgMeta = await fetchImageryMeta(imgMetaUrl);
        if (imgMeta) frame = applyImageryMeta(frame, imgMeta, null, { requestBbox });
        if (readTerrain && !terrainJob) {
          terrainJob = beginOptional((signal) =>
            fetchTerrainDemImpl(frame, null, {
              signal,
              terrainResolution,
              terrainStyle,
              allowSurfaceFallback: devHost,
              deadlineMs: started + TERRAIN_HARD_MS,
            })
          );
        }
      }
    } else if (needImage) {
      fetchImageryMeta(imgMetaUrl).then((meta) => {
        metaDone = true;
        metaReady = meta;
        return meta;
      });
      if (!overtureJob) {
        overtureJob = beginOptional((signal) =>
          fetchOvertureImpl(overtureFrame, { signal, filter: padFootprintBbox(overtureFrame) })
        );
      }
    }
    const globalJob = fetchMsGlobalFootprints(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(coreBudget) })
    ).catch(() => ({ features: [] }));
    const usaCtrl = new AbortController();
    const usaTimer = setTimeout(() => usaCtrl.abort(), coreBudget);
    const usaJob = fetchUsaStructures(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: usaCtrl.signal })
    )
      .catch(() => ({ features: [] }))
      .finally(() => clearTimeout(usaTimer));
    if (includeFoliage && !coverJob) {
      const coverFrame = {
        west: requestBbox.west,
        south: requestBbox.south,
        east: requestBbox.east,
        north: requestBbox.north,
      };
      coverJob = beginOptional((signal) => fetchWorldCoverImpl(coverFrame, { signal }));
    }
    if ((lidarOn || lidarCanopyOn) && !lidarPromise) {
      lidarSettled = false;
      // The canopy grid covers the snapped map frame, a little past the
      // draw. Read the cloud for that frame so its edge is measured too.
      const lidarBox = lidarCanopyOn && frame
        ? { west: frame.west, south: frame.south, east: frame.east, north: frame.north }
        : {
            west: requestBbox.west,
            south: requestBbox.south,
            east: requestBbox.east,
            north: requestBbox.north,
          };
      lidarPromise = fetchUsgsLidar(lidarBox, { maxMs: lidarCapMs(background) })
        .then((value) => {
          lidarSettled = true;
          return value;
        })
        .catch(() => {
          lidarSettled = true;
          return null;
        });
    }
    if (includeFoliage && needImage && !chmJob) {
      const chmFrame = {
        west: frame.west,
        south: frame.south,
        east: frame.east,
        north: frame.north,
      };
      chmJob = beginOptional((signal) => fetchChmGridImpl(chmFrame, { signal }));
    }
    const clientHitsEarly = includeFoliage ? normalizeCanopyHits(body.canopyHits) : [];
    const canopyJob =
      includeFoliage && !clientHitsEarly.length && !devHost
        ? fetchCanopyTrees(frame, (url) => fetchOk(url, "canopy"), { maxTrees: maxTreesForBbox(frame) }).catch(() => null)
        : null;
    const coreWatch = watchSlowStages([
      { label: "Fetching aerial", open: () => needImage && !imagerySettled },
      { label: "Canopy height", open: () => !!(chmJob && !chmJob.isSettled()) },
      { label: "World cover", open: () => !!(coverJob && !coverJob.isSettled()) },
      { label: "Fetching footprints", open: () => true },
    ]);
    coreWatch.tick();
    const core = Promise.all([
      // Microsoft footprints are read from Microsoft's own Global ML release
      // (globalJob, ODbL). The Esri-hosted MSBFP2 copy is no longer read.
      Promise.resolve({ type: "FeatureCollection", features: [] }),
      globalJob,
      usaJob,
      imageryJob,
      canopyJob,
    ]);
    core.catch(() => {});
    let fetched;
    if (devHost) {
      let wallTimer;
      const wall = new Promise((_, reject) => {
        wallTimer = setTimeout(
          () => reject(fail("export", "The operation was aborted due to timeout")),
          background || sharpRoom
            ? Math.max(1000, answerMs - (Date.now() - started) - 400)
            : Math.max(1000, DEV_ANSWER_MS - 800)
        );
      });
      try {
        fetched = await Promise.race([core, wall]);
      } finally {
        clearTimeout(wallTimer);
        coreWatch.stop();
      }
    } else {
      try {
        fetched = await core;
      } finally {
        coreWatch.stop();
      }
    }
    if (devHost && metaDone && metaReady) {
      imgMeta = metaReady;
      frame = applyImageryMeta(frame, imgMeta, null, { requestBbox });
    }
    gj = fetched[0];
    const globalPack = fetched[1] || { features: [] };
    globalFeatures = globalPack.features || [];
    const globalNote = globalSkipWarning(globalPack);
    if (globalNote) warnings.push(globalNote);
    if (gj && gj.partial) {
      warnings.push(
        "Building footprints partial: kept " + (gj.features || []).length + " before the export budget."
      );
    }
    usaFeatures = (fetched[2] && fetched[2].features) || [];
    if (fetched[2] && fetched[2].partial) {
      warnings.push(
        "USA Structures partial: kept " + usaFeatures.length + " footprints before the export budget."
      );
    }
    imgBuf = fetched[3];
    if (imgBuf) {
      frame = applyImageryMeta(frame, imgMeta, jpegSize(imgBuf), { requestBbox });
      const locked = stageClock.timeSpanSync("aerialStitch", () =>
        lockIsotropicImagery(frame, imgBuf, { maxSide })
      );
      frame = locked.frame;
      imgBuf = locked.jpegBuf;
      if (devHost && imageryPlate) warnings.push(mapImageNote(imageryPlate, frame, imgBuf));
      const aerialInfo = imageryCtx ? imagerySource.imageryInfo(imageryCtx) : null;
      if (testHost && aerialInfo && aerialInfo.requested !== "esri") warnings.push(imagerySource.imageryLine(aerialInfo));
      const side = Math.max(+frame.imgW || 0, +frame.imgH || 0);
      const srcTag = aerialInfo && aerialInfo.requested !== "esri" ? " · " + (aerialInfo.id === "esri" ? "Esri" : imagerySource.sourceShort(aerialInfo.id)) : "";
      reportProgress({ step: { id: "aerial", detail: side > 0 ? side + " px" + srcTag : "" } });
    } else {
      reportProgress({ step: { id: "aerial", skipped: true, detail: "no image" } });
    }
    const canopy = fetched[4];
    if (canopy && canopy.parsed && canopy.parsed.hits && canopy.parsed.hits.length) {
      serverCanopyHits = canopy.parsed.hits;
    }
    if (canopy && canopy.trees && canopy.trees.length) {
      treePoints = canopy.trees;
      treesSource = "nlcd-canopy";
    } else if (canopy && canopy.source && !treesSource) {
      treesSource = "nlcd-canopy";
    }
  } catch (e) {
    if (process.env.OPENCLUTTER_STAGE_LOG) {
      process.stderr.write("stage core-fail " + (Date.now() - started) + "\n");
    }
    if (overtureJob) overtureJob.ctrl.abort();
    if (terrainJob) terrainJob.ctrl.abort();
    if (chmJob) chmJob.ctrl.abort();
    if (coverJob) coverJob.ctrl.abort();
    if (outdoorJob) outdoorJob.ctrl.abort();
    if (forestJob) forestJob.ctrl.abort();
    if (detailJob) detailJob.ctrl.abort();
    return json(502, cors, { error: describeCoreFailure(e) });
  }

  // Production and every dev quality already started Overture with the JPEG.
  // This opens the read only when that start did not happen.
  const devLeft = answerMs - (Date.now() - started);
  const devSlice = devHost && devLeft >= 800 ? Math.min(DEV_OPTIONAL_MS, devLeft - 400) : 0;
  if (devHost && (sharpRoom ? devLeft >= 800 : devSlice >= 200) && overtureFrame && needImage) {
    if (!overtureJob) {
      overtureJob = beginOptional((signal) =>
        fetchOvertureImpl(overtureFrame, { signal, filter: padFootprintBbox(overtureFrame) })
      );
    }
    if (readTerrain && !terrainJob) {
      terrainJob = beginOptional((signal) =>
        fetchTerrainDemImpl(frame, null, {
          signal,
          terrainResolution,
          terrainStyle,
          allowSurfaceFallback: true,
          deadlineMs: started + answerMs,
          fitAnswerClock: true,
          backgroundDem: background,
          skip3depProbe: !frameHas3dep(frame),
        })
      );
    }
    if (includeFoliage && !coverJob) {
      coverJob = beginOptional((signal) =>
        fetchWorldCoverImpl(
          {
            west: frame.west,
            south: frame.south,
            east: frame.east,
            north: frame.north,
          },
          { signal }
        )
      );
    }
    if (includeFoliage && !chmJob) {
      chmJob = beginOptional((signal) =>
        fetchChmGridImpl(
          {
            west: frame.west,
            south: frame.south,
            east: frame.east,
            north: frame.north,
          },
          { signal }
        )
      );
    }
  }
  const overturePromise = overtureJob
    ? joinOptional(
        warnings,
        started,
        "Overture buildings",
        overtureJob,
        devHost ? devChmWait(started, background || sharpRoom ? answerMs : undefined) : overtureWait(frame)
      )
    : Promise.resolve(null);
  // The height read overlaps the aerial. On dev it stops with the answer
  // clock. A read that ignores that stop used to hold the function until
  // the gateway answered with no zip.
  const chmPromise = chmJob
    ? joinOptional(
        warnings,
        started,
        "Canopy height",
        chmJob,
        background
          ? chmJoinWait(started, true, answerMs)
          : devHost
            ? devChmWait(started, sharpRoom ? answerMs : undefined)
            : {
                graceMs: 8000,
                hardMs: EXPORT_ANSWER_MS,
              }
      )
    : Promise.resolve(null);
  // World cover starts with the map. The join clock is already running, so
  // buildings are not held for it. The fill step reads whatever came back.
  coverPromise = coverJob
    ? background
      ? joinOptional(warnings, started, "World cover", coverJob, coverJoinWait(started, true))
      : joinQuiet(coverJob, started, coverJoinWait(started, false))
    : Promise.resolve(null);
  const terrainFollow =
    !includeTerrain || devHost
      ? { preset: null, job: devHost ? terrainJob : null, join: null }
      : await followUpTerrain(terrainJob, started, frame, devHost, terrainResolution, terrainStyle);
  const demPromise = terrainFollow.preset
    ? Promise.resolve(terrainFollow.preset)
    : terrainFollow.job
      ? joinOptional(
          warnings,
          started,
          "Terrain",
          terrainFollow.job,
          devHost ? devTerrainWait(started, answerMs) : terrainFollow.join
        )
      : Promise.resolve(null);
  if (readTerrain) reportProgress({ stage: "Reading terrain" });
  const slowWatch = watchSlowStages([
    { label: "Canopy height", open: () => !!(chmJob && !chmJob.isSettled()) },
    { label: "World cover", open: () => !!(coverJob && !coverJob.isSettled()) },
    { label: "Lidar heights", open: () => lidarOn && !lidarSettled },
    { label: "Lidar canopy", open: () => !lidarOn && lidarCanopyOn && !lidarSettled },
  ]);
  slowWatch.tick();
  let optional;
  try {
    optional = await Promise.all([overturePromise, demPromise, chmPromise]);
  } finally {
    slowWatch.stop();
  }
  overturePack = optional[0] || { features: [] };
  const demPack = optional[1];
  let demKind = null;
  let demAttribution = null;
  if (Array.isArray(demPack)) {
    demSamples = demPack;
  } else if (demPack && Array.isArray(demPack.samples)) {
    demSamples = demPack.samples;
    demKind = demPack.kind;
    demAttribution = demPack.attribution;
    if (Array.isArray(demPack.notes)) {
      for (let i = 0; i < demPack.notes.length; i++) warnings.push(demPack.notes[i]);
    }
  } else {
    demSamples = null;
  }
  if (readTerrain) {
    reportProgress({
      step:
        demSamples && demSamples.length
          ? { id: "terrain", detail: demSamples.length + " pts" }
          : { id: "terrain", skipped: true, detail: "left out" },
    });
  }
  chmGrid = optional[2] && optional[2].values ? optional[2] : null;
  const chmTimedOut =
    includeFoliage &&
    !chmGrid &&
    warnings.some((w) => /Canopy height omitted:/.test(String(w)) && /timed out|export budget/i.test(String(w)));
  if (chmTimedOut) {
    warnings.push("Foliage omitted: canopy height timed out. Buildings in this zip are unchanged.");
    if (coverJob && !coverJob.isSettled()) coverJob.ctrl.abort();
  }

  treesSource = normalizeTreesSource(treesSource, treePoints.length);

  const arcgisFeatures = (gj && gj.features) || [];
  const overtureFeatures = (overturePack && overturePack.features) || [];
  // Conflation is pairwise. A dense row group can return several thousand
  // rings; keep the largest 2000 from each source before that pass. The zip
  // cannot carry more than that anyway.
  const SOURCE_CAP = 2000;
  const capSource = (list) => (list.length > SOURCE_CAP ? largestFeatures(list, SOURCE_CAP, frame.mpd) : list);
  const assembled = assembleFootprints({
    global: capSource(globalFeatures),
    overture: capSource(overtureFeatures),
    arcgis: capSource(arcgisFeatures),
    usa: capSource(usaFeatures),
  });
  let features = assembled.features;
  if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage buildings " + (Date.now() - started) + "\n");
  reportProgress({ stage: "Buildings " + features.length });
  reportProgress({ step: { id: "buildings", detail: String(features.length) } });
  const sources = assembled.heightSources || {};
  const footprintMeta = {
    globalFootprints: globalFeatures.length,
    arcgisFootprints: arcgisFeatures.length,
    usaFootprints: usaFeatures.length,
    overtureFootprints: overtureFeatures.length,
    overtureAdded: assembled.overtureAdded || 0,
    msHeights: sources["ms-global"] || 0,
    overtureHeights: sources.overture || 0,
    femaHeights: sources.fema || 0,
    floorHeights: sources["overture-floors"] || 0,
    imageryRoofs: 0,
    medianTrees: 0,
    chmTrees: 0,
  };
  // Imagery roof fill walks every footprint. A campus that already has the
  // vector layers does not get that pass; Oak Creek (far fewer roofs) still does.
  const skipRoofFill = features.length > DENSE_FEATURES;
  // A national leaf-on summer photo, where a country publishes one, checks
  // crowns drawn from an estimated canopy height map. It loads alongside.
  const leafOnJob = includeFoliage && frame ? fetchLeafOnPhoto(frame).catch(() => null) : null;
  let decoded = needImage && !skipRoofFill ? decodeImagery(imgBuf) : null;
  // A plate near 10 MP is past the 6 MP roof decode. Canopy color still
  // needs those pixels, and the roof path already accepts that size.
  if (!decoded && needImage && imgBuf && includeFoliage) decoded = decodeRoofImagery(imgBuf);
  // The photo checks were tuned on Esri. A NAIP or national plate is levelled
  // to Esri's colour range first so its haze does not read as water or paving.
  const levelPhoto = levelForAnalysis(imageryCtx);
  if (decoded && levelPhoto) decoded = normalizeAerial(decoded);
  if (skipRoofFill) {
    warnings.push("Imagery roof fill omitted: this draw already has a full set of building footprints.");
  }
  if (decoded) {
    try {
      const sup = supplementFootprints(decoded, frame, features);
      features = sup.features;
      footprintMeta.imageryRoofs = sup.imageryRoofs;
      footprintMeta.droppedShadow = sup.droppedShadow || 0;
      const pav = rejectPavementFootprints(decoded, frame, features);
      features = pav.features;
      footprintMeta.droppedPavement = pav.dropped;
    } catch {
      // Imagery roof fill is optional. Vector footprints still export.
    }
  }
  let guidewayFeatures = [];
  let osmWater = [];
  let bridgeFeatures = [];
  let planningPlaces = [];
  function takePlaces(pack) {
    const spots = pack && pack.places;
    if (!Array.isArray(spots)) return;
    for (let i = 0; i < spots.length; i++) planningPlaces.push(spots[i]);
  }
  if (detailJob) {
    if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage detail " + (Date.now() - started) + "\n");
    const pack = await detailJob.work;
    if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage shaped " + (Date.now() - started) + "\n");
    if (pack && pack !== TIMED_OUT && Array.isArray(pack.notes)) {
      for (let i = 0; i < pack.notes.length; i++) {
        if (pack.notes[i] && warnings.indexOf(pack.notes[i]) < 0) warnings.push(pack.notes[i]);
      }
    }
    if (pack && pack !== TIMED_OUT && pack.ok !== false) {
      takePlaces(pack);
      guidewayFeatures = pack.guideways || [];
      bridgeFeatures = pack.bridges || [];
      osmWater = pack.water || [];
      try {
        const roofRaw = decoded || (levelPhoto ? normalizeAerial(decodeRoofImagery(imgBuf)) : decodeRoofImagery(imgBuf));
        const shaped = shapeBuildings(features, Object.assign({}, pack, {
          imagery: roofRaw
            ? { data: roofRaw.data, width: roofRaw.width, height: roofRaw.height, frame }
            : null,
        }));
        features = shaped.features;
        footprintMeta.osmParts = shaped.stats.parts;
        footprintMeta.poolOpenings = shaped.stats.openings;
        footprintMeta.parentsDropped = shaped.stats.parentsDropped;
        footprintMeta.largeDropNotes = shaped.stats.largeDrops || [];
      } catch {
        warnings.push("Building outlines kept the source footprint. A pool cut did not finish.");
      }
    }
  }
  gj = { type: "FeatureCollection", features };

  const clientHits = normalizeCanopyHits(body.canopyHits);
  let placeHits =
    clientHits.length > 0
      ? clientHits
      : treesSource === "nlcd-canopy"
        ? normalizeCanopyHits(serverCanopyHits)
        : [];
  if (includeFoliage && placeHits.length && treesSource === "nlcd-canopy") {
    const preview = footprintsToClutter(features, frame);
    treePoints = pickCanopyTrees(placeHits, frame, {
      maxTrees: maxTreesForBbox(frame),
      reject: (lon, lat) => treeHitsBuilding(lon, lat, frame, preview.aabbs),
    });
  }
  if (includeFoliage && chmGrid && treePoints.length) {
    const applied = applyChmToTrees(treePoints, (lon, lat) => sampleChmGrid(chmGrid, lon, lat));
    treePoints = applied.trees;
    footprintMeta.chmTrees = applied.applied;
  }

  if (includeFoliage && wantOsm(body)) {
    try {
      const osm = await fetchOsmTreeNodes(frame.west, frame.south, frame.east, frame.north, UA);
      treePoints = treePoints.concat(osm);
    } catch {
      // OSM is optional; canopy / imagery vegetation still applies.
    }
  }

  let warehouseMembranes = 0;
  for (let i = 0; i < features.length; i++) {
    const src = features[i] && features[i].properties && features[i].properties.heightSource;
    if (src === "warehouse") warehouseMembranes++;
  }
  let lidarYards = [];
  let lidarCanopy = null;
  // The canopy lidar, kept so its roof heights can scale photo shadows even
  // when lidar heights are off.
  let scaleLidar = null;
  // The lidar grid either way, for outlines on empty RV pads.
  let padLidar = null;
  if (lidarCanopyOn && !lidarOn && !chmTimedOut) {
    try {
      if (!lidarSettled) {
        reportProgress({ stage: "Lidar canopy" });
        await flushProgress();
      }
      const lidar = await lidarPromise;
      scaleLidar = lidar;
      if (lidar && !lidar.skipped && lidar.grid) padLidar = lidar.grid;
      if (exportMode.isSiteTypes() && lidar && !lidar.skipped && lidar.grid) {
        // Model heights the lidar contradicts (a park model at 20 m) take the lidar height.
        const checked = checkSourceHeights(features, lidar.grid);
        if (checked.fixed) {
          features = checked.features;
          footprintMeta.lidarHeightFixes = checked.fixed;
          warnings.push("Took " + checked.fixed + " roof height" + (checked.fixed === 1 ? "" : "s") + " from the lidar under the roof where the model height was missing or far too tall.");
        }
      }
      lidarCanopy = fuseCanopyFromLidar(lidar);
    } catch {
      lidarCanopy = null;
    }
  }
  function fuseCanopyFromLidar(lidar) {
    if (!lidar || lidar.skipped || !lidar.grid) return null;
    const fused = fuseLidarCanopy(chmGrid, lidar, { frame, buildings: features });
    if (!fused || !fused.stats.cellsDecided) return null;
    chmGrid = fused.grid;
    fused.original = new Uint8Array(fused.grid.values);
    footprintMeta.lidarCanopy = fused.stats.lidarCanopy;
    footprintMeta.lidarCanopyStats = fused.stats;
    footprintMeta.lidarProject = lidar.project || "";
    footprintMeta.lidarCollected = lidar.collected || "";
    footprintMeta.lidarMs = lidar.ms || 0;
    if (process.env.OC_LIDAR_DEBUG) process.stderr.write("lidarcanopy " + JSON.stringify(fused.stats) + " frame " + JSON.stringify([frame.west, frame.south, frame.east, frame.north]) + " lid " + JSON.stringify(lidar.frame) + " partial " + lidar.partial + " pts " + lidar.points + "\n");
    const note = lidarCanopyNote(fused.stats);
    if (note && warnings.indexOf(note) < 0) warnings.push(note);
    return fused;
  }
  if (lidarOn) {
    try {
      if (!lidarSettled) {
        reportProgress({ stage: "Lidar heights" });
        await flushProgress();
      }
      const lidar = await lidarPromise;
      if (!lidar) {
        warnings.push("Lidar heights not used.");
      } else {
        if (!lidar.skipped && lidar.grid) {
          padLidar = lidar.grid;
          const applied = applyLidarSample(features, treePoints, lidar.grid);
          features = applied.features;
          treePoints = applied.trees;
          lidar.heights = applied.heights;
          lidar.added = applied.added;
          lidar.canopy = applied.canopy;
          footprintMeta.lidarHeights = applied.heights;
          footprintMeta.lidarAdded = applied.added;
          footprintMeta.lidarCanopy = applied.canopy;
          if (applied.yards && applied.yards.length) lidarYards = applied.yards;
          if (lidarCanopyOn && !chmTimedOut) lidarCanopy = fuseCanopyFromLidar(lidar);
        }
        footprintMeta.lidarProject = lidar.project || "";
        footprintMeta.lidarCollected = lidar.collected || "";
        footprintMeta.lidarPoints = lidar.points || 0;
        footprintMeta.lidarBytes = lidar.bytes || 0;
        footprintMeta.lidarSpacing = lidar.spacingM || 0;
        footprintMeta.lidarMs = lidar.ms || 0;
        const status = lidarStatusLine(lidar);
        if (warnings.indexOf(status) < 0) warnings.push(status);
        const used = status === "Lidar heights used.";
        const note = used ? lidarNote(lidar) : "";
        if (note && warnings.indexOf(note) < 0) warnings.push(note);
      }
    } catch {
      warnings.push("Lidar heights not used.");
    }
  }

  // Cast shadows on the photo. A vector outline with no shadow on lit bare
  // ground was torn down after it was traced; stacked goods in a yard throw
  // shadows as long as they are tall. The plate is decoded once for both.
  let shadowPlate = null;
  let shadowScene = null;
  if (imgBuf && frame && features.length) {
    try {
      shadowPlate = decoded && decoded.width === frame.imgW && decoded.height === frame.imgH ? decoded : decodeRoofImagery(imgBuf);
      if (shadowPlate) {
        // Lidar roof heights scale the shadows. Only the scale is read here;
        // outlines keep their source heights when lidar heights are off.
        let heights = null;
        if (!lidarOn && scaleLidar && !scaleLidar.skipped && scaleLidar.grid) {
          heights = features.map((f) => {
            const rings = featureExteriorRings(f && f.geometry);
            for (let r = 0; r < rings.length; r++) {
              const h = heightForRing(scaleLidar.grid, rings[r]);
              if (h != null) return h;
            }
            return null;
          });
        }
        const ghost = rejectShadowless(shadowPlate, frame, features, { heights });
        shadowScene = ghost.scene;
        if (ghost.dropped) {
          features = ghost.features;
          footprintMeta.droppedShadowless = ghost.dropped;
          warnings.push(
            "Left out " + ghost.dropped + " building outline" + (ghost.dropped === 1 ? "" : "s") + " with no roof shadow on the photo: bare ground where the source still maps a building."
          );
        }
      }
    } catch {
      shadowPlate = null;
    }
  }

  let terrain = null;
  if (clientLift.length >= 4 && frame) {
    try {
      terrain = terrainFromSamples(clientLift, frame, {
        terrainResolution,
        terrainStyle,
        kind: clientLiftKind,
        terrainFloors,
      });
    } catch {
      terrain = null;
    }
  } else if (demSamples && demSamples.length && frame) {
    try {
      terrain = terrainFromSamples(demSamples, frame, {
        terrainResolution,
        terrainStyle,
        kind: demKind,
        attribution: demAttribution,
        terrainFloors,
      });
      if (terrain) {
        const notes = terrainResolutionNotes(terrain, frame);
        for (let i = 0; i < notes.length; i++) warnings.push(notes[i]);
      }
    } catch {
      terrain = null;
    }
  }
  if (readTerrain && needImage) noteMissingTerrain(terrain, warnings);
  if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage terrain " + (Date.now() - started) + "\n");

  let maskRings = [];
  let maskPolygons = [];
  if (
    includeFoliage &&
    decoded &&
    frame &&
    decoded.width === frame.imgW &&
    decoded.height === frame.imgH
  ) {
    try {
      const masks = surfaceMasksFromImage(decoded, frame);
      maskRings = masks.waterRings;
      maskPolygons = masks.pavementPolygons;
    } catch {
      maskRings = [];
      maskPolygons = [];
    }
  }

  // Road carriageways, rail beds, the monorail and elevated decks keep no
  // canopy. The mapped width is cut out; a median or verge outside it keeps
  // the trees the aerial and canopy height show there.
  if (includeFoliage && frame && outdoorJob) {
    try {
      const pack = await Promise.race([
        outdoorJob.work,
        new Promise((r) => setTimeout(() => r(null), background ? 20000 : 1500)),
      ]);
      const corridors = pack && pack !== TIMED_OUT && pack.ok !== false ? pack.corridors || [] : [];
      const mpu = Math.max(frame.mpuX || 1, 0.05);
      const extra = corridorMaskPolygons(corridors, frame, mpu, !!lidarCanopy);
      if (extra.length) maskPolygons = (maskPolygons || []).concat(extra);
    } catch {
      /* keep the image masks */
    }
  }

  let woodRings = [];
  let openRuns = [];
  if (includeFoliage && forestJob) {
    const forest = await forestJob.work;
    if (forest && forest !== TIMED_OUT && forest.ok !== false) {
      woodRings = forest.wood || [];
      // A piste corridor is tens of metres wide and used to notch the
      // measured woods out of the zip. The run stays empty where the height
      // model has no crown. A tree the model already measured stays.
      openRuns = forest.pistes || [];
      const forestNotes = forest.notes || [];
      for (let i = 0; i < forestNotes.length; i++) {
        if (warnings.indexOf(forestNotes[i]) < 0) warnings.push(forestNotes[i]);
      }
    }
  }

  if (includeFoliage && !chmTimedOut && coverJob && !coverJob.isSettled()) {
    reportProgress({ stage: "World cover" });
    await flushProgress();
  }
  if (coverPromise) {
    try {
      worldCover = await coverPromise;
    } catch {
      worldCover = null;
    }
  }
  if (includeFoliage && !chmTimedOut) {
    reportProgress({ stage: "Trees" });
    await flushProgress();
  }

  // Water has no canopy. Dark open water reads as a dark conifer stand, and
  // the height model carries noise over a harbor, so crowns stood on the bay.
  // WorldCover water (sea included) and OSM water polygons clear those cells
  // and points. A shoreline crown or an island stays.
  let waterTest = null;
  if (includeFoliage) {
    const polys = osmWater;
    try {
      waterTest = createWaterTest({ worldcover: worldCover, waterPolygons: polys });
    } catch {
      waterTest = null;
    }
    if (waterTest) {
      footprintMeta.waterCanopyCells = clearWaterCanopy(chmGrid, waterTest);
      const pts = dropWaterPoints(treePoints, waterTest);
      treePoints = pts.points;
      const hits = dropWaterPoints(placeHits, waterTest);
      placeHits = hits.points;
      footprintMeta.waterTreesDropped = pts.dropped + hits.dropped;
    }
  }

  // Gap fill runs on a worker while the rest of this stage prepares
  // footprints. It used to sit on the Trees clock before any tile started.
  let fillPromise = null;
  if (includeFoliage && !chmTimedOut && decoded && frame) {
    const fillOpts = { frame, image: decoded, worldcover: worldCover, openRuns };
    if (background) {
      fillPromise = detectParallel.fillInWorker(chmGrid, fillOpts).catch(() => {
        try {
          return fillCanopyGaps(chmGrid, fillOpts);
        } catch {
          return null;
        }
      });
    } else {
      try {
        fillPromise = Promise.resolve(fillCanopyGaps(chmGrid, fillOpts));
      } catch {
        fillPromise = null;
      }
    }
  }

  // 720 keeps the largest canopies and fills the rest with measured crowns.
  // A site with few buildings has JSON room for more, so the cap rises with
  // that headroom up to 1200. The OpenIntent byte budget still drops the rest.

  async function emitClutter(list, extraWarnings) {
    // The API result has no OpenIntent size limit, so it keeps more crowns.
    const foliageCap =
      format === "site-v1"
        ? Math.min(SITE_V1_FOLIAGE_MAX, foliageCapFor(list ? list.length : 0) * 3)
        : foliageCapFor(list ? list.length : 0);
    const slopeTop = demUnderFootprint(terrain);
    const areaCap = areaCapOverride > 0 ? areaCapOverride | 0 : DEFAULT_AREA_CAP;
    const buildingCeiling =
      areaCap > MAX_ATTENUATION_AREAS ? Math.max(MAX_BUILDINGS, areaCap) : MAX_BUILDINGS;
    let foliagePack = null;
    let outdoorPlan = null;
    let preview = null;
    const wantParallel =
      background &&
      ((includeFoliage && !chmTimedOut) ||
        outdoorFeatures.length ||
        guidewayFeatures.length ||
        bridgeFeatures.length);
    if (wantParallel) {
      preview = footprintsToClutter(list, frame, affine, slopeTop, { buildingCeiling });
    }
    // Poles the lidar found (one tall cell, far lower around it) are drawn as
    // light poles only where the photo shows a pole's thin shadow too; the
    // rest stay out. A flat lamp bank is drawn on the lidar alone. Either way
    // they are not trees.
    {
      const lst = footprintMeta.lidarCanopyStats;
      const spots = (lst && lst.poleSpots) || [];
      if (lst) delete lst.poleSpots;
      const mpp = frame && frame.imgW ? (frame.widthM || 0) / frame.imgW : 0;
      let drawn = 0;
      let measuredMapped = 0;
      let lampsDrawn = 0;
      const hs = [];
      if (includePoles && spots.length && decoded && decoded.width === frame.imgW && decoded.height === frame.imgH) {
        const have = outdoorFeatures.filter((f) => f && f.kind === "pole" && f.coords && f.coords[0]);
        for (const p of spots) {
          if (!(p.heightM <= POLE_MAX_H_M)) continue;
          if (nearBuilding(p.lon, p.lat, features, POLE_BUILDING_GAP_M)) continue;
          const [px, py] = llToPx(p.lon, p.lat, frame);
          // A lamp bank the lidar measured as a flat block alone in the open
          // is a pole on its own evidence. A field light stands on grass, and
          // the shadow test reads grass beside the spot as a tree.
          if (!p.lamp) {
            const c = poleShadowContrast(decoded, px, py, p.heightM, mpp);
            if (!(c >= POLE_SHADOW_MIN)) continue;
          }
          // A mapped street lamp at the same spot is the same pole. The lidar
          // measures it, unless the map tags its own height.
          const mx = 111320 * Math.cos((p.lat * Math.PI) / 180);
          const same = have.find((q) => Math.hypot((q.coords[0][0] - p.lon) * mx, (q.coords[0][1] - p.lat) * 111320) < 3);
          if (same) {
            if (!same.explicitHeight) {
              same.heightM = p.heightM;
              same.explicitHeight = true;
              measuredMapped++;
            }
            continue;
          }
          outdoorFeatures.push({ kind: "pole", coords: [[p.lon, p.lat]], closed: false, heightM: p.heightM, explicitHeight: true, rank: 3 });
          drawn++;
          if (p.lamp) lampsDrawn++;
          hs.push(p.heightM);
        }
      }
      footprintMeta.lidarPoleSpots = spots.length;
      footprintMeta.lidarPolesDrawn = drawn;
      footprintMeta.mappedPolesMeasured = measuredMapped;
      footprintMeta.lidarLampPoles = lampsDrawn;
      if (drawn) {
        hs.sort((a, b) => a - b);
        warnings.push("Light poles from lidar: " + drawn + " (" + Math.round(hs[0]) + " to " + Math.round(hs[hs.length - 1]) + " m tall), " + (lampsDrawn === drawn ? "each a lamp bank alone in the open." : lampsDrawn ? lampsDrawn + " of them lamp banks alone in the open, the rest with a pole shadow on the photo." : "each with a pole shadow on the photo."));
      }
    }
    const parallelTasks = [];
    if (background && (outdoorFeatures.length || guidewayFeatures.length || bridgeFeatures.length)) {
      if (process.env.OPENCLUTTER_STAGE_LOG) {
        process.stderr.write("stage outdoor-parallel " + outdoorFeatures.length + "\n");
      }
      const buildings = [];
      if ((includeWater === true || includeParking === true || includeRvs === true || includeCars === true) && outdoorOn && outdoorMiss !== true) {
        for (let i = 0; i < preview.oiAreas.length; i++) {
          buildings.push({
            index: i,
            ringPx: preview.overlayRings[i],
            material: preview.oiAreas[i] && preview.oiAreas[i].area_material,
          });
        }
      }
      const liveOutdoor =
        outdoorOn && outdoorMiss !== true
          ? outdoorFeatures
          : outdoorFeatures.filter((feat) => feat && feat.kind === "storage");
      const outdoorForPlan =
        includeCars === true ? liveOutdoor : liveOutdoor.filter((feat) => !feat || feat.kind !== "car");
      const deckCapNow = raisedDeckCap(areaCapOverride);
      parallelTasks.push(
        stageClock
          .timeSpan("vehicle", () =>
            detectParallel.outdoorParallel({
              features: outdoorForPlan.concat(guidewayFeatures, bridgeFeatures),
              frame,
              buildings,
              parkingRings:
                includeParking === true && outdoorOn && outdoorMiss !== true ? preview.parkingRings || [] : [],
              segmentCaps:
                deckCapNow > 0
                  ? { guideway: deckCapNow, bridge: deckCapNow, footbridge: Math.max(12, Math.floor(deckCapNow / 5)) }
                  : undefined,
              terrain,
              imgBuf,
            })
          )
          .then((plan) => {
            outdoorPlan = plan;
          })
          .catch((err) => {
            if (process.env.OPENCLUTTER_STAGE_LOG) {
              process.stderr.write("stage outdoor-parallel-fail " + (err && err.message ? err.message : err) + "\n");
            }
            outdoorPlan = null;
          })
      );
    }
    if (fillPromise) {
      try {
        const filled = await fillPromise;
        if (filled && filled.values && filled.nonzero > 0) {
          chmGrid = filled;
          // The gap fill reads the aerial. Where the lidar measured open
          // ground or a crown, the measurement stands.
          if (lidarCanopy) {
            const fillNz = chmGrid.nonzero;
            const reverted = keepLidarOpen(chmGrid, lidarCanopy.decided, lidarCanopy.original);
            if (process.env.OC_LIDAR_DEBUG) process.stderr.write("lidarfill nz " + fillNz + " reverted " + reverted + " now " + chmGrid.nonzero + "\n");
          }
          if (waterTest) footprintMeta.waterCanopyCells = (footprintMeta.waterCanopyCells || 0) + clearWaterCanopy(chmGrid, waterTest);
        }
      } catch {
        // The measured grid still ships when the fill cannot be read.
      }
    }
    // OSM woods are an unmeasured outline painted at one guessed height, and
    // Overpass answers some runs and not others. Where a measured height grid
    // covers the draw it decides the canopy, so the result no longer depends
    // on whether that fetch came back.
    if (woodRings.length && chmGrid && chmGrid.nonzero > 0) {
      footprintMeta.woodRingsSkipped = woodRings.length;
      woodRings = [];
    }
    if (lidarCanopy && chmGrid) {
      // Trailers, RVs, cars, and storage stacks are not crowns.
      footprintMeta.vehicleCanopyCells = clearInside(chmGrid, vehicleFeatures(outdoorFeatures));
      // A guideway or gantry beam is one cell wide and level; it is not a crown.
      footprintMeta.lineCanopyCells = clearThinLinesGrid(chmGrid);
      // The flight measured the RVs parked that day and trees cut since. A
      // cell the current leaf-on photo shows as a vehicle, roof or bare
      // ground with no foliage is not canopy (/dev hosts). Only inside a
      // mapped RV park, campground or mobile home park.
      const vehicleZone = exportMode.isPhotoCanopy() ? vehicleZoneTest(outdoorFeatures) : null;
      if (vehicleZone && decoded && frame && decoded.width === frame.imgW && decoded.height === frame.imgH) {
        try {
          const checked = checkCanopyOnPhoto(chmGrid, decoded, frame, vehicleZone);
          footprintMeta.photoCanopy = checked;
          footprintMeta.photoCanopyZone = vehicleZone;
          const midLat = ((+chmGrid.north + +chmGrid.south) / 2) * (Math.PI / 180);
          const cellM2 =
            ((+chmGrid.east - +chmGrid.west) / chmGrid.width) * 111320 * Math.cos(midLat) *
            (((+chmGrid.north - +chmGrid.south) / chmGrid.height) * 110540);
          const note = photoCanopyNote(checked, cellM2);
          if (note && warnings.indexOf(note) < 0) warnings.push(note);
          // Each lidar crown in those zones takes the outline of its own
          // leaves on the same photo (/dev hosts).
          if (checked.gate && exportMode.isPhotoCrowns()) photoCrowns = photoCrownRefiner(decoded, frame, vehicleZone);
        } catch {
          // The lidar canopy stands when the photo cannot be read.
        }
      }
    }
    if (background && includeFoliage && !chmTimedOut) {
      if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage trees-parallel\n");
      parallelTasks.push(
        stageClock
          .timeSpan("tree", () =>
            detectParallel.treePairsParallel(treePoints, frame, preview.aabbs, affine, {
              canopyHits: placeHits,
              chmGrid,
              buildingRings: preview.overlayRings,
              maskRings,
              maskPolygons,
              woodRings,
              palmPoints,
              // Lidar crowns are always split per tree. A blob on an estimated
              // canopy height map larger than one crown is split too, but only
              // along a real height valley between two tops.
              segmentTrees: SEGMENT_TREES,
              segmentMinM2: lidarCanopy ? 0 : ESTIMATED_SPLIT_MIN_M2,
              terrain,
              omitFoliage: false,
              chmRequired: true,
              // Per-tree lidar crowns need more outlines than whole stands.
              // The zip budget still trims after this.
              maxPolygons: SEGMENT_TREES && lidarCanopy ? Math.round(foliageCap * SEGMENT_CAP_SCALE) : foliageCap,
              photoCrowns,
            })
          )
          .then((pack) => {
            foliagePack = pack;
          })
          .catch((err) => {
            if (process.env.OPENCLUTTER_STAGE_LOG) {
              process.stderr.write("stage trees-parallel-fail " + (err && err.message ? err.message : err) + "\n");
            }
            foliagePack = null;
          })
      );
    }
    if (parallelTasks.length) await Promise.all(parallelTasks);
    if (photoCrowns && foliagePack) {
      footprintMeta.photoCrowns = photoCrowns.stats;
      const crownNote = photoCrownNote(photoCrowns.stats);
      if (crownNote && warnings.indexOf(crownNote) < 0) warnings.push(crownNote);
    }
    if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage build-clutter\n");
    const leafOnPhoto = leafOnJob ? await leafOnJob : null;
    if (imageryCtx && imageryCtx.esriCitationJob && imageryCtx.esriCitation === undefined) {
      await Promise.race([imageryCtx.esriCitationJob, new Promise((r) => setTimeout(r, 300))]);
    }
    return buildClutter({
      palmPoints,
      frame,
      footprintsGeojson: { type: "FeatureCollection", features: list },
      treePoints,
      affine,
      name: body.name,
      imgBuf,
      treesSource,
      footprintMeta,
      terrain,
      warnings: extraWarnings ? warnings.concat(extraWarnings) : warnings,
      canopyHits: chmTimedOut ? [] : placeHits,
      heightSample: !chmTimedOut && chmGrid ? (lon, lat) => sampleChmGrid(chmGrid, lon, lat) : null,
      chmGrid: chmTimedOut ? null : chmGrid,
      maskRings,
      maskPolygons,
      woodRings,
      includeFoliage,
      omitFoliage: chmTimedOut,
      chmRequired: includeFoliage,
      maxFoliagePolygons: foliageCap,
      photoCrowns: foliagePack ? null : photoCrowns,
      terrainResolution,
      terrainStyle,
      nlsHeights: devHost,
      outdoorFeatures,
      outdoorNotes,
      includeWater,
      includeParking,
      includeWalls,
      includePoles,
      includeRvs,
      includeCars,
      outdoorMiss,
      guidewayFeatures,
      includeGuideways: true,
      bridgeFeatures,
      includeBridges: true,
      maxAttenuationAreas: areaCapOverride || undefined,
      areaCapOverride: areaCapOverride > 0,
      jsonBudget: jsonBudgetOverride || undefined,
      foliagePack,
      outdoorPlan,
      aerialOpenShare:
        decoded && frame && decoded.width === frame.imgW && decoded.height === frame.imgH
          ? openShareSampler(decoded)
          : null,
      photoLeafyShare:
        footprintMeta.photoCanopy && footprintMeta.photoCanopy.gate && decoded && frame && decoded.width === frame.imgW && decoded.height === frame.imgH
          ? zonedShareSampler(leafyShareSampler(decoded, { heightAt: chmGrid ? gridHeightAt(chmGrid) : null, frame }), footprintMeta.photoCanopyZone, frame)
          : null,
      leafOnGreenShare: leafOnPhoto ? leafOnGreenSampler(leafOnPhoto, frame.mpuX) : null,
      aerialGreenShare:
        decoded && frame && decoded.width === frame.imgW && decoded.height === frame.imgH && footprintMeta.lidarCanopyStats
          ? leafOnGreenSampler({ data: decoded.data, width: decoded.width, height: decoded.height, have: new Uint8Array(decoded.width * decoded.height).fill(1) }, frame.mpuX)
          : null,
      leafOnSource: leafOnPhoto ? leafOnPhoto.source : "",
      imagery: imageryCtx ? imagerySource.imageryInfo(imageryCtx) : null,
    });
  }

  let shrinkNote = "";
  function noteShrink(before, after) {
    if (!(before > after)) return;
    shrinkNote = "Kept the " + after + " largest, tallest roofs so the zip can download.";
  }

  let outdoorFeatures = [];
  let outdoorNotes = [];
  let palmPoints = [];
  let outdoorMiss = false;
  let osmTilesStats = null;
  if (outdoorJob) {
    const pack = await outdoorJob.work;
    if (pack && pack !== TIMED_OUT && pack.osmTiles && exportMode.isTiledOsm() && testHost) osmTilesStats = pack.osmTiles;
    if (!pack || pack === TIMED_OUT || pack.ok === false) {
      outdoorMiss = true;
      warnings.push(OUTDOOR_MISS);
    } else {
      outdoorFeatures = pack.features || [];
      outdoorNotes = pack.notes || [];
      palmPoints = Array.isArray(pack.palms) ? pack.palms : [];
      takePlaces(pack);
      const rest = [];
      const fromOutdoor = [];
      const fromBridges = [];
      for (let i = 0; i < outdoorFeatures.length; i++) {
        const feat = outdoorFeatures[i];
        if (feat && feat.kind === "guideway") fromOutdoor.push(feat);
        else if (feat && feat.kind === "bridge") fromBridges.push(feat);
        else rest.push(feat);
      }
      outdoorFeatures = rest;
      if (!guidewayFeatures.length && fromOutdoor.length) guidewayFeatures = fromOutdoor;
      if (!bridgeFeatures.length && fromBridges.length) bridgeFeatures = fromBridges;
    }
  }

  if (lidarYards.length) outdoorFeatures = outdoorFeatures.concat(lidarYards);
  // Where lidar did not measure a yard (off, or flown before the yard was
  // built), read stacks from their shadows on the photo. Mapped car parks
  // are left out: parked cars throw the same wide shadows.
  let aerialYards = [];
  if (!lidarYards.length && shadowPlate && features.length) {
    try {
      const avoid = [];
      for (let i = 0; i < outdoorFeatures.length; i++) {
        const f = outdoorFeatures[i];
        if (f && f.kind === "parking" && f.structure !== true && Array.isArray(f.coords)) avoid.push(f.coords);
      }
      const got = aerialStorageYards(shadowPlate, frame, features, { scene: shadowScene || undefined, avoid });
      aerialYards = got.yards || [];
    } catch {
      aerialYards = [];
    }
  }
  shadowPlate = null;
  if (aerialYards.length) {
    outdoorFeatures = outdoorFeatures.concat(aerialYards);
    let m2 = 0;
    let lo = Infinity;
    let hi = 0;
    for (const y of aerialYards) {
      m2 += y.areaM2 || 0;
      if (y.heightM < lo) lo = y.heightM;
      if (y.heightM > hi) hi = y.heightM;
    }
    warnings.push(
      "Stacked storage from the photo: " + aerialYards.length + " block" + (aerialYards.length === 1 ? "" : "s") + ", " + Math.round(m2) + " m², " + (lo === hi ? lo + " m" : lo + " to " + hi + " m") + " tall, read from their shadows."
    );
  }
  if (warehouseMembranes && !lidarYards.length && !aerialYards.length) {
    const storageNote = lidarOn
      ? "Stacked storage was left out. Lidar did not show a yard, and the photo showed no stack shadows."
      : "Stacked storage was left out. Lidar heights are off, the street map has no yard, and the photo showed no stack shadows.";
    if (warnings.indexOf(storageNote) < 0) warnings.push(storageNote);
  }

  let parkContextStats = null;
  // A small draw in a big RV park learns the park's pad pattern from the
  // whole park, not only the RVs inside the draw (park-context.js, 1.2.26).
  if (exportMode.isParkContext() && includeRvs === true && outdoorOn && outdoorMiss !== true && imgBuf && frame) {
    try {
      const parkFeatures = parkContextJob ? await parkContextJob : null;
      const ctx = await stageClock.timeSpan("parkContext", () =>
        require("../lib/park-context").readParkContext({
          features: outdoorFeatures,
          frame,
          ctxFeatures: parkFeatures,
          fetchPlate: (f) =>
            imagerySource.fetchPlateWith(imageryCtx, f, PARK_CONTEXT_MS, null, (pf, ms, sig) =>
              fetchImageryJpegBody(esriImageryUrl(pf), ms, sig)
            ),
          placePlate: (f, buf) => {
            const placed = applyImageryMeta(f, null, jpegSize(buf), {
              requestBbox: { west: f.west, south: f.south, east: f.east, north: f.north },
            });
            const locked = lockIsotropicImagery(placed, buf, { maxSide: Math.max(f.imgW, f.imgH) });
            return { frame: locked.frame, buf: locked.jpegBuf };
          },
        })
      );
      parkContextStats = { candidates: ctx.candidates, rvs: ctx.rvs || 0, roads: ctx.roads || 0 };
      if (ctx.frame) parkContextStats.photoPx = [ctx.frame.imgW, ctx.frame.imgH];
      if (ctx.photoMiss) parkContextStats.photoMiss = ctx.photoMiss;
      if (ctx.features.length) outdoorFeatures = outdoorFeatures.concat(ctx.features);
    } catch (err) {
      parkContextStats = { candidates: 0, rvs: 0, failed: String((err && err.message) || err).slice(0, 80) };
    }
  }

  // Building outlines left on empty RV pads: a small outline in an RV park,
  // campground or mobile-home park that the photo shows as bare pad, with
  // no height in the lidar or no shadow under clear sun (stale-footprints).
  if (exportMode.isStaleFootprints() && features.length && frame && imgBuf) {
    try {
      const zones = [];
      for (let i = 0; i < outdoorFeatures.length; i++) {
        const f = outdoorFeatures[i];
        if (!f || !f.coords || f.coords.length < 4) continue;
        if ((f.kind === "camp-zone" && f.tentOnly !== true) || f.kind === "mobile-park") zones.push(f.coords);
      }
      if (zones.length) {
        const plate =
          shadowPlate && shadowPlate.width === frame.imgW && shadowPlate.height === frame.imgH
            ? shadowPlate
            : decoded && decoded.width === frame.imgW && decoded.height === frame.imgH
              ? decoded
              : decodeRoofImagery(imgBuf);
        const stale = dropStaleCampFootprints({ features, zones, plate, frame, lidar: padLidar });
        if (stale.dropped.length) {
          features = stale.features;
          footprintMeta.droppedStalePads = stale.dropped.length;
          // The outlines still mark pads for the worst-case pad fill.
          for (let i = 0; i < stale.dropped.length; i++) {
            const g = stale.dropped[i].ring;
            if (g) outdoorFeatures.push({ kind: "stale-pad", coords: g, closed: true, heightM: 0, explicitHeight: false, rank: 0 });
          }
          warnings.push(
            "Left out " +
              stale.dropped.length +
              " building outline" +
              (stale.dropped.length === 1 ? "" : "s") +
              " on empty RV or campground pads: the photo shows bare pad there and nothing standing on it."
          );
        }
      }
    } catch {
      // The check is optional. The outlines stay.
    }
  }

  let exportFeatures = features;
  const shortLarge = !background && Math.max(frame.widthM, frame.lengthM) > SYNC_LARGE_DRAW_M;
  if (shortLarge) {
    warnings.push(
      "This draw is over 2.5 km. The short export keeps the largest roofs and a smaller map. The background export covers the full draw."
    );
    if (exportFeatures.length > SYNC_LARGE_ROOFS) {
      const before = exportFeatures.length;
      exportFeatures = largestFeatures(exportFeatures, SYNC_LARGE_ROOFS, frame.mpd);
      noteShrink(before, exportFeatures.length);
    }
  }
  if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage emit " + (Date.now() - started) + "\n");
  let built = await emitClutter(exportFeatures);
  if (parkContextStats && built && built.stats) built.stats.parkContext = parkContextStats;
  if (osmTilesStats && built && built.stats) built.stats.osmTiles = osmTilesStats;
  if (process.env.OPENCLUTTER_STAGE_LOG) process.stderr.write("stage emitted " + (Date.now() - started) + "\n");
  // The image does not count toward Hamina's JSON limit. Compress it only
  // when the zip itself cannot fit in Netlify's function response.
  if (background && built.zip && !exportJobs.zipDownloadFits(built.zip.length) && imgBuf) {
    // On /dev (1.2.29) a smaller image frees JSON room under the 9.7 MB
    // total, so the rebuilt JSON can grow; keep 200 KB spare for it.
    const room =
      exportJobs.ZIP_DOWNLOAD_MAX - (built.zip.length - imgBuf.length) - (exportMode.isBigBudget() ? 200000 : 0);
    const smaller = compressJpegToMax(imgBuf, Math.max(180000, room));
    if (smaller && smaller.length < imgBuf.length) {
      imgBuf = smaller;
      warnings.push("Map image was compressed so the zip can download.");
      built = await emitClutter(exportFeatures);
    }
  }
  if (shrinkNote && warnings.indexOf(shrinkNote) < 0) warnings.push(shrinkNote);
  if (includeFoliage && built.stats) reportProgress({ stage: "Trees " + (built.stats.treesKept || 0) });
  if (includeFoliage) {
    reportProgress({
      step: chmTimedOut
        ? { id: "trees", skipped: true, detail: "canopy timed out" }
        : { id: "trees", detail: String((built.stats && built.stats.treesKept) || 0) },
    });
  }
  {
    const st = built.stats || {};
    const vehicles =
      (+st.rvAreas || 0) + (+st.trailerAreas || 0) + (+st.semiAreas || 0) + (+st.boatAreas || 0) +
      (+st.carAreas || 0) + (+st.mobileHomeAreas || 0);
    reportProgress({
      step:
        includeRvs || includeCars
          ? { id: "vehicles", detail: String(vehicles) }
          : { id: "vehicles", skipped: true, detail: "off" },
    });
  }
  reportProgress({ stage: "Packing zip" });

  const frameHeaders = {
    "x-hamina-width-m": String(frame.widthM),
    "x-hamina-length-m": String(frame.lengthM),
    "x-hamina-mpu": String(frame.mpuX),
    "x-hamina-alignment": "import-openintent-zip",
  };

  if (format === "hamina-clipboard") {
    return {
      statusCode: 200,
      headers: {
        ...cors,
        ...frameHeaders,
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${built.slug}-hamina-clipboard.json"`,
      },
      body: JSON.stringify(built.clipboard),
    };
  }

  function terrainClipJson(t) {
    return t && t.clipboard ? JSON.stringify(t.clipboard) : "";
  }

  function refreshTerrainNotes() {
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (/^Terrain (cell size is|paste )/.test(String(warnings[i]))) warnings.splice(i, 1);
    }
    if (!terrain) return;
    const notes = terrainResolutionNotes(terrain, frame);
    for (let i = 0; i < notes.length; i++) warnings.push(notes[i]);
  }

  async function rebuildWithPasteCap(pasteJsonMax) {
    const before = terrainClipJson(terrain).length;
    let next = null;
    try {
      next = terrainFromSamples(demSamples, frame, {
        terrainResolution,
        terrainStyle,
        kind: demKind,
        attribution: demAttribution,
        pasteJsonMax,
        terrainFloors,
      });
    } catch {
      next = null;
    }
    if (!next) return false;
    terrain = next;
    refreshTerrainNotes();
    built = await emitClutter(exportFeatures);
    return terrainClipJson(terrain).length < before;
  }

  async function dropTerrainPaste() {
    if (!terrain || !terrain.clipboard) return;
    terrain = Object.assign({}, terrain, { clipboard: null, pasteOmitted: true });
    refreshTerrainNotes();
    built = await emitClutter(exportFeatures);
  }

  // Copy terrain is the bundle JSON, not a second copy inside the zip. The
  // short path fits that paste beside the zip, then drops it and keeps the
  // zip. A background job stores the zip and the paste as separate blobs, so
  // a Sharp plate must not discard the mesh. Dropping it left Copy terrain
  // as the two GPS points.
  if (!background && built.zip && demSamples && demSamples.length) {
    let guard = 0;
    while (guard < 6 && terrain && terrain.clipboard && built.zip) {
      const clipJson = terrainClipJson(terrain);
      const zipTooBig = !exportJobs.zipDownloadFits(built.zip.length);
      const payloadTooBig = estimateBundlePayload(built.zip.length, clipJson) > EXPORT_PAYLOAD_BUDGET;
      if (!zipTooBig && !payloadTooBig) break;
      const companion = built.zip.length;
      let nextMax = maxPasteJsonForCompanion(companion);
      if (!(nextMax < clipJson.length)) nextMax = Math.floor(clipJson.length * 0.7);
      if (!(nextMax >= 8000)) {
        await dropTerrainPaste();
        break;
      }
      if (!(await rebuildWithPasteCap(nextMax))) {
        await dropTerrainPaste();
        break;
      }
      guard += 1;
    }
  }

  // Direct API v1: the same model the OpenIntent writer used, as GeoJSON.
  // No zip in the response; the job stores this JSON instead.
  if (format === "site-v1") {
    const notes = wantMapNotes(event, body)
      ? buildMapNotes({
          frame,
          terrain,
          places: planningPlaces,
          features: exportFeatures,
          trees: treePoints,
          openintent: built.openintent,
        })
      : [];
    const site = buildSiteV1({
      name: typeof body.name === "string" ? body.name.slice(0, 200) : null,
      openintent: built.openintent,
      frame,
      features: exportFeatures,
      demSamples: includeTerrain && demSamples && demSamples.length ? demSamples : null,
      demKind,
      demAttribution,
      notes,
      stats: built.stats,
      warnings,
    });
    site.timings = stageClock.snapshot({
      areaM2: frame && frame.widthM && frame.lengthM ? frame.widthM * frame.lengthM : 0,
    });
    return json(200, cors, { ok: true, site });
  }

  if (!built.zip) return json(500, cors, { error: "zip missing" });
  if (!background && !exportJobs.zipDownloadFits(built.zip.length)) {
    return json(413, cors, {
      error: "This area is too large to export in one zip. Draw a smaller area and try again.",
    });
  }

  if (format === "zip") {
    return {
      statusCode: 200,
      headers: {
        ...cors,
        ...frameHeaders,
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${built.slug}-openintent.zip"`,
      },
      body: built.zip.toString("base64"),
      isBase64Encoded: true,
    };
  }

  function bundleResult() {
    const terrainFields = !includeTerrain
      ? { terrainFilename: null, terrainClipboard: null, terrainStatus: "Terrain off" }
      : deferTerrain
        ? { terrainFilename: null, terrainClipboard: null, terrainStatus: "" }
        : terrainBundleFields(built.terrain, warnings);
    // Tie points use the imported aerial, northeast at (0, 0). They are not
    // an OpenIntent field and they are not a DEM read.
    const gpsPaste = gpsClipboard(frame);
    if (terrainFields.terrainClipboard) stampGpsTiePoints(terrainFields.terrainClipboard, frame);
    if (wantMapNotes(event, body)) {
      const notes = buildMapNotes({
        frame,
        terrain,
        places: planningPlaces,
        features: exportFeatures,
        trees: treePoints,
        openintent: built.openintent,
      });
      if (terrainFields.terrainClipboard) stampMapNotes(terrainFields.terrainClipboard, notes);
      stampMapNotes(gpsPaste, notes);
    }
    // Nothing in Copy terrain may sit past the aerial, or Hamina shifts the paste.
    if (terrainFields.terrainClipboard) fitClipboardToMap(terrainFields.terrainClipboard, frame);
    fitClipboardToMap(gpsPaste, frame);
    const timings = stageClock.snapshot({
      areaM2: frame && frame.widthM && frame.lengthM ? frame.widthM * frame.lengthM : 0,
    });
    if (built.stats && timings.cached.length) built.stats.cachedSources = timings.cached;
    if (built.stats && osmTilesStats) built.stats.osmTiles = osmTilesStats;
    reportProgress({ timings });
    return json(200, cors, {
      ok: true,
      alignment: ALIGNMENT,
      frame: built.frame,
      stats: built.stats,
      timings,
      zipFilename: `${built.slug}-openintent.zip`,
      zipBase64: built.zip.toString("base64"),
      terrainFilename: terrainFields.terrainFilename,
      terrainClipboard: terrainFields.terrainClipboard,
      terrainStatus: terrainFields.terrainStatus,
      gpsClipboard: gpsPaste.tiePoints.length >= 2 ? gpsPaste : null,
      warnings,
    });
  }

  let result = bundleResult();
  if (!background && lambdaPayloadBytes(result) > EXPORT_PAYLOAD_BUDGET && terrain && terrain.clipboard) {
    const clipJson = terrainClipJson(terrain);
    const scale = EXPORT_PAYLOAD_BUDGET / Math.max(1, lambdaPayloadBytes(result));
    const nextMax = Math.floor(clipJson.length * scale * 0.85);
    if (nextMax >= 8000 && (await rebuildWithPasteCap(nextMax))) result = bundleResult();
    if (lambdaPayloadBytes(result) > EXPORT_PAYLOAD_BUDGET && terrain && terrain.clipboard) {
      await dropTerrainPaste();
      result = bundleResult();
    }
  }
  if (!background && lambdaPayloadBytes(result) > LAMBDA_SYNC_PAYLOAD_MAX) {
    return json(413, cors, {
      error: "This area is too large to export in one zip. Draw a smaller area and try again.",
    });
  }
  return result;
}

exports.handleClutter = handleClutter;
exports.runBackgroundExport = runBackgroundExport;
exports.backgroundImagerySteps = backgroundImagerySteps;
exports.isBackgroundExport = isBackgroundExport;
exports.BACKGROUND_PLATFORM_MS = BACKGROUND_PLATFORM_MS;
exports.BACKGROUND_ANSWER_MS = BACKGROUND_ANSWER_MS;
exports.BACKGROUND_CHM_MS = BACKGROUND_CHM_MS;
exports.BACKGROUND_COVER_MS = BACKGROUND_COVER_MS;
exports.BACKGROUND_LIDAR_MS = BACKGROUND_LIDAR_MS;
exports.sourceWait = sourceWait;
exports.chmJoinWait = chmJoinWait;
exports.setFetchWorldCoverForTests = setFetchWorldCoverForTests;
exports.setSourceCapsForTests = setSourceCapsForTests;

function isPingRequest(event) {
  if (!event || event.httpMethod !== "POST") return false;
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : String(event.body || "");
  if (raw.length > 64) return false;
  try {
    const b = JSON.parse(raw);
    return !!b && typeof b === "object" && !Array.isArray(b) && b.ping === true && Object.keys(b).length === 1;
  } catch {
    return false;
  }
}

exports.handler = async (event, context) => {
  // An image or footprint socket that is still open must not hold the zip.
  // The gateway turns that silence into an empty 504, and the page has no
  // JSON error to show.
  if (context) context.callbackWaitsForEmptyEventLoop = false;
  // {"ping":true} from the page after a draw: proves a POST reaches the export
  // function through the user's network. No export work, no outside calls.
  if (isPingRequest(event)) {
    return json(200, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "cache-control": "no-store" }, { ok: true, ping: true });
  }
  try {
    return await handleClutter(event);
  } catch (e) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
    };
    const msg = e && e.message ? String(e.message) : "export failed";
    return json(500, cors, { error: msg + " — export failed. Retry the export." });
  }
};

exports.UA = UA;
exports.isPingRequest = isPingRequest;
exports.imageryAttemptMs = imageryAttemptMs;
exports.IMAGERY_ATTEMPT_MS = IMAGERY_ATTEMPT_MS;
exports.IMAGERY_ATTEMPT_MS_DEV = IMAGERY_ATTEMPT_MS_DEV;
exports.IMAGERY_RETURN_MS = IMAGERY_RETURN_MS;
exports.EXPORT_ANSWER_MS = EXPORT_ANSWER_MS;
exports.DEV_ANSWER_MS = DEV_ANSWER_MS;
exports.imageryStepBudget = imageryStepBudget;
exports.beginOptional = beginOptional;
exports.joinOptional = joinOptional;
exports.OVERTURE_GRACE_MS = OVERTURE_GRACE_MS;
exports.OVERTURE_LARGE_GRACE_MS = OVERTURE_LARGE_GRACE_MS;
exports.LARGE_DRAW_SIDE_M = LARGE_DRAW_SIDE_M;
exports.OVERTURE_HARD_MS = OVERTURE_HARD_MS;
exports.overtureWait = overtureWait;
exports.largestFeatures = largestFeatures;
exports.EXPORT_PAYLOAD_BUDGET = EXPORT_PAYLOAD_BUDGET;
exports.LAMBDA_SYNC_PAYLOAD_MAX = LAMBDA_SYNC_PAYLOAD_MAX;
exports.lambdaPayloadBytes = lambdaPayloadBytes;
exports.TERRAIN_GRACE_MS = TERRAIN_GRACE_MS;
exports.TERRAIN_HARD_MS = TERRAIN_HARD_MS;
exports.TERRAIN_HARD_MS_DEV = TERRAIN_HARD_MS_DEV;
exports.TERRAIN_FULL_MS = TERRAIN_FULL_MS;
exports.TERRAIN_COARSE_SAMPLES = TERRAIN_COARSE_SAMPLES;
exports.TERRAIN_RESERVE_MS = TERRAIN_RESERVE_MS;
exports.TERRAIN_PLATFORM_MS = TERRAIN_PLATFORM_MS;
exports.TERRAIN_RESCUE_MIN_MS = TERRAIN_RESCUE_MIN_MS;
exports.terrainSettleMs = terrainSettleMs;
exports.terrainRescueBudget = terrainRescueBudget;
exports.setFetchTerrainDemForTests = setFetchTerrainDemForTests;
exports.setFetchChmGridForTests = setFetchChmGridForTests;
exports.setFetchOvertureForTests = setFetchOvertureForTests;
exports.setAerialBudgetForTests = aerialFetch.setAerialBudgetForTests;
exports.AERIAL_STAGE_BUDGET_MS = aerialFetch.AERIAL_STAGE_BUDGET_MS;
exports.devChmWait = devChmWait;