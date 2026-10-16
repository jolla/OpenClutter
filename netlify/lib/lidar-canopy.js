"use strict";

/**
 * Tree canopy traced from USGS 3DEP lidar.
 *
 * The Meta/WRI canopy height map is a model. Over parks, resorts, and
 * campgrounds it spreads crowns across lawns and lots; at the bench sites it
 * drew 1.5 to 2.5 times the canopy the lidar measured. Where a 3DEP cloud
 * covers the draw, each canopy cell is read from the points instead:
 *
 * - Vegetation classes 3/4/5 when the project classified them. Otherwise a
 *   first return that is not ground, building, water, road, rail, wire,
 *   tower, or bridge, and only where the pulse split into more returns.
 *   A roof, trailer, car, or pole top is a hard single return; a crown is not.
 * - A lone tall cell with almost no split returns is a pole or a mast.
 * - Leaf-off flights (November to April) keep a crown that the pulses partly
 *   passed through: one vegetation return is enough, holes inside a crown are
 *   closed from the cells around them, and the Meta height is kept where the
 *   lidar saw branches nearby.
 * - Where the cloud is sparse or missing, the Meta cell stays as it was.
 *
 * Nothing is added where neither source has canopy. Building footprints
 * clear their cells. Water and vehicle masks run after this on the same grid.
 */

const { mercator, groundAt } = require("./usgs-lidar");

const CANOPY_MIN_M = 3;
const CANOPY_MAX_M = 75;
const POLE_MIN_M = 8;

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function leafOffDate(collected, lat) {
  const m = /^\d{4}-(\d{2})/.exec(String(collected || ""));
  if (!m) return false;
  const month = +m[1];
  // South Florida, south Texas, Hawaii, and the desert keep their leaves.
  if (!(lat >= 31)) return false;
  return month <= 4 || month >= 11;
}

function gridLattice(frame, cellM) {
  const lat = (+frame.south + +frame.north) / 2;
  const widthM = Math.abs(+frame.east - +frame.west) * 111320 * Math.cos((lat * Math.PI) / 180);
  const heightM = Math.abs(+frame.north - +frame.south) * 110540;
  let width = Math.max(8, Math.round(widthM / cellM));
  let height = Math.max(8, Math.round(heightM / cellM));
  const over = Math.max(width / 720, height / 720, 1);
  width = Math.max(8, Math.round(width / over));
  height = Math.max(8, Math.round(height / over));
  return {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
    width,
    height,
    values: new Uint8Array(width * height),
    nonzero: 0,
  };
}

/** Per-cell lidar canopy heights. Returns Map key -> { h, ok, evidence }. */
function lidarCells(grid, opts) {
  const leafOff = !!opts.leafOff;
  const counts = grid.counts || {};
  const vegPts = (counts[3] || 0) + (counts[4] || 0) + (counts[5] || 0);
  const classified = grid.kept > 0 && vegPts / grid.kept > 0.03;
  // Some clouds carry neither vegetation classes nor return numbers. There
  // a crown is told from a roof or a trailer by its shape below.
  let tcAll = 0;
  let splitAll = 0;
  for (const rec of grid.cells.values()) {
    tcAll += rec.tc;
    splitAll += rec.mr + rec.lr;
  }
  const splitKnown = tcAll > 0 && splitAll / tcAll > 0.03;
  const ns = [];
  for (const rec of grid.cells.values()) if (rec.n > 0) ns.push(rec.n);
  const nMed = median(ns);
  const minN = Math.max(3, Math.round(nMed * 0.3));
  const out = new Map();
  for (const [key, rec] of grid.cells) {
    const g = groundAt(grid, rec.ix, rec.iy);
    const ok = rec.n >= minN && g != null;
    let h = 0;
    let evidence = false;
    if (g != null) {
      if (classified) {
        if (rec.vegMax != null && rec.vegN >= 1) {
          const top = rec.vegMax - g;
          if (top >= CANOPY_MIN_M) evidence = true;
          if (rec.vegN >= (leafOff ? 1 : 2) && rec.fc >= (leafOff ? 1 : 2) && top >= CANOPY_MIN_M && top <= CANOPY_MAX_M) h = top;
        }
      } else if (rec.tMax != null && rec.tc >= 1) {
        const top = rec.tMax - g;
        const split = splitKnown ? rec.mr + rec.lr : rec.tc;
        if (top >= CANOPY_MIN_M && split >= 1) evidence = true;
        const need = !splitKnown ? 1 : leafOff ? 1 : Math.max(1, Math.ceil(rec.tc * 0.15));
        if (rec.tc >= 2 && split >= need && top >= CANOPY_MIN_M && top <= CANOPY_MAX_M) h = top;
      }
    }
    out.set(key, { ix: rec.ix, iy: rec.iy, h, ok, evidence, n: rec.n, split: rec.mr + rec.lr + rec.vegN });
  }
  let flat = 0;
  if (!classified && !splitKnown) flat = dropFlatTops(out);
  // A lone tall cell with almost no split returns is a pole, mast, or lamp.
  let poles = 0;
  for (const c of out.values()) {
    if (!(c.h >= POLE_MIN_M)) continue;
    let near = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const n = out.get(c.ix + dx + "," + (c.iy + dy));
        if (n && n.h >= CANOPY_MIN_M) near++;
      }
    }
    if (near === 0 && (splitKnown || classified ? c.split < 3 : true)) {
      c.h = 0;
      c.pole = true;
      poles++;
    }
  }
  // Leaf-off: close holes inside a crown from the ring of cells around it.
  let closed = 0;
  if (leafOff) {
    const fills = [];
    for (const c of out.values()) {
      if (c.h >= CANOPY_MIN_M || c.pole) continue;
      const hs = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const n = out.get(c.ix + dx + "," + (c.iy + dy));
          if (n && n.h >= CANOPY_MIN_M) hs.push(n.h);
        }
      }
      if (hs.length >= 5) fills.push([c, median(hs)]);
    }
    for (const [c, h] of fills) {
      c.h = h;
      closed++;
    }
  }
  return { cells: out, classified, splitKnown, nMed, minN, poles, closed, flat };
}

/**
 * A cell with few points of its own is still measured when the cells around
 * it carry the cloud. Its height is its own crown, or the crown that
 * surrounds it on most sides. An edge or a gap in the cloud stays unmeasured.
 */
function coveredCell(read, ix, iy, own) {
  let n = 0;
  let ground = 0;
  const hs = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const k = read.cells.get(ix + dx + "," + (iy + dy));
      if (!k) continue;
      n += k.n;
      if (k.ok || k.n > 0) ground++;
      if ((dx || dy) && k.h >= CANOPY_MIN_M) hs.push(k.h);
    }
  }
  if (ground < 6 || n < read.minN * 3) return null;
  let h = own && own.h >= CANOPY_MIN_M ? own.h : 0;
  if (!h && (!own || own.n < 2) && hs.length >= 5) h = median(hs);
  return { ix, iy, h, ok: true, evidence: (own && own.evidence) || hs.length > 0, pole: own && own.pole, n: own ? own.n : 0 };
}

/**
 * Without classes or return numbers, a roof, a trailer, or a parked truck is
 * a patch of cells at one height. A crown is not. Patches of six or more
 * cells whose tops stay within a few decimetres are cleared.
 */
function dropFlatTops(cells) {
  const seen = new Set();
  let dropped = 0;
  for (const [key, c] of cells) {
    if (!(c.h >= CANOPY_MIN_M) || seen.has(key)) continue;
    const comp = [];
    const stack = [c];
    seen.add(key);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const k = cur.ix + dx + "," + (cur.iy + dy);
          if (seen.has(k)) continue;
          const n = cells.get(k);
          if (n && n.h >= CANOPY_MIN_M) {
            seen.add(k);
            stack.push(n);
          }
        }
      }
    }
    if (comp.length < 6) continue;
    // Local roughness: mean step to the next cell of the patch.
    let steps = 0;
    let sum = 0;
    for (const cur of comp) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const n = cells.get(cur.ix + dx + "," + (cur.iy + dy));
        if (n && n.h >= CANOPY_MIN_M) {
          sum += Math.abs(n.h - cur.h);
          steps++;
        }
      }
    }
    const rough = steps ? sum / steps : 0;
    if (rough < 0.35) {
      for (const cur of comp) cur.h = 0;
      dropped += comp.length;
    }
  }
  return dropped;
}

/**
 * One speckle pass on the measured part of the grid: a lone canopy pixel is
 * cleared and a pixel ringed by canopy on six sides is filled. Crowns become
 * whole outlines instead of thousands of fragments.
 */
function despeckle(values, decided, w, h) {
  const next = new Uint8Array(values);
  let filled = 0;
  let cleared = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!decided[i]) continue;
      let n = 0;
      const hs = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const v = values[i + dy * w + dx];
          if (v >= CANOPY_MIN_M) {
            n++;
            hs.push(v);
          }
        }
      }
      if (values[i] >= CANOPY_MIN_M && n === 0) {
        next[i] = 0;
        cleared++;
      } else if (!(values[i] >= CANOPY_MIN_M) && n >= 6) {
        next[i] = median(hs);
        filled++;
      }
    }
  }
  values.set(next);
  filled += closeGaps(values, decided, w, h);
  return { filled, cleared };
}

/**
 * 3x3 closing on the measured part of the grid: a one-pixel gap between two
 * crowns joins them; the outer edge of a stand does not move. Fewer, whole
 * outlines fit the zip's outline budget. A filled pixel takes the median
 * height of the crowns around it.
 */
function closeGaps(values, decided, w, h) {
  const tall = new Uint8Array(w * h);
  for (let i = 0; i < tall.length; i++) tall[i] = values[i] >= CANOPY_MIN_M ? 1 : 0;
  const grown = new Uint8Array(tall);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (tall[i] || !decided[i]) continue;
      for (let dy = -1; dy <= 1 && !grown[i]; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (tall[i + dy * w + dx]) {
            grown[i] = 1;
            break;
          }
        }
      }
    }
  }
  let filled = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (tall[i] || !grown[i]) continue;
      let keep = true;
      for (let dy = -1; dy <= 1 && keep; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!grown[i + dy * w + dx]) {
            keep = false;
            break;
          }
        }
      }
      if (!keep) continue;
      const hs = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = values[i + dy * w + dx];
          if (v >= CANOPY_MIN_M) hs.push(v);
        }
      }
      if (hs.length < 4) continue;
      values[i] = median(hs);
      filled++;
    }
  }
  return filled;
}

function ringPx(ring, lattice) {
  const w = lattice.width;
  const h = lattice.height;
  const dLon = lattice.east - lattice.west || 1e-9;
  const dLat = lattice.north - lattice.south || 1e-9;
  return ring.map((p) => [((p[0] - lattice.west) / dLon) * w, ((lattice.north - p[1]) / dLat) * h]);
}

/** Scanline fill of one ring onto a w*h mask (pixel centres). */
function fillRing(mask, w, h, pts) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a[1] > cy !== b[1] > cy) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) {
        mask[y * w + x] = 1;
        n++;
      }
    }
  }
  return n;
}

function featureRings(f) {
  if (!f) return [];
  if (Array.isArray(f.coords) && f.coords.length >= 3) return [f.coords];
  const g = f.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates && g.coordinates[0] ? [g.coordinates[0]] : [];
  if (g.type === "MultiPolygon") return (g.coordinates || []).map((p) => p && p[0]).filter(Boolean);
  return [];
}

/** Clear grid cells inside the given footprints. Returns cells cleared. */
function clearInside(grid, list) {
  if (!grid || !grid.values || !Array.isArray(list) || !list.length) return 0;
  if (typeof grid.values === "string") grid.values = Buffer.from(grid.values, "base64");
  const w = grid.width | 0;
  const h = grid.height | 0;
  const mask = new Uint8Array(w * h);
  for (const f of list) {
    for (const ring of featureRings(f)) fillRing(mask, w, h, ringPx(ring, grid));
  }
  let cleared = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && grid.values[i] > 0) {
      grid.values[i] = 0;
      cleared++;
    }
  }
  if (cleared) recount(grid);
  return cleared;
}

function recount(grid) {
  let nz = 0;
  for (let i = 0; i < grid.values.length; i++) if (grid.values[i] >= CANOPY_MIN_M) nz++;
  grid.nonzero = nz;
}

/**
 * Lidar canopy on the Meta grid's lattice.
 * chmGrid may be null; the lattice is then built from the frame.
 * Returns { grid, decided, stats } or null when the cloud cannot be used.
 * decided[i] = 1 where the lidar measured that cell (canopy or open ground).
 */
function fuseLidarCanopy(chmGrid, lidar, opts) {
  const opt = opts || {};
  if (!lidar || lidar.skipped || !lidar.grid || !lidar.grid.cells || lidar.grid.kept < 500) return null;
  const frame = opt.frame || lidar.frame;
  const lat = (+frame.south + +frame.north) / 2;
  const leafOff = opt.leafOff != null ? !!opt.leafOff : leafOffDate(lidar.collected, lat);
  const base = chmGrid && chmGrid.values ? chmGrid : null;
  const lattice = base
    ? Object.assign({}, base, {
        values: new Uint8Array(typeof base.values === "string" ? Buffer.from(base.values, "base64") : base.values),
      })
    : gridLattice(frame, 2.2);
  const meta = base ? (typeof base.values === "string" ? Buffer.from(base.values, "base64") : base.values) : null;
  const read = lidarCells(lidar.grid, { leafOff });
  const g = lidar.grid;
  const w = lattice.width;
  const h = lattice.height;
  const dLon = lattice.east - lattice.west || 1e-9;
  const dLat = lattice.north - lattice.south || 1e-9;
  const decided = new Uint8Array(w * h);
  const values = lattice.values;
  let fromLidar = 0;
  let keptMeta = 0;
  let leafOffMeta = 0;
  let metaBefore = 0;
  let removed = 0;
  for (let y = 0; y < h; y++) {
    const la = lattice.north - ((y + 0.5) / h) * dLat;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const mv = meta ? meta[i] : 0;
      if (mv >= CANOPY_MIN_M) metaBefore++;
      const lo = lattice.west + ((x + 0.5) / w) * dLon;
      const xy = mercator(lo, la);
      const ix = Math.floor((xy[0] - g.originX) / g.cell);
      const iy = Math.floor((xy[1] - g.originY) / g.cell);
      // Every lidar cell under this pixel: the tallest measured crown wins.
      const a = mercator(lattice.west + (x / w) * dLon, lattice.north - ((y + 1) / h) * dLat);
      const b = mercator(lattice.west + ((x + 1) / w) * dLon, lattice.north - (y / h) * dLat);
      const ix0 = Math.floor((a[0] - g.originX) / g.cell);
      const ix1 = Math.floor((b[0] - 1e-6 - g.originX) / g.cell);
      const iy0 = Math.floor((a[1] - g.originY) / g.cell);
      const iy1 = Math.floor((b[1] - 1e-6 - g.originY) / g.cell);
      // A pixel is canopy when the centre cell is, or when at least half of
      // the measured cells under it are. The edge of a crown does not grow.
      let c = read.cells.get(ix + "," + iy);
      if (!c || !c.ok) c = coveredCell(read, ix, iy, c);
      let seen = 0;
      let tall = 0;
      let best = null;
      for (let yy = iy0; yy <= iy1; yy++) {
        for (let xx = ix0; xx <= ix1; xx++) {
          let k = read.cells.get(xx + "," + yy);
          if (!k || !k.ok) k = coveredCell(read, xx, yy, k);
          if (!k) continue;
          seen++;
          if (k.h >= CANOPY_MIN_M) {
            tall++;
            if (!best || k.h > best.h) best = k;
          }
        }
      }
      if (seen && (!c || !(c.h >= CANOPY_MIN_M)) && best && tall * 2 >= seen) c = best;
      else if (!c && seen) c = { h: 0, ok: true, evidence: tall > 0 };
      if (!c) {
        // Sparse or no cloud: the Meta cell stays.
        if (mv >= CANOPY_MIN_M) keptMeta++;
        continue;
      }
      decided[i] = 1;
      let v = c.h >= CANOPY_MIN_M ? Math.min(255, Math.round(c.h)) : 0;
      if (!v && leafOff && mv >= CANOPY_MIN_M && !c.pole) {
        // Leaf-off: the pulses passed a bare crown. Keep the Meta height
        // only where this cell or a neighbour returned off branches.
        let branches = c.evidence;
        for (let dy = -1; dy <= 1 && !branches; dy++) {
          for (let dx = -1; dx <= 1 && !branches; dx++) {
            const n = read.cells.get(ix + dx + "," + (iy + dy));
            if (n && (n.evidence || n.h >= CANOPY_MIN_M)) branches = true;
          }
        }
        if (branches) {
          v = mv;
          leafOffMeta++;
          decided[i] = 0;
        }
      }
      if (mv >= CANOPY_MIN_M && !v) removed++;
      if (v) fromLidar++;
      values[i] = v;
    }
  }
  const speck = despeckle(values, decided, w, h);
  let buildingCells = 0;
  if (Array.isArray(opt.buildings) && opt.buildings.length) {
    const mask = new Uint8Array(w * h);
    for (const f of opt.buildings) for (const ring of featureRings(f)) fillRing(mask, w, h, ringPx(ring, lattice));
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && values[i] > 0) {
        values[i] = 0;
        buildingCells++;
      }
    }
  }
  recount(lattice);
  let decidedN = 0;
  for (let i = 0; i < decided.length; i++) if (decided[i]) decidedN++;
  lattice.source = "lidar";
  lattice.lidarDecided = decided;
  return {
    grid: lattice,
    decided,
    stats: {
      leafOff,
      classified: read.classified,
      cellsDecided: decidedN,
      cellsTotal: w * h,
      lidarCanopy: fromLidar,
      metaKept: keptMeta,
      leafOffMeta,
      metaBefore,
      metaRemoved: removed,
      poles: read.poles,
      closed: read.closed,
      flat: read.flat,
      splitKnown: read.splitKnown,
      speckFilled: speck.filled,
      speckCleared: speck.cleared,
      buildingCells,
      after: lattice.nonzero,
    },
  };
}

/** Zero cells the lidar measured as open after a gap fill added them. */
function keepLidarOpen(grid, decided, original) {
  if (!grid || !grid.values || !decided || decided.length !== grid.values.length) return 0;
  if (typeof grid.values === "string") grid.values = Buffer.from(grid.values, "base64");
  let n = 0;
  for (let i = 0; i < decided.length; i++) {
    if (!decided[i]) continue;
    const was = original ? original[i] : 0;
    if (grid.values[i] !== was) {
      grid.values[i] = was;
      n++;
    }
  }
  if (n) recount(grid);
  return n;
}

const VEHICLE_KINDS = new Set(["storage", "trailer", "trailer-candidate", "rv", "car", "truck"]);

function vehicleFeatures(list) {
  return (Array.isArray(list) ? list : []).filter((f) => f && VEHICLE_KINDS.has(f.kind));
}

function lidarCanopyNote(stats) {
  if (!stats) return "";
  const pct = stats.cellsTotal ? Math.round((stats.cellsDecided / stats.cellsTotal) * 100) : 0;
  let s = "Tree canopy traced from USGS lidar over " + pct + "% of the draw";
  if (stats.leafOff) s += " (leaf-off flight; bare crowns kept where the lidar saw branches)";
  s += pct < 100 ? ". The rest uses the canopy height map." : ".";
  return s;
}

module.exports = {
  fuseLidarCanopy,
  keepLidarOpen,
  clearInside,
  vehicleFeatures,
  lidarCanopyNote,
  leafOffDate,
  lidarCells,
};
