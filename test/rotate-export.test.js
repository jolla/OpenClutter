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

// Feedback #21: Planner Plus rejects any sloped floor that is not an open ring
// of four corners with the first edge low and the opposite edge high.
test("turned Copy terrain floors stay open four-corner rings Planner Plus accepts", () => {
  for (const deg of [29, -29, 45, 90, 137]) {
    const rect = R.rotatedRect({ west: 148.53652, south: -22.9834, east: 148.54293, north: -22.97257 }, deg);
    const frame = frameFor(R.expandedBounds(rect), 1500);
    const g = R.outputGrid(rect, frame);
    // A north-up mesh like Copy terrain: 12 x 14 cells, south-north ramps
    // (low edge first, open rings) and flat raised pads, all inside the frame.
    const nx = 12, ny = 14, cw = frame.widthM / nx, ch = frame.lengthM / ny;
    const sloped = [], raised = [];
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const x0 = -frame.widthM + c * cw, x1 = x0 + cw, y0 = -frame.lengthM + r * ch, y1 = y0 + ch;
        if ((r + c) % 3 === 0) {
          raised.push({ area: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] }, height: 2 });
        } else {
          const zs = r * 3, zn = r * 3 + 3;
          sloped.push({ area: { type: "Polygon", coordinates: [[[x0, y0, zs], [x1, y0, zs], [x1, y1, zn], [x0, y1, zn]]] } });
        }
      }
    }
    const area = (ring) => Math.abs(ring.reduce((s, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0)) / 2;
    const clip = { slopedFloors: sloped, raisedFloorZones: raised };
    R.rotateClipboard(clip, frame, g);
    assert.ok(clip.slopedFloors.length > 0 && clip.raisedFloorZones.length > 0);
    let total = 0;
    for (const f of clip.slopedFloors) {
      const ring = f.area.coordinates[0];
      assert.ok(R.validSlopedRing(ring), deg + " bad sloped " + JSON.stringify(ring));
      for (const p of ring) assert.ok(p[0] >= -g.wM - 1e-3 && p[0] <= 1e-3 && p[1] >= -g.lM - 1e-3 && p[1] <= 1e-3);
      total += area(ring);
    }
    for (const f of clip.raisedFloorZones) {
      const ring = f.area.coordinates[0];
      assert.strictEqual(ring.length, 4, deg + " raised ring " + JSON.stringify(ring));
      assert.ok(area(ring) > 0);
      for (const p of ring) assert.ok(p[0] >= -g.wM - 1e-3 && p[0] <= 1e-3 && p[1] >= -g.lM - 1e-3 && p[1] <= 1e-3);
      total += area(ring);
    }
    // The pieces still cover the turned box.
    assert.ok(Math.abs(total - g.wM * g.lM) / (g.wM * g.lM) < 0.002, deg + " cover " + total + " vs " + g.wM * g.lM);
  }
});
