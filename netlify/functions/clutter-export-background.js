"use strict";

const jobs = require("../lib/export-jobs");
const areaCache = require("../lib/area-cache");
const { completeExportJob } = require("../lib/export-run");
const { FALLBACK_NOTE, handOffExport } = require("../lib/fly-handoff");

function enableAreaCache() {
  if (process.env.OPENCLUTTER_AREA_CACHE === "0") return;
  try {
    const { getStore } = require("@netlify/blobs");
    areaCache.enable(getStore({ name: "openclutter-exports" }));
  } catch {
    /* A missing blob context leaves the cache off. The export still runs. */
  }
}

/**
 * Up to 15 minutes on Netlify. The handler awaits the pipeline, or the Fly
 * worker when both FLY_WORKER_URL and FLY_WORKER_SECRET are set. The
 * platform already answered 202 to the sync function that invoked this.
 * If either value is missing, this is the same background export as before.
 * If the worker does not accept the job, this path runs it and the job says so.
 */
exports.handler = async (event) => {
  jobs.bindBlobs(event);
  if (event && event.blobs) enableAreaCache();
  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 202, body: "" };
  }
  if (payload.mode === "source-tiles") {
    try {
      const { getStore } = require("@netlify/blobs");
      areaCache.enable(getStore({ name: "openclutter-exports" }));
      await areaCache.runTileBatch(payload);
    } catch {
      /* The parent export fetches a tile itself when a partial is missing. */
    }
    return { statusCode: 202, body: "" };
  }
  const jobId = payload.jobId;
  const inner = payload.event;
  if (!jobs.validJobId(jobId) || !inner || !inner.body) return { statusCode: 202, body: "" };

  const fly = await handOffExport(jobId, inner);
  if (fly.handed) return { statusCode: 202, body: "" };
  if (fly.fallback) {
    const current = await jobs.readJob(jobId).catch(() => null);
    if (
      current &&
      current.worker === "fly" &&
      (current.state === "running" || current.state === "done" || current.state === "error")
    ) {
      return { statusCode: 202, body: "" };
    }
    await jobs.updateJob(jobId, { workerFallback: fly.reason || "invoke-failed" }).catch(() => {});
  }
  await completeExportJob(jobId, inner, fly.fallback ? { warning: FALLBACK_NOTE } : undefined);
  return { statusCode: 202, body: "" };
};
