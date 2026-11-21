"use strict";

/**
 * Writes export-job heartbeats from a side thread. The main thread can
 * sit in spawnSync or Atomics.wait for minutes during Trees, which
 * would otherwise stall the in-process timer and look like a dead
 * worker to the Netlify handoff.
 */

const { workerData, parentPort } = require("worker_threads");
const jobs = require("../netlify/lib/export-jobs");

const jobId = workerData && workerData.jobId;
const ms = Math.max(10, (workerData && workerData.intervalMs) || jobs.HEARTBEAT_MS);
const header = workerData && workerData.sab ? new Int32Array(workerData.sab, 0, 2) : null;
let stage = String((workerData && workerData.stage) || "Trees");

function configureBlobsFromEnv() {
  const siteID = String(process.env.NETLIFY_SITE_ID || "").trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || "").trim();
  if (!siteID || !token) return false;
  const { setEnvironmentContext } = require("@netlify/blobs");
  const ctx = { siteID, token };
  const region = String(process.env.NETLIFY_BLOBS_REGION || "").trim();
  if (region) ctx.region = region;
  setEnvironmentContext(ctx);
  return true;
}

if (parentPort) {
  parentPort.on("message", (msg) => {
    if (!msg) return;
    if (typeof msg.stage === "string" && msg.stage) stage = msg.stage;
  });
}

function beat() {
  if (header && Atomics.load(header, 0) === 0) return;
  if (header) Atomics.add(header, 1, 1);
  if (!jobs.validJobId(jobId)) return;
  Promise.resolve()
    .then(() => {
      configureBlobsFromEnv();
      return jobs.writeHeartbeat(jobId, stage);
    })
    .then((cur) => {
      if (jobs.isCancelled(cur) && parentPort) parentPort.postMessage({ cancelled: true });
    })
    .catch(() => {});
}

beat();
const timer = setInterval(beat, ms);
if (typeof timer.unref === "function") timer.unref();
