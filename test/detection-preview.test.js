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

  it("feedback #22: places objects on the aerial's padded extent, not the drawn box", () => {
    // Las Vegas: drawn S 36.12986 N 36.14069, Esri extent S 36.1286188 N 36.1419312.
    const drawn = [[36.12986, -115.15257], [36.12986, -115.13647], [36.14069, -115.13647], [36.14069, -115.15257]];
    const frame = { west: -115.15257, south: 36.1286188, east: -115.13647, north: 36.1419312 };
    const want = [[36.1286188, -115.15257], [36.1286188, -115.13647], [36.1419312, -115.13647], [36.1419312, -115.15257]];
    assert.deepEqual(P.previewCorners({ frame }, drawn, false), want);
    const gpsClipboard = { tiePoints: [{ lat: 36.1286188, lon: -115.15257, x: -1447, y: -1471 }, { lat: 36.1419312, lon: -115.13647, x: 0, y: 0 }] };
    assert.deepEqual(P.previewCorners({ gpsClipboard }, drawn, false), want);
    assert.deepEqual(P.previewCorners({}, drawn, false), drawn);
    assert.deepEqual(P.previewCorners(null, drawn, false), drawn);
    // An object at the top of the picture lands on the aerial's north edge.
    const d = { floorplans: [{ dimensions: [{ width: 100, length: 100, unit: "pixels" }], attenuation_areas: [{ area: ring([[0, 100], [10, 100], [10, 90]]), area_material: { name: "Building - 8.3" } }] }] };
    const got = P.shapesFromOpenIntent(d, P.previewCorners({ frame }, drawn, false));
    assert.ok(Math.abs(got.shapes[0].ring[0][0] - 36.1419312) < 1e-9);
  });

  it("feedback #22: a turned export uses its own corners, never north-up tie points", () => {
    const drawn = [[1, 1], [1, 2], [2, 2], [2, 1]];
    const corners = { sw: [10, 40], se: [11, 40.1], ne: [10.9, 41.1], nw: [9.9, 41] };
    assert.deepEqual(P.previewCorners({ frame: { corners } }, drawn, true), [[40, 10], [40.1, 11], [41.1, 10.9], [41, 9.9]]);
    const gpsClipboard = { tiePoints: [{ lat: 40, lon: 10 }, { lat: 41.1, lon: 10.9 }] };
    assert.deepEqual(P.previewCorners({ gpsClipboard, frame: { west: 0, south: 0, east: 1, north: 1 } }, drawn, true), drawn);
  });
});
