"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  projectYear,
  rankProjects,
  gpsDay,
  gridFromPoints,
  applyLidarSample,
  fetchUsgsLidar,
  mercator,
  HEIGHT_SOURCE,
  km2Of,
} = require("../netlify/lib/usgs-lidar");

const frame = { west: -115.17, south: 36.12, east: -115.16, north: 36.13 };
const CELL = 10;

function origin() {
  return mercator(frame.west, frame.south);
}

function corner(ix, iy) {
  const o = origin();
  const x = o[0] + ix * CELL;
  const y = o[1] + iy * CELL;
  const R = 20037508.342789244;
  const lon = (x * 180) / R;
  const lat = (Math.atan(Math.sinh((y * Math.PI) / R)) * 180) / Math.PI;
  return [lon, lat];
}

function pt(ix, iy, z, cls, extra) {
  const o = origin();
  return Object.assign(
    {
      x: o[0] + (ix + 0.5) * CELL,
      y: o[1] + (iy + 0.5) * CELL,
      z,
      cls,
      ret: 1,
      nret: 1,
    },
    extra || {}
  );
}

function ringAround(x0, y0, x1, y1) {
  const ring = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
  ring.push(ring[0]);
  return ring;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi > lat === yj > lat) continue;
    const x = ((ring[j][0] - ring[i][0]) * (lat - yi)) / (yj - yi) + ring[i][0];
    if (lon < x) inside = !inside;
  }
  return inside;
}

describe("USGS lidar", () => {
  it("reads a project year from the EPT name", () => {
    assert.equal(projectYear("NV_ClarkCo_2_B22"), 2022);
    assert.equal(projectYear("NV_Southern_5_D23"), 2023);
    assert.equal(projectYear("USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018"), 2018);
    assert.equal(projectYear("WI_StWide_8_Marathon_2021"), 2021);
  });

  it("turns adjusted GPS seconds into the flight day", () => {
    assert.equal(gpsDay(342964556.433), "2022-07-27");
  });

  it("picks a Nevada project for the Wynn box and a Wisconsin project for Granite Peak", () => {
    const wynn = rankProjects({ west: -115.16942, south: 36.120084, east: -115.153863, north: 36.131185 });
    assert.ok(wynn.length);
    assert.match(wynn[0][0], /^NV_/);
    const granite = rankProjects({ west: -89.7, south: 44.91, east: -89.684, north: 44.926 });
    assert.ok(granite.length);
    assert.match(granite[0][0], /^WI_/);
    const montreal = rankProjects({ west: -73.57, south: 45.5, east: -73.565, north: 45.5035 });
    assert.equal(montreal.length, 0);
  });

  it("skips downtown Montreal without calling the network", async () => {
    let called = 0;
    const sample = await fetchUsgsLidar(
      { west: -73.57, south: 45.5, east: -73.565, north: 45.5035 },
      {
        fetchImpl() {
          called++;
          throw new Error("network");
        },
      }
    );
    assert.equal(called, 0);
    assert.equal(sample.skipped, "outside-3dep");
    assert.match(sample.warning, /Quebec open lidar/);
    assert.ok(km2Of(sample.frame) > 0);
  });

  it("sets a footprint height from the 90th percentile of class 6 minus ground", () => {
    const points = [];
    for (let ix = 2; ix <= 6; ix++) {
      for (let iy = 2; iy <= 6; iy++) points.push(pt(ix, iy, 5, 2));
    }
    const roofs = [18, 18, 18, 18, 18, 18, 18, 19, 40];
    for (let i = 0; i < roofs.length; i++) points.push(pt(3 + (i % 3), 3 + Math.floor(i / 3), roofs[i], 6));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const feature = {
      type: "Feature",
      properties: { height: 9, heightSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ringAround(2, 2, 8, 8)] },
    };
    const applied = applyLidarSample([feature], [], grid);
    assert.equal(applied.heights, 1);
    assert.equal(applied.features[0].properties.heightSource, HEIGHT_SOURCE);
    assert.equal(applied.features[0].properties.height, 14);
    assert.equal(applied.added, 0);
  });

  it("adds an L-shaped roof the street map missed and leaves vegetation out", () => {
    const points = [];
    for (let ix = 8; ix <= 18; ix++) {
      for (let iy = 8; iy <= 18; iy++) points.push(pt(ix, iy, 4, 2));
    }
    for (let ix = 10; ix <= 15; ix++) {
      for (let iy = 10; iy <= 12; iy++) points.push(pt(ix, iy, 16, 6));
    }
    for (let ix = 10; ix <= 12; ix++) {
      for (let iy = 13; iy <= 16; iy++) points.push(pt(ix, iy, 16, 6));
    }
    for (let ix = 14; ix <= 15; ix++) {
      for (let iy = 14; iy <= 16; iy++) points.push(pt(ix, iy, 20, 5, { nret: 3, ret: 1 }));
    }
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const applied = applyLidarSample([], [], grid);
    assert.equal(applied.added, 1);
    const ring = applied.features[0].geometry.coordinates[0];
    assert.ok(ring.length >= 5);
    assert.equal(applied.features[0].properties.heightSource, HEIGHT_SOURCE);
    assert.ok(applied.features[0].properties.height >= 10);
    const notch = corner(14.5, 15.5);
    assert.equal(pointInRing(notch[0], notch[1], ring), false);
    const bar = corner(13.5, 11.5);
    assert.equal(pointInRing(bar[0], bar[1], ring), true);
  });

  it("does not replace a tower with a low coarse sample", () => {
    const points = [];
    for (let ix = 2; ix <= 6; ix++) {
      for (let iy = 2; iy <= 6; iy++) points.push(pt(ix, iy, 5, 2));
    }
    for (let i = 0; i < 8; i++) points.push(pt(3 + (i % 3), 3, 20, 6));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const feature = {
      type: "Feature",
      properties: { height: 174, heightSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ringAround(2, 2, 8, 8)] },
    };
    const applied = applyLidarSample([feature], [], grid);
    assert.equal(applied.heights, 0);
    assert.equal(applied.features[0].properties.height, 174);
    assert.equal(applied.features[0].properties.heightSource, "overture");
  });

  it("does not turn a bumpy unclassified crown into a building", () => {
    const points = [];
    for (let ix = 20; ix <= 28; ix++) {
      for (let iy = 20; iy <= 26; iy++) {
        points.push(pt(ix, iy, 5, 2));
        points.push(pt(ix, iy, 8, 1));
        points.push(pt(ix, iy, 14, 1));
        points.push(pt(ix, iy, 22, 1));
      }
    }
    for (let ix = 30; ix <= 36; ix++) {
      for (let iy = 20; iy <= 26; iy++) {
        points.push(pt(ix, iy, 5, 2));
        points.push(pt(ix, iy, 14, 1));
        points.push(pt(ix, iy, 14.4, 1));
        points.push(pt(ix, iy, 14.8, 1));
      }
    }
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const applied = applyLidarSample([], [], grid);
    assert.equal(applied.added, 1);
    const ring = applied.features[0].geometry.coordinates[0];
    const crown = corner(24.5, 23.5);
    const roof = corner(33.5, 23.5);
    assert.equal(pointInRing(crown[0], crown[1], ring), false);
    assert.equal(pointInRing(roof[0], roof[1], ring), true);
    assert.ok(applied.features[0].properties.height > 8);
    assert.ok(applied.features[0].properties.height < 12);
  });

  it("updates a tree from high vegetation and leaves a building height alone when the cloud is only trees", () => {
    const points = [];
    for (let ix = 2; ix <= 5; ix++) points.push(pt(ix, 2, 6, 2));
    points.push(pt(3, 3, 22, 5, { nret: 3, ret: 1 }));
    points.push(pt(3, 3, 21, 5, { nret: 3, ret: 2 }));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const tree = { lon: corner(3.5, 3.5)[0], lat: corner(3.5, 3.5)[1], heightM: 8 };
    const building = {
      type: "Feature",
      properties: { height: 11, heightSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ringAround(2, 2, 6, 6)] },
    };
    const applied = applyLidarSample([building], [tree], grid);
    assert.equal(applied.heights, 0);
    assert.equal(applied.features[0].properties.height, 11);
    assert.equal(applied.canopy, 1);
    assert.equal(applied.trees[0].heightSource, HEIGHT_SOURCE);
    assert.ok(applied.trees[0].heightM > 10);
  });

  it("sends lidar only from the dev query flag", () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    const toml = fs.readFileSync(path.join(__dirname, "../netlify.toml"), "utf8");
    assert.match(app, /function lidarEnabled\(\)/);
    assert.match(app, /get\("lidar"\)/);
    assert.match(app, /raw === "1"/);
    assert.equal(app.split("lidar: lidarEnabled()").length, 3);
    assert.match(clutter, /devHost && \(body\.lidar === true/);
    assert.match(toml, /external_node_modules = \["laz-perf"\]/);
  });
});
