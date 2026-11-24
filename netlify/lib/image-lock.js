"use strict";

/**
 * Bounded aerial lock. lockIsotropicImagery decodes the plate, resamples it
 * onto ground meters (trueMetres) and encodes it again. On the largest plates
 * that synchronous step has, a few times, held the main thread for 2 to 8
 * minutes while the box was idle, and every other source's clock stalled with
 * it. Here it runs on its own thread with a deadline. A thread that misses the
 * deadline is stopped and the lock is tried once more on a fresh thread; if
 * that also misses, the export keeps the unresampled plate on its own pixel
 * grid (the same result as an undecodable plate) and says so.
 */
const path = require("node:path");
const gf = require("./geo-frame");

/** Per-attempt deadline. A 3,300 px plate normally locks in 3 to 6 s. */
const IMAGE_LOCK_MS = 40000;
const IMAGE_LOCK_ATTEMPTS = 2;
/** Plates at or under this many pixels lock inline (well under a second). */
const IMAGE_LOCK_INLINE_PX = 1200 * 1200;

function workerFile() {
  return path.join(__dirname, "image-lock-worker.js");
}

function spawnLock(workerData) {
  const { Worker } = require("node:worker_threads");
  return new Worker(workerFile(), { workerData });
}

function attempt(spawn, data, ms) {
  return new Promise((resolve) => {
    let done = false;
    let worker = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker) {
        try {
          const p = worker.terminate();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {
          /* already gone */
        }
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), ms);
    try {
      worker = spawn(data);
    } catch (err) {
      finish({ error: String((err && err.message) || err) });
      return;
    }
    worker.on("message", (msg) => finish(msg && msg.ok ? { msg } : { error: (msg && msg.error) || "lock failed" }));
    worker.on("error", (err) => finish({ error: String((err && err.message) || err) }));
    worker.on("exit", (code) => finish({ error: "lock thread exited " + code }));
  });
}

/**
 * @returns {Promise<{frame, jpegBuf, resampled, groundMeters, timedOut?:boolean, attempts:number, wallMs:number, timing?:object}>}
 */
async function lockIsotropicImageryBounded(frame, jpegBuf, opts = {}, deps = {}) {
  const t0 = Date.now();
  const size = jpegBuf ? gf.jpegSize(jpegBuf) : null;
  const px = size ? size.width * size.height : 0;
  // No thread file (a bundle that did not copy it): the pre-1.3.91 inline lock.
  const haveThread = deps.spawn ? true : require("node:fs").existsSync(workerFile());
  const inline = deps.inline != null ? deps.inline : !haveThread || !jpegBuf || jpegBuf.length < 100 || px <= IMAGE_LOCK_INLINE_PX;
  if (inline) {
    const timing = {};
    const out = gf.lockIsotropicImagery(frame, jpegBuf, Object.assign({}, opts, { timing }));
    return Object.assign({}, out, { attempts: 0, wallMs: Date.now() - t0, timing });
  }
  const spawn = deps.spawn || spawnLock;
  const ms = deps.timeoutMs > 0 ? deps.timeoutMs : IMAGE_LOCK_MS;
  const data = {
    frame,
    jpeg: new Uint8Array(jpegBuf.buffer, jpegBuf.byteOffset, jpegBuf.byteLength),
    opts: { maxSide: opts.maxSide, quality: opts.quality, legacy: opts.legacy === true },
    trueMetres: gf.isTrueMetres(),
    hangMs: deps.hangMs || 0,
  };
  const why = [];
  for (let i = 0; i < IMAGE_LOCK_ATTEMPTS; i++) {
    const got = await attempt(spawn, Object.assign({}, data, { hangMs: Array.isArray(data.hangMs) ? data.hangMs[i] || 0 : data.hangMs }), ms);
    if (got.msg) {
      const m = got.msg;
      return {
        frame: m.frame,
        jpegBuf: m.jpeg ? Buffer.from(m.jpeg.buffer, m.jpeg.byteOffset, m.jpeg.byteLength) : jpegBuf,
        resampled: !!m.resampled,
        groundMeters: !!m.groundMeters,
        attempts: i + 1,
        wallMs: Date.now() - t0,
        timing: m.timing || {},
        retried: why.slice(),
      };
    }
    why.push(got.timedOut ? "timeout" : got.error || "failed");
    if (!got.timedOut && i === IMAGE_LOCK_ATTEMPTS - 1 && why.every((w) => w !== "timeout")) {
      // The thread could not run at all (not slow): lock inline as before.
      const timing = {};
      const out = gf.lockIsotropicImagery(frame, jpegBuf, Object.assign({}, opts, { timing }));
      return Object.assign({}, out, { attempts: 0, wallMs: Date.now() - t0, timing, retried: why.slice() });
    }
  }
  return {
    frame: gf.unifyFrameMpu(frame),
    jpegBuf,
    resampled: false,
    groundMeters: false,
    timedOut: why.every((w) => w === "timeout"),
    failed: why,
    attempts: IMAGE_LOCK_ATTEMPTS,
    wallMs: Date.now() - t0,
  };
}

module.exports = {
  IMAGE_LOCK_MS,
  IMAGE_LOCK_ATTEMPTS,
  IMAGE_LOCK_INLINE_PX,
  lockIsotropicImageryBounded,
};
