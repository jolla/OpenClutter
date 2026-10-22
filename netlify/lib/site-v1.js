"use strict";

/**
 * Direct API v1: turn one finished export into structured site data.
 * Input is the same model the OpenIntent writer gets (attenuation areas in
 * image pixels, the frame, the conflated footprints, outdoor features, DEM
 * samples and map notes). Output is GeoJSON in EPSG:4326 per collection.
 * Nothing here detects anything; it only reshapes what the export built.
 */

const { pxToLl, clipboardToLl } = require("./geo-frame");
const { version: engineVersion } = require("./version");

const API_VERSION = "1.0.0";
const FREQUENCY_GHZ = 5;
const COLLECTIONS = [
  "buildings",
  "trees",
  "poles",
  "water",
  "parking",
  "walls",
  "vehicles",
  "other",
  "terrain",
  "gpsAnchors",
  "mapNotes",
  "aerial",
  "provenance",
];
const FEATURE_COLLECTIONS = [
  "buildings",
  "trees",
  "poles",
  "water",
  "parking",
  "walls",
  "vehicles",
  "other",
  "gpsAnchors",
  "mapNotes",
];

function r6(n) {
  return Math.round(n * 1e6) / 1e6;
}
function r2(n) {
  return Math.round(n * 100) / 100;
}

function classify(name) {
  const n = String(name || "");
  if (/^Foliage - Trunk/i.test(n)) return "trunk";
  if (/^Foliage - Understory/i.test(n)) return "stand";
  if (/^Foliage/i.test(n)) return "crown";
  if (/Light pole/i.test(n)) return "pole";
  if (/^Water/i.test(n)) return "water";
  if (/^Parking/i.test(n)) return "parking";
  if (/^(Retaining wall|Wall|Fence|Hedge)/i.test(n)) return "wall";
  if (/^(RV|Semi|Car|Boat|Trailer|Mobile home)/i.test(n)) return "vehicle";
  if (/^(Building|Podium)/i.test(n) || /Podium/i.test(n)) return "building";
  return "other";
}

function wallKind(name) {
  const n = String(name || "").toLowerCase();
  if (n.indexOf("retaining") === 0) return "retaining";
  if (n.indexOf("fence") === 0) return "fence";
  if (n.indexOf("hedge") === 0) return "hedge";
  return "wall";
}

function vehicleKind(name) {
  const m = /^(RV|Semi|Car|Boat|Trailer|Mobile home)/i.exec(String(name || ""));
  return m ? m[1].toLowerCase().replace(" ", "-") : "vehicle";
}

function otherKind(name) {
  const m = /^(Guideway|Bridge|Storage)/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "other";
}

function ringFromArea(area, frame) {
  const coords = (area && area.area && area.area.coordinates) || [];
  const ll = [];
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i] && coords[i].coordinate_xyz;
    if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
    const q = pxToLl(+p.x, +p.y, frame);
    ll.push([r6(q[0]), r6(q[1])]);
  }
  if (ll.length < 3) return null;
  const a = ll[0];
  const b = ll[ll.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ll.push([a[0], a[1]]);
  return ll;
}

function centroid(ring) {
  let x = 0;
  let y = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [r6(x / n), r6(y / n)];
}

function areaM2(ring, frame) {
  const mx = (frame.widthM || 0) / Math.max(1e-12, frame.east - frame.west);
  const my = (frame.lengthM || 0) / Math.max(1e-12, frame.north - frame.south);
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * mx * (ring[i + 1][1] * my) - ring[i + 1][0] * mx * (ring[i][1] * my);
  }
  return Math.abs(s) / 2;
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-18) + xi) inside = !inside;
  }
  return inside;
}

function bboxOf(ring) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of ring) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

function materialOf(mat) {
  const rf = (mat && mat.rf_properties) || {};
  return {
    name: String((mat && mat.name) || ""),
    attenuationDbPerMeter: Number.isFinite(+rf.attenuation_per_m) ? +rf.attenuation_per_m : null,
    frequencyGHz: FREQUENCY_GHZ,
    displayColor: (mat && mat.display_color) || null,
  };
}

function heightsOf(mat) {
  const top = Number.isFinite(+(mat && mat.top_height)) ? +mat.top_height : null;
  const base = Number.isFinite(+(mat && mat.bottom_height)) ? +mat.bottom_height : 0;
  return { baseHeightM: r2(base), topHeightM: top == null ? null : r2(top) };
}

/** Footprints with a first outer ring, indexed by bbox for the centroid match. */
function sourceIndex(features) {
  const out = [];
  const list = Array.isArray(features) ? features : [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const g = f && f.geometry;
    if (!g) continue;
    const rings =
      g.type === "Polygon" ? [g.coordinates && g.coordinates[0]] : g.type === "MultiPolygon" ? (g.coordinates || []).map((p) => p && p[0]) : [];
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4) continue;
      out.push({ i, ring, bbox: bboxOf(ring), props: f.properties || {} });
    }
  }
  return out;
}

function matchSource(index, pt) {
  let best = null;
  let bestArea = Infinity;
  for (const s of index) {
    const b = s.bbox;
    if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
    if (!inRing(pt, s.ring)) continue;
    const a = (b[2] - b[0]) * (b[3] - b[1]);
    if (a < bestArea) {
      best = s;
      bestArea = a;
    }
  }
  return best;
}

const MEASURED = /laser|lidar|chm|nls/i;

function heightConfidence(source) {
  const s = String(source || "");
  if (MEASURED.test(s)) return 0.85;
  if (/^(osm|overture)$/i.test(s)) return 0.7;
  if (/floors|fema|ms-global|nearby/i.test(s)) return 0.5;
  return s ? 0.4 : null;
}

function fc(features) {
  return { type: "FeatureCollection", features };
}

function terrainGrid(samples, opts) {
  const pts = (Array.isArray(samples) ? samples : []).filter(
    (s) => s && Number.isFinite(+s.lon) && Number.isFinite(+s.lat) && Number.isFinite(+s.z)
  );
  if (pts.length < 4) return null;
  const key = (v) => Math.round(+v * 1e7);
  const lons = Array.from(new Set(pts.map((p) => key(p.lon)))).sort((a, b) => a - b);
  const lats = Array.from(new Set(pts.map((p) => key(p.lat)))).sort((a, b) => b - a);
  const grid = new Map();
  for (const p of pts) grid.set(key(p.lon) + "," + key(p.lat), +p.z);
  let minZ = Infinity;
  let maxZ = -Infinity;
  const rows = [];
  for (const la of lats) {
    const row = [];
    for (const lo of lons) {
      const z = grid.get(lo + "," + la);
      if (Number.isFinite(z)) {
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        row.push(r2(z));
      } else row.push(null);
    }
    rows.push(row);
  }
  const frame = opts.frame;
  const kind = opts.kind === "surface" ? "surface" : "bare-earth";
  const cell =
    lons.length > 1 && frame && frame.east > frame.west
      ? ((frame.widthM || 0) / (frame.east - frame.west)) * ((lons[lons.length - 1] - lons[0]) / 1e7) / (lons.length - 1)
      : null;
  return {
    representation: "grid",
    order: "rows north to south, columns west to east",
    cols: lons.length,
    rows: lats.length,
    cellSizeM: cell == null ? null : r2(cell),
    lons: lons.map((v) => v / 1e7),
    lats: lats.map((v) => v / 1e7),
    z: rows,
    kind,
    verticalDatum: kind === "surface" ? "EGM2008" : "NAVD88",
    attribution: opts.attribution || (kind === "surface" ? "Copernicus DEM GLO-30" : "USGS 3DEP"),
    minZ: r2(minZ),
    maxZ: r2(maxZ),
    reliefM: r2(maxZ - minZ),
  };
}

/** Nearest grid node elevation at lon/lat, or null outside the grid. */
function groundSampler(t) {
  const lon0 = t.lons[0];
  const lon1 = t.lons[t.lons.length - 1];
  const latN = t.lats[0];
  const latS = t.lats[t.lats.length - 1];
  return function at(lon, lat) {
    if (!(lon1 > lon0) || !(latN > latS)) return null;
    const c = Math.round(((lon - lon0) / (lon1 - lon0)) * (t.cols - 1));
    const r = Math.round(((latN - lat) / (latN - latS)) * (t.rows - 1));
    if (c < 0 || r < 0 || c >= t.cols || r >= t.rows) return null;
    const z = t.z[r][c];
    return Number.isFinite(z) ? z : null;
  };
}

const PROVENANCE = [
  { id: "osm", role: "buildings-parts-poles-notes", licence: "ODbL", attribution: "© OpenStreetMap contributors", commercialUseAllowed: true },
  { id: "ms-global", role: "building-footprints", licence: "ODbL", attribution: "Microsoft Global ML Building Footprints, ODbL", commercialUseAllowed: true },
  { id: "overture", role: "building-footprints-heights", licence: "ODbL", attribution: "Overture Maps Foundation (buildings theme, ODbL); includes © OpenStreetMap contributors, Microsoft, Esri Community Maps contributors, Google Open Buildings", commercialUseAllowed: true },
  { id: "usa-structures", role: "building-footprints-us", licence: "public-domain", attribution: "FEMA USA Structures", commercialUseAllowed: true },
  { id: "nls-laser", role: "building-heights-finland", licence: "CC BY 4.0", attribution: "National Land Survey of Finland", commercialUseAllowed: true },
  { id: "usgs-3dep", role: "terrain-lidar-us", licence: "public-domain", attribution: "USGS 3DEP", commercialUseAllowed: true },
  { id: "nlcd-tcc", role: "canopy-us", licence: "public-domain", attribution: "USFS / MRLC NLCD Tree Canopy Cover", commercialUseAllowed: true },
  { id: "meta-chm", role: "canopy-height", licence: "CC BY 4.0", attribution: "Meta and World Resources Institute (WRI) CHMv2. Source imagery for CHM © 2016 Vantor", commercialUseAllowed: true },
  { id: "esa-worldcover", role: "canopy-gap-fill", licence: "CC BY 4.0", attribution: "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium", commercialUseAllowed: true },
  { id: "copernicus-glo30", role: "terrain-fallback", licence: "Copernicus DEM licence", attribution: "Copernicus DEM GLO-30", commercialUseAllowed: true },
  { id: "esri-world-imagery", role: "aerial-and-detection", licence: "Esri proprietary", attribution: "Powered by Esri. Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community", commercialUseAllowed: false },
];

/**
 * @param {object} p
 * @param {object} p.openintent  built.openintent
 * @param {object} p.frame       internal frame (west/south/east/north, imgW/imgH, widthM/lengthM, mpu)
 * @param {Array}  p.features    conflated building footprints (GeoJSON features)
 * @param {Array}  p.demSamples  [{lon,lat,z}] or null
 * @param {Array}  p.notes       clipboard map notes [{x,y,text,color,icon}]
 */
function buildSiteV1(p) {
  const frame = p.frame;
  const fp = (p.openintent && p.openintent.floorplans && p.openintent.floorplans[0]) || {};
  const areas = Array.isArray(fp.attenuation_areas) ? fp.attenuation_areas : [];
  const index = sourceIndex(p.features);
  const out = { buildings: [], trees: [], poles: [], water: [], parking: [], walls: [], vehicles: [], other: [] };
  const trunks = [];
  let buildingParts = 0;
  const heightSources = {};

  for (let i = 0; i < areas.length; i++) {
    const a = areas[i];
    const mat = a.area_material || {};
    const ring = ringFromArea(a, frame);
    if (!ring) continue;
    const kind = classify(mat.name);
    const h = heightsOf(mat);
    const material = materialOf(mat);
    const c = centroid(ring);
    if (kind === "building") {
      const src = matchSource(index, c);
      const sp = (src && src.props) || {};
      const hs = sp.heightSource || null;
      if (hs) heightSources[hs] = (heightSources[hs] || 0) + 1;
      out.buildings.push({
        type: "Feature",
        id: "b" + i,
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          kind: "building",
          buildingId: src ? "s" + src.i : "b" + i,
          name: sp.name || sp.partName || null,
          baseHeightM: h.baseHeightM,
          topHeightM: h.topHeightM,
          heightM: h.topHeightM == null ? null : r2(h.topHeightM - h.baseHeightM),
          heightSource: hs,
          heightConfidence: heightConfidence(hs),
          geomSource: sp.geomSource || null,
          buildingPart: !!sp.buildingPart,
          podium: /podium/i.test(material.name) || !!sp.podium,
          levelBaseM: Number.isFinite(+sp.levelBaseM) ? +sp.levelBaseM : null,
          floatSpan: !!sp.floatSpan,
          roofShape: sp.roofShape || null,
          footprintAreaM2: Math.round(areaM2(ring, frame)),
          materialClass: /podium/i.test(material.name) ? "podium" : "building",
          material,
        },
      });
    } else if (kind === "trunk") {
      trunks.push({ ring, c, h, material });
    } else if (kind === "crown" || kind === "stand") {
      const am = areaM2(ring, frame);
      out.trees.push({
        type: "Feature",
        id: "t" + i,
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          kind: kind === "stand" ? "stand" : "tree",
          stem: { type: "Point", coordinates: c },
          crownBaseM: h.baseHeightM,
          crownTopM: h.topHeightM,
          crownRadiusM: r2(Math.sqrt(am / Math.PI)),
          crownAreaM2: Math.round(am),
          trunkHeightM: null,
          trunkDiameterM: null,
          speciesClass: /palm/i.test(material.name) ? "palm" : "unknown",
          leafState: "unknown",
          foliageClass: /heavy/i.test(material.name) ? "heavy" : /understory/i.test(material.name) ? "understory" : "light",
          attenuationDbPerMeter: material.attenuationDbPerMeter,
          materialCrown: material,
          materialTrunk: null,
        },
      });
    } else if (kind === "pole") {
      const am = areaM2(ring, frame);
      out.poles.push({
        type: "Feature",
        id: "p" + i,
        geometry: { type: "Point", coordinates: c },
        properties: {
          kind: "pole",
          poleType: "lighting",
          heightM: h.topHeightM == null ? null : r2(h.topHeightM - h.baseHeightM),
          baseHeightM: h.baseHeightM,
          topHeightM: h.topHeightM,
          diameterM: r2(Math.max(0.1, Math.sqrt((4 * am) / Math.PI))),
          material,
        },
      });
    } else {
      const coll = kind === "wall" ? "walls" : kind === "vehicle" ? "vehicles" : kind === "other" ? "other" : kind;
      const props = { kind: kind === "wall" ? wallKind(mat.name) : kind === "vehicle" ? vehicleKind(mat.name) : kind === "other" ? otherKind(mat.name) : kind, baseHeightM: h.baseHeightM, topHeightM: h.topHeightM, material };
      out[coll].push({ type: "Feature", id: coll[0] + i, geometry: { type: "Polygon", coordinates: [ring] }, properties: props });
    }
  }

  // More than one area on one footprint: every area above the lowest is a part.
  {
    const groups = new Map();
    for (const b of out.buildings) {
      const g = b.properties.buildingId;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((x, y) => x.properties.baseHeightM - y.properties.baseHeightM);
      for (let k = 0; k < list.length; k++) {
        list[k].properties.tier = k === 0 ? "mass" : "part";
        if (k > 0) {
          list[k].properties.buildingPart = true;
          buildingParts++;
        }
      }
    }
  }

  // A trunk prism sits inside its crown. Fold it onto that tree.
  for (const t of trunks) {
    let host = null;
    for (const tree of out.trees) {
      if (tree.properties.kind !== "tree" || tree.properties.trunkHeightM != null) continue;
      if (inRing(t.c, tree.geometry.coordinates[0])) {
        host = tree;
        break;
      }
    }
    const diam = r2(Math.max(0.1, Math.sqrt((4 * areaM2(t.ring, frame)) / Math.PI)));
    if (host) {
      host.properties.stem = { type: "Point", coordinates: t.c };
      host.properties.trunkHeightM = t.h.topHeightM == null ? null : r2(t.h.topHeightM - t.h.baseHeightM);
      host.properties.trunkDiameterM = diam;
      host.properties.materialTrunk = t.material;
    } else {
      out.other.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [t.ring] },
        properties: { kind: "trunk", baseHeightM: t.h.baseHeightM, topHeightM: t.h.topHeightM, diameterM: diam, material: t.material },
      });
    }
  }

  const terrain = p.demSamples ? terrainGrid(p.demSamples, { frame, kind: p.demKind, attribution: p.demAttribution }) : null;
  if (terrain) {
    const at = groundSampler(terrain);
    const stamp = (f, pt) => {
      const z = at(pt[0], pt[1]);
      if (z != null) f.properties.groundOffsetM = r2(z - terrain.minZ);
    };
    for (const coll of ["buildings", "trees", "parking", "walls", "vehicles", "other"]) {
      for (const f of out[coll]) stamp(f, centroid(f.geometry.coordinates[0]));
    }
    for (const f of out.poles) stamp(f, f.geometry.coordinates);
  }

  const gps = [
    { role: "southwest", lon: frame.west, lat: frame.south, x: -(frame.widthM || 0), y: -(frame.lengthM || 0) },
    { role: "northeast", lon: frame.east, lat: frame.north, x: 0, y: 0 },
  ].map((g) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [r6(g.lon), r6(g.lat)] },
    properties: { role: g.role, localXM: r2(g.x), localYM: r2(g.y) },
  }));

  const notes = (Array.isArray(p.notes) ? p.notes : [])
    .map((n) => {
      if (!n || !Number.isFinite(+n.x) || !Number.isFinite(+n.y)) return null;
      const ll = clipboardToLl(+n.x, +n.y, frame);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [r6(ll[0]), r6(ll[1])] },
        properties: { text: String(n.text || ""), color: n.color || null, icon: n.icon || null },
      };
    })
    .filter(Boolean);

  const stats = {
    buildings: out.buildings.length,
    buildingParts,
    trees: out.trees.filter((t) => t.properties.kind === "tree").length,
    stands: out.trees.filter((t) => t.properties.kind === "stand").length,
    treesWithTrunk: out.trees.filter((t) => t.properties.trunkHeightM != null).length,
    poles: out.poles.length,
    water: out.water.length,
    parking: out.parking.length,
    walls: out.walls.length,
    vehicles: out.vehicles.length,
    other: out.other.length,
    mapNotes: notes.length,
    terrainCells: terrain ? terrain.cols * terrain.rows : 0,
    areaM2: Math.round((frame.widthM || 0) * (frame.lengthM || 0)),
    heightSources,
    engine: p.stats || null,
  };

  return {
    apiVersion: API_VERSION,
    engineVersion,
    name: p.name || null,
    crs: "EPSG:4326",
    heightDatum:
      terrain
        ? "baseHeightM/topHeightM are meters above the lowest terrain sample in the frame (terrain.minZ), so objects already sit on the slope. groundOffsetM is the terrain under the feature above that same datum; topHeightM - groundOffsetM is the height above local ground."
        : "Heights are meters above local ground (terrain off or unavailable).",
    frame: {
      west: r6(frame.west),
      south: r6(frame.south),
      east: r6(frame.east),
      north: r6(frame.north),
      widthM: r2(frame.widthM || 0),
      lengthM: r2(frame.lengthM || 0),
    },
    buildings: fc(out.buildings),
    trees: fc(out.trees),
    poles: fc(out.poles),
    water: fc(out.water),
    parking: fc(out.parking),
    walls: fc(out.walls),
    vehicles: fc(out.vehicles),
    other: fc(out.other),
    terrain,
    gpsAnchors: fc(gps),
    mapNotes: fc(notes),
    aerial: {
      provider: "esri-world-imagery",
      bbox: { west: r6(frame.west), south: r6(frame.south), east: r6(frame.east), north: r6(frame.north) },
      crs: "EPSG:4326",
      widthPx: frame.imgW || null,
      heightPx: frame.imgH || null,
      url: null,
      licence: {
        commercialUseAllowed: false,
        note: "Esri World Imagery needs a commercial licence inside a paid product. The prototype does not serve the image.",
      },
      attribution: "Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    },
    provenance: { sources: PROVENANCE },
    stats,
    warnings: Array.isArray(p.warnings) ? p.warnings.slice() : [],
  };
}

/**
 * Pick collections and one page of features from a stored site.
 * Paging applies to each FeatureCollection independently.
 */
function selectSite(site, q) {
  const want = String((q && q.collections) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = want.filter((c) => COLLECTIONS.indexOf(c) < 0);
  if (unknown.length) {
    const err = new Error("Unknown collection: " + unknown.join(", ") + ".");
    err.code = "invalid_collections";
    throw err;
  }
  const pick = want.length ? want : COLLECTIONS;
  const pageSize = Math.max(1, Math.min(2000, parseInt((q && q.pageSize) || "", 10) || 500));
  const page = Math.max(1, parseInt((q && q.page) || "", 10) || 1);
  const out = {};
  for (const k of Object.keys(site)) {
    if (COLLECTIONS.indexOf(k) < 0) out[k] = site[k];
  }
  let maxPages = 1;
  const totals = {};
  for (const c of pick) {
    const v = site[c];
    if (FEATURE_COLLECTIONS.indexOf(c) >= 0 && v && Array.isArray(v.features)) {
      const total = v.features.length;
      totals[c] = total;
      maxPages = Math.max(maxPages, Math.ceil(total / pageSize) || 1);
      out[c] = fc(v.features.slice((page - 1) * pageSize, page * pageSize));
    } else {
      out[c] = v == null ? null : v;
    }
  }
  out.paging = {
    page,
    pageSize,
    totalPages: maxPages,
    totals,
    next: page < maxPages ? page + 1 : null,
  };
  return out;
}

module.exports = { buildSiteV1, selectSite, terrainGrid, classify, API_VERSION, COLLECTIONS };
