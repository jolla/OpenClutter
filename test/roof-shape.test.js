"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { footprintsToClutter } = require("../netlify/lib/pipeline");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { domePieces, slopePieces, piecesForFeature, DOME_BANDS, SLOPE_BANDS } = require("../netlify/lib/roof-form");

function metersBox(lon, lat, eastM, northM, props) {
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLon = eastM / mLon;
  const dLat = northM / 110540;
  return {
    type: "Feature",
    properties: Object.assign({ heightSource: "overture", geomSource: "overture" }, props),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [lon - dLon / 2, lat - dLat / 2],
        [lon + dLon / 2, lat - dLat / 2],
        [lon + dLon / 2, lat + dLat / 2],
        [lon - dLon / 2, lat + dLat / 2],
        [lon - dLon / 2, lat - dLat / 2],
      ]],
    },
  };
}

function circle(lon, lat, radiusM, props) {
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const ring = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([lon + (Math.cos(a) * radiusM) / mLon, lat + (Math.sin(a) * radiusM) / 110540]);
  }
  return {
    type: "Feature",
    properties: Object.assign({ heightSource: "overture", geomSource: "overture" }, props),
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function frameAround(lon, lat) {
  const dLon = 400 / (111320 * Math.cos((lat * Math.PI) / 180));
  const dLat = 400 / 110540;
  return geoFrame({
    west: lon - dLon,
    south: lat - dLat,
    east: lon + dLon,
    north: lat + dLat,
    name: "Wynn",
  });
}

function tops(built) {
  return built.oiAreas.map((a) => a.area_material.top_height);
}

describe("dome and sloping roofs", () => {
  it("does not export a dome footprint as one full-height cylinder", () => {
    const sphere = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/sphere-overture.geojson"), "utf8"));
    assert.equal(sphere.properties.roofShape, "dome");
    assert.equal(sphere.properties.height, 112);
    const pieces = domePieces(sphere);
    assert.ok(pieces);
    assert.equal(pieces.length, DOME_BANDS);
    assert.equal(pieces[0].properties.shapePart, true);
    assert.ok(pieces[0].properties.height < 40);
    assert.equal(pieces[pieces.length - 1].properties.height, 112);
    const ground = sphere.geometry.coordinates[0];
    const base = pieces[0].geometry.coordinates[0];
    assert.equal(base.length, ground.length);
    assert.equal(base[0][0], ground[0][0]);
    function lonSpan(ring) {
      let min = Infinity;
      let max = -Infinity;
      for (const p of ring) {
        if (p[0] < min) min = p[0];
        if (p[0] > max) max = p[0];
      }
      return max - min;
    }
    const cap = pieces[pieces.length - 1].geometry.coordinates[0];
    assert.ok(lonSpan(cap) < lonSpan(ground) * 0.55, `cap span ${lonSpan(cap)} vs ground ${lonSpan(ground)}`);

    const frame = frameAround(-115.1621, 36.1212);
    const built = footprintsToClutter([sphere], frame, null);
    assert.ok(built.stats.buildings >= 4 && built.stats.buildings <= DOME_BANDS);
    const heights = tops(built);
    assert.ok(Math.max(...heights) >= 111.5 && Math.max(...heights) <= 112.05);
    assert.ok(Math.min(...heights) < 40);
    assert.ok(new Set(heights.map((h) => h.toFixed(1))).size >= 4, "dome bands share one top");
    const full = built.oiAreas.filter((a) => a.area_material.top_height >= 100 && a.area_material.name === "Building - 112.0");
    assert.equal(full.length, 0);
  });

  it("does not export a high side and a low side as one flat roof", () => {
    const lat = 36.1266;
    const lon = -115.1656;
    const tower = metersBox(lon, lat, 50, 220, {
      height: 187,
      lowHeight: 120,
      roofDirection: 0,
    });
    const pieces = slopePieces(tower);
    assert.ok(pieces);
    assert.equal(pieces.length, SLOPE_BANDS);
    const pieceHeights = pieces.map((p) => p.properties.height);
    assert.equal(pieceHeights[0], 120);
    assert.equal(pieceHeights[pieceHeights.length - 1], 187);
    assert.ok(pieceHeights[1] > 120 && pieceHeights[1] < 187);
    function latOf(feature) {
      const ring = feature.geometry.coordinates[0];
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) s += ring[i][1];
      return s / (ring.length - 1);
    }
    assert.ok(latOf(pieces[0]) > latOf(pieces[pieces.length - 1]), "direction 0 falls to the north");

    const built = footprintsToClutter([tower], frameAround(lon, lat), null);
    assert.equal(built.stats.buildings, SLOPE_BANDS);
    const heights = tops(built).sort((a, b) => a - b);
    assert.ok(heights[0] >= 119.5 && heights[0] <= 120.5, `low ${heights[0]}`);
    assert.ok(heights[heights.length - 1] >= 186.5 && heights[heights.length - 1] <= 187.05, `high ${heights[heights.length - 1]}`);
    assert.ok(new Set(heights.map((h) => h.toFixed(1))).size === SLOPE_BANDS, `flat tops ${heights.join(",")}`);
    const flat = built.oiAreas.filter((a) => a.area_material.name === "Building - 187.0" && a.area_material.bottom_height == null);
    assert.equal(flat.length, 1, "only the high strip is the full measured top");
  });

  it("leaves a plain box and a one-height tower as one object", () => {
    const lat = 36.1266;
    const lon = -115.1656;
    const box = metersBox(lon, lat, 40, 24, { height: 8 });
    const tower = metersBox(lon + 0.002, lat, 70, 230, { height: 187 });
    const round = circle(lon, lat, 40, { height: 20, roofShape: "round" });
    const shedNoDir = metersBox(lon, lat, 40, 180, { height: 80, roofShape: "shed", roofHeight: 30 });
    const shortRise = metersBox(lon, lat, 40, 180, {
      height: 187,
      lowHeight: 182,
      roofDirection: 90,
    });
    assert.equal(piecesForFeature(box).length, 1);
    assert.equal(piecesForFeature(tower).length, 1);
    assert.equal(piecesForFeature(round).length, 1);
    assert.equal(slopePieces(shedNoDir), null);
    assert.equal(slopePieces(shortRise), null);
    assert.equal(domePieces(tower), null);

    const built = footprintsToClutter([box, tower], frameAround(lon, lat), null);
    assert.equal(built.stats.buildings, 2);
    const names = built.oiAreas.map((a) => a.area_material.name);
    assert.ok(names.includes("Building - Two Floor"));
    assert.ok(names.includes("Building - 187.0"));
    assert.equal(built.oiAreas.filter((a) => a.area_material.top_height === 187).length, 1);
  });

  it("derives a shed's low side from the recorded rise and direction", () => {
    const lat = 36.13;
    const lon = -115.16;
    const shed = metersBox(lon, lat, 30, 120, {
      height: 48,
      roofShape: "skillion",
      roofHeight: 20,
      roofDirection: 90,
    });
    const pieces = slopePieces(shed);
    assert.ok(pieces);
    assert.equal(pieces.length, SLOPE_BANDS);
    assert.equal(pieces[0].properties.height, 28);
    assert.equal(pieces[pieces.length - 1].properties.height, 48);
    function lonOf(feature) {
      const ring = feature.geometry.coordinates[0];
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) s += ring[i][0];
      return s / (ring.length - 1);
    }
    assert.ok(lonOf(pieces[0]) > lonOf(pieces[pieces.length - 1]), "direction 90 falls to the east");
    const built = footprintsToClutter([shed], frameAround(lon, lat), null);
    const heights = tops(built);
    assert.equal(built.stats.buildings, SLOPE_BANDS);
    assert.ok(Math.min(...heights) < 30);
    assert.ok(Math.max(...heights) > 47);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 15);
  });
});
