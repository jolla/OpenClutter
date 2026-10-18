"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isPalmTags, palmCentres, heightContourRing } = require("../netlify/lib/vegetation");
const { individualTreeParts, materialForVegetation } = require("../netlify/lib/materials");

// 1 px = 1 m, lon/lat are just px for the sampler.
const frame = { west: 0, east: 200, south: 0, north: 200, imgW: 200, imgH: 200, mpuX: 1, mpuY: 1 };
const { pxToLl } = require("../netlify/lib/geo-frame");

function square(cx, cy, r) {
  return [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]];
}

function sampler(fn) {
  const { llToPx } = require("../netlify/lib/geo-frame");
  return (lon, lat) => {
    const p = llToPx(lon, lat, frame);
    return fn(p[0], p[1]);
  };
}

describe("palms", () => {
  it("reads OSM palm tags", () => {
    assert.equal(isPalmTags({ natural: "tree", leaf_type: "palm" }), true);
    assert.equal(isPalmTags({ natural: "tree", genus: "Washingtonia" }), true);
    assert.equal(isPalmTags({ natural: "tree", species: "Phoenix dactylifera" }), true);
    assert.equal(isPalmTags({ natural: "tree", genus: "Quercus", leaf_type: "broadleaved" }), false);
  });

  it("treats a tall narrow isolated column as one palm", () => {
    const hs = sampler((x, y) => (Math.hypot(x - 100, y - 100) <= 2.2 ? 14 : 0));
    const got = palmCentres(square(100, 100, 2), frame, 14, [], hs);
    assert.ok(got && got.length === 1);
  });

  it("does not call a broad crown a palm", () => {
    const hs = sampler((x, y) => Math.max(0, 12 - Math.hypot(x - 100, y - 100) * 0.6));
    assert.equal(palmCentres(square(100, 100, 8), frame, 12, [], hs), null);
  });

  it("splits a merged row of palm heads at the measured peaks", () => {
    const heads = [80, 90, 100, 110, 120];
    const hs = sampler((x, y) => {
      for (const hx of heads) if (Math.hypot(x - hx, y - 100) <= 2.2) return 13;
      return Math.abs(y - 100) <= 2 ? 4 : 0;
    });
    const ring = [[77, 97], [123, 97], [123, 103], [77, 103], [77, 97]];
    const got = palmCentres(ring, frame, 13, [], hs);
    assert.ok(got && got.length === heads.length, String(got && got.length));
  });

  it("puts a palm crown in the top 3 m on a stem", () => {
    const parts = individualTreeParts(materialForVegetation(14, "light"), 0, 2.8);
    assert.ok(parts);
    assert.equal(parts.crownMat.top_height, 14);
    assert.ok(parts.crownMat.bottom_height >= 11 && parts.crownMat.bottom_height <= 11.8);
    assert.equal(parts.trunkMat.top_height, parts.crownMat.bottom_height);
  });

  it("shapes an upper band from the measured height", () => {
    const hs = sampler((x, y) => (x < 100 ? 14 : 6));
    const ring = square(100, 100, 20);
    const c = heightContourRing(ring, frame, hs, 10);
    assert.ok(c);
    for (const p of c) assert.ok(p[0] <= 101.5);
  });
});
void pxToLl;
