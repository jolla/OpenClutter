"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_TREES,
  MAX_TREES_LARGE,
  MIN_CANOPY_PCT,
  MIN_VALID_SAMPLES,
  TCC_IMAGESERVER,
  canopySamplesUrl,
  canopySampleCount,
  parseCanopyPct,
  treesFromCanopySamples,
  decideCanopy,
  normalizeTreesSource,
  pickStratified,
  pickCanopyTrees,
  maxTreesForBbox,
  mergeTreePoints,
  vegColorScore,
  isVeg,
  localLumaStats,
  canopyScore,
  collectRgbCandidates,
  detectTreesFromImageData,
  rgbFillNeeded,
  resolveTrees,
  RGB_POLICY_PREFER_NLCD,
  RGB_POLICY_LEGACY,
  RGB_POLICY_FORCE_RGB,
} = require("../netlify/lib/tree-source");

const LONG_MEADOW = {
  west: -87.8885,
  south: 42.8935,
  east: -87.8815,
  north: 42.9002,
  name: "8121 S Long Meadow Dr",
};

function makeRgba(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

function sampleGrid(n, valueFn) {
  const samples = [];
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    samples.push({
      location: {
        x: LONG_MEADOW.west + ((col + 0.5) / cols) * (LONG_MEADOW.east - LONG_MEADOW.west),
        y: LONG_MEADOW.south + ((row + 0.5) / Math.ceil(n / cols)) * (LONG_MEADOW.north - LONG_MEADOW.south),
      },
      value: String(valueFn(row, col, i)),
    });
  }
  return { samples };
}

describe("NLCD / USFS canopy source", () => {
  it("builds an unauthenticated CONUS getSamples URL for the shared bbox", () => {
    const url = canopySamplesUrl(LONG_MEADOW);
    assert.match(url, /^https:\/\/imagery\.geoplatform\.gov\/iipp\/rest\/services\/Vegetation\/USFS_EDW_NLCD_TCC_CONUS\/ImageServer\/getSamples\?/);
    assert.ok(url.includes("geometryType=esriGeometryEnvelope"));
    assert.ok(url.includes("beginyear"));
    assert.ok(url.includes("sortAscending"));
    assert.ok(url.includes("f=json"));
    assert.equal(TCC_IMAGESERVER.endsWith("USFS_EDW_NLCD_TCC_CONUS/ImageServer"), true);
    assert.ok(canopySampleCount(LONG_MEADOW) >= 64);
    assert.ok(canopySampleCount(LONG_MEADOW) <= 1600);
    const wynnCount = canopySampleCount({
      west: -115.1735,
      south: 36.1205,
      east: -115.1488,
      north: 36.1355,
    });
    assert.ok(wynnCount > 800, `large golf bbox should sample more than 800 TCC cells, got ${wynnCount}`);
  });

  it("parses percent canopy and drops nodata 254/255", () => {
    assert.equal(parseCanopyPct("78"), 78);
    assert.equal(parseCanopyPct("0"), 0);
    assert.equal(parseCanopyPct("254"), null);
    assert.equal(parseCanopyPct("255"), null);
    assert.equal(parseCanopyPct("101"), null);
    assert.equal(MIN_CANOPY_PCT, 18);
    assert.equal(MIN_VALID_SAMPLES, 20);
  });

  it("thresholds ≥30% and does not treat a valid sparse site as missing raster", () => {
    const payload = sampleGrid(25, (row) => (row === 0 ? 80 : 5));
    const parsed = treesFromCanopySamples(payload);
    assert.equal(parsed.validCount, 25);
    assert.ok(parsed.hits.length >= 1);
    assert.ok(parsed.hits.every((h) => h.pct >= 18));
    const decided = decideCanopy(parsed);
    assert.equal(decided.ok, true);
    assert.equal(decided.reason, "nlcd-canopy");
  });

  it("falls back when the bbox is empty / nodata (outside CONUS)", () => {
    const payload = {
      samples: Array.from({ length: 12 }, (_, i) => ({
        location: { x: 0, y: 0 },
        value: i % 2 ? "255" : "254",
      })),
    };
    const parsed = treesFromCanopySamples(payload);
    assert.equal(parsed.validCount, 0);
    assert.equal(decideCanopy(parsed).ok, false);
    assert.equal(decideCanopy({ samples: 0, validCount: 0, hits: [] }).ok, false);
  });

  it("picks southern woods instead of filling a north-first cap", () => {
    const hits = [];
    for (let i = 0; i < 200; i++) {
      hits.push({
        lon: LONG_MEADOW.west + 0.001 + (i % 10) * 0.0002,
        lat: LONG_MEADOW.north - 0.0003,
        score: 0.9,
        pct: 90,
      });
    }
    for (let i = 0; i < 40; i++) {
      hits.push({
        lon: LONG_MEADOW.west + 0.002 + (i % 8) * 0.0003,
        lat: LONG_MEADOW.south + 0.0004,
        score: 0.7,
        pct: 70,
      });
    }
    const picked = pickCanopyTrees(hits, LONG_MEADOW, { maxTrees: 64, cell: 0.00005 });
    assert.ok(picked.length <= 64);
    const mid = (LONG_MEADOW.north + LONG_MEADOW.south) / 2;
    const south = picked.filter((p) => p.lat < mid);
    assert.ok(south.length >= 4, `expected southern woods in the sample, got ${south.length} of ${picked.length}`);
  });

  it("does not plant an orchard grid on NLCD sample centers", () => {
    const payload = sampleGrid(196, (row) => (row < 8 ? 82 : 6));
    const parsed = treesFromCanopySamples(payload);
    const trees = pickCanopyTrees(parsed.hits, LONG_MEADOW, { maxTrees: 80 });
    assert.ok(trees.length >= 8, `expected woods trees, got ${trees.length}`);
    assert.ok(trees.length < parsed.hits.length, "must subsample the 30 m lattice");
    let onCenter = 0;
    for (const t of trees) {
      const hit = parsed.hits.some(
        (h) => Math.abs(h.lon - t.lon) < 1e-10 && Math.abs(h.lat - t.lat) < 1e-10
      );
      if (hit) onCenter++;
    }
    assert.ok(
      onCenter <= trees.length * 0.25,
      `trees still on sample centers: ${onCenter}/${trees.length}`
    );
    const mpdLat = 110540;
    const mpdLon = 111320 * Math.cos(((LONG_MEADOW.south + LONG_MEADOW.north) / 2) * Math.PI / 180);
    let minD = Infinity;
    for (let i = 0; i < trees.length; i++) {
      for (let j = i + 1; j < trees.length; j++) {
        const dx = (trees[i].lon - trees[j].lon) * mpdLon;
        const dy = (trees[i].lat - trees[j].lat) * mpdLat;
        const d = Math.hypot(dx, dy);
        if (d < minD) minD = d;
      }
    }
    assert.ok(minD >= 5, `NMS spacing too tight: ${minD} m`);
    const mid = (LONG_MEADOW.north + LONG_MEADOW.south) / 2;
    const south = trees.filter((t) => t.lat < mid);
    const north = trees.filter((t) => t.lat >= mid);
    assert.ok(south.length > north.length, `woods should dominate lawns: south ${south.length} north ${north.length}`);
  });

  it("does not spend canopy points on a building footprint", () => {
    const hits = [];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        hits.push({
          lon: LONG_MEADOW.west + 0.001 + col * 0.00035,
          lat: LONG_MEADOW.south + 0.001 + row * 0.00035,
          pct: 72,
          score: 0.72,
        });
      }
    }
    const reject = (lon, lat) => lon < LONG_MEADOW.west + 0.0022;
    const trees = pickCanopyTrees(hits, LONG_MEADOW, { maxTrees: 40, reject });
    assert.ok(trees.length >= 4, `expected off-roof trees, got ${trees.length}`);
    assert.ok(trees.every((t) => t.lon >= LONG_MEADOW.west + 0.0022));
  });

  it("fills continuous high canopy instead of only isolated yard peaks", () => {
    const hits = [];
    // Isolated landscaping trees (peaks) along the west edge.
    for (let i = 0; i < 12; i++) {
      hits.push({
        lon: LONG_MEADOW.west + 0.0004,
        lat: LONG_MEADOW.south + 0.0004 + i * 0.0004,
        pct: 88,
        score: 0.88,
      });
    }
    // Continuous woods occupying the east half.
    for (let row = 0; row < 14; row++) {
      for (let col = 0; col < 12; col++) {
        hits.push({
          lon: LONG_MEADOW.west + 0.0035 + col * 0.00022,
          lat: LONG_MEADOW.south + 0.0005 + row * 0.00035,
          pct: 70 + ((row + col) % 8),
          score: 0.75,
        });
      }
    }
    const trees = pickCanopyTrees(hits, LONG_MEADOW, { maxTrees: 120 });
    assert.ok(trees.length >= 40, `expected woods to fill, got ${trees.length}`);
    const midLon = (LONG_MEADOW.west + LONG_MEADOW.east) / 2;
    const east = trees.filter((t) => t.lon > midLon);
    assert.ok(
      east.length >= trees.length * 0.5,
      `woods bins should fill, east ${east.length} / ${trees.length}`
    );
  });

  it("merges RGB supplements without snapping onto a lattice", () => {
    const nlcd = [{ lon: LONG_MEADOW.west + 0.002, lat: LONG_MEADOW.south + 0.002, pct: 70 }];
    const rgb = [];
    for (let i = 0; i < 20; i++) {
      rgb.push({
        lon: LONG_MEADOW.west + 0.004 + i * 0.00008,
        lat: LONG_MEADOW.south + 0.004,
        score: 0.6,
      });
    }
    const merged = mergeTreePoints(nlcd, rgb, LONG_MEADOW, { maxTrees: 12 });
    assert.ok(merged.length >= 2 && merged.length <= 12);
    assert.ok(merged.some((t) => Math.abs(t.lon - nlcd[0].lon) < 1e-6));
  });
});

describe("pickStratified does not north-fill", () => {
  it("round-robins spatial bins up to MAX_TREES", () => {
    const items = [];
    for (let i = 0; i < 300; i++) items.push({ x: 2 + (i % 50), y: 3 + Math.floor(i / 50), score: 1 });
    for (let i = 0; i < 40; i++) items.push({ x: 5 + (i % 20), y: 70 + Math.floor(i / 20), score: 0.6 });
    const picked = pickStratified(items, 80, (c) => [c.x, c.y], 0, 0, 100, 100, 8, 8);
    assert.equal(picked.length, 80);
    assert.ok(picked.some((p) => p.y > 50));
    assert.equal(MAX_TREES, 180);
    assert.equal(MAX_TREES_LARGE, 800);
  });

  it("scales MAX_TREES with bbox area for golf/campus maps", () => {
    const small = maxTreesForBbox(LONG_MEADOW);
    const large = maxTreesForBbox({
      west: -115.1735,
      south: 36.1205,
      east: -115.1488,
      north: 36.1355,
    });
    assert.ok(small >= 180 && small <= 400, `small site cap ${small}`);
    assert.ok(large >= 600 && large <= 800, `Wynn-scale cap ${large}`);
  });
});

describe("imagery RGB fallback classifier", () => {
  it("keeps green canopy color but rejects water, pavement, and bright roofs", () => {
    assert.ok(isVeg(70, 95, 50));
    assert.ok(vegColorScore(75, 68, 48) > 0, "winter brown woody");
    assert.equal(isVeg(80, 100, 140), false, "water");
    assert.equal(isVeg(200, 198, 190), false, "pavement");
    assert.equal(isVeg(210, 200, 185), false, "roof");
  });

  it("rejects smooth lawn (low texture) even when the color is olive", () => {
    const data = makeRgba(48, 48, () => [100, 125, 70]);
    const stats = localLumaStats(data, 48, 48, 24, 24, 5, 2);
    assert.ok(stats.std < 7.5, `lawn std ${stats.std}`);
    assert.equal(canopyScore(vegColorScore(100, 125, 70), stats), 0);
    const hits = collectRgbCandidates(data, 48, 48, { step: 8 });
    assert.equal(hits.length, 0);
  });

  it("selects textured winter / brown canopy", () => {
    const data = makeRgba(64, 64, (x, y) => {
      const n = ((x * 13 + y * 7) % 17) - 8;
      return [70 + n * 4, 62 + n * 3, 46 + n * 2];
    });
    const stats = localLumaStats(data, 64, 64, 32, 32, 5, 2);
    assert.ok(stats.std > 8, `woods std ${stats.std}`);
    const hits = collectRgbCandidates(data, 64, 64, { step: 8, minScore: 0.2 });
    assert.ok(hits.length > 0, "textured winter canopy should produce candidates");
  });

  it("does not fill the cap from the northern lawn before southern woods", () => {
    const w = 80;
    const h = 80;
    const data = makeRgba(w, h, (x, y) => {
      if (y < h / 2) return [100, 125, 70];
      const n = ((x * 13 + y * 7) % 17) - 8;
      return [70 + n * 4, 62 + n * 3, 46 + n * 2];
    });
    const picked = detectTreesFromImageData(data, w, h, null, { step: 8, maxTrees: 30, minScore: 0.2 });
    assert.ok(picked.length > 0);
    const south = picked.filter((p) => p.y >= h / 2);
    assert.ok(south.length >= picked.length * 0.6, `south ${south.length} / ${picked.length}`);
  });

  it("does not carpet gray parking / pavement", () => {
    const data = makeRgba(80, 80, (x, y) => {
      const stripe = x % 18 === 0 ? 14 : 0;
      return [148 + stripe, 146 + stripe, 141 + stripe];
    });
    const hits = collectRgbCandidates(data, 80, 80, { step: 8 });
    assert.equal(hits.length, 0);
    const picked = detectTreesFromImageData(data, 80, 80, null, { step: 8, maxTrees: 40 });
    assert.equal(picked.length, 0);
  });
});

describe("treesSource labels", () => {
  it("normalizes unknown / missing values", () => {
    assert.equal(normalizeTreesSource("nlcd-canopy", 0), "nlcd-canopy");
    assert.equal(normalizeTreesSource("imagery-rgb", 10), "imagery-rgb");
    assert.equal(normalizeTreesSource("none", 0), "none");
    assert.equal(normalizeTreesSource(undefined, 4), "imagery-rgb");
    assert.equal(normalizeTreesSource("wat", 0), "none");
  });
});

describe("RGB fill policy", () => {
  const bbox = LONG_MEADOW;
  const rgb = [
    { lon: bbox.west + 0.001, lat: bbox.south + 0.001, score: 0.7 },
    { lon: bbox.west + 0.002, lat: bbox.south + 0.002, score: 0.6 },
  ];

  it("prefers valid NLCD even when it placed 0 trees (no parking carpet)", () => {
    const canopy = {
      trees: [],
      source: "nlcd-canopy",
      reason: "nlcd-canopy",
      parsed: { samples: 64, validCount: 64, hits: [] },
    };
    assert.equal(rgbFillNeeded(canopy, bbox, { rgbPolicy: RGB_POLICY_PREFER_NLCD }), false);
    const resolved = resolveTrees(bbox, canopy, rgb, { rgbPolicy: RGB_POLICY_PREFER_NLCD });
    assert.equal(resolved.source, "nlcd-canopy");
    assert.equal(resolved.trees.length, 0);
  });

  it("RGB-fills only true gaps (nodata / outside CONUS)", () => {
    const canopy = {
      trees: [],
      source: null,
      reason: "nodata-or-outside-conus",
      parsed: { samples: 12, validCount: 0, hits: [] },
    };
    assert.equal(rgbFillNeeded(canopy, bbox, { rgbPolicy: RGB_POLICY_PREFER_NLCD }), true);
    const resolved = resolveTrees(bbox, canopy, rgb, { rgbPolicy: RGB_POLICY_PREFER_NLCD });
    assert.equal(resolved.source, "imagery-rgb");
    assert.equal(resolved.trees.length, 2);
  });

  it("PR #8 legacy policy RGB-fills when NLCD placed nothing", () => {
    const canopy = {
      trees: [],
      source: "nlcd-canopy",
      reason: "nlcd-canopy",
      parsed: { samples: 64, validCount: 64, hits: [] },
    };
    assert.equal(rgbFillNeeded(canopy, bbox, { rgbPolicy: RGB_POLICY_LEGACY }), true);
    const resolved = resolveTrees(bbox, canopy, rgb, { rgbPolicy: RGB_POLICY_LEGACY });
    assert.equal(resolved.source, "imagery-rgb");
    assert.ok(resolved.trees.length >= 1);
  });

  it("force-rgb always uses imagery points (eval contrast)", () => {
    const canopy = {
      trees: [{ lon: bbox.west + 0.003, lat: bbox.south + 0.003, pct: 70 }],
      source: "nlcd-canopy",
      parsed: { samples: 64, validCount: 64, hits: [{ pct: 70 }] },
    };
    assert.equal(rgbFillNeeded(canopy, bbox, { rgbPolicy: RGB_POLICY_FORCE_RGB }), true);
    const resolved = resolveTrees(bbox, canopy, rgb, { rgbPolicy: RGB_POLICY_FORCE_RGB });
    assert.equal(resolved.source, "imagery-rgb");
  });
});
