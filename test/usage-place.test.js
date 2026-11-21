"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const place = require("../netlify/lib/usage-place");

afterEach(() => {
  place.setLookupForTests(undefined);
});

describe("usage place codes", () => {
  it("normalizes country codes and reads Netlify visitor geo", () => {
    assert.equal(place.normalizeCountry("us"), "US");
    assert.equal(place.normalizeCountry("UK"), "GB");
    assert.equal(place.normalizeCountry("Nevada"), "unknown");
    assert.equal(place.normalizeCountry(""), "unknown");
    assert.equal(place.visitorCountryFrom({ country: { code: "FI" } }), "FI");
    assert.equal(place.visitorCountryFrom({ country: { code: "us", name: "United States" } }), "US");
    assert.equal(place.visitorCountryFrom(null), "unknown");
    assert.equal(place.visitorCountryFrom({ city: "Las Vegas", subdivision: { code: "NV" } }), "unknown");
    assert.equal(place.isCountryKey("US"), true);
    assert.equal(place.isCountryKey("unknown"), true);
    assert.equal(place.isCountryKey("US-NV"), false);
    assert.equal(place.isRegionKey("US-NV"), true);
    assert.equal(place.isRegionKey("AU-NSW"), true);
    assert.equal(place.isRegionKey("Nevada"), false);
  });

  it("takes country and US, Canada, or Australia region from a Nominatim address, never a city", () => {
    assert.deepEqual(
      place.codesFromAddress({
        address: { country_code: "us", "ISO3166-2-lvl4": "US-NV", city: "Las Vegas", road: "Las Vegas Blvd" },
      }),
      { country: "US", region: "US-NV" }
    );
    assert.deepEqual(
      place.codesFromAddress({ address: { country_code: "ca", state: "Ontario", city: "Toronto" } }),
      { country: "CA", region: "CA-ON" }
    );
    assert.deepEqual(
      place.codesFromAddress({ address: { country_code: "au", state: "New South Wales", city: "Sydney" } }),
      { country: "AU", region: "AU-NSW" }
    );
    assert.deepEqual(place.codesFromAddress({ address: { country_code: "fi", city: "Helsinki" } }), {
      country: "FI",
      region: "",
    });
    assert.deepEqual(place.codesFromAddress({}), { country: "unknown", region: "" });
    const codes = place.codesFromAddress({
      address: { country_code: "us", "ISO3166-2-lvl4": "US-NV", city: "Paradise", road: "E Tropicana Ave" },
    });
    assert.equal(JSON.stringify(codes).includes("Paradise"), false);
    assert.equal(JSON.stringify(codes).includes("Tropicana"), false);
  });

  it("looks up the center of a box and returns only codes", async () => {
    const vegas = { west: -115.15257, south: 36.12986, east: -115.13647, north: 36.14069 };
    const center = place.boxCenter(vegas);
    assert.ok(Math.abs(center.lat - (36.12986 + 36.14069) / 2) < 1e-9);
    let seen = null;
    const loc = await place.lookupExportPlace(vegas, {
      timeoutMs: 500,
      fetch: async (url) => {
        seen = String(url);
        return {
          ok: true,
          async json() {
            return {
              address: { country_code: "us", "ISO3166-2-lvl4": "US-NV", city: "Paradise" },
            };
          },
        };
      },
    });
    assert.deepEqual(loc, { country: "US", region: "US-NV" });
    assert.match(seen, /nominatim\.openstreetmap\.org\/reverse/);
    assert.equal(JSON.stringify(loc).includes("Paradise"), false);
    assert.deepEqual(await place.lookupExportPlace(null), { country: "unknown", region: "" });
    assert.deepEqual(
      await place.lookupExportPlace(vegas, {
        fetch: async () => {
          throw new Error("network");
        },
      }),
      { country: "unknown", region: "" }
    );
  });
});
