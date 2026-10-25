"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { racePlates, refusedBySource } = require("../netlify/lib/aerial-fetch");
const exportMode = require("../netlify/lib/export-mode");
const vt = require("../netlify/lib/vehicle-track");
const { fillPads } = require("../netlify/lib/rv-pads");

function jpegLike(n) {
  const b = Buffer.alloc(n, 7);
  b[0] = 0xff;
  b[1] = 0xd8;
  return b;
}

describe("aerial plates Esri does not serve", () => {
  it("marks the kept plate as the finest there is when every sharper plate got HTTP 500", async () => {
    const got = await racePlates(
      [
        { plate: { imgW: 32, imgH: 32 }, tile: false },
        { plate: { imgW: 16, imgH: 16 }, tile: false },
        { plate: { imgW: 8, imgH: 8 }, tile: false },
      ],
      {
        budgetMs: 2000,
        fetchImage: async (frame) => {
          if (frame.imgW > 8) throw new Error("HTTP 500");
          return jpegLike(200);
        },
      }
    );
    assert.equal(got.index, 2);
    assert.equal(got.stepped, true);
    assert.equal(got.noFiner, true);
  });

  it("a timeout is not a refusal", () => {
    assert.equal(refusedBySource(new Error("HTTP 500")), true);
    assert.equal(refusedBySource(new Error("The operation was aborted due to timeout")), false);
    assert.equal(refusedBySource(null), false);
  });
});

// A synthetic 0.25 m plate: gravel ground, one plate in lon/lat.
function plateOf(w, h, rgb) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
function paint(plate, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * plate.width + x) * 4;
      plate.data[i] = rgb[0];
      plate.data[i + 1] = rgb[1];
      plate.data[i + 2] = rgb[2];
    }
  }
}
const LAT = 35.1;
const MLON = 111320 * Math.cos((LAT * Math.PI) / 180);
const W = 200;
const H = 200;
const FRAME = {
  west: -114.5,
  east: -114.5 + (W * 0.25) / MLON,
  north: LAT + (H * 0.25) / 110540,
  south: LAT,
  imgW: W,
  imgH: H,
  mpuX: 0.25,
  mpuY: 0.25,
};
const pxToLL = (x, y) => [FRAME.west + (x / W) * (FRAME.east - FRAME.west), FRAME.north - (y / H) * (FRAME.north - FRAME.south)];
const PAD = [pxToLL(20, 20), pxToLL(180, 20), pxToLL(180, 180), pxToLL(20, 180), pxToLL(20, 20)];

describe("site types roadside roofs (ROADSIDE_V2)", () => {
  afterEach(() => exportMode.setSiteTypes(false));

  it("finds a blue-grey park model on gravel that the white mask misses", () => {
    const plate = plateOf(W, H, [166, 164, 147]);
    // 3.5 x 12 m teal roof with its shadow along one side.
    paint(plate, 90, 76, 104, 124, [135, 166, 161]);
    paint(plate, 104, 76, 108, 124, [60, 62, 58]);
    exportMode.setSiteTypes(false);
    assert.equal(vt.roadsideVehicles(PAD, FRAME, plate, []).length, 0);
    exportMode.setSiteTypes(true);
    const got = vt.roadsideVehicles(PAD, FRAME, plate, []);
    assert.equal(got.length, 1);
    assert.ok(got[0].len > 10 && got[0].len < 14, String(got[0].len));
  });

  it("leaves a court (saturated blue) and a mapped roof alone", () => {
    exportMode.setSiteTypes(true);
    const plate = plateOf(W, H, [166, 164, 147]);
    paint(plate, 90, 76, 104, 124, [40, 90, 170]);
    assert.equal(vt.roadsideVehicles(PAD, FRAME, plate, []).length, 0);
    const p2 = plateOf(W, H, [166, 164, 147]);
    paint(p2, 90, 76, 104, 124, [135, 166, 161]);
    const roof = [pxToLL(89, 75), pxToLL(105, 75), pxToLL(105, 125), pxToLL(89, 125), pxToLL(89, 75)];
    assert.equal(vt.roadsideVehicles(PAD, FRAME, p2, [roof]).length, 0);
  });

  it("a pale concrete slab on a grey gravel pad is not a roof; a white roof is", () => {
    exportMode.setSiteTypes(true);
    // A sunlit photo: a white roof off the pad sets the top tone.
    const plate = plateOf(W, H, [120, 118, 108]);
    paint(plate, 0, 0, 16, 16, [248, 248, 246]);
    paint(plate, 90, 76, 104, 124, [188, 176, 156]);
    assert.equal(vt.roadsideVehicles(PAD, FRAME, plate, []).length, 0);
    const p2 = plateOf(W, H, [120, 118, 108]);
    paint(p2, 0, 0, 16, 16, [248, 248, 246]);
    paint(p2, 90, 76, 104, 124, [238, 238, 232]);
    assert.equal(vt.roadsideVehicles(PAD, FRAME, p2, []).length, 1);
  });

  it("under a forest canopy a dimmer roof still counts", () => {
    exportMode.setSiteTypes(true);
    const plate = plateOf(W, H, [70, 72, 60]);
    paint(plate, 0, 0, 16, 16, [205, 203, 196]);
    paint(plate, 90, 76, 104, 124, [190, 186, 172]);
    assert.equal(vt.roadsideVehicles(PAD, FRAME, plate, []).length, 1);
  });

  it("empty gravel gets no box", () => {
    exportMode.setSiteTypes(true);
    assert.equal(vt.roadsideVehicles(PAD, FRAME, plateOf(W, H, [166, 164, 147]), []).length, 0);
  });
});

describe("pad fills stay on the park's pad surface", () => {
  // Pixel space, y up, 0.25 m per px. A road along y = 100 px (25 m).
  const frame = { imgW: 800, imgH: 400, mpuX: 0.25, mpuY: 0.25 };
  const zone = [[0, 0], [800, 0], [800, 400], [0, 400], [0, 0]];
  const road = { line: [[0, 100], [800, 100]] };
  const rv = (cx) => {
    const x0 = cx - 6;
    return [[x0, 124], [x0 + 12, 124], [x0 + 12, 172], [x0, 172], [x0, 124]];
  };
  function run(farRgb) {
    const plate = plateOf(800, 400, [166, 164, 147]);
    // Image rows run top-down: y_up 0..400 -> row 400..0. Sand east of x = 400 px.
    paint(plate, 400, 0, 800, 400, farRgb);
    const evidence = [];
    for (let k = 0; k < 6; k++) evidence.push(rv(40 + k * 56));
    return fillPads({ zones: [zone], roads: [road], evidence, obstacles: [], frame, plate });
  }
  it("fills the run past the last RV on matching gravel", () => {
    const got = run([166, 164, 147]);
    assert.ok(got.added >= 3, String(got.added));
  });
  it("does not fill open desert sand that is not the pad surface", () => {
    const same = run([166, 164, 147]).rings.filter((r) => r[0][0] > 400).length;
    const sand = run([203, 184, 152]).rings.filter((r) => r[0][0] > 400).length;
    assert.ok(same > 0, String(same));
    assert.equal(sand, 0);
  });
});
