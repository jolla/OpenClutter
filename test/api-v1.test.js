"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jobs = require("../netlify/lib/export-jobs");
const api = require("../netlify/functions/api-v1");
const { buildSiteV1, selectSite, terrainGrid, classify } = require("../netlify/lib/site-v1");
const { completeExportJob } = require("../netlify/lib/export-run");

function memoryStore() {
  const map = new Map();
  return {
    map,
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async set(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

const KEY = "oc_test_unit_key_0123456789";
const HOST = { host: "dev--openclutter.netlify.app", "x-forwarded-proto": "https" };

function req(method, path, opts) {
  const o = opts || {};
  const headers = Object.assign({}, HOST, o.key === null ? {} : { authorization: "Bearer " + (o.key || KEY) });
  return {
    httpMethod: method,
    path,
    headers,
    queryStringParameters: o.query || {},
    body: o.body === undefined ? "" : JSON.stringify(o.body),
  };
}

const POLY = {
  type: "Polygon",
  coordinates: [[[-115.1655, 36.1205], [-115.1625, 36.1205], [-115.1625, 36.1225], [-115.1655, 36.1225], [-115.1655, 36.1205]]],
};

// 100 x 100 px frame over a ~90 m box. OI pixels are Y-up from the SW corner.
const FRAME = { west: 10, south: 50, east: 10.00125, north: 50.0008, widthM: 89.4, lengthM: 89.0, imgW: 100, imgH: 100, mpuX: 0.894, mpuY: 0.89 };
function sq(x, y, s) {
  return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => ({ coordinate_xyz: { x: a, y: b, unit: "pixels" } }));
}
function area(ring, name, top, bottom, att) {
  const m = { name, rf_properties: { attenuation_per_m: att }, top_height: top, display_color: "#888888" };
  if (bottom != null) m.bottom_height = bottom;
  return { area: { coordinates: ring }, area_material: m };
}
const OI = {
  floorplans: [
    {
      attenuation_areas: [
        area(sq(10, 10, 20), "Building - 12.9", 12.9, null, 5),
        area(sq(15, 15, 5), "Building - 23.1 @ 12.9", 23.1, 12.9, 5),
        area(sq(60, 60, 10), "Foliage - Heavy 14.2", 14.2, 3.5, 1.5),
        area(sq(64, 64, 1), "Foliage - Trunk 3.5", 3.5, null, 3),
        area(sq(80, 20, 0.4), "Light pole", 9, null, 10),
        area(sq(40, 80, 10), "Parking 9.0", 9, null, 2),
        area(sq(5, 80, 2), "Hedge 1.5", 1.5, null, 1),
        area(sq(70, 5, 3), "RV 3.5", 3.5, null, 4),
      ],
    },
  ],
};
const LL = (x, y) => [10 + (x / 100) * 0.00125, 50 + (y / 100) * 0.0008];
const FEATURES = [
  {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[LL(9, 9), LL(31, 9), LL(31, 31), LL(9, 31), LL(9, 9)]] },
    properties: { height: 12.9, heightSource: "nls-laser", geomSource: "osm", name: "Town hall" },
  },
];

describe("site-v1 model", () => {
  it("classifies OpenIntent materials", () => {
    assert.equal(classify("Building - Podium 3.0"), "building");
    assert.equal(classify("Foliage - Trunk 3.5"), "trunk");
    assert.equal(classify("Foliage - Light 7.5"), "crown");
    assert.equal(classify("Foliage - Understory 2.0"), "stand");
    assert.equal(classify("Light pole"), "pole");
    assert.equal(classify("Retaining wall 2.0"), "wall");
    assert.equal(classify("Semi 4.1 @ 3.0"), "vehicle");
    assert.equal(classify("Water"), "water");
  });

  it("builds GeoJSON collections from the export model", () => {
    const site = buildSiteV1({
      name: "Unit",
      openintent: OI,
      frame: FRAME,
      features: FEATURES,
      demSamples: [
        { lon: 10, lat: 50.0008, z: 12 },
        { lon: 10.00125, lat: 50.0008, z: 13 },
        { lon: 10, lat: 50, z: 10 },
        { lon: 10.00125, lat: 50, z: 11 },
      ],
      notes: [{ x: -10, y: -10, text: "Clock tower", color: "#db6921", icon: "NOTICE_OUTLINE" }],
      warnings: ["w1"],
    });
    assert.equal(site.apiVersion, "1.0.0");
    assert.equal(site.crs, "EPSG:4326");
    assert.equal(site.buildings.features.length, 2);
    const hall = site.buildings.features[0].properties;
    assert.equal(hall.topHeightM, 12.9);
    assert.equal(hall.heightSource, "nls-laser");
    assert.equal(hall.name, "Town hall");
    assert.equal(hall.material.attenuationDbPerMeter, 5);
    const tower = site.buildings.features[1].properties;
    assert.equal(tower.baseHeightM, 12.9);
    assert.equal(tower.buildingId, hall.buildingId);
    assert.equal(tower.tier, "part");
    assert.equal(tower.buildingPart, true);
    assert.equal(hall.tier, "mass");
    assert.ok(Number.isFinite(hall.groundOffsetM));
    assert.equal(site.stats.buildingParts, 1);
    assert.equal(site.trees.features.length, 1);
    const tree = site.trees.features[0].properties;
    assert.equal(tree.crownTopM, 14.2);
    assert.equal(tree.crownBaseM, 3.5);
    assert.equal(tree.trunkHeightM, 3.5);
    assert.equal(tree.foliageClass, "heavy");
    assert.equal(tree.attenuationDbPerMeter, 1.5);
    assert.equal(site.poles.features.length, 1);
    assert.equal(site.poles.features[0].geometry.type, "Point");
    assert.equal(site.poles.features[0].properties.heightM, 9);
    assert.equal(site.parking.features.length, 1);
    assert.equal(site.walls.features[0].properties.kind, "hedge");
    assert.equal(site.vehicles.features[0].properties.kind, "rv");
    assert.equal(site.terrain.cols, 2);
    assert.equal(site.terrain.rows, 2);
    assert.deepEqual(site.terrain.z, [[12, 13], [10, 11]]);
    assert.equal(site.terrain.reliefM, 3);
    assert.equal(site.mapNotes.features.length, 1);
    assert.equal(site.mapNotes.features[0].properties.text, "Clock tower");
    assert.equal(site.gpsAnchors.features.length, 2);
    assert.equal(site.aerial.licence.commercialUseAllowed, false);
    const ring = site.buildings.features[0].geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.ok(ring.every((p) => p[0] >= 10 && p[0] <= 10.00125 && p[1] >= 50 && p[1] <= 50.0008));
  });

  it("pages each collection and rejects unknown ones", () => {
    const site = buildSiteV1({ openintent: OI, frame: FRAME, features: FEATURES });
    const one = selectSite(site, { collections: "buildings,poles", pageSize: "1", page: "2" });
    assert.equal(one.buildings.features.length, 1);
    assert.equal(one.poles.features.length, 0);
    assert.equal(one.trees, undefined);
    assert.equal(one.paging.totalPages, 2);
    assert.equal(one.paging.totals.buildings, 2);
    assert.equal(one.paging.next, null);
    assert.throws(() => selectSite(site, { collections: "nope" }), /Unknown collection/);
  });

  it("returns no terrain grid for too few samples", () => {
    assert.equal(terrainGrid([{ lon: 1, lat: 1, z: 1 }], { frame: FRAME }), null);
  });
});

describe("api v1 handler", { concurrency: 1 }, () => {
  let jobStore;
  let apiStore;
  let invoked;
  beforeEach(() => {
    process.env.OPENCLUTTER_API_KEY_HASHES = api.hashKey(KEY);
    jobStore = memoryStore();
    apiStore = memoryStore();
    jobs.setExportStoreForTests(jobStore);
    api.setApiStoreForTests(apiStore);
    invoked = [];
    api.setApiDepsForTests({
      fetch: async (url, init) => {
        invoked.push({ url, body: JSON.parse(init.body) });
        return { status: 202 };
      },
      now: () => Date.now(),
      sleep: async () => {},
    });
  });
  afterEach(() => {
    delete process.env.OPENCLUTTER_API_KEY_HASHES;
    jobs.setExportStoreForTests(null);
    api.setApiStoreForTests(null);
  });

  it("serves health without a key", async () => {
    const res = await api.handler(req("GET", "/v1/health", { key: null }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).apiVersion, "1.0.0");
  });

  it("rejects a missing or wrong key", async () => {
    let res = await api.handler(req("POST", "/v1/sites", { key: null, body: { geometry: POLY } }));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, "unauthorized");
    res = await api.handler(req("POST", "/v1/sites", { key: "oc_test_wrong", body: { geometry: POLY } }));
    assert.equal(res.statusCode, 401);
  });

  it("validates geometry", async () => {
    let res = await api.handler(req("POST", "/v1/sites", { body: {} }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "bbox_required");
    res = await api.handler(req("POST", "/v1/sites", { body: { geometry: { type: "Point", coordinates: [1, 2] } } }));
    assert.equal(JSON.parse(res.body).error.code, "invalid_geometry");
    res = await api.handler(req("POST", "/v1/sites", { body: { bbox: [-115, 36, -114, 37] } }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "area_too_large");
  });

  it("creates a job, hands it to the background export, and serves the result", async () => {
    const res = await api.handler(req("POST", "/v1/sites", { body: { name: "Vegas", geometry: POLY } }));
    assert.equal(res.statusCode, 202);
    assert.ok(res.headers["x-ratelimit-limit"]);
    const view = JSON.parse(res.body);
    assert.equal(view.status, "queued");
    assert.equal(invoked.length, 1);
    assert.match(invoked[0].url, /clutter-export-background$/);
    const inner = JSON.parse(invoked[0].body.event.body);
    assert.equal(inner.format, "site-v1");
    assert.equal(inner.west, -115.1655);
    assert.equal(inner.north, 36.1225);
    assert.equal(inner.includeFoliage, true);
    assert.equal(invoked[0].body.event.headers.authorization, undefined, "the key never leaves the API function");

    let st = await api.handler(req("GET", "/v1/sites/" + view.id));
    assert.equal(JSON.parse(st.body).status, "queued");
    let r = await api.handler(req("GET", "/v1/sites/" + view.id + "/result"));
    assert.equal(r.statusCode, 409);

    const site = buildSiteV1({ openintent: OI, frame: FRAME, features: FEATURES });
    await jobs.saveSite(view.id, site);
    await jobs.updateJob(view.id, { state: "done", stage: "Site ready", siteStats: site.stats, siteBytes: 10 });
    st = await api.handler(req("GET", "/v1/sites/" + view.id));
    const done = JSON.parse(st.body);
    assert.equal(done.status, "succeeded");
    assert.equal(done.statsPreview.buildings, 2);
    r = await api.handler(req("GET", "/v1/sites/" + view.id + "/result", { query: { collections: "buildings,trees" } }));
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.buildings.features.length, 2);
    assert.equal(body.trees.features.length, 1);
    assert.equal(body.poles, undefined);
  });

  it("returns the site inline when wait is set and the job finishes", async () => {
    api.setApiDepsForTests({
      fetch: async (url, init) => {
        const payload = JSON.parse(init.body);
        const site = buildSiteV1({ openintent: OI, frame: FRAME, features: FEATURES });
        await jobs.saveSite(payload.jobId, site);
        await jobs.updateJob(payload.jobId, { state: "done", siteStats: site.stats });
        return { status: 202 };
      },
    });
    const res = await api.handler(req("POST", "/v1/sites", { body: { geometry: POLY }, query: { wait: "10" } }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, "succeeded");
    assert.equal(JSON.parse(res.body).buildings.features.length, 2);
  });

  it("does not expose web export jobs", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    await jobs.createJob(id);
    const res = await api.handler(req("GET", "/v1/sites/" + id));
    assert.equal(res.statusCode, 404);
  });

  it("rate limits job creation per key", async () => {
    const limit = api.RATE_LIMITS.create.limit;
    const key = "rl/" + api.hashKey(KEY).slice(0, 16) + "/create/" + Math.floor(Date.now() / api.RATE_LIMITS.create.windowMs);
    await apiStore.setJSON(key, { n: limit });
    const res = await api.handler(req("POST", "/v1/sites", { body: { geometry: POLY } }));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["x-ratelimit-remaining"], "0");
    assert.ok(+res.headers["retry-after"] >= 1);
  });

  it("stores a site-v1 export result instead of a zip", async () => {
    const clutter = require("../netlify/functions/clutter");
    const real = clutter.runBackgroundExport;
    const site = buildSiteV1({ openintent: OI, frame: FRAME, features: FEATURES, warnings: ["note"] });
    clutter.runBackgroundExport = async () => ({ statusCode: 200, body: JSON.stringify({ ok: true, site }) });
    try {
      const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await jobs.createJob(id);
      const out = await completeExportJob(id, { httpMethod: "POST", headers: {}, body: "{}" });
      assert.equal(out.finished, true);
      const job = await jobs.readJob(id);
      assert.equal(job.state, "done");
      assert.equal(job.siteStats.buildings, 2);
      assert.ok(job.siteBytes > 100);
      assert.equal(jobStore.map.has("job/" + id + "/zip"), false);
      const back = await jobs.readSite(id);
      assert.equal(back.buildings.features.length, 2);
    } finally {
      clutter.runBackgroundExport = real;
    }
  });
});
