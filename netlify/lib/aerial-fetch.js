"use strict";

/**
 * Background aerial fetch.
 *
 * One Esri export of a plate near 10 MP can sit until a 90s deadline and
 * still return nothing. A second step that rounds to the same pixel size
 * used to spend that wait again. This module races the distinct sizes
 * together, splits a large plate into parallel tiles, and stops at
 * AERIAL_STAGE_BUDGET_MS. A shared cap limits how many Esri exports
 * run at once across those plates, with slots going to the sharpest
 * tiled plate first so a mid plate cannot cut in before the sharp
 * plate has queued all of its tiles. Once a coarser plate is already
 * in hand, those slots all go to the sharper plate. A transient tile
 * failure is retried with a short backoff, and a successful JPEG is
 * kept briefly so a retry or a repeated frame does not hit the network
 * again. Download, tile decode, and stitch all sit inside that budget.
 * When it expires, the sharpest JPEG already in hand is the one kept,
 * except a sharper tiled plate that is nearly done gets a short wait
 * that stays at or under 40 s in all.
 */

const { esriContentExtent, jpegSize, resizeRgba } = require("./geo-frame");

const AERIAL_STAGE_BUDGET_MS = 36000;
const AERIAL_TILE_MIN_SIDE = 2800;
const AERIAL_TILE_LONG_SIDE = 1280;
const AERIAL_TILE_POOL = 6;
/** Shared cap across every plate in a race, so a resilient 4-plate
 * site cannot open a dozen Esri exports at once. */
const AERIAL_FETCH_CONCURRENCY = 4;
/** When a coarser tiled plate is waiting, leave this many of the
 * cap's slots for it so a hanging sharp plate cannot starve the fallback. */
const AERIAL_FETCH_RESERVE_COARSER = 1;
/** First try plus this many retries on a transient tile error. */
const AERIAL_TILE_ATTEMPTS = 3;
const AERIAL_TILE_RETRY_MS = 250;
const AERIAL_TILE_CACHE_TTL_MS = 10 * 60 * 1000;
const AERIAL_TILE_CACHE_MAX_BYTES = 48 * 1024 * 1024;
/**
 * Resilient mode tiles every plate from this long side. A single 2211 px
 * request on a 330 m Las Vegas draw sat past 40 s; the same plate as four
 * tiles returned in 11 s.
 */
const AERIAL_TILE_MIN_SIDE_RESILIENT = 2000;
/**
 * Resilient mode: after the first plate fails, a coarser plate in hand
 * waits this long for a sharper plate still on the wire. The 0.075 m
 * plate of a small draw fails in under a second (Esri "Error: bytes"),
 * and the 663 px fallback used to win the race against the 1326 px and
 * 2211 px plates by a few hundred milliseconds.
 */
const AERIAL_SHARPER_GRACE_MS = 20000;
/**
 * When the budget expires with no JPEG in hand, wait this long for a
 * late first plate before aborting. A plate already in hand still
 * stops at the budget. Official canopy flakes (florida-resort,
 * pnw-conifer) timed out with no plate kept.
 */
const AERIAL_EMPTY_GRACE_MS = 12000;
/**
 * When a coarser plate is already in hand and a sharper tiled plate is
 * nearly done (stitching, or at most two tiles left, or at least three
 * quarters of its tiles), wait this long past the ordinary budget for
 * it to finish. The stage budget stays at 36 s; together they stay at
 * or under 40 s. A hanging sharp plate that is not nearly done still
 * stops at the ordinary budget.
 */
const AERIAL_NEAR_DONE_GRACE_MS = 4000;

let budgetOverride = 0;

function setAerialBudgetForTests(ms) {
  const n = +ms;
  budgetOverride = n > 0 ? n : 0;
}

function aerialBudgetMs() {
  return budgetOverride > 0 ? budgetOverride : AERIAL_STAGE_BUDGET_MS;
}

function shouldTilePlate(plate, minSide) {
  if (!plate || !(plate.imgW > 0) || !(plate.imgH > 0)) return false;
  return Math.max(plate.imgW, plate.imgH) >= (minSide > 0 ? minSide : AERIAL_TILE_MIN_SIDE);
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

function tilePlan(plate, minSide) {
  if (!shouldTilePlate(plate, minSide)) return null;
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

function stitchExpired(opts) {
  if (!opts) return false;
  if (opts.signal && opts.signal.aborted) return true;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  return !!(opts.deadlineAt && now() > opts.deadlineAt);
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

async function stitchTiles(plate, tiles, buffers, opts) {
  const jpeg = require("jpeg-js");
  if (stitchExpired(opts)) throw abortError();
  const rgba = new Uint8Array(plate.imgW * plate.imgH * 4);
  for (let i = 0; i < tiles.length; i++) {
    if (opts && typeof opts.pace === "function") await opts.pace(i);
    if (stitchExpired(opts)) throw abortError();
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
    await Promise.resolve();
  }
  if (stitchExpired(opts)) throw abortError();
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
  const plan = tilePlan(plate, opts.tileMinSide);
  if (!plan) {
    const buf = await opts.fetchImage(plate, opts.signal);
    if (opts.onUnit) opts.onUnit();
    return buf;
  }
  // Queue every tile for a slot up front. The old per-plate pool of 6
  // only submitted that many jobs, so a 9-tile sharp plate lost tiles
  // 7-9 to a mid plate already sitting in the FIFO queue. The shared
  // cap, not the pool, now limits how many Esri exports run.
  const tiled = Promise.all(plan.tiles.map(async (tile) => {
    if (opts.signal && opts.signal.aborted) throw abortError();
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) throw abortError();
    const buf = await opts.fetchImage(frameFromTile(tile), opts.signal);
    if (opts.onUnit) opts.onUnit();
    return buf;
  }));
  tiled.catch(() => {});
  let buffers;
  if (opts.deadlineAt) {
    const left = opts.deadlineAt - Date.now();
    let timer;
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => reject(abortError()), Math.max(0, left));
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    try {
      buffers = await Promise.race([tiled, stop]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    buffers = await tiled;
  }
  if (opts.signal && opts.signal.aborted) throw abortError();
  if (opts.deadlineAt && Date.now() > opts.deadlineAt) throw abortError();
  if (opts.onStitch) opts.onStitch(true);
  return stitchTiles(plate, plan.tiles, buffers, {
    deadlineAt: opts.deadlineAt,
    signal: opts.signal,
    pace: opts.pace,
    now: opts.now,
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    if (typeof t.unref === "function") t.unref();
  });
}

let fetchActive = 0;
const fetchQueue = [];
const fetchInflight = new Map();
const tileCache = new Map();
let tileCacheBytes = 0;
let slotEpoch = 0;
let fallbackInHand = false;

function resetForTests() {
  slotEpoch += 1;
  fetchActive = 0;
  fetchQueue.length = 0;
  fetchInflight.clear();
  tileCache.clear();
  tileCacheBytes = 0;
  fallbackInHand = false;
}

function frameCacheKey(frame) {
  if (!frame) return "";
  const nums = [frame.west, frame.south, frame.east, frame.north, frame.imgW, frame.imgH].map(Number);
  if (!nums.every(Number.isFinite)) return "";
  const f = (n) => (Math.round(+n * 1e6) / 1e6).toFixed(6);
  return [f(frame.west), f(frame.south), f(frame.east), f(frame.north), +frame.imgW, +frame.imgH].join(",");
}

function cacheGet(key) {
  if (!key) return null;
  const e = tileCache.get(key);
  if (!e) return null;
  if (Date.now() >= e.exp) {
    tileCache.delete(key);
    tileCacheBytes -= e.bytes;
    if (tileCacheBytes < 0) tileCacheBytes = 0;
    return null;
  }
  tileCache.delete(key);
  tileCache.set(key, e);
  return e.buf;
}

function cacheSet(key, buf) {
  if (!key || !buf || !buf.length) return;
  const bytes = buf.length;
  const existing = tileCache.get(key);
  if (existing) {
    tileCacheBytes -= existing.bytes;
    tileCache.delete(key);
  }
  while (tileCache.size && tileCacheBytes + bytes > AERIAL_TILE_CACHE_MAX_BYTES) {
    const first = tileCache.keys().next().value;
    const ev = tileCache.get(first);
    tileCache.delete(first);
    if (ev) tileCacheBytes -= ev.bytes;
    if (tileCacheBytes < 0) tileCacheBytes = 0;
  }
  tileCache.set(key, { buf, bytes, exp: Date.now() + AERIAL_TILE_CACHE_TTL_MS });
  tileCacheBytes += bytes;
}

function coarserWaiting(priority) {
  for (let i = 0; i < fetchQueue.length; i++) {
    if (fetchQueue[i].priority > priority) return true;
  }
  return false;
}

function dispatchFetchSlot() {
  while (fetchActive < AERIAL_FETCH_CONCURRENCY && fetchQueue.length) {
    let pick = -1;
    for (let i = 0; i < fetchQueue.length; i++) {
      const p = fetchQueue[i].priority;
      const cap = coarserWaiting(p) && !fallbackInHand
        ? AERIAL_FETCH_CONCURRENCY - AERIAL_FETCH_RESERVE_COARSER
        : AERIAL_FETCH_CONCURRENCY;
      if ((fetchInflight.get(p) || 0) >= cap) continue;
      if (pick < 0 || p < fetchQueue[pick].priority) pick = i;
    }
    if (pick < 0) {
      // Every queued job is at its per-plate cap. Use the leftover slot
      // on the sharpest waiter rather than leaving it idle.
      pick = 0;
      for (let i = 1; i < fetchQueue.length; i++) {
        if (fetchQueue[i].priority < fetchQueue[pick].priority) pick = i;
      }
    }
    const job = fetchQueue.splice(pick, 1)[0];
    job.run();
  }
}

/**
 * Shared cap. Lower priority numbers are sharper and go first, but one
 * slot stays available for a coarser tiled plate that is already waiting.
 */
function withFetchSlot(fn, priority) {
  const pri = Number.isFinite(+priority) ? +priority : 0;
  const epoch = slotEpoch;
  return new Promise((resolve, reject) => {
    const job = {
      priority: pri,
      run: function () {
        if (epoch !== slotEpoch) {
          resolve();
          return;
        }
        fetchActive += 1;
        fetchInflight.set(pri, (fetchInflight.get(pri) || 0) + 1);
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            if (epoch !== slotEpoch) return;
            fetchActive -= 1;
            if (fetchActive < 0) fetchActive = 0;
            const n = (fetchInflight.get(pri) || 1) - 1;
            if (n <= 0) fetchInflight.delete(pri);
            else fetchInflight.set(pri, n);
            dispatchFetchSlot();
          });
      },
    };
    fetchQueue.push(job);
    dispatchFetchSlot();
  });
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort/i.test(String((err && (err.message || err.reason)) || err || ""));
}

function isTransientAerialError(err) {
  if (isAbortError(err)) return false;
  const msg = String((err && (err.message || err.reason)) || err || "");
  if (!msg) return true;
  return /timeout|timed out|econnreset|etimedout|enotfound|eai_again|econnrefused|socket|network|fetch failed|429|503|504/i.test(msg);
}

function signalAborted(signal) {
  return !!(signal && signal.aborted);
}

function pastDeadline(deadlineAt) {
  return !!(deadlineAt && Date.now() > deadlineAt);
}

function sleepAbortable(ms, signal, deadlineAt) {
  let left = Math.max(0, ms);
  if (deadlineAt) left = Math.min(left, Math.max(0, deadlineAt - Date.now()));
  if (!(left > 0) || signalAborted(signal) || pastDeadline(deadlineAt)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t = setTimeout(onDone, left);
    if (typeof t.unref === "function") t.unref();
    function onDone() {
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onDone);
      clearTimeout(t);
      resolve();
    }
    if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onDone, { once: true });
  });
}

/**
 * Shared Esri fetch: concurrency cap, transient retry, and a short JPEG cache.
 */
function wrapFetchImage(fetchImage, opts) {
  const deadlineAt = opts && opts.deadlineAt;
  const attempts = opts && opts.attempts > 0 ? opts.attempts : AERIAL_TILE_ATTEMPTS;
  // Tiled plates share the cap. A coarser unstitched plate must be able
  // to start even when every tile slot is busy, or the fallback starves.
  const useSlot = !opts || opts.slot !== false;
  const priority = opts && Number.isFinite(+opts.priority) ? +opts.priority : 0;
  return async function (frame, signal) {
    const key = frameCacheKey(frame);
    const hit = cacheGet(key);
    if (hit) return hit;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signalAborted(signal) || pastDeadline(deadlineAt)) throw abortError();
      try {
        const run = async () => {
          if (signalAborted(signal) || pastDeadline(deadlineAt)) throw abortError();
          return await fetchImage(frame, signal);
        };
        const buf = useSlot ? await withFetchSlot(run, priority) : await run();
        if (buf && buf.length > 100) cacheSet(key, buf);
        return buf;
      } catch (err) {
        lastErr = err;
        const more =
          attempt < attempts &&
          isTransientAerialError(err) &&
          !signalAborted(signal) &&
          !pastDeadline(deadlineAt);
        if (!more) throw err;
        await sleepAbortable(AERIAL_TILE_RETRY_MS * Math.pow(2, attempt - 1), signal, deadlineAt);
      }
    }
    throw lastErr || abortError();
  };
}

/** An imagery error that is the server's answer (HTTP 5xx), not a timeout or abort. */
function refusedBySource(err) {
  const msg = String((err && (err.message || err.reason)) || err || "");
  return /HTTP 5\d\d/.test(msg) && !/timeout|abort/i.test(msg);
}

/**
 * entries are sharpest first. opts.fetchImage(frame, signal) returns a JPEG.
 * The finest plate wins when it arrives inside the budget. Otherwise the
 * sharpest JPEG already in hand is the one returned.
 */
async function racePlates(entries, opts) {
  const list = entries || [];
  const budgetMs = opts && opts.budgetMs > 0 ? opts.budgetMs : aerialBudgetMs();
  const emptyGraceMs =
    opts && opts.emptyGraceMs != null && Number.isFinite(+opts.emptyGraceMs)
      ? Math.max(0, +opts.emptyGraceMs)
      : AERIAL_EMPTY_GRACE_MS;
  const nearDoneMs =
    opts && opts.nearDoneGraceMs != null && Number.isFinite(+opts.nearDoneGraceMs)
      ? Math.max(0, +opts.nearDoneGraceMs)
      : AERIAL_NEAR_DONE_GRACE_MS;
  const started = Date.now();
  fallbackInHand = false;
  const deadlineAt = started + budgetMs + emptyGraceMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs + emptyGraceMs);
  if (typeof timer.unref === "function") timer.unref();

  const fetchPlainImage = wrapFetchImage(opts && opts.fetchImage, { deadlineAt, slot: false });
  const fetchTileImageAt = (priority) =>
    wrapFetchImage(opts && opts.fetchImage, { deadlineAt, slot: true, priority: priority });
  const tileMinSide = opts && opts.tileMinSide > 0 ? opts.tileMinSide : 0;
  const graceMs = opts && opts.sharperGraceMs > 0 ? opts.sharperGraceMs : 0;
  const unitCounts = list.map((entry) => {
    if (entry && entry.tile) {
      const plan = tilePlan(entry.plate, tileMinSide);
      if (plan) return plan.tiles.length;
    }
    return 1;
  });
  const unitTotal = unitCounts.reduce((sum, n) => sum + n, 0);
  const unitsDone = unitCounts.map(() => 0);
  const stitching = unitCounts.map(() => false);
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

  /** Every plate sharper than idx has failed, so nothing better can come. */
  function sharperSettled(idx) {
    for (let i = 0; i < idx; i++) {
      if (!errors[i] && !(results[i] && results[i].length > 100)) return false;
    }
    return true;
  }
  function plateNearlyDone(i) {
    if (results[i] || errors[i]) return false;
    if (stitching[i]) return true;
    const total = unitCounts[i] || 1;
    const done = unitsDone[i] || 0;
    if (!(total >= 2)) return false;
    return done >= total - 2 || done / total >= 0.75;
  }
  function sharperNearlyDone(idx) {
    for (let i = 0; i < idx; i++) {
      if (plateNearlyDone(i)) return true;
    }
    return false;
  }
  let fallbackAt = 0;

  const jobs = list.map((entry, i) => {
    const run =
      entry && entry.tile
        ? fetchTiled(entry.plate, {
            tileMinSide,
            fetchImage: fetchTileImageAt(i),
            signal: ctrl.signal,
            deadlineAt: deadlineAt,
            pace: opts.pace,
            now: opts.now,
            onUnit: function () {
              unitsDone[i] += 1;
              if (opts.onUnit) opts.onUnit();
            },
            onStitch: function () {
              stitching[i] = true;
              notify();
            },
          })
        : Promise.resolve()
            .then(() => fetchPlainImage(entry.plate, ctrl.signal))
            .then((buf) => {
              unitsDone[i] += 1;
              if (opts.onUnit) opts.onUnit();
              return buf;
            });
    return run
      .then((buf) => {
        results[i] = buf;
        if (i > 0) {
          fallbackInHand = true;
          dispatchFetchSlot();
        }
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
    while (true) {
      const elapsed = Date.now() - started;
      if (results[0]) break;
      if (settled >= list.length) break;
      const best = bestIndex();
      const hasPlate = best >= 0;
      // A plate in hand still stops at the ordinary budget (plus the
      // existing sharper-plate grace, and a short wait when a sharper
      // tiled plate is nearly done). Empty-hand grace only applies
      // when nothing has arrived yet.
      let left;
      if (hasPlate) {
        left = budgetMs - elapsed;
        if (errors[0]) {
          // Sharp failed. Only the optional sharper-plate grace waits
          // for a mid plate; without it, keep the plate already in hand.
          if (!(graceMs > 0)) break;
          if (sharperSettled(best)) break;
          if (!fallbackAt) fallbackAt = Date.now();
          const graceLeft = graceMs - (Date.now() - fallbackAt);
          if (!(graceLeft > 0)) break;
          left = Math.min(Math.max(0, left), graceLeft);
        } else if (!(left > 0)) {
          // Sharp is still in flight. A nearly-done tiled plate gets a
          // short wait; otherwise keep the plate already in hand.
          if (nearDoneMs > 0 && sharperNearlyDone(best)) {
            left = started + budgetMs + nearDoneMs - Date.now();
            if (!(left > 0)) break;
          } else {
            break;
          }
        }
      } else {
        left = budgetMs + emptyGraceMs - elapsed;
        if (!(left > 0)) break;
      }
      if (!(left > 0)) break;
      await waitChange(left);
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    fallbackInHand = false;
  }

  const idx = bestIndex();
  if (idx < 0) {
    const err = errors.find(Boolean);
    if (err) throw err;
    throw Object.assign(new Error("The operation was aborted due to timeout"), { source: "imagery" });
  }
  // Every sharper plate answered with a server error: Esri has no finer
  // imagery at this spot (its export cannot resample past the source), so
  // the kept plate is the sharpest there is, not a timeout fallback.
  let noFiner = idx > 0;
  for (let i = 0; i < idx && noFiner; i++) noFiner = refusedBySource(errors[i]);
  return {
    buf: results[idx],
    index: idx,
    stepped: idx > 0,
    noFiner,
    elapsedMs: Date.now() - started,
    unitsDone: unitsDone.slice(),
    unitCounts: unitCounts.slice(),
  };
}

module.exports = {
  AERIAL_STAGE_BUDGET_MS,
  AERIAL_TILE_MIN_SIDE,
  AERIAL_TILE_LONG_SIDE,
  AERIAL_TILE_POOL,
  AERIAL_TILE_MIN_SIDE_RESILIENT,
  AERIAL_SHARPER_GRACE_MS,
  AERIAL_EMPTY_GRACE_MS,
  AERIAL_NEAR_DONE_GRACE_MS,
  AERIAL_FETCH_CONCURRENCY,
  AERIAL_FETCH_RESERVE_COARSER,
  AERIAL_TILE_ATTEMPTS,
  AERIAL_TILE_RETRY_MS,
  AERIAL_TILE_CACHE_TTL_MS,
  setAerialBudgetForTests,
  aerialBudgetMs,
  shouldTilePlate,
  sameExportPlate,
  tilePlan,
  stitchTiles,
  racePlates,
  refusedBySource,
  isTransientAerialError,
  resetForTests,
};
