"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/nls-hamina-sample.json");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter, validateOiArea } = require("../netlify/lib/pipeline");
const { unzipStore } = require("../netlify/lib/zip-store");
const {
  materialForBuilding,
  liftPickedBuilding,
  canonicalAreaMaterial,
  isPoisonedOiName,
  isMeasuredBuildingOiName,
} = require("../netlify/lib/materials");
const {
  NLS_API_KEY_ENV,
  nlsApiKey,
  cellMetres,
  heightForRing,
  applyNlsBuildingHeights,
  lonLatToTm35,
} = require("../netlify/lib/nls-building-height");

function squareFeature(west, south, east, north, props) {
  return {
    type: "Feature",
    properties: props || {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}

describe("NLS Hamina building heights", () => {
  it("reads the laser grid at the fixture cells", () => {
    const roofCol = Math.floor((fixture.roof.e - fixture.originE) / fixture.cellM);
    const roofRow = Math.floor((fixture.roof.n - fixture.originN) / fixture.cellM);
    assert.equal(cellMetres(roofCol, roofRow), fixture.roof.dm / 10);
    const groundCol = Math.floor((fixture.ground.e - fixture.originE) / fixture.cellM);
    const groundRow = Math.floor((fixture.ground.n - fixture.originN) / fixture.cellM);
    assert.equal(cellMetres(groundCol, groundRow), 0);
    const [e, n] = lonLatToTm35(fixture.roof.lon, fixture.roof.lat);
    assert.ok(Math.abs(e - fixture.roof.e) < 0.05);
    assert.ok(Math.abs(n - fixture.roof.n) < 0.05);
  });

  it("samples a varied roof height inside a downtown ring", () => {
    assert.equal(heightForRing(fixture.ring), fixture.ringHeightM);
    assert.ok(fixture.ringHeightM > 2);
    assert.notEqual(fixture.ringHeightM, 4.5);
    assert.notEqual(fixture.ringHeightM, 7.620092660326749);
  });

  it("does not replace an overture or FEMA height", () => {
    const ring = fixture.ring;
    const west = ring[0][0];
    const south = ring[0][1];
    const east = ring[2][0];
    const north = ring[2][1];
    const features = [
      squareFeature(west, south, east, north, { height: 12, heightSource: "overture" }),
      squareFeature(west + 0.0004, south, east + 0.0004, north, { height: 9, heightSource: "fema" }),
      squareFeature(west, south, east, north, { height: 3, heightSource: "overture-floors" }),
    ];
    const out = applyNlsBuildingHeights(features);
    assert.equal(features[0].properties.height, 12);
    assert.equal(features[0].properties.heightSource, "overture");
    assert.equal(features[1].properties.height, 9);
    assert.equal(features[1].properties.heightSource, "fema");
    assert.equal(features[2].properties.heightSource, "nls-laser");
    assert.equal(features[2].properties.height, fixture.ringHeightM);
    assert.equal(out.applied, 1);
  });

  it("emits Building - H.H on the dev path and leaves the US stock bins alone", () => {
    const ring = fixture.ring;
    const frame = geoFrame({
      west: ring[0][0] - 0.0003,
      south: ring[0][1] - 0.0002,
      east: ring[2][0] + 0.0003,
      north: ring[2][1] + 0.0002,
      name: "Hamina center",
    });
    const feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    const off = buildClutter({
      frame,
      footprintsGeojson: { features: [JSON.parse(JSON.stringify(feature))] },
      treePoints: [],
      name: "Hamina off",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const offName = off.openintent.floorplans[0].attenuation_areas[0].area_material.name;
    assert.equal(offName.startsWith("Building - "), true);
    assert.equal(isMeasuredBuildingOiName(offName), false);

    const on = buildClutter({
      frame,
      footprintsGeojson: { features: [JSON.parse(JSON.stringify(feature))] },
      treePoints: [],
      name: "Hamina on",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      nlsHeights: true,
    });
    const area = on.openintent.floorplans[0].attenuation_areas[0];
    assert.equal(area.area_material.name, "Building - " + fixture.ringHeightM.toFixed(1));
    assert.equal(area.area_material.top_height, fixture.ringHeightM);
    assert.equal("bottom_height" in area.area_material, false);
    assert.equal(isPoisonedOiName(area.area_material.name), false);
    assert.equal(validateOiArea(area, frame.imgW, frame.imgH).ok, true);
    const cat = on.openintent.area_materials.find((m) => m.name === area.area_material.name);
    assert.deepEqual(area.area_material, cat);
    assert.equal(on.stats.nlsHeights, 1);
    assert.equal(on.stats.nlsHeightMin, fixture.ringHeightM);
    assert.equal(on.stats.nlsHeightMax, fixture.ringHeightM);
    const files = unzipStore(on.zip);
    const readme = files["README.txt"].toString();
    assert.match(readme, /National Land Survey of Finland/);
    assert.match(readme, /CC BY 4\.0/);
    assert.match(readme, /Building - H\.H/);
    assert.doesNotMatch(readme, /Building N\.N m is the material/);
    const clipId = "bldg-m-" + fixture.ringHeightM.toFixed(1).replace(".", "_");
    assert.ok(on.clipboard.attenuatingZoneTypes.some((t) => t.id === clipId && t.topEdge === fixture.ringHeightM));

    const vegas = geoFrame({ west: -115.18, south: 36.12, east: -115.16, north: 36.14, name: "Vegas" });
    const dLon = (vegas.east - vegas.west) * 0.04;
    const dLat = (vegas.north - vegas.south) * 0.03;
    const us = buildClutter({
      frame: vegas,
      footprintsGeojson: {
        features: [
          squareFeature(
            vegas.west + dLon,
            vegas.south + dLat,
            vegas.west + dLon * 2,
            vegas.south + dLat * 2,
            { height: 6.41, heightSource: "fema" }
          ),
        ],
      },
      treePoints: [],
      name: "Oak Creek style",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      nlsHeights: true,
    });
    assert.equal(us.openintent.floorplans[0].attenuation_areas[0].area_material.name, "Building - Two Floor");
    assert.equal(us.stats.nlsHeights, 0);
    assert.doesNotMatch(unzipStore(us.zip)["README.txt"].toString(), /National Land Survey of Finland/);
  });

  it("lifts a measured thickness onto a slope without using the poisoned name", () => {
    const picked = materialForBuilding(8.3, 120, { exactMetres: true });
    assert.equal(picked.material.name, "Building - 8.3");
    assert.equal(picked.material.top_height, 8.3);
    assert.equal(canonicalAreaMaterial(picked.material).name, "Building - 8.3");
    const lifted = liftPickedBuilding(picked, 3.2);
    assert.equal(lifted.material.name, "Building - 8.3 @ 3.2");
    assert.equal(lifted.material.bottom_height, 3.2);
    assert.equal(lifted.material.top_height, 11.5);
    assert.equal(Math.round((lifted.material.top_height - lifted.material.bottom_height) * 10) / 10, 8.3);
    assert.equal(lifted.buildingHeight, 8.3);
    assert.equal(isPoisonedOiName(lifted.material.name), false);
    assert.deepEqual(canonicalAreaMaterial(lifted.material), lifted.material);
    const stock = liftPickedBuilding(materialForBuilding(6.4, 100), 10);
    assert.equal(stock.material.name, "Building - Two Floor 10.0");
    assert.equal(isMeasuredBuildingOiName(stock.material.name), false);
  });

  it("reads NLS_API_KEY and does not invent one", () => {
    const prev = process.env[NLS_API_KEY_ENV];
    delete process.env[NLS_API_KEY_ENV];
    assert.equal(nlsApiKey(), "");
    process.env[NLS_API_KEY_ENV] = "  coordinator-key  ";
    assert.equal(nlsApiKey(), "coordinator-key");
    if (prev == null) delete process.env[NLS_API_KEY_ENV];
    else process.env[NLS_API_KEY_ENV] = prev;
  });
});
