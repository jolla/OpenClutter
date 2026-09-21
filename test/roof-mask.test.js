"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { imageryRoofFeatures, pointInRing } = require("../netlify/lib/roof-mask");

function paint(w, h, draw) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const px = draw(x, y);
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe("imagery roof mask", () => {
  const frame = geoFrame(
    { west: -87.92, south: 42.898, east: -87.915, north: 42.902 },
    { imgW: 200, imgH: 200, maxSpanM: 5000 }
  );

  function raw() {
    return paint(200, 200, (x, y) => {
      if (x >= 40 && x <= 130 && y >= 50 && y <= 120) return [232, 232, 230];
      return [(x * 3) % 40, 70 + (y % 17), 30];
    });
  }

  it("fills a large smooth white roof that no vector covers", () => {
    const found = imageryRoofFeatures(raw(), frame, []);
    assert.equal(found.features.length, 1);
    const ring = found.features[0].geometry.coordinates[0];
    const cx = frame.west + (85 / 200) * (frame.east - frame.west);
    const cy = frame.north - (85 / 200) * (frame.north - frame.south);
    assert.equal(pointInRing([cx, cy], ring), true);
    assert.equal(found.features[0].properties.source, "imagery-roof");
  });

  it("does not emit a second polygon when a footprint already covers the roof", () => {
    const west = frame.west + (40 / 200) * (frame.east - frame.west);
    const east = frame.west + (130 / 200) * (frame.east - frame.west);
    const north = frame.north - (50 / 200) * (frame.north - frame.south);
    const south = frame.north - (120 / 200) * (frame.north - frame.south);
    const feature = {
      type: "Feature",
      properties: { height: 8.2 },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ]],
      },
    };
    const found = imageryRoofFeatures(raw(), frame, [feature]);
    assert.equal(found.features.length, 0);
  });
});
