"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { rankPlaces, textScore, suggestPlaces } = require("../netlify/lib/place-search");

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

  it("returns an empty list when both services fail", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
    assert.deepEqual(await suggestPlaces("sphere", null, { fetchFn }), []);
  });
});
