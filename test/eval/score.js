"use strict";

/**
 * Image-space eval scores. No Hamina UI.
 *
 * Buildings: MS footprint rings vs emitted overlay rings (centroid + IoU).
 * Trees: pavement/parking/roof false positives, high-canopy recall, orchard grid.
 */

const { llToPx, llToImagePx, metersPerDeg } = require("../../netlify/lib/geo-frame");
const { ZONE_TYPES } = require("../../netlify/lib/hamina-clipboard");
const {
  featureExteriorRings,
  ringAreaM2,
  MEGA_CAMPUS_M2,
  MIN_AREA_M2,
  coverageStats,
} = require("../../netlify/lib/pipeline");
const T = require("../../netlify/lib/tree-source");

const THRESHOLDS = {
  minCentroidHitRate: 0.85,
  minBuildingIou: 0.45,
  maxMissingLargeRoofs: 0,
  maxIncompleteMultiPolygons: 0,
  minLargeRoofKeepRate: 1,
  maxPavementTreeFrac: 0.15,
  maxRoofTreeFrac: 0.03,
  minHighCanopyRecall: 0.55,
  minHighCanopyCells: 8,
  maxOrchardScore: 0.75,
  minUniqueBuildingHeights: 8,
  minMatchedHeightFrac: 0.9,
  minUniqueFoliageHeights: 4,
  minMedianTrees: 8,
  minOvertureExplicit: 8,
  minChmTrees: 8,
  minTerrainPolygons: 1,
};

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function uniqueOpen(ring) {
  if (!ring || ring.length < 3) return [];
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  return closed;
}

function pointInRing(pt, ring) {
  const pts = uniqueOpen(ring);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const intersect =
      yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function shoelaceCentroid(ring) {
  const pts = uniqueOpen(ring);
  if (!pts.length) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-18) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / pts.length, sy / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** A point guaranteed (when possible) to lie inside the ring. */
function interiorPoint(ring) {
  const c = shoelaceCentroid(ring);
  if (c && pointInRing(c, ring)) return c;
  const pts = uniqueOpen(ring);
  for (const p of pts) {
    if (pointInRing(p, ring)) return p;
  }
  if (pts.length >= 3) {
    const mid = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3];
    if (pointInRing(mid, ring)) return mid;
  }
  return c || (pts[0] ? pts[0] : null);
}

function lonLatRingToPx(ring, frame) {
  return ring.map(([lon, lat]) => llToPx(lon, lat, frame));
}

function rasterizeRings(rings, w, h, step) {
  const set = new Set();
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      for (let i = 0; i < rings.length; i++) {
        if (pointInRing([x, y], rings[i])) {
          set.add(x + ":" + y);
          break;
        }
      }
    }
  }
  return set;
}

function iouSets(a, b) {
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 1;
}

function overlapRatio(srcSet, emittedSet) {
  if (!srcSet.size) return 1;
  let inter = 0;
  for (const k of srcSet) if (emittedSet.has(k)) inter++;
  return inter / srcSet.size;
}

function majorRings(features, frame) {
  const out = [];
  for (const f of features || []) {
    const rings = featureExteriorRings(f.geometry);
    const parts = [];
    for (const ring of rings) {
      const areaM2 = ringAreaM2(ring, frame.mpd);
      const px = lonLatRingToPx(ring, frame);
      parts.push({ ring, px, areaM2 });
    }
    out.push({
      feature: f,
      type: f.geometry && f.geometry.type,
      parts,
    });
  }
  return out;
}

function scoreBuildings(features, overlayRings, frame) {
  const majors = majorRings(features, frame);
  const emitted = overlayRings || [];
  const srcPx = [];
  for (const m of majors) for (const p of m.parts) srcPx.push(p.px);
  const step = Math.max(3, Math.round(Math.min(frame.imgW, frame.imgH) / 180));
  const srcSet = rasterizeRings(srcPx, frame.imgW, frame.imgH, step);
  const emSet = rasterizeRings(emitted, frame.imgW, frame.imgH, step);
  const iou = iouSets(srcSet, emSet);

  let eligible = 0;
  let centroidHits = 0;
  let large = 0;
  let largeKept = 0;
  let missingLargeRoofs = 0;
  let incompleteMultiPolygons = 0;

  for (const m of majors) {
    const keepable = m.parts.filter((p) => p.areaM2 >= MIN_AREA_M2 && p.areaM2 <= MEGA_CAMPUS_M2);
    if (!keepable.length) continue;
    let keptParts = 0;
    for (const p of keepable) {
      eligible++;
      const interior = interiorPoint(p.px);
      const hit =
        interior && emitted.some((em) => pointInRing(interior, em))
          ? true
          : overlapRatio(rasterizeRings([p.px], frame.imgW, frame.imgH, step), emSet) >= 0.35;
      if (hit) {
        centroidHits++;
        keptParts++;
      }
      if (p.areaM2 >= 1000) {
        large++;
        if (hit) largeKept++;
        else missingLargeRoofs++;
      }
    }
    const isMulti = m.type === "MultiPolygon" || keepable.length > 1;
    if (isMulti && keptParts < keepable.length) incompleteMultiPolygons++;
  }

  const centroidHitRate = eligible ? centroidHits / eligible : 1;
  const largeRoofKeepRate = large ? largeKept / large : 1;
  return {
    eligibleFootprints: eligible,
    centroidHits,
    centroidHitRate,
    iou,
    largeRoofs: large,
    largeRoofsKept: largeKept,
    largeRoofKeepRate,
    missingLargeRoofs,
    incompleteMultiPolygons,
  };
}

function nearestTccPct(lon, lat, samples) {
  if (!samples || !samples.length) return null;
  let best = Infinity;
  let pct = null;
  for (let i = 0; i < samples.length; i++) {
    const loc = samples[i].location || {};
    const dx = lon - loc.x;
    const dy = lat - loc.y;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      pct = T.parseCanopyPct(samples[i].value);
    }
  }
  return pct;
}

function sampleRgba(raw, x, y) {
  const xi = Math.max(0, Math.min(raw.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(raw.height - 1, Math.round(y)));
  const i = (yi * raw.width + xi) * 4;
  return {
    x: xi,
    y: yi,
    r: raw.data[i],
    g: raw.data[i + 1],
    b: raw.data[i + 2],
  };
}

/**
 * Pavement / parking / roof: high luma, low vegetation, or NLCD cell ≈ 0.
 */
function medianRing(raw, x, y) {
  let pav = 0;
  let veg = 0;
  let n = 0;
  for (let a = 0; a < 12; a++) {
    const ang = (Math.PI * 2 * a) / 12;
    const xx = Math.round(x + Math.cos(ang) * 14);
    const yy = Math.round(y + Math.sin(ang) * 14);
    if (xx < 0 || yy < 0 || xx >= raw.width || yy >= raw.height) continue;
    const i = (yy * raw.width + xx) * 4;
    const r = raw.data[i];
    const g = raw.data[i + 1];
    const b = raw.data[i + 2];
    const Y = luma(r, g, b);
    const color = T.vegColorScore(r, g, b);
    n++;
    if (color > 0) veg++;
    else if (Y > 75 && Y < 168) pav++;
  }
  if (n < 8) return false;
  return pav / n >= 0.45 && veg / n <= 0.34;
}

function isPavementLike(tree, frame, raw, samples) {
  const [ix, iy] = llToImagePx(tree.lon, tree.lat, frame);
  const px = sampleRgba(raw, ix, iy);
  const Y = luma(px.r, px.g, px.b);
  const stats = T.localLumaStats(raw.data, raw.width, raw.height, px.x, px.y, 5, 2);
  const color = T.vegColorScore(px.r, px.g, px.b);
  const score = T.canopyScore(color, stats);
  const pct = nearestTccPct(tree.lon, tree.lat, samples);
  // Parking medians sit in NLCD cells near 0. Exempt only a textured canopy
  // core whose ring is gray pavement — not a lawn and not an RGB carpet.
  if (score >= 0.36 && Y < 155 && medianRing(raw, px.x, px.y)) {
    return { pavement: false, reason: "median-canopy", Y, score, pct };
  }
  if (pct != null && pct >= 18) return { pavement: false, reason: "nlcd-canopy", Y, score, pct };
  if (pct != null && pct < 8) return { pavement: true, reason: "nlcd-low", Y, score, pct };
  if (Y > 160 && score < 0.4) return { pavement: true, reason: "bright-roof", Y, score, pct };
  if (Y > 140 && (score < 0.28 || stats.std < 8)) {
    return { pavement: true, reason: "high-luma-low-veg", Y, score, pct };
  }
  if (stats.std < 6.5 && stats.range < 20 && Y > 95) {
    return { pavement: true, reason: "smooth-bright", Y, score, pct };
  }
  return { pavement: false, reason: "ok", Y, score, pct };
}

function orchardLatticeScore(trees, bbox) {
  if (!trees || trees.length < 16) {
    return { score: 0, reject: false, cv: null, axisFrac: null, n: trees ? trees.length : 0 };
  }
  const mpd = metersPerDeg((+bbox.south + +bbox.north) / 2);
  const nns = [];
  for (let i = 0; i < trees.length; i++) {
    let best = Infinity;
    let ang = 0;
    for (let j = 0; j < trees.length; j++) {
      if (i === j) continue;
      const dx = (trees[i].lon - trees[j].lon) * mpd.lon;
      const dy = (trees[i].lat - trees[j].lat) * mpd.lat;
      const d = Math.hypot(dx, dy);
      if (d > 1 && d < best) {
        best = d;
        ang = Math.atan2(dy, dx);
      }
    }
    if (best < Infinity) nns.push({ d: best, ang });
  }
  if (nns.length < 12) return { score: 0, reject: false, cv: null, axisFrac: null, n: trees.length };
  const ds = nns.map((n) => n.d);
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const variance = ds.reduce((s, d) => s + (d - mean) * (d - mean), 0) / ds.length;
  const cv = mean ? Math.sqrt(variance) / mean : 1;
  let axis = 0;
  for (const n of nns) {
    const a = Math.abs(n.ang) % (Math.PI / 2);
    const dist = Math.min(a, Math.PI / 2 - a);
    if (dist < (12 * Math.PI) / 180) axis++;
  }
  const axisFrac = axis / nns.length;
  const score = (cv < 0.22 ? 0.55 : cv < 0.32 ? 0.25 : 0) + (axisFrac > 0.6 ? 0.45 : axisFrac * 0.35);
  return {
    score,
    cv,
    axisFrac,
    medianNnM: ds.slice().sort((a, b) => a - b)[(ds.length / 2) | 0],
    n: trees.length,
    reject: score >= THRESHOLDS.maxOrchardScore && trees.length >= 24,
  };
}

function highCanopyRecall(trees, hits, bbox) {
  const high = (hits || []).filter((h) => (h.pct || 0) >= 40);
  if (high.length < THRESHOLDS.minHighCanopyCells) {
    return { cells: high.length, covered: 0, recall: null };
  }
  const mpd = metersPerDeg((+bbox.south + +bbox.north) / 2);
  let covered = 0;
  for (const h of high) {
    const hit = (trees || []).some((t) => {
      const dx = (t.lon - h.lon) * mpd.lon;
      const dy = (t.lat - h.lat) * mpd.lat;
      return dx * dx + dy * dy < 45 * 45;
    });
    if (hit) covered++;
  }
  return { cells: high.length, covered, recall: covered / high.length };
}

function treePointsFromBuilt(built) {
  const pts = [];
  const areas = (built.openintent && built.openintent.floorplans[0].attenuation_areas) || [];
  const mats = new Set(["Tree Trunk"]);
  for (const a of areas) {
    const trunkName = typeof a.area_material === "string" ? a.area_material : a.area_material && a.area_material.name;
    if (!mats.has(trunkName)) continue;
    const coords = a.area.coordinates || [];
    if (coords.length < 3) continue;
    let sx = 0;
    let sy = 0;
    const n = coords.length - 1;
    for (let i = 0; i < n; i++) {
      sx += coords[i].coordinate_xyz.x;
      sy += coords[i].coordinate_xyz.y;
    }
    pts.push({ xUp: sx / n, yUp: sy / n });
  }
  return pts;
}

function scoreRoofTrees(treeLonLat, features) {
  const rings = [];
  for (const f of features || []) {
    const g = f && f.geometry;
    if (!g) continue;
    if (g.type === "Polygon" && g.coordinates && g.coordinates[0]) rings.push(g.coordinates[0]);
    else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates || []) {
        if (poly && poly[0]) rings.push(poly[0]);
      }
    }
  }
  const trees = treeLonLat || [];
  let onRoof = 0;
  for (const t of trees) {
    const pt = [t.lon, t.lat];
    if (rings.some((ring) => pointInRing(pt, ring))) onRoof++;
  }
  return {
    roofTrees: onRoof,
    roofTreeFrac: trees.length ? onRoof / trees.length : 0,
  };
}

/** Probe points (lon/lat) that must land inside an emitted building ring. */
function scoreRoofProbes(probes, overlayRings, frame) {
  const points = probes || [];
  let hit = 0;
  const missed = [];
  for (const p of points) {
    const px = llToPx(+p.lon, +p.lat, frame);
    const ok = (overlayRings || []).some((ring) => pointInRing(px, ring));
    if (ok) hit++;
    else missed.push(p.id || `${p.lon},${p.lat}`);
  }
  return { probes: points.length, hit, missed };
}

function scoreTrees(treeLonLat, frame, raw, tccPayload, treesSource) {
  const parsed = T.treesFromCanopySamples(tccPayload || { samples: [] });
  const samples = (tccPayload && tccPayload.samples) || [];
  const trees = treeLonLat || [];
  let pavement = 0;
  for (const t of trees) {
    if (isPavementLike(t, frame, raw, samples).pavement) pavement++;
  }
  const pavementTreeFrac = trees.length ? pavement / trees.length : 0;
  const orchard = orchardLatticeScore(trees, frame);
  const canopy = highCanopyRecall(trees, parsed.hits, frame);
  return {
    treesPlaced: trees.length,
    treesSource: treesSource || "none",
    pavementTrees: pavement,
    pavementTreeFrac,
    highCanopyCells: canopy.cells,
    highCanopyCovered: canopy.covered,
    highCanopyRecall: canopy.recall,
    orchard,
    nlcdValid: parsed.validCount,
    nlcdHits: parsed.hits.length,
  };
}

function evaluate(scores, thresholds) {
  const t = thresholds || THRESHOLDS;
  const failures = [];
  const b = scores.buildings;
  const v = scores.trees;
  if (b.centroidHitRate < t.minCentroidHitRate) {
    failures.push(`centroidHitRate ${b.centroidHitRate.toFixed(3)} < ${t.minCentroidHitRate}`);
  }
  if (b.iou < t.minBuildingIou) {
    failures.push(`buildingIoU ${b.iou.toFixed(3)} < ${t.minBuildingIou}`);
  }
  if (b.missingLargeRoofs > t.maxMissingLargeRoofs) {
    failures.push(`missingLargeRoofs ${b.missingLargeRoofs} > ${t.maxMissingLargeRoofs}`);
  }
  if (b.incompleteMultiPolygons > t.maxIncompleteMultiPolygons) {
    failures.push(`incompleteMultiPolygons ${b.incompleteMultiPolygons}`);
  }
  if (b.largeRoofKeepRate < t.minLargeRoofKeepRate && b.largeRoofs > 0) {
    failures.push(`largeRoofKeepRate ${b.largeRoofKeepRate.toFixed(3)} < ${t.minLargeRoofKeepRate}`);
  }
  if (v.pavementTreeFrac > t.maxPavementTreeFrac) {
    failures.push(`pavementTreeFrac ${v.pavementTreeFrac.toFixed(3)} > ${t.maxPavementTreeFrac}`);
  }
  if (v.roofTreeFrac != null && v.roofTreeFrac > t.maxRoofTreeFrac) {
    failures.push(`roofTreeFrac ${v.roofTreeFrac.toFixed(3)} > ${t.maxRoofTreeFrac}`);
  }
  if (scores.roofProbes && scores.roofProbes.missed && scores.roofProbes.missed.length) {
    failures.push(`roofProbes missed ${scores.roofProbes.missed.join(", ")}`);
  }
  if (v.highCanopyRecall != null && v.highCanopyRecall < t.minHighCanopyRecall) {
    failures.push(`highCanopyRecall ${v.highCanopyRecall.toFixed(3)} < ${t.minHighCanopyRecall}`);
  }
  if (v.orchard && v.orchard.reject) {
    failures.push(`orchardLattice ${v.orchard.score.toFixed(3)}`);
  }
  const h = scores.heights;
  if (h && h.applicable) {
    if (h.uniqueBuildingHeights < t.minUniqueBuildingHeights) {
      failures.push(`uniqueBuildingHeights ${h.uniqueBuildingHeights} < ${t.minUniqueBuildingHeights}`);
    }
    if (h.matchedFrac < t.minMatchedHeightFrac) {
      failures.push(`matchedHeightFrac ${h.matchedFrac.toFixed(3)} < ${t.minMatchedHeightFrac}`);
    }
    if (h.uniqueFoliageHeights < t.minUniqueFoliageHeights) {
      failures.push(`uniqueFoliageHeights ${h.uniqueFoliageHeights} < ${t.minUniqueFoliageHeights}`);
    }
  }
  if (scores.imageryRecovery && scores.imageryRecovery.required && !scores.imageryRecovery.hit) {
    failures.push("imagery roof recovery missed " + (scores.imageryRecovery.probe || "probe"));
  }
  if (scores.medians && scores.medians.required && scores.medians.kept < t.minMedianTrees) {
    failures.push(`medianTrees ${scores.medians.kept} < ${t.minMedianTrees}`);
  }
  const ov = scores.overture;
  if (ov && ov.required) {
    if (ov.explicit < t.minOvertureExplicit) {
      failures.push(`overtureHeights ${ov.explicit} < ${t.minOvertureExplicit}`);
    }
    if (ov.added + ov.heightsUpgraded < 1) {
      failures.push("overture merge did not add or upgrade a footprint");
    }
  }
  const terrain = scores.terrain;
  if (terrain && terrain.required) {
    if (terrain.polygons < t.minTerrainPolygons) failures.push("terrain clipboard empty");
    if (terrain.reliefM > 2 && terrain.sloped < 1) failures.push("terrain relief missing sloped floors");
    if (!terrain.separateFromOpenIntent) failures.push("terrain leaked into OpenIntent");
    if (!terrain.mainClipboardFlat) failures.push("main hamina clipboard gained terrain zones");
  }
  const chm = scores.chm;
  if (chm && chm.required && chm.applied < t.minChmTrees) {
    failures.push(`chmTrees ${chm.applied} < ${t.minChmTrees}`);
  }
  const compat = scores.compatibility;
  if (compat && compat.required !== false) {
    if (compat.materials !== ZONE_TYPES.length) {
      failures.push(`openIntentMaterials ${compat.materials} !== ${ZONE_TYPES.length}`);
    }
    if (!compat.stockOnly) failures.push("OpenIntent material is not a stock Hamina name");
    if (!compat.consistent) failures.push("area material does not match the catalog entry");
  }
  return { ok: failures.length === 0, failures };
}

function scoreMaterialCompatibility(openintent) {
  const mats = (openintent && openintent.area_materials) || [];
  const areas =
    (openintent && openintent.floorplans && openintent.floorplans[0] && openintent.floorplans[0].attenuation_areas) ||
    [];
  const expected = ZONE_TYPES.map((t) => t.name);
  const names = mats.map((m) => m && m.name);
  const stockOnly = names.length === expected.length && names.every((n, i) => n === expected[i]);
  const byName = new Map(mats.map((m) => [m.name, m]));
  let consistent = stockOnly;
  for (const a of areas) {
    const m = a && a.area_material;
    const name = typeof m === "string" ? m : m && m.name;
    const cat = name && byName.get(name);
    if (!cat) {
      consistent = false;
      break;
    }
    if (typeof m !== "string" && JSON.stringify(m) !== JSON.stringify(cat)) {
      consistent = false;
      break;
    }
  }
  return {
    required: true,
    mode: "stock-openintent",
    materials: mats.length,
    stockOnly,
    consistent,
  };
}

function scoreMeasuredHeights(features, overlayRings, overlayHeights, frame, openintent, clipboard) {
  let eligible = 0;
  let matched = 0;
  const emitted = new Set();
  for (const f of features || []) {
    const props = (f && f.properties) || {};
    const h = Number(props.height || props.Height || props.HEIGHT || 0);
    if (!(h > 2 && h < 80)) continue;
    const rings = [];
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon" && g.coordinates && g.coordinates[0]) rings.push(g.coordinates[0]);
    else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates || []) if (poly && poly[0]) rings.push(poly[0]);
    }
    for (const ring of rings) {
      // Shoelace centroids of bowed or self-touching rings can land tens of
      // meters outside the footprint and inside a neighbor. Score a point
      // that lies in the source ring, then the nearest emitted roof that
      // contains it.
      const c = interiorPoint(ring);
      if (!c || !pointInRing(c, ring)) continue;
      const px = llToPx(c[0], c[1], frame);
      let found = -1;
      let bestD = Infinity;
      const maxD = 12 / Math.max((frame.mpuX || 1), 0.05);
      for (let i = 0; i < (overlayRings || []).length; i++) {
        if (!pointInRing(px, overlayRings[i])) continue;
        const oc = shoelaceCentroid(overlayRings[i]);
        if (!oc) continue;
        const d = Math.hypot(oc[0] - px[0], oc[1] - px[1]);
        if (d < bestD) {
          bestD = d;
          found = i;
        }
      }
      if (found < 0 || bestD > maxD) continue;
      eligible++;
      const eh = overlayHeights && overlayHeights[found];
      if (eh != null) emitted.add(Number(eh).toFixed(1));
      if (eh != null && Math.abs(eh - Math.round(h * 10) / 10) <= 0.15) matched++;
    }
  }
  const areas = (openintent && openintent.floorplans && openintent.floorplans[0].attenuation_areas) || [];
  const foliageH = new Set();
  let stockFoliage = 0;
  let foliage = 0;
  for (const a of areas) {
    const name = typeof a.area_material === "string" ? a.area_material : a.area_material && a.area_material.name;
    if (!name || name.indexOf("Foliage") !== 0) continue;
    foliage++;
    if (name === "Foliage - Heavy" || name === "Foliage - Light") stockFoliage++;
  }
  const clipTypes = (clipboard && clipboard.attenuatingZoneTypes) || [];
  for (const t of clipTypes) {
    if (t && t.id && String(t.id).indexOf("foliage-m-") === 0 && t.topEdge > 2) {
      foliageH.add(Number(t.topEdge).toFixed(1));
    }
  }
  return {
    applicable: eligible >= 8,
    eligible,
    matched,
    matchedFrac: eligible ? matched / eligible : 1,
    uniqueBuildingHeights: emitted.size,
    uniqueFoliageHeights: foliageH.size,
    foliage,
    stockFoliage,
  };
}

function scoreSite({ built, frame, footprints, jpegDecoded, tcc, treePoints, treesSource }) {
  const buildings = scoreBuildings(footprints.features || [], built._overlayRings || [], frame);
  // overlay rings are not on built; caller may pass overlayRings
  const trees = scoreTrees(treePoints, frame, jpegDecoded, tcc, treesSource);
  const coverage = coverageStats(built.stats);
  const scores = { buildings, trees, coverage };
  const gate = evaluate(scores);
  return { ...scores, gate };
}

module.exports = {
  THRESHOLDS,
  luma,
  pointInRing,
  interiorPoint,
  shoelaceCentroid,
  rasterizeRings,
  iouSets,
  scoreBuildings,
  scoreTrees,
  scoreRoofTrees,
  scoreRoofProbes,
  scoreMeasuredHeights,
  scoreMaterialCompatibility,
  isPavementLike,
  orchardLatticeScore,
  highCanopyRecall,
  treePointsFromBuilt,
  evaluate,
  scoreSite,
  nearestTccPct,
};
