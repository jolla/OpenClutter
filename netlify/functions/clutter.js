"use strict";

const UA = "openclutter/0.14.2 (https://github.com/jolla/OpenClutter)";
// Netlify hobby kills the function around 10s. The JPEG is the long pole
// (Oak Creek ~6s) and must start immediately. Imagery metadata is the same
// Esri export and used to be awaited for up to 7s before that download began,
// so a slow meta response left no time for the JPEG. Meta is now capped and
// overlapped with the JPEG. Footprints keep their own 7s clock and are not
// aborted when the JPEG aborts. Canopy height and 3DEP still start only after
// core. Overture starts with the JPEG, before the Global ML gzip. A finished
// read is kept even if core passed 5s; a read still in flight gets up to 1.5s
// more (hard cap 9s). Aborting at 5s dropped the Las Vegas Sphere (Overture
// only — absent from MS Global and USA Structures).
const CORE_FETCH_MS = 7000;
const IMAGERY_ATTEMPT_MS = 8500;
const IMAGERY_ATTEMPTS = 2;
const IMAGERY_BACKOFF_MS = 400;
// One full attempt fits in the function. A retry runs only when the first
// failure leaves at least 1.2s under this ceiling (fast reset, not a 8.5s hang).
const IMAGERY_BUDGET_MS = 8500;
// Live Oak Creek metadata was ~3.0s and pads latitude by ~500 m at the same
// pixel size. 2.5s dropped that snap and clipped the corridor. 4s still
// overlaps the JPEG instead of running before it.
const META_MS = 4000;
const OPTIONAL_MS = 2000;
const SKIP_OPTIONAL_AFTER_MS = 5000;
const { geoFrame, esriImageryUrl, esriImageryMetaUrl, fetchMsFootprints, fitAffine, jpegSize, applyImageryMeta, lockIsotropicImagery, padFootprintBbox } = require("../lib/geo-frame");
const { buildClutter, ALIGNMENT, footprintsToClutter } = require("../lib/pipeline");
const { fetchOsmTreeNodes } = require("../lib/osm-trees");
const { fetchCanopyTrees, normalizeTreesSource, maxTreesForBbox, pickCanopyTrees } = require("../lib/tree-source");
const { fetchMsGlobalFootprints } = require("../lib/ms-global");
const { fetchUsaStructures } = require("../lib/usa-structures");
const { assembleFootprints } = require("../lib/conflate");
const { fetchOvertureFootprints } = require("../lib/overture");
const { fetchChmGrid, applyChmToTrees, sampleChmGrid } = require("../lib/canopy-height");
const { fetchDemSamples, terrainFromSamples } = require("../lib/terrain");
const { treeHitsBuilding } = require("../lib/vegetation");
const { supplementFootprints } = require("../lib/roof-mask");
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
      if (ctrl.signal.aborted) return TIMED_OUT;
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

/**
 * Collect a fetch started with beginOptional.
 * A read that already finished is kept even when the core phase used the
 * 5s optional-start budget — discarding it dropped the Las Vegas Sphere,
 * which is in Overture and absent from MS Global / USA Structures.
 * Work still running after that budget is aborted unless opts.graceMs allows
 * a short wait that must end by opts.hardMs.
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
  if (elapsed < SKIP_OPTIONAL_AFTER_MS) {
    budget = Math.min(OPTIONAL_MS, Math.max(400, SKIP_OPTIONAL_AFTER_MS - elapsed));
  } else if (graceMs) {
    // In-flight read that started with the JPEG. Global ML often finishes
    // within a second of the Overture row group; aborting at 5s drops it.
    budget = Math.min(graceMs, Math.max(0, hardMs - elapsed));
  }
  if (budget < 200) {
    job.ctrl.abort();
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

function wantOsm(body) {
  return body.osmTrees === true || body.osm === true;
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
  const imgUrl = esriImageryUrl(frame);
  const imgMetaUrl = esriImageryMetaUrl(frame);

  let treePoints = Array.isArray(body.trees) ? body.trees.slice() : [];
  let treesSource = ["nlcd-canopy", "imagery-rgb", "none"].includes(body.treesSource)
    ? body.treesSource
    : null;

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
  try {
    // JPEG and Overture together. Meta may snap the footprint query, but it
    // must not gate the image or the Overture read — the Las Vegas row group
    // loses if it starts only after metadata, behind the Global ML gzip.
    const imageryJob = needImage ? fetchImageryJpeg(imgUrl) : Promise.resolve(null);
    const overtureFrame = {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
    };
    // Row groups from the request bbox (one Vegas group). Keep features in the
    // same latitude pad MSBFP2 uses, so an Esri N/S snap does not drop roofs
    // the row group already contains.
    overtureJob = beginOptional((signal) =>
      fetchOvertureFootprints(overtureFrame, { signal, filter: padFootprintBbox(overtureFrame) })
    );
    if (needImage) {
      imgMeta = await fetchImageryMeta(imgMetaUrl);
      if (imgMeta) frame = applyImageryMeta(frame, imgMeta, null);
    }
    const globalJob = fetchMsGlobalFootprints(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(CORE_FETCH_MS) })
    ).catch(() => ({ features: [] }));
    const usaJob = fetchUsaStructures(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(CORE_FETCH_MS) })
    ).catch(() => ({ features: [] }));
    const canopyJob =
      !treePoints.length
        ? fetchCanopyTrees(frame, (url) => fetchOk(url, "canopy"), { maxTrees: maxTreesForBbox(frame) }).catch(() => null)
        : null;
    const fetched = await Promise.all([
      fetchMsFootprints(frame, (url) => fetchOk(url, "footprints"), { pad: false }),
      globalJob,
      usaJob,
      imageryJob,
      canopyJob,
    ]);
    gj = fetched[0];
    globalFeatures = (fetched[1] && fetched[1].features) || [];
    usaFeatures = (fetched[2] && fetched[2].features) || [];
    imgBuf = fetched[3];
    if (imgBuf) {
      frame = applyImageryMeta(frame, imgMeta, jpegSize(imgBuf));
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
    return json(502, cors, { error: describeCoreFailure(e) });
  }

  const optional = await Promise.all([
    overtureJob
      ? joinOptional(warnings, started, "Overture buildings", overtureJob, { graceMs: 1500, hardMs: 9000 })
      : Promise.resolve(null),
    runOptional(warnings, started, "Terrain", (signal) => fetchDemSamples(frame, null, { signal })),
    needImage
      ? runOptional(warnings, started, "Canopy height", (signal) => fetchChmGrid(frame, { signal }))
      : Promise.resolve(null),
  ]);
  overturePack = optional[0] || { features: [] };
  demSamples = optional[1];
  chmGrid = optional[2];

  treesSource = normalizeTreesSource(treesSource, treePoints.length);

  const arcgisFeatures = (gj && gj.features) || [];
  const overtureFeatures = (overturePack && overturePack.features) || [];
  const assembled = assembleFootprints({
    global: globalFeatures,
    overture: overtureFeatures,
    arcgis: arcgisFeatures,
    usa: usaFeatures,
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
  const decoded = needImage ? decodeImagery(imgBuf) : null;
  if (decoded) {
    try {
      const sup = supplementFootprints(decoded, frame, features);
      features = sup.features;
      footprintMeta.imageryRoofs = sup.imageryRoofs;
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
  if (placeHits.length && treesSource === "nlcd-canopy") {
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
  if (chmGrid && treePoints.length) {
    const applied = applyChmToTrees(treePoints, (lon, lat) => sampleChmGrid(chmGrid, lon, lat));
    treePoints = applied.trees;
    footprintMeta.chmTrees = applied.applied;
  }

  if (wantOsm(body)) {
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
      terrain = terrainFromSamples(demSamples, frame);
    } catch {
      terrain = null;
    }
  }

  const built = buildClutter({
    frame,
    footprintsGeojson: gj,
    treePoints,
    affine,
    name: body.name,
    imgBuf,
    treesSource,
    footprintMeta,
    terrain,
    warnings,
    canopyHits: placeHits,
    heightSample: chmGrid ? (lon, lat) => sampleChmGrid(chmGrid, lon, lat) : null,
  });

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
  if (built.zip.length > 4500000) return json(413, cors, { error: "zip too large" });

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

  return json(200, cors, {
    ok: true,
    alignment: ALIGNMENT,
    frame: built.frame,
    stats: built.stats,
    zipFilename: `${built.slug}-openintent.zip`,
    zipBase64: built.zip.toString("base64"),
    warnings,
  });
};

exports.beginOptional = beginOptional;
exports.joinOptional = joinOptional;