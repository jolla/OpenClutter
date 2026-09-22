"use strict";

/**
 * Footprint conflation. OSM ways are never read.
 *
 * Geometry, best ring wins:
 * 1. Microsoft Global ML is the base polygon.
 * 2. Overture, then Esri MSBFP2, then FEMA USA Structures are considered in
 *    that order. A candidate is the same building when its exterior centroid
 *    sits inside a kept ring, or within 11 m of that ring's centroid (a second
 *    outline of the same roof). It is not emitted twice.
 * 3. Replace the kept ring only when the candidate is a single exterior and
 *    either has more vertices at a similar area, or the kept ring is a partial
 *    stub inside a fuller outline (area at most 2.4×). A smaller stub never
 *    replaces a larger ring. Imagery roof fill still runs after this and does
 *    not invent rings.
 *
 * Height, measured wins (higher rank replaces):
 *    overture explicit height > Microsoft Global ML height > FEMA HEIGHT
 *    > Overture num_floors × 3 m > nearest measured neighbor within 120 m
 *    > stock One Floor / Five Floor / Hotel bins.
 *    Microsoft height -1 and anything ≤ 2 m is ignored.
 *    Ties keep the height already on the kept ring.
 *    OpenIntent buildings use the four gold Building names. Trees use
 *    stock Foliage - Heavy / Light, or a measured-height custom. Exact metres
 *    are clipboard zone types only (materials.js, compatibilityMode stock-foliage).
 */

const { exteriorRings, centroid, pointInRing, featureHeight, setFeatureHeight } = require("./ms-global");

const HEIGHT_RANK = {
  overture: 40,
  "ms-global": 30,
  fema: 20,
  "overture-floors": 10,
  nearby: 5,
};

const FLOOR_HEIGHT_M = 3;

function heightSource(feature) {
  return (feature && feature.properties && feature.properties.heightSource) || "";
}

function heightRank(feature) {
  const src = heightSource(feature);
  if (HEIGHT_RANK[src]) return HEIGHT_RANK[src];
  if (featureHeight(feature)) return HEIGHT_RANK.fema;
  return 0;
}

function ringVertexCount(ring) {
  if (!ring || ring.length < 4) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  return closed ? ring.length - 1 : ring.length;
}

function featureVertexCount(feature) {
  const rings = exteriorRings(feature && feature.geometry);
  let n = 0;
  for (const r of rings) n += ringVertexCount(r);
  return n;
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return 0;
  let lat = 0;
  for (let i = 0; i < n; i++) lat += +ring[i][1];
  const cos = Math.cos(((lat / n) * Math.PI) / 180);
  const mx = 111320 * Math.max(0.2, cos);
  const my = 110540;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += +ring[i][0] * mx * +ring[j][1] * my - +ring[j][0] * mx * +ring[i][1] * my;
  }
  return Math.abs(a) / 2;
}

function featureAreaM2(feature) {
  const rings = exteriorRings(feature && feature.geometry);
  let a = 0;
  for (const r of rings) a += ringAreaM2(r);
  return a;
}

function singleExterior(feature) {
  const rings = exteriorRings(feature && feature.geometry);
  return rings.length === 1 ? rings[0] : null;
}

function cloneGeometry(geometry) {
  return JSON.parse(JSON.stringify(geometry));
}

const SAME_ROOF_M = 11;

function centroidNear(c, ring) {
  const oc = centroid(ring);
  if (!c || !oc) return false;
  const cos = Math.cos((c[1] * Math.PI) / 180);
  const dx = (c[0] - oc[0]) * 111320 * Math.max(0.2, cos);
  const dy = (c[1] - oc[1]) * 110540;
  return dx * dx + dy * dy <= SAME_ROOF_M * SAME_ROOF_M;
}

/**
 * @returns {boolean}
 */
function shouldReplaceGeometry(owner, candidate) {
  const ownerRing = singleExterior(owner);
  const candRing = singleExterior(candidate);
  if (!ownerRing || !candRing) return false;
  const va = ringVertexCount(ownerRing);
  const vb = ringVertexCount(candRing);
  const aa = ringAreaM2(ownerRing);
  const ab = ringAreaM2(candRing);
  if (!(aa > 1) || !(ab > 1) || !(va >= 3) || !(vb >= 3)) return false;
  const ratio = ab / aa;
  if (vb >= va + 2 && ratio >= 0.65 && ratio <= 1.5) return true;
  const c = centroid(ownerRing);
  if (ratio >= 1.35 && ratio <= 2.4 && vb + 1 >= va && c && pointInRing(c, candRing)) return true;
  return false;
}

function similarFootprint(owner, candidate) {
  const aa = featureAreaM2(owner);
  const ab = featureAreaM2(candidate);
  if (!(aa > 1) || !(ab > 1)) return false;
  const ratio = ab / aa;
  return ratio >= 0.4 && ratio <= 2.5;
}

function applyHeight(owner, candidate, rankHeight) {
  const h = featureHeight(candidate);
  if (!h) return "";
  if (!similarFootprint(owner, candidate)) return "";
  const src = heightSource(candidate);
  const had = featureHeight(owner);
  if (!rankHeight) {
    if (had) return "";
    setFeatureHeight(owner, h);
    if (src) owner.properties.heightSource = src;
    return "filled";
  }
  if (had && heightRank(candidate) <= heightRank(owner)) return "";
  setFeatureHeight(owner, h);
  if (src) owner.properties.heightSource = src;
  else if (!had) delete owner.properties.heightSource;
  return had ? "upgraded" : "filled";
}

function replaceGeometry(owner, candidate, owners) {
  for (let i = owners.length - 1; i >= 0; i--) {
    if (owners[i].feature === owner) owners.splice(i, 1);
  }
  owner.geometry = cloneGeometry(candidate.geometry);
  if (!owner.properties) owner.properties = {};
  if (candidate.properties && candidate.properties.geomSource) {
    owner.properties.geomSource = candidate.properties.geomSource;
  }
  const rings = exteriorRings(owner.geometry);
  for (const r of rings) owners.push({ ring: r, feature: owner });
}

/**
 * @param {object[]} primary
 * @param {object[]} secondary
 * @param {{replaceGeometry?: boolean, rankHeight?: boolean}} [opts]
 */
function conflateFootprints(primary, secondary, opts) {
  const replace = !!(opts && opts.replaceGeometry);
  const rankHeight = !!(opts && opts.rankHeight);
  const base = Array.isArray(primary) ? primary.slice() : [];
  const extraSrc = Array.isArray(secondary) ? secondary : [];
  const owners = [];
  for (const f of base) {
    const ex = exteriorRings(f && f.geometry);
    for (const r of ex) owners.push({ ring: r, feature: f });
  }
  let added = 0;
  let heightsTransferred = 0;
  let heightsUpgraded = 0;
  let geometriesReplaced = 0;
  for (const f of extraSrc) {
    const ex = exteriorRings(f && f.geometry);
    if (!ex.length) continue;
    let covered = true;
    const seen = new Set();
    for (const ring of ex) {
      const c = centroid(ring);
      const owner =
        c &&
        (owners.find((o) => pointInRing(c, o.ring)) || owners.find((o) => centroidNear(c, o.ring)));
      if (!owner) {
        covered = false;
        continue;
      }
      if (seen.has(owner.feature)) continue;
      seen.add(owner.feature);
      if (replace && shouldReplaceGeometry(owner.feature, f)) {
        replaceGeometry(owner.feature, f, owners);
        geometriesReplaced++;
      }
      const how = applyHeight(owner.feature, f, rankHeight);
      if (how === "filled") heightsTransferred++;
      else if (how === "upgraded") heightsUpgraded++;
    }
    if (covered) continue;
    base.push(f);
    for (const r of ex) owners.push({ ring: r, feature: f });
    added++;
  }
  return { features: base, added, heightsTransferred, heightsUpgraded, geometriesReplaced };
}

function tagLayer(features, geomSource, heightSourceName) {
  const list = Array.isArray(features) ? features : [];
  for (const f of list) {
    if (!f) continue;
    if (!f.properties) f.properties = {};
    if (!f.properties.geomSource && geomSource) f.properties.geomSource = geomSource;
    if (heightSourceName && featureHeight(f) && !f.properties.heightSource) {
      f.properties.heightSource = heightSourceName;
    }
  }
  return list;
}

function countHeightSources(features) {
  const counts = { "ms-global": 0, overture: 0, fema: 0, "overture-floors": 0, nearby: 0, untagged: 0 };
  for (const f of features || []) {
    if (!featureHeight(f)) continue;
    const src = heightSource(f);
    if (src && Object.prototype.hasOwnProperty.call(counts, src)) counts[src]++;
    else counts.untagged++;
  }
  return counts;
}

/**
 * Global ML, then Overture, then MSBFP2, then USA Structures.
 * Imagery roofs are applied by the caller after this.
 */
function assembleFootprints({ global, overture, arcgis, usa }) {
  const g = tagLayer(global, "ms-global", "ms-global");
  const o = tagLayer(overture, "overture", null);
  const a = tagLayer(arcgis, "arcgis", null);
  const u = tagLayer(usa, "usa", "fema");
  const withOverture = conflateFootprints(g, o, { replaceGeometry: true, rankHeight: true });
  const withArc = conflateFootprints(withOverture.features, a, { replaceGeometry: true, rankHeight: true });
  const withUsa = conflateFootprints(withArc.features, u, { replaceGeometry: true, rankHeight: true });
  return {
    features: withUsa.features,
    overtureAdded: withOverture.added,
    overtureUpgraded: withOverture.heightsUpgraded,
    geometriesReplaced:
      withOverture.geometriesReplaced + withArc.geometriesReplaced + withUsa.geometriesReplaced,
    heightsTransferred:
      withOverture.heightsTransferred + withArc.heightsTransferred + withUsa.heightsTransferred,
    heightSources: countHeightSources(withUsa.features),
  };
}

module.exports = {
  HEIGHT_RANK,
  FLOOR_HEIGHT_M,
  heightRank,
  heightSource,
  ringAreaM2,
  shouldReplaceGeometry,
  conflateFootprints,
  assembleFootprints,
  countHeightSources,
  tagLayer,
};
