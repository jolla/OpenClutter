"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fn = require("../netlify/lib/export-filename");

const FORT = {
  west: -81.535,
  south: 28.385,
  east: -81.512,
  north: 28.405,
};
const WYNN = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
};
const KOA = {
  west: -112.195,
  south: 35.248,
  east: -112.185,
  north: 35.255,
};
const NOW = new Date("2026-11-24T15:30:00Z");

after(() => {
  fn.setLookupForTests();
});

describe("formatAreaSize", () => {
  it("uses m2, ha, or km2 by size", () => {
    assert.equal(fn.formatAreaSize(450), "450m2");
    assert.equal(fn.formatAreaSize(4500), "4500m2");
    assert.equal(fn.formatAreaSize(12000), "1.2ha");
    assert.equal(fn.formatAreaSize(120000), "12ha");
    assert.equal(fn.formatAreaSize(1.2e6), "1.2km2");
    assert.equal(fn.formatAreaSize(12e6), "12km2");
    assert.equal(fn.formatAreaSize(0), "");
  });
});

describe("slugPart and addresses", () => {
  it("transliterates accents and drops punctuation", () => {
    assert.equal(fn.slugPart("São Paulo"), "Sao-Paulo");
    assert.equal(fn.slugPart("München"), "Munchen");
    assert.equal(fn.slugPart("Disney's Fort Wilderness Resort"), "Disneys-Fort-Wilderness-Resort");
    assert.equal(fn.slugPart("Parc de la Villette"), "Parc-de-la-Villette");
  });

  it("rejects street addresses and generic names", () => {
    assert.equal(fn.isStreetAddress("123 Main Street"), true);
    assert.equal(fn.isStreetAddress("44 Oak Avenue, Orlando"), true);
    assert.equal(fn.isStreetAddress("Fort Wilderness"), false);
    assert.equal(fn.usablePlaceName("Site"), "");
    assert.equal(fn.usablePlaceName("123 Main Street"), "");
    assert.equal(fn.usablePlaceName("Fort Wilderness"), "Fort Wilderness");
  });
});

describe("buildExportZipName", () => {
  it("builds Place_Locality_size_date.zip", () => {
    const name = fn.buildExportZipName({
      place: "Fort-Wilderness",
      locality: "Orlando-FL",
      areaM2: 1.2e6,
      now: NOW,
    });
    assert.equal(name, "Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip");
  });

  it("falls back to rounded centroid coordinates", () => {
    const name = fn.buildExportZipName({
      lat: 28.405,
      lon: -81.573,
      areaM2: 1.2e6,
      now: NOW,
    });
    assert.equal(name, "28.41N_81.57W_1.2km2_20261124.zip");
  });

  it("parses a search-box label of Feature - City, ST", () => {
    const parsed = fn.parseNamedLabel("Disney's Fort Wilderness Resort - Orlando, FL");
    assert.equal(parsed.place, "Disneys-Fort-Wilderness-Resort");
    assert.equal(parsed.locality, "Orlando-FL");
    const name = fn.buildExportZipName({
      place: parsed.place,
      locality: parsed.locality,
      areaM2: 1.2e6,
      now: NOW,
    });
    assert.equal(name, "Disneys-Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip");
  });

  it("compacts long localities and stays at about 60 characters", () => {
    const name = fn.buildExportZipName({
      place: "Disneys-Fort-Wilderness-Resort-and-Campground-Recreation-Area",
      locality: "Lake-Buena-Vista-FL",
      areaM2: 1.2e6,
      now: NOW,
    });
    assert.ok(name.endsWith("_1.2km2_20261124.zip"));
    assert.ok(name.length <= 60, name + " is " + name.length);
    assert.match(name, /^[A-Za-z0-9._-]+$/);
  });

  it("names a Wynn-sized box with the provided place", () => {
    const name = fn.buildExportZipName({
      place: "Wynn-Golf",
      locality: "Las-Vegas-NV",
      ...WYNN,
      now: NOW,
    });
    assert.match(name, /^Wynn-Golf_Las-Vegas-NV_\d+(\.\d+)?km2_20261124\.zip$/);
    assert.ok(fn.bboxAreaM2(WYNN) > 1e6);
  });
});

describe("compactLocality", () => {
  it("uses city plus region or country code", () => {
    assert.equal(fn.compactLocality("Orlando, FL"), "Orlando-FL");
    assert.equal(fn.compactLocality("Orlando, Florida, United States"), "Orlando-FL");
    assert.equal(fn.compactLocality("São Paulo, Brazil"), "Sao-Paulo-BR");
    assert.equal(fn.compactLocality("Paris, France"), "Paris-FR");
    assert.equal(fn.compactLocality("Toronto, Ontario, Canada"), "Toronto-ON");
    assert.equal(fn.compactLocality({ city: "Las Vegas", state: "Nevada", country_code: "us" }), "Las-Vegas-NV");
  });
});

describe("placeFromPhoton and placeFromNominatim", () => {
  it("prefers a named park over a street", () => {
    const photon = fn.placeFromPhoton({
      properties: {
        name: "Disney's Fort Wilderness Resort & Campground",
        osm_key: "tourism",
        osm_value: "hotel",
        city: "Bay Lake",
        state: "Florida",
        countrycode: "US",
      },
    });
    assert.equal(photon.place, "Disneys-Fort-Wilderness-Resort-and-Campground");
    assert.equal(photon.locality, "Bay-Lake-FL");

    const nom = fn.placeFromNominatim({
      name: "Main Street",
      addresstype: "road",
      class: "highway",
      type: "residential",
      address: { road: "Main Street", city: "Orlando", state: "Florida", country_code: "us" },
    });
    assert.equal(nom.place, "");
    assert.equal(nom.locality, "Orlando-FL");
  });
});

describe("resolveExportZipName", () => {
  it("uses a picked search result and does not call the geocoder", async () => {
    let called = 0;
    fn.setLookupForTests(() => {
      called += 1;
      return { place: "Should-Not-Run", locality: "X" };
    });
    const name = await fn.resolveExportZipName({
      pickedPlace: { name: "Fort Wilderness", locality: "Orlando, FL" },
      ...FORT,
      areaM2: 1.2e6,
      now: NOW,
    });
    assert.equal(name, "Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip");
    assert.equal(called, 0);
  });

  it("ignores a typed street address and reverse-geocodes instead", async () => {
    fn.setLookupForTests(() => ({ place: "Lake-Eola-Park", locality: "Orlando-FL" }));
    const name = await fn.resolveExportZipName({
      name: "123 Main Street, Orlando",
      ...FORT,
      areaM2: 1.2e6,
      now: NOW,
    });
    assert.equal(name, "Lake-Eola-Park_Orlando-FL_1.2km2_20261124.zip");
  });

  it("falls back to coordinates when the lookup is slow or empty", async () => {
    fn.setLookupForTests(() => new Promise(() => {}));
    const name = await fn.resolveExportZipName({
      lat: 28.405,
      lon: -81.573,
      areaM2: 1.2e6,
      now: NOW,
      timeoutMs: 30,
    });
    assert.equal(name, "28.41N_81.57W_1.2km2_20261124.zip");
  });

  it("uses a search-box auto label without a network call", async () => {
    fn.setLookupForTests(() => {
      throw new Error("should not look up");
    });
    const name = await fn.resolveExportZipName({
      name: "Williams KOA Journey - Williams, AZ",
      ...KOA,
      now: NOW,
    });
    assert.match(name, /^Williams-KOA-Journey_Williams-AZ_\d+(\.\d+)?(ha|km2|m2)_20261124\.zip$/);
  });

  it("fills a missing locality from a fast reverse lookup", async () => {
    fn.setLookupForTests(() => ({ place: "Ignored-Feature", locality: "Las-Vegas-NV" }));
    const name = await fn.resolveExportZipName({
      name: "Wynn Golf",
      ...WYNN,
      now: NOW,
    });
    assert.match(name, /^Wynn-Golf_Las-Vegas-NV_\d+(\.\d+)?km2_20261124\.zip$/);
  });
});

describe("safeZipFilename", () => {
  it("keeps ASCII slugs and forces a .zip suffix", () => {
    assert.equal(fn.safeZipFilename("Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip"), "Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip");
    assert.equal(fn.safeZipFilename("weird name.zip"), "weird-name.zip");
  });
});
