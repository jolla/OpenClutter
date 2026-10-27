"use strict";

/**
 * Lidar tree crowns shaped on the current photo (/dev hosts, 1.2.39).
 *
 * The canopy grid is about 2.2 m a cell and each cell keeps its tallest
 * return, so a 5 m cypress traces as a block of 2 to 4 squares, a row of
 * small trees between parked RVs merges into one green slab, and a crown
 * edge spills a cell past the leaves onto gravel and roofs. The photo is
 * about 0.2 m a pixel and shows where the leaves are today.
 *
 * For each lidar crown up to CROWN_MAX_M2 (one tree or a small group, never
 * a woods), on a leaf-on photo:
 * - Leafy pixels (photo-canopy.js) within WINDOW_M of the traced outline are
 *   cleaned: an opening drops lone pixels and thin lawn edges, a closing
 *   fills the texture gaps inside a crown. The grid keeps one return per
 *   2.2 m cell and its edge can sit a cell off the leaves, so a crown kept
 *   that way is then traced out to SHAPE_WINDOW_M (about one cell): it keeps
 *   all of its leaves, but a wider blob never adds a tree, never joins two,
 *   and never changes which crowns are kept or left out.
 * - Each leaf blob of at least BLOB_MIN_M2 with at least IN_SHARE of it
 *   inside the outline is one crown. Its outline is the blob edge, so a
 *   crown is as wide as its leaves and two trees the grid merged are two
 *   crowns. A blob two lidar crowns both reach is one tree.
 * - Each crown keeps the tallest lidar cell under its own leaves, never
 *   more than the outline it came from.
 * - A crown with no leaf blob is left out: what the flight measured there
 *   is gone or was never a tree.
 * All of that only where the lidar is out of date in the zones: at least
 * STALE_SHARE of the crowns read have no leaves at all on the photo (RVs,
 * awnings and trailers the flight read as crowns, trees since cut), and at
 * least STALE_EVIDENCE_SHARE of those show a bright roof, vehicle top or
 * pale ground (STALE_BRIGHT_MIN of the crown). Dense leaf-on canopy the
 * leaf test misses (dull or hazy green) is no such evidence. Where
 * the lidar still matches the photo, every crown keeps its lidar outline,
 * and a crown with no leaves is left out only when the photo shows at
 * least DROP_OPEN of it as roof, vehicle top or open ground. "Not leafy"
 * alone never removes a tree: dark olive desert trees, conifers and shaded
 * crowns often read as neither leaves nor ground.
 * - A crown whose photo is mostly bare branches or deep shade and hardly
 *   any bright roof (a leaf-off hardwood, a crown shaded by a taller one)
 *   keeps its lidar outline.
 * Nothing is added outside the lidar crowns, and larger stands keep the
 * grid outline and their two-layer forest form.
 */

const { leafyPixel, foliagePixel, barePixel, branchPixel, BRANCH_KEEP } = require("./photo-canopy");
const { dpClosed } = require("./canopy-height");
const { materialForVegetation } = require("./materials");
const { pxToLl } = require("./geo-frame");

const CROWN_MAX_M2 = 400;
const WINDOW_M = 1;
// A kept crown is traced out to about one 2.2 m canopy cell (1.2.48).
const SHAPE_WINDOW_M = 2;
const BLOB_MIN_M2 = 2;
const IN_SHARE = 0.3;
const OPEN_PX = 1;
const CLOSE_PX = 2;
const EDGE_EPS_M = 0.35;
const MAX_VERTS = 24;
const SHADE_LUMA = 45;
const BRIGHT_LUMA = 170;
const BRIGHT_MAX = 0.15;
const LEAFY_KEEP_MAX = 0.1;
const MIN_H = 3;
// Lidar out of date in the zones: at least this share of the crowns read
// (and at least STALE_MIN_CROWNS of them) have no leaves on the photo.
const STALE_SHARE = 0.35;
const STALE_MIN_CROWNS = 20;
// Otherwise a leafless crown is left out only when this share of it is
// roof, vehicle top or open ground on the photo.
const DROP_OPEN = 0.5;
// A leafless crown is evidence that the lidar is out of date only when at
// least this share of it is bright roof, vehicle top or pale ground on the
// photo, and the lidar counts as out of date only when at least
// STALE_EVIDENCE_SHARE of the leafless crowns are such evidence. Leafless
// crowns that reach STALE_BRIGHT_MIN: Pismo Coast Village 57%, Westwind 69%,
// Traverse City KOA 15% (dense leaf-on woods the leaf test misses),
// Fort Wilderness 12%, Colorado camp 4%.
const STALE_BRIGHT_MIN = 0.15;
const STALE_EVIDENCE_SHARE = 0.4;

const C_LEAFY = 1;
const C_BARE = 2;
const C_SHADE = 3;
const C_BRIGHT = 4;

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function grayGains(d, n) {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 7) {
    sr += d[i * 4];
    sg += d[i * 4 + 1];
    sb += d[i * 4 + 2];
  }
  if (!(sr > 0) || !(sg > 0) || !(sb > 0)) return [1, 1, 1];
  const m = (sr + sg + sb) / 3;
  return [m / sr, m / sg, m / sb];
}

function ringArea(r) {
  let a = 0;
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0];
    const yi = r[i][1];
    const xj = r[j][0];
    const yj = r[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Square erosion (grow false) or dilation (grow true) of a crop mask. */
function morph(m, w, h, r, grow) {
  if (!(r > 0)) return m;
  // Separable: rows, then columns.
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const q = xx < 0 || xx >= w ? 0 : m[y * w + xx];
        if (grow && q) { v = 1; break; }
        if (!grow && !q) { v = 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        const q = yy < 0 || yy >= h ? 0 : tmp[yy * w + x];
        if (grow && q) { v = 1; break; }
        if (!grow && !q) { v = 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Outer edge of one 4-connected blob in a crop (y down), as pixel corners.
 * At a corner two blob pixels share only diagonally, the walk turns right,
 * so it never crosses to the other pixel.
 */
function traceBlob(mask, w, h) {
  const key = (x, y) => y * (w + 1) + x;
  const out = new Map();
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const add = (ax, ay, bx, by) => {
    const k = key(ax, ay);
    const list = out.get(k);
    if (list) list.push([bx, by]);
    else out.set(k, [[bx, by]]);
  };
  let sx = -1;
  let sy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (sx < 0) {
        sx = x;
        sy = y;
      }
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  if (sx < 0) return null;
  // The top-left pixel's top edge is on the outer boundary.
  const ring = [[sx, sy]];
  let px = sx;
  let py = sy;
  let cx = sx + 1;
  let cy = sy;
  const used = new Set([key(sx, sy) * 4 + 0]);
  for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
    if (cx === sx && cy === sy) break;
    ring.push([cx, cy]);
    const list = out.get(key(cx, cy));
    if (!list || !list.length) return null;
    let next = list[0];
    if (list.length > 1) {
      // Right turn first (y down): heading (dx, dy) turns to (-dy, dx).
      const dx = cx - px;
      const dy = cy - py;
      const rx = -dy;
      const ry = dx;
      next = list.find((n) => n[0] - cx === rx && n[1] - cy === ry) || list[0];
    }
    px = cx;
    py = cy;
    cx = next[0];
    cy = next[1];
  }
  void used;
  return ring.length >= 4 ? ring : null;
}

/**
 * A refiner for one export: the photo (RGBA, imgW x imgH, north up), the
 * frame, and an optional (lon, lat) zone test. Pixel classes are read once
 * and cached.
 */
function photoCrownRefiner(photo, frame, inZone) {
  if (!photo || !photo.data || !frame || photo.width !== frame.imgW || photo.height !== frame.imgH) return null;
  const w = photo.width;
  const h = photo.height;
  const d = photo.data;
  const gains = grayGains(d, w * h);
  const cls = new Uint8Array(w * h); // 0 = not read yet, else class + 8
  const mpu = frame.mpuX || frame.mpu || 1;
  const classAt = (x, y) => {
    const i = y * w + x;
    if (cls[i]) return cls[i] - 8;
    let n = 0;
    let s = 0;
    let s2 = 0;
    for (let yy = y - 2; yy <= y + 2; yy++) {
      if (yy < 0 || yy >= h) continue;
      for (let xx = x - 2; xx <= x + 2; xx++) {
        if (xx < 0 || xx >= w) continue;
        const k = (yy * w + xx) * 4;
        const v = luma(d[k], d[k + 1], d[k + 2]);
        s += v;
        s2 += v * v;
        n++;
      }
    }
    const m = s / n;
    const std = Math.sqrt(Math.max(0, s2 / n - m * m));
    const k = i * 4;
    const r = d[k];
    const g = d[k + 1];
    const b = d[k + 2];
    const y0 = luma(r, g, b);
    let c = 0;
    if (foliagePixel(r, g, b, std) || leafyPixel(r * gains[0], g * gains[1], b * gains[2], std)) c = C_LEAFY;
    else if (y0 >= BRIGHT_LUMA) c = C_BRIGHT;
    else if (barePixel(r, g, b, std)) c = C_BARE;
    else if (branchPixel(r, g, b, std) || y0 < SHADE_LUMA) c = C_SHADE;
    cls[i] = c + 8;
    return c;
  };
  const stats = { crowns: 0, shaped: 0, extra: 0, dropped: 0, kept: 0, m2Before: 0, m2After: 0, leafless: 0, evidence: 0 };

  function centreLonLat(ringPx) {
    let cx = 0;
    let cy = 0;
    for (const p of ringPx) {
      cx += p[0];
      cy += p[1];
    }
    return pxToLl(cx / ringPx.length, cy / ringPx.length, frame);
  }

  /** Shape one crown. Returns the new polygons ([] = left out), or null to keep it. */
  function shape(poly, heightAt) {
    const ringIn = poly.ringPx;
    const open = ringIn.length > 1 && ringIn[0][0] === ringIn[ringIn.length - 1][0] && ringIn[0][1] === ringIn[ringIn.length - 1][1] ? ringIn.slice(0, -1) : ringIn;
    if (open.length < 3) return null;
    const m2 = ringArea(open) * mpu * mpu;
    if (!(m2 > 0) || m2 > CROWN_MAX_M2) return null;
    if (inZone) {
      const c = centreLonLat(open);
      if (!inZone(c[0], c[1])) return null;
    }
    const topH = Number(poly.material && poly.material.top_height) || 0;
    stats.crowns++;
    stats.m2Before += m2;
    // Crop in photo rows (y down).
    const pad = Math.ceil(Math.max(WINDOW_M, SHAPE_WINDOW_M) / mpu) + 2;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const rr = open.map((p) => [p[0], h - p[1]]);
    for (const p of rr) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const x0 = Math.max(0, Math.floor(minX) - pad);
    const x1 = Math.min(w - 1, Math.ceil(maxX) + pad);
    const y0 = Math.max(0, Math.floor(minY) - pad);
    const y1 = Math.min(h - 1, Math.ceil(maxY) + pad);
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    if (cw < 3 || ch < 3) return null;
    const inside = new Uint8Array(cw * ch);
    let nIn = 0;
    let nLeaf = 0;
    let nShade = 0;
    let nBright = 0;
    let nBare = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (!inRing(rr, x0 + x + 0.5, y0 + y + 0.5)) continue;
        inside[y * cw + x] = 1;
        const c = classAt(x0 + x, y0 + y);
        nIn++;
        if (c === C_LEAFY) nLeaf++;
        else if (c === C_SHADE) nShade++;
        else if (c === C_BRIGHT) nBright++;
        else if (c === C_BARE) nBare++;
      }
    }
    if (nIn < 4) return null;
    // A leaf-off hardwood or a shaded crown: the photo cannot shape it.
    if (nLeaf / nIn < LEAFY_KEEP_MAX && nShade / nIn >= BRANCH_KEEP && nBright / nIn < BRIGHT_MAX) {
      stats.kept++;
      stats.m2After += m2;
      return null;
    }
    // Leaf blobs within windowM of the outline (4-connected, whole-photo
    // pixel indices). Each blob carries how many of its pixels fall inside.
    const leafBlobs = (windowM) => {
      const win = morph(inside, cw, ch, Math.round(windowM / mpu), true);
      let leaf = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = y * cw + x;
          if (win[i] && classAt(x0 + x, y0 + y) === C_LEAFY) leaf[i] = 1;
        }
      }
      leaf = morph(morph(leaf, cw, ch, OPEN_PX, false), cw, ch, OPEN_PX, true);
      leaf = morph(morph(leaf, cw, ch, CLOSE_PX, true), cw, ch, CLOSE_PX, false);
      for (let i = 0; i < leaf.length; i++) if (!win[i]) leaf[i] = 0;
      const lab = new Uint8Array(cw * ch);
      const found = [];
      for (let i = 0; i < leaf.length; i++) {
        if (!leaf[i] || lab[i]) continue;
        const stack = [i];
        lab[i] = 1;
        const px = [];
        let ni = 0;
        while (stack.length) {
          const j = stack.pop();
          const x = j % cw;
          const y = (j / cw) | 0;
          px.push((y0 + y) * w + x0 + x);
          if (inside[j]) ni++;
          if (x > 0 && leaf[j - 1] && !lab[j - 1]) { lab[j - 1] = 1; stack.push(j - 1); }
          if (x < cw - 1 && leaf[j + 1] && !lab[j + 1]) { lab[j + 1] = 1; stack.push(j + 1); }
          if (y > 0 && leaf[j - cw] && !lab[j - cw]) { lab[j - cw] = 1; stack.push(j - cw); }
          if (y < ch - 1 && leaf[j + cw] && !lab[j + cw]) { lab[j + cw] = 1; stack.push(j + cw); }
        }
        found.push({ px, ni });
      }
      return found;
    };
    // Which crowns are trees, and which are left out, is read inside
    // WINDOW_M of the outline, as before.
    const core = leafBlobs(WINDOW_M).filter((b) => b.px.length * mpu * mpu >= BLOB_MIN_M2 && b.ni / b.px.length >= IN_SHARE);
    // A tree the read keeps is then traced out to SHAPE_WINDOW_M, so a crown
    // the grid placed a cell off its leaves keeps the whole crown. A wider
    // blob is used only when it holds exactly one kept blob: it never adds a
    // tree and never joins two.
    let shapes = core;
    if (core.length && SHAPE_WINDOW_M > WINDOW_M) {
      const owner = new Map();
      core.forEach((b, k) => {
        for (const j of b.px) owner.set(j, k);
      });
      const used = new Set();
      shapes = [];
      for (const b of leafBlobs(SHAPE_WINDOW_M)) {
        const held = new Set();
        for (const j of b.px) {
          const k = owner.get(j);
          if (k !== undefined) held.add(k);
        }
        if (held.size !== 1) continue;
        const k = held.values().next().value;
        if (used.has(k)) continue;
        used.add(k);
        shapes.push(b);
      }
      core.forEach((b, k) => {
        if (!used.has(k)) shapes.push(b);
      });
    }
    const blobs = [];
    for (const { px } of shapes) {
      let top = 0;
      if (typeof heightAt === "function") {
        for (let k = 0; k < px.length; k += 3) {
          const gx = px[k] % w;
          const gy = (px[k] / w) | 0;
          const ll = pxToLl(gx + 0.5, h - (gy + 0.5), frame);
          const v = Number(heightAt(ll[0], ll[1])) || 0;
          if (v > top) top = v;
        }
      }
      const hM = top >= MIN_H ? Math.min(top, topH || top) : topH;
      blobs.push({ px, hM, poly });
    }
    // Share of the crown the photo positively shows as roof, vehicle top or
    // open ground (not just "not leafy": dark, olive and shaded crowns
    // often read as neither).
    return { blobs, open: (nBright + nBare) / nIn, bright: nBright / nIn, m2 };
  }

  /** One crown polygon from a set of photo pixels (whole-photo indices). */
  function crownFromBlob(px, hM, poly) {
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let by0 = Infinity;
    let by1 = -Infinity;
    for (const j of px) {
      const x = j % w;
      const y = (j / w) | 0;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const bm = new Uint8Array(bw * bh);
    for (const j of px) bm[(((j / w) | 0) - by0) * bw + ((j % w) - bx0)] = 1;
    const ring = traceBlob(bm, bw, bh);
    if (!ring) return null;
    let eps = EDGE_EPS_M / mpu;
    let pts = dpClosed(ring, eps);
    while (pts.length > MAX_VERTS && eps < 20) {
      eps *= 1.4;
      pts = dpClosed(ring, eps);
    }
    if (pts.length < 3) return null;
    const ringPx = pts.map((p) => [bx0 + p[0], h - (by0 + p[1])]);
    ringPx.push([ringPx[0][0], ringPx[0][1]]);
    const m2 = ringArea(ringPx.slice(0, -1)) * mpu * mpu;
    if (!(m2 >= BLOB_MIN_M2 * 0.5)) return null;
    const topH = Number(poly.material && poly.material.top_height) || 0;
    const tier = String((poly.material && poly.material.name) || "").indexOf("Light") >= 0 ? "light" : hM >= 12 ? "heavy" : "light";
    const material = (hM > 0 && Math.abs(hM - topH) > 0.05 ? materialForVegetation(Math.round(hM * 10) / 10, tier) : null) || poly.material;
    stats.m2After += m2;
    return {
      ringPx,
      ringLonLat: ringPx.map((p) => pxToLl(p[0], p[1], frame)),
      material,
      kind: "canopy",
      shape: "polygon",
      segTree: true,
      photoShaped: true,
    };
  }

  /**
   * Shape a list of canopy polygons (polygonsFromCrowns form). A leaf blob
   * two lidar crowns both reach is one tree: their blobs join.
   */
  function refine(polygons, heightAt) {
    const list = polygons || [];
    const keep = [];
    const blobs = [];
    const read = [];
    for (const p of list) {
      let made = null;
      if (p && !p.context && Array.isArray(p.ringPx) && p.ringPx.length >= 4) {
        try {
          made = shape(p, heightAt);
        } catch {
          made = null;
        }
      }
      if (made === null) keep.push(p);
      else read.push({ p, made });
    }
    // Is the lidar out of date in these zones? Only when many of the
    // crowns it measured have no leaves at all on the photo (trees cut,
    // RVs and awnings the flight read as crowns) does the photo reshape
    // every crown. Where the lidar still matches the photo, each crown keeps
    // its lidar outline, and only a crown with no leaves whose photo shows
    // mostly roof, vehicle top or open ground is left out: a crown the leaf
    // test merely misses (dark, olive, shaded) stays.
    // A leafless crown counts as evidence only when the photo shows bright
    // roof, vehicle top or pale ground there: a leaf-on woods the leaf test
    // misses (dull or hazy green) is not a sign that the flight is old.
    const leaflessCrowns = read.filter((r) => !r.made.blobs.length);
    const leafless = leaflessCrowns.length;
    const evidence = leaflessCrowns.filter((r) => r.made.bright >= STALE_BRIGHT_MIN).length;
    stats.leafless = leafless;
    stats.evidence = evidence;
    stats.stale =
      read.length >= STALE_MIN_CROWNS &&
      leafless / read.length >= STALE_SHARE &&
      evidence / leafless >= STALE_EVIDENCE_SHARE;
    for (const r of read) {
      if (!r.made.blobs.length) {
        if (stats.stale || r.made.open >= DROP_OPEN) {
          stats.dropped++;
          continue;
        }
      } else if (stats.stale) {
        stats.shaped++;
        for (const b of r.made.blobs) blobs.push(b);
        continue;
      }
      stats.kept++;
      stats.m2After += r.made.m2;
      keep.push(r.p);
    }
    // Union blobs that share pixels.
    const parent = blobs.map((b, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const owner = new Map();
    for (let b = 0; b < blobs.length; b++) {
      for (const j of blobs[b].px) {
        const o = owner.get(j);
        if (o === undefined) owner.set(j, b);
        else {
          const ra = find(o);
          const rb = find(b);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
    const groups = new Map();
    for (let b = 0; b < blobs.length; b++) {
      const r = find(b);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(blobs[b]);
    }
    const shaped = [];
    let made = 0;
    for (const g of groups.values()) {
      let px = g[0].px;
      let best = g[0];
      if (g.length > 1) {
        const set = new Set();
        for (const b of g) {
          for (const j of b.px) set.add(j);
          if (b.hM > best.hM) best = b;
        }
        px = [...set];
      }
      const c = crownFromBlob(px, best.hM, best.poly);
      if (c) {
        shaped.push(c);
        made++;
      }
    }
    stats.extra = Math.max(0, made - stats.shaped);
    stats.m2Before = Math.round(stats.m2Before);
    stats.m2After = Math.round(stats.m2After);
    return keep.concat(shaped);
  }

  return { refine, stats, classAt };
}

/** Nearest-cell height sampler on a canopy grid (lon, lat). */
function gridHeightAt(grid) {
  if (!grid || !grid.values) return null;
  const values = typeof grid.values === "string" ? Buffer.from(grid.values, "base64") : grid.values;
  const w = grid.width | 0;
  const h = grid.height | 0;
  const dLon = +grid.east - +grid.west;
  const dLat = +grid.north - +grid.south;
  return (lon, lat) => {
    const x = Math.floor(((lon - +grid.west) / dLon) * w);
    const y = Math.floor(((+grid.north - lat) / dLat) * h);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return values[y * w + x] || 0;
  };
}

function photoCrownNote(stats) {
  if (!stats || !(stats.shaped > 0)) return "";
  return (
    "Shaped " +
    stats.shaped.toLocaleString("en-US") +
    " lidar tree crown" +
    (stats.shaped === 1 ? "" : "s") +
    " to the leaves on the current photo" +
    (stats.extra > 0 ? ", " + stats.extra.toLocaleString("en-US") + " more trees split from merged crowns" : "") +
    "."
  );
}

module.exports = {
  photoCrownRefiner,
  gridHeightAt,
  photoCrownNote,
  traceBlob,
  CROWN_MAX_M2,
  BLOB_MIN_M2,
  SHAPE_WINDOW_M,
  STALE_BRIGHT_MIN,
  STALE_EVIDENCE_SHARE,
};
