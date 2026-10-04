"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { exportFailure, failureError, runExportAttempts } = require("../public/export-client");

describe("export gateway timeout", () => {
  it("retries an empty 504 or 408 and does not call the draw too large", async () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    assert.equal(app.includes("Export did not finish. Try again."), false);
    assert.equal(/too large to finish in one export/.test(app), false);
    assert.match(app, /Export is still working\./);
    assert.match(html, /src="\/export-client\.js"/);
    assert.match(app, /OpenClutterExport\.runExportAttempts/);

    for (const status of [504, 408]) {
      const failure = exportFailure(status, {});
      assert.equal(failure.gateway, true);
      assert.equal(failure.retry, true);
      assert.equal(failure.attempts, 3);
      assert.equal(failure.message, "Export failed. Retry.");
      assert.equal(/did not finish|too large to finish/i.test(failure.message), false);
      const err = failureError(status, {});
      assert.equal(err.attempts, 3);
      assert.equal(err.noRetry, false);
    }

    const blocked = exportFailure(400, { error: "bad bbox" });
    assert.equal(blocked.retry, false);
    assert.equal(blocked.attempts, 1);
    assert.equal(blocked.message, "bad bbox");
    assert.equal(exportFailure(413, {}).retry, false);

    const imagery = exportFailure(502, { error: "Aerial imagery timed out. Retry the export." });
    assert.equal(imagery.gateway, false);
    assert.equal(imagery.attempts, 2);
    assert.equal(imagery.retry, true);

    const seen = [];
    const zip = { zipBase64: "e30=", zipFilename: "openclutter.zip" };
    const data = await runExportAttempts(async (attempt) => {
      seen.push(attempt);
      if (attempt < 3) throw failureError(504, {});
      return zip;
    });
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(data, zip);

    await assert.rejects(
      () => runExportAttempts(async () => { throw failureError(400, { error: "bad bbox" }); }),
      (err) => {
        assert.equal(err.message, "bad bbox");
        assert.equal(/did not finish|too large to finish/i.test(err.message), false);
        return true;
      }
    );
  });
});
