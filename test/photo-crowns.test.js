"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pcr = require("../netlify/lib/photo-crowns");
const exportMode = require("../netlify/lib/export-mode");
const { materialForVegetation } = require("../netlify/lib/materials");

// 200 x 200 px photo at 0.2 m a pixel (40 m square), north up.
const S = 200;
const MPU = 0.2;
const frame = { west: 0, south: 0, east: 0.0004, north: 0.0004, imgW: S, imgH: S, mpuX: MPU, mpuY: MPU, mpu: MPU };

/** Photo painter: kind(x, y) in photo px (y down) -> "leafy" | "shade" | "roof". */
function photoOf(kind) {
  const data = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const k = kind(x, y);
      const odd = (x + y) % 2 === 1;
      let c;
      if (k === "leafy") c = odd ? [55, 72, 38] : [85, 104, 62];
      else if (k === "shade") c = odd ? [18, 22, 26] : [30, 34, 36];
      // Dense dull green canopy the leaf test misses (neither leafy, shade,
      // bare nor bright): a leaf-on deciduous woods on a hazy photo.
      else if (k === "dull") c = odd ? [90, 140, 100] : [120, 170, 125];
      else c = [236, 238, 240];
      const i = (y * S + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: S, height: S, data };
}

const disk = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;

/** A square crown polygon in OpenIntent px (y up) from photo px corners (y down). */
function squareCrown(x0, y0, x1, y1, heightM) {
  const ringPx = [
    [x0, S - y0],
    [x1, S - y0],
    [x1, S - y1],
    [x0, S - y1],
    [x0, S - y0],
  ];
  return { ringPx, material: materialForVegetation(heightM, "light"), kind: "canopy", shape: "polygon", segTree: true };
}

function areaM2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return (Math.abs(a) / 2) * MPU * MPU;
}

/**
 * Twenty small lidar crowns on the bright roofs along the bottom edge of
 * the photo (photo rows 176 to 196, from column x0): the flight read RVs as trees, so the
 * lidar is out of date here and the photo reshapes every crown.
 */
function staleRoofCrowns(x0 = 0) {
  const step = (S - x0) / 20;
  const out = [];
  for (let i = 0; i < 20; i++) out.push(squareCrown(x0 + i * step, 176, x0 + i * step + step - 1, 196, 4));
  return out;
}

describe("photo-crowns", () => {
  it("splits one lidar block over two trees into two crowns the size of their leaves", () => {
    const a = disk(60, 100, 12);
    const b = disk(130, 100, 10);
    const photo = photoOf((x, y) => (a(x, y) || b(x, y) ? "leafy" : "roof"));
    const ref = pcr.photoCrownRefiner(photo, frame, null);
    const out = ref.refine([squareCrown(40, 80, 150, 120, 9)].concat(staleRoofCrowns()), () => 9);
    assert.equal(ref.stats.stale, true);
    assert.equal(out.length, 2);
    const m2 = out.map((p) => areaM2(p.ringPx)).sort((x, y) => x - y);
    // Disks of 10 and 12 px radius at 0.2 m: 12.6 and 18.1 m2.
    assert.ok(Math.abs(m2[0] - 12.6) < 3, "small crown " + m2[0]);
    assert.ok(Math.abs(m2[1] - 18.1) < 3.5, "large crown " + m2[1]);
    for (const p of out) {
      assert.equal(p.segTree, true);
      assert.equal(p.photoShaped, true);
      assert.ok(p.ringLonLat.length === p.ringPx.length);
    }
    assert.equal(ref.stats.shaped, 1);
    assert.equal(ref.stats.extra, 1);
  });
  it("leaves out a crown that sits on a bright roof with no leaves", () => {
    const photo = photoOf(() => "roof");
    const ref = pcr.photoCrownRefiner(photo, frame, null);
    const out = ref.refine([squareCrown(40, 40, 70, 60, 6)], () => 6);
    assert.equal(out.length, 0);
    assert.equal(ref.stats.dropped, 1);
  });
  it("never reaches past the lidar crown onto leaves farther than a metre", () => {
    const photo = photoOf((x) => (x < 100 ? "leafy" : "roof"));
    const ref = pcr.photoCrownRefiner(photo, frame, null);
    const out = ref.refine([squareCrown(60, 60, 90, 90, 8)].concat(staleRoofCrowns(100)), () => 8);
    assert.equal(out.length, 1);
    for (const p of out[0].ringPx) {
      assert.ok(p[0] >= 60 - 5.5 && p[0] <= 90 + 5.5, "x " + p[0]);
      assert.ok(S - p[1] >= 60 - 5.5 && S - p[1] <= 90 + 5.5, "y " + p[1]);
    }
  });
  it("keeps a shaded or leaf-off crown, a woods, and crowns outside the zone as they were", () => {
    const shade = photoOf(() => "shade");
    const ref = pcr.photoCrownRefiner(shade, frame, null);
    const c = squareCrown(40, 40, 80, 80, 12);
    assert.deepEqual(ref.refine([c], () => 12), [c]);
    const leafy = photoOf(() => "leafy");
    const woods = squareCrown(0, 0, 150, 150, 15); // 900 m2
    assert.deepEqual(pcr.photoCrownRefiner(leafy, frame, null).refine([woods], () => 15), [woods]);
    const roof = photoOf(() => "roof");
    const outside = pcr.photoCrownRefiner(roof, frame, () => false);
    const c2 = squareCrown(40, 40, 70, 60, 6);
    assert.deepEqual(outside.refine([c2], () => 6), [c2]);
  });
  it("does not give one leaf blob to two crowns", () => {
    const photo = photoOf((x, y) => (disk(100, 100, 14)(x, y) ? "leafy" : "roof"));
    const ref = pcr.photoCrownRefiner(photo, frame, null);
    const out = ref.refine([squareCrown(80, 80, 104, 120, 10), squareCrown(96, 80, 120, 120, 8)].concat(staleRoofCrowns()), () => 10);
    assert.equal(out.length, 1);
  });
  it("keeps lidar outlines where the lidar still matches the photo", () => {
    // Two trees under one lidar block and no leafless crowns: nothing to say
    // the flight is out of date, so the block stays as measured.
    const a = disk(60, 100, 12);
    const b = disk(130, 100, 10);
    const photo = photoOf((x, y) => (a(x, y) || b(x, y) ? "leafy" : "roof"));
    const ref = pcr.photoCrownRefiner(photo, frame, null);
    const block = squareCrown(40, 80, 150, 120, 9);
    assert.deepEqual(ref.refine([block], () => 9), [block]);
    assert.equal(ref.stats.stale, false);
    assert.equal(ref.stats.shaped, 0);
  });
  it("never leaves out a crown the leaf test misses unless the photo shows roof or open ground", () => {
    // A dark olive desert crown: smooth, grey-green, neither leafy nor roof.
    const olive = (x, y) => disk(60, 60, 14)(x, y);
    const data = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const c = olive(x, y) ? [66, 68, 60] : [236, 238, 240];
        const i = (y * S + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    }
    const ref = pcr.photoCrownRefiner({ width: S, height: S, data }, frame, null);
    const tree = squareCrown(48, 48, 72, 72, 7);
    const roof = squareCrown(120, 120, 140, 140, 5);
    const out = ref.refine([tree, roof], () => 7);
    assert.deepEqual(out, [tree]);
    assert.equal(ref.stats.dropped, 1);
  });
  it("does not call dense dull green canopy out-of-date lidar", () => {
    // A leafy campground: most crowns sit on dense green canopy the leaf test
    // misses. With no bright roof under them they are no evidence that the
    // lidar is out of date, so no crown is trimmed, split or left out.
    const photo = photoOf((x, y) => (y < 150 ? "dull" : "roof"));
    const ref = pcr.photoCrownRefiner(photo, frame, null);
    assert.equal(ref.classAt(10, 10), 0);
    assert.equal(ref.classAt(11, 10), 0);
    const crowns = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) crowns.push(squareCrown(4 + i * 28, 4 + j * 28, 24 + i * 28, 24 + j * 28, 12));
    const out = ref.refine(crowns, () => 12);
    assert.deepEqual(out, crowns);
    assert.equal(ref.stats.leafless, 25);
    assert.equal(ref.stats.evidence, 0);
    assert.equal(ref.stats.stale, false);
    assert.equal(ref.stats.dropped, 0);
    assert.equal(ref.stats.shaped, 0);
  });
  it("needs a photo that matches the frame", () => {
    assert.equal(pcr.photoCrownRefiner({ width: 10, height: 10, data: new Uint8Array(400) }, frame, null), null);
  });
  it("traces a blob edge on pixel corners", () => {
    const ring = pcr.traceBlob(new Uint8Array([1, 1, 1, 1]), 2, 2);
    assert.equal(ring.length, 8);
  });
  it("puts a small leaf head on a tall reading on a stem, not a green column to the ground", () => {
    const m = require("../netlify/lib/materials");
    const mat = materialForVegetation(12, "heavy");
    // 1.6 m across: the crown is the top 2.5 m.
    const head = m.individualTreeParts(mat, 0, 0, 1.2 * 1.6);
    assert.equal(head.crownMat.bottom_height, 9.5);
    assert.equal(head.trunkMat.top_height, 9.5);
    // 8 m across: the usual stem (35% of the height).
    const wide = m.individualTreeParts(mat, 0, 0, 1.2 * 8);
    assert.equal(wide.crownMat.bottom_height, m.individualTreeParts(mat, 0).crownMat.bottom_height);
    assert.equal(m.leafCrownBase(4, 3), 0, "under 5 m there is no stem");
  });
  it("gives a small photo crown its own stem inside the leaves", () => {
    const veg = require("../netlify/lib/vegetation");
    // An L-shaped 4 m2 leaf blob, 12 m tall (OpenIntent px, y up).
    const ring = [[0, 0], [15, 0], [15, 5], [5, 5], [5, 15], [0, 15], [0, 0]];
    const poly = { ringPx: ring, ringLonLat: ring.map(() => [0, 0]), material: materialForVegetation(12, "heavy"), kind: "canopy", shape: "polygon", segTree: true, photoShaped: true };
    const pack = veg.assembleFoliage([poly], frame, null, null, {}, {});
    const trunks = pack.oiAreas.filter((a) => a.kind === "trunk");
    assert.equal(trunks.length, 1);
    const crowns = pack.oiAreas.filter((a) => a.kind !== "trunk");
    for (const c of crowns) assert.ok(Number(c.material.bottom_height) >= 2.5, c.material.name);
  });
  it("is a /dev switch", () => {
    exportMode.setPhotoCrowns(true);
    assert.equal(exportMode.isPhotoCrowns(), true);
    exportMode.setPhotoCrowns(false);
    assert.equal(exportMode.isPhotoCrowns(), false);
  });
  it("notes how many crowns were shaped", () => {
    assert.equal(pcr.photoCrownNote({ shaped: 0 }), "");
    assert.equal(pcr.photoCrownNote({ shaped: 0, dropped: 2 }), "");
    assert.match(pcr.photoCrownNote({ shaped: 3, extra: 2 }), /^Shaped 3 lidar tree crowns to the leaves on the current photo, 2 more trees split from merged crowns\.$/);
  });
});
