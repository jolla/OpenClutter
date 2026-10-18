"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isSpiderRing, normalizeFeature } = require("../netlify/lib/ms-global");
const { rejectShadowFootprints } = require("../netlify/lib/roof-mask");

// Global ML ring traced along the Wynn tower shadow (208,000 m², needle corners).
const WYNN_SHADOW_RING = [[-115.16405332009997,36.124789550399164],[-115.16295801153164,36.127908379201266],[-115.16293253432373,36.127385212625875],[-115.16230814243062,36.12916308939474],[-115.16383382945126,36.129114619162245],[-115.16556769636415,36.130194728784424],[-115.16670396820764,36.1290048182241],[-115.16371694338106,36.12714401841863],[-115.1670590861363,36.12790995179506],[-115.16672231093274,36.128262663576834],[-115.16631161268266,36.128168566116926],[-115.1662392677861,36.128244327463165],[-115.16605771761485,36.12825008501417],[-115.16716568557267,36.128940238566784],[-115.16701623237009,36.12587125390271],[-115.16824656637948,36.12583223478786],[-115.16705901249782,36.125092410481855],[-115.16600848147596,36.12619268805731],[-115.16589233244099,36.12380327147177],[-115.1650023747563,36.12324888078002],[-115.16384811985061,36.124457821505196],[-115.16376565794306,36.122761386107896],[-115.160534920181,36.12286385048526],[-115.16121058624937,36.1230187048597],[-115.16405332009997,36.124789550399164]];

function rect(w, s, e, n) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

test("Global ML shadow trace with needle corners is dropped at the source", () => {
  assert.strictEqual(isSpiderRing(WYNN_SHADOW_RING), true);
  const f = normalizeFeature({ geometry: { type: "Polygon", coordinates: [WYNN_SHADOW_RING] }, properties: { height: 10.6 } });
  assert.strictEqual(f, null);
});

test("Large square warehouse and small acute rings are kept", () => {
  const big = rect(-86.3, 36.18, -86.297, 36.182);
  assert.strictEqual(isSpiderRing(big), false);
  const wedge = [[-71.05, 42.35], [-71.0496, 42.35], [-71.05, 42.3501], [-71.04995, 42.35005], [-71.05, 42.35]];
  assert.strictEqual(isSpiderRing(wedge), false);
  assert.ok(normalizeFeature({ geometry: { type: "Polygon", coordinates: [big] }, properties: {} }));
});

test("Bow-tie Global ML ring is dropped", () => {
  const bow = [[0, 0], [0.001, 0.001], [0.001, 0], [0, 0.001], [0, 0]];
  assert.strictEqual(normalizeFeature({ geometry: { type: "Polygon", coordinates: [bow] }, properties: {} }), null);
});

function frameAndRaw(shadeLeft) {
  const W = 100;
  const H = 100;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = shadeLeft && x < 50 ? 30 : 170;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v + 6;
      data[i + 3] = 255;
    }
  }
  const frame = { west: 0, south: 0, east: 0.001, north: 0.001, imgW: W, imgH: H, mpd: { lon: 100000, lat: 100000 }, mpuX: 1, mpuY: 1 };
  return { raw: { data, width: W, height: H }, frame };
}

test("Unconfirmed Global ML outline on deep shadow is dropped; confirmed ones stay", () => {
  const { raw, frame } = frameAndRaw(true);
  const shade = rect(0.00005, 0.00005, 0.00045, 0.00095);
  const lit = rect(0.00055, 0.00005, 0.00095, 0.00095);
  const ml = (ring, props) => ({ type: "Feature", properties: { geomSource: "ms-global", ...props }, geometry: { type: "Polygon", coordinates: [ring] } });
  const out = rejectShadowFootprints(raw, frame, [
    ml(shade, {}),
    ml(lit, {}),
    ml(shade, { height: 20, heightSource: "fema" }),
    { type: "Feature", properties: { geomSource: "overture" }, geometry: { type: "Polygon", coordinates: [shade] } },
  ]);
  assert.strictEqual(out.dropped, 1);
  assert.strictEqual(out.features.length, 3);
});
