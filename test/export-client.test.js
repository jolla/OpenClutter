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
  chooseTerrainPaste,
  terrainPasteLine,
  exportSummaryLines,
  steepestGrade,
} = require("../public/export-client");
const { steepestClipboardGrade } = require("../netlify/lib/terrain");

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
      assert.equal(failure.retry, true);
      assert.equal(failure.attempts, 2);
      assert.equal(failure.message, EMPTY_502_STATUS);
      assert.notEqual(failure.message, "");
      assert.notEqual(failure.message, WORKING_STATUS);
      assert.equal(/stopped before a zip was ready|Aerial imagery timed out|did not finish|too large to finish/i.test(failure.message), false);
      const err = failureError(status, {});
      assert.equal(err.attempts, 2);
      assert.equal(err.noRetry, false);
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
    assert.equal(empty502.retry, true);
    assert.equal(empty502.attempts, 2);
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
    assert.deepEqual(calls, [1, 2]);

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
        assert.equal(err.noRetry, false);
        return true;
      }
    );
    assert.deepEqual(emptyCalls, [1, 2]);

    const recovered = [];
    const zipAfterMiss = await runExportAttempts(async (attempt) => {
      recovered.push(attempt);
      if (attempt === 1) throw failureError(502, {});
      return { zipBase64: "e30=", zipFilename: "openclutter.zip" };
    });
    assert.deepEqual(recovered, [1, 2]);
    assert.equal(zipAfterMiss.zipFilename, "openclutter.zip");
    assert.match(app, /The first export did not return a zip\. Export is still working\./);

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

describe("Copy terrain after a background result", () => {
  const gps = {
    header: { type: "HaminaClipboard" },
    tiePoints: [
      { lat: 40.5, lon: -112.16, x: -100, y: -100 },
      { lat: 40.51, lon: -112.15, x: 0, y: 0 },
    ],
    slopedFloors: [],
    raisedFloorZones: [],
  };

  it("keeps the sloped mesh and stamps the two GPS points onto it", () => {
    const mesh = {
      header: { type: "HaminaClipboard" },
      slopedFloors: [{ area: { coordinates: [[[0, 0, 1], [1, 0, 1], [1, 1, 2], [0, 1, 2]]] } }],
      raisedFloorZones: [],
      tiePoints: [],
    };
    const choice = chooseTerrainPaste(
      { terrainClipboard: mesh, gpsClipboard: gps, terrainStatus: "Terrain sloped 20×20." },
      true
    );
    assert.equal(choice.gpsOnly, false);
    const parsed = JSON.parse(choice.json);
    assert.equal(parsed.slopedFloors.length, 1);
    assert.equal(parsed.tiePoints.length, 2);
    assert.equal(parsed.tiePoints[1].x, 0);
    assert.match(choice.status, /Terrain sloped/);
  });

  it("does not replace a missing mesh with the GPS copy when Terrain is on", () => {
    const choice = chooseTerrainPaste({ terrainClipboard: null, gpsClipboard: gps, terrainStatus: "" }, true);
    assert.equal(choice.json, "");
    assert.equal(choice.gpsOnly, false);
    assert.equal(choice.status, "Terrain did not return. Export again.");
  });

  it("names the paste size for Details", () => {
    const line = terrainPasteLine({
      slopedFloors: [{}, {}],
      raisedFloorZones: [{}],
    });
    assert.match(line, /^Terrain paste: 3 floors, \d+ KB$/);
    assert.equal(/\u2014/.test(line), false);
    assert.equal(terrainPasteLine({ slopedFloors: [], raisedFloorZones: [] }), "");
    const client = fs.readFileSync(path.join(__dirname, "../public/export-client.js"), "utf8");
    assert.match(client, /Terrain paste: " \+ floors \+ " floors, " \+ kb \+ " KB"/);
  });

  it("lists a compact finished-export summary", () => {
    const ramp = {
      area: {
        coordinates: [[[0, 0, 0], [10, 0, 0], [10, 20, 10], [0, 20, 10]]],
      },
    };
    const data = {
      zipBytes: 3410000,
      warnings: ["Map image 4096 px, 0.19 m per pixel.", "Lidar heights used."],
      terrainClipboard: { slopedFloors: [ramp], raisedFloorZones: [{}, {}] },
      stats: {
        buildings: 129,
        trees: 593,
        discreteTrees: 410,
        rvAreas: 2,
        parkingAreas: 4,
        wallAreas: 0,
        poleAreas: 1,
        waterAreas: 0,
        bridgeAreas: 1,
        guidewayAreas: 2,
        terrainMinM: 612.4,
        terrainMaxM: 891.2,
        terrainReliefM: 278.8,
        openIntentJsonBytes: 2100000,
        jsonBudget: 3800000,
      },
    };
    const lines = exportSummaryLines(data, { foliageOn: true, terrainOn: true });
    assert.deepEqual(lines, [
      "Buildings 129",
      "Trees 410, stands 183",
      "RVs 2",
      "Parking 4",
      "Poles 1",
      "Bridges and rail 3",
      "Minimum 612.4 m (2,009 ft)",
      "Maximum 891.2 m (2,924 ft)",
      "Elevation change 278.8 m (915 ft)",
      "Steepest slope 50% (27°)",
      "Terrain pieces 3",
      "Zip 3.41 MB, OpenIntent 2.10 MB of 3.80 MB",
      "Map 4096 px, 0.19 m per pixel",
    ]);
    assert.equal(lines.some((line) => /Walls and fences|Water /.test(line)), false);
    assert.equal(/\u2014/.test(lines.join("\n")), false);
    assert.equal(steepestGrade(data.terrainClipboard), steepestClipboardGrade(data.terrainClipboard));
    const off = exportSummaryLines(
      { stats: { buildings: 0, trees: 4, openIntentJsonBytes: 80000 } },
      { foliageOn: false, terrainOn: false }
    );
    assert.deepEqual(off, ["Buildings 0", "Terrain off", "OpenIntent 80 KB of 3.80 MB"]);
    const stands = exportSummaryLines(
      { stats: { buildings: 1, trees: 12, discreteTrees: 0 }, frame: { imgW: 2048, imgH: 1800, mpuX: 0.4 } },
      { foliageOn: true, terrainOn: true }
    );
    assert.equal(stands[1], "Stands 12");
    assert.equal(stands[stands.length - 1], "Map 2048 px, 0.40 m per pixel");
  });

  it("still copies GPS points when Terrain is off", () => {
    const choice = chooseTerrainPaste({ terrainClipboard: null, gpsClipboard: gps }, false);
    assert.equal(choice.gpsOnly, true);
    assert.equal(JSON.parse(choice.json).tiePoints.length, 2);
    assert.equal(JSON.parse(choice.json).slopedFloors.length, 0);
  });
});
