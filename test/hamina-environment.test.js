"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, OPENINTENT_VERSION, HAMINA_ENVIRONMENT } = require("../netlify/lib/pipeline");
const exportMode = require("../netlify/lib/export-mode");
const { emptyClipboard } = require("../netlify/lib/hamina-clipboard");

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

  it("adds hamina_properties on /dev and keeps openintent_version at 2.0.1", () => {
    exportMode.setHaminaEnvironment(true);
    const built = tinyExport();
    assert.equal(built.openintent.openintent_version, "2.0.1");
    assert.deepEqual(built.openintent.hamina_properties, {
      environment: "Outdoor (Trees / Foliage)",
    });
    assert.equal(HAMINA_ENVIRONMENT, "Outdoor (Trees / Foliage)");
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
    assert.deepEqual(oiZip.hamina_properties, { environment: "Outdoor (Trees / Foliage)" });
    assert.equal(oiZip.openintent_version, "2.0.1");
    // HaminaClipboard (Copy terrain) has no equivalent project-type root.
    assert.equal("hamina_properties" in built.clipboard, false);
    assert.equal(built.clipboard.header.type, "HaminaClipboard");
    const empty = emptyClipboard();
    assert.equal("hamina_properties" in empty, false);
    assert.equal("environment" in empty.header, false);
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
