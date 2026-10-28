"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fb = require("../netlify/lib/feedback");
const handlerMod = require("../netlify/functions/feedback");
const client = require("../public/feedback.js");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(40, 2)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const jpegUrl = "data:image/jpeg;base64," + JPEG.toString("base64");

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k, o) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      if (o && o.type === "json") return JSON.parse(v);
      if (o && o.type === "arrayBuffer") return Uint8Array.from(v).buffer;
      return v;
    },
    async set(k, v) {
      m.set(k, Buffer.from(v));
    },
    async setJSON(k, v) {
      m.set(k, JSON.stringify(v));
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

function fakeGh(opts) {
  const o = opts || {};
  const calls = { issues: [], files: [] };
  let n = 100;
  return {
    calls,
    async createIssue(issue, where) {
      if (o.fail) {
        const e = new Error("GitHub answered 401");
        e.githubStatus = 401;
        throw e;
      }
      calls.issues.push({ issue, repo: where.repo, token: where.token });
      n += 1;
      return { number: n, url: "https://github.com/" + where.repo + "/issues/" + n };
    },
    async putPrivateFile(p, buf, where) {
      calls.files.push({ p, size: buf.length, repo: where.repo });
      return "https://github.com/" + where.repo + "/blob/main/" + p + "?raw=true";
    },
  };
}

const ENV = {
  GITHUB_FEEDBACK_PRIVATE_TOKEN: "priv-token-x",
  FEEDBACK_PRIVATE_REPO: "jolla/OpenClutter-feedback",
};

function post(body, extra) {
  const e = extra || {};
  return {
    httpMethod: "POST",
    headers: Object.assign(
      {
        origin: "https://dev.openclutter.com",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        "x-nf-client-connection-ip": "203.0.113.9",
      },
      e.headers || {}
    ),
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function setup(env, ghOpts) {
  const gh = fakeGh(ghOpts);
  const rateStore = memStore();
  handlerMod.setForTests({ env, gh, rateStore, now: Date.parse("2026-10-28T19:00:00Z") });
  return { gh, rateStore };
}

const base = { type: "bug", message: "Trees float above the hill\nmore detail", version: "1.2.50", elapsedMs: 9000 };

test("feedback: config never exposes the token or the private repo", () => {
  const page = fb.pageConfig(fb.readConfig(ENV));
  assert.equal(page.configured, true);
  const s = JSON.stringify(page);
  assert.ok(!s.includes("token") && !s.includes("OpenClutter-feedback"));
  assert.equal(fb.pageConfig(fb.readConfig({})).configured, false);
  assert.equal(fb.readConfig({ FEEDBACK_PRIVATE_REPO: "jolla/OpenClutter-feedback" }), null);
  assert.equal(fb.readConfig({ GITHUB_FEEDBACK_PRIVATE_TOKEN: "x" }), null);
  assert.equal(fb.readConfig({ FEEDBACK_PRIVATE_REPO: "bad repo", GITHUB_FEEDBACK_PRIVATE_TOKEN: "x" }), null);
  assert.equal(fb.readConfig({ GITHUB_FEEDBACK_TOKEN: "x" }), null, "no public token path");
});

test("feedback: origin allow list and host kind", () => {
  assert.ok(fb.allowedOrigin("https://openclutter.com"));
  assert.ok(fb.allowedOrigin("https://dev.openclutter.com"));
  assert.ok(fb.allowedOrigin("https://deploy-preview-12--openclutter.netlify.app"));
  assert.ok(!fb.allowedOrigin("https://evil.example"));
  assert.ok(!fb.allowedOrigin("http://openclutter.com"));
  assert.ok(!fb.allowedOrigin("https://openclutter.com.evil.example"));
  assert.equal(fb.hostKind("https://openclutter.com"), "prod");
  assert.equal(fb.hostKind("https://dev.openclutter.com"), "dev");
});

test("feedback: title defuses mentions and cross references", () => {
  const t = fb.titleFrom("bug", "@octocat look at other/repo#12 and #5 please");
  assert.ok(t.startsWith("[Bug] "));
  assert.ok(!/@[A-Za-z]/.test(t));
  assert.ok(!/repo#\d/.test(t));
  assert.ok(!/(^|\s)#\d/.test(t));
  const long = fb.titleFrom("suggestion", "x".repeat(300));
  assert.ok(long.length <= 80 + "[Suggestion] ".length);
});

test("feedback: message goes in a fence it cannot break out of", () => {
  const evil = "hi\n````\n@everyone ![x](https://evil/x.png) <img src=x>\n";
  const f = fb.fence(evil);
  const opener = f.split("\n")[0].replace("text", "");
  assert.ok(opener.length >= 5);
  assert.ok(f.endsWith("\n" + opener));
});

test("feedback: parseReport limits and spam traps", () => {
  assert.equal(fb.parseReport(Object.assign({}, base, { website: "http://spam" })).spam, true);
  assert.equal(fb.parseReport(Object.assign({}, base, { elapsedMs: 300 })).spam, true);
  assert.throws(() => fb.parseReport(Object.assign({}, base, { message: "   " })), /a little more/);
  assert.throws(() => fb.parseReport(Object.assign({}, base, { message: "y".repeat(4001) })), /under 4000/);
  assert.throws(
    () => fb.parseReport(Object.assign({}, base, { message: "a https://a.b b https://c.d http://e.f www.g.h" })),
    /at most 3 links/
  );
  assert.throws(() => fb.parseReport(Object.assign({}, base, { email: "not an email" })), /email/);
  assert.throws(() => fb.parseReport(Object.assign({}, base, { images: [jpegUrl, jpegUrl, jpegUrl, jpegUrl] })), /at most 3/);
  const png = "data:image/jpeg;base64," + PNG.toString("base64");
  assert.throws(() => fb.parseReport(Object.assign({}, base, { images: [png] })), /not a JPEG or WebP/);
  const big = "data:image/jpeg;base64," + Buffer.concat([JPEG, Buffer.alloc(fb.IMAGE_MAX_BYTES)]).toString("base64");
  assert.throws(() => fb.parseReport(Object.assign({}, base, { images: [big] })), /too large/);
  const r = fb.parseReport(Object.assign({}, base, { type: "nope", images: [jpegUrl, "data:image/webp;base64," + WEBP.toString("base64")] }));
  assert.equal(r.type, "other");
  assert.deepEqual(r.images.map((i) => i.type), ["image/jpeg", "image/webp"]);
  assert.equal(r.public, undefined);
});

test("feedback: bounds are checked and rounded", () => {
  assert.deepEqual(fb.cleanBounds({ west: -97.123456789, south: 30.1, east: -97.1, north: 30.2 }), {
    west: -97.12346,
    south: 30.1,
    east: -97.1,
    north: 30.2,
  });
  assert.equal(fb.cleanBounds({ west: 0, south: 5, east: 1, north: 4 }), null);
  assert.equal(fb.cleanBounds({ west: "0", south: 1, east: 1, north: 2 }), null);
  assert.equal(fb.browserSummary("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15"), "Safari 17 on macOS");
});

test("feedback: GET reports config without secrets", async () => {
  setup(ENV);
  const r = await handlerMod.handler({ httpMethod: "GET", headers: { origin: "https://openclutter.com" } });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes("token-x"));
  assert.equal(JSON.parse(r.body).configured, true);
});

test("feedback: not configured answers 503 not_configured", async () => {
  setup({});
  const r = await handlerMod.handler(post(base));
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.parse(r.body).code, "not_configured");
});

test("feedback: wrong origin and oversize bodies are refused", async () => {
  setup(ENV);
  assert.equal((await handlerMod.handler(post(base, { headers: { origin: "https://evil.example" } }))).statusCode, 403);
  const huge = JSON.stringify(Object.assign({}, base, { pad: "x".repeat(fb.BODY_MAX_BYTES) }));
  assert.equal((await handlerMod.handler(post(huge))).statusCode, 413);
  assert.equal((await handlerMod.handler(post("{nope"))).statusCode, 400);
});

test("feedback: private issue with private screenshots, Reply to, context", async () => {
  const { gh } = setup(ENV);
  const body = Object.assign({}, base, {
    type: "suggestion",
    email: "me@example.org",
    images: [jpegUrl],
    public: true,
    context: { bounds: { west: -97.2, south: 30.1, east: -97.1, north: 30.2 }, viewport: { w: 1280, h: 800 } },
  });
  const r = await handlerMod.handler(post(body));
  assert.equal(r.statusCode, 200, r.body);
  const out = JSON.parse(r.body);
  assert.equal(out.url, undefined, "a private issue link is not handed back");
  assert.equal(gh.calls.issues.length, 1);
  assert.equal(gh.calls.issues[0].repo, "jolla/OpenClutter-feedback");
  assert.equal(gh.calls.issues[0].token, "priv-token-x");
  assert.equal(gh.calls.files.length, 1);
  assert.match(gh.calls.files[0].p, /^screenshots\/2026-10\/[0-9a-f]{32}\.jpg$/);
  const issue = gh.calls.issues[0].issue;
  assert.match(issue.body, /\*\*Reply to:\*\* `me@example\.org`/);
  assert.ok(!issue.title.includes("me@example.org"));
  assert.ok(issue.body.includes("?raw=true"));
  assert.match(issue.body, /Draw bounds:\*\* W -97\.2/);
  assert.match(issue.body, /Chrome 130 on Windows, window 1280 x 800/);
  assert.match(issue.body, /v1\.2\.50 \(dev\)/);
  assert.match(issue.body, /Sent privately/);
  assert.deepEqual(issue.labels, ["enhancement", "user-feedback"]);
});

test("feedback: honeypot answers ok without an issue", async () => {
  const { gh } = setup(ENV);
  const r = await handlerMod.handler(post(Object.assign({}, base, { website: "x" })));
  assert.equal(r.statusCode, 200);
  assert.equal(gh.calls.issues.length, 0);
});

test("feedback: per-IP rate limit", async () => {
  const { gh } = setup(ENV);
  for (let i = 0; i < fb.RATE.shortMax; i++) assert.equal((await handlerMod.handler(post(base))).statusCode, 200);
  const r = await handlerMod.handler(post(base));
  assert.equal(r.statusCode, 429);
  assert.equal(gh.calls.issues.length, fb.RATE.shortMax);
  const other = await handlerMod.handler(post(base, { headers: { "x-nf-client-connection-ip": "198.51.100.1" } }));
  assert.equal(other.statusCode, 200);
});

test("feedback: GitHub failure is a friendly 502", async () => {
  setup(ENV, { fail: true });
  const r = await handlerMod.handler(post(Object.assign({}, base, { images: [jpegUrl] })));
  assert.equal(r.statusCode, 502);
  assert.ok(!r.body.includes("token"));
});

test("feedback client: payload and helpers", () => {
  assert.deepEqual(client.fitSize(3200, 1600, 1600), { w: 1600, h: 800 });
  assert.deepEqual(client.fitSize(800, 600, 1600), { w: 800, h: 600 });
  assert.equal(client.dataUrlBytes("data:image/jpeg;base64," + JPEG.toString("base64")), JPEG.length);
  const p = client.buildPayload({ message: "m", email: " a@b.co ", includeContext: false });
  assert.equal(p.email, "a@b.co");
  assert.equal(p.context, undefined);
  assert.equal("public" in p, false);
  const q = client.buildPayload({ message: "m", includeContext: true, bounds: { west: 1 }, viewport: { w: 1, h: 2 } });
  assert.deepEqual(q.context.bounds, { west: 1 });
});

test("feedback page: visible Feedback pill, private dialog, no public option, no em dashes", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // 1.2.52: its own pill in the bottom-right corner (a tester called the footer link very subtle).
  assert.match(html, /<button type="button" id="feedback-link" class="feedback-pill"[^>]*>[\s\S]*?Feedback<\/button>/);
  assert.match(html, /\.feedback-pill:focus-visible \{ outline:/);
  const credit = html.slice(html.indexOf('<p class="map-credit"'), html.indexOf("</p>", html.indexOf('<p class="map-credit"')));
  assert.ok(!credit.includes("feedback-link"), "not faint footer text");
  assert.match(html, /#fb-send:disabled \{ background: #30363d;/);
  assert.match(html, /<dialog id="feedback"/);
  assert.ok(!/fb-public|Post publicly|fb-mail/.test(html));
  assert.match(html, /go privately to the OpenClutter team/);
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "netlify", "functions", "feedback-image.js")));
  assert.match(html, /<script src="\/feedback.js"><\/script>/);
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "feedback.js"), "utf8");
  const dlg = html.slice(html.indexOf('<dialog id="feedback"'), html.indexOf("</dialog>"));
  for (const text of [dlg, js, fs.readFileSync(path.join(__dirname, "..", "netlify", "lib", "feedback.js"), "utf8")]) {
    assert.ok(!text.includes("\u2014"), "no em dashes");
  }
  assert.ok(!/@[a-z0-9.-]+\.(com|org|net)/i.test(js), "no address in the page bundle");
});
