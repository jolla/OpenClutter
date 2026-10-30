"use strict";

/**
 * Lidar canopy checked against the current photo (/dev hosts, 1.2.37).
 *
 * A 3DEP flight is a snapshot. At an RV park it measured the RVs, trailers
 * and awnings parked that day: their roof edges split the pulse the same way
 * a crown does, so a block of 3 to 4.5 m cells reads as a hedge of trees.
 * Trees cut since the flight still stand in the cloud as well. The photo is
 * newer and shows what is there now.
 *
 * Each canopy cell is read on the photo:
 * - leafy: a textured green pixel darker than a lawn, a dark conifer, or a
 *   textured grey-green crown (cypress, pine, eucalyptus).
 * - bare: smooth pavement, a gravel or dirt pitch, a mown lawn, or a bright
 *   smooth roof (an RV or trailer top).
 * A cell with under LEAFY_MIN leafy pixels is cleared when it is lower than any road
 * vehicle can stand (VEHICLE_TOP_M), or when the photo shows bare ground or a
 * roof across a fifth of it. A shaded cell (dark, not leafy, not bare) of a
 * tall crown stays. After tracing, a crown piece whose outline shows leafy
 * texture on less than PIECE_LEAFY_MIN of the photo is dropped with its stem
 * (pipeline.js): a crown that is there today shows foliage on its lit side.
 *
 * Only cells inside a mapped RV park, campground or mobile home park are
 * read (zones): that is where the flight caught vehicles that have moved
 * since. Orchards, yards and woods elsewhere keep the lidar canopy.
 *
 * The test runs only when the photo is leaf-on: enough cells of at least
 * GATE_TALL_M must show leafy texture. A winter photo of bare branches is
 * left alone. A mixed photo (green pines among bare oaks) passes that test,
 * so a cell or crown piece whose photo is mostly bare branches (textured,
 * mid-dark, brown or grey) or deep shade, and hardly any bright roof, is
 * kept as well: a leaf-off hardwood or a crown in the shade of taller trees
 * looks like that, a parked RV or a gravel pitch does not.
 * Canopy at least TREE_ONLY_M tall stays unless its photo is lit (a bright
 * share of BRIGHT_MAX or more): a leaf-off woods over leaf litter reads as
 * dirt pitch, and the gate above can pass on its grey-green cast.
 * Nothing is added.
 */

const { coniferPixel, openGroundPixel } = require("./surface-mask");
const exportMode = require("./export-mode");

/** No road vehicle stands this tall: the legal limit is 4 to 4.3 m. */
const VEHICLE_TOP_M = 5;
const LEAFY_MIN = 0.1;
const BARE_MIN = 0.2;
const GATE_TALL_M = 8;
const GATE_MIN_CELLS = 25;
const GATE_LEAFY = 0.2;
const GATE_SHARE = 0.2;
const CANOPY_MIN_M = 3;
/** A cell or crown this much bare branches or shade, and under BRIGHT_MAX bright, stays. */
const BRANCH_KEEP = 0.4;
const SHADE_LUMA = 45;
const BRIGHT_MAX = 0.15;
const BRIGHT_LUMA = 170;
/**
 * No vehicle, awning or park model stands this tall. A cell or crown piece
 * this tall is cleared only for a tree cut since the flight, and the photo
 * of that shows a lit pad, gravel or roof. A dark one is a leaf-off or
 * shaded crown over leaf litter and stays (feedback #11, export-mode
 * tallCanopyKeep).
 */
const TREE_ONLY_M = 12;

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Gray-world gains, so a warm or cool plate reads green the same way. */
function grayGains(photo) {
  const d = photo.data;
  const n = photo.width * photo.height;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let k = 0;
  for (let i = 0; i < n; i += 7) {
    sr += d[i * 4];
    sg += d[i * 4 + 1];
    sb += d[i * 4 + 2];
    k++;
  }
  if (!k || !(sr > 0) || !(sg > 0) || !(sb > 0)) return [1, 1, 1];
  const m = (sr + sg + sb) / 3;
  return [m / sr, m / sg, m / sb];
}

/** Luma spread over the 5 x 5 box around a pixel. */
function boxStd(d, w, h, x, y) {
  let n = 0;
  let s = 0;
  let s2 = 0;
  for (let yy = y - 2; yy <= y + 2; yy++) {
    if (yy < 0 || yy >= h) continue;
    for (let xx = x - 2; xx <= x + 2; xx++) {
      if (xx < 0 || xx >= w) continue;
      const i = (yy * w + xx) * 4;
      const v = luma(d[i], d[i + 1], d[i + 2]);
      s += v;
      s2 += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/** A crown on a leaf-on photo: textured green darker than lawn, or a dark conifer. */
function leafyPixel(r, g, b, std) {
  if (coniferPixel(r, g, b)) return true;
  const y = luma(r, g, b);
  return g >= r + 4 && g >= b - 3 && y >= 20 && y <= 100 && std >= 10;
}

/**
 * Grey-green foliage on the raw photo: a coastal cypress, pine or eucalyptus
 * crown is textured, darker than gravel or a roof, and yellower than a shadow
 * (green well above blue). Lawn is smooth, gravel and roofs are bright, and a
 * shadow on pavement is blue, so none of them pass.
 */
function foliagePixel(r, g, b, std) {
  const y = luma(r, g, b);
  return std >= 10 && y >= 18 && y <= 120 && g - b >= 12 && g >= r - 8;
}

function isLeafy(d, k, gains, std) {
  if (foliagePixel(d[k], d[k + 1], d[k + 2], std)) return true;
  return leafyPixel(d[k] * gains[0], d[k + 1] * gains[1], d[k + 2] * gains[2], std);
}

/**
 * Bare branches of a leaf-off hardwood: textured, mid-dark, brown or grey
 * (red at least blue, so not a blue shadow). Tested after leafyPixel.
 */
function branchPixel(r, g, b, std) {
  const y = luma(r, g, b);
  return std >= 12 && y >= 25 && y <= 150 && r >= b;
}

/** A bright smooth roof: an RV, trailer or park-model top. */
function roofPixel(r, g, b, std) {
  const y = luma(r, g, b);
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc ? (maxc - minc) / maxc : 0;
  return y >= 190 && sat < 0.15 && std < 14;
}

function barePixel(r, g, b, std) {
  if (roofPixel(r, g, b, std)) return true;
  if (std >= 11 || coniferPixel(r, g, b)) return false;
  return !!openGroundPixel(r, g, b, std);
}

/**
 * Read every canopy cell of the grid on the photo. frame maps lon/lat to the
 * photo (imgW x imgH, north up). Returns per-cell shares, or null when the
 * photo does not match the frame.
 */
function readCells(grid, photo, frame, inZone) {
  if (!grid || !grid.values || !photo || !photo.data || !frame) return null;
  if (!(photo.width === frame.imgW && photo.height === frame.imgH)) return null;
  const values = grid.values;
  const gw = grid.width | 0;
  const gh = grid.height | 0;
  const pw = photo.width;
  const ph = photo.height;
  const d = photo.data;
  const gains = grayGains(photo);
  const fx = pw / (+frame.east - +frame.west);
  const fy = ph / (+frame.north - +frame.south);
  const dLon = (+grid.east - +grid.west) / gw;
  const dLat = (+grid.north - +grid.south) / gh;
  const leafy = new Float32Array(gw * gh).fill(-1);
  const bare = new Float32Array(gw * gh).fill(-1);
  const branch = new Float32Array(gw * gh).fill(-1);
  const bright = new Float32Array(gw * gh).fill(-1);
  for (let gy = 0; gy < gh; gy++) {
    const latN = +grid.north - gy * dLat;
    const latS = latN - dLat;
    const y0 = Math.max(0, Math.floor((+frame.north - latN) * fy));
    const y1 = Math.min(ph - 1, Math.ceil((+frame.north - latS) * fy) - 1);
    if (y1 < y0) continue;
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (!(values[i] >= CANOPY_MIN_M)) continue;
      const lonW = +grid.west + gx * dLon;
      if (inZone && !inZone(lonW + dLon / 2, latN - dLat / 2)) continue;
      const x0 = Math.max(0, Math.floor((lonW - +frame.west) * fx));
      const x1 = Math.min(pw - 1, Math.ceil((lonW + dLon - +frame.west) * fx) - 1);
      if (x1 < x0) continue;
      let n = 0;
      let nl = 0;
      let nb = 0;
      let nr = 0;
      let nh = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = (y * pw + x) * 4;
          const std = boxStd(d, pw, ph, x, y);
          n++;
          if (luma(d[k], d[k + 1], d[k + 2]) >= BRIGHT_LUMA) nh++;
          if (isLeafy(d, k, gains, std)) nl++;
          else if (barePixel(d[k], d[k + 1], d[k + 2], std)) nb++;
          else if (branchPixel(d[k], d[k + 1], d[k + 2], std) || luma(d[k], d[k + 1], d[k + 2]) < SHADE_LUMA) nr++;
        }
      }
      if (n < 4) continue;
      leafy[i] = nl / n;
      bare[i] = nb / n;
      branch[i] = nr / n;
      bright[i] = nh / n;
    }
  }
  return { leafy, bare, branch, bright };
}

/**
 * Clear lidar canopy cells the current photo shows as a vehicle, a roof or
 * open ground. Mutates grid.values. Returns the counts for the stats.
 */
function checkCanopyOnPhoto(grid, photo, frame, inZone) {
  const out = { gate: false, tallCells: 0, tallLeafy: 0, cleared: 0, vehicleHeight: 0, bare: 0, branchKept: 0, tallKept: 0 };
  const keepTall = exportMode.isTallCanopyKeep();
  if (typeof inZone !== "function") return out;
  if (grid && typeof grid.values === "string") grid.values = Buffer.from(grid.values, "base64");
  const read = readCells(grid, photo, frame, inZone);
  if (!read) return out;
  const values = grid.values;
  for (let i = 0; i < values.length; i++) {
    if (!(values[i] >= GATE_TALL_M) || read.leafy[i] < 0) continue;
    out.tallCells++;
    if (read.leafy[i] >= GATE_LEAFY) out.tallLeafy++;
  }
  out.gate = out.tallCells >= GATE_MIN_CELLS && out.tallLeafy >= GATE_SHARE * out.tallCells;
  if (!out.gate) return out;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v >= CANOPY_MIN_M) || read.leafy[i] < 0 || read.leafy[i] >= LEAFY_MIN) continue;
    if (read.branch[i] >= BRANCH_KEEP && read.bright[i] < BRIGHT_MAX) {
      out.branchKept++;
      continue;
    }
    if (keepTall && v >= TREE_ONLY_M && read.bright[i] < BRIGHT_MAX) {
      out.tallKept++;
      continue;
    }
    if (v < VEHICLE_TOP_M) {
      values[i] = 0;
      out.vehicleHeight++;
    } else if (read.bare[i] >= BARE_MIN) {
      values[i] = 0;
      out.bare++;
    }
  }
  out.cleared = out.vehicleHeight + out.bare;
  if (out.cleared) {
    let nz = 0;
    for (let i = 0; i < values.length; i++) if (values[i] >= CANOPY_MIN_M) nz++;
    grid.nonzero = nz;
  }
  return out;
}

/**
 * Share of a crown outline (OpenIntent px, y up) that shows leafy texture on
 * the photo. Null (kept) when the ring has too few pixels on the photo, or
 * when it is mostly bare branches and not bright: a leaf-off hardwood.
 * opts.heightAt(lon, lat) and opts.frame give the canopy height under the
 * outline: a piece whose median is TREE_ONLY_M or more and that is not lit
 * is kept as well (tallCanopyKeep).
 */
function leafyShareSampler(photo, opts) {
  if (!photo || !photo.data || !(photo.width > 0) || !(photo.height > 0)) return null;
  const { data: d, width: w, height: h } = photo;
  const gains = grayGains(photo);
  const o = opts || {};
  const fr = o.frame;
  const heightAt =
    exportMode.isTallCanopyKeep() && typeof o.heightAt === "function" && fr && Number.isFinite(+fr.west) && Number.isFinite(+fr.north)
      ? o.heightAt
      : null;
  return function leafyShare(ring) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 24));
    let n = 0;
    let leafy = 0;
    let branch = 0;
    let bright = 0;
    const hs = heightAt ? [] : null;
    for (let y = Math.ceil(y0); y <= y1; y += step) {
      for (let x = Math.ceil(x0); x <= x1; x += step) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0];
          const yi = ring[i][1];
          const xj = ring[j][0];
          const yj = ring[j][1];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (!inside) continue;
        const row = h - 1 - Math.round(y);
        const col = Math.round(x);
        if (row < 0 || row >= h || col < 0 || col >= w) continue;
        const k = (row * w + col) * 4;
        n++;
        if (hs) {
          const lon = +fr.west + ((col + 0.5) / w) * (+fr.east - +fr.west);
          const lat = +fr.north - ((row + 0.5) / h) * (+fr.north - +fr.south);
          const v = heightAt(lon, lat);
          if (v >= CANOPY_MIN_M) hs.push(v);
        }
        const std = boxStd(d, w, h, col, row);
        if (luma(d[k], d[k + 1], d[k + 2]) >= BRIGHT_LUMA) bright++;
        if (isLeafy(d, k, gains, std)) leafy++;
        else if (!barePixel(d[k], d[k + 1], d[k + 2], std) && (branchPixel(d[k], d[k + 1], d[k + 2], std) || luma(d[k], d[k + 1], d[k + 2]) < SHADE_LUMA)) branch++;
      }
    }
    if (n < 6) return null;
    if (branch / n >= BRANCH_KEEP && bright / n < BRIGHT_MAX) return null;
    if (hs && hs.length >= n * 0.5 && bright / n < BRIGHT_MAX) {
      hs.sort((a, b) => a - b);
      if (hs[hs.length >> 1] >= TREE_ONLY_M) return null;
    }
    return leafy / n;
  };
}

function photoCanopyNote(res, cellM2) {
  if (!res || !res.cleared) return "";
  const m2 = Math.round((res.cleared * (cellM2 || 0)) / 10) * 10;
  return (
    "Left out " +
    (m2 > 0 ? m2.toLocaleString("en-US") + " m² of " : "") +
    "lidar canopy that the current photo shows as parked vehicles, roofs or open ground with no foliage."
  );
}

const ZONE_KINDS = new Set(["rv-site", "camp-zone", "mobile-park"]);

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Point test (lon, lat) for the mapped RV parks, campgrounds and mobile home
 * parks among the outdoor features, or null when the draw has none.
 */
function vehicleZoneTest(features) {
  const rings = [];
  for (const f of Array.isArray(features) ? features : []) {
    if (!f || !ZONE_KINDS.has(f.kind) || !Array.isArray(f.coords) || f.coords.length < 4) continue;
    let w = Infinity;
    let e = -Infinity;
    let s = Infinity;
    let n = -Infinity;
    for (const c of f.coords) {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    }
    rings.push({ ring: f.coords, w, e, s, n });
  }
  if (!rings.length) return null;
  return function inZone(lon, lat) {
    for (const r of rings) {
      if (lon < r.w || lon > r.e || lat < r.s || lat > r.n) continue;
      if (ringContains(r.ring, lon, lat)) return true;
    }
    return false;
  };
}

/**
 * Wrap a leafy share sampler so a crown outline (OpenIntent px, y up) whose
 * centre is outside every zone reads null (kept).
 */
function zonedShareSampler(sampler, inZone, frame) {
  if (typeof sampler !== "function" || typeof inZone !== "function" || !frame) return null;
  const w = frame.imgW;
  const h = frame.imgH;
  return function zonedShare(ring) {
    if (!ring || !ring.length) return null;
    let sx = 0;
    let sy = 0;
    for (const p of ring) {
      sx += p[0];
      sy += p[1];
    }
    const x = sx / ring.length;
    const row = h - 1 - sy / ring.length;
    const lon = +frame.west + ((x + 0.5) / w) * (+frame.east - +frame.west);
    const lat = +frame.north - ((row + 0.5) / h) * (+frame.north - +frame.south);
    if (!inZone(lon, lat)) return null;
    return sampler(ring);
  };
}

/** A lidar crown piece with leafy texture on less of its outline is gone. */
const PIECE_LEAFY_MIN = 0.2;

module.exports = {
  PIECE_LEAFY_MIN,
  vehicleZoneTest,
  zonedShareSampler,
  leafyShareSampler,
  checkCanopyOnPhoto,
  photoCanopyNote,
  readCells,
  leafyPixel,
  foliagePixel,
  barePixel,
  branchPixel,
  roofPixel,
  BRANCH_KEEP,
  VEHICLE_TOP_M,
  TREE_ONLY_M,
  BRIGHT_MAX,
  LEAFY_MIN,
  BARE_MIN,
};
