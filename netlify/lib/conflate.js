"use strict";

/**
 * Footprint conflation. OSM ways are never read.
 *
 * Geometry, best ring wins:
 * 1. Microsoft Global ML is the base polygon.
 * 2. Overture, then Esri MSBFP2, then FEMA USA Structures are considered in
 *    that order. A candidate is the same building when its exterior centroid
 *    sits inside a kept ring, or within 11 m of that ring's centroid (a second
 *    outline of the same roof). It is not emitted twice. A coarse mega hull
 *    (over 150000 m² and under 40 vertices) does not count: emit drops that
 *    hull, so using it as a mask deletes the detailed roofs inside it.
 * 3. Replace the kept ring only when the candidate is a single exterior and
 *    either has more vertices at a similar area, or the kept ring is a partial
 *    stub inside a fuller outline. A stub up to 2.4× smaller is replaced when
 *    it sits inside the fuller ring. A center stub up to 8× smaller is replaced
 *    only when each centroid lies inside the other ring (the same roof, not a
 *    house inside a campus). A smaller stub never replaces a larger ring.
 *    Imagery roof fill still runs after this and does not invent rings.
 * 4. Centroid-in-ring still misses the same roof drawn twice when the outlines
 *    are shifted (Oak Creek duplicates sit 14–16 m apart, IoU ~0.7, and neither
 *    centroid falls inside the other). dedupeStackedFootprints runs after the
 *    layer merge and again at emit: a ring that is mostly covered by a better
 *    outline is dropped; a real neighbor that only cuts across the edge is
 *    notched so the shared patch is emitted once. A shared wall with almost
 *    no area is left alone.
 *
 * Height, measured wins (higher rank replaces):
 *    overture explicit height > Microsoft Global ML height > NLS laser nDSM
 *    > FEMA HEIGHT > Overture num_floors × 3 m > nearest measured neighbor
 *    within 120 m > stock One Floor / Five Floor / Hotel bins.
 *    NLS laser is applied on the dev host after this merge (Finland tile
 *    L5211C3). It does not replace overture, MS, or FEMA heights.
 *    Microsoft height -1 and anything ≤ 2 m is ignored.
 *    Ties keep the height already on the kept ring.
 *    OpenIntent buildings use the four gold Building names. Trees use
 *    stock Foliage - Heavy / Light, or a measured-height custom. Exact metres
 *    are clipboard zone types only (materials.js, compatibilityMode stock-foliage).
 */

const polygonClipping = require("polygon-clipping");
const { exteriorRings, centroid, pointInRing, featureHeight, setFeatureHeight } = require("./ms-global");
const { simpleExteriorRings } = require("./poly-clip");

const HEIGHT_RANK = {
  overture: 40,
  "ms-global": 30,
  "nls-laser": 25,
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
/** Fuller outline may replace a stub up to this area ratio. */
const STUB_RATIO_MAX = 2.4;
/**
 * A concentric center stub (each centroid inside the other ring) may be up to
 * this many times smaller than the full roof. Vegas east of the Sphere: a
 * 1355 m² fragment sits in an 8246 m² hall (ratio ~6). A campus centroid does
 * not fall inside a house, so this does not promote a hull over a real roof.
 */
const CONCENTRIC_STUB_RATIO_MAX = 8;
/** Intersection / candidate area above this is the same roof, not a neighbor. */
const STACK_COVER = 0.55;
/** Ignore a shared wall. Notch anything larger that still stacks. */
const STACK_CUT_M2 = 12;
const STACK_CUT_FRAC = 0.06;
/** Same bands as pipeline isMegaCampus. A coarse campus hull is left for that filter. */
const MEGA_CAMPUS_M2 = 150000;
const HOTEL_MEGA_M2 = 400000;
const MEGA_MIN_DETAIL_VERTS = 40;

function coarseMega(area, verts) {
  if (!(area > MEGA_CAMPUS_M2)) return false;
  if (area > HOTEL_MEGA_M2) return true;
  return !(verts >= MEGA_MIN_DETAIL_VERTS);
}

const SOURCE_RANK = {
  overture: 50,
  "ms-global": 40,
  "imagery-roof": 35,
  arcgis: 20,
  usa: 10,
};

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
  const ownerC = centroid(ownerRing);
  if (!(ownerC && pointInRing(ownerC, candRing) && vb + 1 >= va && ratio >= 1.35)) return false;
  if (ratio <= STUB_RATIO_MAX) return true;
  const candC = centroid(candRing);
  if (
    ratio <= CONCENTRIC_STUB_RATIO_MAX &&
    ab < MEGA_CAMPUS_M2 &&
    candC &&
    pointInRing(candC, ownerRing)
  ) {
    return true;
  }
  return false;
}

function ringIsCoarseMega(ring) {
  return coarseMega(ringAreaM2(ring), ringVertexCount(ring));
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
      const blocks = (o) => !ringIsCoarseMega(o.ring);
      const owner =
        c &&
        (owners.find((o) => blocks(o) && pointInRing(c, o.ring)) ||
          owners.find((o) => blocks(o) && centroidNear(c, o.ring)));
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
  const counts = { "ms-global": 0, overture: 0, "nls-laser": 0, fema: 0, "overture-floors": 0, nearby: 0, untagged: 0 };
  for (const f of features || []) {
    if (!featureHeight(f)) continue;
    const src = heightSource(f);
    if (src && Object.prototype.hasOwnProperty.call(counts, src)) counts[src]++;
    else counts.untagged++;
  }
  return counts;
}

function evidenceRank(feature) {
  const src = heightSource(feature);
  return HEIGHT_RANK[src] || 0;
}

function sourceRank(feature) {
  const props = (feature && feature.properties) || {};
  const name = props.geomSource || props.source || "";
  return SOURCE_RANK[name] || 0;
}

function keepScore(item) {
  return item.evidence * 1e9 + item.sourceRank * 1e6 + Math.min(item.verts, 160) * 1e3 + item.area;
}

function ringsForDedupe(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : geometry.type === "Polygon"
        ? [geometry.coordinates]
        : [];
  const out = [];
  for (const rings of polys) {
    if (!rings || !rings[0] || rings[0].length < 4) continue;
    out.push(rings[0]);
    for (let i = 1; i < rings.length; i++) {
      const ring = rings[i];
      if (!ring || ring.length < 4) continue;
      const c = centroid(ring);
      if (c && pointInRing(c, rings[0])) continue;
      out.push(ring);
    }
  }
  return out;
}

function projectionFor(features) {
  let lat = 0;
  let n = 0;
  let lon0 = 0;
  let lat0 = 0;
  let seeded = false;
  for (const f of features) {
    for (const ring of ringsForDedupe(f && f.geometry)) {
      for (const p of ring) {
        const x = +p[0];
        const y = +p[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!seeded) {
          lon0 = x;
          lat0 = y;
          seeded = true;
        }
        lat += y;
        n++;
      }
    }
  }
  const mean = n ? lat / n : 0;
  const cos = Math.cos((mean * Math.PI) / 180);
  return { mx: 111320 * Math.max(0.2, cos), my: 110540, lon0, lat0 };
}

function meterArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

function multiArea(multi) {
  let a = 0;
  for (const poly of multi || []) {
    if (!poly || !poly[0]) continue;
    a += meterArea(poly[0]);
    for (let i = 1; i < poly.length; i++) a -= meterArea(poly[i]);
  }
  return a > 0 ? a : 0;
}

function openPts(ring, tol) {
  if (!ring || ring.length < 3) return [];
  const closed =
    ring.length >= 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const src = closed ? ring.slice(0, -1) : ring.slice();
  const out = [];
  for (const p of src) {
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(+p[0] - last[0], +p[1] - last[1]) < tol) continue;
    out.push([+p[0], +p[1]]);
  }
  if (out.length >= 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < tol) {
    out.pop();
  }
  return out;
}

function openMeters(ring) {
  return openPts(ring, 0.05);
}

function closeMeters(open) {
  if (!open || open.length < 3) return [];
  const ring = open.slice();
  if (signedMeter(ring) < 0) ring.reverse();
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function signedMeter(open) {
  let a = 0;
  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    const q = open[(i + 1) % open.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function toMeters(ring, proj) {
  const open = openPts(ring, 1e-10);
  if (open.length < 3) return [];
  const pts = open.map(([lon, lat]) => [(lon - proj.lon0) * proj.mx, (lat - proj.lat0) * proj.my]);
  return closeMeters(pts);
}

function fromMeters(ring, proj) {
  const open = openMeters(ring);
  if (open.length < 3) return [];
  const pts = open.map(([x, y]) => [proj.lon0 + x / proj.mx, proj.lat0 + y / proj.my]);
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

function meterBBox(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

function meterHit(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function pieceWorthKeeping(area, original) {
  if (!(area >= 22)) return false;
  if (area >= original * 0.45) return true;
  return area >= 90;
}

function cloneKept(item, meterRing, proj) {
  const m = meterRing || item.m;
  const lonLat = fromMeters(m, proj);
  if (lonLat.length < 4) return null;
  const feature = {
    type: "Feature",
    properties: JSON.parse(JSON.stringify((item.feature && item.feature.properties) || {})),
    geometry: { type: "Polygon", coordinates: [lonLat] },
  };
  if (item.feature && item.feature.id != null) feature.id = item.feature.id;
  return {
    feature,
    m,
    area: meterArea(m),
    bb: meterBBox(m),
    verts: openMeters(m).length,
  };
}

function overlapAgainst(item, kept) {
  const targets = [];
  for (const k of kept) {
    if (meterHit(item.bb, k.bb)) targets.push(k);
  }
  if (!targets.length) return { inter: 0, targets, best: null };
  let mask;
  try {
    mask = [[targets[0].m]];
    for (let i = 1; i < targets.length; i++) mask = polygonClipping.union(mask, [[targets[i].m]]);
  } catch {
    return { inter: 0, targets, best: null };
  }
  let inter = 0;
  try {
    inter = multiArea(polygonClipping.intersection([[item.m]], mask));
  } catch {
    inter = 0;
  }
  let best = null;
  let bestA = 0;
  for (const k of targets) {
    let a = 0;
    try {
      a = multiArea(polygonClipping.intersection([[item.m]], [[k.m]]));
    } catch {
      a = 0;
    }
    if (a > bestA) {
      bestA = a;
      best = k;
    }
  }
  return { inter, targets, best };
}

function cutAgainst(item, targets, proj) {
  let geom = [[item.m]];
  for (const t of targets) {
    try {
      geom = polygonClipping.difference(geom, [[t.m]]);
    } catch {
      return null;
    }
  }
  const rings = simpleExteriorRings(geom);
  const pieces = [];
  for (const ring of rings) {
    const kept = cloneKept(item, ring, proj);
    if (kept && kept.area >= 1) pieces.push(kept);
  }
  return pieces;
}

function unionInto(partner, item, proj) {
  let geom;
  try {
    geom = polygonClipping.union([[partner.m]], [[item.m]]);
  } catch {
    return null;
  }
  const rings = simpleExteriorRings(geom);
  let best = null;
  for (const ring of rings) {
    const piece = cloneKept(partner, ring, proj);
    if (piece && (!best || piece.area > best.area)) best = piece;
  }
  if (!best || best.area < partner.area * 0.9) return null;
  applyHeight(best.feature, item.feature, true);
  applyHeight(best.feature, partner.feature, true);
  return best;
}

/**
 * One outline per roof. Shifted copies from MS / Overture / USA Structures
 * survive the centroid test; this drops a ring that is mostly inside a better
 * outline, and notches a neighbor that only shares a patch. Touching walls
 * (a few square metres) stay as two buildings.
 *
 * @param {object[]} features
 * @returns {{features: object[], dropped: number, cut: number, merged: number}}
 */
function dedupeStackedFootprints(features) {
  const list = Array.isArray(features) ? features : [];
  const proj = projectionFor(list);
  const items = [];
  for (const f of list) {
    if (!f || !f.geometry) continue;
    for (const ring of ringsForDedupe(f.geometry)) {
      const m = toMeters(ring, proj);
      if (m.length < 4) continue;
      const area = meterArea(m);
      if (!(area >= 1)) continue;
      items.push({
        feature: f,
        m,
        area,
        bb: meterBBox(m),
        verts: openPts(ring, 1e-10).length,
        evidence: evidenceRank(f),
        sourceRank: sourceRank(f),
        mega: false,
      });
      const item = items[items.length - 1];
      item.mega = coarseMega(item.area, item.verts);
    }
  }
  items.sort((a, b) => keepScore(b) - keepScore(a));
  const kept = [];
  const megas = [];
  let dropped = 0;
  let cut = 0;
  let merged = 0;
  for (const item of items) {
    if (item.mega) {
      megas.push(item);
      continue;
    }
    const hit = overlapAgainst(item, kept);
    const cover = item.area > 0 ? hit.inter / item.area : 0;
    if (hit.inter >= STACK_CUT_M2 && cover >= STACK_COVER && hit.best) {
      let other = 0;
      for (const t of hit.targets) {
        if (t === hit.best) continue;
        try {
          other += multiArea(polygonClipping.intersection([[item.m]], [[t.m]]));
        } catch {
          /* a second partner that cannot be measured blocks the union */
          other = item.area;
        }
      }
      if (other < item.area * 0.15) {
        const united = unionInto(hit.best, item, proj);
        if (united) {
          const idx = kept.indexOf(hit.best);
          if (idx >= 0) kept[idx] = united;
          merged++;
          continue;
        }
      }
      if (hit.best) applyHeight(hit.best.feature, item.feature, true);
      const rescue = cutAgainst(item, hit.targets, proj);
      const wing = rescue ? rescue.filter((p) => pieceWorthKeeping(p.area, item.area)) : null;
      if (wing && wing.length) {
        cut++;
        for (const p of wing) kept.push(p);
        continue;
      }
      dropped++;
      continue;
    }
    if (hit.inter >= STACK_CUT_M2 && cover >= STACK_CUT_FRAC) {
      const pieces = cutAgainst(item, hit.targets, proj);
      const good = pieces ? pieces.filter((p) => pieceWorthKeeping(p.area, item.area)) : null;
      if (!pieces) {
        const copy = cloneKept(item, null, proj);
        if (copy) kept.push(copy);
        continue;
      }
      if (!good.length) {
        if (cover >= 0.35 && hit.best) applyHeight(hit.best.feature, item.feature, true);
        if (cover >= 0.35) dropped++;
        else {
          const copy = cloneKept(item, null, proj);
          if (copy) kept.push(copy);
        }
        continue;
      }
      cut++;
      for (const p of good) kept.push(p);
      continue;
    }
    const copy = cloneKept(item, null, proj);
    if (copy) kept.push(copy);
  }
  for (const item of megas) {
    const copy = cloneKept(item, null, proj);
    if (copy) kept.push(copy);
  }
  return { features: kept.map((k) => k.feature), dropped, cut, merged };
}

/**
 * Global ML, then Overture, then MSBFP2, then USA Structures.
 * Imagery roofs are applied by the caller after this.
 * Stacked outlines of the same roof are removed before return.
 */
function assembleFootprints({ global, overture, arcgis, usa }) {
  const g = tagLayer(global, "ms-global", "ms-global");
  const o = tagLayer(overture, "overture", null);
  const a = tagLayer(arcgis, "arcgis", null);
  const u = tagLayer(usa, "usa", "fema");
  const withOverture = conflateFootprints(g, o, { replaceGeometry: true, rankHeight: true });
  const withArc = conflateFootprints(withOverture.features, a, { replaceGeometry: true, rankHeight: true });
  const withUsa = conflateFootprints(withArc.features, u, { replaceGeometry: true, rankHeight: true });
  const separated = dedupeStackedFootprints(withUsa.features);
  return {
    features: separated.features,
    overtureAdded: withOverture.added,
    overtureUpgraded: withOverture.heightsUpgraded,
    geometriesReplaced:
      withOverture.geometriesReplaced + withArc.geometriesReplaced + withUsa.geometriesReplaced,
    heightsTransferred:
      withOverture.heightsTransferred + withArc.heightsTransferred + withUsa.heightsTransferred,
    heightSources: countHeightSources(separated.features),
    stackedDropped: separated.dropped,
    stackedCut: separated.cut,
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
  dedupeStackedFootprints,
  countHeightSources,
  tagLayer,
};
