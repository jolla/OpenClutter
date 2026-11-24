"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fn = require("../netlify/lib/export-filename");
const nominatim = require("../netlify/lib/nominatim");

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
        osm_value: "camp_site",
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

describe("enclosing area fallback", () => {
  const FW = { west: -81.57, south: 28.3935, east: -81.546, north: 28.4135 };
  const KOA = { west: -112.15926, south: 35.32465, east: -112.15474, north: 35.32957 };
  const WYNN = { west: -115.1735, south: 36.1205, east: -115.1488, north: 36.1355 };
  const PISMO = { west: -120.6398, south: 35.131, east: -120.6346, north: 35.137 };
  const TORONTO = { west: -79.39, south: 43.645, east: -79.375, north: 43.655 };
  const NOW = new Date("2026-11-24T15:30:00Z");

  it("treats Possum Path and other road loops as roads, not places", () => {
    assert.equal(fn.isRoadOrPath({ name: "Possum Path", osm_key: "highway", osm_value: "service", type: "street" }), true);
    assert.equal(fn.isRoadOrPath({ name: "Erin Court", osm_key: "highway", osm_value: "residential", type: "street" }), true);
    assert.equal(fn.isRoadOrPath({ name: "Disney's Fort Wilderness Campground", osm_key: "tourism", osm_value: "camp_site" }), false);
  });

  it("picks the enclosing campground over a road loop at the centre of Fort Wilderness", () => {
    const picked = fn.pickEnclosingPlace(
      [
        { properties: { name: "Possum Path", osm_key: "highway", osm_value: "service", type: "street", district: "Bay Lake", state: "Florida", countrycode: "US", extent: [-81.5587, 28.4039, -81.5578, 28.4027] } },
        { properties: { name: "Disney's Fort Wilderness Campground", osm_key: "tourism", osm_value: "camp_site", type: "house", city: "KIss", district: "Bay Lake", state: "Florida", countrycode: "US", extent: [-81.5635, 28.4134, -81.5502, 28.3937] } },
        { properties: { name: "Comfort Station", osm_key: "amenity", osm_value: "toilets", type: "house", district: "Bay Lake", state: "Florida", countrycode: "US" } },
      ],
      FW
    );
    assert.equal(picked.place, "Disneys-Fort-Wilderness-Campground");
    assert.equal(picked.locality, "Bay-Lake-FL");
  });

  it("picks a nearby KOA campground over the street at the centre", () => {
    const picked = fn.pickEnclosingPlace(
      [
        { properties: { name: "Erin Court", osm_key: "highway", osm_value: "residential", type: "street", county: "Coconino", state: "Arizona", countrycode: "US" } },
        { properties: { name: "Shell", osm_key: "amenity", osm_value: "fuel", type: "house", county: "Coconino", state: "Arizona", countrycode: "US" } },
        { properties: { name: "KOA Campground", osm_key: "tourism", osm_value: "caravan_site", type: "house", county: "Coconino", state: "Arizona", countrycode: "US" } },
      ],
      KOA
    );
    assert.equal(picked.place, "KOA-Campground");
    assert.equal(picked.locality, "AZ");
  });

  it("picks the Pismo RV park that covers the box, not a house or a lane", () => {
    const picked = fn.pickEnclosingPlace(
      [
        { properties: { osm_key: "place", osm_value: "house", type: "house", street: "South Dolliver Street", city: "Pismo Beach", state: "California", countrycode: "US" } },
        { properties: { name: "Shoreline Lane", osm_key: "highway", osm_value: "service", type: "street", city: "Pismo Beach", state: "California", countrycode: "US" } },
        { properties: { name: "Pismo Coast Village RV Resort", osm_key: "tourism", osm_value: "caravan_site", type: "house", city: "Pismo Beach", state: "California", countrycode: "US", extent: [-120.6394, 35.1365, -120.6351, 35.1316] } },
      ],
      PISMO
    );
    assert.equal(picked.place, "Pismo-Coast-Village-RV-Resort");
    assert.equal(picked.locality, "Pismo-Beach-CA");
  });

  it("falls back to city and state when a dense-city or large-strip box has no enclosing site", () => {
    assert.deepEqual(
      fn.pickEnclosingPlace(
        [
          { properties: { name: "Encore Resort Boulevard", osm_key: "highway", osm_value: "service", type: "street", city: "Winchester", state: "Nevada", countrycode: "US" } },
          { properties: { name: "EY Tower", osm_key: "building", osm_value: "yes", type: "house", city: "Toronto", state: "Ontario", countrycode: "CA" } },
        ],
        WYNN
      ),
      { place: "", locality: "Winchester-NV" }
    );
  });

  it("names five unsearched boxes from a Photon reverse list, not the first road hit", async () => {
    const replies = {
      fw: {
        features: [
          { properties: { name: "Possum Path", osm_key: "highway", osm_value: "service", type: "street", district: "Bay Lake", state: "Florida", countrycode: "US", extent: [-81.5587, 28.4039, -81.5578, 28.4027] } },
          { properties: { name: "Disney's Fort Wilderness Campground", osm_key: "tourism", osm_value: "camp_site", district: "Bay Lake", state: "Florida", countrycode: "US", extent: [-81.5635, 28.4134, -81.5502, 28.3937] } },
        ],
      },
      koa: {
        features: [
          { properties: { name: "Erin Court", osm_key: "highway", osm_value: "residential", type: "street", state: "Arizona", countrycode: "US" } },
          { properties: { name: "KOA Campground", osm_key: "tourism", osm_value: "caravan_site", state: "Arizona", countrycode: "US" } },
        ],
      },
      wynn: {
        features: [
          { properties: { name: "Encore Resort Boulevard", osm_key: "highway", osm_value: "service", type: "street", city: "Winchester", state: "Nevada", countrycode: "US" } },
        ],
      },
      pismo: {
        features: [
          { properties: { osm_key: "place", osm_value: "house", type: "house", city: "Pismo Beach", state: "California", countrycode: "US" } },
          { properties: { name: "Pismo Coast Village RV Resort", osm_key: "tourism", osm_value: "caravan_site", city: "Pismo Beach", state: "California", countrycode: "US", extent: [-120.6394, 35.1365, -120.6351, 35.1316] } },
        ],
      },
      toronto: {
        features: [
          { properties: { name: "EY Tower", osm_key: "building", osm_value: "yes", type: "house", city: "Toronto", state: "Ontario", countrycode: "CA" } },
          { properties: { name: "Sheppard Street", osm_key: "highway", osm_value: "residential", type: "street", city: "Toronto", state: "Ontario", countrycode: "CA" } },
        ],
      },
    };
    const nomi = {
      fw: { name: "Bay Lake", address: { state: "Florida", country_code: "us" } },
      koa: { name: "Red Lake", address: { village: "Red Lake", state: "Arizona", country_code: "us" } },
      wynn: { name: "Winchester", address: { town: "Winchester", state: "Nevada", country_code: "us" } },
      pismo: { name: "Pismo Beach", address: { village: "Pismo Beach", state: "California", country_code: "us" } },
      toronto: { name: "Toronto", address: { city: "Toronto", state: "Ontario", country_code: "ca" } },
    };
    function siteOf(url) {
      if (url.includes("-81.55")) return "fw";
      if (url.includes("-112.15")) return "koa";
      if (url.includes("-115.16")) return "wynn";
      if (url.includes("-120.63")) return "pismo";
      if (url.includes("-79.38")) return "toronto";
      return "";
    }
    const stubFetch = async (url) => {
      const site = siteOf(String(url));
      if (String(url).includes("photon.komoot.io")) {
        return { ok: true, json: async () => replies[site] || { features: [] } };
      }
      return { ok: true, json: async () => nomi[site] || {} };
    };
    fn.setLookupForTests();
    const names = {};
    for (const [id, box] of [
      ["fw", FW],
      ["koa", KOA],
      ["wynn", WYNN],
      ["pismo", PISMO],
      ["toronto", TORONTO],
    ]) {
      nominatim._setStore(null);
      names[id] = await fn.resolveExportZipName({
        name: "Site",
        ...box,
        now: NOW,
        fetch: stubFetch,
      });
    }
    assert.equal(names.fw, "Disneys-Fort-Wilderness_Bay-Lake-FL_5.2km2_20261124.zip");
    assert.equal(names.koa, "KOA-Campground_AZ_22ha_20261124.zip");
    assert.match(names.wynn, /^Winchester-NV_[0-9.]+km2_20261124\.zip$/);
    assert.equal(names.pismo, "Pismo-Coast-Village-RV_Pismo-Beach-CA_31ha_20261124.zip");
    assert.match(names.toronto, /^Toronto-ON_[0-9.]+(ha|km2|m2)_20261124\.zip$/);
    assert.equal(names.fw.includes("Possum"), false);
    assert.equal(names.koa.includes("Erin"), false);
    assert.equal(names.wynn.includes("Boulevard"), false);
    assert.equal(names.toronto.includes("Sheppard"), false);
    assert.equal(names.toronto.includes("EY-Tower"), false);
  });

  it("keeps the Photon enclosing place when Nominatim uses the full lookup budget", async () => {
    const fwFeatures = {
      features: [
        { properties: { name: "Possum Path", osm_key: "highway", osm_value: "service", type: "street", district: "Bay Lake", state: "Florida", countrycode: "US" } },
        { properties: { name: "Disney's Fort Wilderness Campground", osm_key: "tourism", osm_value: "camp_site", type: "house", city: "KIss", district: "Bay Lake", state: "Florida", countrycode: "US", extent: [-81.5635, 28.4134, -81.5502, 28.3937] } },
      ],
    };
    const fetchImpl = async (url) => {
      if (String(url).includes("photon.komoot.io")) {
        return { ok: true, json: async () => fwFeatures };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true, json: async () => ({ address: { city: "Bay Lake", state: "Florida", country_code: "us" } }) };
    };
    fn.setLookupForTests();
    const t0 = Date.now();
    const name = await fn.resolveExportZipName({
      name: "Site",
      ...FW,
      now: NOW,
      timeoutMs: 80,
      fetch: fetchImpl,
    });
    assert.equal(name, "Disneys-Fort-Wilderness_Bay-Lake-FL_5.2km2_20261124.zip");
    assert.equal(Date.now() - t0 < 200, true);
  });
});

describe("safeZipFilename", () => {
  it("keeps ASCII slugs and forces a .zip suffix", () => {
    assert.equal(fn.safeZipFilename("Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip"), "Fort-Wilderness_Orlando-FL_1.2km2_20261124.zip");
    assert.equal(fn.safeZipFilename("weird name.zip"), "weird-name.zip");
  });
});
