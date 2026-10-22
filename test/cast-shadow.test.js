"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { rejectShadowless, photoContext, sceneShadow } = require("../netlify/lib/cast-shadow");
const { aerialStorageYards } = require("../netlify/lib/yard-stacks");

// A synthetic plate: 0.25 m pixels, grey pavement, sun in the west so every
// shadow falls east (+x). k = 0.6 m of shadow per metre of height.
const MPP = 0.25;
const K = 0.6;

function makeScene(sizePx) {
  const W = sizePx;
  const H = sizePx;
  const data = new Uint8Array(W * H * 4);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < W * H; i++) {
    const n = Math.round((rnd() - 0.5) * 6);
    data[i * 4] = 150 + n;
    data[i * 4 + 1] = 148 + n;
    data[i * 4 + 2] = 145 + n;
    data[i * 4 + 3] = 255;
  }
  const lat0 = 30;
  const mPerDegLat = 110540;
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const frame = {
    west: -97,
    north: lat0 + (H * MPP) / mPerDegLat / 2,
    south: lat0 - (H * MPP) / mPerDegLat / 2,
    imgW: W,
    imgH: H,
    mpuX: MPP,
    mpuY: MPP,
  };
  frame.east = frame.west + (W * MPP) / mPerDegLon;
  const fill = (x0, y0, x1, y1, rgb, noise) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const k = (y * W + x) * 4;
        const n = noise ? ((x + y) % 2 ? noise : -noise) : 0;
        data[k] = Math.max(0, Math.min(255, rgb[0] + n));
        data[k + 1] = Math.max(0, Math.min(255, rgb[1] + n));
        data[k + 2] = Math.max(0, Math.min(255, rgb[2] + n));
      }
    }
  };
  const toLonLat = (x, y) => [frame.west + (x / W) * (frame.east - frame.west), frame.north - (y / H) * (frame.north - frame.south)];
  const feature = (x0, y0, x1, y1, props) => ({
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [[toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1), toLonLat(x0, y0)]] },
  });
  // A roof of h metres at pixel box, with its shadow to the east.
  const roof = (x0, y0, x1, y1, h, rgb) => {
    fill(x1, y0, x1 + Math.round((h * K) / MPP), y1, [40, 40, 42]);
    fill(x0, y0, x1, y1, rgb || [205, 203, 200]);
  };
  return { raw: { data, width: W, height: H }, frame, fill, roof, feature, toLonLat };
}

function baseScene() {
  const s = makeScene(800);
  const features = [];
  // Four measured roofs, 20 m square, 8 m tall.
  for (const [x, y] of [
    [40, 40],
    [40, 400],
    [400, 40],
    [560, 560],
  ]) {
    s.roof(x, y, x + 80, y + 80, 8);
    features.push(s.feature(x, y, x + 80, y + 80, { geomSource: "usa", height: 8, heightSource: "usgs-lidar" }));
  }
  return { s, features };
}

test("sceneShadow learns the sun side and the shadow scale from measured roofs", () => {
  const { s, features } = baseScene();
  const ctx = photoContext(s.raw, s.frame, features);
  const scene = sceneShadow(ctx, features);
  assert.equal(scene.confident, true);
  assert.equal(scene.dirIndex, 0);
  assert.ok(Math.abs(scene.k - K) < 0.15, "k " + scene.k);
});

test("an outline on bare pavement with no shadow is dropped; real roofs stay", () => {
  const { s, features } = baseScene();
  const ghost = s.feature(260, 260, 340, 340, { geomSource: "usa", height: 6, heightSource: "fema" });
  // A low shed with a shadow and a darker roof.
  s.roof(240, 600, 300, 660, 3, [110, 108, 104]);
  const shed = s.feature(240, 600, 300, 660, { geomSource: "overture" });
  const list = features.concat([ghost, shed]);
  const out = rejectShadowless(s.raw, s.frame, list);
  assert.equal(out.dropped, 1);
  assert.ok(!out.features.includes(ghost));
  assert.ok(out.features.includes(shed));
  for (const f of features) assert.ok(out.features.includes(f));
});

test("an outline drawn inside a larger unmapped roof is kept", () => {
  const { s, features } = baseScene();
  // A 40 m roof, 10 m tall, that no source maps; an outline sits inside it.
  s.roof(200, 200, 360, 360, 10, [170, 168, 165]);
  const part = s.feature(240, 240, 300, 300, { geomSource: "overture" });
  const out = rejectShadowless(s.raw, s.frame, features.concat([part]));
  assert.ok(out.features.includes(part));
});

test("an outline under tree shade or on grass is kept", () => {
  const { s, features } = baseScene();
  s.fill(220, 220, 380, 380, [60, 90, 50]);
  const hidden = s.feature(260, 260, 340, 340, { geomSource: "usa" });
  const out = rejectShadowless(s.raw, s.frame, features.concat([hidden]));
  assert.ok(out.features.includes(hidden));
});

test("without a confident sun nothing is dropped", () => {
  const s = makeScene(400);
  const ghost = s.feature(100, 100, 180, 180, { geomSource: "usa", height: 6, heightSource: "fema" });
  const out = rejectShadowless(s.raw, s.frame, [ghost]);
  assert.equal(out.dropped, 0);
});

function yardScene(withStacks) {
  const s = makeScene(1000);
  const features = [];
  // A 100 m x 90 m warehouse (9000 m2), 12 m tall, plus three measured roofs.
  s.roof(40, 40, 440, 400, 12);
  features.push(s.feature(40, 40, 440, 400, { geomSource: "usa", height: 12, heightSource: "usgs-lidar" }));
  for (const [x, y] of [
    [40, 800],
    [800, 40],
    [820, 820],
  ]) {
    s.roof(x, y, x + 80, y + 80, 8);
    features.push(s.feature(x, y, x + 80, y + 80, { geomSource: "usa", height: 8, heightSource: "fema" }));
  }
  if (withStacks) {
    // Six rows of wrapped goods, 40 m long, 5 m deep, 4 m tall, with their
    // 2.4 m shadows filling the aisles between them.
    for (let r = 0; r < 6; r++) {
      const x0 = 520 + r * 30;
      s.fill(x0 + 20, 460, x0 + 30, 620, [40, 40, 42]);
      s.fill(x0, 460, x0 + 20, 620, [228, 226, 224], 22);
    }
  }
  return { s, features };
}

test("stacked rows beside a warehouse become storage blocks at their shadow height", () => {
  const { s, features } = yardScene(true);
  const got = aerialStorageYards(s.raw, s.frame, features);
  assert.ok(got.yards.length > 0, "reason " + got.reason);
  const m2 = got.yards.reduce((a, y) => a + y.areaM2, 0);
  assert.ok(m2 > 600 && m2 < 2400, "area " + m2);
  for (const y of got.yards) {
    assert.equal(y.kind, "storage");
    assert.equal(y.explicitHeight, true);
    assert.ok(y.heightM >= 3 && y.heightM <= 5.5, "height " + y.heightM);
    // Every block lies in the yard, east of the warehouse.
    for (const q of y.coords) assert.ok(q[0] > s.toLonLat(440, 0)[0]);
  }
});

test("empty pavement beside a warehouse stays empty", () => {
  const { s, features } = yardScene(false);
  const got = aerialStorageYards(s.raw, s.frame, features);
  assert.equal(got.yards.length, 0);
});

test("a mapped car park is never read as a storage yard", () => {
  const { s, features } = yardScene(true);
  const lot = [s.toLonLat(500, 440), s.toLonLat(760, 440), s.toLonLat(760, 640), s.toLonLat(500, 640), s.toLonLat(500, 440)];
  const got = aerialStorageYards(s.raw, s.frame, features, { avoid: [lot] });
  assert.equal(got.yards.length, 0);
});

test("a colourful lot of parked cars is not read as stacks", () => {
  const { s, features } = yardScene(false);
  const colours = [
    [200, 30, 30],
    [30, 60, 190],
    [230, 230, 230],
    [20, 20, 20],
    [200, 180, 40],
  ];
  let c = 0;
  for (let row = 0; row < 6; row++) {
    for (let i = 0; i < 16; i++) {
      const x0 = 520 + row * 30;
      const y0 = 460 + i * 10;
      s.fill(x0 + 18, y0, x0 + 22, y0 + 8, [40, 40, 42]);
      s.fill(x0, y0, x0 + 18, y0 + 8, colours[c++ % colours.length]);
    }
  }
  const got = aerialStorageYards(s.raw, s.frame, features);
  assert.equal(got.yards.length, 0);
});

test("planOutdoor emits a storage block at its measured height", () => {
  const { planOutdoor } = require("../netlify/lib/outdoor-clutter");
  const { s, features } = yardScene(true);
  const got = aerialStorageYards(s.raw, s.frame, features);
  const plan = planOutdoor({ features: got.yards, frame: s.frame, buildings: [], parkingRings: [] });
  const storage = plan.items.filter((it) => it.kind === "storage");
  assert.ok(storage.length >= got.yards.length);
  for (const it of storage) {
    assert.ok(/^Storage /.test(it.material.name));
    assert.equal(it.material.rf_properties.attenuation_per_m, 3);
  }
});

test("source heights that disagree do not set a stack height", () => {
  const s = makeScene(1000);
  const features = [];
  s.roof(40, 40, 440, 400, 12);
  features.push(s.feature(40, 40, 440, 400, { geomSource: "overture", height: 4, heightSource: "overture" }));
  const hs = [4, 9, 16];
  [[40, 800], [800, 40], [820, 820]].forEach(([x, y], i) => {
    s.roof(x, y, x + 80, y + 80, 8);
    features.push(s.feature(x, y, x + 80, y + 80, { geomSource: "overture", height: hs[i], heightSource: "overture" }));
  });
  for (let r = 0; r < 6; r++) {
    const x0 = 520 + r * 30;
    s.fill(x0 + 20, 460, x0 + 30, 620, [40, 40, 42]);
    s.fill(x0, 460, x0 + 20, 620, [228, 226, 224], 22);
  }
  const got = aerialStorageYards(s.raw, s.frame, features);
  assert.equal(got.yards.length, 0);
  assert.equal(got.reason, "no shadow scale");
});
