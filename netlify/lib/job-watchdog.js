"use strict";

const NETLIFY_SILENCE_MS = 2 * 60 * 1000;
const NETLIFY_LIMIT_MS = 16 * 60 * 1000;
const LEGACY_LIMIT_MS = 20 * 60 * 1000;

/** Pure so status reads and tests use exactly the same rule. */
function stalledJobPatch(job, now = Date.now()) {
  if (!job || (job.state !== "running" && job.state !== "queued")) return null;
  const age = now - (+job.createdAt || now);
  const netStart = +job.netlifyStartedAt || 0;
  const beat = +job.netlifyBeatAt || netStart;
  let reason = "";
  if (job.worker === "netlify" && netStart && now - netStart > NETLIFY_LIMIT_MS) reason = "deadline";
  else if (job.worker === "netlify" && beat && now - beat > NETLIFY_SILENCE_MS) reason = "heartbeat-stale";
  // Old workers have no Netlify beat. Never leave a dead run marked running
  // until the 24 hour job TTL. Allow more than both 15 minute platform/page
  // clocks, including the handoff wait, before failing a legacy run.
  else if (age > LEGACY_LIMIT_MS && !job.concurrencyWait) reason = "export-deadline";
  if (!reason) return null;
  const stage = String(job.stage || "export").slice(0, 80);
  return {
    state: "error",
    stage: "Export failed",
    error: "The export worker stopped during " + stage + ". Export again. If it happens again, draw a smaller area.",
    stoppedReason: reason,
    stoppedStage: stage,
  };
}

module.exports = { NETLIFY_SILENCE_MS, NETLIFY_LIMIT_MS, LEGACY_LIMIT_MS, stalledJobPatch };
