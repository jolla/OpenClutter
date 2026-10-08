"use strict";

/**
 * Export jobs live in Netlify Blobs. The sync function writes the job id.
 * The background function writes stages and the zip. A status read drops a
 * job that is older than an hour. The zip is deleted once it is downloaded.
 * Blobs have no server-side TTL, so the hour is checked on read.
 */

const STORE_NAME = "openclutter-exports";
const TTL_MS = 60 * 60 * 1000;

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
  return getStore({ name: STORE_NAME });
}

function freshJob(id) {
  const now = Date.now();
  return {
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

async function updateJob(id, patch) {
  const store = await openStore();
  const cur = (await store.get(jobKey(id), { type: "json" })) || freshJob(id);
  const stages = Array.isArray(cur.stages) ? cur.stages.slice() : [];
  if (patch && patch.stage && stages[stages.length - 1] !== patch.stage) stages.push(patch.stage);
  const next = Object.assign({}, cur, patch || {}, { stages, updatedAt: Date.now() });
  await store.setJSON(jobKey(id), next);
  return next;
}

async function saveZip(id, buf) {
  const store = await openStore();
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  await store.set(zipKey(id), body);
  return body.length;
}

async function takeZip(id) {
  const store = await openStore();
  const raw = await store.get(zipKey(id), { type: "arrayBuffer" });
  if (!raw) return null;
  const buf = Buffer.from(raw);
  await store.delete(zipKey(id)).catch(() => {});
  return buf;
}

async function deleteJob(id) {
  const store = await openStore();
  await store.delete(jobKey(id)).catch(() => {});
  await store.delete(zipKey(id)).catch(() => {});
}

module.exports = {
  TTL_MS,
  validJobId,
  setExportStoreForTests,
  bindBlobs,
  createJob,
  readJob,
  updateJob,
  saveZip,
  takeZip,
  deleteJob,
  freshJob,
};
