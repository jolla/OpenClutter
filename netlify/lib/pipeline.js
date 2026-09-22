"use strict";

const {
  llToPx,
  pxToClipboard,
  applyAffine,
  publicFrame,
  CLIPBOARD_ORIGIN,
} = require("./geo-frame");
const {
  uuid,
  ZONE_TYPES,
  emptyClipboard,
  clipZone,
} = require("./hamina-clipboard");
const { materialForBuilding, catalogMaterials } = require("./materials");
const { treePairsFromPoints } = require("./vegetation");
const { zipStore } = require("./zip-store");
const { overlaySvg, frameLockJson } = require("./overlay");

const MIN_AREA_M2 = 25;
const MAX_AREA_M2 = 40000;
const MAX_BUILDINGS = 2000;
/** OpenIntent 2.0.1 coordinate_xyz.x/y minimum is 0; Hamina historically dropped *all* areas if one ring was invalid. */
const MIN_OI_SPAN_PX = 4;
/** Outdoor trunks are ~1 m across; at ~1 m/px that is sub-pixel and Hamina may reject the ring. */
const MIN_OI_SPAN_M = 3;
/**
 * Hamina documents 20,000 walls/map and no attenuation_areas cap. Keep well under
 * that wall budget so one outdoor site cannot blow the importer/GPU. Buildings
 * first, then complete canopy+trunk pairs.
 */
const MAX_ATTENUATION_AREAS = 4000;
const OPENINTENT_VERSION = "2.0.1";
const STOCK_MATERIAL_NAMES = ZONE_TYPES.map((t) => t.name);

const ZIP_README =
  "Import this zip in Hamina (Projects → Import → OpenIntent).\n" +
  "The OpenIntent JSON is the source of truth: map image + all attenuating objects.\n" +
  "Hamina 2026-09-01+ imports attenuation_areas. area_materials are the six stock names only.\n" +
  "Exact measured metres are zone types inside hamina-clipboard.json (paste that file for those heights).\n" +
  "Schema: OpenIntent 2.0.1, pixels Y-up from SW, closed rings, area_materials listed.\n" +
  "(Optional) Unzip and open alignment-overlay.svg next to images/ to check rooftops.\n" +
  "hamina-clipboard.json is a silent fallback for older Hamina builds only — not the happy path.\n";

const ZIP_TROUBLESHOOT =
  "\nTroubleshooting if Hamina shows the map but no attenuating objects:\n" +
  "If VERIFY.txt attenuation_areas > 0, generation succeeded. Hamina then either dropped the import\n" +
  "or failed to render (WebGL). Do this in order:\n" +
  "  1. Unzip and confirm VERIFY.txt attenuation_areas (same as openIntent_*.json length).\n" +
  "     buildingsKept 111 + 2×treesKept 367 = 845 polygons — not buildingsKept alone.\n" +
  "  2. Open alignment-overlay.svg next to images/. Rooftops (red) and trees (green) should sit on the JPEG.\n" +
  "  3. In Hamina, check the Attenuating Objects sidebar count.\n" +
  "     0 = OpenIntent import dropped the areas. >0 = they imported but did not draw.\n" +
  "  4. If stats>0 but Hamina is empty (sidebar 0 or objects invisible): paste hamina-clipboard.json into Hamina.\n" +
  "  5. Console WebGL texSubImage2D / Rive warnings can hide objects after a successful import.\n" +
  "     Try Hamina’s 2D map view, and turn hardware acceleration off, then zoom the full extent.\n" +
  "Pixel vs meter aspect can differ after Esri N/S pad (non-square mpu). Overlay still locks image-space;\n" +
  "that does not hide objects by itself.\n" +
  "Hamina publishes a 20,000 walls/map OpenIntent cap and no attenuation_areas cap; this zip emits\n" +
  "at most " +
  MAX_ATTENUATION_AREAS +
  " areas (buildings first). Invalid/open/NaN/self-intersecting rings are dropped per-polygon.\n" +
  "OpenIntent materials omit bottom_height (Hamina rejected it as Invalid OpenIntent format) and use\n" +
  "stock names + itu_material_type ITU_R_UNKNOWN (oiconvert / Hamina-tested importer).\n";

/**
 * Skip Microsoft campus-merge blobs (one giant wrong polygon). Do NOT use a
 * fraction of the drawn map — a tight commercial bbox makes a 2 ha big-box
 * roof look like “half the site” (Oak Creek white roof).
 */
const MEGA_CAMPUS_M2 = 150000;

function megaCampusLimitM2() {
  return MEGA_CAMPUS_M2;
}

function isMegaCampus(areaM2) {
  return areaM2 > MEGA_CAMPUS_M2;
}

function coverageStats(stats) {
  const s = stats || {};
  return {
    buildingsKept: s.buildings || 0,
    treesKept: s.trees || 0,
    treesSource: s.treesSource || "none",
    fetched: s.fetched != null ? s.fetched : s.buildings || 0,
    droppedMega: s.droppedMega || 0,
    droppedTiny: s.droppedTiny || 0,
    droppedClip: s.droppedClip || 0,
    droppedCap: s.droppedCap || 0,
    droppedInvalid: s.droppedInvalid || 0,
    droppedAreasCap: s.droppedAreasCap || 0,
    attenuationAreasEmitted: s.attenuationAreasEmitted != null ? s.attenuationAreasEmitted : s.areas || 0,
    globalFootprints: s.globalFootprints || 0,
    arcgisFootprints: s.arcgisFootprints || 0,
    usaFootprints: s.usaFootprints || 0,
    imageryRoofs: s.imageryRoofs || 0,
    medianTrees: s.medianTrees || 0,
    measuredBuildings: s.measuredBuildings || 0,
    overtureFootprints: s.overtureFootprints || 0,
    overtureAdded: s.overtureAdded || 0,
    msHeights: s.msHeights || 0,
    overtureHeights: s.overtureHeights || 0,
    femaHeights: s.femaHeights || 0,
    floorHeights: s.floorHeights || 0,
    chmTrees: s.chmTrees || 0,
    terrainRaised: s.terrainRaised || 0,
    terrainSloped: s.terrainSloped || 0,
    areaMaterials: s.areaMaterials != null ? s.areaMaterials : STOCK_MATERIAL_NAMES.length,
    compatibilityMode: s.compatibilityMode || "stock-openintent",
    exactBuildingHeights: s.exactBuildingHeights || 0,
    exactFoliageHeights: s.exactFoliageHeights || 0,
    openintentVersion: s.openintentVersion || OPENINTENT_VERSION,
    coordinateUnit: s.coordinateUnit || "pixels",
    coordinateOrigin: s.coordinateOrigin || "Y-up from SW",
  };
}

function coverageSummary(stats) {
  const c = coverageStats(stats);
  const drops = [];
  if (c.droppedMega) drops.push("mega " + c.droppedMega);
  if (c.droppedTiny) drops.push("tiny " + c.droppedTiny);
  if (c.droppedClip) drops.push("clip " + c.droppedClip);
  if (c.droppedCap) drops.push("cap " + c.droppedCap);
  if (c.droppedInvalid) drops.push("invalid " + c.droppedInvalid);
  if (c.droppedAreasCap) drops.push("areas-cap " + c.droppedAreasCap);
  const dropTxt = drops.length ? `; dropped ${drops.join(", ")}` : "";
  return (
    `Buildings ${c.buildingsKept} kept (${c.fetched} fetched${dropTxt}). ` +
    `Trees ${c.treesKept} kept (${c.treesSource}). ` +
    `attenuation_areas ${c.attenuationAreasEmitted}.`
  );
}

const TERRAIN_README =
  "\nOptional Planner Plus terrain (not part of the OpenIntent import):\n" +
  "USGS 3DEP bare-earth elevations are simplified to a few pads and facets in\n" +
  "terrain-clipboard.json. OpenIntent does not support raised or sloped floors.\n" +
  "1. Unzip terrain-clipboard.json. Do not import that file as OpenIntent.\n" +
  "2. In Hamina Planner Plus, open the map and paste the file contents.\n" +
  "3. raisedFloorZones are flat pads (xy meters, NE origin, same frame as hamina-clipboard.json).\n" +
  "   height is meters above the lowest DEM sample. slabOnly is true. attenuationDbPerMeter is 0\n" +
  "   so the ground slab is not a second clutter wall.\n" +
  "4. slopedFloors are triangles with xyz vertices (z = meters above that same low point).\n" +
  "If terrain-clipboard.json is absent, the DEM request did not return a usable grid.\n" +
  "The OpenIntent zip import is unchanged either way.\n";

function zipReadme(stats) {
  const c = coverageStats(stats);
  return (
    ZIP_README +
    "\nCoverage — compare buildingsKept / treesKept / attenuationAreasEmitted to Hamina’s sidebar.\n" +
    coverageSummary(stats) +
    "\n" +
    TERRAIN_README +
    "\n" +
    `buildingsKept: ${c.buildingsKept}\n` +
    `treesKept: ${c.treesKept}\n` +
    `treesSource: ${c.treesSource}\n` +
    `attenuationAreasEmitted: ${c.attenuationAreasEmitted}\n` +
    `openintent_version: ${c.openintentVersion}\n` +
    `fetched: ${c.fetched}\n` +
    `droppedMega: ${c.droppedMega}\n` +
    `droppedTiny: ${c.droppedTiny}\n` +
    `droppedClip: ${c.droppedClip}\n` +
    `droppedCap: ${c.droppedCap}\n` +
    `droppedInvalid: ${c.droppedInvalid}\n` +
    `droppedAreasCap: ${c.droppedAreasCap}\n` +
    ZIP_TROUBLESHOOT
  );
}

function verifyTxt(stats) {
  const c = coverageStats(stats);
  return (
    `attenuation_areas: ${c.attenuationAreasEmitted}\n` +
    `openintent_version: ${c.openintentVersion}\n` +
    `coordinate_unit: ${c.coordinateUnit}\n` +
    `coordinate_origin: ${c.coordinateOrigin}\n` +
    `area_materials: ${c.areaMaterials != null ? c.areaMaterials : STOCK_MATERIAL_NAMES.length}\n` +
    `buildingsKept: ${c.buildingsKept}\n` +
    `treesKept: ${c.treesKept}\n` +
    `attenuationAreasEmitted: ${c.attenuationAreasEmitted}\n`
  );
}

const ALIGNMENT = [
  "Exact alignment (repeatable, any site):",
  "1. Import this zip in Hamina (Projects → Import → OpenIntent).",
  "   The zip’s meter dimensions ARE the JPEG’s geographic extent (widthM × lengthM).",
  "   OpenIntent floorplans[].attenuation_areas[] carry buildings + tree pairs",
  "   (stock Hamina names: Building - One/Five Floor, Hotel podium, Foliage - Heavy/Light, Tree Trunk).",
  "   Extra files (alignment-overlay.svg, frame-lock.json, hamina-clipboard.json) are ignored on import.",
  "2. Hamina 2026-09-01+ imports attenuating objects from OpenIntent. No clipboard paste.",
  "3. hamina-clipboard.json inside the zip is a silent fallback for older Hamina builds only.",
  "Clipboard meters use that same widthM × lengthM. Origin: " + CLIPBOARD_ORIGIN,
  "Do NOT use a Google Earth screenshot as the map — Hamina auto-scale will not",
  "match lon/lat footprints. Dual-scale nudges are a legacy escape hatch only.",
  "Do NOT add OSM building or tree rings (Hamina dropped v8 attenuation_areas).",
].join("\n");

function ringAreaM2(ring, mpd) {
  if (!ring || ring.length < 3) return 0;
  const pts = ring.slice();
  const a0 = pts[0];
  const last = pts[pts.length - 1];
  if (a0[0] !== last[0] || a0[1] !== last[1]) pts.push(a0);
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const x0 = pts[i][0] * mpd.lon;
    const y0 = pts[i][1] * mpd.lat;
    const x1 = pts[i + 1][0] * mpd.lon;
    const y1 = pts[i + 1][1] * mpd.lat;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function perpDist2(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-24) return dist2(p, a);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return dist2(p, [a[0] + t * vx, a[1] + t * vy]);
}

function simplifyDP(pts, eps2) {
  if (pts.length <= 2) return pts;
  let maxI = 0;
  let maxD = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist2(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps2) {
    const left = simplifyDP(pts.slice(0, maxI + 1), eps2);
    const right = simplifyDP(pts.slice(maxI), eps2);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function simplifyRing(ring, maxPts = 32) {
  if (!ring || ring.length < 3) return ring;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  if (closed.length <= maxPts) {
    closed.push(closed[0]);
    return closed;
  }
  const eps = 2.5e-6;
  let out = simplifyDP(closed, eps * eps);
  if (out.length > maxPts) {
    const step = Math.max(1, Math.ceil(out.length / maxPts));
    const thin = [];
    for (let i = 0; i < out.length; i += step) thin.push(out[i]);
    out = thin;
  }
  if (out.length < 3) return ring;
  out.push(out[0]);
  return out;
}

function xyz(x, y) {
  return {
    coordinate_xyz: {
      x: +Math.max(0, x).toFixed(3),
      y: +Math.max(0, y).toFixed(3),
      unit: "pixels",
    },
  };
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function uniqueOpenRing(ring, eps = 0.0005) {
  const src =
    ring && ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : (ring || []).slice();
  const out = [];
  for (const p of src) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push([p[0], p[1]]);
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

function ringAreaPx(ring) {
  const pts = uniqueOpenRing(ring);
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function ringBBox(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Keep a min-span square inside the image (shift inward at edges). */
function fitSquareInImage(cx, cy, span, imgW, imgH) {
  const hw = span / 2;
  let x0 = cx - hw;
  let y0 = cy - hw;
  let x1 = cx + hw;
  let y1 = cy + hw;
  if (x0 < 0) {
    x1 -= x0;
    x0 = 0;
  }
  if (y0 < 0) {
    y1 -= y0;
    y0 = 0;
  }
  if (x1 > imgW) {
    x0 -= x1 - imgW;
    x1 = imgW;
  }
  if (y1 > imgH) {
    y0 -= y1 - imgH;
    y1 = imgH;
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(imgW, x1);
  y1 = Math.min(imgH, y1);
  if (x1 - x0 < 1 || y1 - y0 < 1) return [];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function minOiSpanPx(mpuX) {
  return Math.max(MIN_OI_SPAN_PX, MIN_OI_SPAN_M / Math.max(mpuX || 1, 0.01));
}

/**
 * Sub-pixel tree trunks used to emit near-degenerate hexagons. After toFixed(3)
 * those can be duplicate/NaN-adjacent and Hamina then dropped every area.
 * Expand only collapsed blobs — not thin real building slivers.
 */
function ensureMinSpan(pts, imgW, imgH, minSpan) {
  if (!pts || pts.length < 3) return pts;
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  const b = ringBBox(pts);
  if (b.w >= span && b.h >= span) return pts;
  if (b.w >= span || b.h >= span) return pts;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const square = fitSquareInImage(cx, cy, Math.max(span, b.w, b.h), imgW, imgH);
  return square.length ? square : pts;
}

function ccw(a, b, c) {
  return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
}

function segsIntersectProper(a, b, c, d) {
  if (a[0] === c[0] && a[1] === c[1]) return false;
  if (a[0] === d[0] && a[1] === d[1]) return false;
  if (b[0] === c[0] && b[1] === c[1]) return false;
  if (b[0] === d[0] && b[1] === d[1]) return false;
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function oiSelfIntersects(coords) {
  const n = coords.length - 1;
  if (n < 4) return false;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = coords[i].coordinate_xyz;
    pts.push([p.x, p.y]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segsIntersectProper(a, b, c, d)) return true;
    }
  }
  return false;
}

function signedAreaOi(coords) {
  let a = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const p = coords[i].coordinate_xyz;
    const q = coords[i + 1].coordinate_xyz;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * OpenIntent 2.0.1 / Hamina import: closed ring, ≥3 unique vertices, unit pixels,
 * x,y ≥ 0 and inside the JPEG, finite, no consecutive duplicates, non-zero area.
 * One bad ring historically wiped the entire attenuation_areas import.
 */
function validateOiCoords(coords, imgW, imgH) {
  if (!coords || coords.length < 4) return { ok: false, reason: "too-few" };
  for (const c of coords) {
    const p = c && c.coordinate_xyz;
    if (!p) return { ok: false, reason: "missing-xyz" };
    if (p.unit !== "pixels") return { ok: false, reason: "unit" };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: "nan" };
    if (p.x < 0 || p.y < 0 || p.x > imgW || p.y > imgH) return { ok: false, reason: "bounds" };
  }
  const first = coords[0].coordinate_xyz;
  const last = coords[coords.length - 1].coordinate_xyz;
  if (first.x !== last.x || first.y !== last.y) return { ok: false, reason: "open" };
  const seen = new Set();
  for (let i = 0; i < coords.length - 1; i++) {
    const p = coords[i].coordinate_xyz;
    const q = coords[i + 1].coordinate_xyz;
    if (p.x === q.x && p.y === q.y) return { ok: false, reason: "duplicate" };
    seen.add(p.x + "," + p.y);
  }
  if (seen.size < 3) return { ok: false, reason: "degenerate" };
  if (Math.abs(signedAreaOi(coords)) < 1e-6) return { ok: false, reason: "zero-area" };
  if (oiSelfIntersects(coords)) return { ok: false, reason: "self-intersect" };
  return { ok: true };
}

function validateOiArea(area, imgW, imgH) {
  if (!area || !area.area || !area.area_material) return { ok: false, reason: "shape" };
  const mat = area.area_material;
  if (typeof mat.name !== "string" || mat.name.length < 3 || mat.name.length > 48) {
    return { ok: false, reason: "material" };
  }
  if (Object.prototype.hasOwnProperty.call(mat, "bottom_height")) return { ok: false, reason: "bottom_height" };
  if (mat.itu_material_type !== "ITU_R_UNKNOWN") return { ok: false, reason: "itu" };
  if (!(mat.top_height > 0)) return { ok: false, reason: "height" };
  const db = mat.rf_properties && mat.rf_properties.attenuation_per_m;
  if (!(db > 0)) return { ok: false, reason: "attenuation" };
  if (mat.display_color && !/^#[0-9A-Fa-f]{6}$/.test(mat.display_color)) {
    return { ok: false, reason: "color" };
  }
  return validateOiCoords(area.area.coordinates, imgW, imgH);
}

/** Round + drop consecutive duplicates *after* toFixed so Hamina never sees collapsed verts. */
function finalizeOiCoords(rawPts, imgW, imgH) {
  const pts = [];
  for (const p of rawPts || []) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const c = xyz(Math.min(imgW, Math.max(0, p[0])), Math.min(imgH, Math.max(0, p[1])));
    const xyzc = c.coordinate_xyz;
    if (!Number.isFinite(xyzc.x) || !Number.isFinite(xyzc.y)) continue;
    const last = pts[pts.length - 1];
    if (last && last.coordinate_xyz.x === xyzc.x && last.coordinate_xyz.y === xyzc.y) continue;
    pts.push(c);
  }
  if (pts.length < 3) return null;
  const a = pts[0].coordinate_xyz;
  const b = pts[pts.length - 1].coordinate_xyz;
  if (a.x !== b.x || a.y !== b.y) pts.push(pts[0]);
  if (pts.length < 4) return null;
  return pts;
}

/**
 * Clip a ring to the image rectangle. Vertex clamp (old path) collapsed
 * off-map edges onto the border and produced invalid rings — Hamina then
 * dropped every attenuation_area.
 */
function clipRingToRect(ring, w, h) {
  const edges = [
    [(p) => p[0] >= 0, (a, b) => lerp(a, b, (0 - a[0]) / (b[0] - a[0] || 1e-12))],
    [(p) => p[0] <= w, (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0] || 1e-12))],
    [(p) => p[1] >= 0, (a, b) => lerp(a, b, (0 - a[1]) / (b[1] - a[1] || 1e-12))],
    [(p) => p[1] <= h, (a, b) => lerp(a, b, (h - a[1]) / (b[1] - a[1] || 1e-12))],
  ];
  let pts = uniqueOpenRing(ring);
  if (pts.length < 3) return [];
  for (const [inside, intersect] of edges) {
    const src = pts;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i + src.length - 1) % src.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    pts = uniqueOpenRing(out);
    if (pts.length < 3) return [];
  }
  return pts;
}

function ringToOi(pts, imgW, imgH, mpuX) {
  if (!pts || pts.length < 3) return null;
  let clipped = clipRingToRect(pts, imgW, imgH);
  if (clipped.length < 3) return null;
  clipped = ensureMinSpan(clipped, imgW, imgH, minOiSpanPx(mpuX));
  if (!clipped || clipped.length < 3) return null;
  if (ringAreaPx(clipped) < 1e-6) return null;
  const out = finalizeOiCoords(clipped, imgW, imgH);
  if (!out) return null;
  const check = validateOiCoords(out, imgW, imgH);
  return check.ok ? out : null;
}

function makeOiArea(coords, material) {
  if (!coords || !material) return null;
  return { area: { coordinates: coords }, area_material: material };
}

function emitIfValid(area, imgW, imgH) {
  if (!area) return null;
  const check = validateOiArea(area, imgW, imgH);
  if (!check.ok) return null;
  // JSON.stringify turns NaN/Infinity into null — re-check the on-disk shape.
  try {
    const parsed = JSON.parse(JSON.stringify(area));
    if (!validateOiArea(parsed, imgW, imgH).ok) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Buildings first, then complete canopy+trunk pairs so a cap never splits a tree. */
function capAttenuationAreas(areas, buildingCount, max) {
  const limit = max == null ? MAX_ATTENUATION_AREAS : max;
  if (!areas || areas.length <= limit) return { areas: areas || [], dropped: 0 };
  const b = Math.min(buildingCount, limit);
  let rest = limit - b;
  rest -= rest % 2;
  const kept = areas.slice(0, b + rest);
  return { areas: kept, dropped: areas.length - kept.length };
}

function siteName(raw) {
  const name = String(raw || "Site")
    .replace(/[^\w \-]/g, "")
    .trim()
    .slice(0, 60) || "Site";
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "Site";
  return { name, slug };
}

function lonLatToClip(lon, lat, frame, affine) {
  if (affine) return applyAffine(lon, lat, affine);
  return pxToClipboard(...llToPx(lon, lat, frame), frame);
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringInside(inner, outer) {
  if (!inner || inner.length < 3 || !outer || outer.length < 3) return false;
  let hits = 0;
  const n = Math.min(inner.length - 1, 5);
  for (let i = 0; i < n; i++) {
    if (pointInRing(inner[i], outer)) hits++;
  }
  return hits >= Math.ceil(n * 0.6);
}

/**
 * Every exterior ring of a Polygon or MultiPolygon. Extra rings that are not
 * holes (Oak Creek: L-wing + white roof as sibling exteriors) are kept.
 */
function featureExteriorRings(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  const groups = [];
  if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) groups.push(poly || []);
  } else if (geometry.type === "Polygon") {
    groups.push(geometry.coordinates);
  } else {
    return [];
  }
  const out = [];
  for (const rings of groups) {
    if (!rings || !rings.length) continue;
    const exterior = rings[0];
    if (exterior && exterior.length >= 4) out.push(exterior);
    for (let i = 1; i < rings.length; i++) {
      const r = rings[i];
      if (!r || r.length < 4) continue;
      if (ringInside(r, exterior)) continue;
      out.push(r);
    }
  }
  return out;
}

function emitBuilding(ring, heightM, frame, affine, buckets) {
  const amRaw = ringAreaM2(ring, frame.mpd);
  const maxPts = amRaw > 8000 ? 56 : amRaw > 1500 ? 40 : 32;
  const simple = simplifyRing(ring, maxPts);
  if (!simple || simple.length < 4) return "skip";
  const am = ringAreaM2(simple, frame.mpd);
  if (isMegaCampus(am)) return "mega";
  if (am < MIN_AREA_M2) return "tiny";
  const pts = [];
  const clipRing = [];
  for (const [lon, lat] of simple) {
    const [x, y] = llToPx(lon, lat, frame);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pts.push([x, y]);
      clipRing.push(lonLatToClip(lon, lat, frame, affine));
    }
  }
  if (pts.length < 3) return "skip";
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX < 0 || maxY < 0 || minX > frame.imgW || minY > frame.imgH) return "clip";
  const oiCoords = ringToOi(pts, frame.imgW, frame.imgH, frame.mpuX);
  if (!oiCoords) return "clip";
  const picked = materialForBuilding(heightM, am);
  const area = emitIfValid(makeOiArea(oiCoords, picked.material), frame.imgW, frame.imgH);
  if (!area) return "invalid";
  buckets.oiAreas.push(area);
  if (picked.clipType) buckets.clipTypes.push(picked.clipType);
  if (picked.material) buckets.materials.push(picked.material);
  if (picked.measured) buckets.measured++;
  const z = clipZone(picked.typeId, clipRing);
  if (z) buckets.clipZones.push(z);
  buckets.aabbs.push({ minX, maxX, minY, maxY });
  buckets.overlayRings.push(pts);
  buckets.overlayHeights.push(picked.exactHeight || picked.material.top_height);
  return "keep";
}

function ringCentroidLL(ring) {
  if (!ring || ring.length < 3) return null;
  const end =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < end; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return end ? [sx / end, sy / end] : null;
}

function readHeight(feature) {
  const props = (feature && feature.properties) || {};
  const h = Number(props.height || props.Height || props.HEIGHT || 0);
  return h > 2 && h < 80 ? h : 0;
}

/**
 * Buildings with no FEMA/MS height take the nearest measured height within 120 m.
 * Farther than that, the stock area bins remain the fallback.
 */
function borrowNearbyHeights(features, frame) {
  if (!frame || !frame.mpd) return 0;
  const measured = [];
  for (const f of features || []) {
    const h = readHeight(f);
    if (!h) continue;
    const rings = featureExteriorRings(f.geometry);
    const c = rings[0] && ringCentroidLL(rings[0]);
    if (c) measured.push({ c, h });
  }
  if (!measured.length) return 0;
  const maxD = 120 * 120;
  let n = 0;
  for (const f of features || []) {
    if (readHeight(f)) continue;
    const rings = featureExteriorRings(f.geometry);
    const c = rings[0] && ringCentroidLL(rings[0]);
    if (!c) continue;
    let best = 0;
    let bestD = maxD;
    for (let i = 0; i < measured.length; i++) {
      const dx = (c[0] - measured[i].c[0]) * frame.mpd.lon;
      const dy = (c[1] - measured[i].c[1]) * frame.mpd.lat;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) {
        bestD = d2;
        best = measured[i].h;
      }
    }
    if (!best) continue;
    if (!f.properties) f.properties = {};
    f.properties.height = best;
    if (!f.properties.heightSource) f.properties.heightSource = "nearby";
    n++;
  }
  return n;
}

function footprintsToClutter(features, frame, affine) {
  borrowNearbyHeights(features, frame);
  const oiAreas = [];
  const clipZones = [];
  const aabbs = [];
  const overlayRings = [];
  const list = features || [];
  const stats = {
    fetched: list.length,
    buildings: 0,
    droppedMega: 0,
    droppedTiny: 0,
    droppedClip: 0,
    droppedCap: 0,
    droppedInvalid: 0,
  };
  const buckets = {
    oiAreas,
    clipZones,
    aabbs,
    overlayRings,
    overlayHeights: [],
    clipTypes: [],
    materials: [],
    measured: 0,
  };
  for (const f of list) {
    const g = f.geometry;
    if (!g) continue;
    const props = f.properties || {};
    const heightM = Number(props.height || props.Height || props.HEIGHT || 0) || 0;
    const rings = featureExteriorRings(g);
    if (!rings.length) continue;
    for (const ring of rings) {
      if (oiAreas.length >= MAX_BUILDINGS) {
        stats.droppedCap++;
        continue;
      }
      const result = emitBuilding(ring, heightM, frame, affine, buckets);
      if (result === "keep") stats.buildings++;
      else if (result === "mega") stats.droppedMega++;
      else if (result === "tiny") stats.droppedTiny++;
      else if (result === "clip") stats.droppedClip++;
      else if (result === "invalid") stats.droppedInvalid++;
    }
  }
  stats.measuredBuildings = buckets.measured;
  return {
    oiAreas,
    clipZones,
    aabbs,
    overlayRings,
    overlayHeights: buckets.overlayHeights,
    clipTypes: buckets.clipTypes,
    materials: buckets.materials,
    stats,
  };
}

function treesToOi(oiTreeAreas, imgW, imgH, mpuX) {
  const out = [];
  let droppedInvalid = 0;
  for (const t of oiTreeAreas) {
    const coords = ringToOi(t.ringPx, imgW, imgH, mpuX);
    const area = emitIfValid(makeOiArea(coords, t.material), imgW, imgH);
    if (!area) {
      droppedInvalid++;
      continue;
    }
    out.push(area);
  }
  return { areas: out, droppedInvalid };
}

function buildOpenIntent(frame, name, imgName, areas, materials) {
  return {
    floorplans: [
      {
        name,
        project_name: name + " Clutter",
        floor_id: uuid(),
        rotation: 0,
        map_uri: "file://images/" + imgName,
        dimensions: [
          {
            width: frame.imgW,
            length: frame.imgH,
            height: 12 / frame.mpuY,
            unit: "pixels",
          },
          { width: frame.widthM, length: frame.lengthM, height: 12, unit: "meters" },
          {
            width: frame.widthM / 0.3048,
            length: frame.lengthM / 0.3048,
            height: 12 / 0.3048,
            unit: "feet",
          },
        ],
        attenuation_areas: areas,
        coverage_areas: [],
        reference_markers: [
          { name: "OC-SW", coordinate_xyz: { x: 0, y: 0, unit: "pixels" } },
          { name: "OC-SE", coordinate_xyz: { x: frame.imgW, y: 0, unit: "pixels" } },
          { name: "OC-NW", coordinate_xyz: { x: 0, y: frame.imgH, unit: "pixels" } },
          { name: "OC-NE", coordinate_xyz: { x: frame.imgW, y: frame.imgH, unit: "pixels" } },
        ],
        closets: [],
      },
    ],
    wall_materials: [],
    switches: [],
    area_materials: catalogMaterials(),
    openintent_version: OPENINTENT_VERSION,
  };
}

function buildClutter({
  frame,
  footprintsGeojson,
  treePoints,
  affine,
  name: rawName,
  imgBuf,
  treesSource,
  footprintMeta,
  terrain,
  warnings,
}) {
  const { name, slug } = siteName(rawName);
  const imgName = `${slug}.jpg`;
  const fp = footprintsToClutter(footprintsGeojson?.features || [], frame, affine);
  const veg = treePairsFromPoints(treePoints || [], frame, fp.aabbs, affine);
  const trees = treesToOi(veg.oiAreas, frame.imgW, frame.imgH, frame.mpuX);
  const uncapped = fp.oiAreas.concat(trees.areas);
  const capped = capAttenuationAreas(uncapped, fp.oiAreas.length);
  const areas = capped.areas;
  const clip = emptyClipboard();
  const seenTypes = new Set(clip.attenuatingZoneTypes.map((t) => t.id));
  for (const t of (fp.clipTypes || []).concat(veg.clipTypes || [])) {
    if (t && t.id && !seenTypes.has(t.id)) {
      seenTypes.add(t.id);
      clip.attenuatingZoneTypes.push(t);
    }
  }
  clip.attenuatingZones = fp.clipZones.concat(veg.clipZones);
  if (capped.dropped) {
    clip.attenuatingZones = clip.attenuatingZones.slice(0, areas.length);
  }
  const materials = catalogMaterials();
  let exactBuildingHeights = 0;
  let exactFoliageHeights = 0;
  for (const t of clip.attenuatingZoneTypes) {
    if (t.id && String(t.id).indexOf("bldg-m-") === 0) exactBuildingHeights++;
    if (t.id && String(t.id).indexOf("foliage-m-") === 0) exactFoliageHeights++;
  }
  const oi = buildOpenIntent(frame, name, imgName, areas, materials);
  const treeOverlayPts = [];
  for (const t of veg.oiAreas || []) {
    if (t.kind !== "trunk" || !t.ringPx || !t.ringPx.length) continue;
    let sx = 0;
    let sy = 0;
    const n = t.ringPx.length - 1;
    for (let i = 0; i < n; i++) {
      sx += t.ringPx[i][0];
      sy += t.ringPx[i][1];
    }
    treeOverlayPts.push([sx / n, sy / n]);
  }
  const overlay = overlaySvg({
    frame,
    imgName,
    buildingRingsYUp: fp.overlayRings,
    treePointsYUp: treeOverlayPts,
  });
  const lock = frameLockJson(frame, imgName);
  const stats = {
    ...fp.stats,
    trees: veg.count,
    treesSource: treesSource || (veg.count ? "imagery-rgb" : "none"),
    zones: clip.attenuatingZones.length,
    areas: areas.length,
    droppedInvalid: (fp.stats.droppedInvalid || 0) + trees.droppedInvalid,
    droppedAreasCap: capped.dropped,
    attenuationAreasEmitted: areas.length,
    openintentVersion: OPENINTENT_VERSION,
    coordinateUnit: "pixels",
    coordinateOrigin: "Y-up from SW",
    calibrated: Boolean(affine),
    summary: "",
    buildingsKept: 0,
    treesKept: 0,
    globalFootprints: footprintMeta && footprintMeta.globalFootprints ? footprintMeta.globalFootprints : 0,
    arcgisFootprints: footprintMeta && footprintMeta.arcgisFootprints ? footprintMeta.arcgisFootprints : 0,
    usaFootprints: footprintMeta && footprintMeta.usaFootprints ? footprintMeta.usaFootprints : 0,
    imageryRoofs: footprintMeta && footprintMeta.imageryRoofs ? footprintMeta.imageryRoofs : 0,
    medianTrees: footprintMeta && footprintMeta.medianTrees ? footprintMeta.medianTrees : 0,
    overtureFootprints: footprintMeta && footprintMeta.overtureFootprints ? footprintMeta.overtureFootprints : 0,
    overtureAdded: footprintMeta && footprintMeta.overtureAdded ? footprintMeta.overtureAdded : 0,
    msHeights: footprintMeta && footprintMeta.msHeights ? footprintMeta.msHeights : 0,
    overtureHeights: footprintMeta && footprintMeta.overtureHeights ? footprintMeta.overtureHeights : 0,
    femaHeights: footprintMeta && footprintMeta.femaHeights ? footprintMeta.femaHeights : 0,
    floorHeights: footprintMeta && footprintMeta.floorHeights ? footprintMeta.floorHeights : 0,
    chmTrees: footprintMeta && footprintMeta.chmTrees ? footprintMeta.chmTrees : 0,
    terrainRaised: terrain && terrain.raised ? terrain.raised : 0,
    terrainSloped: terrain && terrain.sloped ? terrain.sloped : 0,
    areaMaterials: materials.length,
    compatibilityMode: "stock-openintent",
    exactBuildingHeights,
    exactFoliageHeights,
  };
  stats.summary = coverageSummary(stats);
  Object.assign(stats, coverageStats(stats));
  let zip = null;
  if (imgBuf) {
    const zipFiles = [
      { name: `openIntent_${slug}.json`, data: Buffer.from(JSON.stringify(oi)) },
      { name: "images/" + imgName, data: imgBuf },
      {
        name: "export-warnings.json",
        data: Buffer.from(JSON.stringify({ errors: [], warnings: (warnings || []).filter(Boolean).map(String) })),
      },
      { name: "export-stats.json", data: Buffer.from(JSON.stringify(coverageStats(stats), null, 2)) },
      { name: "VERIFY.txt", data: Buffer.from(verifyTxt(stats)) },
      { name: "hamina-clipboard.json", data: Buffer.from(JSON.stringify(clip)) },
      { name: "README.txt", data: zipReadme(stats) },
      { name: "alignment-overlay.svg", data: Buffer.from(overlay) },
      { name: "frame-lock.json", data: Buffer.from(JSON.stringify(lock, null, 2)) },
    ];
    if (terrain && terrain.clipboard && (terrain.raised || terrain.sloped)) {
      zipFiles.push({
        name: "terrain-clipboard.json",
        data: Buffer.from(JSON.stringify(terrain.clipboard)),
      });
    }
    zip = zipStore(zipFiles);
  }
  return {
    name,
    slug,
    imgName,
    openintent: oi,
    clipboard: clip,
    terrain: terrain || null,
    zip,
    stats,
    frame: publicFrame(frame),
    alignment: ALIGNMENT,
  };
}

module.exports = {
  ALIGNMENT,
  ZIP_README,
  ZIP_TROUBLESHOOT,
  MIN_AREA_M2,
  MAX_AREA_M2,
  MAX_BUILDINGS,
  MAX_ATTENUATION_AREAS,
  MIN_OI_SPAN_PX,
  MIN_OI_SPAN_M,
  OPENINTENT_VERSION,
  STOCK_MATERIAL_NAMES,
  MEGA_CAMPUS_M2,
  megaCampusLimitM2,
  isMegaCampus,
  coverageStats,
  coverageSummary,
  zipReadme,
  verifyTxt,
  featureExteriorRings,
  ringAreaM2,
  simplifyRing,
  footprintsToClutter,
  buildClutter,
  siteName,
  simplifyDP,
  clipRingToRect,
  ringToOi,
  ringAreaPx,
  validateOiCoords,
  validateOiArea,
  emitIfValid,
  capAttenuationAreas,
  ensureMinSpan,
  minOiSpanPx,
};
