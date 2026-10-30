"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { rankPlaces, textScore, suggestPlaces, stateQuery } = require("../netlify/lib/place-search");

describe("place search ranking", () => {
  it("forgives a typo and an abbreviation", () => {
    assert.equal(textScore("caesers palace", "Caesars Palace"), 1);
    assert.equal(textScore("empire state bldg", "Empire State Building"), 1);
    assert.equal(textScore("caesers palace", "Caesars Palace", false), 0.5);
  });

  it("puts the full name ahead of a short surname match", () => {
    const view = { lat: 36.12, lon: -115.165 };
    const esri = [{ label: "Dr. Brian Wyn MD", detail: "Las Vegas, NV", text: "Dr. Brian Wyn MD, Las Vegas, NV", magicKey: "k", source: "esri", rank: 0 }];
    const photon = [{ label: "Wynn Las Vegas", detail: "Las Vegas, United States", text: "Wynn Las Vegas, Las Vegas", lat: 36.1265, lon: -115.1657, source: "photon", rank: 0 }];
    assert.equal(rankPlaces("wyn las vegas", view, esri, photon)[0].label, "Wynn Las Vegas");
  });

  it("prefers the same name near the map view", () => {
    const view = { lat: 36.12, lon: -115.165 };
    const photon = [
      { label: "Bellagio", detail: "Como, Italia", text: "Bellagio, Como, Italia", lat: 45.98, lon: 9.26, source: "photon", rank: 0 },
      { label: "Bellagio", detail: "Las Vegas", text: "Bellagio, Las Vegas", lat: 36.1126, lon: -115.1767, source: "photon", rank: 1 },
    ];
    assert.equal(rankPlaces("bellagio", view, [], photon)[0].detail, "Las Vegas");
  });

  it("reads a trailing state as a state, not a word", () => {
    assert.deepEqual(stateQuery("Austin, Tx"), { place: "Austin", state: "Texas" });
    assert.deepEqual(stateQuery("Austin TX"), { place: "Austin", state: "Texas" });
    assert.deepEqual(stateQuery("Austin Texas"), { place: "Austin", state: "Texas" });
    assert.deepEqual(stateQuery("Charleston, West Virginia"), { place: "Charleston", state: "West Virginia" });
    assert.deepEqual(stateQuery("Kansas City, MO"), { place: "Kansas City", state: "Missouri" });
    assert.equal(stateQuery("Allow me"), null);
    assert.equal(stateQuery("West Virginia"), null);
    assert.equal(stateQuery("Caesars Palace"), null);
  });

  it("puts the city ahead of a college with its name for City, ST (issue 8)", () => {
    // Photon gives POIs the short state and towns the long one.
    const view = { lat: 33.659, lon: -96.595 };
    const photon = [
      { label: "Austin", detail: "Travis, Texas, United States", text: "Austin, Travis, Texas, United States", lat: 30.265, lon: -97.747, source: "photon", rank: 0, kind: "city", state: "Texas" },
      { label: "Austin", detail: "Texas, United States", text: "Austin, Texas, United States", lat: 29.89, lon: -96.24, source: "photon", rank: 1, kind: "county", state: "Texas" },
      { label: "Austin College", detail: "900 North Grand Avenue, Sherman, Texas, United States", text: "Austin College, 900 North Grand Avenue, Sherman, Texas, United States", lat: 33.647, lon: -96.598, source: "photon", rank: 5, kind: "", state: "Texas" },
    ];
    for (const q of ["Austin, Tx", "Austin, TX", "Austin Texas"]) {
      const top = rankPlaces(q, view, [], photon)[0];
      assert.equal(top.text, "Austin, Travis, Texas, United States", q);
    }
    assert.equal(rankPlaces("Austin College", view, [], photon)[0].label, "Austin College");
  });

  it("asks Photon for places in the typed state and expands TX", async () => {
    const urls = [];
    const fetchFn = async (url) => {
      urls.push(url);
      const placesOnly = url.includes("osm_tag=place");
      const features = placesOnly
        ? [{ geometry: { coordinates: [-89.644, 39.799] }, properties: { name: "Springfield", osm_key: "place", osm_value: "city", county: "Sangamon", state: "Illinois", country: "United States" } }]
        : [{ geometry: { coordinates: [-87.723, 41.913] }, properties: { name: "Springfield Pumping Station", osm_key: "landuse", osm_value: "industrial", city: "Chicago", state: "IL", country: "United States" } }];
      return { ok: true, json: async () => ({ features }) };
    };
    const list = await suggestPlaces("Springfield, IL", { lat: 41.88, lon: -87.63 }, { fetchFn });
    assert.equal(urls.length, 2);
    assert.ok(urls.some((u) => u.includes("osm_tag=place") && u.includes(encodeURIComponent("Springfield, Illinois"))));
    assert.equal(list[0].label, "Springfield");
    assert.equal(list[1].detail, "Chicago, Illinois, United States");
    urls.length = 0;
    await suggestPlaces("Caesars Palace", null, { fetchFn });
    assert.equal(urls.length, 1);
  });

  it("returns an empty list when both services fail", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
    assert.deepEqual(await suggestPlaces("sphere", null, { fetchFn }), []);
  });
});
