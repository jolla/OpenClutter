"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const overpass = require("../netlify/lib/overpass");
const exportMode = require("../netlify/lib/export-mode");

const MAP_XML = '<?xml version="1.0"?><osm version="0.6"><node id="1" lat="36.12" lon="-115.16"/></osm>';
const JSON_OK = '{"version":0.6,"elements":[{"type":"node","id":1,"lat":1,"lon":2}]}';
const box = { west: -115.164, south: 36.1195, east: -115.1605, north: 36.1225 };

function res(status, text, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (headers && headers[String(h).toLowerCase()]) || null },
    text: async () => text,
  };
}

/** Real waits scaled down 1000x, so the 15 s hedge is 15 ms and stays after a quick answer. */
function fastSleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms / 1000));
    if (signal) signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

function hostOf(url) {
  return new URL(url).host;
}

describe("overpass client", () => {
  let lines;
  let calls;
  beforeEach(() => {
    lines = [];
    calls = [];
  });
  afterEach(() => {
    overpass.resetForTests();
    exportMode.setResilient(false);
  });

  function setup(handler) {
    overpass.resetForTests({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return handler(url, init, calls.length);
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
    });
  }

  it("parses Retry-After and /api/status slot times", () => {
    assert.equal(overpass.retryAfterMs("12"), 12000);
    assert.equal(overpass.retryAfterMs(""), 0);
    const now = Date.parse("2026-10-22T22:00:00Z");
    assert.equal(overpass.retryAfterMs("Thu, 22 Oct 2026 22:00:30 GMT", now), 30000);
    assert.equal(overpass.statusWaitMs("Rate limit: 2\n2 slots available now.\n"), 0);
    assert.equal(
      overpass.statusWaitMs("Rate limit: 2\nSlot available after: 2026-10-22T22:00:09Z, in 9 seconds.\nSlot available after: 2026-10-22T22:00:21Z, in 21 seconds.\n"),
      9000
    );
    assert.equal(overpass.statusWaitMs("nothing here"), -1);
  });

  it("treats a runtime error remark as a failed answer", () => {
    assert.equal(overpass.bodyOk("map", MAP_XML), true);
    assert.equal(overpass.bodyOk("map", "<osm><remark> runtime error: Query timed out </remark></osm>"), false);
    assert.equal(overpass.bodyOk("interpreter", JSON_OK), true);
    assert.equal(overpass.bodyOk("interpreter", '{"elements":[],"remark":"runtime error: Query ran out of memory"}'), false);
  });

  it("pauses a server that answers 429 and reads the next one", async () => {
    setup((url) => {
      if (url.includes("/status")) return res(200, "Slot available after: x, in 40 seconds.");
      if (hostOf(url) === "overpass-api.de") return res(429, "Too Many Requests");
      return res(200, MAP_XML);
    });
    const got = await overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 });
    assert.equal(got.ok, true);
    assert.match(got.text, /<osm/);
    const hosts = calls.map((c) => hostOf(c.url));
    assert.deepEqual(hosts, ["overpass-api.de", "overpass-api.de", "overpass.private.coffee"]);
    assert.ok(lines.some((l) => /overpass-api\.de map status=429 .*pause=4\d\d\d\d slotIn=40000/.test(l)), lines.join("\n"));
  });

  it("honours Retry-After without asking /api/status", async () => {
    setup((url) => {
      if (hostOf(url) === "overpass-api.de") return res(429, "", { "retry-after": "45" });
      return res(200, JSON_OK);
    });
    const got = await overpass.request({ kind: "interpreter", query: "[out:json];node(1,2,3,4);out;", deadlineMs: 5000 });
    assert.equal(got.ok, true);
    assert.ok(!calls.some((c) => c.url.includes("/status")));
    assert.ok(lines.some((l) => /status=429 .*pause=4[5-6]\d\d\d/.test(l)), lines.join("\n"));
  });

  it("backs off after 504 and falls through every server", async () => {
    setup((url) => {
      if (hostOf(url) === "maps.mail.ru") return res(200, JSON_OK);
      return res(504, "Gateway Timeout");
    });
    const got = await overpass.request({ kind: "interpreter", query: "q1", deadlineMs: 5000 });
    assert.equal(got.ok, true);
    assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass.private.coffee", "maps.mail.ru"]);
    assert.equal(lines.filter((l) => /status=504 .*backoff=\d+/.test(l)).length, 2);
  });

  it("skips a server that refuses the connection and keeps it skipped", async () => {
    const refused = () => {
      const e = new TypeError("fetch failed");
      e.cause = Object.assign(new Error("connect ECONNREFUSED 65.109.112.52:443"), { code: "ECONNREFUSED" });
      throw e;
    };
    setup((url) => {
      if (hostOf(url) === "overpass-api.de") refused();
      return res(200, JSON_OK);
    });
    const a = await overpass.request({ kind: "interpreter", query: "qa", deadlineMs: 5000 });
    const b = await overpass.request({ kind: "interpreter", query: "qb", deadlineMs: 5000 });
    assert.equal(a.ok && b.ok, true);
    assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass.private.coffee", "overpass.private.coffee"]);
    assert.ok(lines.some((l) => /status=refused .*code=ECONNREFUSED pause=600000/.test(l)), lines.join("\n"));
  });

  it("asks the last-resort server only when every other one is out", async () => {
    setup((url) => {
      if (hostOf(url) === "overpass.openstreetmap.fr") return res(200, JSON_OK);
      return res(429, "", { "retry-after": "60" });
    });
    const got = await overpass.request({ kind: "interpreter", query: "q-last", deadlineMs: 5000 });
    assert.equal(got.ok, true);
    const hosts = calls.filter((c) => !c.url.includes("/status")).map((c) => hostOf(c.url));
    assert.deepEqual(hosts, ["overpass-api.de", "overpass.private.coffee", "maps.mail.ru", "overpass.openstreetmap.fr"]);
  });

  it("never asks the last-resort server while a regular one answers", async () => {
    setup((url) => (hostOf(url) === "overpass-api.de" ? res(504, "busy") : res(200, JSON_OK)));
    await overpass.request({ kind: "interpreter", query: "q-reg", deadlineMs: 5000 });
    assert.ok(!calls.some((c) => hostOf(c.url) === "overpass.openstreetmap.fr"));
  });

  it("reads the socket code under a nested fetch error", () => {
    const agg = Object.assign(new Error("agg"), { errors: [Object.assign(new Error("x"), { code: "ECONNREFUSED" })] });
    assert.equal(overpass.errorCode(Object.assign(new TypeError("fetch failed"), { cause: agg })), "ECONNREFUSED");
    assert.equal(overpass.errorCode(new Error("plain")), "");
  });

  it("returns ok:false at the deadline so the export keeps its warning", async () => {
    let t = 1000;
    overpass.resetForTests({
      fetch: async (url) => {
        calls.push({ url });
        t += 2000;
        return res(503, "busy");
      },
      log: () => {},
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const got = await overpass.request({ kind: "interpreter", query: "q2", deadlineMs: 20000 });
    assert.equal(got.ok, false);
    assert.ok(calls.length >= 3 && calls.length < 20, String(calls.length));
  });

  it("does not retry a 400 on another server", async () => {
    setup(() => res(400, "too many nodes"));
    const got = await overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 });
    assert.equal(got.ok, false);
    assert.equal(got.status, 400);
    assert.equal(calls.length, 1);
  });

  it("coalesces identical reads and keeps a short-lived copy", async () => {
    setup(async () => {
      await new Promise((r) => setTimeout(r, 4));
      return res(200, MAP_XML);
    });
    const [a, b] = await Promise.all([
      overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 }),
      overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 }),
    ]);
    const c = await overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 });
    assert.equal(a.ok && b.ok && c.ok, true);
    assert.equal(c.cached, true);
    assert.equal(calls.length, 1);
  });

  it("caps requests in flight per server", async () => {
    let active = 0;
    let peak = 0;
    setup(async (url) => {
      if (hostOf(url) !== "overpass-api.de") return res(200, JSON_OK);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return res(200, JSON_OK);
    });
    await Promise.all([1, 2, 3, 4, 5].map((i) => overpass.request({ kind: "interpreter", query: "q" + i, deadlineMs: 5000 })));
    assert.ok(peak <= overpass.ENDPOINTS[0].slots, String(peak));
  });

  it("is off unless the export turns it on", async () => {
    const tiles = require("../netlify/lib/osm-tiles");
    let hit = 0;
    const fetchImpl = async () => {
      hit += 1;
      return res(200, MAP_XML);
    };
    exportMode.setResilient(true);
    // A caller's own fetchImpl keeps the earlier path, as in the tests and bench fixtures.
    const got = await tiles.fetchOsmMaps(box, { fetchImpl });
    assert.equal(got.xmls.length, 1);
    assert.equal(hit, 1);
  });
});

describe("area cache classifier", () => {
  const cache = require("../netlify/lib/area-cache");
  it("never treats a blob store request as a source read", () => {
    assert.equal(cache.classifyFetch("https://api.netlify.com/api/v1/blobs/site/openclutter-exports/raw/overpass/interpreter/abc/body"), null);
    assert.equal(cache.classifyFetch("https://netlify-blobs.s3.us-east-1.amazonaws.com/raw/overpass/interpreter/abc"), null);
    assert.equal(cache.classifyFetch("https://overpass-api.de/api/map?bbox=1,2,3,4").source, "osm");
    assert.equal(cache.classifyFetch("https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/chm/tile.tif").source, "canopy");
    assert.equal(cache.classifyFetch("https://maps.mail.ru/osm/tools/overpass/api/interpreter", { body: "data=x" }).source, "overpass");
  });
});
