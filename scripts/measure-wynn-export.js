"use strict";

/**
 * Time one Wynn golf export. Cache stays off unless OPENCLUTTER_AREA_CACHE=1,
 * which also keeps a memory blob store for the process.
 *
 *   node scripts/measure-wynn-export.js baseline
 *   node scripts/measure-wynn-export.js cached
 */

const fs = require("node:fs");
const area = require("../public/bbox-area");
const cache = require("../netlify/lib/area-cache");
const jobs = require("../netlify/lib/export-jobs");
const { runBackgroundExport } = require("../netlify/functions/clutter");

const WYNN = {
  west: -115.16942,
  south: 36.11944163,
  east: -115.153863,
  north: 36.13182737,
  name: "Wynn Golf",
};

const OVERLAP = {
  west: -115.16142,
  south: 36.11944163,
  east: -115.145863,
  north: 36.13182737,
  name: "Wynn Golf overlap",
};

function memoryStore() {
  const map = new Map();
  return {
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async set(key, value) {
      map.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value));
    },
    async get(key, opts) {
      if (!map.has(key)) return null;
      const value = map.get(key);
      if (opts && opts.type === "arrayBuffer") {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      return value;
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function eventFor(box) {
  return {
    httpMethod: "POST",
    headers: { host: "dev--openclutter.netlify.app" },
    path: "/.netlify/functions/clutter-export-background",
    body: JSON.stringify({
      ...box,
      includeFoliage: true,
      includeWater: false,
      includeParking: true,
      includeWalls: true,
      includePoles: true,
      includeRvs: true,
      includeTerrain: true,
      deferTerrain: false,
      terrainResolution: "auto",
      terrainStyle: "sloped",
      imageryQuality: "auto",
      lidar: false,
      mapNotes: true,
      trees: [],
      treesSource: null,
      format: "bundle",
      async: false,
    }),
  };
}

async function runOne(box, label) {
  const id = "11111111-1111-4111-8111-111111111111";
  const store = jobsStore;
  await jobs.createJob(id);
  const started = Date.now();
  const res = await runBackgroundExport(eventFor(box), (patch) => jobs.updateJob(id, patch));
  const elapsed = Date.now() - started;
  let data = {};
  try {
    data = JSON.parse(res.body || "{}");
  } catch {
    data = { error: String(res.body || "").slice(0, 400) };
  }
  const job = await jobs.readJob(id);
  const timings = data.timings || (job && job.timings) || null;
  const out = {
    label,
    status: res.statusCode,
    elapsedMs: elapsed,
    error: data.error || null,
    areaM2: timings && timings.areaM2,
    buildings: data.stats && data.stats.buildings,
    trees: data.stats && data.stats.trees,
    cached: timings && timings.cached,
    timings,
    warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 12) : [],
  };
  process.stderr.write(label + " " + res.statusCode + " " + elapsed + "ms\n");
  return out;
}

const mode = process.argv[2] || "baseline";
const sides = area.bboxSidesM(WYNN);
const areaM2 = Math.round(sides.widthM * sides.lengthM);
process.stderr.write("wynn area " + areaM2 + " m2 " + sides.widthM.toFixed(1) + " x " + sides.lengthM.toFixed(1) + "\n");

const jobsStore = memoryStore();
jobs.setExportStoreForTests(jobsStore);

(async () => {
  if (mode === "baseline") {
    process.env.OPENCLUTTER_AREA_CACHE = "0";
    cache.disable();
    const row = await runOne(WYNN, "baseline");
    const payload = { version: require("../package.json").version, areaM2, row };
    fs.writeFileSync("/tmp/wynn-baseline.json", JSON.stringify(payload, null, 2));
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.env.OPENCLUTTER_AREA_CACHE = "1";
  const blob = memoryStore();
  cache.enable(blob);
  const cold = await runOne(WYNN, "cold");
  const warm = await runOne(WYNN, "warm");
  const overlap = await runOne(OVERLAP, "overlap");
  const payload = {
    version: require("../package.json").version,
    areaM2,
    concurrency: cache.FETCH_CONCURRENCY,
    backgroundFunctions: cache.MAX_BACKGROUND_FUNCTIONS,
    ttl: cache.SOURCE_TTL_MS,
    cold,
    warm,
    overlap,
  };
  fs.writeFileSync("/tmp/wynn-cached.json", JSON.stringify(payload, null, 2));
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
