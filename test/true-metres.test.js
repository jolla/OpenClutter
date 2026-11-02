"use strict";
const test = require("node:test");
const assert = require("node:assert");
const gf = require("../netlify/lib/geo-frame");
const exportMode = require("../netlify/lib/export-mode");

test("trueMetres: on for dev hosts by default, never on production", () => {
  assert.strictEqual(exportMode.trueMetresWanted(false, {}, {}), false);
  assert.strictEqual(exportMode.trueMetresWanted(false, { trueMetres: true }, { trueMetres: "1" }), false);
  assert.strictEqual(exportMode.trueMetresWanted(true, {}, {}), true);
  assert.strictEqual(exportMode.trueMetresWanted(true, null, null), true);
  assert.strictEqual(exportMode.trueMetresWanted(true, {}, { trueMetres: "1" }), true);
  assert.strictEqual(exportMode.trueMetresWanted(true, {}, { trueMetres: "0" }), false);
  assert.strictEqual(exportMode.trueMetresWanted(true, { trueMetres: false }, { trueMetres: "1" }), false);
  assert.strictEqual(exportMode.trueMetresWanted(true, { trueMetres: "false" }, {}), false);
});

test("ground-meter resample below 54N only with trueMetres", () => {
  gf.setTrueMetres(false);
  assert.strictEqual(gf.needsGroundMeterImage(42.9), false);
  assert.strictEqual(gf.needsGroundMeterImage(60.5), true);
  gf.setTrueMetres(true);
  assert.strictEqual(gf.isTrueMetres(), true);
  assert.strictEqual(gf.needsGroundMeterImage(42.9), true);
  assert.strictEqual(gf.needsGroundMeterImage(52.4), true);
  assert.strictEqual(gf.needsGroundMeterImage(5), false);
  gf.setTrueMetres(false);
});

test("legacy lock keeps the pre-trueMetres plate for the vehicle detectors", () => {
  const jpeg = require("jpeg-js");
  const w = 200;
  const h = 200;
  const data = Buffer.alloc(w * h * 4, 128);
  const buf = jpeg.encode({ data, width: w, height: h }, 80).data;
  const frame = gf.geoFrame({ west: -120.64, south: 35.13, east: -120.635, north: 35.135 }, { imgW: w, imgH: h, maxSpanM: 8000, minSpanM: 1 });
  gf.setTrueMetres(true);
  const on = gf.lockIsotropicImagery(frame, buf, { maxSide: 4096 });
  const legacy = gf.lockIsotropicImagery(frame, buf, { maxSide: 4096, legacy: true });
  gf.setTrueMetres(false);
  const off = gf.lockIsotropicImagery(frame, buf, { maxSide: 4096 });
  assert.strictEqual(on.groundMeters, true);
  assert.ok(on.frame.imgW !== w || on.frame.imgH !== h);
  assert.strictEqual(legacy.groundMeters, false);
  assert.strictEqual(legacy.frame.imgW, off.frame.imgW);
  assert.strictEqual(legacy.frame.imgH, off.frame.imgH);
  assert.strictEqual(legacy.jpegBuf, off.jpegBuf);
});
