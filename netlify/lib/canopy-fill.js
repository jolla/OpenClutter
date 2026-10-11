"use strict";

/**
 * Fill canopy cells the height model left empty.
 * A dark conifer pixel, or an ESA WorldCover tree cell, becomes a measured
 * top. Grass and cropland stay empty unless the pixel is spruce. Shrub on
 * the 10 m map is not a crown by itself. A neighbor height is used when one
 * exists. Otherwise a stand is 14 m (conifer), 10 m (a woody shrub), or 12 m.
 */

const { gridSize } = require("./canopy-height");
const { coniferPixel, luma } = require("./surface-mask");
const { TREE, SHRUB, GRASS, CROP, WATER } = require("./worldcover");

const CONIFER_H = 14;
const WOOD_H = 12;
const SHRUB_H = 10;

function localStd(data, w, h, x, y) {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  const offs = [
    [0, 0],
    [4, 0],
    [-4, 0],
    [0, 4],
    [0, -4],
  ];
  for (let k = 0; k < offs.length; k++) {
    const xx = x + offs[k][0];
    const yy = y + offs[k][1];
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const i = (yy * w + xx) * 4;
    const Y = luma(data[i], data[i + 1], data[i + 2]);
    n++;
    sum += Y;
    sum2 += Y * Y;
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

function sampleRgb(image, frame, lon, lat) {
  const data = image && image.data;
  const w = image && image.width | 0;
  const h = image && image.height | 0;
  if (!data || w < 2 || h < 2) return null;
  const x = Math.round(((lon - frame.west) / (frame.east - frame.west || 1e-9)) * (w - 1));
  const y = Math.round(((frame.north - lat) / (frame.north - frame.south || 1e-9)) * (h - 1));
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const i = (y * w + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], x, y, w, h, data };
}

function neighborHeight(values, w, h, x, y) {
  const acc = [];
  for (let dy = -6; dy <= 6; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -6; dx <= 6; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const v = values[yy * w + xx] || 0;
      if (v >= 3 && v < 80) acc.push(v);
    }
  }
  if (!acc.length) return 0;
  acc.sort((a, b) => a - b);
  return acc[acc.length >> 1];
}

function emptyGrid(frame) {
  const size = gridSize(frame);
  return {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
    width: size.width,
    height: size.height,
    values: new Uint8Array(size.width * size.height),
    nonzero: 0,
  };
}

function copyGrid(grid) {
  const w = grid.width | 0;
  const h = grid.height | 0;
  const src = grid.values;
  const values = new Uint8Array(w * h);
  const n = Math.min(values.length, src ? src.length : 0);
  for (let i = 0; i < n; i++) values[i] = src[i] || 0;
  return {
    west: +grid.west,
    south: +grid.south,
    east: +grid.east,
    north: +grid.north,
    width: w,
    height: h,
    values,
    nonzero: 0,
  };
}

/**
 * Textured green that is lighter than a spruce. A smooth lawn stays out:
 * the variance gate is what separates a crown from a pasture.
 */
function broadleafPixel(r, g, b) {
  const Y = luma(r, g, b);
  const exg = 2 * g - r - b;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc ? (maxc - minc) / maxc : 0;
  return Y >= 70 && Y <= 145 && g >= r + 12 && g >= b + 8 && exg >= 28 && sat >= 0.16;
}

/**
 * @param {object|null} grid CHM window, or null to start from the aerial
 * @param {{frame:object, image:object, worldcover?:{sample:Function}}} opts
 */
function fillCanopyGaps(grid, opts) {
  const frame = opts && opts.frame;
  const image = opts && opts.image;
  if (!frame || !image || !image.data) return grid;
  const base = grid && grid.values && grid.width > 1 ? copyGrid(grid) : emptyGrid(frame);
  const values = base.values;
  const w = base.width;
  const h = base.height;
  const cover = opts && opts.worldcover;
  const dLon = +base.east - +base.west || 1e-9;
  const dLat = +base.north - +base.south || 1e-9;
  const woody = new Uint8Array(w * h);
  const open = new Uint8Array(w * h);
  const bare = new Uint8Array(w * h);
  let filled = 0;
  for (let y = 0; y < h; y++) {
    const lat = +base.north - ((y + 0.5) / h) * dLat;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lon = +base.west + ((x + 0.5) / w) * dLon;
      const px = sampleRgb(image, frame, lon, lat);
      const cls = cover && typeof cover.sample === "function" ? cover.sample(lon, lat) | 0 : 0;
      if (cls === WATER) continue;
      if (cls === GRASS || cls === CROP) open[i] = 1;
      // Shrub and bare ground are not a place to grow a crown. Measured
      // height still stands. The sand and the creosote stay empty.
      if (cls === SHRUB || cls === 60) bare[i] = 1;
      let dark = false;
      let leaf = false;
      let rough = false;
      if (px) {
        const std = localStd(px.data, px.w, px.h, px.x, px.y);
        dark = coniferPixel(px.r, px.g, px.b);
        leaf = broadleafPixel(px.r, px.g, px.b);
        rough = std >= 8;
        // A spruce crown is often smoother than the variance gate used for a
        // broadleaf. A flat shadow (std under 3) can only grow from a neighbor.
        // Grass and crop hide dark stands, so a spruce still seeds there.
        // A broadleaf color on that same field is a meadow, not a crown.
        // Shrub and bare ground stay empty: dark creosote is not a spruce woods.
        if (!bare[i]) {
          if (dark && std < 3) woody[i] = 1;
          if (dark && std >= 3) woody[i] = 2;
          else if (leaf && rough && !open[i]) woody[i] = 2;
        }
      }
      if (values[i] >= 3) continue;
      const near = neighborHeight(values, w, h, x, y);
      // A 10 m tree label around a crown the height model already measured
      // is the lawn beside that crown. Seeding it merges the stand into a
      // blob and the outline misses the trees. A mapped wood with no
      // measured neighbor is still a gap.
      // Color on shrub or bare ground is creosote and shadow, not a woods.
      // Measured height is already in the grid. A spruce on grass still seeds.
      const seed = (woody[i] === 2 && !bare[i]) || (cls === TREE && !(near >= 3));
      if (!seed) continue;
      const height = near >= 3 ? near : dark ? CONIFER_H : cls === SHRUB ? SHRUB_H : WOOD_H;
      values[i] = height;
      filled++;
    }
  }
  // A few steps into a woody neighbor pull a shadowed crown in. A flat
  // shadow still needs two canopy neighbors, so a lone dark pixel stays empty.
  for (let pass = 0; pass < 3; pass++) {
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (values[i] >= 3 || !woody[i]) continue;
        let near = 0;
        let touch = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const v = values[yy * w + xx] || 0;
            if (v >= 3 && v < 80) {
              touch++;
              if (v > near) near = v;
            }
          }
        }
        if (touch >= 2 && near >= 3) add.push([i, near]);
      }
    }
    if (!add.length) break;
    for (let k = 0; k < add.length; k++) {
      if (values[add[k][0]] >= 3) continue;
      values[add[k][0]] = add[k][1];
      filled++;
    }
  }
  // One cell past the stand, about 2 m, so a crown the grid clipped still
  // covers the trees at its edge.
  const halo = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (values[i] >= 3) continue;
      let near = 0;
      let touch = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const v = values[(y + dy) * w + (x + dx)] || 0;
          if (v >= 3 && v < 80) {
            touch++;
            if (v > near) near = v;
          }
        }
      }
      if (!(touch >= 3 && near >= 3)) continue;
      // A mapped field stays open. A grass cell that is actually spruce,
      // even just at the edge of the 2 m cell, is still the stand.
      if (open[i] && !woody[i] && !coniferInCell(image, frame, x, y, w, h, dLon, dLat)) continue;
      if (bare[i] && !woody[i]) continue;
      halo.push([i, near]);
    }
  }
  for (let k = 0; k < halo.length; k++) {
    values[halo[k][0]] = halo[k][1];
    filled++;
  }
  let nz = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= 2) nz++;
  base.nonzero = nz;
  base.filled = filled;
  return base;
}

function coniferInCell(image, frame, x, y, w, h, dLon, dLat) {
  const lon = +frame.west + ((x + 0.5) / w) * dLon;
  const lat = +frame.north - ((y + 0.5) / h) * dLat;
  const ox = dLon / w;
  const oy = dLat / h;
  const offs = [
    [0, 0],
    [0.4, 0],
    [-0.4, 0],
    [0, 0.4],
    [0, -0.4],
  ];
  for (let k = 0; k < offs.length; k++) {
    const px = sampleRgb(image, frame, lon + offs[k][0] * ox, lat - offs[k][1] * oy);
    if (px && coniferPixel(px.r, px.g, px.b)) return true;
  }
  return false;
}

module.exports = {
  CONIFER_H,
  WOOD_H,
  fillCanopyGaps,
};
