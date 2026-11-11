"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const overpass = require("../netlify/lib/overpass");
const nominatim = require("../netlify/lib/nominatim");
const { handler } = require("../netlify/functions/reverse");

const BERKELEY = {
  south: "45.998524",
  west: "-112.535329",
  north: "46.067024",
  east: "-112.460980",
};

const origJson = overpass.requestJson;
const origReverse = nominatim.nominatimReverse;

afterEach(() => {
  overpass.requestJson = origJson;
  nominatim.nominatimReverse = origReverse;
});

describe("nominatim reverse URL", () => {
  it("uses /reverse on the public Nominatim host with zoom 14", () => {
    const url = nominatim.reverseUrl(46.032774, -112.4981545);
    assert.match(url, /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/);
    assert.match(url, /format=jsonv2/);
    assert.match(url, /zoom=14/);
    assert.match(url, /lat=46\.032774/);
  });
});

describe("reverse handler", () => {
  it("returns 400 with an empty label for a bad box", async () => {
    const res = await handler({ httpMethod: "GET", queryStringParameters: { south: "x" } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).label, "");
  });

  it("returns Berkeley Pit - Butte, MT from Overpass plus Nominatim", async () => {
    overpass.requestJson = async () => ({
      elements: [
        {
          type: "way",
          id: 35740942,
          bounds: { minlat: 46.01, minlon: -112.52, maxlat: 46.025, maxlon: -112.5 },
          center: { lat: 46.0171152, lon: -112.511297 },
          tags: {
            name: "Berkeley Pit",
            natural: "water",
            wikidata: "Q820869",
            wikipedia: "en:Berkeley Pit",
          },
        },
      ],
    });
    nominatim.nominatimReverse = async () => ({
      ok: true,
      data: {
        address: {
          city: "Butte",
          state: "Montana",
          "ISO3166-2-lvl4": "US-MT",
          country_code: "us",
        },
      },
    });
    const res = await handler({ httpMethod: "GET", queryStringParameters: BERKELEY });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.label, "Berkeley Pit - Butte, MT");
    assert.equal(body.feature, "Berkeley Pit");
    assert.equal(body.place, "Butte, MT");
  });

  it("returns an empty label when both lookups fail", async () => {
    overpass.requestJson = async () => {
      throw new Error("overpass down");
    };
    nominatim.nominatimReverse = async () => {
      throw new Error("nominatim down");
    };
    const res = await handler({ httpMethod: "GET", queryStringParameters: BERKELEY });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).label, "");
  });
});
