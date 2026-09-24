"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  groupsForBbox,
  orderGroups,
  bboxRowFilter,
  featureFromRow,
  featuresFromRows,
  fetchOvertureFootprints,
  RELEASE,
} = require("../netlify/lib/overture");

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

  it("reads the Las Vegas Sphere row group before the southern neighbor", () => {
    const lat = 36.1206;
    const lon = -115.1614;
    const dLon = 450 / (111320 * Math.cos((lat * Math.PI) / 180));
    const dLat = 450 / 110540;
    const bbox = { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
    const groups = groupsForBbox(bbox.west, bbox.south, bbox.east, bbox.north);
    assert.ok(groups.length >= 2, "expected the Sphere group and its southern neighbor");
    const center = groups[0];
    assert.ok(center.ymin <= lat && center.ymax >= lat, "first group must contain the Sphere");
    assert.ok(center.xmin <= lon && center.xmax >= lon);
    const south = groups.find((g) => g.ymax < lat);
    assert.ok(south, "southern neighbor group missing");
    assert.ok(center.rowStart > south.rowStart, "center group is the later row range; do not sort by rowStart");
    const reversed = orderGroups([south, center], bbox);
    assert.equal(reversed[0].rowStart, center.rowStart);
  });

  it("keeps a Sphere-height ring when the southern row group aborts", async () => {
    const fs = require("fs");
    const path = require("path");
    const lat = 36.1206;
    const lon = -115.1614;
    const dLon = 450 / (111320 * Math.cos((lat * Math.PI) / 180));
    const dLat = 450 / 110540;
    const frame = { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
    const sphere = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/sphere-overture.geojson"), "utf8"));
    const groups = groupsForBbox(frame.west, frame.south, frame.east, frame.north);
    const calls = [];
    const reader = {
      compressors: {},
      asyncBufferFromUrl: async () => ({}),
      parquetReadObjects: async (opts) => {
        calls.push(opts.rowStart);
        assert.equal(opts.usePageIndex, true);
        assert.ok(opts.filter && opts.filter.$and);
        if (opts.rowStart !== groups[0].rowStart) {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
        }
        return [
          {
            height: sphere.properties.height,
            num_floors: null,
            is_underground: false,
            bbox: { xmin: frame.west, xmax: frame.east, ymin: frame.south, ymax: frame.north },
            geometry: sphere.geometry,
          },
        ];
      },
    };
    const pack = await fetchOvertureFootprints(frame, { reader, signal: new AbortController().signal });
    assert.equal(calls[0], groups[0].rowStart);
    assert.equal(pack.partial, true);
    assert.equal(pack.features.length, 1);
    assert.equal(pack.features[0].properties.height, 112);
    assert.equal(pack.features[0].properties.heightSource, "overture");
    assert.ok(pack.features[0].geometry.coordinates[0].length >= 30);
  });

  it("bbox page filter overlaps the query on every side", () => {
    const filter = bboxRowFilter({ west: -115.17, south: 36.11, east: -115.15, north: 36.13 });
    const keys = filter.$and.map((clause) => Object.keys(clause)[0]);
    assert.deepEqual(keys, ["bbox.xmax", "bbox.xmin", "bbox.ymax", "bbox.ymin"]);
    assert.equal(filter.$and[0]["bbox.xmax"].$gte, -115.17);
    assert.equal(filter.$and[2]["bbox.ymax"].$gte, 36.11);
  });
});
