"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { handler } = require("../netlify/functions/clutter");
const { ZONE_TYPES } = require("../netlify/lib/hamina-clipboard");

const WYNN = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
  name: "Wynn Golf",
};

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(120, 1), Buffer.from([0xff, 0xd9])]);

describe("HaminaClipboard types vs working geo paste", () => {
  it("are byte-identical in the schema fields", () => {
    assert.deepEqual(ZONE_TYPES, [
      { id: "foliage-heavy", name: "Foliage - Heavy", color: "#3F7D2A", shortcutKey: "o", topEdge: 12.0, bottomEdge: 3.5, attenuationDbPerMeter: 2.0, ituRModelEnabled: true, transparencyEnabled: true },
      { id: "foliage-light", name: "Foliage - Light", color: "#6FA84A", shortcutKey: "f", topEdge: 9.0, bottomEdge: 3.0, attenuationDbPerMeter: 1.0, ituRModelEnabled: true, transparencyEnabled: true },
      { id: "tree-trunk", name: "Tree Trunk", color: "#8B6B4F", shortcutKey: "z", topEdge: 8.0, bottomEdge: null, attenuationDbPerMeter: 10.0, ituRModelEnabled: true, transparencyEnabled: false },
      { id: "bldg-one", name: "Building - One Floor", color: "#C4C4C4", shortcutKey: "v", topEdge: 4.5, bottomEdge: null, attenuationDbPerMeter: 5.0, ituRModelEnabled: true, transparencyEnabled: false },
      { id: "bldg-five", name: "Building - Five Floor", color: "#9A9A9A", shortcutKey: "b", topEdge: 16.0, bottomEdge: null, attenuationDbPerMeter: 5.0, ituRModelEnabled: true, transparencyEnabled: false },
      { id: "hotel", name: "Hotel podium", color: "#8B6914", shortcutKey: "h", topEdge: 55.0, bottomEdge: null, attenuationDbPerMeter: 2.0, ituRModelEnabled: true, transparencyEnabled: false },
    ]);
  });
});

describe("clutter handler (mocked Esri)", () => {
  const urls = [];
  const orig = global.fetch;
  before(() => {
    global.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes("USFS_EDW_NLCD_TCC") || String(url).includes("getSamples")) {
        const samples = [];
        for (let i = 0; i < 24; i++) {
          samples.push({
            location: { x: -115.16 - i * 0.0003, y: 36.128 - i * 0.0002 },
            value: String(40 + (i % 40)),
          });
        }
        return { ok: true, json: async () => ({ samples }) };
      }
      if (String(url).includes("overpass")) {
        return {
          ok: true,
          json: async () => ({ elements: [{ type: "node", lon: -115.16, lat: 36.128 }] }),
        };
      }
      if (String(url).includes("MSBFP2")) {
        return {
          ok: true,
          json: async () => ({
            features: [{
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [[
                  [-115.165, 36.126], [-115.164, 36.126], [-115.164, 36.127], [-115.165, 36.127], [-115.165, 36.126],
                ]],
              },
            }],
          }),
        };
      }
      if (String(url).includes("World_Imagery")) {
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      throw new Error("unexpected fetch " + url);
    };
  });
  after(() => {
    global.fetch = orig;
  });

  it("bundle emits zip + clipboard on one frame and does not call Overpass by default", async () => {
    urls.length = 0;
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "bundle" }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.zipBase64);
    assert.equal(body.clipboard.header.type, "HaminaClipboard");
    assert.ok(body.clipboard.attenuatingZones.length >= 1);
    assert.deepEqual(body.frame.clipboardCorners.ne, [0, 0]);
    assert.match(body.alignment, /Import the OpenIntent zip/);
    assert.ok(!urls.some((u) => u.includes("overpass")));
    assert.ok(urls.some((u) => u.includes("World_Imagery") && u.includes("bboxSR=4326") && u.includes("imageSR=4326")));
    assert.ok(urls.some((u) => u.includes("MSBFP2")));
    assert.ok(body.stats.trees >= 1);
    assert.equal(body.stats.treesSource, "imagery-rgb");
    assert.ok(!urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
  });

  it("clipboard-only skips imagery and still uses shared widthM", async () => {
    urls.length = 0;
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, format: "hamina-clipboard" }),
    });
    assert.equal(res.statusCode, 200);
    const clip = JSON.parse(res.body);
    assert.equal(clip.header.type, "HaminaClipboard");
    assert.ok(!urls.some((u) => u.includes("World_Imagery")));
    assert.ok(urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
    assert.equal(res.headers["x-hamina-alignment"], "import-zip-then-paste");
    assert.ok(Number(res.headers["x-hamina-width-m"]) > 2000);
  });

  it("echoes client treesSource and does not re-fetch canopy when trees are provided", async () => {
    urls.length = 0;
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({
        ...WYNN,
        trees: [{ lon: -115.17, lat: 36.122, pct: 72 }],
        treesSource: "nlcd-canopy",
        format: "bundle",
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.stats.treesSource, "nlcd-canopy");
    assert.ok(body.stats.trees >= 1);
    assert.ok(!urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
  });
});
