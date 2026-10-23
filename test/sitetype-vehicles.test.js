"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, imagePxToLl } = require("../netlify/lib/geo-frame");
const { roadsideVehicles, finalizeVehicles, boatsOnWater } = require("../netlify/lib/vehicle-track");
const { featuresFromMapXml, parseOverpass } = require("../netlify/lib/outdoor-clutter");

const BOX = { west: -100.0015, south: 35.0, east: -100.0, north: 35.0012 };

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
  const r = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  return r.map((p) => imagePxToLl(p[0], p[1], f));
}

describe("site-type vehicles", () => {
  it("finds a white RV roof beside a road and not a tan pad", () => {
    const f = frame();
    const plate = plateOf(f, [120, 118, 112]);
    // A 10 by 2.7 m white roof and a tan concrete pad of the same size.
    paint(plate, 60, 60, 93, 69, [235, 236, 238]);
    paint(plate, 60, 150, 93, 159, [232, 210, 170]);
    const pad = ringPx(f, 40, 40, 120, 90);
    const found = roadsideVehicles(pad, f, plate, []);
    assert.equal(found.length, 1);
    assert.ok(found[0].len > 8 && found[0].len < 12, "len " + found[0].len);
    const tan = roadsideVehicles(ringPx(f, 40, 130, 120, 180), f, plate, []);
    assert.equal(tan.length, 0);
  });

  it("leaves out a roof that is a mapped building", () => {
    const f = frame();
    const plate = plateOf(f, [120, 118, 112]);
    paint(plate, 60, 60, 93, 69, [235, 236, 238]);
    const found = roadsideVehicles(ringPx(f, 40, 40, 120, 90), f, plate, [ringPx(f, 58, 58, 95, 71)]);
    assert.equal(found.length, 0);
  });

  it("draws a road RV only where the photo shows a roof", () => {
    const f = frame();
    const pad = ringPx(f, 40, 40, 120, 90);
    const road = { kind: "rv", pitchUse: "road", coords: ringPx(f, 70, 60, 80, 66), pad, heightM: 3.5 };
    assert.equal(finalizeVehicles([road], null, null).length, 0);
    assert.equal(finalizeVehicles([road], null, () => []).length, 0);
    const c = imagePxToLl(76, 64, f);
    const out = finalizeVehicles([road], null, () => [{ lon: c[0], lat: c[1], ux: 1, uy: 0, len: 9, wid: 2.6 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].pitchUse, "roadside");
  });

  it("puts boats on hulls in the water and none on a bare walkway", () => {
    const f = frame();
    const plate = plateOf(f, [40, 60, 80]);
    // Two hulls, 9 by 3 m, beside a 1 m walkway.
    paint(plate, 30, 100, 300, 103, [220, 220, 220]);
    paint(plate, 60, 105, 90, 115, [235, 235, 235]);
    paint(plate, 150, 105, 180, 115, [235, 235, 235]);
    const ring = ringPx(f, 10, 80, 330, 200);
    const boats = boatsOnWater(ring, f, plate, [], null);
    assert.equal(boats.length, 2, JSON.stringify(boats.map((b) => b.coords && b.coords.length)));
    const empty = plateOf(f, [40, 60, 80]);
    paint(empty, 30, 100, 300, 103, [220, 220, 220]);
    assert.equal(boatsOnWater(ring, f, empty, [], null).length, 0);
  });

  it("keeps a mapped marina from the map extract", () => {
    const xml = [
      "<osm>",
      '<node id="1" lat="35.0002" lon="-100.0012"/>',
      '<node id="2" lat="35.0002" lon="-100.0003"/>',
      '<node id="3" lat="35.0010" lon="-100.0003"/>',
      '<node id="4" lat="35.0010" lon="-100.0012"/>',
      '<way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>',
      '<tag k="leisure" v="marina"/></way>',
      "</osm>",
    ].join("");
    const parsed = featuresFromMapXml(xml, { rvs: true }, BOX);
    assert.equal(parsed.features.filter((x) => x.kind === "marina").length, 1);
  });

  it("makes a marina zone around mapped piers with no marina area", () => {
    const g = (lat) => [
      { lat, lon: -100.0012 },
      { lat, lon: -100.0004 },
    ];
    const elements = [
      { type: "way", id: 10, geometry: g(35.0004), tags: { man_made: "pier" } },
      { type: "way", id: 11, geometry: g(35.0007), tags: { man_made: "pier" } },
    ];
    const parsed = parseOverpass({ elements }, { rvs: true }, BOX);
    const zones = parsed.features.filter((x) => x.kind === "marina");
    assert.equal(zones.length, 1);
    assert.equal(zones[0].piers.length, 2);
  });

  it("keeps the 1.2.17 rules when the export is not on a /dev host", () => {
    const mode = require("../netlify/lib/export-mode");
    const f = frame();
    const road = { kind: "rv", pitchUse: "road", coords: ringPx(f, 70, 60, 80, 66), heightM: 3.5 };
    const xml = [
      "<osm>",
      '<node id="1" lat="35.0002" lon="-100.0012"/>',
      '<node id="2" lat="35.0002" lon="-100.0003"/>',
      '<node id="3" lat="35.0010" lon="-100.0003"/>',
      '<node id="4" lat="35.0010" lon="-100.0012"/>',
      '<way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>',
      '<tag k="leisure" v="marina"/></way>',
      "</osm>",
    ].join("");
    mode.setSiteTypes(false);
    try {
      assert.equal(finalizeVehicles([road], null, null).length, 1);
      assert.equal(featuresFromMapXml(xml, { rvs: true }, BOX).features.filter((x) => x.kind === "marina").length, 0);
    } finally {
      mode.setSiteTypes(true);
    }
    assert.equal(finalizeVehicles([road], null, null).length, 0);
  });

  it("clears a long narrow walkway and keeps a hull beside it", () => {
    const { maskWalkways } = require("../netlify/lib/vehicle-track");
    const w = 200;
    const h = 60;
    const mask = new Uint8Array(w * h);
    // 0.3 m pixels: a 45 m by 2.4 m walkway and a 10 by 4 m hull.
    for (let y = 10; y < 18; y++) for (let x = 20; x < 170; x++) mask[y * w + x] = 1;
    for (let y = 30; y < 43; y++) for (let x = 40; x < 73; x++) mask[y * w + x] = 1;
    maskWalkways(mask, w, h, 0.3);
    let walk = 0;
    let hull = 0;
    for (let y = 10; y < 18; y++) for (let x = 20; x < 170; x++) walk += mask[y * w + x];
    for (let y = 30; y < 43; y++) for (let x = 40; x < 73; x++) hull += mask[y * w + x];
    assert.equal(walk, 0);
    assert.equal(hull, 13 * 33);
  });

  it("draws no boats on a light strip between pavement and water", () => {
    const f = frame();
    const plate = plateOf(f, [20, 30, 45]);
    // Dark pavement on the shore, a 40 m by 5 m light strip along it, open
    // water below.
    paint(plate, 0, 0, f.imgW, 117, [70, 72, 78]);
    paint(plate, 40, 100, 175, 117, [200, 198, 190]);
    const boats = boatsOnWater(ringPx(f, 10, 60, 330, 200), f, plate, [], null);
    assert.equal(boats.length, 0);
  });
});
