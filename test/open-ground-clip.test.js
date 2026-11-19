"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { clipOpenGroundRing, openGroundPixel, localStd } = require("../netlify/lib/surface-mask");

function photo(w, h, kind) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const odd = (x + y) % 2 === 1;
      let c;
      const k = kind(x, y);
      if (k === "leafy") c = odd ? [55, 72, 38] : [85, 104, 62];
      else if (k === "lawn") c = [80, 110, 70];
      else if (k === "dirt") c = [150, 135, 115];
      else c = [236, 238, 240];
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function contains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("clipOpenGroundRing", () => {
  it("trims a large meadow off a woods ring and keeps the forest half", () => {
    // 1 m per pixel. A 80 x 160 m lawn on the right is well above 150 m2.
    const w = 220;
    const h = 200;
    const im = photo(w, h, (x) => (x < 110 ? "leafy" : "lawn"));
    const ring = [
      [20, 20],
      [200, 20],
      [200, 180],
      [20, 180],
      [20, 20],
    ];
    const got = clipOpenGroundRing(im, ring, { mpuX: 1, mpuY: 1 });
    assert.ok(got.clearedM2 > 500, "cleared a large meadow, got " + got.clearedM2);
    assert.ok(got.rings.length >= 1);
    const r = got.rings[0];
    assert.equal(contains(r, 60, 100), true, "forest half stays");
    assert.equal(contains(r, 170, 100), false, "meadow half is gone");
  });

  it("keeps a small lawn fleck inside a crown", () => {
    const w = 200;
    const h = 200;
    const im = photo(w, h, (x, y) => (x >= 90 && x < 100 && y >= 90 && y < 100 ? "lawn" : "leafy"));
    const ring = [
      [20, 20],
      [180, 20],
      [180, 180],
      [20, 180],
      [20, 20],
    ];
    const got = clipOpenGroundRing(im, ring, { mpuX: 1, mpuY: 1 });
    assert.equal(got.clearedM2, 0);
    assert.equal(got.rings.length, 1);
    assert.equal(got.rings[0], ring);
  });

  it("returns no rings when the whole crown is a gravel bar", () => {
    const w = 200;
    const h = 200;
    const im = photo(w, h, () => "dirt");
    const ring = [
      [20, 20],
      [180, 20],
      [180, 180],
      [20, 180],
      [20, 20],
    ];
    const got = clipOpenGroundRing(im, ring, { mpuX: 1, mpuY: 1 });
    assert.ok(got.clearedM2 > 500);
    assert.equal(got.rings.length, 0);
  });
});
