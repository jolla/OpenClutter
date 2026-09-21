/**
 * OpenClutter tree sources (browser + Node).
 *
 * 1. Default: USFS / NLCD percent tree canopy (CONUS ImageServer getSamples).
 * 2. Fallback: Esri aerial RGB — textured woody canopy, not smooth lawn.
 *
 * Sampling never fills MAX_TREES in scan order (that parked every icon on the
 * north lawn at 8121 S Long Meadow Dr). Collect the whole frame, score, then
 * spatially stratify.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterTrees = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_TREES = 180;
  const MAX_TREES_LARGE = 800;
  /** Keep pixels at or above this NLCD/USFS percent canopy (golf/sparse woods). */
  const MIN_CANOPY_PCT = 18;
  /**
   * Need this many valid 0–100 samples to trust the raster for the bbox.
   * Below this → empty / nodata / outside CONUS → imagery-rgb fallback.
   * Sparse-but-valid canopy (0–7 trees) is still nlcd-canopy, not RGB.
   */
  const MIN_VALID_SAMPLES = 20;
  const TCC_IMAGESERVER =
    "https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer";
  const KNOWN_SOURCES = ["nlcd-canopy", "imagery-rgb", "none"];

  function luma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function canopySampleCount(bbox) {
    const dLon = Math.abs(+bbox.east - +bbox.west);
    const dLat = Math.abs(+bbox.north - +bbox.south);
    // Native TCC is 30 m ≈ 0.00027°. Cap so getSamples stays well under 2 s.
    const nx = Math.max(8, Math.round(dLon / 0.00027));
    const ny = Math.max(8, Math.round(dLat / 0.00027));
    return Math.min(1600, Math.max(64, nx * ny));
  }

  function canopySamplesUrl(bbox, opts) {
    opts = opts || {};
    const sampleCount = opts.sampleCount || canopySampleCount(bbox);
    const geometry = JSON.stringify({
      xmin: +bbox.west,
      ymin: +bbox.south,
      xmax: +bbox.east,
      ymax: +bbox.north,
      spatialReference: { wkid: 4326 },
    });
    const mosaicRule = JSON.stringify({
      mosaicMethod: "esriMosaicAttribute",
      sortField: "beginyear",
      sortAscending: false,
    });
    const u = new URL(TCC_IMAGESERVER + "/getSamples");
    u.searchParams.set("geometry", geometry);
    u.searchParams.set("geometryType", "esriGeometryEnvelope");
    u.searchParams.set("sr", "4326");
    u.searchParams.set("sampleCount", String(sampleCount));
    u.searchParams.set("mosaicRule", mosaicRule);
    u.searchParams.set("returnFirstValueOnly", "true");
    u.searchParams.set("interpolation", "RSP_NearestNeighbor");
    u.searchParams.set("f", "json");
    return u.toString();
  }

  /** 254 = non-processing, 255 = background; reject those and non-numeric. */
  function parseCanopyPct(value) {
    if (value == null) return null;
    const n = +String(value).split(/[,\s]/)[0];
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return n;
  }

  function treesFromCanopySamples(payload, opts) {
    opts = opts || {};
    const minPct = opts.minPct == null ? MIN_CANOPY_PCT : opts.minPct;
    const samples = payload && Array.isArray(payload.samples) ? payload.samples : [];
    const hits = [];
    let validCount = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const loc = (s && s.location) || {};
      const lon = +loc.x;
      const lat = +loc.y;
      const pct = parseCanopyPct(s && s.value);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (pct == null) continue;
      validCount++;
      if (pct >= minPct) hits.push({ lon: lon, lat: lat, score: pct / 100, pct: pct });
    }
    return { samples: samples.length, validCount: validCount, hits: hits };
  }

  /**
   * Trust the raster only when it actually covers the bbox.
   * "Too few points" here means too few *valid samples*, not too few trees.
   */
  function decideCanopy(parsed, opts) {
    opts = opts || {};
    const minValid = opts.minValidSamples == null ? MIN_VALID_SAMPLES : opts.minValidSamples;
    if (!parsed || parsed.samples < 1) return { ok: false, reason: "no-samples" };
    if (parsed.validCount < minValid) return { ok: false, reason: "nodata-or-outside-conus" };
    return { ok: true, reason: "nlcd-canopy" };
  }

  function normalizeTreesSource(value, treeCount) {
    if (KNOWN_SOURCES.indexOf(value) !== -1) return value;
    return treeCount > 0 ? "imagery-rgb" : "none";
  }

  function dedupeByCell(items, toXY, cell) {
    const best = new Map();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const xy = toXY(it);
      const k = Math.floor(xy[0] / cell) + ":" + Math.floor(xy[1] / cell);
      const prev = best.get(k);
      if (!prev || (it.score || 0) > (prev.score || 0)) best.set(k, it);
    }
    return Array.from(best.values());
  }

  function metersPerDeg(lat) {
    const rad = (lat * Math.PI) / 180;
    return { lon: 111320 * Math.cos(rad), lat: 110540 };
  }

  /**
   * Scale the tree cap with map area: ~180 on a small campus, 600–800 on a
   * 2 km golf/resort bbox. Never a UI slider.
   */
  function maxTreesForBbox(bbox) {
    if (!bbox) return MAX_TREES;
    const south = +bbox.south;
    const north = +bbox.north;
    const west = +bbox.west;
    const east = +bbox.east;
    if (![south, north, west, east].every(Number.isFinite)) return MAX_TREES;
    const mpd = metersPerDeg((south + north) / 2);
    const areaKm2 =
      (Math.abs(east - west) * mpd.lon * Math.abs(north - south) * mpd.lat) / 1e6;
    const scaled = Math.round(180 + areaKm2 * 175);
    return Math.max(MAX_TREES, Math.min(MAX_TREES_LARGE, scaled));
  }

  function hash01(lon, lat, salt) {
    const s = Math.sin(lon * 127.1 + lat * 311.7 + (salt || 0) * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function uniqueSorted(nums, digits) {
    const seen = [];
    const k = Math.pow(10, digits == null ? 8 : digits);
    const set = new Set();
    for (let i = 0; i < nums.length; i++) {
      const v = Math.round(nums[i] * k) / k;
      if (!set.has(v)) {
        set.add(v);
        seen.push(v);
      }
    }
    seen.sort(function (a, b) {
      return a - b;
    });
    return seen;
  }

  function medianGap(sorted) {
    if (!sorted || sorted.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > 0) gaps.push(d);
    }
    if (!gaps.length) return null;
    gaps.sort(function (a, b) {
      return a - b;
    });
    return gaps[(gaps.length / 2) | 0];
  }

  function inferCellDeg(hits, bbox) {
    const xs = uniqueSorted(
      hits.map(function (h) {
        return h.lon;
      })
    );
    const ys = uniqueSorted(
      hits.map(function (h) {
        return h.lat;
      })
    );
    const dx = medianGap(xs);
    const dy = medianGap(ys);
    const dLon = Math.abs(+bbox.east - +bbox.west) || 0.001;
    const dLat = Math.abs(+bbox.north - +bbox.south) || 0.001;
    return {
      lon: dx && dx > 1e-8 ? dx : dLon / Math.max(8, xs.length),
      lat: dy && dy > 1e-8 ? dy : dLat / Math.max(8, ys.length),
    };
  }

  function isLocalMax(grid, key, pct) {
    const cell = grid.get(key);
    if (!cell) return false;
    const ix = cell.ix;
    const iy = cell.iy;
    let maxN = pct;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const o = grid.get(ix + dx + ":" + (iy + dy));
        if (!o) continue;
        n++;
        if (o.pct > maxN) maxN = o.pct;
      }
    }
    return n >= 2 && pct >= maxN && pct >= MIN_CANOPY_PCT;
  }

  function woodsNeighborCount(grid, key, minPct) {
    const cell = grid.get(key);
    if (!cell) return 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const o = grid.get(cell.ix + dx + ":" + (cell.iy + dy));
        if (o && o.pct >= minPct) n++;
      }
    }
    return n;
  }

  /**
   * Round-robin NMS across spatial bins so continuous woods fill instead of
   * isolated yard peaks taking the whole cap.
   */
  function nmsStratified(candidates, bbox, maxTrees, distFn) {
    if (!candidates || !candidates.length || maxTrees <= 0) return [];
    const mpd = metersPerDeg((+bbox.south + +bbox.north) / 2);
    const binsX = 12;
    const binsY = 12;
    const west = +bbox.west;
    const south = +bbox.south;
    const dx = (+bbox.east - west) || 1;
    const dy = (+bbox.north - south) || 1;
    const bins = [];
    for (let i = 0; i < binsX * binsY; i++) bins.push([]);
    const scored = candidates.slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    for (let i = 0; i < scored.length; i++) {
      const c = scored[i];
      let bx = Math.floor(((c.lon - west) / dx) * binsX);
      let by = Math.floor(((c.lat - south) / dy) * binsY);
      if (bx < 0) bx = 0;
      if (by < 0) by = 0;
      if (bx >= binsX) bx = binsX - 1;
      if (by >= binsY) by = binsY - 1;
      bins[by * binsX + bx].push(c);
    }
    const kept = [];
    let guard = 0;
    while (kept.length < maxTrees && guard < maxTrees + 4) {
      guard++;
      let added = false;
      for (let i = 0; i < bins.length; i++) {
        if (kept.length >= maxTrees) break;
        const bin = bins[i];
        while (bin.length) {
          const c = bin.shift();
          const minD = distFn(c);
          let ok = true;
          for (let k = 0; k < kept.length; k++) {
            const ddx = (c.lon - kept[k].lon) * mpd.lon;
            const ddy = (c.lat - kept[k].lat) * mpd.lat;
            if (ddx * ddx + ddy * ddy < minD * minD) {
              ok = false;
              break;
            }
          }
          if (ok) {
            kept.push(c);
            added = true;
            break;
          }
        }
      }
      if (!added) break;
    }
    return kept;
  }

  function canopyNmsDistM(c) {
    const score = Math.min(1, c.score || 0);
    const d = 7 + 9 * (1 - score);
    return c.woods ? d * 0.72 : d;
  }

  /**
   * NLCD getSamples (and RGB step lattices) are regular grids. Do not plant a
   * tree on every cell center — that is the Long Meadow orchard.
   *
   * Treat canopy % as a density field: local-maxima get a tree, woods get a
   * few jittered points with non-max suppression, lawns (low %) get few/none.
   */
  function placeTreesFromCanopy(hits, bbox, opts) {
    opts = opts || {};
    const minPct = opts.minPct == null ? MIN_CANOPY_PCT : opts.minPct;
    const maxTrees = opts.maxTrees == null ? maxTreesForBbox(bbox) : opts.maxTrees;
    if (!hits || !hits.length || maxTrees <= 0) return [];
    const mpd = metersPerDeg((+bbox.south + +bbox.north) / 2);
    const cell = inferCellDeg(hits, bbox);
    const originLon = +bbox.west;
    const originLat = +bbox.south;
    const grid = new Map();
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const pct = h.pct != null ? +h.pct : (h.score || 0) * 100;
      if (!Number.isFinite(pct) || pct < minPct) continue;
      const ix = Math.round((h.lon - originLon) / cell.lon);
      const iy = Math.round((h.lat - originLat) / cell.lat);
      const key = ix + ":" + iy;
      const prev = grid.get(key);
      if (!prev || pct > prev.pct) {
        grid.set(key, { lon: h.lon, lat: h.lat, pct: pct, ix: ix, iy: iy });
      }
    }
    const cellArea = cell.lon * mpd.lon * cell.lat * mpd.lat;
    const candidates = [];
    grid.forEach(function (c, key) {
      const frac = Math.max(0, Math.min(1, (c.pct - minPct) / (100 - minPct)));
      const peak = isLocalMax(grid, key, c.pct);
      const woods = woodsNeighborCount(grid, key, minPct) >= 3;
      const spacing = woods ? 10 - 4 * frac : 18 - 8 * frac;
      let lambda = (c.pct / 100) * (cellArea / Math.max(36, spacing * spacing));
      lambda = Math.min(woods ? 4.5 : 2.5, lambda);
      if (peak) lambda = Math.max(lambda, 1.0 + 0.6 * frac);
      if (woods) lambda = Math.max(lambda, 0.85 + 1.4 * frac);
      if (!peak && !woods && c.pct < minPct + 15) lambda *= 0.35;
      const n0 = Math.floor(lambda);
      const n = Math.min(woods ? 5 : 3, n0 + (hash01(c.lon, c.lat, 1) < lambda - n0 ? 1 : 0));
      for (let i = 0; i < n; i++) {
        const jx = (hash01(c.lon, c.lat, 10 + i) - 0.5) * 0.92;
        const jy = (hash01(c.lon, c.lat, 30 + i) - 0.5) * 0.92;
        const lon = c.lon + jx * cell.lon;
        const lat = c.lat + jy * cell.lat;
        if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) continue;
        candidates.push({
          lon: lon,
          lat: lat,
          pct: c.pct,
          woods: woods,
          score: c.pct / 100 + (peak ? 0.08 : 0) + (woods ? 0.12 : 0) - i * 0.03,
        });
      }
    });
    const kept = nmsStratified(candidates, bbox, maxTrees, canopyNmsDistM);
    return kept.map(function (t) {
      return { lon: t.lon, lat: t.lat, pct: t.pct };
    });
  }

  /**
   * Whole-frame pick: highest score per spatial bin, round-robin so the south
   * woods are not starved after the north lawn fills a scan-order cap.
   */
  function pickStratified(items, maxCount, toXY, x0, y0, x1, y1, binsX, binsY) {
    maxCount = maxCount == null ? MAX_TREES : maxCount;
    binsX = binsX || 8;
    binsY = binsY || 8;
    if (!items || !items.length || maxCount <= 0) return [];
    if (items.length <= maxCount) {
      return items.slice().sort(function (a, b) {
        return (b.score || 0) - (a.score || 0);
      });
    }
    const dx = x1 - x0 || 1;
    const dy = y1 - y0 || 1;
    const bins = [];
    for (let i = 0; i < binsX * binsY; i++) bins.push([]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const xy = toXY(it);
      let bx = Math.floor(((xy[0] - x0) / dx) * binsX);
      let by = Math.floor(((xy[1] - y0) / dy) * binsY);
      if (bx < 0) bx = 0;
      if (by < 0) by = 0;
      if (bx >= binsX) bx = binsX - 1;
      if (by >= binsY) by = binsY - 1;
      bins[by * binsX + bx].push(it);
    }
    for (let i = 0; i < bins.length; i++) {
      bins[i].sort(function (a, b) {
        return (b.score || 0) - (a.score || 0);
      });
    }
    const out = [];
    const used = new Set();
    let round = 0;
    while (out.length < maxCount) {
      let added = false;
      for (let i = 0; i < bins.length; i++) {
        if (out.length >= maxCount) break;
        const bin = bins[i];
        if (round < bin.length) {
          const it = bin[round];
          const k = toXY(it).join(",");
          if (!used.has(k)) {
            used.add(k);
            out.push(it);
            added = true;
          }
        }
      }
      if (!added) break;
      round++;
    }
    return out;
  }

  function pickCanopyTrees(hits, bbox, opts) {
    opts = opts || {};
    if (opts.maxTrees == null) opts = Object.assign({}, opts, { maxTrees: maxTreesForBbox(bbox) });
    return placeTreesFromCanopy(hits, bbox, opts);
  }

  function mergeTreePoints(a, b, bbox, opts) {
    opts = opts || {};
    const maxTrees = opts.maxTrees == null ? maxTreesForBbox(bbox) : opts.maxTrees;
    const src = (a || []).concat(b || []);
    const all = [];
    for (let i = 0; i < src.length; i++) {
      const t = src[i];
      if (!t) continue;
      const lon = +(Array.isArray(t) ? t[0] : t.lon != null ? t.lon : t.lng);
      const lat = +(Array.isArray(t) ? t[1] : t.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const pct = t.pct != null ? +t.pct : t.score != null ? +t.score * 100 : 50;
      const score = t.score != null ? +t.score : pct / 100;
      all.push({
        lon: lon,
        lat: lat,
        pct: Number.isFinite(pct) ? pct : 50,
        score: Number.isFinite(score) ? score : 0.5,
        woods: !!t.woods,
      });
    }
    return nmsStratified(all, bbox, maxTrees, canopyNmsDistM).map(function (t) {
      const out = { lon: t.lon, lat: t.lat };
      if (t.pct != null) out.pct = t.pct;
      if (t.score != null) out.score = t.score;
      return out;
    });
  }

  async function fetchCanopyTrees(bbox, fetchFn, opts) {
    opts = opts || {};
    const url = canopySamplesUrl(bbox, opts);
    const r = await fetchFn(url);
    if (!r.ok) throw new Error("canopy HTTP " + r.status);
    const json = await r.json();
    const parsed = treesFromCanopySamples(json, opts);
    const decided = decideCanopy(parsed, opts);
    if (!decided.ok) {
      return { trees: [], source: null, reason: decided.reason, parsed: parsed };
    }
    return {
      trees: pickCanopyTrees(parsed.hits, bbox, opts),
      source: "nlcd-canopy",
      reason: decided.reason,
      parsed: parsed,
    };
  }

  /**
   * Color gate: green canopy + winter brown/gray woody. Lawn also matches green;
   * texture must reject it. Hard-reject water, bright roof, gray pavement.
   */
  function vegColorScore(r, g, b) {
    const s = r + g + b;
    if (s < 45 || s > 460) return 0;
    if (b > 125 && b > g + 8) return 0;
    if (b > r + 18 && b > g + 12) return 0;
    if (r > 185 && g > 170) return 0;
    const Y = luma(r, g, b);
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const sat = maxc === 0 ? 0 : (maxc - minc) / maxc;
    if (Y > 175 && sat < 0.2) return 0;

    const exg = 2 * g - r - b;
    const olive =
      g >= r - 18 &&
      g > b + 4 &&
      r > 32 &&
      r < 170 &&
      g > 36 &&
      g < 160 &&
      b < 120 &&
      exg > 4;
    if (olive) return Y < 95 ? 0.9 : Y < 125 ? 0.75 : 0.55;

    const dusty =
      r >= g - 8 &&
      r > b + 10 &&
      r > 40 &&
      r < 150 &&
      g > 36 &&
      g < 130 &&
      b < 95 &&
      g > r * 0.5;
    if (dusty) return Y < 110 ? 0.82 : 0.62;

    const winterBrown =
      Y > 28 &&
      Y < 130 &&
      r > 32 &&
      g > 28 &&
      b < 115 &&
      r < 170 &&
      g < 155 &&
      Math.abs(r - g) <= 40 &&
      (r > b + 6 || g > b + 6) &&
      sat > 0.06 &&
      sat < 0.6;
    if (winterBrown) return Y < 85 ? 0.88 : 0.7;

    const winterGray =
      Y > 30 && Y < 105 && sat < 0.22 && Math.abs(r - g) < 18 && Math.abs(g - b) < 22 && r < 140;
    if (winterGray) return 0.55;
    return 0;
  }

  function isVeg(r, g, b) {
    return vegColorScore(r, g, b) > 0;
  }

  function localLumaStats(data, w, h, x, y, radius, step) {
    radius = radius == null ? 5 : radius;
    step = step == null ? 2 : step;
    const i0 = (y * w + x) * 4;
    const Y0 = luma(data[i0], data[i0 + 1], data[i0 + 2]);
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    let vegN = 0;
    let absDev = 0;
    let minL = 255;
    let maxL = 0;
    for (let dy = -radius; dy <= radius; dy += step) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -radius; dx <= radius; dx += step) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const i = (yy * w + xx) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const Y = luma(r, g, b);
        n++;
        sum += Y;
        sum2 += Y * Y;
        absDev += Math.abs(Y - Y0);
        if (Y < minL) minL = Y;
        if (Y > maxL) maxL = Y;
        if (vegColorScore(r, g, b) > 0) vegN++;
      }
    }
    const mean = n ? sum / n : 0;
    const variance = n ? sum2 / n - mean * mean : 0;
    return {
      n: n,
      mean: mean,
      std: Math.sqrt(Math.max(0, variance)),
      range: maxL - minL,
      vegFrac: n ? vegN / n : 0,
      absDev: n ? absDev / n : 0,
      center: Y0,
    };
  }

  function canopyScore(colorScore, stats) {
    if (colorScore <= 0) return 0;
    if (!stats || stats.n < 8) return 0;
    if (stats.vegFrac < 0.22) return 0;
    // Smooth lawn / water / roof: low local texture even when the color is green.
    if (stats.std < 7.5 && stats.range < 22) return 0;
    if (stats.absDev < 5 && stats.std < 10) return 0;
    const texture = Math.min(1, (stats.std - 4) / 24);
    if (texture < 0.12) return 0;
    const dark = stats.mean < 90 ? 1.12 : stats.mean < 115 ? 1.0 : 0.82;
    const neighborhood = 0.55 + 0.45 * Math.min(1, stats.vegFrac / 0.7);
    return colorScore * (0.3 + 0.7 * texture) * dark * neighborhood;
  }

  function inBuildingAabb(x, y, boxes, pad) {
    if (!boxes || !boxes.length) return false;
    pad = pad || 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad) {
        return true;
      }
    }
    return false;
  }

  function collectRgbCandidates(data, w, h, opts) {
    opts = opts || {};
    const step = opts.step || 8;
    const radius = opts.radius || 5;
    const minScore = opts.minScore == null ? 0.28 : opts.minScore;
    const boxes = opts.buildingAabbs;
    const hits = [];
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        if (inBuildingAabb(x, y, boxes, 2)) continue;
        const i = (y * w + x) * 4;
        const color = vegColorScore(data[i], data[i + 1], data[i + 2]);
        if (color <= 0) continue;
        const stats = localLumaStats(data, w, h, x, y, radius, 2);
        const score = canopyScore(color, stats);
        if (score < minScore) continue;
        hits.push({ x: x, y: y, score: score });
      }
    }
    return hits;
  }

  function scatterNmsPixels(hits, maxCount, minDist) {
    maxCount = maxCount == null ? MAX_TREES : maxCount;
    minDist = minDist == null ? (maxCount >= 400 ? 9 : 14) : minDist;
    const scored = (hits || []).slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    const out = [];
    const minD2 = minDist * minDist;
    for (let i = 0; i < scored.length; i++) {
      if (out.length >= maxCount) break;
      const h = scored[i];
      const jx = (hash01(h.x, h.y, 3) - 0.5) * 7;
      const jy = (hash01(h.x, h.y, 9) - 0.5) * 7;
      const x = h.x + jx;
      const y = h.y + jy;
      let ok = true;
      for (let k = 0; k < out.length; k++) {
        const dx = x - out[k].x;
        const dy = y - out[k].y;
        if (dx * dx + dy * dy < minD2) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ x: x, y: y, score: h.score });
    }
    return out;
  }

  function detectTreesFromImageData(data, w, h, bbox, opts) {
    opts = opts || {};
    const maxTrees = opts.maxTrees == null ? (bbox ? maxTreesForBbox(bbox) : MAX_TREES) : opts.maxTrees;
    const hits = collectRgbCandidates(data, w, h, opts);
    const minDist = opts.minDist != null ? opts.minDist : maxTrees >= 400 ? 9 : 14;
    const picked = scatterNmsPixels(hits, maxTrees, minDist);
    if (!bbox) return picked;
    const west = +bbox.west;
    const south = +bbox.south;
    const east = +bbox.east;
    const north = +bbox.north;
    return picked.map(function (p) {
      return {
        lon: west + (p.x / w) * (east - west),
        lat: north - (p.y / h) * (north - south),
        score: p.score,
      };
    });
  }

  return {
    MAX_TREES: MAX_TREES,
    MAX_TREES_LARGE: MAX_TREES_LARGE,
    MIN_CANOPY_PCT: MIN_CANOPY_PCT,
    MIN_VALID_SAMPLES: MIN_VALID_SAMPLES,
    TCC_IMAGESERVER: TCC_IMAGESERVER,
    KNOWN_SOURCES: KNOWN_SOURCES,
    maxTreesForBbox: maxTreesForBbox,
    canopySampleCount: canopySampleCount,
    canopySamplesUrl: canopySamplesUrl,
    parseCanopyPct: parseCanopyPct,
    treesFromCanopySamples: treesFromCanopySamples,
    decideCanopy: decideCanopy,
    normalizeTreesSource: normalizeTreesSource,
    dedupeByCell: dedupeByCell,
    pickStratified: pickStratified,
    placeTreesFromCanopy: placeTreesFromCanopy,
    pickCanopyTrees: pickCanopyTrees,
    mergeTreePoints: mergeTreePoints,
    scatterNmsPixels: scatterNmsPixels,
    fetchCanopyTrees: fetchCanopyTrees,
    vegColorScore: vegColorScore,
    isVeg: isVeg,
    localLumaStats: localLumaStats,
    canopyScore: canopyScore,
    collectRgbCandidates: collectRgbCandidates,
    detectTreesFromImageData: detectTreesFromImageData,
  };
});
