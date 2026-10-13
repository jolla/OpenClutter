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

function currentTiles() {
  try {
    return require("./cpu-pool").tileProgress();
  } catch {
    return null;
  }
}

function withTiles(patch) {
  if (patch && patch.tilesTotal > 0) return patch;
  const tiles = currentTiles();
  if (!tiles || !(tiles.tilesTotal > 0)) return patch;
  return Object.assign({}, patch || {}, {
    tilesDone: tiles.tilesDone | 0,
    tilesTotal: tiles.tilesTotal | 0,
  });
}

/**
 * Netlify has no Fly heartbeat. The same 10 second beat writes tile counts
 * onto the job so the page can move the Trees slice on either path.
 */
function startTilePulse(jobId) {
  try {
    require("./cpu-pool").beginExportTiles();
  } catch {
    /* The export still runs. The button uses the stage weight. */
  }
  const beat = () => {
    const tiles = currentTiles();
    if (!tiles || !(tiles.tilesTotal > 0)) return;
    jobs
      .readJob(jobId)
      .then((cur) => {
        if (!cur || jobs.isTerminalState(cur.state)) return null;
        return jobs.updateJob(jobId, {
          tilesDone: tiles.tilesDone | 0,
          tilesTotal: tiles.tilesTotal | 0,
        });
      })
      .catch(() => {});
  };
  const timer = setInterval(beat, jobs.HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
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
  const stopTiles = startTilePulse(jobId);
  try {
    const result = await runBackgroundExport(inner, async (patch) => {
      if (opts && typeof opts.onProgress === "function") {
        try {
          await opts.onProgress(patch);
        } catch {
          /* A stage note must not fail the export. */
        }
      }
      return jobs.updateJob(jobId, withTiles(patch));
    });
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
  } finally {
    stopTiles();
  }
}

module.exports = { completeExportJob, publicError };
