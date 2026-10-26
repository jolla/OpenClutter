"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { contextBox, contextRoads, readParkContext, CTX_MAX_M } = require("../netlify/lib/park-context");
const { fillPads } = require("../netlify/lib/rv-pads");
const { parkContextWanted, isParkContext } = require("../netlify/lib/export-mode");

// A 150 m draw in the south-west corner of a 600 x 450 m park.
const draw = { west: -114.5776, south: 35.1131, east: -114.57595, north: 35.11445 };
const park = [
  [-114.5778, 35.1129],
  [-114.5713, 35.1129],
  [-114.5713, 35.1172],
  [-114.5778, 35.1172],
  [-114.5778, 35.1129],
];
const zone = { kind: "camp-zone", coords: park, closed: true };

describe("park context for worst-case pads", () => {
  it("reads past the draw only when a mapped park runs past it", () => {
    assert.equal(contextBox([], draw), null);
    const inside = {
      kind: "camp-zone",
      coords: [
        [-114.5775, 35.1132],
        [-114.5761, 35.1132],
        [-114.5761, 35.1143],
        [-114.5775, 35.1143],
        [-114.5775, 35.1132],
      ],
    };
    assert.equal(contextBox([inside], draw), null);
    assert.equal(contextBox([Object.assign({}, zone, { tentOnly: true })], draw), null);
    const box = contextBox([zone], draw);
    assert.ok(box.east > draw.east && box.north > draw.north);
    assert.ok(box.west <= draw.west && box.south <= draw.south);
  });

  it("holds the read to the size cap around the draw", () => {
    const huge = {
      kind: "camp-zone",
      coords: [
        [-114.7, 35.0],
        [-114.4, 35.0],
        [-114.4, 35.3],
        [-114.7, 35.3],
        [-114.7, 35.0],
      ],
    };
    const box = contextBox([huge], draw);
    const lat = (box.south + box.north) / 2;
    const w = (box.east - box.west) * 111320 * Math.cos((lat * Math.PI) / 180);
    const h = (box.north - box.south) * 110540;
    assert.ok(w <= CTX_MAX_M + 1 && h <= CTX_MAX_M + 1, w + " x " + h);
  });

  it("adds only the park roads the draw did not read", () => {
    const a = { kind: "camp-road", coords: [[-114.577, 35.1135], [-114.574, 35.1135]] };
    const b = { kind: "camp-road", coords: [[-114.574, 35.116], [-114.572, 35.116]] };
    const got = contextRoads([a], [a, b, b]);
    assert.equal(got.length, 1);
    assert.equal(got[0].parkContext, true);
    assert.deepEqual(got[0].coords, b.coords);
  });

  it("never fetches a photo when nothing runs past the draw, and keeps roads when the photo misses", async () => {
    let asked = 0;
    const none = await readParkContext({ features: [], frame: draw, fetchPlate: async () => (asked++, null) });
    assert.equal(none.features.length, 0);
    assert.equal(asked, 0);
    const road = { kind: "camp-road", coords: [[-114.574, 35.116], [-114.572, 35.116]] };
    const cand = {
      kind: "rv",
      pitchUse: "road",
      coords: [[-114.573, 35.1162], [-114.5729, 35.1162], [-114.5729, 35.1163], [-114.573, 35.1163], [-114.573, 35.1162]],
      pad: [[-114.573, 35.1162], [-114.5729, 35.1162], [-114.5729, 35.1163], [-114.573, 35.1163], [-114.573, 35.1162]],
    };
    const frame = Object.assign({ imgW: 600, imgH: 600, mpuX: 0.25, mpuY: 0.25 }, draw);
    const miss = await readParkContext({
      features: [zone],
      ctxFeatures: [zone, road, cand],
      frame,
      fetchPlate: async () => {
        throw new Error("timeout");
      },
    });
    assert.equal(miss.roads, 1);
    assert.equal(miss.rvs, 0);
    assert.equal(miss.photoMiss, "timeout");
    assert.ok(miss.features.every((f) => f.kind === "camp-road"));
  });

  it("lets RVs past the draw set the pad pattern inside it", () => {
    // 1 px = 1 m. The draw is the west 60 m of a road; the park goes on east.
    const frame = { imgW: 60, imgH: 120, mpuX: 1, mpuY: 1 };
    const data = new Uint8ClampedArray(60 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 150;
      data[i + 1] = 148;
      data[i + 2] = 140;
      data[i + 3] = 255;
    }
    const plate = { width: 60, height: 120, data };
    const zoneM = [[0, 0], [400, 0], [400, 120], [0, 120], [0, 0]];
    const road = [[5, 60], [395, 60]];
    const rv = (x) => [[x - 1.5, 64], [x + 1.5, 64], [x + 1.5, 74], [x - 1.5, 74], [x - 1.5, 64]];
    const seen = [12, 44].map(rv);
    const past = [100, 108, 116, 124, 140, 148].map(rv);
    const alone = fillPads({ frame, zones: [zoneM], roads: [road], evidence: seen, obstacles: [], plate });
    assert.equal(alone.added, 0);
    const withPark = fillPads({ frame, zones: [zoneM], roads: [road], evidence: seen, obstacles: [], plate, context: { evidence: past, roads: [] } });
    assert.ok(withPark.added >= 2, "added " + withPark.added);
    for (const r of withPark.rings) {
      const cx = r.reduce((a, p) => a + p[0], 0) / r.length;
      assert.ok(cx > 0 && cx < 60, "pad centre inside the draw");
    }
    // Pads at the park's 8 m spacing between the two RVs the draw sees.
    assert.ok(withPark.rings.some((r) => r[0][1] > 60 && r[0][0] > 14 && r[0][0] < 42));
    // A draw with enough RVs of its own keeps its own pattern.
    const many = [12, 20, 28, 36, 44, 52].map(rv);
    const own = fillPads({ frame, zones: [zoneM], roads: [road], evidence: many, obstacles: [], plate });
    const ctx = fillPads({ frame, zones: [zoneM], roads: [road], evidence: many, obstacles: [], plate, context: { evidence: [100, 113, 126].map(rv), roads: [[[5, 30], [395, 30]]] } });
    assert.deepEqual(ctx.rings, own.rings);
  });

  it("is on for every host unless the request opts out (1.2.41)", () => {
    assert.equal(isParkContext(), false);
    assert.equal(parkContextWanted(true, {}), true);
    assert.equal(parkContextWanted(true, { parkContext: false }), false);
    assert.equal(parkContextWanted(false, {}), true);
    assert.equal(parkContextWanted(false, { parkContext: true }), true);
    assert.equal(parkContextWanted(false, { parkContext: false }), false);
  });
});
