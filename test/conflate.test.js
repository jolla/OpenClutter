"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { conflateFootprints, assembleFootprints, dedupeStackedFootprints, heightRank, ringAreaM2 } = require("../netlify/lib/conflate");
const { mergeFootprintFeatures } = require("../netlify/lib/ms-global");

function box(west, south, east, north, props) {
  return {
    type: "Feature",
    properties: Object.assign({}, props),
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}

const RING = [-87.918, 42.899, -87.917, 42.9];

describe("footprint conflation", () => {
  it("keeps a Microsoft height when FEMA only fills gaps", () => {
    const ms = box(RING[0], RING[1], RING[2], RING[3], { height: 11.2, heightSource: "ms-global", geomSource: "ms-global" });
    const fema = box(RING[0] + 0.0001, RING[1] + 0.0001, RING[2] - 0.0001, RING[3] - 0.0001, {
      height: 6.4,
      heightSource: "fema",
    });
    const plain = mergeFootprintFeatures([ms], [fema]);
    assert.equal(plain.heightsTransferred, 0);
    assert.equal(plain.features[0].properties.height, 11.2);
    const ranked = conflateFootprints([ms], [fema], { rankHeight: true });
    assert.equal(ranked.features[0].properties.height, 11.2);
    assert.equal(ranked.features[0].properties.heightSource, "ms-global");
    assert.equal(heightRank(ranked.features[0]), 30);
  });

  it("prefers an explicit Overture height and a more detailed ring", () => {
    const ms = box(RING[0], RING[1], RING[2], RING[3], { height: 8, heightSource: "ms-global", geomSource: "ms-global" });
    const overture = {
      type: "Feature",
      properties: { height: 6.4, heightSource: "overture", geomSource: "overture" },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [RING[0], RING[1]],
          [RING[0] + 0.0004, RING[1]],
          [RING[2] - 0.0002, RING[1] + 0.00015],
          [RING[2], RING[1]],
          [RING[2], RING[3]],
          [RING[0], RING[3]],
          [RING[0], RING[1]],
        ]],
      },
    };
    const merged = conflateFootprints([ms], [overture], { replaceGeometry: true, rankHeight: true });
    assert.equal(merged.added, 0);
    assert.equal(merged.heightsUpgraded, 1);
    assert.equal(merged.geometriesReplaced, 1);
    assert.equal(merged.features[0].properties.height, 6.4);
    assert.equal(merged.features[0].properties.heightSource, "overture");
    assert.equal(merged.features[0].properties.geomSource, "overture");
    assert.ok(merged.features[0].geometry.coordinates[0].length > 5);
  });

  it("does not let a floor-count estimate or a stub ring replace a measured footprint", () => {
    const ms = box(RING[0], RING[1], RING[2], RING[3], { height: 9.1, heightSource: "ms-global" });
    const floors = box(RING[0] + 0.0002, RING[1] + 0.0002, RING[2] - 0.0002, RING[3] - 0.0002, {
      height: 6,
      heightSource: "overture-floors",
      geomSource: "overture",
    });
    const stub = box(RING[0] + 0.0003, RING[1] + 0.0003, RING[0] + 0.00045, RING[1] + 0.00045, {
      height: 14,
      heightSource: "overture",
      geomSource: "overture",
    });
    const merged = conflateFootprints([ms], [floors, stub], { replaceGeometry: true, rankHeight: true });
    assert.equal(merged.features.length, 1);
    assert.equal(merged.features[0].properties.height, 9.1);
    assert.equal(merged.geometriesReplaced, 0);
    assert.equal(merged.heightsUpgraded, 0);
  });

  it("adds an Overture footprint whose centroid is still uncovered", () => {
    const ms = box(RING[0], RING[1], RING[2], RING[3], { height: 5, heightSource: "ms-global" });
    const extra = box(-87.921, 42.896, -87.9202, 42.8968, { height: 4.2, heightSource: "overture" });
    const assembled = assembleFootprints({ global: [ms], overture: [extra], arcgis: [], usa: [] });
    assert.equal(assembled.overtureAdded, 1);
    assert.equal(assembled.features.length, 2);
    assert.equal(assembled.heightSources.overture, 1);
    assert.equal(assembled.heightSources["ms-global"], 1);
  });

  it("drops a shifted duplicate outline of the same roof", () => {
    const cos = Math.cos((42.9 * Math.PI) / 180);
    const dLon = 14 / (111320 * cos);
    const a = box(RING[0], RING[1], RING[2], RING[3], {
      height: 9.1,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const b = box(RING[0] + dLon, RING[1] + 0.00002, RING[2] + dLon, RING[3] + 0.00002, {
      height: 6,
      heightSource: "fema",
      geomSource: "usa",
    });
    const out = dedupeStackedFootprints([a, b]);
    assert.equal(out.features.length, 1);
    assert.equal(out.dropped + out.merged, 1);
    assert.equal(out.features[0].properties.height, 9.1);
    assert.equal(out.features[0].properties.geomSource, "ms-global");
  });

  it("keeps adjacent buildings that only share a wall", () => {
    const cos = Math.cos((42.9 * Math.PI) / 180);
    const lonSpan = 36 / (111320 * cos);
    const latSpan = 28 / 110540;
    const sliver = 0.25 / (111320 * cos);
    const west = -87.92;
    const south = 42.9;
    const a = box(west, south, west + lonSpan, south + latSpan, {
      height: 6,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const b = box(west + lonSpan - sliver, south, west + lonSpan * 2, south + latSpan, {
      height: 5.5,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const out = dedupeStackedFootprints([a, b]);
    assert.equal(out.features.length, 2);
    assert.equal(out.dropped, 0);
    assert.equal(out.cut, 0);
  });

  it("notches a neighbor that cuts across another roof instead of emitting both", () => {
    const cos = Math.cos((42.9 * Math.PI) / 180);
    const lonSpan = 70 / (111320 * cos);
    const latSpan = 40 / 110540;
    const overlap = 18 / (111320 * cos);
    const west = -87.91;
    const south = 42.895;
    const a = box(west, south, west + lonSpan, south + latSpan, {
      height: 11,
      heightSource: "overture",
      geomSource: "overture",
    });
    const b = box(west + lonSpan - overlap, south, west + lonSpan * 2 - overlap, south + latSpan, {
      height: 8,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const out = dedupeStackedFootprints([a, b]);
    assert.equal(out.features.length, 2);
    assert.equal(out.dropped, 0);
    assert.equal(out.cut, 1);
    const polygonClipping = require("polygon-clipping");
    const mx = 111320 * cos;
    const my = 110540;
    const toM = (ring) => {
      const open = ring.slice(0, -1).map(([lon, lat]) => [(lon - west) * mx, (lat - south) * my]);
      open.push(open[0]);
      return open;
    };
    const inter = polygonClipping.intersection(
      [[toM(out.features[0].geometry.coordinates[0])]],
      [[toM(out.features[1].geometry.coordinates[0])]]
    );
    let area = 0;
    for (const poly of inter) {
      const r = poly[0];
      for (let i = 0; i < r.length - 1; i++) area += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    }
    assert.ok(Math.abs(area) / 2 < 5, `notched intersection ${Math.abs(area) / 2}`);
  });

  function metersBox(lon, lat, widthM, heightM, props) {
    const mx = 111320 * Math.cos((lat * Math.PI) / 180);
    const dLon = widthM / mx;
    const dLat = heightM / 110540;
    return box(lon - dLon / 2, lat - dLat / 2, lon + dLon / 2, lat + dLat / 2, props);
  }

  it("replaces a concentric center stub with the fuller roof above the 2.4× cap", () => {
    const lon = -115.156;
    const lat = 36.1204;
    const stub = metersBox(lon, lat, 40, 34, { geomSource: "overture", height: 12, heightSource: "overture" });
    const full = metersBox(lon, lat, 100, 83, { geomSource: "overture", height: 18, heightSource: "overture" });
    const merged = conflateFootprints([stub], [full], { replaceGeometry: true, rankHeight: true });
    assert.equal(merged.features.length, 1);
    assert.equal(merged.geometriesReplaced, 1);
    const area = ringAreaM2(merged.features[0].geometry.coordinates[0]);
    assert.ok(area > 7000 && area < 10000, `full roof area ${area}`);
  });

  it("does not let a coarse mega hull hide a detailed roof that emit would keep", () => {
    const { geoFrame } = require("../netlify/lib/geo-frame");
    const { footprintsToClutter } = require("../netlify/lib/pipeline");
    const lon = -115.164;
    const lat = 36.124;
    const mega = metersBox(lon, lat, 520, 450, { geomSource: "ms-global", height: 10, heightSource: "ms-global" });
    const detail = metersBox(lon - 0.0004, lat + 0.0003, 90, 180, {
      geomSource: "overture",
      height: 22,
      heightSource: "overture",
    });
    const merged = conflateFootprints([mega], [detail], { replaceGeometry: true, rankHeight: true });
    assert.equal(merged.added, 1, "detailed roof must not be covered by a coarse mega hull");
    assert.equal(merged.features.length, 2);
    const frame = geoFrame(
      { west: lon - 0.006, south: lat - 0.004, east: lon + 0.006, north: lat + 0.004, name: "mega" },
      { imgW: 800, imgH: 600 }
    );
    const built = footprintsToClutter(merged.features, frame, null);
    assert.equal(built.stats.droppedMega, 1);
    assert.equal(built.stats.buildings, 1);
  });
});
