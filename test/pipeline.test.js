"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, llToClipboard, cornerClipboard, llToPx } = require("../netlify/lib/geo-frame");
const {
  ZONE_TYPES,
  emptyClipboard,
  gpsTiePoints,
  gpsClipboard,
  CLIPBOARD_COLLECTION_KEYS,
  pickBuildingTypeId,
} = require("../netlify/lib/hamina-clipboard");
const { buildClutter, ringAreaM2, MAX_AREA_M2, MIN_AREA_M2, megaCampusLimitM2, featureExteriorRings, MEGA_CAMPUS_M2, HOTEL_MEGA_M2, isMegaCampus, footprintsToClutter, ringVertexCount, MAX_OI_RING_VERTS, capBuildingsAndTrees, dropNestedDuplicateRoofs, parseAreaCapOverride, parseJsonBudgetOverride, raisedAreaHolds, raisedDeckCap, coverageSummary, MAX_ATTENUATION_AREAS, OPENINTENT_JSON_BUDGET, JSON_BUDGET_MAX } = require("../netlify/lib/pipeline");
const { OI_BUILDING_NAMES, isVegetationOiName, isPoisonedOiName } = require("../netlify/lib/materials");
const { zipStore, unzipStore, zipUnderLimit } = require("../netlify/lib/zip-store");
const { version: APP_VERSION } = require("../netlify/lib/version");
const { canopyHitsGrid } = require("./canopy-grid");

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

/** Densify each edge so ringVertexCount stays high after simplify. */
function densifyFeature(feature, targetVerts) {
  const ring = feature.geometry.coordinates[0];
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  const out = [];
  const perEdge = Math.max(2, Math.ceil(targetVerts / closed.length));
  for (let i = 0; i < closed.length; i++) {
    const a = closed[i];
    const b = closed[(i + 1) % closed.length];
    for (let s = 0; s < perEdge; s++) {
      const t = s / perEdge;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(out[0]);
  return {
    type: "Feature",
    properties: feature.properties || {},
    geometry: { type: "Polygon", coordinates: [out] },
  };
}

/** Irregular ~areaM2 podium that keeps detail verts under Douglas–Peucker. */
function wavyPodiumFeature(midLon, midLat, areaM2, mpd, n = 72) {
  // Wobble lowers mean radius; scale so shoelace area lands near target.
  const r0 = Math.sqrt(areaM2 / Math.PI) * 1.22;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wobble = 0.82 + 0.18 * Math.sin(a * 5) + 0.06 * Math.cos(a * 9);
    const rr = r0 * wobble;
    out.push([midLon + (rr * Math.cos(a)) / mpd.lon, midLat + (rr * Math.sin(a)) / mpd.lat]);
  }
  out.push(out[0]);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [out] },
  };
}

describe("clipboard zones stay on the aerial", () => {
  it("clips a footprint that crosses the north edge into the meter frame", () => {
    const frame = geoFrame({
      west: -87.92,
      south: 42.89,
      east: -87.91,
      north: 42.9,
      name: "Edge",
    });
    const spanLat = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const lon0 = frame.west + spanLon * 0.4;
    const lon1 = lon0 + spanLon * 0.12;
    const lat0 = frame.north - spanLat * 0.04;
    const lat1 = frame.north + spanLat * 0.2;
    const outside = llToClipboard((lon0 + lon1) / 2, lat1, frame);
    assert.ok(outside[1] > 1, "fixture vertex is north of the JPEG");
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [squareFeature(lon0, lat0, lon1, lat1, { height: 8 })],
      },
      treePoints: [],
      name: "Edge",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built.stats.buildings, 1);
    const zone = built.clipboard.attenuatingZones[0];
    assert.ok(zone);
    for (const [x, y] of zone.area.coordinates[0]) {
      assert.ok(x >= -frame.widthM - 1e-3 && x <= 1e-3, "x " + x);
      assert.ok(y >= -frame.lengthM - 1e-3 && y <= 1e-3, "y " + y);
    }
  });
});

describe("HaminaClipboard schema", () => {
  it("header, zone types, and empty collections match the working paste schema", () => {
    const clip = emptyClipboard("00000000-0000-4000-8000-000000000000");
    assert.deepEqual(clip.header, {
      type: "HaminaClipboard",
      version: [1, 0, 0],
      id: "00000000-0000-4000-8000-000000000000",
      isCut: false,
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
    assert.equal(ZONE_TYPES.find((t) => t.id === "foliage-light").transparencyEnabled, true);
    assert.equal(ZONE_TYPES.find((t) => t.id === "tree-trunk").transparencyEnabled, true);
    assert.equal(ZONE_TYPES.find((t) => t.id === "bldg-one").transparencyEnabled, false);
  });

  it("places two GPS tie points on the southwest and northeast corners of the imported map", () => {
    const frame = geoFrame(WYNN);
    const points = gpsTiePoints(frame);
    const corners = cornerClipboard(frame);
    assert.equal(points.length, 2);
    assert.equal(points[0].lat, frame.south);
    assert.equal(points[0].lon, frame.west);
    assert.equal(points[0].x, +corners.sw[0].toFixed(6));
    assert.equal(points[0].y, +corners.sw[1].toFixed(6));
    assert.equal(points[1].lat, frame.north);
    assert.equal(points[1].lon, frame.east);
    assert.equal(points[1].x, 0);
    assert.equal(points[1].y, 0);
    assert.ok(Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) > 100);
    const paste = gpsClipboard(frame);
    assert.equal(paste.header.type, "HaminaClipboard");
    assert.equal(paste.header.isCut, false);
    assert.deepEqual(paste.tiePoints, points);
    assert.equal(paste.slopedFloors.length, 0);
    assert.equal(paste.raisedFloorZones.length, 0);
    assert.equal(paste.attenuatingZoneTypes.length, 0);
    assert.equal(JSON.stringify(paste).includes("reference_markers"), false);
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
    assert.equal(built.stats.includeFoliage, false);
    assert.equal(built.stats.trees, 0);
    assert.equal(built.stats.treesSource, "none");
    assert.equal(built.stats.fetched, 1);
    assert.equal(built.stats.buildingsKept, 1);
    assert.equal(built.stats.treesKept, 0);
    assert.match(built.stats.summary, /Buildings 1 kept \(1 fetched\)/);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(built.stats.openIntentBuildingAreas, 1);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.equal(areas.length, built.stats.openIntentBuildingAreas + built.stats.openIntentTreeAreas);
    assert.ok(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
    assert.equal(JSON.stringify(built.openintent).includes("Foliage - Light"), false);
    assert.equal(built.clipboard.attenuatingZones.length, built.stats.buildings);
    assert.equal(built.stats.areas, areas.length);
    const allowed = (name) => OI_BUILDING_NAMES.includes(name) || isVegetationOiName(name);
    assert.deepEqual(
      built.openintent.area_materials.map((m) => m.name).slice(0, 4),
      OI_BUILDING_NAMES
    );
    for (const a of areas) {
      assert.equal(typeof a.area_material, "object");
      assert.equal(allowed(a.area_material.name), true, a.area_material.name);
      const cat = built.openintent.area_materials.find((m) => m.name === a.area_material.name);
      assert.deepEqual(a.area_material, cat);
      assert.equal("itu_material_type" in a.area_material, false);
      assert.equal("bottom_height" in a.area_material, false);
      const coords = a.area.coordinates;
      assert.ok(coords.length >= 4);
      const dumpedArea = JSON.stringify(a.area);
      assert.equal(dumpedArea.includes("\n"), false);
      assert.equal(dumpedArea.includes('"meters"'), false);
      assert.equal(dumpedArea.includes('"feet"'), false);
      for (let i = 0; i < coords.length; i++) {
        const px = coords[i].coordinate_xyz;
        assert.equal(px.unit, "pixels");
        assert.equal(Object.keys(coords[i]).join(","), "coordinate_xyz");
        const sx = String(px.x);
        const sy = String(px.y);
        const dx = sx.includes(".") ? sx.split(".")[1].length : 0;
        const dy = sy.includes(".") ? sy.split(".")[1].length : 0;
        assert.ok(dx <= 2 && dy <= 2, sx + "," + sy);
        assert.ok(px.x >= 0 && px.x < frame.imgW);
        assert.ok(px.y >= 0 && px.y < frame.imgH);
      }
      const first = coords[0].coordinate_xyz;
      const lastPx = coords[coords.length - 1].coordinate_xyz;
      assert.equal(first.x, lastPx.x);
      assert.equal(first.y, lastPx.y);
    }
    const bldg = built.clipboard.attenuatingZones.find((z) => z.typeId.startsWith("bldg"));
    const tree = built.clipboard.attenuatingZones.find((z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("foliage") === 0);
    assert.ok(bldg);
    assert.equal(tree, undefined);
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
    assert.deepEqual(Object.keys(zipped).sort(), [`images/${built.slug}.jpg`, `openIntent_${built.slug}.json`].sort());
    assert.equal(built.clipboard.header.type, "HaminaClipboard");
    assert.ok(built.clipboard.attenuatingZones.length >= 1);
    assert.match(built.alignment, /Import this zip in Hamina \(Projects → Import → OpenIntent\)/);
    assert.match(built.stats.summary, /Foliage off/);
    assert.equal(built.stats.buildingsKept, 1);
    assert.equal(built.stats.includeFoliage, false);
    assert.equal(built.stats.treesKept, 0);
    assert.equal(built.stats.treesSource, "none");
    const oiZip = JSON.parse(zipped[`openIntent_${built.slug}.json`].toString());
    assert.equal(oiZip.floorplans[0].attenuation_areas.length, areas.length);
    assert.equal(built.stats.attenuationAreasEmitted, areas.length);
    assert.equal(built.stats.openintentVersion, "2.0.1");
    assert.equal(built.stats.openclutterVersion, APP_VERSION);
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
    assert.equal(built.stats.fetched, 2);
    assert.match(built.stats.summary, /Buildings 0 kept/);
    assert.match(built.stats.summary, /dropped mega/);
    assert.equal(built.stats.buildingsKept, 0);
    assert.equal(built.stats.treesKept, 0);
    assert.ok(built.stats.droppedMega >= 1);
    assert.equal(unzipStore(built.zip)["README.txt"], undefined);
  });

  it("keeps a big-box roof on a tight commercial bbox (Oak Creek)", () => {
    const frame = geoFrame({
      west: -87.92,
      south: 42.898,
      east: -87.9172,
      north: 42.9002,
    });
    const mapArea = frame.widthM * frame.lengthM;
    assert.ok(mapArea < 90000, `expected tight site, got ${Math.round(mapArea)} m²`);
    const midLon = (frame.west + frame.east) / 2;
    const midLat = (frame.south + frame.north) / 2;
    const dLon = 180 / frame.mpd.lon / 2;
    const dLat = 150 / frame.mpd.lat / 2;
    const store = squareFeature(midLon - dLon, midLat - dLat, midLon + dLon, midLat + dLat);
    const storeArea = ringAreaM2(store.geometry.coordinates[0], frame.mpd);
    assert.ok(storeArea > 15000 && storeArea < MEGA_CAMPUS_M2, `store ${storeArea}`);
    assert.ok(storeArea > mapArea * 0.45, "this is the fraction that used to drop the white roof");
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [store] },
      treePoints: [
        {
          lon: frame.west + (frame.east - frame.west) * 0.06,
          lat: frame.south + (frame.north - frame.south) * 0.06,
        },
      ],
      name: "Oak Creek WI",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "imagery-rgb",
    });
    assert.equal(built.stats.buildingsKept, 1);
    assert.equal(built.stats.droppedMega, 0);
    assert.equal(built.stats.treesKept, 0);
    assert.equal(built.stats.treesSource, "none");
    assert.equal(built.stats.buildingsKept, 1);
    assert.equal(built.stats.treesSource, "none");
    assert.equal(unzipStore(built.zip)["README.txt"], undefined);
  });

  it("emits every MultiPolygon part and Polygon sibling ring", () => {
    const frame = geoFrame({
      west: -87.92,
      south: 42.898,
      east: -87.9172,
      north: 42.9002,
    });
    const wing = squareFeature(frame.west + 0.0003, frame.south + 0.0003, frame.west + 0.0008, frame.south + 0.0008);
    const hall = squareFeature(frame.west + 0.0012, frame.south + 0.0003, frame.west + 0.0024, frame.south + 0.0012);
    const multi = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [wing.geometry.coordinates, hall.geometry.coordinates],
      },
    };
    const siblingPoly = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [wing.geometry.coordinates[0], hall.geometry.coordinates[0]],
      },
    };
    assert.equal(featureExteriorRings(multi.geometry).length, 2);
    assert.equal(featureExteriorRings(siblingPoly.geometry).length, 2);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [multi] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built.stats.fetched, 1);
    assert.equal(built.stats.buildingsKept, 2);
    const built2 = buildClutter({
      frame,
      footprintsGeojson: { features: [siblingPoly] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built2.stats.buildingsKept, 2);
  });

  it("keeps hotel-scale wings and skips map-swallowing campus blobs", () => {
    const frame = geoFrame(WYNN);
    const limit = megaCampusLimitM2(frame);
    assert.ok(limit > 40000, `large-map mega limit should exceed 4 ha, got ${limit}`);
    assert.equal(limit, HOTEL_MEGA_M2);
    const midLon = (frame.west + frame.east) / 2;
    const midLat = (frame.south + frame.north) / 2;
    // ~2.5 ha hotel podium (was dropped by the old 1.5 ha hard cap).
    const dLon = 180 / frame.mpd.lon / 2;
    const dLat = 140 / frame.mpd.lat / 2;
    const hotel = squareFeature(midLon - dLon, midLat - dLat, midLon + dLon, midLat + dLat);
    const hotelArea = ringAreaM2(hotel.geometry.coordinates[0], frame.mpd);
    assert.ok(hotelArea > 15000 && hotelArea < limit, `hotel area ${hotelArea} vs limit ${limit}`);
    const campus = squareFeature(frame.west, frame.south, frame.east, frame.north);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [hotel, campus] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(built.stats.buildings, 1);
    assert.ok(built.stats.droppedMega >= 1);
    assert.equal(built.stats.fetched, 2);
    assert.match(built.stats.summary, /Buildings 1 kept \(2 fetched/);
  });

  it("keeps a detailed casino podium above MEGA_CAMPUS but drops a coarse MS hull", () => {
    const frame = geoFrame(WYNN);
    const midLon = (frame.west + frame.east) / 2;
    const midLat = (frame.south + frame.north) / 2;
    // ~185k m² irregular podium (Wynn-scale). A densified square collapses to
    // 4 corners under Douglas–Peucker; a wavy ring keeps detail verts.
    const detailed = wavyPodiumFeature(midLon, midLat, 185000, frame.mpd, 72);
    const detailedArea = ringAreaM2(detailed.geometry.coordinates[0], frame.mpd);
    assert.ok(detailedArea > MEGA_CAMPUS_M2 && detailedArea < HOTEL_MEGA_M2, `podium ${detailedArea}`);
    assert.ok(ringVertexCount(detailed.geometry.coordinates[0]) >= 40);
    assert.equal(isMegaCampus(detailedArea, 56), false);
    const side = Math.sqrt(185000);
    const dLon = (side * 1.05) / frame.mpd.lon / 2;
    const dLat = (side * 1.05) / frame.mpd.lat / 2;
    // Coarse 4-corner hull in the same size band (MS campus-merge style).
    const coarse = squareFeature(midLon - dLon, midLat - dLat, midLon + dLon, midLat + dLat);
    const coarseArea = ringAreaM2(coarse.geometry.coordinates[0], frame.mpd);
    assert.ok(coarseArea > MEGA_CAMPUS_M2 && coarseArea < HOTEL_MEGA_M2, `coarse ${coarseArea}`);
    assert.equal(isMegaCampus(coarseArea, 4), true);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [detailed, coarse] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.ok(built.stats.buildingsKept >= 1, "detailed podium was dropped");
    assert.equal(built.stats.droppedMega, 1);
    assert.equal(built.stats.fetched, 2);
  });

  it("clips an off-map mega hull instead of counting it as mega", () => {
    const frame = geoFrame(WYNN);
    // Entirely east of the frame — intersects nothing after clip.
    const off = squareFeature(frame.east + 0.001, frame.south, frame.east + 0.02, frame.north);
    assert.ok(ringAreaM2(off.geometry.coordinates[0], frame.mpd) > MEGA_CAMPUS_M2);
    const built = footprintsToClutter([off], frame, null);
    assert.equal(built.stats.buildings, 0);
    assert.equal(built.stats.droppedMega, 0);
    assert.ok(built.stats.droppedClip >= 1);
  });

  it("keeps Wynn resort mega rings from the Jerry export diagnosis fixture", () => {
    const fs = require("fs");
    const path = require("path");
    const fixture = path.join(__dirname, "fixtures/wynn-golf/mega-dropped.geojson");
    const lockPath = path.join(__dirname, "fixtures/wynn-golf/frame-lock.json");
    assert.ok(fs.existsSync(fixture), "wynn mega fixture missing");
    assert.ok(fs.existsSync(lockPath), "wynn frame-lock fixture missing");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const megaFc = JSON.parse(fs.readFileSync(fixture, "utf8"));
    const frame = geoFrame(
      {
        west: lock.extent.west,
        south: lock.extent.south,
        east: lock.extent.east,
        north: lock.extent.north,
        name: "Wynn Golf",
      },
      { imgW: lock.image.widthPx, imgH: lock.image.heightPx }
    );
    // Before the fix these three were droppedMega; now the on-map detailed USA
    // resort ring (~185k) and the clipped hotel tip (~111k) must be kept. The
    // off-map MS hull becomes clip, not mega.
    const beforeStyle = megaFc.features.filter((f) => {
      const am = ringAreaM2(f.geometry.coordinates[0], frame.mpd);
      return am > MEGA_CAMPUS_M2;
    });
    assert.equal(beforeStyle.length, 3);
    const built = footprintsToClutter(megaFc.features, frame, null);
    assert.ok(built.stats.buildings >= 2, `expected ≥2 kept, got ${built.stats.buildings}`);
    assert.equal(built.stats.droppedMega, 0);
    assert.ok(built.stats.droppedClip >= 1);
  });

  it("keeps the Las Vegas Sphere ring on Jerry's Wynn frame and on a south-extended frame", () => {
    const fs = require("fs");
    const path = require("path");
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/frame-lock.json"), "utf8"));
    const sphere = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/sphere-overture.geojson"), "utf8"));
    const area = ringAreaM2(sphere.geometry.coordinates[0], { lon: 90000, lat: 110540 });
    assert.ok(area > 15000 && area < MEGA_CAMPUS_M2, `sphere area ${area}`);
    assert.ok(ringVertexCount(sphere.geometry.coordinates[0]) >= 30);
    assert.equal(isMegaCampus(area, ringVertexCount(sphere.geometry.coordinates[0])), false);

    function frameFor(south) {
      return geoFrame(
        {
          west: lock.extent.west,
          south,
          east: lock.extent.east,
          north: lock.extent.north,
          name: "Wynn Golf",
        },
        { imgW: lock.image.widthPx, imgH: lock.image.heightPx }
      );
    }
    function covers(frame, built, lon, lat) {
      const [x, y] = llToPx(lon, lat, frame);
      const ring = built.overlayRings[0];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-20) + xi;
        if (hit) inside = !inside;
      }
      return inside;
    }

    // Jerry's export extent clips the southern half. The visible cap stays.
    const clipped = frameFor(lock.extent.south);
    const cap = footprintsToClutter([sphere], clipped, null);
    assert.ok(cap.stats.buildings >= 2 && cap.stats.buildings <= 6, `dome bands ${cap.stats.buildings}`);
    assert.equal(cap.stats.droppedMega, 0);
    assert.equal(cap.stats.droppedTiny, 0);
    assert.equal(cap.stats.droppedClip, 0);
    const capTops = cap.oiAreas.map((a) => a.area_material.top_height);
    assert.ok(Math.max(...capTops) >= 111.5 && Math.max(...capTops) <= 112.05, `apex ${Math.max(...capTops)}`);
    assert.ok(cap.oiAreas[0].area_material.top_height < 40, "ground band is not the full 112 m cylinder");
    assert.notEqual(cap.oiAreas[0].area_material.name, "Building - 112.0");
    assert.equal(covers(clipped, cap, -115.1621, 36.1216), true);
    const { oiPixelCoords, validateOiCoords } = require("../netlify/lib/pipeline");
    const spherePx = oiPixelCoords(cap.oiAreas[0].area.coordinates);
    assert.ok(spherePx.length - 1 <= MAX_OI_RING_VERTS, `sphere OI verts ${spherePx.length - 1}`);
    assert.equal(validateOiCoords(cap.oiAreas[0].area.coordinates, clipped.imgW, clipped.imgH).ok, true);

    // Bbox that includes the center keeps the round ground ring and stacks
    // shorter rings up to the measured 112 m. It is not one full-height cylinder.
    const full = frameFor(36.119);
    const disk = footprintsToClutter([sphere], full, null);
    assert.ok(disk.stats.buildings >= 4 && disk.stats.buildings <= 6, `dome bands ${disk.stats.buildings}`);
    assert.equal(disk.stats.droppedMega, 0);
    const diskTops = disk.oiAreas.map((a) => a.area_material.top_height);
    assert.ok(Math.max(...diskTops) >= 111.5 && Math.max(...diskTops) <= 112.05, `apex ${Math.max(...diskTops)}`);
    assert.ok(disk.oiAreas[0].area_material.top_height < 40, "ground band is not the full 112 m cylinder");
    assert.notEqual(disk.oiAreas[0].area_material.name, "Building - 112.0");
    const fullHeight = disk.oiAreas.filter((a) => a.area_material.top_height >= 100);
    assert.equal(fullHeight.length >= 1, true);
    assert.equal(covers(full, disk, -115.16208, 36.12123), true);
    const diskPx = oiPixelCoords(disk.oiAreas[0].area.coordinates);
    assert.ok(diskPx.length - 1 <= MAX_OI_RING_VERTS, `full sphere OI verts ${diskPx.length - 1}`);
    const xs = disk.overlayRings[0].map((p) => p[0]);
    const ys = disk.overlayRings[0].map((p) => p[1]);
    const wM = (Math.max(...xs) - Math.min(...xs)) * full.mpuX;
    const hM = (Math.max(...ys) - Math.min(...ys)) * full.mpuY;
    assert.ok(wM > 140 && hM > 140, `sphere span ${wM} x ${hM}`);
    const aspect = wM / hM;
    assert.ok(aspect > 0.8 && aspect < 1.25, `sphere aspect ${aspect}`);
    let areaPx = 0;
    const ring = disk.overlayRings[0];
    for (let i = 0; i < ring.length - 1; i++) {
      areaPx += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    const areaM2 = (Math.abs(areaPx) / 2) * full.mpuX * full.mpuY;
    assert.ok(areaM2 > 15000 && areaM2 < 40000, `emitted sphere area ${areaM2}`);
    const bandAreas = disk.overlayRings.map((r) => {
      let a = 0;
      for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
      return (Math.abs(a) / 2) * full.mpuX * full.mpuY;
    });
    const tallest = diskTops.indexOf(Math.max(...diskTops));
    assert.ok(bandAreas[tallest] < areaM2 * 0.5, `apex plan ${bandAreas[tallest]} vs ground ${areaM2}`);
    assert.ok(Math.min(...bandAreas) < Math.max(...bandAreas) * 0.35, "upper rings shrink toward the top");
  });

  it("caps a 100+ vertex ring and drops a one-axis sliver from OpenIntent", () => {
    const fs = require("fs");
    const path = require("path");
    const { oiPixelCoords, validateOiCoords, validateOiArea } = require("../netlify/lib/pipeline");
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/frame-lock.json"), "utf8"));
    const frame = geoFrame(
      {
        west: lock.extent.west,
        south: lock.extent.south,
        east: lock.extent.east,
        north: lock.extent.north,
        name: "Wynn Golf",
      },
      { imgW: lock.image.widthPx, imgH: lock.image.heightPx }
    );
    const midLon = (frame.west + frame.east) / 2;
    const midLat = (frame.south + frame.north) / 2;
    // ~90k m² sits in the #24 180-vert budget, under the mega cutoff, so the
    // old path emitted the raw Overture detail (Jerry's zip hit 156).
    const dense = wavyPodiumFeature(midLon, midLat, 90000, frame.mpd, 140);
    assert.ok(ringVertexCount(dense.geometry.coordinates[0]) >= 100);
    assert.ok(ringAreaM2(dense.geometry.coordinates[0], frame.mpd) > 20000);
    assert.ok(ringAreaM2(dense.geometry.coordinates[0], frame.mpd) < MEGA_CAMPUS_M2);
    const thinLen = 40 / frame.mpd.lon;
    const thinWid = 2 / frame.mpd.lat;
    const thinLon = frame.west + (frame.east - frame.west) * 0.12;
    const thinLat = frame.south + (frame.north - frame.south) * 0.72;
    const thin = squareFeature(thinLon, thinLat, thinLon + thinLen, thinLat + thinWid);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [dense, thin] },
      treePoints: [],
      name: "Wynn Dense",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(built.stats.droppedSpan, 1);
    assert.equal(built.stats.droppedVerts, 0);
    assert.ok(areas.length >= 1, "dense roof produced no area");
    assert.equal(built.stats.buildingsKept, areas.length);
    assert.equal(built.stats.droppedMega, 0);
    assert.ok(built.clipboard.attenuatingZones.length >= 2, "clipboard keeps the exact sliver");
    let maxVerts = 0;
    for (const a of areas) {
      assert.equal(validateOiArea(a, frame.imgW, frame.imgH).ok, true);
      const px = oiPixelCoords(a.area.coordinates);
      const n = px.length - 1;
      if (n > maxVerts) maxVerts = n;
      assert.ok(n <= MAX_OI_RING_VERTS, `emitted ${n} verts`);
      assert.equal(validateOiCoords(a.area.coordinates, frame.imgW, frame.imgH).ok, true);
      const xs = px.map((c) => c.coordinate_xyz.x);
      const ys = px.map((c) => c.coordinate_xyz.y);
      assert.ok(Math.max(...xs) - Math.min(...xs) >= 4 - 0.01);
      assert.ok(Math.max(...ys) - Math.min(...ys) >= 4 - 0.01);
    }
    assert.ok(maxVerts >= 8, "capped ring still has a real outline");
    assert.equal(built.stats.droppedSpan, 1);
    assert.equal(built.stats.droppedVerts, 0);
    assert.equal(built.stats.attenuationAreasEmitted, areas.length);
    assert.equal(unzipStore(built.zip)["VERIFY.txt"], undefined);
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
    assert.equal(built.stats.trees, 0);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.equal(built.stats.includeFoliage, false);
  });

  it("does not emit OSM rings — tree points are not crowns", () => {
    const frame = geoFrame(WYNN);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [{ lon: (frame.west + frame.east) / 2, lat: (frame.south + frame.north) / 2 }],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const ids = new Set(built.clipboard.attenuatingZones.map((z) => z.typeId));
    assert.equal(ids.has("tree-trunk"), false);
    assert.equal(built.stats.trees, 0);
    assert.equal(built.clipboard.attenuatingZones.length, 0);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.equal(built.stats.openIntentBuildingAreas, 0);
    const treeOi = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(treeOi.length, 0);
    assert.ok(built.openintent.area_materials.every((m) => !isPoisonedOiName(m.name)));
  });

  it("include foliage emits canopy polygons and skips point circles and trunks", () => {
    const frame = geoFrame(WYNN);
    const lon = frame.west + (frame.east - frame.west) * 0.2;
    const lat = frame.south + (frame.north - frame.south) * 0.2;
    const hits = canopyHitsGrid(frame, lon, lat, { cols: 3, rows: 2, pct: 80 });
    const off = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [{ lon, lat, pct: 80, heightM: 14.2, median: true }],
      canopyHits: hits,
      name: "Foliage Off",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "nlcd-canopy",
      includeFoliage: false,
    });
    assert.equal(off.stats.includeFoliage, false);
    assert.equal(off.stats.openIntentTreeAreas, 0);
    assert.equal(off.stats.treesSource, "none");
    assert.equal(off.openintent.floorplans[0].attenuation_areas.length, 0);
    assert.equal(
      off.clipboard.attenuatingZones.some((z) => String(z.typeId).indexOf("foliage") === 0 || String(z.typeId).indexOf("trunk") >= 0),
      false
    );
    const on = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [
        { lon, lat, pct: 80, heightM: 14.2, median: true },
        { lon: lon + 0.00001, lat, pct: 70, median: true },
      ],
      canopyHits: hits,
      name: "Foliage On",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "nlcd-canopy",
      includeFoliage: true,
      heightSample: () => 14.2,
    });
    assert.equal(on.stats.includeFoliage, true);
    assert.ok(on.stats.openIntentTreeAreas >= 1);
    assert.equal(on.stats.treesSource, "nlcd-canopy");
    const areas = on.openintent.floorplans[0].attenuation_areas;
    assert.ok(areas.every((a) => isVegetationOiName(a.area_material.name)));
    assert.ok(areas.some((a) => a.area_material.top_height === 14.2 && a.area_material.rf_properties.attenuation_per_m === 1.5));
    assert.equal(areas.some((a) => a.area_material.name === "Tree Trunk"), false);
    assert.equal(
      on.clipboard.attenuatingZones.some((z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("trunk") === 0),
      false
    );
    assert.ok(on.clipboard.attenuatingZones.some((z) => String(z.typeId).indexOf("foliage") === 0));
    assert.equal(unzipStore(on.zip)["alignment-overlay.svg"], undefined);
    const pointsOnly = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [{ lon, lat, pct: 80, heightM: 14.2, median: true }],
      name: "Points",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      treesSource: "imagery-rgb",
      includeFoliage: true,
    });
    assert.equal(pointsOnly.stats.openIntentTreeAreas, 0);
    assert.equal(pointsOnly.clipboard.attenuatingZones.length, 0);
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
    assert.match(built.alignment, /aerial JPEG/);
    assert.equal(/Paste hamina-clipboard\.json for trees/i.test(built.alignment), false);
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
    assert.equal(built.stats.trees, 0);
    assert.equal(built.stats.openIntentBuildingAreas, 2);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.equal(oi.attenuation_areas.length, built.stats.openIntentBuildingAreas + built.stats.openIntentTreeAreas);
    assert.equal(built.clipboard.attenuatingZones.length, 2);
    const names = oi.attenuation_areas.map((a) => a.area_material.name);
    assert.ok(names.every((n) => OI_BUILDING_NAMES.includes(n)));
    assert.ok(names.includes("Building - One Floor") || names.includes("Building - Five Floor") || names.includes("Building - Two Floor"));
    assert.equal(names.some((n) => n === "Foliage - Heavy" || n === "Foliage - Light"), false);
    assert.ok(!names.includes("Tree Trunk"));
    const zipped = unzipStore(built.zip);
    assert.equal(zipped["alignment-overlay.svg"], undefined);
    assert.equal(zipped["hamina-clipboard.json"], undefined);
    const fromZip = JSON.parse(zipped[`openIntent_${built.slug}.json`].toString());
    assert.equal(fromZip.floorplans[0].attenuation_areas.length, oi.attenuation_areas.length);
    assert.equal(
      built.clipboard.attenuatingZones.some((z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("foliage") === 0 || String(z.typeId).indexOf("trunk") === 0),
      false
    );
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
    assert.equal(ringToOi([[-5, -5], [-1, -5], [-1, -1], [-5, -1], [-5, -5]], w, h, 1), null);
  });

  it("rejects open, NaN, duplicate, and self-intersecting rings after rounding", () => {
    const { validateOiCoords, ringToOi, ensureMinSpan } = require("../netlify/lib/pipeline");
    const w = 100;
    const h = 80;
    const closed = [
      { coordinate_xyz: { x: 10, y: 10, unit: "pixels" } },
      { coordinate_xyz: { x: 40, y: 10, unit: "pixels" } },
      { coordinate_xyz: { x: 40, y: 40, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 40, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 10, unit: "pixels" } },
    ];
    assert.equal(validateOiCoords(closed, w, h).ok, true);
    const open = closed.slice(0, -1);
    assert.equal(validateOiCoords(open, w, h).ok, false);
    const nan = closed.map((c, i) =>
      i === 1 ? { coordinate_xyz: { x: NaN, y: 10, unit: "pixels" } } : c
    );
    assert.equal(validateOiCoords(nan, w, h).reason, "nan");
    const dup = [
      closed[0],
      closed[1],
      { coordinate_xyz: { x: 40, y: 10, unit: "pixels" } },
      closed[2],
      closed[3],
      closed[4],
    ];
    assert.equal(validateOiCoords(dup, w, h).reason, "duplicate");
    const bowtie = ringToOi(
      [
        [10, 10],
        [40, 10],
        [10, 40],
        [40, 40],
        [10, 10],
      ],
      w,
      h,
      1
    );
    assert.equal(bowtie, null);
    const tiny = ensureMinSpan(
      [
        [20, 20],
        [20.2, 20],
        [20.2, 20.2],
        [20, 20.2],
      ],
      w,
      h
    );
    const expanded = ringToOi(tiny, w, h, 1);
    assert.ok(expanded);
    assert.equal(validateOiCoords(expanded, w, h).ok, true);
    assert.ok(expanded.length >= 4);
    assert.equal(expanded.every((c) => c.coordinate_xyz.unit === "pixels"), true);
    const xs = expanded.filter((c) => c.coordinate_xyz.unit === "pixels").map((c) => c.coordinate_xyz.x);
    const ys = expanded.filter((c) => c.coordinate_xyz.unit === "pixels").map((c) => c.coordinate_xyz.y);
    assert.ok(Math.max(...xs) - Math.min(...xs) >= 3);
    assert.ok(Math.max(...ys) - Math.min(...ys) >= 3);
    const sliver = ensureMinSpan(
      [
        [10, 10],
        [40, 10],
        [40, 11],
        [10, 11],
      ],
      w,
      h,
      4
    );
    assert.deepEqual(sliver, []);
    assert.equal(
      ringToOi(
        [
          [10, 10],
          [40, 10],
          [40, 11],
          [10, 11],
          [10, 10],
        ],
        w,
        h,
        1
      ),
      null
    );
    const thinCoords = [
      { coordinate_xyz: { x: 10, y: 10, unit: "pixels" } },
      { coordinate_xyz: { x: 40, y: 10, unit: "pixels" } },
      { coordinate_xyz: { x: 40, y: 11, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 11, unit: "pixels" } },
      { coordinate_xyz: { x: 10, y: 10, unit: "pixels" } },
    ];
    assert.equal(validateOiCoords(thinCoords, w, h).reason, "span");
    const mild = ringToOi(
      [
        [10, 10],
        [40, 10],
        [40, 13],
        [10, 13],
        [10, 10],
      ],
      w,
      h,
      1
    );
    assert.ok(mild);
    const mildPx = mild.filter((c) => c.coordinate_xyz.unit === "pixels");
    const mildXs = mildPx.map((c) => c.coordinate_xyz.x);
    const mildYs = mildPx.map((c) => c.coordinate_xyz.y);
    assert.ok(Math.max(...mildXs) - Math.min(...mildXs) >= 4 - 0.01);
    assert.ok(Math.max(...mildYs) - Math.min(...mildYs) >= 4 - 0.01);
  });

  it("keeps a valid building when a sibling ring is a bowtie", () => {
    const frame = geoFrame(WYNN);
    const dLon = (frame.east - frame.west) * 0.03;
    const dLat = (frame.north - frame.south) * 0.03;
    const lon0 = frame.west + (frame.east - frame.west) * 0.3;
    const lat0 = frame.south + (frame.north - frame.south) * 0.3;
    const good = squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat);
    const bow = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[
          [lon0 + dLon * 3, lat0],
          [lon0 + dLon * 5, lat0],
          [lon0 + dLon * 3, lat0 + dLat * 2],
          [lon0 + dLon * 5, lat0 + dLat * 2],
          [lon0 + dLon * 3, lat0],
        ]],
      },
    };
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [good, bow] },
      treePoints: [],
      name: "Site",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.ok(built.stats.buildingsKept >= 1);
    assert.equal(built.openintent.floorplans[0].attenuation_areas.length, built.stats.attenuationAreasEmitted);
    assert.ok(built.stats.attenuationAreasEmitted >= 1);
    for (const a of built.openintent.floorplans[0].attenuation_areas) {
      const { validateOiArea } = require("../netlify/lib/pipeline");
      assert.equal(validateOiArea(a, frame.imgW, frame.imgH).ok, true);
    }
  });

  it("emits a measured building height as its own Hamina-safe material", () => {
    const frame = geoFrame(WYNN);
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.03;
    const lon0 = frame.west + (frame.east - frame.west) * 0.4;
    const lat0 = frame.south + (frame.north - frame.south) * 0.4;
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat, { height: 6.41 })],
      },
      treePoints: [
        {
          lon: frame.west + (frame.east - frame.west) * 0.15,
          lat: frame.south + (frame.north - frame.south) * 0.15,
          pct: 64,
        },
      ],
      name: "Measured",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.deepEqual(
      built.openintent.area_materials.map((m) => m.name).slice(0, 4),
      OI_BUILDING_NAMES
    );
    // 6.41 m buckets to Building - Two Floor in the gold outdoor set.
    const bldg = areas.find((a) => a.area_material && a.area_material.name === "Building - Two Floor");
    assert.ok(bldg);
    assert.equal(typeof bldg.area_material, "object");
    const cat = built.openintent.area_materials.find((m) => m.name === "Building - Two Floor");
    assert.deepEqual(bldg.area_material, cat);
    assert.equal(cat.top_height, 7.620092660326749);
    assert.equal("itu_material_type" in cat, false);
    assert.equal(cat.rf_properties.attenuation_per_m, 5);
    assert.equal("bottom_height" in cat, false);
    assert.equal(built.stats.compatibilityMode, "stock-foliage");
    assert.equal(built.stats.areaMaterials, OI_BUILDING_NAMES.length);
    assert.equal(built.stats.openIntentBuildingAreas, 1);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.equal(areas.length, 1);
    assert.equal(areas.some((a) => a.area_material.name === "Foliage - Heavy"), false);
    assert.ok(!areas.some((a) => a.area_material.name === "Tree Trunk"));
    assert.ok(built.clipboard.attenuatingZoneTypes.some((t) => t.id === "bldg-m-6_4" && t.topEdge === 6.4));
    assert.equal(built.clipboard.attenuatingZones.length, 1);
  });

  it("caps complete tree pairs and never splits a canopy/trunk", () => {
    const { capAttenuationAreas } = require("../netlify/lib/pipeline");
    const areas = [];
    for (let i = 0; i < 10; i++) areas.push({ id: i });
    const capped = capAttenuationAreas(areas, 3, 6);
    assert.equal(capped.areas.length, 5);
    assert.equal(capped.dropped, 5);
    assert.deepEqual(capped.areas.map((a) => a.id), [0, 1, 2, 3, 4]);
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

  it("deflates json when the stored zip is over the download limit and leaves a small zip stored", () => {
    const json = Buffer.from('{"areas":"' + "x".repeat(80000) + '"}');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const files = [
      { name: "openIntent_Site.json", data: json },
      { name: "images/site.jpg", data: jpeg },
    ];
    const stored = zipStore(files);
    const fitted = zipUnderLimit(files, 4000);
    assert.ok(stored.length > 4000);
    assert.ok(fitted.length < stored.length);
    assert.ok(fitted.length <= 4000, "deflated " + fitted.length);
    assert.equal(fitted.readUInt16LE(8), 8);
    const back = unzipStore(fitted);
    assert.equal(back["openIntent_Site.json"].toString(), json.toString());
    assert.equal(back["images/site.jpg"].length, jpeg.length);
    const small = zipUnderLimit([{ name: "a.json", data: Buffer.from("{}") }], 4400000);
    assert.equal(small.readUInt16LE(8), 0);
    assert.equal(unzipStore(small)["a.json"].toString(), "{}");
  });
});

describe("building type pick", () => {
  it("uses stock ids only", () => {
    assert.equal(pickBuildingTypeId(80, 0), "bldg-one");
    assert.equal(pickBuildingTypeId(2000, 0), "bldg-five");
    assert.equal(pickBuildingTypeId(9000, 0), "hotel");
    assert.equal(pickBuildingTypeId(80, 30), "hotel");
  });

  it("buckets OpenIntent buildings into the gold One/Two/Five/Ten set", () => {
    const { pickOiBuildingTypeId } = require("../netlify/lib/materials");
    assert.equal(pickOiBuildingTypeId(80, 0), "bldg-one");
    assert.equal(pickOiBuildingTypeId(80, 6.4), "bldg-two");
    assert.equal(pickOiBuildingTypeId(2000, 0), "bldg-five");
    assert.equal(pickOiBuildingTypeId(80, 18), "bldg-five");
    assert.equal(pickOiBuildingTypeId(9000, 0), "bldg-ten");
    assert.equal(pickOiBuildingTypeId(80, 32), "bldg-ten");
  });
});

describe("main UI: import buildings, optional foliage", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "public");

  it("index and app keep one Foliage toggle, on unless unchecked", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
    assert.match(html, /Export a zip\. Import it in Hamina for the aerial map and buildings\./);
    assert.equal(/Import OpenIntent for the map and buildings/i.test(html), false);
    assert.equal(/One zip\./i.test(html), false);
    assert.match(html, />\s*Foliage\s*</);
    assert.equal(/Include foliage|Experimental/.test(html + app), false);
    assert.match(html, /id="include-foliage"[^>]*checked/);
    assert.match(html, /id="status-line"/);
    assert.match(html, /id="status-more"[^>]*hidden/);
    assert.equal(/<details[^>]*\sopen/.test(html), false);
    assert.match(app, /function exportHeadline/);
    assert.match(app, /Zip ready\./);
    assert.match(app, /more\.open = false/);
    assert.match(html, /id="clutter-options"/);
    assert.match(html, /<details id="advanced">\s*<summary>Advanced<\/summary>/);
    assert.match(html, /id="include-terrain"[^>]*checked/);
    assert.match(html, />\s*Terrain\s*</);
    assert.equal(/paste hamina-clipboard\.json for trees/i.test(html), false);
    assert.match(app, /Import this zip in Hamina \(Projects → Import → OpenIntent\)/);
    assert.match(app, /includeFoliage/);
    assert.equal(/Paste hamina-clipboard\.json from the zip for trees/i.test(app), false);
    assert.match(app, /stats\.summary/);
    const pasteClient = fs.readFileSync(path.join(root, "export-client.js"), "utf8");
    assert.match(app, /chooseTerrainPaste/);
    assert.match(pasteClient, /terrainClipboard/);
    assert.match(app, /Copied\. Paste terrain separately in Hamina\./);
    assert.match(app, /Paste terrain separately in Hamina\./);
    assert.match(app, /Copied\. Paste the GPS points separately in Hamina\./);
    assert.equal(/Copied terrain\. Paste it in Planner Plus/.test(app), false);
    assert.match(app, /function downloadFailure/);
    assert.match(app, /data\.error \|\| data\.errorMessage/);
    assert.equal(/The zip was not ready/.test(app), false);
    assert.match(app, /function setCopyNote/);
    assert.match(app, /function clearCopyNote/);
    assert.match(app, /function setStatus\(msg, err\) \{\n  clearCopyNote\(\);/);
    assert.match(html, /id="copy-note"[^>]*hidden/);
    const copyHandler = app.split("copyTerrainBtn.onclick")[1].split("function exportError")[0];
    assert.match(copyHandler, /setCopyNote\(/);
    assert.equal(/setStatus\(/.test(copyHandler), false);
    assert.equal(/\u2014/.test(copyHandler), false);
    assert.match(pasteClient, /gpsClipboard/);
    assert.match(app, /Copy GPS points/);
    assert.match(app, /southwest and northeast corners of the imported map/);
    const afterDownloadFn = app.split("function downloadBlob")[1] || "";
    assert.equal((afterDownloadFn.match(/downloadBlob\(/g) || []).length, 2);
    assert.match(app, /downloadBlob\(b64ToBlob\(data\.zipBase64/);
    assert.match(app, /downloadBlob\(blob,/);
    assert.equal(/terrain-clipboard\.json/.test(app), false);
    assert.equal(/terrainFilename/.test(app), false);
    assert.equal(/downloaded terrain/i.test(app), false);
    assert.match(html, /id="copy-terrain"[^>]*hidden/);
    assert.match(html, /Copy terrain/);
    assert.equal((html.match(/<select/gi) || []).length, 1);
    assert.match(html, /id="map-quality"/);
    assert.match(html, /value="auto" selected>Auto</);
    assert.match(html, /value="low">Low · 256 px</);
    assert.match(html, /value="standard">Standard · 640 px</);
    assert.match(html, /value="high">High · 1040 px</);
    assert.match(html, /value="sharp">Sharp · 2048 px</);
    assert.match(html, /value="4k">4K · 4096 px</);
    assert.equal(/id="terrain-hint"/.test(html), false);
    assert.equal(/id="map-quality-hint"/.test(html), false);
    assert.equal(/4K does not return/.test(html), false);
    assert.equal(/type="range"/i.test(html), false);
    assert.equal(/DEM source|3DEP source/i.test(html + app), false);
    assert.equal(/id="terrain-resolution"/.test(html), false);
    assert.equal(/terrain-resolution-range/.test(html + app), false);
    assert.equal(/Terrain resolution/.test(html), false);
    assert.equal(/>Default</.test(html), false);
    assert.equal(/>Fine</.test(html), false);
    assert.equal(/>Finest</.test(html), false);
    assert.equal(/past 20×20/.test(html), false);
    assert.equal(/Ski hills only/i.test(html), false);
    assert.match(html, /class="build"/);
    assert.equal(/<h1>[^<]*id="app-version"/.test(html), false);
    assert.equal(/\bterrainRes\b/.test(app), false);
    assert.equal(/selectedTerrainResolution/.test(app), false);
    assert.equal(/TERRAIN_STOPS/.test(app), false);
    assert.match(app, /function syncDevPanel/);
    assert.match(app, /sub\.hidden = dev/);
    assert.match(app, /function restoreAdvanced/);
    assert.match(app, /localStorage\.getItem\("openclutter-advanced"\) === "1"/);
    assert.match(app, /localStorage\.setItem\("openclutter-advanced", details\.open \? "1" : "0"\)/);
    assert.match(app, /function clutterChecked/);
    assert.match(app, /if \(!input\) return true/);
    assert.match(app, /function terrainExportEnabled\(\) \{\n  const input = document\.getElementById\("include-terrain"\);\n  if \(!input\) return true;\n  return !!input\.checked;\n\}/);
    assert.equal(/if \(devPage\(\)\) return true/.test(app), false);
    assert.match(app, /const terrainOff = includeTerrain === false/);
    assert.match(app, /terrainOff \? "Terrain off"/);
    assert.match(app, /includeTerrain: terrain/);
    assert.match(app, /deferTerrain: terrain && devPage\(\)/);
    assert.match(app, /liftSamples/);
    assert.match(app, /liftKind/);
    assert.match(app, /format: "terrain"/);
    assert.match(app, /function fetchTerrainPaste/);
    assert.match(app, /Terrain did not return\. Export again\./);
    assert.match(app, /terrainResolution: terrain \? "auto" : undefined/);
    assert.equal(/id="terrain-style"|name="terrain-style"|Raised layers/.test(html + app), false);
    assert.equal(/selectedTerrainStyle/.test(app), false);
    assert.match(app, /terrainStyle: terrain \? "sloped" : undefined/);
    assert.match(app, /function selectedImageryQuality/);
    assert.match(app, /getElementById\("map-quality"\)/);
    assert.match(app, /return "auto";/);
    assert.match(app, /imageryQuality: devPage\(\) \? selectedImageryQuality\(\) : undefined/);
    assert.match(app, /function areaCapOverride\(\)/);
    assert.match(app, /function terrainFloorsOverride\(\)/);
    assert.match(app, /n < 100 \|\| n > 6000/);
    assert.match(app, /function jsonBudgetOverride\(\)/);
    assert.match(app, /if \(!devPage\(\)\) return undefined/);
    assert.match(app, /areaCap: areaCapOverride\(\)/);
    assert.match(app, /jsonBudget: jsonBudgetOverride\(\)/);
    assert.match(app, /terrainFloors: terrainFloorsOverride\(\)/);
    assert.match(app, /OpenClutterExport\.terrainPasteLine/);
    assert.equal(/\u2014/.test(app.slice(app.indexOf("function areaCapOverride"), app.indexOf("function selectedImageryQuality"))), false);
    const clutterSrc = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(clutterSrc, /const areaCapOverride = devHost \? parseAreaCapOverride\(body\.areaCap\) : 0/);
    assert.match(clutterSrc, /const jsonBudgetOverride = devHost \? parseJsonBudgetOverride\(body\.jsonBudget\) : 0/);
    assert.match(clutterSrc, /const terrainFloors = devHost \? parseTerrainFloorOverride\(body\.terrainFloors\) : 0/);
    assert.match(app, /const ESRI_TILE_MAX_ZOOM = 23/);
    assert.match(app, /const mapZoom = devPage\(\) \? ESRI_TILE_MAX_ZOOM : 18/);
    assert.match(app, /L\.map\("map", \{ maxZoom: mapZoom \}\)/);
    assert.match(app, /World_Imagery\/MapServer\/tile/);
    assert.match(app, /imageryTiles\.options\.maxNativeZoom = z - 1/);
    assert.match(app, /Export is still working\./);
    assert.equal(/too large to finish in one export/.test(app), false);
    assert.equal(/resolution slider|imagery source/i.test(html + app), false);
  });

  it("distinguishes a drag box from a click polygon and still exports one bbox", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
    assert.match(html, /id="draw-hint"/);
    assert.match(html, /id="draw-hint"[^>]*>Drag a box, or click corners and click the first to close\.</);
    assert.equal(/\u2014/.test(html.slice(html.indexOf('id="draw-hint"'), html.indexOf('id="draw-hint"') + 160)), false);
    assert.equal(/finish-shape/.test(html), false);
    assert.equal(/Finish shape/.test(html + app), false);
    assert.match(app, /Click the first corner to close\. Double-click also finishes/);
    assert.match(app, /function enterDrawMode/);
    const afterDraw = app.split('getElementById("draw").onclick')[1] || "";
    assert.ok((afterDraw.match(/enterDrawMode\(/g) || []).length >= 2);
    assert.equal(/enterDrawMode\("Click the map to draw\. Drag a box/.test(app), false);
    assert.match(app, /if \(!drawSession\.armed\)/);
    assert.match(app, /prepareExport/);
    assert.match(app, /dblclick/);
    assert.match(app, /Export was not run/);
    assert.equal(/Right-click finishes/.test(html + app), false);
    assert.match(html, /src="\/site-draw\.js"/);
    assert.equal(/leaflet-draw/.test(html), false);
    assert.equal(/<dialog/i.test(html), false);
    assert.equal((html.match(/<select/gi) || []).length, 1);
    assert.match(html, /id="map-quality"/);
    assert.match(app, /bboxReadout/);
    assert.match(app, /polygonReadout/);
    assert.match(html, /area-quiet/);
    assert.equal(/formatBboxFeet|formatPolygonSqFt|SQFT/.test(app), false);
    assert.equal(/unit toggle|id="unit/.test(html + app), false);
    assert.match(app, /contextmenu/);
    const menuAt = app.indexOf('"contextmenu"');
    const menuBody = app.slice(menuAt, menuAt + 160);
    assert.match(menuBody, /preventDefault/);
    assert.equal(/finish\(/.test(menuBody), false);
    assert.match(app, /map\.panBy/);
    assert.match(app, /function releasePanelFocus/);
    assert.match(app, /function typingTarget/);
    const typingFn = app.slice(app.indexOf("function typingTarget"), app.indexOf("function panGesture"));
    assert.match(typingFn, /type === "search"/);
    assert.equal(/tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/.test(typingFn), false);
    const spaceAt = app.indexOf('ev.code === "Space"');
    const spaceBody = app.slice(spaceAt, spaceAt + 220);
    assert.match(spaceBody, /releasePanelFocus/);
    assert.match(spaceBody, /preventDefault/);
    assert.match(app, /ev\.code === "Space"/);
    assert.match(app, /ev\.button === 2/);
    assert.match(app, /Escape/);
    assert.match(app, /commit-box/);
    assert.match(app, /commit-polygon/);
    assert.match(app, /\/api\/clutter/);
    assert.match(app, /\.\.\.bbox/);
    assert.equal(/\/api\/clutter-polygon/.test(app), false);
    assert.match(app, /OpenClutterDraw/);
    assert.equal(/L\.Draw/.test(app), false);
  });
});

describe("attenuation cap keeps discrete trees", () => {
  it("keeps a stemmed tree ahead of a canopy that was listed first", () => {
    const canopy = { id: "canopy" };
    const tree = { id: "crown" };
    const layer = { id: "layer" };
    const trunk = { id: "trunk" };
    const capped = capBuildingsAndTrees(
      [{ id: "building" }],
      [canopy, tree, layer, trunk],
      ["canopy", "canopy", "layer", "trunk"],
      4
    );
    assert.deepEqual(capped.areas.map((a) => a.id), ["building", "crown", "layer", "trunk"]);
    assert.equal(capped.dropped, 1);
    assert.equal(capped.discreteTrees, 1);
    assert.equal(capped.droppedTrees, 1);
  });

  it("keeps slope canopy when stemmed trees would otherwise fill the cap", () => {
    const buildings = [];
    for (let i = 0; i < 6; i++) buildings.push({ id: "b" + i });
    const trees = [];
    const kinds = [];
    for (let i = 0; i < 4; i++) {
      trees.push({ id: "slope" + i });
      kinds.push("slope");
    }
    for (let i = 0; i < 4; i++) {
      trees.push({ id: "crown" + i });
      kinds.push("canopy");
      trees.push({ id: "trunk" + i });
      kinds.push("trunk");
    }
    const capped = capBuildingsAndTrees(buildings, trees, kinds, 10);
    const ids = capped.areas.map((a) => a.id);
    assert.ok(ids.filter((id) => String(id).indexOf("slope") === 0).length >= 2, ids.join(","));
    assert.ok(ids.some((id) => String(id).indexOf("crown") === 0), ids.join(","));
  });

  it("holds water and parking slots before a canopy spends them", () => {
    const canopy = { id: "canopy" };
    const tree = { id: "crown" };
    const layer = { id: "layer" };
    const trunk = { id: "trunk" };
    const capped = capBuildingsAndTrees(
      [{ id: "building" }],
      [canopy, tree, layer, trunk],
      ["canopy", "canopy", "layer", "trunk"],
      5,
      1
    );
    assert.deepEqual(capped.areas.map((a) => a.id), ["building", "crown", "layer", "trunk"]);
    assert.equal(capped.droppedBuildings, 0);
    assert.equal(capped.treeGroups, 1);
    assert.equal(5 - capped.areas.length, 1);
  });

  it("keeps a taller roof ahead of a larger short roof when the area budget is full", () => {
    const frame = geoFrame(WYNN);
    const lon = frame.west + (frame.east - frame.west) * 0.2;
    const lat = frame.south + (frame.north - frame.south) * 0.2;
    const shortWide = squareFeature(lon, lat, lon + 0.0032, lat + 0.0032, {
      height: 6,
      heightSource: "ms-global",
    });
    const tall = squareFeature(lon + 0.005, lat, lon + 0.0066, lat + 0.0016, {
      height: 80,
      heightSource: "ms-global",
    });
    const notes = [];
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [shortWide, tall] },
      name: "Priority",
      warnings: notes,
      maxAttenuationAreas: 1,
    });
    assert.equal(built.stats.buildingsKept, 1);
    const mat = built.openintent.floorplans[0].attenuation_areas[0].area_material;
    assert.ok(mat.top_height > 40, mat.name + " top " + mat.top_height);
    const text = notes.join(" ");
    assert.match(text, /largest, tallest roofs/);
    assert.match(text, /did not fit in the 1 area budget/);
    assert.match(built.stats.summary, /Area cap 1\./);
    assert.equal(/test override/.test(built.stats.summary), false);
  });
});

describe("dev area cap override", () => {
  it("accepts 982 through 5000 and ignores anything else", () => {
    assert.equal(parseAreaCapOverride(982), 982);
    assert.equal(parseAreaCapOverride(1500), 1500);
    assert.equal(parseAreaCapOverride(5000), 5000);
    assert.equal(parseAreaCapOverride("3000"), 3000);
    assert.equal(parseAreaCapOverride(" 1500 "), 1500);
    assert.equal(parseAreaCapOverride(981), 0);
    assert.equal(parseAreaCapOverride(5001), 0);
    assert.equal(parseAreaCapOverride(6000), 0);
    assert.equal(parseAreaCapOverride(1500.5), 0);
    assert.equal(parseAreaCapOverride("1500.5"), 0);
    assert.equal(parseAreaCapOverride("foo"), 0);
    assert.equal(parseAreaCapOverride(""), 0);
    assert.equal(parseAreaCapOverride(null), 0);
    assert.equal(raisedDeckCap(982), 0);
    assert.ok(raisedDeckCap(1500) >= 160);
    assert.ok(raisedDeckCap(5000) > raisedDeckCap(1500));
  });

  it("names the active cap, and the override, in the details line", () => {
    const base = { buildingsKept: 1, fetched: 1, attenuationAreasEmitted: 1, includeFoliage: false, treesKept: 0, treesSource: "none" };
    assert.match(coverageSummary(base), /Byte budget 3\.80 MB\. Sanity cap 5000\.$/);
    const named = coverageSummary(Object.assign({}, base, {
      largeDropNotes: ["Dropped building 1200 m2: triangular outline covered open ground."],
    }));
    assert.match(named, /Dropped building 1200 m2: triangular outline covered open ground\./);
    assert.equal(/\u2014/.test(named), false);
    assert.equal(/test override/.test(coverageSummary(base)), false);
    assert.match(coverageSummary(Object.assign({}, base, { areaCap: 3000, areaCapOverride: true })), /Area cap 3000 \(test override\)\.$/);
    assert.match(coverageSummary(Object.assign({}, base, { areaCap: 982, areaCapOverride: true })), /Area cap 982 \(test override\)\.$/);
    assert.equal(/\u2014/.test(coverageSummary(Object.assign({}, base, { areaCap: 3000, areaCapOverride: true }))), false);
    const sized = coverageSummary(Object.assign({}, base, {
      openIntentJsonBytes: 1250000,
      jsonBudget: 3800000,
      stoppedBy: "count",
      areaCap: 982,
    }));
    assert.match(sized, /OpenIntent JSON 1\.25 MB\. Stopped at area cap 982\./);
    const budgeted = coverageSummary(Object.assign({}, base, {
      openIntentJsonBytes: 3799917,
      jsonBudget: 3800000,
      stoppedBy: "bytes",
      areaCap: 5000,
      areaCapOverride: true,
    }));
    assert.match(budgeted, /OpenIntent JSON 3\.80 MB\. Stopped at the 3\.80 MB byte budget\./);
    assert.equal(/\u2014/.test(budgeted), false);
  });

  it("accepts a dev JSON budget from 3.8 MB through 5 MB", () => {
    assert.equal(OPENINTENT_JSON_BUDGET, 3800000);
    assert.equal(JSON_BUDGET_MAX, 5000000);
    assert.equal(parseJsonBudgetOverride(3800000), 3800000);
    assert.equal(parseJsonBudgetOverride(4500000), 4500000);
    assert.equal(parseJsonBudgetOverride("4500000"), 4500000);
    assert.equal(parseJsonBudgetOverride(5000000), 5000000);
    assert.equal(parseJsonBudgetOverride(3799999), 0);
    assert.equal(parseJsonBudgetOverride(5000001), 0);
    assert.equal(parseJsonBudgetOverride(4500000.5), 0);
    assert.equal(parseJsonBudgetOverride("4.5e6"), 0);
    assert.equal(parseJsonBudgetOverride(""), 0);
  });

  it("stops at the byte budget before the count cap and keeps pixel vertices", () => {
    const frame = geoFrame(WYNN);
    const lon = frame.west + (frame.east - frame.west) * 0.2;
    const lat = frame.south + (frame.north - frame.south) * 0.2;
    const tall = squareFeature(lon + 0.005, lat, lon + 0.0066, lat + 0.0016, {
      height: 80,
      heightSource: "ms-global",
    });
    const shortWide = squareFeature(lon, lat, lon + 0.0032, lat + 0.0032, {
      height: 6,
      heightSource: "ms-global",
    });
    const both = buildClutter({
      frame,
      footprintsGeojson: { features: [shortWide, tall] },
      name: "Byte one",
      maxAttenuationAreas: 5,
    });
    assert.equal(both.stats.attenuationAreasEmitted, 2);
    assert.equal(both.stats.stoppedBy, "areas");
    assert.match(both.stats.summary, /Every area fit\./);
    const two = buildClutter({
      frame,
      footprintsGeojson: { features: [shortWide, tall] },
      name: "Byte one",
      maxAttenuationAreas: 5,
      jsonBudget: both.stats.openIntentJsonBytes - 1,
    });
    assert.equal(two.stats.attenuationAreasEmitted, 1);
    assert.equal(two.stats.stoppedBy, "bytes");
    assert.ok(two.stats.openIntentJsonBytes <= both.stats.openIntentJsonBytes - 1);
    assert.match(two.stats.summary, /Stopped at the \d+\.\d+ MB byte budget/);
    assert.equal(/\u2014/.test(two.stats.summary), false);
    const coords = two.openintent.floorplans[0].attenuation_areas[0].area.coordinates;
    assert.equal(coords.every((c) => c.coordinate_xyz.unit === "pixels"), true);
    const underCap = buildClutter({
      frame,
      footprintsGeojson: { features: [shortWide, tall] },
      name: "Byte one",
      maxAttenuationAreas: 1,
    });
    assert.equal(underCap.stats.stoppedBy, "count");
    assert.match(underCap.stats.summary, /Stopped at area cap 1\./);
    assert.ok(underCap.stats.openIntentJsonBytes < OPENINTENT_JSON_BUDGET);
  });

  it("gives slots above 982 to buildings, trees, and decks", () => {
    const counts = { buildings: 4500, treeAreas: 2000, deckCount: 700, waterParking: 8 };
    const at982 = raisedAreaHolds(982, counts);
    assert.equal(at982.buildingLimit + at982.treeHold + at982.deckHold + at982.waterHold <= 982, true);
    const low = raisedAreaHolds(1500, counts);
    const mid = raisedAreaHolds(3000, counts);
    const high = raisedAreaHolds(5000, counts);
    for (const hold of [low, mid, high]) {
      const sum = hold.buildingLimit + hold.treeHold + hold.deckHold + hold.waterHold;
      assert.equal(sum, hold === low ? 1500 : hold === mid ? 3000 : 5000);
    }
    assert.ok(low.buildingLimit > 982);
    assert.ok(mid.buildingLimit > low.buildingLimit);
    assert.ok(high.buildingLimit > mid.buildingLimit);
    assert.ok(low.treeHold > 0);
    assert.ok(mid.treeHold > low.treeHold);
    assert.ok(high.treeHold > mid.treeHold);
    assert.ok(low.deckHold >= 96);
    assert.ok(mid.deckHold > low.deckHold);
    assert.ok(high.deckHold > mid.deckHold);
    assert.equal(low.waterHold, 8);
    assert.equal(MAX_ATTENUATION_AREAS, 982);
  });

  it("stops building pieces at the ceiling the caller sets", () => {
    const frame = geoFrame(WYNN);
    const features = [];
    for (let i = 0; i < 4; i++) {
      const lon = frame.west + 0.001 + i * 0.002;
      const lat = frame.south + 0.001;
      features.push(squareFeature(lon, lat, lon + 0.0008, lat + 0.0008, { height: 12 }));
    }
    const capped = footprintsToClutter(features, frame, null, null, { buildingCeiling: 2 });
    assert.equal(capped.oiAreas.length, 2);
    assert.ok(capped.stats.droppedCap >= 2);
    const open = footprintsToClutter(features, frame);
    assert.equal(open.oiAreas.length, 4);
    assert.equal(open.stats.droppedCap, 0);
  });
});

function pixelRoof(pts, bottom, top) {
  return {
    area: {
      coordinates: pts.map(([x, y]) => ({ coordinate_xyz: { x, y, unit: "pixels" } })),
    },
    area_material: { name: "Building - " + top.toFixed(1) + " @ " + bottom.toFixed(1), bottom_height: bottom, top_height: top },
  };
}

describe("same-seat roofs", () => {
  it("drops an outline that sits inside a larger roof and seats a taller tower on it", () => {
    const outer = pixelRoof(
      [
        [0, 0],
        [100, 0],
        [100, 80],
        [0, 80],
        [0, 0],
      ],
      10,
      22
    );
    const duplicate = pixelRoof(
      [
        [10, 10],
        [40, 10],
        [40, 40],
        [10, 40],
        [10, 10],
      ],
      11,
      20
    );
    const tower = pixelRoof(
      [
        [60, 10],
        [80, 10],
        [80, 40],
        [60, 40],
        [60, 10],
      ],
      10.5,
      90
    );
    const band = pixelRoof(
      [
        [20, 50],
        [40, 50],
        [40, 70],
        [20, 70],
        [20, 50],
      ],
      22,
      40
    );
    const areas = [duplicate, tower, outer, band];
    assert.equal(dropNestedDuplicateRoofs(areas), 1);
    assert.equal(areas.length, 3);
    const seated = areas.find((a) => a.area_material.top_height === 90);
    assert.equal(seated.area_material.bottom_height, 22);
    assert.equal(seated.area_material.name, "Building - 68.0 @ 22.0");
    assert.ok(areas.some((a) => a.area_material.top_height === 40));
    assert.ok(areas.some((a) => a.area_material.top_height === 22));
  });
});

describe("water stays when crowns would fill the area cap", () => {
  it("keeps the pond and drops the wall and the pole before the extra crown", () => {
    const w = 48;
    const h = 48;
    const cell = 2.2;
    const values = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 30, y - 30) <= 3.4) values[y * w + x] = 16;
        if (y >= 2 && y <= 6 && x >= 2 && x <= 8) values[y * w + x] = 3;
      }
    }
    const midLat = 42.9;
    const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
    const west = -87.93;
    const south = 42.89;
    const grid = {
      west,
      south,
      east: west + (w * cell) / mLon,
      north: south + (h * cell) / 110540,
      width: w,
      height: h,
      values,
    };
    const frame = geoFrame({ west, south, east: grid.east, north: grid.north, name: "Pond" });
    const dLon = (frame.east - frame.west) * 0.08;
    const dLat = (frame.north - frame.south) * 0.08;
    const lon0 = frame.west + (frame.east - frame.west) * 0.55;
    const lat0 = frame.south + (frame.north - frame.south) * 0.02;
    const warnings = [];
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [
          {
            type: "Feature",
            properties: { height: 8 },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [lon0, lat0],
                [lon0 + dLon, lat0],
                [lon0 + dLon, lat0 + dLat],
                [lon0, lat0 + dLat],
                [lon0, lat0],
              ]],
            },
          },
        ],
      },
      name: "Pond",
      warnings,
      includeFoliage: true,
      chmGrid: grid,
      treesSource: "chm",
      includeWater: true,
      includeWalls: true,
      includePoles: true,
      maxAttenuationAreas: 7,
      outdoorFeatures: [
        {
          kind: "water",
          coords: [
            [frame.west + (frame.east - frame.west) * 0.55, frame.south + (frame.north - frame.south) * 0.55],
            [frame.west + (frame.east - frame.west) * 0.85, frame.south + (frame.north - frame.south) * 0.55],
            [frame.west + (frame.east - frame.west) * 0.85, frame.south + (frame.north - frame.south) * 0.85],
            [frame.west + (frame.east - frame.west) * 0.55, frame.south + (frame.north - frame.south) * 0.85],
            [frame.west + (frame.east - frame.west) * 0.55, frame.south + (frame.north - frame.south) * 0.55],
          ],
          heightM: 2.1,
          explicitHeight: false,
        },
        {
          kind: "wall",
          coords: [
            [frame.west + (frame.east - frame.west) * 0.45, frame.south + (frame.north - frame.south) * 0.15],
            [frame.west + (frame.east - frame.west) * 0.45, frame.south + (frame.north - frame.south) * 0.4],
          ],
          heightM: 2.5,
          explicitHeight: true,
        },
        {
          kind: "pole",
          coords: [[(frame.west + frame.east) / 2, frame.south + (frame.north - frame.south) * 0.48]],
          heightM: 9,
          explicitHeight: false,
          rank: 0,
        },
      ],
    });
    assert.equal(built.stats.waterAreas, 1, built.stats.summary);
    assert.equal(built.stats.wallAreas, 0);
    assert.equal(built.stats.poleAreas, 0);
    assert.match(built.stats.summary, /Water 1/);
    assert.match(built.stats.summary, /Trees 1 kept of 2 \(1 stems, chm\)/);
    assert.equal(/Water left out/.test(warnings.join("\n")), false);
    assert.match(warnings.join("\n"), /Walls left out/);
    assert.match(warnings.join("\n"), /Light poles left out/);
    assert.equal(built.stats.attenuationAreasEmitted, 7);
  });
});

describe("RVs fill after buildings and before extra trees", () => {
  it("keeps the trailers when crowns would take the leftover slots", () => {
    const frame = geoFrame(WYNN);
    const lon = frame.west + (frame.east - frame.west) * 0.15;
    const lat = frame.south + (frame.north - frame.south) * 0.15;
    const dLon = 0.0004;
    const dLat = 0.00025;
    const features = [];
    for (let i = 0; i < 3; i++) {
      features.push(
        squareFeature(lon + i * 0.0012, lat, lon + i * 0.0012 + dLon, lat + dLat, { height: 12 })
      );
    }
    const hits = canopyHitsGrid(frame, frame.west + (frame.east - frame.west) * 0.7, frame.south + (frame.north - frame.south) * 0.7, {
      cols: 4,
      rows: 3,
      pct: 80,
    });
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const rv = [];
    for (let i = 0; i < 4; i++) {
      const x = lon + 0.004 + (i * 14) / mLon;
      const y = lat + 0.001;
      rv.push({
        kind: "rv",
        coords: [
          [x, y],
          [x + 12 / mLon, y],
          [x + 12 / mLon, y + 2.6 / 110540],
          [x, y + 2.6 / 110540],
          [x, y],
        ],
        heightM: 3.5,
        explicitHeight: true,
      });
    }
    const built = buildClutter({
      frame,
      footprintsGeojson: { features },
      treePoints: [{ lon: hits[0].lon, lat: hits[0].lat, pct: 80, heightM: 12, median: true }],
      canopyHits: hits,
      name: "RV cap",
      treesSource: "nlcd-canopy",
      includeFoliage: true,
      includeRvs: true,
      maxAttenuationAreas: 5,
      outdoorFeatures: rv,
    });
    assert.equal(built.stats.openIntentBuildingAreas, 3);
    assert.equal(built.stats.rvAreas, 2);
    assert.equal(built.stats.openIntentTreeAreas, 0);
    assert.match(built.stats.summary, /RVs 2/);
    const off = buildClutter({
      frame,
      footprintsGeojson: { features },
      treePoints: [{ lon: hits[0].lon, lat: hits[0].lat, pct: 80, heightM: 12, median: true }],
      canopyHits: hits,
      name: "RV off",
      treesSource: "nlcd-canopy",
      includeFoliage: true,
      includeRvs: false,
      maxAttenuationAreas: 5,
      outdoorFeatures: rv,
    });
    assert.equal(off.stats.rvAreas, 0);
    assert.ok(off.stats.openIntentTreeAreas > 0);
  });
});
