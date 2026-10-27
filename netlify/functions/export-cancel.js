"use strict";

/**
 * POST /api/export-cancel?job=<id>. The page's Cancel on the Exporting
 * button. Same access as export-status: the job id is the key. Marks the
 * job cancelled (terminal, so no zip is stored for it) and asks the Fly
 * machine running it to stop now. The worker also sees the mark on its
 * next heartbeat, so a request the Fly proxy does not deliver still stops
 * the job within a few seconds. Any zip or site already stored for the
 * job is deleted.
 */

const jobs = require("../lib/export-jobs");
const { cancelOnWorker } = require("../lib/fly-handoff");

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

let workerCancel = cancelOnWorker;

function setWorkerCancelForTests(fn) {
  workerCancel = typeof fn === "function" ? fn : cancelOnWorker;
}

exports.handler = async (event) => {
  jobs.bindBlobs(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const q = event.queryStringParameters || {};
  let id = q.job || q.id;
  if (!id && event.body) {
    try {
      const body = JSON.parse(event.body);
      id = body && (body.job || body.jobId);
    } catch {
      /* The query string carries the id. */
    }
  }
  if (!jobs.validJobId(id)) return json(400, { error: "Export id is not valid." });
  let job;
  try {
    job = await jobs.cancelJob(id);
  } catch {
    return json(503, { error: "Export cancel is unavailable." });
  }
  if (!job) return json(404, { error: "This export expired." });
  const cancelled = job.state === "cancelled";
  // A zip or site the run already wrote is removed; a cancelled job never
  // serves a file, so nothing waits for its TTL.
  if (cancelled) await jobs.deleteZip(id).catch(() => {});
  let worker = { sent: false, status: 0 };
  if (cancelled && job.worker === "fly") {
    worker = await workerCancel(id, job.flyMachine || "").catch(() => ({ sent: false, status: 0 }));
  }
  return json(200, {
    ok: true,
    cancelled,
    state: job.state,
    workerStatus: worker.status || 0,
  });
};

exports.setWorkerCancelForTests = setWorkerCancelForTests;
