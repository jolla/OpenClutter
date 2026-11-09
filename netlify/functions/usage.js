"use strict";

/**
 * POST /api/usage  one page-load ping. Always 204. Bots, prefetch, Do Not
 * Track, and Global Privacy Control are not stored.
 * GET  /api/usage  aggregates for charts.
 *   period=day|week|month   (day when omitted)
 *   date=YYYY-MM-DD | YYYY-Www | YYYY-MM
 *   from= and to=  in that same shape
 *   neither: last 30 days, 12 weeks, or 12 months, Chicago time
 * When OPENCLUTTER_API_KEY_HASHES is set, GET uses the same key check as
 * the draft /v1 API. When that variable is empty, GET is public.
 */

const usage = require("../lib/usage");

const baseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function bindBlobs(event) {
  if (!event || !event.blobs) return;
  const src = event.headers || {};
  const headers = {};
  for (const key of Object.keys(src)) headers[String(key).toLowerCase()] = src[key];
  try {
    require("@netlify/blobs").connectLambda({ blobs: event.blobs, headers });
  } catch {
    /* A missing blob context leaves the counters idle. */
  }
}

function noContent() {
  return {
    statusCode: 204,
    headers: Object.assign({}, baseHeaders, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-openclutter-key",
    }),
    body: "",
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ "content-type": "application/json" }, baseHeaders),
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  bindBlobs(event);
  const method = String((event && event.httpMethod) || "GET").toUpperCase();
  if (method === "OPTIONS") return noContent();
  if (method === "POST") {
    const headers = (event && event.headers) || {};
    if (!usage.skipPing(headers)) await usage.recordPage(headers).catch(() => {});
    return noContent();
  }
  if (method !== "GET") return json(405, { error: "GET or POST only" });
  if (!usage.readAllowed((event && event.headers) || {})) {
    return json(401, { error: "Send Authorization: Bearer <api key>." });
  }
  const q = (event && event.queryStringParameters) || {};
  const period = String(q.period || "day").trim().toLowerCase();
  if (period !== "day" && period !== "week" && period !== "month") {
    return json(400, { error: "period must be day, week, or month." });
  }
  const range = usage.parseRange(period, q, usage.now());
  if (!range) {
    return json(400, {
      error: "Use date= or from= and to=. A day range can cover 400 days, a week range 104 weeks, a month range 36 months.",
    });
  }
  let periods;
  try {
    periods = await usage.readPeriods(period, range.from, range.to);
  } catch {
    return json(503, { error: "Usage totals are unavailable." });
  }
  return json(200, {
    ok: true,
    timezone: usage.TZ,
    auth: usage.accessMode(),
    period,
    from: range.from,
    to: range.to,
    periods,
  });
};
