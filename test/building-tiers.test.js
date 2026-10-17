"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const rings = require("./fixtures/hamina-rings.json");
const { tierForRing, applyNlsBuildingHeights } = require("../netlify/lib/nls-building-height");
const { dedupeStackedFootprints } = require("../netlify/lib/conflate");
const { domePieces } = require("../netlify/lib/roof-form");

function poly(ring, props) {
  return { type: "Feature", properties: Object.assign({}, props), geometry: { type: "Polygon", coordinates: [ring] } };
}

describe("towers rise above their roof", () => {
  it("finds a measured tower cluster inside a roof and keeps the roof at its own height", () => {
    const t = tierForRing(rings["153089115"]);
    assert.ok(t, "laser drum found");
    assert.ok(t.top >= 20 && t.top <= 24, "drum top " + t.top);
    assert.ok(t.roof >= 10 && t.roof <= 13, "roof " + t.roof);
    // round drum: chamfered octagon (8 corners + closing point)
    assert.equal(t.ring.length, 9);
  });

  it("adds a laser tier part only when no mapped part already draws the tower", () => {
    const body = poly(rings["153089119"], { geomSource: "overture" });
    const tower = poly(rings["1552092821"], { geomSource: "osm-part", buildingPart: true, height: 26, heightSource: "osm" });
    const list = [body, tower];
    const r = applyNlsBuildingHeights(list);
    assert.equal(r.tiers, 0);
    assert.equal(list.length, 2);
    assert.ok(tower.properties.height >= 25, "part reads the 90th percentile: " + tower.properties.height);
    const church = [poly(rings["153089115"], { geomSource: "overture" })];
    const c = applyNlsBuildingHeights(church);
    assert.equal(c.tiers, 1);
    assert.equal(church.length, 2);
    assert.equal(church[1].properties.geomSource, "nls-tier");
    assert.ok(church[0].properties.height < 13, "nave no longer lifted by the drum");
  });

  it("keeps a small mapped clock tower as an upper mass on its roof", () => {
    const body = poly(rings["153089119"], { geomSource: "overture", height: 12.9, heightSource: "nls-laser" });
    const tower = poly(rings["1552092821"], { geomSource: "osm-part", buildingPart: true, height: 27, heightSource: "nls-laser" });
    const out = dedupeStackedFootprints([body, tower]).features;
    const kept = out.find((f) => f.properties.height === 27);
    assert.ok(kept, "tower kept");
    assert.equal(kept.properties.levelBaseM, 12.9);
  });

  it("does not keep a small unmapped fragment as a tower", () => {
    const body = poly(rings["153089119"], { geomSource: "overture", height: 12.9, heightSource: "nls-laser" });
    const frag = poly(rings["1552092821"], { geomSource: "ms-global", height: 27, heightSource: "ms-global" });
    const out = dedupeStackedFootprints([body, frag]).features;
    assert.ok(!out.some((f) => f.properties.levelBaseM > 0));
  });

  it("draws a dome tower as straight walls with the dome on top", () => {
    const tower = poly(rings["1552092821"], { height: 27, levelBaseM: 12.9, roofShape: "dome" });
    const pieces = domePieces(tower);
    assert.ok(pieces && pieces.length >= 2);
    assert.equal(pieces[0].properties.levelBaseM, 12.9);
    assert.ok(pieces[0].properties.height > 20, "walls reach " + pieces[0].properties.height);
    assert.equal(pieces[pieces.length - 1].properties.height, 27);
  });
});
