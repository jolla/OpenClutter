"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { esriFeaturesToGeojson, fetchUsaStructures } = require("../netlify/lib/usa-structures");
const { mergeFootprintFeatures } = require("../netlify/lib/ms-global");

describe("USA Structures footprints", () => {
  it("keeps the exterior ring and a usable height, and drops holes", () => {
    const features = esriFeaturesToGeojson([
      {
        attributes: { HEIGHT: 6.2 },
        geometry: {
          rings: [
            [
              [-87.92, 42.9],
              [-87.919, 42.9],
              [-87.919, 42.901],
              [-87.92, 42.901],
              [-87.92, 42.9],
            ],
            [
              [-87.9197, 42.9002],
              [-87.9193, 42.9002],
              [-87.9193, 42.9006],
              [-87.9197, 42.9006],
              [-87.9197, 42.9002],
            ],
          ],
        },
      },
      { attributes: { HEIGHT: -1 }, geometry: { rings: [] } },
    ]);
    assert.equal(features.length, 1);
    assert.equal(features[0].geometry.coordinates.length, 1);
    assert.equal(features[0].properties.height, 6.2);
  });

  it("fetches ids then geometry and merges only uncovered centroids", async () => {
    const frame = { west: -87.93, south: 42.89, east: -87.91, north: 42.91 };
    const ring = [
      [-87.9205, 42.9005],
      [-87.9202, 42.9005],
      [-87.9202, 42.9009],
      [-87.9205, 42.9009],
      [-87.9205, 42.9005],
    ];
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("returnIdsOnly")) {
        return { ok: true, json: async () => ({ objectIds: [7] }) };
      }
      assert.match(u, /objectIds=7/);
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { HEIGHT: 8 }, geometry: { rings: [ring] } }],
        }),
      };
    };
    const pack = await fetchUsaStructures(frame, fetchFn);
    assert.equal(pack.features.length, 1);
    const already = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    const covered = mergeFootprintFeatures([already], pack.features);
    assert.equal(covered.added, 0);
    const fresh = mergeFootprintFeatures([], pack.features);
    assert.equal(fresh.added, 1);
  });
});
