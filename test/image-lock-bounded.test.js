"use strict";

// 1.3.91: the aerial lock runs on its own thread with a deadline, so a stuck
// plate cannot hold the export (g-r188 Fort Wilderness sat 480 s in it).
const test = require("node:test");
const assert = require("node:assert/strict");
const jpeg = require("jpeg-js");
const gf = require("../netlify/lib/geo-frame");
const { lockIsotropicImageryBounded } = require("../netlify/lib/image-lock");

function plate(w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 7) & 255;
      data[i + 1] = (y * 5) & 255;
      data[i + 2] = ((x + y) * 3) & 255;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width: w, height: h }, 85).data;
}

// 60N: needs the ground-meter resample whether or not trueMetres is on.
const bboxN = { west: 25.0, south: 60.0, east: 25.02, north: 60.01 };
const W = 320;
const H = 320;
const buf = plate(W, H);
const frameN = gf.geoFrame(bboxN, { imgW: W, imgH: H, maxSpanM: 50000, minSpanM: 1 });

test("thread lock matches the inline lock byte for byte", async () => {
  const inline = gf.lockIsotropicImagery(frameN, buf, { maxSide: 1040 });
  assert.equal(inline.resampled, true);
  const got = await lockIsotropicImageryBounded(frameN, buf, { maxSide: 1040 }, { inline: false });
  assert.equal(got.attempts, 1);
  assert.equal(got.resampled, true);
  assert.deepEqual(got.frame, inline.frame);
  assert.ok(Buffer.compare(got.jpegBuf, inline.jpegBuf) === 0);
  assert.ok(got.timing && got.timing.decodeMs >= 0 && got.timing.resizeMs >= 0 && got.timing.encodeMs >= 0);
});

test("a stuck lock is stopped at the deadline, retried once, then the plate is kept unresampled", async () => {
  const t0 = Date.now();
  const got = await lockIsotropicImageryBounded(frameN, buf, { maxSide: 1040 }, { inline: false, timeoutMs: 400, hangMs: 60000 });
  const took = Date.now() - t0;
  assert.ok(took < 5000, "bounded, took " + took + " ms");
  assert.equal(got.attempts, 2);
  assert.equal(got.timedOut, true);
  assert.deepEqual(got.failed, ["timeout", "timeout"]);
  assert.equal(got.resampled, false);
  assert.equal(got.groundMeters, false);
  assert.equal(got.jpegBuf, buf);
  assert.deepEqual(got.frame, gf.unifyFrameMpu(frameN));
});

test("a lock stuck once succeeds on the fresh thread", async () => {
  const inline = gf.lockIsotropicImagery(frameN, buf, { maxSide: 1040 });
  const got = await lockIsotropicImageryBounded(frameN, buf, { maxSide: 1040 }, { inline: false, timeoutMs: 1500, hangMs: [60000, 0] });
  assert.equal(got.attempts, 2);
  assert.deepEqual(got.retried, ["timeout"]);
  assert.equal(got.resampled, true);
  assert.ok(Buffer.compare(got.jpegBuf, inline.jpegBuf) === 0);
});

test("a thread that cannot start keeps the plate instead of locking on the main thread", async () => {
  const spawn = () => {
    throw new Error("no threads");
  };
  const got = await lockIsotropicImageryBounded(frameN, buf, { maxSide: 1040 }, { inline: false, spawn });
  assert.equal(got.mode, "kept");
  assert.equal(got.resampled, false);
  assert.equal(got.jpegBuf, buf);
  assert.deepEqual(got.frame, gf.unifyFrameMpu(frameN));
  assert.deepEqual(got.failed, ["no threads", "no threads"]);
});

test("the Netlify included_files set is enough to run the lock thread on its own", async () => {
  // Same layout netlify.toml ships: netlify/lib/{image-lock-worker,geo-frame,
  // stage-clock}.js and node_modules/jpeg-js under the task root.
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { Worker } = require("node:worker_threads");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-lock-"));
  try {
    const toml = fs.readFileSync(path.join(__dirname, "..", "netlify.toml"), "utf8");
    const lists = toml.match(/included_files = \[[^\]]*\]/g) || [];
    const lockLists = lists.filter((l) => l.includes("image-lock-worker.js"));
    assert.equal(lockLists.length, 2, "clutter and clutter-export-background both ship the thread");
    const files = JSON.parse(lockLists[0].replace(/^included_files = /, ""));
    for (const f of files) {
      if (f.endsWith("/**")) {
        const dir = f.slice(0, -3);
        fs.mkdirSync(path.dirname(path.join(root, dir)), { recursive: true });
        fs.cpSync(path.join(__dirname, "..", dir), path.join(root, dir), { recursive: true, dereference: true });
      } else if (f.endsWith(".js")) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        fs.copyFileSync(path.join(__dirname, "..", f), path.join(root, f));
      }
    }
    const file = path.join(root, "netlify", "lib", "image-lock-worker.js");
    const spawn = (data) => new Worker(file, { workerData: data });
    const inline = gf.lockIsotropicImagery(frameN, buf, { maxSide: 1040 });
    const got = await lockIsotropicImageryBounded(frameN, buf, { maxSide: 1040 }, { inline: false, spawn });
    assert.equal(got.mode, "thread");
    assert.ok(Buffer.compare(got.jpegBuf, inline.jpegBuf) === 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the thread file is looked for under the Lambda task root", () => {
  const path = require("node:path");
  const { workerCandidates } = require("../netlify/lib/image-lock");
  const prev = process.env.LAMBDA_TASK_ROOT;
  process.env.LAMBDA_TASK_ROOT = "/var/task";
  try {
    assert.ok(workerCandidates().includes(path.join("/var/task", "netlify", "lib", "image-lock-worker.js")));
  } finally {
    if (prev === undefined) delete process.env.LAMBDA_TASK_ROOT;
    else process.env.LAMBDA_TASK_ROOT = prev;
  }
});

test("a small plate locks inline", async () => {
  const small = plate(64, 64);
  const fr = gf.geoFrame(bboxN, { imgW: 64, imgH: 64, maxSpanM: 50000, minSpanM: 1 });
  const got = await lockIsotropicImageryBounded(fr, small, { maxSide: 1040 });
  assert.equal(got.mode, "inline");
});

test("a plate that needs no resample is sized from its header without a decode", () => {
  // 28N legacy plate: no ground meters, under maxSide.
  const bboxS = { west: -81.6, south: 28.4, east: -81.58, north: 28.41 };
  const fr = gf.geoFrame(bboxS, { imgW: W, imgH: H, maxSpanM: 50000, minSpanM: 1 });
  const timing = {};
  const out = gf.lockIsotropicImagery(fr, buf, { maxSide: 1040, legacy: true, timing });
  assert.equal(out.resampled, false);
  assert.equal(out.groundMeters, false);
  assert.equal(out.jpegBuf, buf);
  assert.equal(timing.decodeMs, undefined);
  const expect = gf.unifyFrameMpu(gf.geoFrame(bboxS, { imgW: W, imgH: H, maxSpanM: Math.max(fr.widthM, fr.lengthM, 2500) * 2.5, minSpanM: 1 }));
  assert.deepEqual(out.frame, expect);
});

test("worker:netlify keeps a /dev export on Netlify, never on production", () => {
  const { devStaysOnNetlify } = require("../netlify/lib/fly-handoff");
  const body = JSON.stringify({ west: 0, worker: "netlify" });
  assert.equal(devStaysOnNetlify({ headers: { host: "dev.openclutter.com" }, body }), true);
  assert.equal(devStaysOnNetlify({ headers: { host: "openclutter.com" }, body }), false);
  assert.equal(devStaysOnNetlify({ headers: { host: "dev.openclutter.com" }, body: JSON.stringify({ west: 0 }) }), false);
});
