"use strict";

/**
 * Export jobs live in Netlify Blobs. The sync function writes the job id.
 * The background function writes stages and the zip. A status read drops a
 * job that is older than 24 hours. The zip and the terrain JSON on the job
 * stay for those 24 hours so the page can download or copy them again.
 * Blobs have no server-side TTL, so the expiry is checked on read, and a new
 * export sweeps a bounded batch of expired jobs so stored zips do not pile up.
 *
 * The Fly worker also writes a heartbeat on this same job while an export
 * runs. The heartbeat is the current stage name, a timestamp, and tile
 * counts. Aerial uses tiles finished during the fetch. Trees uses tiles
 * finished in that queue. Netlify treats a gap of
 * HEARTBEAT_STALE_MS as a stopped worker.
 */

const { markStage, stageKey } = require("./export-progress");

const STORE_NAME = "openclutter-exports";
const TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 30 * 60 * 1000;
const SWEEP_MAX_READS = 200;
let lastSweepAt = 0;
// The worker writes this often. A long CPU stage (buildings on a large
// draw) can block the event loop for well over a minute, so the stale
// window is five minutes. A machine that has actually stopped still
// falls back; a live export that is mid-stage does not.
const HEARTBEAT_MS = 10 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
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

/**
 * A heartbeat may repeat a stage or move to a later one. It must not
 * put an earlier label back on the job, or the status line freezes
 * on the first stage after a newer one was already written.
 */
function stageMovesForward(current, next) {
  const name = String(next || "").trim();
  if (!name) return false;
  const prev = String(current || "").trim();
  if (!prev) return true;
  if (name === prev) return false;
  const ahead = markStage(name).progress + 1e-9 >= markStage(prev).progress;
  return ahead;
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
  maybeSweepExpired().catch(() => {});
  return job;
}

/**
 * Delete jobs (and their zips) past expiresAt. Reads at most
 * SWEEP_MAX_READS job records, and runs at most every SWEEP_EVERY_MS per
 * instance. A zip with no job record left is deleted too.
 */
async function sweepExpired(now) {
  const store = await openStore();
  if (!store || typeof store.list !== "function") return 0;
  const clock = now > 0 ? now : Date.now();
  const listed = await store.list({ prefix: "job/" });
  const keys = ((listed && listed.blobs) || []).map((b) => b.key);
  const have = new Set(keys);
  let reads = 0;
  let dropped = 0;
  for (const key of keys) {
    const zipMatch = /^job\/([^/]+)\/(zip|site-v1)$/.exec(key);
    if (zipMatch) {
      if (!have.has(jobKey(zipMatch[1]))) {
        await store.delete(key).catch(() => {});
        dropped += 1;
      }
      continue;
    }
    const m = /^job\/([^/]+)$/.exec(key);
    if (!m || reads >= SWEEP_MAX_READS) continue;
    reads += 1;
    const job = await store.get(key, { type: "json" }).catch(() => null);
    if (job && job.expiresAt && clock > job.expiresAt) {
      await store.delete(key).catch(() => {});
      await store.delete(zipKey(m[1])).catch(() => {});
      await store.delete(siteKey(m[1])).catch(() => {});
      dropped += 1;
    }
  }
  return dropped;
}

async function maybeSweepExpired() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_EVERY_MS) return 0;
  lastSweepAt = now;
  return sweepExpired(now);
}

async function readJob(id) {
  if (!validJobId(id)) return null;
  const store = await openStore();
  const job = await store.get(jobKey(id), { type: "json" });
  if (!job) return null;
  if (job.expiresAt && Date.now() > job.expiresAt) {
    await store.delete(jobKey(id)).catch(() => {});
    await store.delete(zipKey(id)).catch(() => {});
    await store.delete(siteKey(id)).catch(() => {});
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

let strongReadsOk = true;

async function loadJobRecord(store, id) {
  const key = jobKey(id);
  if (store && typeof store.getWithMetadata === "function") {
    let row;
    try {
      row = strongReadsOk
        ? await store.getWithMetadata(key, { type: "json", consistency: "strong" })
        : await store.getWithMetadata(key, { type: "json" });
    } catch (err) {
      // v1 functions and the Fly worker lack uncachedEdgeURL. Fall back to an
      // eventual read; the etag + onlyIfMatch write still guards conflicts.
      if (!/uncachedEdgeURL|strong consistency/i.test(String(err && err.message))) throw err;
      strongReadsOk = false;
      row = await store.getWithMetadata(key, { type: "json" });
    }
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
/**
 * Finished export steps for the page checklist, keyed by id. Each entry is
 * { done, skipped, detail, at }. Older pages ignore this field.
 */
const STEP_IDS = ["aerial", "terrain", "buildings", "trees", "vehicles", "zip"];

function mergeStep(prev, step) {
  if (!step || STEP_IDS.indexOf(step.id) < 0) return null;
  const next = Object.assign({}, prev && typeof prev === "object" ? prev : {});
  next[step.id] = {
    done: !step.skipped,
    skipped: !!step.skipped,
    detail: String(step.detail || "").slice(0, 60),
    at: Date.now(),
  };
  return next;
}

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
  const keyChanged = !!(incoming.stage && stageKey(cur.stage) !== stageKey(incoming.stage));
  if (incoming.tilesDone != null || incoming.tilesTotal != null) {
    const total = +incoming.tilesTotal;
    const done = +incoming.tilesDone;
    const prevTotal = +cur.tilesTotal;
    const prevDone = +cur.tilesDone;
    const lower =
      !(total > 0) ||
      !Number.isFinite(done) ||
      (prevTotal > 0 && Number.isFinite(prevDone) && done / total + 1e-9 < prevDone / prevTotal);
    if (lower && !keyChanged) {
      delete incoming.tilesDone;
      delete incoming.tilesTotal;
    }
  } else if (keyChanged) {
    incoming.tilesDone = null;
    incoming.tilesTotal = null;
  }
  let steps = null;
  if (incoming.step) {
    steps = mergeStep(cur.steps, incoming.step);
    delete incoming.step;
    if (steps) incoming.steps = steps;
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

function siteKey(id) {
  return "job/" + id + "/site-v1";
}

/** Direct API v1 result. Stored as JSON text next to the job record. */
async function saveSite(id, site) {
  const store = await openStore();
  const text = typeof site === "string" ? site : JSON.stringify(site);
  await store.set(siteKey(id), text);
  return Buffer.byteLength(text);
}

async function readSite(id) {
  const store = await openStore();
  const text = await store.get(siteKey(id), { type: "text" });
  if (!text) return null;
  return JSON.parse(text);
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
  await store.delete(siteKey(id)).catch(() => {});
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
 * Tile counts ride along with the stage. A beat that would lower the
 * fraction is ignored, so a later queue cannot pull the bar backward.
 * Missing counts leave the previous tiles on the job.
 */
function tilePatch(cur, extra, replace) {
  if (!extra) return null;
  const total = +extra.tilesTotal;
  const done = +extra.tilesDone;
  if (!(total > 0) || !Number.isFinite(done)) return null;
  const next = {
    tilesDone: Math.max(0, Math.min(Math.floor(total), Math.floor(done))),
    tilesTotal: Math.max(1, Math.floor(total)),
  };
  if (replace) return next;
  const prevTotal = +cur.tilesTotal;
  const prevDone = +cur.tilesDone;
  if (prevTotal > 0 && Number.isFinite(prevDone)) {
    if (next.tilesDone / next.tilesTotal + 1e-9 < prevDone / prevTotal) return null;
  }
  return next;
}

/**
 * Stamp the job the worker is still running. A done or failed job is
 * terminal: a late beat refreshes nothing, including heartbeatAt.
 * The beat is written only while state is still queued or running.
 * extra may carry tilesDone and tilesTotal for the aerial fetch or the
 * Trees slice. A new stage replaces those counts.
 */
async function writeHeartbeat(id, stage, extra) {
  if (!validJobId(id)) return null;
  const cur = await readJob(id);
  if (!cur) return null;
  if (isTerminalState(cur.state)) return cur;
  if (cur.state !== "running" && cur.state !== "queued") return cur;
  const name = String(stage || cur.heartbeatStage || cur.stage || "")
    .replace(/\s+/g, " ")
    .trim();
  const shown = cur.stage || cur.heartbeatStage || "";
  const forward = stageMovesForward(shown, name);
  const patch = {
    heartbeatAt: Date.now(),
    heartbeatStage: forward || !shown ? name : String(shown),
  };
  if (forward) patch.stage = name;
  if (/^Fetching (aerial|map)\b/i.test(patch.heartbeatStage || name)) {
    const now = Date.now();
    const started = cur.aerialStartedAt || cur.createdAt || now;
    if (!cur.aerialStartedAt) patch.aerialStartedAt = started;
    const elapsed = Math.max(0, now - started);
    if (!(+cur.aerialElapsedMs >= elapsed)) patch.aerialElapsedMs = elapsed;
  }
  const tiles = tilePatch(cur, extra, forward && stageKey(shown) !== stageKey(name));
  if (tiles) {
    patch.tilesDone = tiles.tilesDone;
    patch.tilesTotal = tiles.tilesTotal;
  }
  return updateJob(id, patch);
}

module.exports = {
  TTL_MS,
  sweepExpired,
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
  saveSite,
  readSite,
  deleteZip,
  takeZip,
  deleteJob,
  freshJob,
  writeHeartbeat,
  isTerminalState,
  mergeJobPatch,
  stageMovesForward,
};
