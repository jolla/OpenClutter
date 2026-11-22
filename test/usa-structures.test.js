"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { esriFeaturesToGeojson, fetchUsaStructures, setUsaCacheDir, setUsaCacheLimits, usaEmptyWarning, intersectsUsaStructures, USA_CACHE_MAX_BYTES, USA_CACHE_TTL_MS } = require("../netlify/lib/usa-structures");
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

  it("retries a failed id query and then returns geometry", async () => {
    const frame = { west: -87.93, south: 42.89, east: -87.91, north: 42.91 };
    const ring = [
      [-87.9205, 42.9005],
      [-87.9202, 42.9005],
      [-87.9202, 42.9009],
      [-87.9205, 42.9009],
      [-87.9205, 42.9005],
    ];
    let ids = 0;
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("returnIdsOnly")) {
        ids++;
        if (ids === 1) return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, json: async () => ({ objectIds: [7] }) };
      }
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { HEIGHT: 8 }, geometry: { rings: [ring] } }],
        }),
      };
    };
    const pack = await fetchUsaStructures(frame, fetchFn, { retryWaitMs: 0 });
    assert.equal(ids, 2);
    assert.equal(pack.features.length, 1);
    assert.equal(pack.failed, false);
  });

  it("retries a hanging id query after a short attempt timeout", async () => {
    const frame = { west: -87.93, south: 42.89, east: -87.91, north: 42.91 };
    const ring = [
      [-87.9205, 42.9005],
      [-87.9202, 42.9005],
      [-87.9202, 42.9009],
      [-87.9205, 42.9009],
      [-87.9205, 42.9005],
    ];
    let ids = 0;
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("returnIdsOnly")) {
        ids++;
        if (ids === 1) {
          return new Promise(() => {});
        }
        return { ok: true, json: async () => ({ objectIds: [7] }) };
      }
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { HEIGHT: 8 }, geometry: { rings: [ring] } }],
        }),
      };
    };
    const pack = await fetchUsaStructures(frame, fetchFn, { attemptMs: 40, retryWaitMs: 0 });
    assert.equal(ids, 2);
    assert.equal(pack.features.length, 1);
  });

  it("reuses a cached USA pack so a later failure does not go empty", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-usa-cache-"));
    setUsaCacheDir(dir);
    setUsaCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    assert.equal(USA_CACHE_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(USA_CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    const frame = { west: -87.93, south: 42.89, east: -87.91, north: 42.91 };
    const ring = [
      [-87.9205, 42.9005],
      [-87.9202, 42.9005],
      [-87.9202, 42.9009],
      [-87.9205, 42.9009],
      [-87.9205, 42.9005],
    ];
    let calls = 0;
    const fetchFn = async (url) => {
      calls++;
      const u = String(url);
      if (calls > 2) throw new Error("network down");
      if (u.includes("returnIdsOnly")) return { ok: true, json: async () => ({ objectIds: [7] }) };
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { HEIGHT: 8 }, geometry: { rings: [ring] } }],
        }),
      };
    };
    try {
      const first = await fetchUsaStructures(frame, fetchFn, { diskCache: true, retryWaitMs: 0 });
      const second = await fetchUsaStructures(frame, fetchFn, { diskCache: true, retryWaitMs: 0 });
      assert.equal(first.features.length, 1);
      assert.equal(second.features.length, 1);
      assert.equal(second.cached, true);
      assert.ok(calls <= 2);
    } finally {
      setUsaCacheDir(undefined);
      setUsaCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not cache a failed empty read", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-usa-empty-"));
    setUsaCacheDir(dir);
    setUsaCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    const frame = { west: -87.93, south: 42.89, east: -87.91, north: 42.91 };
    const ring = [
      [-87.9205, 42.9005],
      [-87.9202, 42.9005],
      [-87.9202, 42.9009],
      [-87.9205, 42.9009],
      [-87.9205, 42.9005],
    ];
    let calls = 0;
    const fetchFn = async (url) => {
      calls++;
      const u = String(url);
      if (calls <= 3) return { ok: false, status: 502, json: async () => ({}) };
      if (u.includes("returnIdsOnly")) return { ok: true, json: async () => ({ objectIds: [7] }) };
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { HEIGHT: 8 }, geometry: { rings: [ring] } }],
        }),
      };
    };
    try {
      const first = await fetchUsaStructures(frame, fetchFn, { diskCache: true, retries: 2, retryWaitMs: 0 });
      assert.equal(first.features.length, 0);
      assert.equal(first.failed, true);
      const second = await fetchUsaStructures(frame, fetchFn, { diskCache: true, retries: 0, retryWaitMs: 0 });
      assert.equal(second.features.length, 1);
    } finally {
      setUsaCacheDir(undefined);
      setUsaCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when a US draw ends up with no USA footprints", () => {
    const fw = { west: -81.6, south: 28.3, east: -81.5, north: 28.4 };
    assert.equal(intersectsUsaStructures(fw), true);
    assert.equal(intersectsUsaStructures({ west: 24, south: 60, east: 25, north: 61 }), false);
    const note = usaEmptyWarning(
      { features: [], failed: true, emptyReason: "timeout" },
      { frame: fw, otherFootprints: 157 }
    );
    assert.match(note, /USA Structures omitted/);
    assert.match(note, /Microsoft and OpenStreetMap/);
    assert.equal(
      usaEmptyWarning({ features: [{ type: "Feature" }] }, { frame: fw, otherFootprints: 157 }),
      ""
    );
    assert.equal(
      usaEmptyWarning({ features: [], failed: false, emptyReason: "none" }, { frame: { west: 24, south: 60, east: 25, north: 61 }, otherFootprints: 10 }),
      ""
    );
  });

  it("skips southern Canada and other non-US draws without an omitted warning", async () => {
    const toronto = { west: -79.388, south: 43.643, east: -79.373, north: 43.652 };
    const montreal = { west: -73.58, south: 45.49, east: -73.55, north: 45.51 };
    const vancouver = { west: -123.14, south: 49.27, east: -123.10, north: 49.29 };
    const windsor = { west: -83.05, south: 42.30, east: -83.02, north: 42.32 };
    const tijuana = { west: -117.05, south: 32.50, east: -117.02, north: 32.53 };
    const london = { west: -0.100, south: 51.508, east: -0.085, north: 51.517 };
    for (const frame of [toronto, montreal, vancouver, windsor, tijuana, london]) {
      assert.equal(intersectsUsaStructures(frame), false);
      assert.equal(usaEmptyWarning({ features: [], failed: true, emptyReason: "none" }, { frame, otherFootprints: 100 }), "");
    }
    let calls = 0;
    const pack = await fetchUsaStructures(toronto, async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    });
    assert.equal(calls, 0);
    assert.equal(pack.emptyReason, "out-of-coverage");
    assert.equal(pack.features.length, 0);
    assert.equal(usaEmptyWarning(pack, { frame: toronto, otherFootprints: 100 }), "");
  });

  it("still treats a US city as in coverage and prefers a geocoded country", () => {
    const detroit = { west: -83.06, south: 42.32, east: -83.03, north: 42.34 };
    const florida = { west: -81.6, south: 28.3, east: -81.5, north: 28.4 };
    const toronto = { west: -79.388, south: 43.643, east: -79.373, north: 43.652 };
    assert.equal(intersectsUsaStructures(detroit), true);
    assert.equal(intersectsUsaStructures(florida), true);
    assert.equal(intersectsUsaStructures(toronto, { country: "US" }), true);
    assert.equal(intersectsUsaStructures(detroit, { country: "CA" }), false);
    assert.equal(intersectsUsaStructures(toronto, { country: "GB" }), false);
    const note = usaEmptyWarning(
      { features: [], failed: true, emptyReason: "timeout" },
      { frame: florida, otherFootprints: 10 }
    );
    assert.match(note, /USA Structures omitted/);
    assert.equal(
      usaEmptyWarning({ features: [], failed: true, emptyReason: "timeout" }, { frame: toronto, country: "CA", otherFootprints: 10 }),
      ""
    );
  });
});
