"use strict";

// Feedback #14: a map note at each light pole the export shipped.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, llToPx } = require("../netlify/lib/geo-frame");
const { buildMapNotes, poleNotes, poleRowsFromOpenIntent, POLE_NOTE_CAP } = require("../netlify/lib/map-notes");
const exportMode = require("../netlify/lib/export-mode");

const frame = geoFrame(
  { west: -71.551, south: 44.463, east: -71.542, north: 44.47 },
  { maxSide: 400, metersPerPx: 2 }
);

function square(lon, lat, name, top, bottom) {
  const [x, y] = llToPx(lon, lat, frame);
  const d = 0.1;
  const material = { name, top_height: top };
  if (bottom != null) material.bottom_height = bottom;
  return {
    area_material: material,
    area: {
      coordinates: [
        { coordinate_xyz: { x: x - d, y: y - d } },
        { coordinate_xyz: { x: x + d, y: y - d } },
        { coordinate_xyz: { x: x + d, y: y + d } },
        { coordinate_xyz: { x: x - d, y: y + d } },
      ],
    },
  };
}

function oiOf(areas) {
  return { floorplans: [{ attenuation_areas: areas }] };
}

describe("pole map notes (feedback #14)", () => {
  it("reads only shipped light poles, with their own height", () => {
    const oi = oiOf([
      square(-71.546, 44.466, "Light pole 9.0", 9),
      square(-71.545, 44.467, "Light pole 10.2 @ 12.6", 22.8, 12.6),
      square(-71.544, 44.468, "Building - One Floor", 3),
      square(-71.543, 44.465, "Foliage 12.0", 12),
    ]);
    const rows = poleRowsFromOpenIntent(oi, frame);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => Math.round(r.heightM * 10) / 10), [9, 10.2]);
  });

  it("is off unless asked, and leaves the other notes unchanged", () => {
    const oi = oiOf([square(-71.546, 44.466, "Light pole 9.0", 9)]);
    const off = buildMapNotes({ frame, openintent: oi });
    const on = buildMapNotes({ frame, openintent: oi, poleNotes: true });
    assert.equal(off.length, 0);
    assert.equal(on.length, 1);
    assert.equal(on[0].text, "Light pole, 9 m");
    assert.equal(on[0].icon, "NOTICE_OUTLINE");
    assert.ok(on[0].x <= 0 && on[0].x >= -frame.widthM && on[0].y <= 0 && on[0].y >= -frame.lengthM);
  });

  it("merges a lamp-lined street so the pole notes stay under the cap", () => {
    const areas = [];
    for (let i = 0; i < 60; i++) areas.push(square(-71.5505 + i * 0.00013, 44.4665, "Light pole " + (9 + (i % 2)).toFixed(1), 9 + (i % 2)));
    const notes = poleNotes(poleRowsFromOpenIntent(oiOf(areas), frame), frame);
    assert.ok(notes.length >= 1 && notes.length <= POLE_NOTE_CAP, "pole notes " + notes.length);
    assert.match(notes[0].text, /^\d+ light poles within \d+ m, 9 to 10 m$/);
    const total = notes.reduce((s, n) => s + (+n.text.split(" ")[0] || 1), 0);
    assert.equal(total, 60);
    for (const n of notes) assert.doesNotMatch(n.text, /[\u2014]|\d+\.\d{3,}|AP|gateway/);
  });

  it("keeps two close poles apart only when there is room", () => {
    const rows = [
      { lon: -71.546, lat: 44.466, heightM: 9 },
      { lon: -71.54602, lat: 44.466, heightM: 9 },
    ];
    const notes = poleNotes(rows, frame, 12);
    assert.equal(notes.length, 2);
    const one = poleNotes(rows, frame, 1);
    assert.equal(one.length, 1);
    assert.equal(one[0].text, "2 light poles within 8 m, 9 m");
  });

  it("caps a big lot at POLE_NOTE_CAP notes spread over the map", () => {
    const rows = [];
    for (let i = 0; i < 14; i++) {
      for (let j = 0; j < 14; j++) rows.push({ lon: -71.5505 + i * 0.0006, lat: 44.4633 + j * 0.00045, heightM: 10 });
    }
    const notes = poleNotes(rows, frame);
    assert.equal(notes.length, POLE_NOTE_CAP);
    const xs = notes.map((n) => n.x);
    const ys = notes.map((n) => n.y);
    assert.ok(Math.max(...xs) - Math.min(...xs) > frame.widthM * 0.6);
    assert.ok(Math.max(...ys) - Math.min(...ys) > frame.lengthM * 0.6);
  });

  it("is on for /dev hosts only and can be turned off there", () => {
    assert.equal(exportMode.poleNotesWanted(false, {}), false);
    assert.equal(exportMode.poleNotesWanted(false, { poleNotes: true }), false);
    assert.equal(exportMode.poleNotesWanted(true, {}), true);
    assert.equal(exportMode.poleNotesWanted(true, null), true);
    assert.equal(exportMode.poleNotesWanted(true, { poleNotes: false }), false);
    assert.equal(exportMode.poleNotesWanted(true, {}, { poleNotes: "0" }), false);
    assert.equal(exportMode.isPoleNotes(), false);
  });
});
