"use strict";

const jobs = require("../lib/export-jobs");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function json(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ "content-type": "application/json" }, cors),
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  const q = event.queryStringParameters || {};
  const id = q.job || q.id;
  if (!jobs.validJobId(id)) return json(400, { error: "Export id is not valid." });
  let job;
  try {
    job = await jobs.readJob(id);
  } catch {
    return json(503, { error: "The zip could not be read. Export again." });
  }
  if (!job) return json(404, { error: "This export expired. Export again." });
  if (job.state === "error") return json(409, { error: job.error || "Export failed." });
  if (job.state !== "done") return json(409, { error: "The zip is not ready yet." });
  let zip;
  try {
    zip = await jobs.takeZip(id);
  } catch {
    return json(503, { error: "The zip could not be read. Export again." });
  }
  if (!zip || !zip.length) return json(410, { error: "This export was already downloaded. Export again." });
  const name = String(job.zipFilename || "openclutter.zip").replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    statusCode: 200,
    headers: Object.assign({}, cors, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${name}"`,
    }),
    body: zip.toString("base64"),
    isBase64Encoded: true,
  };
};
