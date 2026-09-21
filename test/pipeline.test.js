"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, llToClipboard, cornerClipboard } = require("../netlify/lib/geo-frame");
const {
  ZONE_TYPES,
  emptyClipboard,
  CLIPBOARD_COLLECTION_KEYS,
  pickBuildingTypeId,
} = require("../netlify/lib/hamina-clipboard");
const { buildClutter, ringAreaM2, MAX_AREA_M2, MIN_AREA_M2 } = require("../netlify/lib/pipeline");
const { zipStore, unzipStore } = require("../netlify/lib/zip-store");

const WYNN = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
  name: "Wynn Golf",
};

function squareFeature(west, south, east, north, props = {}) {
  return {
    type: "Feature",
    properties: props,
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

describe("HaminaClipboard schema", () => {
  it("header, zone types, and empty collections match the working paste schema", () => {
    const clip = emptyClipboard("00000000-0000-4000-8000-000000000000");
    assert.deepEqual(clip.header, {
      type: "HaminaClipboard",
      version: [1, 0, 0],
      id: "00000000-0000-4000-8000-000000000000",
    });
    for (const k of CLIPBOARD_COLLECTION_KEYS) {
      assert.ok(Array.isArray(clip[k]), k);
      assert.equal(clip[k].length, 0);
    }
    const names = ZONE_TYPES.map((t) => t.name);
    assert.deepEqual(names, [
      "Foliage - Heavy",
      "Foliage - Light",
      "Tree Trunk",
      "Building - One Floor",
      "Building - Five Floor",
      "Hotel podium",
    ]);
    for (const t of ZONE_TYPES) {
      assert.equal(typeof t.ituRModelEnabled, "boolean");
      assert.equal(typeof t.transparencyEnabled, "boolean");
      assert.ok("bottomEdge" in t);
      assert.ok("shortcutKey" in t);
    }
    assert.equal(ZONE_TYPES.find((t) => t.id === "foliage-heavy").transparencyEnabled, true);
    assert.equal(ZONE_TYPES.find((t) => t.id === "bldg-one").transparencyEnabled, false);
  });
});

describe("pipeline: footprints + trees share the frame", () => {
  it("clipboard building vertices use the same widthM/lengthM as the zip", () => {
    const frame = geoFrame(WYNN);
    const dLon = (frame.east - frame.west) * 0.02;
    const dLat = (frame.north - frame.south) * 0.02;
    const lon0 = frame.west + dLon * 4;
    const lat0 = frame.south + dLat * 4;
    const gj = {
      features: [squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat)],
    };
    const imgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const built = buildClutter({
      frame,
      footprintsGeojson: gj,
      treePoints: [{ lon: lon0 + dLon / 2, lat: lat0 + dLat * 8 }],
      name: "Wynn Golf",
      imgBuf,
      treesSource: "nlcd-canopy",
    });
    const meters = built.openintent.floorplans[0].dimensions.find((d) => d.unit === "meters");
    assert.equal(meters.width, frame.widthM);
    assert.equal(meters.length, frame.lengthM);
    assert.equal(built.clipboard.header.type, "HaminaClipboard");
    assert.equal(built.stats.buildings, 1);
    assert.equal(built.stats.trees, 1);
    assert.equal(built.stats.treesSource, "nlcd-canopy");
    const bldg = built.clipboard.attenuatingZones.find((z) => z.typeId.startsWith("bldg"));
    const tree = built.clipboard.attenuatingZones.find((z) => z.typeId === "tree-trunk");
    assert.ok(bldg);
    assert.ok(tree);
    const corners = cornerClipboard(frame);
    for (const [x, y] of bldg.area.coordinates[0]) {
      assert.ok(x >= corners.sw[0] - 1 && x <= corners.ne[0] + 1);
      assert.ok(y >= corners.sw[1] - 1 && y <= corners.ne[1] + 1);
    }
    const expected = llToClipboard(lon0, lat0, frame);
    const got = bldg.area.coordinates[0][0];
    assert.ok(Math.abs(got[0] - expected[0]) < 0.05);
    assert.ok(Math.abs(got[1] - expected[1]) < 0.05);
    assert.ok(built.zip.length > 100);
    assert.equal(built.openintent.openintent_version, "2.0.1");
    const zipped = unzipStore(built.zip);
    assert.ok(zipped[`openIntent_${built.slug}.json`]);
    assert.ok(zipped[`images/${built.slug}.jpg`]);
    assert.ok(zipped["export-warnings.json"]);
    assert.ok(zipped["hamina-clipboard.json"]);
    assert.ok(zipped["README.txt"]);
    const fromZip = JSON.parse(zipped["hamina-clipboard.json"].toString());
    assert.equal(fromZip.header.type, "HaminaClipboard");
    assert.deepEqual(fromZip.attenuatingZones, built.clipboard.attenuatingZones);
    assert.match(zipped["README.txt"].toString(), /hamina-clipboard\.json/);
    assert.ok(zipped["alignment-overlay.svg"]);
    assert.ok(zipped["frame-lock.json"]);
    const svg = zipped["alignment-overlay.svg"].toString();
    assert.match(svg, /images\/Wynn-Golf\.jpg/);
    assert.match(svg, /polygon /);
    const lock = JSON.parse(zipped["frame-lock.json"].toString());
    assert.equal(lock.clipboard.convention.includes("NE"), true);
    assert.equal(lock.openintent.yRelation, "y_up + y_img = imgH");
    assert.equal(Object.keys(zipped).length, 7);
  });

  it("drops campus mega-polygons and tiny sheds", () => {
    const frame = geoFrame(WYNN);
    const mega = squareFeature(frame.west, frame.south, frame.east, frame.north);
    const tinyLon = frame.west + 0.00001;
    const tinyLat = frame.south + 0.00001;
    const tiny = squareFeature(tinyLon, tinyLat, tinyLon + 0.00002, tinyLat + 0.00002);
    assert.ok(ringAreaM2(mega.geometry.coordinates[0], frame.mpd) > MAX_AREA_M2);
    assert.ok(ringAreaM2(tiny.geometry.coordinates[0], frame.mpd) < MIN_AREA_M2);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [mega, tiny] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built.stats.buildings, 0);
    assert.ok(built.stats.droppedMega >= 1);
    assert.ok(built.stats.droppedTiny >= 1);
  });

  it("skips trees that land inside a building AABB", () => {
    const frame = geoFrame(WYNN);
    const dLon = (frame.east - frame.west) * 0.05;
    const dLat = (frame.north - frame.south) * 0.05;
    const lon0 = (frame.west + frame.east) / 2 - dLon / 2;
    const lat0 = (frame.south + frame.north) / 2 - dLat / 2;
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat)] },
      treePoints: [
        { lon: lon0 + dLon / 2, lat: lat0 + dLat / 2 },
        { lon: frame.west + (frame.east - frame.west) * 0.1, lat: frame.south + (frame.north - frame.south) * 0.1 },
      ],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built.stats.trees, 1);
  });

  it("does not emit OSM rings — trees are point pairs only", () => {
    const frame = geoFrame(WYNN);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [{ lon: (frame.west + frame.east) / 2, lat: (frame.south + frame.north) / 2 }],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const ids = new Set(built.clipboard.attenuatingZones.map((z) => z.typeId));
    assert.ok(ids.has("tree-trunk"));
    assert.ok(ids.has("foliage-heavy") || ids.has("foliage-light"));
    assert.equal(built.stats.trees, 1);
    assert.equal(built.clipboard.attenuatingZones.length, 2);
  });

  it("zip dimensions and clipboard origin stay one shared frame", () => {
    const frame = geoFrame(WYNN);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built.frame.widthM, frame.widthM);
    assert.equal(built.frame.clipboardCorners.ne[0], 0);
    assert.equal(built.frame.clipboardCorners.ne[1], 0);
    assert.match(built.alignment, /Import the OpenIntent zip/);
    assert.match(built.alignment, /Google Earth/);
  });
});

describe("zip store", () => {
  it("writes a PK zip", () => {
    const z = zipStore([{ name: "a.txt", data: "hi" }]);
    assert.equal(z[0], 0x50);
    assert.equal(z[1], 0x4b);
  });

  it("round-trips stored files", () => {
    const z = zipStore([
      { name: "openIntent_Site.json", data: "{}" },
      { name: "hamina-clipboard.json", data: '{"header":{"type":"HaminaClipboard"}}' },
    ]);
    const files = unzipStore(z);
    assert.equal(files["openIntent_Site.json"].toString(), "{}");
    assert.equal(JSON.parse(files["hamina-clipboard.json"]).header.type, "HaminaClipboard");
  });
});

describe("building type pick", () => {
  it("uses stock ids only", () => {
    assert.equal(pickBuildingTypeId(80, 0), "bldg-one");
    assert.equal(pickBuildingTypeId(2000, 0), "bldg-five");
    assert.equal(pickBuildingTypeId(9000, 0), "hotel");
    assert.equal(pickBuildingTypeId(80, 30), "hotel");
  });
});
