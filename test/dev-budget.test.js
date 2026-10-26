"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const exportMode = require("../netlify/lib/export-mode");
const {
  buildClutter,
  coverageSummary,
  effectiveJsonBudget,
  OPENINTENT_JSON_BUDGET,
  DEV_JSON_BUDGET,
  DEV_TOTAL_BUDGET,
  DEV_JSON_FLOOR,
} = require("../netlify/lib/pipeline");
const { exportSummaryLines } = require("../public/export-client");

const FRAME = { west: -115.1735, south: 36.1205, east: -115.1488, north: 36.1355, name: "Budget" };

function square(west, south, east, north, height) {
  return {
    type: "Feature",
    properties: { height, heightSource: "ms-global" },
    geometry: { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
  };
}

function scene(imgBuf, extra) {
  const frame = geoFrame(FRAME);
  const lon = frame.west + (frame.east - frame.west) * 0.2;
  const lat = frame.south + (frame.north - frame.south) * 0.2;
  return buildClutter(Object.assign({
    frame,
    footprintsGeojson: { features: [square(lon, lat, lon + 0.003, lat + 0.003, 6), square(lon + 0.005, lat, lon + 0.0066, lat + 0.0016, 80)] },
    name: "Budget",
    imgBuf,
  }, extra || {}));
}

afterEach(() => exportMode.setBigBudget(false));

describe("1.2.29 /dev Hamina budget", () => {
  it("is off by default and production keeps the 4.9 MB JSON-only budget", () => {
    assert.equal(exportMode.isBigBudget(), false);
    assert.equal(OPENINTENT_JSON_BUDGET, 4900000);
    assert.equal(effectiveJsonBudget(0, 0), 4900000);
    assert.equal(effectiveJsonBudget(0, 9000000), 4900000);
    assert.equal(effectiveJsonBudget(5000000, 9000000), 5000000);
  });

  it("gives /dev 5.8 MB of JSON and at most 9.7 MB of JSON plus map image", () => {
    exportMode.setBigBudget(true);
    assert.equal(DEV_JSON_BUDGET, 5800000);
    assert.equal(DEV_TOTAL_BUDGET, 9700000);
    assert.equal(effectiveJsonBudget(0, 0), 5800000);
    assert.equal(effectiveJsonBudget(0, 3865174), 5800000);
    assert.equal(effectiveJsonBudget(0, 3900000), 5800000);
    assert.equal(effectiveJsonBudget(0, 4500000), 5200000);
    assert.equal(effectiveJsonBudget(0, 9000000), DEV_JSON_FLOOR);
    assert.equal(effectiveJsonBudget(5000000, 3000000), 5000000);
    for (const img of [0, 1e6, 3865174, 4e6, 5e6, 8e6]) {
      const b = effectiveJsonBudget(0, img);
      assert.ok(b <= DEV_JSON_BUDGET && (b + img <= DEV_TOTAL_BUDGET || b === DEV_JSON_FLOOR), String(img));
    }
  });

  it("production scene stats carry no new fields and the 4.9 MB summary", () => {
    const prod = scene(Buffer.alloc(4000000));
    assert.equal(prod.stats.jsonBudget, 4900000);
    assert.equal("totalBudget" in prod.stats, false);
    assert.equal("imageBytes" in prod.stats, false);
    assert.match(prod.stats.summary, /Byte budget 4\.90 MB\. Sanity cap 8000\./);
  });

  it("/dev scene stats use the image-aware budget", () => {
    exportMode.setBigBudget(true);
    const dev = scene(Buffer.alloc(4500000));
    assert.equal(dev.stats.jsonBudget, 5200000);
    assert.equal(dev.stats.totalBudget, 9700000);
    assert.equal(dev.stats.imageBytes, 4500000);
    assert.match(dev.stats.summary, /Byte budget 5\.20 MB of JSON \(9\.70 MB with the map image\)\./);
    assert.equal(/\u2014/.test(dev.stats.summary), false);
    const small = scene(Buffer.alloc(2000000));
    assert.equal(small.stats.jsonBudget, 5800000);
  });

  it("the trim still drops the tail when /dev is over the budget", () => {
    exportMode.setBigBudget(true);
    const both = scene(Buffer.alloc(1000));
    assert.equal(both.stats.stoppedBy, "areas");
    const one = scene(Buffer.alloc(1000), { jsonBudget: both.stats.openIntentJsonBytes - 1 });
    assert.equal(one.stats.stoppedBy, "bytes");
    assert.equal(one.stats.attenuationAreasEmitted, 1);
  });

  it("summaries name the map image when it shrinks the /dev budget", () => {
    const line = coverageSummary({
      buildings: 1, openIntentJsonBytes: 5190000, jsonBudget: 5200000, stoppedBy: "bytes", totalBudget: 9700000, imageBytes: 4500000,
    });
    assert.match(line, /Stopped at the 5\.20 MB byte budget\. The 4\.50 MB map image counts toward the 9\.70 MB Hamina total\./);
    const full = coverageSummary({
      buildings: 1, openIntentJsonBytes: 5790000, jsonBudget: 5800000, stoppedBy: "bytes", totalBudget: 9700000, imageBytes: 3000000,
    });
    assert.match(full, /Stopped at the 5\.80 MB byte budget\.$/);
    const ui = exportSummaryLines(
      { stats: { buildings: 1, openIntentJsonBytes: 5190000, jsonBudget: 5200000, stoppedBy: "bytes", totalBudget: 9700000, imageBytes: 4500000 } },
      { foliageOn: false, terrainOn: false }
    );
    assert.ok(ui.includes("OpenIntent 5.19 MB of 5.20 MB"));
    assert.ok(ui.includes("The 4.50 MB map image counts toward the 9.70 MB total."));
    const prodUi = exportSummaryLines(
      { stats: { buildings: 1, openIntentJsonBytes: 4890000, jsonBudget: 4900000, stoppedBy: "bytes" } },
      { foliageOn: false, terrainOn: false }
    );
    assert.equal(prodUi.some((l) => /map image counts/.test(l)), false);
  });

  it("the export function turns the budget on for /dev hosts only", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /exportMode\.setBigBudget\(testHost\);/);
  });
});
