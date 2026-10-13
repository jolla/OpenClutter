"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { handler } = require("../netlify/functions/geocode");

const SNIPPET =
  "<a class='result-link'>Casa Evexía, 298 Lakeshore, Pointe-Claire, QC (2026) - Glartent</a>";

const PLACE = [
  {
    lat: "45.4287480",
    lon: "-73.8261990",
    display_name: "298, Chemin du Bord-du-Lac - Lakeshore, Pointe-Claire",
  },
];

function jsonResponse(data, ok = true) {
  return {
    ok,
    status: ok ? 200 : 502,
    json: async () => data,
    text: async () => "",
  };
}

describe("geocode handler venue fallback", () => {
  const orig = global.fetch;
  after(() => {
    global.fetch = orig;
  });

  it("geocodes Casa Evexia from the street in a search snippet", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("lite.duckduckgo.com")) {
        return { ok: true, status: 200, text: async () => SNIPPET, json: async () => ({}) };
      }
      const q = decodeURIComponent((u.split("q=")[1] || "").split("&")[0]);
      if (q.startsWith("298")) return jsonResponse(PLACE);
      return jsonResponse([]);
    };
    const res = await handler({
      httpMethod: "GET",
      queryStringParameters: { q: "Casa Evexia" },
    });
    const hits = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(hits[0].lat, "45.4287480");
    assert.equal(hits[0].lon, "-73.8261990");
    assert.ok(calls.some((u) => u.includes("lite.duckduckgo.com")));
    assert.ok(calls.some((u) => decodeURIComponent(u).includes("298 Lakeshore, Pointe-Claire, QC")));
  });

  it("does not ask the snippet service when Nominatim already hit the address", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      const q = decodeURIComponent((u.split("q=")[1] || "").split("&")[0]);
      if (q.includes("Lakeshore Road")) return jsonResponse(PLACE);
      return jsonResponse([]);
    };
    const res = await handler({
      httpMethod: "GET",
      queryStringParameters: {
        q: "298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3",
      },
    });
    const hits = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(hits[0].lat, "45.4287480");
    assert.equal(calls.some((u) => u.includes("duckduckgo")), false);
  });

  it("returns an empty list when the snippet has no street for that name", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("lite.duckduckgo.com")) {
        return { ok: true, status: 200, text: async () => SNIPPET, json: async () => ({}) };
      }
      return jsonResponse([]);
    };
    const res = await handler({
      httpMethod: "GET",
      queryStringParameters: { q: "Something Else" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });
});
