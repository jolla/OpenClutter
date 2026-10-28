"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const U = require("../public/url-state");

describe("url state: parse", () => {
  it("reads map and box from the hash", () => {
    const got = U.parse("#map=17/36.12800/-115.16000&box=36.127100,-115.161900,36.129300,-115.158400");
    assert.deepEqual(got.view, { zoom: 17, lat: 36.128, lon: -115.16 });
    assert.deepEqual(got.box, { south: 36.1271, west: -115.1619, north: 36.1293, east: -115.1584 });
  });

  it("returns nulls for an empty or unrelated hash", () => {
    assert.deepEqual(U.parse(""), { view: null, box: null });
    assert.deepEqual(U.parse("#"), { view: null, box: null });
    assert.deepEqual(U.parse("#foo=bar"), { view: null, box: null });
    assert.deepEqual(U.parse(undefined), { view: null, box: null });
  });

  it("ignores bad values without throwing", () => {
    const bad = [
      "#map=abc",
      "#map=17/36.1",
      "#map=17/x/-115",
      "#map=17/36/-115/9",
      "#map=1e3/36/-115",
      "#map=17/95/-115",
      "#map=Infinity/36/-115",
      "#map=%E0%A4%A",
    ];
    for (const h of bad) assert.equal(U.parse(h).view, null, h);
    const badBox = [
      "#box=1,2,3",
      "#box=36,-115,36,-115",
      "#box=a,b,c,d",
      "#box=36,-115,37,200",
      "#box=89,-115,89.5,-114",
      "#box=0,0,20,20",
      "#box=<script>,1,2,3",
    ];
    for (const h of badBox) assert.equal(U.parse(h).box, null, h);
  });

  it("clamps zoom and latitude and wraps longitude", () => {
    assert.equal(U.parse("#map=40/36/-115", { maxZoom: 18 }).view.zoom, 18);
    assert.equal(U.parse("#map=0/36/-115").view.zoom, 1);
    assert.equal(U.parse("#map=40/36/-115").view.zoom, 23);
    assert.equal(U.parse("#map=10/89/0").view.lat, U.MAX_LAT);
    assert.equal(U.parse("#map=10/0/190").view.lon, -170);
    assert.equal(U.parse("#map=10/0/-190").view.lon, 170);
  });

  it("puts a swapped box back in south,west,north,east order", () => {
    assert.deepEqual(U.parse("#box=36.2,-115.1,36.1,-115.2").box, { south: 36.1, west: -115.2, north: 36.2, east: -115.1 });
  });
});

describe("url state: format", () => {
  it("writes compact map and box with 5 or 6 decimals", () => {
    const h = U.format("", {
      view: { zoom: 17, lat: 36.1280004, lon: -115.16 },
      box: { south: 36.12710041, west: -115.1619, north: 36.1293, east: -115.1584 },
    });
    assert.equal(h, "#map=17/36.12800/-115.16000&box=36.127100,-115.161900,36.129300,-115.158400");
    assert.equal(U.format("", { view: { zoom: 19, lat: 1.5, lon: 2 } }), "#map=19/1.500000/2.000000");
  });

  it("round-trips", () => {
    const state = {
      view: { zoom: 18, lat: 44.97812, lon: -93.26501 },
      box: { south: 44.9771, west: -93.2671, north: 44.9792, east: -93.2633 },
    };
    const back = U.parse(U.format("", state));
    assert.deepEqual(back.view, state.view);
    assert.deepEqual(back.box, state.box);
  });

  it("drops box= when the box is cleared and keeps other keys", () => {
    const prev = "#map=10/1/2&box=1,2,3,4&note=a%20b&flag";
    assert.equal(U.format(prev, { view: { zoom: 11, lat: 1, lon: 2 }, box: null }), "#map=11/1.00000/2.00000&note=a%20b&flag");
    assert.equal(U.format("#map=1/1/1", {}), "");
  });

  it("never writes -0", () => {
    assert.equal(U.formatView({ zoom: 3, lat: -0.000001, lon: 0 }), "3/0.00000/0.00000");
  });
});

describe("url state: debounce", () => {
  function fakeTimers() {
    let next = 1;
    const pending = new Map();
    return {
      setTimeout(fn) {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
      runAll() {
        const fns = [...pending.values()];
        pending.clear();
        fns.forEach((f) => f());
      },
      get size() {
        return pending.size;
      },
    };
  }

  it("collapses a burst of moves into one write with the last value", () => {
    const t = fakeTimers();
    const calls = [];
    const d = U.debounce((v) => calls.push(v), 300, t);
    d(1);
    d(2);
    d(3);
    assert.equal(t.size, 1);
    t.runAll();
    assert.deepEqual(calls, [3]);
  });

  it("flush runs a pending call now and cancel drops it", () => {
    const t = fakeTimers();
    const calls = [];
    const d = U.debounce((v) => calls.push(v), 300, t);
    d("a");
    d.flush();
    d("b");
    d.cancel();
    t.runAll();
    assert.deepEqual(calls, ["a"]);
  });
});

describe("url state: page wiring", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

  it("loads url-state.js and net-errors.js before app.js", () => {
    const iUrl = html.indexOf('src="/url-state.js"');
    const iNet = html.indexOf('src="/net-errors.js"');
    const iApp = html.indexOf('src="/app.js"');
    assert.ok(iUrl > 0 && iNet > 0 && iApp > iUrl && iApp > iNet);
  });

  it("uses replaceState, never pushState, for the map URL", () => {
    assert.match(app, /history\.replaceState\(/);
    assert.equal(/history\.pushState\(/.test(app), false);
  });

  it("keeps the search text out of the URL", () => {
    const block = app.slice(app.indexOf("const pushUrlState"), app.indexOf("function writeUrlState"));
    assert.ok(block.length > 0);
    assert.equal(/searchInput|getElementById\("q"\)/.test(block), false);
  });

  it("updates the URL when a box is drawn or cleared", () => {
    const apply = app.slice(app.indexOf("function applyExtent("), app.indexOf("function showIdleStatus("));
    const clear = app.slice(app.indexOf("function clearFinishedShape("), app.indexOf("function commitBox("));
    assert.match(apply, /writeUrlState\(\)/);
    assert.match(clear, /writeUrlState\(\)/);
  });
});

describe("url state: debounce with real timers", () => {
  it("runs with the global timers called unbound", async () => {
    const calls = [];
    const d = U.debounce((v) => calls.push(v), 5);
    d(1);
    d(2);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, [2]);
  });
});
