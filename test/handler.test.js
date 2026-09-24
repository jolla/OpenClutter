"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { handler, beginOptional, joinOptional, OVERTURE_GRACE_MS, OVERTURE_LARGE_GRACE_MS, OVERTURE_HARD_MS, overtureWait, largestFeatures } = require("../netlify/functions/clutter");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { ZONE_TYPES } = require("../netlify/lib/hamina-clipboard");
const { unzipStore } = require("../netlify/lib/zip-store");
const { version: APP_VERSION } = require("../netlify/lib/version");

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
        if (String(url).includes("f=json")) {
          return {
            ok: true,
            json: async () => ({
              width: 64,
              height: 64,
              extent: {
                xmin: WYNN.west,
                ymin: WYNN.south,
                xmax: WYNN.east,
                ymax: WYNN.north,
                spatialReference: { wkid: 4326 },
              },
            }),
          };
        }
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      throw new Error("unexpected fetch " + url);
    };
  });
  after(() => {
    global.fetch = orig;
  });

  it("bundle emits one zip that already contains clipboard JSON", async () => {
    urls.length = 0;
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "bundle" }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.zipBase64);
    assert.equal(body.clipboard, undefined);
    assert.equal(body.clipboardFilename, undefined);
    assert.equal(body.terrainFilename, "terrain-clipboard.json");
    assert.equal(body.terrainClipboard.header.type, "HaminaClipboard");
    assert.ok(body.terrainClipboard.raisedFloorZones.length + body.terrainClipboard.slopedFloors.length >= 1);
    assert.match(body.terrainStatus, /Copy terrain/);
    assert.match(body.terrainStatus, /Planner Plus/);
    assert.equal(/terrain-clipboard\.json/.test(body.terrainStatus), false);
    assert.equal(body.terrainClipboard.attenuatingZones.length, 0);
    assert.match(body.zipFilename, /\.zip$/);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.ok(files["openIntent_Wynn-Golf.json"]);
    assert.ok(files["images/Wynn-Golf.jpg"]);
    assert.ok(files["export-warnings.json"]);
    assert.ok(files["hamina-clipboard.json"]);
    assert.ok(files["README.txt"]);
    assert.ok(files["alignment-overlay.svg"]);
    assert.ok(files["frame-lock.json"]);
    assert.ok(files["export-stats.json"]);
    assert.ok(files["VERIFY.txt"]);
    const exportStats = JSON.parse(files["export-stats.json"].toString());
    assert.equal(typeof exportStats.buildingsKept, "number");
    assert.equal(typeof exportStats.treesKept, "number");
    assert.ok(exportStats.treesSource);
    const clip = JSON.parse(files["hamina-clipboard.json"].toString());
    assert.equal(clip.header.type, "HaminaClipboard");
    assert.ok(clip.attenuatingZones.length >= 1);
    assert.equal(clip.raisedFloorZones.length, 0);
    assert.equal(clip.slopedFloors.length, 0);
    assert.ok(files["terrain-clipboard.json"]);
    const terrainFile = JSON.parse(files["terrain-clipboard.json"].toString());
    assert.deepEqual(terrainFile.raisedFloorZones, body.terrainClipboard.raisedFloorZones);
    assert.deepEqual(terrainFile.slopedFloors, body.terrainClipboard.slopedFloors);
    const oiText = files["openIntent_Wynn-Golf.json"].toString();
    assert.equal(oiText.includes("raisedFloorZones"), false);
    assert.equal(oiText.includes("slopedFloors"), false);
    assert.deepEqual(body.frame.clipboardCorners.ne, [0, 0]);
    assert.match(body.alignment, /Import this zip in Hamina/);
    assert.match(files["README.txt"].toString(), /Import this zip in Hamina \(Projects → Import → OpenIntent\)/);
    const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
    assert.ok(oi.floorplans[0].attenuation_areas.length >= 1);
    assert.equal(exportStats.attenuationAreasEmitted, oi.floorplans[0].attenuation_areas.length);
    assert.equal(exportStats.openclutterVersion, APP_VERSION);
    assert.match(files["README.txt"].toString(), new RegExp(`^openclutter_version: ${APP_VERSION}$`, "m"));
    assert.match(files["VERIFY.txt"].toString(), new RegExp(`^attenuation_areas: ${exportStats.attenuationAreasEmitted}$`, "m"));
    assert.match(files["VERIFY.txt"].toString(), new RegExp(`^openclutter_version: ${APP_VERSION}$`, "m"));
    assert.equal(body.stats.openIntentBuildingAreas, body.stats.buildings);
    assert.equal(body.stats.includeFoliage, false);
    assert.equal(body.stats.openIntentTreeAreas, 0);
    assert.equal(
      oi.floorplans[0].attenuation_areas.length,
      body.stats.openIntentBuildingAreas + body.stats.openIntentTreeAreas
    );
    assert.equal(
      clip.attenuatingZones.some((z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("foliage") === 0 || String(z.typeId).indexOf("trunk") === 0),
      false
    );
    assert.ok(!urls.some((u) => u.includes("overpass")));
    assert.ok(urls.some((u) => u.includes("World_Imagery") && u.includes("bboxSR=4326") && u.includes("imageSR=4326")));
    assert.ok(urls.some((u) => u.includes("World_Imagery") && u.includes("f=json")));
    assert.ok(urls.some((u) => u.includes("MSBFP2")));
    assert.ok(urls.some((u) => u.includes("MSBFP2") && u.includes("orderByFields=OBJECTID")));
    assert.ok(urls.some((u) => u.includes("MSBFP2") && u.includes("resultOffset=")));
    assert.equal(body.stats.trees, 0);
    assert.ok(body.stats.fetched >= 1);
    assert.match(body.stats.summary, /Buildings /);
    assert.match(body.stats.summary, /Foliage off/);
    assert.match(body.stats.summary, /Trees /);
    assert.equal(body.stats.treesSource, "none");
    assert.ok(!urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
    const dem = urls.find((u) => u.includes("elevation.nationalmap.gov") && u.includes("getSamples"));
    assert.ok(dem);
    assert.equal(new URL(dem).searchParams.get("sampleCount"), "576");
    assert.equal(body.stats.terrainResolution, "auto");
    assert.match(files["README.txt"].toString(), /Auto is the default/);
  });

  it("asks 3DEP for a denser sample count when terrain resolution is Fine or Finest", async () => {
    async function sampleCountFor(terrainResolution, query) {
      urls.length = 0;
      const payload = { ...WYNN, format: "bundle" };
      if (terrainResolution != null) payload.terrainResolution = terrainResolution;
      const res = await handler({
        httpMethod: "POST",
        queryStringParameters: query || undefined,
        body: JSON.stringify(payload),
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.stats.includeFoliage, false);
      const hit = urls.find((u) => u.includes("elevation.nationalmap.gov") && u.includes("getSamples"));
      assert.ok(hit);
      return { count: new URL(hit).searchParams.get("sampleCount"), id: body.stats.terrainResolution };
    }
    assert.deepEqual(await sampleCountFor(undefined), { count: "576", id: "auto" });
    assert.deepEqual(await sampleCountFor("default"), { count: "144", id: "default" });
    assert.deepEqual(await sampleCountFor("fine"), { count: "324", id: "fine" });
    assert.deepEqual(await sampleCountFor("finest"), { count: "576", id: "finest" });
    assert.deepEqual(await sampleCountFor("ultra"), { count: "576", id: "auto" });
    assert.deepEqual(await sampleCountFor(undefined, { terrainResolution: "fine" }), { count: "324", id: "fine" });
    assert.deepEqual(await sampleCountFor("default", { terrainResolution: "finest" }), { count: "144", id: "default" });
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
    assert.ok(!urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
    assert.equal(res.headers["x-hamina-alignment"], "import-openintent-zip");
    assert.ok(Number(res.headers["x-hamina-width-m"]) > 2000);
  });

  it("format=zip bytes already contain hamina-clipboard.json", async () => {
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "zip" }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/zip");
    const files = unzipStore(Buffer.from(res.body, "base64"));
    const clip = JSON.parse(files["hamina-clipboard.json"].toString());
    assert.equal(clip.header.type, "HaminaClipboard");
    assert.ok(files["openIntent_Wynn-Golf.json"]);
  });

  it("echoes client treesSource and does not re-fetch canopy when trees are provided", async () => {
    urls.length = 0;
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({
        ...WYNN,
        trees: [{ lon: -115.17, lat: 36.122, pct: 72 }],
        treesSource: "nlcd-canopy",
        includeFoliage: true,
        canopyHits: [
          { lon: -115.17, lat: 36.122, pct: 72 },
          { lon: -115.1697, lat: 36.122, pct: 72 },
          { lon: -115.17, lat: 36.12225, pct: 72 },
          { lon: -115.1697, lat: 36.12225, pct: 80 },
        ],
        format: "bundle",
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.stats.includeFoliage, true);
    assert.equal(body.stats.treesSource, "nlcd-canopy");
    assert.ok(body.stats.trees >= 1);
    assert.ok(body.stats.openIntentTreeAreas >= 1);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
    const veg = oi.floorplans[0].attenuation_areas.filter((a) => String(a.area_material.name).indexOf("Foliage") === 0);
    assert.ok(veg.length >= 1);
    const clip = JSON.parse(files["hamina-clipboard.json"].toString());
    assert.equal(clip.attenuatingZones.some((z) => z.typeId === "tree-trunk"), false);
    assert.ok(!urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
  });
});

describe("optional sources cannot fail the export", () => {
  const orig = global.fetch;

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input && input.url) return String(input.url);
    return String(input);
  }

  function hang(signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 504, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }), 30000);
      const abort = () => {
        clearTimeout(timer);
        const err = new Error("The operation was aborted due to timeout");
        err.name = "AbortError";
        reject(err);
      };
      if (signal && signal.aborted) abort();
      else if (signal) signal.addEventListener("abort", abort, { once: true });
    });
  }

  function coreFetch(url, init) {
    const u = urlOf(url);
    if (u.includes("overturemaps") || u.includes("blob.core.windows.net/release") || u.includes("dataforgood-fb-data") || u.includes("elevation.nationalmap.gov")) {
      return hang(init && init.signal);
    }
    if (u.includes("World_Imagery")) {
      if (u.includes("f=json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: WYNN.west, ymin: WYNN.south, xmax: WYNN.east, ymax: WYNN.north, spatialReference: { wkid: 4326 } },
          }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => jpeg });
    }
    if (u.includes("MSBFP2")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          features: [{
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[[-115.165, 36.126], [-115.164, 36.126], [-115.164, 36.127], [-115.165, 36.127], [-115.165, 36.126]]],
            },
          }],
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ features: [] }), arrayBuffer: async () => new ArrayBuffer(0) });
  }

  after(() => {
    global.fetch = orig;
  });

  it("returns the OpenIntent zip when Overture, canopy height, and terrain hang", async () => {
    global.fetch = coreFetch;
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], includeFoliage: true, format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    // Wynn is a large draw, so a hung Overture read may use the long grace.
    // It still has to return a zip well inside the gateway clock.
    assert.ok(elapsed < 20000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(body.stats.fetched >= 1, true);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.ok(files["openIntent_Wynn-Golf.json"]);
    const warnings = JSON.parse(files["export-warnings.json"].toString());
    const text = warnings.warnings.join("\n");
    assert.match(text, /Overture buildings omitted/);
    assert.match(text, /Canopy height omitted/);
    assert.match(text, /Terrain omitted/);
    assert.equal(/esri/i.test(text), false);
    assert.equal(/smaller box/i.test(text + body.warnings.join(" ")), false);
    assert.equal(files["terrain-clipboard.json"], undefined);
    assert.equal(body.terrainClipboard, null);
    assert.equal(body.terrainFilename, null);
    assert.match(body.terrainStatus, /Terrain omitted/);
    assert.match(body.terrainStatus, /OpenIntent zip is unchanged/);
  });

  it("keeps a finished 3DEP grid when the aerial JPEG passes 5s", async () => {
    const samples = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        samples.push({
          location: {
            x: WYNN.west + ((c + 0.5) / 6) * (WYNN.east - WYNN.west),
            y: WYNN.south + ((r + 0.5) / 6) * (WYNN.north - WYNN.south),
          },
          value: "640",
        });
      }
    }
    global.fetch = async (url, init) => {
      const u = urlOf(url);
      if (u.includes("elevation.nationalmap.gov")) {
        return { ok: true, json: async () => ({ samples }) };
      }
      if (u.includes("overturemaps") || u.includes("blob.core.windows.net") || u.includes("dataforgood-fb-data")) {
        return { ok: true, json: async () => ({ features: [] }) };
      }
      if (u.includes("World_Imagery") && !u.includes("f=json")) {
        await new Promise((resolve) => setTimeout(resolve, 5200));
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      return coreFetch(u, init);
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    assert.ok(elapsed >= 5000, "jpeg " + elapsed);
    assert.ok(elapsed < 7500, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(body.terrainFilename, "terrain-clipboard.json");
    assert.ok(body.terrainClipboard.raisedFloorZones.length >= 1);
    assert.equal(body.terrainClipboard.slopedFloors.length, 0);
    const pad = body.terrainClipboard.raisedFloorZones[0];
    assert.deepEqual(Object.keys(pad), ["area", "height", "attenuationDbPerMeter", "slabOnly"]);
    assert.equal(pad.area.coordinates[0][0].length, 2);
    assert.equal(pad.slabOnly, false);
    assert.equal(pad.attenuationDbPerMeter, 0);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.ok(files["terrain-clipboard.json"]);
    assert.equal(files["openIntent_Wynn-Golf.json"].toString().includes("raisedFloorZones"), false);
    assert.equal(body.stats.includeFoliage, false);
  });

  it("does not call an imagery timeout Esri or a smaller box", async () => {
    global.fetch = async (url) => {
      const u = urlOf(url);
      if (u.includes("World_Imagery") && !u.includes("f=json")) {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
      }
      if (u.includes("World_Imagery")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: WYNN.west, ymin: WYNN.south, xmax: WYNN.east, ymax: WYNN.north },
          }),
        };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "bundle" }),
    });
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Aerial imagery timed out/);
    assert.equal(/esri/i.test(body.error), false);
    assert.equal(/smaller box/i.test(body.error), false);
  });

  it("retries the aerial JPEG on a timeout and still exports", async () => {
    let jpegCalls = 0;
    global.fetch = async (url, init) => {
      const u = urlOf(url);
      if (u.includes("World_Imagery") && !u.includes("f=json")) {
        jpegCalls++;
        if (jpegCalls === 1) {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
        }
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      return coreFetch(u);
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    assert.equal(jpegCalls, 2);
    assert.ok(elapsed >= 400, "backoff " + elapsed);
    assert.ok(elapsed < 20000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(/smaller box/i.test(body.error || ""), false);
  });

  it("starts the aerial JPEG without waiting out a slow imagery metadata response", async () => {
    const calls = [];
    const t0 = Date.now();
    global.fetch = async (url, init) => {
      const u = urlOf(url);
      calls.push({ u, t: Date.now() - t0 });
      if (u.includes("World_Imagery") && u.includes("f=json")) return hang(init && init.signal);
      return coreFetch(u, init);
    };
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    const jpeg = calls.find((c) => c.u.includes("World_Imagery") && !c.u.includes("f=json"));
    const meta = calls.find((c) => c.u.includes("World_Imagery") && c.u.includes("f=json"));
    assert.ok(jpeg && meta);
    assert.ok(jpeg.t < 200, "jpeg start " + jpeg.t);
    assert.ok(Math.abs(jpeg.t - meta.t) < 200, "jpeg " + jpeg.t + " meta " + meta.t);
    assert.ok(elapsed < 22000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    // Metadata never arrived. The JPEG is still Esri's padded content grid.
    // Projecting the drawn box shifts every roof except the draw center.
    assert.ok(body.frame.south < WYNN.south - 1e-5, "south " + body.frame.south);
    assert.ok(body.frame.north > WYNN.north + 1e-5, "north " + body.frame.north);
    assert.equal(body.frame.west, WYNN.west);
    assert.equal(body.frame.east, WYNN.east);
    assert.ok(jpeg.u.includes(String(WYNN.south)), "imagery URL must stay the drawn box");
    assert.equal(jpeg.u.includes(String(body.frame.south)), false);
  });

  it("aborts a hung Overture read quickly on a small draw", async () => {
    const small = {
      west: -115.16,
      south: 36.12,
      east: -115.158,
      north: 36.122,
      name: "Small lot",
    };
    global.fetch = async (url, init) => {
      const u = urlOf(url);
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: small.west, ymin: small.south, xmax: small.east, ymax: small.north },
          }),
        };
      }
      return coreFetch(url, init);
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...small, format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(/smaller box/i.test((body.warnings || []).join(" ")), false);
  });

  it("starts Overture during the core footprint fetch, not after it", async () => {
    const calls = [];
    const t0 = Date.now();
    global.fetch = async (url, init) => {
      const u = urlOf(url);
      const t = Date.now() - t0;
      calls.push({ u, t, phase: "start" });
      if (u.includes("bfppub") || u.includes("global-buildings")) {
        await new Promise((resolve) => setTimeout(resolve, 280));
        calls.push({ u, t: Date.now() - t0, phase: "end" });
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      return coreFetch(u, init);
    };
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "bundle" }),
    });
    assert.equal(res.statusCode, 200);
    const overtureStart = calls.find((c) => c.phase === "start" && (c.u.includes("overturemaps") || c.u.includes("/release/")));
    const globalEnd = calls.find((c) => c.phase === "end" && (c.u.includes("bfppub") || c.u.includes("global-buildings")));
    assert.ok(overtureStart, "overture fetch did not start");
    assert.ok(globalEnd, "global fetch did not finish");
    assert.ok(overtureStart.t < globalEnd.t, `overture ${overtureStart.t} global end ${globalEnd.t}`);
  });
});

describe("Overture join keeps a finished read after the core budget", () => {
  it("returns features that finished before the 5s mark even if core ran longer", async () => {
    const warnings = [];
    const job = beginOptional(async () => ({ features: [{ type: "Feature" }] }));
    await job.work;
    const result = await joinOptional(warnings, Date.now() - 6000, "Overture buildings", job);
    assert.equal(result.features.length, 1);
    assert.equal(warnings.length, 0);
  });

  it("uses a short grace so an in-flight Overture read can finish after 5s", async () => {
    const warnings = [];
    const job = beginOptional(
      () => new Promise((resolve) => setTimeout(() => resolve({ features: [{ type: "Feature" }] }), 350))
    );
    const t0 = Date.now();
    const result = await joinOptional(warnings, Date.now() - 6000, "Overture buildings", job, {
      graceMs: 1500,
      hardMs: 9000,
    });
    const waited = Date.now() - t0;
    assert.equal(result.features.length, 1);
    assert.equal(warnings.length, 0);
    assert.ok(waited >= 300 && waited < 1200, "waited " + waited);
  });

  it("aborts Overture immediately once the core budget is spent and it is still running", async () => {
    const warnings = [];
    let aborted = false;
    const job = beginOptional(
      (signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) {
            aborted = true;
            reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }));
            return;
          }
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }));
          });
        })
    );
    const t0 = Date.now();
    const result = await joinOptional(warnings, Date.now() - 6000, "Overture buildings", job);
    assert.equal(result, null);
    assert.ok(Date.now() - t0 < 400, "waited " + (Date.now() - t0));
    assert.match(warnings[0], /Overture buildings omitted: export budget spent/);
    assert.equal(aborted, true);
  });

  it("keeps an in-flight Overture read after core has already passed 9s", async () => {
    assert.ok(OVERTURE_HARD_MS > 18000, "Sphere read must outlast a slow Netlify core");
    assert.ok(OVERTURE_GRACE_MS >= 4000);
    const warnings = [];
    const job = beginOptional(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ features: [{ type: "Feature", properties: { height: 112 } }] }), 400)
        )
    );
    const started = Date.now() - 14000;
    const result = await joinOptional(warnings, started, "Overture buildings", job, {
      graceMs: OVERTURE_GRACE_MS,
      hardMs: OVERTURE_HARD_MS,
    });
    assert.equal(result.features[0].properties.height, 112);
    assert.equal(warnings.length, 0);
  });

  it("keeps footprints already parsed when the Overture abort fires", async () => {
    const warnings = [];
    const job = beginOptional(
      (signal) =>
        new Promise((resolve) => {
          const done = () => resolve({ features: [{ type: "Feature", properties: { height: 112 } }], partial: true });
          if (signal.aborted) done();
          else signal.addEventListener("abort", done);
        })
    );
    const result = await joinOptional(warnings, Date.now() - (OVERTURE_HARD_MS + 2000), "Overture buildings", job, {
      graceMs: OVERTURE_GRACE_MS,
      hardMs: OVERTURE_HARD_MS,
    });
    assert.equal(result.features.length, 1);
    assert.match(warnings[0], /partial: kept 1 footprints/);
  });

  it("keeps an in-flight Overture read when a long grace outlasts a fast core", async () => {
    const warnings = [];
    const job = beginOptional(
      () => new Promise((resolve) => setTimeout(() => resolve({ features: [{ type: "Feature" }] }), 250))
    );
    const t0 = Date.now();
    const result = await joinOptional(warnings, Date.now() - 1000, "Overture buildings", job, {
      graceMs: OVERTURE_LARGE_GRACE_MS,
      hardMs: OVERTURE_HARD_MS,
    });
    assert.equal(result.features.length, 1);
    assert.equal(warnings.length, 0);
    assert.ok(Date.now() - t0 < 2000, "waited " + (Date.now() - t0));
  });

  it("uses the long Overture grace only for a draw at least 1.5 km on a side", () => {
    const large = overtureWait(geoFrame(WYNN));
    assert.equal(large.graceMs, OVERTURE_LARGE_GRACE_MS);
    assert.equal(large.hardMs, OVERTURE_HARD_MS);
    const small = overtureWait(
      geoFrame({ west: -115.16, south: 36.12, east: -115.158, north: 36.122 })
    );
    assert.equal(small.graceMs, OVERTURE_GRACE_MS);
  });

  it("keeps the largest roofs when a campus zip has to be shortened", () => {
    const mpd = { lon: 90000, lat: 110540 };
    const small = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[-115.16, 36.12], [-115.1599, 36.12], [-115.1599, 36.1201], [-115.16, 36.1201], [-115.16, 36.12]]],
      },
    };
    const big = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[-115.17, 36.12], [-115.16, 36.12], [-115.16, 36.13], [-115.17, 36.13], [-115.17, 36.12]]],
      },
    };
    const kept = largestFeatures([small, big, small], 1, mpd);
    assert.equal(kept.length, 1);
    assert.equal(kept[0], big);
  });
});

describe("oversized Microsoft footprint tile", () => {
  const orig = global.fetch;
  after(() => {
    global.fetch = orig;
  });

  it("exports the other building sources and records the skip", async () => {
    let bodyReads = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("bfppub") || u.includes("global-buildings")) {
        return {
          ok: true,
          headers: {
            get: (name) => (String(name).toLowerCase() === "content-length" ? String(179 * 1024 * 1024) : null),
          },
          arrayBuffer: async () => {
            bodyReads++;
            return new ArrayBuffer(8);
          },
          body: { cancel: async () => {} },
        };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: WYNN.west, ymin: WYNN.south, xmax: WYNN.east, ymax: WYNN.north },
          }),
        };
      }
      if (u.includes("World_Imagery")) return { ok: true, arrayBuffer: async () => jpeg };
      if (u.includes("MSBFP2")) {
        return {
          ok: true,
          json: async () => ({
            features: [{
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [[[-115.165, 36.126], [-115.164, 36.126], [-115.164, 36.127], [-115.165, 36.127], [-115.165, 36.126]]],
              },
            }],
          }),
        };
      }
      if (u.includes("USA_Structures") || u.includes("services2.arcgis.com")) {
        return { ok: true, json: async () => ({ objectIds: [], features: [] }) };
      }
      throw new Error("skip " + u);
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(bodyReads, 0);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    const notes = (body.warnings || []).join("\n");
    const tileNote = (body.warnings || []).find((w) => /Microsoft building footprints/.test(w)) || "";
    assert.match(tileNote, /omitted/);
    assert.match(tileNote, /179 MB/);
    assert.equal(/smaller box/i.test(tileNote), false);
    assert.equal(/esri/i.test(tileNote), false);
    assert.ok(body.zipBase64);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    const stats = JSON.parse(files["export-stats.json"].toString());
    assert.match(stats.warnings.join("\n"), /179 MB/);
    const zipNotes = JSON.parse(files["export-warnings.json"].toString());
    assert.match(zipNotes.warnings.join("\n"), /omitted/);
    assert.ok(stats.attenuationAreasEmitted >= 1);
  });
});
