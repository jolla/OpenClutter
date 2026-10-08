"use strict";

const jobs = require("../lib/export-jobs");

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
  return json(200, {
    ok: job.state !== "error",
    state: job.state,
    stage: job.stage,
    stages: job.stages || [],
    error: job.error || null,
    stats: job.stats || null,
    warnings: job.warnings || [],
    zipFilename: job.zipFilename || null,
    zipBytes: job.zipBytes || 0,
    terrainClipboard: job.terrainClipboard || null,
    terrainStatus: job.terrainStatus || "",
    gpsClipboard: job.gpsClipboard || null,
  });
};
