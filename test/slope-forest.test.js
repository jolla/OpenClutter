"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { forestFromElements, ringAreaM2, fetchSlopeForest, forestEmptyWarning, setForestCacheDir, setForestCacheLimits, FOREST_CACHE_MAX_BYTES, FOREST_CACHE_TTL_MS } = require("../netlify/lib/slope-forest");

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

  it("retries a failed Overpass forest read once", async () => {
    let n = 0;
    const got = await fetchSlopeForest(bbox, {
      overture: false,
      fetchOverpassForest: async () => {
        n += 1;
        if (n === 1) return { ok: false, wood: [], pistes: [], notes: [] };
        return { ok: true, wood: [{ areaM2: 100 }], pistes: [], notes: [] };
      },
    });
    assert.equal(n, 2);
    assert.equal(got.ok, true);
    assert.equal(got.wood.length, 1);
  });

  it("does not start a second Overpass forest read when the first already used the budget", async () => {
    let n = 0;
    const got = await fetchSlopeForest(bbox, {
      overture: false,
      timeoutMs: 40,
      fetchOverpassForest: async (_b, _q, _o, ms) => {
        n += 1;
        await new Promise((resolve) => setTimeout(resolve, ms + 5));
        return { ok: false, wood: [], pistes: [], notes: [] };
      },
    });
    assert.equal(n, 1);
    assert.equal(got.ok, false);
  });

  it("reuses a cached forest pack so a later failure does not go empty", async () => {
    const os = require("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-forest-cache-"));
    setForestCacheDir(dir);
    setForestCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    assert.equal(FOREST_CACHE_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(FOREST_CACHE_TTL_MS, 14 * 24 * 60 * 60 * 1000);
    let n = 0;
    const fetchOverpassForest = async () => {
      n += 1;
      if (n > 1) throw new Error("cache should hit");
      return { ok: true, wood: [{ areaM2: 100 }], pistes: [[0, 1]], notes: [] };
    };
    try {
      const first = await fetchSlopeForest(bbox, { overture: false, diskCache: true, fetchOverpassForest });
      const second = await fetchSlopeForest(bbox, { overture: false, diskCache: true, fetchOverpassForest });
      assert.equal(first.wood.length, 1);
      assert.equal(second.wood.length, 1);
      assert.equal(second.cached, true);
      assert.equal(n, 1);
    } finally {
      setForestCacheDir(undefined);
      setForestCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when the forest read fails and stays quiet when woods were returned", () => {
    assert.match(forestEmptyWarning({ ok: false }), /Forest outlines omitted/);
    assert.equal(forestEmptyWarning({ ok: true, wood: [{ areaM2: 100 }], pistes: [] }), "");
  });
});
