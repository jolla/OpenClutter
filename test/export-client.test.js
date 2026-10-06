"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  WORKING_STATUS,
  EMPTY_502_STATUS,
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
    assert.equal(app.includes("The export stopped before a zip was ready."), false);
    assert.equal(client.includes("The export stopped before a zip was ready."), false);
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
      assert.equal(failure.message, EMPTY_502_STATUS);
      assert.notEqual(failure.message, "");
      assert.notEqual(failure.message, WORKING_STATUS);
      assert.equal(/stopped before a zip was ready|Aerial imagery timed out|did not finish|too large to finish/i.test(failure.message), false);
      const err = failureError(status, {});
      assert.equal(err.attempts, 1);
      assert.equal(err.noRetry, true);
      assert.equal(idleStatus(err), EMPTY_502_STATUS);
      assert.notEqual(idleStatus(err), "");
      assert.notEqual(idleStatus(err), WORKING_STATUS);
    }

    assert.equal(idleStatus(new Error("")), "");
    assert.equal(idleStatus(new Error(WORKING_STATUS)), "");
    assert.notEqual(idleStatus(new Error("")), WORKING_STATUS);
    assert.equal(
      idleStatus(failureError(502, { error: "Aerial imagery timed out. Retry the export." })),
      EMPTY_502_STATUS
    );
    assert.equal(
      idleStatus(new Error("The export stopped before a zip was ready.")),
      ""
    );

    const blocked = exportFailure(400, { error: "bad bbox" });
    assert.equal(blocked.retry, false);
    assert.equal(blocked.attempts, 1);
    assert.equal(blocked.message, "bad bbox");
    assert.equal(exportFailure(413, {}).retry, false);
    assert.equal(idleStatus(failureError(400, { error: "bad bbox" })), "bad bbox");

    const imagery = exportFailure(502, { error: "Aerial imagery timed out. Retry the export." });
    assert.equal(imagery.gateway, true);
    assert.equal(imagery.attempts, 1);
    assert.equal(imagery.retry, false);
    assert.equal(imagery.message, EMPTY_502_STATUS);
    assert.equal(/Aerial imagery timed out/.test(imagery.message), false);

    const footprints = exportFailure(502, { error: "Building footprints timed out. Retry the export." });
    assert.equal(footprints.attempts, 1);
    assert.equal(footprints.retry, false);
    assert.equal(footprints.message, "Building footprints timed out. Retry the export.");
    assert.equal(idleStatus(failureError(502, { error: footprints.message })), footprints.message);

    const empty502 = exportFailure(502, {});
    assert.equal(empty502.gateway, true);
    assert.equal(empty502.retry, false);
    assert.equal(empty502.attempts, 1);
    assert.equal(empty502.message, EMPTY_502_STATUS);
    assert.equal(EMPTY_502_STATUS, "The export did not return a zip.");
    assert.equal(/Export failed\. Retry\.|did not finish|stopped before a zip|Aerial imagery timed out|too large to finish/i.test(EMPTY_502_STATUS), false);
    assert.equal(idleStatus(failureError(502, {})), EMPTY_502_STATUS);
    assert.notEqual(idleStatus(failureError(502, {})), "");
    assert.notEqual(idleStatus(failureError(502, {})), WORKING_STATUS);

    const calls = [];
    await assert.rejects(
      () =>
        runExportAttempts(async (attempt) => {
          calls.push(attempt);
          throw failureError(504, {});
        }),
      (err) => {
        assert.equal(idleStatus(err), EMPTY_502_STATUS);
        assert.notEqual(idleStatus(err), "");
        assert.notEqual(idleStatus(err), WORKING_STATUS);
        assert.equal(/stopped before a zip was ready|Aerial imagery timed out/.test(idleStatus(err)), false);
        assert.equal(/Export failed\. Retry\.|did not finish|too large to finish/i.test(String(err.message)), false);
        return true;
      }
    );
    assert.deepEqual(calls, [1]);

    const emptyCalls = [];
    await assert.rejects(
      () =>
        runExportAttempts(async (attempt) => {
          emptyCalls.push(attempt);
          throw failureError(502, {});
        }),
      (err) => {
        assert.equal(err.message, EMPTY_502_STATUS);
        assert.equal(idleStatus(err), EMPTY_502_STATUS);
        assert.equal(err.noRetry, true);
        return true;
      }
    );
    assert.deepEqual(emptyCalls, [1]);

    const jsonCalls = [];
    await assert.rejects(
      () =>
        runExportAttempts(async (attempt) => {
          jsonCalls.push(attempt);
          throw failureError(502, { error: "Aerial imagery timed out. Retry the export." });
        }),
      (err) => {
        assert.equal(err.message, EMPTY_502_STATUS);
        assert.equal(idleStatus(err), EMPTY_502_STATUS);
        assert.equal(err.noRetry, true);
        assert.equal(/Aerial imagery timed out/.test(idleStatus(err)), false);
        return true;
      }
    );
    assert.deepEqual(jsonCalls, [1]);

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
