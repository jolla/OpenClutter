"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { providerFor, leafOnGreenSampler, leafOnGreenPixel, fetchLeafOnPhoto } = require("../netlify/lib/leaf-on-photo");

test("leaf-on provider: Finland only, and only with a key", () => {
  const fi = { west: 27.19, east: 27.2, south: 60.56, north: 60.57 };
  assert.strictEqual(providerFor(fi, {}), null);
  assert.strictEqual(providerFor(fi, { NLS_API_KEY: "k" }).id, "nls-fi");
  assert.strictEqual(providerFor({ west: -88.05, east: -88.04, south: 42.98, north: 42.99 }, { NLS_API_KEY: "k" }), null);
});

test("leaf-on green: foliage yes, grey roof and blue shadow no", () => {
  assert.ok(leafOnGreenPixel(70, 90, 85));
  assert.ok(!leafOnGreenPixel(140, 145, 150));
  assert.ok(!leafOnGreenPixel(80, 90, 110));
});

test("leaf-on sampler: share inside a ring, null without coverage", () => {
  const w = 20, h = 20;
  const data = new Uint8Array(w * h * 4);
  const have = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const col = i % w;
    const green = col < 10;
    data.set(green ? [60, 110, 70, 255] : [150, 150, 150, 255], i * 4);
    have[i] = 1;
  }
  const share = leafOnGreenSampler({ data, have, width: w, height: h });
  assert.ok(share([[1, 1], [8, 1], [8, 8], [1, 8], [1, 1]]) > 0.9);
  assert.ok(share([[11, 1], [18, 1], [18, 8], [11, 8], [11, 1]]) < 0.05);
  have.fill(0);
  assert.strictEqual(share([[1, 1], [8, 1], [8, 8], [1, 8], [1, 1]]), null);
});

test("leaf-on photo: no fetch outside coverage", async () => {
  let called = 0;
  const r = await fetchLeafOnPhoto({ west: -88.05, east: -88.04, south: 42.98, north: 42.99, imgW: 10, imgH: 10 }, { env: { NLS_API_KEY: "k" }, fetch: () => { called++; } });
  assert.strictEqual(r, null);
  assert.strictEqual(called, 0);
});
