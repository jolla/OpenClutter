"use strict";

const UA = "openclutter/0.8.0 (https://github.com/jolla/OpenClutter)";
const { geoFrame, esriImageryUrl, msFootprintsUrl, fitAffine } = require("../lib/geo-frame");
const { buildClutter, ALIGNMENT } = require("../lib/pipeline");
const { fetchOsmTreeNodes } = require("../lib/osm-trees");
const { fetchCanopyTrees, normalizeTreesSource } = require("../lib/tree-source");

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
  const footprintsUrl = msFootprintsUrl(frame, 300);

  let treePoints = Array.isArray(body.trees) ? body.trees.slice() : [];
  let treesSource = ["nlcd-canopy", "imagery-rgb", "none"].includes(body.treesSource)
    ? body.treesSource
    : null;

  let imgBuf = null;
  let gj;
  try {
    const jobs = [fetchOk(footprintsUrl)];
    if (needImage) jobs.push(fetchOk(imgUrl));
    const canopyJob =
      !treePoints.length && !treesSource
        ? fetchCanopyTrees(frame, (url) => fetchOk(url)).catch(() => null)
        : null;
    const [fpRes, imgRes] = await Promise.all(jobs);
    gj = await fpRes.json();
    if (needImage) {
      imgBuf = Buffer.from(await imgRes.arrayBuffer());
      if (imgBuf.length < 100 || imgBuf[0] !== 0xff || imgBuf[1] !== 0xd8) {
        throw new Error("imagery not jpeg");
      }
    }
    if (canopyJob) {
      const canopy = await canopyJob;
      if (canopy && canopy.source) {
        treePoints = canopy.trees;
        treesSource = "nlcd-canopy";
      }
    }
  } catch (e) {
    return json(502, cors, { error: String(e.message || e) + " — Esri timed out, retry or draw a smaller box" });
  }

  treesSource = normalizeTreesSource(treesSource, treePoints.length);

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
  });

  const frameHeaders = {
    "x-hamina-width-m": String(frame.widthM),
    "x-hamina-length-m": String(frame.lengthM),
    "x-hamina-mpu": String(frame.mpuX),
    "x-hamina-alignment": "import-zip-then-paste",
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
    clipboardFilename: `${built.slug}-hamina-clipboard.json`,
    zipBase64: built.zip.toString("base64"),
    clipboard: built.clipboard,
  });
};