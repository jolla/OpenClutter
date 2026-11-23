"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const persist = require("../netlify/lib/overture-buildings-cache");
const { RELEASE, fetchOvertureFootprints, isTransientOvertureError, BUILDING_ATTEMPTS } = require("../netlify/lib/overture");

const BOX = { west: -93.179, south: 44.978, east: -93.169, north: 44.987 };
const RING = {
  type: "Feature",
  properties: { height: 8, heightSource: "overture", source: "overture" },
  geometry: {
    type: "Polygon",
    coordinates: [[[-93.174, 44.982], [-93.173, 44.982], [-93.173, 44.983], [-93.174, 44.983], [-93.174, 44.982]]],
  },
};


describe("overture buildings cache and retry", () => {
  let dir = "";

  beforeEach(() => {
    persist.resetForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ovt-bldg-"));
    persist.setBuildingCacheDir(dir);
    persist.setBuildingCacheLimits({ maxBytes: 1024 * 1024, ttlMs: persist.BUILDING_CACHE_TTL_MS });
    delete process.env.OPENCLUTTER_OVERTURE_BUILDINGS_FAIL_ATTEMPTS;
  });

  afterEach(() => {
    persist.resetForTests();
    persist.setBuildingCacheDir(undefined);
    persist.setBuildingCacheLimits(undefined);
    delete process.env.OPENCLUTTER_OVERTURE_BUILDINGS_FAIL_ATTEMPTS;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leftover temp dir is harmless */
    }
  });

  it("matches street retry: two attempts, and treats fetch failed as transient", () => {
    assert.equal(BUILDING_ATTEMPTS, 2);
    assert.equal(isTransientOvertureError(new TypeError("fetch failed")), true);
    assert.equal(isTransientOvertureError(new Error("HTTP 503")), true);
    const gone = new Error("release gone");
    gone.code = "OVERTURE_RELEASE_GONE";
    assert.equal(isTransientOvertureError(gone), false);
  });

  it("saves a successful complete read and returns it later", async () => {
    const wrote = await persist.writeBuildingCache(BOX, {
      features: [RING],
      rowGroups: 1,
      groupsRead: 1,
      release: RELEASE,
    });
    assert.equal(wrote, true);
    const got = await persist.readBuildingCache(BOX, { release: RELEASE });
    assert.ok(got);
    assert.equal(got.features.length, 1);
    assert.equal(got.release, RELEASE);
    assert.match(persist.cacheNote(got), /saved Overture copy dated/);
  });

  it("does not store an empty or partial buildings read", async () => {
    assert.equal(await persist.writeBuildingCache(BOX, { features: [], release: RELEASE }), false);
    assert.equal(
      await persist.writeBuildingCache(BOX, { features: [RING], partial: true, release: RELEASE }),
      false
    );
    assert.equal(await persist.readBuildingCache(BOX, { release: RELEASE }), null);
  });

  it("misses a cache entry keyed to a different release", async () => {
    await persist.writeBuildingCache(BOX, { features: [RING], release: RELEASE });
    assert.equal(await persist.readBuildingCache(BOX, { release: "2026-09-23.1" }), null);
  });

  it("retries a transient fetch failure and keeps the second attempt", async () => {
    const groups = require("../netlify/lib/overture").groupsForBbox(BOX.west, BOX.south, BOX.east, BOX.north);
    assert.ok(groups.length >= 1);
    let calls = 0;
    const reader = {
      compressors: {},
      asyncBufferFromUrl: async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return {};
      },
      parquetReadObjects: async () => [
        {
          height: 6,
          num_floors: null,
          is_underground: false,
          bbox: { xmin: BOX.west, xmax: BOX.east, ymin: BOX.south, ymax: BOX.north },
          geometry: RING.geometry,
        },
      ],
    };
    const pack = await fetchOvertureFootprints(BOX, { reader, diskCache: true, signal: new AbortController().signal });
    assert.equal(calls, 2);
    assert.equal(pack.features.length, groups.length);
    assert.equal(pack.cached, undefined);
    const cached = await persist.readBuildingCache(BOX, { release: RELEASE, diskCache: true });
    assert.ok(cached);
    assert.equal(cached.features.length, groups.length);
  });

  it("does not retry a 404 on the pinned release", async () => {
    let calls = 0;
    const reader = {
      compressors: {},
      asyncBufferFromUrl: async () => {
        calls++;
        throw new Error("fetch head failed 404");
      },
      parquetReadObjects: async () => [],
    };
    await assert.rejects(
      fetchOvertureFootprints(BOX, { reader, diskCache: true, signal: new AbortController().signal }),
      (e) => e.code === "OVERTURE_RELEASE_GONE" && calls === 1
    );
  });

  it("uses a saved copy after two live transient failures, and still warns clearly when there is none", async () => {
    await persist.writeBuildingCache(BOX, { features: [RING], rowGroups: 1, groupsRead: 1, release: RELEASE });
    const reader = {
      compressors: {},
      asyncBufferFromUrl: async () => {
        throw new TypeError("fetch failed");
      },
      parquetReadObjects: async () => [],
    };
    const pack = await fetchOvertureFootprints(BOX, { reader, diskCache: true, signal: new AbortController().signal });
    assert.equal(pack.cached, true);
    assert.equal(pack.features.length, 1);
    assert.match(pack.cacheNote, /live servers did not answer/);

    persist.setBuildingCacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "oc-ovt-bldg-empty-")));
    await assert.rejects(
      fetchOvertureFootprints(BOX, { reader, diskCache: true, signal: new AbortController().signal }),
      (e) => /fetch failed/.test(String(e && e.message))
    );
  });
});
