"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame, pxToLl } = require("../netlify/lib/geo-frame");
const { footprintsToClutter, coverageSummary } = require("../netlify/lib/pipeline");
const {
  OI_BUILDING_NAMES,
  OI_BUILDING_TYPES,
  PODIUM_COLOR,
  PODIUM_NAME,
  BUILDING_COLOR_TOWER,
  isPoisonedOiName,
  isPodiumName,
  documentMaterials,
} = require("../netlify/lib/materials");
const { pointInRingLL } = require("../netlify/lib/building-shape");

const FIVE_M = OI_BUILDING_TYPES.find((t) => t.name === "Building - Five Floor").topEdge;

function frame() {
  return geoFrame(
    { west: -115.17, south: 36.12, east: -115.16, north: 36.13, name: "Podium" },
    { maxSide: 700, metersPerPx: 2 }
  );
}

function square(west, south, east, north, props) {
  return {
    type: "Feature",
    properties: props || {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}

function areasOf(built) {
  return built.oiAreas;
}

function byName(areas, pred) {
  return areas.filter((a) => pred(a.area_material.name));
}

describe("podium bases use a warm building gray", () => {
  it("colors a low roof under a tower, and leaves a plain low-rise cool gray", () => {
    const map = frame();
    const podium = square(-115.168, 36.124, -115.165, 36.127, { height: 18, heightSource: "overture" });
    const tower = square(-115.1672, 36.1252, -115.1666, 36.1258, {
      height: 187,
      heightSource: "overture",
    });
    const wing = square(-115.165, 36.125, -115.1642, 36.126, { height: 12, heightSource: "overture" });
    const house = square(-115.1692, 36.129, -115.1686, 36.1296, { height: 8, heightSource: "overture" });
    const shed = square(-115.1669, 36.127, -115.16675, 36.12714, { height: 4.5, heightSource: "overture" });
    const mid = square(-115.1622, 36.1212, -115.1614, 36.122, { height: 20, heightSource: "overture" });
    const neighbor = square(-115.1614, 36.1212, -115.1608, 36.1218, { height: 12, heightSource: "overture" });
    const built = footprintsToClutter([podium, tower, wing, house, shed, mid, neighbor], map);
    const areas = areasOf(built);
    const podiums = byName(areas, (n) => n === PODIUM_NAME || n.indexOf(PODIUM_NAME + " ") === 0);
    const towers = areas.filter((a) => a.area_material.display_color === BUILDING_COLOR_TOWER);
    assert.ok(podiums.length >= 2, "podium and the attached wing, got " + podiums.length);
    assert.equal(built.stats.podiumAreas, podiums.length);
    for (const area of podiums) {
      assert.equal(area.area_material.display_color, PODIUM_COLOR);
      assert.equal(area.area_material.rf_properties.attenuation_per_m, 5);
      assert.equal("transparencyEnabled" in area.area_material, false);
      assert.equal(area.area_material.name.includes("\u2014"), false);
      assert.equal(isPoisonedOiName(area.area_material.name), false);
    }
    assert.equal(towers.length, 1);
    assert.equal(towers[0].area_material.display_color, BUILDING_COLOR_TOWER);
    assert.equal(towers[0].area_material.rf_properties.attenuation_per_m, 5);
    assert.equal(towers[0].area_material.top_height, 187);
    assert.equal(String(towers[0].area_material.name).indexOf(PODIUM_NAME), -1);
    const cool = areas.filter((a) => OI_BUILDING_NAMES.includes(a.area_material.name));
    assert.ok(cool.length >= 3, "house, shed, and mid-rise stay on the gold floors");
    for (const area of cool) {
      assert.notEqual(area.area_material.display_color, PODIUM_COLOR);
    }
    assert.equal(isPoisonedOiName("Hotel podium"), true);
    assert.equal(isPodiumName(PODIUM_NAME), true);
    assert.equal(isPoisonedOiName(PODIUM_NAME), false);
    assert.match(coverageSummary(built.stats), /Podiums \d+\./);
    assert.equal(coverageSummary(built.stats).includes("\u2014"), false);
  });

  it("treats a base under 40 percent of a much taller tower as a podium", () => {
    const map = frame();
    const base = square(-115.1695, 36.1242, -115.1686, 36.1252, { height: 35, heightSource: "overture" });
    const tower = square(-115.1692, 36.1245, -115.1689, 36.1249, { height: 200, heightSource: "overture" });
    const built = footprintsToClutter([base, tower], map);
    const podiums = byName(areasOf(built), (n) => n === PODIUM_NAME);
    const towers = areasOf(built).filter((a) => a.area_material.display_color === BUILDING_COLOR_TOWER);
    assert.equal(podiums.length, 1);
    assert.equal(podiums[0].area_material.display_color, PODIUM_COLOR);
    assert.equal(podiums[0].area_material.top_height, 35);
    assert.equal(podiums[0].area_material.rf_properties.attenuation_per_m, 5);
    assert.equal(towers.length, 1);
    assert.equal(towers[0].area_material.display_color, BUILDING_COLOR_TOWER);
    assert.equal(towers[0].area_material.top_height, 200);
    assert.equal(String(towers[0].area_material.name).indexOf(PODIUM_NAME), -1);
  });

  it("colors a low building:part under a tall part, and not a floating upper part", () => {
    const map = frame();
    const base = square(-115.166, 36.1242, -115.1648, 36.1254, {
      height: 14,
      heightSource: "overture",
      buildingPart: true,
    });
    const tower = square(-115.1656, 36.1245, -115.1652, 36.125, {
      height: 90,
      heightSource: "overture",
      buildingPart: true,
    });
    const sky = square(-115.163, 36.1242, -115.1624, 36.1248, {
      height: 20,
      heightSource: "overture",
      buildingPart: true,
      levelBaseM: 16,
      floatSpan: true,
    });
    const mast = square(-115.1624, 36.1242, -115.1618, 36.1248, {
      height: 80,
      heightSource: "overture",
      buildingPart: true,
    });
    const built = footprintsToClutter([base, tower, sky, mast], map);
    const areas = areasOf(built);
    const podiums = byName(areas, (n) => n === PODIUM_NAME || n.indexOf(PODIUM_NAME + " ") === 0);
    assert.equal(podiums.length, 1);
    assert.equal(podiums[0].area_material.display_color, PODIUM_COLOR);
    assert.equal(podiums[0].area_material.rf_properties.attenuation_per_m, 5);
    const tall = areas.filter((a) => a.area_material.top_height >= 80 || String(a.area_material.name).indexOf("80") >= 0 || String(a.area_material.name).indexOf("90") >= 0);
    assert.ok(tall.length >= 1);
    for (const area of tall) assert.notEqual(area.area_material.display_color, PODIUM_COLOR);
    const floated = areas.filter((a) => a !== podiums[0] && tall.indexOf(a) < 0);
    for (const area of floated) assert.notEqual(area.area_material.name.indexOf(PODIUM_NAME), 0);
  });

  it("keeps the Wynn retail outline warm and the towers cool gray", () => {
    const fc = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/retail-111322055.geojson"), "utf8")
    );
    const ring = fc.features[0].geometry.coordinates[0];
    const map = geoFrame(
      { west: -115.1694, south: 36.1244, east: -115.1638, north: 36.1289, name: "Wynn podium" },
      { maxSide: 900, metersPerPx: 1.2 }
    );
    const retail = {
      type: "Feature",
      properties: { height: 18, heightSource: "overture", geomSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    const wynn = square(-115.1677, 36.12568, -115.1674, 36.12592, {
      height: 187,
      heightSource: "overture",
    });
    const encore = square(-115.1665, 36.12695, -115.16618, 36.12725, {
      height: 192,
      heightSource: "overture",
    });
    assert.equal(pointInRingLL([-115.1683, 36.12571], ring), true);
    assert.equal(pointInRingLL([-115.16755, 36.1258], ring), true);
    assert.equal(pointInRingLL([-115.16634, 36.1271], ring), true);
    const built = footprintsToClutter([retail, wynn, encore], map);
    const areas = areasOf(built);
    const podiums = byName(areas, (n) => n === PODIUM_NAME);
    const towers = areas.filter((a) => a.area_material.display_color === BUILDING_COLOR_TOWER);
    assert.ok(podiums.length >= 1, "retail pieces " + podiums.length);
    assert.equal(built.stats.podiumAreas, podiums.length);
    assert.equal(towers.length, 2);
    for (const area of podiums) {
      assert.equal(area.area_material.display_color, PODIUM_COLOR);
      assert.equal(area.area_material.top_height, FIVE_M);
      assert.equal(area.area_material.rf_properties.attenuation_per_m, 5);
      assert.equal(area.area_material.name, PODIUM_NAME);
    }
    for (const area of towers) {
      assert.ok(area.area_material.top_height >= 169);
      assert.equal(String(area.area_material.name).indexOf(PODIUM_NAME), -1);
      assert.equal(area.area_material.rf_properties.attenuation_per_m, 5);
    }
    let wing = 0;
    const probe = [-115.1683, 36.12571];
    for (let i = 0; i < built.overlayRings.length; i++) {
      const ll = built.overlayRings[i].map((p) => pxToLl(p[0], p[1], map));
      if (!pointInRingLL(probe, ll)) continue;
      wing++;
      const area = areas[i];
      assert.ok(area, "overlay piece has an area");
      assert.equal(area.area_material.name, PODIUM_NAME);
      assert.equal(area.area_material.display_color, PODIUM_COLOR);
    }
    assert.ok(wing >= 1, "western retail wing stayed");
    const catalog = documentMaterials(areas);
    assert.deepEqual(catalog.slice(0, 4).map((m) => m.name), OI_BUILDING_NAMES);
    const podiumCat = catalog.find((m) => m.name === PODIUM_NAME && m.top_height === FIVE_M);
    assert.ok(podiumCat);
    assert.equal(podiumCat.display_color, PODIUM_COLOR);
    for (const area of podiums) assert.deepEqual(area.area_material, podiumCat);
  });

  it("seats a podium on the local slope and keeps the crown thickness", () => {
    const map = frame();
    const podium = square(-115.168, 36.124, -115.165, 36.127, { height: 18, heightSource: "overture" });
    const tower = square(-115.1672, 36.1252, -115.1666, 36.1258, { height: 187, heightSource: "overture" });
    const slopeTop = function () {
      return 40;
    };
    slopeTop.seat = function () {
      return 12.5;
    };
    slopeTop.split = function (ring) {
      return [ring];
    };
    const built = footprintsToClutter([podium, tower], map, null, slopeTop);
    const areas = areasOf(built);
    const podiums = byName(areas, (n) => n.indexOf(PODIUM_NAME) === 0);
    const towers = areas.filter((a) => a.area_material.display_color === BUILDING_COLOR_TOWER);
    assert.equal(podiums.length, 1);
    const mat = podiums[0].area_material;
    assert.equal(mat.name, "Building - Podium 12.5");
    assert.equal(mat.display_color, PODIUM_COLOR);
    assert.equal(mat.bottom_height, 12.5);
    assert.equal(mat.top_height, Math.round((12.5 + FIVE_M) * 10) / 10);
    assert.equal(mat.rf_properties.attenuation_per_m, 5);
    assert.equal("transparencyEnabled" in mat, false);
    assert.equal(towers.length, 1);
    assert.equal(towers[0].area_material.display_color, BUILDING_COLOR_TOWER);
    assert.equal(String(towers[0].area_material.name).indexOf(PODIUM_NAME), -1);
    const clip = built.clipTypes.find((t) => t && t.name === mat.name);
    assert.ok(clip);
    assert.equal(clip.color, PODIUM_COLOR);
    assert.equal(clip.attenuationDbPerMeter, 5);
  });
});
