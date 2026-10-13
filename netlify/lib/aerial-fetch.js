"use strict";

/**
 * Background aerial fetch.
 *
 * One Esri export of a plate near 10 MP can sit until a 90s deadline and
 * still return nothing. A second step that rounds to the same pixel size
 * used to spend that wait again. This module races the distinct sizes
 * together, splits a large plate into parallel tiles, and stops at
 * AERIAL_STAGE_BUDGET_MS with the sharpest JPEG that arrived.
 */

const { esriContentExtent, jpegSize, resizeRgba } = require("./geo-frame");

const AERIAL_STAGE_BUDGET_MS = 36000;
const AERIAL_TILE_MIN_SIDE = 2800;
const AERIAL_TILE_LONG_SIDE = 1280;
const AERIAL_TILE_POOL = 6;
const STITCH_GRACE_MS = 4000;

let budgetOverride = 0;

function setAerialBudgetForTests(ms) {
  const n = +ms;
  budgetOverride = n > 0 ? n : 0;
}

function aerialBudgetMs() {
  return budgetOverride > 0 ? budgetOverride : AERIAL_STAGE_BUDGET_MS;
}

function shouldTilePlate(plate) {
  if (!plate || !(plate.imgW > 0) || !(plate.imgH > 0)) return false;
  return Math.max(plate.imgW, plate.imgH) >= AERIAL_TILE_MIN_SIDE;
}

/** A 1 px cap rounding is the same Esri plate. Do not fetch it twice. */
function sameExportPlate(a, b) {
  if (!a || !b || !(a.imgW > 0) || !(b.imgW > 0) || !(a.imgH > 0) || !(b.imgH > 0)) return false;
  if (a.imgW === b.imgW && a.imgH === b.imgH) return true;
  if (Math.abs(a.imgW - b.imgW) <= 4 && Math.abs(a.imgH - b.imgH) <= 4) return true;
  const pa = a.imgW * a.imgH;
  const pb = b.imgW * b.imgH;
  return Math.abs(pa - pb) / Math.max(pa, pb) <= 0.02;
}

function tilePlan(plate) {
  if (!shouldTilePlate(plate)) return null;
  const extent = esriContentExtent(plate, plate.imgW, plate.imgH);
  const cols = Math.max(1, Math.ceil(plate.imgW / AERIAL_TILE_LONG_SIDE));
  const rows = Math.max(1, Math.ceil(plate.imgH / AERIAL_TILE_LONG_SIDE));
  if (cols * rows < 2) return null;
  const lonSpan = extent.east - extent.west;
  const latSpan = extent.north - extent.south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round((r * plate.imgH) / rows);
    const y1 = Math.round(((r + 1) * plate.imgH) / rows);
    const north = extent.north - (y0 / plate.imgH) * latSpan;
    const south = extent.north - (y1 / plate.imgH) * latSpan;
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round((c * plate.imgW) / cols);
      const x1 = Math.round(((c + 1) * plate.imgW) / cols);
      const west = extent.west + (x0 / plate.imgW) * lonSpan;
      const east = extent.west + (x1 / plate.imgW) * lonSpan;
      const imgW = x1 - x0;
      const imgH = y1 - y0;
      if (!(imgW > 1) || !(imgH > 1) || !(east > west) || !(north > south)) return null;
      tiles.push({ x: x0, y: y0, imgW, imgH, west, south, east, north });
    }
  }
  return { imgW: plate.imgW, imgH: plate.imgH, tiles };
}

function frameFromTile(tile) {
  return {
    west: tile.west,
    south: tile.south,
    east: tile.east,
    north: tile.north,
    imgW: tile.imgW,
    imgH: tile.imgH,
  };
}

function blitTile(dst, dstW, src, sw, sh, x, y) {
  for (let row = 0; row < sh; row++) {
    const srcStart = row * sw * 4;
    const dstStart = ((y + row) * dstW + x) * 4;
    dst.set(src.subarray(srcStart, srcStart + sw * 4), dstStart);
  }
}

function stitchTiles(plate, tiles, buffers) {
  const jpeg = require("jpeg-js");
  const rgba = new Uint8Array(plate.imgW * plate.imgH * 4);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    let decoded;
    try {
      decoded = jpeg.decode(buffers[i], {
        useTArray: true,
        maxResolutionInMP: 24,
        formatAsRGBA: true,
      });
    } catch {
      throw new Error("tile jpeg");
    }
    if (!decoded || !decoded.data || !(decoded.width > 1) || !(decoded.height > 1)) {
      throw new Error("tile jpeg");
    }
    let src = decoded.data;
    let sw = decoded.width;
    let sh = decoded.height;
    if (sw !== tile.imgW || sh !== tile.imgH) {
      if (Math.abs(sw - tile.imgW) > 16 || Math.abs(sh - tile.imgH) > 16) {
        throw new Error("tile size");
      }
      src = resizeRgba(src, sw, sh, tile.imgW, tile.imgH);
      sw = tile.imgW;
      sh = tile.imgH;
    }
    blitTile(rgba, plate.imgW, src, sw, sh, tile.x, tile.y);
  }
  const enc = jpeg.encode({ data: rgba, width: plate.imgW, height: plate.imgH }, 82);
  const buf = Buffer.from(enc.data);
  const sized = jpegSize(buf);
  if (!sized || sized.width !== plate.imgW || sized.height !== plate.imgH) {
    throw new Error("stitched jpeg");
  }
  return buf;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = null;
  async function worker() {
    while (!failed && cursor < items.length) {
      const i = cursor;
      cursor += 1;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = err || new Error("tile failed");
        throw failed;
      }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function fetchTiled(plate, opts) {
  const plan = tilePlan(plate);
  if (!plan) {
    const buf = await opts.fetchImage(plate, opts.signal);
    if (opts.onUnit) opts.onUnit();
    return buf;
  }
  const buffers = await mapPool(plan.tiles, AERIAL_TILE_POOL, async (tile) => {
    if (opts.signal && opts.signal.aborted) throw new Error("aborted");
    const buf = await opts.fetchImage(frameFromTile(tile), opts.signal);
    if (opts.onUnit) opts.onUnit();
    return buf;
  });
  if (opts.signal && opts.signal.aborted) throw new Error("aborted");
  if (opts.onStitch) opts.onStitch(true);
  return stitchTiles(plate, plan.tiles, buffers);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * entries are sharpest first. opts.fetchImage(frame, signal) returns a JPEG.
 * The finest plate wins when it arrives inside the budget. Otherwise the
 * sharpest JPEG already in hand is the one returned.
 */
async function racePlates(entries, opts) {
  const list = entries || [];
  const budgetMs = opts && opts.budgetMs > 0 ? opts.budgetMs : aerialBudgetMs();
  const started = Date.now();
  const ctrl = new AbortController();
  let stitching = false;
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  if (typeof timer.unref === "function") timer.unref();

  const unitCounts = list.map((entry) => {
    if (entry && entry.tile) {
      const plan = tilePlan(entry.plate);
      if (plan) return plan.tiles.length;
    }
    return 1;
  });
  const unitTotal = unitCounts.reduce((sum, n) => sum + n, 0);
  if (opts && opts.onUnits) opts.onUnits(unitTotal);

  const results = new Array(list.length);
  const errors = new Array(list.length);
  let settled = 0;
  let wake = function () {};
  function notify() {
    const fn = wake;
    wake = function () {};
    fn();
  }
  function waitChange(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, ms));
      wake = function () {
        clearTimeout(t);
        resolve();
      };
    });
  }

  function bestIndex() {
    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].length > 100) return i;
    }
    return -1;
  }

  const jobs = list.map((entry, i) => {
    const run =
      entry && entry.tile
        ? fetchTiled(entry.plate, {
            fetchImage: opts.fetchImage,
            signal: ctrl.signal,
            onUnit: function () {
              if (opts.onUnit) opts.onUnit();
            },
            onStitch: function () {
              stitching = true;
              notify();
            },
          })
        : Promise.resolve()
            .then(() => opts.fetchImage(entry.plate, ctrl.signal))
            .then((buf) => {
              if (opts.onUnit) opts.onUnit();
              return buf;
            });
    return run
      .then((buf) => {
        results[i] = buf;
      })
      .catch((err) => {
        errors[i] = err || new Error("aerial imagery failed");
      })
      .finally(() => {
        settled += 1;
        notify();
      });
  });
  for (let i = 0; i < jobs.length; i++) jobs[i].catch(() => {});

  try {
    while (Date.now() - started < budgetMs) {
      if (results[0]) break;
      if (errors[0] && bestIndex() >= 0) break;
      if (settled >= list.length) break;
      const left = budgetMs - (Date.now() - started);
      if (!(left > 0)) break;
      await waitChange(left);
    }
    if (!results[0] && !errors[0] && stitching) {
      const grace = Math.min(STITCH_GRACE_MS, Math.max(0, budgetMs + STITCH_GRACE_MS - (Date.now() - started)));
      const until = Date.now() + grace;
      while (!results[0] && !errors[0] && Date.now() < until) {
        await waitChange(until - Date.now());
      }
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }

  const idx = bestIndex();
  if (idx < 0) {
    const err = errors.find(Boolean);
    if (err) throw err;
    throw Object.assign(new Error("The operation was aborted due to timeout"), { source: "imagery" });
  }
  return { buf: results[idx], index: idx, stepped: idx > 0 };
}

module.exports = {
  AERIAL_STAGE_BUDGET_MS,
  AERIAL_TILE_MIN_SIDE,
  AERIAL_TILE_LONG_SIDE,
  setAerialBudgetForTests,
  aerialBudgetMs,
  shouldTilePlate,
  sameExportPlate,
  tilePlan,
  stitchTiles,
  racePlates,
};
