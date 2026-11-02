"use strict";
const test = require("node:test");
const assert = require("node:assert");
const oc = require("../netlify/lib/outdoor-clutter");
const exportMode = require("../netlify/lib/export-mode");
const sw = require("../netlify/lib/sea-water");

const BOX = { west: 0, south: 0, east: 0.01, north: 0.01 };
const OPTS = { water: true, parking: false, walls: false, poles: false, rvs: false, cars: false };

function mapXml(ways, relations) {
  let id = 1;
  const nodes = [];
  const wx = [];
  for (const w of ways) {
    const refs = w.pts.map((p) => {
      const n = id++;
      nodes.push(`<node id="${n}" lat="${p[1]}" lon="${p[0]}"/>`);
      return n;
    });
    if (w.closed) refs.push(refs[0]);
    const tags = Object.entries(w.tags || {}).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join("");
    wx.push(`<way id="${w.id}">${refs.map((r) => `<nd ref="${r}"/>`).join("")}${tags}</way>`);
  }
  const rx = (relations || []).map((r) => {
    const mem = r.members.map((m) => `<member type="way" ref="${m.ref}" role="${m.role}"/>`).join("");
    const tags = Object.entries(r.tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join("");
    return `<relation id="${r.id}">${mem}${tags}</relation>`;
  });
  return `<?xml version="1.0"?><osm>${nodes.join("")}${wx.join("")}${rx.join("")}</osm>`;
}

function waterRings(xml, on) {
  exportMode.setSeaWater(on);
  try {
    const got = oc.featuresFromMapXml(xml, OPTS, BOX, 0);
    return (got.features || []).filter((f) => f.kind === "water").map((f) => f.coords);
  } finally {
    exportMode.setSeaWater(false);
  }
}

function inside(pt, rings) {
  return rings.some((r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i];
      const b = r[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  });
}

// Short streets dotted over a region: the land marks the side test counts.
function streets(x0, x1, y0, y1, idBase) {
  const out = [];
  let k = 0;
  for (let x = x0; x < x1; x += 0.001) {
    for (let y = y0; y < y1; y += 0.001) {
      out.push({ id: idBase + k++, pts: [[x, y], [x + 0.0004, y + 0.0002]], tags: { highway: "residential" } });
    }
  }
  return out;
}

test("seaWater: dev hosts only, off with seaWater:false", () => {
  assert.strictEqual(exportMode.seaWaterWanted(false, {}), false);
  assert.strictEqual(exportMode.seaWaterWanted(false, { seaWater: true }), false);
  assert.strictEqual(exportMode.seaWaterWanted(true, {}), true);
  assert.strictEqual(exportMode.seaWaterWanted(true, { seaWater: false }), false);
});

test("seaWater: coastline puts the sea on its right, nothing when off", () => {
  // Heading north at x=0.006: sea to the east, town to the west.
  const ways = [{ id: 1000, pts: [[0.006, -0.002], [0.0062, 0.005], [0.006, 0.012]], tags: { natural: "coastline" } }];
  const xml = mapXml(ways.concat(streets(0.0005, 0.005, 0.0005, 0.0095, 2000)));
  assert.strictEqual(waterRings(xml, false).length, 0);
  const on = waterRings(xml, true);
  assert.ok(on.length > 0);
  assert.ok(inside([0.008, 0.005], on));
  assert.ok(!inside([0.003, 0.005], on));
});

test("seaWater: river relation picks the side without streets", () => {
  // Two banks of a river drawn in opposite directions, the tile cuts both.
  const ways = [
    { id: 1001, pts: [[-0.002, 0.004], [0.012, 0.0042]] },
    { id: 1002, pts: [[-0.002, 0.0062], [0.012, 0.006]] },
  ];
  const rel = [{ id: 9001, members: [{ ref: 1001, role: "outer" }, { ref: 1002, role: "outer" }], tags: { type: "multipolygon", natural: "water", water: "river" } }];
  const land = streets(0.0005, 0.0095, 0.0005, 0.0035, 2000).concat(streets(0.0005, 0.0095, 0.007, 0.0095, 4000));
  const on = waterRings(mapXml(ways.concat(land), rel), true);
  assert.ok(inside([0.005, 0.005], on));
  assert.ok(!inside([0.005, 0.002], on));
  assert.ok(!inside([0.005, 0.008], on));
  // No streets to tell the sides apart: emit nothing rather than guess.
  assert.strictEqual(waterRings(mapXml(ways, rel), true).length, 0);
});

test("seaWater: an island (inner member) is land, intermittent water is skipped", () => {
  const ways = [
    { id: 1001, pts: [[-0.002, -0.002], [0.012, -0.002], [0.012, 0.012], [-0.002, 0.012]], closed: true },
    { id: 1002, pts: [[0.003, 0.003], [0.007, 0.003], [0.007, 0.007], [0.003, 0.007]], closed: true },
  ];
  const tags = { type: "multipolygon", natural: "water", water: "lake" };
  const rel = [{ id: 9001, members: [{ ref: 1001, role: "outer" }, { ref: 1002, role: "inner" }], tags }];
  const on = waterRings(mapXml(ways, rel), true);
  assert.ok(inside([0.001, 0.001], on));
  assert.ok(!inside([0.005, 0.005], on));
  const dry = [{ id: 9001, members: rel[0].members, tags: Object.assign({ intermittent: "yes" }, tags) }];
  assert.strictEqual(waterRings(mapXml(ways, dry), true).length, 0);
});

test("seaWater: closing a shore run past the north-west corner keeps its corners in order", () => {
  // East edge to west edge heading west: the land to the north is closed via NW then NE.
  const ring = oc._closeWaterRingRaw([[0.01, 0.004], [0.005, 0.0045], [0, 0.007]], BOX);
  const area = sw.multiAreaDeg([[ring]]) / 1e-4;
  assert.ok(area > 0.45 && area < 0.55, `area ${area}`);
});
