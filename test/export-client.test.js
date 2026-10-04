"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { exportFailure, failureError, runExportAttempts } = require("../public/export-client");

describe("export gateway timeout", () => {
  it("finishes a recoverable or slow export instead of stopping on an empty failure", async () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const client = fs.readFileSync(path.join(__dirname, "../public/export-client.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    assert.equal(app.includes("Export did not finish. Try again."), false);
    assert.equal(app.includes("Export failed. Retry."), false);
    assert.equal(client.includes("Export failed. Retry."), false);
    assert.equal(/too large to finish in one export/.test(app + client), false);
    assert.match(app, /Export is still working\./);
    assert.match(html, /src="\/export-client\.js"/);
    assert.match(app, /OpenClutterExport\.runExportAttempts/);

    for (const status of [504, 408, 502, 503]) {
      const failure = exportFailure(status, {});
      assert.equal(failure.retry, true);
      assert.equal(failure.attempts, 3);
      assert.equal(failure.message, "");
      assert.equal(/Export failed\. Retry\.|did not finish|too large to finish/i.test(failure.message), false);
      const err = failureError(status, {});
      assert.equal(err.attempts, 3);
      assert.equal(err.noRetry, false);
      assert.equal(err.message, "");
    }
    assert.equal(exportFailure(504, {}).gateway, true);
    assert.equal(exportFailure(502, {}).gateway, false);

    const blocked = exportFailure(400, { error: "bad bbox" });
    assert.equal(blocked.retry, false);
    assert.equal(blocked.attempts, 1);
    assert.equal(blocked.message, "bad bbox");
    assert.equal(exportFailure(413, {}).retry, false);
    assert.equal(exportFailure(413, {}).attempts, 1);

    const imagery = exportFailure(502, { error: "Aerial imagery timed out. Retry the export." });
    assert.equal(imagery.gateway, false);
    assert.equal(imagery.attempts, 3);
    assert.equal(imagery.retry, true);
    assert.equal(imagery.message, "Aerial imagery timed out. Retry the export.");

    const zip = { zipBase64: "e30=", zipFilename: "openclutter.zip" };
    const seen = [];
    const data = await runExportAttempts(async (attempt) => {
      seen.push(attempt);
      if (attempt < 3) throw failureError(504, {});
      return zip;
    });
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(data, zip);

    const afterEmpty = [];
    const emptyThenZip = await runExportAttempts(async (attempt) => {
      afterEmpty.push(attempt);
      if (attempt === 1) throw failureError(502, {});
      return zip;
    });
    assert.deepEqual(afterEmpty, [1, 2]);
    assert.equal(emptyThenZip, zip);

    const afterThrow = [];
    const thrownThenZip = await runExportAttempts(async (attempt) => {
      afterThrow.push(attempt);
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return zip;
    });
    assert.deepEqual(afterThrow, [1, 2]);
    assert.equal(thrownThenZip, zip);

    await assert.rejects(
      () => runExportAttempts(async () => { throw failureError(504, {}); }),
      (err) => {
        assert.equal(err.message, "");
        assert.equal(/Export failed\. Retry\.|did not finish|too large to finish/i.test(String(err.message)), false);
        return true;
      }
    );

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
