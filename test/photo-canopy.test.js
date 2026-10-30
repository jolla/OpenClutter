"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pc = require("../netlify/lib/photo-canopy");
const exportMode = require("../netlify/lib/export-mode");

const N = 10; // grid cells per side
const PX = 10; // photo px per cell
const frame = { west: 0, south: 0, east: 1, north: 1, imgW: N * PX, imgH: N * PX };

/** Paint each grid cell of a photo with a surface: leafy, greygreen, roof, brown. */
function photoOf(kind) {
  const w = N * PX;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const k = kind(Math.floor(x / PX), Math.floor(y / PX));
      const odd = (x + y) % 2 === 1;
      let c;
      if (k === "leafy") c = odd ? [55, 72, 38] : [85, 104, 62];
      else if (k === "greygreen") c = odd ? [80, 82, 62] : [112, 114, 92];
      else if (k === "brown") c = odd ? [90, 75, 60] : [125, 108, 90];
      else if (k === "shade") c = odd ? [18, 22, 26] : [30, 34, 36];
      else if (k === "dirt") c = [150, 135, 115];
      else c = [236, 238, 240];
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: w, height: w, data };
}

const ALL = () => true;

function gridOf(height) {
  const values = new Float32Array(N * N);
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) values[gy * N + gx] = height(gx, gy);
  return { west: 0, south: 0, east: 1, north: 1, width: N, height: N, values, nonzero: N * N };
}

describe("photo-canopy pixels", () => {
  it("reads a lit broadleaf crown and a grey-green cypress as leafy", () => {
    assert.equal(pc.foliagePixel(70, 82, 48, 20), true);
    assert.equal(pc.foliagePixel(95, 96, 76, 22), true);
  });
  it("does not read an RV roof, gravel or a blue shadow as leafy", () => {
    assert.equal(pc.foliagePixel(238, 238, 238, 24), false);
    assert.equal(pc.foliagePixel(180, 178, 168, 15), false);
    assert.equal(pc.foliagePixel(45, 50, 49, 20), false);
    assert.equal(pc.foliagePixel(70, 82, 48, 4), false, "smooth lawn");
    assert.equal(pc.roofPixel(238, 238, 238, 2), true);
  });
  it("reads bare brown branches, not a roof, a smooth pitch or a blue shadow, as branches", () => {
    assert.equal(pc.branchPixel(110, 95, 78, 18), true);
    assert.equal(pc.branchPixel(236, 238, 240, 20), false);
    assert.equal(pc.branchPixel(150, 135, 115, 4), false);
    assert.equal(pc.branchPixel(40, 48, 62, 20), false);
  });
});

describe("checkCanopyOnPhoto", () => {
  it("clears RV-height lidar canopy on bare roofs and keeps leafy crowns", () => {
    // Left half: tall leafy trees (gate). Right half: 3.8 m RV rows on white roofs.
    const photo = photoOf((gx) => (gx < 5 ? "leafy" : "roof"));
    const grid = gridOf((gx) => (gx < 5 ? 12 : 3.8));
    const res = pc.checkCanopyOnPhoto(grid, photo, frame, ALL);
    assert.equal(res.gate, true);
    assert.equal(res.vehicleHeight, 50);
    assert.equal(grid.nonzero, 50);
    for (let gy = 0; gy < N; gy++) {
      assert.equal(grid.values[gy * N + 2], 12);
      assert.equal(grid.values[gy * N + 7], 0);
    }
  });

  it("keeps a tall grey-green windbreak", () => {
    const photo = photoOf((gx) => (gx < 5 ? "leafy" : "greygreen"));
    const grid = gridOf((gx) => (gx < 5 ? 12 : 9));
    const res = pc.checkCanopyOnPhoto(grid, photo, frame, ALL);
    assert.equal(res.gate, true);
    assert.equal(res.cleared, 0);
  });

  it("clears a tall crown that now stands over a bright roof", () => {
    const photo = photoOf((gx) => (gx < 5 ? "leafy" : "roof"));
    const grid = gridOf((gx) => (gx < 5 ? 12 : 9));
    const res = pc.checkCanopyOnPhoto(grid, photo, frame, ALL);
    assert.equal(res.bare, 50);
  });

  it("leaves a leaf-off photo alone", () => {
    const photo = photoOf((gx) => (gx < 5 ? "brown" : "roof"));
    const grid = gridOf((gx) => (gx < 5 ? 12 : 3.8));
    const res = pc.checkCanopyOnPhoto(grid, photo, frame, ALL);
    assert.equal(res.gate, false);
    assert.equal(res.cleared, 0);
    assert.ok(Math.abs(grid.values[7] - 3.8) < 1e-5);
  });

  it("keeps bare hardwoods on a mixed photo of green pines and leaf-off oaks", () => {
    // Left: tall green pines (gate passes). Middle: 9 m and 4 m leaf-off
    // oaks (bare brown branches). Right: 3.8 m RV rows on white roofs.
    const kind = (gx) => (gx < 4 ? "leafy" : gx < 7 ? "brown" : "roof");
    const grid = gridOf((gx) => (gx < 4 ? 12 : gx < 6 ? 9 : gx < 7 ? 4 : 3.8));
    const res = pc.checkCanopyOnPhoto(grid, photoOf(kind), frame, ALL);
    assert.equal(res.gate, true);
    assert.equal(res.branchKept, 30);
    for (let gy = 0; gy < N; gy++) {
      assert.equal(grid.values[gy * N + 5], 9, "leaf-off oak stays");
      assert.equal(grid.values[gy * N + 6], 4, "low leaf-off oak stays");
      assert.equal(grid.values[gy * N + 8], 0, "RV roof cleared");
    }
    const share = pc.leafyShareSampler(photoOf(kind));
    assert.equal(share([[42, 20], [68, 20], [68, 50], [42, 50]]), null, "bare oak crown piece kept");
    assert.ok(share([[72, 20], [98, 20], [98, 50], [72, 50]]) < pc.PIECE_LEAFY_MIN, "RV roof piece dropped");
  });

  it("keeps a lidar crown piece in deep shade", () => {
    const kind = (gx) => (gx < 5 ? "leafy" : gx < 7 ? "shade" : "roof");
    const share = pc.leafyShareSampler(photoOf(kind));
    assert.equal(share([[52, 20], [68, 20], [68, 50], [52, 50]]), null);
  });

  it("skips a photo that does not match the frame", () => {
    const photo = photoOf(() => "roof");
    const grid = gridOf(() => 3.8);
    const res = pc.checkCanopyOnPhoto(grid, photo, { ...frame, imgW: 50 }, ALL);
    assert.equal(res.cleared, 0);
  });
});

describe("vehicle zones", () => {
  const park = { kind: "camp-zone", coords: [[0.5, 0], [1, 0], [1, 1], [0.5, 1], [0.5, 0]] };
  it("reads only RV parks, campgrounds and mobile home parks", () => {
    assert.equal(pc.vehicleZoneTest([]), null);
    assert.equal(pc.vehicleZoneTest([{ kind: "parking", coords: park.coords }]), null);
    const inZone = pc.vehicleZoneTest([park]);
    assert.equal(inZone(0.75, 0.5), true);
    assert.equal(inZone(0.25, 0.5), false);
  });
  it("does nothing without a zone, and keeps RV-height canopy outside one", () => {
    const photo = photoOf((gx) => (gx < 5 ? "leafy" : "roof"));
    const none = gridOf((gx) => (gx < 5 ? 12 : 3.8));
    assert.equal(pc.checkCanopyOnPhoto(none, photo, frame).cleared, 0);
    // West of the park: an orchard row of 3.8 m trees on brown ground. In
    // the park (x from 0.4): tall leafy trees, then RV roofs.
    const wide = { kind: "camp-zone", coords: [[0.4, 0], [1, 0], [1, 1], [0.4, 1], [0.4, 0]] };
    const grid = gridOf((gx) => (gx < 2 || (gx >= 4 && gx < 7) ? 12 : 3.8));
    const kind = (gx) => (gx < 2 || (gx >= 4 && gx < 7) ? "leafy" : gx < 4 ? "brown" : "roof");
    const res = pc.checkCanopyOnPhoto(grid, photoOf(kind), frame, pc.vehicleZoneTest([wide]));
    assert.equal(res.gate, true);
    for (let gy = 0; gy < N; gy++) {
      assert.ok(grid.values[gy * N + 3] > 3, "outside the park stays");
      assert.equal(grid.values[gy * N + 5], 12, "leafy crown in the park stays");
      assert.equal(grid.values[gy * N + 8], 0, "RV roof in the park cleared");
    }
  });
  it("keeps a crown piece centred outside the park", () => {
    const photo = photoOf(() => "roof");
    const share = pc.zonedShareSampler(pc.leafyShareSampler(photo), pc.vehicleZoneTest([park]), frame);
    const ring = (x0) => [[x0, 20], [x0 + 30, 20], [x0 + 30, 50], [x0, 50]];
    assert.equal(share(ring(5)), null);
    assert.ok(share(ring(60)) < pc.PIECE_LEAFY_MIN);
  });
});

describe("leafyShareSampler", () => {
  it("scores a crown ring on foliage high and on a roof low", () => {
    const photo = photoOf((gx) => (gx < 5 ? "leafy" : "roof"));
    const share = pc.leafyShareSampler(photo);
    const ring = (x0) => [[x0, 20], [x0 + 30, 20], [x0 + 30, 50], [x0, 50]];
    assert.ok(share(ring(5)) >= pc.PIECE_LEAFY_MIN);
    assert.ok(share(ring(60)) < pc.PIECE_LEAFY_MIN);
  });
});

describe("tall canopy keep (feedback #11)", () => {
  // Left: tall green pines (gate passes). Middle: 24 m leaf-off woods over
  // leaf litter (smooth brown, reads as dirt pitch). Right: 15 m crowns over a
  // bright roof (a tree cut since the flight).
  const kind = (gx) => (gx < 4 ? "leafy" : gx < 7 ? "dirt" : "roof");
  const height = (gx) => (gx < 4 ? 20 : gx < 7 ? 24 : 15);
  it("clears dark tall canopy with the switch off (1.3.4 behaviour)", () => {
    exportMode.setTallCanopyKeep(false);
    const grid = gridOf(height);
    const res = pc.checkCanopyOnPhoto(grid, photoOf(kind), frame, ALL);
    assert.equal(res.gate, true);
    assert.equal(grid.values[5], 0);
  });
  it("keeps dark canopy 12 m and taller, still clears it over a lit roof", () => {
    exportMode.setTallCanopyKeep(true);
    try {
      const grid = gridOf(height);
      const res = pc.checkCanopyOnPhoto(grid, photoOf(kind), frame, ALL);
      assert.equal(res.gate, true);
      assert.equal(res.tallKept, 30);
      for (let gy = 0; gy < N; gy++) {
        assert.equal(grid.values[gy * N + 5], 24, "leaf-off woods stay");
        assert.equal(grid.values[gy * N + 8], 0, "lit roof cleared");
      }
      const tall = gridOf(height);
      const share = pc.leafyShareSampler(photoOf(kind), {
        frame,
        heightAt: (lon, lat) => tall.values[Math.min(N - 1, Math.floor((1 - lat) * N)) * N + Math.min(N - 1, Math.floor(lon * N))],
      });
      assert.equal(share([[42, 20], [68, 20], [68, 50], [42, 50]]), null, "tall dark crown piece kept");
      assert.ok(share([[72, 20], [98, 20], [98, 50], [72, 50]]) < pc.PIECE_LEAFY_MIN, "piece over a lit roof dropped");
    } finally {
      exportMode.setTallCanopyKeep(false);
    }
  });
});

describe("tall canopy keep switch (feedback #11)", () => {
  it("is on for /dev hosts only, and ?tallCanopyKeep=0 turns it off there", () => {
    assert.equal(exportMode.tallCanopyKeepWanted(false, {}), false);
    assert.equal(exportMode.tallCanopyKeepWanted(false, { tallCanopyKeep: true }), false);
    assert.equal(exportMode.tallCanopyKeepWanted(true, {}), true);
    assert.equal(exportMode.tallCanopyKeepWanted(true, null), true);
    assert.equal(exportMode.tallCanopyKeepWanted(true, { tallCanopyKeep: false }), false);
    assert.equal(exportMode.tallCanopyKeepWanted(true, { tallCanopyKeep: "0" }), false);
  });
});

describe("photo-canopy export mode", () => {
  it("is on for dev hosts only", () => {
    exportMode.setPhotoCanopy(true);
    assert.equal(exportMode.isPhotoCanopy(), true);
    exportMode.setPhotoCanopy(false);
    assert.equal(exportMode.isPhotoCanopy(), false);
  });
  it("notes the cleared area", () => {
    assert.match(pc.photoCanopyNote({ cleared: 10 }, 4), /^Left out 40 m² of lidar canopy/);
    assert.equal(pc.photoCanopyNote({ cleared: 0 }, 4), "");
  });
});
