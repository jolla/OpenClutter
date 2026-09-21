"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { groupsForBbox, featureFromRow, featuresFromRows, RELEASE } = require("../netlify/lib/overture");

const OAK = {
  west: -87.92259693145752,
  south: 42.89043196008693,
  east: -87.91184663772584,
  north: 42.90325386116256,
};

describe("Overture buildings", () => {
  it("selects the single Oak Creek row group from the committed index", () => {
    const groups = groupsForBbox(OAK.west, OAK.south, OAK.east, OAK.north);
    assert.equal(RELEASE, "2026-08-19.0");
    assert.equal(groups.length, 1);
    assert.match(groups[0].file, /^part-00060-/);
    assert.equal(groups[0].rowStart, 1265190);
    assert.equal(groups[0].rowCount, 22200);
    assert.ok(groups[0].xmin < OAK.west && groups[0].xmax > OAK.east);
  });

  it("keeps an explicit height over a floor-count estimate and drops rows outside the bbox", () => {
    const inside = {
      height: 6.45,
      num_floors: 2,
      bbox: { xmin: -87.92, xmax: -87.919, ymin: 42.9, ymax: 42.901 },
      geometry: {
        type: "Polygon",
        coordinates: [[[-87.92, 42.9], [-87.919, 42.9], [-87.919, 42.901], [-87.92, 42.901], [-87.92, 42.9]]],
      },
    };
    const floorsOnly = {
      height: null,
      num_floors: 3,
      bbox: { xmin: -87.918, xmax: -87.917, ymin: 42.898, ymax: 42.899 },
      geometry: {
        type: "Polygon",
        coordinates: [[[-87.918, 42.898], [-87.917, 42.898], [-87.917, 42.899], [-87.918, 42.899], [-87.918, 42.898]]],
      },
    };
    const outside = {
      height: 20,
      num_floors: 4,
      bbox: { xmin: -87.8, xmax: -87.79, ymin: 42.7, ymax: 42.71 },
      geometry: {
        type: "Polygon",
        coordinates: [[[-87.8, 42.7], [-87.79, 42.7], [-87.79, 42.71], [-87.8, 42.71], [-87.8, 42.7]]],
      },
    };
    const underground = { is_underground: true, height: 5, bbox: inside.bbox, geometry: inside.geometry };
    const features = featuresFromRows([inside, floorsOnly, outside, underground], OAK);
    assert.equal(features.length, 2);
    assert.equal(features[0].properties.heightSource, "overture");
    assert.equal(features[0].properties.height, 6.45);
    assert.equal(features[1].properties.heightSource, "overture-floors");
    assert.equal(features[1].properties.height, 9);
    assert.equal(featureFromRow(underground, OAK), null);
  });
});
