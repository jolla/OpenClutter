"use strict";

/**
 * HTTP entry for the Fly machine. One export keeps this response open
 * until the job finishes, including the newline every 20s. Returning 202
 * and then working with no connection is what Fly autostop killed. Autostop
 * is off in fly.toml. This process exits itself after IDLE_EXIT_MS with no
 * export, which stops the machine. The last line of the response is the result.
 */

const http = require("node:http");
const { BODY_MAX, handleWorkerRequest, jobInFlight, createIdleExit } = require("./worker");

const IDLE_TICK_MS = 30 * 1000;
let stopRequested = false;
const CANCEL_EXIT_MS = 500;
let cancelExitFn = () => {
  const t = setTimeout(() => {
    console.log("export cancelled; worker exits to stop the job");
    process.exit(0);
  }, CANCEL_EXIT_MS);
  if (typeof t.unref === "function") t.unref();
};

function cancelExit() {
  cancelExitFn();
}

function setCancelExitForTests(fn) {
  cancelExitFn = typeof fn === "function" ? fn : cancelExitFn;
}
let idleExit = createIdleExit({ inFlight: jobInFlight });

function useIdleExit(ctrl) {
  idleExit = ctrl || createIdleExit({ inFlight: jobInFlight });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        const err = new Error("body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body || {});
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function onRequest(req, res) {
  const release = idleExit.hold();
  try {
    let body = "";
    try {
      if (req.method === "POST") body = await readBody(req);
    } catch (err) {
      const status = err && err.statusCode === 413 ? 413 : 400;
      sendJson(res, status, { error: status === 413 ? "Request is too large." : "invalid json" });
      return;
    }
    let result;
    try {
      result = await handleWorkerRequest({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
    } catch {
      sendJson(res, 500, { error: "Export failed." });
      return;
    }
    if (!result.job) {
      sendJson(res, result.statusCode, result.body);
      return;
    }
    res.writeHead(result.statusCode, { "content-type": "application/x-ndjson" });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const beat = setInterval(() => {
      try {
        if (!res.writableEnded) res.write("\n");
      } catch {
        /* The export keeps running after the client leaves. */
      }
    }, 20000);
    if (typeof beat.unref === "function") beat.unref();
    let outcome = { ok: false, reason: "export-failed" };
    try {
      outcome = (await result.job) || outcome;
    } catch {
      outcome = { ok: false, reason: "export-failed" };
    } finally {
      clearInterval(beat);
    }
    if (outcome && outcome.cancelled) {
      // A cancelled pipeline may still hold fetches and CPU threads. Answer,
      // then exit so all of it stops and the machine is free; a clean exit
      // is not restarted and the next export starts the machine.
      const done = () => cancelExit();
      if (!res.writableEnded) res.end(JSON.stringify(outcome) + "\n", done);
      else done();
      return;
    }
    if (!res.writableEnded) res.end(JSON.stringify(outcome) + "\n");
    if (stopRequested) process.exit(0);
  } finally {
    release();
  }
}

function startServer(port) {
  const server = http.createServer(onRequest);
  const listenPort = port == null ? Number(process.env.PORT) || 8080 : port;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "0.0.0.0", () => resolve(server));
  });
}

function requestStop() {
  stopRequested = true;
}

if (require.main === module) {
  console.log(require("../netlify/lib/cpu-pool").cpuStartLine());
  const idle = createIdleExit({ inFlight: jobInFlight });
  useIdleExit(idle);
  const idleTimer = setInterval(() => idle.check(), IDLE_TICK_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
  process.on("SIGTERM", () => {
    requestStop();
    if (!jobInFlight()) process.exit(0);
  });
  startServer()
    .then((server) => {
      const addr = server.address();
      console.log("openclutter export worker listening on " + (addr && addr.port));
    })
    .catch((err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    });
}

module.exports = { startServer, requestStop, useIdleExit, setCancelExitForTests, IDLE_TICK_MS };
