"use strict";

const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { geocodePlace } = require("../netlify/lib/geocode-place");
const nominatim = require("../netlify/lib/nominatim");
const searchCache = require("../netlify/lib/search-cache");

const PHOTON = {
  features: [
    {
      geometry: { coordinates: [-112.534, 46.003] },
      properties: {
        name: "Butte",
        osm_key: "place",
        osm_value: "city",
        county: "Silver Bow",
        state: "Montana",
        country: "United States",
      },
    },
  ],
};

const NOMI = [
  {
    lat: "60.46647",
    lon: "26.94582",
    display_name: "Kotka, Finland",
  },
];

function jsonResponse(data, ok = true) {
  return { ok, status: ok ? 200 : 502, json: async () => data, text: async () => "" };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(t);
      reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

describe("geocode race", () => {
  const orig = global.fetch;
  beforeEach(() => {
    nominatim._setStore(null);
    searchCache._setStore(null);
    searchCache._clear();
  });
  after(() => {
    global.fetch = orig;
  });

  it("returns a fast Nominatim hit without waiting for a slow Photon", async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("photon")) {
        await delay(400, init && init.signal);
        return jsonResponse(PHOTON);
      }
      return jsonResponse(NOMI);
    };
    const t0 = Date.now();
    const result = await geocodePlace("Kotka Finland", null, { fetch: fetchFn, userAgent: "openclutter/test" });
    const ms = Date.now() - t0;
    assert.equal(result.ok, true);
    assert.equal(result.source, "nominatim");
    assert.equal(result.cached, false);
    assert.equal(result.hits[0].display_name, "Kotka, Finland");
    assert.equal(result.hits[0].source, "nominatim");
    assert.ok(ms < 250, "waited " + ms + " ms");
    assert.ok(calls.some((u) => u.includes("photon")));
    assert.equal(calls.filter((u) => u.includes("nominatim.openstreetmap.org")).length, 1);
  });

  it("returns a fast Photon hit without waiting for a slow Nominatim", async () => {
    const fetchFn = async (url, init) => {
      const u = String(url);
      if (u.includes("photon")) return jsonResponse(PHOTON);
      await delay(400, init && init.signal);
      return jsonResponse(NOMI);
    };
    const t0 = Date.now();
    const result = await geocodePlace("Butte MT", null, { fetch: fetchFn, userAgent: "openclutter/test" });
    const ms = Date.now() - t0;
    assert.equal(result.source, "photon");
    assert.equal(result.hits[0].display_name.includes("Butte"), true);
    assert.ok(ms < 250, "waited " + ms + " ms");
  });

  it("waits for Photon when Nominatim is empty", async () => {
    const fetchFn = async (url, init) => {
      const u = String(url);
      if (u.includes("photon")) {
        await delay(40, init && init.signal);
        return jsonResponse(PHOTON);
      }
      return jsonResponse([]);
    };
    const result = await geocodePlace("Butte MT", null, { fetch: fetchFn, userAgent: "openclutter/test" });
    assert.equal(result.source, "photon");
    assert.match(String(result.hits[0].display_name), /Butte/);
  });

  it("asks Nominatim only once for a bilingual street", async () => {
    const nomi = [];
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("photon")) return jsonResponse({ features: [] });
      nomi.push(decodeURIComponent((u.split("q=")[1] || "").split("&")[0]));
      return jsonResponse([
        { lat: "45.4287480", lon: "-73.8261990", display_name: "298 Lakeshore, Pointe-Claire" },
      ]);
    };
    const result = await geocodePlace(
      "298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3",
      null,
      { fetch: fetchFn, userAgent: "openclutter/test" }
    );
    assert.equal(result.source, "nominatim");
    assert.deepEqual(nomi, ["298 Lakeshore Road, Pointe-Claire, QC"]);
  });

  it("returns a cached hit without calling the providers", async () => {
    let n = 0;
    const fetchFn = async (url) => {
      n++;
      const u = String(url);
      if (u.includes("photon")) return jsonResponse(PHOTON);
      return jsonResponse([]);
    };
    const first = await geocodePlace("Butte MT", null, { fetch: fetchFn, userAgent: "openclutter/test" });
    assert.equal(first.cached, false);
    assert.ok(n > 0);
    n = 0;
    const second = await geocodePlace("Butte MT", null, { fetch: fetchFn, userAgent: "openclutter/test" });
    assert.equal(second.cached, true);
    assert.equal(second.source, "photon");
    assert.equal(n, 0);
  });

  it("does not cache an empty miss, and reports a provider error", async () => {
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("photon")) return jsonResponse({ features: [] });
      return jsonResponse([], false);
    };
    const first = await geocodePlace("nowhere", null, { fetch: fetchFn, userAgent: "openclutter/test" });
    assert.equal(first.ok, false);
    assert.equal(first.status, 502);
    assert.equal(first.hits.length, 0);
    const again = await geocodePlace("nowhere", { lat: 1, lon: 2 }, { fetch: fetchFn, userAgent: "openclutter/test" });
    assert.equal(again.cached, false);
  });
});
