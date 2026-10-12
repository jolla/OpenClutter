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

function threadCount() {
  const list = os.cpus();
  const n = list && list.length;
  return n > 0 ? n : 1;
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
  if (msg.ok) slot.resolve(msg.result);
  else slot.reject(new Error(msg.error || "worker failed"));
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
    const worker = new Worker(workerFile());
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

function runOne(task, payload) {
  const pool = ensurePool();
  if (!pool) return Promise.resolve().then(() => runInline(task, payload));
  const id = seq++;
  const worker = pool[(id - 1) % pool.length];
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, task, payload });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

async function runTiles(task, payloads) {
  const list = payloads || [];
  if (!list.length) return [];
  const out = new Array(list.length);
  await Promise.all(
    list.map(async (payload, i) => {
      out[i] = await runOne(task, payload);
    })
  );
  return out;
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
  workerFile,
  runOne,
  runTiles,
  closePool,
};
