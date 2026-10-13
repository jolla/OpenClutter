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
    stageLabel: finished ? job.stageLabel || job.stage : (mark && mark.label) || view.stage || job.stage,
    progress: finished ? 1 : liveFraction(view),
    percent: pct,
    progressCeiling: finished ? 1 : mark ? mark.ceiling : job.progressCeiling == null ? 0 : job.progressCeiling,
    aerialElapsedMs: view.aerialElapsedMs > 0 ? view.aerialElapsedMs : null,
    tilesDone: Number.isFinite(+job.tilesDone) ? job.tilesDone : null,
    tilesTotal: Number.isFinite(+job.tilesTotal) ? job.tilesTotal : null,
    createdAt: job.createdAt || null,
    stages: job.stages || [],
    error: job.error || null,
    stats: job.stats || null,
    warnings: job.warnings || [],
    zipFilename: job.zipFilename || null,
    zipBytes: job.zipBytes || 0,
    terrainClipboard: job.terrainClipboard || null,
    terrainStatus: job.terrainStatus || "",
    gpsClipboard: job.gpsClipboard || null,
    worker: job.worker || job.heartbeatStage || null,
  });
};
