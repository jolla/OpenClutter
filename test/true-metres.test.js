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
