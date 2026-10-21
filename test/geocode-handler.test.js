"use strict";

const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { handler } = require("../netlify/functions/geocode");
const nominatim = require("../netlify/lib/nominatim");

const PLACE = [
  {
    lat: "45.4287480",
    lon: "-73.8261990",
    display_name: "298, Chemin du Bord-du-Lac - Lakeshore, Pointe-Claire",
  },
];

function jsonResponse(data, ok = true) {
  return { ok, status: ok ? 200 : 502, json: async () => data, text: async () => "" };
}

describe("geocode handler (Photon, then Nominatim)", () => {
  const orig = global.fetch;
  const origUrl = process.env.NOMINATIM_URL;
  beforeEach(() => nominatim._setStore(null));
  after(() => {
    global.fetch = orig;
    if (origUrl === undefined) delete process.env.NOMINATIM_URL;
    else process.env.NOMINATIM_URL = origUrl;
  });

  it("geocodes an address through Nominatim without a search-page scrape or the Esri geocoder", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("photon")) return jsonResponse({ features: [] });
      const q = decodeURIComponent((u.split("q=")[1] || "").split("&")[0]);
      if (q.includes("Lakeshore")) return jsonResponse(PLACE);
      return jsonResponse([]);
    };
    const res = await handler({
      httpMethod: "GET",
      queryStringParameters: { q: "298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3" },
    });
    const hits = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(hits[0].lat, "45.4287480");
    assert.equal(calls.some((u) => /duckduckgo|geocode\.arcgis\.com/.test(u)), false);
    assert.ok(calls.some((u) => u.startsWith(nominatim.DEFAULT_URL)));
  });

  it("returns an empty list for a venue name no open source knows", async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("photon")) return jsonResponse({ features: [] });
      return jsonResponse([]);
    };
    const res = await handler({ httpMethod: "GET", queryStringParameters: { q: "Casa Evexia" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
    assert.equal(calls.some((u) => /duckduckgo|arcgis/.test(u)), false);
  });

  it("reads the Nominatim endpoint from NOMINATIM_URL", async () => {
    process.env.NOMINATIM_URL = "https://geo.example.org/search";
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("photon")) return jsonResponse({ features: [] });
      return jsonResponse(PLACE);
    };
    await handler({ httpMethod: "GET", queryStringParameters: { q: "298 Lakeshore Pointe-Claire" } });
    assert.ok(calls.some((u) => u.startsWith("https://geo.example.org/search?")));
    assert.equal(calls.some((u) => u.includes("nominatim.openstreetmap.org")), false);
    delete process.env.NOMINATIM_URL;
    assert.equal(nominatim.endpoint({ NOMINATIM_URL: "http://insecure.example/search" }), nominatim.DEFAULT_URL);
  });
});

describe("Nominatim pacing", () => {
  it("keeps calls at least 1 s apart in one process", async () => {
    nominatim._setStore(null);
    const at = [];
    const fetch = async () => {
      at.push(Date.now());
      return jsonResponse([]);
    };
    await nominatim.nominatimSearch("a", { fetch });
    await nominatim.nominatimSearch("b", { fetch });
    assert.ok(at[1] - at[0] >= nominatim.GAP_MS - 5, "gap " + (at[1] - at[0]));
  });

  it("shares one slot clock across instances through the blob store", async () => {
    let value = null;
    let etag = 0;
    const store = {
      async getWithMetadata() {
        return value ? { data: value, etag: String(etag) } : null;
      },
      async setJSON(key, data, opts) {
        if (opts && opts.onlyIfNew && value) return { modified: false };
        if (opts && opts.onlyIfMatch && opts.onlyIfMatch !== String(etag)) return { modified: false };
        value = data;
        etag++;
        return { modified: true };
      },
    };
    nominatim._setStore(store);
    const now = Date.now();
    const a = await nominatim.reserveSlot(now);
    // A second instance has its own process clock, but the store holds the next slot.
    nominatim._setStore(store);
    const b = await nominatim.reserveSlot(now);
    assert.ok(b - a >= nominatim.GAP_MS, "slots " + a + " " + b);
    nominatim._setStore(null);
  });
});
