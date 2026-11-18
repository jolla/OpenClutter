"use strict";

// 1.3.40: slope splits run in one persistent thread per Node thread. The
// pieces must match the in-process 1.3.26 split and the old child process,
// and a hung stand must still be cut off at the budget.
process.env.OPENCLUTTER_SPLIT_THREAD_TEST = "1";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { terrainFromSamples, splitRingByFloor } = require("../netlify/lib/terrain");
const splitPool = require("../netlify/lib/split-pool");

function gridSamples(frame, zAt) {
  const samples = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const lon = frame.west + ((c + 0.5) / 6) * (frame.east - frame.west);
      const lat = frame.south + ((r + 0.5) / 6) * (frame.north - frame.south);
      samples.push({ lon, lat, z: zAt(r, c, lon, lat) });
    }
  }
  return samples;
}

function rect(frame, a, b, c, d) {
  const spanLon = frame.east - frame.west;
  const span = frame.north - frame.south;
  const w = frame.west + spanLon * a;
  const s = frame.south + span * b;
  const e = frame.west + spanLon * c;
  const n = frame.south + span * d;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (old == null) delete process.env[key];
    else process.env[key] = old;
  }
}

describe("persistent split thread", () => {
  after(() => splitPool.shutdown());
  const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Granite Peak" });
  const span = frame.north - frame.south;
  const terrain = terrainFromSamples(
    gridSamples(frame, (r, c, lon, lat) => 400 + ((lat - frame.south) / span) * 40),
    frame,
    { terrainResolution: "default" }
  );
  const rings = [rect(frame, 0.3, 0.12, 0.46, 0.88), rect(frame, 0.6, 0.1, 0.7, 0.6), rect(frame, 0.1, 0.2, 0.25, 0.95)];

  it("returns the same pieces as the in-process split and the old child", () => {
    assert.equal(splitPool.useChild(), false);
    for (const ring of rings) {
      const inproc = withEnv("OPENCLUTTER_SPLIT_INPROCESS", "1", () => splitRingByFloor(terrain, ring));
      const child = withEnv("OPENCLUTTER_SPLIT_CHILD", "1", () => splitRingByFloor(terrain, ring));
      const thread = splitRingByFloor(terrain, ring);
      const canopy = splitRingByFloor(terrain, ring, { maxPieces: 6, keepPartial: true });
      const canopyIn = withEnv("OPENCLUTTER_SPLIT_INPROCESS", "1", () =>
        splitRingByFloor(terrain, ring, { maxPieces: 6, keepPartial: true })
      );
      assert.ok(thread.length >= 2, "pieces " + thread.length);
      assert.deepEqual(thread, inproc);
      assert.deepEqual(thread, child);
      assert.deepEqual(canopy, canopyIn);
    }
  });

  it("reuses one thread across stands", () => {
    splitRingByFloor(terrain, rings[0]);
    const id = splitPool.threadIdForTest();
    assert.ok(id > 0);
    for (const ring of rings) splitRingByFloor(terrain, ring);
    assert.equal(splitPool.threadIdForTest(), id);
  });

  it("cuts off a hung stand at the budget and starts a fresh thread", () => {
    splitRingByFloor(terrain, rings[0]);
    const before = splitPool.threadIdForTest();
    const t0 = Date.now();
    const res = splitPool.hangForTest(400);
    const wall = Date.now() - t0;
    assert.equal(res.timedOut, true);
    assert.ok(wall >= 350 && wall < 5000, "wall " + wall);
    assert.equal(splitPool.threadIdForTest(), 0);
    const inproc = withEnv("OPENCLUTTER_SPLIT_INPROCESS", "1", () => splitRingByFloor(terrain, rings[1]));
    assert.deepEqual(splitRingByFloor(terrain, rings[1]), inproc);
    const after = splitPool.threadIdForTest();
    assert.ok(after > 0 && after !== before);
  });
});
