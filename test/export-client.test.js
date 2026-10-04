"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  WORKING_STATUS,
  STOPPED_STATUS,
  exportFailure,
  failureError,
  idleStatus,
  runExportAttempts,
} = require("../public/export-client");

describe("export gateway timeout", () => {
  it("returns one zip and does not leave the working line up after a 504", async () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const client = fs.readFileSync(path.join(__dirname, "../public/export-client.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    assert.equal(app.includes("Export did not finish. Try again."), false);
    assert.equal(app.includes("Export failed. Retry."), false);
    assert.equal(client.includes("Export failed. Retry."), false);
    assert.equal(/too large to finish in one export/.test(app + client), false);
    assert.match(app, /Export is still working\./);
    assert.match(app, /OpenClutterExport\.idleStatus/);
    assert.match(html, /src="\/export-client\.js"/);
    assert.match(app, /OpenClutterExport\.runExportAttempts/);
    assert.equal(WORKING_STATUS, "Export is still working.");

    for (const status of [504, 408]) {
      const failure = exportFailure(status, {});
      assert.equal(failure.gateway, true);
      assert.equal(failure.retry, false);
      assert.equal(failure.attempts, 1);
      assert.equal(failure.message, STOPPED_STATUS);
      assert.notEqual(failure.message, WORKING_STATUS);
      assert.equal(/Export failed\. Retry\.|did not finish|too large to finish/i.test(failure.message), false);
      const err = failureError(status, {});
      assert.equal(err.attempts, 1);
      assert.equal(err.noRetry, true);
      assert.equal(idleStatus(err), STOPPED_STATUS);
      assert.notEqual(idleStatus(err), WORKING_STATUS);
    }

    assert.equal(idleStatus(new Error("")), STOPPED_STATUS);
    assert.equal(idleStatus(new Error(WORKING_STATUS)), STOPPED_STATUS);
    assert.notEqual(idleStatus(new Error("")), WORKING_STATUS);

    const blocked = exportFailure(400, { error: "bad bbox" });
    assert.equal(blocked.retry, false);
    assert.equal(blocked.attempts, 1);
    assert.equal(blocked.message, "bad bbox");
    assert.equal(exportFailure(413, {}).retry, false);
    assert.equal(idleStatus(failureError(400, { error: "bad bbox" })), "bad bbox");

    const imagery = exportFailure(502, { error: "Aerial imagery timed out. Retry the export." });
    assert.equal(imagery.gateway, false);
    assert.equal(imagery.attempts, 3);
    assert.equal(imagery.retry, true);
    assert.equal(imagery.message, "Aerial imagery timed out. Retry the export.");

    const calls = [];
    await assert.rejects(
      () =>
        runExportAttempts(async (attempt) => {
          calls.push(attempt);
          throw failureError(504, {});
        }),
      (err) => {
        assert.equal(idleStatus(err), STOPPED_STATUS);
        assert.notEqual(idleStatus(err), WORKING_STATUS);
        assert.equal(/Export failed\. Retry\.|did not finish|too large to finish/i.test(String(err.message)), false);
        return true;
      }
    );
    assert.deepEqual(calls, [1]);

    const zip = { zipBase64: "e30=", zipFilename: "openclutter.zip" };
    const once = [];
    const data = await runExportAttempts(async (attempt) => {
      once.push(attempt);
      return zip;
    });
    assert.deepEqual(once, [1]);
    assert.equal(data, zip);

    await assert.rejects(
      () => runExportAttempts(async () => { throw failureError(400, { error: "bad bbox" }); }),
      (err) => {
        assert.equal(err.message, "bad bbox");
        assert.equal(/Export failed\. Retry\.|did not finish|too large to finish/i.test(err.message), false);
        return true;
      }
    );
  });
});
