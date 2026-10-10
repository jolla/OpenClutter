"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame, pxToLl, clipboardToLl } = require("../netlify/lib/geo-frame");
const { footprintsToClutter, capOiRingPx, ringAreaPx } = require("../netlify/lib/pipeline");
const {
  parseBuildingDetail,
  shapeBuildings,
  footprintRings,
  pointInRingLL,
  centroidLL,
} = require("../netlify/lib/building-shape");

function metersBox(lon, lat, widthM, heightM, props) {
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLon = widthM / mx;
  const dLat = heightM / 110540;
  return {
    type: "Feature",
    properties: Object.assign({}, props),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [lon - dLon / 2, lat - dLat / 2],
        [lon + dLon / 2, lat - dLat / 2],
        [lon + dLon / 2, lat + dLat / 2],
        [lon - dLon / 2, lat + dLat / 2],
        [lon - dLon / 2, lat - dLat / 2],
      ]],
    },
  };
}

function ringOf(feature) {
  return feature.geometry.coordinates[0];
}

describe("building outlines", () => {
  const lon = -115.165;
  const lat = 36.128;

  it("opens a courtyard hole instead of filling it", () => {
    const outer = metersBox(lon, lat, 80, 60);
    const hole = metersBox(lon, lat, 20, 16);
    const feature = {
      type: "Feature",
      properties: { height: 12, heightSource: "overture" },
      geometry: {
        type: "Polygon",
        coordinates: [ringOf(outer), ringOf(hole)],
      },
    };
    const rings = footprintRings(feature.geometry);
    assert.ok(rings.length >= 1);
    const court = centroidLL(ringOf(hole));
    for (let i = 0; i < rings.length; i++) {
      assert.equal(pointInRingLL(court, rings[i]), false, "courtyard centroid is inside a roof");
    }
  });

  it("notches a pool out of a complex outline and keeps a part height", () => {
    const parent = metersBox(lon, lat, 180, 120, {
      height: 14,
      heightSource: "overture",
      geomSource: "overture",
    });
    const pool = metersBox(lon, lat + 0.00015, 36, 18);
    const wing = metersBox(lon - 0.00035, lat, 50, 40, {
      height: 16,
      heightSource: "osm",
      geomSource: "osm-part",
      buildingPart: true,
      levelBaseM: 4,
    });
    const shaped = shapeBuildings([parent], { parts: [wing], openings: [ringOf(pool)] });
    assert.equal(shaped.stats.parts, 1);
    assert.equal(shaped.stats.openings, 1);
    const poolAt = centroidLL(ringOf(pool));
    for (let i = 0; i < shaped.features.length; i++) {
      const rings = footprintRings(shaped.features[i].geometry);
      for (let r = 0; r < rings.length; r++) {
        assert.equal(pointInRingLL(poolAt, rings[r]), false);
      }
    }
    const part = shaped.features.find((f) => f.properties && f.properties.buildingPart);
    assert.ok(part);
    assert.equal(part.properties.levelBaseM, 4);
    assert.equal(part.properties.height, 16);
    const frame = geoFrame({
      west: lon - 0.002,
      south: lat - 0.0015,
      east: lon + 0.002,
      north: lat + 0.0015,
      name: "Pool",
    });
    const built = footprintsToClutter(shaped.features, frame, null);
    assert.ok(built.stats.buildings >= 1);
    let covered = 0;
    for (let i = 0; i < built.overlayRings.length; i++) {
      const ring = built.overlayRings[i].map((p) => pxToLl(p[0], p[1], frame));
      if (pointInRingLL(poolAt, ring)) covered++;
    }
    assert.equal(covered, 0);
  });

  it("reads an OSM part height and min_height, and a pool as an opening", () => {
    const parsed = parseBuildingDetail({
      elements: [
        {
          type: "way",
          tags: { "building:part": "yes", height: "112 m", min_height: "18", name: "Sphere" },
          geometry: [
            { lon: -115.16, lat: 36.12 },
            { lon: -115.159, lat: 36.12 },
            { lon: -115.159, lat: 36.121 },
            { lon: -115.16, lat: 36.121 },
            { lon: -115.16, lat: 36.12 },
          ],
        },
        {
          type: "way",
          tags: { leisure: "swimming_pool" },
          geometry: [
            { lon: -115.1647, lat: 36.1256 },
            { lon: -115.1645, lat: 36.1256 },
            { lon: -115.1645, lat: 36.1258 },
            { lon: -115.1647, lat: 36.1258 },
            { lon: -115.1647, lat: 36.1256 },
          ],
        },
        {
          type: "way",
          tags: { building: "hotel", name: "Encore" },
          geometry: [
            { lon: -115.17, lat: 36.12 },
            { lon: -115.169, lat: 36.12 },
            { lon: -115.169, lat: 36.121 },
            { lon: -115.17, lat: 36.121 },
            { lon: -115.17, lat: 36.12 },
          ],
        },
      ],
    });
    assert.equal(parsed.parts.length, 1);
    assert.equal(parsed.buildings.length, 1);
    assert.equal(parsed.parts[0].properties.height, 112);
    assert.equal(parsed.parts[0].properties.levelBaseM, undefined);
    assert.equal(parsed.parts[0].properties.buildingPart, true);
    assert.equal(parsed.openings.length, 1);
  });

  it("floats a small sky bridge and keeps a large min_height part on the ground", () => {
    const lat = 36.1188;
    const lon = -115.1682;
    const mx = 111320 * Math.cos((lat * Math.PI) / 180);
    const dLon = 36 / mx;
    const dLat = 8 / 110540;
    const bridge = [
      { lon: lon - dLon / 2, lat: lat - dLat / 2 },
      { lon: lon + dLon / 2, lat: lat - dLat / 2 },
      { lon: lon + dLon / 2, lat: lat + dLat / 2 },
      { lon: lon - dLon / 2, lat: lat + dLat / 2 },
      { lon: lon - dLon / 2, lat: lat - dLat / 2 },
    ];
    const garage = [
      { lon: -115.164, lat: 36.1204 },
      { lon: -115.1628, lat: 36.1204 },
      { lon: -115.1628, lat: 36.1214 },
      { lon: -115.164, lat: 36.1214 },
      { lon: -115.164, lat: 36.1204 },
    ];
    const parsed = parseBuildingDetail({
      elements: [
        {
          type: "way",
          tags: {
            man_made: "bridge",
            bridge: "yes",
            covered: "yes",
            "building:levels": "1",
            "building:min_level": "1",
            name: "Sky Bridge",
          },
          geometry: bridge,
        },
        {
          type: "way",
          tags: {
            "building:part": "yes",
            height: "25",
            min_height: "18",
            amenity: "parking",
            parking: "multi-storey",
            name: "Wynn Employee Parking",
          },
          geometry: garage,
        },
      ],
    });
    const sky = parsed.parts.find((p) => p.properties && p.properties.floatSpan);
    const deck = parsed.parts.find((p) => p.properties && p.properties.partName === "Wynn Employee Parking");
    assert.ok(sky);
    assert.equal(sky.properties.levelBaseM, 3);
    assert.equal(sky.properties.height, 6);
    assert.ok(deck);
    assert.equal(deck.properties.height, 25);
    assert.equal(deck.properties.levelBaseM, undefined);
  });

  it("keeps the parent when the only part does not reach the ground", () => {
    const parent = metersBox(lon, lat, 80, 60, {
      height: 12,
      heightSource: "overture",
      geomSource: "overture",
    });
    const pool = metersBox(lon + 0.0002, lat, 16, 12);
    const deck = metersBox(lon - 0.00005, lat, 28, 18, {
      height: 12,
      heightSource: "osm",
      geomSource: "osm-part",
      buildingPart: true,
      levelBaseM: 6,
      floatSpan: true,
    });
    const shaped = shapeBuildings([parent], { parts: [deck], openings: [ringOf(pool)] });
    const ground = shaped.features.filter((f) => !(f.properties && f.properties.buildingPart));
    assert.ok(ground.length >= 1, "parent dropped even though the part starts at 6 m");
    const span = shaped.features.find((f) => f.properties && f.properties.floatSpan);
    assert.ok(span);
    assert.equal(span.properties.levelBaseM, 6);
  });

  it("does not let the vertex cap fill a courtyard", () => {
    const pts = [];
    for (let x = 0; x <= 40; x += 2) pts.push([x, 0]);
    for (let y = 0; y <= 50; y += 2) pts.push([40, y]);
    for (let x = 40; x <= 160; x += 2) pts.push([x, 50]);
    for (let y = 50; y >= 0; y -= 2) pts.push([160, y]);
    for (let x = 160; x <= 200; x += 2) pts.push([x, 0]);
    for (let y = 0; y <= 80; y += 2) pts.push([200, y]);
    for (let x = 200; x >= 0; x -= 2) pts.push([x, 80]);
    for (let y = 80; y >= 0; y -= 2) pts.push([0, y]);
    pts.push(pts[0]);
    const before = ringAreaPx(pts);
    const capped = capOiRingPx(pts, 40, { maxEpsPx: 2, keepOutPx: [[100, 20]] });
    assert.ok(capped.length >= 4);
    const after = ringAreaPx(capped);
    assert.ok(after <= before * 1.08, `area ${after} grew from ${before}`);
    assert.equal(pointInRingLL([100, 20], capped), false);
  });

  function metersPoly(originLon, originLat, offsets, props) {
    const mx = 111320 * Math.cos((originLat * Math.PI) / 180);
    const ring = offsets.map(([east, north]) => [originLon + east / mx, originLat + north / 110540]);
    ring.push(ring[0].slice());
    return {
      type: "Feature",
      properties: Object.assign({ height: 12, heightSource: "overture", geomSource: "overture" }, props),
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  }

  it("replaces a triangular copy with the OSM outline of that building", () => {
    const wedge = metersPoly(lon, lat, [
      [0, 0],
      [200, 0],
      [40, 90],
    ]);
    const retail = [
      [0, 0],
      [80, 0],
      [80, -20],
      [140, -20],
      [140, 0],
      [200, 0],
      [40, 90],
    ];
    const shaped = shapeBuildings([wedge], {
      buildings: [metersPoly(lon, lat, retail).geometry.coordinates[0]],
    });
    assert.equal(shaped.stats.wedgesReplaced, 1);
    assert.equal(shaped.features.length, 1);
    const ring = shaped.features[0].geometry.coordinates[0];
    assert.ok(ring.length > 5, "retail outline kept its bay");
    const bay = metersPoly(lon, lat, [[100, -10]]).geometry.coordinates[0][0];
    assert.equal(pointInRingLL(bay, ring), true);
  });

  it("drops a triangular blanket that covers another roof", () => {
    const wedge = metersPoly(lon, lat, [
      [0, 0],
      [200, 0],
      [40, 90],
    ]);
    const tower = metersBox(lon + 0.00015, lat + 0.0002, 24, 18, {
      height: 180,
      heightSource: "overture",
      geomSource: "overture",
    });
    const shaped = shapeBuildings([wedge, tower], { buildings: [] });
    assert.equal(shaped.stats.wedgesDropped, 1);
    assert.equal(shaped.features.length, 1);
    assert.equal(shaped.features[0].properties.height, 180);
  });

  it("keeps a triangular building that does not cover another roof", () => {
    const wedge = metersPoly(lon, lat, [
      [0, 0],
      [200, 0],
      [40, 90],
    ]);
    const shaped = shapeBuildings([wedge], { buildings: [] });
    assert.equal(shaped.stats.wedgesDropped, 0);
    assert.equal(shaped.stats.wedgesReplaced, 0);
    assert.equal(shaped.features.length, 1);
  });

  function areaM(ring) {
    const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
    const lat0 = open.reduce((s, p) => s + p[1], 0) / open.length;
    const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const my = 110540;
    let a = 0;
    for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
      a += open[j][0] * mx * open[i][1] * my - open[i][0] * mx * open[j][1] * my;
    }
    return Math.abs(a) / 2;
  }

  function triOf(ring) {
    const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
    let cx = 0;
    let cy = 0;
    for (const p of open) {
      cx += p[0];
      cy += p[1];
    }
    cx /= open.length;
    cy /= open.length;
    const ranked = open.slice().sort((a, b) => (b[0] - cx) ** 2 + (b[1] - cy) ** 2 - ((a[0] - cx) ** 2 + (a[1] - cy) ** 2));
    let best = 0;
    const n = Math.min(12, ranked.length);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          const a = ranked[i];
          const b = ranked[j];
          const c = ranked[k];
          const t = Math.abs(a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2;
          if (t > best) best = t;
        }
      }
    }
    let poly = 0;
    for (let i = 0, j = open.length - 1; i < open.length; j = i++) poly += open[j][0] * open[i][1] - open[i][0] * open[j][1];
    poly = Math.abs(poly) / 2;
    return poly > 0 ? best / poly : 0;
  }

  it("drops a triangular blanket that covers a road", () => {
    const wedge = metersPoly(lon, lat, [
      [0, 0],
      [220, 0],
      [40, 100],
    ]);
    const mx = 111320 * Math.cos((lat * Math.PI) / 180);
    const road = [];
    for (let east = 30; east <= 140; east += 10) {
      road.push([lon + east / mx, lat + 35 / 110540]);
    }
    const shaped = shapeBuildings([wedge], { buildings: [], roads: [road] });
    assert.equal(shaped.stats.wedgesDropped, 1);
    assert.equal(shaped.features.length, 0);
    assert.match(shaped.stats.largeDrops.join(" "), /Dropped building \d+ m2: triangular outline covered open ground\./);
    assert.equal(shaped.stats.largeDrops.join(" ").includes("\u2014"), false);
  });

  it("drops a triangular blanket that covers a pool", () => {
    const wedge = metersPoly(lon, lat, [
      [0, 0],
      [220, 0],
      [40, 100],
    ]);
    const pool = metersBox(lon + 80 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 30 / 110540, 30, 18);
    const shaped = shapeBuildings([wedge], { buildings: [], openings: [ringOf(pool)] });
    assert.equal(shaped.stats.wedgesDropped, 1);
    assert.equal(shaped.features.length, 0);
  });

  function paintRect(data, width, height, frame, lon0, lat0, lon1, lat1, rgb) {
    const mx = 111320 * Math.cos((lat * Math.PI) / 180);
    for (let y = 0; y < height; y++) {
      const latP = frame.north - ((y + 0.5) / height) * (frame.north - frame.south);
      for (let x = 0; x < width; x++) {
        const lonP = frame.west + ((x + 0.5) / width) * (frame.east - frame.west);
        const east = (lonP - lon) * mx;
        const north = (latP - lat) * 110540;
        const e0 = (lon0 - lon) * mx;
        const n0 = (lat0 - lat) * 110540;
        const e1 = (lon1 - lon) * mx;
        const n1 = (lat1 - lat) * 110540;
        if (east < Math.min(e0, e1) || east > Math.max(e0, e1) || north < Math.min(n0, n1) || north > Math.max(n0, n1)) continue;
        const i = (y * width + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = 255;
      }
    }
  }

  function campusImagery(paint) {
    const width = 220;
    const height = 180;
    const frame = {
      west: lon - 0.0015,
      south: lat - 0.001,
      east: lon + 0.006,
      north: lat + 0.004,
    };
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 150;
      data[i + 1] = 148;
      data[i + 2] = 140;
      data[i + 3] = 255;
    }
    paint(data, width, height, frame);
    return { data, width, height, frame };
  }

  it("cuts a sprawling outline into a dark roof and a warm roof at 18 m", () => {
    const campus = metersPoly(lon, lat, [
      [0, 0],
      [420, 0],
      [200, 340],
    ], { height: 12, heightSource: "overture" });
    const imagery = campusImagery((data, width, height, frame) => {
      paintRect(data, width, height, frame, lon + 110 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 30 / 110540, lon + 210 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 130 / 110540, [28, 36, 40]);
      paintRect(data, width, height, frame, lon + 230 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 80 / 110540, lon + 320 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 180 / 110540, [214, 168, 132]);
    });
    const shaped = shapeBuildings([campus], { buildings: [], openings: [], roads: [], imagery });
    assert.equal(shaped.stats.coresCarved, 1);
    assert.equal(shaped.features.length, 2);
    for (let i = 0; i < shaped.features.length; i++) {
      assert.equal(shaped.features[i].properties.height, 18);
      const ring = shaped.features[i].geometry.coordinates[0];
      assert.ok(ring.length <= 6, "core stayed a rectangle");
    }
    const tip = [lon + 200 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 330 / 110540];
    let coversTip = false;
    for (let i = 0; i < shaped.features.length; i++) {
      if (pointInRingLL(tip, shaped.features[i].geometry.coordinates[0])) coversTip = true;
    }
    assert.equal(coversTip, false);
  });

  it("keeps the Wynn retail podium when roof cores replace the coarse triangle", () => {
    const fc = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/retail-111322055.geojson"), "utf8")
    );
    const osm = fc.features[0].geometry.coordinates[0];
    const tri = [
      [-115.1683421, 36.1256826],
      [-115.1641422, 36.12695],
      [-115.1668834, 36.128554],
      [-115.1683421, 36.1256826],
    ];
    const podium = [-115.1683, 36.12571];
    const golf = [-115.16775, 36.1259];
    const pool = [
      [-115.16755, 36.12555],
      [-115.16735, 36.12555],
      [-115.16735, 36.12572],
      [-115.16755, 36.12572],
      [-115.16755, 36.12555],
    ];
    const dark = [
      [-115.16547, 36.1269],
      [-115.1664, 36.12714],
      [-115.1668, 36.12611],
      [-115.16587, 36.12587],
      [-115.16547, 36.1269],
    ];
    const warm = [
      [-115.16435, 36.1276],
      [-115.16529, 36.12784],
      [-115.16572, 36.12674],
      [-115.16478, 36.1265],
      [-115.16435, 36.1276],
    ];
    assert.equal(fc.features[0].properties.osmId, 111322055);
    assert.equal(pointInRingLL(podium, osm), true);
    assert.equal(pointInRingLL(golf, tri), true);
    assert.equal(pointInRingLL(golf, osm), false);
    const poolAt = centroidLL(pool);
    assert.equal(pointInRingLL(poolAt, osm), true);
    const feature = {
      type: "Feature",
      properties: { height: 12, heightSource: "overture", geomSource: "overture" },
      geometry: { type: "Polygon", coordinates: [osm] },
    };
    const frameLL = { west: -115.1692, south: 36.1242, east: -115.1636, north: 36.1291 };
    const width = 480;
    const height = 420;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 150;
      data[i + 1] = 148;
      data[i + 2] = 140;
      data[i + 3] = 255;
    }
    function paint(ring, rgb) {
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (const p of ring) {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
      const spanX = frameLL.east - frameLL.west;
      const spanY = frameLL.north - frameLL.south;
      const x0 = Math.max(0, Math.floor(((minLon - frameLL.west) / spanX) * width) - 1);
      const x1 = Math.min(width - 1, Math.ceil(((maxLon - frameLL.west) / spanX) * width) + 1);
      const y0 = Math.max(0, Math.floor(((frameLL.north - maxLat) / spanY) * height) - 1);
      const y1 = Math.min(height - 1, Math.ceil(((frameLL.north - minLat) / spanY) * height) + 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const lon = frameLL.west + ((x + 0.5) / width) * spanX;
          const lat = frameLL.north - ((y + 0.5) / height) * spanY;
          if (!pointInRingLL([lon, lat], ring)) continue;
          const i = (y * width + x) * 4;
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
          data[i + 3] = 255;
        }
      }
    }
    paint(dark, [28, 36, 40]);
    paint(warm, [214, 168, 132]);
    const shaped = shapeBuildings([feature], {
      buildings: [osm],
      openings: [pool],
      roads: [],
      imagery: { data, width, height, frame: frameLL },
    });
    assert.equal(shaped.stats.coresCarved, 0);
    assert.equal(shaped.stats.largeDrops.length, 0);
    let podiumHit = 0;
    let golfHit = 0;
    let poolHit = 0;
    for (let i = 0; i < shaped.features.length; i++) {
      const ring = shaped.features[i].geometry.coordinates[0];
      if (pointInRingLL(podium, ring)) podiumHit++;
      if (pointInRingLL(golf, ring)) golfHit++;
      if (pointInRingLL(poolAt, ring)) poolHit++;
      assert.equal(shaped.features[i].properties.height, 18);
      const tri = triOf(ring);
      const area = areaM(ring);
      assert.ok(!(area > 5000 && tri >= 0.82), "diagonal piece tri " + tri.toFixed(2));
    }
    assert.ok(podiumHit >= 1, "retail wing was dropped");
    assert.equal(golfHit, 0);
    assert.equal(poolHit, 0);
    const copy = {
      type: "Feature",
      properties: { height: 12, heightSource: "overture", geomSource: "overture" },
      geometry: { type: "Polygon", coordinates: [tri] },
    };
    const restored = shapeBuildings([copy], { buildings: [osm], openings: [pool], roads: [] });
    assert.equal(restored.stats.wedgesReplaced, 1);
    assert.equal(restored.stats.wedgesDropped, 0);
    let restoredPodium = false;
    let restoredGolf = false;
    let restoredPool = false;
    for (let i = 0; i < restored.features.length; i++) {
      const ring = restored.features[i].geometry.coordinates[0];
      if (pointInRingLL(podium, ring)) restoredPodium = true;
      if (pointInRingLL(golf, ring)) restoredGolf = true;
      if (pointInRingLL(poolAt, ring)) restoredPool = true;
    }
    assert.equal(restoredPodium, true);
    assert.equal(restoredGolf, false);
    assert.equal(restoredPool, false);
    const map = geoFrame(
      { west: -115.1694, south: 36.1244, east: -115.1638, north: 36.1289, name: "Wynn podium" },
      { maxSide: 1600, metersPerPx: 0.5 }
    );
    const built = footprintsToClutter(shaped.features, map);
    let overlayPodium = 0;
    let overlayPool = 0;
    let overlayGolf = 0;
    for (let i = 0; i < built.overlayRings.length; i++) {
      const ring = built.overlayRings[i].map((p) => pxToLl(p[0], p[1], map));
      if (pointInRingLL(podium, ring)) overlayPodium++;
      if (pointInRingLL(poolAt, ring)) overlayPool++;
      if (pointInRingLL(golf, ring)) overlayGolf++;
    }
    assert.ok(overlayPodium >= 1, "podium missing after the vertex cap");
    assert.equal(overlayPool, 0);
    assert.equal(overlayGolf, 0);
    assert.equal(built.stats.largeDropNotes.join(" ").includes("\u2014"), false);
  });

  it("drops the diagonal podium wedge and keeps the retail ring on the solar block", () => {
    const fc = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/wynn-golf/retail-111322055.geojson"), "utf8")
    );
    const osm = fc.features[0].geometry.coordinates[0];
    const solar = [-115.16808, 36.12581];
    const wedgeAt = [-115.1683, 36.1268];
    const wedge = [
      [-115.168634, 36.126992],
      [-115.168124, 36.126321],
      [-115.168124, 36.126772],
      [-115.16759, 36.126772],
      [-115.167513, 36.127556],
      [-115.168634, 36.126992],
    ];
    assert.equal(pointInRingLL(solar, osm), true);
    assert.equal(pointInRingLL(wedgeAt, osm), false);
    const retail = {
      type: "Feature",
      properties: { height: 12, heightSource: "overture", geomSource: "overture" },
      geometry: { type: "Polygon", coordinates: [osm] },
    };
    const slab = {
      type: "Feature",
      properties: { height: 12, heightSource: "overture", geomSource: "overture" },
      geometry: { type: "Polygon", coordinates: [wedge] },
    };
    const shaped = shapeBuildings([retail, slab], { buildings: [osm], openings: [], roads: [] });
    assert.ok(shaped.stats.wedgesDropped >= 1);
    let solarHit = 0;
    let wedgeHit = 0;
    for (let i = 0; i < shaped.features.length; i++) {
      const ring = shaped.features[i].geometry.coordinates[0];
      if (pointInRingLL(solar, ring)) solarHit++;
      if (pointInRingLL(wedgeAt, ring)) wedgeHit++;
      const tri = triOf(ring);
      const area = areaM(ring);
      assert.ok(!(area > 5000 && tri >= 0.82), "diagonal piece area " + Math.round(area) + " tri " + tri.toFixed(2));
    }
    assert.ok(solarHit >= 1, "solar block missing");
    assert.equal(wedgeHit, 0);
    const map = geoFrame(
      { west: -115.1694, south: 36.1244, east: -115.1638, north: 36.1289, name: "Wynn solar" },
      { maxSide: 1600, metersPerPx: 0.5 }
    );
    const built = footprintsToClutter(shaped.features, map);
    let overlaySolar = 0;
    let overlayWedge = 0;
    for (let i = 0; i < built.overlayRings.length; i++) {
      const ring = built.overlayRings[i].map((p) => pxToLl(p[0], p[1], map));
      if (pointInRingLL(solar, ring)) overlaySolar++;
      if (pointInRingLL(wedgeAt, ring)) overlayWedge++;
      const tri = triOf(ring);
      const area = areaM(ring);
      assert.ok(!(area > 5000 && tri >= 0.82), "emitted wedge area " + Math.round(area) + " tri " + tri.toFixed(2));
    }
    assert.ok(overlaySolar >= 1, "solar missing after the vertex cap");
    assert.equal(overlayWedge, 0);
  });

  it("leaves a single-tone sprawling outline uncut", () => {
    const campus = metersPoly(lon, lat, [
      [0, 0],
      [420, 0],
      [200, 340],
    ], { height: 12, heightSource: "overture" });
    const imagery = campusImagery((data, width, height, frame) => {
      paintRect(data, width, height, frame, lon + 110 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 30 / 110540, lon + 210 / (111320 * Math.cos((lat * Math.PI) / 180)), lat + 130 / 110540, [28, 36, 40]);
    });
    const shaped = shapeBuildings([campus], { buildings: [], openings: [], roads: [], imagery });
    assert.equal(shaped.stats.coresCarved, 0);
    assert.equal(shaped.features.length, 1);
  });

  it("cuts a tapered campus spike and seats the low-rise body at 18 m", () => {
    const offsets = [
      [100, 0],
      [130, 90],
      [220, 90],
      [220, 160],
      [0, 160],
      [0, 90],
      [90, 90],
    ];
    const campus = metersPoly(lon, lat, offsets, { height: 12, heightSource: "overture" });
    const shaped = shapeBuildings([campus], { buildings: [], openings: [], roads: [] });
    assert.equal(shaped.stats.tapersCut, 1);
    assert.ok(shaped.features.length >= 1);
    const mx = 111320 * Math.cos((lat * Math.PI) / 180);
    const tip = [lon + 100 / mx, lat];
    let coversTip = false;
    for (let i = 0; i < shaped.features.length; i++) {
      const ring = shaped.features[i].geometry.coordinates[0];
      if (pointInRingLL(tip, ring)) coversTip = true;
      assert.equal(shaped.features[i].properties.height, 18);
    }
    assert.equal(coversTip, false);
  });

  it("keeps a plain rectangular roof as one area", () => {
    const box = metersBox(lon, lat, 40, 24, { height: 12, heightSource: "overture" });
    const frame = geoFrame(
      { west: lon - 0.002, south: lat - 0.0015, east: lon + 0.002, north: lat + 0.0015 },
      { maxSide: 1024, metersPerPx: 0.5 }
    );
    const built = footprintsToClutter([box], frame);
    assert.equal(built.clipZones.length, 1);
  });

  it("splits a concave roof instead of collapsing it to a wedge", () => {
    const offsets = [];
    for (let x = 0; x <= 240; x += 4) offsets.push([x, 0]);
    for (let y = 4; y <= 28; y += 4) offsets.push([240, y]);
    let x = 240;
    for (let t = 0; t < 12; t++) {
      x -= 8;
      offsets.push([x, 28]);
      offsets.push([x, 44]);
      x -= 12;
      offsets.push([x, 44]);
      offsets.push([x, 28]);
    }
    offsets.push([0, 0]);
    const mx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ring = offsets.map(([east, north]) => [lon + east / mx, lat + north / 110540]);
    ring.push(ring[0].slice());
    const feature = {
      type: "Feature",
      properties: { height: 18, heightSource: "overture", geomSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    const frame = geoFrame(
      { west: lon - 0.001, south: lat - 0.001, east: lon + 0.004, north: lat + 0.0015 },
      { maxSide: 2048, metersPerPx: 0.4 }
    );
    const built = footprintsToClutter([feature], frame);
    assert.ok(built.clipZones.length >= 2, "roof collapsed to " + built.clipZones.length + " area");
    let sum = 0;
    for (let i = 0; i < built.clipZones.length; i++) {
      const coords = built.clipZones[i].area.coordinates[0].map(([xM, yM]) => clipboardToLl(xM, yM, frame));
      const verts = coords.length > 1 ? coords.length - 1 : coords.length;
      assert.ok(verts <= 40, "piece has " + verts + " vertices");
      const area = areaM(coords);
      const tri = triOf(coords);
      sum += area;
      assert.ok(!(area > 5000 && tri >= 0.82), "piece is a wedge area " + Math.round(area) + " tri " + tri.toFixed(2));
    }
    const source = areaM(ring);
    assert.ok(sum > source * 0.75 && sum < source * 1.2, "pieces " + Math.round(sum) + " vs source " + Math.round(source));
  });

  it("keeps a narrow static caravan as a building", () => {
    const lon = -115.16;
    const lat = 36.12;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const dLon = 20 / mLon;
    const dLat = 1.4 / 110540;
    const ring = [
      { lon, lat },
      { lon: lon + dLon, lat },
      { lon: lon + dLon, lat: lat + dLat },
      { lon, lat: lat + dLat },
      { lon, lat },
    ];
    const parsed = parseBuildingDetail({
      elements: [
        { type: "way", tags: { building: "static_caravan" }, geometry: ring },
        { type: "way", tags: { building: "yes", name: "Lodge" }, geometry: ring },
      ],
    });
    assert.equal(parsed.parts.length, 1);
    assert.equal(parsed.parts[0].properties.staticCaravan, true);
    assert.equal(parsed.parts[0].properties.height, 3.5);
    const frame = geoFrame(
      { west: lon - 0.001, south: lat - 0.001, east: lon + 0.002, north: lat + 0.001, name: "Caravan" },
      { maxSide: 400, metersPerPx: 0.4 }
    );
    const kept = footprintsToClutter(parsed.parts, frame);
    assert.equal(kept.stats.buildings, 1);
    assert.equal(kept.stats.droppedSpan, 0);
    assert.equal(kept.oiAreas[0].area_material.name, "Building - 3.5");
    const plain = parsed.parts.map((f) => {
      const copy = JSON.parse(JSON.stringify(f));
      delete copy.properties.staticCaravan;
      return copy;
    });
    const dropped = footprintsToClutter(plain, frame);
    assert.equal(dropped.stats.buildings, 0);
    assert.equal(dropped.stats.droppedSpan, 1);
  });
});
