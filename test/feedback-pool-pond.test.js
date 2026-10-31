"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { poolWater } = require("../netlify/lib/vehicle-track");
const { osmWaterRings } = require("../netlify/lib/surface-mask");

function plateOf(w, h, fill) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const GRASS = [70, 95, 50];
const DECK = [200, 190, 170];
const COVER = [8, 29, 27];

// Feedback #12: a covered pool, 25 x 12 m at 0.25 m per pixel, with a 2 m deck.
function poolPlate(deck) {
  return plateOf(200, 120, (x, y) => {
    if (x >= 50 && x < 150 && y >= 36 && y < 84) return COVER;
    if (deck && x >= 42 && x < 158 && y >= 28 && y < 92) return DECK;
    return GRASS;
  });
}

test("poolWater finds a dark covered pool with a light deck (feedback #12)", () => {
  const m = poolWater(poolPlate(true), 0, 0, 200, 120, 0.25);
  assert.ok(m, "pool found");
  assert.equal(m[60 * 200 + 100], 1);
  assert.equal(m[10 * 200 + 10], 0);
});

test("poolWater ignores the same dark patch with no deck, and thin shade", () => {
  assert.equal(poolWater(poolPlate(false), 0, 0, 200, 120, 0.25), null);
  const strip = plateOf(200, 120, (x, y) => (y >= 50 && y < 58 && x >= 20 && x < 180 ? COVER : DECK));
  assert.equal(poolWater(strip, 0, 0, 200, 120, 0.25), null);
});

// Feedback #13: a green (algae) pond with its OSM outline drawn 10 m off.
const FRAME = { west: 0, east: 0.0036, south: 0, north: 0.0018, imgW: 400, imgH: 200, mpuX: 1, mpuY: 1 };
const POND = [10, 65, 15];
const FOREST = [60, 55, 40];
function pondImage() {
  return plateOf(400, 200, (x, y) => {
    const nx = (x - 200) / 80;
    const ny = (y - 100) / 50;
    if (nx * nx + ny * ny <= 1) return [POND[0] + ((x * 7 + y * 3) % 5), POND[1] + ((x * 3 + y * 5) % 5), POND[2]];
    return [FOREST[0] + ((x * 13 + y * 7) % 31) - 15, FOREST[1] + ((x * 5 + y * 11) % 31) - 15, FOREST[2] + ((x + y) % 21) - 10];
  });
}
function llRing(cx, cy, rx, ry) {
  const ring = [];
  for (let k = 0; k <= 24; k++) {
    const a = (k / 24) * 2 * Math.PI;
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    ring.push([FRAME.west + (x / FRAME.imgW) * (FRAME.east - FRAME.west), FRAME.north - (y / FRAME.imgH) * (FRAME.north - FRAME.south)]);
  }
  return ring;
}

test("osmWaterRings follows the photo pond past an offset outline (feedback #13)", () => {
  const img = pondImage();
  const rings = osmWaterRings(img, FRAME, [[llRing(212, 88, 80, 50)]]);
  assert.equal(rings.length, 1);
  const r = rings[0];
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const p of r) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
  }
  // The photo pond spans x 120 to 280; the outline 132 to 292.
  assert.ok(x0 < 126 && x0 > 110, "west edge on the photo pond: " + x0);
  assert.ok(x1 < 286 && x1 > 270, "east edge on the photo pond: " + x1);
});

test("osmWaterRings adds nothing where the outline holds no pond water", () => {
  const img = plateOf(400, 200, (x, y) => [FOREST[0] + ((x * 13 + y * 7) % 31) - 15, FOREST[1], FOREST[2]]);
  assert.deepEqual(osmWaterRings(img, FRAME, [[llRing(200, 100, 80, 50)]]), []);
});
