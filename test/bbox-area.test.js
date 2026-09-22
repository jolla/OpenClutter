"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { metersPerDeg: frameMetersPerDeg } = require("../netlify/lib/geo-frame");
const {
  SQFT_PER_M2,
  metersPerDeg,
  bboxAreaM2,
  bboxAreaSqFt,
  formatSqFt,
  formatBboxSqFt,
} = require("../public/bbox-area");

describe("bbox square feet", () => {
  it("matches geo-frame meters per degree (latitude, not a flat degree grid)", () => {
    for (const lat of [36.128, 43.07, 44.5, 0]) {
      assert.deepEqual(metersPerDeg(lat), frameMetersPerDeg(lat));
    }
  });

  it("converts meters² with the 10.7639 factor", () => {
    assert.equal(SQFT_PER_M2, 10.7639);
    const lat = 36.128;
    const mpd = metersPerDeg(lat);
    const bbox = {
      west: -115.16,
      east: -115.16 + 100 / mpd.lon,
      south: lat - 50 / mpd.lat,
      north: lat + 50 / mpd.lat,
    };
    assert.ok(Math.abs(bboxAreaM2(bbox) - 10000) < 1e-6);
    assert.ok(Math.abs(bboxAreaSqFt(bbox) - 107639) < 1e-4);
    assert.equal(formatBboxSqFt(bbox), "107,639 sq ft");
  });

  it("shrinks east-west meters at Wisconsin latitude versus Las Vegas", () => {
    const span = { dLon: 0.01, dLat: 0.008 };
    const vegas = bboxAreaSqFt({
      west: -115.17,
      east: -115.17 + span.dLon,
      south: 36.12,
      north: 36.12 + span.dLat,
    });
    const wisconsin = bboxAreaSqFt({
      west: -89.4,
      east: -89.4 + span.dLon,
      south: 43.05,
      north: 43.05 + span.dLat,
    });
    const flat = span.dLon * 111320 * span.dLat * 110540 * SQFT_PER_M2;
    assert.ok(wisconsin < vegas);
    assert.ok(vegas < flat * 0.85, `vegas ${vegas} should account for cos(lat), flat ${flat}`);
  });

  it("formats with US commas and a sq ft label", () => {
    assert.equal(formatSqFt(1240000), "1,240,000 sq ft");
    assert.equal(formatSqFt(10.7639), "11 sq ft");
    assert.equal(formatSqFt(0.4), "");
    assert.equal(formatSqFt(0), "");
    assert.equal(formatSqFt(NaN), "");
  });

  it("treats swapped corners as the same box", () => {
    const a = { west: -115.2, south: 36.1, east: -115.15, north: 36.14 };
    const b = { west: -115.15, south: 36.14, east: -115.2, north: 36.1 };
    assert.equal(formatBboxSqFt(a), formatBboxSqFt(b));
    assert.equal(formatBboxSqFt(null), "");
  });
});
