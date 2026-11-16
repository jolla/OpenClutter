"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { forestFromElements, ringAreaM2, fetchSlopeForest } = require("../netlify/lib/slope-forest");

const bbox = { west: -89.692, south: 44.921, east: -89.668, north: 44.939 };

function way(tags, ring) {
  return {
    type: "way",
    tags,
    geometry: ring.map((p) => ({ lon: p[0], lat: p[1] })),
  };
}

describe("slope forest masks", () => {
  it("keeps woods, opens downhill runs, and does not mask the resort lease", () => {
    const wood = [
      [-89.69, 44.925],
      [-89.675, 44.925],
      [-89.675, 44.936],
      [-89.69, 44.936],
      [-89.69, 44.925],
    ];
    const run = [
      [-89.684, 44.928],
      [-89.681, 44.928],
      [-89.681, 44.934],
      [-89.684, 44.934],
      [-89.684, 44.928],
    ];
    const lease = [
      [bbox.west, bbox.south],
      [bbox.east, bbox.south],
      [bbox.east, bbox.north],
      [bbox.west, bbox.north],
      [bbox.west, bbox.south],
    ];
    const line = [
      [-89.688, 44.926],
      [-89.686, 44.93],
      [-89.684, 44.933],
    ];
    const parsed = forestFromElements(
      {
        elements: [
          way({ natural: "wood" }, wood),
          way({ "piste:type": "downhill" }, run),
          way({ landuse: "winter_sports" }, lease),
          way({ "piste:type": "downhill" }, line),
          way({ landuse: "forest" }, [
            [-89.67, 44.922],
            [-89.6697, 44.922],
            [-89.6697, 44.9222],
            [-89.67, 44.9222],
            [-89.67, 44.922],
          ]),
        ],
      },
      bbox
    );
    assert.equal(parsed.wood.length, 2);
    assert.ok(parsed.wood[0].areaM2 > 100000, "wood area " + parsed.wood[0].areaM2);
    assert.equal(parsed.wood[0].heightM, 12);
    assert.equal(parsed.pistes.length, 2);
    assert.ok(ringAreaM2(parsed.pistes[0]) > 1000);
    assert.ok(parsed.notes.some((n) => n.indexOf("winter-sports lease") >= 0));
    assert.equal(JSON.stringify(parsed).includes("\u2014"), false);
  });
});

describe("slope forest fetch", () => {
  it("gives a background export 45 seconds so it can wait for the Overture street-map read", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /fetchSlopeForest\([^)]*timeoutMs: background \? 45000/);
  });

  it("uses the Overpass forest query when the street-map read does not finish in time", async () => {
    let overpass = 0;
    const got = await fetchSlopeForest(bbox, {
      timeoutMs: 40,
      fetchStreetMaps: async (_b, o) => {
        await new Promise((_, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (o.signal && o.signal.aborted) fail();
          else if (o.signal) o.signal.addEventListener("abort", fail, { once: true });
        });
      },
      fetchOverpassForest: async () => {
        overpass += 1;
        return { ok: true, wood: [{ areaM2: 100 }], pistes: [], notes: [] };
      },
    });
    assert.equal(overpass, 1);
    assert.equal(got.wood.length, 1);
  });
});
