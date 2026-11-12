"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../netlify/lib/search-cache");

describe("search cache", () => {
  beforeEach(() => {
    cache._setStore(null);
    cache._clear();
  });

  it("returns a stored hit and never stores an empty list", async () => {
    const hits = [{ lat: 46.0, lon: -112.5, display_name: "Butte", source: "photon" }];
    await cache.cacheSet("geocode", "Butte MT", null, hits);
    assert.deepEqual(await cache.cacheGet("geocode", "Butte MT", null), hits);
    await cache.cacheSet("geocode", "nowhere", null, []);
    assert.equal(await cache.cacheGet("geocode", "nowhere", null), null);
    await cache.cacheSet("suggest", "x", null, null);
    assert.equal(await cache.cacheGet("suggest", "x", null), null);
  });

  it("treats the same query with different spacing as one key", () => {
    assert.equal(cache.cacheKey("geocode", "Butte  MT", null), cache.cacheKey("geocode", "butte mt", null));
  });

  it("reads a hit from the shared blob store on a cold instance", async () => {
    const hits = [{ lat: 1, lon: 2, display_name: "Kotka", source: "nominatim" }];
    let stored = null;
    const store = {
      async get(_key, opts) {
        if (!stored) return null;
        return opts && opts.type === "json" ? stored : JSON.stringify(stored);
      },
      async setJSON(_key, data) {
        stored = data;
        return { modified: true };
      },
    };
    cache._setStore(store);
    await cache.cacheSet("geocode", "Kotka Finland", null, hits);
    cache._clear();
    assert.deepEqual(await cache.cacheGet("geocode", "Kotka Finland", null), hits);
  });

  it("does not return an expired blob", async () => {
    const store = {
      async get() {
        return { value: [{ lat: 1, lon: 2, display_name: "old" }], exp: Date.now() - 1000 };
      },
      async setJSON() {
        return { modified: true };
      },
    };
    cache._setStore(store);
    assert.equal(await cache.cacheGet("geocode", "old", null), null);
  });
});
