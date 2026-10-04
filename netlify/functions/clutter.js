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
// Dev host asks for a 2048 px / 0.5 m JPEG first. A Wynn-sized box at that
// size can sit past 12s. Waiting that out, then still reading footprints,
// kept the function silent until the gateway closed it (~30s, empty 504).
// The sharp request has this long. If it has not arrived, the next smaller
// image must still finish, and the zip must be on the way, before
// EXPORT_ANSWER_MS. 2400 px is not the request.
const IMAGERY_ATTEMPT_MS_DEV = 7000;
const IMAGERY_STEPDOWN_MS = [4000, 3500];
// Step down immediately when the sharp request fails at once. A request
// that is still out at the end of the sharp window steps down too, using
// only the time left under IMAGERY_RETURN_MS. A sharp JPEG that arrives
// inside the window is kept.
const IMAGERY_STEPDOWN_QUICK_MS = 2000;
const IMAGERY_RETURN_MS = 15000;
// Network waits stop here so the zip is the response. The gateway closes a
// silent export around 30s, including cold start, so this stays well under that.
const EXPORT_ANSWER_MS = 17000;
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
const TERRAIN_HARD_MS_DEV = 18000;
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
// OpenIntent triples plus the clipboard and overlay for every roof on a
// campus blow past the response limit (Hollywood at 982 areas was ~6.5 MB).
// Stay under it so the zip actually downloads. The bundle repeats
// terrain-clipboard.json beside that zip, so a fine paste is fitted again
// against the synchronous payload budget before the response is returned.
const ZIP_FIT_BYTES = 4200000;
const ZIP_SHRINK_STEPS = [640, 400, 240];
const { geoFrame, esriImageryUrl, esriImageryMetaUrl, fetchMsFootprints, fitAffine, jpegSize, applyImageryMeta, lockIsotropicImagery, padFootprintBbox, imageryExportPlan } = require("../lib/geo-frame");
const { buildClutter, ALIGNMENT, footprintsToClutter, ringAreaM2, featureExteriorRings } = require("../lib/pipeline");
const { fetchOsmTreeNodes } = require("../lib/osm-trees");
const { fetchCanopyTrees, normalizeTreesSource, maxTreesForBbox, pickCanopyTrees } = require("../lib/tree-source");
const { fetchMsGlobalFootprints, globalSkipWarning } = require("../lib/ms-global");
const { fetchUsaStructures } = require("../lib/usa-structures");
const { assembleFootprints } = require("../lib/conflate");
const { fetchOvertureFootprints } = require("../lib/overture");
const { fetchChmGrid, applyChmToTrees, sampleChmGrid } = require("../lib/canopy-height");
const {
  fetchTerrainDem,
  terrainFromSamples,
  terrainBundleFields,
  terrainResolutionNotes,
  noteMissingTerrain,
  normalizeTerrainResolution,
  normalizeTerrainStyle,
  isDevDemHost,
  frameHas3dep,
  EXPORT_PAYLOAD_BUDGET,
  LAMBDA_SYNC_PAYLOAD_MAX,
  estimateBundlePayload,
  lambdaPayloadBytes,
  maxPasteJsonForCompanion,
} = require("../lib/terrain");

let fetchTerrainDemImpl = fetchTerrainDem;
function setFetchTerrainDemForTests(fn) {
  fetchTerrainDemImpl = typeof fn === "function" ? fn : fetchTerrainDem;
}
const { treeHitsBuilding } = require("../lib/vegetation");
const { supplementFootprints } = require("../lib/roof-mask");
const { surfaceMasksFromImage } = require("../lib/surface-mask");
const { rejectPavementFootprints } = require("../lib/pavement");
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

async function fetchOk(url, source) {
  let last = "fetch failed";
  let timedOut = false;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(CORE_FETCH_MS) });
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

/** Production stays on the 8.5s ceiling. The dev host gets a longer first try for the 2048px JPEG. */
function imageryAttemptMs(devHost) {
  return devHost ? IMAGERY_ATTEMPT_MS_DEV : IMAGERY_ATTEMPT_MS;
}

function imagerySteps(devHost) {
  const plan = imageryExportPlan(devHost);
  if (!devHost) {
    return plan.map((step) => Object.assign({ attemptMs: IMAGERY_ATTEMPT_MS }, step));
  }
  return plan.map((step, i) =>
    Object.assign({ attemptMs: i === 0 ? IMAGERY_ATTEMPT_MS_DEV : IMAGERY_STEPDOWN_MS[i - 1] }, step)
  );
}

/**
 * Budget for a later, smaller JPEG. A fast failure keeps that step's own
 * wait. A late abort gets only the time left under IMAGERY_RETURN_MS, so the
 * function can still answer. 0 means do not start another image.
 */
function imageryStepBudget(elapsed, attemptMs) {
  const elapsedMs = Math.max(0, +elapsed || 0);
  const attempt = attemptMs > 0 ? attemptMs : IMAGERY_ATTEMPT_MS;
  if (elapsedMs < IMAGERY_STEPDOWN_QUICK_MS) return attempt;
  const room = IMAGERY_RETURN_MS - elapsedMs;
  if (room < 1500) return 0;
  return Math.min(attempt, room);
}

/** Same drawn box. A failed sharp JPEG may use the next smaller size. A slow fine JPEG that succeeds is kept. */
async function fetchImageryStepped(bbox, steps) {
  let last;
  const started = Date.now();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let attemptMs = step.attemptMs;
    if (i > 0) {
      attemptMs = imageryStepBudget(Date.now() - started, step.attemptMs);
      if (!(attemptMs >= 1500)) break;
    }
    const frame = geoFrame(bbox, { maxSide: step.maxSide, metersPerPx: step.metersPerPx });
    try {
      return await fetchImageryJpeg(esriImageryUrl(frame), attemptMs);
    } catch (e) {
      last = e;
    }
  }
  throw last;
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

async function fetchImageryJpeg(url, attemptMs) {
  const ceiling = attemptMs > 0 ? attemptMs : IMAGERY_ATTEMPT_MS;
  let last = "aerial imagery failed";
  let timedOut = false;
  const started = Date.now();
  for (let attempt = 0; attempt < IMAGERY_ATTEMPTS; attempt++) {
    const budget = Math.min(ceiling, ceiling - (Date.now() - started));
    if (budget < 1200) break;
    const ctrl = new AbortController();
    const deadline = imageryDeadline(budget, ctrl);
    try {
      const buf = await Promise.race([
        (async () => {
          const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
          if (!r.ok) {
            const err = fail("imagery", "HTTP " + r.status);
            if (r.status < 500) throw err;
            throw Object.assign(new Error("HTTP " + r.status), { httpStatus: r.status });
          }
          const body = Buffer.from(await r.arrayBuffer());
          if (body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8) throw fail("imagery", "imagery not jpeg");
          return body;
        })(),
        deadline.timeout,
      ]);
      return buf;
    } catch (e) {
      if (e && e.source) throw e;
      last = String(e && e.message ? e.message : e);
      timedOut = isTimeout(e) || !(e && e.httpStatus);
    } finally {
      deadline.clear();
    }
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
  let budget = 0;
  if (opts && opts.reserveMs > 0) {
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
    job.ctrl.abort();
    const flushed = await flushOptional(job, 1200);
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
      const flushed = await flushOptional(job, 1500);
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
  return "bundle";
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

function featureAreaM2(feature, mpd) {
  const rings = featureExteriorRings(feature && feature.geometry);
  let area = 0;
  for (let i = 0; i < rings.length; i++) area += ringAreaM2(rings[i], mpd);
  return area;
}

/** Largest roofs first. A shortened campus export should keep the big halls. */
function largestFeatures(features, n, mpd) {
  const list = Array.isArray(features) ? features : [];
  const scored = [];
  for (let i = 0; i < list.length; i++) scored.push({ feature: list[i], area: featureAreaM2(list[i], mpd) });
  scored.sort((a, b) => b.area - a.area);
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

/** Include foliage is off unless the body or query explicitly turns it on. */
function wantFoliage(event, body) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body.includeFoliage != null ? body.includeFoliage : q.includeFoliage;
  return raw === true || raw === 1 || raw === "1" || raw === "true";
}

/** Terrain stays on unless the body or query explicitly turns it off. */
function wantTerrain(event, body) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body.includeTerrain != null ? body.includeTerrain : q.includeTerrain;
  if (raw == null || raw === "") return true;
  return !(raw === false || raw === 0 || raw === "0" || raw === "false");
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

  const devHost = isDevDemHost(event);
  const steps = imagerySteps(devHost);
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
  const includeTerrain = wantTerrain(event, body);

  let treePoints = includeFoliage && Array.isArray(body.trees) ? body.trees.slice() : [];
  let treesSource = includeFoliage && ["nlcd-canopy", "imagery-rgb", "none"].includes(body.treesSource)
    ? body.treesSource
    : includeFoliage
      ? null
      : "none";

  let imgBuf = null;
  let gj;
  let imgMeta = null;
  let globalFeatures = [];
  let usaFeatures = [];
  let serverCanopyHits = null;
  let overturePack = { features: [] };
  let demSamples = null;
  let chmGrid = null;
  const warnings = [];
  const started = Date.now();
  let overtureJob = null;
  let terrainJob = null;
  let chmJob = null;
  try {
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
    const imageryJob = needImage ? fetchImageryStepped(requestBbox, steps) : Promise.resolve(null);
    if (needImage) {
      frame = applyImageryMeta(frame, null, { width: frame.imgW, height: frame.imgH }, { requestBbox });
    }
    const overtureFrame = {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
    };
    // Content-grid bbox (same center as the draw, so the Sphere row group is
    // still first). Latitude pad matches the JPEG so an Esri N/S snap does
    // not drop roofs the row group already contains.
    overtureJob = beginOptional((signal) =>
      fetchOvertureFootprints(overtureFrame, { signal, filter: padFootprintBbox(overtureFrame) })
    );
    // Dev host: start the DEM on the predicted content grid, in parallel with
    // metadata. A large campus used to await that JSON (up to 4s) and then
    // abort the read at 9s while footprints were still downloading. Raised
    // layers do not fetch again; terrainStyle is applied when the mesh is built.
    // Production still starts after the snap below.
    if (includeTerrain && needImage && devHost) {
      const terrainFrame = Object.assign({}, frame);
      terrainJob = beginOptional((signal) =>
        fetchTerrainDemImpl(terrainFrame, null, {
          signal,
          terrainResolution,
          terrainStyle,
          allowSurfaceFallback: true,
          deadlineMs: started + TERRAIN_HARD_MS_DEV,
        })
      );
    }
    if (needImage) {
      imgMeta = await fetchImageryMeta(imgMetaUrl);
      if (imgMeta) frame = applyImageryMeta(frame, imgMeta, null, { requestBbox });
      // Same lon/lat extent the JPEG will lock. Meters are applied later with
      // the isotropic frame, so pads line up with hamina-clipboard.json.
      // 3DEP where that service has a grid. On the dev host, a miss reads
      // Copernicus GLO-30 inside this same optional budget. Outside coverage
      // the 3DEP probe is short so GLO-30 gets the remaining time.
      // includeTerrain false skips the DEM, the follow-up, and Copy terrain.
      if (includeTerrain && !terrainJob) {
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
    const globalJob = fetchMsGlobalFootprints(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(CORE_FETCH_MS) })
    ).catch(() => ({ features: [] }));
    const usaCtrl = new AbortController();
    const usaTimer = setTimeout(() => usaCtrl.abort(), CORE_FETCH_MS);
    const usaJob = fetchUsaStructures(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: usaCtrl.signal })
    )
      .catch(() => ({ features: [] }))
      .finally(() => clearTimeout(usaTimer));
    if (includeFoliage && needImage && !chmJob) {
      const chmFrame = {
        west: frame.west,
        south: frame.south,
        east: frame.east,
        north: frame.north,
      };
      chmJob = beginOptional((signal) => fetchChmGrid(chmFrame, { signal }));
    }
    const clientHitsEarly = includeFoliage ? normalizeCanopyHits(body.canopyHits) : [];
    const canopyJob =
      includeFoliage && !clientHitsEarly.length
        ? fetchCanopyTrees(frame, (url) => fetchOk(url, "canopy"), { maxTrees: maxTreesForBbox(frame) }).catch(() => null)
        : null;
    const fetched = await Promise.all([
      fetchMsFootprints(frame, (url) => fetchOk(url, "footprints"), { pad: false, budgetMs: CORE_FETCH_MS }),
      globalJob,
      usaJob,
      imageryJob,
      canopyJob,
    ]);
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
      const locked = lockIsotropicImagery(frame, imgBuf, { maxSide });
      frame = locked.frame;
      imgBuf = locked.jpegBuf;
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
    if (overtureJob) overtureJob.ctrl.abort();
    if (terrainJob) terrainJob.ctrl.abort();
    if (chmJob) chmJob.ctrl.abort();
    return json(502, cors, { error: describeCoreFailure(e) });
  }

  // Overture and canopy start now so the Finland DEM settle wait does not
  // eat their grace. The DEM follow-up may replace terrainJob with a coarser
  // GLO-30 read once that settle window misses.
  const overturePromise = overtureJob
    ? joinOptional(warnings, started, "Overture buildings", overtureJob, overtureWait(frame))
    : Promise.resolve(null);
  const chmPromise = chmJob
    ? joinOptional(warnings, started, "Canopy height", chmJob)
    : Promise.resolve(null);
  const terrainFollow = includeTerrain
    ? await followUpTerrain(terrainJob, started, frame, devHost, terrainResolution, terrainStyle)
    : { preset: null, job: null, join: null };
  const demPromise = terrainFollow.preset
    ? Promise.resolve(terrainFollow.preset)
    : terrainFollow.job
      ? joinOptional(warnings, started, "Terrain", terrainFollow.job, terrainFollow.join)
      : Promise.resolve(null);
  const optional = await Promise.all([overturePromise, demPromise, chmPromise]);
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
  chmGrid = optional[2] && optional[2].values ? optional[2] : null;
  const chmTimedOut =
    includeFoliage &&
    !chmGrid &&
    warnings.some((w) => /Canopy height omitted:/.test(String(w)) && /timed out|export budget/i.test(String(w)));
  if (chmTimedOut) {
    warnings.push("Foliage omitted: canopy height timed out. Buildings in this zip are unchanged.");
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
  const decoded = needImage && !skipRoofFill ? decodeImagery(imgBuf) : null;
  if (skipRoofFill) {
    warnings.push("Imagery roof fill omitted: this draw already has a full set of building footprints.");
  }
  if (decoded) {
    try {
      const sup = supplementFootprints(decoded, frame, features);
      features = sup.features;
      footprintMeta.imageryRoofs = sup.imageryRoofs;
      const pav = rejectPavementFootprints(decoded, frame, features);
      features = pav.features;
      footprintMeta.droppedPavement = pav.dropped;
    } catch {
      // Imagery roof fill is optional. Vector footprints still export.
    }
  }
  gj = { type: "FeatureCollection", features };

  const clientHits = normalizeCanopyHits(body.canopyHits);
  const placeHits =
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

  let terrain = null;
  if (demSamples && demSamples.length && frame) {
    try {
      terrain = terrainFromSamples(demSamples, frame, {
        terrainResolution,
        terrainStyle,
        kind: demKind,
        attribution: demAttribution,
      });
      if (terrain) {
        const notes = terrainResolutionNotes(terrain, frame);
        for (let i = 0; i < notes.length; i++) warnings.push(notes[i]);
      }
    } catch {
      terrain = null;
    }
  }
  if (includeTerrain && needImage) noteMissingTerrain(terrain, warnings);

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

  const FOLIAGE_CAPS = [480, 160, 48, 12];
  let foliageCap = FOLIAGE_CAPS[0];

  function emitClutter(list, extraWarnings) {
    return buildClutter({
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
      includeFoliage,
      omitFoliage: chmTimedOut,
      maxFoliagePolygons: foliageCap,
      terrainResolution,
      terrainStyle,
      nlsHeights: devHost,
    });
  }

  function noteShrink(n) {
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (/^Kept the \d+ largest roofs/.test(warnings[i])) warnings.splice(i, 1);
    }
    warnings.push(
      "Kept the " + n + " largest roofs so the zip can download. Draw a smaller area for the rest of this campus."
    );
  }

  let exportFeatures = features;
  if (exportFeatures.length > ZIP_SHRINK_STEPS[0]) {
    exportFeatures = largestFeatures(exportFeatures, ZIP_SHRINK_STEPS[0], frame.mpd);
    noteShrink(exportFeatures.length);
  }
  let built = emitClutter(exportFeatures);
  if (includeFoliage && !chmTimedOut && built.zip && built.zip.length > ZIP_FIT_BYTES) {
    for (let i = 1; i < FOLIAGE_CAPS.length && built.zip && built.zip.length > ZIP_FIT_BYTES; i++) {
      foliageCap = FOLIAGE_CAPS[i];
      built = emitClutter(exportFeatures);
    }
  }
  if (built.zip && built.zip.length > ZIP_FIT_BYTES) {
    for (let i = 1; i < ZIP_SHRINK_STEPS.length; i++) {
      exportFeatures = largestFeatures(features, ZIP_SHRINK_STEPS[i], frame.mpd);
      noteShrink(exportFeatures.length);
      built = emitClutter(exportFeatures);
      if (built.zip && built.zip.length <= ZIP_FIT_BYTES) break;
    }
  }

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

  function rebuildWithPasteCap(pasteJsonMax) {
    const before = terrainClipJson(terrain).length;
    let next = null;
    try {
      next = terrainFromSamples(demSamples, frame, {
        terrainResolution,
        terrainStyle,
        kind: demKind,
        attribution: demAttribution,
        pasteJsonMax,
      });
    } catch {
      next = null;
    }
    if (!next) return false;
    terrain = next;
    refreshTerrainNotes();
    built = emitClutter(exportFeatures);
    return terrainClipJson(terrain).length < before;
  }

  function dropTerrainPaste() {
    if (!terrain || !terrain.clipboard) return;
    terrain = Object.assign({}, terrain, { clipboard: null, pasteOmitted: true });
    refreshTerrainNotes();
    built = emitClutter(exportFeatures);
  }

  // The zip stores the paste and the bundle JSON stores it again. Fit to the
  // leftover budget, then drop the paste and keep the zip if it still will not.
  if (built.zip && demSamples && demSamples.length) {
    let guard = 0;
    while (guard < 6 && terrain && terrain.clipboard && built.zip) {
      const clipJson = terrainClipJson(terrain);
      const zipTooBig = built.zip.length > 4500000;
      const payloadTooBig = estimateBundlePayload(built.zip.length, clipJson) > EXPORT_PAYLOAD_BUDGET;
      if (!zipTooBig && !payloadTooBig) break;
      const companion = Math.max(0, built.zip.length - clipJson.length);
      let nextMax = maxPasteJsonForCompanion(companion);
      if (!(nextMax < clipJson.length)) nextMax = Math.floor(clipJson.length * 0.7);
      if (!(nextMax >= 8000)) {
        dropTerrainPaste();
        break;
      }
      if (!rebuildWithPasteCap(nextMax)) {
        dropTerrainPaste();
        break;
      }
      guard += 1;
    }
  }

  if (!built.zip) return json(500, cors, { error: "zip missing" });
  if (built.zip.length > 4500000) {
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
    const terrainFields = includeTerrain
      ? terrainBundleFields(built.terrain, warnings)
      : { terrainFilename: null, terrainClipboard: null, terrainStatus: "Terrain off" };
    return json(200, cors, {
      ok: true,
      alignment: ALIGNMENT,
      frame: built.frame,
      stats: built.stats,
      zipFilename: `${built.slug}-openintent.zip`,
      zipBase64: built.zip.toString("base64"),
      terrainFilename: terrainFields.terrainFilename,
      terrainClipboard: terrainFields.terrainClipboard,
      terrainStatus: terrainFields.terrainStatus,
      warnings,
    });
  }

  let result = bundleResult();
  if (lambdaPayloadBytes(result) > EXPORT_PAYLOAD_BUDGET && terrain && terrain.clipboard) {
    const clipJson = terrainClipJson(terrain);
    const scale = EXPORT_PAYLOAD_BUDGET / Math.max(1, lambdaPayloadBytes(result));
    const nextMax = Math.floor(clipJson.length * scale * 0.85);
    if (nextMax >= 8000 && rebuildWithPasteCap(nextMax)) result = bundleResult();
    if (lambdaPayloadBytes(result) > EXPORT_PAYLOAD_BUDGET && terrain && terrain.clipboard) {
      dropTerrainPaste();
      result = bundleResult();
    }
  }
  if (lambdaPayloadBytes(result) > LAMBDA_SYNC_PAYLOAD_MAX) {
    return json(413, cors, {
      error: "This area is too large to export in one zip. Draw a smaller area and try again.",
    });
  }
  return result;
}

exports.handler = async (event, context) => {
  // An image or footprint socket that is still open must not hold the zip.
  // The gateway turns that silence into an empty 504, and the page has no
  // JSON error to show.
  if (context) context.callbackWaitsForEmptyEventLoop = false;
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
exports.imageryAttemptMs = imageryAttemptMs;
exports.IMAGERY_ATTEMPT_MS = IMAGERY_ATTEMPT_MS;
exports.IMAGERY_ATTEMPT_MS_DEV = IMAGERY_ATTEMPT_MS_DEV;
exports.IMAGERY_RETURN_MS = IMAGERY_RETURN_MS;
exports.EXPORT_ANSWER_MS = EXPORT_ANSWER_MS;
exports.imageryStepBudget = imageryStepBudget;
exports.beginOptional = beginOptional;
exports.joinOptional = joinOptional;
exports.OVERTURE_GRACE_MS = OVERTURE_GRACE_MS;
exports.OVERTURE_LARGE_GRACE_MS = OVERTURE_LARGE_GRACE_MS;
exports.LARGE_DRAW_SIDE_M = LARGE_DRAW_SIDE_M;
exports.OVERTURE_HARD_MS = OVERTURE_HARD_MS;
exports.overtureWait = overtureWait;
exports.largestFeatures = largestFeatures;
exports.ZIP_FIT_BYTES = ZIP_FIT_BYTES;
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