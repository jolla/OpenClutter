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

  const MAX_TREES = 250;
  /** Keep pixels at or above this NLCD/USFS percent canopy. */
  const MIN_CANOPY_PCT = 30;
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
    return Math.min(800, Math.max(64, nx * ny));
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
    const maxTrees = opts.maxTrees == null ? MAX_TREES : opts.maxTrees;
    const cell = opts.cell == null ? 0.00012 : opts.cell;
    const deduped = dedupeByCell(hits, function (t) {
      return [t.lon, t.lat];
    }, cell);
    return pickStratified(
      deduped,
      maxTrees,
      function (t) {
        return [t.lon, t.lat];
      },
      +bbox.west,
      +bbox.south,
      +bbox.east,
      +bbox.north
    ).map(function (t) {
      return { lon: t.lon, lat: t.lat, pct: t.pct };
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

  function detectTreesFromImageData(data, w, h, bbox, opts) {
    opts = opts || {};
    const maxTrees = opts.maxTrees == null ? MAX_TREES : opts.maxTrees;
    const hits = collectRgbCandidates(data, w, h, opts);
    const cell = opts.cell || 16;
    const deduped = dedupeByCell(hits, function (t) {
      return [t.x, t.y];
    }, cell);
    const picked = pickStratified(deduped, maxTrees, function (t) {
      return [t.x, t.y];
    }, 0, 0, w, h);
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
    MIN_CANOPY_PCT: MIN_CANOPY_PCT,
    MIN_VALID_SAMPLES: MIN_VALID_SAMPLES,
    TCC_IMAGESERVER: TCC_IMAGESERVER,
    KNOWN_SOURCES: KNOWN_SOURCES,
    canopySampleCount: canopySampleCount,
    canopySamplesUrl: canopySamplesUrl,
    parseCanopyPct: parseCanopyPct,
    treesFromCanopySamples: treesFromCanopySamples,
    decideCanopy: decideCanopy,
    normalizeTreesSource: normalizeTreesSource,
    dedupeByCell: dedupeByCell,
    pickStratified: pickStratified,
    pickCanopyTrees: pickCanopyTrees,
    fetchCanopyTrees: fetchCanopyTrees,
    vegColorScore: vegColorScore,
    isVeg: isVeg,
    localLumaStats: localLumaStats,
    canopyScore: canopyScore,
    collectRgbCandidates: collectRgbCandidates,
    detectTreesFromImageData: detectTreesFromImageData,
  };
});
