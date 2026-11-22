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

/** Real waits scaled down 1000x. */
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
    assert.ok(hosts.includes("overpass-api.de"));
    assert.ok(hosts.includes("overpass.private.coffee") || hosts.includes("maps.mail.ru"));
    assert.ok(!hosts.includes("overpass.openstreetmap.fr"));
    assert.ok(lines.some((l) => /overpass-api\.de map status=429 .*pause=4\d\d\d\d/.test(l)), lines.join("\n"));
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

  it("moves to the last resort once two regular servers fail in one read", async () => {
    const refused = () => {
      const e = new TypeError("fetch failed");
      e.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      throw e;
    };
    setup((url) => {
      const h = hostOf(url);
      if (h === "overpass-api.de") refused();
      if (h === "overpass.openstreetmap.fr") return res(200, JSON_OK);
      return res(504, "busy");
    });
    const got = await overpass.request({ kind: "interpreter", query: "q-two", deadlineMs: 5000 });
    assert.equal(got.ok, true);
    const hosts = calls.map((c) => hostOf(c.url));
    assert.deepEqual(hosts, ["overpass-api.de", "overpass.private.coffee", "maps.mail.ru", "overpass.openstreetmap.fr"]);
  });

  it("moves to the last resort once the only regular server fails in one read", async () => {
    const prev = process.env.OPENCLUTTER_OVERPASS_ENDPOINTS;
    process.env.OPENCLUTTER_OVERPASS_ENDPOINTS = "overpass-api.de,openstreetmap.fr";
    try {
      setup((url) => {
        const h = hostOf(url);
        if (h === "overpass-api.de") return res(502, "busy");
        if (h === "overpass.openstreetmap.fr") return res(200, JSON_OK);
        return res(504, "busy");
      });
      const got = await overpass.request({ kind: "interpreter", query: "q-one-regular", deadlineMs: 5000 });
      assert.equal(got.ok, true);
      const hosts = calls.map((c) => hostOf(c.url));
      assert.deepEqual(hosts, ["overpass-api.de", "overpass.openstreetmap.fr"]);
    } finally {
      if (prev == null) delete process.env.OPENCLUTTER_OVERPASS_ENDPOINTS;
      else process.env.OPENCLUTTER_OVERPASS_ENDPOINTS = prev;
    }
  });

  it("asks one server at a time and moves on when one hangs", async () => {
    let active = 0;
    let peak = 0;
    setup((url, init) => {
      const h = hostOf(url);
      active += 1;
      peak = Math.max(peak, active);
      const done = (p) => p.finally(() => (active -= 1));
      if (h === "overpass-api.de") {
        return done(
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          })
        );
      }
      if (h === "overpass.openstreetmap.fr") return done(Promise.resolve(res(200, JSON_OK)));
      return done(Promise.resolve(res(504, "busy")));
    });
    const got = await overpass.request({ kind: "interpreter", query: "q-hang", deadlineMs: 400 });
    assert.equal(got.ok, true);
    assert.equal(peak, 1);
    assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass.private.coffee", "maps.mail.ru", "overpass.openstreetmap.fr"]);
  });

  it("never asks the last-resort server while a regular one answers", async () => {
    setup((url) => (hostOf(url) === "overpass-api.de" ? res(504, "busy") : res(200, JSON_OK)));
    await overpass.request({ kind: "interpreter", query: "q-reg", deadlineMs: 5000 });
    assert.ok(!calls.some((c) => hostOf(c.url) === "overpass.openstreetmap.fr"));
  });

  it("rejects a body cut off mid-stream", () => {
    assert.equal(overpass.bodyOk("map", MAP_XML), true);
    assert.equal(overpass.bodyOk("map", MAP_XML.slice(0, -10)), false);
    assert.equal(overpass.bodyOk("interpreter", JSON_OK), true);
    assert.equal(overpass.bodyOk("interpreter", JSON_OK.slice(0, -5)), false);
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
    const hosts = calls.map((c) => hostOf(c.url));
    assert.ok(calls.length >= 1 && calls.length <= 3, String(calls.length));
    assert.ok(!hosts.includes("overpass.openstreetmap.fr"));
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
    // The first read races the regular mirrors once; the copy serves later calls.
    assert.ok(calls.length >= 1 && calls.length <= 3, String(calls.length));
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

  it("leaves a server that answers 406 alone for the block pause, with no status probe", async () => {
    setup((url) => {
      if (hostOf(url) === "overpass-api.de") return res(406, "Not Acceptable");
      return res(200, JSON_OK);
    });
    const a = await overpass.request({ kind: "interpreter", query: "q406a", deadlineMs: 5000 });
    const b = await overpass.request({ kind: "interpreter", query: "q406b", deadlineMs: 5000 });
    assert.equal(a.ok && b.ok, true);
    assert.ok(!calls.some((c) => c.url.includes("/status")));
    assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass.private.coffee", "overpass.private.coffee"]);
    assert.ok(lines.some((l) => /status=406 .*blocked pause=18\d{5}/.test(l)), lines.join("\n"));
  });

  it("skips a server after two silent timeouts in a row", async () => {
    let clock = Date.now();
    overpass.resetForTests({
      now: () => clock,
      fetch: async (url, init) => {
        calls.push({ url });
        if (hostOf(url) === "overpass-api.de") {
          return new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }
        return res(200, JSON_OK);
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    for (const q of ["qs1", "qs2", "qs3"]) {
      const got = await overpass.request({ kind: "interpreter", query: q, deadlineMs: 90000 });
      assert.equal(got.ok, true);
      // Past the ordinary backoff, inside the 10 min skip.
      clock += 60000;
    }
    assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass.private.coffee", "overpass-api.de", "overpass.private.coffee", "overpass.private.coffee"]);
    assert.ok(lines.some((l) => /overpass-api\.de interpreter status=timeout .*silent=2 pause=600000/.test(l)), lines.join("\n"));
  });

  it("caps a hang at about 20 s while another server can still be asked", async () => {
    let seen = 0;
    overpass.resetForTests({
      fetch: async (url, init) => {
        calls.push({ url });
        const t0 = Date.now();
        const h = hostOf(url);
        // The hedged partner fails fast so the first hang can use its full 20 s cap.
        if (h === "overpass.private.coffee") return res(504, "busy");
        if (h !== "overpass-api.de") return res(200, JSON_OK);
        await new Promise((resolve) => init.signal.addEventListener("abort", resolve, { once: true }));
        seen = Date.now() - t0;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    await overpass.request({ kind: "interpreter", query: "q-share", deadlineMs: 90000 });
    // ATTEMPT_MS 20 s, scaled 1000x, while other servers remain.
    assert.ok(seen >= 15 && seen < 30, String(seen));
    assert.equal(overpass.ATTEMPT_MS, 20000);
    assert.equal(overpass.HEDGE_MS, 5000);
  });

  it("asks a second regular server after a short hang and keeps the first good answer", async () => {
    let deSeen = 0;
    let peak = 0;
    let active = 0;
    overpass.resetForTests({
      fetch: async (url, init) => {
        calls.push({ url });
        const h = hostOf(url);
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (h === "overpass-api.de") {
            const t0 = Date.now();
            await new Promise((resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                deSeen = Date.now() - t0;
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              }, { once: true });
            });
          }
          return res(200, JSON_OK);
        } finally {
          active -= 1;
        }
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    const got = await overpass.request({ kind: "interpreter", query: "q-hedge", deadlineMs: 90000 });
    assert.equal(got.ok, true);
    assert.ok(peak >= 2, String(peak));
    // HEDGE_MS 5 s scaled 1000x, well under the 20 s cap.
    assert.ok(deSeen >= 3 && deSeen < 15, String(deSeen));
    const hosts = calls.map((c) => hostOf(c.url));
    assert.ok(hosts.includes("overpass-api.de"));
    assert.ok(hosts.includes("overpass.private.coffee"));
    assert.ok(!hosts.includes("overpass.openstreetmap.fr"));
  });

  it("lets the last remaining server use the rest of the window, past the 20 s cap", async () => {
    let frSeen = 0;
    overpass.resetForTests({
      fetch: async (url) => {
        calls.push({ url });
        const h = hostOf(url);
        if (h !== "overpass.openstreetmap.fr") return res(504, "busy");
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 30));
        frSeen = Date.now() - t0;
        return res(200, JSON_OK);
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    const got = await overpass.request({ kind: "interpreter", query: "q-last-slow", deadlineMs: 90000 });
    assert.equal(got.ok, true);
    // 30 ms real wait is longer than a scaled 20 s cap (20 ms) and shorter
    // than the leftover 90 s window (90 ms scaled).
    assert.ok(frSeen >= 25, String(frSeen));
  });

  it("only asks the servers a local run names", async () => {
    process.env.OPENCLUTTER_OVERPASS_ENDPOINTS = "openstreetmap.fr";
    try {
      setup(() => res(200, JSON_OK));
      const got = await overpass.request({ kind: "interpreter", query: "q-only", deadlineMs: 5000 });
      assert.equal(got.ok, true);
      assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass.openstreetmap.fr"]);
    } finally {
      delete process.env.OPENCLUTTER_OVERPASS_ENDPOINTS;
    }
  });

  it("sends the app's identifying user agent by default", async () => {
    setup(() => res(200, JSON_OK));
    await overpass.request({ kind: "interpreter", query: "q-ua", deadlineMs: 5000 });
    const { userAgent } = require("../netlify/lib/version");
    assert.equal(calls[0].init.headers["user-agent"], userAgent);
    assert.match(userAgent, /^openclutter\/\d+\.\d+\.\d+ \(https:\/\/github\.com\/jolla\/OpenClutter\)$/);
  });

  it("keeps answers on disk by query when a cache dir is set, and never a failed read", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-overpass-"));
    process.env.OPENCLUTTER_OVERPASS_CACHE_DIR = dir;
    try {
      setup((url) => (hostOf(url) === "overpass-api.de" ? res(200, MAP_XML) : res(504, "busy")));
      const a = await overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 });
      assert.equal(a.ok, true);
      const afterFirst = calls.length;
      assert.ok(afterFirst >= 1 && afterFirst <= 3, String(afterFirst));
      // A new process: no in-memory copy, the disk copy answers.
      setup(() => {
        throw new Error("no network expected");
      });
      const b = await overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 });
      assert.equal(b.ok, true);
      assert.equal(b.disk, true);
      assert.equal(b.text, MAP_XML);
      assert.equal(calls.length, afterFirst);
      // A different box is a different key; a failed read leaves nothing.
      setup(() => res(400, "bad"));
      const c = await overpass.request({ kind: "map", bbox: Object.assign({}, box, { west: box.west - 0.001 }), deadlineMs: 5000 });
      assert.equal(c.ok, false);
      const files = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : files.push(f.name);
      })(dir);
      assert.equal(files.filter((f) => f.endsWith(".gz")).length, 1);
    } finally {
      delete process.env.OPENCLUTTER_OVERPASS_CACHE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a block pause across processes when the cache dir is set", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-overpass-"));
    process.env.OPENCLUTTER_OVERPASS_CACHE_DIR = dir;
    try {
      setup((url) => (hostOf(url) === "overpass-api.de" ? res(406, "") : res(200, JSON_OK)));
      await overpass.request({ kind: "interpreter", query: "q-p1", deadlineMs: 5000 });
      assert.ok(fs.existsSync(path.join(dir, "endpoint-pauses.json")));
      setup(() => res(200, JSON_OK));
      await overpass.request({ kind: "interpreter", query: "q-p2", deadlineMs: 5000 });
      assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass.private.coffee", "overpass.private.coffee"]);
    } finally {
      delete process.env.OPENCLUTTER_OVERPASS_CACHE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the same servers as before while overpass-api.de answers", async () => {
    setup(() => res(200, JSON_OK));
    for (let i = 0; i < 3; i++) await overpass.request({ kind: "interpreter", query: "q-healthy" + i, deadlineMs: 5000 });
    assert.deepEqual(calls.map((c) => hostOf(c.url)), ["overpass-api.de", "overpass-api.de", "overpass-api.de"]);
  });

  it("names a stale street-map copy once per export and stays quiet for a fresh one", async () => {
    let clock = Date.parse("2026-11-04T12:00:00Z");
    const fresh = '<?xml version="1.0"?><osm version="0.6"><meta osm_base="2026-11-04T11:58:00Z"/><node id="1" lat="1" lon="2"/></osm>';
    const old = '{"version":0.6,"osm3s":{"timestamp_osm_base":"2026-08-10T00:10:23Z"},"elements":[]}';
    overpass.resetForTests({
      fetch: async (url) => (hostOf(url) === "overpass-api.de" ? res(200, fresh) : res(200, old)),
      log: () => {},
      now: () => clock,
    });
    await overpass.request({ kind: "map", bbox: box, deadlineMs: 5000 });
    assert.equal(overpass.staleNote(), "");
    process.env.OPENCLUTTER_OVERPASS_ENDPOINTS = "openstreetmap.fr";
    try {
      await overpass.request({ kind: "interpreter", query: "q-stale", deadlineMs: 5000 });
    } finally {
      delete process.env.OPENCLUTTER_OVERPASS_ENDPOINTS;
    }
    assert.match(overpass.staleNote(), /backup OpenStreetMap copy dated Aug 10, 2026/);
    overpass.resetStaleUse();
    assert.equal(overpass.staleNote(), "");
    assert.equal(overpass.osmBaseOf(fresh), Date.parse("2026-11-04T11:58:00Z"));
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

  it("races regular map mirrors and uses the last-resort server without a 60 s serial wait", async () => {
    let peak = 0;
    let active = 0;
    const frBody = MAP_XML.replace("<osm", '<osm osm_base="2026-11-01T00:00:00Z"');
    const t0 = Date.now();
    overpass.resetForTests({
      fetch: async (url, init) => {
        calls.push({ url });
        const h = hostOf(url);
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (h === "overpass.openstreetmap.fr") {
            await new Promise((r) => setTimeout(r, 12));
            return res(200, frBody);
          }
          await new Promise((resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true }
            );
          });
        } finally {
          active -= 1;
        }
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    const got = await overpass.request({
      kind: "map",
      bbox: box,
      deadlineMs: 30000,
    });
    const ms = Date.now() - t0;
    assert.equal(got.ok, true);
    assert.equal(got.text, frBody);
    assert.ok(peak >= 2, String(peak));
    // Last-resort wait is 8 s, scaled to 8 ms by fastSleep, plus the 12 ms answer.
    assert.ok(ms < 80, String(ms));
    const hosts = calls.map((c) => hostOf(c.url));
    assert.ok(hosts.includes("overpass-api.de"));
    assert.ok(hosts.includes("overpass.openstreetmap.fr"));
  });

  it("keeps the first good map body and cancels the other mirrors", async () => {
    const coffeeBody = MAP_XML.replace("id=\"1\"", 'id="22"');
    overpass.resetForTests({
      fetch: async (url, init) => {
        calls.push({ url });
        const h = hostOf(url);
        if (h === "overpass.private.coffee") {
          await new Promise((r) => setTimeout(r, 5));
          return res(200, coffeeBody);
        }
        await new Promise((resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
        });
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    const got = await overpass.request({ kind: "map", bbox: box, deadlineMs: 30000 });
    assert.equal(got.ok, true);
    assert.equal(got.text, coffeeBody);
    assert.ok(!calls.some((c) => hostOf(c.url) === "overpass.openstreetmap.fr"));
  });

  it("stops when a map extract is over the size cap instead of waiting on other mirrors", async () => {
    const big = MAP_XML + "x".repeat(50);
    overpass.resetForTests({
      fetch: async (url, init) => {
        calls.push({ url });
        const h = hostOf(url);
        if (h === "overpass-api.de") return res(200, big);
        await new Promise((resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
        });
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    const t0 = Date.now();
    const got = await overpass.request({ kind: "map", bbox: box, deadlineMs: 30000, maxBytes: 20 });
    const ms = Date.now() - t0;
    assert.equal(got.ok, false);
    assert.equal(got.tooBig, true);
    assert.ok(ms < 50, String(ms));
  });

  it("gives up after one attempt per map mirror without retrying until the deadline", async () => {
    const t0 = Date.now();
    overpass.resetForTests({
      fetch: async (url) => {
        calls.push({ url });
        return res(504, "busy");
      },
      log: (l) => lines.push(l),
      sleep: fastSleep,
      timerScale: 1000,
    });
    const got = await overpass.request({ kind: "map", bbox: box, deadlineMs: 30000 });
    const ms = Date.now() - t0;
    assert.equal(got.ok, false);
    assert.ok(ms < 80, String(ms));
    const hosts = calls.map((c) => hostOf(c.url));
    assert.equal(hosts.filter((h) => h === "overpass-api.de").length, 1);
    assert.equal(hosts.filter((h) => h === "overpass.private.coffee").length, 1);
    assert.ok(hosts.includes("overpass.openstreetmap.fr"));
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
