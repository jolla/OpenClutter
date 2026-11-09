"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const usage = require("../netlify/lib/usage");
const jobs = require("../netlify/lib/export-jobs");
const { handler } = require("../netlify/functions/usage");
const { handler: statusHandler } = require("../netlify/functions/export-status");

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IP = "203.0.113.9";
const DAY = "2026-11-09";
const NOON = Date.parse("2026-11-09T18:00:00Z");
const NEXT = Date.parse("2026-11-10T18:00:00Z");
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function memoryStore() {
  const map = new Map();
  let seq = 0;
  return {
    map,
    async setJSON(key, value, opts) {
      if (opts && opts.onlyIfNew && map.has(key)) return { modified: false };
      if (opts && opts.onlyIfMatch) {
        const cur = map.get(key);
        if (!cur || cur.etag !== opts.onlyIfMatch) return { modified: false };
      }
      const etag = String(++seq);
      map.set(key, { etag, value: JSON.parse(JSON.stringify(value)) });
      return { modified: true, etag };
    },
    async set(key, value) {
      map.set(key, { etag: String(++seq), value });
    },
    async get(key) {
      const row = map.get(key);
      return row ? row.value : null;
    },
    async getWithMetadata(key) {
      const row = map.get(key);
      if (!row) return null;
      return { data: row.value, etag: row.etag, metadata: {} };
    },
    async delete(key) {
      map.delete(key);
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

function jobStore() {
  const map = new Map();
  return {
    map,
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async set(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

function req(method, headers, query) {
  return { httpMethod: method, headers: headers || {}, queryStringParameters: query || {}, body: "" };
}

function browser(extra) {
  return Object.assign(
    { host: "openclutter.com", "user-agent": CHROME, "x-nf-client-connection-ip": IP },
    extra || {}
  );
}

function hostOf(body, host) {
  return body.periods[0].hosts[host || "prod"];
}

afterEach(() => {
  usage.setStoreForTests(undefined);
  usage.setNowForTests(null);
  usage.resetSweepForTests();
  jobs.setExportStoreForTests(null);
  delete process.env.OPENCLUTTER_API_KEY_HASHES;
});

describe("usage periods", () => {
  it("buckets hosts, Chicago days, and ISO weeks", () => {
    assert.equal(usage.hostBucket("www.openclutter.com"), "prod");
    assert.equal(usage.hostBucket("dev.openclutter.com"), "dev");
    assert.equal(usage.hostBucket("dev--openclutter.netlify.app"), "other");
    assert.equal(usage.chicagoDate(Date.parse("2026-11-09T05:30:00Z")), "2026-11-08");
    assert.equal(usage.chicagoDate(NOON), DAY);
    assert.equal(usage.weekStart(usage.isoWeekKey(DAY)), DAY);
    assert.equal(usage.weekEnd(usage.isoWeekKey(DAY)), "2026-11-15");
    assert.equal(usage.isoWeekKey("2026-11-15"), usage.isoWeekKey(DAY));
    assert.notEqual(usage.isoWeekKey("2026-11-16"), usage.isoWeekKey(DAY));
    assert.equal(usage.weekSpansMonths(usage.isoWeekKey(DAY)), false);
    assert.equal(usage.weekSpansMonths(usage.isoWeekKey("2026-11-30")), true);
    assert.equal(usage.weekStart(usage.isoWeekKey("2026-11-30")), "2026-11-30");
    assert.equal(usage.weekEnd(usage.isoWeekKey("2026-11-30")), "2026-12-06");
    assert.equal(usage.monthDue("2026-11", "2026-12-03"), false);
    assert.equal(usage.monthDue("2026-11", "2026-12-04"), true);
  });

  it("skips bots, health checks, prefetch, and privacy signals", () => {
    assert.equal(usage.isBot(CHROME), false);
    assert.equal(usage.isBot(""), true);
    assert.equal(usage.isBot("curl/8.4.0"), true);
    assert.equal(usage.isBot("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
    assert.equal(usage.isBot("UptimeRobot/2.0"), true);
    assert.equal(usage.isBot("ELB-HealthChecker/2.0"), true);
    assert.equal(usage.isBot("Mozilla/5.0 HeadlessChrome/120.0.0.0"), true);
    assert.equal(usage.skipPing({ dnt: "1", "user-agent": CHROME }), true);
    assert.equal(usage.skipPing({ "sec-gpc": "1", "user-agent": CHROME }), true);
    assert.equal(usage.skipPing({ purpose: "prefetch", "user-agent": CHROME }), true);
    assert.equal(usage.skipPing({ "user-agent": CHROME }), false);
  });

  it("counts one person across days in the same month", async () => {
    const store = memoryStore();
    usage.setStoreForTests(store);
    usage.setNowForTests(() => NOON);
    const headers = browser();
    assert.equal((await handler(req("POST", headers))).statusCode, 204);
    usage.setNowForTests(() => NEXT);
    assert.equal((await handler(req("POST", headers))).statusCode, 204);
    assert.equal((await handler(req("POST", browser({ "user-agent": CHROME + " Edg/120.0" })))).statusCode, 204);
    usage.setNowForTests(() => NOON);
    const one = JSON.parse((await handler(req("GET", {}, { period: "day", date: DAY }))).body);
    assert.equal(one.periods.length, 1);
    assert.equal(hostOf(one).pageviews, 1);
    assert.equal(hostOf(one).uniqueUsers, 1);
    const month = JSON.parse((await handler(req("GET", {}, { period: "month", date: DAY }))).body);
    assert.equal(month.periods[0].key, "2026-11");
    assert.equal(hostOf(month).pageviews, 3);
    assert.equal(hostOf(month).uniqueUsers, 2);
    const week = JSON.parse((await handler(req("GET", {}, { period: "week", date: DAY }))).body);
    assert.equal(week.periods[0].start, DAY);
    assert.equal(week.periods[0].end, "2026-11-15");
    assert.equal(week.periods[0].approx, false);
    assert.equal(hostOf(week).uniqueUsers, 2);
    assert.equal(hostOf(week).pageviews, 3);
    const span = JSON.parse((await handler(req("GET", {}, { period: "week", date: "2026-11-30" }))).body);
    assert.equal(span.periods[0].approx, true);
    assert.equal(span.periods[0].end, "2026-12-06");
    const saltKeys = [...store.map.keys()].filter((k) => k.startsWith("salt/"));
    assert.deepEqual(saltKeys, ["salt/2026-11"]);
    const dumped = JSON.stringify([...store.map.entries()]);
    assert.equal(dumped.includes(IP), false);
    assert.equal(dumped.includes("Macintosh"), false);
    const salt = await store.get("salt/2026-11");
    const hash = usage.visitorHash(salt.salt, IP, CHROME);
    assert.equal(await store.get("vis/2026-11/prod/" + hash) != null, true);
    assert.equal([...store.map.keys()].some((k) => k.indexOf(hash) !== -1 && k.indexOf("2026-12") !== -1), false);
  });

  it("attributes exports to that visitor and summarizes them", async () => {
    const store = memoryStore();
    const exportsStore = jobStore();
    usage.setStoreForTests(store);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(exportsStore);
    const headers = browser();
    await handler(req("POST", headers));
    await handler(req("POST", headers));

    await jobs.createJob(JOB, { headers });
    let body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    let row = hostOf(body);
    assert.equal(row.pageviews, 2);
    assert.equal(row.uniqueUsers, 1);
    assert.equal(row.exportingUsers, 1);
    assert.equal(row.exportsStarted, 1);
    assert.equal(row.exportsPerUser.mean, 1);
    assert.equal(row.exportsPerUser.median, 1);
    assert.equal(row.exportsPerUser.histogram["1"], 1);
    assert.equal(row.conversion.exportsPerPageview, 0.5);
    assert.equal(row.conversion.exportingUsersPerUnique, 1);

    const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await jobs.createJob(second, { headers });
    await jobs.updateJob(second, { state: "running" });
    await jobs.updateJob(second, { state: "error", stage: "Export failed", error: "nope" });
    await jobs.updateJob(second, { state: "done", stage: "Zip ready" });
    const third = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await jobs.createJob(third, { headers });
    await jobs.updateJob(third, { state: "running" });
    await jobs.cancelJob(third);
    await jobs.readJob(third);

    body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    row = hostOf(body);
    assert.equal(row.exportsStarted, 3);
    assert.equal(row.exportsDone, 0);
    assert.equal(row.exportsError, 1);
    assert.equal(row.exportsCancelled, 1);
    assert.equal(row.exportingUsers, 1);
    assert.equal(row.exportsPerUser.histogram["2-3"], 1);
    assert.equal(row.exportsPerUser.histogram["1"], 0);
    assert.equal(row.exportsPerUser.mean, 3);
    assert.equal(row.exportsPerUser.median, 3);
    assert.equal(row.uniqueUsers, 1);

    await jobs.updateJob(JOB, { state: "running" });
    await jobs.updateJob(JOB, { state: "done", stage: "Zip ready" });
    await jobs.readJob(JOB);
    body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    assert.equal(hostOf(body).exportsDone, 1);

    const status = await statusHandler({ httpMethod: "GET", queryStringParameters: { job: JOB } });
    const job = exportsStore.map.get("job/" + JOB);
    assert.equal(status.body.includes(job.usageVisitor), false);
    assert.equal(status.body.includes(IP), false);

    const otherUa = browser({ "user-agent": CHROME + " Extra", "x-nf-client-connection-ip": "203.0.113.10" });
    const dropped = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await jobs.createJob(dropped, { headers: otherUa });
    body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    assert.equal(hostOf(body).uniqueUsers, 2);
    assert.equal(hostOf(body).exportingUsers, 2);
    assert.equal(hostOf(body).exportsStarted, 4);
    await jobs.deleteJob(dropped);
    body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    row = hostOf(body);
    assert.equal(row.uniqueUsers, 1);
    assert.equal(row.exportingUsers, 1);
    assert.equal(row.exportsStarted, 3);
    assert.equal(row.exportsPerUser.median, 3);

    await jobs.createJob("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { headers: browser({ "user-agent": "curl/8.4.0" }) });
    await jobs.createJob("ffffffff-ffff-4fff-8fff-ffffffffffff", { headers: browser({ dnt: "1" }) });
    body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    assert.equal(hostOf(body).exportsStarted, 3);

    const dev = JSON.parse(
      (await handler(req("GET", {}, { date: DAY }))).body
    );
    assert.equal(dev.periods[0].hosts.dev.pageviews, 0);
    await handler(req("POST", browser({ host: "dev.openclutter.com", "x-nf-client-connection-ip": "203.0.113.40" })));
    const split = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    assert.equal(split.periods[0].hosts.dev.pageviews, 1);
    assert.equal(split.periods[0].hosts.dev.uniqueUsers, 1);
    assert.equal(split.periods[0].totals.pageviews, hostOf(split).pageviews + 1);
  });

  it("claims a Fly finish that was stored without a usage stamp", async () => {
    const store = memoryStore();
    const exportsStore = jobStore();
    usage.setStoreForTests(store);
    usage.setNowForTests(() => NOON);
    jobs.setExportStoreForTests(exportsStore);
    const fly = "99999999-9999-4999-8999-999999999999";
    await jobs.createJob(fly, { headers: browser() });
    const raw = exportsStore.map.get("job/" + fly);
    raw.state = "done";
    raw.stage = "Zip ready";
    delete raw.usageCounted;
    await jobs.readJob(fly);
    await jobs.readJob(fly);
    const body = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    assert.equal(hostOf(body).exportsStarted, 1);
    assert.equal(hostOf(body).exportsDone, 1);
  });

  it("keeps reconciled aggregates and drops the salt and visitor hashes", async () => {
    const store = memoryStore();
    usage.setStoreForTests(store);
    const hash = "a".repeat(64);
    await store.setJSON("salt/2026-11", { salt: "abcabcabcabcabcabcabcabcabcabcab" });
    await store.setJSON("vis/2026-11/prod/" + hash, {
      pv: { "2026-11-09": 4 },
      st: { "2026-11-09": 2 },
      dn: { "2026-11-09": 1 },
      er: {},
      ca: {},
    });
    await store.setJSON("agg/day/2026-11-09/prod", {
      pageviews: 99,
      uniqueUsers: 9,
      exportingUsers: 9,
      exportsStarted: 9,
      exportsDone: 9,
      exportsError: 0,
      exportsCancelled: 0,
      byCount: { "9": 9 },
    });
    await usage.finalizeDue("2026-12-04");
    assert.equal(await store.get("salt/2026-11"), null);
    assert.equal(await store.get("vis/2026-11/prod/" + hash), null);
    assert.equal((await store.get("final/2026-11")).at, "2026-12-04");
    usage.setNowForTests(() => Date.parse("2026-12-04T18:00:00Z"));
    const body = JSON.parse((await handler(req("GET", {}, { period: "day", date: DAY }))).body);
    const row = hostOf(body);
    assert.equal(row.pageviews, 4);
    assert.equal(row.uniqueUsers, 1);
    assert.equal(row.exportingUsers, 1);
    assert.equal(row.exportsStarted, 2);
    assert.equal(row.exportsDone, 1);
    assert.equal(row.exportsPerUser.mean, 2);
    assert.equal(row.exportsPerUser.histogram["2-3"], 1);
    await usage.finalizeDue("2026-12-05");
    const again = JSON.parse((await handler(req("GET", {}, { period: "day", date: DAY }))).body);
    assert.equal(hostOf(again).pageviews, 4);
    assert.equal(hostOf(again).uniqueUsers, 1);
  });

  it("serves trend windows and the existing API key", async () => {
    usage.setStoreForTests(memoryStore());
    usage.setNowForTests(() => NOON);
    const days = JSON.parse((await handler(req("GET"))).body);
    assert.equal(days.period, "day");
    assert.equal(days.from, "2026-10-11");
    assert.equal(days.to, DAY);
    assert.equal(days.periods.length, 30);
    assert.equal(days.auth, "public");
    const weeks = JSON.parse((await handler(req("GET", {}, { period: "week" }))).body);
    assert.equal(weeks.periods.length, 12);
    assert.equal(weeks.to, usage.isoWeekKey(DAY));
    const months = JSON.parse((await handler(req("GET", {}, { period: "month" }))).body);
    assert.equal(months.periods.length, 12);
    assert.equal(months.from, "2025-12");
    assert.equal(months.to, "2026-11");
    const quarter = JSON.parse((await handler(req("GET", {}, { period: "month", from: "2026-01", to: "2026-03" }))).body);
    assert.deepEqual(quarter.periods.map((p) => p.key), ["2026-01", "2026-02", "2026-03"]);

    const key = "oc_test_unit_key_0123456789";
    process.env.OPENCLUTTER_API_KEY_HASHES = crypto.createHash("sha256").update(key).digest("hex");
    assert.equal((await handler(req("GET", {}, { date: DAY }))).statusCode, 401);
    assert.equal((await handler(req("POST", browser()))).statusCode, 204);
    const authed = await handler(req("GET", { authorization: "Bearer " + key }, { date: DAY }));
    assert.equal(authed.statusCode, 200);
    assert.equal(JSON.parse(authed.body).auth, "api-key");
    assert.equal((await handler(req("GET", { "x-openclutter-key": key }, { period: "week", date: DAY }))).statusCode, 200);
    delete process.env.OPENCLUTTER_API_KEY_HASHES;

    assert.equal((await handler(req("GET", {}, { date: "2026-02-31" }))).statusCode, 400);
    assert.equal((await handler(req("GET", {}, { from: DAY, to: "2026-11-01" }))).statusCode, 400);
    assert.equal((await handler(req("GET", {}, { from: "2024-01-01", to: DAY }))).statusCode, 400);
    assert.equal((await handler(req("GET", {}, { period: "year" }))).statusCode, 400);
    assert.equal((await handler(req("PUT"))).statusCode, 405);
    await handler(req("POST", browser({ "user-agent": "curl/8.4.0" })));
    const quiet = JSON.parse((await handler(req("GET", {}, { date: DAY }))).body);
    assert.equal(hostOf(quiet).pageviews, 1);
  });
});

describe("usage page copy", () => {
  it("pings without cookies or stored ids, and says so on the page and in the README", () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
    const start = app.indexOf("function sendUsagePing()");
    const fn = app.slice(start, app.indexOf("sendUsagePing();", start));
    assert.ok(start > 0);
    assert.match(fn, /keepalive:\s*true/);
    assert.match(fn, /credentials:\s*"omit"/);
    assert.match(fn, /sendBeacon/);
    assert.match(fn, /doNotTrack/);
    assert.match(fn, /globalPrivacyControl/);
    assert.equal(fn.includes("localStorage"), false);
    assert.equal(fn.includes("sessionStorage"), false);
    assert.equal(fn.includes("document.cookie"), false);
    assert.match(html, /anonymous totals of page views and exports by day, week, and month/);
    assert.match(html, /No cookies, and no raw IP addresses\./);
    assert.match(readme, /GET \/api\/usage/);
    assert.match(readme, /OPENCLUTTER_API_KEY_HASHES/);
    assert.match(readme, /period=week/);
    const section = readme.slice(readme.indexOf("## Usage counts"), readme.indexOf("## Data credits"));
    assert.equal(section.includes("\u2014"), false);
    assert.equal(fn.includes("\u2014"), false);
    assert.equal(fs.readFileSync(path.join(__dirname, "../netlify/lib/usage.js"), "utf8").includes("\u2014"), false);
    assert.equal(fs.readFileSync(path.join(__dirname, "../netlify/functions/usage.js"), "utf8").includes("\u2014"), false);
  });
});
