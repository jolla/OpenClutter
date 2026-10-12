"use strict";

/**
 * One export at a time. Auth, then the same job finish the Netlify
 * background function uses. This file does not detect roofs or trees.
 */

const crypto = require("node:crypto");
const jobs = require("../netlify/lib/export-jobs");
const areaCache = require("../netlify/lib/area-cache");
const { completeExportJob } = require("../netlify/lib/export-run");

const BODY_MAX = 2 * 1000 * 1000;
let inFlight = null;

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const want = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === want) return String(headers[keys[i]] || "");
  }
  return "";
}

function pathOf(url) {
  const raw = String(url || "/");
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

function workerSecret() {
  return String(process.env.OPENCLUTTER_WORKER_SECRET || "").trim();
}

function secretOk(headers) {
  const expected = workerSecret();
  if (!expected) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header(headers, "authorization").trim());
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function configureBlobsFromEnv() {
  const siteID = String(process.env.NETLIFY_SITE_ID || "").trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || "").trim();
  if (!siteID || !token) return false;
  const { setEnvironmentContext } = require("@netlify/blobs");
  const ctx = { siteID, token };
  const region = String(process.env.NETLIFY_BLOBS_REGION || "").trim();
  if (region) ctx.region = region;
  setEnvironmentContext(ctx);
  return true;
}

function enableAreaCache() {
  if (process.env.OPENCLUTTER_AREA_CACHE === "0") return;
  try {
    const { getStore } = require("@netlify/blobs");
    const opts = { name: "openclutter-exports" };
    const region = String(process.env.NETLIFY_BLOBS_REGION || "").trim();
    if (region) opts.region = region;
    areaCache.enable(getStore(opts));
  } catch {
    /* The export still runs. A missing tile is fetched on its own. */
  }
}

function jsonResult(statusCode, body) {
  return { statusCode, body };
}

/**
 * headers are a plain object. body is a string.
 * A 202 result may include job, a promise the HTTP server awaits before
 * it ends the response. The promise keeps running if the client leaves.
 */
async function handleWorkerRequest(req) {
  const method = String((req && req.method) || "GET").toUpperCase();
  const path = pathOf(req && req.url);
  if (method === "GET" && (path === "/health" || path === "/")) {
    return jsonResult(200, { ok: true });
  }
  if (method !== "POST" || path !== "/export") {
    return jsonResult(405, { error: "POST /export only." });
  }
  if (!secretOk(req && req.headers)) {
    return jsonResult(401, { error: "Unauthorized." });
  }
  let payload = null;
  try {
    payload = JSON.parse((req && req.body) || "");
  } catch {
    return jsonResult(400, { error: "invalid json" });
  }
  const jobId = payload && payload.jobId;
  const inner = payload && payload.event;
  if (!jobs.validJobId(jobId) || !inner || !inner.body) {
    return jsonResult(400, { error: "Export id is not valid." });
  }
  if (!configureBlobsFromEnv()) {
    return jsonResult(503, { error: "Blob store is not configured." });
  }
  if (inFlight) {
    return jsonResult(409, { error: "An export is already running." });
  }
  const job = runAcceptedJob(jobId, inner);
  inFlight = job;
  job.finally(() => {
    if (inFlight === job) inFlight = null;
  });
  return { statusCode: 202, body: { ok: true, accepted: true }, job };
}

async function runAcceptedJob(jobId, inner) {
  enableAreaCache();
  try {
    return await completeExportJob(jobId, inner, { worker: "fly" });
  } catch {
    return { ok: false, reason: "export-failed" };
  }
}

function jobInFlight() {
  return !!inFlight;
}

module.exports = {
  BODY_MAX,
  handleWorkerRequest,
  configureBlobsFromEnv,
  secretOk,
  jobInFlight,
};
