"use strict";

const UA = "openclutter/0.14.0 (https://github.com/jolla/OpenClutter)";
const { geoFrame, esriImageryUrl, esriImageryMetaUrl, fetchMsFootprints, fitAffine, jpegSize, applyImageryMeta } = require("../lib/geo-frame");
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

async function fetchOk(url) {
  let last = "fetch failed";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000) });
      if (r.ok) return r;
      last = "HTTP " + r.status;
    } catch (e) {
      last = String(e.message || e);
    }
  }
  throw new Error(last);
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
  try {
    if (needImage) {
      const metaRes = await fetchOk(imgMetaUrl).catch(() => null);
      if (metaRes) {
        try {
          imgMeta = await metaRes.json();
        } catch {
          imgMeta = null;
        }
        if (imgMeta) frame = applyImageryMeta(frame, imgMeta, null);
      }
    }
    const globalJob = fetchMsGlobalFootprints(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) })
    ).catch(() => ({ features: [] }));
    const usaJob = fetchUsaStructures(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) })
    ).catch(() => ({ features: [] }));
    const overtureJob = fetchOvertureFootprints(frame).catch(() => ({ features: [] }));
    const demJob = fetchDemSamples(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) })
    ).catch(() => null);
    const chmJob = needImage ? fetchChmGrid(frame).catch(() => null) : Promise.resolve(null);
    const canopyJob =
      !treePoints.length
        ? fetchCanopyTrees(frame, (url) => fetchOk(url), { maxTrees: maxTreesForBbox(frame) }).catch(() => null)
        : null;
    const fetched = await Promise.all([
      fetchMsFootprints(frame, (url) => fetchOk(url), { pad: false }),
      globalJob,
      usaJob,
      needImage ? fetchOk(imgUrl) : Promise.resolve(null),
      overtureJob,
      demJob,
      chmJob,
    ]);
    gj = fetched[0];
    globalFeatures = (fetched[1] && fetched[1].features) || [];
    usaFeatures = (fetched[2] && fetched[2].features) || [];
    const imgRes = needImage ? fetched[3] : null;
    overturePack = fetched[4] || { features: [] };
    demSamples = fetched[5];
    chmGrid = fetched[6];
    if (needImage) {
      imgBuf = Buffer.from(await imgRes.arrayBuffer());
      if (imgBuf.length < 100 || imgBuf[0] !== 0xff || imgBuf[1] !== 0xd8) {
        throw new Error("imagery not jpeg");
      }
      frame = applyImageryMeta(frame, imgMeta, jpegSize(imgBuf));
    }
    if (canopyJob) {
      const canopy = await canopyJob;
      if (canopy && canopy.parsed && canopy.parsed.hits && canopy.parsed.hits.length) {
        serverCanopyHits = canopy.parsed.hits;
      }
      if (canopy && canopy.trees && canopy.trees.length) {
        treePoints = canopy.trees;
        treesSource = "nlcd-canopy";
      } else if (canopy && canopy.source && !treesSource) {
        treesSource = "nlcd-canopy";
      }
    }
  } catch (e) {
    return json(502, cors, { error: String(e.message || e) + " — Esri timed out, retry or draw a smaller box" });
  }

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
  if (built.zip.length > 4500000) return json(413, cors, { error: "zip too large — draw a smaller box" });

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
  });
};