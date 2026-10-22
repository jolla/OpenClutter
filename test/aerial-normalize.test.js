"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { normalizeAerial, TARGET_LO, TARGET_HI } = require("../netlify/lib/aerial-normalize");
const { surfaceMasksFromImage } = require("../netlify/lib/surface-mask");

function image(w, h, fill) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// A hazy summer plate: lifted blue in the shadows, flat contrast. Dark
// shaded crowns (left) next to a sunlit lot (right), with a speckle of
// highlights so the scene has a full range.
function hazyPlate() {
  return image(240, 240, (x, y) => {
    const n = ((x * 7919 + y * 104729) % 23) - 11;
    if ((x * 31 + y * 17) % 97 === 0) return [230, 230, 228];
    if (x < 120) return [58 + n, 72 + n, 88 + n];
    return [150 + n, 148 + n, 140 + n];
  });
}

test("levelling maps each channel's 1st and 99th percentile onto the Esri range", () => {
  const out = normalizeAerial(hazyPlate());
  assert.ok(out.levelled);
  for (let c = 0; c < 3; c++) {
    let lo = 255;
    let hi = 0;
    for (let i = c; i < out.data.length; i += 4) {
      lo = Math.min(lo, out.data[i]);
      hi = Math.max(hi, out.data[i]);
    }
    assert.ok(lo <= TARGET_LO[c] + 2, "channel " + c + " low " + lo);
    assert.ok(hi >= TARGET_HI[c] - 2, "channel " + c + " high " + hi);
  }
});

test("hazy shaded crowns stop reading as water once levelled", () => {
  const raw = hazyPlate();
  const frame = { imgW: 240, imgH: 240, mpuX: 0.6, mpuY: 0.6 };
  const before = surfaceMasksFromImage(raw, frame);
  const after = surfaceMasksFromImage(normalizeAerial(raw), frame);
  assert.ok(before.waterM2 > 0, "haze reads as water before levelling");
  assert.strictEqual(after.waterM2, 0);
});

test("a flat or empty image is returned unchanged", () => {
  const flat = image(32, 32, () => [120, 120, 120]);
  assert.strictEqual(normalizeAerial(flat), flat);
  assert.strictEqual(normalizeAerial(null), null);
});
