"use strict";

/**
 * One Node worker per CPU. Detection that used to block the export
 * heartbeat runs here. The main thread only waits, so setInterval
 * still fires.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

function reportedCpuCount() {
  const list = os.cpus();
  const n = list && list.length;
  return n > 0 ? n : 0;
}

/**
 * performance-4x is 4 dedicated vCPUs. os.cpus() inside the guest can
 * still report 1 or the host count. When OPENCLUTTER_CPU_COUNT or
 * FLY_MACHINE_CPUS is set, that number is the pool. The host count is
 * not used.
 */
function configuredCpuCount() {
  const raw = process.env.OPENCLUTTER_CPU_COUNT || process.env.FLY_MACHINE_CPUS || "";
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.floor(n);
}

function threadCount() {
  const configured = configuredCpuCount();
  if (configured > 0) return configured;
  if (typeof os.availableParallelism === "function") {
    const n = os.availableParallelism();
    if (n > 0) return n;
  }
  const reported = reportedCpuCount();
  return reported > 0 ? reported : 1;
}

function cpuStartLine() {
  const avail = typeof os.availableParallelism === "function" ? os.availableParallelism() : 0;
  return (
    "worker start os.cpus " +
    reportedCpuCount() +
    " availableParallelism " +
    avail +
    " pool " +
    threadCount()
  );
}

function tileTimingLine(jobId, tileId, threadId, startMs, durationMs) {
  const start = (Math.max(0, startMs) / 1000).toFixed(1);
  const duration = (Math.max(0, durationMs) / 1000).toFixed(1);
  return (
    "export " +
    jobId +
    " stage tile " +
    tileId +
    " thread " +
    threadId +
    " start " +
    start +
    "s duration " +
    duration +
    "s"
  );
}

const logState = {
  jobId: "",
  t0: 0,
  log: () => {},
};

function setExportLog(jobId, log) {
  if (!jobId) {
    logState.jobId = "";
    logState.t0 = 0;
    logState.log = () => {};
    return;
  }
  logState.jobId = String(jobId);
  logState.t0 = Date.now();
  logState.log = typeof log === "function" ? log : (line) => console.log(line);
}

function noteTile(tileId, info) {
  if (!logState.jobId || !info) return;
  const line = tileTimingLine(
    logState.jobId,
    tileId,
    info.threadId,
    info.startedAt - logState.t0,
    info.finishedAt - info.startedAt
  );
  logState.log(line);
}

function workerFile() {
  return path.join(__dirname, "cpu-worker.js");
}

let workers = null;
let seq = 1;
const pending = new Map();
let failed = false;

function onMessage(msg) {
  if (!msg || msg.id == null) return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.ok) {
    if (msg.startedAt && slot.onTime) {
      slot.onTime({
        threadId: msg.threadId,
        startedAt: msg.startedAt,
        finishedAt: msg.finishedAt || msg.startedAt,
      });
    }
    slot.resolve(msg.result);
  } else slot.reject(new Error(msg.error || "worker failed"));
}

function ensurePool() {
  if (failed) return null;
  if (workers) return workers;
  if (!fs.existsSync(workerFile())) {
    failed = true;
    return null;
  }
  const n = threadCount();
  workers = [];
  for (let i = 0; i < n; i++) {
    const worker = new Worker(workerFile(), { workerData: { index: i } });
    if (typeof worker.unref === "function") worker.unref();
    worker.on("message", onMessage);
    worker.on("error", (err) => {
      const message = err && err.message ? err.message : "worker failed";
      for (const slot of pending.values()) slot.reject(new Error(message));
      pending.clear();
    });
    workers.push(worker);
  }
  return workers;
}

function runInline(task, payload) {
  return require("./cpu-tasks").runTask(task, payload);
}

function runOn(workerIndex, task, payload, hooks) {
  const pool = ensurePool();
  const onTime = hooks && hooks.onTime;
  if (!pool) {
    return Promise.resolve().then(() => {
      const startedAt = Date.now();
      const result = runInline(task, payload);
      if (onTime) onTime({ threadId: "main", startedAt, finishedAt: Date.now() });
      return result;
    });
  }
  const id = seq++;
  const worker = pool[Math.abs(workerIndex | 0) % pool.length];
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onTime });
    try {
      worker.postMessage({ id, task, payload });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

function runOne(task, payload, hooks) {
  return runOn(seq, task, payload, hooks);
}

/**
 * Threads pull the next payload when they finish. One task is in flight
 * per thread, so a short tile does not sit behind a long one on the same
 * worker. The main thread only waits, and the 10 second heartbeat still fires.
 */
async function runQueue(task, payloads) {
  const list = payloads || [];
  const out = new Array(list.length);
  if (!list.length) return out;
  const pool = ensurePool();
  let cursor = 0;
  const pull = async (workerIndex) => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const payload = list[i];
      const tileId = payload && payload.tileId != null ? payload.tileId : task + "-" + i;
      out[i] = await runOn(workerIndex, task, payload, {
        onTime(info) {
          noteTile(tileId, info);
        },
      });
    }
  };
  const n = pool ? Math.min(pool.length, list.length) : 1;
  await Promise.all(Array.from({ length: n }, (_, workerIndex) => pull(workerIndex)));
  return out;
}

async function runTiles(task, payloads) {
  return runQueue(task, payloads);
}

function poolSize() {
  return workers ? workers.length : 0;
}

async function closePool() {
  const pool = workers;
  workers = null;
  failed = false;
  if (!pool) return;
  await Promise.all(pool.map((worker) => worker.terminate().catch(() => {})));
}

module.exports = {
  threadCount,
  cpuStartLine,
  tileTimingLine,
  setExportLog,
  workerFile,
  runOne,
  runTiles,
  runQueue,
  poolSize,
  closePool,
};
