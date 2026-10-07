"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { handler, beginOptional, joinOptional, OVERTURE_GRACE_MS, OVERTURE_LARGE_GRACE_MS, OVERTURE_HARD_MS, overtureWait, largestFeatures, imageryAttemptMs, imageryStepBudget, IMAGERY_ATTEMPT_MS, IMAGERY_ATTEMPT_MS_DEV, IMAGERY_RETURN_MS, DEV_ANSWER_MS, lambdaPayloadBytes, EXPORT_PAYLOAD_BUDGET, LAMBDA_SYNC_PAYLOAD_MAX, terrainSettleMs, terrainRescueBudget, TERRAIN_RESERVE_MS, TERRAIN_HARD_MS, TERRAIN_FULL_MS, TERRAIN_COARSE_SAMPLES, setFetchTerrainDemForTests, setFetchChmGridForTests, setFetchOvertureForTests } = require("../netlify/functions/clutter");
const { geoFrame, imageryExportPlan } = require("../netlify/lib/geo-frame");
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
      { id: "tree-trunk", name: "Tree Trunk", color: "#8B6B4F", shortcutKey: "z", topEdge: 8.0, bottomEdge: null, attenuationDbPerMeter: 10.0, ituRModelEnabled: true, transparencyEnabled: true },
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
    assert.equal(body.gpsClipboard.tiePoints.length, 2);
    assert.deepEqual(body.terrainClipboard.tiePoints, body.gpsClipboard.tiePoints);
    assert.deepEqual(body.terrainClipboard.tiePoints[1], {
      lat: body.frame.north,
      lon: body.frame.east,
      x: 0,
      y: 0,
    });
    assert.equal(body.terrainClipboard.tiePoints[0].lat, body.frame.south);
    assert.equal(body.terrainClipboard.tiePoints[0].lon, body.frame.west);
    assert.match(body.zipFilename, /\.zip$/);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.deepEqual(Object.keys(files).sort(), ["images/Wynn-Golf.jpg", "openIntent_Wynn-Golf.json"]);
    const exportStats = body.stats;
    assert.equal(typeof exportStats.buildingsKept, "number");
    assert.equal(typeof exportStats.treesKept, "number");
    assert.ok(exportStats.treesSource);
    assert.equal(files["terrain-clipboard.json"], undefined);
    assert.equal(files["hamina-clipboard.json"], undefined);
    const oiText = files["openIntent_Wynn-Golf.json"].toString();
    assert.equal(oiText.includes("raisedFloorZones"), false);
    assert.equal(oiText.includes("slopedFloors"), false);
    assert.equal(oiText.includes("tiePoints"), false);
    assert.deepEqual(body.frame.clipboardCorners.ne, [0, 0]);
    assert.match(body.alignment, /Import this zip in Hamina/);
    const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
    assert.ok(oi.floorplans[0].attenuation_areas.length >= 1);
    assert.equal(exportStats.attenuationAreasEmitted, oi.floorplans[0].attenuation_areas.length);
    assert.equal(exportStats.openclutterVersion, APP_VERSION);
    assert.equal(body.stats.openIntentBuildingAreas, body.stats.buildings);
    assert.equal(body.stats.includeFoliage, false);
    assert.equal(body.stats.openIntentTreeAreas, 0);
    assert.equal(
      oi.floorplans[0].attenuation_areas.length,
      body.stats.openIntentBuildingAreas + body.stats.openIntentTreeAreas
    );
    assert.equal(
      oi.floorplans[0].attenuation_areas.some(
        (a) => a.area_material && /foliage|tree trunk/i.test(String(a.area_material.name))
      ),
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
    assert.match(body.terrainStatus, /USGS 3DEP bare-earth/);
    assert.equal(/Copernicus/.test(body.terrainStatus), false);
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), false);
    assert.equal(/Airbus Defence/.test(body.terrainStatus), false);
    assert.equal(exportStats.demKind, "bare-earth");
  });

  it("skips the DEM and Copy terrain when includeTerrain is false", async () => {
    urls.length = 0;
    const calls = [];
    setFetchTerrainDemForTests(async () => {
      calls.push("dem");
      return { samples: [], kind: "bare-earth" };
    });
    try {
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...WYNN, includeTerrain: false, format: "bundle" }),
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.terrainStatus, "Terrain off");
      assert.equal(body.terrainClipboard, null);
      assert.equal(body.terrainFilename, null);
      assert.equal(body.gpsClipboard.header.type, "HaminaClipboard");
      assert.equal(body.gpsClipboard.tiePoints.length, 2);
      assert.equal(body.gpsClipboard.tiePoints[0].lat, body.frame.south);
      assert.equal(body.gpsClipboard.tiePoints[0].lon, body.frame.west);
      assert.equal(body.gpsClipboard.tiePoints[1].lat, body.frame.north);
      assert.equal(body.gpsClipboard.tiePoints[1].lon, body.frame.east);
      assert.equal(body.gpsClipboard.tiePoints[1].x, 0);
      assert.equal(body.gpsClipboard.tiePoints[1].y, 0);
      assert.equal(body.gpsClipboard.slopedFloors.length, 0);
      assert.equal(body.gpsClipboard.raisedFloorZones.length, 0);
      assert.ok(Math.hypot(
        body.gpsClipboard.tiePoints[1].x - body.gpsClipboard.tiePoints[0].x,
        body.gpsClipboard.tiePoints[1].y - body.gpsClipboard.tiePoints[0].y
      ) > 100);
      assert.equal(calls.length, 0);
      assert.equal(urls.some((u) => u.includes("elevation.nationalmap.gov")), false);
      assert.equal(urls.some((u) => u.includes("copernicus-dem")), false);
      const warnings = (body.warnings || []).join("\n");
      assert.equal(/terrain omitted|timed out/i.test(warnings), false);
      assert.equal(/terrain omitted|timed out/i.test(body.terrainStatus), false);
      const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
      assert.equal(files["terrain-clipboard.json"], undefined);
      assert.ok(files["images/Wynn-Golf.jpg"]);
      assert.ok(files["openIntent_Wynn-Golf.json"]);
      const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
      assert.ok(oi.floorplans[0].attenuation_areas.length >= 1);
      assert.equal(body.stats.includeFoliage, false);
    } finally {
      setFetchTerrainDemForTests(null);
    }
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
    assert.deepEqual(await sampleCountFor("10"), { count: "2500", id: "10" });
    assert.deepEqual(await sampleCountFor("1"), { count: "2500", id: "1" });
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

  it("format=zip is the OpenIntent JSON and the aerial", async () => {
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ ...WYNN, trees: [{ lon: -115.17, lat: 36.122 }], format: "zip" }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/zip");
    const files = unzipStore(Buffer.from(res.body, "base64"));
    assert.deepEqual(Object.keys(files).sort(), ["images/Wynn-Golf.jpg", "openIntent_Wynn-Golf.json"]);
    assert.ok(files["openIntent_Wynn-Golf.json"]);
  });

  it("echoes client treesSource and does not draw NLCD squares when canopy height misses", async () => {
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
    assert.equal(body.stats.trees, 0);
    assert.equal(body.stats.openIntentTreeAreas, 0);
    assert.equal(body.stats.foliageGeometry === "nlcd-polygon", false);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
    const veg = oi.floorplans[0].attenuation_areas.filter((a) => String(a.area_material.name).indexOf("Foliage") === 0);
    assert.equal(veg.length, 0);
    assert.equal(files["hamina-clipboard.json"], undefined);
    assert.equal(
      oi.floorplans[0].attenuation_areas.some((a) => a.area_material && a.area_material.name === "Tree Trunk"),
      false
    );
    assert.ok(!urls.some((u) => u.includes("USFS_EDW_NLCD_TCC")));
  });
});

describe("dev foliage traces canopy height", () => {
  const orig = global.fetch;
  const { oiPixelCoords } = require("../netlify/lib/pipeline");
  const { isVegetationOiName, isTrunkOiName } = require("../netlify/lib/materials");
  const { devChmWait } = require("../netlify/functions/clutter");

  function axisRect(ring) {
    const open =
      ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1)
        : ring.slice();
    if (open.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      const a = open[i];
      const b = open[(i + 1) % 4];
      const dx = Math.abs(a[0] - b[0]);
      const dy = Math.abs(a[1] - b[1]);
      if (dx > 1e-3 && dy > 1e-3) return false;
    }
    return true;
  }

  function roundCrown() {
    const w = 48;
    const h = 48;
    const cell = 2.2;
    const values = new Uint8Array(w * h);
    let nz = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 24, y - 24) <= 3.4) {
          values[y * w + x] = 16;
          nz++;
        }
      }
    }
    const midLat = 36.128;
    const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
    const west = -115.162;
    const south = 36.127;
    return {
      west,
      south,
      east: west + (w * cell) / mLon,
      north: south + (h * cell) / 110540,
      width: w,
      height: h,
      values,
      nonzero: nz,
    };
  }

  function hang(signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 30000);
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

  before(() => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("MSBFP2")) {
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
      if (u.includes("World_Imagery")) {
        if (u.includes("f=json")) {
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: [] }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
  });

  after(() => {
    setFetchChmGridForTests(null);
    global.fetch = orig;
  });

  it("gives canopy height the rest of the dev answer clock", () => {
    const wait = devChmWait(Date.now());
    assert.ok(wait.budgetMs > 400, "budget " + wait.budgetMs);
    assert.ok(wait.budgetMs <= DEV_ANSWER_MS - 400);
    assert.equal(wait.flushMs, 80);
  });

  it("exports a traced crown and a trunk when canopy height is ready", async () => {
    setFetchChmGridForTests(async () => roundCrown());
    const hits = [
      { lon: -115.17, lat: 36.122, pct: 80 },
      { lon: -115.1697, lat: 36.122, pct: 80 },
      { lon: -115.17, lat: 36.12225, pct: 80 },
      { lon: -115.1697, lat: 36.12225, pct: 80 },
    ];
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({
        ...WYNN,
        includeFoliage: true,
        treesSource: "nlcd-canopy",
        canopyHits: hits,
        format: "bundle",
      }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.equal(body.stats.foliageGeometry, "chm-contour");
    assert.ok(body.stats.openIntentTreeAreas >= 1);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.deepEqual(Object.keys(files).sort(), ["images/Wynn-Golf.jpg", "openIntent_Wynn-Golf.json"]);
    const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
    const areas = oi.floorplans[0].attenuation_areas;
    const crowns = areas.filter((a) => isVegetationOiName(a.area_material.name));
    const trunks = areas.filter((a) => isTrunkOiName(a.area_material.name));
    assert.equal(crowns.length, 1);
    assert.equal(trunks.length, 1);
    const crown = crowns[0];
    assert.equal(crown.area_material.transparencyEnabled, true);
    assert.ok(crown.area_material.bottom_height >= 2.5);
    assert.ok(crown.area_material.bottom_height < crown.area_material.top_height);
    assert.equal(trunks[0].area_material.top_height, crown.area_material.bottom_height);
    const ring = oiPixelCoords(crown.area.coordinates).map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
    assert.equal(axisRect(ring), false, "crown ring " + JSON.stringify(ring));
    assert.ok(ring.length >= 6, "traced ring has " + ring.length + " corners");
  });

  it("returns the buildings zip when canopy height hangs and does not draw squares", async () => {
    setFetchChmGridForTests((_frame, opts) => hang(opts && opts.signal));
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({
        ...WYNN,
        includeFoliage: true,
        treesSource: "nlcd-canopy",
        canopyHits: [
          { lon: -115.17, lat: 36.122, pct: 80 },
          { lon: -115.1697, lat: 36.122, pct: 80 },
          { lon: -115.17, lat: 36.12225, pct: 80 },
          { lon: -115.1697, lat: 36.12225, pct: 80 },
        ],
        format: "bundle",
      }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));
    assert.ok(elapsed >= 4000, "elapsed " + elapsed);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.match((body.warnings || []).join("\n"), /Foliage omitted: canopy height timed out/);
    assert.equal(body.stats.openIntentTreeAreas, 0);
    assert.equal(body.stats.foliageGeometry, "omitted");
    assert.ok(body.stats.openIntentBuildingAreas >= 1);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.deepEqual(Object.keys(files).sort(), ["images/Wynn-Golf.jpg", "openIntent_Wynn-Golf.json"]);
    const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
    assert.equal(
      oi.floorplans[0].attenuation_areas.some((a) => /foliage|tree trunk/i.test(String(a.area_material && a.area_material.name))),
      false
    );
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
      body: JSON.stringify({
        ...WYNN,
        trees: [{ lon: -115.17, lat: 36.122 }],
        includeFoliage: true,
        treesSource: "nlcd-canopy",
        canopyHits: [
          { lon: -115.17, lat: 36.122, pct: 80 },
          { lon: -115.1697, lat: 36.122, pct: 80 },
          { lon: -115.17, lat: 36.12225, pct: 70 },
          { lon: -115.1697, lat: 36.12225, pct: 70 },
          { lon: -115.1694, lat: 36.122, pct: 60 },
          { lon: -115.1694, lat: 36.12225, pct: 60 },
        ],
        format: "bundle",
      }),
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
    assert.equal(files["export-warnings.json"], undefined);
    const text = (body.warnings || []).join("\n");
    assert.match(text, /Overture buildings omitted/);
    assert.match(text, /Canopy height omitted/);
    assert.match(text, /Foliage omitted: canopy height timed out/);
    assert.match(body.stats.summary, /Foliage omitted \(canopy height timed out\)/);
    assert.equal(body.stats.openIntentTreeAreas, 0);
    assert.ok(body.stats.openIntentBuildingAreas >= 1);
    assert.equal(body.stats.includeFoliage, true);
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
    assert.equal(files["terrain-clipboard.json"], undefined);
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
    assert.ok(OVERTURE_HARD_MS > 14000, "Sphere read must outlast a slow aerial");
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

  function demPack() {
    return {
      samples: [
        { lon: 27.181, lat: 60.566, z: 4 },
        { lon: 27.19, lat: 60.566, z: 6 },
        { lon: 27.181, lat: 60.575, z: 9 },
        { lon: 27.19, lat: 60.575, z: 12 },
      ],
      kind: "surface",
      attribution: "glo",
    };
  }

  it("keeps a DEM that resolves in the last slice of the dev answer clock", async () => {
    const warnings = [];
    const job = beginOptional(() => new Promise((resolve) => setTimeout(() => resolve(demPack()), 120)));
    const started = Date.now() - 5750;
    const result = await joinOptional(warnings, started, "Terrain", job, {
      graceMs: 0,
      hardMs: 6000,
      budgetMs: 0,
      flushMs: 80,
      keepOpen: true,
    });
    assert.equal(result && result.samples && result.samples.length, 4);
    assert.equal(warnings.length, 0);
  });

  it("keeps a DEM grid that resolves as the terrain abort fires", async () => {
    const warnings = [];
    const job = beginOptional(
      (signal) =>
        new Promise((resolve) => {
          const done = () => resolve(demPack());
          if (signal.aborted) done();
          else signal.addEventListener("abort", done, { once: true });
        })
    );
    const result = await joinOptional(warnings, Date.now() - (TERRAIN_HARD_MS + 500), "Terrain", job, {
      graceMs: 1500,
      hardMs: TERRAIN_HARD_MS,
    });
    assert.equal(result.samples.length, 4);
    assert.equal(result.kind, "surface");
    assert.equal(warnings.length, 0);
  });

  it("waits out a reserved terrain slice after the 9s cap", async () => {
    const warnings = [];
    const job = beginOptional(() => new Promise((resolve) => setTimeout(() => resolve(demPack()), 350)));
    const started = Date.now() - 10000;
    const t0 = Date.now();
    const result = await joinOptional(warnings, started, "Terrain", job, {
      graceMs: TERRAIN_RESERVE_MS,
      hardMs: 10000 + TERRAIN_RESERVE_MS + 400,
      reserveMs: TERRAIN_RESERVE_MS,
    });
    assert.equal(result.samples.length, 4);
    assert.equal(warnings.length, 0);
    assert.ok(Date.now() - t0 >= 300 && Date.now() - t0 < 2000, "waited " + (Date.now() - t0));
  });

  it("budgets a coarser Finland follow-up after the aerial cap is gone", () => {
    assert.equal(terrainSettleMs(100), 2000);
    assert.equal(terrainSettleMs(8000), 1000);
    assert.equal(terrainSettleMs(9500), 0);
    assert.equal(terrainRescueBudget(100), TERRAIN_RESERVE_MS);
    assert.equal(terrainRescueBudget(10000), TERRAIN_RESERVE_MS);
    assert.equal(terrainRescueBudget(19600), 0);
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
    assert.equal(files["export-stats.json"], undefined);
    const stats = body.stats;
    assert.match(stats.warnings.join("\n"), /179 MB/);
    assert.match((body.warnings || []).join("\n"), /omitted/);
    assert.ok(stats.attenuationAreasEmitted >= 1);
  });
});

describe("dev-host Esri long side", () => {
  const prev = global.fetch;

  function samples() {
    const out = [];
    for (let i = 0; i < 24; i++) {
      out.push({
        location: { x: -115.16 - i * 0.0003, y: 36.128 - i * 0.0002 },
        value: String(40 + (i % 40)),
      });
    }
    return out;
  }

  async function longSideFor(extra) {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: extra.headers,
      path: extra.path,
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const img = seen.find((u) => u.includes("World_Imagery") && u.includes("f=image"));
    const m = String(img).match(/size=(\d+),(\d+)/);
    assert.ok(m, String(img));
    return Math.max(+m[1], +m[2]);
  }

  after(() => {
    global.fetch = prev;
  });

  it("keeps the first export image inside the production attempt", () => {
    assert.equal(IMAGERY_ATTEMPT_MS, 8500);
    assert.equal(IMAGERY_ATTEMPT_MS_DEV, 2500);
    assert.equal(imageryAttemptMs(false), 8500);
    assert.equal(imageryAttemptMs(true), 2500);
    assert.equal(IMAGERY_RETURN_MS, 15000);
    assert.equal(DEV_ANSWER_MS, 6000);
    assert.ok(DEV_ANSWER_MS <= 8000);
    assert.ok(IMAGERY_ATTEMPT_MS_DEV + 1500 < DEV_ANSWER_MS);
    assert.equal(imageryStepBudget(0, 8500), 8500);
    assert.equal(imageryStepBudget(5000, 8500), 8500);
    assert.equal(imageryStepBudget(14000, 8500), 0);
  });

  it("keeps a measured roof that crosses the edge of a long dev draw", async () => {
    global.fetch = async (url) => {
      const u = String(url);
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
      return { ok: true, json: async () => ({ features: [] }) };
    };
    setFetchOvertureForTests(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                features: [
                  {
                    type: "Feature",
                    properties: { height: 112, heightSource: "overture" },
                    geometry: {
                      type: "Polygon",
                      coordinates: [[
                        [-115.176, 36.128],
                        [-115.17, 36.128],
                        [-115.17, 36.131],
                        [-115.176, 36.131],
                        [-115.176, 36.128],
                      ]],
                    },
                  },
                  {
                    type: "Feature",
                    properties: { height: 112, heightSource: "overture" },
                    geometry: {
                      type: "Polygon",
                      coordinates: [[
                        [-115.164, 36.118],
                        [-115.16, 36.118],
                        [-115.16, 36.12],
                        [-115.164, 36.12],
                        [-115.164, 36.118],
                      ]],
                    },
                  },
                ],
              }),
            1100
          )
        )
    );
    try {
      const t0 = Date.now();
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...WYNN, format: "bundle", includeFoliage: false, deferTerrain: true }),
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
      assert.ok(elapsed >= 1000, "elapsed " + elapsed);
      assert.ok(elapsed < 8000, "elapsed " + elapsed);
      const body = JSON.parse(res.body);
      const notes = (body.warnings || []).join("\n");
      assert.equal(/Overture buildings omitted/.test(notes), false, notes);
      const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
      const oi = JSON.parse(files["openIntent_Wynn-Golf.json"].toString());
      const tops = (oi.floorplans[0].attenuation_areas || [])
        .map((a) => a.area_material && a.area_material.top_height)
        .filter((n) => n >= 100);
      assert.equal(tops.length, 1, JSON.stringify(tops));
    } finally {
      setFetchOvertureForTests(null);
    }
  });

  it("asks the dev host for a 400 px export image", async () => {
    assert.equal(await longSideFor({ headers: { host: "dev--openclutter.netlify.app" } }), 400);
    assert.equal(
      await longSideFor({ headers: { host: "deploy-preview-12--openclutter.netlify.app" } }),
      400
    );
    assert.equal(
      await longSideFor({ headers: { host: "openclutter.netlify.app" }, path: "/dev" }),
      400
    );
    assert.equal(await longSideFor({ headers: { host: "openclutter.netlify.app" } }), 1040);
    assert.equal(
      await longSideFor({ headers: { host: "openclutter.netlify.app" }, path: "/api/clutter" }),
      1040
    );
  });

  it("steps down to 256 px when the 400 px export fails", async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=400,")) {
        throw new Error("The operation was aborted due to timeout");
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.ok(images.some((u) => /size=400,/.test(u)), images.join("\n"));
    assert.ok(images.some((u) => /size=256,/.test(u)), images.join("\n"));
    assert.equal(images.some((u) => /size=640,/.test(u)), false);
    assert.equal(images.some((u) => /size=1040,/.test(u)), false);
  });

  it("still exports when the first JPEG aborts after the quick window", async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=400,")) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        throw new Error("The operation was aborted due to timeout");
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(/too large to finish in one export/.test(res.body), false);
    assert.equal(/did not finish/i.test(res.body), false);
    assert.equal(/Aerial imagery timed out/.test(res.body), false);
    assert.equal(/stopped before a zip was ready/.test(res.body), false);
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.ok(images.some((u) => /size=400,/.test(u)), images.join("\n"));
    assert.ok(images.some((u) => /size=256,/.test(u)), images.join("\n"));
    assert.equal(images.some((u) => /size=640,/.test(u)), false);
    assert.equal(images.some((u) => /size=1040,/.test(u)), false);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
  });

  it("keeps a 400 px image that arrives inside its window", async () => {
    const seen = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=400,")) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1600);
          const signal = init && init.signal;
          const abort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }));
          };
          if (signal) {
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }
        });
        return { ok: true, arrayBuffer: async () => jpeg };
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(/too large to finish in one export/.test(res.body), false);
    assert.ok(elapsed >= 1400, "elapsed " + elapsed);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.equal(images.length, 1, images.join("\n"));
    assert.match(images[0], /size=400,/);
    assert.equal(/size=2048,|size=1600,|size=1040,|size=256,/.test(images[0]), false);
  });

  it("returns a zip when the 400 px image misses and the smaller one arrives", async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=400,")) {
        throw new Error("The operation was aborted due to timeout");
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    assert.equal(/Aerial imagery timed out/.test(res.body), false);
    assert.equal(/too large to finish in one export/.test(res.body), false);
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.ok(images.some((u) => /size=400,/.test(u)), images.join("\n"));
    assert.ok(images.some((u) => /size=256,/.test(u)), images.join("\n"));
    assert.equal(images.some((u) => /size=2048,/.test(u)), false);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
  });

  it("returns a zip when the sharp image is still out and footprints hang", async () => {
    const seen = [];
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
    global.fetch = async (url, init) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("overturemaps") || u.includes("blob.core.windows.net/release") || u.includes("elevation.nationalmap.gov") || u.includes("getSamples")) {
        return hang(init && init.signal);
      }
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=400,")) {
        return hang(init && init.signal);
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
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const t0 = Date.now();
    const res = await handler(
      {
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...WYNN, format: "bundle" }),
      },
      {}
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    assert.equal(/Export failed\. Retry\./.test(res.body), false);
    assert.equal(/too large to finish in one export/.test(res.body), false);
    assert.equal(/did not finish/i.test(res.body), false);
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.ok(images.some((u) => /size=400,/.test(u)), images.join("\n"));
    assert.ok(images.some((u) => /size=256,/.test(u)), images.join("\n"));
    assert.equal(images.some((u) => /size=640,/.test(u)), false);
    assert.equal(images.some((u) => /size=1040,/.test(u)), false);
    assert.equal(images.some((u) => /size=1600,/.test(u)), false);
    assert.equal(/Aerial imagery timed out/.test(res.body), false);
    assert.equal(/stopped before a zip was ready/.test(res.body), false);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(res.headers && res.headers["content-type"], "application/json");
  });

  it("returns a finished JSON error when footprints never come back", async () => {
    global.fetch = async (url) => {
      const u = String(url);
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
      return new Promise(() => {});
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", includeFoliage: false }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 502);
    assert.ok(elapsed < 7000, "elapsed " + elapsed);
    assert.ok(elapsed >= 4500, "elapsed " + elapsed);
    assert.equal(res.headers && res.headers["content-type"], "application/json");
    const body = JSON.parse(res.body);
    assert.equal(body.error, "Export timed out. Retry the export.");
    assert.equal(body.zipBase64, undefined);
    assert.equal(/Export failed\. Retry\./.test(res.body), false);
    assert.equal(/did not finish/i.test(res.body), false);
    assert.equal(/stopped before a zip was ready/.test(res.body), false);
    assert.equal(/too large to finish/.test(res.body), false);
  });

  it("asks a short dev draw for a half-meter aerial", async () => {
    const small = { west: -115.166, south: 36.126, east: -115.161, north: 36.13, name: "Corner" };
    const step = imageryExportPlan(true, small)[0];
    const frame = geoFrame(small, { maxSide: step.maxSide, metersPerPx: step.metersPerPx });
    const expectSide = Math.max(frame.imgW, frame.imgH);
    assert.ok(expectSide >= 600, expectSide);
    assert.ok(expectSide <= 1040, expectSide);
    assert.ok(frame.mpuX <= 0.7, frame.mpuX);
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: frame.imgW,
            height: frame.imgH,
            extent: { xmin: small.west, ymin: small.south, xmax: small.east, ymax: small.north },
          }),
        };
      }
      if (u.includes("World_Imagery")) return { ok: true, arrayBuffer: async () => jpeg };
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...small, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.equal(images.length, 1, images.join("\n"));
    assert.match(images[0], new RegExp("size=" + expectSide + ","));
    assert.equal(/size=2048,|size=1600,/.test(images[0]), false);
  });

  it("asks a long dev draw for the High plate and steps down when that plate misses", async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=1040,")) {
        return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", imageryQuality: "high" }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.ok(images.some((u) => /size=1040,/.test(u)), images.join("\n"));
    assert.ok(images.some((u) => /size=400,/.test(u)), images.join("\n"));
    assert.equal(images.some((u) => /size=256,/.test(u)), false);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    const notes = (body.warnings || []).join("\n");
    assert.match(notes, /Map image stepped down to \d+ px.*The 1040 px plate was still out\./);
    assert.equal(/did not finish|timed out|too large to finish|stopped before a zip/i.test(notes), false);
  });

  it("keeps the High plate when that image returns", async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", imageryQuality: "high" }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.equal(images.length, 1, images.join("\n"));
    assert.match(images[0], /size=1040,/);
    const notes = (JSON.parse(res.body).warnings || []).join("\n");
    assert.match(notes, /Map image \d+ px\./);
    assert.equal(/Map image stepped down/.test(notes), false);
  });

  it("ignores a map quality choice off the dev host", async () => {
    const small = { west: -115.166, south: 36.126, east: -115.161, north: 36.13, name: "Corner" };
    const prod = imageryExportPlan(false, small)[0];
    const high = imageryExportPlan(true, small, "high")[0];
    const prodFrame = geoFrame(small, { maxSide: prod.maxSide, metersPerPx: prod.metersPerPx });
    const highFrame = geoFrame(small, { maxSide: high.maxSide, metersPerPx: high.metersPerPx });
    const prodSide = Math.max(prodFrame.imgW, prodFrame.imgH);
    const highSide = Math.max(highFrame.imgW, highFrame.imgH);
    assert.notEqual(prodSide, highSide);
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: prodFrame.imgW,
            height: prodFrame.imgH,
            extent: { xmin: small.west, ymin: small.south, xmax: small.east, ymax: small.north },
          }),
        };
      }
      if (u.includes("World_Imagery")) return { ok: true, arrayBuffer: async () => jpeg };
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "openclutter.netlify.app" },
      body: JSON.stringify({ ...small, format: "bundle", imageryQuality: "high" }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.equal(images.length, 1, images.join("\n"));
    assert.match(images[0], new RegExp("size=" + prodSide + ","));
    assert.equal(new RegExp("size=" + highSide + ",").test(images[0]), false);
    const notes = (JSON.parse(res.body).warnings || []).join("\n");
    assert.equal(/Map image/.test(notes), false);
  });

  it("keeps a High plate that arrives after the Auto imagery budget", async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=1040,")) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { ok: true, arrayBuffer: async () => jpeg };
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", imageryQuality: "high" }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    const images = seen.filter((u) => u.includes("World_Imagery") && u.includes("f=image"));
    assert.equal(images.length, 1, images.join("\n"));
    assert.match(images[0], /size=1040,/);
    const notes = (JSON.parse(res.body).warnings || []).join("\n");
    assert.match(notes, /Map image \d+ px/);
    assert.equal(/Map image stepped down/.test(notes), false);
  });

  it("asks a smaller Sharp draw for 2048 px and starts buildings with that plate", async () => {
    const order = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        order.push(u);
        order.push("image-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push("image-end");
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("overturemaps") || u.includes("blob.core.windows.net/release")) {
        order.push("overture");
        return { ok: true, json: async () => ({ features: [] }) };
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
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD_TCC")) {
        return { ok: true, json: async () => ({ samples: samples() }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", imageryQuality: "sharp", includeFoliage: false }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    const imageAt = order.indexOf("image-end");
    const overtureAt = order.indexOf("overture");
    assert.ok(imageAt >= 0, order.join(","));
    assert.ok(overtureAt >= 0 && overtureAt < imageAt, order.join(","));
    assert.ok(order[0].includes("size=2048,"), order.join("\n"));
    assert.equal(order.filter((e) => String(e).includes("size=1040,") || String(e).includes("size=400,")).length, 0);
    const notes = (JSON.parse(res.body).warnings || []).join("\n");
    assert.match(notes, /Map image \d+ px/);
    assert.equal(/Map image stepped down/.test(notes), false);
    assert.equal(/does not fit this draw/.test(notes), false);
  });

  it("keeps downtown buildings and canopy when a Sharp 2048 plate does not fit", async () => {
    const MTL = {
      west: -73.5745,
      south: 45.4975,
      east: -73.5625,
      north: 45.5052,
      name: "Downtown Montreal",
    };
    const order = [];
    function montrealCrown() {
      const w = 48;
      const h = 48;
      const cell = 2.2;
      const values = new Uint8Array(w * h);
      let nz = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (Math.hypot(x - 24, y - 24) <= 3.4) {
            values[y * w + x] = 16;
            nz++;
          }
        }
      }
      const midLat = 45.503;
      const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
      const west = -73.566;
      const south = 45.5025;
      return {
        west,
        south,
        east: west + (w * cell) / mLon,
        north: south + (h * cell) / 110540,
        width: w,
        height: h,
        values,
        nonzero: nz,
      };
    }
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=1040,")) {
        order.push(u);
        order.push("image-start");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        order.push("image-end");
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        order.push(u);
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: MTL.west, ymin: MTL.south, xmax: MTL.east, ymax: MTL.north },
          }),
        };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    };
    setFetchOvertureForTests(async () => {
      order.push("overture-start");
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push("overture-end");
      return {
        features: [
          {
            type: "Feature",
            properties: { height: 40, heightSource: "overture" },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [-73.57, 45.5],
                [-73.568, 45.5],
                [-73.568, 45.502],
                [-73.57, 45.502],
                [-73.57, 45.5],
              ]],
            },
          },
        ],
      };
    });
    setFetchChmGridForTests(async () => {
      order.push("chm-start");
      return montrealCrown();
    });
    try {
      const t0 = Date.now();
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          ...MTL,
          format: "bundle",
          imageryQuality: "sharp",
          includeFoliage: true,
          includeTerrain: true,
          deferTerrain: true,
        }),
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
      assert.ok(elapsed < 8000, "elapsed " + elapsed);
      const imageAt = order.indexOf("image-end");
      assert.ok(imageAt > order.indexOf("overture-end"), order.join(","));
      assert.ok(imageAt > order.indexOf("chm-start"), order.join(","));
      assert.ok(order[0].includes("size=1040,"), order.join("\n"));
      assert.equal(order.some((e) => String(e).includes("size=2048,")), false);
      const body = JSON.parse(res.body);
      assert.ok(body.stats.buildings >= 1, body.stats.summary);
      assert.ok(body.stats.fetched >= 1, body.stats.summary);
      assert.equal(/0 fetched/.test(body.stats.summary), false, body.stats.summary);
      assert.ok(body.stats.openIntentTreeAreas >= 1 || body.stats.trees >= 1, body.stats.summary);
      assert.equal(/Trees 0 kept/.test(body.stats.summary), false, body.stats.summary);
      const notes = (body.warnings || []).join("\n");
      assert.match(notes, /Map image \d+ px/);
      assert.match(notes, /A 2048 px plate does not fit this draw/);
      assert.equal(/Map image stepped down/.test(notes), false);
      assert.equal(body.terrainClipboard, null);
      const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
      assert.equal(files["terrain-clipboard.json"], undefined);
      assert.ok(Object.keys(files).some((name) => name.startsWith("openIntent_")));
      assert.ok(Object.keys(files).some((name) => name.startsWith("images/")));
    } finally {
      setFetchOvertureForTests(null);
      setFetchChmGridForTests(null);
    }
  });

  it("reads terrain during a High plate instead of omitting it when the plate uses the clock", async () => {
    const order = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image") && u.includes("size=1040,")) {
        order.push("image-start");
        const signal = init && init.signal;
        await new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal && signal.aborted) fail();
          else if (signal) signal.addEventListener("abort", fail, { once: true });
          else setTimeout(fail, 7000);
        });
      }
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        order.push("image-step");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("elevation.nationalmap.gov") && u.includes("getSamples")) {
        order.push("dem");
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: true, json: async () => ({ samples: samples() }) };
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
      return { ok: true, json: async () => ({ features: [] }) };
    };
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", imageryQuality: "high", includeFoliage: false, includeTerrain: true }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    assert.ok(order.indexOf("dem") >= 0 && order.indexOf("dem") < order.indexOf("image-step"), order.join(","));
    const body = JSON.parse(res.body);
    assert.ok(body.terrainClipboard, body.terrainStatus);
    assert.match(body.terrainStatus, /Copy terrain/);
    assert.equal(/export budget spent/.test(body.terrainStatus + (body.warnings || []).join("\n")), false);
  });
});

describe("dev-host Copernicus fallback", () => {
  const orig = global.fetch;
  const TRAFALGAR = {
    west: -0.13,
    south: 51.506,
    east: -0.126,
    north: 51.51,
    name: "Trafalgar",
  };

  after(() => {
    global.fetch = orig;
    setFetchTerrainDemForTests(null);
  });

  function installFetch(samplesBody, extent) {
    const box = extent || TRAFALGAR;
    const urls = [];
    global.fetch = async (url, init) => {
      const u = String(url && url.url ? url.url : url);
      urls.push(u);
      if (u.includes("getSamples") && u.includes("elevation.nationalmap.gov")) {
        if (samplesBody === "hang") {
          return await new Promise((resolve, reject) => {
            const signal = init && init.signal;
            const fail = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (signal && signal.aborted) fail();
            else if (signal) signal.addEventListener("abort", fail, { once: true });
            else {
              const timer = setTimeout(fail, 15000);
              if (timer.unref) timer.unref();
            }
          });
        }
        return { ok: true, json: async () => samplesBody };
      }
      if (u.includes("copernicus-dem")) {
        return { ok: false, status: 404, headers: { get: () => undefined }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (u.includes("World_Imagery")) {
        if (u.includes("f=json")) {
          return {
            ok: true,
            json: async () => ({
              width: 64,
              height: 64,
              extent: {
                xmin: box.west,
                ymin: box.south,
                xmax: box.east,
                ymax: box.north,
                spatialReference: { wkid: 4326 },
              },
            }),
          };
        }
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("MSBFP2")) {
        return {
          ok: true,
          json: async () => ({
            features: [{
              type: "Feature",
              properties: { height: 12 },
              geometry: {
                type: "Polygon",
                coordinates: [[
                  [-0.1288, 51.5072], [-0.1282, 51.5072], [-0.1282, 51.5078], [-0.1288, 51.5078], [-0.1288, 51.5072],
                ]],
              },
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    return urls;
  }

  it("skips the 3DEP probe outside coverage and reads GLO-30 on the dev host", async () => {
    const samples = [];
    for (let i = 0; i < 4; i++) {
      samples.push({
        location: {
          x: TRAFALGAR.west + ((i % 2) + 0.5) * 0.002,
          y: TRAFALGAR.south + (Math.floor(i / 2) + 0.5) * 0.002,
        },
        value: "18",
      });
    }
    const urls = installFetch({ samples });
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...TRAFALGAR, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(urls.some((u) => u.includes("elevation.nationalmap.gov") && u.includes("getSamples")), false);
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), true);
    assert.match(body.terrainStatus, /Terrain omitted/);
    assert.equal(body.terrainClipboard, null);
  });

  it("requests the London GLO-30 tile when 3DEP fails on the dev host", async () => {
    const urls = installFetch({ error: { message: "Invalid or missing input parameters" } });
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...TRAFALGAR, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const glo = urls.filter((u) => u.includes("copernicus-dem"));
    assert.equal(glo.length >= 1, true);
    assert.match(glo[0], /Copernicus_DSM_COG_10_N51_00_W001_00_DEM\.tif/);
    assert.equal(body.terrainClipboard, null);
    assert.match(body.terrainStatus, /Terrain omitted/);
    assert.match(body.terrainStatus, /USGS 3DEP did not return a usable grid/);
  });

  it("leaves production on 3DEP alone when that grid is missing", async () => {
    const urls = installFetch({ error: { message: "Invalid or missing input parameters" } });
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "openclutter.netlify.app" },
      body: JSON.stringify({ ...TRAFALGAR, format: "bundle" }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), false);
    assert.equal(body.terrainClipboard, null);
    assert.match(body.terrainStatus, /Terrain omitted/);
  });

  const HAMINA = {
    west: 27.18,
    south: 60.565,
    east: 27.2,
    north: 60.578,
    name: "Hamina",
  };

  it("fails a hanging 3DEP fast for Hamina and still requests GLO-30 on the dev host", async () => {
    const urls = installFetch("hang", HAMINA);
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...HAMINA, format: "bundle", includeFoliage: false }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), true);
    assert.match(body.terrainStatus, /Terrain omitted/);
    assert.equal(body.terrainClipboard, null);
  });

  it("warns timed out for Hamina only when GLO-30 is aborted as well", async () => {
    const urls = [];
    global.fetch = async (url, init) => {
      const u = String(url && url.url ? url.url : url);
      urls.push(u);
      if (
        (u.includes("elevation.nationalmap.gov") && u.includes("getSamples")) ||
        u.includes("copernicus-dem")
      ) {
        return await new Promise((resolve, reject) => {
          const signal = init && init.signal;
          const fail = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal && signal.aborted) fail();
          else if (signal) signal.addEventListener("abort", fail, { once: true });
          else {
            const timer = setTimeout(fail, 15000);
            if (timer.unref) timer.unref();
          }
        });
      }
      if (u.includes("World_Imagery")) {
        if (u.includes("f=json")) {
          return {
            ok: true,
            json: async () => ({
              width: 64,
              height: 64,
              extent: {
                xmin: HAMINA.west,
                ymin: HAMINA.south,
                xmax: HAMINA.east,
                ymax: HAMINA.north,
                spatialReference: { wkid: 4326 },
              },
            }),
          };
        }
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...HAMINA, format: "bundle", includeFoliage: false }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), true);
    assert.match(body.terrainStatus, /Terrain omitted/);
    assert.equal(body.terrainClipboard, null);
  });

  it("returns a Hamina zip with laser heights, and still a zip when the grid is missing", async () => {
    const fixture = require("./fixtures/nls-hamina-sample.json");
    const { setNlsGridPathForTests } = require("../netlify/lib/nls-building-height");
    const box = {
      west: 27.19,
      south: 60.566,
      east: 27.2,
      north: 60.572,
      name: "Hamina",
    };
    function install() {
      global.fetch = async (url) => {
        const u = String(url && url.url ? url.url : url);
        if (u.includes("getSamples") && u.includes("elevation.nationalmap.gov")) {
          return { ok: true, json: async () => ({ error: { message: "no 3dep" } }) };
        }
        if (u.includes("copernicus-dem")) {
          return { ok: false, status: 404, headers: { get: () => undefined }, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        if (u.includes("World_Imagery")) {
          if (u.includes("f=json")) {
            return {
              ok: true,
              json: async () => ({
                width: 64,
                height: 64,
                extent: {
                  xmin: box.west,
                  ymin: box.south,
                  xmax: box.east,
                  ymax: box.north,
                  spatialReference: { wkid: 4326 },
                },
              }),
            };
          }
          return { ok: true, arrayBuffer: async () => jpeg };
        }
        if (u.includes("MSBFP2")) {
          return {
            ok: true,
            json: async () => ({
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "Polygon", coordinates: [fixture.ring] },
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
      };
    }
    install();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...box, format: "bundle", includeFoliage: false }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 500));
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(body.stats.nlsHeights >= 1, true);
    assert.equal((body.warnings || []).some((w) => /Finland building heights omitted/.test(String(w))), false);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.equal(files["README.txt"], undefined);
    assert.ok(Object.keys(files).some((name) => name.startsWith("openIntent_")));

    setNlsGridPathForTests("/tmp/openclutter-missing-nls-grid.gz");
    try {
      install();
      const miss = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...box, format: "bundle", includeFoliage: false }),
      });
      assert.equal(miss.statusCode, 200, String(miss.body).slice(0, 500));
      const missBody = JSON.parse(miss.body);
      assert.ok(missBody.zipBase64);
      assert.equal(missBody.stats.nlsHeights, 0);
      assert.ok((missBody.warnings || []).some((w) => /Finland building heights omitted/.test(String(w))));
      assert.equal(missBody.error, undefined);
    } finally {
      setNlsGridPathForTests(null);
    }
  });

  function haminaSamples(frame) {
    const samples = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        samples.push({
          lon: frame.west + ((c + 0.5) / 4) * (frame.east - frame.west),
          lat: frame.south + ((r + 0.5) / 4) * (frame.north - frame.south),
          z: 4 + r * 3 + c * 0.2,
        });
      }
    }
    return {
      samples,
      kind: "surface",
      attribution: "Copernicus DEM GLO-30",
    };
  }

  it("keeps a Finland grid when the dev host skips the 3DEP probe", async () => {
    const calls = [];
    setFetchTerrainDemForTests((frame, _fetchFn, opts) => {
      calls.push({
        budgetMs: opts && opts.budgetMs,
        skip3depProbe: !!(opts && opts.skip3depProbe),
      });
      if (!(opts && opts.skip3depProbe)) {
        return new Promise((resolve, reject) => {
          const fail = () =>
            reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }));
          const signal = opts && opts.signal;
          if (signal && signal.aborted) fail();
          else if (signal) signal.addEventListener("abort", fail, { once: true });
        });
      }
      return haminaSamples(frame);
    });
    installFetch({ error: { message: "no 3dep" } }, HAMINA);
    try {
      const t0 = Date.now();
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...HAMINA, format: "bundle", includeFoliage: false }),
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
      assert.ok(elapsed < 6000, "elapsed " + elapsed);
      const body = JSON.parse(res.body);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].skip3depProbe, true);
      assert.ok(body.zipBase64);
      assert.ok(body.terrainClipboard, body.terrainStatus);
      assert.match(body.terrainStatus, /Copy terrain/);
    } finally {
      setFetchTerrainDemForTests(null);
    }
  });

  it("keeps a Finland GLO-30 grid that finished during the aerial", async () => {
    const calls = [];
    setFetchTerrainDemForTests((frame, _fetchFn, opts) => {
      calls.push(!!(opts && opts.skip3depProbe));
      return haminaSamples(frame);
    });
    installFetch({ error: { message: "no 3dep" } }, HAMINA);
    try {
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...HAMINA, format: "bundle", includeFoliage: false, terrainResolution: "auto" }),
      });
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
      const body = JSON.parse(res.body);
      assert.deepEqual(calls, [true]);
      assert.match(body.terrainStatus, /Copy terrain/);
      assert.equal(/timed out/i.test(body.terrainStatus), false);
    } finally {
      setFetchTerrainDemForTests(null);
    }
  });

  it("does not retry GLO-30 after a fast Finland grid miss", async () => {
    const calls = [];
    setFetchTerrainDemForTests(() => {
      calls.push("miss");
      throw new Error("USGS 3DEP did not return a usable grid");
    });
    installFetch({ error: { message: "no 3dep" } }, HAMINA);
    try {
      const t0 = Date.now();
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({ ...HAMINA, format: "bundle", includeFoliage: false }),
      });
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
      assert.ok(Date.now() - t0 < 2500, "elapsed " + (Date.now() - t0));
      const body = JSON.parse(res.body);
      assert.deepEqual(calls, ["miss"]);
      assert.match(body.terrainStatus, /did not return a usable grid/);
      assert.equal(/timed out/i.test(body.terrainStatus), false);
      assert.equal(body.terrainClipboard, null);
    } finally {
      setFetchTerrainDemForTests(null);
    }
  });

  it("does not call GLO-30 for Hamina on production", async () => {
    const urls = installFetch({ error: { message: "Invalid or missing input parameters" } }, HAMINA);
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "openclutter.netlify.app" },
      body: JSON.stringify({ ...HAMINA, format: "bundle", includeFoliage: false }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), false);
    assert.equal(urls.some((u) => u.includes("elevation.nationalmap.gov")), true);
    assert.equal(body.terrainClipboard, null);
    assert.match(body.terrainStatus, /Terrain omitted/);
  });

  it("keeps the full 3DEP sample count for a US frame on the dev host", async () => {
    const samples = [];
    for (let i = 0; i < 4; i++) {
      samples.push({
        location: {
          x: WYNN.west + ((i % 2) + 0.5) * ((WYNN.east - WYNN.west) / 2),
          y: WYNN.south + (Math.floor(i / 2) + 0.5) * ((WYNN.north - WYNN.south) / 2),
        },
        value: "640",
      });
    }
    const urls = installFetch({ samples }, WYNN);
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WYNN, format: "bundle", includeFoliage: false }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    const dem = urls.find((u) => u.includes("elevation.nationalmap.gov") && u.includes("getSamples"));
    assert.ok(dem);
    assert.equal(new URL(dem).searchParams.get("sampleCount"), "144");
    assert.equal(urls.some((u) => u.includes("copernicus-dem")), false);
    assert.match(body.terrainStatus, /USGS 3DEP bare-earth/);
    assert.equal(body.terrainFilename, "terrain-clipboard.json");
  });
});

describe("campus terrain paste stays inside the synchronous response", () => {
  const prev = global.fetch;
  const heavyJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(3600000, 7),
    Buffer.from([0xff, 0xd9]),
  ]);

  function campusBox() {
    const lat = 44.91;
    const widthM = 2140;
    const lengthM = 1780;
    const mpdLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const west = -89.72;
    const south = lat;
    return {
      west,
      south,
      east: west + widthM / mpdLon,
      north: south + lengthM / 110540,
      name: "Campus",
    };
  }

  function install(box, jpegBuf) {
    global.fetch = async (url) => {
      const u = String(url && url.url ? url.url : url);
      if (u.includes("getSamples") || u.includes("USFS_EDW_NLCD")) {
        const samples = [];
        const n = 12;
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            const lon = box.west + ((c + 0.5) / n) * (box.east - box.west);
            const lat = box.south + ((r + 0.5) / n) * (box.north - box.south);
            samples.push({
              location: { x: lon, y: lat },
              value: 200 + ((lat - box.south) / (box.north - box.south)) * 80,
            });
          }
        }
        return { ok: true, json: async () => ({ samples }) };
      }
      if (u.includes("World_Imagery")) {
        if (u.includes("f=json")) {
          return {
            ok: true,
            json: async () => ({
              width: 64,
              height: 48,
              extent: {
                xmin: box.west,
                ymin: box.south,
                xmax: box.east,
                ymax: box.north,
                spatialReference: { wkid: 4326 },
              },
            }),
          };
        }
        return { ok: true, arrayBuffer: async () => jpegBuf };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
  }

  after(() => {
    global.fetch = prev;
  });

  async function exportCampus(resolution, jpegBuf) {
    const box = campusBox();
    install(box, jpegBuf);
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      path: "/dev",
      body: JSON.stringify({
        ...box,
        format: "bundle",
        includeFoliage: false,
        terrainResolution: resolution,
      }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    const payload = lambdaPayloadBytes(res);
    assert.ok(payload <= EXPORT_PAYLOAD_BUDGET, "payload " + payload);
    assert.ok(payload <= LAMBDA_SYNC_PAYLOAD_MAX);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.ok(Object.keys(files).some((name) => name.startsWith("openIntent_")));
    return body;
  }

  it("returns zip plus Copy terrain for 10 m and 1 m on a heavy aerial", async () => {
    for (const stop of ["10", "1"]) {
      const body = await exportCampus(stop, heavyJpeg);
      assert.ok(body.terrainClipboard, body.terrainStatus);
      assert.match(body.terrainStatus, /reduced from/);
      assert.match(body.terrainStatus, /Copy terrain/);
      assert.equal(/omitted/.test(body.terrainStatus), false);
      const quads =
        body.terrainClipboard.slopedFloors.length + body.terrainClipboard.raisedFloorZones.length;
      assert.match(body.terrainStatus, /Terrain sloped/);
      assert.ok(quads < 214 * 178, stop + " quads " + quads);
      assert.ok(quads >= 6 * 5, stop + " quads " + quads);
      const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
      assert.equal(files["terrain-clipboard.json"], undefined);
      assert.ok(body.terrainClipboard);
    }
  });

  it("keeps Auto inside 20×20 on a heavy aerial", async () => {
    const body = await exportCampus("auto", heavyJpeg);
    assert.ok(body.terrainClipboard, body.terrainStatus);
    assert.equal(/reduced from/.test(body.terrainStatus), false);
    assert.equal(/past 20×20/.test(body.terrainStatus), false);
    assert.match(body.terrainStatus, /Copy terrain/);
    assert.match(body.terrainStatus, /Terrain sloped 20×20/);
    assert.equal(/omitted/.test(body.terrainStatus), false);
    const quads =
      body.terrainClipboard.slopedFloors.length + body.terrainClipboard.raisedFloorZones.length;
    assert.equal(quads, 20 * 20);
  });
});

describe("large campus DEM survives the building fetch", () => {
  const prev = global.fetch;
  after(() => {
    global.fetch = prev;
  });

  function campusBox() {
    const lat = 44.91;
    const widthM = 2140;
    const lengthM = 1780;
    const mpdLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const west = -89.72;
    const south = lat;
    return {
      west,
      south,
      east: west + widthM / mpdLon,
      north: south + lengthM / 110540,
      name: "Campus",
    };
  }

  function demBody(box, n) {
    const samples = [];
    const side = Math.max(2, n | 0);
    for (let r = 0; r < side; r++) {
      for (let c = 0; c < side; c++) {
        const lon = box.west + ((c + 0.5) / side) * (box.east - box.west);
        const lat = box.south + ((r + 0.5) / side) * (box.north - box.south);
        const t = (lat - box.south) / (box.north - box.south);
        samples.push({ location: { x: lon, y: lat }, value: 200 + t * 40 });
      }
    }
    return { samples };
  }

  function install(mode) {
    const counts = [];
    const box = campusBox();
    global.fetch = async (url, init) => {
      const u = String(url && url.url ? url.url : url);
      if (u.includes("elevation.nationalmap.gov") && u.includes("getSamples")) {
        const count = new URL(u).searchParams.get("sampleCount");
        counts.push(count);
        const signal = init && init.signal;
        const hang =
          mode === "all" || (mode === "full" && count !== String(TERRAIN_COARSE_SAMPLES));
        if (hang) {
          return await new Promise((resolve, reject) => {
            const fail = () => {
              const err = new Error("The operation was aborted due to timeout");
              err.name = "AbortError";
              reject(err);
            };
            if (signal && signal.aborted) fail();
            else if (signal) signal.addEventListener("abort", fail, { once: true });
            else {
              const timer = setTimeout(fail, 30000);
              if (timer.unref) timer.unref();
            }
          });
        }
        const n = Math.max(2, Math.round(Math.sqrt(Number(count) || 8)));
        return { ok: true, json: async () => demBody(box, Math.min(n, 12)) };
      }
      if (u.includes("copernicus-dem")) {
        return { ok: false, status: 404, headers: { get: () => undefined }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (u.includes("World_Imagery")) {
        if (u.includes("f=json")) {
          return {
            ok: true,
            json: async () => ({
              width: 64,
              height: 48,
              extent: {
                xmin: box.west,
                ymin: box.south,
                xmax: box.east,
                ymax: box.north,
                spatialReference: { wkid: 4326 },
              },
            }),
          };
        }
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    return { counts, box };
  }

  function post(box, terrainStyle) {
    return handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      path: "/dev",
      body: JSON.stringify({
        ...box,
        format: "bundle",
        includeFoliage: false,
        terrainStyle,
        terrainResolution: "auto",
      }),
    });
  }

  it("pastes Raised layers and Sloped from a coarse grid when the full 3DEP read hangs", async () => {
    const { counts, box } = install("full");
    for (const style of ["raised", "sloped"]) {
      counts.length = 0;
      const t0 = Date.now();
      const res = await post(box, style);
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
      assert.ok(elapsed < 6000, style + " elapsed " + elapsed);
      const body = JSON.parse(res.body);
      assert.ok(body.zipBase64);
      assert.equal(body.terrainClipboard, null);
      assert.match(body.terrainStatus, /Terrain omitted/);
      assert.equal(counts.includes(String(TERRAIN_COARSE_SAMPLES)), false, counts.join(","));
    }
  });

  it("keeps the full 3DEP grid when that read returns", async () => {
    const { counts, box } = install("none");
    const res = await post(box, "raised");
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));
    const body = JSON.parse(res.body);
    assert.deepEqual(counts, ["144"]);
    assert.match(body.terrainStatus, /Terrain raised layers/);
    assert.match(body.terrainStatus, /Copy terrain/);
    assert.equal(/timed out/i.test((body.warnings || []).join("\n") + body.terrainStatus), false);
    const floors = body.terrainClipboard.raisedFloorZones.length;
    assert.ok(floors >= 1 && floors <= 400, "floors " + floors);
  });

  it("soft-omits when the coarse campus read is aborted too", async () => {
    const { counts, box } = install("all");
    const t0 = Date.now();
    const res = await post(box, "raised");
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));
    assert.ok(elapsed < 6000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.zipBase64);
    assert.equal(body.terrainClipboard, null);
    assert.match(body.terrainStatus, /Terrain omitted/);
    assert.match(body.terrainStatus, /OpenIntent zip is unchanged/);
    assert.equal(counts.includes(String(TERRAIN_COARSE_SAMPLES)), false, counts.join(","));
  });
});

describe("Pointe-Claire dev export", () => {
  const prev = global.fetch;
  const POINTE = {
    west: -73.8285,
    south: 45.4272,
    east: -73.8239,
    north: 45.4305,
    name: "Pointe-Claire",
  };

  after(() => {
    global.fetch = prev;
    setFetchOvertureForTests(null);
    setFetchTerrainDemForTests(null);
  });

  it("returns roofs, a sharp aerial, and Copy terrain for the peninsula", async () => {
    const images = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) images.push(u);
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: POINTE.west, ymin: POINTE.south, xmax: POINTE.east, ymax: POINTE.north },
          }),
        };
      }
      if (u.includes("World_Imagery")) return { ok: true, arrayBuffer: async () => jpeg };
      return { ok: true, json: async () => ({ features: [], objectIds: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    setFetchOvertureForTests(async () => ({
      features: [{
        type: "Feature",
        properties: { height: 9, heightSource: "overture" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-73.8268, 45.4282],
            [-73.8262, 45.4282],
            [-73.8262, 45.4287],
            [-73.8268, 45.4287],
            [-73.8268, 45.4282],
          ]],
        },
      }],
    }));
    setFetchTerrainDemForTests(async () => ({
      samples: [
        { lon: -73.828, lat: 45.4275, z: 18 },
        { lon: -73.824, lat: 45.4275, z: 22 },
        { lon: -73.828, lat: 45.4302, z: 30 },
        { lon: -73.824, lat: 45.4302, z: 36 },
      ],
      kind: "surface",
      attribution: "Copernicus DEM GLO-30",
    }));
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...POINTE, format: "bundle", includeFoliage: false, includeTerrain: true }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    assert.ok(elapsed < 8000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    assert.ok(body.stats.buildings >= 1, body.stats.summary);
    assert.ok(body.stats.fetched >= 1);
    assert.ok(body.terrainClipboard, body.terrainStatus);
    assert.match(body.terrainStatus, /Copy terrain/);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.deepEqual(Object.keys(files).sort(), ["images/Pointe-Claire.jpg", "openIntent_Pointe-Claire.json"]);
    assert.equal(files["terrain-clipboard.json"], undefined);
    const oi = JSON.parse(files["openIntent_Pointe-Claire.json"].toString());
    assert.ok(oi.floorplans[0].attenuation_areas.length >= 1);
    assert.ok(images.length >= 1, "no imagery url");
    const size = String(images[0]).match(/size=(\d+),(\d+)/);
    assert.ok(size, images[0]);
    assert.ok(Math.max(+size[1], +size[2]) >= 600, images[0]);
    assert.ok(Math.max(+size[1], +size[2]) <= 1040, images[0]);
  });
});

describe("terrain aside from the zip clock", () => {
  const prev = global.fetch;
  const WICO = {
    west: -73.8293,
    south: 45.42485,
    east: -73.81842,
    north: 45.42966,
    name: "Wi-Co",
  };
  const dem = {
    samples: [
      { lon: -73.829, lat: 45.425, z: 18 },
      { lon: -73.819, lat: 45.425, z: 22 },
      { lon: -73.829, lat: 45.4295, z: 30 },
      { lon: -73.819, lat: 45.4295, z: 36 },
    ],
    kind: "surface",
    attribution: "Copernicus DEM GLO-30",
  };

  after(() => {
    global.fetch = prev;
    setFetchTerrainDemForTests(null);
  });

  it("asks a US elevation request to read Copernicus beside 3DEP", async () => {
    let opts = null;
    global.fetch = async () => ({ ok: true, json: async () => ({ features: [] }) });
    setFetchTerrainDemForTests(async (_frame, _fetchFn, o) => {
      opts = o;
      return {
        samples: [
          { lon: -115.165, lat: 36.127, z: 620 },
          { lon: -115.155, lat: 36.127, z: 628 },
          { lon: -115.165, lat: 36.134, z: 640 },
          { lon: -115.155, lat: 36.134, z: 648 },
        ],
        kind: "surface",
        attribution: "Copernicus DEM GLO-30",
      };
    });
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({
        west: -115.1655,
        south: 36.1265,
        east: -115.1545,
        north: 36.135,
        name: "Wynn Golf",
        format: "terrain",
        includeTerrain: true,
        terrainStyle: "sloped",
      }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));
    assert.equal(opts && opts.parallelSurface, true);
    assert.equal(opts.allowSurfaceFallback, true);
    assert.equal(opts.skip3depProbe, false);
    const body = JSON.parse(res.body);
    assert.ok(body.terrainClipboard && body.terrainClipboard.slopedFloors.length > 0);
  });

  it("reads elevation without the map when format is terrain", async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ features: [] }), arrayBuffer: async () => jpeg };
    };
    setFetchTerrainDemForTests(async () => dem);
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WICO, format: "terrain", includeTerrain: true, terrainStyle: "sloped" }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    const body = JSON.parse(res.body);
    assert.ok(body.terrainClipboard && body.terrainClipboard.slopedFloors.length > 0, body.terrainStatus);
    assert.match(body.terrainStatus, /Copy terrain/);
    assert.ok(Array.isArray(body.liftSamples) && body.liftSamples.length >= 4);
    assert.equal(body.liftKind, "surface");
    assert.equal(body.zipBase64, undefined);
    assert.equal(urls.some((u) => u.includes("World_Imagery")), false);
    assert.equal(/export budget spent/.test(body.terrainStatus), false);
  });

  it("keeps a slow elevation read that the zip clock would have aborted", async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ features: [] }) });
    setFetchTerrainDemForTests(
      () => new Promise((resolve) => setTimeout(() => resolve(dem), 1500))
    );
    const t0 = Date.now();
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WICO, format: "terrain", includeTerrain: true }),
    });
    assert.ok(Date.now() - t0 >= 1400);
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 300));
    const body = JSON.parse(res.body);
    assert.ok(body.terrainClipboard, body.terrainStatus);
    assert.equal(/export budget spent/.test(body.terrainStatus || ""), false);
  });

  it("does not start the DEM inside a deferred zip", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return {
          ok: true,
          json: async () => ({
            width: 64,
            height: 64,
            extent: { xmin: WICO.west, ymin: WICO.south, xmax: WICO.east, ymax: WICO.north },
          }),
        };
      }
      if (u.includes("World_Imagery")) return { ok: true, arrayBuffer: async () => jpeg };
      return { ok: true, json: async () => ({ features: [] }) };
    };
    setFetchTerrainDemForTests(async () => {
      calls.push("dem");
      return dem;
    });
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({
        ...WICO,
        format: "bundle",
        includeTerrain: true,
        includeFoliage: false,
        deferTerrain: true,
      }),
    });
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    const body = JSON.parse(res.body);
    assert.equal(calls.length, 0);
    assert.ok(body.zipBase64);
    assert.equal(body.terrainClipboard, null);
    assert.equal(body.terrainStatus, "");
    assert.equal(/export budget spent|terrain omitted/i.test((body.warnings || []).join("\n") + body.terrainStatus), false);
    const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
    assert.equal(files["terrain-clipboard.json"], undefined);
    assert.ok(Object.keys(files).some((name) => name.endsWith(".json")));
    assert.ok(Object.keys(files).some((name) => name.endsWith(".jpg")));
  });

  it("lifts a building onto the pasted mesh without putting that mesh in the zip", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
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
      return { ok: true, json: async () => ({ features: [] }) };
    };
    setFetchTerrainDemForTests(async () => {
      calls.push("dem");
      throw new Error("zip must not read a DEM");
    });
    setFetchOvertureForTests(async () => ({
      features: [
        {
          type: "Feature",
          properties: { height: 40, heightSource: "overture" },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [-115.161, 36.129],
              [-115.159, 36.129],
              [-115.159, 36.131],
              [-115.161, 36.131],
              [-115.161, 36.129],
            ]],
          },
        },
      ],
    }));
    try {
      const res = await handler({
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          ...WYNN,
          format: "bundle",
          includeFoliage: false,
          includeTerrain: true,
          deferTerrain: true,
          terrainStyle: "sloped",
          liftKind: "bare-earth",
          liftSamples: [
            { lon: WYNN.west, lat: WYNN.south, z: 600 },
            { lon: WYNN.east, lat: WYNN.south, z: 600 },
            { lon: WYNN.west, lat: WYNN.north, z: 640 },
            { lon: WYNN.east, lat: WYNN.north, z: 640 },
          ],
        }),
      });
      assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
      const body = JSON.parse(res.body);
      assert.equal(calls.length, 0);
      assert.equal(body.terrainClipboard, null);
      assert.ok(body.stats.buildingsLifted >= 1, body.stats.summary);
      const files = unzipStore(Buffer.from(body.zipBase64, "base64"));
      assert.equal(files["terrain-clipboard.json"], undefined);
      const names = Object.keys(files);
      assert.ok(names.some((name) => name.endsWith(".json")));
      assert.ok(names.some((name) => name.endsWith(".jpg")));
      const oiName = names.find((name) => name.indexOf("openIntent_") === 0);
      const oi = JSON.parse(files[oiName].toString());
      const bottoms = (oi.floorplans[0].attenuation_areas || [])
        .map((a) => a.area_material && a.area_material.bottom_height)
        .filter((n) => n >= 5);
      assert.ok(bottoms.length >= 1, JSON.stringify(oi.floorplans[0].attenuation_areas.map((a) => a.area_material)));
      const mat = oi.floorplans[0].attenuation_areas.find((a) => a.area_material && a.area_material.bottom_height >= 5).area_material;
      assert.ok(mat.top_height > mat.bottom_height + 10, JSON.stringify(mat));
    } finally {
      setFetchOvertureForTests(null);
      setFetchTerrainDemForTests(null);
    }
  });

  it("says to export again when the aside read does not return", async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    setFetchTerrainDemForTests(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "dev--openclutter.netlify.app" },
      body: JSON.stringify({ ...WICO, format: "terrain" }),
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.terrainClipboard, null);
    assert.equal(body.terrainStatus, "Terrain did not return. Export again.");
    assert.equal(/export budget spent/.test(body.terrainStatus), false);
  });
});
