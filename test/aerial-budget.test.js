"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jpeg = require("jpeg-js");
const jobs = require("../netlify/lib/export-jobs");
const { exportPercent } = require("../netlify/lib/export-progress");
const { handler: statusHandler } = require("../netlify/functions/export-status");
const { geoFrame, capEsriExportFrame } = require("../netlify/lib/geo-frame");
const {
  AERIAL_STAGE_BUDGET_MS,
  sameExportPlate,
  tilePlan,
  stitchTiles,
  racePlates,
} = require("../netlify/lib/aerial-fetch");
const {
  runBackgroundExport,
  setAerialBudgetForTests,
  setFetchOvertureForTests,
  setFetchTerrainDemForTests,
  setFetchChmGridForTests,
  setFetchWorldCoverForTests,
} = require("../netlify/functions/clutter");

const LEBANON = { west: -86.4904, south: 40.028, east: -86.48512, north: 40.03327 };

function solidJpeg(w, h, rgb) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

function memoryStore() {
  const map = new Map();
  return {
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function tallBox() {
  const mpdLon = 111320 * Math.cos((40 * Math.PI) / 180);
  return {
    west: -90,
    south: 40,
    east: -90 + 450 / mpdLon,
    north: 40 + 580 / 110540,
    name: "Tall plate",
  };
}

function sideOf(url) {
  const match = /size=(\d+),(\d+)/.exec(String(url));
  if (!match) return 0;
  return Math.max(+match[1], +match[2]);
}

describe("aerial budget", () => {
  const prev = global.fetch;

  afterEach(() => {
    global.fetch = prev;
    setAerialBudgetForTests(0);
    setFetchOvertureForTests(null);
    setFetchTerrainDemForTests(null);
    setFetchChmGridForTests(null);
    setFetchWorldCoverForTests(null);
    jobs.setExportStoreForTests(null);
  });

  it("keeps the stage budget between 30 and 40 seconds", () => {
    assert.ok(AERIAL_STAGE_BUDGET_MS >= 30000 && AERIAL_STAGE_BUDGET_MS <= 40000);
  });

  it("treats a one-pixel cap rounding as the same plate", () => {
    assert.equal(sameExportPlate({ imgW: 2779, imgH: 3597 }, { imgW: 2779, imgH: 3598 }), true);
    assert.equal(sameExportPlate({ imgW: 3196, imgH: 3128 }, { imgW: 3196, imgH: 3128 }), true);
    assert.equal(sameExportPlate({ imgW: 2779, imgH: 3597 }, { imgW: 1800, imgH: 2330 }), false);
  });

  it("splits a Lebanon-sized plate into tiles that cover it exactly", () => {
    const raw = geoFrame(LEBANON, { maxSide: 8192, metersPerPx: 0.075 });
    const plate = capEsriExportFrame(raw);
    const plan = tilePlan(plate);
    assert.ok(plan.tiles.length >= 4, String(plan && plan.tiles.length));
    let area = 0;
    for (let i = 0; i < plan.tiles.length; i++) {
      const tile = plan.tiles[i];
      area += tile.imgW * tile.imgH;
      const deg = (tile.east - tile.west) / (tile.north - tile.south);
      const pix = tile.imgW / tile.imgH;
      assert.ok(Math.abs(deg - pix) / pix < 1e-6, deg + " vs " + pix);
      assert.ok(tile.x >= 0 && tile.y >= 0);
      assert.ok(tile.x + tile.imgW <= plate.imgW);
      assert.ok(tile.y + tile.imgH <= plate.imgH);
    }
    assert.equal(area, plate.imgW * plate.imgH);
  });

  it("stitches tile JPEGs back to the plate size", async () => {
    const tiles = [
      { x: 0, y: 0, imgW: 8, imgH: 8 },
      { x: 8, y: 0, imgW: 8, imgH: 8 },
    ];
    const buf = await stitchTiles({ imgW: 16, imgH: 8 }, tiles, [
      solidJpeg(8, 8, [220, 10, 10]),
      solidJpeg(8, 8, [10, 10, 220]),
    ]);
    const dec = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 2 });
    assert.equal(dec.width, 16);
    assert.equal(dec.height, 8);
    assert.ok(dec.data[0] > 180, String(dec.data[0]));
    assert.ok(dec.data[8 * 4 + 2] > 180, String(dec.data[8 * 4 + 2]));
  });

  it("returns the sharp plate when it arrives inside the budget", async () => {
    const fine = solidJpeg(16, 16, [20, 140, 20]);
    const coarse = solidJpeg(8, 8, [20, 20, 140]);
    const t0 = Date.now();
    const got = await racePlates(
      [
        { plate: { imgW: 16, imgH: 16 }, tile: false },
        { plate: { imgW: 8, imgH: 8 }, tile: false },
      ],
      {
        budgetMs: 2000,
        fetchImage: async (frame) => {
          if (frame.imgW === 16) await new Promise((resolve) => setTimeout(resolve, 40));
          return frame.imgW === 16 ? fine : coarse;
        },
      }
    );
    assert.equal(got.index, 0);
    assert.equal(got.stepped, false);
    assert.equal(got.buf.length, fine.length);
    assert.ok(Date.now() - t0 < 1000, String(Date.now() - t0));
  });

  it("stops at the budget and keeps the plate that already arrived", async () => {
    const coarse = solidJpeg(8, 8, [20, 20, 140]);
    const marks = [];
    const budgetMs = 350;
    const t0 = Date.now();
    const got = await racePlates(
      [
        { plate: { imgW: 64, imgH: 64 }, tile: false },
        { plate: { imgW: 8, imgH: 8 }, tile: false },
      ],
      {
        budgetMs,
        onUnits: (total) => marks.push(total),
        onUnit: () => marks.push("unit"),
        fetchImage: (frame, signal) => {
          if (frame.imgW === 64) {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(coarse), 60000);
              const abort = () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              };
              if (signal) signal.addEventListener("abort", abort, { once: true });
            });
          }
          return Promise.resolve(coarse);
        },
      }
    );
    const elapsed = Date.now() - t0;
    assert.equal(got.stepped, true);
    assert.equal(got.index, 1);
    assert.ok(elapsed >= budgetMs - 40, "elapsed " + elapsed);
    assert.ok(elapsed < 2000, "elapsed " + elapsed);
    assert.ok(marks[0] >= 2);
    assert.ok(marks.indexOf("unit") > 0);
  });

  it("moves the percent during aerial and still saves 100 for the zip", () => {
    assert.equal(exportPercent({ stage: "Fetching aerial", state: "running" }, 0), 0);
    const elapsed = exportPercent(
      { stage: "Fetching aerial", state: "running", aerialElapsedMs: 8000, aerialBudgetMs: 36000 },
      0
    );
    assert.ok(elapsed >= 1 && elapsed < 4, String(elapsed));
    const tiles = exportPercent(
      { stage: "Fetching aerial", state: "running", tilesDone: 2, tilesTotal: 6 },
      0
    );
    assert.ok(tiles >= 1 && tiles < 100, String(tiles));
    assert.ok(tiles >= elapsed || tiles >= 1);
    assert.equal(exportPercent({ stage: "Trees", state: "running", tilesDone: 3, tilesTotal: 10 }, 0), 43);
    assert.equal(exportPercent({ stage: "Zip ready", state: "running" }, 0), 99);
    assert.equal(exportPercent({ stage: "Zip ready", state: "done" }, 0), 100);
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    assert.match(app, /aerialElapsedMs/);
    assert.equal(app.includes("\u2014"), false);
  });

  it("drops aerial tile counts when the stage moves on to trees", async () => {
    jobs.setExportStoreForTests(memoryStore());
    const id = "55555555-5555-4555-8555-555555555555";
    await jobs.createJob(id);
    await jobs.updateJob(id, { state: "running" });
    const beat = await jobs.writeHeartbeat(id, "Fetching aerial", { tilesDone: 3, tilesTotal: 6 });
    assert.equal(beat.tilesDone, 3);
    assert.equal(beat.tilesTotal, 6);
    assert.equal(beat.heartbeatStage, "Fetching aerial");
    const trees = await jobs.writeHeartbeat(id, "Trees", { tilesDone: 1, tilesTotal: 8 });
    assert.equal(trees.stage, "Trees");
    assert.equal(trees.tilesDone, 1);
    assert.equal(trees.tilesTotal, 8);
    const pct = exportPercent(trees, 0);
    assert.ok(pct >= 20 && pct < 98, String(pct));
  });

  it("bounds a background aerial fetch by the budget and moves progress", async () => {
    setAerialBudgetForTests(1600);
    setFetchOvertureForTests(async () => ({ features: [] }));
    setFetchTerrainDemForTests(async () => null);
    setFetchChmGridForTests(async () => null);
    setFetchWorldCoverForTests(async () => null);
    const jpegBuf = solidJpeg(32, 24, [80, 90, 70]);
    const patches = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        const side = sideOf(u);
        if (side > 2000) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 60000);
            const signal = init && init.signal;
            const abort = () => {
              clearTimeout(timer);
              const err = new Error("The operation was aborted due to timeout");
              err.name = "AbortError";
              reject(err);
            };
            if (signal) {
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            }
          });
        }
        return { ok: true, arrayBuffer: async () => jpegBuf };
      }
      return { ok: true, json: async () => ({ features: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const t0 = Date.now();
    const res = await runBackgroundExport(
      {
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          ...tallBox(),
          includeFoliage: false,
          includeTerrain: false,
          includeRvs: false,
          includeCars: false,
          format: "bundle",
        }),
      },
      (patch) => {
        if (patch) patches.push(patch);
      }
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    assert.ok(elapsed < 4000, "elapsed " + elapsed);
    const body = JSON.parse(res.body);
    const note = (body.warnings || []).find((line) => /^Map stepped down/.test(String(line))) || "";
    assert.match(note, /Map stepped down to \d+ px from \d+ px\./);
    const aerial = patches.filter((patch) => patch.stage === "Fetching aerial" && patch.tilesTotal > 0);
    assert.ok(aerial.length >= 1, JSON.stringify(patches.slice(0, 6)));
    assert.ok(aerial.some((patch) => patch.tilesDone > 0));
    const moving = exportPercent(
      { stage: "Fetching aerial", state: "running", tilesDone: 1, tilesTotal: aerial[0].tilesTotal },
      0
    );
    assert.ok(moving >= 1 && moving < 100, String(moving));
  });

  it("counts decode and stitch in the budget and moves status during Fetching aerial", async () => {
    const tiles = [];
    const bufs = [];
    for (let i = 0; i < 6; i++) {
      tiles.push({ x: i * 8, y: 0, imgW: 8, imgH: 8 });
      bufs.push(solidJpeg(8, 8, [20, 140, 20]));
    }
    const t0 = Date.now();
    let paces = 0;
    await assert.rejects(
      () =>
        stitchTiles({ imgW: 48, imgH: 8 }, tiles, bufs, {
          deadlineAt: t0 + 100,
          pace: async () => {
            paces += 1;
            await new Promise((resolve) => setTimeout(resolve, 80));
          },
        }),
      (err) => err && err.name === "AbortError"
    );
    const stitchElapsed = Date.now() - t0;
    assert.ok(paces > 0 && paces < 6, "paces " + paces);
    assert.ok(stitchElapsed < 500, "stitch elapsed " + stitchElapsed);

    const big = {
      west: -86.49,
      south: 40.02,
      east: -86.48,
      north: 40.03,
      imgW: 3000,
      imgH: 2000,
    };
    const small = { west: big.west, south: big.south, east: big.east, north: big.north, imgW: 40, imgH: 30 };
    assert.ok(tilePlan(big).tiles.length >= 4);
    const budgetMs = 280;
    const raced = Date.now();
    const got = await racePlates(
      [
        { plate: big, tile: true },
        { plate: small, tile: false },
      ],
      {
        budgetMs,
        fetchImage: (frame, signal) => {
          if (frame.imgW > 200) {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(solidJpeg(8, 8, [1, 1, 1])), 60000);
              const abort = () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              };
              if (signal) {
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
              }
            });
          }
          return Promise.resolve(solidJpeg(frame.imgW, frame.imgH, [10, 10, 200]));
        },
      }
    );
    const raceElapsed = Date.now() - raced;
    assert.equal(got.stepped, true);
    assert.equal(got.index, 1);
    assert.ok(raceElapsed < budgetMs + 500, "race elapsed " + raceElapsed);

    jobs.setExportStoreForTests(memoryStore());
    const id = "12121212-1212-4212-8212-121212121212";
    await jobs.createJob(id);
    await jobs.updateJob(id, {
      state: "running",
      stage: "Fetching aerial",
      createdAt: Date.now() - 8000,
      aerialStartedAt: Date.now() - 8000,
    });
    const res = await statusHandler({ httpMethod: "GET", queryStringParameters: { job: id } });
    const body = JSON.parse(res.body);
    assert.equal(body.stage, "Fetching aerial");
    assert.equal(body.stageLabel, "Fetching aerial");
    assert.notEqual(body.stageLabel, "Fetching map");
    assert.ok(body.progress > 0, "progress " + body.progress);
    assert.ok(body.percent >= 1 && body.percent < 100, "percent " + body.percent);
    assert.equal(body.state === "done" ? body.percent : body.percent < 100, true);
    const beat = await jobs.writeHeartbeat(id, "Fetching aerial", { tilesDone: 3, tilesTotal: 8 });
    assert.equal(beat.heartbeatStage, "Fetching aerial");
    assert.ok(beat.aerialElapsedMs > 0);
    const moved = await statusHandler({ httpMethod: "GET", queryStringParameters: { job: id } });
    const movedBody = JSON.parse(moved.body);
    assert.equal(movedBody.stageLabel, "Fetching aerial");
    assert.ok(movedBody.percent >= 1 && movedBody.percent < 100, "tiles percent " + movedBody.percent);
    assert.equal(exportPercent({ stage: "Zip ready", state: "done" }, 0), 100);
    assert.ok(exportPercent({ stage: "Fetching aerial", state: "running", aerialElapsedMs: 8000 }, 0) >= 1);
  });
});

describe("aerial race, resilient wait for a sharper plate", () => {
  const jpeg = require("jpeg-js");
  function jpg(w, h) {
    const data = Buffer.alloc(w * h * 4, 120);
    return Buffer.from(jpeg.encode({ data, width: w, height: h }, 80).data);
  }
  it("keeps the sharper plate that arrives after a coarser one", async () => {
    const got = await racePlates(
      [
        { plate: { imgW: 64, imgH: 64 }, tile: false },
        { plate: { imgW: 32, imgH: 32 }, tile: false },
        { plate: { imgW: 8, imgH: 8 }, tile: false },
      ],
      {
        budgetMs: 3000,
        sharperGraceMs: 1500,
        fetchImage: async (frame) => {
          if (frame.imgW === 64) throw new Error("Error: bytes");
          if (frame.imgW === 32) await new Promise((r) => setTimeout(r, 120));
          return jpg(frame.imgW, frame.imgH);
        },
      }
    );
    assert.equal(got.index, 1);
  });
  it("earlier behaviour without the grace keeps the first plate in hand", async () => {
    const got = await racePlates(
      [
        { plate: { imgW: 64, imgH: 64 }, tile: false },
        { plate: { imgW: 32, imgH: 32 }, tile: false },
        { plate: { imgW: 8, imgH: 8 }, tile: false },
      ],
      {
        budgetMs: 3000,
        fetchImage: async (frame) => {
          if (frame.imgW === 64) throw new Error("Error: bytes");
          if (frame.imgW === 32) await new Promise((r) => setTimeout(r, 120));
          return jpg(frame.imgW, frame.imgH);
        },
      }
    );
    assert.equal(got.index, 2);
  });
  it("stops waiting at the grace when the sharper plate hangs", async () => {
    const t0 = Date.now();
    const got = await racePlates(
      [
        { plate: { imgW: 64, imgH: 64 }, tile: false },
        { plate: { imgW: 32, imgH: 32 }, tile: false },
        { plate: { imgW: 8, imgH: 8 }, tile: false },
      ],
      {
        budgetMs: 5000,
        sharperGraceMs: 300,
        fetchImage: (frame, signal) => {
          if (frame.imgW === 64) return Promise.reject(new Error("Error: bytes"));
          if (frame.imgW === 32) {
            return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          }
          return Promise.resolve(jpg(8, 8));
        },
      }
    );
    assert.equal(got.index, 2);
    assert.ok(Date.now() - t0 < 2000, String(Date.now() - t0));
  });
  it("tiles a 2000 px plate only when asked", () => {
    const { tilePlan, AERIAL_TILE_MIN_SIDE_RESILIENT } = require("../netlify/lib/aerial-fetch");
    const plate = { west: -115.164, south: 36.1195, east: -115.1605, north: 36.1225, imgW: 2098, imgH: 2211 };
    assert.equal(tilePlan(plate), null);
    const plan = tilePlan(plate, AERIAL_TILE_MIN_SIDE_RESILIENT);
    assert.ok(plan && plan.tiles.length === 4, JSON.stringify(plan && plan.tiles.length));
  });
});
