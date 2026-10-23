"use strict";

/**
 * RV shell (1.2.25, /dev hosts; rvShell:false turns it off).
 *
 * Hamina attenuating objects are volumetric (dB per metre of path), so a
 * solid RV block is right across its width but far too lossy along its
 * length: 10 m at 9 dB/m is 90 dB, while a real RV blocks about 20 to 27 dB
 * end-on. A hollow RV is closer: four flat walls on the same footprint
 * (Hamina walls are flat dB, no thickness) plus a thin roof slab, which is
 * an attenuating object with a bottom height. Any straight path through
 * the body crosses two walls whichever way it goes.
 *
 * The footprint, height and terrain seat are the RV's own. Nothing is
 * added that the block did not already cover. An area whose name does not
 * parse stays a solid block at its own dB/m (9 on /dev).
 *
 * Checked in Hamina (test-eu, 2026-10-23): 28 walls and 13 objects imported
 * in place, and an AP 10 m off the side or the end of an RV read about
 * 24 dB lower behind it.
 */

/** dB per wall at 5 GHz. Two walls give 24 dB, the best estimate for a through-RV path. */
const RV_WALL_DB = 12;
/** Sandwich sidewall, about 5 cm. Hamina ignores thickness for walls. */
const RV_WALL_THICKNESS_M = 0.05;
/**
 * Roof slab: 0.2 m thick at 30 dB/m, 6 dB straight down. A slab is
 * volumetric, so a ray at elevation angle a loses 6 / sin(a): 12 dB at 30
 * degrees, 35 dB at 10, 69 dB at 5. Pole APs see RV roofs at 3 to 15
 * degrees, so a 12 dB roof (69 to 138 dB at 10 to 5 degrees) would paint a
 * deep stripe behind every RV. 6 dB is the compromise; see RV-SHELL.md.
 */
const RV_ROOF_M = 0.2;
const RV_ROOF_DB = 6;
const RV_ROOF_DB_PER_M = RV_ROOF_DB / RV_ROOF_M;
const RV_SHELL_COLOR = "#8A9098";
const TRAILER_SHELL_COLOR = "#A39888";

const SHELL_NAME = /^(RV|Trailer) (\d+\.\d)(?: @ (\d+\.\d))?$/;

function round1(v) {
  return Math.round(v * 10) / 10;
}

function parseShellArea(a) {
  const m = a && a.area_material;
  if (!m) return null;
  const p = SHELL_NAME.exec(String(m.name || ""));
  if (!p) return null;
  const coords = a.area && a.area.coordinates;
  if (!coords || coords.length < 4) return null;
  return { label: p[1], height: Number(p[2]), base: p[3] != null ? Number(p[3]) : 0, coords };
}

function seatSuffix(base) {
  return base > 0 ? " @ " + base.toFixed(1) : "";
}

function wallMaterial(label, height, base) {
  const mat = {
    name: label + " shell " + height.toFixed(1) + seatSuffix(base),
    itu_material_type: "ITU_R_METAL",
    rf_properties: {
      attenuation_flat: RV_WALL_DB,
      attenuation_per_m: round1(RV_WALL_DB / RV_WALL_THICKNESS_M),
    },
    thickness_m: RV_WALL_THICKNESS_M,
    top_height: round1(base + height),
    display_color: label === "Trailer" ? TRAILER_SHELL_COLOR : RV_SHELL_COLOR,
  };
  if (base > 0) mat.bottom_height = round1(base);
  return mat;
}

function roofMaterial(label, height, base, roofDb) {
  const top = round1(base + height);
  return {
    name: label + " roof " + height.toFixed(1) + seatSuffix(base),
    rf_properties: { attenuation_per_m: round1(roofDb / RV_ROOF_M) },
    top_height: top,
    bottom_height: round1(top - RV_ROOF_M),
    display_color: label === "Trailer" ? TRAILER_SHELL_COLOR : RV_SHELL_COLOR,
  };
}

/**
 * Split RV and Trailer blocks into walls plus a roof slab.
 * Returns the new area list, the wall segments, and the materials used.
 */
function shellRvAreas(areas, opts) {
  const roofDb = opts && Number(opts.roofDb) > 0 ? Number(opts.roofDb) : RV_ROOF_DB;
  const out = [];
  const walls = [];
  const wallMats = new Map();
  const roofMats = new Map();
  let shells = 0;
  for (const a of areas || []) {
    const s = parseShellArea(a);
    if (!s) {
      out.push(a);
      continue;
    }
    const wm = wallMaterial(s.label, s.height, s.base);
    if (!wallMats.has(wm.name)) wallMats.set(wm.name, wm);
    const rm = roofMaterial(s.label, s.height, s.base, roofDb);
    if (!roofMats.has(rm.name)) roofMats.set(rm.name, rm);
    const pts = s.coords.map((c) => c.coordinate_xyz);
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (p.x === q.x && p.y === q.y) continue;
      walls.push({ wall_type: wm.name, start_point: { x: p.x, y: p.y }, end_point: { x: q.x, y: q.y } });
    }
    out.push({ area: a.area, area_material: { ...rm, rf_properties: { ...rm.rf_properties } } });
    shells++;
  }
  return {
    areas: out,
    walls,
    wallMaterials: [...wallMats.values()],
    roofMaterials: [...roofMats.values()],
    shells,
  };
}

/** Straight-line loss, for the notes and tests. */
function shellLossDb(wallsCrossed, roofPathM) {
  return wallsCrossed * RV_WALL_DB + (roofPathM || 0) * RV_ROOF_DB_PER_M;
}

module.exports = {
  RV_WALL_DB,
  RV_ROOF_M,
  RV_ROOF_DB,
  RV_ROOF_DB_PER_M,
  shellRvAreas,
  shellLossDb,
  parseShellArea,
};
