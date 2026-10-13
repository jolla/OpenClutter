"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { imageryRoofFeatures, darkRectRoofs, darkPanelsWhenRoofFillSkipped, pointInRing } = require("../netlify/lib/roof-mask");

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

  it("fills a mid-size bright roof and a smooth gray membrane, not a parking lot", () => {
    const mid = paint(200, 200, (x, y) => {
      if (x >= 20 && x <= 42 && y >= 30 && y <= 52) return [236, 236, 234];
      if (x >= 90 && x <= 140 && y >= 90 && y <= 130) return [154, 152, 148];
      if (x >= 150 && x <= 190 && y >= 20 && y <= 70) {
        const n = ((x * 17 + y * 13) % 40);
        return [100 + n, 100 + (n % 17), 98 + (n % 11)];
      }
      return [(x * 3) % 40, 70 + (y % 17), 30];
    });
    const bright = imageryRoofFeatures(mid, frame, []);
    assert.equal(bright.features.length, 1, "bright mid-size roof");
    const membrane = imageryRoofFeatures(mid, frame, bright.features, "membrane");
    assert.equal(membrane.features.length, 1, "smooth gray membrane");
    assert.equal(
      membrane.features.concat(bright.features).some((f) => {
        const ring = f.geometry.coordinates[0];
        const lon = frame.west + (170 / 200) * (frame.east - frame.west);
        const lat = frame.north - (45 / 200) * (frame.north - frame.south);
        return pointInRing([lon, lat], ring);
      }),
      false,
      "textured parking is not a footprint"
    );
    const dark = paint(200, 200, (x, y) => (x >= 40 && x <= 110 && y >= 40 && y <= 110 ? [48, 50, 46] : [20, 80, 30]));
    assert.equal(imageryRoofFeatures(dark, frame, []).features.length, 0);
    assert.equal(imageryRoofFeatures(dark, frame, [], "membrane").features.length, 0);
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

describe("dark panel rectangles", () => {
  const frame = geoFrame(
    { west: -87.92, south: 42.898, east: -87.915, north: 42.902 },
    { imgW: 200, imgH: 200, maxSpanM: 5000 }
  );

  function ll(x, y) {
    return [
      frame.west + (x / 200) * (frame.east - frame.west),
      frame.north - (y / 200) * (frame.north - frame.south),
    ];
  }

  function neighborTouching(x0, y0, x1, y1) {
    const a = ll(x1, y1);
    const b = ll(x1 + 18, y1);
    const c = ll(x1 + 18, y0);
    const d = ll(x1, y0);
    return {
      type: "Feature",
      properties: { height: 12 },
      geometry: { type: "Polygon", coordinates: [[a, b, c, d, a]] },
    };
  }

  function panelImage() {
    return paint(200, 200, (x, y) => {
      if (x >= 40 && x <= 110 && y >= 50 && y <= 115) return [24, 28, 26];
      return [36, 98, 42];
    });
  }

  it("does not invent a building from a dark rectangle", () => {
    const found = darkRectRoofs(panelImage(), frame, [neighborTouching(40, 50, 110, 115)]);
    assert.equal(found.features.length, 0);
    const skipped = darkPanelsWhenRoofFillSkipped(null, panelImage(), frame, [neighborTouching(40, 50, 110, 115)]);
    assert.equal(skipped.features.length, 0);
  });

  it("does not emit a second rectangle when a footprint already covers the panels", () => {
    const a = ll(40, 115);
    const b = ll(110, 115);
    const c = ll(110, 50);
    const d = ll(40, 50);
    const covered = {
      type: "Feature",
      properties: { height: 16 },
      geometry: { type: "Polygon", coordinates: [[a, b, c, d, a]] },
    };
    const found = darkRectRoofs(panelImage(), frame, [covered]);
    assert.equal(found.features.length, 0);
  });

  it("rejects a dark road and a panel with no building beside it", () => {
    const road = paint(200, 200, (x, y) => (x >= 20 && x <= 32 ? [30, 32, 28] : [36, 98, 42]));
    const beside = neighborTouching(20, 0, 32, 200);
    assert.equal(darkRectRoofs(road, frame, [beside]).features.length, 0);
    assert.equal(darkRectRoofs(panelImage(), frame, []).features.length, 0);
  });
});
