"use strict";

/**
 * In-app feedback. Checks a report from the page and turns it into a GitHub
 * issue. Private by default: reports go to a private repo (FEEDBACK_PRIVATE_REPO)
 * and their screenshots are stored in that private repo. Only when the
 * reporter ticks "Post publicly on GitHub" does the report go to the public
 * repo, with screenshots served from Netlify Blobs by unguessable id.
 *
 * The page never talks to GitHub and never sees a token or a private address.
 * Public issue bodies put the user's words inside a code block so mentions,
 * links, images and HTML do not render.
 */

const crypto = require("node:crypto");

const ENV = {
  publicToken: "GITHUB_FEEDBACK_TOKEN",
  publicRepo: "GITHUB_FEEDBACK_REPO",
  privateToken: "GITHUB_FEEDBACK_PRIVATE_TOKEN",
  privateRepo: "FEEDBACK_PRIVATE_REPO",
  publicEmail: "FEEDBACK_PUBLIC_EMAIL",
};
const DEFAULT_PUBLIC_REPO = "jolla/OpenClutter";

const TYPES = {
  bug: { label: "bug", title: "Bug" },
  suggestion: { label: "enhancement", title: "Suggestion" },
  other: { label: "feedback", title: "Feedback" },
};
const FEEDBACK_LABEL = "user-feedback";

const MESSAGE_MIN = 5;
const MESSAGE_MAX = 4000;
const TITLE_MAX = 80;
const EMAIL_MAX = 254;
const MAX_LINKS = 3;
const MAX_IMAGES = 3;
const IMAGE_MAX_BYTES = 600 * 1024;
// Three 600 KB screenshots as base64 plus the text. Netlify allows 6 MB.
const BODY_MAX_BYTES = 3 * 1024 * 1024;
// A person needs a moment to type. Faster than this is treated as a bot.
const MIN_FILL_MS = 1500;

const RATE = {
  shortMs: 10 * 60 * 1000,
  shortMax: 3,
  dayMs: 24 * 60 * 60 * 1000,
  dayMax: 10,
  globalDayMax: 60,
};

const PUBLIC_IMAGE_STORE = "openclutter-feedback-public";
const RATE_STORE = "openclutter-ratelimit";

class FeedbackError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new FeedbackError(status, code, message);
}

function validRepo(s) {
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(String(s || ""));
}

/**
 * Which destinations are set up. Token values stay inside this object and
 * are never sent to the page or logged.
 */
function readConfig(env) {
  const e = env || process.env;
  const s = (k) => String(e[k] || "").trim();
  const pubRepo = s(ENV.publicRepo) || DEFAULT_PUBLIC_REPO;
  const privRepo = s(ENV.privateRepo);
  const publicToken = s(ENV.publicToken);
  const privateToken = s(ENV.privateToken);
  const email = s(ENV.publicEmail);
  return {
    public: publicToken && validRepo(pubRepo) ? { repo: pubRepo, token: publicToken } : null,
    private: privateToken && validRepo(privRepo) ? { repo: privRepo, token: privateToken } : null,
    publicEmail: email && validEmail(email) ? email : "",
  };
}

/** What the page may know: which options to show, and the mailto alias. */
function publicConfig(cfg) {
  return {
    configured: !!(cfg.public || cfg.private),
    private: !!cfg.private,
    public: !!cfg.public,
    email: cfg.publicEmail || null,
    maxImages: MAX_IMAGES,
    maxImageBytes: IMAGE_MAX_BYTES,
    maxMessage: MESSAGE_MAX,
  };
}

/** Hosts the page runs on. Anything else is refused. */
function allowedOrigin(origin) {
  let u;
  try {
    u = new URL(String(origin || ""));
  } catch {
    return false;
  }
  const h = u.hostname;
  if (u.protocol === "http:" && (h === "localhost" || h === "127.0.0.1")) return true;
  if (u.protocol !== "https:") return false;
  return (
    h === "openclutter.com" ||
    h === "www.openclutter.com" ||
    h === "dev.openclutter.com" ||
    h === "openclutter.netlify.app" ||
    /^[a-z0-9-]+--openclutter\.netlify\.app$/.test(h)
  );
}

/** "dev" for /dev hosts and previews, "prod" for openclutter.com. */
function hostKind(origin) {
  let h = "";
  try {
    h = new URL(String(origin || "")).hostname;
  } catch {
    return "unknown";
  }
  if (h === "openclutter.com" || h === "www.openclutter.com" || h === "openclutter.netlify.app") return "prod";
  if (h === "localhost" || h === "127.0.0.1") return "local";
  return "dev";
}

/** Control and direction characters out (tab and newline stay), CRLF to LF. */
function cleanText(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function countLinks(s) {
  const m = String(s).match(/\b(?:https?:\/\/|www\.)\S+/gi);
  return m ? m.length : 0;
}

/**
 * Titles do not render markdown, but an @name or owner/repo#1 in a title
 * still reads as a ping or a cross link, so both are broken up.
 */
function defuse(s) {
  return String(s)
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    .replace(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d)/g, "$1#\u200b$2")
    .replace(/(^|\s)#(\d)/g, "$1#\u200b$2");
}

function titleFrom(type, message) {
  const first = message.split("\n").map((l) => l.trim()).find(Boolean) || "";
  let t = first.replace(/\s+/g, " ");
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX - 3).trimEnd() + "...";
  return "[" + TYPES[type].title + "] " + defuse(t);
}

/** A fenced block that the message cannot close early. */
function fence(text) {
  const runs = String(text).match(/`+/g) || [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  const f = "`".repeat(Math.max(3, longest + 1));
  return f + "text\n" + text + "\n" + f;
}

function validEmail(s) {
  s = String(s || "");
  return s.length <= EMAIL_MAX && /^[^\s@<>()",;:\\[\]`]+@[^\s@<>()",;:\\[\]`]+\.[A-Za-z]{2,}$/.test(s);
}

function validVersion(s) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(String(s || ""));
}

function finite(n, lo, hi) {
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
}

/** Draw bounds rounded to about 1 m. Null when anything is off. */
function cleanBounds(b) {
  if (!b || typeof b !== "object") return null;
  const { west, south, east, north } = b;
  if (!finite(west, -180, 180) || !finite(east, -180, 180)) return null;
  if (!finite(south, -90, 90) || !finite(north, -90, 90)) return null;
  if (south >= north || west === east) return null;
  const r = (x) => Math.round(x * 1e5) / 1e5;
  return { west: r(west), south: r(south), east: r(east), north: r(north) };
}

/** Browser name, major version and OS from the user agent. Never the full string. */
function browserSummary(ua) {
  const s = String(ua || "");
  if (!s) return "";
  let name;
  let m;
  if ((m = /Edg\/(\d+)/.exec(s))) name = "Edge " + m[1];
  else if ((m = /OPR\/(\d+)/.exec(s))) name = "Opera " + m[1];
  else if ((m = /Firefox\/(\d+)/.exec(s))) name = "Firefox " + m[1];
  else if ((m = /Chrome\/(\d+)/.exec(s))) name = "Chrome " + m[1];
  else if ((m = /Version\/(\d+)[\d.]* .*Safari\//.exec(s))) name = "Safari " + m[1];
  else name = "Other browser";
  let os = "";
  if (/Windows/.test(s)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";
  return os ? name + " on " + os : name;
}

function viewportText(v) {
  if (!v || typeof v !== "object") return "";
  const w = Math.round(Number(v.w));
  const h = Math.round(Number(v.h));
  if (!(w > 0 && w < 20000 && h > 0 && h < 20000)) return "";
  return w + " x " + h;
}

/** Image type from the first bytes. Only what the page sends: JPEG or WebP. */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function decodeImage(item, i) {
  const raw = typeof item === "string" ? item : item && item.data;
  const m = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(raw || ""));
  const bad = () => fail(400, "bad_image", "Screenshot " + (i + 1) + " is not a JPEG or WebP image.");
  if (!m) bad();
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > IMAGE_MAX_BYTES) fail(413, "image_too_big", "Screenshot " + (i + 1) + " is too large.");
  const type = sniffImage(buf);
  if (!type || type !== m[1]) bad();
  return { buf, type, ext: type === "image/webp" ? "webp" : "jpg" };
}

/**
 * Checks the parsed body. Returns { spam: true } for the honeypot or a form
 * sent too fast, so the caller can answer like a success without an issue.
 */
function parseReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "bad_request", "The report could not be read.");
  if (String(body.website || "").trim()) return { spam: true };
  const elapsed = Number(body.elapsedMs);
  if (body.elapsedMs != null && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return { spam: true };
  const type = Object.prototype.hasOwnProperty.call(TYPES, body.type) ? body.type : "other";
  const message = cleanText(body.message).trim();
  if (message.length < MESSAGE_MIN) fail(400, "empty", "Please tell us a little more.");
  if (message.length > MESSAGE_MAX) fail(413, "too_long", "Please keep it under " + MESSAGE_MAX + " characters.");
  if (countLinks(message) > MAX_LINKS) fail(400, "too_many_links", "Please include at most " + MAX_LINKS + " links.");
  const email = cleanText(body.email).trim();
  if (email && !validEmail(email)) fail(400, "bad_email", "That email does not look right. You can leave it blank.");
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_IMAGES) fail(400, "too_many_images", "Please attach at most " + MAX_IMAGES + " screenshots.");
  const decoded = images.map(decodeImage);
  const share = body.context && typeof body.context === "object" ? body.context : null;
  return {
    spam: false,
    public: body.public === true,
    type,
    message,
    email,
    images: decoded,
    version: validVersion(body.version) ? String(body.version) : "",
    bounds: share ? cleanBounds(share.bounds) : null,
    viewport: share ? viewportText(share.viewport) : "",
    shareBrowser: !!share,
  };
}

/**
 * Markdown issue for either repo. extra.email is only passed for the private
 * repo; the public body says at most that a private contact exists.
 */
function buildIssue(report, extra) {
  const x = extra || {};
  const lines = [];
  lines.push("**Type:** " + TYPES[report.type].title);
  lines.push("**Version:** " + (report.version ? "v" + report.version : "unknown") + " (" + (x.host || "unknown") + ")");
  if (report.shareBrowser && x.browser) {
    lines.push("**Browser:** " + x.browser + (report.viewport ? ", window " + report.viewport : ""));
  }
  if (report.bounds) {
    const b = report.bounds;
    const lat = Math.round(((b.south + b.north) / 2) * 1e5) / 1e5;
    const lon = Math.round(((b.west + b.east) / 2) * 1e5) / 1e5;
    lines.push(
      "**Draw bounds:** W " + b.west + ", S " + b.south + ", E " + b.east + ", N " + b.north +
        " ([map](https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon + "))"
    );
  }
  if (x.email) lines.push("**Reply to:** `" + x.email.replace(/`/g, "") + "`");
  else if (x.hasPrivateContact) lines.push("**Contact:** the reporter left an email, kept private.");
  if (x.publicIssueUrl) lines.push("**Public issue:** " + x.publicIssueUrl);
  lines.push("");
  lines.push("**Message:**");
  lines.push("");
  lines.push(fence(report.message));
  const urls = x.imageUrls || [];
  if (urls.length) {
    lines.push("");
    lines.push("**Screenshots:**");
    lines.push("");
    urls.forEach((u, i) => lines.push("![Screenshot " + (i + 1) + "](" + u + ")"));
  }
  lines.push("");
  lines.push(
    "<sub>Sent from the OpenClutter Feedback form" + (x.isPrivate ? " (private)" : " (posted publicly by the reporter)") + ".</sub>"
  );
  return {
    title: titleFrom(report.type, report.message),
    body: lines.join("\n"),
    labels: [TYPES[report.type].label, FEEDBACK_LABEL],
  };
}

/** A short private note for the email someone left on a public report. */
function buildContactNote(report, publicIssue, host) {
  return {
    title: "[Contact] for public report #" + publicIssue.number,
    body: [
      "**Public issue:** " + publicIssue.url,
      "**Reply to:** `" + report.email.replace(/`/g, "") + "`",
      "**Host:** " + host,
      "",
      "<sub>The email is kept here so it never appears on the public issue.</sub>",
    ].join("\n"),
    labels: [FEEDBACK_LABEL, "contact"],
  };
}

function ipHash(ip) {
  return crypto.createHash("sha256").update("openclutter-feedback:" + String(ip || "unknown")).digest("hex").slice(0, 32);
}

/**
 * Per-IP and site-wide counters in Netlify Blobs, keyed by a hash of the IP.
 * Best effort, not atomic: a store error lets the report through.
 * Returns null when allowed, or a message when a limit is hit.
 */
async function checkRate(store, ip, now) {
  if (!store) return null;
  const t = now == null ? Date.now() : now;
  const key = "feedback/ip/" + ipHash(ip);
  const gkey = "feedback/global/" + new Date(t).toISOString().slice(0, 10);
  try {
    const rec = (await store.get(key, { type: "json" })) || {};
    const hits = (Array.isArray(rec.hits) ? rec.hits : []).filter((h) => typeof h === "number" && t - h < RATE.dayMs);
    const recent = hits.filter((h) => t - h < RATE.shortMs).length;
    if (recent >= RATE.shortMax) return "Thanks! You have sent a few reports just now. Please try again in a few minutes.";
    if (hits.length >= RATE.dayMax) return "Thanks! You have reached today's limit. Please try again tomorrow.";
    const g = (await store.get(gkey, { type: "json" })) || {};
    const gcount = Number(g.count) || 0;
    if (gcount >= RATE.globalDayMax) return "Feedback is very busy today. Please try again tomorrow.";
    hits.push(t);
    await store.setJSON(key, { hits });
    await store.setJSON(gkey, { count: gcount + 1 });
    return null;
  } catch {
    return null;
  }
}

function newImageId() {
  return crypto.randomBytes(16).toString("hex");
}

function validImageId(id) {
  return /^[0-9a-f]{32}$/.test(String(id || ""));
}

module.exports = {
  ENV,
  DEFAULT_PUBLIC_REPO,
  TYPES,
  FEEDBACK_LABEL,
  MESSAGE_MAX,
  MAX_IMAGES,
  IMAGE_MAX_BYTES,
  BODY_MAX_BYTES,
  RATE,
  PUBLIC_IMAGE_STORE,
  RATE_STORE,
  FeedbackError,
  readConfig,
  publicConfig,
  allowedOrigin,
  hostKind,
  cleanText,
  defuse,
  titleFrom,
  fence,
  validEmail,
  cleanBounds,
  browserSummary,
  sniffImage,
  parseReport,
  buildIssue,
  buildContactNote,
  ipHash,
  checkRate,
  newImageId,
  validImageId,
};
