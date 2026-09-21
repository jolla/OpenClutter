"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_TREES,
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
  vegColorScore,
  isVeg,
  localLumaStats,
  canopyScore,
  collectRgbCandidates,
  detectTreesFromImageData,
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
    assert.ok(canopySampleCount(LONG_MEADOW) <= 800);
  });

  it("parses percent canopy and drops nodata 254/255", () => {
    assert.equal(parseCanopyPct("78"), 78);
    assert.equal(parseCanopyPct("0"), 0);
    assert.equal(parseCanopyPct("254"), null);
    assert.equal(parseCanopyPct("255"), null);
    assert.equal(parseCanopyPct("101"), null);
    assert.equal(MIN_CANOPY_PCT, 30);
    assert.equal(MIN_VALID_SAMPLES, 20);
  });

  it("thresholds ≥30% and does not treat a valid sparse site as missing raster", () => {
    const payload = sampleGrid(25, (row) => (row === 0 ? 80 : 5));
    const parsed = treesFromCanopySamples(payload);
    assert.equal(parsed.validCount, 25);
    assert.ok(parsed.hits.length >= 1);
    assert.ok(parsed.hits.every((h) => h.pct >= 30));
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
});

describe("pickStratified does not north-fill", () => {
  it("round-robins spatial bins up to MAX_TREES", () => {
    const items = [];
    for (let i = 0; i < 300; i++) items.push({ x: 2 + (i % 50), y: 3 + Math.floor(i / 50), score: 1 });
    for (let i = 0; i < 40; i++) items.push({ x: 5 + (i % 20), y: 70 + Math.floor(i / 20), score: 0.6 });
    const picked = pickStratified(items, 80, (c) => [c.x, c.y], 0, 0, 100, 100, 8, 8);
    assert.equal(picked.length, 80);
    assert.ok(picked.some((p) => p.y > 50));
    assert.equal(MAX_TREES, 250);
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
