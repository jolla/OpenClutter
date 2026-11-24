"use strict";

/**
 * Bounded aerial lock. lockIsotropicImagery decodes the plate, resamples it
 * onto ground meters (trueMetres) and encodes it again. On the largest plates
 * that synchronous step has, a few times, held the main thread for 2 to 8
 * minutes while the box was idle, and every other source's clock stalled with
 * it. Here it runs on its own thread with a deadline. A thread that misses the
 * deadline is stopped and the lock is tried once more on a fresh thread; if
 * that also misses, the export keeps the unresampled plate on its own pixel
 * grid (the same result as an undecodable plate) and says so. A large plate
 * never locks on the main thread: if no thread can run it (no thread file, or
 * a thread that cannot start), the plate is kept the same way (1.3.92).
 */
const path = require("node:path");
const gf = require("./geo-frame");

/** Per-attempt deadline. A 3,300 px plate normally locks in 3 to 6 s. */
const IMAGE_LOCK_MS = 40000;
const IMAGE_LOCK_ATTEMPTS = 2;

/**
 * Where the thread file is. In the repo and on Fly it sits beside this file.
 * In a Netlify function bundle this file is inlined into the function, so
 * __dirname is the function's folder; netlify.toml copies the thread file
 * (and geo-frame.js, jpeg-js) to netlify/lib under the task root.
 */
function workerCandidates() {
  const roots = [process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  const out = [path.join(__dirname, "image-lock-worker.js"), path.join(__dirname, "..", "lib", "image-lock-worker.js")];
  for (const r of roots) out.push(path.join(r, "netlify", "lib", "image-lock-worker.js"));
  return out;
}

let workerPathMemo;
function workerFile() {
  if (workerPathMemo !== undefined) return workerPathMemo;
  const fs = require("node:fs");
  workerPathMemo = null;
  for (const f of workerCandidates()) {
    try {
      if (fs.existsSync(f) && fs.existsSync(path.join(path.dirname(f), "geo-frame.js"))) {
        workerPathMemo = f;
        break;
      }
    } catch {
      /* next */
    }
  }
  return workerPathMemo;
}

function spawnLock(workerData) {
  const file = workerFile();
  if (!file) throw new Error("no lock thread file");
  const { Worker } = require("node:worker_threads");
  return new Worker(file, { workerData });
}

/** The unresampled plate on its own pixel grid: no decode, no wait. */
function keepPlate(frame, jpegBuf, t0, extra) {
  return Object.assign(
    { frame: frame ? gf.unifyFrameMpu(frame) : frame, jpegBuf, resampled: false, groundMeters: false, wallMs: Date.now() - t0 },
    extra
  );
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
  // There is no timer capable of stopping synchronous JPEG work. Even a
  // small plate therefore uses the thread; the only inline result is the
  // constant-work, no-decode path for an absent image.
  if (!frame || !jpegBuf || jpegBuf.length < 100) {
    return keepPlate(frame, jpegBuf, t0, { attempts: 0, mode: "kept" });
  }
  // A large plate never locks on the main thread (1.3.92): with no thread
  // file there is no deadline that can stop it, so keep the plate instead.
  const haveThread = deps.spawn ? true : !!workerFile();
  if (!haveThread) {
    return keepPlate(frame, jpegBuf, t0, { failed: ["no-thread"], attempts: 0, mode: "kept" });
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
        mode: "thread",
      };
    }
    why.push(got.timedOut ? "timeout" : got.error || "failed");
  }
  return keepPlate(frame, jpegBuf, t0, {
    timedOut: why.every((w) => w === "timeout"),
    failed: why,
    attempts: IMAGE_LOCK_ATTEMPTS,
    mode: "kept",
  });
}

/** /dev probe: lock a generated 1400 px plate at 60N and say how it ran. */
async function lockProbe() {
  const jpeg = require("jpeg-js");
  const w = 1400;
  const h = 1400;
  const data = Buffer.alloc(w * h * 4, 128);
  const buf = jpeg.encode({ data, width: w, height: h }, 80).data;
  const frame = gf.geoFrame({ west: 25.0, south: 60.0, east: 25.05, north: 60.025 }, { imgW: w, imgH: h, maxSpanM: 50000, minSpanM: 1 });
  const r = await lockIsotropicImageryBounded(frame, buf, { maxSide: 2048 });
  return {
    file: workerFile(),
    taskRoot: process.env.LAMBDA_TASK_ROOT || null,
    mode: r.mode,
    attempts: r.attempts,
    wallMs: r.wallMs,
    timing: r.timing || null,
    failed: r.failed || null,
    resampled: r.resampled,
    out: r.frame ? [r.frame.imgW, r.frame.imgH] : null,
  };
}

module.exports = {
  lockProbe,
  workerFile,
  workerCandidates,
  IMAGE_LOCK_MS,
  IMAGE_LOCK_ATTEMPTS,
  lockIsotropicImageryBounded,
};
