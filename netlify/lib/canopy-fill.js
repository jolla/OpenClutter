"use strict";

/**
 * Fill canopy cells the height model left empty, only beside a measured crown.
 * A dark conifer pixel or an ESA WorldCover tree cell within about 4 m of a
 * measured top becomes that neighbor's height. A mown lawn, a dirt pitch, and
 * a road stay empty even when the 10 m map calls them trees. A spruce on
 * grass still grows from a measured crown. Shrub and bare ground do not.
 */

const { gridSize } = require("./canopy-height");
const { coniferPixel, luma, openGroundPixel } = require("./surface-mask");
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

function neighborHeight(values, w, h, x, y, rad) {
  const reach = rad > 0 ? rad : 2;
  const acc = [];
  for (let dy = -reach; dy <= reach; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -reach; dx <= reach; dx++) {
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

function pointInRing(ring, x, y) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi === yj) continue;
    if ((yi > y) === (yj > y)) continue;
    const xi = ring[i][0];
    const xj = ring[j][0];
    if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function onOpenRun(rings, lon, lat) {
  if (!rings || !rings.length) return false;
  for (let i = 0; i < rings.length; i++) {
    if (pointInRing(rings[i], lon, lat)) return true;
  }
  return false;
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
function coverClasses(grid, cover) {
  if (!grid || !cover || typeof cover.sample !== "function") return null;
  const w = grid.width | 0;
  const h = grid.height | 0;
  if (w < 2 || h < 2) return null;
  const out = new Uint8Array(w * h);
  const dLon = +grid.east - +grid.west || 1e-9;
  const dLat = +grid.north - +grid.south || 1e-9;
  for (let y = 0; y < h; y++) {
    const lat = +grid.north - ((y + 0.5) / h) * dLat;
    for (let x = 0; x < w; x++) {
      const lon = +grid.west + ((x + 0.5) / w) * dLon;
      out[y * w + x] = cover.sample(lon, lat) | 0;
    }
  }
  return out;
}

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
  const run = new Uint8Array(w * h);
  const ground = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h);
  const klass = new Uint8Array(w * h);
  const openRuns = opts && opts.openRuns;
  let filled = 0;
  for (let y = 0; y < h; y++) {
    const lat = +base.north - ((y + 0.5) / h) * dLat;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lon = +base.west + ((x + 0.5) / w) * dLon;
      const px = sampleRgb(image, frame, lon, lat);
      const cls = opts && opts.classes ? opts.classes[i] | 0 : cover && typeof cover.sample === "function" ? cover.sample(lon, lat) | 0 : 0;
      klass[i] = cls;
      if (cls === WATER) continue;
      if (cls === GRASS || cls === CROP) open[i] = 1;
      // Shrub and bare ground are not a place to grow a crown. Measured
      // height still stands. The sand and the creosote stay empty.
      if (cls === SHRUB || cls === 60) bare[i] = 1;
      // A mapped ski run is wide enough to cover the woods beside it.
      // Color does not grow a crown there. A height already measured stays.
      if (onOpenRun(openRuns, lon, lat)) run[i] = 1;
      if (px) {
        const std = localStd(px.data, px.w, px.h, px.x, px.y);
        const spruce = coniferPixel(px.r, px.g, px.b);
        const leaf = broadleafPixel(px.r, px.g, px.b);
        const rough = std >= 8;
        if (spruce && luma(px.r, px.g, px.b) <= 70) dark[i] = 1;
        // A mown lawn, a dirt pitch, and a road stay open even when the
        // 10 m map calls them trees. A spruce pixel is not that ground.
        if (openGroundPixel(px.r, px.g, px.b, std)) ground[i] = 1;
        // A spruce crown is often smoother than the variance gate used for a
        // broadleaf. A flat shadow (std under 3) can only grow from a neighbor.
        // Grass and crop hide dark stands, so a spruce still seeds there.
        // A broadleaf color on that same field is a meadow, not a crown.
        // Shrub and bare ground stay empty: dark creosote is not a spruce woods.
        if (!bare[i] && !ground[i]) {
          if (spruce && std < 3) woody[i] = 1;
          if (spruce && std >= 3) woody[i] = 2;
          else if (leaf && rough && !open[i]) woody[i] = 2;
        }
      }
    }
  }
  // A lawn, a pitch, or a road is not a crown, even when the height model
  // marked that grass. The aerial is the check: a spruce pixel is not ground,
  // and a textured crown is not a mown field. Clearing it before the seed
  // pass stops one spike from growing across the pitch.
  for (let i = 0; i < values.length; i++) {
    if (ground[i]) values[i] = 0;
  }
  // Seeds read the measured grid only. Writing heights in the same pass used
  // to walk a WorldCover tree label across a whole field from one crown.
  const seeded = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (values[i] >= 3 || run[i] || ground[i] || bare[i]) continue;
      const near = neighborHeight(values, w, h, x, y);
      const cls = klass[i];
      // A mapped tree cell beside a measured crown is a gap the height model
      // missed. The same label on a lawn, with no crown next to it, is not.
      // A mapped tree, or a spruce pixel, fills only next to a crown the
      // height model already measured. A dark patch with no measured neighbor
      // used to paint the lawn between stands.
      const treeSeed = cls === TREE && near >= 3;
      const colorSeed = woody[i] === 2 && dark[i] && near >= 3;
      if (!treeSeed && !colorSeed) continue;
      seeded.push([i, near]);
    }
  }
  for (let k = 0; k < seeded.length; k++) {
    const i = seeded[k][0];
    if (values[i] >= 3) continue;
    values[i] = seeded[k][1];
    filled++;
  }
  // A few steps into a woody neighbor pull a shadowed crown in. A flat
  // shadow still needs two canopy neighbors, so a lone dark pixel stays empty.
  // Textured spruce can walk further than a smooth shadow, and it still
  // stops at a lawn, a pitch, or a road.
  for (let pass = 0; pass < 8; pass++) {
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (values[i] >= 3 || !woody[i] || run[i] || ground[i]) continue;
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
        const need = woody[i] === 2 ? 1 : 2;
        if (touch >= need && near >= 3) add.push([i, near]);
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
      if (values[i] >= 3 || run[i] || ground[i]) continue;
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
  // A dark woods the height model missed is still a woods. A speck of shadow
  // on a lawn is not: the stand has to be large, or already touch a crown.
  const seenDark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (seenDark[start] || values[start] >= 3 || !dark[start] || woody[start] !== 2) continue;
      if (ground[start] || bare[start] || run[start]) continue;
      const comp = [];
      const stack = [start];
      seenDark[start] = 1;
      let touchH = 0;
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = cx + dx;
            if (xx < 0 || xx >= w) continue;
            const n = yy * w + xx;
            const v = values[n] || 0;
            if (v >= 3 && v < 80 && v > touchH) touchH = v;
            if (seenDark[n] || v >= 3 || !dark[n] || woody[n] !== 2) continue;
            if (ground[n] || bare[n] || run[n]) continue;
            seenDark[n] = 1;
            stack.push(n);
          }
        }
      }
      // About 200 m² beside a crown, or a stand of its own above about 600 m².
      if (comp.length < 40) continue;
      if (!touchH && comp.length < 120) continue;
      const hgt = touchH || CONIFER_H;
      for (let i = 0; i < comp.length; i++) {
        if (values[comp[i]] >= 3) continue;
        values[comp[i]] = hgt;
        filled++;
      }
    }
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
  coverClasses,
};
