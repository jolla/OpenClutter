"use strict";

// One-shot thread for the aerial lock (decode, ground-meter resample,
// encode). The main thread stays free while it runs and can stop it.
const { parentPort, workerData } = require("node:worker_threads");
const gf = require("./geo-frame");

try {
  gf.setTrueMetres(workerData.trueMetres === true);
  if (workerData.hangMs > 0) {
    // Test hook: a stuck lock (the main thread must not wait on it).
    const until = Date.now() + workerData.hangMs;
    while (Date.now() < until) {
      /* spin */
    }
  }
  const timing = {};
  const out = gf.lockIsotropicImagery(workerData.frame, Buffer.from(workerData.jpeg), Object.assign({}, workerData.opts, { timing }));
  const buf = out.jpegBuf;
  parentPort.postMessage({
    ok: true,
    frame: out.frame,
    jpeg: buf ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null,
    resampled: out.resampled,
    groundMeters: out.groundMeters,
    timing,
  });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
}
