"use strict";

/**
 * Finish one export job: run the same background pipeline the Netlify
 * function runs, then write the zip and the status into the job store.
 * The Fly worker and the Netlify background function both call this.
 * Detection stays in clutter.js.
 */

const clutter = require("../functions/clutter");
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
async function otherWorkerFinished(jobId, worker) {
  if (!worker) return false;
  const cur = await jobs.readJob(jobId).catch(() => null);
  if (!cur || !jobs.isTerminalState(cur.state)) return false;
  const who = String(cur.worker || "");
  return !!(who && who !== worker);
}

/**
 * Netlify runs have no Fly heartbeat. This beat writes netlifyBeatAt every
 * 10 seconds while the function is alive, with its memory and the stages
 * still open, so export-status can fail a run whose function died (1.3.93).
 */
function maxRssMb() {
  try {
    return Math.round((process.resourceUsage().maxRSS * 1024) / 1e6);
  } catch {
    return null;
  }
}

// Netlify runs this process has started, and its RSS when this one began:
// a warm function reused after a heavy export shows here (1.3.103).
let processRuns = 0;

function startNetlifyBeat(jobId, attempt) {
  processRuns++;
  const runInProcess = processRuns;
  const startRssMb = Math.round(process.memoryUsage.rss() / 1e6);
  let peakRss = 0;
  const sample = () => {
    const r = process.memoryUsage.rss();
    if (r > peakRss) peakRss = r;
  };
  const sampler = setInterval(sample, 500);
  if (typeof sampler.unref === "function") sampler.unref();
  const beat = () => {
    sample();
    let open = [];
    try {
      open = require("./stage-clock").openSpans().slice(0, 6);
    } catch {
      open = [];
    }
    const mem = process.memoryUsage();
    jobs
      .readJob(jobId)
      .then((cur) => {
        // Keep beating after the silence rule failed this attempt: the page
        // is still watching for its late finish (1.3.95).
        const mine = attempt && cur && cur.stoppedAttempt === attempt;
        if (!cur || (jobs.isTerminalState(cur.state) && !mine)) return null;
        return jobs.updateJob(jobId, {
          netlifyBeatAt: Date.now(),
          netlifyBeat: {
            rssMb: Math.round(mem.rss / 1e6),
            peakRssMb: Math.round(peakRss / 1e6),
            // The kernel's high-water mark. peakRssMb is sampled on the main
            // thread, so a long synchronous stage hides its own peak and it
            // shows up at the next stage instead (1.3.101).
            maxRssMb: maxRssMb(),
            runInProcess,
            startRssMb,
            heapMb: Math.round(mem.heapUsed / 1e6),
            limitMb: require("./host-memory").functionMemoryMb() || null,
            open,
          },
        });
      })
      .catch(() => {});
  };
  beat();
  const timer = setInterval(beat, jobs.HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(sampler);
  };
}

const CANCELLED = { ok: true, finished: false, cancelled: true, reason: "cancelled" };

async function completeExportJob(jobId, inner, opts) {
  const warning = opts && opts.warning ? String(opts.warning) : "";
  const worker = opts && opts.worker ? String(opts.worker) : "";
  // Cancelled before it started (page Cancel while queued): run nothing.
  if (await jobs.jobCancelled(jobId)) return CANCELLED;
  // One id per Netlify attempt: only this attempt may replace a silence
  // error with its own late done (1.3.95).
  const attempt = opts && opts.netlifyBeat ? require("node:crypto").randomUUID() : "";
  const mark = (p) => (attempt ? Object.assign(p, { netlifyAttempt: attempt }) : p);
  try {
    const patch = { state: "running", stage: "Fetching aerial" };
    if (worker) patch.worker = worker;
    if (opts && opts.netlifyBeat) {
      patch.netlifyStartedAt = Date.now();
      patch.netlifyBeatAt = Date.now();
      patch.netlifyAttempt = attempt;
    }
    if (warning) patch.warnings = [warning];
    await jobs.updateJob(jobId, patch);
  } catch {
    return { ok: false, reason: "job-write-failed" };
  }
  const stopTiles = startTilePulse(jobId);
  const stopBeat = opts && opts.netlifyBeat ? startNetlifyBeat(jobId, attempt) : () => {};
  try {
    const result = await clutter.runBackgroundExport(inner, async (patch) => {
      if (opts && typeof opts.onProgress === "function") {
        try {
          await opts.onProgress(patch);
        } catch {
          /* A stage note must not fail the export. */
        }
      }
      return jobs.updateJob(jobId, withTiles(patch));
    });
    if (await otherWorkerFinished(jobId, worker)) {
      return { ok: true, finished: false, reason: "other-worker-finished" };
    }
    // Cancelled while it ran: store no zip and no site.
    if (await jobs.jobCancelled(jobId)) return CANCELLED;
    const status = result && result.statusCode;
    let data = {};
    try {
      data = JSON.parse((result && result.body) || "{}");
    } catch {
      data = {};
    }
    // The body string is a third copy of the zip (as base64) once parsed (1.3.101).
    if (result) result.body = null;
    if (status === 200 && data.site) {
      if (await otherWorkerFinished(jobId, worker)) {
        return { ok: true, finished: false, reason: "other-worker-finished" };
      }
      const bytes = await jobs.saveSite(jobId, data.site);
      // Cancel can land while the site is written: drop the stored copy.
      if (await jobs.jobCancelled(jobId)) {
        await jobs.deleteZip(jobId).catch(() => {});
        return CANCELLED;
      }
      await jobs.updateJob(jobId, mark({
        state: "done",
        stage: "Site ready",
        error: null,
        siteBytes: bytes,
        siteStats: data.site.stats || null,
        warnings: withWarning(Array.isArray(data.site.warnings) ? data.site.warnings : [], warning),
        timings: data.site.timings || null,
      }));
      return { ok: true, finished: true };
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
    if (await otherWorkerFinished(jobId, worker)) {
      return { ok: true, finished: false, reason: "other-worker-finished" };
    }
    if (await jobs.jobCancelled(jobId)) return CANCELLED;
    const zip = Buffer.from(data.zipBase64, "base64");
    data.zipBase64 = null;
    await jobs.saveZip(jobId, zip);
    // Cancel can land while the zip is written: drop the stored zip so a
    // cancelled job leaves no file behind.
    if (await jobs.jobCancelled(jobId)) {
      await jobs.deleteZip(jobId).catch(() => {});
      return CANCELLED;
    }
    const warnings = withWarning(Array.isArray(data.warnings) ? data.warnings : [], warning);
    await jobs.updateJob(jobId, mark({
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
    }));
    return { ok: true, finished: true };
  } catch (err) {
    if (await jobs.jobCancelled(jobId)) return CANCELLED;
    if (await otherWorkerFinished(jobId, worker)) {
      return { ok: true, finished: false, reason: "other-worker-finished" };
    }
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
    stopBeat();
  }
}

module.exports = { completeExportJob, publicError };
