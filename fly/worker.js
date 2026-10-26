"use strict";

/**
 * One export at a time. Auth, then the same job finish the Netlify
 * background function uses. This file does not detect roofs or trees.
 */

const crypto = require("node:crypto");
const jobs = require("../netlify/lib/export-jobs");
const { HEARTBEAT_MS } = jobs;
const areaCache = require("../netlify/lib/area-cache");
const { completeExportJob } = require("../netlify/lib/export-run");

const BODY_MAX = 2 * 1000 * 1000;
// Fly autostop is off. Exit 0 after this long with no export so the
// machine stops. on-failure does not restart a clean exit.
const IDLE_EXIT_MS = 5 * 60 * 1000;
let inFlight = null;
let inFlightId = "";
let cancelInFlight = null;
let exportRunner = null;

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const want = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === want) return String(headers[keys[i]] || "");
  }
  return "";
}

function pathOf(url) {
  const raw = String(url || "/");
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

function workerSecret() {
  return String(process.env.OPENCLUTTER_WORKER_SECRET || "").trim();
}

function secretOk(headers) {
  const expected = workerSecret();
  if (!expected) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header(headers, "authorization").trim());
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

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

function enableAreaCache() {
  if (process.env.OPENCLUTTER_AREA_CACHE === "0") return;
  try {
    const { getStore } = require("@netlify/blobs");
    const opts = { name: "openclutter-exports" };
    const region = String(process.env.NETLIFY_BLOBS_REGION || "").trim();
    if (region) opts.region = region;
    areaCache.enable(getStore(opts));
  } catch {
    /* The export still runs. A missing tile is fetched on its own. */
  }
}

function jsonResult(statusCode, body) {
  return { statusCode, body };
}

/**
 * headers are a plain object. body is a string.
 * A 202 result may include job, a promise the HTTP server awaits before
 * it ends the response. The promise keeps running if the client leaves.
 */
async function handleWorkerRequest(req) {
  const method = String((req && req.method) || "GET").toUpperCase();
  const path = pathOf(req && req.url);
  if (method === "GET" && (path === "/health" || path === "/")) {
    return jsonResult(200, { ok: true });
  }
  if (method !== "POST" || (path !== "/export" && path !== "/cancel")) {
    return jsonResult(405, { error: "POST /export or /cancel only." });
  }
  if (!secretOk(req && req.headers)) {
    return jsonResult(401, { error: "Unauthorized." });
  }
  let payload = null;
  try {
    payload = JSON.parse((req && req.body) || "");
  } catch {
    return jsonResult(400, { error: "invalid json" });
  }
  if (path === "/cancel") return handleCancel(payload);
  const jobId = payload && payload.jobId;
  const inner = payload && payload.event;
  if (!jobs.validJobId(jobId) || !inner || !inner.body) {
    return jsonResult(400, { error: "Export id is not valid." });
  }
  if (!configureBlobsFromEnv()) {
    return jsonResult(503, { error: "Blob store is not configured." });
  }
  if (inFlight) {
    return jsonResult(409, { error: "An export is already running." });
  }
  const job = runAcceptedJob(jobId, inner);
  inFlight = job;
  inFlightId = jobId;
  job.finally(() => {
    if (inFlight === job) {
      inFlight = null;
      inFlightId = "";
      cancelInFlight = null;
    }
  });
  return { statusCode: 202, body: { ok: true, accepted: true }, job };
}

/**
 * POST /cancel { jobId } with the worker secret. Stops the export this
 * machine is running when the id matches. The job record is already
 * "cancelled" (the page's Cancel wrote it), so a miss here is harmless:
 * the running worker also sees it on its next heartbeat.
 */
function handleCancel(payload) {
  const jobId = payload && payload.jobId;
  if (!jobs.validJobId(jobId)) return jsonResult(400, { error: "Export id is not valid." });
  if (!inFlight || inFlightId !== jobId || typeof cancelInFlight !== "function") {
    return jsonResult(404, { ok: false, running: false });
  }
  cancelInFlight("cancel request");
  return jsonResult(200, { ok: true, cancelled: true });
}

function stageStartLine(jobId, stage, elapsedMs) {
  const elapsed = (Math.max(0, elapsedMs) / 1000).toFixed(1);
  return "export " + jobId + " stage start " + stage + " elapsed " + elapsed + "s";
}

function stageDoneLine(jobId, stage, durationMs) {
  const duration = (Math.max(0, durationMs) / 1000).toFixed(1);
  return "export " + jobId + " stage done " + stage + " duration " + duration + "s";
}

/**
 * One line when a stage starts, one when it finishes. fly logs shows both.
 * elapsed is from the start of this export. duration is that stage only.
 */
function createStageLogger(jobId, opts) {
  const nowFn = (opts && opts.now) || Date.now;
  const log = (opts && opts.log) || ((line) => console.log(line));
  const t0 = nowFn();
  let current = "";
  let currentAt = t0;
  return {
    note(stage) {
      const name = String(stage || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!name || name === current) return;
      const now = nowFn();
      if (current) log(stageDoneLine(jobId, current, now - currentAt));
      current = name;
      currentAt = now;
      log(stageStartLine(jobId, name, now - t0));
    },
    finish() {
      if (!current) return;
      const now = nowFn();
      log(stageDoneLine(jobId, current, now - currentAt));
      current = "";
    },
  };
}

function createWorkerSession(jobId, opts) {
  const logger = createStageLogger(jobId, opts);
  let stage = "Fetching aerial";
  logger.note(stage);
  return {
    stageName() {
      return stage;
    },
    async onProgress(patch) {
      if (!patch || !patch.stage) return;
      stage = String(patch.stage);
      logger.note(stage);
      const tiles =
        patch.tilesTotal > 0
          ? { tilesDone: patch.tilesDone | 0, tilesTotal: patch.tilesTotal | 0 }
          : heartbeatTiles();
      await jobs.writeHeartbeat(jobId, stage, tiles);
    },
    finish() {
      logger.finish();
    },
  };
}

function heartbeatTiles() {
  try {
    return require("../netlify/lib/cpu-pool").tileProgress();
  } catch {
    return null;
  }
}

function startHeartbeatTimer(jobId, getStage, intervalMs, onCancelled) {
  const ms = intervalMs == null ? HEARTBEAT_MS : intervalMs;
  const beat = () => {
    Promise.resolve()
      .then(() =>
        jobs.writeHeartbeat(jobId, typeof getStage === "function" ? getStage() : getStage, heartbeatTiles())
      )
      .then((cur) => {
        // The page's Cancel marks the job; the beat is where this machine sees it.
        if (jobs.isCancelled(cur) && typeof onCancelled === "function") onCancelled("job cancelled");
      })
      .catch(() => {});
  };
  beat();
  const timer = setInterval(beat, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function setExportRunnerForTests(fn) {
  exportRunner = typeof fn === "function" ? fn : null;
}

function machineId() {
  return String(process.env.FLY_MACHINE_ID || "").trim();
}

/**
 * The export races a cancel. On cancel the job answers at once with
 * { ok: true, cancelled: true }; the pipeline is left behind, stores
 * nothing (completeExportJob checks the job before a zip), and the HTTP
 * server exits the process after the answer so fetches and CPU threads
 * stop and the machine is free. The next export starts it again.
 */
async function runAcceptedJob(jobId, inner) {
  enableAreaCache();
  const { cpuStartLine, setExportLog } = require("../netlify/lib/cpu-pool");
  setExportLog(jobId);
  console.log("export " + jobId + " " + cpuStartLine());
  const session = createWorkerSession(jobId);
  let onCancel = null;
  const cancelled = new Promise((resolve) => {
    onCancel = resolve;
  });
  let cancelledOnce = false;
  const cancel = (why) => {
    if (cancelledOnce) return;
    cancelledOnce = true;
    console.log("export " + jobId + " cancelled (" + (why || "cancel") + ") during " + session.stageName() + "; stopping");
    onCancel({ ok: true, finished: false, cancelled: true, reason: "cancelled" });
  };
  cancelInFlight = cancel;
  const machine = machineId();
  if (machine) jobs.updateJob(jobId, { flyMachine: machine }).catch(() => {});
  const timer = startHeartbeatTimer(jobId, () => session.stageName(), null, cancel);
  try {
    const run = exportRunner || completeExportJob;
    const work = Promise.resolve().then(() =>
      run(jobId, inner, {
        worker: "fly",
        onProgress: (patch) => session.onProgress(patch),
      })
    );
    work.catch(() => {});
    return await Promise.race([work, cancelled]);
  } catch {
    return { ok: false, reason: "export-failed" };
  } finally {
    clearInterval(timer);
    session.finish();
  }
}

function cancelRunningForTests(why) {
  if (typeof cancelInFlight === "function") cancelInFlight(why || "test");
}

/**
 * Exit only when no export is in flight and no request is still being
 * read. A hold blocks the exit for that request and does not slide the
 * idle clock, so a health check cannot keep the machine up. An in-flight
 * export slides the clock, including after the client has dropped.
 */
function createIdleExit(opts) {
  const idleMs = opts && opts.idleMs != null ? opts.idleMs : IDLE_EXIT_MS;
  const nowFn = (opts && opts.now) || Date.now;
  const exitFn = (opts && opts.exit) || (() => process.exit(0));
  const inFlightFn = (opts && opts.inFlight) || jobInFlight;
  let idleSince = nowFn();
  let holds = 0;
  let exited = false;
  return {
    hold() {
      holds += 1;
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        if (holds > 0) holds -= 1;
      };
    },
    check() {
      if (exited) return false;
      const now = nowFn();
      if (inFlightFn()) {
        idleSince = now;
        return false;
      }
      if (holds > 0) return false;
      if (now - idleSince >= idleMs) {
        exited = true;
        exitFn();
        return true;
      }
      return false;
    },
  };
}

function jobInFlight() {
  return !!inFlight;
}

module.exports = {
  BODY_MAX,
  HEARTBEAT_MS,
  IDLE_EXIT_MS,
  handleWorkerRequest,
  configureBlobsFromEnv,
  secretOk,
  jobInFlight,
  createStageLogger,
  createWorkerSession,
  startHeartbeatTimer,
  stageStartLine,
  stageDoneLine,
  createIdleExit,
  setExportRunnerForTests,
  cancelRunningForTests,
};
