"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { setSiteTypes } = require("../netlify/lib/export-mode");
const {
  pitchClass,
  isTruckLotTags,
  decidePitch,
  vehiclePixel,
  mergeDenseCars,
  semiBoxes,
  boatBoxes,
  scoreVehicles,
  scoreLayerOverlap,
  SEMI_LENGTH_M,
  SEMI_WIDTH_M,
  BOAT_LENGTH_M,
  CAR_LAYER_M,
  RV_DB,
  TRAILER_DB,
  semisAtDocks,
} = require("../netlify/lib/vehicle-track");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { outdoorMaterial } = require("../netlify/lib/materials");

describe("vehicle track", () => {
  it("reads an RV pad and a tent pad from the mapped name", () => {
    assert.equal(pitchClass("RV 12"), "rv");
    assert.equal(pitchClass("TS 4"), "tent");
    assert.equal(pitchClass("TS42"), "tent");
    assert.equal(pitchClass(""), "");
  });

  it("keeps a metal RV at 12 dB/m and a trailer at the same rate", () => {
    const rv = outdoorMaterial("rv", 3.5);
    const trailer = outdoorMaterial("trailer", 3.2);
    assert.equal(rv.rf_properties.attenuation_per_m, RV_DB);
    assert.equal(trailer.rf_properties.attenuation_per_m, TRAILER_DB);
    assert.equal(rv.transparencyEnabled, undefined);
    assert.equal(trailer.transparencyEnabled, undefined);
    assert.ok(RV_DB >= 10 && RV_DB <= 15);
  });

  it("drops an empty tent pad and keeps a light vehicle on it as a trailer", () => {
    assert.equal(decidePitch("tent", null), "");
    assert.equal(decidePitch("tent", 2), "");
    assert.equal(decidePitch("tent", 12), "trailer");
    setSiteTypes(false);
    assert.equal(decidePitch("rv", 2), "");
    setSiteTypes(true);
    // /dev hosts model the worst case: an empty RV pitch keeps its RV.
    assert.equal(decidePitch("rv", 2), "rv");
    assert.equal(decidePitch("rv", null), "rv");
    assert.equal(decidePitch("rv", 200), "");
    assert.equal(decidePitch("road", 2), "rv");
  });

  it("treats a pale roof as a vehicle and a green lawn as ground", () => {
    assert.equal(vehiclePixel(210, 208, 200), true);
    assert.equal(vehiclePixel(70, 120, 60), false);
    assert.equal(vehiclePixel(180, 90, 40), false);
    assert.equal(vehiclePixel(40, 40, 40), false);
  });

  it("merges a dense car row into one 1.5 m layer", () => {
    const lat = 33.4;
    const lon = -112.0;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const points = [];
    for (let i = 0; i < 12; i++) points.push([lon + (i * 2.6) / mLon, lat]);
    for (let i = 0; i < 12; i++) points.push([lon + (i * 2.6) / mLon, lat + 4 / 110540]);
    const layers = mergeDenseCars(points);
    assert.ok(layers.length < points.length, "layers " + layers.length);
    assert.ok(layers.length <= 4, "rows " + layers.length);
    assert.equal(layers[0].merged, true);
    assert.equal(layers[0].heightM, CAR_LAYER_M);
    const few = mergeDenseCars(points.slice(0, 3));
    assert.equal(few.length, 3);
    assert.equal(few[0].merged, false);
  });

  it("puts dock aprons outside the warehouse and not on the roof", () => {
    const { dockAprons, roofWantsDocks } = require("../netlify/lib/vehicle-track");
    const ring = [
      [-86.4888, 40.0322],
      [-86.4888, 40.0275],
      [-86.4868, 40.0275],
      [-86.4868, 40.0322],
      [-86.4888, 40.0322],
    ];
    const aprons = dockAprons(ring, 46);
    assert.ok(aprons.length >= 2, "aprons " + aprons.length);
    const center = [-86.4878, 40.02985];
    for (let i = 0; i < aprons.length; i++) {
      let inside = false;
      const poly = aprons[i];
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const yi = poly[a][1];
        const yj = poly[b][1];
        if (yi > center[1] === yj > center[1]) continue;
        const x = ((poly[b][0] - poly[a][0]) * (center[1] - yi)) / (yj - yi || 1e-20) + poly[a][0];
        if (center[0] < x) inside = !inside;
      }
      assert.equal(inside, false, "apron " + i + " covers the roof");
    }
    const frame = { mpuX: 0.5, mpuY: 0.5 };
    const big = [
      [0, 0],
      [200, 0],
      [200, 220],
      [0, 220],
      [0, 0],
    ];
    assert.equal(roofWantsDocks([big], frame), true);
    assert.equal(roofWantsDocks([[[0, 0], [20, 0], [20, 20], [0, 20]]], frame), false);
  });

  it("treats a truck stop name as a truck lot", () => {
    assert.equal(isTruckLotTags({ parking: "truck" }), true);
    assert.equal(isTruckLotTags({ name: "Iowa 80 Truckstop" }), true);
    assert.equal(isTruckLotTags({ parking: "surface", name: "Main lot" }), false);
  });

  it("places semi boxes on a truck lot and boats on slips", () => {
    const lat = 41.5;
    const lon = -90.8;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const lot = [
      [lon, lat],
      [lon + 90 / mLon, lat],
      [lon + 90 / mLon, lat + 30 / 110540],
      [lon, lat + 30 / 110540],
      [lon, lat],
    ];
    const semis = semiBoxes([{ coords: lot }]);
    assert.ok(semis.length >= 2, "semis " + semis.length);
    assert.equal(semis[0].kind, "semi");
    assert.equal(semis[0].heightM, 4.1);
    const marina = [
      [lon, lat],
      [lon + 40 / mLon, lat],
      [lon + 40 / mLon, lat + 20 / 110540],
      [lon, lat + 20 / 110540],
      [lon, lat],
    ];
    const boats = boatBoxes([
      { kind: "marina", coords: marina },
      { kind: "mooring", coords: [[lon + 10 / mLon, lat + 8 / 110540]] },
      { kind: "mooring", coords: [[lon + 1, lat + 1]] },
    ]);
    assert.equal(boats.length, 1);
    assert.equal(boats[0].heightM, 3.5);
    assert.ok(BOAT_LENGTH_M >= 6 && SEMI_LENGTH_M > SEMI_WIDTH_M);
  });

  it("scores a merged car layer by covered area", () => {
    const parked = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.0004],
      [0, 0.0004],
      [0, 0],
    ];
    const empty = [
      [0, 0.0005],
      [0.001, 0.0005],
      [0.001, 0.0009],
      [0, 0.0009],
      [0, 0.0005],
    ];
    const layer = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.0009],
      [0, 0.0009],
      [0, 0],
    ];
    const row = scoreLayerOverlap(
      [
        { class: "car", ring: parked },
        { class: "empty", ring: empty },
      ],
      [layer],
      8
    );
    assert.ok(row.recall > 0.9, "recall " + row.recall);
    assert.ok(row.precision > 0.3 && row.precision < 0.7, "precision " + row.precision);
  });

  it("scores a class only against pads that were labeled", () => {
    const pad = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
      [0, 0],
    ];
    const rows = scoreVehicles(
      [
        { class: "rv", ring: pad },
        { class: "empty", ring: pad },
      ],
      [{ class: "rv", center: [0.0005, 0.0005], ring: pad }]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].class, "rv");
    assert.equal(rows[0].recall, 1);
    assert.equal(rows[0].precision, 1);
  });

  it("does not invent trailers on an empty gray apron", () => {
    const width = 220;
    const height = 180;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 168;
      data[i + 1] = 168;
      data[i + 2] = 168;
      data[i + 3] = 255;
    }
    const frame = geoFrame(
      { west: -90, south: 40, east: -89.988, north: 40.004 },
      { imgW: width, imgH: height, maxSpanM: 8000, minSpanM: 1 }
    );
    const ring = [
      [-89.997, 40.0036],
      [-89.997, 40.0004],
      [-89.991, 40.0004],
      [-89.991, 40.0036],
      [-89.997, 40.0036],
    ];
    const found = semisAtDocks([ring], frame, { data, width, height }, [ring]);
    assert.equal(found.length, 0);
  });

  it("searches a yard inside the footprint and skips a panel roof", () => {
    const { yardInsideFootprint } = require("../netlify/lib/vehicle-track");
    const width = 400;
    const height = 240;
    const frame = geoFrame(
      { west: -90, south: 40, east: -89.996, north: 40.0024 },
      { imgW: width, imgH: height, maxSpanM: 8000, minSpanM: 1 }
    );
    const ring = [
      [-89.9992, 40.0022],
      [-89.9992, 40.0002],
      [-89.9968, 40.0002],
      [-89.9968, 40.0022],
      [-89.9992, 40.0022],
    ];
    function paint(draw) {
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const rgb = draw(x, y);
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
          data[i + 3] = 255;
        }
      }
      return { data, width, height };
    }
    function xy(lon, lat) {
      const x = ((lon - frame.west) / (frame.east - frame.west)) * width;
      const y = ((frame.north - lat) / (frame.north - frame.south)) * height;
      return [x, y];
    }
    const roofX = xy(-89.9982, 40.0012)[0];
    const yardPlate = paint((x, y) => {
      if (x < roofX) return [236, 236, 232];
      const rel = y - 188;
      const row = Math.floor(rel / 10);
      const inRow = row >= 0 && row < 4;
      const along = x - roofX - 36;
      const inLen = along >= 0 && along < 16;
      const across = inRow ? rel - row * 10 : 99;
      if (inRow && inLen && across >= 0 && across < 2) return [232, 232, 228];
      if (inRow && inLen && across >= 2 && across < 6) return [42, 42, 40];
      return [132, 132, 128];
    });
    const yard = yardInsideFootprint(ring, frame, yardPlate);
    assert.ok(yard.yardM2 >= 400, "yard " + yard.yardM2);
    const found = semisAtDocks([ring], frame, yardPlate, [ring]);
    assert.ok(found.length >= 2, "trailers " + found.length);
    for (let i = 0; i < found.length; i++) {
      const px = xy(found[i].center[0], found[i].center[1]);
      assert.ok(px[0] > roofX, "trailer on the roof at x " + px[0]);
    }
    const solar = paint((x, y) => {
      const inset = x > 30 && x < width - 30 && y > 24 && y < height - 24;
      const panel = inset && (Math.floor((x - 30) / 18) % 2 === 0) && (Math.floor((y - 24) / 10) % 2 === 0);
      return panel ? [42, 48, 44] : [244, 244, 240];
    });
    const roof = yardInsideFootprint(ring, frame, solar);
    assert.equal(roof.allow, null);
    assert.equal(roof.yardM2, 0);
    const onRoof = semisAtDocks([ring], frame, solar, [ring]);
    assert.equal(onRoof.length, 0);
  });
});
