"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, imagePxToLl, pxToLl, llToImagePx } = require("../netlify/lib/geo-frame");

describe("roof hole Y convention", () => {
  it("JPEG ringPx round-trips with imagePxToLl, not Y-up pxToLl", () => {
    const frame = geoFrame(
      { west: -120.64, south: 35.13, east: -120.63, north: 35.14 },
      { imgW: 1000, imgH: 2000, maxSpanM: 5000, minSpanM: 1 }
    );
    // A roof near the top of the JPEG (small y).
    const ringPx = [
      [100, 200],
      [180, 200],
      [180, 260],
      [100, 260],
      [100, 200],
    ];
    const wrong = ringPx.map((p) => pxToLl(p[0], p[1], frame));
    const right = ringPx.map((p) => imagePxToLl(p[0], p[1], frame));
    const backWrong = wrong.map((ll) => llToImagePx(ll[0], ll[1], frame));
    const backRight = right.map((ll) => llToImagePx(ll[0], ll[1], frame));
    // Wrong path mirrors to the bottom half.
    assert.ok(backWrong[0][1] > frame.imgH / 2, "Y-up path mirrors south");
    // Right path lands back on the top.
    assert.ok(Math.abs(backRight[0][1] - 200) < 0.01);
    assert.ok(Math.abs(backRight[2][1] - 260) < 0.01);
  });
});
