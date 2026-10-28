"use strict";

/**
 * GET  /api/feedback  which destinations are set up (no secrets, no private address).
 * POST /api/feedback  one report from the page's Feedback form.
 *
 * Private by default: the report becomes an issue in FEEDBACK_PRIVATE_REPO and
 * its screenshots are stored as files in that private repo. With "Post
 * publicly on GitHub" ticked it becomes an issue in the public repo, with
 * screenshots in Netlify Blobs served by feedback-image. An email someone
 * leaves never goes on a public issue; it goes to the private repo or nowhere.
 * Nothing from the report (message, email, IP) is written to the logs.
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
    /* Blobs unavailable: rate limits fall open, public screenshots fail. */
  }
}

let stores = null;
let ghImpl = gh;
let envOverride = null;
let nowOverride = null;

function setForTests(o) {
  const x = o || {};
  stores = x.stores || null;
  ghImpl = x.gh || gh;
  envOverride = x.env || null;
  nowOverride = x.now == null ? null : x.now;
}

function store(name) {
  if (stores) return stores[name] || null;
  try {
    return require("@netlify/blobs").getStore({ name });
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

function monthPath(now) {
  return new Date(now).toISOString().slice(0, 7);
}

async function sendPublic(report, cfg, ctx) {
  const imgStore = report.images.length ? store(fb.PUBLIC_IMAGE_STORE) : null;
  if (report.images.length && !imgStore) {
    throw new fb.FeedbackError(503, "images_unavailable", "Screenshots cannot be stored right now. Try again without them.");
  }
  const ids = [];
  try {
    for (const img of report.images) {
      const id = fb.newImageId();
      await imgStore.set("img/" + id, img.buf, { metadata: { type: img.type, at: ctx.now } });
      ids.push(id);
    }
    const imageUrls = ids.map((id) => ctx.origin + "/api/feedback-image?id=" + id);
    const issue = fb.buildIssue(report, {
      host: ctx.host,
      browser: ctx.browser,
      imageUrls,
      hasPrivateContact: !!(report.email && cfg.private),
      isPrivate: false,
    });
    const made = await ghImpl.createIssue(issue, { repo: cfg.public.repo, token: cfg.public.token });
    if (report.email && cfg.private) {
      try {
        await ghImpl.createIssue(fb.buildContactNote(report, made, ctx.host), {
          repo: cfg.private.repo,
          token: cfg.private.token,
        });
      } catch {
        console.warn("feedback: private contact note failed");
      }
    }
    return { ok: true, public: true, url: made.url, number: made.number };
  } catch (err) {
    for (const id of ids) {
      try {
        await imgStore.delete("img/" + id);
      } catch {
        /* Best effort. */
      }
    }
    throw err;
  }
}

async function sendPrivate(report, cfg, ctx) {
  const opts = { repo: cfg.private.repo, token: cfg.private.token };
  const imageUrls = [];
  for (const img of report.images) {
    const p = "screenshots/" + monthPath(ctx.now) + "/" + fb.newImageId() + "." + img.ext;
    imageUrls.push(await ghImpl.putPrivateFile(p, img.buf, opts));
  }
  const issue = fb.buildIssue(report, {
    host: ctx.host,
    browser: ctx.browser,
    imageUrls,
    email: report.email || "",
    isPrivate: true,
  });
  const made = await ghImpl.createIssue(issue, opts);
  return { ok: true, public: false, number: made.number };
}

exports.handler = async (event) => {
  const h = lowerHeaders(event);
  const origin = requestOrigin(h);
  const okOrigin = fb.allowedOrigin(origin) ? origin : "";
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: okOrigin ? json(204, {}, okOrigin).headers : baseHeaders, body: "" };
  const cfg = fb.readConfig(envOverride || process.env);
  if (event.httpMethod === "GET") return json(200, fb.publicConfig(cfg), okOrigin);
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" }, okOrigin);
  if (!okOrigin) return json(403, { error: "Please send feedback from the OpenClutter page.", code: "origin" });

  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : String(event.body || "");
  if (Buffer.byteLength(raw, "utf8") > fb.BODY_MAX_BYTES) {
    return json(413, { error: "That report is too large. Try fewer or smaller screenshots.", code: "too_big" }, okOrigin);
  }
  if (!cfg.public && !cfg.private) {
    return json(503, { error: "Feedback is not configured yet.", code: "not_configured" }, okOrigin);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "The report could not be read.", code: "bad_request" }, okOrigin);
  }
  bindBlobs(event, h);
  const now = nowOverride == null ? Date.now() : nowOverride;
  try {
    const report = fb.parseReport(body);
    if (report.spam) return json(200, { ok: true, public: false }, okOrigin);
    // Public only with consent and a public setup; otherwise private.
    let goPublic = report.public && !!cfg.public;
    if (!goPublic && !cfg.private) {
      return json(
        409,
        { error: "Private reports are not set up yet. Tick Post publicly on GitHub to send it.", code: "public_only" },
        okOrigin
      );
    }
    const limited = await fb.checkRate(store(fb.RATE_STORE), clientIp(h), now);
    if (limited) return json(429, { error: limited, code: "rate_limited" }, okOrigin);
    const ctx = {
      now,
      origin: okOrigin,
      host: fb.hostKind(okOrigin),
      browser: fb.browserSummary(h["user-agent"]),
    };
    const out = goPublic ? await sendPublic(report, cfg, ctx) : await sendPrivate(report, cfg, ctx);
    return json(200, out, okOrigin);
  } catch (err) {
    if (err instanceof fb.FeedbackError) return json(err.status, { error: err.message, code: err.code }, okOrigin);
    console.warn("feedback: send failed" + (err && err.githubStatus ? " (GitHub " + err.githubStatus + ")" : ""));
    return json(502, { error: "Sorry, the report could not be sent. Please try again later.", code: "send_failed" }, okOrigin);
  }
};

exports.setForTests = setForTests;
