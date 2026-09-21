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

const MIN_AREA_M2 = 40;
const MAX_AREA_M2 = 15000;
const MAX_BUILDINGS = 300;

const ZIP_README =
  "Import this zip in Hamina (OpenIntent), then open hamina-clipboard.json, copy all, click map, paste\n";

const ALIGNMENT = [
  "Exact alignment (repeatable, any site):",
  "1. Import the OpenIntent zip in Hamina (Projects → Import → OpenIntent).",
  "   The zip’s meter dimensions ARE the geographic bbox (widthM × lengthM).",
  "   Extra files (hamina-clipboard.json, README.txt) are ignored on import.",
  "2. Delete any leftover attenuating objects.",
  "3. Open hamina-clipboard.json from the zip, copy all, click the map, paste.",
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

function simplifyRing(ring, maxPts = 20) {
  if (!ring || ring.length < 3) return ring;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  const step = Math.max(1, Math.ceil(closed.length / maxPts));
  const out = [];
  for (let i = 0; i < closed.length; i += step) out.push(closed[i]);
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

function ringToOi(pts, imgW, imgH) {
  if (!pts || pts.length < 3) return null;
  const out = [];
  for (const p of pts) {
    const x = Math.min(imgW, Math.max(0, p[0]));
    const y = Math.min(imgH, Math.max(0, p[1]));
    out.push(xyz(x, y));
  }
  const a = out[0].coordinate_xyz;
  const b = out[out.length - 1].coordinate_xyz;
  if (a.x !== b.x || a.y !== b.y) out.push(out[0]);
  if (out.length < 4) return null;
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
      stats.buildings++;
    }
  }
  return { oiAreas, clipZones, aabbs, stats };
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
          { width: frame.imgW, length: frame.imgH, height: 12, unit: "pixels" },
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
        reference_markers: [],
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
  const stats = {
    ...fp.stats,
    trees: veg.count,
    treesSource: treesSource || (veg.count ? "imagery-rgb" : "none"),
    zones: clip.attenuatingZones.length,
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
};
