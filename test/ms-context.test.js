"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  extractLandContext,
  rejectMicrosoftFalsePositives,
  isThinStrip,
  overlapFraction,
  landContextQuery,
  parkingSurfaceQuery,
} = require("../netlify/lib/ms-context");

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

describe("Microsoft land context", () => {
  const W = -79.385;
  const S = 43.646;
  const E = -79.3845;
  const N = 43.6465;

  it("classifies parking, park, platform, and railway land from Overpass elements", () => {
    const ctx = extractLandContext([
      {
        type: "way",
        tags: { amenity: "parking" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }, { lon: E, lat: N }, { lon: W, lat: N }, { lon: W, lat: S }],
      },
      {
        type: "way",
        tags: { leisure: "park" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }, { lon: E, lat: N }, { lon: W, lat: N }, { lon: W, lat: S }],
      },
      {
        type: "way",
        tags: { railway: "platform" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }, { lon: E, lat: N }, { lon: W, lat: N }, { lon: W, lat: S }],
      },
      {
        type: "way",
        tags: { landuse: "railway" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }, { lon: E, lat: N }, { lon: W, lat: N }, { lon: W, lat: S }],
      },
      {
        type: "way",
        tags: { railway: "rail" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }],
      },
      {
        type: "way",
        tags: { amenity: "parking", parking: "multi-storey" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }, { lon: E, lat: N }, { lon: W, lat: N }, { lon: W, lat: S }],
      },
    ]);
    assert.equal(ctx.parking.length, 1);
    assert.equal(ctx.parks.length, 1);
    assert.equal(ctx.platforms.length, 1);
    assert.equal(ctx.railwayLand.length, 1);
    assert.equal(ctx.railwayLines.length, 1);
  });

  it("rejects a Microsoft footprint that sits mostly on a parking lot", () => {
    const parking = [
      [[W, S], [E, S], [E, N], [W, N], [W, S]],
    ];
    const ms = box(W + 0.00005, S + 0.00005, E - 0.00005, N - 0.00005, {
      height: 7.6,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const overture = box(W - 0.001, S - 0.001, W - 0.0005, S - 0.0005, {
      height: 20,
      heightSource: "overture",
      geomSource: "overture",
    });
    const out = rejectMicrosoftFalsePositives([ms, overture], { parking, railwayLand: [], platforms: [], parks: [], plazas: [], railwayLines: [] });
    assert.equal(out.dropped, 1);
    assert.equal(out.features.length, 1);
    assert.equal(out.features[0].properties.geomSource, "overture");
    assert.ok(overlapFraction(ms, parking) >= 0.6);
  });

  it("keeps a Microsoft footprint on parking when lidar supports a structure", () => {
    const parking = [[[W, S], [E, S], [E, N], [W, N], [W, S]]];
    const ms = box(W + 0.00005, S + 0.00005, E - 0.00005, N - 0.00005, {
      height: 7.6,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const out = rejectMicrosoftFalsePositives([ms], { parking, railwayLand: [], platforms: [], parks: [], plazas: [], railwayLines: [] }, {
      lidarHeight: () => 12,
    });
    assert.equal(out.dropped, 0);
    assert.equal(out.features.length, 1);
  });

  it("rejects a Microsoft footprint mostly on a park or plaza", () => {
    const parks = [[[W, S], [E, S], [E, N], [W, N], [W, S]]];
    const ms = box(W + 0.00005, S + 0.00005, E - 0.00005, N - 0.00005, {
      height: 6.9,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const out = rejectMicrosoftFalsePositives([ms], { parking: [], railwayLand: [], platforms: [], parks, plazas: [], railwayLines: [] });
    assert.equal(out.dropped, 1);
    assert.equal(out.reasons[0].reason, "park");
  });

  it("rejects a very elongated thin Microsoft strip and keeps a long warehouse", () => {
    // ~2 m x 40 m strip near 43.65 N.
    const strip = box(W, S, W + 0.000025, S + 0.00036, {
      height: 4.5,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    assert.equal(isThinStrip(strip), true);
    const warehouse = box(W, S, W + 0.00025, S + 0.0008, {
      height: 12,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    assert.equal(isThinStrip(warehouse), false);
    const out = rejectMicrosoftFalsePositives([strip, warehouse], {
      parking: [],
      railwayLand: [],
      platforms: [],
      parks: [],
      plazas: [],
      railwayLines: [],
    });
    assert.equal(out.dropped, 1);
    assert.equal(out.features.length, 1);
    assert.equal(out.features[0].properties.height, 12);
  });

  it("rejects a thin Microsoft strip along a railway even with a tall model height", () => {
    const strip = box(W, S, W + 0.000025, S + 0.00036, {
      height: 123,
      heightSource: "ms-global",
      geomSource: "ms-global",
    });
    const line = [[W, S], [W + 0.00002, S + 0.00036]];
    const out = rejectMicrosoftFalsePositives([strip], {
      parking: [],
      railwayLand: [],
      platforms: [],
      parks: [],
      plazas: [],
      railwayLines: [line],
    });
    assert.equal(out.dropped, 1);
  });

  it("does not treat a multi-storey parking garage as a surface lot", () => {
    const ctx = extractLandContext([
      {
        type: "way",
        tags: { amenity: "parking", parking: "multi-storey" },
        geometry: [{ lon: W, lat: S }, { lon: E, lat: S }, { lon: E, lat: N }, { lon: W, lat: N }, { lon: W, lat: S }],
      },
    ]);
    assert.equal(ctx.parking.length, 0);
  });

  it("includes the land-context clauses in the street-map and detail queries", () => {
    const box = "43, -79, 44, -78";
    const clause = landContextQuery(box);
    const parking = parkingSurfaceQuery(box);
    const tiles = fs.readFileSync(path.join(__dirname, "../netlify/lib/osm-tiles.js"), "utf8");
    const detail = fs.readFileSync(path.join(__dirname, "../netlify/lib/building-shape.js"), "utf8");
    assert.match(clause, /landuse"="railway/);
    assert.match(clause, /railway"="platform/);
    assert.match(clause, /leisure"~/);
    assert.ok(tiles.includes("landContextQuery(box)"));
    assert.ok(detail.includes("landContextQuery(box)"));
    assert.ok(detail.includes("parkingSurfaceQuery(box)"));
    assert.match(parking, /amenity"="parking/);
  });
});
