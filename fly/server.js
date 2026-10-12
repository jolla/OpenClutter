"use strict";

/**
 * HTTP entry for the Fly machine. One export keeps the response open so
 * Fly Proxy still sees a request and does not stop the machine mid-job.
 * A newline every 20s is only a heartbeat. The last line is the result.
 */

const http = require("node:http");
const { BODY_MAX, handleWorkerRequest } = require("./worker");

let stopRequested = false;

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
  if (!res.writableEnded) res.end(JSON.stringify(outcome) + "\n");
  if (stopRequested) process.exit(0);
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
  process.on("SIGTERM", () => {
    requestStop();
    const { jobInFlight } = require("./worker");
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

module.exports = { startServer, requestStop };
