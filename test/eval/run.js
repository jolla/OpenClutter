"use strict";

/**
 * Run the production clutter pipeline against cached fixtures (or --live Esri/NLCD)
 * and score buildings/trees in image space. No Hamina UI.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  geoFrame,
  esriImageryUrl,
  esriImageryMetaUrl,
  fetchMsFootprints,
  applyImageryMeta,
  jpegSize,
} = require("../../netlify/lib/geo-frame");
const { buildClutter, footprintsToClutter } = require("../../netlify/lib/pipeline");
const T = require("../../netlify/lib/tree-source");
const { treeHitsBuilding } = require("../../netlify/lib/vegetation");
const { fetchMsGlobalFootprints, mergeFootprintFeatures } = require("../../netlify/lib/ms-global");
const { fetchUsaStructures } = require("../../netlify/lib/usa-structures");
const { scoreBuildings, scoreTrees, scoreRoofTrees, scoreRoofProbes, scoreMeasuredHeights, evaluate, pointInRing, THRESHOLDS } = require("./score");
const { supplementFootprints } = require("../../netlify/lib/roof-mask");
const { featureExteriorRings } = require("../../netlify/lib/pipeline");

const ROOT = path.join(__dirname, "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const DEFAULT_OUT = path.join(ROOT, "test", "eval", "out");
const UA = "openclutter/0.12.0-eval (https://github.com/jolla/OpenClutter)";

function loadSitesIndex() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "sites.json"), "utf8")).sites;
}

function fixtureDir(id) {
  return path.join(FIXTURES, id);
}

function loadFixture(site) {
  const dir = fixtureDir(site.id);
  return {
    site,
    bbox: JSON.parse(fs.readFileSync(path.join(dir, "bbox.json"), "utf8")),
    meta: JSON.parse(fs.readFileSync(path.join(dir, "imagery-meta.json"), "utf8")),
    jpeg: fs.readFileSync(path.join(dir, "imagery.jpg")),
    footprints: JSON.parse(fs.readFileSync(path.join(dir, "footprints.geojson"), "utf8")),
    tcc: JSON.parse(fs.readFileSync(path.join(dir, "tcc-samples.json"), "utf8")),
    roofPoints: fs.existsSync(path.join(dir, "roof-points.json"))
      ? JSON.parse(fs.readFileSync(path.join(dir, "roof-points.json"), "utf8"))
      : null,
  };
}

async function fetchOk(url) {
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return r;
}

async function fetchLive(site) {
  const bbox = { west: site.west, south: site.south, east: site.east, north: site.north, name: site.name };
  const drawn = geoFrame(bbox);
  const meta = await (await fetchOk(esriImageryMetaUrl(drawn))).json();
  const jpeg = Buffer.from(await (await fetchOk(esriImageryUrl(drawn))).arrayBuffer());
  const frame = applyImageryMeta(drawn, meta, jpegSize(jpeg));
  const arcgis = await fetchMsFootprints(frame, (url) => fetchOk(url), { pad: false });
  const globalPack = await fetchMsGlobalFootprints(frame, (url) => fetchOk(url)).catch(() => ({ features: [] }));
  const usaPack = await fetchUsaStructures(frame, (url) => fetchOk(url)).catch(() => ({ features: [] }));
  const withArcgis = mergeFootprintFeatures(globalPack.features || [], arcgis.features || []);
  const merged = mergeFootprintFeatures(withArcgis.features, usaPack.features || []);
  const footprints = {
    type: "FeatureCollection",
    features: merged.features,
    globalFootprints: (globalPack.features || []).length,
    arcgisFootprints: (arcgis.features || []).length,
    usaFootprints: (usaPack.features || []).length,
    addedFromUsa: merged.added,
  };
  const tcc = await (await fetchOk(T.canopySamplesUrl(frame))).json();
  return { site, bbox: { ...site }, meta, jpeg, footprints, tcc, roofPoints: null };
}

function decodeJpeg(buf) {
  const jpeg = require("jpeg-js");
  return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 20 });
}

function resolveFromSources(frame, tcc, jpegDecoded, rgbPolicy, buildingAabbs) {
  const parsed = T.treesFromCanopySamples(tcc);
  const decided = T.decideCanopy(parsed);
  const budget = T.maxTreesForBbox(frame);
  const reject =
    buildingAabbs && buildingAabbs.length
      ? (lon, lat) => treeHitsBuilding(lon, lat, frame, buildingAabbs)
      : null;
  const canopy = decided.ok
    ? {
        trees: T.pickCanopyTrees(parsed.hits, frame, { maxTrees: budget, reject }),
        source: "nlcd-canopy",
        reason: decided.reason,
        parsed,
      }
    : { trees: [], source: null, reason: decided.reason, parsed };
  let rgb = [];
  const needRgb = T.rgbFillNeeded(canopy, frame, { rgbPolicy, maxTrees: budget });
  if (needRgb && jpegDecoded) {
    rgb = T.detectTreesFromImageData(jpegDecoded.data, jpegDecoded.width, jpegDecoded.height, frame, {
      maxTrees: budget,
    });
  }
  const resolved = T.resolveTrees(frame, canopy, rgb, { rgbPolicy, maxTrees: budget });
  return { canopy, rgb, resolved, parsed };
}

function probeInsideFeature(feature, probe) {
  const rings = featureExteriorRings(feature && feature.geometry);
  for (let i = 0; i < rings.length; i++) {
    if (pointInRing([+probe.lon, +probe.lat], rings[i])) return true;
  }
  return false;
}

function imageryRecovery(jpegDecoded, frame, features, probes) {
  const target = (probes || []).find((p) => p.id === "big-white-retail") || (probes || [])[0];
  if (!target) return { required: false, hit: true, probe: null };
  const blinded = (features || []).filter((f) => !probeInsideFeature(f, target));
  const sup = supplementFootprints(jpegDecoded, frame, blinded);
  const hit = sup.features.some((f) => probeInsideFeature(f, target));
  return { required: true, hit, probe: target.id, imageryRoofs: sup.imageryRoofs };
}

function runLoaded(loaded, opts) {
  opts = opts || {};
  const rgbPolicy = opts.rgbPolicy || T.RGB_POLICY_PREFER_NLCD;
  const drawn = geoFrame(loaded.bbox);
  const frame = applyImageryMeta(drawn, loaded.meta, jpegSize(loaded.jpeg));
  const jpegDecoded = decodeJpeg(loaded.jpeg);
  const baseFeatures = loaded.footprints.features || [];
  const supplemented =
    rgbPolicy === T.RGB_POLICY_PREFER_NLCD
      ? supplementFootprints(jpegDecoded, frame, baseFeatures)
      : { features: baseFeatures, imageryRoofs: 0, droppedStubs: 0 };
  const fp = footprintsToClutter(supplemented.features, frame);
  const { canopy, resolved, parsed } = resolveFromSources(
    frame,
    loaded.tcc,
    jpegDecoded,
    rgbPolicy,
    rgbPolicy === T.RGB_POLICY_PREFER_NLCD ? fp.aabbs : null
  );
  let treePoints = resolved.trees;
  let medianKept = 0;
  if (rgbPolicy === T.RGB_POLICY_PREFER_NLCD && jpegDecoded) {
    const medians = T.detectMedianTrees(jpegDecoded.data, jpegDecoded.width, jpegDecoded.height, frame, {
      maxTrees: 80,
      reject: (lon, lat) => treeHitsBuilding(lon, lat, frame, fp.aabbs),
    });
    treePoints = T.appendTreePoints(resolved.trees, medians, frame, {
      minDistM: 8,
      maxTrees: Math.min(T.MAX_TREES_LARGE, T.maxTreesForBbox(frame) + medians.length),
    });
    medianKept = treePoints.filter((t) => t.median).length;
  }
  const built = buildClutter({
    frame,
    footprintsGeojson: { type: "FeatureCollection", features: supplemented.features },
    treePoints,
    name: loaded.site.name || loaded.bbox.name || loaded.site.id,
    imgBuf: loaded.jpeg,
    treesSource: resolved.source,
    footprintMeta: {
      imageryRoofs: supplemented.imageryRoofs || 0,
      medianTrees: medianKept,
    },
  });
  const buildings = scoreBuildings(baseFeatures, fp.overlayRings, frame);
  const trees = scoreTrees(treePoints, frame, jpegDecoded, loaded.tcc, resolved.source);
  Object.assign(trees, scoreRoofTrees(treePoints, supplemented.features));
  const probes = (loaded.roofPoints && loaded.roofPoints.points) || [];
  const roofProbes = probes.length ? scoreRoofProbes(probes, fp.overlayRings, frame) : null;
  if (roofProbes) buildings.roofProbes = roofProbes;
  const heights = scoreMeasuredHeights(baseFeatures, fp.overlayRings, fp.overlayHeights, frame, built.openintent);
  const recovery =
    rgbPolicy === T.RGB_POLICY_PREFER_NLCD ? imageryRecovery(jpegDecoded, frame, baseFeatures, probes) : { required: false, hit: true };
  const medians = {
    required: rgbPolicy === T.RGB_POLICY_PREFER_NLCD && loaded.site.id === "oak-creek-commercial",
    kept: medianKept,
  };
  const gate = evaluate({ buildings, trees, roofProbes, heights, imageryRecovery: recovery, medians });
  const exportStats = {
    site: loaded.site.id,
    name: loaded.site.name,
    rgbPolicy,
    frame: {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
      widthM: frame.widthM,
      lengthM: frame.lengthM,
      imgW: frame.imgW,
      imgH: frame.imgH,
    },
    coverage: {
      buildingsKept: built.stats.buildingsKept,
      treesKept: built.stats.treesKept,
      treesSource: built.stats.treesSource,
      fetched: built.stats.fetched,
      droppedMega: built.stats.droppedMega,
      droppedTiny: built.stats.droppedTiny,
      droppedClip: built.stats.droppedClip,
      droppedCap: built.stats.droppedCap,
    },
    buildings,
    trees,
    heights,
    imageryRecovery: recovery,
    medians,
    gate,
    thresholds: THRESHOLDS,
    canopyReason: canopy.reason,
    resolveReason: resolved.reason,
    nlcdHits: parsed.hits.length,
  };
  return { built, frame, exportStats, gate, resolved, fp };
}

function writeSiteOut(outRoot, result) {
  const id = result.exportStats.site;
  const dir = path.join(outRoot, id);
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  const { unzipStore } = require("../../netlify/lib/zip-store");
  const files = unzipStore(result.built.zip);
  for (const [name, buf] of Object.entries(files)) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  fs.writeFileSync(path.join(dir, "export-stats.json"), JSON.stringify(result.exportStats, null, 2) + "\n");
  return dir;
}

function parseArgs(argv) {
  const args = {
    live: false,
    legacy: false,
    compareLegacy: false,
    writeFixtures: false,
    out: DEFAULT_OUT,
    ids: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") args.live = true;
    else if (a === "--legacy") args.legacy = true;
    else if (a === "--compare-legacy") args.compareLegacy = true;
    else if (a === "--write-fixtures") args.writeFixtures = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--site") args.ids = [argv[++i]];
  }
  return args;
}

function formatRow(stats) {
  const g = stats.gate.ok ? "PASS" : "FAIL";
  const rec = stats.trees.highCanopyRecall == null ? "n/a" : stats.trees.highCanopyRecall.toFixed(2);
  return (
    `${stats.site.padEnd(24)} ${String(stats.rgbPolicy).padEnd(22)} ${g.padEnd(5)} ` +
    `bldg ${stats.buildings.centroidHits}/${stats.buildings.eligibleFootprints} ` +
    `iou ${stats.buildings.iou.toFixed(2)} ` +
    `missLarge ${stats.buildings.missingLargeRoofs} ` +
    `pav ${stats.trees.pavementTreeFrac.toFixed(3)} ` +
    `roof ${stats.trees.roofTreeFrac == null ? "n/a" : stats.trees.roofTreeFrac.toFixed(3)} ` +
    `canopy ${rec} ` +
    `trees ${stats.trees.treesPlaced} (${stats.trees.treesSource}) ` +
    `h ${stats.heights && stats.heights.uniqueBuildingHeights != null ? stats.heights.uniqueBuildingHeights : "-"} ` +
    `fol ${stats.heights && stats.heights.uniqueFoliageHeights != null ? stats.heights.uniqueFoliageHeights : "-"} ` +
    `med ${stats.medians ? stats.medians.kept : "-"} ` +
    `roofFill ${stats.imageryRecovery && stats.imageryRecovery.imageryRoofs != null ? stats.imageryRecovery.imageryRoofs : "-"}`
  );
}

async function runEval(opts) {
  opts = opts || {};
  const sites = loadSitesIndex().filter((s) => !opts.ids || opts.ids.includes(s.id));
  const policies = [];
  if (opts.compareLegacy) {
    policies.push(T.RGB_POLICY_FORCE_RGB, T.RGB_POLICY_PREFER_NLCD);
  } else {
    policies.push(opts.legacy ? T.RGB_POLICY_FORCE_RGB : T.RGB_POLICY_PREFER_NLCD);
  }
  const results = [];
  for (const site of sites) {
    const loaded = opts.live ? await fetchLive(site) : loadFixture(site);
    if (opts.live && opts.writeFixtures) {
      const dir = fixtureDir(site.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "bbox.json"), JSON.stringify({ id: site.id, name: site.name, west: site.west, south: site.south, east: site.east, north: site.north }, null, 2) + "\n");
      fs.writeFileSync(path.join(dir, "imagery-meta.json"), JSON.stringify(loaded.meta, null, 2) + "\n");
      fs.writeFileSync(path.join(dir, "imagery.jpg"), loaded.jpeg);
      fs.writeFileSync(path.join(dir, "footprints.geojson"), JSON.stringify(loaded.footprints) + "\n");
      fs.writeFileSync(path.join(dir, "tcc-samples.json"), JSON.stringify(loaded.tcc) + "\n");
    }
    for (const rgbPolicy of policies) {
      const result = runLoaded(loaded, { rgbPolicy });
      const outDir = opts.compareLegacy
        ? path.join(opts.out || DEFAULT_OUT, rgbPolicy)
        : opts.out || DEFAULT_OUT;
      writeSiteOut(outDir, result);
      results.push(result);
    }
  }
  return results;
}

module.exports = {
  FIXTURES,
  DEFAULT_OUT,
  loadSitesIndex,
  loadFixture,
  fetchLive,
  runLoaded,
  runEval,
  writeSiteOut,
  parseArgs,
  formatRow,
};
