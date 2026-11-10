"use strict";

/**
 * Canopy on steep bare ground.
 *
 * Where no lidar covers a draw, canopy comes from the Meta/WRI canopy height
 * model and ESA WorldCover. Both read the grey-green, shadow-striped benches
 * of an open-pit mine as forest: on the Bingham Canyon export (2026-11-10)
 * most of the pit wall in the draw came out as Foliage, and WorldCover
 * marked the same benches as tree cover. A crater wall or a talus slope does
 * the same in a smaller way.
 *
 * steepTerrainZone builds a slope test from the DEM samples the export
 * already read. A canopy piece whose centre stands on a slope of at least
 * STEEP_SLOPE (rise over run, about 24 degrees at that sample spacing) is
 * read on the current photo with the same leafy-texture test the lidar
 * crowns use (photo-canopy.js), and is dropped with its stem when it shows
 * foliage on less than PIECE_LEAFY_MIN of its outline. A wooded mountainside
 * shows foliage and stays, and so do bare branches, deep shade, and tall
 * dark crowns (leafyShareSampler returns null for those). Flat ground is
 * never read, so parks, campgrounds and towns keep their canopy as before.
 */

const STEEP_SLOPE = 0.45;
/** Slope raster cells across the longer side of the frame. */
const ZONE_CELLS = 32;

function metersPerDegree(lat) {
  const r = (lat * Math.PI) / 180;
  return { x: 111320 * Math.cos(r), y: 110540 };
}

/** Least-squares plane slope (rise over run) through points [x, y, z] in metres. */
function planeSlope(pts) {
  const n = pts.length;
  if (n < 4) return null;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
    mz += p[2];
  }
  mx /= n;
  my /= n;
  mz /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (const p of pts) {
    const x = p[0] - mx;
    const y = p[1] - my;
    const z = p[2] - mz;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-9)) return null;
  const b = (sxz * syy - syz * sxy) / det;
  const c = (syz * sxx - sxz * sxy) / det;
  return Math.sqrt(b * b + c * c);
}

/**
 * Returns (lon, lat) => true on steep ground, or null when the DEM is too
 * sparse or nothing in the frame is steep.
 */
function steepTerrainZone(samples, frame, opts) {
  const o = opts || {};
  const minSlope = o.minSlope > 0 ? o.minSlope : STEEP_SLOPE;
  if (!frame || !Array.isArray(samples)) return null;
  const pts = samples.filter((s) => s && Number.isFinite(+s.lon) && Number.isFinite(+s.lat) && Number.isFinite(+s.z));
  if (pts.length < 16) return null;
  const west = Math.min(+frame.west, +frame.east);
  const east = Math.max(+frame.west, +frame.east);
  const south = Math.min(+frame.south, +frame.north);
  const north = Math.max(+frame.south, +frame.north);
  if (!(east > west && north > south)) return null;
  const m = metersPerDegree((south + north) / 2);
  const wM = (east - west) * m.x;
  const hM = (north - south) * m.y;
  const spacing = Math.sqrt((wM * hM) / pts.length);
  const radius = Math.max(1.6 * spacing, 20);
  const xyz = pts.map((s) => [(+s.lon - west) * m.x, (+s.lat - south) * m.y, +s.z]);
  const side = Math.max(wM, hM) / ZONE_CELLS;
  const cols = Math.max(1, Math.ceil(wM / side));
  const rows = Math.max(1, Math.ceil(hM / side));
  const steep = new Uint8Array(cols * rows);
  let any = 0;
  const r2 = radius * radius;
  for (let r = 0; r < rows; r++) {
    const cy = (r + 0.5) * side;
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * side;
      const near = [];
      for (const p of xyz) {
        const dx = p[0] - cx;
        const dy = p[1] - cy;
        if (dx * dx + dy * dy <= r2) near.push(p);
      }
      const s = planeSlope(near);
      if (s != null && s >= minSlope) {
        steep[r * cols + c] = 1;
        any++;
      }
    }
  }
  if (!any) return null;
  const test = function steepAt(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    const c = Math.floor(((lon - west) * m.x) / side);
    const r = Math.floor(((lat - south) * m.y) / side);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    return steep[r * cols + c] === 1;
  };
  test.steepCells = any;
  test.cells = cols * rows;
  return test;
}

function steepCanopyNote(dropped) {
  if (!(dropped > 0)) return "";
  return (
    "Left out " +
    dropped +
    " canopy piece" +
    (dropped === 1 ? "" : "s") +
    " on steep ground (rock walls, pit benches or crater slopes) that show no foliage on the photo."
  );
}

module.exports = { STEEP_SLOPE, planeSlope, steepTerrainZone, steepCanopyNote };
