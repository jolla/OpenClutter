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
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.length, built.stats.buildings + built.stats.trees * 2);
    assert.equal(areas.length, built.clipboard.attenuatingZones.length);
    assert.equal(built.stats.areas, areas.length);
    const stock = new Set(ZONE_TYPES.map((t) => t.name));
    assert.deepEqual(
      built.openintent.area_materials.map((m) => m.name),
      ZONE_TYPES.map((t) => t.name)
    );
    for (const a of areas) {
      assert.ok(stock.has(a.area_material.name), a.area_material.name);
      assert.ok(a.area_material.top_height > 0);
      assert.ok(a.area_material.rf_properties.attenuation_per_m > 0);
      const coords = a.area.coordinates;
      assert.ok(coords.length >= 4);
      const first = coords[0].coordinate_xyz;
      const last = coords[coords.length - 1].coordinate_xyz;
      assert.equal(first.unit, "pixels");
      assert.equal(first.x, last.x);
      assert.equal(first.y, last.y);
      for (const c of coords) {
        assert.ok(c.coordinate_xyz.x >= 0 && c.coordinate_xyz.x <= frame.imgW);
        assert.ok(c.coordinate_xyz.y >= 0 && c.coordinate_xyz.y <= frame.imgH);
      }
    }
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
    const readme = zipped["README.txt"].toString();
    assert.match(readme, /Import this zip in Hamina \(Projects → Import → OpenIntent\)/);
    assert.match(readme, /silent fallback/);
    assert.ok(!/click map, paste/i.test(readme));
    const oiZip = JSON.parse(zipped[`openIntent_${built.slug}.json`].toString());
    assert.equal(oiZip.floorplans[0].attenuation_areas.length, areas.length);
    assert.ok(zipped["alignment-overlay.svg"]);
    assert.ok(zipped["frame-lock.json"]);
    const svg = zipped["alignment-overlay.svg"].toString();
    assert.match(svg, /images\/Wynn-Golf\.jpg/);
    assert.match(svg, /polygon /);
    const lock = JSON.parse(zipped["frame-lock.json"].toString());
    assert.equal(lock.clipboard.convention.includes("NE"), true);
    assert.equal(lock.openintent.yRelation, "y_up + y_img = imgH");
    assert.match(lock.note, /OpenIntent/);
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
    assert.equal(built.openintent.floorplans[0].attenuation_areas.length, 2);
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
    assert.match(built.alignment, /Import this zip in Hamina/);
    assert.match(built.alignment, /Google Earth/);
    assert.match(built.alignment, /silent fallback/);
    assert.ok(!/click the map, paste/i.test(built.alignment));
  });
});

describe("OpenIntent attenuation_areas", () => {
  const { clipRingToRect, ringToOi } = require("../netlify/lib/pipeline");

  it("matches building + canopy/trunk counts on a snapped JPEG frame", () => {
    const drawn = geoFrame({
      west: -87.8885,
      south: 42.8935,
      east: -87.8815,
      north: 42.9002,
    });
    const { applyImageryMeta } = require("../netlify/lib/geo-frame");
    const frame = applyImageryMeta(drawn, {
      width: 571,
      height: 741,
      extent: {
        xmin: -87.8885,
        ymin: 42.89230796847636,
        xmax: -87.8815,
        ymax: 42.901392031523635,
        spatialReference: { wkid: 4326 },
      },
    }, { width: 571, height: 741 });
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.04;
    const lon0 = frame.west + (frame.east - frame.west) * 0.3;
    const lat0 = frame.south + (frame.north - frame.south) * 0.3;
    const lon1 = lon0 + (frame.east - frame.west) * 0.25;
    const lat1 = lat0 + (frame.north - frame.south) * 0.2;
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [
          squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat),
          squareFeature(lon1, lat1, lon1 + dLon, lat1 + dLat, { height: 16 }),
        ],
      },
      treePoints: [
        { lon: frame.west + (frame.east - frame.west) * 0.12, lat: frame.south + (frame.north - frame.south) * 0.12 },
        { lon: frame.west + (frame.east - frame.west) * 0.18, lat: frame.south + (frame.north - frame.south) * 0.2 },
        { lon: frame.west + (frame.east - frame.west) * 0.85, lat: frame.south + (frame.north - frame.south) * 0.8 },
      ],
      name: "Long Meadow",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const oi = built.openintent.floorplans[0];
    assert.equal(oi.dimensions.find((d) => d.unit === "meters").width, frame.widthM);
    assert.equal(oi.dimensions.find((d) => d.unit === "meters").length, frame.lengthM);
    assert.equal(built.stats.buildings, 2);
    assert.equal(built.stats.trees, 3);
    assert.equal(oi.attenuation_areas.length, 2 + 3 * 2);
    assert.equal(built.clipboard.attenuatingZones.length, oi.attenuation_areas.length);
    const names = oi.attenuation_areas.map((a) => a.area_material.name);
    assert.ok(names.includes("Building - One Floor") || names.includes("Building - Five Floor"));
    assert.ok(names.includes("Tree Trunk"));
    assert.ok(names.includes("Foliage - Heavy") || names.includes("Foliage - Light"));
    const zipped = unzipStore(built.zip);
    assert.ok(zipped["alignment-overlay.svg"]);
    assert.match(zipped["alignment-overlay.svg"].toString(), /polygon /);
    const fromZip = JSON.parse(zipped[`openIntent_${built.slug}.json`].toString());
    assert.equal(fromZip.floorplans[0].attenuation_areas.length, 8);
  });

  it("clips straddling rings instead of collapsing them onto the border", () => {
    const w = 100;
    const h = 80;
    const clipped = clipRingToRect(
      [
        [-20, 10],
        [40, 10],
        [40, 50],
        [-20, 50],
        [-20, 10],
      ],
      w,
      h
    );
    assert.ok(clipped.length >= 3);
    assert.ok(clipped.every(([x, y]) => x >= -1e-9 && x <= w + 1e-9 && y >= -1e-9 && y <= h + 1e-9));
    const xs = clipped.map((p) => p[0]);
    assert.ok(Math.min(...xs) >= -1e-6);
    assert.ok(Math.max(...xs) > 10);
    assert.equal(ringToOi([[-5, -5], [-1, -5], [-1, -1], [-5, -1], [-5, -5]], w, h), null);
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

describe("main UI is import-only", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "public");

  it("index and app copy tell the user to import the zip, not paste", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
    assert.match(html, /Import this zip in Hamina \(Projects → Import → OpenIntent\)/);
    assert.match(app, /Import this zip in Hamina \(Projects → Import → OpenIntent\)/);
    assert.ok(!/\bpaste\b/i.test(html));
    assert.ok(!/\bpaste\b/i.test(app));
  });
});
