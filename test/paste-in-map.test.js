"use strict";

// Feedback #6: a map note past the aerial made Hamina place the whole
// Copy terrain paste beside the map. Every paste item stays on the map.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { emptyClipboard, fitClipboardToMap, gpsTiePoints } = require("../netlify/lib/hamina-clipboard");
const { buildMapNotes } = require("../netlify/lib/map-notes");

const frame = geoFrame(
  { west: -97.75233, south: 30.26506, east: -97.74992, north: 30.26652 },
  { maxSide: 800, metersPerPx: 0.3 }
);

function square(lon, lat, h, d) {
  const s = d || 0.0001;
  return {
    type: "Feature",
    properties: { height: h },
    geometry: {
      type: "Polygon",
      coordinates: [[[lon, lat], [lon + s, lat], [lon + s, lat + s], [lon, lat + s], [lon, lat]]],
    },
  };
}

function onMap(n) {
  return n.x >= -frame.widthM && n.x <= 0 && n.y >= -frame.lengthM && n.y <= 0;
}

describe("Copy terrain stays on the map (feedback #6)", () => {
  it("drops a tall obstruction note past the aerial and keeps the one inside", () => {
    const outside = square(frame.east + 0.0002, frame.north + 0.0006, 149);
    const inside = square((frame.west + frame.east) / 2, (frame.south + frame.north) / 2, 121);
    const notes = buildMapNotes({ frame, places: [], features: [outside, inside], terrain: null });
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /121 m/);
    assert.ok(notes.every(onMap));
  });

  it("keeps a terrain high point on the map edge", () => {
    const terrain = {
      samples: [
        { lon: frame.east, lat: frame.north, z: 142 },
        { lon: frame.west, lat: frame.south, z: 120 },
      ],
    };
    const notes = buildMapNotes({ frame, places: [], features: [], terrain });
    assert.equal(notes.length, 1);
    assert.ok(notes.every(onMap));
  });

  it("fitClipboardToMap drops off-map notes and pins floor vertices to the edge", () => {
    const w = frame.widthM;
    const l = frame.lengthM;
    const clip = emptyClipboard("t");
    clip.tiePoints = gpsTiePoints(frame);
    clip.mapNotes = [
      { x: 23.0, y: 74.7, text: "Tall obstruction, 149 m" },
      { x: -10, y: -12, text: "Terrain high point, 142 m" },
      { x: 0.2, y: -5, text: "edge" },
    ];
    clip.slopedFloors = [
      { area: { type: "Polygon", coordinates: [[[-1, -2, 0], [0.02, -2, 0], [0.02, 0.01, 1], [-1, 0.01, 1]]] } },
    ];
    clip.raisedFloorZones = [
      { area: { type: "Polygon", coordinates: [[[-w - 0.03, -l - 0.02], [-w + 5, -l - 0.02], [-w + 5, -l + 5], [-w - 0.03, -l + 5]]] } },
    ];
    fitClipboardToMap(clip, frame);
    assert.deepEqual(clip.mapNotes.map((n) => n.text), ["Terrain high point, 142 m", "edge"]);
    assert.equal(clip.mapNotes[1].x, 0);
    const pts = [];
    for (const z of clip.slopedFloors.concat(clip.raisedFloorZones)) for (const p of z.area.coordinates[0]) pts.push(p);
    for (const p of pts) {
      assert.ok(p[0] >= -w - 1e-4 && p[0] <= 0, "x " + p[0]);
      assert.ok(p[1] >= -l - 1e-4 && p[1] <= 0, "y " + p[1]);
    }
    assert.equal(clip.slopedFloors[0].area.coordinates[0][2][2], 1);
    assert.equal(clip.tiePoints.length, 2);
  });

  it("the bundle fits Copy terrain and the GPS paste to the map", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(src, /fitClipboardToMap\(terrainFields\.terrainClipboard, frame\)/);
    assert.match(src, /fitClipboardToMap\(gpsPaste, frame\)/);
  });
});
