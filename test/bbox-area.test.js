"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { metersPerDeg: frameMetersPerDeg } = require("../netlify/lib/geo-frame");
const {
  FEET_PER_M,
  metersPerDeg,
  bboxSidesM,
  bboxSidesFt,
  formatFeet,
  formatBboxFeet,
} = require("../public/bbox-area");

describe("bbox width × length in feet", () => {
  it("matches geo-frame meters per degree (latitude, not a flat degree grid)", () => {
    for (const lat of [36.128, 43.07, 44.5, 0]) {
      assert.deepEqual(metersPerDeg(lat), frameMetersPerDeg(lat));
    }
  });

  it("converts each side with the 3.280839895 factor, width × length", () => {
    assert.equal(FEET_PER_M, 3.280839895);
    const lat = 36.128;
    const mpd = metersPerDeg(lat);
    const bbox = {
      west: -115.16,
      east: -115.16 + 100 / mpd.lon,
      south: lat - 25 / mpd.lat,
      north: lat + 25 / mpd.lat,
    };
    const meters = bboxSidesM(bbox);
    assert.ok(Math.abs(meters.widthM - 100) < 1e-6);
    assert.ok(Math.abs(meters.lengthM - 50) < 1e-6);
    const feet = bboxSidesFt(bbox);
    assert.ok(Math.abs(feet.widthFt - 328.0839895) < 1e-6);
    assert.ok(Math.abs(feet.lengthFt - 164.04199475) < 1e-6);
    assert.equal(formatBboxFeet(bbox), "328 × 164 ft");
    assert.equal(formatBboxFeet(bbox).includes("sq ft"), false);
  });

  it("shrinks east-west feet at Wisconsin latitude versus Las Vegas", () => {
    const span = { dLon: 0.01, dLat: 0.008 };
    const vegas = bboxSidesFt({
      west: -115.17,
      east: -115.17 + span.dLon,
      south: 36.12,
      north: 36.12 + span.dLat,
    });
    const wisconsin = bboxSidesFt({
      west: -89.4,
      east: -89.4 + span.dLon,
      south: 43.05,
      north: 43.05 + span.dLat,
    });
    const flatWidth = span.dLon * 111320 * FEET_PER_M;
    assert.ok(wisconsin.widthFt < vegas.widthFt);
    assert.ok(Math.abs(wisconsin.lengthFt - vegas.lengthFt) < 1e-6);
    assert.ok(vegas.widthFt < flatWidth * 0.85, `vegas width ${vegas.widthFt} should account for cos(lat)`);
  });

  it("formats with US commas as width × length ft", () => {
    assert.equal(formatFeet(1280), "1,280");
    assert.equal(formatFeet(0.4), "");
    assert.equal(formatFeet(0), "");
    assert.equal(formatFeet(NaN), "");
    const lat = 36.13;
    const mpd = metersPerDeg(lat);
    const widthM = 1280 / FEET_PER_M;
    const lengthM = 980 / FEET_PER_M;
    const bbox = {
      west: -115.17,
      east: -115.17 + widthM / mpd.lon,
      south: lat - lengthM / 2 / mpd.lat,
      north: lat + lengthM / 2 / mpd.lat,
    };
    assert.equal(formatBboxFeet(bbox), "1,280 × 980 ft");
  });

  it("treats swapped corners as the same box", () => {
    const a = { west: -115.2, south: 36.1, east: -115.15, north: 36.14 };
    const b = { west: -115.15, south: 36.14, east: -115.2, north: 36.1 };
    assert.equal(formatBboxFeet(a), formatBboxFeet(b));
    assert.match(formatBboxFeet(a), /^\d{1,3}(,\d{3})* × \d{1,3}(,\d{3})* ft$/);
    assert.equal(formatBboxFeet(null), "");
  });
});
