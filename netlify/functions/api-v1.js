"use strict";

/**
 * OpenClutter direct API v1 (prototype).
 *   POST /v1/sites               create a site job (202), or wait for a small one (200)
 *   GET  /v1/sites/{id}          job status
 *   GET  /v1/sites/{id}/result   structured site data (collections, paging)
 *   GET  /v1/health              no auth
 * The job runs through the same background export (Fly worker first) as the
 * web page, with format "site-v1", so no OpenIntent zip is stored or sent.
 */

const crypto = require("node:crypto");
const jobs = require("../lib/export-jobs");
const { geoFrame } = require("../lib/geo-frame");
const { selectSite, API_VERSION } = require("../lib/site-v1");
const { version: engineVersion } = require("../lib/version");

const RATE_LIMITS = {
  create: { limit: 60, windowMs: 60 * 60 * 1000 },
  status: { limit: 300, windowMs: 60 * 1000 },
  result: { limit: 120, windowMs: 60 * 60 * 1000 },
};
const MAX_WAIT_S = 20;
const RESPONSE_SOFT_MAX = 5.5 * 1000 * 1000;

let deps = { fetch: (...a) => fetch(...a), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
function setApiDepsForTests(d) {
  deps = Object.assign({}, deps, d || {});
}

function requestId() {
  return "req_" + crypto.randomBytes(8).toString("hex");
}

function respond(status, body, extra) {
  return {
    statusCode: status,
    headers: Object.assign(
      { "content-type": "application/json", "cache-control": "no-store", "x-openclutter-api-version": API_VERSION },
      extra || {}
    ),
    body: JSON.stringify(body),
  };
}

function apiError(status, code, message, extra) {
  return respond(status, { error: { code, message, requestId: requestId() } }, extra);
}

function header(headers, name) {
  const want = name.toLowerCase();
  for (const k of Object.keys(headers || {})) if (k.toLowerCase() === want) return String(headers[k] || "");
  return "";
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

/** OPENCLUTTER_API_KEY_HASHES: comma list of sha256 hex digests of valid keys. */
function keyHashes() {
  return String(process.env.OPENCLUTTER_API_KEY_HASHES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

function presentedKey(headers) {
  const auth = /^Bearer\s+(\S+)$/i.exec(header(headers, "authorization").trim());
  if (auth) return auth[1];
  return header(headers, "x-openclutter-key").trim();
}

function authenticate(headers) {
  const key = presentedKey(headers);
  if (!key) return null;
  const got = Buffer.from(hashKey(key), "hex");
  for (const h of keyHashes()) {
    const want = Buffer.from(h, "hex");
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return h;
  }
  return null;
}

async function openStore() {
  const { getStore } = require("@netlify/blobs");
  return getStore({ name: "openclutter-api" });
}
let storeOverride = null;
function setApiStoreForTests(s) {
  storeOverride = s;
}

/** Fixed window counter per key and route class. Best effort, not atomic. */
async function rateLimit(keyHash, bucket) {
  const rule = RATE_LIMITS[bucket];
  const now = deps.now();
  const win = Math.floor(now / rule.windowMs);
  const reset = Math.ceil(((win + 1) * rule.windowMs) / 1000);
  const headers = { "x-ratelimit-limit": String(rule.limit), "x-ratelimit-reset": String(reset) };
  let used = 0;
  try {
    const store = storeOverride || (await openStore());
    const k = "rl/" + keyHash.slice(0, 16) + "/" + bucket + "/" + win;
    const cur = await store.get(k, { type: "json" });
    used = (cur && cur.n) | 0;
    if (used >= rule.limit) {
      headers["x-ratelimit-remaining"] = "0";
      headers["retry-after"] = String(Math.max(1, reset - Math.floor(now / 1000)));
      return { ok: false, headers };
    }
    used += 1;
    await store.setJSON(k, { n: used });
  } catch {
    /* A missing store must not block the API. */
  }
  headers["x-ratelimit-remaining"] = String(Math.max(0, rule.limit - used));
  return { ok: true, headers };
}

function ringsOf(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) return geometry.coordinates.map((p) => p && p[0]);
  if (geometry.type === "Feature") return ringsOf(geometry.geometry);
  return null;
}

/** GeoJSON Polygon/MultiPolygon (or bbox) to the axis-aligned frame the engine uses. */
function frameFromRequest(body) {
  if (body.geometry) {
    const rings = ringsOf(body.geometry);
    if (!rings || !rings.length) throw Object.assign(new Error("geometry must be a GeoJSON Polygon or MultiPolygon."), { code: "invalid_geometry" });
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4) throw Object.assign(new Error("Each polygon ring needs at least 4 positions."), { code: "invalid_geometry" });
      for (const p of ring) {
        const lon = Array.isArray(p) ? +p[0] : NaN;
        const lat = Array.isArray(p) ? +p[1] : NaN;
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85) {
          throw Object.assign(new Error("Coordinates must be [lon, lat] in EPSG:4326."), { code: "invalid_geometry" });
        }
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
    return { west: w, south: s, east: e, north: n };
  }
  if (Array.isArray(body.bbox) && body.bbox.length === 4) {
    const [w, s, e, n] = body.bbox.map(Number);
    return { west: w, south: s, east: e, north: n };
  }
  throw Object.assign(new Error("Send geometry (GeoJSON Polygon) or bbox [west, south, east, north]."), { code: "bbox_required" });
}

function bool(v, dflt) {
  if (v === undefined || v === null) return dflt;
  return v === true || v === "true" || v === 1 || v === "1";
}

/** API options to the body the export pipeline already reads. */
function exportBody(bbox, body) {
  const o = body.options || {};
  const out = Object.assign({}, bbox, {
    format: "site-v1",
    name: typeof body.name === "string" ? body.name.slice(0, 200) : undefined,
    includeFoliage: bool(o.includeFoliage, true),
    includePoles: bool(o.includePoles, true),
    includeWater: bool(o.includeWater, false),
    includeParking: bool(o.includeParking, true),
    includeWalls: bool(o.includeWalls, true),
    includeRvs: bool(o.includeVehicles, false),
    includeCars: bool(o.includeVehicles, false),
    includeTerrain: bool(o.includeTerrain, true),
    mapNotes: bool(o.includeMapNotes, true),
  });
  if (o.terrainResolution != null) out.terrainResolution = String(o.terrainResolution);
  if (o.imageryQuality != null && o.imageryQuality !== "auto") out.imageryQuality = String(o.imageryQuality);
  if (bool(o.lidarHeights, false)) out.lidar = true;
  return out;
}

function hostHeaders(headers) {
  const keep = {};
  for (const k of ["host", "x-forwarded-host", "x-forwarded-proto", "x-nf-request-id", "user-agent"]) {
    const v = header(headers, k);
    if (v) keep[k] = v;
  }
  return keep;
}

function backgroundUrl(headers) {
  const host = (header(headers, "x-forwarded-host") || header(headers, "host")).split(",")[0].trim();
  const proto = header(headers, "x-forwarded-proto") || "https";
  if (host && host.indexOf(".") !== -1) return proto + "://" + host + "/.netlify/functions/clutter-export-background";
  const base = process.env.DEPLOY_URL || process.env.DEPLOY_PRIME_URL || process.env.URL || "";
  return String(base).replace(/\/$/, "") + "/.netlify/functions/clutter-export-background";
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

const STATE = { queued: "queued", running: "running", done: "succeeded", error: "failed" };

function statusView(id, job) {
  const state = STATE[job.state] || job.state || "queued";
  const view = {
    id,
    apiVersion: API_VERSION,
    engineVersion,
    status: state,
    stage: job.stage || null,
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
    expiresAt: iso(job.expiresAt),
    warnings: job.warnings || [],
    error: job.state === "error" ? { code: "job_failed", message: job.error || "Build failed." } : null,
    statusUrl: "/v1/sites/" + id,
    resultUrl: "/v1/sites/" + id + "/result",
  };
  if (job.siteStats) {
    const s = job.siteStats;
    view.statsPreview = { buildings: s.buildings, trees: s.trees, poles: s.poles, terrainCells: s.terrainCells };
    view.resultBytes = job.siteBytes || null;
  }
  if (job.timings && job.timings.totalMs) view.elapsedMs = job.timings.totalMs;
  return view;
}

async function createSite(event, body, rlHeaders) {
  let bbox;
  try {
    bbox = frameFromRequest(body);
    geoFrame(bbox, {});
  } catch (e) {
    const code = e.code || (/too large|max/i.test(e.message) ? "area_too_large" : /too small|min/i.test(e.message) ? "area_too_small" : "invalid_geometry");
    return apiError(400, code, String(e.message || e), rlHeaders);
  }
  const id = crypto.randomUUID();
  const inner = {
    httpMethod: "POST",
    headers: hostHeaders(event.headers),
    path: "/api/clutter",
    body: JSON.stringify(exportBody(bbox, body)),
  };
  try {
    await jobs.createJob(id);
    await jobs.updateJob(id, { api: "v1", name: typeof body.name === "string" ? body.name.slice(0, 200) : null });
  } catch {
    return apiError(503, "upstream_unavailable", "Job store is unavailable.", rlHeaders);
  }
  try {
    const res = await deps.fetch(backgroundUrl(event.headers), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: id, event: inner }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 202 && res.status !== 200) throw new Error("invoke " + res.status);
  } catch {
    await jobs.deleteJob(id).catch(() => {});
    return apiError(503, "upstream_unavailable", "Could not start the build. Try again.", rlHeaders);
  }
  const q = event.queryStringParameters || {};
  const waitS = Math.min(MAX_WAIT_S, Math.max(0, +(q.wait || (body.options && body.options.waitSeconds) || 0) || 0));
  if (waitS > 0) {
    const until = deps.now() + waitS * 1000;
    while (deps.now() < until) {
      await deps.sleep(1500);
      const job = await jobs.readJob(id).catch(() => null);
      if (job && job.state === "done") return resultResponse(id, job, q, rlHeaders);
      if (job && job.state === "error") return respond(200, statusView(id, job), rlHeaders);
    }
  }
  const job = (await jobs.readJob(id).catch(() => null)) || { state: "queued", createdAt: deps.now() };
  return respond(202, statusView(id, job), Object.assign({ location: "/v1/sites/" + id }, rlHeaders));
}

async function resultResponse(id, job, q, rlHeaders) {
  if (job.state === "error") return apiError(409, "job_failed", job.error || "Build failed.", rlHeaders);
  if (job.state !== "done") return apiError(409, "job_not_ready", "Status is " + (STATE[job.state] || job.state) + ". Poll the status URL.", rlHeaders);
  let site;
  try {
    site = await jobs.readSite(id);
  } catch {
    site = null;
  }
  if (!site) return apiError(410, "job_expired", "The result is gone. Create a new job.", rlHeaders);
  let out;
  try {
    out = selectSite(site, q);
  } catch (e) {
    return apiError(400, e.code || "invalid_request", String(e.message || e), rlHeaders);
  }
  out = Object.assign({ id, status: "succeeded" }, out);
  const text = JSON.stringify(out);
  if (Buffer.byteLength(text) > RESPONSE_SOFT_MAX) {
    return apiError(413, "result_too_large", "Result is larger than one response. Use collections= and pageSize= to page it.", rlHeaders);
  }
  return {
    statusCode: 200,
    headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store", "x-openclutter-api-version": API_VERSION }, rlHeaders),
    body: text,
  };
}

function routeOf(event) {
  const raw = String(event.path || event.rawPath || "");
  const m = /\/v1(\/.*)?$/.exec(raw.replace(/\/\.netlify\/functions\/api-v1/, "/v1"));
  return (m && m[1]) || "/";
}

exports.handler = async (event) => {
  jobs.bindBlobs(event);
  const method = String(event.httpMethod || "GET").toUpperCase();
  const route = routeOf(event).replace(/\/+$/, "") || "/";
  if (method === "GET" && (route === "/health" || route === "/")) {
    return respond(200, { ok: true, apiVersion: API_VERSION, engineVersion });
  }
  const keyHash = authenticate(event.headers || {});
  if (!keyHash) return apiError(401, "unauthorized", "Send Authorization: Bearer <api key>.");

  const one = /^\/sites\/([^/]+)(\/result)?$/.exec(route);
  if (route === "/sites") {
    if (method !== "POST") return apiError(405, "method_not_allowed", "POST /v1/sites.");
    const rl = await rateLimit(keyHash, "create");
    if (!rl.ok) return apiError(429, "rate_limited", "Too many jobs this hour.", rl.headers);
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return apiError(400, "invalid_json", "Body must be JSON.", rl.headers);
    }
    return createSite(event, body || {}, rl.headers);
  }
  if (one && method === "GET") {
    const id = one[1];
    const isResult = !!one[2];
    const rl = await rateLimit(keyHash, isResult ? "result" : "status");
    if (!rl.ok) return apiError(429, "rate_limited", "Rate limit reached.", rl.headers);
    if (!jobs.validJobId(id)) return apiError(404, "job_not_found", "No such job.", rl.headers);
    let job;
    try {
      job = await jobs.readJob(id);
    } catch {
      return apiError(503, "upstream_unavailable", "Job store is unavailable.", rl.headers);
    }
    if (!job || job.api !== "v1") return apiError(404, "job_not_found", "No such job, or it expired.", rl.headers);
    if (isResult) return resultResponse(id, job, event.queryStringParameters || {}, rl.headers);
    return respond(200, statusView(id, job), rl.headers);
  }
  return apiError(404, "not_found", "Unknown route.");
};

exports.hashKey = hashKey;
exports.frameFromRequest = frameFromRequest;
exports.exportBody = exportBody;
exports.setApiDepsForTests = setApiDepsForTests;
exports.setApiStoreForTests = setApiStoreForTests;
exports.RATE_LIMITS = RATE_LIMITS;
