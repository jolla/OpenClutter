"use strict";

const UA = "openclutter/0.13.0 (https://github.com/jolla/OpenClutter)";
const { geoFrame, esriImageryUrl, esriImageryMetaUrl, fetchMsFootprints, fitAffine, jpegSize, applyImageryMeta } = require("../lib/geo-frame");
const { buildClutter, ALIGNMENT, footprintsToClutter } = require("../lib/pipeline");
const { fetchOsmTreeNodes } = require("../lib/osm-trees");
const { fetchCanopyTrees, normalizeTreesSource, maxTreesForBbox, pickCanopyTrees } = require("../lib/tree-source");
const { fetchMsGlobalFootprints, mergeFootprintFeatures } = require("../lib/ms-global");
const { fetchUsaStructures } = require("../lib/usa-structures");
const { treeHitsBuilding } = require("../lib/vegetation");

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
    const jobs = [fetchMsFootprints(frame, (url) => fetchOk(url), { pad: false })];
    const globalJob = fetchMsGlobalFootprints(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) })
    ).catch(() => ({ features: [] }));
    const usaJob = fetchUsaStructures(frame, (url) =>
      fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) })
    ).catch(() => ({ features: [] }));
    jobs.push(globalJob);
    jobs.push(usaJob);
    if (needImage) jobs.push(fetchOk(imgUrl));
    const canopyJob =
      !treePoints.length
        ? fetchCanopyTrees(frame, (url) => fetchOk(url), { maxTrees: maxTreesForBbox(frame) }).catch(() => null)
        : null;
    const fetched = await Promise.all(jobs);
    gj = fetched[0];
    globalFeatures = (fetched[1] && fetched[1].features) || [];
    usaFeatures = (fetched[2] && fetched[2].features) || [];
    const imgRes = needImage ? fetched[3] : null;
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
  const withArcgis = mergeFootprintFeatures(globalFeatures, arcgisFeatures);
  const merged = mergeFootprintFeatures(withArcgis.features, usaFeatures);
  gj = { type: "FeatureCollection", features: merged.features };
  const footprintMeta = {
    globalFootprints: globalFeatures.length,
    arcgisFootprints: arcgisFeatures.length,
    usaFootprints: usaFeatures.length,
  };

  const clientHits = normalizeCanopyHits(body.canopyHits);
  const placeHits =
    clientHits.length > 0
      ? clientHits
      : treesSource === "nlcd-canopy"
        ? normalizeCanopyHits(serverCanopyHits)
        : [];
  if (placeHits.length && treesSource === "nlcd-canopy") {
    const preview = footprintsToClutter(merged.features, frame);
    treePoints = pickCanopyTrees(placeHits, frame, {
      maxTrees: maxTreesForBbox(frame),
      reject: (lon, lat) => treeHitsBuilding(lon, lat, frame, preview.aabbs),
    });
  }

  if (wantOsm(body)) {
    try {
      const osm = await fetchOsmTreeNodes(frame.west, frame.south, frame.east, frame.north, UA);
      treePoints = treePoints.concat(osm);
    } catch {
      // OSM is optional; canopy / imagery vegetation still applies.
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