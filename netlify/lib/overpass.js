"use strict";

/**
 * One client for every Overpass read of an export.
 *
 * Public Overpass servers turn requests away under load: 429 when the
 * caller's slots are taken, 504 or a "runtime error" remark when the
 * server is busy, or no answer at all. A single fetch per endpoint loses
 * the street map on a busy minute. This client:
 *   - asks one endpoint at a time, in order, and moves to the next only
 *     after the current one failed or ran out its share of the read's
 *     window (sequential failover; never two servers for the same read),
 *   - honours Retry-After and the /api/status slot time on a 429, and
 *     pauses that endpoint (the main instance asks for 30 s),
 *   - treats a 406 as a block on this address and leaves that endpoint
 *     alone for BAN_PAUSE_MS (no status probe, no retry loop),
 *   - backs off with jitter after 5xx answers and timeouts, and skips a
 *     server for DEAD_PAUSE_MS after DEAD_AFTER silent timeouts in a row,
 *   - caps requests in flight per endpoint inside this process,
 *   - coalesces identical reads and keeps a short-lived copy of each
 *     answer (OSM data, ODbL; credited in ATTRIBUTION.txt),
 *   - when OPENCLUTTER_OVERPASS_CACHE_DIR is set (benches and local runs,
 *     never a deployed host), keeps every answer on disk keyed by the
 *     query or bbox, so reruns read the same data without asking a server,
 *     and keeps endpoint pauses there across processes.
 * OPENCLUTTER_OVERPASS_ENDPOINTS (comma list of endpoint ids, in order)
 * limits a local run to some servers. Every request carries the app's
 * identifying user agent (lib/version.js).
 * The caller's signal or deadline is final. A read that is still missing
 * then returns ok:false and the export keeps its existing warning.
 *
 * Endpoint policies (wiki.openstreetmap.org/wiki/Overpass_API, Oct 2026):
 * overpass-api.de is overloaded, asks for no parallel scripts and a 30 s
 * pause after 429; private.coffee (formerly kumi.systems) has no rate
 * limit, allows commercial use, and asks for fewer than 10 requests at a
 * time; VK Maps states no limits. overpass.openstreetmap.fr serves the
 * whole planet but its copy can be weeks behind, so it is a last resort:
 * asked once two regular servers have failed in the same read, or when
 * every other server is refused, paused or backing off for longer than
 * LAST_RESORT_WAIT_MS.
 *
 * A server that refuses the connection outright (a firewall on one egress
 * address answers ECONNREFUSED in under a second) is skipped for
 * REFUSED_PAUSE_MS, so the read moves on at once instead of retrying it
 * every backoff step.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ENDPOINTS = [
  { id: "overpass-api.de", base: "https://overpass-api.de/api", slots: 2, pause429Ms: 30000, status: true },
  { id: "private.coffee", base: "https://overpass.private.coffee/api", slots: 3, pause429Ms: 10000, status: true },
  { id: "maps.mail.ru", base: "https://maps.mail.ru/osm/tools/overpass/api", slots: 2, pause429Ms: 10000, status: false },
  { id: "openstreetmap.fr", base: "https://overpass.openstreetmap.fr/api", slots: 1, pause429Ms: 30000, status: false, lastResort: true },
];

/** Skip a server that refused the connection for this long. */
const REFUSED_PAUSE_MS = 10 * 60 * 1000;
/** A refusal answers fast; a slow connect error is a timeout, not a firewall. */
const REFUSED_MAX_MS = 5000;
/** Ask a last-resort server only when no other one is free this soon. */
const LAST_RESORT_WAIT_MS = 8000;
const REFUSED_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_FAIL"]);

/** The socket error code under a fetch failure (undici nests it). */
function errorCode(e) {
  let cur = e;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (cur.code && typeof cur.code === "string" && !/^UND_ERR/.test(cur.code)) return cur.code;
    if (Array.isArray(cur.errors) && cur.errors.length) {
      const inner = errorCode(cur.errors[0]);
      if (inner) return inner;
    }
    cur = cur.cause;
  }
  return "";
}

/** Longest wait on one request. */
const ATTEMPT_MS = 60000;
/** Shortest share of the window one server gets while another is left to ask. */
const MIN_ATTEMPT_MS = 15000;
/** Window kept back for the next server while one is being asked. */
const RESERVE_MS = 25000;
/** A 406 is a block on this address: leave that server alone this long. */
const BAN_PAUSE_MS = 30 * 60 * 1000;
/** Silent timeouts in a row before a server is skipped for DEAD_PAUSE_MS. */
const DEAD_AFTER = 2;
const DEAD_PAUSE_MS = 10 * 60 * 1000;
const STATUS_MS = 4000;
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 20000;
const JITTER_MS = 1000;
/** In-process copy. The blob store keeps its own 6 h OSM copy. */
const MEMO_MS = 10 * 60 * 1000;
const MEMO_MAX = 32;
const DEFAULT_DEADLINE_MS = 90000;

const state = new Map();
const memo = new Map();
const inflight = new Map();
let logFn = (line) => console.log(line);
let fetchOverride = null;
let nowFn = Date.now;
let sleepOverride = null;
/** Tests shrink the per-request timer by this factor. */
let timerScale = 1;

function endpointState(ep) {
  let s = state.get(ep.id);
  if (!s) {
    s = { active: 0, queue: [], pausedUntil: 0, fails: 0, silent: 0 };
    const saved = loadSavedPauses()[ep.id];
    if (saved > nowFn()) s.pausedUntil = saved;
    state.set(ep.id, s);
  }
  return s;
}

/** Endpoints this process may ask: all, or OPENCLUTTER_OVERPASS_ENDPOINTS in that order. */
function endpoints() {
  const want = String(process.env.OPENCLUTTER_OVERPASS_ENDPOINTS || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!want.length) return ENDPOINTS;
  const out = [];
  for (const id of want) {
    const ep = ENDPOINTS.find((e) => e.id === id);
    if (ep && out.indexOf(ep) < 0) out.push(ep);
  }
  return out.length ? out : ENDPOINTS;
}

/** Disk copy directory, or "" when off (every deployed host). */
function cacheDir() {
  return String(process.env.OPENCLUTTER_OVERPASS_CACHE_DIR || "").trim();
}

function diskKey(kind, payload) {
  return crypto.createHash("sha256").update(kind + "\n" + String(payload)).digest("hex");
}

function diskPath(dir, kind, payload) {
  const k = diskKey(kind, payload);
  return path.join(dir, kind, k.slice(0, 2), k + ".gz");
}

function diskGet(kind, payload) {
  const dir = cacheDir();
  if (!dir) return null;
  try {
    const text = zlib.gunzipSync(fs.readFileSync(diskPath(dir, kind, payload))).toString("utf8");
    return bodyOk(kind, text) ? text : null;
  } catch {
    return null;
  }
}

function diskSet(kind, payload, text) {
  const dir = cacheDir();
  if (!dir || !bodyOk(kind, text)) return;
  try {
    const file = diskPath(dir, kind, payload);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(text, "utf8")));
    fs.renameSync(tmp, file);
  } catch {
    /* the disk copy is optional */
  }
}

let savedPauses = null;
function pausesFile() {
  const dir = cacheDir();
  return dir ? path.join(dir, "endpoint-pauses.json") : "";
}

function loadSavedPauses() {
  if (savedPauses) return savedPauses;
  savedPauses = {};
  const file = pausesFile();
  if (!file) return savedPauses;
  try {
    const got = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of Object.keys(got || {})) if (Number.isFinite(+got[k])) savedPauses[k] = +got[k];
  } catch {
    /* none saved */
  }
  return savedPauses;
}

/** Long pauses (a block, a dead server) outlive this process when the disk copy is on. */
function pauseLong(ep, until) {
  const s = endpointState(ep);
  s.pausedUntil = Math.max(s.pausedUntil, until);
  const file = pausesFile();
  if (!file) return;
  const all = loadSavedPauses();
  all[ep.id] = s.pausedUntil;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all));
  } catch {
    /* optional */
  }
}

function rawFetch() {
  if (fetchOverride) return fetchOverride;
  try {
    const cache = require("./area-cache");
    if (typeof cache.rawFetch === "function") return cache.rawFetch();
  } catch {
    /* fall through */
  }
  return fetch;
}

function sleep(ms, signal) {
  if (sleepOverride) return sleepOverride(ms, signal);
  return new Promise((resolve) => {
    const t = setTimeout(done, Math.max(0, ms));
    if (typeof t.unref === "function") t.unref();
    function done() {
      if (signal) signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    if (signal) {
      if (signal.aborted) return done();
      signal.addEventListener("abort", done, { once: true });
    }
  });
}

function jitter() {
  return Math.floor(Math.random() * JITTER_MS);
}

async function acquire(ep, signal) {
  const s = endpointState(ep);
  if (s.active < ep.slots) {
    s.active += 1;
    return true;
  }
  return new Promise((resolve) => {
    const entry = { resolve, signal };
    const onAbort = () => {
      const i = s.queue.indexOf(entry);
      if (i >= 0) s.queue.splice(i, 1);
      resolve(false);
    };
    entry.onAbort = onAbort;
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    s.queue.push(entry);
  });
}

function release(ep) {
  const s = endpointState(ep);
  while (s.queue.length) {
    const next = s.queue.shift();
    if (next.signal) next.signal.removeEventListener("abort", next.onAbort);
    if (next.signal && next.signal.aborted) continue;
    next.resolve(true);
    return;
  }
  s.active = Math.max(0, s.active - 1);
}

/** Retry-After as seconds or an HTTP date. 0 when absent. */
function retryAfterMs(value, now) {
  const v = String(value || "").trim();
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - (now || Date.now()));
}

/**
 * /api/status text. Returns the wait until a slot opens in ms, 0 when a
 * slot is free now, or -1 when the text says nothing.
 */
function statusWaitMs(text) {
  const t = String(text || "");
  if (/\d+\s+slots? available now/i.test(t) && !/^0\s+slots/im.test(t)) return 0;
  let best = -1;
  const re = /Slot available after:[^\n]*?in\s+(-?\d+)\s+seconds?/gi;
  let m;
  while ((m = re.exec(t))) {
    const ms = Math.max(0, parseInt(m[1], 10) * 1000);
    if (best < 0 || ms < best) best = ms;
  }
  return best;
}

async function slotWaitMs(ep, ua) {
  if (!ep.status) return -1;
  try {
    const r = await rawFetch()(ep.base + "/status", {
      headers: { "user-agent": ua },
      signal: AbortSignal.timeout(STATUS_MS),
    });
    if (!r.ok) return -1;
    return statusWaitMs(await r.text());
  } catch {
    return -1;
  }
}

/** Overpass can answer 200 with a runtime error remark and no data. */
function bodyOk(kind, text) {
  const t = String(text || "");
  // A body cut off mid-stream (one server closes long chunked answers early) has no </osm>.
  if (kind === "map") return t.indexOf("<osm") >= 0 && t.lastIndexOf("</osm>") > 0 && !/<remark>\s*runtime error/i.test(t);
  const head = t.slice(0, 400);
  if (!/"elements"\s*:/.test(head) && !/"elements"\s*:/.test(t.slice(0, 4000))) return false;
  const tail = t.slice(-600);
  if (!/\}\s*$/.test(tail)) return false;
  return !/"remark"\s*:\s*"[^"]*runtime error/i.test(tail);
}

/** A busy-server answer: a runtime error remark instead of data. */
function isRemark(text) {
  return /runtime error|timed out|out of memory|rate_limited/i.test(String(text || "").slice(-2000));
}

async function readText(r) {
  if (r && typeof r.text === "function") return r.text();
  if (r && typeof r.json === "function") return JSON.stringify(await r.json());
  return "";
}

function memoKey(kind, payload) {
  return kind + ":" + crypto.createHash("sha1").update(String(payload)).digest("hex").slice(0, 24);
}

function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (nowFn() - hit.at > MEMO_MS) {
    memo.delete(key);
    return null;
  }
  return hit.value;
}

function memoSet(key, value) {
  memo.set(key, { at: nowFn(), value });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

function requestFor(ep, kind, payload, ua) {
  if (kind === "map") {
    return {
      url: ep.base + "/map?bbox=" + payload,
      init: { headers: { "user-agent": ua, accept: "application/xml,text/xml,*/*" } },
    };
  }
  return {
    url: ep.base + "/interpreter",
    init: {
      method: "POST",
      headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "data=" + encodeURIComponent(payload),
    },
  };
}

function log(tag, ep, kind, status, ms, n, extra) {
  try {
    logFn(
      "overpass" + (tag ? " " + tag : "") + " " + ep.id + " " + kind + " status=" + status + " ms=" + Math.round(ms) + " try=" + n + (extra ? " " + extra : "")
    );
  } catch {
    /* logging is optional */
  }
}

/**
 * One request to one endpoint. Resolves { ok, status, text, retryMs }.
 * Never throws for a network failure.
 */
function defaultUa() {
  try {
    return require("./version").userAgent;
  } catch {
    return "openclutter (https://github.com/jolla/OpenClutter)";
  }
}

async function attempt(ep, kind, payload, opts, n, outer, limitMs) {
  const ua = opts.ua || defaultUa();
  const got = await acquire(ep, outer);
  if (!got) return { ok: false, status: "aborted", text: "" };
  const t0 = nowFn();
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  const left = Math.max(1000, opts.deadlineAt - nowFn());
  const allowMs = Math.min(ATTEMPT_MS, left, limitMs > 0 ? limitMs : Infinity);
  const timer = setTimeout(() => ctrl.abort(), allowMs / timerScale);
  if (typeof timer.unref === "function") timer.unref();
  const s = endpointState(ep);
  try {
    const req = requestFor(ep, kind, payload, ua);
    const r = await rawFetch()(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
    const text = await readText(r);
    const ms = nowFn() - t0;
    s.silent = 0;
    if (!(typeof r.status === "number" && r.status > 0)) {
      // Not an HTTP answer this client can read (a stub without a status).
      if (r.ok && bodyOk(kind, text)) return { ok: true, status: 200, text };
      log(opts.tag, ep, kind, "unknown", ms, n);
      return { ok: false, status: 0, text: "", final: true };
    }
    if (r.ok && bodyOk(kind, text)) {
      s.fails = 0;
      log(opts.tag, ep, kind, r.status, ms, n, "bytes=" + text.length);
      return { ok: true, status: r.status, text };
    }
    if (r.status === 400 || (r.status >= 200 && r.status < 300)) {
      // A 400 is the query or box itself. Another server says the same.
      if (r.status === 400) {
        log(opts.tag, ep, kind, r.status, ms, n);
        return { ok: false, status: 400, text, final: true };
      }
      if (!isRemark(text)) {
        // 200 with no Overpass body at all. A retry would read the same.
        log(opts.tag, ep, kind, r.status + "-nobody", ms, n);
        return { ok: false, status: r.status, text: "", final: true };
      }
      s.fails += 1;
      const wait = backoffMs(s.fails);
      s.pausedUntil = Math.max(s.pausedUntil, nowFn() + wait);
      log(opts.tag, ep, kind, r.status + "-remark", ms, n, "backoff=" + wait);
      return { ok: false, status: r.status, text: "" };
    }
    if (r.status === 406) {
      // overpass-api.de answers 406 to an address it has blocked by hand
      // for heavy use. Asking again only prolongs it.
      s.fails += 1;
      const wait = BAN_PAUSE_MS + jitter();
      pauseLong(ep, nowFn() + wait);
      log(opts.tag, ep, kind, 406, ms, n, "blocked pause=" + Math.round(wait));
      return { ok: false, status: 406, text: "" };
    }
    if (r.status === 429) {
      let wait = retryAfterMs(r.headers && r.headers.get && r.headers.get("retry-after"), nowFn());
      let slot = -1;
      if (!wait) {
        slot = await slotWaitMs(ep, ua);
        if (slot > 0) wait = slot;
      }
      wait = Math.max(wait, ep.pause429Ms) + jitter();
      s.pausedUntil = Math.max(s.pausedUntil, nowFn() + wait);
      log(opts.tag, ep, kind, r.status, ms, n, "pause=" + Math.round(wait) + (slot >= 0 ? " slotIn=" + slot : ""));
      return { ok: false, status: r.status, text: "" };
    }
    s.fails += 1;
    const wait = backoffMs(s.fails);
    s.pausedUntil = Math.max(s.pausedUntil, nowFn() + wait);
    log(opts.tag, ep, kind, r.status, ms, n, "backoff=" + wait);
    return { ok: false, status: r.status, text: "" };
  } catch (e) {
    const ms = nowFn() - t0;
    const aborted = !!(outer && outer.aborted);
    const code = errorCode(e);
    if (!aborted && !ctrl.signal.aborted && REFUSED_CODES.has(code) && ms < REFUSED_MAX_MS) {
      s.fails += 1;
      pauseLong(ep, nowFn() + REFUSED_PAUSE_MS);
      log(opts.tag, ep, kind, "refused", ms, n, "code=" + code + " pause=" + REFUSED_PAUSE_MS);
    } else if (!aborted) {
      s.fails += 1;
      const timedOut = ctrl.signal.aborted;
      // A server that sends nothing for a whole fair share, twice in a row,
      // is skipped for a while instead of eating every read's window.
      if (timedOut && allowMs >= MIN_ATTEMPT_MS) s.silent += 1;
      if (timedOut && s.silent >= DEAD_AFTER) {
        pauseLong(ep, nowFn() + DEAD_PAUSE_MS);
        log(opts.tag, ep, kind, "timeout", ms, n, "silent=" + s.silent + " pause=" + DEAD_PAUSE_MS);
      } else {
        const wait = backoffMs(s.fails);
        s.pausedUntil = Math.max(s.pausedUntil, nowFn() + wait);
        log(opts.tag, ep, kind, timedOut ? "timeout" : "neterr", ms, n, "backoff=" + wait + (code ? " code=" + code : ""));
      }
    } else {
      log(opts.tag, ep, kind, "cancelled", ms, n);
    }
    return { ok: false, status: aborted ? "aborted" : "timeout", text: "" };
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuter);
    release(ep);
  }
}

function backoffMs(fails) {
  const n = Math.max(1, fails | 0);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, n - 1)) + jitter();
}

/** Regular servers that failed in this read. */
function regularFails(failed) {
  if (!failed) return 0;
  let n = 0;
  for (const ep of endpoints()) if (!ep.lastResort && failed.has(ep.id)) n++;
  return n;
}

function nextEndpoint(skip, failed) {
  const list = endpoints();
  const now = nowFn();
  const open = (ep) => !(skip && skip.has(ep.id)) && !(failed && failed.has(ep.id)) && endpointState(ep).pausedUntil <= now;
  // A regular server not asked yet in this read and free now comes first.
  for (const ep of list) if (!ep.lastResort && open(ep)) return { ep, waitMs: 0 };
  // Two regular servers failed this read: the last resort before waiting
  // on a server that already failed.
  if (regularFails(failed) >= 2) {
    for (const ep of list) if (ep.lastResort && open(ep)) return { ep, waitMs: 0 };
  }
  let best = null;
  let soonest = Infinity;
  for (const ep of list) {
    if (ep.lastResort || (skip && skip.has(ep.id))) continue;
    const s = endpointState(ep);
    if (s.pausedUntil <= now) return { ep, waitMs: 0 };
    if (s.pausedUntil < soonest) {
      soonest = s.pausedUntil;
      best = ep;
    }
  }
  // Every regular server is busy or refused: a last resort that is free
  // now beats a wait longer than LAST_RESORT_WAIT_MS.
  if (!best || soonest - now > LAST_RESORT_WAIT_MS) {
    for (const ep of list) {
      if (!ep.lastResort || (skip && skip.has(ep.id))) continue;
      const s = endpointState(ep);
      if (s.pausedUntil <= now) return { ep, waitMs: 0 };
      if (s.pausedUntil < soonest) {
        soonest = s.pausedUntil;
        best = ep;
      }
    }
  }
  if (!best) return null;
  return { ep: best, waitMs: soonest - now };
}

/**
 * How long one server may take in this read. The last server that can
 * still be asked gets the rest of the window (up to ATTEMPT_MS); while
 * another is left, RESERVE_MS stays back for it. Tile reads
 * (opts.slowFailMs, export-mode tiledOsm) give each server a third of
 * what is left, never under slowFailMs, since two tiles share the window.
 */
function attemptLimitMs(ep, failed, opts, skip) {
  const now = nowFn();
  const left = Math.max(0, opts.deadlineAt - now);
  const more = endpoints().some((e) => e !== ep && !(skip && skip.has(e.id)) && !(failed && failed.has(e.id)) && endpointState(e).pausedUntil < opts.deadlineAt - 1000);
  if (!more) return Math.min(ATTEMPT_MS, left);
  if (opts.slowFailMs > 0) return Math.min(ATTEMPT_MS, Math.max(opts.slowFailMs, Math.round(left / 3)));
  return Math.min(ATTEMPT_MS, Math.max(Math.min(MIN_ATTEMPT_MS, Math.round(left / 2)), left - RESERVE_MS));
}

/**
 * The network part: one server at a time, in order, with pauses and
 * backoff, until one answers or the deadline passes. Never two servers
 * for the same read at once.
 */
async function fetchAcross(kind, payload, opts) {
  const outer = new AbortController();
  const parent = opts.signal;
  const onParent = () => outer.abort();
  if (parent) {
    if (parent.aborted) outer.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  const deadlineTimer = setTimeout(() => outer.abort(), Math.max(0, opts.deadlineAt - nowFn()));
  if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
  const tileRead = opts.slowFailMs > 0;
  let n = 0;
  let lastStatus = 0;
  const failed = new Set();
  // Tile reads: a server that sent an empty or cut-off body is not asked again in this read.
  const spent = new Set();
  try {
    while (!outer.signal.aborted && nowFn() < opts.deadlineAt) {
      const pick = nextEndpoint(spent, failed);
      if (!pick) break;
      if (pick.waitMs > 0) {
        if (nowFn() + pick.waitMs >= opts.deadlineAt) break;
        await sleep(pick.waitMs + jitter(), outer.signal);
        continue;
      }
      n += 1;
      const r = await attempt(pick.ep, kind, payload, opts, n, outer.signal, attemptLimitMs(pick.ep, failed, opts, spent));
      if (r && r.ok) return r;
      if (!r || r.status === "aborted") break;
      // A 400 is the query itself. Outside tile reads an empty or cut-off
      // 200 ends the read as before; a tile read moves to the next server.
      if (r.final && (r.status === 400 || !tileRead)) return r;
      failed.add(pick.ep.id);
      lastStatus = r.status || lastStatus;
      if (r.final) spent.add(pick.ep.id);
    }
    return { ok: false, status: lastStatus || "deadline", text: "" };
  } finally {
    clearTimeout(deadlineTimer);
    outer.abort();
    if (parent) parent.removeEventListener("abort", onParent);
  }
}

/**
 * Interpreter read that returns parsed JSON or null. For callers that
 * used to loop over endpoints themselves.
 */
async function requestJson(query, opts) {
  const o = opts || {};
  const res = await request({ kind: "interpreter", query, signal: o.signal, ua: o.ua, deadlineMs: o.deadlineMs, tag: o.tag });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function bboxPayload(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => +v).join(",");
}

/**
 * Read Overpass with retries and endpoint fallback.
 * opts.kind "map" (bbox) or "interpreter" (query). opts.signal and
 * opts.deadlineMs bound the whole read.
 * @returns {Promise<{ok:boolean, status:number|string, text:string, cached?:boolean}>}
 */
async function request(opts) {
  const o = opts || {};
  const kind = o.kind === "map" ? "map" : "interpreter";
  const payload = kind === "map" ? bboxPayload(o.bbox) : String(o.query || "");
  const key = memoKey(kind, payload);
  const hit = memoGet(key);
  if (hit) return Object.assign({ cached: true }, hit);
  const disk = diskGet(kind, payload);
  if (disk) {
    const value = { ok: true, status: 200, text: disk };
    memoSet(key, value);
    try {
      logFn("overpass" + (o.tag ? " " + o.tag : "") + " disk " + kind + " bytes=" + disk.length);
    } catch {
      /* logging is optional */
    }
    return Object.assign({ cached: true, disk: true }, value);
  }
  if (inflight.has(key)) return waitWithSignal(inflight.get(key), o.signal);
  const deadlineAt = nowFn() + (o.deadlineMs > 0 ? o.deadlineMs : DEFAULT_DEADLINE_MS);
  // The shared read keeps going when one caller leaves; it stops at its own deadline.
  const work = loadThroughCache(kind, payload, o.bbox, {
    ua: o.ua,
    tag: o.tag || "",
    deadlineAt,
    signal: null,
    slowFailMs: o.slowFailMs > 0 ? o.slowFailMs : 0,
  }).then((res) => {
    if (res && res.ok) {
      memoSet(key, { ok: true, status: res.status, text: res.text });
      diskSet(kind, payload, res.text);
    }
    return res;
  });
  inflight.set(key, work);
  work.finally(() => {
    if (inflight.get(key) === work) inflight.delete(key);
  });
  return waitWithSignal(work, o.signal);
}

function waitWithSignal(work, signal) {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve({ ok: false, status: "aborted", text: "" });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ ok: false, status: "aborted", text: "" });
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve({ ok: false, status: "error", text: "" });
      }
    );
  });
}

/** The blob store's OSM copy (6 h) when it is on, so other machines reuse a read. */
async function loadThroughCache(kind, payload, bbox, opts) {
  let cache = null;
  try {
    cache = require("./area-cache");
  } catch {
    cache = null;
  }
  if (!cache || !cache.enabled() || fetchOverride) return fetchAcross(kind, payload, opts);
  const spec =
    kind === "map"
      ? cache.classifyFetch(ENDPOINTS[0].base + "/map?bbox=" + payload, {})
      : cache.classifyFetch(ENDPOINTS[0].base + "/interpreter", { body: "data=" + encodeURIComponent(payload) });
  if (!spec) return fetchAcross(kind, payload, opts);
  let res = null;
  try {
    const got = await cache.loadRaw(spec, async () => {
      res = await fetchAcross(kind, payload, opts);
      if (!res.ok) return { ok: false, status: res.status };
      const body = Buffer.from(res.text);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? spec.contentType : "") },
        arrayBuffer: async () => body,
      };
    });
    const text = Buffer.isBuffer(got.body) ? got.body.toString("utf8") : String(got.body || "");
    if (!bodyOk(kind, text)) return res && res.ok ? res : { ok: false, status: "bad-cache", text: "" };
    return { ok: true, status: got.status || 200, text, cached: !res };
  } catch {
    return res || { ok: false, status: "error", text: "" };
  }
}

/** Status line for the earlier single-fetch paths, so both modes show in the logs. */
function logLegacy(url, kind, status, ms) {
  let host = "";
  try {
    host = new URL(String(url)).host;
  } catch {
    host = String(url || "");
  }
  try {
    logFn("overpass legacy " + host + " " + kind + " status=" + status + " ms=" + Math.round(ms));
  } catch {
    /* logging is optional */
  }
}

function resetForTests(opts) {
  state.clear();
  memo.clear();
  inflight.clear();
  savedPauses = null;
  const o = opts || {};
  fetchOverride = o.fetch || null;
  logFn = o.log || (() => {});
  nowFn = o.now || Date.now;
  sleepOverride = o.sleep || null;
  timerScale = o.timerScale > 0 ? o.timerScale : 1;
}

module.exports = {
  ENDPOINTS,
  REFUSED_PAUSE_MS,
  LAST_RESORT_WAIT_MS,
  errorCode,
  ATTEMPT_MS,
  MIN_ATTEMPT_MS,
  RESERVE_MS,
  BAN_PAUSE_MS,
  DEAD_AFTER,
  DEAD_PAUSE_MS,
  endpoints,
  diskKey,
  MEMO_MS,
  request,
  logLegacy,
  requestJson,
  retryAfterMs,
  statusWaitMs,
  bodyOk,
  backoffMs,
  resetForTests,
};
