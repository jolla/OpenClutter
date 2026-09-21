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
  TYPE_BY_ID,
  emptyClipboard,
  oiMaterialFromType,
  pickBuildingTypeId,
  clipZone,
} = require("./hamina-clipboard");
const { treePairsFromPoints } = require("./vegetation");
const { zipStore } = require("./zip-store");
const { overlaySvg, frameLockJson } = require("./overlay");

const MIN_AREA_M2 = 40;
const MAX_AREA_M2 = 15000;
const MAX_BUILDINGS = 300;

const ZIP_README =
  "Import this zip in Hamina (Projects → Import → OpenIntent).\n" +
  "The OpenIntent JSON is the source of truth: map image + all attenuating objects.\n" +
  "Hamina 2026-09-01+ imports attenuation_areas (stock type names, heights, dB/m).\n" +
  "(Optional) Unzip and open alignment-overlay.svg next to images/ to check rooftops.\n" +
  "hamina-clipboard.json is a silent fallback for older Hamina builds only — not the happy path.\n";

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

function simplifyRing(ring, maxPts = 24) {
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

function ringToOi(pts, imgW, imgH) {
  if (!pts || pts.length < 3) return null;
  const clipped = clipRingToRect(pts, imgW, imgH);
  if (clipped.length < 3) return null;
  // Trunks are often <1 px across at outdoor mpu; a large px² cutoff would
  // drop the canopy/trunk pair. Reject only collapsed rings.
  if (ringAreaPx(clipped) < 1e-6) return null;
  const out = clipped.map(([x, y]) =>
    xyz(Math.min(imgW, Math.max(0, x)), Math.min(imgH, Math.max(0, y)))
  );
  const a = out[0].coordinate_xyz;
  const b = out[out.length - 1].coordinate_xyz;
  if (a.x !== b.x || a.y !== b.y) out.push(out[0]);
  const seen = new Set();
  for (let i = 0; i < out.length - 1; i++) {
    seen.add(out[i].coordinate_xyz.x + "," + out[i].coordinate_xyz.y);
  }
  if (seen.size < 3 || out.length < 4) return null;
  return out;
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

function footprintsToClutter(features, frame, affine) {
  const oiAreas = [];
  const clipZones = [];
  const aabbs = [];
  const overlayRings = [];
  const stats = { buildings: 0, droppedMega: 0, droppedTiny: 0, droppedClip: 0 };
  for (const f of features || []) {
    if (oiAreas.length >= MAX_BUILDINGS) break;
    const g = f.geometry;
    if (!g) continue;
    const heightM =
      Number((f.properties || {}).height || (f.properties || {}).Height || 0) || 0;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) {
      const ring = simplifyRing(poly[0] || []);
      if (!ring || ring.length < 4) continue;
      const am = ringAreaM2(ring, frame.mpd);
      if (am > MAX_AREA_M2) {
        stats.droppedMega++;
        continue;
      }
      if (am < MIN_AREA_M2) {
        stats.droppedTiny++;
        continue;
      }
      const pts = [];
      const clipRing = [];
      for (const [lon, lat] of ring) {
        const [x, y] = llToPx(lon, lat, frame);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          pts.push([x, y]);
          clipRing.push(lonLatToClip(lon, lat, frame, affine));
        }
      }
      if (pts.length < 3) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (maxX < 0 || maxY < 0 || minX > frame.imgW || minY > frame.imgH) {
        stats.droppedClip++;
        continue;
      }
      const oiCoords = ringToOi(pts, frame.imgW, frame.imgH);
      if (!oiCoords) {
        stats.droppedClip++;
        continue;
      }
      const typeId = pickBuildingTypeId(am, heightM);
      const type = TYPE_BY_ID[typeId];
      const mat = oiMaterialFromType(type, heightM > 2 ? heightM : type.topEdge);
      oiAreas.push({ area: { coordinates: oiCoords }, area_material: mat });
      const z = clipZone(typeId, clipRing);
      if (z) clipZones.push(z);
      aabbs.push({ minX, maxX, minY, maxY });
      overlayRings.push(pts);
      stats.buildings++;
    }
  }
  return { oiAreas, clipZones, aabbs, overlayRings, stats };
}

function treesToOi(oiTreeAreas, imgW, imgH) {
  const out = [];
  for (const t of oiTreeAreas) {
    const coords = ringToOi(t.ringPx, imgW, imgH);
    if (!coords) continue;
    const type = TYPE_BY_ID[t.typeId];
    out.push({ area: { coordinates: coords }, area_material: oiMaterialFromType(type) });
  }
  return out;
}

function buildOpenIntent(frame, name, imgName, areas) {
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
    area_materials: ZONE_TYPES.map((t) => oiMaterialFromType(t)),
    openintent_version: "2.0.1",
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
}) {
  const { name, slug } = siteName(rawName);
  const imgName = `${slug}.jpg`;
  const fp = footprintsToClutter(footprintsGeojson?.features || [], frame, affine);
  const veg = treePairsFromPoints(treePoints || [], frame, fp.aabbs, affine);
  const areas = fp.oiAreas.concat(treesToOi(veg.oiAreas, frame.imgW, frame.imgH));
  const clip = emptyClipboard();
  clip.attenuatingZones = fp.clipZones.concat(veg.clipZones);
  const oi = buildOpenIntent(frame, name, imgName, areas);
  const treeOverlayPts = [];
  for (const t of veg.oiAreas || []) {
    if (t.typeId !== "tree-trunk" || !t.ringPx || !t.ringPx.length) continue;
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
    calibrated: Boolean(affine),
  };
  let zip = null;
  if (imgBuf) {
    zip = zipStore([
      { name: `openIntent_${slug}.json`, data: Buffer.from(JSON.stringify(oi)) },
      { name: "images/" + imgName, data: imgBuf },
      { name: "export-warnings.json", data: Buffer.from('{"errors":[],"warnings":[]}') },
      { name: "hamina-clipboard.json", data: Buffer.from(JSON.stringify(clip)) },
      { name: "README.txt", data: ZIP_README },
      { name: "alignment-overlay.svg", data: Buffer.from(overlay) },
      { name: "frame-lock.json", data: Buffer.from(JSON.stringify(lock, null, 2)) },
    ]);
  }
  return {
    name,
    slug,
    imgName,
    openintent: oi,
    clipboard: clip,
    zip,
    stats,
    frame: publicFrame(frame),
    alignment: ALIGNMENT,
  };
}

module.exports = {
  ALIGNMENT,
  ZIP_README,
  MIN_AREA_M2,
  MAX_AREA_M2,
  MAX_BUILDINGS,
  ringAreaM2,
  simplifyRing,
  footprintsToClutter,
  buildClutter,
  siteName,
  simplifyDP,
  clipRingToRect,
  ringToOi,
  ringAreaPx,
};
