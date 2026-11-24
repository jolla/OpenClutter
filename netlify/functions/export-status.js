"use strict";

const jobs = require("../lib/export-jobs");
const { markStage, exportPercent, liveFraction } = require("../lib/export-progress");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function json(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ "content-type": "application/json" }, cors),
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  jobs.bindBlobs(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  const q = event.queryStringParameters || {};
  const id = q.job || q.id;
  if (!jobs.validJobId(id)) return json(400, { error: "Export id is not valid." });
  let job;
  try {
    job = await jobs.readJob(id);
  } catch {
    return json(503, { error: "Export status is unavailable. Export again." });
  }
  if (!job) return json(404, { error: "This export expired. Export again." });
  if (job.state === "queued") {
    await jobs.kickStart(id).catch(() => {});
    job = (await jobs.readJob(id).catch(() => job)) || job;
  }
  // A platform kill (OOM or function deadline) cannot catch and write its
  // own error. Evaluate against the latest record under the update lock.
  const { stalledJobPatch } = require("../lib/job-watchdog");
  if (stalledJobPatch(job)) {
    job = await jobs.updateJob(id, (cur) => stalledJobPatch(cur)).catch(() => job);
  }
  const beat = String(job.heartbeatStage || "");
  const stored = String(job.stage || "");
  const live =
    (job.state === "running" || job.state === "queued") && beat && jobs.stageMovesForward(stored, beat)
      ? beat
      : stored || beat;
  const view = Object.assign({}, job, { stage: live || job.stage || beat });
  if (/^Fetching (aerial|map)\b/i.test(String(view.stage || ""))) {
    const started = Number(view.aerialStartedAt || view.createdAt);
    let elapsed = started > 0 ? Math.max(0, Date.now() - started) : 0;
    if (+view.aerialElapsedMs > elapsed) elapsed = +view.aerialElapsedMs;
    if (elapsed > 0) view.aerialElapsedMs = elapsed;
  }
  const mark = view.stage ? markStage(view.stage) : null;
  const finished = job.state === "done";
  const pct = finished ? 100 : exportPercent(view, 0);
  return json(200, {
    ok: job.state !== "error",
    state: job.state,
    stage: view.stage || job.stage,
    stageLabel: finished
      ? job.stageLabel || job.stage
      : job.state === "queued"
        ? job.stageLabel || "Waiting for a worker"
        : (mark && mark.label) || view.stage || job.stage,
    concurrencyWait: job.state === "queued" && !!job.concurrencyWait,
    queueReason: job.state === "queued" ? job.queueReason || null : null,
    progress: finished ? 1 : liveFraction(view),
    percent: pct,
    progressCeiling: finished ? 1 : mark ? mark.ceiling : job.progressCeiling == null ? 0 : job.progressCeiling,
    aerialElapsedMs: view.aerialElapsedMs > 0 ? view.aerialElapsedMs : null,
    tilesDone: Number.isFinite(+job.tilesDone) ? job.tilesDone : null,
    tilesTotal: Number.isFinite(+job.tilesTotal) ? job.tilesTotal : null,
    createdAt: job.createdAt || null,
    stages: job.stages || [],
    steps: job.steps || {},
    error: job.error || null,
    // No attempt id is exposed. The page keeps watching only this job
    // until its platform clock runs out (1.3.95).
    lateDoneWaitMs: require("../lib/job-watchdog").lateDoneWindowMs(job),
    lateDone: !!job.lateDone,
    stats: job.stats || null,
    warnings: job.warnings || [],
    zipFilename: job.zipFilename || null,
    zipBytes: job.zipBytes || 0,
    terrainClipboard: job.terrainClipboard || null,
    terrainStatus: job.terrainStatus || "",
    gpsClipboard: job.gpsClipboard || null,
    // Only the worker that took the job (fly or netlify), or none. A stage
    // name is not a worker (1.3.96).
    worker: job.worker === "fly" || job.worker === "netlify" ? job.worker : null,
    netlifyBeatAt: job.netlifyBeatAt || null,
    netlifyBeat: job.netlifyBeat || null,
  });
};
