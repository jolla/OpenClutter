"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseBbox,
  boxCenter,
  displayName,
  formatPlace,
  formatLabel,
  regionAbbrev,
  pickFeature,
  labelForBox,
} = require("../netlify/lib/reverse-geocode");

const BERKELEY_BOX = {
  south: 45.998524,
  west: -112.535329,
  north: 46.067024,
  east: -112.46098,
};

const BERKELEY_ELEMENTS = [
  {
    type: "way",
    id: 35740942,
    bounds: { minlat: 46.01, minlon: -112.52, maxlat: 46.025, maxlon: -112.50 },
    center: { lat: 46.0171152, lon: -112.511297 },
    tags: {
      name: "Berkeley Pit",
      natural: "water",
      wikidata: "Q820869",
      wikipedia: "en:Berkeley Pit",
    },
  },
  {
    type: "relation",
    id: 1,
    bounds: { minlat: 45.5, minlon: -113.2, maxlat: 46.5, maxlon: -111.8 },
    center: { lat: 46.03, lon: -112.5 },
    tags: {
      name: "Butte",
      boundary: "administrative",
      admin_level: "8",
      place: "city",
      wikidata: "Q467664",
      wikipedia: "en:Butte, Montana",
    },
  },
  {
    type: "way",
    id: 2,
    bounds: { minlat: 46.04, minlon: -112.51, maxlat: 46.055, maxlon: -112.49 },
    center: { lat: 46.048, lon: -112.50 },
    tags: { name: "Yankee Doodle Tailings Pond", natural: "water" },
  },
  {
    type: "way",
    id: 3,
    bounds: { minlat: 46.013, minlon: -112.536, maxlat: 46.0135, maxlon: -112.5355 },
    center: { lat: 46.0132, lon: -112.5358 },
    tags: {
      name: "Dumas Brothel",
      wikidata: "Q1264902",
      wikipedia: "en:Dumas Brothel",
    },
  },
  {
    type: "way",
    id: 4,
    bounds: { minlat: 46.02, minlon: -112.53, maxlat: 46.0204, maxlon: -112.5296 },
    center: { lat: 46.0202, lon: -112.5298 },
    tags: { name: "Steward Mine", man_made: "mineshaft" },
  },
  {
    type: "node",
    id: 5,
    lat: 46.02,
    lon: -112.51,
    tags: { name: "Berkeley Pit Viewing Stand", tourism: "viewpoint" },
  },
  {
    type: "way",
    id: 6,
    tags: { name: "Berkeley Pit Visitor Information & Tickets", tourism: "information" },
    center: { lat: 46.02, lon: -112.51 },
  },
  {
    type: "relation",
    id: 7,
    bounds: { minlat: 44.0, minlon: -114.0, maxlat: 47.0, maxlon: -110.0 },
    center: { lat: 46.03, lon: -112.5 },
    tags: {
      name: "Beaverhead-Deerlodge National Forest",
      boundary: "protected_area",
      wikidata: "Q3079107",
      wikipedia: "en:Beaverhead-Deerlodge National Forest",
    },
  },
];

describe("parseBbox", () => {
  it("reads a finite south,west,north,east box", () => {
    const box = parseBbox(BERKELEY_BOX);
    assert.equal(box.south, BERKELEY_BOX.south);
    assert.ok(boxCenter(box).lat > 46.03 && boxCenter(box).lat < 46.04);
  });

  it("rejects inverted, huge, or non-numeric boxes", () => {
    assert.equal(parseBbox({ south: 2, west: 1, north: 1, east: 2 }), null);
    assert.equal(parseBbox({ south: 0, west: 0, north: 3, east: 0.1 }), null);
    assert.equal(parseBbox({ south: "x", west: 0, north: 1, east: 1 }), null);
  });
});

describe("displayName and format", () => {
  it("prefers the English Wikipedia title when it is an alt name", () => {
    assert.equal(
      displayName({
        name: "Barringer Crater",
        alt_name: "Barringer Crater;Meteor Crater Natural Landmark;Barringer Meteor Crater",
        wikipedia: "en:Meteor Crater",
      }),
      "Meteor Crater"
    );
    assert.equal(displayName({ name: "Berkeley Pit", wikipedia: "en:Berkeley Pit" }), "Berkeley Pit");
  });

  it("formats US city and state, and City, Country abroad", () => {
    assert.equal(regionAbbrev({ "ISO3166-2-lvl4": "US-MT", state: "Montana" }), "MT");
    assert.equal(
      formatPlace({
        address: {
          city: "Butte",
          state: "Montana",
          "ISO3166-2-lvl4": "US-MT",
          country: "United States",
          country_code: "us",
        },
      }),
      "Butte, MT"
    );
    assert.equal(
      formatPlace({
        address: { city: "Paris", country: "France", country_code: "fr" },
      }),
      "Paris, France"
    );
    assert.equal(
      formatPlace({
        address: { county: "Coconino County", "ISO3166-2-lvl4": "US-AZ", country_code: "us" },
      }),
      "Coconino County, AZ"
    );
  });

  it("joins a landmark and city, and does not repeat the city name", () => {
    assert.equal(formatLabel("Berkeley Pit", "Butte, MT"), "Berkeley Pit - Butte, MT");
    assert.equal(formatLabel("Butte", "Butte, MT"), "Butte, MT");
    assert.equal(formatLabel("", "Butte, MT"), "Butte, MT");
    assert.equal(formatLabel("Berkeley Pit", ""), "Berkeley Pit");
  });
});

describe("pickFeature", () => {
  it("picks Berkeley Pit over mines, ponds, historic buildings, and admin areas", () => {
    const picked = pickFeature(BERKELEY_ELEMENTS, BERKELEY_BOX);
    assert.ok(picked);
    assert.equal(picked.name, "Berkeley Pit");
  });

  it("falls back to city only when nothing notable is in the box", () => {
    assert.equal(pickFeature([], BERKELEY_BOX), null);
  });
});

describe("labelForBox", () => {
  it("combines the Overpass landmark with the Nominatim city", async () => {
    const named = await labelForBox(BERKELEY_BOX, {
      requestJson: async () => ({ elements: BERKELEY_ELEMENTS }),
      nominatimReverse: async () => ({
        ok: true,
        data: {
          address: {
            city: "Butte",
            state: "Montana",
            "ISO3166-2-lvl4": "US-MT",
            country_code: "us",
          },
        },
      }),
    });
    assert.equal(named.label, "Berkeley Pit - Butte, MT");
    assert.equal(named.feature, "Berkeley Pit");
    assert.equal(named.place, "Butte, MT");
  });

  it("returns only the city when Overpass fails, and fails soft on both errors", async () => {
    const cityOnly = await labelForBox(BERKELEY_BOX, {
      requestJson: async () => {
        throw new Error("overpass down");
      },
      nominatimReverse: async () => ({
        ok: true,
        data: { address: { city: "Butte", "ISO3166-2-lvl4": "US-MT", country_code: "us" } },
      }),
    });
    assert.equal(cityOnly.label, "Butte, MT");
    const empty = await labelForBox(BERKELEY_BOX, {
      requestJson: async () => {
        throw new Error("overpass down");
      },
      nominatimReverse: async () => {
        throw new Error("nominatim down");
      },
    });
    assert.equal(empty.label, "");
  });
});

describe("fetchLandmarkOsm", () => {
  it("asks openstreetmap.fr first when requestJson is not injected", async () => {
    const { fetchLandmarkOsm, LANDMARK_OVERPASS } = require("../netlify/lib/reverse-geocode");
    const calls = [];
    const osm = await fetchLandmarkOsm(BERKELEY_BOX, {
      userAgent: "openclutter-test",
      osmFetch: async (url, init) => {
        calls.push({ url, method: init.method, ua: init.headers["user-agent"] });
        return {
          ok: true,
          json: async () => ({ elements: BERKELEY_ELEMENTS }),
        };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LANDMARK_OVERPASS);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].ua, "openclutter-test");
    assert.equal(osm.elements[0].tags.name, "Berkeley Pit");
  });
});
