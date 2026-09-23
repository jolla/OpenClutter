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
  lockIsotropicImagery,
  jpegSize,
  geodesicPixelMismatchPx,
} = require("../../netlify/lib/geo-frame");
const { buildClutter, footprintsToClutter, oiPixelCoords, featureExteriorRings } = require("../../netlify/lib/pipeline");
const T = require("../../netlify/lib/tree-source");
const { treeHitsBuilding } = require("../../netlify/lib/vegetation");
const { fetchMsGlobalFootprints, mergeFootprintFeatures } = require("../../netlify/lib/ms-global");
const { fetchUsaStructures } = require("../../netlify/lib/usa-structures");
const { conflateFootprints, countHeightSources } = require("../../netlify/lib/conflate");
const { terrainFromSamples } = require("../../netlify/lib/terrain");
const { applyChmToTrees, sampleChmGrid } = require("../../netlify/lib/canopy-height");
const { isVegetationOiName } = require("../../netlify/lib/materials");
const { scoreBuildings, scoreTrees, scoreRoofTrees, scoreRoofProbes, scoreMeasuredHeights, scoreMaterialCompatibility, scoreFoliageBuildingOverlap, scorePairwiseOverlap, evaluate, pointInRing, THRESHOLDS } = require("./score");
const { surfaceMasksFromImage } = require("../../netlify/lib/surface-mask");
const { supplementFootprints } = require("../../netlify/lib/roof-mask");
const { rejectPavementFootprints } = require("../../netlify/lib/pavement");
const { scoreOiContentGrid } = require("../../netlify/lib/overlay");

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
    overture: fs.existsSync(path.join(dir, "overture.geojson"))
      ? JSON.parse(fs.readFileSync(path.join(dir, "overture.geojson"), "utf8"))
      : null,
    dem: fs.existsSync(path.join(dir, "dem-samples.json"))
      ? JSON.parse(fs.readFileSync(path.join(dir, "dem-samples.json"), "utf8"))
      : null,
    chm: fs.existsSync(path.join(dir, "chm-grid.json"))
      ? JSON.parse(fs.readFileSync(path.join(dir, "chm-grid.json"), "utf8"))
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
  const snapped = applyImageryMeta(drawn, meta, jpegSize(jpeg));
  const locked = lockIsotropicImagery(snapped, jpeg);
  const frame = locked.frame;
  const jpegOut = locked.jpegBuf || jpeg;
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
  return { site, bbox: { ...site }, meta, jpeg: jpegOut, footprints, tcc, roofPoints: null };
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

function vegetationRingsFromOi(oi) {
  const areas =
    (oi && oi.floorplans && oi.floorplans[0] && oi.floorplans[0].attenuation_areas) || [];
  const rings = [];
  for (const a of areas) {
    const name = a && a.area_material && a.area_material.name;
    if (!isVegetationOiName(name)) continue;
    const px = oiPixelCoords(a.area.coordinates);
    if (!px || px.length < 4) continue;
    rings.push(px.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]));
  }
  return rings;
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
  const snapped = applyImageryMeta(drawn, loaded.meta, jpegSize(loaded.jpeg));
  const locked = lockIsotropicImagery(snapped, loaded.jpeg);
  const frame = locked.frame;
  const jpegDecoded = decodeJpeg(locked.jpegBuf || loaded.jpeg);
  const baseFeatures = loaded.footprints.features || [];
  const prefer = rgbPolicy === T.RGB_POLICY_PREFER_NLCD;
  let vectorFeatures = baseFeatures;
  let overtureMerge = null;
  if (prefer && loaded.overture && loaded.overture.features && loaded.overture.features.length) {
    overtureMerge = conflateFootprints(baseFeatures.slice(), loaded.overture.features, {
      replaceGeometry: true,
      rankHeight: true,
    });
    vectorFeatures = overtureMerge.features;
  }
  const supplemented = prefer
    ? supplementFootprints(jpegDecoded, frame, vectorFeatures)
    : { features: baseFeatures, imageryRoofs: 0, droppedStubs: 0 };
  const pavement = prefer && jpegDecoded
    ? rejectPavementFootprints(jpegDecoded, frame, supplemented.features)
    : { features: supplemented.features, dropped: 0 };
  const emittedFeatures = pavement.features;
  const pavementLeft = prefer && jpegDecoded
    ? rejectPavementFootprints(jpegDecoded, frame, emittedFeatures).dropped
    : 0;
  const fp = footprintsToClutter(emittedFeatures, frame);
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
  let chmApplied = 0;
  if (prefer && loaded.chm) {
    const applied = applyChmToTrees(treePoints, (lon, lat) => sampleChmGrid(loaded.chm, lon, lat));
    treePoints = applied.trees;
    chmApplied = applied.applied;
  }
  const terrain = prefer && loaded.dem && loaded.dem.samples ? terrainFromSamples(loaded.dem.samples, frame) : null;
  const heightSources = countHeightSources(vectorFeatures);
  const surface =
    jpegDecoded && jpegDecoded.width === frame.imgW && jpegDecoded.height === frame.imgH
      ? surfaceMasksFromImage(jpegDecoded, frame)
      : { waterRings: [], pavementPolygons: [], waterM2: 0, pavementM2: 0 };
  const includeFoliage = opts.includeFoliage === true;
  const built = buildClutter({
    frame,
    footprintsGeojson: { type: "FeatureCollection", features: emittedFeatures },
    treePoints: includeFoliage ? treePoints : [],
    name: loaded.site.name || loaded.bbox.name || loaded.site.id,
    imgBuf: locked.jpegBuf || loaded.jpeg,
    treesSource: includeFoliage ? resolved.source : "none",
    terrain,
    maskRings: surface.waterRings,
    maskPolygons: surface.pavementPolygons,
    footprintMeta: {
      imageryRoofs: supplemented.imageryRoofs || 0,
      droppedPavement: pavement.dropped || 0,
      medianTrees: includeFoliage ? medianKept : 0,
      overtureFootprints: loaded.overture && loaded.overture.features ? loaded.overture.features.length : 0,
      overtureAdded: overtureMerge ? overtureMerge.added : 0,
      msHeights: heightSources["ms-global"] || 0,
      overtureHeights: heightSources.overture || 0,
      femaHeights: heightSources.fema || 0,
      floorHeights: heightSources["overture-floors"] || 0,
      chmTrees: includeFoliage ? chmApplied : 0,
    },
    canopyHits: includeFoliage && resolved.source === "nlcd-canopy" && parsed && parsed.hits ? parsed.hits : [],
    heightSample: includeFoliage && prefer && loaded.chm ? (lon, lat) => sampleChmGrid(loaded.chm, lon, lat) : null,
    includeFoliage,
  });
  const buildings = scoreBuildings(emittedFeatures, fp.overlayRings, frame);
  const trees = scoreTrees(treePoints, frame, jpegDecoded, loaded.tcc, resolved.source);
  Object.assign(trees, scoreRoofTrees(treePoints, emittedFeatures));
  const probes = (loaded.roofPoints && loaded.roofPoints.points) || [];
  const roofProbes = probes.length ? scoreRoofProbes(probes, fp.overlayRings, frame) : null;
  if (roofProbes) buildings.roofProbes = roofProbes;
  const heights = scoreMeasuredHeights(
    vectorFeatures,
    fp.overlayRings,
    fp.overlayHeights,
    frame,
    built.openintent,
    built.clipboard
  );
  const compatibility = scoreMaterialCompatibility(built.openintent);
  let customTreeAreas = 0;
  const oiAreas =
    (built.openintent.floorplans[0] && built.openintent.floorplans[0].attenuation_areas) || [];
  for (const a of oiAreas) {
    const name = a && a.area_material && a.area_material.name;
    if (isVegetationOiName(name)) customTreeAreas++;
  }
  const openIntentTrees = {
    required: includeFoliage && treePoints.length > 0,
    placed: treePoints.length,
    emitted: built.stats.openIntentTreeAreas || 0,
    custom: customTreeAreas,
    buildingAreas: built.stats.openIntentBuildingAreas || 0,
    canopyOnly: includeFoliage,
  };
  const recovery = prefer ? imageryRecovery(jpegDecoded, frame, vectorFeatures, probes) : { required: false, hit: true };
  const medians = {
    required: prefer && loaded.site.id === "oak-creek-commercial",
    kept: medianKept,
  };
  const overture = {
    required: prefer && !!(loaded.overture && loaded.overture.features && loaded.overture.features.length),
    considered: loaded.overture && loaded.overture.features ? loaded.overture.features.length : 0,
    added: overtureMerge ? overtureMerge.added : 0,
    heightsUpgraded: overtureMerge ? overtureMerge.heightsUpgraded : 0,
    explicit: heightSources.overture || 0,
  };
  const terrainScore = {
    required: prefer && !!(loaded.dem && loaded.dem.samples && loaded.dem.samples.length),
    raised: terrain ? terrain.raised : 0,
    sloped: terrain ? terrain.sloped : 0,
    reliefM: terrain ? terrain.reliefM : 0,
    polygons: terrain ? terrain.raised + terrain.sloped : 0,
    separateFromOpenIntent: !JSON.stringify(built.openintent).includes("raisedFloorZones"),
    mainClipboardFlat: built.clipboard.raisedFloorZones.length === 0 && built.clipboard.slopedFloors.length === 0,
  };
  const chm = {
    required: prefer && !!loaded.chm,
    applied: chmApplied,
  };
  const oiRings = (fp.oiAreas || []).map((area) => {
    const pix = oiPixelCoords(area.area.coordinates);
    const pts = [];
    for (let i = 0; i < pix.length - 1; i++) {
      pts.push([pix[i].coordinate_xyz.x, pix[i].coordinate_xyz.y]);
    }
    return pts;
  });
  const foliageRings = vegetationRingsFromOi(built.openintent);
  const foliageOverlap = scoreFoliageBuildingOverlap(foliageRings, fp.overlayRings, frame);
  const buildingOverlap = scorePairwiseOverlap(oiRings, frame);
  const foliageSelfOverlap = scorePairwiseOverlap(foliageRings, frame);
  const drift = scoreOiContentGrid(fp.overlayRings, oiRings);
  const jpegWH = jpegSize(locked.jpegBuf || loaded.jpeg);
  const retail = (probes || []).find((p) => p.id === "big-white-retail") || { lon: frame.west, lat: frame.south };
  const geodesicMismatchPx = geodesicPixelMismatchPx(frame, retail.lon, retail.lat);
  const contentGrid = {
    required: prefer,
    jpegMatchesFrame: !!(jpegWH && jpegWH.width === frame.imgW && jpegWH.height === frame.imgH),
    mpuLocked: frame.mpuX === frame.mpuY && Math.abs(frame.lengthM - frame.imgH * frame.mpuX) < 1e-6,
    geodesicMismatchPx,
    // Oak Creek's Esri JPEG is degree-linear. A geodesic imgH would make this ~0
    // and put footprints on a different pixel grid than the aerial.
    minGeodesicMismatchPx: loaded.site.id === "oak-creek-commercial" ? 40 : 0,
    drift,
    ok:
      drift.ok &&
      !!(jpegWH && jpegWH.width === frame.imgW && jpegWH.height === frame.imgH) &&
      frame.mpuX === frame.mpuY,
  };
  const pavementFootprints = {
    required: prefer,
    dropped: pavement.dropped || 0,
    kept: pavementLeft,
    minDropped: loaded.site.id === "oak-creek-commercial" ? 4 : 0,
  };
  const gate = evaluate({
    buildings,
    trees,
    roofProbes,
    heights,
    imageryRecovery: recovery,
    medians,
    overture,
    terrain: terrainScore,
    chm,
    compatibility,
    openIntentTrees,
    foliageOverlap,
    buildingOverlap,
    foliageSelfOverlap,
    contentGrid,
    pavementFootprints,
    includeFoliage,
  });
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
    compatibility,
    openIntentTrees,
    imageryRecovery: recovery,
    medians,
    overture,
    terrain: terrainScore,
    chm,
    foliageOverlap,
    buildingOverlap,
    foliageSelfOverlap,
    surface: {
      waterRings: surface.waterRings.length,
      waterM2: surface.waterM2 || 0,
      pavementRings: surface.pavementPolygons.length,
      pavementM2: surface.pavementM2 || 0,
    },
    contentGrid,
    pavementFootprints,
    includeFoliage,
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
    `foliage ${stats.includeFoliage ? "on" : "off"} ` +
    `h ${stats.heights && stats.heights.uniqueBuildingHeights != null ? stats.heights.uniqueBuildingHeights : "-"} ` +
    `fol ${stats.heights && stats.heights.uniqueFoliageHeights != null ? stats.heights.uniqueFoliageHeights : "-"} ` +
    `med ${stats.medians ? stats.medians.kept : "-"} ` +
    `ov ${stats.overture ? stats.overture.explicit : "-"} ` +
    `chm ${stats.chm ? stats.chm.applied : "-"} ` +
    `ter ${stats.terrain ? stats.terrain.sloped + "/" + stats.terrain.raised : "-"} ` +
    `roofFill ${stats.imageryRecovery && stats.imageryRecovery.imageryRoofs != null ? stats.imageryRecovery.imageryRoofs : "-"} ` +
    `bOv ${((stats.buildingOverlap && stats.buildingOverlap.overlapM2) || 0).toFixed(1)} ` +
    `fOv ${((stats.foliageSelfOverlap && stats.foliageSelfOverlap.overlapM2) || 0).toFixed(1)}`
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
