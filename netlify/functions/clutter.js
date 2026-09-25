"use strict";

const { userAgent: UA } = require("../lib/version");
// Netlify hobby kills the function around 10s. The JPEG is the long pole
// (Oak Creek ~6s) and must start immediately. Imagery metadata is the same
// Esri export and used to be awaited for up to 7s before that download began,
// so a slow meta response left no time for the JPEG. Meta is now capped and
// overlapped with the JPEG. Footprints keep their own 7s clock and are not
// aborted when the JPEG aborts. Canopy height still starts only after core.
// 3DEP starts once imagery metadata has snapped the extent, overlapping the
// JPEG, so a slow aerial download does not skip the DEM. Overture starts with
// the JPEG, before the Global ML gzip. A finished read is kept even if core
// passed 5s. A read still in flight keeps a grace window until OVERTURE_HARD_MS.
// The live Sphere export spent ~18s on imagery and the other footprint layers;
// a 9s hard cap then aborted Overture, which is the only source of that ring
// (absent from MS Global and USA Structures). Page-index pruning reads the
// center row group first so a late abort can still keep footprints already parsed.
const CORE_FETCH_MS = 7000;
const IMAGERY_ATTEMPT_MS = 8500;
const IMAGERY_ATTEMPTS = 2;
const IMAGERY_BACKOFF_MS = 400;
// One full attempt fits in the function. A retry runs only when the first
// failure leaves at least 1.2s under this ceiling (fast reset, not a 8.5s hang).
const IMAGERY_BUDGET_MS = 8500;
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
// read cannot stretch Oak Creek. hardMs still cuts a slow core at 23s.
const OVERTURE_LARGE_GRACE_MS = 15000;
const LARGE_DRAW_SIDE_M = 1500;
const OVERTURE_HARD_MS = 23000;
// Roof fill scans every footprint. On a dense draw that already spent 10s
// fetching, skip it and emit the vector buildings.
const DENSE_FEATURES = 1500;
// OpenIntent triples plus the clipboard and overlay for every roof on a
// campus blow past the response limit (Hollywood at 982 areas was ~6.5 MB).
// Stay under it so the zip actually downloads.
const ZIP_FIT_BYTES = 4200000;
const ZIP_SHRINK_STEPS = [640, 400, 240];
const { geoFrame, esriImageryUrl, esriImageryMetaUrl, fetchMsFootprints, fitAffine, jpegSize, applyImageryMeta, lockIsotropicImagery, padFootprintBbox } = require("../lib/geo-frame");
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
  noteMissingTerrain,
  normalizeTerrainResolution,
  isDevDemHost,
} = require("../lib/terrain");
const { treeHitsBuilding } = require("../lib/vegetation");
const { supplementFootprints } = require("../lib/roof-mask");
const { surfaceMasksFromImage } = require("../lib/surface-mask");
const { rejectPavementFootprints } = require("../lib/pavement");
const { detectMedianTrees, appendTreePoints } = require("../lib/tree-source");

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

/** Headers and JPEG body share one AbortController per attempt. A timeout does not reuse that signal. */
async function fetchImageryJpeg(url) {
  let last = "aerial imagery failed";
  let timedOut = false;
  const started = Date.now();
  for (let attempt = 0; attempt < IMAGERY_ATTEMPTS; attempt++) {
    const budget = Math.min(IMAGERY_ATTEMPT_MS, IMAGERY_BUDGET_MS - (Date.now() - started));
    if (budget < 1200) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
      if (!r.ok) {
        last = "HTTP " + r.status;
        timedOut = false;
        if (r.status < 500) throw fail("imagery", last);
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw fail("imagery", "imagery not jpeg");
        return buf;
      }
    } catch (e) {
      if (e && e.source) throw e;
      last = String(e && e.message ? e.message : e);
      timedOut = isTimeout(e);
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 >= IMAGERY_ATTEMPTS) break;
    const pause = IMAGERY_BACKOFF_MS * (attempt + 1);
    if (Date.now() - started + pause > IMAGERY_BUDGET_MS - 1200) break;
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
        if (value && Array.isArray(value.features) && value.features.length) return value;
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

function keptFootprints(result) {
  if (!result || result === TIMED_OUT) return null;
  if (Array.isArray(result.features) && result.features.length) return result;
  return null;
}

/** After an abort, keep rows the reader already returned (center group first). */
async function flushOptional(job, waitMs) {
  if (job.isSettled()) return keptFootprints(await job.work);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
  });
  try {
    return keptFootprints(await Promise.race([job.work, timeout]));
  } finally {
    clearTimeout(timer);
  }
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
  if (graceMs > SKIP_OPTIONAL_AFTER_MS) {
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
      warnings.push(label + " partial: kept " + flushed.features.length + " footprints already read");
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
        warnings.push(label + " partial: kept " + flushed.features.length + " footprints already read");
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

/** Include foliage is off unless the body or query explicitly turns it on. */
function wantFoliage(event, body) {
  const q = (event && event.queryStringParameters) || {};
  const raw = body && body.includeFoliage != null ? body.includeFoliage : q.includeFoliage;
  return raw === true || raw === 1 || raw === "1" || raw === "true";
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

exports.handler = async (event) => {
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

  let frame;
  try {
    frame = geoFrame(body);
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
  const imgUrl = esriImageryUrl(frame);
  const imgMetaUrl = esriImageryMetaUrl(frame);
  const includeFoliage = wantFoliage(event, body);

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
    const imageryJob = needImage ? fetchImageryJpeg(imgUrl) : Promise.resolve(null);
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
    if (needImage) {
      imgMeta = await fetchImageryMeta(imgMetaUrl);
      if (imgMeta) frame = applyImageryMeta(frame, imgMeta, null, { requestBbox });
      // Same lon/lat extent the JPEG will lock. Meters are applied later with
      // the isotropic frame, so pads line up with hamina-clipboard.json.
      // 3DEP first. On the dev host only, a miss reads Copernicus GLO-30
      // inside this same optional budget (grace 1.5s, hard 9s).
      terrainJob = beginOptional((signal) =>
        fetchTerrainDem(frame, null, {
          signal,
          terrainResolution,
          allowSurfaceFallback: isDevDemHost(event),
        })
      );
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
      const locked = lockIsotropicImagery(frame, imgBuf);
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
    return json(502, cors, { error: describeCoreFailure(e) });
  }

  const optional = await Promise.all([
    overtureJob
      ? joinOptional(warnings, started, "Overture buildings", overtureJob, overtureWait(frame))
      : Promise.resolve(null),
    terrainJob
      ? joinOptional(warnings, started, "Terrain", terrainJob, { graceMs: 1500, hardMs: 9000 })
      : Promise.resolve(null),
    includeFoliage && needImage
      ? runOptional(warnings, started, "Canopy height", (signal) => fetchChmGrid(frame, { signal }))
      : Promise.resolve(null),
  ]);
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
  } else {
    demSamples = null;
  }
  chmGrid = optional[2];

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
    if (decoded) {
      const medians = detectMedianTrees(decoded.data, decoded.width, decoded.height, frame, {
        maxTrees: 80,
        reject: (lon, lat) => treeHitsBuilding(lon, lat, frame, preview.aabbs),
      });
      footprintMeta.medianTrees = medians.length;
      treePoints = appendTreePoints(treePoints, medians, frame, {
        minDistM: 8,
        maxTrees: Math.min(800, maxTreesForBbox(frame) + medians.length),
      });
    }
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
        kind: demKind,
        attribution: demAttribution,
      });
    } catch {
      terrain = null;
    }
  }
  if (needImage) noteMissingTerrain(terrain, warnings);

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
      canopyHits: placeHits,
      heightSample: chmGrid ? (lon, lat) => sampleChmGrid(chmGrid, lon, lat) : null,
      chmGrid,
      maskRings,
      maskPolygons,
      includeFoliage,
      terrainResolution,
      nlsHeights: isDevDemHost(event),
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

  const terrainFields = terrainBundleFields(built.terrain, warnings);
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
};

exports.UA = UA;
exports.beginOptional = beginOptional;
exports.joinOptional = joinOptional;
exports.OVERTURE_GRACE_MS = OVERTURE_GRACE_MS;
exports.OVERTURE_LARGE_GRACE_MS = OVERTURE_LARGE_GRACE_MS;
exports.LARGE_DRAW_SIDE_M = LARGE_DRAW_SIDE_M;
exports.OVERTURE_HARD_MS = OVERTURE_HARD_MS;
exports.overtureWait = overtureWait;
exports.largestFeatures = largestFeatures;
exports.ZIP_FIT_BYTES = ZIP_FIT_BYTES;