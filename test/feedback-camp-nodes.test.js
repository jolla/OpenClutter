"use strict";

// Feedback #15 (Williams AZ KOA): a campground mapped only as a point got no
// RV read at all. campNodes (dev hosts) reads a circle around the point on
// the photo and keeps only a dense group of RVs near the point.

const test = require("node:test");
const assert = require("node:assert/strict");
const exportMode = require("../netlify/lib/export-mode");
const oc = require("../netlify/lib/outdoor-clutter");

const BBOX = { west: -112.15926, south: 35.32465, east: -112.15474, north: 35.32957 };
const KOA = { type: "node", id: 1, lon: -112.1575068, lat: 35.328879, tags: { tourism: "caravan_site", name: "KOA Campground" } };

function withCampNodes(on, fn) {
  const before = exportMode.isCampNodes();
  exportMode.setCampNodes(on);
  try {
    return fn();
  } finally {
    exportMode.setCampNodes(before);
  }
}

function rvWindows(features) {
  return features.filter((f) => f && f.kind === "rv" && f.nodeSite);
}

test("campNodes is on for /dev hosts only and can be turned off there", () => {
  assert.equal(exportMode.campNodesWanted(false, {}), false);
  assert.equal(exportMode.campNodesWanted(false, { campNodes: true }), false);
  assert.equal(exportMode.campNodesWanted(true, {}), true);
  assert.equal(exportMode.campNodesWanted(true, null), true);
  assert.equal(exportMode.campNodesWanted(true, { campNodes: false }), false);
  assert.equal(exportMode.campNodesWanted(true, { campNodes: "0" }), false);
});

test("a point-mapped campground gets read-only photo windows only with campNodes", () => {
  const off = withCampNodes(false, () => oc.parseOverpass({ elements: [KOA] }, { rvs: true }, BBOX, 0));
  assert.equal(rvWindows(off.features).length, 0);
  assert.equal(off.features.filter((f) => f.kind === "rv").length, 0);
  const on = withCampNodes(true, () => oc.parseOverpass({ elements: [KOA] }, { rvs: true }, BBOX, 0));
  const wins = rvWindows(on.features);
  assert.ok(wins.length > 100, "windows " + wins.length);
  for (const w of wins) {
    assert.equal(w.pitchUse, "road");
    assert.ok(w.pad && w.pad.length >= 4);
  }
  // The circle is never a park outline (no pad fills, no context read).
  assert.equal(on.features.filter((f) => f.kind === "camp-zone").length, 0);
});

test("a point inside a mapped park outline adds nothing", () => {
  const ring = [
    [-112.1585, 35.3280],
    [-112.1565, 35.3280],
    [-112.1565, 35.3295],
    [-112.1585, 35.3295],
    [-112.1585, 35.3280],
  ];
  const park = { type: "way", id: 2, tags: { tourism: "caravan_site" }, geometry: ring.map((c) => ({ lon: c[0], lat: c[1] })) };
  const on = withCampNodes(true, () => oc.parseOverpass({ elements: [KOA, park] }, { rvs: true }, BBOX, 0));
  assert.equal(rvWindows(on.features).length, 0);
  assert.equal(on.features.filter((f) => f.kind === "camp-zone").length, 1);
});

test("the map read (XML) keeps the campground point for campNodes", () => {
  const xml =
    '<osm><node id="1" lat="35.328879" lon="-112.1575068"><tag k="tourism" v="caravan_site"/></node></osm>';
  const off = withCampNodes(false, () => oc.featuresFromMapXml(xml, { rvs: true }, BBOX, 0));
  assert.equal(rvWindows(off.features).length, 0);
  const on = withCampNodes(true, () => oc.featuresFromMapXml(xml, { rvs: true }, BBOX, 0));
  assert.ok(rvWindows(on.features).length > 100);
});

function unitAt(dxM, dyM, key) {
  const lat = KOA.lat + dyM / 110540;
  const lon = KOA.lon + dxM / (111320 * Math.cos((KOA.lat * Math.PI) / 180));
  const d = 0.00002;
  return {
    kind: "rv",
    pitchUse: "roadside",
    nodeSite: key,
    coords: [
      [lon - d, lat - d],
      [lon + d, lat - d],
      [lon + d, lat + d],
      [lon - d, lat + d],
      [lon - d, lat - d],
    ],
  };
}

test("only a dense group of RVs near the point is kept", () => {
  const key = KOA.lon.toFixed(7) + "," + KOA.lat.toFixed(7);
  const park = [];
  for (let i = 0; i < 8; i++) park.push(unitAt(i * 12, 20, key));
  const strays = [unitAt(-150, -150, key), unitAt(160, 40, key), unitAt(0, -200, key)];
  const far = [];
  for (let i = 0; i < 7; i++) far.push(unitAt(-200 + i * 10, 150, key));
  const other = { kind: "pole", coords: [[KOA.lon, KOA.lat]] };
  const mapped = unitAt(300, 300, undefined);
  const kept = oc.keepCampNodeClusters(park.concat(strays, far, [other, mapped]));
  assert.equal(kept.filter((f) => f.nodeSite).length, 8);
  assert.ok(kept.includes(other));
  assert.ok(kept.includes(mapped));
  // A small group near the point is not a park.
  const few = oc.keepCampNodeClusters(park.slice(0, 4));
  assert.equal(few.length, 0);
});
