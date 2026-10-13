"use strict";

/**
 * Hand a queued export to the Fly worker.
 *
 * Both FLY_WORKER_URL and FLY_WORKER_SECRET must be set. If either is
 * missing, the caller keeps the Netlify background path and this module
 * does not call out. The Fly machine stores the same secret as
 * OPENCLUTTER_WORKER_SECRET, because Fly rejects env names that start
 * with FLY_.
 *
 * The worker holds the HTTP response open until the zip is stored. This
 * wait stays inside the Netlify background function, which already has
 * the long clock. The page still gets a job id from the short request.
 *
 * A heartbeat is not required before that POST. The worker that is live
 * before this deploy never writes one. After the POST, a beat older than
 * HEARTBEAT_STALE_MS, or no beat for that long, means the machine stopped.
 * The caller then runs the job here, or marks it failed when the page or
 * this function has under RERUN_MIN_MS left.
 */

const jobs = require("./export-jobs");
const { HEARTBEAT_STALE_MS } = jobs;

const FALLBACK_NOTE = "Fly worker did not accept this export. It is running on the Netlify background path.";
const RERUN_NOTE = "The export worker stopped. The job was run here instead.";
const HANDOFF_MS = 14 * 60 * 1000 + 30 * 1000;
const HEARTBEAT_POLL_MS = 5 * 1000;
// The page polls for 15 minutes. The background function stops one minute
// before the platform kills it. A second run needs at least two minutes
// on both of those clocks, or the job is failed instead of left running.
const PAGE_MS = 15 * 60 * 1000;
const FUNCTION_ANSWER_MS = PAGE_MS - 60 * 1000;
const RERUN_MIN_MS = 2 * 60 * 1000;

let testDeps = null;

function setHandoffDepsForTests(deps) {
  testDeps = deps || null;
}

function flyWorkerConfig() {
  const url = String(process.env.FLY_WORKER_URL || "").trim();
  const secret = String(process.env.FLY_WORKER_SECRET || "").trim();
  if (!url || !secret) return null;
  return { url: exportUrl(url), secret };
}

function exportUrl(base) {
  const trimmed = String(base || "").replace(/\/$/, "");
  if (/\/export$/i.test(trimmed)) return trimmed;
  return trimmed + "/export";
}

function parseWorkerBody(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].charAt(0) !== "{") continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* A newline keep-alive is not the result. */
    }
  }
  return {};
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function workerStoppedMessage(stage) {
  const name = String(stage || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return "The export worker stopped. Export again.";
  return "The export worker stopped during " + name + ". Export again.";
}

function stageOf(job) {
  if (!job) return "";
  return String(job.heartbeatStage || job.stage || "")
    .replace(/\s+/g, " ")
    .trim();
}

function heartbeatIsStale(heartbeatAt, now, startedAt, staleMs) {
  const windowMs = staleMs == null ? HEARTBEAT_STALE_MS : staleMs;
  const anchor =
    typeof heartbeatAt === "number" && Number.isFinite(heartbeatAt) ? heartbeatAt : startedAt;
  return now - anchor >= windowMs;
}

function rerunHasRoom(job, now, startedAt) {
  const created = job && typeof job.createdAt === "number" ? job.createdAt : startedAt;
  const pageLeft = created + PAGE_MS - now;
  const fnLeft = startedAt + FUNCTION_ANSWER_MS - now;
  return pageLeft >= RERUN_MIN_MS && fnLeft >= RERUN_MIN_MS;
}

function mustLeave(job, now, startedAt) {
  const created = job && typeof job.createdAt === "number" ? job.createdAt : startedAt;
  return now >= startedAt + HANDOFF_MS || now >= created + PAGE_MS;
}

function clockFns() {
  const deps = testDeps || {};
  return {
    nowFn: typeof deps.now === "function" ? deps.now : Date.now,
    sleepFn: typeof deps.sleep === "function" ? deps.sleep : sleep,
    pollMs: deps.pollMs != null ? deps.pollMs : HEARTBEAT_POLL_MS,
    staleMs: deps.staleMs != null ? deps.staleMs : HEARTBEAT_STALE_MS,
  };
}

async function inspectJob(jobId, startedAt, nowFn, staleMs) {
  const now = nowFn();
  const job = await jobs.readJob(jobId).catch(() => null);
  const stage = stageOf(job);
  const room = rerunHasRoom(job, now, startedAt);
  if (job && job.worker === "fly" && (job.state === "done" || job.state === "error")) {
    return { action: "finished", job, stage, room };
  }
  const beat =
    job && typeof job.heartbeatAt === "number" && Number.isFinite(job.heartbeatAt)
      ? job.heartbeatAt
      : null;
  const stale = heartbeatIsStale(beat, now, startedAt, staleMs);
  if (stale) return { action: "stale", job, stage, room };
  if (mustLeave(job, now, startedAt)) return { action: "stay", job, stage, room };
  return { action: "wait", job, stage, room };
}

function toResult(decision) {
  if (decision.action === "finished") {
    return { skipped: false, handed: true, fallback: false, stay: false, reason: "worker-finished" };
  }
  if (decision.action === "stay") {
    return { skipped: false, handed: false, fallback: false, stay: true, reason: "heartbeat-fresh" };
  }
  return {
    skipped: false,
    handed: false,
    fallback: true,
    stay: false,
    dead: true,
    reason: "heartbeat-stale",
    stage: decision.stage || "",
    outOfRoom: !decision.room,
  };
}

async function watchAfterDrop(jobId, startedAt, nowFn, sleepFn, pollMs, staleMs) {
  let decision = await inspectJob(jobId, startedAt, nowFn, staleMs);
  if (decision.action === "finished") return toResult(decision);
  const accepted = !!(decision.job && decision.job.worker === "fly" && decision.job.state === "running");
  const beat = !!(decision.job && typeof decision.job.heartbeatAt === "number");
  if (!accepted && !beat) {
    return { skipped: false, handed: false, fallback: true, stay: false, reason: "invoke-failed" };
  }
  while (decision.action === "wait") {
    await sleepFn(pollMs);
    decision = await inspectJob(jobId, startedAt, nowFn, staleMs);
  }
  return toResult(decision);
}

/**
 * fetchImpl is for tests. Production uses global fetch.
 * Returns { skipped, handed, fallback, stay, reason, stage, outOfRoom }.
 * The POST starts before any heartbeat is read.
 */
async function handOffExport(jobId, inner, fetchImpl) {
  const cfg = flyWorkerConfig();
  if (!cfg) return { skipped: true, handed: false, fallback: false, stay: false };
  const { sleepFn } = clockFns();
  let result = null;
  for (let attempt = 0; attempt <= BUSY_RETRY_MS.length; attempt++) {
    result = await handOffOnce(jobId, inner, fetchImpl, cfg);
    if (!isBusyResult(result) || attempt === BUSY_RETRY_MS.length) break;
    await sleepFn(BUSY_RETRY_MS[attempt]);
  }
  return result;
}

// A busy machine answers 409. The Fly proxy answers 429 or 503 when every
// machine is at its hard limit or still starting. Each retry lets the proxy
// start or pick another machine before the job falls back to Netlify.
const BUSY_STATUSES = [409, 429, 502, 503];
const BUSY_RETRY_MS = [3000, 6000, 10000];

function isBusyResult(result) {
  if (!result || !result.fallback || typeof result.reason !== "string") return false;
  const m = /^invoke-(\d+)$/.exec(result.reason);
  return !!m && BUSY_STATUSES.includes(Number(m[1]));
}

async function handOffOnce(jobId, inner, fetchImpl, cfg) {
  const { nowFn, sleepFn, pollMs, staleMs } = clockFns();
  const fetchFn = fetchImpl || globalThis.fetch;
  const startedAt = nowFn();
  const controller = new AbortController();
  const hard = setTimeout(() => controller.abort(), HANDOFF_MS);
  if (typeof hard.unref === "function") hard.unref();

  let settled = null;
  const fetchPromise = Promise.resolve()
    .then(() =>
      fetchFn(cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + cfg.secret,
        },
        body: JSON.stringify({ jobId, event: inner }),
        signal: controller.signal,
      })
    )
    .then(async (res) => {
      const status = res && typeof res.status === "number" ? res.status : 0;
      if (status !== 202 && status !== 200) {
        let text = "";
        try {
          text = res && typeof res.text === "function" ? await res.text() : "";
        } catch {
          text = "";
        }
        settled = { kind: "http", status, text };
        return;
      }
      try {
        const text = await res.text();
        settled = { kind: "body", status, text };
      } catch (err) {
        settled = { kind: "drop", error: err };
      }
    })
    .catch((err) => {
      if (!settled) settled = { kind: "drop", error: err };
    });

  try {
    while (!settled) {
      const which = await Promise.race([
        fetchPromise.then(() => "done", () => "done"),
        Promise.resolve("check"),
      ]);
      if (settled || which === "done") {
        if (!settled) await fetchPromise;
        break;
      }
      const decision = await inspectJob(jobId, startedAt, nowFn, staleMs);
      if (settled) break;
      if (decision.action !== "wait") {
        controller.abort();
        return toResult(decision);
      }
      await Promise.race([
        fetchPromise.then(() => "done", () => "done"),
        sleepFn(pollMs).then(() => "tick"),
      ]);
    }
  } finally {
    clearTimeout(hard);
  }

  if (!settled) {
    try {
      await fetchPromise;
    } catch {
      /* The catch on fetchPromise already recorded the drop. */
    }
  }

  if (!settled || settled.kind === "drop") {
    return watchAfterDrop(jobId, startedAt, nowFn, sleepFn, pollMs, staleMs);
  }
  if (settled.kind === "http") {
    return {
      skipped: false,
      handed: false,
      fallback: true,
      stay: false,
      reason: "invoke-" + (settled.status || "failed"),
    };
  }
  const data = parseWorkerBody(settled.text);
  if (data.ok === true) {
    return { skipped: false, handed: true, fallback: false, stay: false };
  }
  return { skipped: false, handed: false, fallback: true, stay: false, reason: "worker-rejected" };
}

module.exports = {
  FALLBACK_NOTE,
  RERUN_NOTE,
  HANDOFF_MS,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_POLL_MS,
  PAGE_MS,
  FUNCTION_ANSWER_MS,
  RERUN_MIN_MS,
  setHandoffDepsForTests,
  flyWorkerConfig,
  exportUrl,
  parseWorkerBody,
  workerStoppedMessage,
  heartbeatIsStale,
  rerunHasRoom,
  handOffExport,
  isBusyResult,
  BUSY_RETRY_MS,
};
