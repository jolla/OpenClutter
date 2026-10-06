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
  bboxReadout,
  ringAreaM2,
  polygonReadout,
} = require("../public/bbox-area");

const WYNN = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
};

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
    const line = bboxReadout(bbox);
    assert.equal(line.text, "5,000 m² · 53,820 ft²");
    assert.match(line.html, /^5,000 m² · <span class="area-quiet">53,820 ft²<\/span>$/);
    assert.equal(/\d m ·/.test(line.text), false);
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

  it("formats with US commas and keeps a short site in meters", () => {
    assert.equal(formatFeet(1280), "1,280");
    assert.equal(formatFeet(0.4), "");
    assert.equal(formatFeet(0), "");
    assert.equal(formatFeet(NaN), "");
    const lat = 36.13;
    const mpd = metersPerDeg(lat);
    const spanM = 40;
    const bbox = {
      west: -115.17,
      east: -115.17 + spanM / mpd.lon,
      south: lat - spanM / 2 / mpd.lat,
      north: lat + spanM / 2 / mpd.lat,
    };
    const line = bboxReadout(bbox);
    assert.equal(line.text, "1,600 m² · 17,222 ft²");
    assert.equal(line.text.includes("km"), false);
    assert.equal(/\d m ·/.test(line.text), false);
  });

  it("treats swapped corners as the same box", () => {
    const a = { west: -115.2, south: 36.1, east: -115.15, north: 36.14 };
    const b = { west: -115.15, south: 36.14, east: -115.2, north: 36.1 };
    assert.equal(bboxReadout(a).text, bboxReadout(b).text);
    assert.equal(bboxReadout(null), null);
  });
});

describe("area readout stays in square meters and square feet", () => {
  it("reads a Wynn-sized site as square meters and square feet", () => {
    const sides = bboxSidesM(WYNN);
    const span = Math.max(sides.widthM, sides.lengthM);
    assert.ok(span > 2000 && span < 2500, span);
    const line = bboxReadout(WYNN);
    assert.equal(line.text, "3,682,408 m² · 39,637,114 ft²");
    assert.match(line.text, /ft²$/);
    assert.equal(/\bkm\b|\bmi\b|\bha\b|acres/.test(line.text), false);
    assert.equal(/\d m ·/.test(line.text), false);
    assert.match(line.html, /<span class="area-quiet">[^<]+ ft²<\/span>/);
  });

  it("keeps a few-hundred-meter site in square meters and square feet", () => {
    const lat = 36.13;
    const mpd = metersPerDeg(lat);
    const bbox = {
      west: -115.17,
      east: -115.17 + 400 / mpd.lon,
      south: lat - 150 / mpd.lat,
      north: lat + 150 / mpd.lat,
    };
    assert.equal(bboxReadout(bbox).text, "120,000 m² · 1,291,669 ft²");
  });

  it("does not lead a campus with the side length", () => {
    const line = bboxReadout(WYNN).text;
    assert.equal(/^\d+(\.\d+)? km/.test(line), false);
    assert.equal(line.includes("2.2 km"), false);
  });
});

describe("polygon area readout", () => {
  const lat = 36.128;
  const mpd = metersPerDeg(lat);
  const south = lat - 25 / mpd.lat;
  const north = lat + 25 / mpd.lat;
  const west = -115.16;
  const east = west + 100 / mpd.lon;
  const rect = [
    { lat: south, lng: west },
    { lat: south, lng: east },
    { lat: north, lng: east },
    { lat: north, lng: west },
  ];

  it("matches the box readout for the same corners", () => {
    const m2 = ringAreaM2(rect);
    const sides = bboxSidesM({ west: west, south: south, east: east, north: north });
    assert.ok(Math.abs(m2 - sides.widthM * sides.lengthM) < 1e-4);
    const box = bboxReadout({ west: west, south: south, east: east, north: north });
    const ring = polygonReadout(rect);
    assert.equal(ring.text, box.text);
    assert.equal(ring.text, "5,000 m² · 53,820 ft²");
    assert.equal(ring.text.startsWith("5,000 m²"), true);
  });

  it("keeps a triangle smaller than the box and ignores winding and a closing vertex", () => {
    const tri = [rect[0], rect[1], rect[2]];
    const triM2 = ringAreaM2(tri);
    const rectM2 = ringAreaM2(rect);
    assert.ok(triM2 > 0);
    assert.ok(triM2 < rectM2);
    const reversed = rect.slice().reverse();
    assert.ok(Math.abs(ringAreaM2(reversed) - rectM2) < 1e-6);
    const closed = rect.concat([{ lat: rect[0].lat, lng: rect[0].lng }]);
    assert.ok(Math.abs(ringAreaM2(closed) - rectM2) < 1e-6);
    assert.equal(polygonReadout([rect[0], rect[1]]), null);
    assert.equal(polygonReadout(null), null);
    const triLine = polygonReadout([rect[0], rect[1], rect[2]]);
    assert.ok(triLine.text.includes("m²"));
    assert.ok(triLine.text.includes("ft²"));
    assert.equal(triLine.text.startsWith("2,500 m²"), true);
    assert.equal(/\d m ·/.test(triLine.text), false);
  });
});
