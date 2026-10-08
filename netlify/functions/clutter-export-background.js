"use strict";

const { runBackgroundExport } = require("./clutter");
const jobs = require("../lib/export-jobs");

function publicError(err) {
  const msg = err && err.message ? String(err.message) : "Export failed.";
  if (/aborted due to timeout|timed out/i.test(msg)) {
    return "Export timed out. Draw a smaller area and try again.";
  }
  return msg;
}

/**
 * Up to 15 minutes on Netlify. The handler awaits the pipeline. The platform
 * already answered 202 to the sync function that invoked this.
 */
exports.handler = async (event) => {
  jobs.bindBlobs(event);
  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 202, body: "" };
  }
  const jobId = payload.jobId;
  const inner = payload.event;
  if (!jobs.validJobId(jobId) || !inner || !inner.body) return { statusCode: 202, body: "" };
  try {
    await jobs.updateJob(jobId, { state: "running", stage: "Fetching aerial" });
  } catch (err) {
    return { statusCode: 202, body: "" };
  }
  try {
    const result = await runBackgroundExport(inner, (patch) => jobs.updateJob(jobId, patch));
    const status = result && result.statusCode;
    let data = {};
    try {
      data = JSON.parse((result && result.body) || "{}");
    } catch {
      data = {};
    }
    if (status !== 200 || !data.zipBase64) {
      const why =
        data.error ||
        (status && status !== 200 ? "Export failed (" + status + ")." : "Export finished without a zip.");
      await jobs.updateJob(jobId, {
        state: "error",
        stage: "Export failed",
        error: why,
      });
      return { statusCode: 202, body: "" };
    }
    const zip = Buffer.from(data.zipBase64, "base64");
    await jobs.saveZip(jobId, zip);
    await jobs.updateJob(jobId, {
      state: "done",
      stage: "Zip ready",
      error: null,
      zipFilename: data.zipFilename || "openclutter.zip",
      zipBytes: zip.length,
      stats: data.stats || null,
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      terrainClipboard: data.terrainClipboard || null,
      terrainStatus: data.terrainStatus || "",
      gpsClipboard: data.gpsClipboard || null,
    });
  } catch (err) {
    await jobs.updateJob(jobId, {
      state: "error",
      stage: "Export failed",
      error: publicError(err),
    }).catch(() => {});
  }
  return { statusCode: 202, body: "" };
};
