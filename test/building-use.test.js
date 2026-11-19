"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyBuildingUse,
  dbForBuildingUse,
  usesCustomBuildingMaterial,
  copyOsmUseTags,
} = require("../netlify/lib/building-use");
const {
  materialForBuilding,
  canonicalAreaMaterial,
  liftPickedBuilding,
  documentMaterials,
} = require("../netlify/lib/materials");

function db(mat) {
  return mat && mat.rf_properties && mat.rf_properties.attenuation_per_m;
}

describe("building use classification", () => {
  it("maps OSM tags to the agreed dB/m values and leaves unknown at 5", () => {
    const cases = [
      [{ building: "house" }, "wood", 3],
      [{ building: "apartments" }, "wood", 3],
      [{ "building:material": "wood" }, "wood", 3],
      [{ building: "shed" }, "shed", 2],
      [{ building: "garage" }, "shed", 2],
      [{ building: "carport" }, "carport", 0.5],
      [{ amenity: "carport" }, "carport", 0.5],
      [{ material: "brick" }, "masonry", 5],
      [{ building: "retail" }, "bigbox", 6],
      [{ shop: "supermarket" }, "bigbox", 6],
      [{ name: "Walmart Supercenter" }, "bigbox", 6],
      [{ building: "school" }, "civic", 6],
      [{ amenity: "hospital" }, "civic", 6],
      [{ building: "skyscraper" }, "glass", 6],
      [{ building: "office", height: 40 }, "glass", 6],
      [{ material: "glass" }, "glass", 6],
      [{ building: "warehouse" }, "metal", 8],
      [{ building: "hangar" }, "metal", 8],
      [{ building: "parking" }, "parking", 2],
      [{ class: "parking" }, "parking", 2],
      [{ parking: "multi-storey" }, "parking", 2],
      [{ building: "yes" }, null, 5],
      [{}, null, 5],
    ];
    for (const [props, id, expectedDb] of cases) {
      const type = classifyBuildingUse(props);
      assert.equal(type && type.id, id, JSON.stringify(props));
      assert.equal(dbForBuildingUse(type), expectedDb, JSON.stringify(props) + " db");
    }
  });

  it("prefers a shed over a metal warehouse when both could apply", () => {
    const type = classifyBuildingUse({ building: "shed", material: "metal" });
    assert.equal(type.id, "shed");
    assert.equal(type.db, 2);
  });

  it("does not treat a short office as a glass tower", () => {
    assert.equal(classifyBuildingUse({ building: "office", height: 8 }), null);
  });
});

describe("typed building materials", () => {
  it("keeps stock 5 dB/m gold names for unknown and masonry", () => {
    const unknown = materialForBuilding(4.5, 80);
    assert.equal(unknown.material.name, "Building - One Floor");
    assert.equal(db(unknown.material), 5);
    assert.deepEqual(canonicalAreaMaterial(unknown.material), unknown.material);

    const masonry = materialForBuilding(4.5, 80, { use: { material: "brick" } });
    assert.equal(masonry.material.name, "Building - One Floor");
    assert.equal(db(masonry.material), 5);
  });

  it("emits a custom named object at the type dB/m, and the catalog keeps it", () => {
    const wood = materialForBuilding(4.5, 80, { use: { building: "house" } });
    assert.equal(wood.material.name, "Building - Wood frame 4.5");
    assert.equal(db(wood.material), 3);
    assert.equal(canonicalAreaMaterial(wood.material).name, wood.material.name);

    const metal = materialForBuilding(12, 2000, { use: { building: "warehouse" }, exactMetres: true });
    assert.equal(metal.material.name, "Building - Metal warehouse 12.0");
    assert.equal(db(metal.material), 8);

    const carport = materialForBuilding(4.5, 40, { use: { building: "carport" } });
    assert.equal(carport.material.name, "Building - Carport 4.5");
    assert.equal(db(carport.material), 0.5);

    const catalog = documentMaterials([{ area_material: wood.material }, { area_material: metal.material }]);
    assert.ok(catalog.some((m) => m.name === "Building - Wood frame 4.5"));
    assert.ok(catalog.some((m) => m.name === "Building - Metal warehouse 12.0"));
  });

  it("lifts a typed material on a slope and still canonicalizes", () => {
    const picked = materialForBuilding(4.5, 80, { use: { building: "house" } });
    const lifted = liftPickedBuilding(picked, 3.2);
    assert.equal(lifted.material.name, "Building - Wood frame 4.5 @ 3.2");
    assert.equal(db(lifted.material), 3);
    assert.equal(lifted.material.bottom_height, 3.2);
    assert.equal(canonicalAreaMaterial(lifted.material).name, lifted.material.name);
    assert.equal(usesCustomBuildingMaterial(classifyBuildingUse({ building: "house" })), true);
    assert.equal(usesCustomBuildingMaterial(classifyBuildingUse({ material: "brick" })), false);
  });
});

describe("copyOsmUseTags", () => {
  it("copies OSM tags onto a matching footprint and leaves a miss alone", () => {
    const house = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ];
    house.osmTags = { building: "house", name: "12 Oak" };
    const features = [
      {
        type: "Feature",
        properties: { geomSource: "overture" },
        geometry: { type: "Polygon", coordinates: [[[0.05, 0.05], [0.05, 0.95], [0.95, 0.95], [0.95, 0.05], [0.05, 0.05]]] },
      },
      {
        type: "Feature",
        properties: { geomSource: "overture" },
        geometry: { type: "Polygon", coordinates: [[[10, 10], [10, 11], [11, 11], [11, 10], [10, 10]]] },
      },
    ];
    const n = copyOsmUseTags(features, [house]);
    assert.equal(n, 1);
    assert.equal(features[0].properties.building, "house");
    assert.equal(features[0].properties.name, "12 Oak");
    assert.equal(features[1].properties.building, undefined);
  });
});
