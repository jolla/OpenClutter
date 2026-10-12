"use strict";

/**
 * Finish one export job: run the same background pipeline the Netlify
 * function runs, then write the zip and the status into the job store.
 * The Fly worker and the Netlify background function both call this.
 * Detection stays in clutter.js.
 */

const { runBackgroundExport } = require("../functions/clutter");
const jobs = require("./export-jobs");

function publicError(err) {
  const msg = err && err.message ? String(err.message) : "Export failed.";
  if (/aborted due to timeout|timed out/i.test(msg)) {
    return "Export timed out. Draw a smaller area and try again.";
  }
  return msg;
}

function withWarning(list, warning) {
  const warnings = Array.isArray(list) ? list.slice() : [];
  if (warning && warnings.indexOf(warning) < 0) warnings.unshift(warning);
  return warnings;
}

/**
 * Returns { ok: true } when the job record was updated (done or error).
 * Returns { ok: false } when the job store could not be written, so the
 * caller can run the Netlify path instead.
 */
async function completeExportJob(jobId, inner, opts) {
  const warning = opts && opts.warning ? String(opts.warning) : "";
  const worker = opts && opts.worker ? String(opts.worker) : "";
  try {
    const patch = { state: "running", stage: "Fetching aerial" };
    if (worker) patch.worker = worker;
    if (warning) patch.warnings = [warning];
    await jobs.updateJob(jobId, patch);
  } catch {
    return { ok: false, reason: "job-write-failed" };
  }
  try {
    const result = await runBackgroundExport(inner, (patch) => jobs.updateJob(jobId, patch));
    const status = result && result.statusCode;
    let data = {};
    try {
      data = JSON.parse((result && result.body) || "{}");
    } catch {
      data = {};
    }
    if (status !== 200 || !data.zipBase64) {
      const why =
        data.error ||
        (status && status !== 200 ? "Export failed (" + status + ")." : "Export finished without a zip.");
      const errPatch = {
        state: "error",
        stage: "Export failed",
        error: why,
      };
      if (warning) errPatch.warnings = withWarning([], warning);
      await jobs.updateJob(jobId, errPatch);
      return { ok: true, finished: false };
    }
    const zip = Buffer.from(data.zipBase64, "base64");
    await jobs.saveZip(jobId, zip);
    const warnings = withWarning(Array.isArray(data.warnings) ? data.warnings : [], warning);
    await jobs.updateJob(jobId, {
      state: "done",
      stage: "Zip ready",
      error: null,
      zipFilename: data.zipFilename || "openclutter.zip",
      zipBytes: zip.length,
      stats: data.stats || null,
      warnings,
      terrainClipboard: data.terrainClipboard || null,
      terrainStatus: data.terrainStatus || "",
      gpsClipboard: data.gpsClipboard || null,
      timings: data.timings || null,
    });
    return { ok: true, finished: true };
  } catch (err) {
    const errPatch = {
      state: "error",
      stage: "Export failed",
      error: publicError(err),
    };
    if (warning) errPatch.warnings = withWarning([], warning);
    await jobs.updateJob(jobId, errPatch).catch(() => {});
    return { ok: true, finished: false };
  }
}

module.exports = { completeExportJob, publicError };
