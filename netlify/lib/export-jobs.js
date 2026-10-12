"use strict";

/**
 * Export jobs live in Netlify Blobs. The sync function writes the job id.
 * The background function writes stages and the zip. A status read drops a
 * job that is older than an hour. The zip is deleted once it is downloaded.
 * Blobs have no server-side TTL, so the hour is checked on read.
 *
 * The Fly worker also writes a heartbeat on this same job while an export
 * runs. The heartbeat is the current stage name and a timestamp. Netlify
 * treats a gap of HEARTBEAT_STALE_MS as a stopped worker.
 */

const { markStage } = require("./export-progress");

const STORE_NAME = "openclutter-exports";
const TTL_MS = 60 * 60 * 1000;
// The worker writes this often. A missed beat still lands inside the
// 45 second stale window unless the machine has actually stopped.
const HEARTBEAT_MS = 10 * 1000;
const HEARTBEAT_STALE_MS = 45 * 1000;
// Netlify rejects a function response above 6,291,556 bytes. The zip is
// base64 in that response. This is the largest file whose base64 form,
// plus a small envelope, still fits. It is not a Hamina import limit.
const FUNCTION_RESPONSE_MAX = 6291556;
const RESPONSE_ENVELOPE = 8192;
const ZIP_DOWNLOAD_MAX = Math.floor((FUNCTION_RESPONSE_MAX - RESPONSE_ENVELOPE - 1) / 4) * 3;

function zipDownloadFits(byteLength) {
  const n = byteLength | 0;
  if (!(n > 0) || n > ZIP_DOWNLOAD_MAX) return false;
  return Math.ceil(n / 3) * 4 + 8192 < FUNCTION_RESPONSE_MAX;
}

let storeOverride = null;

function setExportStoreForTests(store) {
  storeOverride = store;
}

/**
 * These functions use the Lambda-style handler. Netlify only fills
 * NETLIFY_BLOBS_CONTEXT for the newer function format. The v1 event carries
 * the same credentials on event.blobs, and connectLambda copies them across.
 */
function bindBlobs(event) {
  if (!event || !event.blobs) return false;
  const src = event.headers || {};
  const headers = {};
  for (const key of Object.keys(src)) headers[String(key).toLowerCase()] = src[key];
  try {
    const { connectLambda } = require("@netlify/blobs");
    connectLambda({ blobs: event.blobs, headers });
    return true;
  } catch {
    return false;
  }
}

function jobKey(id) {
  return "job/" + id;
}

function zipKey(id) {
  return "job/" + id + "/zip";
}

function validJobId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));
}

async function openStore() {
  if (storeOverride) return storeOverride;
  const { getStore } = require("@netlify/blobs");
  // v1 function events do not include the uncached edge URL strong reads need.
  // NETLIFY_BLOBS_REGION is only for a worker outside Netlify. Leave it unset
  // on the function. The lambda context already knows the store.
  const opts = { name: STORE_NAME };
  const region = String(process.env.NETLIFY_BLOBS_REGION || "").trim();
  if (region) opts.region = region;
  return getStore(opts);
}

function withStageMark(job, stage) {
  const mark = markStage(stage);
  job.stageLabel = mark.label;
  job.progress = mark.progress;
  job.progressCeiling = mark.ceiling;
  return job;
}

function freshJob(id) {
  const now = Date.now();
  const job = {
    id,
    state: "queued",
    stage: "Fetching aerial",
    stages: ["Fetching aerial"],
    error: null,
    stats: null,
    warnings: [],
    zipFilename: null,
    zipBytes: 0,
    terrainClipboard: null,
    terrainStatus: "",
    gpsClipboard: null,
    createdAt: now,
    expiresAt: now + TTL_MS,
    updatedAt: now,
  };
  return withStageMark(job, job.stage);
}

async function createJob(id) {
  const store = await openStore();
  const job = freshJob(id);
  await store.setJSON(jobKey(id), job);
  return job;
}

async function readJob(id) {
  if (!validJobId(id)) return null;
  const store = await openStore();
  const job = await store.get(jobKey(id), { type: "json" });
  if (!job) return null;
  if (job.expiresAt && Date.now() > job.expiresAt) {
    await store.delete(jobKey(id)).catch(() => {});
    await store.delete(zipKey(id)).catch(() => {});
    return null;
  }
  return job;
}

function isTerminalState(state) {
  return state === "done" || state === "error" || state === "failed";
}

const jobLocks = new Map();

function withJobLock(id, fn) {
  const key = String(id);
  const prev = jobLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {
      if (jobLocks.get(key) === tail) jobLocks.delete(key);
    },
    () => {
      if (jobLocks.get(key) === tail) jobLocks.delete(key);
    }
  );
  jobLocks.set(key, tail);
  return run;
}

async function loadJobRecord(store, id) {
  const key = jobKey(id);
  if (store && typeof store.getWithMetadata === "function") {
    const row = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!row) return { job: null, etag: null };
    return { job: row.data || null, etag: row.etag || null };
  }
  const job = await store.get(key, { type: "json" });
  return { job: job || null, etag: null };
}

async function saveJobRecord(store, id, job, etag) {
  const key = jobKey(id);
  if (etag) {
    const result = await store.setJSON(key, job, { onlyIfMatch: etag });
    if (result && result.modified === false) return false;
    return true;
  }
  if (typeof store.getWithMetadata === "function") {
    const result = await store.setJSON(key, job, { onlyIfNew: true });
    if (result && result.modified === false) return false;
    return true;
  }
  await store.setJSON(key, job);
  return true;
}

/**
 * A done or failed job is terminal. A later heartbeat, stage note, or
 * requeue must not change state, error, or the zip pointer. Heartbeat
 * fields apply only while the job is still queued or running.
 * A patch that tries to leave a terminal state is ignored entirely.
 */
function mergeJobPatch(cur, patch) {
  const incoming = Object.assign({}, patch || {});
  if (isTerminalState(cur.state)) {
    if (patch && patch.state && patch.state !== cur.state) return { unchanged: true, job: cur };
    delete incoming.state;
    delete incoming.error;
    delete incoming.zipFilename;
    delete incoming.zipBytes;
    delete incoming.heartbeatAt;
    delete incoming.heartbeatStage;
  }
  const keys = Object.keys(incoming);
  if (!keys.length) return { unchanged: true, job: cur };
  const stages = Array.isArray(cur.stages) ? cur.stages.slice() : [];
  if (incoming.stage && stages[stages.length - 1] !== incoming.stage) stages.push(incoming.stage);
  const next = Object.assign({}, cur, incoming, { stages, updatedAt: Date.now() });
  if (incoming.stage) withStageMark(next, incoming.stage);
  return { unchanged: false, job: next };
}

async function updateJob(id, patch) {
  return withJobLock(id, async () => {
    const store = await openStore();
    for (let attempt = 0; attempt < 8; attempt++) {
      const loaded = await loadJobRecord(store, id);
      const cur = loaded.job || freshJob(id);
      const merged = mergeJobPatch(cur, patch);
      if (merged.unchanged) return cur;
      const wrote = await saveJobRecord(store, id, merged.job, loaded.etag);
      if (wrote) return merged.job;
    }
    const last = await loadJobRecord(store, id);
    return last.job || freshJob(id);
  });
}

async function saveZip(id, buf) {
  const store = await openStore();
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  await store.set(zipKey(id), body);
  return body.length;
}

async function readZip(id) {
  const store = await openStore();
  const raw = await store.get(zipKey(id), { type: "arrayBuffer" });
  if (!raw) return null;
  const buf = Buffer.from(raw);
  return buf.length ? buf : null;
}

async function deleteZip(id) {
  const store = await openStore();
  await store.delete(zipKey(id)).catch(() => {});
}

async function takeZip(id) {
  const buf = await readZip(id);
  if (!buf) return null;
  await deleteZip(id);
  return buf;
}

async function deleteJob(id) {
  const store = await openStore();
  await store.delete(jobKey(id)).catch(() => {});
  await store.delete(zipKey(id)).catch(() => {});
}

/**
 * Stamp the job the worker is still running. A done or failed job is
 * terminal: a late beat refreshes nothing, including heartbeatAt.
 * The beat is written only while state is still queued or running.
 */
async function writeHeartbeat(id, stage) {
  if (!validJobId(id)) return null;
  const cur = await readJob(id);
  if (!cur) return null;
  if (isTerminalState(cur.state)) return cur;
  if (cur.state !== "running" && cur.state !== "queued") return cur;
  const name = String(stage || cur.heartbeatStage || cur.stage || "")
    .replace(/\s+/g, " ")
    .trim();
  return updateJob(id, {
    heartbeatAt: Date.now(),
    heartbeatStage: name,
  });
}

module.exports = {
  TTL_MS,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  ZIP_DOWNLOAD_MAX,
  FUNCTION_RESPONSE_MAX,
  zipDownloadFits,
  validJobId,
  setExportStoreForTests,
  bindBlobs,
  createJob,
  readJob,
  updateJob,
  saveZip,
  readZip,
  deleteZip,
  takeZip,
  deleteJob,
  freshJob,
  writeHeartbeat,
  isTerminalState,
  mergeJobPatch,
};
