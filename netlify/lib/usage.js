"use strict";

/**
 * Anonymous usage totals in the Netlify Blobs store openclutter-usage.
 *
 * Visitor id is sha256(monthSalt + ip + userAgent). monthSalt is 32 hex
 * chars from 16 random bytes, one per America/Chicago calendar month, stored
 * here. It is not an environment variable. Raw IP addresses and user agents
 * are never written.
 *
 * The salt and the per-visitor records are deleted once that month's
 * aggregates have been reconciled, which happens on the 4th Chicago day of
 * the next month (three days into the new month). After that, only the
 * aggregate documents remain, so an id from one month cannot be linked to
 * the next.
 *
 * Periods are the Chicago day, the ISO week, and the calendar month. Each
 * is split into prod (openclutter.com and www), dev (dev.openclutter.com),
 * and other. A week whose Monday and Sunday fall in different months counts
 * a person once in each month, so that week's unique users, exporting users,
 * and exports-per-user histogram can be high. Those weeks are marked approx.
 *
 * Totals are one JSON document per period and host, updated with an etag
 * retry. Two events for the same visitor at the same moment can drop or
 * double an increment. While the visitor records still exist, reconciliation
 * rewrites the finished days, the month, and any finished week from those
 * records, so a finalized month matches the records. Until then, treat the
 * numbers as close rather than exact.
 *
 * exportsPerUser is the distribution of exports started among users with at
 * least one start (mean, median, histogram 1 / 2-3 / 4-10 / 11+). A finish
 * is attributed to the same visitor id and to the Chicago day the job was
 * created. The id is stored on the job record until that job expires so the
 * finish can be counted without the IP. The status response does not include it.
 *
 * The page ping and an export are skipped for an empty or bot-like user
 * agent, a prefetch, Do Not Track, or Global Privacy Control. In-process
 * benches call the export function directly and do not create a job or load
 * the page, so they are not counted. There is no bench query flag on those
 * calls. navigator.webdriver skips an automated browser that does load the page.
 *
 * Fly writes the finished job from its own copy of export-jobs.js. The visitor
 * id is computed on Netlify when the job is created, so the worker never sees
 * the IP. Until that worker is redeployed, its write does not increment the
 * finish. The Netlify background function, and any status read, claims a
 * finished job that has no usageCounted stamp. A finish is missed only when
 * the worker writes it after Netlify has stopped watching and nothing reads
 * status. Redeploying the worker makes the write itself count.
 */

const crypto = require("node:crypto");

const STORE_NAME = "openclutter-usage";
const TZ = "America/Chicago";
const HOSTS = ["prod", "dev", "other"];
const SWEEP_EVERY_MS = 30 * 60 * 1000;
const DAY_LIMIT = 400;
const WEEK_LIMIT = 104;
const MONTH_LIMIT = 36;
const HISTOGRAM_KEYS = ["1", "2-3", "4-10", "11+"];

const BOT_UA =
  /bot\b|spider|crawler|\bcrawl\b|slurp|\bwget\b|\bcurl\b|python-requests|python-urllib|go-http-client|headless|phantomjs|selenium|playwright|puppeteer|lighthouse|bytespider|ahrefs|semrush|dotbot|uptimerobot|pingdom|statuscake|site24x7|kube-probe|healthchecker|health-check|healthcheck|facebookexternalhit|embedly|slackbot|discordbot|telegrambot|applebot|duckduckbot|baiduspider|yandexbot|bingpreview|ia_archiver/i;

let storeMode = "live";
let storeOverride = null;
let nowFn = () => Date.now();
let lastSweepAt = 0;

function setStoreForTests(store) {
  if (store === undefined) {
    storeMode = "live";
    storeOverride = null;
  } else {
    storeMode = "test";
    storeOverride = store;
  }
}

function setNowForTests(fn) {
  nowFn = typeof fn === "function" ? fn : () => Date.now();
}

function resetSweepForTests() {
  lastSweepAt = 0;
}

function now() {
  return nowFn();
}

function header(headers, name) {
  const want = name.toLowerCase();
  const src = headers || {};
  for (const k of Object.keys(src)) {
    if (String(k).toLowerCase() === want) {
      const v = src[k];
      return Array.isArray(v) ? String(v[0] || "") : String(v || "");
    }
  }
  return "";
}

function requestHost(headers) {
  const xf = header(headers, "x-forwarded-host").split(",")[0].trim();
  return xf || header(headers, "host").split(",")[0].trim();
}

function clientIp(headers) {
  const nf = header(headers, "x-nf-client-connection-ip").trim();
  if (nf) return nf;
  const client = header(headers, "client-ip").trim();
  if (client) return client;
  return header(headers, "x-forwarded-for").split(",")[0].trim();
}

function hostBucket(host) {
  const raw = String(host || "").trim().toLowerCase();
  if (raw === "prod" || raw === "dev" || raw === "other") return raw;
  const name = raw.split(",")[0].trim().replace(/:\d+$/, "");
  if (name === "openclutter.com" || name === "www.openclutter.com") return "prod";
  if (name === "dev.openclutter.com") return "dev";
  return "other";
}

function isBot(ua) {
  const s = String(ua || "").trim();
  if (!s || s.length > 500) return true;
  return BOT_UA.test(s);
}

function skipPing(headers) {
  const dnt = header(headers, "dnt").trim().toLowerCase();
  if (dnt === "1" || dnt === "yes") return true;
  if (header(headers, "sec-gpc").trim() === "1") return true;
  const purpose = (
    header(headers, "purpose") ||
    header(headers, "sec-purpose") ||
    header(headers, "x-purpose")
  ).toLowerCase();
  if (purpose.indexOf("prefetch") !== -1 || purpose.indexOf("preview") !== -1) return true;
  if (isBot(header(headers, "user-agent"))) return true;
  return false;
}

function chicagoDate(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : "";
  };
  return get("year") + "-" + get("month") + "-" + get("day");
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const [y, m, d] = String(s).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validMonth(s) {
  return /^\d{4}-\d{2}$/.test(String(s || "")) && validDate(String(s) + "-01");
}

function validWeek(s) {
  if (!/^\d{4}-W\d{2}$/.test(String(s || ""))) return false;
  const week = Number(String(s).slice(6));
  if (week < 1 || week > 53) return false;
  const start = weekStart(s);
  return isoWeekKey(start) === s;
}

function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return dt.getUTCFullYear() + "-" + mm + "-" + dd;
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
}

function isoWeekKey(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const isoYear = dt.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return isoYear + "-W" + String(week).padStart(2, "0");
}

function weekStart(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekKey || ""));
  if (!m) return "";
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1) + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

function weekEnd(weekKey) {
  const start = weekStart(weekKey);
  return start ? shiftDate(start, 6) : "";
}

function weekSpansMonths(weekKey) {
  const start = weekStart(weekKey);
  const end = weekEnd(weekKey);
  return !!start && start.slice(0, 7) !== end.slice(0, 7);
}

function eachDayOfMonth(month) {
  const out = [];
  let cur = month + "-01";
  while (cur.slice(0, 7) === month) {
    out.push(cur);
    cur = shiftDate(cur, 1);
  }
  return out;
}

function monthLastDay(month) {
  const days = eachDayOfMonth(month);
  return days[days.length - 1] || month + "-01";
}

function periodBounds(period, key) {
  if (period === "week") return { start: weekStart(key), end: weekEnd(key) };
  if (period === "month") return { start: key + "-01", end: monthLastDay(key) };
  return { start: key, end: key };
}

function emptyAgg(approx) {
  return {
    pageviews: 0,
    uniqueUsers: 0,
    exportingUsers: 0,
    exportsStarted: 0,
    exportsDone: 0,
    exportsError: 0,
    exportsCancelled: 0,
    byCount: {},
    approx: !!approx,
  };
}

function copyAgg(row, approx) {
  const base = emptyAgg(approx);
  if (!row || typeof row !== "object") return base;
  base.pageviews = row.pageviews | 0;
  base.uniqueUsers = row.uniqueUsers | 0;
  base.exportingUsers = row.exportingUsers | 0;
  base.exportsStarted = row.exportsStarted | 0;
  base.exportsDone = row.exportsDone | 0;
  base.exportsError = row.exportsError | 0;
  base.exportsCancelled = row.exportsCancelled | 0;
  base.byCount = Object.assign({}, row.byCount || {});
  base.approx = !!(row.approx || approx);
  return base;
}

function copyVisitor(row) {
  const src = row && typeof row === "object" ? row : {};
  const out = {};
  for (const k of ["pv", "st", "dn", "er", "ca"]) out[k] = Object.assign({}, src[k] || {});
  return out;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function histogramBucket(count) {
  if (count <= 1) return "1";
  if (count <= 3) return "2-3";
  if (count <= 10) return "4-10";
  return "11+";
}

function distributionStats(byCount) {
  const hist = { "1": 0, "2-3": 0, "4-10": 0, "11+": 0 };
  const values = [];
  let weighted = 0;
  let users = 0;
  const src = byCount || {};
  for (const k of Object.keys(src)) {
    const c = Number(k);
    const n = src[k] | 0;
    if (!(c > 0) || !(n > 0)) continue;
    users += n;
    weighted += c * n;
    hist[histogramBucket(c)] += n;
    for (let i = 0; i < n; i++) values.push(c);
  }
  values.sort((a, b) => a - b);
  let median = null;
  if (values.length) {
    const mid = Math.floor(values.length / 2);
    median = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }
  return { hist, weighted, users, median };
}

function present(row) {
  const src = copyAgg(row, false);
  const dist = distributionStats(src.byCount);
  const exporting = src.exportingUsers | 0;
  const usersForMean = dist.users || exporting;
  const weighted = dist.users ? dist.weighted : src.exportsStarted;
  const mean = usersForMean > 0 ? round6(weighted / usersForMean) : null;
  return {
    pageviews: src.pageviews,
    uniqueUsers: src.uniqueUsers,
    exportingUsers: exporting,
    exportsStarted: src.exportsStarted,
    exportsDone: src.exportsDone,
    exportsError: src.exportsError,
    exportsCancelled: src.exportsCancelled,
    exportsPerUser: {
      mean,
      median: dist.median,
      histogram: dist.hist,
    },
    conversion: {
      exportsPerPageview: src.pageviews > 0 ? round6(src.exportsStarted / src.pageviews) : null,
      exportingUsersPerUnique: src.uniqueUsers > 0 ? round6(exporting / src.uniqueUsers) : null,
    },
  };
}

function mergeAggs(rows) {
  const out = emptyAgg(false);
  for (const row of rows) {
    const src = copyAgg(row, false);
    out.pageviews += src.pageviews;
    out.uniqueUsers += src.uniqueUsers;
    out.exportingUsers += src.exportingUsers;
    out.exportsStarted += src.exportsStarted;
    out.exportsDone += src.exportsDone;
    out.exportsError += src.exportsError;
    out.exportsCancelled += src.exportsCancelled;
    for (const k of Object.keys(src.byCount)) {
      out.byCount[k] = (out.byCount[k] | 0) + (src.byCount[k] | 0);
    }
    if (src.approx) out.approx = true;
  }
  return out;
}

function visitorHash(salt, ip, ua) {
  return crypto
    .createHash("sha256")
    .update(String(salt) + String(ip) + String(ua))
    .digest("hex");
}

function aggKey(period, key, host) {
  return "agg/" + period + "/" + key + "/" + host;
}

function visitorKey(month, host, hash) {
  return "vis/" + month + "/" + host + "/" + hash;
}

async function openStore() {
  if (storeMode === "test") return storeOverride || null;
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore({ name: STORE_NAME });
  } catch {
    return null;
  }
}

function keyHashes() {
  return String(process.env.OPENCLUTTER_API_KEY_HASHES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

function accessMode() {
  return keyHashes().length ? "api-key" : "public";
}

function presentedKey(headers) {
  const auth = /^Bearer\s+(\S+)$/i.exec(header(headers, "authorization").trim());
  if (auth) return auth[1];
  return header(headers, "x-openclutter-key").trim();
}

function readAllowed(headers) {
  const list = keyHashes();
  if (!list.length) return true;
  const key = presentedKey(headers);
  if (!key) return false;
  const got = Buffer.from(crypto.createHash("sha256").update(String(key)).digest("hex"), "hex");
  for (const h of list) {
    const want = Buffer.from(h, "hex");
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return true;
  }
  return false;
}

async function listKeys(store, prefix) {
  if (!store || typeof store.list !== "function") return [];
  const listed = await store.list({ prefix });
  return ((listed && listed.blobs) || []).map((b) => b.key).filter(Boolean);
}

async function updateJson(store, key, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let cur = null;
    let etag = null;
    let haveMeta = typeof store.getWithMetadata === "function";
    if (haveMeta) {
      try {
        const row = await store.getWithMetadata(key, { type: "json" });
        if (row && row.data) cur = row.data;
        if (row && row.etag) etag = row.etag;
      } catch {
        haveMeta = false;
        cur = await store.get(key, { type: "json" });
      }
    } else {
      cur = await store.get(key, { type: "json" });
    }
    const next = fn(cur);
    if (!next) return cur;
    if (haveMeta && etag) {
      const res = await store.setJSON(key, next, { onlyIfMatch: etag });
      if (res && res.modified === false) continue;
      return next;
    }
    if (haveMeta && !etag) {
      const res = await store.setJSON(key, next, { onlyIfNew: true });
      if (res && res.modified === false) continue;
      return next;
    }
    await store.setJSON(key, next);
    return next;
  }
  return null;
}

async function ensureSalt(store, month) {
  const key = "salt/" + month;
  const existing = await store.get(key, { type: "json" });
  if (existing && existing.salt) return String(existing.salt);
  const salt = crypto.randomBytes(16).toString("hex");
  try {
    const res = await store.setJSON(key, { salt }, { onlyIfNew: true });
    if (res && res.modified === false) {
      const again = await store.get(key, { type: "json" });
      if (again && again.salt) return String(again.salt);
    }
  } catch {
    const again = await store.get(key, { type: "json" });
    if (again && again.salt) return String(again.salt);
    await store.setJSON(key, { salt });
  }
  return salt;
}

function sumMap(map, pred) {
  let n = 0;
  const src = map || {};
  for (const day of Object.keys(src)) {
    if (pred(day)) n += src[day] | 0;
  }
  return n;
}

function presence(rec, pred) {
  return sumMap(rec && rec.pv, pred) + sumMap(rec && rec.st, pred) > 0;
}

function bumpMap(map, day, delta) {
  const next = Object.assign({}, map || {});
  const n = (next[day] | 0) + delta;
  if (n <= 0) delete next[day];
  else next[day] = n;
  return next;
}

function effectsFor(before, after, day, kind, delta) {
  const week = isoWeekKey(day);
  const month = day.slice(0, 7);
  const specs = [
    ["day", day, (d) => d === day],
    ["week", week, (d) => isoWeekKey(d) === week],
    ["month", month, (d) => d.slice(0, 7) === month],
  ];
  const field = { pv: "pageviews", st: "exportsStarted", dn: "exportsDone", er: "exportsError", ca: "exportsCancelled" }[kind];
  const out = [];
  for (const [period, key, pred] of specs) {
    const effect = {
      period,
      key,
      pageviews: 0,
      exportsStarted: 0,
      exportsDone: 0,
      exportsError: 0,
      exportsCancelled: 0,
      uniqueDelta: 0,
      exportingDelta: 0,
      fromCount: 0,
      toCount: 0,
    };
    effect[field] = delta;
    if (kind === "pv" || kind === "st") {
      const was = presence(before, pred);
      const will = presence(after, pred);
      if (was !== will) effect.uniqueDelta = will ? 1 : -1;
    }
    if (kind === "st") {
      const from = sumMap(before && before.st, pred);
      const to = sumMap(after && after.st, pred);
      if (from === 0 && to > 0) effect.exportingDelta = 1;
      else if (from > 0 && to === 0) effect.exportingDelta = -1;
      effect.fromCount = from;
      effect.toCount = to;
    }
    out.push(effect);
  }
  return out;
}

function applyEffect(row, effect) {
  const approx = effect.period === "week" && weekSpansMonths(effect.key);
  const next = copyAgg(row, approx);
  if (approx) next.approx = true;
  next.pageviews = Math.max(0, next.pageviews + (effect.pageviews | 0));
  next.exportsStarted = Math.max(0, next.exportsStarted + (effect.exportsStarted | 0));
  next.exportsDone = Math.max(0, next.exportsDone + (effect.exportsDone | 0));
  next.exportsError = Math.max(0, next.exportsError + (effect.exportsError | 0));
  next.exportsCancelled = Math.max(0, next.exportsCancelled + (effect.exportsCancelled | 0));
  next.uniqueUsers = Math.max(0, next.uniqueUsers + (effect.uniqueDelta | 0));
  next.exportingUsers = Math.max(0, next.exportingUsers + (effect.exportingDelta | 0));
  if (effect.fromCount > 0 && effect.fromCount !== effect.toCount) {
    const k = String(effect.fromCount);
    const left = (next.byCount[k] | 0) - 1;
    if (left <= 0) delete next.byCount[k];
    else next.byCount[k] = left;
  }
  if (effect.toCount > 0 && effect.fromCount !== effect.toCount) {
    const k = String(effect.toCount);
    next.byCount[k] = (next.byCount[k] | 0) + 1;
  }
  return next;
}

async function record(ctx, kind, delta) {
  const store = await openStore();
  if (!store || !ctx || !ctx.visitor) return null;
  const at = ctx.now != null ? ctx.now : now();
  const day = chicagoDate(at);
  const month = ctx.month || day.slice(0, 7);
  const host = hostBucket(ctx.host);
  await sweepMonths(store, day, false).catch(() => {});
  const vKey = visitorKey(month, host, ctx.visitor);
  let effects = null;
  const written = await updateJson(store, vKey, (cur) => {
    const before = copyVisitor(cur);
    let applied = delta | 0;
    if (applied < 0) {
      const had = before[kind] && before[kind][day] ? before[kind][day] | 0 : 0;
      if (had <= 0) {
        effects = [];
        return null;
      }
      if (had + applied < 0) applied = -had;
    }
    if (!applied) {
      effects = [];
      return null;
    }
    const after = copyVisitor(before);
    after[kind] = bumpMap(before[kind], day, applied);
    effects = effectsFor(before, after, day, kind, applied);
    return after;
  });
  if (!effects) return null;
  for (const effect of effects) {
    await updateJson(store, aggKey(effect.period, effect.key, host), (cur) => applyEffect(cur, effect));
  }
  return written ? { day, month, host } : { day, month, host, undone: true };
}

async function attribute(headers, nowMs) {
  const at = nowMs != null ? nowMs : now();
  const host = hostBucket(requestHost(headers));
  if (skipPing(headers)) return { host, visitor: "", month: "", now: at, skip: true };
  const store = await openStore();
  if (!store) return null;
  const day = chicagoDate(at);
  const month = day.slice(0, 7);
  const salt = await ensureSalt(store, month);
  const visitor = visitorHash(salt, clientIp(headers), header(headers, "user-agent"));
  return { host, visitor, month, now: at, skip: false };
}

async function recordPage(headers) {
  try {
    const attr = await attribute(headers, now());
    if (!attr || !attr.visitor) return null;
    return await record(attr, "pv", 1);
  } catch {
    return null;
  }
}

async function recordStart(attr) {
  try {
    if (!attr || !attr.visitor) return null;
    return await record(attr, "st", 1);
  } catch {
    return null;
  }
}

async function undoStart(job) {
  try {
    if (!job || !job.usageVisitor) return null;
    return await record(
      {
        host: job.usageHost || "other",
        visitor: job.usageVisitor,
        month: job.usageMonth,
        now: job.usageAt || job.createdAt || now(),
      },
      "st",
      -1
    );
  } catch {
    return null;
  }
}

async function recordFinish(job) {
  try {
    if (!job || !job.usageVisitor) return null;
    const state = job.state;
    const kind = state === "done" ? "dn" : state === "cancelled" ? "ca" : state === "error" || state === "failed" ? "er" : "";
    if (!kind) return null;
    return await record(
      {
        host: job.usageHost || "other",
        visitor: job.usageVisitor,
        month: job.usageMonth,
        now: job.usageAt || now(),
      },
      kind,
      1
    );
  } catch {
    return null;
  }
}

function sumKind(rec, kind, pred) {
  return sumMap(rec && rec[kind], pred);
}

function computeAgg(list, pred, approx) {
  const agg = emptyAgg(approx);
  for (const rec of list) {
    const pv = sumKind(rec, "pv", pred);
    const st = sumKind(rec, "st", pred);
    const dn = sumKind(rec, "dn", pred);
    const er = sumKind(rec, "er", pred);
    const ca = sumKind(rec, "ca", pred);
    if (pv || st) agg.uniqueUsers += 1;
    agg.pageviews += pv;
    agg.exportsStarted += st;
    agg.exportsDone += dn;
    agg.exportsError += er;
    agg.exportsCancelled += ca;
    if (st > 0) {
      agg.exportingUsers += 1;
      const k = String(st);
      agg.byCount[k] = (agg.byCount[k] | 0) + 1;
    }
  }
  return agg;
}

async function loadVisitors(store, month) {
  const out = { prod: [], dev: [], other: [] };
  if (!validMonth(month)) return out;
  for (const host of HOSTS) {
    let keys = [];
    try {
      keys = await listKeys(store, "vis/" + month + "/" + host + "/");
    } catch {
      keys = [];
    }
    for (const key of keys) {
      const rec = await store.get(key, { type: "json" }).catch(() => null);
      if (rec) out[host].push(rec);
    }
  }
  return out;
}

function monthDue(month, today) {
  if (!validMonth(month) || !validDate(today)) return false;
  const deleteOn = shiftDate(shiftMonth(month, 1) + "-01", 3);
  return today >= deleteOn;
}

async function reconcileMonth(store, month, today) {
  const visitors = await loadVisitors(store, month);
  const days = eachDayOfMonth(month);
  for (const day of days) {
    for (const host of HOSTS) {
      const exact = computeAgg(visitors[host], (d) => d === day, false);
      await store.setJSON(aggKey("day", day, host), exact);
    }
  }
  for (const host of HOSTS) {
    const exact = computeAgg(visitors[host], (d) => d.slice(0, 7) === month, false);
    await store.setJSON(aggKey("month", month, host), exact);
  }
  const seenWeeks = [];
  for (const day of days) {
    const week = isoWeekKey(day);
    if (seenWeeks[seenWeeks.length - 1] !== week) seenWeeks.push(week);
  }
  for (const week of seenWeeks) {
    const end = weekEnd(week);
    if (!end || end >= today) continue;
    const spans = weekSpansMonths(week);
    let byHost = visitors;
    if (spans) {
      const other = weekStart(week).slice(0, 7) === month ? weekEnd(week).slice(0, 7) : weekStart(week).slice(0, 7);
      const salt = await store.get("salt/" + other, { type: "json" }).catch(() => null);
      const visLeft = await listKeys(store, "vis/" + other + "/").catch(() => []);
      if (!salt && (!visLeft || !visLeft.length)) continue;
      const otherVis = await loadVisitors(store, other);
      byHost = { prod: [], dev: [], other: [] };
      for (const host of HOSTS) byHost[host] = visitors[host].concat(otherVis[host]);
    }
    for (const host of HOSTS) {
      const exact = computeAgg(byHost[host], (d) => isoWeekKey(d) === week, spans);
      exact.approx = spans;
      await store.setJSON(aggKey("week", week, host), exact);
    }
  }
}

async function deleteMonthRaw(store, month) {
  let keys = [];
  try {
    keys = await listKeys(store, "vis/" + month + "/");
  } catch {
    keys = [];
  }
  for (const key of keys) await store.delete(key).catch(() => {});
  await store.delete("salt/" + month).catch(() => {});
}

async function sweepMonths(store, today, force) {
  if (!force) {
    const t = Date.now();
    if (t - lastSweepAt < SWEEP_EVERY_MS) return 0;
    lastSweepAt = t;
  }
  if (!validDate(today)) return 0;
  const months = new Set();
  let saltKeys = [];
  let visKeys = [];
  try {
    saltKeys = await listKeys(store, "salt/");
    visKeys = await listKeys(store, "vis/");
  } catch {
    return 0;
  }
  for (const key of saltKeys) {
    const month = key.slice("salt/".length);
    if (validMonth(month)) months.add(month);
  }
  for (const key of visKeys) {
    const m = /^vis\/(\d{4}-\d{2})\//.exec(key);
    if (m) months.add(m[1]);
  }
  let done = 0;
  for (const month of months) {
    if (!monthDue(month, today)) continue;
    const marker = await store.get("final/" + month, { type: "json" }).catch(() => null);
    if (!marker) {
      await reconcileMonth(store, month, today);
      await store.setJSON("final/" + month, { at: today });
    }
    await deleteMonthRaw(store, month);
    done += 1;
  }
  return done;
}

async function finalizeDue(today) {
  const store = await openStore();
  if (!store) return 0;
  return sweepMonths(store, today, true);
}

function eachDay(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    if (out.length > DAY_LIMIT) break;
    cur = shiftDate(cur, 1);
  }
  return out;
}

function eachWeek(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    if (out.length > WEEK_LIMIT) break;
    cur = isoWeekKey(shiftDate(weekStart(cur), 7));
  }
  return out;
}

function eachMonth(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    if (out.length > MONTH_LIMIT) break;
    cur = shiftMonth(cur, 1);
  }
  return out;
}

function defaultRange(period, today) {
  if (period === "week") {
    const end = isoWeekKey(today);
    const start = isoWeekKey(shiftDate(weekStart(end), -7 * 11));
    return { from: start, to: end };
  }
  if (period === "month") {
    const end = today.slice(0, 7);
    return { from: shiftMonth(end, -11), to: end };
  }
  return { from: shiftDate(today, -29), to: today };
}

function coerceKey(period, value) {
  const s = String(value || "").trim();
  if (period === "day") return validDate(s) ? s : "";
  if (period === "month") {
    if (validMonth(s)) return s;
    if (validDate(s)) return s.slice(0, 7);
    return "";
  }
  if (validWeek(s)) return s;
  if (validDate(s)) return isoWeekKey(s);
  return "";
}

function parseRange(period, query, nowMs) {
  if (period !== "day" && period !== "week" && period !== "month") return null;
  const q = query || {};
  const today = chicagoDate(nowMs == null ? now() : nowMs);
  const date = String(q.date || "").trim();
  const fromRaw = String(q.from || "").trim();
  const toRaw = String(q.to || "").trim();
  let from = "";
  let to = "";
  if (date) {
    from = coerceKey(period, date);
    to = from;
    if (!from) return null;
  } else if (fromRaw || toRaw) {
    if (!fromRaw || !toRaw) return null;
    from = coerceKey(period, fromRaw);
    to = coerceKey(period, toRaw);
    if (!from || !to || from > to) return null;
  } else {
    const range = defaultRange(period, today);
    from = range.from;
    to = range.to;
  }
  const keys = period === "week" ? eachWeek(from, to) : period === "month" ? eachMonth(from, to) : eachDay(from, to);
  const limit = period === "week" ? WEEK_LIMIT : period === "month" ? MONTH_LIMIT : DAY_LIMIT;
  if (!keys.length || keys.length > limit || keys[0] !== from || keys[keys.length - 1] !== to) return null;
  return { from, to };
}

async function readPeriods(period, from, to) {
  const store = await openStore();
  const today = chicagoDate(now());
  if (store) await sweepMonths(store, today, false).catch(() => {});
  const keys = period === "week" ? eachWeek(from, to) : period === "month" ? eachMonth(from, to) : eachDay(from, to);
  const periods = [];
  for (const key of keys) {
    const approx = period === "week" && weekSpansMonths(key);
    const hosts = {};
    const raw = {};
    for (const host of HOSTS) {
      let row = null;
      if (store) row = await store.get(aggKey(period, key, host), { type: "json" }).catch(() => null);
      raw[host] = copyAgg(row, approx);
      if (approx) raw[host].approx = true;
      hosts[host] = present(raw[host]);
    }
    const bounds = periodBounds(period, key);
    const merged = mergeAggs(HOSTS.map((host) => raw[host]));
    if (approx) merged.approx = true;
    periods.push({
      period,
      key,
      start: bounds.start,
      end: bounds.end,
      approx: !!merged.approx,
      hosts,
      totals: present(merged),
    });
  }
  return periods;
}

module.exports = {
  STORE_NAME,
  TZ,
  HOSTS,
  HISTOGRAM_KEYS,
  DAY_LIMIT,
  WEEK_LIMIT,
  MONTH_LIMIT,
  setStoreForTests,
  setNowForTests,
  resetSweepForTests,
  now,
  header,
  requestHost,
  clientIp,
  hostBucket,
  isBot,
  skipPing,
  chicagoDate,
  validDate,
  validMonth,
  validWeek,
  shiftDate,
  shiftMonth,
  isoWeekKey,
  weekStart,
  weekEnd,
  weekSpansMonths,
  monthDue,
  visitorHash,
  accessMode,
  readAllowed,
  attribute,
  recordPage,
  recordStart,
  undoStart,
  recordFinish,
  finalizeDue,
  parseRange,
  readPeriods,
  present,
};
