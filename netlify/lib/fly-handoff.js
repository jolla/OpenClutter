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
 */

const FALLBACK_NOTE = "Fly worker did not accept this export. It is running on the Netlify background path.";
const HANDOFF_MS = 14 * 60 * 1000 + 30 * 1000;

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
      /* A heartbeat line is not the result. */
    }
  }
  return {};
}

/**
 * fetchImpl is for tests. Production uses global fetch.
 * Returns { skipped, handed, fallback, reason }.
 */
async function handOffExport(jobId, inner, fetchImpl) {
  const cfg = flyWorkerConfig();
  if (!cfg) return { skipped: true, handed: false, fallback: false };
  const fetchFn = fetchImpl || globalThis.fetch;
  try {
    const res = await fetchFn(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + cfg.secret,
      },
      body: JSON.stringify({ jobId, event: inner }),
      signal: AbortSignal.timeout(HANDOFF_MS),
    });
    const text = await res.text();
    if (res.status !== 202 && res.status !== 200) {
      return { skipped: false, handed: false, fallback: true, reason: "invoke-" + res.status };
    }
    const data = parseWorkerBody(text);
    if (data.ok === true) return { skipped: false, handed: true, fallback: false };
    return { skipped: false, handed: false, fallback: true, reason: "worker-rejected" };
  } catch {
    return { skipped: false, handed: false, fallback: true, reason: "invoke-failed" };
  }
}

module.exports = {
  FALLBACK_NOTE,
  HANDOFF_MS,
  flyWorkerConfig,
  exportUrl,
  parseWorkerBody,
  handOffExport,
};
