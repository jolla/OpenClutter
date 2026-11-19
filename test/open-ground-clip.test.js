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
  it("does not cut a large lawn meadow off a woods ring", () => {
    // Lawn also fires on smooth canopy, so it is not punched here.
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
    assert.equal(got.clearedM2, 0);
    assert.equal(got.rings.length, 1);
    assert.equal(got.rings[0], ring);
  });

  it("trims a large gravel bar off a woods ring and keeps the forest half", () => {
    const w = 220;
    const h = 200;
    const im = photo(w, h, (x) => (x < 110 ? "leafy" : "dirt"));
    const ring = [
      [20, 20],
      [200, 20],
      [200, 180],
      [20, 180],
      [20, 20],
    ];
    const got = clipOpenGroundRing(im, ring, { mpuX: 1, mpuY: 1 });
    assert.ok(got.clearedM2 > 500, "cleared a large gravel bar, got " + got.clearedM2);
    assert.ok(got.rings.length >= 1);
    const r = got.rings[0];
    assert.equal(contains(r, 60, 100), true, "forest half stays");
    assert.equal(contains(r, 170, 100), false, "gravel half is gone");
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

  it("keeps a mid-size lawn bite on a woods edge, but cuts a mid-size gravel bite", () => {
    const w = 200;
    const h = 200;
    // ~400 m2 opening on the east edge: above the 80 m2 gravel floor, below the 1000 m2 lawn floor.
    // Interior holes are not emitted (a crown is one ring), so the patch has to touch the outline.
    const opening = (x, y) => (x >= 150 && y >= 80 && y < 120);
    const ring = [
      [20, 20],
      [180, 20],
      [180, 180],
      [20, 180],
      [20, 20],
    ];
    const lawnPhoto = photo(w, h, (x, y) => (opening(x, y) ? "lawn" : "leafy"));
    const lawn = clipOpenGroundRing(lawnPhoto, ring, { mpuX: 1, mpuY: 1 });
    assert.equal(lawn.clearedM2, 0, "400 m2 of lawn on a crown edge stays");
    assert.equal(lawn.rings.length, 1);
    assert.equal(lawn.rings[0], ring);

    const dirtPhoto = photo(w, h, (x, y) => (opening(x, y) ? "dirt" : "leafy"));
    const dirt = clipOpenGroundRing(dirtPhoto, ring, { mpuX: 1, mpuY: 1 });
    assert.ok(dirt.clearedM2 > 80, "400 m2 of gravel is cut, got " + dirt.clearedM2);
    assert.ok(dirt.rings.length >= 1);
    assert.equal(contains(dirt.rings[0], 165, 100), false, "gravel bite is gone");
    assert.equal(contains(dirt.rings[0], 60, 100), true, "woods stay");
  });

});

const { clipTreePieceOpenGround, isTrunkArea } = require("../netlify/lib/pipeline");

function area(name, ring) {
  return {
    area_material: { name },
    area: {
      coordinates: ring.map((p) => ({ coordinate_xyz: { x: p[0], y: p[1], unit: "pixels" } })),
    },
  };
}

function ringOf(a) {
  return a.area.coordinates.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
}

describe("clipTreePieceOpenGround", () => {
  it("clips every stacked crown and does not copy a sibling onto an extra", () => {
    const meadow = [
      [20, 20],
      [200, 20],
      [200, 180],
      [20, 180],
      [20, 20],
    ];
    const forest = [
      [20, 20],
      [100, 20],
      [100, 180],
      [20, 180],
      [20, 20],
    ];
    // First crown is a large mixed stand (clip splits off the meadow).
    // Second crown is the same stand at another height: it must also be
    // clipped, and must not be copied unclipped onto an extra piece.
    const piece = {
      discrete: true,
      areas: [
        area("Foliage - Heavy 20.0 @ 10.0", meadow),
        area("Foliage - Light 8.0 @ 5.0", meadow),
        area("Foliage - Trunk 2.5 @ 5.0", [
          [55, 90],
          [65, 90],
          [65, 100],
          [55, 100],
          [55, 90],
        ]),
      ],
    };
    const im = photo(220, 200, (x) => (x < 110 ? "leafy" : "dirt"));
    const clip = (ring) => clipOpenGroundRing(im, ring, { mpuX: 1, mpuY: 1 });
    const got = clipTreePieceOpenGround(piece, clip);
    assert.ok(got.clearedM2 > 500);
    const crowns = got.areas.filter((a) => !isTrunkArea(a));
    const trunks = got.areas.filter(isTrunkArea);
    assert.equal(trunks.length, 1);
    assert.ok(crowns.length >= 1);
    for (const c of crowns) {
      const r = ringOf(c);
      assert.equal(contains(r, 60, 100), true, "forest half stays on the piece");
      assert.equal(contains(r, 170, 100), false, "meadow half is gone from the piece");
    }
    // extras may hold the other geographic component, but never the unclipped meadow stand
    for (const extra of got.extras) {
      const extraCrowns = extra.areas.filter((a) => !isTrunkArea(a));
      assert.ok(extraCrowns.length <= 1, "a split does not carry a sibling crown");
      for (const c of extraCrowns) {
        assert.equal(contains(ringOf(c), 170, 100), false, "extra is not the unclipped meadow");
      }
    }
  });

  it("drops a piece when every crown is a gravel bar", () => {
    const ring = [
      [20, 20],
      [180, 20],
      [180, 180],
      [20, 180],
      [20, 20],
    ];
    const piece = { discrete: true, areas: [area("Foliage - Heavy 12.0 @ 8.0", ring)] };
    const im = photo(200, 200, () => "dirt");
    const got = clipTreePieceOpenGround(piece, (r) => clipOpenGroundRing(im, r, { mpuX: 1, mpuY: 1 }));
    assert.ok(got.clearedM2 > 500);
    assert.equal(got.areas.length, 0);
    assert.equal(got.extras.length, 0);
  });
});
