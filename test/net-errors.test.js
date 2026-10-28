"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const N = require("../public/net-errors");

const BASE = "https://openclutter.com/";

function res(status, type, extra) {
  const headers = new Map([["content-type", type || "application/json"]]);
  return Object.assign(
    {
      status,
      ok: status >= 200 && status < 300,
      url: "",
      redirected: false,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
    },
    extra || {}
  );
}

async function blockedBy(fetchImpl, url, init, step) {
  try {
    await N.guardedFetch(url || "/api/geocode?q=x", init, { fetch: fetchImpl, base: BASE, step: step || "Search", navigator: { onLine: true } });
  } catch (err) {
    return err;
  }
  return null;
}

describe("net errors: guardedFetch", () => {
  it("passes a normal JSON response through", async () => {
    const r = res(200, "application/json");
    const got = await N.guardedFetch("/api/geocode", undefined, { fetch: async () => r, base: BASE });
    assert.equal(got, r);
  });

  it("leaves ordinary API errors to the caller", async () => {
    for (const status of [400, 404, 413, 500, 502, 504]) {
      const r = res(status, status === 502 ? "text/html" : "application/json");
      const got = await N.guardedFetch("/api/clutter", undefined, { fetch: async () => r, base: BASE });
      assert.equal(got, r, String(status));
    }
  });

  it("names the step and host when the request never connects", async () => {
    const err = await blockedBy(async () => {
      throw new TypeError("Failed to fetch");
    });
    assert.ok(err && err.blocked);
    assert.equal(err.kind, "network");
    assert.equal(err.noRetry, true);
    assert.match(err.message, /^Search could not reach openclutter\.com\./);
    assert.match(err.message, /firewall or proxy/);
    assert.match(err.message, /Try another network\./);
  });

  it("says offline when the browser reports no connection", async () => {
    let err = null;
    try {
      await N.guardedFetch("/api/x", undefined, {
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
        base: BASE,
        step: "Export",
        navigator: { onLine: false },
      });
    } catch (e) {
      err = e;
    }
    assert.equal(err.kind, "offline");
    assert.match(err.message, /offline/);
  });

  it("treats 403, 407 and 451 as a block", async () => {
    assert.equal((await blockedBy(async () => res(403, "text/html"))).kind, "forbidden");
    assert.equal((await blockedBy(async () => res(451, "application/json"))).kind, "forbidden");
    const proxy = await blockedBy(async () => res(407, "text/plain"));
    assert.equal(proxy.kind, "proxy-auth");
    assert.match(proxy.message, /407/);
  });

  it("treats an HTML page where JSON was due as a proxy block page", async () => {
    const err = await blockedBy(async () => res(200, "text/html; charset=utf-8"), "/api/clutter", undefined, "Export");
    assert.equal(err.kind, "html");
    assert.match(err.message, /^Export was blocked: openclutter\.com returned a firewall or proxy page instead of data\./);
    assert.match(err.message, /ask IT to allow openclutter\.com\./);
  });

  it("treats a redirect to another host as a block", async () => {
    const err = await blockedBy(async () =>
      res(200, "application/json", { redirected: true, url: "https://gateway.zscaler.net/block?x=1" })
    );
    assert.equal(err.kind, "redirect");
  });

  it("reports a timeout with the host", async () => {
    const err = await blockedBy(
      async () => {
        const e = new Error("signal timed out");
        e.name = "TimeoutError";
        throw e;
      },
      "https://imagery.geoplatform.gov/x",
      undefined,
      "Tree canopy data"
    );
    assert.equal(err.kind, "timeout");
    assert.match(err.message, /^Tree canopy data timed out reaching imagery\.geoplatform\.gov\./);
  });

  it("reports an abort caused by a timeout signal as a timeout", async () => {
    const reason = new Error("t");
    reason.name = "TimeoutError";
    const err = await blockedBy(
      async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
      "/api/x",
      { signal: { reason } }
    );
    assert.equal(err.kind, "timeout");
  });

  it("rethrows a user cancel unchanged", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const err = await blockedBy(async () => {
      throw abort;
    }, "/api/x", { signal: { reason: abort } });
    assert.equal(err, abort);
  });

  it("keeps the network hint on an unexpected reply", () => {
    const m = N.unexpectedReplyMessage("Feedback", "openclutter.com", 502);
    assert.equal(m, "Feedback got an unexpected reply from openclutter.com (502). A company firewall or proxy may be in the way. Try again, or try another network.");
    assert.match(N.unexpectedReplyMessage("Feedback", "", 0), /from the server\. /);
  });

  it("has no em dashes in any message", () => {
    for (const kind of ["network", "timeout", "forbidden", "proxy-auth", "html", "redirect", "offline"]) {
      assert.equal(/\u2014/.test(N.blockedMessage("Export", "openclutter.com", kind)), false, kind);
    }
  });
});

describe("net errors: API host fallback", () => {
  function memStore() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  }
  function closedOn(host, okRes) {
    const calls = [];
    const f = async (url) => {
      calls.push(String(url));
      if (String(url).includes(host)) throw new TypeError("Failed to fetch"); // net::ERR_CONNECTION_CLOSED
      return okRes;
    };
    return { f, calls };
  }
  const PAGE = "https://dev.openclutter.com/";

  it("uses same-origin only when no API host is set", async () => {
    const ok = res(200);
    const { f, calls } = closedOn("api.openclutter.com", ok);
    const route = N.createApiRoute({ base: "", fetch: f, pageBase: PAGE });
    assert.equal(await route.fetch("/api/clutter", {}, { step: "Export" }), ok);
    assert.deepEqual(calls, ["/api/clutter"]);
    assert.equal(route.url("/api/x"), "/api/x");
  });

  it("falls back to the page's own /api when the API host drops the connection, and remembers it", async () => {
    const ok = res(200);
    const { f, calls } = closedOn("api.openclutter.com", ok);
    const storage = memStore();
    let fell = 0;
    const route = N.createApiRoute({ base: "https://api.openclutter.com/", fetch: f, pageBase: PAGE, storage, onFallback: () => fell++ });
    assert.equal(route.url("/api/clutter"), "https://api.openclutter.com/api/clutter");
    assert.equal(await route.fetch("/api/clutter", { method: "POST" }, { step: "Export" }), ok);
    assert.deepEqual(calls, ["https://api.openclutter.com/api/clutter", "/api/clutter"]);
    assert.equal(fell, 1);
    assert.equal(route.sameOrigin, true);
    // Status and download go straight to the page's host now.
    await route.fetch("/api/export-status?job=1", {}, { step: "Export status" });
    assert.equal(calls[calls.length - 1], "/api/export-status?job=1");
    // A new page in the same session starts on the page's host.
    const again = N.createApiRoute({ base: "https://api.openclutter.com", fetch: f, pageBase: PAGE, storage });
    assert.equal(again.sameOrigin, true);
  });

  it("does not fall back on an HTTP answer from the API host", async () => {
    const calls = [];
    const f = async (url) => {
      calls.push(url);
      return res(500, "application/json");
    };
    const route = N.createApiRoute({ base: "https://api.openclutter.com", fetch: f, pageBase: PAGE });
    const r = await route.fetch("/api/clutter", {}, { step: "Export" });
    assert.equal(r.status, 500);
    assert.equal(calls.length, 1);
    assert.equal(route.sameOrigin, false);
  });

  it("names both hosts when the page's own host is blocked too", async () => {
    const f = async () => {
      throw new TypeError("Failed to fetch");
    };
    const route = N.createApiRoute({ base: "https://api.openclutter.com", fetch: f, pageBase: PAGE, navigator: { onLine: true } });
    let err = null;
    try {
      await route.fetch("/api/clutter", {}, { step: "Export" });
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.blocked && err.noRetry);
    assert.match(err.message, /^Export could not reach api\.openclutter\.com or dev\.openclutter\.com\. A company firewall or proxy may be blocking it\. Try another network\.$/);
  });

  it("rethrows a user cancel without falling back", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const calls = [];
    const f = async (url) => {
      calls.push(url);
      throw abort;
    };
    const route = N.createApiRoute({ base: "https://api.openclutter.com", fetch: f, pageBase: PAGE });
    await assert.rejects(route.fetch("/api/clutter", { signal: { reason: abort } }, { step: "Export" }), (e) => e === abort);
    assert.equal(calls.length, 1);
  });
});

describe("net errors: tile watch", () => {
  it("shows once after a batch of failed tiles, not per tile", () => {
    let shown = 0;
    let back = 0;
    const w = N.createTileWatch({ onBlocked: () => shown++, onRecovered: () => back++ });
    w.batch();
    for (let i = 0; i < 20; i++) w.error(16);
    assert.equal(shown, 1);
    w.batch();
    for (let i = 0; i < 20; i++) w.error(17);
    assert.equal(shown, 1);
    w.load();
    w.load();
    assert.equal(back, 1);
  });

  it("stays quiet when some tiles load", () => {
    let shown = 0;
    const w = N.createTileWatch({ onBlocked: () => shown++ });
    w.batch();
    w.load();
    for (let i = 0; i < 10; i++) w.error(16);
    assert.equal(shown, 0);
  });

  it("skips the deep-zoom misses the quality map expects", () => {
    let shown = 0;
    const w = N.createTileWatch({ onBlocked: () => shown++, skipZoom: (z) => z > 19 });
    for (let i = 0; i < 10; i++) w.error(21);
    assert.equal(shown, 0);
  });
});

describe("net errors: page wiring", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

  it("sends every app request except the fire-and-forget cancel through guardedFetch", () => {
    const raw = app.match(/(^|[^.\w])fetch\(/g) || [];
    assert.equal(raw.length, 1);
    assert.match(app, /fetch\(exportApi\.url\("\/api\/export-cancel/);
    for (const p of ["/api/clutter", "/api/export-status", "/api/export-file"]) {
      assert.equal(new RegExp('OpenClutterNet\\.guardedFetch\\(\\s*"' + p.replace(/\//g, "\\/")).test(app), false, p + " goes through exportApi");
    }
    assert.match(app, /addEventListener\("unhandledrejection"/);
    for (const step of ["Search", "Export", "Export status", "Download", "Terrain", "Tree canopy data"]) {
      assert.match(app, new RegExp('step: "' + step + '"'), step);
    }
  });

  it("sends both feedback requests through guardedFetch", () => {
    const fb = fs.readFileSync(path.join(root, "public/feedback.js"), "utf8");
    assert.match(fb, /net\.guardedFetch\("\/api\/feedback", init, \{ step: "Feedback" \}\)/);
    assert.equal((fb.match(/feedbackFetch\(\{/g) || []).length, 2);
    assert.equal(/fetch\("\/api\/feedback", \{/.test(fb), false);
    assert.ok(html.indexOf('src="/net-errors.js"') < html.indexOf('src="/feedback.js"'));
    // Non-JSON or empty 5xx replies keep the network hint; the generic line suggests another network.
    assert.match(fb, /net\.unexpectedReplyMessage\("Feedback", location\.host, status\)/);
    assert.match(fb, /SEND_FAILED = "Sorry, the report could not be sent\. Try again later, or try another network\."/);
    assert.equal(/Please try again later/.test(fb), false);
  });

  it("watches imagery tile errors once", () => {
    assert.match(app, /createTileWatch\(/);
    assert.match(app, /imageryTiles\.on\("tileerror", \(ev\) => tileWatch\.error/);
  });

  it("says why when the map library from unpkg is blocked", () => {
    assert.match(html, /if \(!window\.L\)/);
    assert.match(html, /unpkg\.com was blocked or unreachable/);
  });
});
