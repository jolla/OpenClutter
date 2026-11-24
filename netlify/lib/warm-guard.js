"use strict";

/**
 * Warm Netlify reuse after a heavy export (1.3.102).
 *
 * Node does not give an export's memory back to the system, and Netlify
 * reuses a warm function for the next background job. Right after a Fort
 * Wilderness run the process still held about 1 GB, so the next export died
 * in "Fetching aerial" ("the backup server ran out of room").
 *
 * On a low-memory host only:
 * - after a Netlify run that leaves the process large, exit it, so the next
 *   job starts in a fresh function. The platform retries this invocation;
 *   the retry finds the job finished and does nothing (1.3.94 check).
 * - before a Netlify run, if the process is already large, exit before the
 *   run starts so the platform retries the job cold, at most twice; the
 *   last allowed attempt runs anyway.
 * Fly, the benches, and roomy hosts never reach this.
 */
const DIRTY_FRACTION = 0.375;
const MAX_COLD_RETRIES = 2;

function limitBytes() {
  const mb = require("./host-memory").functionMemoryMb() || 1024;
  return mb * 1024 * 1024;
}

function rssBytes() {
  return process.memoryUsage.rss();
}

function dirty(deps = {}) {
  if (!require("./host-memory").lowMemoryHost()) return false;
  const rss = deps.rss ? deps.rss() : rssBytes();
  return rss > limitBytes() * DIRTY_FRACTION;
}

function mb(b) {
  return Math.round(b / 1e6);
}

/** "run" or "exiting". Call right before a Netlify export run. */
async function beforeRun(jobId, deps = {}) {
  if (!dirty(deps)) return "run";
  const jobs = deps.jobs || require("./export-jobs");
  const exit = deps.exit || ((code) => process.exit(code));
  const cur = await jobs.readJob(jobId).catch(() => null);
  const n = (cur && +cur.coldRetries) || 0;
  if (n >= MAX_COLD_RETRIES) return "run";
  const rss = mb(deps.rss ? deps.rss() : rssBytes());
  await jobs.updateJob(jobId, { coldRetries: n + 1, coldRetryRssMb: rss }).catch(() => {});
  process.stderr.write("warm-guard: " + rss + " MB at start, exiting for a cold retry (" + (n + 1) + ")\n");
  exit(1);
  return "exiting";
}

/** Call after a Netlify export run has written its result. */
async function afterRun(jobId, deps = {}) {
  if (!dirty(deps)) return false;
  const jobs = deps.jobs || require("./export-jobs");
  const exit = deps.exit || ((code) => process.exit(code));
  const rss = mb(deps.rss ? deps.rss() : rssBytes());
  await jobs.updateJob(jobId, { recycledRssMb: rss }).catch(() => {});
  process.stderr.write("warm-guard: " + rss + " MB after the export, exiting so the next job starts fresh\n");
  exit(0);
  return true;
}

module.exports = { beforeRun, afterRun, dirty, DIRTY_FRACTION, MAX_COLD_RETRIES };
