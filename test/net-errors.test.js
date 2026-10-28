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

  it("has no em dashes in any message", () => {
    for (const kind of ["network", "timeout", "forbidden", "proxy-auth", "html", "redirect", "offline"]) {
      assert.equal(/\u2014/.test(N.blockedMessage("Export", "openclutter.com", kind)), false, kind);
    }
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
    assert.match(app, /fetch\("\/api\/export-cancel/);
    for (const step of ["Search", "Export", "Export status", "Download", "Terrain", "Tree canopy data"]) {
      assert.match(app, new RegExp('step: "' + step + '"'), step);
    }
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
