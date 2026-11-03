"use strict";

// Feedback #18 prototype: a turned box exports square to the box.
const test = require("node:test");
const assert = require("node:assert");
const R = require("../netlify/lib/rotate-export");
const exportMode = require("../netlify/lib/export-mode");

const BOX = { west: -77.44779, south: 39.05061, east: -77.44294, north: 39.05407 };

function frameFor(b, imgW) {
  const lat0 = (b.south + b.north) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const widthM = (b.east - b.west) * kx;
  const lengthM = (b.north - b.south) * ky;
  const mpu = widthM / imgW;
  const imgH = Math.round(lengthM / mpu);
  return Object.assign({}, b, { imgW, imgH, widthM, lengthM: imgH * mpu, mpuX: mpu, mpuY: mpu });
}

test("rotate is off unless a /dev request asks for it", () => {
  assert.strictEqual(exportMode.rotateWanted(false, { rotate: 30 }), 0);
  assert.strictEqual(exportMode.rotateWanted(true, {}), 0);
  assert.strictEqual(exportMode.rotateWanted(true, { rotate: 0 }), 0);
  assert.strictEqual(exportMode.rotateWanted(true, { rotate: 33 }), 33);
  assert.strictEqual(exportMode.rotateWanted(true, null, { rotate: "-20" }), -20);
  assert.strictEqual(R.normalizeRotate(370), 10);
  assert.strictEqual(R.normalizeRotate(190), -170);
  assert.strictEqual(R.normalizeRotate("x"), 0);
});

test("the expanded north-up box holds every corner of the turned box", () => {
  for (const deg of [-75, -33, 10, 45, 90]) {
    const rect = R.rotatedRect(BOX, deg);
    const ex = R.expandedBounds(rect);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [lon, lat] = R.rectToLl(rect, (a * rect.widthM) / 2, (b * rect.lengthM) / 2);
      assert.ok(lon > ex.west && lon < ex.east && lat > ex.south && lat < ex.north, deg + " corner outside");
    }
  }
});

test("the output grid is square to the box and its maps invert", () => {
  const rect = R.rotatedRect(BOX, 33);
  const frame = frameFor(R.expandedBounds(rect), 3000);
  const g = R.outputGrid(rect, frame);
  assert.ok(Math.abs(g.wM - rect.widthM) < g.mOut && Math.abs(g.lM - rect.lengthM) < g.mOut);
  // One output pixel step is one frame pixel long on the ground (true meters frame).
  assert.ok(Math.abs(Math.hypot(g.fwd[0], g.fwd[3]) - 1) < 1e-3);
  // The output's right edge runs 33 degrees clockwise from east.
  assert.ok(Math.abs((Math.atan2(g.fwd[3], g.fwd[0]) * 180) / Math.PI + 33) < 0.05);
  const p = [123.4, 567.8];
  const f = [g.fwd[0] * p[0] + g.fwd[1] * p[1] + g.fwd[2], g.fwd[3] * p[0] + g.fwd[4] * p[1] + g.fwd[5]];
  const q = [g.inv[0] * f[0] + g.inv[1] * f[1] + g.inv[2], g.inv[3] * f[0] + g.inv[4] * f[1] + g.inv[5]];
  assert.ok(Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6);
});

test("clipping keeps heights on a cut sloped floor", () => {
  const ring = [[-5, 0, 0], [5, 0, 10], [5, 4, 10], [-5, 4, 0]];
  const cut = R.clipRingToBox(ring, 0, 0, 10, 10);
  assert.ok(cut && cut.length === 4);
  const atCut = cut.filter((p) => Math.abs(p[0]) < 1e-9);
  assert.strictEqual(atCut.length, 2);
  for (const p of atCut) assert.ok(Math.abs(p[2] - 5) < 1e-9);
});

test("clipboard items move with the box and leave nothing past the map", () => {
  const rect = R.rotatedRect(BOX, 33);
  const frame = frameFor(R.expandedBounds(rect), 3000);
  const g = R.outputGrid(rect, frame);
  // The box center in the north-up frame's clipboard meters.
  const cx = ((rect.lon0 - frame.west) / (frame.east - frame.west)) * frame.imgW * frame.mpuX - frame.widthM;
  const cy = ((rect.lat0 - frame.south) / (frame.north - frame.south)) * frame.imgH * frame.mpuY - frame.lengthM;
  const clip = {
    mapNotes: [{ x: cx, y: cy, text: "center" }, { x: -frame.widthM + 1, y: -1, text: "corner of the north-up map" }],
    raisedFloorZones: [{ area: { type: "Polygon", coordinates: [[[-frame.widthM, -frame.lengthM], [0, -frame.lengthM], [0, 0], [-frame.widthM, 0], [-frame.widthM, -frame.lengthM]]] }, height: 3 }],
  };
  R.rotateClipboard(clip, frame, g);
  assert.strictEqual(clip.mapNotes.length, 1);
  assert.ok(Math.abs(clip.mapNotes[0].x + g.wM / 2) < 0.01 && Math.abs(clip.mapNotes[0].y + g.lM / 2) < 0.01);
  const ring = clip.raisedFloorZones[0].area.coordinates[0];
  for (const p of ring) assert.ok(p[0] >= -g.wM - 1e-3 && p[0] <= 1e-3 && p[1] >= -g.lM - 1e-3 && p[1] <= 1e-3);
  assert.strictEqual(clip.tiePoints.length, 2);
  assert.strictEqual(clip.tiePoints[1].x, 0);
});
