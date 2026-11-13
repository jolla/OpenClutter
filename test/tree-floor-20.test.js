"use strict";

// Feedback #20: woods on a ski hill sat under the sloped floor. A foliage tile
// that ran out of time was rerun with no terrain (every stand at 0 m), and a
// piece that still climbed a whole ramp sat on its downhill edge.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { terrainFromSamples, demUnderFootprint, resetSplitGuard } = require("../netlify/lib/terrain");
const { llToClipboard } = require("../netlify/lib/geo-frame");

const frame = geoFrame({ west: -89.69671, south: 44.91919, east: -89.67452, north: 44.93134, name: "Granite Peak" });

function hill() {
  const samples = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const lon = frame.west + ((c + 0.5) / 8) * (frame.east - frame.west);
      const lat = frame.south + ((r + 0.5) / 8) * (frame.north - frame.south);
      // Summit on the south edge, about 200 m down to the north.
      samples.push({ lon, lat, z: 580 - (r / 7) * 200 });
    }
  }
  return terrainFromSamples(samples, frame);
}

function stand() {
  const w = frame.west + (frame.east - frame.west) * 0.4;
  const e = frame.west + (frame.east - frame.west) * 0.5;
  const s = frame.south + (frame.north - frame.south) * 0.05;
  const n = frame.south + (frame.north - frame.south) * 0.25;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
}

function captureStderr(fn) {
  const real = fs.writeSync;
  const lines = [];
  fs.writeSync = function (fd, text) {
    if (fd === 2 && typeof text === "string") {
      lines.push(text);
      return text.length;
    }
    return real.apply(fs, arguments);
  };
  try {
    return { out: fn(), lines };
  } finally {
    fs.writeSync = real;
  }
}

describe("feedback #20 woods stay on the sloped floor when a tile runs long", () => {
  it("a rerun tile still cuts a hillside stand and seats each piece on its own ground", () => {
    const terrain = hill();
    const slopeTop = demUnderFootprint(terrain, { cellsOnly: true });
    assert.equal(typeof slopeTop, "function");
    const { out: pieces, lines } = captureStderr(() => slopeTop.splitCanopy(stand()));
    resetSplitGuard();
    assert.ok(pieces.length >= 2, "pieces " + pieces.length);
    assert.ok(lines.some((l) => l.indexOf("quick cut") >= 0), lines.join(""));
    assert.equal(lines.some((l) => l.indexOf("slope-split profile") >= 0), false, "no 1.3.26 child");
    const seats = pieces.map((p) => Number(slopeTop.seat(p)) || 0);
    assert.ok(Math.max(...seats) - Math.min(...seats) > 20, "seats " + seats.join(","));
    assert.ok(Math.max(...seats) > 50, "uphill pieces are lifted");
  });

  it("past the soft tile budget the rest of the tile takes the quick cut", () => {
    const terrain = hill();
    const slopeTop = demUnderFootprint(terrain, { cellsAfter: Date.now() - 1 });
    const { out: pieces, lines } = captureStderr(() => slopeTop.splitCanopy(stand()));
    resetSplitGuard();
    assert.ok(pieces.length >= 2);
    assert.ok(lines.some((l) => l.indexOf("quick cut") >= 0));
  });

  it("the timed-out tile rerun keeps its terrain", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/lib/cpu-pool.js"), "utf8");
    const fn = src.split("function foliageAssembleFallback")[1].split("\n}\n")[0];
    assert.equal(/terrain:\s*null/.test(fn), false);
    assert.ok(fn.indexOf("splitCellsOnly: true") >= 0);
  });

  it("refine halves a piece that climbs a ramp until each part climbs at most 3 m", () => {
    const terrain = hill();
    const slopeTop = demUnderFootprint(terrain, {});
    resetSplitGuard();
    const ring = stand();
    const relief = (r) => slopeTop(r) - slopeTop.seat(r);
    assert.ok(relief(ring) > 10, "stand climbs " + relief(ring));
    const parts = slopeTop.refine(ring);
    assert.ok(parts.length >= 2, "parts " + parts.length);
    const area = (r) => {
      const xy = r.map((p) => llToClipboard(p[0], p[1], frame));
      let a = 0;
      for (let i = 0; i < xy.length - 1; i++) a += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
      return Math.abs(a) / 2;
    };
    const total = parts.reduce((s, p) => s + area(p), 0);
    assert.ok(Math.abs(total - area(ring)) < area(ring) * 0.01, "area kept " + total + " of " + area(ring));
    const worst = Math.max(...parts.map(relief));
    assert.ok(worst <= 3.5, "worst part climbs " + worst);
  });

  it("refine leaves a mild piece whole", () => {
    const terrain = hill();
    const slopeTop = demUnderFootprint(terrain, {});
    const w = frame.west + (frame.east - frame.west) * 0.4;
    const s = frame.south + (frame.north - frame.south) * 0.5;
    const d = 0.00002;
    const tiny = [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
    assert.equal(slopeTop.refine(tiny).length, 1);
  });
});
