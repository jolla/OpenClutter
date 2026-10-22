"use strict";

/**
 * Cast shadows read from the aerial.
 *
 * A standing object throws a dark band on the side away from the sun. The
 * photo has one sun, so every real roof in the draw shades the same side,
 * and the band is longer the taller the roof. This module reads that from
 * the pixels already decoded for the roof checks:
 *
 * - sceneShadow: which way the shadows fall and how many metres of shadow
 *   one metre of height throws, learned from footprints whose height came
 *   from a measurement (lidar, a source height, floors). With too few such
 *   roofs, or bands that are not clearly darker on one side, the scene is
 *   not confident and nothing here acts.
 * - shadowlessFootprints: a vector outline (Overture, USA Structures,
 *   Microsoft) whose shadow side is lit open ground in a confident scene.
 *   That outline is a building that was torn down after the source traced
 *   it. The pavement rule cannot see it when the slab left behind is bright
 *   concrete, which reads like a light roof. To be dropped it must also
 *   show no colour step at its edge, sit on lit bare ground (not under
 *   trees, in shade, or off the plate), not be far brighter than the
 *   scene's ground (membrane roofs, tent tops), and not sit on a flat
 *   surface that ends in shade (an outline drawn inside a larger roof).
 *   Photos coarser than GHOST_MAX_MPP are left alone.
 *
 * Nothing here adds a building. A footprint whose shadow side falls on
 * another roof, off the photo, or on too few pixels is undecided and kept.
 */

const { featureExteriorRings } = require("./pipeline");

const DIRS = 16;
/** Edge samples every metre. Band samples out to this many metres. */
const BAND_M = [0.7, 1.4, 2.1, 2.8];
const MIN_BAND_SAMPLES = 16;
/** A roof at least this large votes on the sun. */
const REF_MIN_M2 = 300;
const REF_MIN_H = 4;
const REF_MIN_COUNT = 3;
/** Band dark share of a roof that throws a shadow, and of one that does not. */
const LIT_MAX = 0.12;
const SHADED_MIN = 0.55;
const EDGE_M = 1;
const EDGE_STEP_MAX = 0.12;
const MURKY_MAX = 0.3;
const RAISED_WALK_M = 40;
const RAISED_MAX = 0.4;
const BRIGHT_MAX = 1.35;
const GHOST_MAX_MPP = 0.5;
/** Sources that measured a height. A guessed or default height does not vote. */
/** Sources whose height is a survey of the roof itself. */
const SURVEYED = { "usgs-lidar": true, nls: true };
/** Source-height scales agree when the upper quartile is within this factor of the lower. */
const K_AGREE = 1.35;
const MEASURED = { "usgs-lidar": true, overture: true, "overture-floors": true, osm: true, "osm-part": true, fema: true, nls: true, "ms-global": true };

function luma(d, i) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/** Photo context: raw pixels, metres per raw pixel, a dark threshold, and a roof mask. */
function photoContext(raw, frame, features) {
  if (!raw || !raw.data || !frame || !(frame.imgW > 0) || !(frame.mpuX > 0)) return null;
  const W = raw.width;
  const H = raw.height;
  const sx = W / frame.imgW;
  const sy = H / frame.imgH;
  const mpp = frame.mpuX / sx;
  // Shadow length on a 1 m pixel is two or three pixels. Too coarse to read.
  if (!(mpp > 0) || mpp > 0.75) return null;
  const lumas = [];
  const step = Math.max(4, Math.round(Math.sqrt((W * H) / 40000)));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) lumas.push(luma(raw.data, (y * W + x) * 4));
  }
  lumas.sort((a, b) => a - b);
  const median = lumas[lumas.length >> 1] || 128;
  const dark = Math.min(80, Math.max(35, median * 0.5));
  const rings = [];
  const list = features || [];
  for (let f = 0; f < list.length; f++) {
    const ext = featureExteriorRings(list[f] && list[f].geometry);
    for (let r = 0; r < ext.length; r++) {
      const px = ext[r].map((q) => [
        ((q[0] - frame.west) / (frame.east - frame.west)) * W,
        ((frame.north - q[1]) / (frame.north - frame.south)) * H,
      ]);
      rings.push({ feature: f, px });
    }
  }
  // Coarse roof mask at 4 raw pixels per cell: is this pixel under any outline?
  const cs = 4;
  const mw = Math.ceil(W / cs);
  const mh = Math.ceil(H / cs);
  const mask = new Uint8Array(mw * mh);
  for (let r = 0; r < rings.length; r++) {
    const px = rings[r].px;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of px) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    rings[r].box = [x0, y0, x1, y1];
    const cx0 = Math.max(0, Math.floor(x0 / cs));
    const cx1 = Math.min(mw - 1, Math.floor(x1 / cs));
    const cy0 = Math.max(0, Math.floor(y0 / cs));
    const cy1 = Math.min(mh - 1, Math.floor(y1 / cs));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (pointInRing((cx + 0.5) * cs, (cy + 0.5) * cs, px)) mask[cy * mw + cx] = 1;
      }
    }
  }
  function underRoof(x, y) {
    const cx = Math.floor(x / cs);
    const cy = Math.floor(y / cs);
    if (cx < 0 || cy < 0 || cx >= mw || cy >= mh) return true;
    return mask[cy * mw + cx] === 1;
  }
  function isDark(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return null;
    return luma(raw.data, (iy * W + ix) * 4) < dark;
  }
  return { raw, frame, W, H, mpp, dark, median, rings, underRoof, isDark };
}

function dirVec(k) {
  const a = (k / DIRS) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
}

/** Edge points (raw px) with outward normals, one per metre. */
function edgePoints(ctx, px) {
  const out = [];
  const ccw = signedArea(px) > 0;
  const stepPx = 1 / ctx.mpp;
  for (let i = 0; i < px.length - 1; i++) {
    const a = px[i];
    const b = px[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    // Image y points down. With positive shoelace area the outward normal is (dy, -dx).
    const nx = ccw ? dy / len : -dy / len;
    const ny = ccw ? -dx / len : dx / len;
    const n = Math.max(1, Math.floor(len / stepPx));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ x: a[0] + dx * t, y: a[1] + dy * t, nx, ny });
    }
  }
  return out;
}

/** Dark share of the band just outside the edges that face direction d. */
function bandScore(ctx, edges, d) {
  let n = 0;
  let dark = 0;
  for (const e of edges) {
    if (e.nx * d[0] + e.ny * d[1] < 0.5) continue;
    for (const m of BAND_M) {
      const x = e.x + (d[0] * m) / ctx.mpp;
      const y = e.y + (d[1] * m) / ctx.mpp;
      if (ctx.underRoof(x, y)) continue;
      const v = ctx.isDark(x, y);
      if (v == null) continue;
      n++;
      if (v) dark++;
    }
  }
  return { n, share: n ? dark / n : 0 };
}

/** Metres of shadow beyond the edges facing d (median of uncensored runs). */
function shadowLengthM(ctx, edges, d) {
  const runs = [];
  const stepM = Math.max(0.3, ctx.mpp);
  for (let i = 0; i < edges.length; i += 2) {
    const e = edges[i];
    if (e.nx * d[0] + e.ny * d[1] < 0.7) continue;
    let t = stepM;
    let last = 0;
    let gap = 0;
    let censored = false;
    while (t < 60) {
      const x = e.x + (d[0] * t) / ctx.mpp;
      const y = e.y + (d[1] * t) / ctx.mpp;
      if (ctx.underRoof(x, y)) {
        censored = true;
        break;
      }
      const v = ctx.isDark(x, y);
      if (v == null) {
        censored = true;
        break;
      }
      if (v) {
        last = t;
        gap = 0;
      } else if (++gap > 2) break;
      t += stepM;
    }
    if (!censored && last > 0) runs.push(last);
  }
  if (runs.length < 6) return null;
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1];
}

function measuredHeight(feature) {
  const p = (feature && feature.properties) || {};
  const h = Number(p.height);
  if (!(h >= REF_MIN_H) || h > 300) return 0;
  if (!MEASURED[p.heightSource || p.geomSource || ""]) return 0;
  return h;
}

function ringAreaM2(ctx, px) {
  return Math.abs(signedArea(px)) * ctx.mpp * ctx.mpp;
}

/**
 * Which way the shadows fall, and metres of shadow per metre of height.
 * @returns {{confident:boolean, dir:number[]|null, k:number|null, refs:number, lit:number}}
 */
function sceneShadow(ctx, features, opts) {
  const none = { confident: false, dir: null, k: null, refs: 0, lit: 0 };
  if (!ctx) return none;
  const lidarH = (opts && opts.heights) || null;
  const refs = [];
  for (const r of ctx.rings) {
    const f = features[r.feature];
    // A height sampled from lidar for this outline outranks the source's.
    const sampled = lidarH ? Number(lidarH[r.feature]) : 0;
    const fromLidar = sampled >= REF_MIN_H && sampled <= 300;
    const h = fromLidar ? sampled : measuredHeight(f);
    if (!h) continue;
    if (ringAreaM2(ctx, r.px) < REF_MIN_M2) continue;
    const src = (f && f.properties && f.properties.heightSource) || "";
    refs.push({ ring: r, h, edges: edgePoints(ctx, r.px), surveyed: fromLidar || SURVEYED[src] === true });
  }
  if (refs.length < REF_MIN_COUNT) return Object.assign(none, { refs: refs.length });
  const sums = new Array(DIRS).fill(0);
  const scores = refs.map((ref) => {
    const row = [];
    for (let k = 0; k < DIRS; k++) {
      const s = bandScore(ctx, ref.edges, dirVec(k));
      row.push(s);
      if (s.n >= MIN_BAND_SAMPLES) sums[k] += s.share;
    }
    return row;
  });
  let best = 0;
  for (let k = 1; k < DIRS; k++) if (sums[k] > sums[best]) best = k;
  const opp = (best + DIRS / 2) % DIRS;
  const dir = dirVec(best);
  // Roofs that shade the best side. Torn-down outlines in the same draw do
  // not vote against them; they are what this module looks for.
  const shadedRefs = [];
  let voters = 0;
  let oppSum = 0;
  let oppN = 0;
  for (let i = 0; i < scores.length; i++) {
    const row = scores[i];
    if (row[best].n < MIN_BAND_SAMPLES) continue;
    voters++;
    if (row[best].share < SHADED_MIN) continue;
    shadedRefs.push(refs[i]);
    if (row[opp].n >= MIN_BAND_SAMPLES) {
      oppSum += row[opp].share;
      oppN++;
    }
  }
  // Those roofs are lit on the sun side. A dark surround is not a shadow.
  const confident = shadedRefs.length >= REF_MIN_COUNT && oppN >= 2 && oppSum / oppN <= 0.25;
  // Shadow metres per metre of height. Surveyed heights (lidar) set it when
  // two or more shaded roofs have one. Source heights alone (floors, a
  // default) can be far off; their scale is trusted only when three or more
  // agree, and only callers that need a height (stack yards) ask.
  let k = null;
  let kReliable = false;
  if (confident) {
    const all = [];
    const surveyed = [];
    for (const ref of shadedRefs) {
      const L = shadowLengthM(ctx, ref.edges, dir);
      if (!(L != null && L > 0.5)) continue;
      all.push(L / ref.h);
      if (ref.surveyed) surveyed.push(L / ref.h);
    }
    const ks = surveyed.length >= 2 ? surveyed : all;
    if (ks.length >= 2) {
      ks.sort((a, b) => a - b);
      k = ks[ks.length >> 1];
      if (ks === surveyed) kReliable = true;
      else if (ks.length >= 3) kReliable = ks[Math.floor((ks.length * 3) / 4)] <= ks[Math.floor(ks.length / 4)] * K_AGREE;
    }
  }
  const shaded = shadedRefs.length;
  return { confident, dir, dirIndex: best, k, kReliable, refs: refs.length, shaded, voters };
}

/**
 * Vector outlines with a lit shadow side in a confident scene.
 * @returns {Set<number>} indexes into features
 */
/**
 * Median colour step across an outline, inside vs outside at EDGE_M. A
 * standing roof differs from the ground beside it somewhere along its edge;
 * an outline drawn on unbroken pavement or lawn does not.
 */
function edgeContrast(ctx, edges) {
  const d = ctx.raw.data;
  const W = ctx.W;
  const H = ctx.H;
  const off = EDGE_M / ctx.mpp;
  const steps = [];
  let murky = 0;
  let inSum = 0;
  function rgb(x, y) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null;
    const k = (yi * W + xi) * 4;
    return [d[k], d[k + 1], d[k + 2]];
  }
  for (const e of edges) {
    const ox = e.x + e.nx * off;
    const oy = e.y + e.ny * off;
    if (ctx.underRoof(ox, oy)) continue;
    const a = rgb(e.x - e.nx * off, e.y - e.ny * off);
    const b = rgb(ox, oy);
    if (!a || !b) continue;
    const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
    inSum += la;
    if (la < ctx.dark * 1.25 || (a[1] > a[0] + 8 && a[1] > a[2] + 4) || a[0] + a[1] + a[2] === 0) murky++;
    steps.push((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3);
  }
  if (steps.length < MIN_BAND_SAMPLES) return null;
  steps.sort((x, y) => x - y);
  return { step: steps[steps.length >> 1], murky: murky / steps.length, inLuma: inSum / steps.length };
}

/**
 * Share of shadow-side edge points that sit on a raised surface: walking
 * away from the sun over the same flat colour, the walk ends in shade. An
 * outline drawn inside a larger roof (a wing, a mismatched part) meets that
 * roof's shadow; one drawn on open ground meets curbs, cars, and grass.
 */
function raisedShare(ctx, edges, d) {
  const lumaAt = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= ctx.W || iy >= ctx.H) return null;
    return luma(ctx.raw.data, (iy * ctx.W + ix) * 4);
  };
  let n = 0;
  let raised = 0;
  const step = 0.5 / ctx.mpp;
  const startPx = BAND_M[0] / ctx.mpp;
  const maxPx = RAISED_WALK_M / ctx.mpp;
  for (const e of edges) {
    if (e.nx * d[0] + e.ny * d[1] < 0.5) continue;
    const y0 = lumaAt(e.x + d[0] * startPx, e.y + d[1] * startPx);
    if (y0 == null || y0 < ctx.dark) continue;
    n++;
    for (let t = startPx + step; t <= maxPx; t += step) {
      const v = lumaAt(e.x + d[0] * t, e.y + d[1] * t);
      if (v == null) break;
      if (Math.abs(v - y0) <= y0 * 0.1) continue;
      // A roof edge (gutter, parapet) may sit between the roof and its shadow.
      for (let u = t; u <= t + 1.5 / ctx.mpp; u += step / 2) {
        const w = lumaAt(e.x + d[0] * u, e.y + d[1] * u);
        if (w != null && w < ctx.dark) {
          raised++;
          break;
        }
      }
      break;
    }
  }
  return n ? raised / n : 0;
}

function shadowlessFootprints(ctx, features, scene, opts) {
  const out = new Set();
  if (!ctx || !scene || !scene.confident || !scene.dir) return out;
  const o = opts || {};
  // A shadow band a metre or two wide needs sub-half-metre pixels.
  if (ctx.mpp > GHOST_MAX_MPP) return out;
  const minM2 = o.minM2 || 120;
  // Expected shadow of a 3 m shed. Past that the band must show it.
  const k = scene.k || 0;
  if (!(k * 3 >= BAND_M[1])) return out;
  const byFeature = new Map();
  for (const r of ctx.rings) {
    if (!byFeature.has(r.feature)) byFeature.set(r.feature, []);
    byFeature.get(r.feature).push(r);
  }
  for (const [fi, rings] of byFeature) {
    const f = features[fi];
    const p = (f && f.properties) || {};
    if (p.source === "imagery-roof" || p.lidarAdded) continue;
    let n = 0;
    let dark = 0;
    let area = 0;
    for (const r of rings) {
      area += ringAreaM2(ctx, r.px);
      const s = bandScore(ctx, edgePoints(ctx, r.px), scene.dir);
      n += s.n;
      dark += s.share * s.n;
    }
    if (area < minM2 || n < MIN_BAND_SAMPLES * 2) continue;
    if (dark / n > LIT_MAX) continue;
    // A real roof still steps in colour from the ground at its edge, even
    // when a mosaic seam or a high sun hides its shadow.
    // Inside it must be lit, bare ground: under trees, in shade, or off the
    // plate nothing can be told, so the outline stays.
    const steps = [];
    let murky = 0;
    let inLuma = 0;
    for (const r of rings) {
      const c = edgeContrast(ctx, edgePoints(ctx, r.px));
      if (c == null) continue;
      steps.push(c.step);
      murky = Math.max(murky, c.murky);
      inLuma = Math.max(inLuma, c.inLuma);
    }
    if (!steps.length || murky > MURKY_MAX) continue;
    // Far brighter than the scene's ground reads as a membrane roof or a
    // tent top more often than as bare slab; leave it.
    if (inLuma > ctx.median * BRIGHT_MAX) continue;
    const step = Math.max(...steps);
    if (o.debug) o.debug.push({ fi, share: dark / n, step: step / ctx.median, murky });
    if (step > ctx.median * EDGE_STEP_MAX) continue;
    let raised = 0;
    for (const r of rings) raised = Math.max(raised, raisedShare(ctx, edgePoints(ctx, r.px), scene.dir));
    if (o.debug) o.debug[o.debug.length - 1].raised = raised;
    if (raised >= RAISED_MAX) continue;
    out.add(fi);
  }
  return out;
}

function rejectShadowless(raw, frame, features, opts) {
  const list = features || [];
  const ctx = photoContext(raw, frame, list);
  const scene = sceneShadow(ctx, list, opts);
  const drop = shadowlessFootprints(ctx, list, scene);
  if (!drop.size) return { features: list, dropped: 0, scene };
  return { features: list.filter((_, i) => !drop.has(i)), dropped: drop.size, scene };
}

module.exports = {
  photoContext,
  sceneShadow,
  shadowlessFootprints,
  rejectShadowless,
  edgePoints,
  bandScore,
  shadowLengthM,
  dirVec,
};
