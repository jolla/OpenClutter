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
  emptyClipboard,
  clipZone,
} = require("./hamina-clipboard");
const {
  materialForBuilding,
  canonicalAreaMaterial,
  documentMaterials,
  OI_BUILDING_NAMES,
  COMPATIBILITY_MODE,
} = require("./materials");
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
 * Last Hamina import that showed clutter was 982 areas (PR #12, stock names).
 * Buildings fill the cap first. Tree rings use stock Foliage - Heavy / Light,
 * or a measured-height custom of that shape, and take whatever slots remain.
 */
const MAX_ATTENUATION_AREAS = 982;
const OPENINTENT_VERSION = "2.0.1";
const STOCK_MATERIAL_NAMES = OI_BUILDING_NAMES.slice();

const ZIP_README =
  "Import this zip in Hamina (Projects → Import → OpenIntent).\n" +
  "OpenIntent carries the map image plus building and tree attenuation_areas.\n" +
  "Buildings use Hamina's outdoor Building - One/Two/Five/Ten Floor materials.\n" +
  "Trees use Hamina's Foliage - Heavy (19.68 ft, 2 dB/m) and Foliage - Light (19.68 ft, 1 dB/m).\n" +
  "Canopy rings are cut around building footprints (4 m buffer) and imagery water, so foliage does not cover roofs or ponds.\n" +
  "A measured height that is not 19.68 ft is Foliage - Heavy 14.2 or Foliage - Light 7.5 (same color and dB/m).\n" +
  "There is no Tree type, so OpenIntent does not emit trunks. Tree Trunk and Foliage N.N m stay off OpenIntent.\n" +
  "hamina-clipboard.json is optional legacy paste for trunks and exact measured metres.\n" +
  "Schema: OpenIntent 2.0.1, pixels+meters+feet per vertex, isotropic meter/pixel aspect.\n" +
  "(Optional) Unzip and open alignment-overlay.svg next to images/ to check rooftops and canopy.\n";

const ZIP_TROUBLESHOOT =
  "\nTroubleshooting if Hamina shows the map but no attenuating objects:\n" +
  "If VERIFY.txt attenuation_areas > 0, generation succeeded. Hamina then either dropped the import\n" +
  "or failed to render (WebGL). Do this in order:\n" +
  "  1. Unzip and confirm VERIFY.txt attenuation_areas (same as openIntent_*.json length).\n" +
  "     openIntentBuildingAreas + openIntentTreeAreas equals that count.\n" +
  "  2. Open alignment-overlay.svg next to images/. Rooftops (red) and trees (green) should sit on the JPEG.\n" +
  "  3. In Hamina, check the Attenuating Objects sidebar count.\n" +
  "     0 = OpenIntent import dropped the areas. >0 = they imported but did not draw.\n" +
  "  4. Optional: paste hamina-clipboard.json for Foliage / Tree Trunk names and exact metres.\n" +
  "  5. Console WebGL texSubImage2D / Rive warnings can hide objects after a successful import.\n" +
  "     Try Hamina’s 2D map view, and turn hardware acceleration off, then zoom the full extent.\n" +
  "Floorplan dimensions.height is Hamina outdoor 2.5 m (8.202 ft); meters match JPEG pixel aspect.\n" +
  "Building materials are the gold One/Two/Five/Ten Floor objects.\n" +
  "Tree materials are stock Foliage - Heavy / Light, or Foliage - Heavy H.H / Foliage - Light H.H at the measured height.\n" +
  "Each is name + rf_properties + top_height + display_color. No itu_material_type, no bottom_height.\n" +
  "Tree Trunk and Foliage N.N m are clipboard-only.\n" +
  "Each ring vertex is pixels+meters+feet; materials omit itu_material_type and bottom_height.\n" +
  "Rings thinner than 4 px on one axis, or over the Hamina vertex cap, are omitted from OpenIntent\n" +
  "(VERIFY.txt warning) so one bad ring cannot drop the import. Those shapes stay on the clipboard.\n";

/**
 * Skip Microsoft campus-merge blobs (one giant wrong polygon). Do NOT use a
 * fraction of the drawn map — a tight commercial bbox makes a 2 ha big-box
 * roof look like “half the site” (Oak Creek white roof).
 *
 * Size is measured after clipping the ring to the imagery frame. Off-map MS
 * hulls (Wynn SE blob) become empty/tiny instead of “mega”.
 *
 * Coarse rings above MEGA_CAMPUS_M2 are still dropped. Detailed outlines
 * (USA Structures / high-vertex roofs) may reach HOTEL_MEGA_M2 so casino and
 * convention podiums (Wynn ~185k m²) are kept. Anything larger is always mega.
 */
const MEGA_CAMPUS_M2 = 150000;
const HOTEL_MEGA_M2 = 400000;
/** After simplify, coarse MS hulls stay ~20–32 verts; real large roofs keep ≥40. */
const MEGA_MIN_DETAIL_VERTS = 40;
/**
 * Hamina outdoor OpenIntent rings top out near 21 vertices. A project
 * re-exported after clipboard paste tops out near 41. Emit at most this many
 * open vertices so one dense Overture ring cannot invalidate the import.
 * Mega classification still uses the detailed simplify (#24 budgets, including
 * 56 for large roofs) before this cap: the podium is kept, then simplified
 * under the import ceiling.
 */
const MAX_OI_RING_VERTS = 40;
/** Image-edge rounding shaves ~0.002 px; do not treat that as a sub-4 px sliver. */
const OI_SPAN_SLACK_PX = 0.005;
/**
 * A short side under half the minimum is a sliver: drop it from OpenIntent.
 * A nearer miss (coarse pixels, a 3 px wing) is expanded out to the floor so
 * the ring stays valid without inventing a wide wall from a 1 px edge.
 */
const OI_SLIVER_FRACTION = 0.5;

function megaCampusLimitM2() {
  return HOTEL_MEGA_M2;
}

function ringVertexCount(ring) {
  if (!ring || ring.length < 3) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  return closed ? ring.length - 1 : ring.length;
}

/**
 * @param {number} areaM2 area of the ring already clipped to the map
 * @param {number} [vertCount] vertex count of the simplified (pre-clip) ring
 */
function isMegaCampus(areaM2, vertCount) {
  if (!(areaM2 > MEGA_CAMPUS_M2)) return false;
  if (areaM2 > HOTEL_MEGA_M2) return true;
  const verts = vertCount == null ? 0 : +vertCount;
  return !(verts >= MEGA_MIN_DETAIL_VERTS);
}

function pxRingAreaM2(pts, mpuX, mpuY) {
  if (!pts || pts.length < 3) return 0;
  const mx = mpuX > 0 ? mpuX : 1;
  const my = mpuY > 0 ? mpuY : mx;
  return ringAreaPx(pts) * mx * my;
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
    droppedSpan: s.droppedSpan || 0,
    droppedVerts: s.droppedVerts || 0,
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
    openIntentBuildingAreas: s.openIntentBuildingAreas || 0,
    openIntentTreeAreas: s.openIntentTreeAreas || 0,
    compatibilityMode: s.compatibilityMode || COMPATIBILITY_MODE,
    exactBuildingHeights: s.exactBuildingHeights || 0,
    exactFoliageHeights: s.exactFoliageHeights || 0,
    waterMaskRings: s.waterMaskRings || 0,
    pavementMaskRings: s.pavementMaskRings || 0,
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
  if (c.droppedSpan) drops.push("span " + c.droppedSpan);
  if (c.droppedVerts) drops.push("verts " + c.droppedVerts);
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
    `droppedSpan: ${c.droppedSpan}\n` +
    `droppedVerts: ${c.droppedVerts}\n` +
    `droppedAreasCap: ${c.droppedAreasCap}\n` +
    ZIP_TROUBLESHOOT
  );
}

function verifyTxt(stats) {
  const c = coverageStats(stats);
  return (
    `attenuation_areas: ${c.attenuationAreasEmitted}\n` +
    `openIntentBuildingAreas: ${c.openIntentBuildingAreas || 0}\n` +
    `openIntentTreeAreas: ${c.openIntentTreeAreas || 0}\n` +
    `openintent_version: ${c.openintentVersion}\n` +
    `coordinate_unit: ${c.coordinateUnit}\n` +
    `coordinate_origin: ${c.coordinateOrigin}\n` +
    `area_materials: ${c.areaMaterials != null ? c.areaMaterials : STOCK_MATERIAL_NAMES.length}\n` +
    `buildingsKept: ${c.buildingsKept}\n` +
    `treesKept: ${c.treesKept}\n` +
    `attenuationAreasEmitted: ${c.attenuationAreasEmitted}\n` +
    verifyOmitWarning(c)
  );
}

function verifyOmitWarning(c) {
  const span = c.droppedSpan || 0;
  const verts = c.droppedVerts || 0;
  if (!span && !verts) return "";
  return (
    `warning: omitted ${span} thin-span and ${verts} over-vertex ring(s) from OpenIntent so one invalid ring cannot drop the import\n`
  );
}

const ALIGNMENT = [
  "Exact alignment (repeatable, any site):",
  "1. Import this zip in Hamina (Projects → Import → OpenIntent).",
  "   Floorplan meters match the JPEG pixel aspect (unified mpu; Esri content grid).",
  "   dimensions.height is Hamina outdoor 2.5 m. OpenIntent areas are buildings and trees.",
  "   Buildings: Building - One / Two / Five / Ten Floor.",
  "   Trees: Foliage - Heavy / Foliage - Light (19.68 ft). Measured heights use Foliage - Heavy H.H / Foliage - Light H.H.",
  "2. hamina-clipboard.json is optional legacy paste for older Foliage / Tree Trunk names",
  "   and exact measured heights. The import already includes canopy.",
  "3. Extra files (alignment-overlay.svg, frame-lock.json) are ignored on OpenIntent import.",
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

function simplifyRing(ring, maxPts = 32, eps = 2.5e-6) {
  if (!ring || ring.length < 3) return ring;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  if (closed.length <= maxPts) {
    closed.push(closed[0]);
    return closed;
  }
  const tol = eps > 0 ? eps : 2.5e-6;
  let out = simplifyDP(closed, tol * tol);
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

function xyz(x, y, unit) {
  return {
    coordinate_xyz: {
      x: +Math.max(0, x).toFixed(6),
      y: +Math.max(0, y).toFixed(6),
      unit: unit || "pixels",
    },
  };
}

/**
 * Hamina-native attenuation rings interleave pixels, meters, feet per vertex
 * (Jerry's gold OpenIntent export). Meters are Y-up from SW: x_m = x_px * mpu.
 */
function expandOiCoordTriples(pixelCoords, mpu) {
  const m = Number(mpu);
  if (!(m > 0) || !pixelCoords || !pixelCoords.length) return null;
  const out = [];
  for (const c of pixelCoords) {
    const p = c && c.coordinate_xyz;
    if (!p || p.unit !== "pixels") return null;
    const xm = p.x * m;
    const ym = p.y * m;
    out.push(xyz(p.x, p.y, "pixels"));
    out.push(xyz(xm, ym, "meters"));
    out.push(xyz(xm / 0.3048, ym / 0.3048, "feet"));
  }
  return out;
}

/** Pixel-only vertices from a Hamina triple ring or a legacy pixels-only ring. */
function oiPixelCoords(coords) {
  if (!coords || !coords.length) return [];
  const u0 = coords[0] && coords[0].coordinate_xyz && coords[0].coordinate_xyz.unit;
  if (u0 === "pixels" && coords.length >= 3) {
    const u1 = coords[1] && coords[1].coordinate_xyz && coords[1].coordinate_xyz.unit;
    if (u1 === "meters") {
      const out = [];
      if (coords.length % 3 !== 0) return [];
      for (let i = 0; i < coords.length; i += 3) {
        const p = coords[i] && coords[i].coordinate_xyz;
        const m = coords[i + 1] && coords[i + 1].coordinate_xyz;
        const f = coords[i + 2] && coords[i + 2].coordinate_xyz;
        if (!p || p.unit !== "pixels" || !m || m.unit !== "meters" || !f || f.unit !== "feet") return [];
        out.push(coords[i]);
      }
      return out;
    }
  }
  return coords.slice();
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
 * "ok" — both axes clear the floor.
 * "thin" — one axis is a sliver. Do not expand (that invents a building) and
 * do not emit (Hamina may drop every area if one ring is degenerate).
 * "collapsed" — both axes are tiny (tree-trunk scale). Expand to a square.
 */
function ringSpanClass(pts, minSpan) {
  if (!pts || pts.length < 3) return "collapsed";
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  const b = ringBBox(pts);
  const floor = span - OI_SPAN_SLACK_PX;
  const xOk = b.w >= floor;
  const yOk = b.h >= floor;
  if (xOk && yOk) return "ok";
  if (xOk || yOk) return "thin";
  return "collapsed";
}

function thinSliverDrop(pts, minSpan) {
  if (ringSpanClass(pts, minSpan) !== "thin") return false;
  const b = ringBBox(pts);
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  return Math.min(b.w, b.h) < span * OI_SLIVER_FRACTION;
}

/** Stretch only the short axis out to `span`, keeping the ring inside the image. */
function expandShortAxis(pts, imgW, imgH, span) {
  const b = ringBBox(pts);
  let minX = b.minX;
  let maxX = b.maxX;
  let minY = b.minY;
  let maxY = b.maxY;
  if (b.w < span) {
    const cx = (b.minX + b.maxX) / 2;
    minX = cx - span / 2;
    maxX = cx + span / 2;
    if (minX < 0) {
      maxX -= minX;
      minX = 0;
    }
    if (maxX > imgW) {
      minX -= maxX - imgW;
      maxX = imgW;
    }
    minX = Math.max(0, minX);
    maxX = Math.min(imgW, maxX);
  }
  if (b.h < span) {
    const cy = (b.minY + b.maxY) / 2;
    minY = cy - span / 2;
    maxY = cy + span / 2;
    if (minY < 0) {
      maxY -= minY;
      minY = 0;
    }
    if (maxY > imgH) {
      minY -= maxY - imgH;
      maxY = imgH;
    }
    minY = Math.max(0, minY);
    maxY = Math.min(imgH, maxY);
  }
  const floor = span - OI_SPAN_SLACK_PX;
  if (maxX - minX < floor || maxY - minY < floor) return [];
  const sx = b.w > 1e-9 ? (maxX - minX) / b.w : 1;
  const sy = b.h > 1e-9 ? (maxY - minY) / b.h : 1;
  const out = [];
  for (const p of pts) out.push([minX + (p[0] - b.minX) * sx, minY + (p[1] - b.minY) * sy]);
  return out;
}

/**
 * Sub-pixel tree trunks used to emit near-degenerate hexagons. After toFixed(3)
 * those can be duplicate/NaN-adjacent and Hamina then dropped every area.
 * Expand collapsed blobs and near-miss short sides. Drop one-axis slivers.
 */
function ensureMinSpan(pts, imgW, imgH, minSpan) {
  if (!pts || pts.length < 3) return pts;
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  const klass = ringSpanClass(pts, span);
  if (klass === "ok") return pts;
  if (klass === "thin") {
    if (thinSliverDrop(pts, span)) return [];
    return expandShortAxis(pts, imgW, imgH, span);
  }
  const b = ringBBox(pts);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const square = fitSquareInImage(cx, cy, Math.max(span, b.w, b.h), imgW, imgH);
  return square.length ? square : [];
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
  const pixels = oiPixelCoords(coords);
  const n = pixels.length - 1;
  if (n < 4) return false;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = pixels[i].coordinate_xyz;
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
  const pixels = oiPixelCoords(coords);
  let a = 0;
  for (let i = 0; i < pixels.length - 1; i++) {
    const p = pixels[i].coordinate_xyz;
    const q = pixels[i + 1].coordinate_xyz;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Hamina-native rings use pixels+meters+feet triples per vertex. Validate the
 * pixel vertices (closed, in-bounds) and the triple interleave when present.
 */
function validateOiCoords(coords, imgW, imgH) {
  const pixels = oiPixelCoords(coords);
  if (!pixels || pixels.length < 4) return { ok: false, reason: "too-few" };
  if (coords.length !== pixels.length) {
    if (coords.length !== pixels.length * 3) return { ok: false, reason: "triple" };
  }
  for (const c of pixels) {
    const p = c && c.coordinate_xyz;
    if (!p) return { ok: false, reason: "missing-xyz" };
    if (p.unit !== "pixels") return { ok: false, reason: "unit" };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: "nan" };
    if (p.x < 0 || p.y < 0 || p.x > imgW || p.y > imgH) return { ok: false, reason: "bounds" };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i].coordinate_xyz;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const spanFloor = MIN_OI_SPAN_PX - OI_SPAN_SLACK_PX;
  if (maxX - minX < spanFloor || maxY - minY < spanFloor) return { ok: false, reason: "span" };
  const first = pixels[0].coordinate_xyz;
  const last = pixels[pixels.length - 1].coordinate_xyz;
  if (first.x !== last.x || first.y !== last.y) return { ok: false, reason: "open" };
  const seen = new Set();
  for (let i = 0; i < pixels.length - 1; i++) {
    const p = pixels[i].coordinate_xyz;
    const q = pixels[i + 1].coordinate_xyz;
    if (p.x === q.x && p.y === q.y) return { ok: false, reason: "duplicate" };
    seen.add(p.x + "," + p.y);
  }
  if (seen.size < 3) return { ok: false, reason: "degenerate" };
  if (Math.abs(signedAreaOi(pixels)) < 1e-6) return { ok: false, reason: "zero-area" };
  if (oiSelfIntersects(pixels)) return { ok: false, reason: "self-intersect" };
  return { ok: true };
}

function oiAreaMaterialName(mat) {
  if (typeof mat === "string") return mat;
  return mat && mat.name ? mat.name : "";
}

/** Gold building clone, or the canonical measured vegetation object. Null if it would not match the catalog. */
function catalogMaterial(material) {
  return canonicalAreaMaterial(material);
}

function validateOiArea(area, imgW, imgH) {
  if (!area || !area.area || area.area_material == null) return { ok: false, reason: "shape" };
  const mat = area.area_material;
  // OpenIntent 2.0.1 attenuation_area.area_material is a material object.
  // A catalog name string fails the whole document ("Invalid OpenIntent format",
  // PR #18). The object must deep-equal its catalog entry: gold building, or
  // Stock Foliage - Heavy / Light, or a measured-height custom. No itu_material_type,
  // no bottom_height. Poisoned names fail closed and that ring is omitted.
  if (typeof mat !== "object" || mat == null || Array.isArray(mat)) return { ok: false, reason: "material" };
  if ("itu_material_type" in mat || "bottom_height" in mat) return { ok: false, reason: "material" };
  const cat = catalogMaterial(mat);
  if (!cat || JSON.stringify(mat) !== JSON.stringify(cat)) return { ok: false, reason: "material" };
  return validateOiCoords(area.area.coordinates, imgW, imgH);
}

/** Round + drop consecutive duplicates *after* toFixed so Hamina never sees collapsed verts. */
function finalizeOiCoords(rawPts, imgW, imgH) {
  const pts = [];
  for (const p of rawPts || []) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const c = xyz(Math.min(imgW, Math.max(0, p[0])), Math.min(imgH, Math.max(0, p[1])), "pixels");
    // toFixed can round imgW-epsilon back up to imgW. A point on the far edge
    // is outside a strict < dimension check and one such ring drops the import.
    if (imgW > 0 && c.coordinate_xyz.x >= imgW) c.coordinate_xyz.x = Math.round((imgW - 0.002) * 1e6) / 1e6;
    if (imgH > 0 && c.coordinate_xyz.y >= imgH) c.coordinate_xyz.y = Math.round((imgH - 0.002) * 1e6) / 1e6;
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

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHullOpen(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts.slice();
  const lower = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function subsampleOpen(open, maxPts) {
  if (open.length <= maxPts) return open.slice();
  const step = Math.ceil(open.length / maxPts);
  const thin = [];
  for (let i = 0; i < open.length && thin.length < maxPts; i += step) thin.push(open[i]);
  return thin;
}

function ringSelfIntersectsPx(pts) {
  const open = uniqueOpenRing(pts);
  const n = open.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segsIntersectProper(a, b, open[j], open[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * OpenIntent vertex ceiling. Rings already under the budget are returned
 * unchanged (a bowtie stays a bowtie so validation can reject it). Longer
 * rings are Douglas–Peucker'd, then subsampled, then replaced with the
 * convex hull if a candidate would self-intersect.
 */
function capOiRingPx(ring, maxPts) {
  const limit = Math.max(3, maxPts | 0);
  const open = uniqueOpenRing(ring);
  if (open.length < 3) return [];
  if (open.length <= limit) return open.concat([open[0]]);
  const candidates = [];
  let eps = 0.35;
  for (let i = 0; i < 14; i++) {
    const simplified = simplifyRing(open.concat([open[0]]), limit, eps);
    const next = uniqueOpenRing(simplified);
    if (next.length >= 3 && next.length <= limit && next.length < open.length) candidates.push(next);
    eps *= 1.65;
  }
  candidates.push(subsampleOpen(open, limit));
  const hull = convexHullOpen(open);
  if (hull.length >= 3) candidates.push(hull.length > limit ? subsampleOpen(hull, limit) : hull);
  for (const c of candidates) {
    if (c.length >= 3 && c.length <= limit && ringAreaPx(c) > 1e-4 && !ringSelfIntersectsPx(c)) {
      return c.concat([c[0]]);
    }
  }
  return [];
}

function ringToOi(pts, imgW, imgH, mpuX) {
  if (!pts || pts.length < 3) return null;
  let clipped = clipRingToRect(pts, imgW, imgH);
  if (clipped.length < 3) return null;
  const span = minOiSpanPx(mpuX);
  if (thinSliverDrop(clipped, span)) return null;
  clipped = ensureMinSpan(clipped, imgW, imgH, span);
  if (!clipped || clipped.length < 3) return null;
  if (ringSpanClass(clipped, span) !== "ok") return null;
  clipped = capOiRingPx(clipped, MAX_OI_RING_VERTS);
  if (!clipped || ringVertexCount(clipped) < 3 || ringVertexCount(clipped) > MAX_OI_RING_VERTS) return null;
  if (ringAreaPx(clipped) < 1e-6) return null;
  const pixels = finalizeOiCoords(clipped, imgW, imgH);
  if (!pixels) return null;
  const check = validateOiCoords(pixels, imgW, imgH);
  if (!check.ok) return null;
  const triples = expandOiCoordTriples(pixels, mpuX);
  if (!triples) return null;
  return validateOiCoords(triples, imgW, imgH).ok ? triples : null;
}

function makeOiArea(coords, material) {
  const mat = catalogMaterial(material);
  if (!coords || !mat) return null;
  return { area: { coordinates: coords }, area_material: mat };
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
function capAttenuationAreas(areas, buildingCount, max, opts) {
  const limit = max == null ? MAX_ATTENUATION_AREAS : max;
  const pairTail = !opts || opts.pairTail !== false;
  if (!areas || areas.length <= limit) return { areas: areas || [], dropped: 0 };
  const b = Math.min(buildingCount, limit);
  let rest = limit - b;
  if (pairTail) rest -= rest % 2;
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
  // Large detailed roofs (Wynn casino) self-intersect if Douglas–Peucker is too
  // aggressive; try a tighter pass before giving up as clip. These budgets
  // stay high so isMegaCampus can see ≥40 detail verts (#24, including the
  // 56-vert large-roof pass). ringToOi then caps the emitted ring to
  // MAX_OI_RING_VERTS — the detail count is not the OpenIntent vertex count.
  const budgets =
    amRaw > 80000
      ? [
          [180, 1e-6],
          [320, 5e-7],
          [400, 1e-7],
        ]
      : amRaw > 20000
        ? [
            [96, 2.5e-6],
            [160, 1e-6],
          ]
        : amRaw > 8000
          ? [[56, 2.5e-6]]
          : amRaw > 1500
            ? [[40, 2.5e-6]]
            : [[32, 2.5e-6]];

  let lastFail = "skip";
  for (const [maxPts, eps] of budgets) {
    const result = emitBuildingSimplified(ring, heightM, frame, affine, buckets, maxPts, eps);
    if (result === "keep") return "keep";
    // Tiny clipped area will not grow with more verts. A one-axis sliver
    // will not grow a short side either — do not retry and double-count it.
    if (result === "tiny" || result === "span") return result;
    // Mega from a coarse simplify may clear once detail verts are preserved.
    if (result === "mega") {
      lastFail = "mega";
      continue;
    }
    lastFail = result;
  }
  return lastFail;
}

/** Overlay uses the detailed clip. Clipboard uses clipPx (exact sliver, or the OI ring on the keep path). */
function stashBuilding(buckets, frame, affine, clipRing, overlayPts, clipPx, picked) {
  if (picked.clipType) buckets.clipTypes.push(picked.clipType);
  if (picked.measured) buckets.measured++;
  const clipFromImage = [];
  if (!affine) {
    const open = uniqueOpenRing(clipPx);
    for (const p of open) {
      const m = pxToClipboard(p[0], p[1], frame);
      clipFromImage.push([
        Math.min(0, Math.max(-frame.widthM, m[0])),
        Math.min(0, Math.max(-frame.lengthM, m[1])),
      ]);
    }
  }
  const z = clipZone(picked.typeId, affine ? clipRing : clipFromImage);
  if (z) buckets.clipZones.push(z);
  const src = overlayPts && overlayPts.length ? overlayPts : clipPx;
  const cxs = src.map((p) => p[0]);
  const cys = src.map((p) => p[1]);
  buckets.aabbs.push({
    minX: Math.min(...cxs),
    maxX: Math.max(...cxs),
    minY: Math.min(...cys),
    maxY: Math.max(...cys),
  });
  buckets.overlayRings.push(src);
  buckets.overlayHeights.push(picked.exactHeight || (picked.material && picked.material.top_height) || 0);
}

function emitBuildingSimplified(ring, heightM, frame, affine, buckets, maxPts, eps) {
  const simple = simplifyRing(ring, maxPts, eps);
  if (!simple || simple.length < 4) return "skip";
  const detailVerts = ringVertexCount(simple);
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
  // Clip before size filters so off-map MS hulls are not counted as mega.
  const clippedPts = clipRingToRect(pts, frame.imgW, frame.imgH);
  if (!clippedPts || clippedPts.length < 3) return "clip";
  const am = pxRingAreaM2(clippedPts, frame.mpuX, frame.mpuY);
  if (isMegaCampus(am, detailVerts)) return "mega";
  if (am < MIN_AREA_M2) return "tiny";
  const minSpan = minOiSpanPx(frame.mpuX);
  if (thinSliverDrop(clippedPts, minSpan)) {
    // Clipboard keeps the exact sliver. OpenIntent must not, or Hamina drops
    // every attenuating object.
    const pickedThin = materialForBuilding(heightM, am);
    stashBuilding(buckets, frame, affine, clipRing, clippedPts, clippedPts, pickedThin);
    return "span";
  }
  const oiCoords = ringToOi(clippedPts, frame.imgW, frame.imgH, frame.mpuX);
  if (!oiCoords) {
    if (ringVertexCount(clippedPts) > MAX_OI_RING_VERTS) return "verts";
    return "clip";
  }
  const picked = materialForBuilding(heightM, am);
  const area = emitIfValid(makeOiArea(oiCoords, picked.material), frame.imgW, frame.imgH);
  if (!area) return "invalid";
  buckets.oiAreas.push(area);
  if (picked.clipType) buckets.clipTypes.push(picked.clipType);
  if (picked.material) buckets.materials.push(picked.material);
  if (picked.measured) buckets.measured++;
  // Clipboard meters follow the clipped OpenIntent ring, not the raw lon/lat
  // polygon. Footprints that cross the JPEG were landing at x=+8.4, y=+38,
  // y=-1999 against a south edge of -1919.
  // OI rings are pixels+meters+feet triples — only the pixel vertices are an
  // image grid. Treating meters/feet as pixels (PR #20) and clamping them
  // inflated footprints and shoved them south/west of the aerial.
  const clipFromImage = [];
  if (!affine) {
    const pixelVerts = oiPixelCoords(oiCoords);
    const n = pixelVerts.length;
    const end =
      n > 1 &&
      pixelVerts[0].coordinate_xyz.x === pixelVerts[n - 1].coordinate_xyz.x &&
      pixelVerts[0].coordinate_xyz.y === pixelVerts[n - 1].coordinate_xyz.y
        ? n - 1
        : n;
    for (let i = 0; i < end; i++) {
      const p = pixelVerts[i].coordinate_xyz;
      const m = pxToClipboard(p.x, p.y, frame);
      clipFromImage.push([
        Math.min(0, Math.max(-frame.widthM, m[0])),
        Math.min(0, Math.max(-frame.lengthM, m[1])),
      ]);
    }
  }
  const z = clipZone(picked.typeId, affine ? clipRing : clipFromImage);
  if (z) buckets.clipZones.push(z);
  const cxs = clippedPts.map((p) => p[0]);
  const cys = clippedPts.map((p) => p[1]);
  buckets.aabbs.push({
    minX: Math.min(...cxs),
    maxX: Math.max(...cxs),
    minY: Math.min(...cys),
    maxY: Math.max(...cys),
  });
  buckets.overlayRings.push(clippedPts);
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
    droppedSpan: 0,
    droppedVerts: 0,
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
      else if (result === "span") stats.droppedSpan++;
      else if (result === "verts") stats.droppedVerts++;
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
  const areas = [];
  const kinds = [];
  let droppedInvalid = 0;
  for (const t of oiTreeAreas || []) {
    const coords = ringToOi(t.ringPx, imgW, imgH, mpuX);
    const area = emitIfValid(makeOiArea(coords, t.material), imgW, imgH);
    if (!area) {
      droppedInvalid++;
      continue;
    }
    areas.push(area);
    kinds.push(t.kind === "trunk" ? "trunk" : "canopy");
  }
  return { areas, kinds, droppedInvalid };
}

/** Hamina outdoor OpenIntent floorplan height (gold export + after-paste re-export). */
const OI_FLOORPLAN_HEIGHT_M = 2.5;
const OI_FLOORPLAN_HEIGHT_FT = 8.202;

function buildOpenIntent(frame, name, imgName, areas, materials) {
  const mpu = frame.mpuX || frame.mpu || frame.widthM / frame.imgW;
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
            height: OI_FLOORPLAN_HEIGHT_M / mpu,
            unit: "pixels",
          },
          {
            width: frame.widthM,
            length: frame.lengthM,
            height: OI_FLOORPLAN_HEIGHT_M,
            unit: "meters",
          },
          {
            width: frame.widthM / 0.3048,
            length: frame.lengthM / 0.3048,
            height: OI_FLOORPLAN_HEIGHT_FT,
            unit: "feet",
          },
        ],
        attenuation_areas: areas,
        coverage_areas: [],
        reference_markers: [],
        closets: [],
      },
    ],
    wall_materials: [],
    switches: [],
    area_materials: documentMaterials(areas),
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
  canopyHits,
  heightSample,
  maskRings,
  maskPolygons,
}) {
  const { name, slug } = siteName(rawName);
  const imgName = `${slug}.jpg`;
  const fp = footprintsToClutter(footprintsGeojson?.features || [], frame, affine);
  const veg = treePairsFromPoints(treePoints || [], frame, fp.aabbs, affine, {
    canopyHits,
    heightSample,
    buildingRings: fp.overlayRings,
    maskRings,
    maskPolygons,
  });
  // A poisoned or drifted vegetation material fails makeOiArea and that ring
  // is omitted, so it cannot empty the buildings.
  const treeOi = treesToOi(veg.oiAreas, frame.imgW, frame.imgH, frame.mpuX);
  const canopies = [];
  const trunks = [];
  for (let i = 0; i < treeOi.areas.length; i++) {
    if (treeOi.kinds[i] === "trunk") trunks.push(treeOi.areas[i]);
    else canopies.push(treeOi.areas[i]);
  }
  const uncapped = fp.oiAreas.concat(canopies, trunks);
  const capped = capAttenuationAreas(uncapped, fp.oiAreas.length, MAX_ATTENUATION_AREAS, {
    pairTail: false,
  });
  const areas = capped.areas;
  const clip = emptyClipboard();
  const seenTypes = new Set(clip.attenuatingZoneTypes.map((t) => t.id));
  for (const t of (fp.clipTypes || []).concat(veg.clipTypes || [])) {
    if (t && t.id && !seenTypes.has(t.id)) {
      seenTypes.add(t.id);
      clip.attenuatingZoneTypes.push(t);
    }
  }
  // Full building + tree clipboard; do not trim to the OI building count.
  clip.attenuatingZones = fp.clipZones.concat(veg.clipZones);
  const materials = documentMaterials(areas);
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
    treePointsYUp: veg.overlayPoints && veg.overlayPoints.length ? veg.overlayPoints : treeOverlayPts,
    treeRingsYUp: veg.overlayRings,
  });
  const lock = frameLockJson(frame, imgName);
  const buildingEmitted = Math.min(fp.oiAreas.length, areas.length);
  const treeEmitted = areas.length - buildingEmitted;
  const stats = {
    ...fp.stats,
    trees: veg.count,
    treesSource: treesSource || (veg.count ? "imagery-rgb" : "none"),
    zones: clip.attenuatingZones.length,
    areas: areas.length,
    droppedInvalid: fp.stats.droppedInvalid || 0,
    droppedTreeRings: treeOi.droppedInvalid,
    droppedAreasCap: capped.dropped,
    attenuationAreasEmitted: areas.length,
    openIntentBuildingAreas: buildingEmitted,
    openIntentTreeAreas: treeEmitted,
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
    compatibilityMode: COMPATIBILITY_MODE,
    exactBuildingHeights,
    exactFoliageHeights,
    waterMaskRings: (maskRings || []).length,
    pavementMaskRings: (maskPolygons || []).length,
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
  OI_FLOORPLAN_HEIGHT_M,
  OI_FLOORPLAN_HEIGHT_FT,
  STOCK_MATERIAL_NAMES,
  MEGA_CAMPUS_M2,
  HOTEL_MEGA_M2,
  MEGA_MIN_DETAIL_VERTS,
  MAX_OI_RING_VERTS,
  megaCampusLimitM2,
  isMegaCampus,
  ringVertexCount,
  pxRingAreaM2,
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
  oiAreaMaterialName,
  oiPixelCoords,
  expandOiCoordTriples,
  emitIfValid,
  capAttenuationAreas,
  ensureMinSpan,
  minOiSpanPx,
  capOiRingPx,
  ringSpanClass,
};
