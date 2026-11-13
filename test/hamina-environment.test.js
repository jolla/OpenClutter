"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, OPENINTENT_VERSION, HAMINA_ENVIRONMENT, HAMINA_ENVIRONMENT_TREES, HAMINA_ENVIRONMENT_OPEN, haminaEnvironmentFor } = require("../netlify/lib/pipeline");
const exportMode = require("../netlify/lib/export-mode");
const { emptyClipboard } = require("../netlify/lib/hamina-clipboard");
const { canopyHitsGrid } = require("./canopy-grid");

const BOX = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
  name: "Wynn Golf",
};

function squareFeature(west, south, east, north) {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}

function tinyExport() {
  const frame = geoFrame(BOX);
  const dLon = (frame.east - frame.west) * 0.02;
  const dLat = (frame.north - frame.south) * 0.02;
  const lon0 = frame.west + dLon * 4;
  const lat0 = frame.south + dLat * 4;
  return buildClutter({
    frame,
    footprintsGeojson: { features: [squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat)] },
    name: "Wynn Golf",
    imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
}

describe("hamina_properties.environment on /dev OpenIntent exports", () => {
  afterEach(() => exportMode.setHaminaEnvironment(false));

  it("keeps the production root keys when the switch is off", () => {
    exportMode.setHaminaEnvironment(false);
    const built = tinyExport();
    assert.equal(built.openintent.openintent_version, "2.0.1");
    assert.equal(OPENINTENT_VERSION, "2.0.1");
    assert.equal("hamina_properties" in built.openintent, false);
    assert.deepEqual(Object.keys(built.openintent).sort(), [
      "area_materials",
      "floorplans",
      "openintent_version",
      "switches",
      "wall_materials",
    ]);
    assert.equal("hamina_properties" in built.clipboard, false);
    assert.equal("environment" in built.clipboard.header, false);
  });

  it("uses Outdoor (Open) when the zip has no canopy, and keeps openintent_version at 2.0.1", () => {
    exportMode.setHaminaEnvironment(true);
    const built = tinyExport();
    assert.equal(built.openintent.openintent_version, "2.0.1");
    assert.equal(built.stats.openIntentTreeAreas || 0, 0);
    assert.deepEqual(built.openintent.hamina_properties, {
      environment: "Outdoor (Open)",
    });
    assert.equal(HAMINA_ENVIRONMENT_OPEN, "Outdoor (Open)");
    assert.equal(HAMINA_ENVIRONMENT, "Outdoor (Trees / Foliage)");
    assert.equal(HAMINA_ENVIRONMENT_TREES, "Outdoor (Trees / Foliage)");
    assert.deepEqual(Object.keys(built.openintent).sort(), [
      "area_materials",
      "floorplans",
      "hamina_properties",
      "openintent_version",
      "switches",
      "wall_materials",
    ]);
    const keys = Object.keys(built.openintent);
    assert.equal(keys[0], "openintent_version");
    assert.equal(keys[1], "hamina_properties");
    const zipped = require("../netlify/lib/zip-store").unzipStore(built.zip);
    const oiZip = JSON.parse(zipped[`openIntent_${built.slug}.json`].toString());
    assert.deepEqual(oiZip.hamina_properties, { environment: "Outdoor (Open)" });
    assert.equal(oiZip.openintent_version, "2.0.1");
    // HaminaClipboard (Copy terrain) has no equivalent project-type root.
    assert.equal("hamina_properties" in built.clipboard, false);
    assert.equal(built.clipboard.header.type, "HaminaClipboard");
    const empty = emptyClipboard();
    assert.equal("hamina_properties" in empty, false);
    assert.equal("environment" in empty.header, false);
  });

  it("uses Outdoor (Trees / Foliage) when the zip has canopy", () => {
    exportMode.setHaminaEnvironment(true);
    const frame = geoFrame(BOX);
    const dLon = (frame.east - frame.west) * 0.02;
    const dLat = (frame.north - frame.south) * 0.02;
    const lon = frame.west + dLon * 4;
    const lat = frame.south + dLat * 4;
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [
        { lon, lat, pct: 80, heightM: 14.2, median: true },
        { lon: lon + 0.00001, lat, pct: 70, median: true },
      ],
      canopyHits: canopyHitsGrid(frame, lon, lat, { cols: 3, rows: 2, pct: 80 }),
      name: "Wynn Trees",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "nlcd-canopy",
      includeFoliage: true,
      heightSample: () => 14.2,
    });
    assert.ok(built.stats.openIntentTreeAreas >= 1);
    assert.equal(built.openintent.openintent_version, "2.0.1");
    assert.deepEqual(built.openintent.hamina_properties, {
      environment: "Outdoor (Trees / Foliage)",
    });
    const zipped = require("../netlify/lib/zip-store").unzipStore(built.zip);
    const oiZip = JSON.parse(zipped[`openIntent_${built.slug}.json`].toString());
    assert.deepEqual(oiZip.hamina_properties, { environment: "Outdoor (Trees / Foliage)" });
  });

  it("picks the Hamina environment from whether the areas include foliage", () => {
    assert.equal(haminaEnvironmentFor([], []), "Outdoor (Open)");
    assert.equal(
      haminaEnvironmentFor([{ area_material: { name: "Building - One Floor" } }]),
      "Outdoor (Open)"
    );
    assert.equal(
      haminaEnvironmentFor([{ area_material: { name: "Foliage - Heavy 11.2 @ 3.0" } }]),
      "Outdoor (Trees / Foliage)"
    );
    assert.equal(
      haminaEnvironmentFor([], [{ name: "Foliage - Light" }]),
      "Outdoor (Trees / Foliage)"
    );
  });

  it("is wired to /dev hosts only", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(
      src,
      /exportMode\.setHaminaEnvironment\(\s*exportMode\.haminaEnvironmentWanted\(testHost, body, event && event\.queryStringParameters\),\s*\);/
    );
    assert.equal(exportMode.haminaEnvironmentWanted(false, {}), false);
    assert.equal(exportMode.haminaEnvironmentWanted(true, {}), true);
    assert.equal(exportMode.haminaEnvironmentWanted(true, { haminaEnvironment: false }), false);
    assert.equal(exportMode.haminaEnvironmentWanted(true, { haminaEnvironment: "0" }), false);
    assert.equal(exportMode.haminaEnvironmentWanted(false, { haminaEnvironment: true }), false);
  });
});
