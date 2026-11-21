"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const streetPersist = require("../netlify/lib/overture-street-cache");

const BOX = { west: -90.5276, south: 41.5786, east: -90.523, north: 41.5823 };
const WAY = { type: "way", id: "ov-1", tags: { leisure: "marina" }, geometry: [{ lon: -90.525, lat: 41.58 }] };

describe("overture street cache", () => {
  let dir = "";
  let prevDir;

  beforeEach(() => {
    streetPersist.resetForTests();
    prevDir = process.env.OPENCLUTTER_OVERPASS_CACHE_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ovt-street-"));
    process.env.OPENCLUTTER_OVERPASS_CACHE_DIR = dir;
  });

  afterEach(() => {
    streetPersist.resetForTests();
    if (prevDir == null) delete process.env.OPENCLUTTER_OVERPASS_CACHE_DIR;
    else process.env.OPENCLUTTER_OVERPASS_CACHE_DIR = prevDir;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leftover temp dir is harmless */
    }
  });

  it("saves a successful street read on disk and returns it later", async () => {
    const wrote = await streetPersist.writeStreetCache(BOX, {
      elements: [WAY],
      themes: { land_use: 1 },
      release: "2026-10-21.0",
    });
    assert.equal(wrote, true);
    const got = await streetPersist.readStreetCache(BOX, { release: "2026-10-21.0" });
    assert.ok(got);
    assert.equal(got.elements[0].id, "ov-1");
    assert.equal(got.elements[0].tags.leisure, "marina");
    assert.equal(got.release, "2026-10-21.0");
    assert.match(streetPersist.cacheNote(got), /saved Overture copy dated/);
  });

  it("does not store an empty street read", async () => {
    const wrote = await streetPersist.writeStreetCache(BOX, { elements: [], themes: {}, release: "2026-10-21.0" });
    assert.equal(wrote, false);
    const got = await streetPersist.readStreetCache(BOX, { release: "2026-10-21.0" });
    assert.equal(got, null);
  });
});
