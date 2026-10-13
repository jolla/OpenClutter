"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { materialForVegetation } = require("../netlify/lib/materials");
const { pointInRing } = require("../netlify/lib/poly-clip");
const { indexPointCloud, cloudHitsRing, ringAreaPx, treesToOi, oiPixelCoords } = require("../netlify/lib/pipeline");

function brute(points, ring) {
  const { pointInRing } = require("../netlify/lib/poly-clip");
  for (let i = 0; i < points.length; i++) {
    if (pointInRing(points[i], ring)) return true;
  }
  return false;
}

describe("keep-out index", () => {
  it("hits the same samples as a full scan, including cell edges", () => {
    const points = [];
    for (let y = 0; y < 200; y += 4) {
      for (let x = 0; x < 240; x += 4) points.push([x + 0.5, y + 0.5]);
    }
    const index = indexPointCloud(points, 32);
    assert.equal(index.points, points);
    const rings = [
      [
        [10, 10],
        [30, 10],
        [30, 28],
        [10, 28],
        [10, 10],
      ],
      [
        [31, 31],
        [70, 31],
        [70, 90],
        [31, 90],
        [31, 31],
      ],
      [
        [180, 150],
        [220, 160],
        [200, 190],
        [180, 150],
      ],
      [
        [400, 400],
        [440, 400],
        [440, 440],
        [400, 440],
        [400, 400],
      ],
    ];
    for (let i = 0; i < rings.length; i++) {
      assert.equal(cloudHitsRing(index, rings[i]), brute(points, rings[i]), "ring " + i);
      assert.ok(ringAreaPx(rings[i]) > 0);
    }
  });

  it("keeps a crown off a roof when many other roofs are far away", () => {
    const frame = geoFrame({ west: -115.17, south: 36.12, east: -115.16, north: 36.13, name: "Keep" });
    const crown = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      crown.push([400 + Math.cos(a) * 90, 400 + Math.sin(a) * 70]);
    }
    crown.push(crown[0]);
    const roof = [
      [390, 390],
      [410, 390],
      [410, 410],
      [390, 410],
      [390, 390],
    ];
    const far = [];
    for (let i = 0; i < 40; i++) {
      const x = 20 + (i % 8) * 18;
      const y = 20 + Math.floor(i / 8) * 18;
      far.push([
        [x, y],
        [x + 8, y],
        [x + 8, y + 8],
        [x, y + 8],
        [x, y],
      ]);
    }
    const keepOutPx = [];
    for (let y = 392; y < 408; y += 4) {
      for (let x = 392; x < 408; x += 4) keepOutPx.push([x + 0.5, y + 0.5]);
    }
    for (let i = 0; i < 80; i++) keepOutPx.push([20 + (i % 10) * 4, 20 + Math.floor(i / 10) * 4]);
    const packed = treesToOi(
      [
        {
          ringPx: crown,
          material: materialForVegetation(14, "heavy"),
          kind: "canopy",
          keepOutPx,
          keepOutRings: [roof].concat(far),
        },
      ],
      frame.imgW,
      frame.imgH,
      frame.mpuX
    );
    assert.ok(packed.areas.length >= 1, "the crown around the roof is kept");
    for (let i = 0; i < packed.areas.length; i++) {
      const px = oiPixelCoords(packed.areas[i].area.coordinates).map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
      assert.equal(pointInRing([400, 400], px), false, "roof center stays outside piece " + i);
    }
  });
});
