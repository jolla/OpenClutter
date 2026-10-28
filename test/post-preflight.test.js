"use strict";

// Feedback and export POST preflight: some proxies (Zscaler for one tester)
// pass GETs and swap every POST for an HTML block page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fb = require("../netlify/lib/feedback");
const feedbackFn = require("../netlify/functions/feedback");
const clutter = require("../netlify/functions/clutter");
const N = require("../public/net-errors");

const ENV = { GITHUB_FEEDBACK_PRIVATE_TOKEN: "priv-token-x", FEEDBACK_PRIVATE_REPO: "jolla/OpenClutter-feedback" };

function trapStore() {
  const touch = () => {
    throw new Error("rate store touched by a ping");
  };
  return { get: touch, set: touch, setJSON: touch, delete: touch };
}

function trapGh() {
  return {
    async createIssue() {
      throw new Error("issue created by a ping");
    },
    async putPrivateFile() {
      throw new Error("file stored by a ping");
    },
  };
}

function post(body, origin) {
  return {
    httpMethod: "POST",
    headers: { origin: origin || "https://dev.openclutter.com", "x-nf-client-connection-ip": "203.0.113.9" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

test("feedback ping: answers ok without an issue, a rate count or the spam checks", async () => {
  feedbackFn.setForTests({ env: ENV, gh: trapGh(), rateStore: trapStore(), now: 0 });
  for (let i = 0; i < 50; i++) {
    const r = await feedbackFn.handler(post({ ping: true }));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { ok: true, ping: true, configured: true });
    assert.equal(r.headers["content-type"], "application/json");
  }
});

test("feedback ping: says configured false when the form is not set up", async () => {
  feedbackFn.setForTests({ env: {}, gh: trapGh(), rateStore: trapStore() });
  const r = await feedbackFn.handler(post({ ping: true }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).configured, false);
});

test("feedback ping: only the exact ping skips the report path", async () => {
  feedbackFn.setForTests({ env: ENV, gh: trapGh(), rateStore: trapStore() });
  assert.equal(fb.isPing({ ping: true }), true);
  assert.equal(fb.isPing({ ping: true, message: "hello there" }), false);
  assert.equal(fb.isPing({ ping: "true" }), false);
  assert.equal(fb.isPing([true]), false);
  // A ping with a report attached is a report: it fails the honeypot-free checks normally.
  const r = await feedbackFn.handler(post({ ping: true, message: "x" }));
  assert.equal(r.statusCode, 400);
  // Wrong origin is still refused, ping or not.
  assert.equal((await feedbackFn.handler(post({ ping: true }, "https://evil.example"))).statusCode, 403);
});

test("export ping: the clutter function answers {ok, ping} with no export work", async () => {
  const r = await clutter.handler({ httpMethod: "POST", headers: {}, body: '{"ping":true}' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, ping: true });
  assert.equal(clutter.isPingRequest({ httpMethod: "POST", body: '{"ping":true,"west":1}' }), false);
  assert.equal(clutter.isPingRequest({ httpMethod: "GET", body: '{"ping":true}' }), false);
  assert.equal(clutter.isPingRequest({ httpMethod: "POST", body: Buffer.from('{"ping":true}').toString("base64"), isBase64Encoded: true }), true);
});

function res(status, type, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: "",
    redirected: false,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? type : null) },
    json: async () => JSON.parse(body),
  };
}

const PAGE = "https://dev.openclutter.com/";

test("pingPost: ok on a JSON answer, even a JSON error from an old server", async () => {
  const sent = [];
  const ok = await N.pingPost("/api/feedback", "Feedback", {
    base: PAGE,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return res(200, "application/json", '{"ok":true,"ping":true,"configured":true}');
    },
  });
  assert.deepEqual(ok, { ok: true, configured: true });
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.body, '{"ping":true}');
  const old = await N.pingPost("/api/feedback", "Feedback", { base: PAGE, fetch: async () => res(400, "application/json", '{"error":"x"}') });
  assert.equal(old.ok, true);
});

test("pingPost: a POST swapped for a block page, 403, 407 or a dropped connection fails with the firewall line", async () => {
  const cases = [
    [async () => res(200, "text/html", "<html>Zscaler</html>"), /^Feedback was blocked: dev\.openclutter\.com returned a firewall or proxy page/],
    [async () => res(403, "text/html", "<html>no</html>"), /^Feedback was blocked:/],
    [async () => res(407, "text/plain", "auth"), /407 from dev\.openclutter\.com/],
    [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      /^Feedback could not reach dev\.openclutter\.com\./,
    ],
    [async () => res(502, "text/plain", "Bad gateway"), /^Feedback got an unexpected reply from dev\.openclutter\.com \(502\)/],
  ];
  for (const [f, re] of cases) {
    const out = await N.pingPost("/api/feedback", "Feedback", { base: PAGE, fetch: f, navigator: { onLine: true } });
    assert.equal(out.ok, false);
    assert.match(out.message, re);
    assert.equal(/\u2014/.test(out.message), false);
  }
});

test("page wiring: the Feedback dialog pings on open and the export pings after a draw", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "public/feedback.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const dlg = html.slice(html.indexOf('<dialog id="feedback"'), html.indexOf("</dialog>"));
  // The notice sits at the top of the dialog, above the message box.
  assert.ok(dlg.indexOf('id="fb-blocked"') > 0 && dlg.indexOf('id="fb-blocked"') < dlg.indexOf('id="fb-message"'));
  assert.match(js, /net\.pingPost\("\/api\/feedback", "Feedback"\)/);
  assert.match(js, /Your text stays here so you can copy it\./);
  const open = js.slice(js.indexOf("async function open()"), js.indexOf("function close()"));
  assert.match(open, /checkPost\(\)/);
  assert.match(open, /sendBtn\.disabled = true/);
  assert.match(app, /OpenClutterNet\.pingPost\("\/api\/clutter", "Export"/);
  const apply = app.slice(app.indexOf("function applyExtent("), app.indexOf("function checkExportPost("));
  assert.match(apply, /checkExportPost\(\)/);
  const check = app.slice(app.indexOf("function checkExportPost("), app.indexOf("function showIdleStatus("));
  assert.equal(/runExport|enqueueExport|exportOnce|\.onclick/.test(check), false, "a ping never starts an export");
});
