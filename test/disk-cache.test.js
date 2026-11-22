"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createDiskCache } = require("../netlify/lib/disk-cache");

describe("disk cache prune", { concurrency: 1 }, () => {
  it("evicts large files before tiny ones when protectUnderBytes is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-disk-protect-"));
    const cache = createDiskCache({
      envPrefix: "OPENCLUTTER_TEST_CACHE",
      maxBytes: 5 * 1024 * 1024,
      ttlMs: 60 * 1000,
      subdir: "test-protect",
      protectUnderBytes: 1024 * 1024,
    });
    cache.setDir(dir);
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const small = Buffer.from('{"features":[1]}');
    try {
      await cache.write("tile-a", big);
      await cache.write("parsed-a", small);
      await cache.write("tile-b", big);
      await cache.write("parsed-b", small);
      // 4 MB of tiles plus two tiny parsed files is under the 5 MB cap.
      await cache.write("tile-c", big);
      // 6 MB of tiles exceeds the cap: evict the oldest large tile, keep both parsed files.
      await cache.schedulePrune();
      const a = await cache.read("tile-a");
      const b = await cache.read("tile-b");
      const c = await cache.read("tile-c");
      const pa = await cache.read("parsed-a");
      const pb = await cache.read("parsed-b");
      assert.equal(a, null);
      assert.ok(b && b.length === big.length);
      assert.ok(c && c.length === big.length);
      assert.deepEqual(pa, small);
      assert.deepEqual(pb, small);
    } finally {
      cache.setDir(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still evicts oldest first when protectUnderBytes is off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-disk-lru-"));
    const cache = createDiskCache({
      envPrefix: "OPENCLUTTER_TEST_CACHE",
      maxBytes: 5 * 1024 * 1024,
      ttlMs: 60 * 1000,
      subdir: "test-lru",
    });
    cache.setDir(dir);
    const big = Buffer.alloc(2 * 1024 * 1024, 8);
    const small = Buffer.from("tiny");
    try {
      await cache.write("old-small", small);
      await cache.write("tile-a", big);
      await cache.write("tile-b", big);
      await cache.write("tile-c", big);
      await cache.schedulePrune();
      // LRU evicts the oldest file, which is the tiny one, then tile-a if still over.
      const smallHit = await cache.read("old-small");
      const a = await cache.read("tile-a");
      const b = await cache.read("tile-b");
      const c = await cache.read("tile-c");
      assert.equal(smallHit, null);
      assert.equal(a, null);
      assert.ok(b && b.length === big.length);
      assert.ok(c && c.length === big.length);
    } finally {
      cache.setDir(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
