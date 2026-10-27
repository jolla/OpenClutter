"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, imagePxToLl } = require("../netlify/lib/geo-frame");
const { roadsideVehicles } = require("../netlify/lib/vehicle-track");
const { photoSun } = require("../netlify/lib/sun-shadow");
const { dropStaleCampFootprints } = require("../netlify/lib/stale-footprints");
const { mercator } = require("../netlify/lib/usgs-lidar");
const mode = require("../netlify/lib/export-mode");

const BOX = { west: -100.0015, south: 35.0, east: -100.0, north: 35.0012 };
const PAD = [175, 168, 155];
const WHITE = [240, 240, 242];
const SHADE = [50, 50, 50];

function frame() {
  return geoFrame(BOX, { maxSide: 800, metersPerPx: 0.3 });
}

function plateOf(f, rgb) {
  const data = new Uint8ClampedArray(f.imgW * f.imgH * 4);
  for (let i = 0; i < f.imgW * f.imgH; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width: f.imgW, height: f.imgH, data };
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

function ringPx(f, x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ].map((p) => imagePxToLl(p[0], p[1], f));
}

/** Pale concrete with rows of small white roofs, each with its shadow to the east. */
function sunnyLot(f) {
  const plate = plateOf(f, PAD);
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 14; k++) {
      const x = 20 + k * 30;
      const y = 300 + r * 40;
      paint(plate, x, y, x + 10, y + 7, WHITE);
      paint(plate, x + 10, y, x + 18, y + 7, SHADE);
    }
  }
  return plate;
}

function lidarGrid(f, tallBox) {
  const cell = 1;
  const a = mercator(f.west, f.south);
  const b = mercator(f.east, f.north);
  const cells = new Map();
  for (let iy = 0; iy <= Math.ceil(b[1] - a[1]); iy++) {
    for (let ix = 0; ix <= Math.ceil(b[0] - a[0]); ix++) {
      const x = a[0] + ix + 0.5;
      const y = a[1] + iy + 0.5;
      let top = 100.2;
      if (tallBox && x >= tallBox[0] && x <= tallBox[2] && y >= tallBox[1] && y <= tallBox[3]) top = 103.5;
      cells.set(ix + "," + iy, { ix, iy, n: 4, g: 100, b: [], u: [top], v: [], uMax: top, bc: 0, vc: 0 });
    }
  }
  return { originX: a[0], originY: a[1], cell, cells };
}

function building(ring) {
  return { type: "Feature", properties: { source: "osm" }, geometry: { type: "Polygon", coordinates: [ring] } };
}

afterEach(() => {
  mode.setShadowTrailers(false);
  mode.setSiteTypes(true);
});

describe("photo sun", () => {
  it("reads the shadow side from small light roofs", () => {
    const f = frame();
    const sun = photoSun(sunnyLot(f), f.mpuX);
    assert.equal(sun.ok, true);
    assert.equal(sun.deg, 0);
    assert.ok(sun.roofs >= 20);
  });

  it("is unsure on a photo with no shadows", () => {
    const f = frame();
    const plate = plateOf(f, PAD);
    for (let k = 0; k < 14; k++) paint(plate, 20 + k * 30, 300, 30 + k * 30, 307, WHITE);
    assert.equal(photoSun(plate, f.mpuX).ok, false);
  });
});

describe("shaded trailers", () => {
  function scene(f, shadow) {
    const plate = sunnyLot(f);
    // A 4.2 by 2.7 m white roof with one vent: short for the vented roof test.
    paint(plate, 60, 60, 74, 69, WHITE);
    paint(plate, 66, 63, 68, 65, [120, 120, 120]);
    if (shadow) paint(plate, 74, 60, 83, 69, SHADE);
    return plate;
  }

  it("finds a short trailer roof that casts a tall shadow, only with shadowTrailers on", () => {
    const f = frame();
    const pad = ringPx(f, 40, 40, 120, 90);
    assert.equal(roadsideVehicles(pad, f, scene(f, true), []).length, 0);
    mode.setShadowTrailers(true);
    const found = roadsideVehicles(pad, f, scene(f, true), []);
    assert.equal(found.length, 1);
    assert.ok(found[0].wid > 2.2 && found[0].wid < 3.4, "wid " + found[0].wid);
  });

  it("leaves out the same white shape with no shadow (a slab or a tarp)", () => {
    const f = frame();
    mode.setShadowTrailers(true);
    assert.equal(roadsideVehicles(ringPx(f, 40, 40, 120, 90), f, scene(f, false), []).length, 0);
  });
});

describe("stale camp footprints", () => {
  const zoneOf = (f) => ringPx(f, 10, 10, 446, 250);

  it("drops an outline on bare pad when the lidar is clear", () => {
    const f = frame();
    const plate = plateOf(f, PAD);
    const bare = building(ringPx(f, 60, 60, 80, 70));
    const r = dropStaleCampFootprints({ features: [bare], zones: [zoneOf(f)], plate, frame: f, lidar: lidarGrid(f) });
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0].by, "lidar");
    assert.equal(r.features.length, 0);
  });

  it("keeps an outline over a roof, one outside a park, and one the lidar sees standing", () => {
    const f = frame();
    const plate = plateOf(f, PAD);
    paint(plate, 150, 60, 170, 70, WHITE);
    const roof = building(ringPx(f, 150, 60, 170, 70));
    const outside = building(ringPx(f, 60, 300, 80, 310));
    const tallRing = ringPx(f, 250, 60, 270, 70);
    const a = mercator(tallRing[0][0], tallRing[2][1]);
    const b = mercator(tallRing[2][0], tallRing[0][1]);
    const tall = building(tallRing);
    const grid = lidarGrid(f, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
    const r = dropStaleCampFootprints({ features: [roof, outside, tall], zones: [zoneOf(f)], plate, frame: f, lidar: grid });
    assert.equal(r.dropped.length, 0);
    assert.equal(r.features.length, 3);
  });

  it("without lidar drops only under clear sun with no shadow beside the outline", () => {
    const f = frame();
    const bare = building(ringPx(f, 60, 60, 80, 70));
    const flat = plateOf(f, PAD);
    assert.equal(dropStaleCampFootprints({ features: [bare], zones: [zoneOf(f)], plate: flat, frame: f, lidar: null }).dropped.length, 0);
    const sunny = sunnyLot(f);
    const r = dropStaleCampFootprints({ features: [bare], zones: [zoneOf(f)], plate: sunny, frame: f, lidar: null });
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0].by, "shadow");
    const shaded = sunnyLot(f);
    paint(shaded, 80, 60, 90, 70, SHADE);
    assert.equal(dropStaleCampFootprints({ features: [bare], zones: [zoneOf(f)], plate: shaded, frame: f, lidar: null }).dropped.length, 0);
  });
});

describe("stale pads in the outdoor plan", () => {
  it("takes a stale-pad outline as pad evidence only, never as a drawn object", () => {
    const { planOutdoor } = require("../netlify/lib/outdoor-clutter");
    const { fillPads } = require("../netlify/lib/rv-pads");
    const f = frame();
    const zone = { kind: "camp-zone", coords: ringPx(f, 20, 20, 300, 300), closed: true };
    const stale = { kind: "stale-pad", coords: ringPx(f, 50, 50, 83, 60), closed: true, heightM: 0, explicitHeight: false, rank: 0 };
    const plan = planOutdoor({ features: [zone, stale], frame: f, slopeTop: null, buildings: [], parkingRings: [] });
    assert.ok(!plan.items.some((it) => it && it.kind === "stale-pad"));
    assert.equal(plan.items.filter((it) => it && (it.kind === "rv" || it.kind === "trailer")).length, 0);
    // Without roads there is no pad pattern, with or without hints.
    const z = [[[20, 20], [300, 20], [300, 300], [20, 300]]];
    assert.equal(fillPads({ zones: z, roads: [], evidence: [], obstacles: [], frame: f, hints: [[[50, 50], [83, 50], [83, 60], [50, 60]]] }).added, 0);
  });
});

describe("export mode", () => {
  it("keeps both new rules off until a /dev export turns them on", () => {
    const fresh = require("../netlify/lib/export-mode");
    assert.equal(typeof fresh.setStaleFootprints, "function");
    fresh.setStaleFootprints(false);
    assert.equal(fresh.isStaleFootprints(), false);
    assert.equal(fresh.isShadowTrailers(), false);
  });
});
