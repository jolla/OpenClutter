"use strict";

/**
 * Sun direction on an aerial photo, read from the shadows that compact
 * light roofs (RVs, trailers, sheds, cars) cast on the ground beside them.
 *
 * Every light roof of 6 to 40 m2 on the photo is shifted 2 m in each of 24
 * directions; the share of dark ground it lands on is highest on the side
 * the shadows fall. A photo with no clear shadows (overcast, a dim photo, a
 * forest where shade is everywhere, too few roofs) reports ok: false, and
 * nothing that depends on shadows runs on it.
 *
 * Directions are in image pixels: x to the right, y down.
 */

const STEP = 2;
const DIRS = 24;
const SHIFT_M = 2;
const ROOF_M2 = [6, 40];
const MIN_ROOFS = 20;
const MIN_PEAK = 0.3;
const MIN_LIFT = 0.15;
const DARK_OF_MEDIAN = 0.55;
const WHITE_CHROMA = 30;

const cache = new Map();

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function plateKey(plate) {
  const d = plate.data;
  let h = 2166136261;
  const n = d.length;
  for (let k = 0; k < 97; k++) {
    const i = Math.floor((k * (n - 1)) / 96);
    h = Math.imul(h ^ d[i], 16777619) >>> 0;
  }
  return plate.width + "x" + plate.height + ":" + h;
}

/**
 * @param {{width:number,height:number,data:Uint8Array|Uint8ClampedArray}} plate RGBA, rows top-down
 * @param {number} mpu metres per photo pixel
 * @returns {{ok:boolean,dx:number,dy:number,deg:number,peak:number,lift:number,roofs:number,dark:number}}
 */
function photoSun(plate, mpu) {
  const none = { ok: false, dx: 0, dy: 0, deg: 0, peak: 0, lift: 0, roofs: 0, dark: 0 };
  if (!plate || !plate.data || !(plate.width > 8) || !(plate.height > 8) || !(mpu > 0)) return none;
  const key = plateKey(plate) + ":" + mpu.toFixed(4);
  if (cache.has(key)) return cache.get(key);
  const W = plate.width;
  const gw = Math.floor(W / STEP);
  const gh = Math.floor(plate.height / STEP);
  const n = gw * gh;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  const chroma = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = (gy * STEP * W + gx * STEP) * 4;
      const r = plate.data[i];
      const g = plate.data[i + 1];
      const b = plate.data[i + 2];
      const y = Math.round(luma(r, g, b));
      lum[gy * gw + gx] = y;
      chroma[gy * gw + gx] = Math.max(r, g, b) - Math.min(r, g, b);
      hist[y]++;
    }
  }
  let med = 0;
  for (let acc = 0; med < 255; med++) {
    acc += hist[med];
    if (acc >= n / 2) break;
  }
  let top = 255;
  for (let acc = 0; top > 0; top--) {
    acc += hist[top];
    if (acc >= n * 0.005) break;
  }
  const whiteMin = Math.max(170, Math.min(200, top - 25));
  const dark = DARK_OF_MEDIAN * med;
  const white = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (lum[k] >= whiteMin && chroma[k] <= WHITE_CHROMA) white[k] = 1;
  // Compact light roofs: 8-connected white components of roof size.
  const cellM2 = (STEP * mpu) * (STEP * mpu);
  const lab = new Int32Array(n).fill(-1);
  const keep = [];
  let roofs = 0;
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!white[s] || lab[s] >= 0) continue;
    const cells = [];
    lab[s] = s;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const x = k % gw;
      const y = (k / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (!white[j] || lab[j] >= 0) continue;
          lab[j] = s;
          stack.push(j);
        }
      }
    }
    const m2 = cells.length * cellM2;
    if (m2 < ROOF_M2[0] || m2 > ROOF_M2[1]) continue;
    roofs++;
    for (let k = 0; k < cells.length; k++) keep.push(cells[k]);
  }
  const shares = new Float64Array(DIRS);
  const shift = SHIFT_M / (STEP * mpu);
  for (let d = 0; d < DIRS; d++) {
    const a = (2 * Math.PI * d) / DIRS;
    const ox = Math.round(Math.cos(a) * shift);
    const oy = Math.round(Math.sin(a) * shift);
    let seen = 0;
    let dk = 0;
    for (let q = 0; q < keep.length; q++) {
      const k = keep[q];
      const x = (k % gw) + ox;
      const y = ((k / gw) | 0) + oy;
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      const j = y * gw + x;
      if (white[j]) continue;
      seen++;
      if (lum[j] < dark) dk++;
    }
    shares[d] = seen ? dk / seen : 0;
  }
  let best = 0;
  for (let d = 1; d < DIRS; d++) if (shares[d] > shares[best]) best = d;
  const sorted = Array.from(shares).sort((p, q) => p - q);
  const mid = (sorted[DIRS / 2 - 1] + sorted[DIRS / 2]) / 2;
  const peak = shares[best];
  const a = (2 * Math.PI * best) / DIRS;
  const out = {
    ok: roofs >= MIN_ROOFS && peak >= MIN_PEAK && peak - mid >= MIN_LIFT,
    dx: Math.cos(a),
    dy: Math.sin(a),
    deg: (360 * best) / DIRS,
    peak: Math.round(peak * 100) / 100,
    lift: Math.round((peak - mid) * 100) / 100,
    roofs,
    dark,
  };
  if (cache.size >= 4) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

/**
 * Share of dark ground a shape lands on when shifted along a direction.
 * Pixels the shape itself covers (or `skip` marks) are not counted.
 * @param {{width:number,height:number,data:Uint8Array}} plate
 * @param {Array<number[]>} px shape pixels [x, y] in plate pixels
 * @param {number} dx unit direction x (image)
 * @param {number} dy unit direction y (image, down)
 * @param {number[]} metres shift lengths
 * @param {number} mpu
 * @param {number} dark luma below which a pixel is shadow
 * @param {(x:number,y:number)=>boolean} [skip]
 * @returns {number|null} null when too few pixels could be read
 */
function shiftedDarkShare(plate, px, dx, dy, metres, mpu, dark, skip) {
  const inside = new Set();
  for (let k = 0; k < px.length; k++) inside.add(px[k][1] * plate.width + px[k][0]);
  let seen = 0;
  let dk = 0;
  for (let m = 0; m < metres.length; m++) {
    const ox = (dx * metres[m]) / mpu;
    const oy = (dy * metres[m]) / mpu;
    for (let k = 0; k < px.length; k++) {
      const x = Math.round(px[k][0] + ox);
      const y = Math.round(px[k][1] + oy);
      if (x < 0 || y < 0 || x >= plate.width || y >= plate.height) continue;
      if (inside.has(y * plate.width + x)) continue;
      if (skip && skip(x, y)) continue;
      const i = (y * plate.width + x) * 4;
      seen++;
      if (luma(plate.data[i], plate.data[i + 1], plate.data[i + 2]) < dark) dk++;
    }
  }
  return seen >= 5 ? dk / seen : null;
}

module.exports = { photoSun, shiftedDarkShare, _cache: cache };
