"use strict";

/**
 * One client for every Overpass read of an export.
 *
 * Public Overpass servers turn requests away under load: 429 when the
 * caller's slots are taken, 504 or a "runtime error" remark when the
 * server is busy, or no answer at all. A single fetch per endpoint loses
 * the street map on a busy minute. This client:
 *   - asks each endpoint in turn, and starts the next one beside a slow
 *     first answer (one extra request, never a burst),
 *   - honours Retry-After and the /api/status slot time on a 429, and
 *     pauses that endpoint (the main instance asks for 30 s),
 *   - backs off with jitter after 5xx answers and timeouts,
 *   - caps requests in flight per endpoint inside this process,
 *   - coalesces identical reads and keeps a short-lived copy of each
 *     answer (OSM data, ODbL; credited in ATTRIBUTION.txt).
 * The caller's signal or deadline is final. A read that is still missing
 * then returns ok:false and the export keeps its existing warning.
 *
 * Endpoint policies (wiki.openstreetmap.org/wiki/Overpass_API, Oct 2026):
 * overpass-api.de is overloaded, asks for no parallel scripts and a 30 s
 * pause after 429; private.coffee (formerly kumi.systems) has no rate
 * limit, allows commercial use, and asks for fewer than 10 requests at a
 * time; VK Maps states no limits.
 */

const crypto = require("node:crypto");

const ENDPOINTS = [
  { id: "overpass-api.de", base: "https://overpass-api.de/api", slots: 2, pause429Ms: 30000, status: true },
  { id: "private.coffee", base: "https://overpass.private.coffee/api", slots: 3, pause429Ms: 10000, status: true },
  { id: "maps.mail.ru", base: "https://maps.mail.ru/osm/tools/overpass/api", slots: 2, pause429Ms: 10000, status: false },
];

/** Start the next endpoint beside a first answer this slow. */
const HEDGE_MS = 15000;
/** Longest wait on one request. */
const ATTEMPT_MS = 60000;
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

function endpointState(ep) {
  let s = state.get(ep.id);
  if (!s) {
    s = { active: 0, queue: [], pausedUntil: 0, fails: 0 };
    state.set(ep.id, s);
  }
  return s;
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
  if (kind === "map") return t.indexOf("<osm") >= 0 && !/<remark>\s*runtime error/i.test(t);
  const head = t.slice(0, 400);
  if (!/"elements"\s*:/.test(head) && !/"elements"\s*:/.test(t.slice(0, 4000))) return false;
  const tail = t.slice(-600);
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
async function attempt(ep, kind, payload, opts, n, outer) {
  const ua = opts.ua || "OpenClutter/1.0 (+https://openclutter.com)";
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
  const timer = setTimeout(() => ctrl.abort(), Math.min(ATTEMPT_MS, left));
  if (typeof timer.unref === "function") timer.unref();
  const s = endpointState(ep);
  try {
    const req = requestFor(ep, kind, payload, ua);
    const r = await rawFetch()(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
    const text = await readText(r);
    const ms = nowFn() - t0;
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
    if (r.status === 429 || r.status === 406) {
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
    if (!aborted) {
      s.fails += 1;
      const wait = backoffMs(s.fails);
      s.pausedUntil = Math.max(s.pausedUntil, nowFn() + wait);
      log(opts.tag, ep, kind, ctrl.signal.aborted ? "timeout" : "neterr", ms, n, "backoff=" + wait);
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

function nextEndpoint(skip) {
  const now = nowFn();
  let best = null;
  let soonest = Infinity;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const ep = ENDPOINTS[i];
    if (skip && skip.has(ep.id)) continue;
    const s = endpointState(ep);
    if (s.pausedUntil <= now) return { ep, waitMs: 0 };
    if (s.pausedUntil < soonest) {
      soonest = s.pausedUntil;
      best = ep;
    }
  }
  if (!best) return null;
  return { ep: best, waitMs: soonest - now };
}

/**
 * The network part: endpoints in order, a hedge beside a slow answer,
 * pauses and backoff, until one answers or the deadline passes.
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
  let n = 0;
  let lastStatus = 0;
  try {
    while (!outer.signal.aborted && nowFn() < opts.deadlineAt) {
      const pick = nextEndpoint(null);
      if (!pick) break;
      if (pick.waitMs > 0) {
        if (nowFn() + pick.waitMs >= opts.deadlineAt) break;
        await sleep(pick.waitMs + jitter(), outer.signal);
        continue;
      }
      n += 1;
      const running = new Set([pick.ep.id]);
      const races = [attempt(pick.ep, kind, payload, opts, n, outer.signal)];
      let settledFirst = false;
      const hedgeWait = new AbortController();
      const onOuterStop = () => hedgeWait.abort();
      outer.signal.addEventListener("abort", onOuterStop, { once: true });
      races[0].then(() => {
        settledFirst = true;
        hedgeWait.abort();
        outer.signal.removeEventListener("abort", onOuterStop);
      });
      // Hedge: one more endpoint beside a slow first answer.
      const hedge = sleep(HEDGE_MS, hedgeWait.signal).then(() => {
        if (settledFirst || outer.signal.aborted) return null;
        const other = nextEndpoint(running);
        if (!other || other.waitMs > 0) return null;
        running.add(other.ep.id);
        n += 1;
        return attempt(other.ep, kind, payload, opts, n, outer.signal);
      });
      const winner = await firstOk([races[0], hedge]);
      if (winner && winner.ok) return winner;
      if (winner && winner.final) return winner;
      lastStatus = (winner && winner.status) || lastStatus;
    }
    return { ok: false, status: lastStatus || "deadline", text: "" };
  } finally {
    clearTimeout(deadlineTimer);
    outer.abort();
    if (parent) parent.removeEventListener("abort", onParent);
  }
}

/** First ok result; otherwise the last one once all settle. */
function firstOk(promises) {
  return new Promise((resolve) => {
    let left = promises.length;
    let last = null;
    for (const p of promises) {
      Promise.resolve(p).then(
        (res) => {
          if (res && (res.ok || res.final)) return resolve(res);
          if (res) last = res;
          if (--left === 0) resolve(last);
        },
        () => {
          if (--left === 0) resolve(last);
        }
      );
    }
  });
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
  if (inflight.has(key)) return waitWithSignal(inflight.get(key), o.signal);
  const deadlineAt = nowFn() + (o.deadlineMs > 0 ? o.deadlineMs : DEFAULT_DEADLINE_MS);
  // The shared read keeps going when one caller leaves; it stops at its own deadline.
  const work = loadThroughCache(kind, payload, o.bbox, {
    ua: o.ua,
    tag: o.tag || "",
    deadlineAt,
    signal: null,
  }).then((res) => {
    if (res && res.ok) memoSet(key, { ok: true, status: res.status, text: res.text });
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
  const o = opts || {};
  fetchOverride = o.fetch || null;
  logFn = o.log || (() => {});
  nowFn = o.now || Date.now;
  sleepOverride = o.sleep || null;
}

module.exports = {
  ENDPOINTS,
  HEDGE_MS,
  ATTEMPT_MS,
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
