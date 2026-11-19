"use strict";

// Dev hosts: the page reads the finished zip and draws its areas (?preview=0 turns it off).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const P = require("../public/detection-preview.js");

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text);
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function ring(pts) {
  return { coordinates: pts.concat([pts[0]]).map(([x, y]) => ({ coordinate_xyz: { x, y, unit: "pixels" } })) };
}

const doc = {
  floorplans: [
    {
      dimensions: [{ width: 100, length: 200, unit: "pixels" }],
      attenuation_areas: [
        { area: ring([[0, 0], [10, 0], [10, 10]]), area_material: { name: "Building - 8.3" } },
        { area: ring([[50, 100], [60, 100], [60, 110]]), area_material: { name: "Foliage - Heavy 14.2" } },
        { area: ring([[1, 1], [2, 1], [2, 2]]), area_material: { name: "Foliage - Trunk 3.0" } },
        { area: ring([[5, 5], [8, 5], [8, 7]]), area_material: { name: "RV roof 3.5" } },
      ],
      wall_segments: [{ start_point: { x: 5, y: 5 }, end_point: { x: 8, y: 5 } }],
    },
  ],
};

describe("detection preview", () => {
  it("is on by default on dev hosts and off on production", () => {
    assert.equal(P.previewWanted("", true), true);
    assert.equal(P.previewWanted("?preview=1", true), true);
    assert.equal(P.previewWanted("?preview=true", true), true);
    assert.equal(P.previewWanted("?preview=0", true), false);
    assert.equal(P.previewWanted("?preview=false", true), false);
    assert.equal(P.previewWanted("", false), false);
    assert.equal(P.previewWanted("?preview=1", false), false);
  });

  it("reads the OpenIntent document from the zip, not the terrain paste", async () => {
    const buf = zip([
      ["terrain-clipboard.json", JSON.stringify({ floorplans: [{ x: 1 }], big: "x".repeat(5000) })],
      ["site.json", JSON.stringify(doc)],
      ["images/map.jpg", "jpg"],
    ]);
    const got = await P.openIntentFromZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    assert.equal(got.floorplans[0].attenuation_areas.length, 4);
  });

  it("maps Y-up pixels onto the box corners and groups by material", () => {
    const corners = [[40, -90], [40, -89], [41, -89], [41, -90]];
    const got = P.shapesFromOpenIntent(doc, corners);
    assert.deepEqual(got.counts, { building: 1, tree: 1, rv: 1 });
    const b = got.shapes.find((s) => s.kind === "building");
    assert.deepEqual(b.ring[0], [40, -90]);
    assert.deepEqual(b.ring[1], [40, -89.9]);
    const t = got.shapes.find((s) => s.kind === "tree");
    assert.deepEqual(t.ring[0], [40.5, -89.5]);
    assert.equal(got.shapes.filter((s) => s.kind === "rvwall").length, 1);
  });
});
