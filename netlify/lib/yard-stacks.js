"use strict";

/**
 * Stacked goods in an outdoor storage yard, read from the aerial.
 *
 * A yard beside a distribution building holds rows of pallets, lumber, and
 * bundles a few metres tall. Lidar is the best height, but a flight that
 * predates the yard shows bare ground, and most draws have no lidar at all.
 * The photo still carries the height: every stack throws a shadow on the
 * side away from the sun, and the scene's own measured roofs say how many
 * metres of shadow one metre of height throws (cast-shadow.sceneShadow).
 *
 * A stack here is:
 * - outside every building outline and every mapped car park, within
 *   YARD_REACH_M of a large roof;
 * - a run of shade along the sun line that starts at something lit, ends on
 *   lit ground, reads as STACK_MIN_H to STACK_MAX_H metres, and is at least
 *   MIN_SHADOW_WIDTH_M wide across the sun line. A car's shadow is shorter
 *   or narrower. Grass and trees are left to the canopy;
 * - the goods on the sun side of that shade: textured, shaded, or brighter
 *   than the yard's bare pavement.
 * Cells are joined into row blocks and closed over goods cells. A block
 * needs real area, enough shadow, texture, a lit body (not ballast or dirt),
 * bare pavement around it, and grey or white goods rather than the colour
 * patchwork of parked cars. Small blocks count only beside a yard-sized one.
 * Height is the median the shadows read, rounded to 0.5 m.
 *
 * Nothing runs without a confident shadow scene whose scale comes from
 * surveyed roof heights or from source heights that agree. Empty pavement throws no
 * shadow and stays empty.
 */

const { photoContext, sceneShadow } = require("./cast-shadow");
const { traceComponent } = require("./usgs-lidar");

const YARD_HOST_M2 = 8000;
const YARD_REACH_M = 200;
const YARD_MAX_MPP = 0.5;
const STACK_MIN_H = 2;
const STACK_MAX_H = 9;
const BODY_MAX_M = 12;
const MIN_BLOCK_M2 = 120;
const MAX_BLOCKS = 400;
const TILE_M = 24;
const MIN_PIECE_M2 = 20;
const SHADE_SHARE = 0.62;
const ROUGH_SHARE = 0.04;
const MIN_RUNS = 6;
const SPREAD_M = 1.5;
const MIN_SHADOW_WIDTH_M = 3.5;
const MIN_SHADE_SHARE = 0.08;
const MIN_ROUGH_SHARE = 0.35;
const MIN_BODY_LIT = 0.85;
const BARE_BAND = 0.08;
const BARE_GAP_M = 1.5;
const END_LIT = 0.8;
const CLOSE_M = 2.5;
const RING_M = 3;
const MIN_RING_BARE = 0.4;
const MAX_GOODS_SAT = 0.12;
const YARD_ANCHOR_M2 = 800;
const YARD_NEAR_M = 30;
const MAX_SAT_SHARE = 0.8;

function luma(d, i) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

function greenish(d, i) {
  const r = d[i];
  const g = d[i + 1];
  const b = d[i + 2];
  return g > r + 8 && g > b + 4;
}

function distToRingM(ctx, px, x, y) {
  let best = Infinity;
  for (let i = 0; i < px.length - 1; i++) {
    const a = px[i];
    const b = px[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
    if (d < best) best = d;
  }
  return best * ctx.mpp;
}

function pointInRing(x, y, px) {
  let inside = false;
  for (let i = 0, j = px.length - 1; i < px.length; j = i++) {
    const a = px[i];
    const b = px[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function ringAreaPx(px) {
  let a = 0;
  for (let i = 0, j = px.length - 1; i < px.length; j = i++) a += px[j][0] * px[i][1] - px[i][0] * px[j][1];
  return Math.abs(a / 2);
}

/** Douglas-Peucker on a closed loop (open list, first point not repeated). Returns a closed list. */
function simplifyClosed(loop, tol) {
  let far = 0;
  let best = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplify(loop.slice(0, far + 1), tol);
  const b = simplify(loop.slice(far).concat([loop[0]]), tol);
  return a.concat(b.slice(1));
}

/** Douglas-Peucker on grid units. */
function simplify(points, tol) {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bi = -1;
    const ax = points[a][0];
    const ay = points[a][1];
    const dx = points[b][0] - ax;
    const dy = points[b][1] - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (points[i][0] - ax) - dx * (points[i][1] - ay)) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Square dilation / erosion of a 0/1 grid by r cells (separable). */
function dilate(m, gw, gh, r) {
  return morph(m, gw, gh, r, 1);
}
function erode(m, gw, gh, r) {
  return morph(m, gw, gh, r, 0);
}
function morph(m, gw, gh, r, grow) {
  const tmp = new Uint8Array(gw * gh);
  const out = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        const c = xx < 0 || xx >= gw ? 0 : m[y * gw + xx];
        if (grow ? c : !c) {
          v = grow ? 1 : 0;
          break;
        }
      }
      tmp[y * gw + x] = v;
    }
  }
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        const c = yy < 0 || yy >= gh ? 0 : tmp[yy * gw + x];
        if (grow ? c : !c) {
          v = grow ? 1 : 0;
          break;
        }
      }
      out[y * gw + x] = v;
    }
  }
  return out;
}

/**
 * @param {object} raw decoded RGBA plate
 * @param {object} frame export frame
 * @param {object[]} features building features (lon/lat)
 * @param {{scene?:object, ctx?:object, heights?:number[], avoid?:number[][][]}} [opts] heights: lidar roof heights by feature index; avoid: lon/lat rings (mapped car parks)
 * @returns {{yards:object[], scene:object|null, reason:string}}
 */
function aerialStorageYards(raw, frame, features, opts) {
  const o = opts || {};
  const ctx = o.ctx || photoContext(raw, frame, features);
  if (!ctx || ctx.mpp > YARD_MAX_MPP) return { yards: [], scene: null, reason: "photo too coarse" };
  const scene = o.scene || sceneShadow(ctx, features, { heights: o.heights });
  if (!scene.confident || !scene.dir || !scene.kReliable || !(scene.k > 0.15) || scene.k > 4) {
    return { yards: [], scene, reason: "no shadow scale" };
  }
  const hosts = ctx.rings.filter((r) => ringAreaPx(r.px) * ctx.mpp * ctx.mpp >= YARD_HOST_M2);
  if (!hosts.length) return { yards: [], scene, reason: "no large roof" };
  const { W, H, mpp } = ctx;
  const d = ctx.raw.data;
  // Half-metre cells resolve a 2.5 m stack's shadow; never under two pixels.
  const cm = Math.min(1, Math.max(0.5, 2 * mpp));
  const cellPx = cm / mpp;
  const gw = Math.ceil(W / cellPx);
  const gh = Math.ceil(H / cellPx);
  // Which cells are in reach of a host and outside every roof.
  const inYard = new Uint8Array(gw * gh);
  const reachPx = YARD_REACH_M / mpp;
  for (const h of hosts) {
    const [x0, y0, x1, y1] = h.box;
    const gx0 = Math.max(0, Math.floor((x0 - reachPx) / cellPx));
    const gx1 = Math.min(gw - 1, Math.floor((x1 + reachPx) / cellPx));
    const gy0 = Math.max(0, Math.floor((y0 - reachPx) / cellPx));
    const gy1 = Math.min(gh - 1, Math.floor((y1 + reachPx) / cellPx));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * gw + gx;
        if (inYard[i]) continue;
        const x = (gx + 0.5) * cellPx;
        const y = (gy + 0.5) * cellPx;
        if (ctx.underRoof(x, y)) continue;
        if (distToRingM(ctx, h.px, x, y) <= YARD_REACH_M) inYard[i] = 1;
      }
    }
  }
  // Mapped car parks are not storage: rows of parked cars throw the same
  // wide shadows as low stacks.
  for (const ring of o.avoid || []) {
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const px = ring.map((q) => [((q[0] - frame.west) / (frame.east - frame.west)) * W, ((frame.north - q[1]) / (frame.north - frame.south)) * H]);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of px) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    const gx0 = Math.max(0, Math.floor(x0 / cellPx));
    const gx1 = Math.min(gw - 1, Math.floor(x1 / cellPx));
    const gy0 = Math.max(0, Math.floor(y0 / cellPx));
    const gy1 = Math.min(gh - 1, Math.floor(y1 / cellPx));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * gw + gx;
        if (inYard[i] && pointInRing((gx + 0.5) * cellPx, (gy + 0.5) * cellPx, px)) inYard[i] = 0;
      }
    }
  }
  // Cell luma (mean), and the yard's bare pavement level: the commonest
  // smooth, lit cell in reach.
  const cellY = new Float32Array(gw * gh);
  const cellStd = new Float32Array(gw * gh);
  const cellDark = new Float32Array(gw * gh);
  const cellGreen = new Float32Array(gw * gh);
  const cellSat = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (!inYard[i]) continue;
      let n = 0;
      let s = 0;
      let s2 = 0;
      let dk = 0;
      let gr = 0;
      let sa = 0;
      const px0 = Math.floor(gx * cellPx);
      const py0 = Math.floor(gy * cellPx);
      const px1 = Math.min(W, Math.floor((gx + 1) * cellPx));
      const py1 = Math.min(H, Math.floor((gy + 1) * cellPx));
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          const k = (y * W + x) * 4;
          const v = luma(d, k);
          n++;
          s += v;
          s2 += v * v;
          if (v < ctx.dark) dk++;
          if (greenish(d, k)) gr++;
          const mx = Math.max(d[k], d[k + 1], d[k + 2]);
          sa += mx ? (mx - Math.min(d[k], d[k + 1], d[k + 2])) / mx : 0;
        }
      }
      if (!n) continue;
      const m = s / n;
      cellY[i] = m;
      cellStd[i] = Math.sqrt(Math.max(0, s2 / n - m * m));
      cellDark[i] = dk / n;
      cellGreen[i] = gr / n;
      cellSat[i] = sa / n;
      if (cellStd[i] < 8 && cellDark[i] === 0 && cellGreen[i] < 0.2) hist[Math.min(255, Math.round(m))]++;
    }
  }
  // The lit level of the yard: the commonest smooth, lit cell in reach.
  let pave = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[pave]) pave = v;
  let smooth = 0;
  for (let v = 0; v < 256; v++) smooth += hist[v];
  if (!smooth || pave < 60) return { yards: [], scene, reason: "no pavement" };
  // The pavement's own colour, for comparing goods against it.
  let paveSat = 0;
  {
    let n = 0;
    for (let i = 0; i < cellY.length; i++) {
      if (!inYard[i] || cellStd[i] >= 8 || cellGreen[i] >= 0.2 || Math.abs(cellY[i] - pave) > 4) continue;
      paveSat += cellSat[i];
      n++;
    }
    paveSat = n ? paveSat / n : 0;
  }
  // Shade on a lit yard sits near half its luma. Goods are textured; bare
  // pavement and a trailer roof are smooth.
  const shadeY = pave * SHADE_SHARE;
  const roughStd = Math.max(6, pave * ROUGH_SHARE);
  function shade(i) {
    return cellY[i] < shadeY && cellGreen[i] < 0.3;
  }
  function rough(i) {
    return cellStd[i] >= roughStd && cellGreen[i] < 0.3;
  }
  // Anything that is not bare pavement: texture, shade, or a surface clearly
  // brighter than the yard (wrap, white tops). Lumber and bundles are
  // textured; smooth dark asphalt is ground.
  function goods(i) {
    if (cellGreen[i] >= 0.3) return false;
    if (rough(i) || shade(i)) return true;
    return cellY[i] > pave * (1 + BARE_BAND);
  }
  const plainMax = Math.max(2, Math.round(BARE_GAP_M / cm));
  const dir = scene.dir;
  const stepX = dir[0];
  const stepY = dir[1];
  const perpX = -stepY;
  const perpY = stepX;
  function cellAt(fx, fy) {
    const gx = Math.floor(fx);
    const gy = Math.floor(fy);
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return -1;
    return gy * gw + gx;
  }
  // Cast shadows. A run of shade along the sun line is a stack's shadow
  // when it starts at lit goods (not more shade, grass, or ballast), its
  // length reads as a stack height, and its neighbours across the sun line
  // say the same, so the shadow is at least MIN_SHADOW_WIDTH_M wide. A car,
  // a dark car roof, or a trailer seen end-on is narrower than that.
  const castShade = new Uint8Array(gw * gh);
  const runH = new Float32Array(gw * gh);
  const runL = new Float32Array(gw * gh);
  const maxL = STACK_MAX_H * scene.k + 2 * cm;
  // Every run of shade along the sun line, measured once from its sunward
  // end. A run counts when it starts at something lit and not green (the
  // goods), ends on lit ground, and its length reads as a stack height.
  const runs = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (!inYard[i] || !shade(i)) continue;
      const back = cellAt(gx + 0.5 - stepX, gy + 0.5 - stepY);
      if (back < 0 || !inYard[back] || shade(back)) continue;
      if (cellGreen[back] >= 0.6) continue;
      const cells = [];
      let fx = gx + 0.5;
      let fy = gy + 0.5;
      let ended = false;
      while (cells.length * cm <= maxL) {
        const c = cellAt(fx, fy);
        if (c < 0 || !inYard[c]) break;
        if (!shade(c)) {
          // The shadow falls on lit ground: within a metre past its end the
          // surface is as bright as the yard, not ballast or dirt.
          ended = false;
          for (let t = 0; t < Math.round(1 / cm) + 1 && !ended; t++) {
            const e = cellAt(fx + stepX * t, fy + stepY * t);
            if (e < 0) break;
            if (cellGreen[e] < 0.3 && cellY[e] >= pave * END_LIT) ended = true;
          }
          break;
        }
        cells.push(c);
        fx += stepX;
        fy += stepY;
      }
      if (!ended) continue;
      const L = cells.length * cm;
      const h = L / scene.k;
      if (h < STACK_MIN_H || h > STACK_MAX_H) continue;
      for (const c of cells) runL[c] = L;
      runs.push({ i, cells, h });
    }
  }
  // A stack's shadow is wide across the sun line; a car's or a pole's is not.
  const halfW = Math.max(1, Math.round(MIN_SHADOW_WIDTH_M / 2 / cm));
  function wide(i) {
    const gx = i % gw;
    const gy = (i - gx) / gw;
    let side = 0;
    for (let o = -halfW; o <= halfW; o++) {
      if (!o) continue;
      for (let a = -1; a <= 1; a++) {
        const c = cellAt(gx + 0.5 + perpX * o + stepX * a, gy + 0.5 + perpY * o + stepY * a);
        if (c >= 0 && c !== i && runL[c] > 0) {
          side++;
          break;
        }
      }
    }
    return side >= halfW + 1;
  }
  for (const r of runs) {
    let w = 0;
    for (const c of r.cells) if (wide(c)) w++;
    if (w * 3 < r.cells.length) continue;
    runH[r.i] = r.h;
    for (const c of r.cells) castShade[c] = 1;
  }
  // Goods stand on the sun side of their shadow. From each run start, walk
  // toward the sun over textured or shaded cells until two plain cells in a
  // row, another stack's shadow, or BODY_MAX_M. Rough ground with nothing
  // standing on it (ballast, dirt, a lot of cars) is never reached.
  const cand = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (!(runH[i] > 0)) continue;
      cand[i] = 1;
      let bx = gx + 0.5 - stepX;
      let by = gy + 0.5 - stepY;
      let plain = 0;
      for (let t = 0; t < BODY_MAX_M; t += cm) {
        const c = cellAt(bx, by);
        if (c < 0 || !inYard[c] || castShade[c]) break;
        if (goods(c)) {
          plain = 0;
          cand[c] = 1;
        } else if (++plain >= plainMax) break;
        else cand[c] = 1;
        bx -= stepX;
        by -= stepY;
      }
    }
  }
  for (let i = 0; i < cand.length; i++) if (castShade[i]) cand[i] = 1;
  // The walks are one cell wide. Spread them sideways over the textured and
  // shaded cells of the same row, a few cells at most.
  for (let pass = 0; pass < Math.round(SPREAD_M / cm); pass++) {
    const add = [];
    for (let gy = 1; gy < gh - 1; gy++) {
      for (let gx = 1; gx < gw - 1; gx++) {
        const i = gy * gw + gx;
        if (cand[i] || !inYard[i] || !goods(i)) continue;
        if (cand[i - 1] || cand[i + 1] || cand[i - gw] || cand[i + gw]) add.push(i);
      }
    }
    for (const i of add) cand[i] = 1;
  }
  const solid = new Uint8Array(gw * gh);
  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const i = gy * gw + gx;
      if (!inYard[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cand[i + dy * gw + dx]) n++;
      if (cand[i] ? n >= 3 : n >= 6) solid[i] = 1;
    }
  }
  // Rows are continuous; the shadow walks leave gaps between them. Close
  // the field by CLOSE_M over goods cells only, so bare aisles stay out.
  {
    const r = Math.max(1, Math.round(CLOSE_M / cm));
    const grow = dilate(solid, gw, gh, r);
    const closed = erode(grow, gw, gh, r);
    for (let i = 0; i < solid.length; i++) if (!solid[i] && closed[i] && inYard[i] && goods(i)) solid[i] = 1;
  }
  const ringR = Math.max(2, Math.round(RING_M / cm));
  function ringBare(comp) {
    const set = new Set(comp);
    const ring = new Set();
    for (const c of comp) {
      const x = c % gw;
      const y = (c - x) / gw;
      for (const [dx, dy] of [[ringR, 0], [-ringR, 0], [0, ringR], [0, -ringR]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const n = yy * gw + xx;
        if (!set.has(n) && !solid[n]) ring.add(n);
      }
    }
    if (!ring.size) return 0;
    let bare = 0;
    for (const n of ring) if (inYard[n] && !goods(n)) bare++;
    return bare / ring.size;
  }
  const seen = new Uint8Array(gw * gh);
  const blocks = [];
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i] || seen[i]) continue;
    const comp = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const x = c % gw;
      const nb = [c - gw, c + gw, x > 0 ? c - 1 : -1, x < gw - 1 ? c + 1 : -1];
      for (const n of nb) {
        if (n < 0 || n >= solid.length || seen[n] || !solid[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    // The ground shadow is not the stack: leave cast shade at the block's
    // shadow edge out of the footprint.
    const body = [];
    const hs = [];
    let shadeCells = 0;
    let roughCells = 0;
    let litSum = 0;
    let litN = 0;
    for (const c of comp) {
      if (runH[c] > 0) hs.push(runH[c]);
      if (castShade[c]) {
        shadeCells++;
        const x = c % gw;
        const y = (c - x) / gw;
        const fwd = cellAt(x + 0.5 + stepX, y + 0.5 + stepY);
        // Shade with goods beyond it is a gap inside the row; keep it.
        if (fwd < 0 || !solid[fwd] || castShade[fwd]) continue;
      }
      if (rough(c)) roughCells++;
      if (!shade(c)) {
        litSum += cellY[c];
        litN++;
      }
      body.push(c);
    }
    const areaM2 = body.length * cm * cm;
    if (areaM2 < MIN_BLOCK_M2) continue;
    // Goods throw shade across the block and are textured inside it. Flat
    // paint and a lot of parked cars do not read tall enough.
    if (hs.length < MIN_RUNS) continue;
    if (shadeCells < comp.length * MIN_SHADE_SHARE) continue;
    if (roughCells < body.length * MIN_ROUGH_SHARE) continue;
    // Goods are lit as brightly as the pavement they stand on. Ballast,
    // dirt, and gravel read darker.
    if (!litN || litSum / litN < pave * MIN_BODY_LIT) continue;
    // Wrapped goods, bundles, and pallets of stock read grey or white next
    // to the pavement. A lot of parked cars is a patchwork of colours.
    let satSum = 0;
    for (const c of body) satSum += cellSat[c];
    const sat = satSum / body.length;
    if (sat > MAX_GOODS_SAT || sat > paveSat * MAX_SAT_SHARE) continue;
    // A yard is paved: the ground around a block is mostly bare, lit
    // pavement. Track beds, dirt, and grass verges are not.
    if (ringBare(comp) < MIN_RING_BARE) continue;
    hs.sort((a, b) => a - b);
    const hMed = hs[hs.length >> 1];
    const heightM = Math.max(STACK_MIN_H + 0.5, Math.min(STACK_MAX_H, Math.round(hMed * 2) / 2));
    blocks.push({ comp: body, areaM2, heightM, runs: hs.length, shadeShare: shadeCells / comp.length, roughShare: roughCells / body.length });
  }
  blocks.sort((a, b) => b.areaM2 - a.areaM2);
  // A storage yard is large. A lone small patch is more often an unmapped
  // canopy, a walkway roof, or a parked truck than a stack. Keep small
  // blocks only beside a yard-sized one.
  const anchors = blocks.filter((b) => b.areaM2 >= YARD_ANCHOR_M2);
  if (!anchors.length) return { yards: [], scene, reason: "no yard-sized block", pave };
  const nearR = Math.round(YARD_NEAR_M / cm);
  for (const b of blocks) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of b.comp) {
      const x = c % gw;
      const y = (c - x) / gw;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    b.box = [x0, y0, x1, y1];
  }
  const keep = blocks.filter((b) => {
    if (b.areaM2 >= YARD_ANCHOR_M2) return true;
    return anchors.some((a) => b.box[0] <= a.box[2] + nearR && b.box[2] >= a.box[0] - nearR && b.box[1] <= a.box[3] + nearR && b.box[3] >= a.box[1] - nearR);
  });
  blocks.length = 0;
  blocks.push(...keep);
  const yards = [];
  // A long row or a yard-wide cluster traces to more corners than one
  // OpenIntent area takes. Cut a block into TILE_M squares; each piece is a
  // block of its own at the same height.
  const tileCells = Math.max(4, Math.round(TILE_M / cm));
  const pieces = [];
  for (const b of blocks) {
    const byTile = new Map();
    for (const c of b.comp) {
      const x = c % gw;
      const y = (c - x) / gw;
      const key = Math.floor(x / tileCells) + "," + Math.floor(y / tileCells);
      if (!byTile.has(key)) byTile.set(key, []);
      byTile.get(key).push(c);
    }
    for (const cells of byTile.values()) {
      if (cells.length * cm * cm < MIN_PIECE_M2) continue;
      // A tile can hold two parts of the block; take each connected part.
      const set = new Set(cells);
      const done = new Set();
      for (const c0 of cells) {
        if (done.has(c0)) continue;
        const part = [];
        const st = [c0];
        done.add(c0);
        while (st.length) {
          const c = st.pop();
          part.push(c);
          const x = c % gw;
          for (const n of [c - gw, c + gw, x > 0 ? c - 1 : -1, x < gw - 1 ? c + 1 : -1]) {
            if (n < 0 || done.has(n) || !set.has(n)) continue;
            done.add(n);
            st.push(n);
          }
        }
        if (part.length * cm * cm >= MIN_PIECE_M2) pieces.push({ comp: part, areaM2: part.length * cm * cm, heightM: b.heightM });
      }
    }
  }
  pieces.sort((a, b) => b.areaM2 - a.areaM2);
  for (const b of pieces.slice(0, MAX_BLOCKS)) {
    const loop = traceComponent(b.comp.map((c) => ({ ix: c % gw, iy: (c - (c % gw)) / gw })));
    if (!loop || loop.length < 4) continue;
    let simple = simplifyClosed(loop, 1.2);
    for (let tol = 2; simple.length > 36 && tol < 8; tol += 1) simple = simplifyClosed(loop, tol);
    if (simple.length < 4 || simple.length > 36) continue;
    const ring = simple.map((p) => {
      const x = p[0] * cellPx;
      const y = p[1] * cellPx;
      return [frame.west + (x / W) * (frame.east - frame.west), frame.north - (y / H) * (frame.north - frame.south)];
    });
    const a = ring[0];
    const z = ring[ring.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) ring.push([a[0], a[1]]);
    yards.push({
      kind: "storage",
      coords: ring,
      closed: true,
      heightM: b.heightM,
      explicitHeight: true,
      source: "aerial-shadow",
      areaM2: b.areaM2,
    });
  }
  const out = { yards, scene, reason: yards.length ? "" : "no stacks", pave };
  if (o.debug) Object.assign(out, { debug: { gw, gh, inYard, isBody: cand, isShade: castShade, solid, runL, runH, shadeY, hist: Array.from(hist), cellY } });
  return out;
}

module.exports = { aerialStorageYards, YARD_HOST_M2, YARD_REACH_M, STACK_MIN_H, STACK_MAX_H };
