"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  geoFrame,
  llToPx,
  pxToLl,
  pxToClipboard,
  clipboardToPx,
  llToClipboard,
  clipboardToLl,
  cornerClipboard,
  fitAffine,
  applyAffine,
  esriImageryUrl,
  msFootprintsUrl,
} = require("../netlify/lib/geo-frame");

/** Wynn Golf Course bbox from project notes (any-site math, this is the fixture). */
const WYNN = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
};

describe("shared geo frame", () => {
  it("map corners → documented clipboard coords", () => {
    const frame = geoFrame(WYNN);
    const c = cornerClipboard(frame);
    assert.ok(Math.abs(c.sw[0] + frame.widthM) < 1e-9);
    assert.ok(Math.abs(c.sw[1] + frame.lengthM) < 1e-9);
    assert.ok(Math.abs(c.se[0]) < 1e-9);
    assert.ok(Math.abs(c.se[1] + frame.lengthM) < 1e-9);
    assert.ok(Math.abs(c.nw[0] + frame.widthM) < 1e-9);
    assert.ok(Math.abs(c.nw[1]) < 1e-9);
    assert.ok(Math.abs(c.ne[0]) < 1e-9);
    assert.ok(Math.abs(c.ne[1]) < 1e-9);
  });

  it("uses geographic aspect (not a square image)", () => {
    const frame = geoFrame(WYNN);
    const imgAspect = frame.imgW / frame.imgH;
    const meterAspect = frame.widthM / frame.lengthM;
    assert.ok(Math.abs(imgAspect - meterAspect) < 0.02);
    assert.notEqual(frame.imgW, frame.imgH);
  });

  it("Esri export URL uses the same bboxSR/imageSR and size as the frame", () => {
    const frame = geoFrame(WYNN);
    const url = esriImageryUrl(frame);
    assert.match(url, /bboxSR=4326/);
    assert.match(url, /imageSR=4326/);
    assert.match(url, new RegExp(`size=${frame.imgW},${frame.imgH}`));
    assert.match(
      url,
      new RegExp(`bbox=${frame.west},${frame.south},${frame.east},${frame.north}`)
    );
    const fp = msFootprintsUrl(frame);
    assert.match(fp, /MSBFP2/);
    assert.match(fp, /outFields=\*/);
  });

  it("ll → px → clipboard → px → ll round-trip", () => {
    const frame = geoFrame(WYNN);
    const lon = -115.1638;
    const lat = 36.128;
    const [x, y] = llToPx(lon, lat, frame);
    const [lon2, lat2] = pxToLl(x, y, frame);
    assert.ok(Math.abs(lon2 - lon) < 1e-12);
    assert.ok(Math.abs(lat2 - lat) < 1e-12);

    const [cx, cy] = pxToClipboard(x, y, frame);
    const [x2, y2] = clipboardToPx(cx, cy, frame);
    assert.ok(Math.abs(x2 - x) < 1e-9);
    assert.ok(Math.abs(y2 - y) < 1e-9);

    const [cx2, cy2] = llToClipboard(lon, lat, frame);
    assert.ok(Math.abs(cx2 - cx) < 1e-9);
    assert.ok(Math.abs(cy2 - cy) < 1e-9);
    const [lon3, lat3] = clipboardToLl(cx2, cy2, frame);
    assert.ok(Math.abs(lon3 - lon) < 1e-12);
    assert.ok(Math.abs(lat3 - lat) < 1e-12);
  });

  it("pixel of west/south is (0,0) and east/north is (imgW, imgH)", () => {
    const frame = geoFrame(WYNN);
    const sw = llToPx(frame.west, frame.south, frame);
    const ne = llToPx(frame.east, frame.north, frame);
    assert.deepEqual(sw.map((n) => +n.toFixed(10)), [0, 0]);
    assert.ok(Math.abs(ne[0] - frame.imgW) < 1e-9);
    assert.ok(Math.abs(ne[1] - frame.imgH) < 1e-9);
  });

  it("rejects a mismatched scale as the GE-screenshot failure mode", () => {
    const frame = geoFrame(WYNN);
    const haminaGuessW = 795.833;
    const haminaGuessL = 447.656;
    const fakeMpu = haminaGuessW / frame.imgW;
    const [x, y] = llToPx(frame.west, frame.south, frame);
    const wrongSW = [x * fakeMpu - haminaGuessW, y * (haminaGuessL / frame.imgH) - haminaGuessL];
    const rightSW = llToClipboard(frame.west, frame.south, frame);
    // Same pixel origin, but clipboard meters disagree by the ~3× auto-scale.
    assert.ok(Math.abs(rightSW[0] / wrongSW[0] - frame.widthM / haminaGuessW) < 0.02);
    assert.ok(Math.abs(rightSW[0] - wrongSW[0]) > 1000);
  });
});

describe("calibration affine (legacy maps only)", () => {
  it("fits 3+ control points and maps them back", () => {
    const frame = geoFrame(WYNN);
    // Pretend a legacy Hamina map is ~1/3 the geographic size (the Wynn GE case).
    const scale = 795.833 / frame.widthM;
    const pts = [
      { lon: frame.west, lat: frame.south, xM: -795.833, yM: -447.656 },
      { lon: frame.east, lat: frame.south, xM: 0, yM: -447.656 },
      { lon: frame.east, lat: frame.north, xM: 0, yM: 0 },
      { lon: frame.west, lat: frame.north, xM: -795.833, yM: 0 },
    ];
    const aff = fitAffine(pts);
    const sw = applyAffine(frame.west, frame.south, aff);
    const ne = applyAffine(frame.east, frame.north, aff);
    assert.ok(Math.abs(sw[0] + 795.833) < 1e-4);
    assert.ok(Math.abs(sw[1] + 447.656) < 1e-4);
    assert.ok(Math.abs(ne[0]) < 1e-4);
    assert.ok(Math.abs(ne[1]) < 1e-4);
    // Midpoint should sit at half the legacy map, not the geographic clipboard.
    const mid = applyAffine((frame.west + frame.east) / 2, (frame.south + frame.north) / 2, aff);
    const geoMid = llToClipboard((frame.west + frame.east) / 2, (frame.south + frame.north) / 2, frame);
    assert.ok(Math.abs(mid[0] - -795.833 / 2) < 1e-4);
    assert.ok(Math.abs(geoMid[0] / mid[0] - 1 / scale) < 0.05);
  });

  it("throws with fewer than 3 points", () => {
    assert.throws(() => fitAffine([{ lon: 0, lat: 0, xM: 0, yM: 0 }]));
  });
});
