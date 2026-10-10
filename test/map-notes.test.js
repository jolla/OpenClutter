"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { emptyClipboard } = require("../netlify/lib/hamina-clipboard");
const { placesFromElements, buildMapNotes, stampMapNotes, MAP_NOTE_COLOR, MAP_NOTE_ICON } = require("../netlify/lib/map-notes");
const { parseBuildingDetail } = require("../netlify/lib/building-shape");

const frame = geoFrame(
  { west: -71.551, south: 44.463, east: -71.542, north: 44.47 },
  { maxSide: 400, metersPerPx: 2 }
);

function way(tags, lon, lat, span) {
  const d = span || 0.00015;
  return {
    type: "way",
    tags,
    geometry: [
      { lon, lat },
      { lon: lon + d, lat },
      { lon: lon + d, lat: lat + d },
      { lon, lat: lat + d },
      { lon, lat },
    ],
  };
}

function pitch(lon, lat) {
  return { role: "pitch", lon, lat, name: "", heightM: 0, areaM2: 80 };
}

describe("Hamina map notes", () => {
  it("uses the clipboard note object and leaves OpenIntent markers empty", () => {
    const places = placesFromElements([
      way({ building: "yes", name: "Office" }, -71.545, 44.467),
      way({ building: "yes", amenity: "toilets" }, -71.5473, 44.4669),
      way({ building: "yes", name: "Pavillion" }, -71.5435, 44.4671),
      way({ amenity: "parking" }, -71.5436, 44.4634, 0.0004),
      way({ man_made: "tower", name: "Lookout", height: "22" }, -71.5442, 44.4688),
    ]);
    const pitches = [];
    for (let i = 0; i < 6; i++) pitches.push(pitch(-71.549 + i * 0.0004, 44.4684));
    for (let i = 0; i < 6; i++) pitches.push(pitch(-71.544 + i * 0.0003, 44.4648));
    const notes = buildMapNotes({
      frame,
      places: places.concat(pitches),
      features: [
        {
          type: "Feature",
          properties: { height: 22, partName: "Lookout" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-71.5443, 44.4687],
                [-71.5441, 44.4687],
                [-71.5441, 44.4689],
                [-71.5443, 44.4689],
                [-71.5443, 44.4687],
              ],
            ],
          },
        },
      ],
      terrain: {
        samples: [
          { lon: -71.548, lat: 44.469, z: 368.2 },
          { lon: -71.544, lat: 44.464, z: 340 },
        ],
      },
    });
    const text = notes.map((n) => n.text).join("\n");
    assert.match(text, /Suggested gateway, Office/);
    assert.match(text, /Suggested AP, bathhouse/);
    assert.match(text, /Suggested AP, Pavillion/);
    assert.match(text, /Suggested AP, entrance parking/);
    assert.match(text, /Suggested AP$/m);
    assert.match(text, /Tall obstruction, 22 m, Lookout/);
    assert.match(text, /Terrain high point, 368 m/);
    assert.match(text, new RegExp("AFC GPS SW " + frame.south.toFixed(5) + ", " + frame.west.toFixed(5)));
    assert.match(text, new RegExp("AFC GPS NE " + frame.north.toFixed(5) + ", " + frame.east.toFixed(5)));
    for (let i = 0; i < notes.length; i++) {
      assert.deepEqual(Object.keys(notes[i]).sort(), ["color", "icon", "text", "x", "y"]);
      assert.equal(notes[i].color, MAP_NOTE_COLOR);
      assert.equal(notes[i].icon, MAP_NOTE_ICON);
      assert.equal(typeof notes[i].x, "number");
      assert.equal(typeof notes[i].y, "number");
    }
    const clip = emptyClipboard("00000000-0000-4000-8000-000000000001");
    stampMapNotes(clip, notes);
    assert.equal(clip.mapNotes.length, notes.length);
    assert.equal(JSON.stringify(clip).includes("reference_markers"), false);
    const parsed = parseBuildingDetail({
      elements: [way({ building: "yes", name: "Office" }, -71.545, 44.467)],
    });
    assert.equal(parsed.places.length, 1);
    assert.equal(parsed.places[0].role, "office");
    assert.equal(parsed.buildings.length, 1);
  });

  it("notes a shipped canopy of at least 15 m and skips a short building", () => {
    const notes = buildMapNotes({
      frame,
      places: [],
      features: [],
      openintent: {
        floorplans: [
          {
            attenuation_areas: [
              {
                area_material: {
                  name: "Foliage - Heavy 28.0 @ 46.4",
                  top_height: 74.4,
                  bottom_height: 46.4,
                },
                area: {
                  coordinates: [
                    { coordinate_xyz: { x: frame.imgW * 0.4, y: frame.imgH * 0.6 } },
                    { coordinate_xyz: { x: frame.imgW * 0.42, y: frame.imgH * 0.6 } },
                    { coordinate_xyz: { x: frame.imgW * 0.41, y: frame.imgH * 0.62 } },
                  ],
                },
              },
              {
                area_material: {
                  name: "Building - Two Floor 44.3",
                  top_height: 51.9,
                  bottom_height: 44.3,
                },
                area: {
                  coordinates: [
                    { coordinate_xyz: { x: 10, y: 10 } },
                    { coordinate_xyz: { x: 20, y: 10 } },
                    { coordinate_xyz: { x: 15, y: 20 } },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const text = notes.map((n) => n.text).join("\n");
    assert.match(text, /Tall obstruction, tree, 28 m/);
    assert.equal(/Building - Two Floor/.test(text), false);
    assert.equal(/Tall obstruction, 8 m/.test(text), false);
  });

  it("the page sends map notes unless the toggle is off", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(html, /id="include-map-notes"[^>]*checked/);
    assert.match(app, /mapNotes: clutterChecked\("include-map-notes"\)/);
    assert.match(clutter, /function wantMapNotes/);
    assert.match(clutter, /stampMapNotes/);
    const off = buildMapNotes({ frame, places: [], features: [], terrain: null });
    assert.equal(off.length, 2);
    assert.match(off[0].text, /AFC GPS SW/);
    assert.match(off[1].text, /AFC GPS NE/);
  });
});
