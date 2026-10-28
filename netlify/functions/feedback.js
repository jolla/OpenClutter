"use strict";

/**
 * GET  /api/feedback  whether the form is set up (no token, no repo name).
 * POST /api/feedback  one report from the page's Feedback form.
 * POST /api/feedback  {"ping":true}: a reachability check when the form opens.
 *                     Answers {ok, ping, configured}; no issue, no rate count.
 *
 * Reports are private: each one becomes an issue in FEEDBACK_PRIVATE_REPO,
 * its screenshots are stored as files in that private repo, and an email the
 * reporter leaves is shown as "Reply to" in the issue. Nothing from the
 * report (message, email, IP) is written to the logs.
 */

const fb = require("../lib/feedback");
const gh = require("../lib/feedback-github");

const baseHeaders = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status, body, origin) {
  const headers = Object.assign({}, baseHeaders);
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = "content-type";
    headers.vary = "Origin";
  }
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

function lowerHeaders(event) {
  const src = (event && event.headers) || {};
  const out = {};
  for (const k of Object.keys(src)) out[String(k).toLowerCase()] = src[k];
  return out;
}

function bindBlobs(event, headers) {
  if (!event || !event.blobs) return;
  try {
    require("@netlify/blobs").connectLambda({ blobs: event.blobs, headers });
  } catch {
    /* Blobs unavailable: rate limits fall open. */
  }
}

let rateStoreOverride;
let ghImpl = gh;
let envOverride = null;
let nowOverride = null;

function setForTests(o) {
  const x = o || {};
  rateStoreOverride = x.rateStore;
  ghImpl = x.gh || gh;
  envOverride = x.env || null;
  nowOverride = x.now == null ? null : x.now;
}

function rateStore() {
  if (rateStoreOverride !== undefined) return rateStoreOverride;
  try {
    return require("@netlify/blobs").getStore({ name: fb.RATE_STORE });
  } catch {
    return null;
  }
}

function requestOrigin(h) {
  if (h.origin) return h.origin;
  try {
    return new URL(h.referer || "").origin;
  } catch {
    return "";
  }
}

function clientIp(h) {
  const xf = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  return h["x-nf-client-connection-ip"] || h["client-ip"] || xf || "unknown";
}

async function sendPrivate(report, cfg, ctx) {
  const opts = { repo: cfg.repo, token: cfg.token };
  const month = new Date(ctx.now).toISOString().slice(0, 7);
  const imageUrls = [];
  for (const img of report.images) {
    const p = "screenshots/" + month + "/" + fb.newImageId() + "." + img.ext;
    imageUrls.push(await ghImpl.putPrivateFile(p, img.buf, opts));
  }
  const issue = fb.buildIssue(report, {
    host: ctx.host,
    browser: ctx.browser,
    imageUrls,
    email: report.email || "",
  });
  const made = await ghImpl.createIssue(issue, opts);
  return { ok: true, number: made.number };
}

exports.handler = async (event) => {
  const h = lowerHeaders(event);
  const origin = requestOrigin(h);
  const okOrigin = fb.allowedOrigin(origin) ? origin : "";
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: okOrigin ? json(204, {}, okOrigin).headers : baseHeaders, body: "" };
  }
  const cfg = fb.readConfig(envOverride || process.env);
  if (event.httpMethod === "GET") return json(200, fb.pageConfig(cfg), okOrigin);
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" }, okOrigin);
  if (!okOrigin) return json(403, { error: "Please send feedback from the OpenClutter page.", code: "origin" });

  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : String(event.body || "");
  if (Buffer.byteLength(raw, "utf8") > fb.BODY_MAX_BYTES) {
    return json(413, { error: "That report is too large. Try fewer or smaller screenshots.", code: "too_big" }, okOrigin);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "The report could not be read.", code: "bad_request" }, okOrigin);
  }
  // Answered before the config, rate and spam checks: it only proves a POST gets through.
  if (fb.isPing(body)) return json(200, { ok: true, ping: true, configured: !!cfg }, okOrigin);
  if (!cfg) return json(503, { error: "Feedback is not configured yet.", code: "not_configured" }, okOrigin);
  bindBlobs(event, h);
  const now = nowOverride == null ? Date.now() : nowOverride;
  try {
    const report = fb.parseReport(body);
    if (report.spam) return json(200, { ok: true }, okOrigin);
    const limited = await fb.checkRate(rateStore(), clientIp(h), now);
    if (limited) return json(429, { error: limited, code: "rate_limited" }, okOrigin);
    const out = await sendPrivate(report, cfg, {
      now,
      host: fb.hostKind(okOrigin),
      browser: fb.browserSummary(h["user-agent"]),
    });
    return json(200, out, okOrigin);
  } catch (err) {
    if (err instanceof fb.FeedbackError) return json(err.status, { error: err.message, code: err.code }, okOrigin);
    console.warn("feedback: send failed" + (err && err.githubStatus ? " (GitHub " + err.githubStatus + ")" : ""));
    return json(502, { error: "Sorry, the report could not be sent. Please try again later.", code: "send_failed" }, okOrigin);
  }
};

exports.setForTests = setForTests;
