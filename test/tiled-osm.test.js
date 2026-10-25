"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const overpass = require("../netlify/lib/overpass");
const exportMode = require("../netlify/lib/export-mode");
const { fetchTiledOverpassShared, splitTile, planTiles, TILED_BUDGET_MS, TILED_CONCURRENCY, TILED_SLOW_FAIL_MS } = require("../netlify/lib/osm-tiles");

const JSON_OK = '{"version":0.6,"elements":[{"type":"node","id":1,"lat":1,"lon":2}]}';
const CUT = '{"version":0.6,"elements":[{"type":"node","id":1,"lat":1,"lon":2},{"type":"no';
const FW_WIDE = { west: -81.57, south: 28.3935, east: -81.546, north: 28.4135 };

function res(status, text) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
}
function hang(init) {
  return new Promise((_, reject) => {
    const sig = init && init.signal;
    if (sig) sig.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
}
function later(ms, value) {
  return new Promise((r) => setTimeout(() => r(value), ms));
}
function refused() {
  const e = new TypeError("fetch failed");
  e.cause = { code: "ECONNREFUSED" };
  return Promise.reject(e);
}
function hostOf(url) {
  return new URL(url).host;
}

function setup(routes) {
  const lines = [];
  const calls = [];
  overpass.resetForTests({
    fetch: (url, init) => {
      const h = hostOf(url);
      calls.push(h);
      return routes(h, init, calls);
    },
    log: (l) => lines.push(l),
  });
  return { lines, calls };
}

function read(opts) {
  return overpass.request(Object.assign({ kind: "interpreter", query: "[out:json];node(1,2,3,4);out;" + Math.random() }, opts));
}

// The client's timers are unref'd (a real export keeps the process alive);
// this keeps the test's event loop open while a read waits on them.
let keepAlive = null;
beforeEach(() => {
  keepAlive = setInterval(() => {}, 20);
});
afterEach(() => {
  clearInterval(keepAlive);
  overpass.resetForTests();
  exportMode.setTiledOsm(false);
});

describe("1.2.31 slow-fail chain for tile reads", () => {
  it("moves on from hanging servers to the last resort", async () => {
    const t = setup((h, init) => {
      if (h === "overpass-api.de" || h === "overpass.private.coffee") return hang(init);
      if (h === "maps.mail.ru") return Promise.resolve(res(504, "<html>504 Gateway Time-out</html>"));
      return Promise.resolve(res(200, JSON_OK));
    });
    const t0 = Date.now();
    const got = await read({ deadlineMs: 3000, slowFailMs: 40 });
    assert.equal(got.ok, true);
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(t.calls.slice(0, 2), ["overpass-api.de", "overpass.private.coffee"]);
    assert.equal(t.calls.includes("overpass.openstreetmap.fr"), true);
    assert.ok(t.lines.some((l) => /overpass-api\.de interpreter status=slow/.test(l)));
  });

  it("skips a refused server at once and still reaches an answer", async () => {
    const t = setup((h, init) => {
      if (h === "overpass-api.de") return refused();
      if (h === "overpass.private.coffee" || h === "maps.mail.ru") return hang(init);
      return Promise.resolve(res(200, JSON_OK));
    });
    const got = await read({ deadlineMs: 3000, slowFailMs: 40 });
    assert.equal(got.ok, true);
    assert.equal(t.calls[0], "overpass-api.de");
    assert.equal(t.calls[1], "overpass.private.coffee");
    assert.ok(t.lines.some((l) => /status=refused/.test(l)));
  });

  it("rejects a cut-off last-resort body and keeps the slow server's whole answer", async () => {
    const t = setup((h, init) => {
      if (h === "overpass-api.de") return later(250, res(200, JSON_OK));
      if (h === "overpass.private.coffee") return hang(init);
      if (h === "maps.mail.ru") return Promise.resolve(res(504, "x"));
      return Promise.resolve(res(200, CUT));
    });
    const got = await read({ deadlineMs: 3000, slowFailMs: 40 });
    assert.equal(got.ok, true);
    assert.equal(got.text, JSON_OK);
    assert.ok(t.calls.includes("overpass.openstreetmap.fr"));
    assert.ok(t.lines.some((l) => /openstreetmap\.fr interpreter status=200-nobody/.test(l)));
  });

  it("ends on a 400 and gives up at the deadline when every server hangs", async () => {
    setup(() => Promise.resolve(res(400, "bad query")));
    const bad = await read({ deadlineMs: 3000, slowFailMs: 40 });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    setup((h, init) => hang(init));
    const t0 = Date.now();
    const none = await read({ deadlineMs: 300, slowFailMs: 40 });
    assert.equal(none.ok, false);
    assert.ok(Date.now() - t0 < 1500);
  });
});

describe("1.2.31 tiled street-map read", () => {
  it("plans four tiles for the widened Fort Wilderness draw with the shipped limits", () => {
    assert.equal(planTiles(FW_WIDE).length, 4);
    assert.equal(TILED_BUDGET_MS, 105000);
    assert.equal(TILED_CONCURRENCY, 2);
    assert.equal(TILED_SLOW_FAIL_MS, 20000);
    const q = splitTile(planTiles(FW_WIDE)[0]);
    assert.equal(q.length, 4);
  });

  it("keeps two tiles in flight, retries a missed tile, then splits one that misses twice", async () => {
    const seen = new Map();
    let inFlight = 0;
    let peak = 0;
    const tiles = planTiles(FW_WIDE);
    const keyOf = (t) => [t.west, t.south, t.east, t.north].map((v) => v.toFixed(6)).join(",");
    const flaky = keyOf(tiles[1]);
    const stubborn = keyOf(tiles[2]);
    const got = await fetchTiledOverpassShared(FW_WIDE, {
      budgetMs: 5000,
      minLeftMs: 0,
      readTile: async (tile) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await later(5);
        inFlight--;
        const k = keyOf(tile);
        const n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        if (k === flaky && n === 1) return null;
        if (k === stubborn) return null;
        return [{ type: "way", id: Math.round(tile.west * 1e6) + Math.round(tile.south * 1e6) }];
      },
    });
    assert.equal(peak, 2);
    assert.deepEqual(got.osmTiles, { total: 4, missing: 0, retried: 2, split: 1, splitMissing: 0 });
    assert.equal(got.incomplete, false);
    assert.deepEqual(got.notes, []);
    assert.equal(got.elements.length, 3 + 4);
  });

  it("names what is missing in plain words when a tile never loads", async () => {
    const tiles = planTiles(FW_WIDE);
    const got = await fetchTiledOverpassShared(FW_WIDE, {
      budgetMs: 5000,
      minLeftMs: 0,
      readTile: async (tile) => (tile.west === tiles[0].west && tile.south === tiles[0].south ? null : tile.west < tiles[0].east && tile.south < tiles[0].north ? null : [{ type: "way", id: Math.round(tile.east * 1e6 + tile.north * 1e3) }]),
    });
    assert.equal(got.osmTiles.missing, 1);
    assert.equal(got.incomplete, true);
    assert.deepEqual(got.notes, ["Street map: 1 of 4 map tiles did not load, so RVs, parking, walls, light poles, water and bridges are missing in that part of the draw."]);
    assert.equal(/\u2014/.test(got.notes[0]), false);
  });

  it("stops starting passes when the shared window is spent", async () => {
    let clock = 0;
    let reads = 0;
    const got = await fetchTiledOverpassShared(FW_WIDE, {
      budgetMs: 105000,
      now: () => clock,
      readTile: async () => {
        reads++;
        clock += 60000;
        return null;
      },
    });
    assert.ok(reads <= 3);
    assert.equal(got.osmTiles.missing, 4);
    assert.equal(got.osmTiles.retried, 0);
  });

  it("is on for every host, off by default, with the tile stat on dev hosts only", () => {
    assert.equal(exportMode.isTiledOsm(), false);
    assert.equal(exportMode.tiledOsmWanted(false), true);
    assert.equal(exportMode.tiledOsmWanted(true), true);
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /exportMode\.setTiledOsm\(exportMode\.tiledOsmWanted\(testHost\)\);/);
    assert.match(src, /pack\.osmTiles && exportMode\.isTiledOsm\(\) && testHost\)/);
  });
});
