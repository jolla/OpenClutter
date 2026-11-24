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

/** A Netlify attempt beats every 10 s; one silent this long has died. */
const NETLIFY_DEAD_BEAT_MS = 25 * 1000;

/**
 * Netlify retries a background function whose process died (out of memory
 * or killed), with the same payload. A second full run dies the same way,
 * so the page waited about 8 minutes for three attempts (1.3.94). Returns
 * "none" (no Netlify attempt started this job: run it), "finished" (an
 * earlier attempt already ended it: run nothing), "alive" (another
 * attempt is still beating: leave it), or "dead" (fail the job now).
 * Only export runs reach this; a source-tiles batch never does.
 */
async function priorNetlifyAttempt(readJob, jobId, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const first = await readJob(jobId).catch(() => null);
  if (!first || !first.netlifyStartedAt) return { verdict: "none", job: first };
  // Finished (done, error, cancelled) by an earlier attempt: nothing to run.
  if (first.state !== "running" && first.state !== "queued") return { verdict: "finished", job: first };
  const beat = +first.netlifyBeatAt || +first.netlifyStartedAt;
  if (now() - beat > NETLIFY_DEAD_BEAT_MS) return { verdict: "dead", job: first };
  await sleep(NETLIFY_DEAD_BEAT_MS);
  const again = await readJob(jobId).catch(() => null);
  if (!again || (again.state !== "running" && again.state !== "queued")) return { verdict: "alive", job: again };
  const beat2 = +again.netlifyBeatAt || +again.netlifyStartedAt;
  return { verdict: beat2 > beat ? "alive" : "dead", job: again };
}

function deadAttemptPatch(job) {
  const stage = String((job && job.stage) || "export").slice(0, 80);
  return {
    state: "error",
    stage: "Export failed",
    error: "The export worker stopped during " + stage + " (the backup server ran out of room). Export again. If it happens again, draw a smaller area.",
    stoppedReason: "netlify-retry",
    stoppedStage: stage,
  };
}

module.exports = { NETLIFY_DEAD_BEAT_MS, priorNetlifyAttempt, deadAttemptPatch, NETLIFY_SILENCE_MS, NETLIFY_LIMIT_MS, LEGACY_LIMIT_MS, stalledJobPatch };
