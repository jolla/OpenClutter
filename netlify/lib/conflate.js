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
 *    house inside a campus). A traced outline, dozens of corners and not a
 *    triangle, may replace a concentric stub up to 16× smaller. That is the
 *    retail podium when Microsoft only captured one piece of it. A tower is
 *    kept and the podium is added beside it. A smaller stub never replaces a
 *    larger ring.
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
 *    A measured height above Hamina's Ten Floor stock (32 m) stays that
 *    height on the OpenIntent object. A shorter measured building still uses
 *    the four gold names. A taller inset of a larger footprint is its own
 *    attenuating object (podium plan at the podium height, tower plan at the
 *    tower height). A plain box is one object. Trees use stock Foliage -
 *    Heavy / Light, or a measured-height custom.
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
/**
 * A street-map ring with dozens of corners can be the whole podium while
 * Microsoft only has one block of it. 8× misses the Wynn retail ring
 * (about 57,000 m² over a 6,900 m² fragment). A triangle does not qualify.
 */
const TRACED_STUB_RATIO_MAX = 16;
const TRACED_STUB_MIN_VERTS = 80;
/** Intersection / candidate area above this is the same roof, not a neighbor. */
const STACK_COVER = 0.55;
/** Ignore a shared wall. Notch anything larger that still stacks. */
const STACK_CUT_M2 = 12;
const STACK_CUT_FRAC = 0.06;
/**
 * A smaller footprint inside a larger one is a real upper level when it is
 * at least two floors taller, not a duplicate outline and not a tiny stub.
 * A single simple box never qualifies.
 */
const LEVEL_MIN_DELTA_M = 6;
const LEVEL_MIN_INNER_M2 = 180;
const LEVEL_MIN_RATIO = 0.04;
const LEVEL_MAX_RATIO = 0.8;
/**
 * Two outlines this close in area are one roof with two height readings
 * (Wynn Employee Parking: Microsoft 16.9 m inside Overture/OSM 25 m).
 * A tower on a podium is a much smaller fraction of the lower plan.
 */
const SAME_ROOF_RATIO = 0.55;
/**
 * A skyscraper on a casino podium is a few percent of that podium. The 4%
 * floor still drops a modest step (a penthouse, a duplicate stub). A mass
 * at least 40 m taller than the lower plan, or 40 m with no lower height,
 * may be as small as 0.8% of the outer footprint.
 */
const LEVEL_TALL_DELTA_M = 40;
const LEVEL_TALL_MIN_M = 40;
const LEVEL_TALL_MIN_RATIO = 0.008;
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
function extremeTriRatio(ring) {
  if (!ring || ring.length < 4) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring.slice();
  if (open.length < 3) return 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < open.length; i++) {
    cx += +open[i][0];
    cy += +open[i][1];
  }
  cx /= open.length;
  cy /= open.length;
  const ranked = open.slice().sort((a, b) => {
    const da = (a[0] - cx) * (a[0] - cx) + (a[1] - cy) * (a[1] - cy);
    const db = (b[0] - cx) * (b[0] - cx) + (b[1] - cy) * (b[1] - cy);
    return db - da;
  });
  let best = 0;
  const n = Math.min(12, ranked.length);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = ranked[i];
        const b = ranked[j];
        const c = ranked[k];
        const t = Math.abs(+a[0] * (+b[1] - +c[1]) + +b[0] * (+c[1] - +a[1]) + +c[0] * (+a[1] - +b[1])) / 2;
        if (t > best) best = t;
      }
    }
  }
  let poly = 0;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    poly += +open[j][0] * +open[i][1] - +open[i][0] * +open[j][1];
  }
  poly = Math.abs(poly) / 2;
  return poly > 0 ? best / poly : 0;
}

/**
 * The candidate is a traced roof and the owner is a concentric fragment of
 * it, past the 8× stub cap and within 16×. A triangle is not traced.
 */
function concentricTracedStub(owner, candidate) {
  const ownerRing = singleExterior(owner);
  const candRing = singleExterior(candidate);
  if (!ownerRing || !candRing) return false;
  const va = ringVertexCount(ownerRing);
  const vb = ringVertexCount(candRing);
  const aa = ringAreaM2(ownerRing);
  const ab = ringAreaM2(candRing);
  if (!(aa > 1) || !(ab > 1) || vb < TRACED_STUB_MIN_VERTS) return false;
  if (extremeTriRatio(candRing) >= 0.9) return false;
  const ratio = ab / aa;
  if (!(ratio > CONCENTRIC_STUB_RATIO_MAX && ratio <= TRACED_STUB_RATIO_MAX)) return false;
  if (!(ab < MEGA_CAMPUS_M2)) return false;
  if (!(vb + 1 >= va)) return false;
  const ownerC = centroid(ownerRing);
  const candC = centroid(candRing);
  if (!ownerC || !pointInRing(ownerC, candRing)) return false;
  if (!candC || !pointInRing(candC, ownerRing)) return false;
  return true;
}

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
  if (concentricTracedStub(owner, candidate)) {
    const oh = featureHeight(owner);
    const ch = featureHeight(candidate);
    // A tower standing in the podium is not the fragment to overwrite.
    if (oh >= 30 && oh > (ch || 0) + 12) return false;
    return true;
  }
  return false;
}

function ringIsCoarseMega(ring) {
  return coarseMega(ringAreaM2(ring), ringVertexCount(ring));
}

function roundLevelM(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * A smaller footprint inside a larger one that is its own upper mass.
 * `base` is the lower plan's measured height, or 0 when that plan has none
 * (the upper mass then stands on the floor at its own height). Null when
 * the pair is the same roof, a fragment, or a single box.
 */
function upperInset(inner, outer, innerArea, outerArea) {
  const th = featureHeight(inner);
  const ph = featureHeight(outer);
  if (!(th > 2)) return null;
  const ta = innerArea > 0 ? innerArea : featureAreaM2(inner);
  const pa = outerArea > 0 ? outerArea : featureAreaM2(outer);
  if (!(ta >= LEVEL_MIN_INNER_M2) || !(pa > ta)) return null;
  const ratio = ta / pa;
  if (ratio > LEVEL_MAX_RATIO || ratio >= SAME_ROOF_RATIO) return null;
  const innerRing = singleExterior(inner);
  const outerRing = singleExterior(outer);
  if (!innerRing || !outerRing) return null;
  const c = centroid(innerRing);
  if (!c || !pointInRing(c, outerRing)) return null;
  const podiumKnown = ph >= 2;
  const tall = th >= LEVEL_TALL_MIN_M && (!podiumKnown || th >= ph + LEVEL_TALL_DELTA_M);
  const stepped = podiumKnown && th >= ph + LEVEL_MIN_DELTA_M;
  if (!stepped && !tall) return null;
  const minRatio = tall ? LEVEL_TALL_MIN_RATIO : LEVEL_MIN_RATIO;
  if (ratio < minRatio) return null;
  return { base: stepped ? roundLevelM(ph) : 0 };
}

/**
 * Height of the lower plan when `inner` is a taller inset of `outer`.
 * 0 when the pair is the same roof, a fragment, a single box, or an upper
 * mass whose lower plan has no measured height.
 */
function levelBaseM(inner, outer, innerArea, outerArea) {
  const hit = upperInset(inner, outer, innerArea, outerArea);
  return hit && hit.base > 0 ? hit.base : 0;
}

function bestUpperInset(feature, area, others) {
  let chosen = null;
  for (let i = 0; i < others.length; i++) {
    const other = others[i];
    if (!other || other.feature === feature) continue;
    const hit = upperInset(feature, other.feature, area, other.area);
    if (!hit) continue;
    if (!chosen || hit.base > chosen.base) chosen = hit;
  }
  return chosen;
}

function stampLevelBase(feature, base) {
  if (!feature || !(base > 0)) return;
  if (!feature.properties) feature.properties = {};
  const prev = Number(feature.properties.levelBaseM) || 0;
  if (base > prev) feature.properties.levelBaseM = base;
}

function bestLevelBase(feature, area, others) {
  let base = 0;
  for (let i = 0; i < others.length; i++) {
    const other = others[i];
    if (!other || other.feature === feature) continue;
    const b = levelBaseM(feature, other.feature, area, other.area);
    if (b > base) base = b;
  }
  return base;
}

function similarFootprint(owner, candidate) {
  const aa = featureAreaM2(owner);
  const ab = featureAreaM2(candidate);
  if (!(aa > 1) || !(ab > 1)) return false;
  const ratio = ab / aa;
  return ratio >= 0.4 && ratio <= 2.5;
}

function keepCaravanFlag(owner, candidate) {
  const props = candidate && candidate.properties;
  if (!props || props.staticCaravan !== true || !owner) return;
  if (!owner.properties) owner.properties = {};
  owner.properties.staticCaravan = true;
  if (!(Number(owner.properties.height) > 2)) {
    owner.properties.height = Number(props.height) > 2 ? Number(props.height) : 3.5;
    owner.properties.heightSource = props.heightSource || "static-caravan";
  }
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
      const towerOnOwner = upperInset(f, owner.feature);
      if (towerOnOwner) {
        if (towerOnOwner.base > 0) stampLevelBase(f, towerOnOwner.base);
        covered = false;
        continue;
      }
      const ownerOnCandidate = upperInset(owner.feature, f);
      if (ownerOnCandidate) {
        if (ownerOnCandidate.base > 0) stampLevelBase(owner.feature, ownerOnCandidate.base);
        covered = false;
        continue;
      }
      if (replace && shouldReplaceGeometry(owner.feature, f)) {
        replaceGeometry(owner.feature, f, owners);
        geometriesReplaced++;
      } else if (replace && concentricTracedStub(owner.feature, f)) {
        // The owner is a tower inside this outline. Keep the tower and the podium.
        covered = false;
        continue;
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

function childMostlyInside(child, parent) {
  if (!(child.area >= 80) || !(child.area < parent.area * 0.92)) return false;
  if (!meterHit(parent.bb, child.bb)) return false;
  let inter = 0;
  try {
    inter = multiArea(polygonClipping.intersection([[child.m]], [[parent.m]]));
  } catch {
    return false;
  }
  return inter / child.area >= 0.75;
}

/**
 * Overture often emits the whole roof and the parts that already tile it.
 * Drawing both stacks a second volume on the podium and the towers. Two or
 * more parts that cover most of that outline replace it. A tower that only
 * covers a corner of its podium does not.
 */
function coveredParentIndexes(items) {
  const drop = new Set();
  for (let i = 0; i < items.length; i++) {
    if (items[i].mega) continue;
    const parent = items[i];
    const children = [];
    for (let j = 0; j < items.length; j++) {
      if (i === j || drop.has(j)) continue;
      if (childMostlyInside(items[j], parent)) children.push(items[j]);
    }
    if (children.length < 2) continue;
    let mask;
    try {
      mask = [[children[0].m]];
      for (let c = 1; c < children.length; c++) mask = polygonClipping.union(mask, [[children[c].m]]);
    } catch {
      continue;
    }
    let cover = 0;
    try {
      cover = multiArea(polygonClipping.intersection([[parent.m]], mask));
    } catch {
      continue;
    }
    if (parent.area > 0 && cover / parent.area >= 0.6) drop.add(i);
  }
  return drop;
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
  keepCaravanFlag(best.feature, item.feature);
  keepCaravanFlag(best.feature, partner.feature);
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
  const skipParent = coveredParentIndexes(items);
  const kept = [];
  const megas = [];
  let dropped = 0;
  let cut = 0;
  let merged = 0;
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    if (skipParent.has(n)) {
      dropped++;
      continue;
    }
    if (item.mega) {
      megas.push(item);
      continue;
    }
    const hit = overlapAgainst(item, kept);
    const cover = item.area > 0 ? hit.inter / item.area : 0;
    const upper = bestUpperInset(item.feature, item.area, hit.targets);
    if (upper && hit.inter >= STACK_CUT_M2) {
      if (upper.base > 0) stampLevelBase(item.feature, upper.base);
      const copy = cloneKept(item, null, proj);
      if (copy) kept.push(copy);
      continue;
    }
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
      if (hit.best) {
        applyHeight(hit.best.feature, item.feature, true);
        keepCaravanFlag(hit.best.feature, item.feature);
      }
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
        if (cover >= 0.35 && hit.best) {
          applyHeight(hit.best.feature, item.feature, true);
          keepCaravanFlag(hit.best.feature, item.feature);
        }
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
  for (let i = 0; i < kept.length; i++) {
    const base = bestLevelBase(kept[i].feature, kept[i].area, kept);
    if (base > 0) stampLevelBase(kept[i].feature, base);
  }
  // A stamped base is the lower plan's roof. It may lift this footprint only
  // while that plan is still here and covers it. A dropped duplicate leaves
  // a gap, so the mass extends to the ground. A source bridge keeps its base.
  groundUncoveredFloats(kept);
  return { features: kept.map((k) => k.feature), dropped, cut, merged };
}

function lowerCoversFloat(item, other) {
  if (!item || !other || other === item) return false;
  if (coarseMega(other.area, other.verts)) return false;
  const props = item.feature && item.feature.properties;
  const base = Number(props && props.levelBaseM) || 0;
  if (!(base > 0)) return false;
  const otherProps = other.feature && other.feature.properties;
  const otherBase = Number(otherProps && otherProps.levelBaseM) || 0;
  if (otherBase > 1) return false;
  const oh = featureHeight(other.feature);
  if (!(oh + 1.5 >= base)) return false;
  let inter = 0;
  try {
    inter = multiArea(polygonClipping.intersection([[item.m]], [[other.m]]));
  } catch {
    return false;
  }
  return item.area > 0 && inter / item.area >= 0.6;
}

function groundUncoveredFloats(kept) {
  for (let i = 0; i < kept.length; i++) {
    const item = kept[i];
    const props = item.feature && item.feature.properties;
    if (!props) continue;
    const base = Number(props.levelBaseM) || 0;
    if (!(base > 0) || props.floatSpan) continue;
    let covered = false;
    for (let j = 0; j < kept.length; j++) {
      if (lowerCoversFloat(item, kept[j])) {
        covered = true;
        break;
      }
    }
    if (!covered) delete props.levelBaseM;
  }
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
