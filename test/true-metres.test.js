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

test("legacyAreaScale keeps pre-trueMetres size floors (1 when off or on the old plate)", () => {
  const box = { west: -114.57485, east: -114.57321, south: 35.11341, north: 35.11481 };
  const w = 2222;
  const legH = Math.round((w * (box.north - box.south)) / (box.east - box.west));
  const mk = (iw, ih) => gf.unifyFrameMpu(gf.geoFrame(box, { imgW: iw, imgH: ih, maxSpanM: 8000, minSpanM: 1 }));
  const legacy = mk(w, legH);
  const sized = gf.groundMeterPixelSize(legacy, w);
  const truth = mk(sized.imgW, sized.imgH);
  gf.setTrueMetres(false);
  assert.strictEqual(gf.legacyAreaScale(truth), 1);
  assert.strictEqual(gf.legacyAreaScale(legacy), 1);
  gf.setTrueMetres(true);
  assert.strictEqual(gf.legacyAreaScale(legacy), 1);
  const k = gf.legacyAreaScale(truth);
  assert.ok(Math.abs(k - 1 / gf.groundMeterStretch(35.1141)) < 0.005, String(k));
  const north = mk(w, w);
  north.south = 60;
  north.north = 60.01;
  assert.strictEqual(gf.legacyAreaScale(north), 1);
  gf.setTrueMetres(false);
});

test("capOiRingPx yScale picks vertices on the old plate and keeps the ring's own points", () => {
  const { capOiRingPx } = require("../netlify/lib/pipeline");
  // A stepped roof with 60 vertices, true-metre pixels (y stretched by 1/k).
  const k = 0.734;
  const old = [];
  for (let i = 0; i <= 30; i++) old.push([i * 10, i % 2 ? 4 : 0]);
  for (let i = 30; i >= 0; i--) old.push([i * 10, 120 + (i % 3 === 0 ? 3 : 0)]);
  const tall = old.map((p) => [p[0], p[1] / k]);
  const plain = capOiRingPx(old, 40, { maxEpsPx: 2 });
  const scaled = capOiRingPx(tall, 40, { maxEpsPx: 2, yScale: k });
  assert.ok(scaled.length >= 4 && scaled.length <= 41);
  assert.strictEqual(scaled.length, plain.length);
  for (let i = 0; i < scaled.length; i++) {
    assert.ok(Math.abs(scaled[i][0] - plain[i][0]) < 1e-9);
    assert.ok(Math.abs(scaled[i][1] - plain[i][1] / k) < 1e-6);
  }
  const keys = new Set(tall.map((p) => p[0] + "," + p[1]));
  for (const p of scaled) assert.ok(keys.has(p[0] + "," + p[1]), "kept a point that is not on the ring: " + p);
  // yScale 1 (switch off) is the plain path.
  assert.deepStrictEqual(capOiRingPx(tall, 40, { maxEpsPx: 2, yScale: 1 }), capOiRingPx(tall, 40, { maxEpsPx: 2 }));
});

test("metersToLines measures a point against railway segments", () => {
  const { metersToLines } = require("../netlify/lib/vehicle-track");
  const lat = 42.8947;
  const rail = [[-87.9224, lat - 0.001], [-87.9224, lat + 0.001]];
  const kx = Math.cos((lat * Math.PI) / 180) * 111320;
  const near = metersToLines([-87.9224 + 3 / kx, lat], [rail]);
  const far = metersToLines([-87.9224 + 9 / kx, lat], [rail]);
  assert.ok(Math.abs(near - 3) < 0.05, "3 m beside the track: " + near);
  assert.ok(Math.abs(far - 9) < 0.05, "9 m beside the track: " + far);
  assert.strictEqual(metersToLines([-87.9, lat], []), Infinity);
});

test("terrain-split building pieces are flagged for the dock yard guard, output unchanged", () => {
  const { footprintsToClutter } = require("../netlify/lib/pipeline");
  const map = gf.geoFrame({ west: -87.925, south: 42.892, east: -87.918, north: 42.897, name: "Dock" }, { maxSide: 900, metersPerPx: 1 });
  const ring = [[-87.923, 42.893], [-87.920, 42.893], [-87.920, 42.895], [-87.923, 42.895], [-87.923, 42.893]];
  const feat = { type: "Feature", properties: { height: 8 }, geometry: { type: "Polygon", coordinates: [ring] } };
  function slope(split) {
    const fn = () => 0;
    fn.seat = () => 0;
    fn.split = (r) =>
      split
        ? [
            [[-87.923, 42.893], [-87.9215, 42.893], [-87.9215, 42.895], [-87.923, 42.895], [-87.923, 42.893]],
            [[-87.9215, 42.893], [-87.920, 42.893], [-87.920, 42.895], [-87.9215, 42.895], [-87.9215, 42.893]],
          ]
        : [r];
    return fn;
  }
  const whole = footprintsToClutter([feat], map, null, slope(false));
  const cut = footprintsToClutter([feat], map, null, slope(true));
  assert.ok(whole.overlayRings.length >= 1);
  assert.ok(whole.overlayRings.every((r) => !r.terrainSplit));
  assert.ok(cut.overlayRings.length >= 2);
  assert.ok(cut.overlayRings.every((r) => r.terrainSplit === true));
  // The flag is not part of the serialized rings or areas.
  assert.ok(!JSON.stringify(cut.overlayRings).includes("terrainSplit"));
  assert.ok(!JSON.stringify(cut.oiAreas).includes("terrainSplit"));
  const later = footprintsToClutter([feat], map, null, slope(false));
  assert.ok(later.overlayRings.every((r) => !r.terrainSplit), "flag does not leak into the next export");
});

test("dock-truck guards ride only on the trueMetres plate", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "../netlify/lib/detect-parallel.js"), "utf8");
  assert.match(src, /const guarded = vf !== frame && !!dockGuards;/);
  assert.match(src, /if \(guarded\) \{\n\s+job\.opts = \{/);
  const vt = fs.readFileSync(path.join(__dirname, "../netlify/lib/vehicle-track.js"), "utf8");
  assert.match(vt, /if \(railLines && metersToLines\(c, railLines\) < railM\) continue;/);
  assert.match(vt, /if \(noYard && noYard\[r\]\) continue;/);
  const cl = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
  assert.match(cl, /dockGuards: vehicleImagery \? \{ railLines: outdoorRailLines \} : null,/);
});
