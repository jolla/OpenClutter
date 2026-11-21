"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const exportMode = require("../netlify/lib/export-mode");
const { zipUnderLimit, unzipStore } = require("../netlify/lib/zip-store");
const {
  DEV_JSON_BUDGET,
  DEV_TOTAL_BUDGET,
  DEV_JSON_FLOOR,
  DEV_HOST_JSON_BUDGET,
  OPENINTENT_JSON_BUDGET,
  effectiveJsonBudget,
  shouldRebuildClutterForSmallerImage,
  replaceZipImage,
} = require("../netlify/lib/pipeline");

describe("smaller map image after zip download cap", () => {
  afterEach(() => {
    exportMode.setBigBudget(false);
    exportMode.setDevImportCaps(false);
  });

  it("does not re-pack prod-host JSON when the 8.37 MB cap does not move", () => {
    exportMode.setBigBudget(true);
    exportMode.setDevImportCaps(false);
    // 4 MB and 3 MB both leave the JSON cap at 8.37 MB.
    assert.equal(effectiveJsonBudget(0, 4000000), DEV_JSON_BUDGET);
    assert.equal(effectiveJsonBudget(0, 3000000), DEV_JSON_BUDGET);
    assert.equal(shouldRebuildClutterForSmallerImage(4000000, 3000000, 0), false);
    // Official Fort Wilderness is in this bucket after the JPEG shrinks.
    assert.equal(shouldRebuildClutterForSmallerImage(5000000, 3007515, 0), false);
  });

  it("re-packs JSON only when a smaller image raises the 14 MB total budget", () => {
    exportMode.setBigBudget(true);
    exportMode.setDevImportCaps(false);
    const tight = DEV_TOTAL_BUDGET - 2000000; // 12 MB image → 2 MB JSON cap
    const after = 3000000; // 3 MB image → 8.37 MB JSON cap
    assert.equal(effectiveJsonBudget(0, tight), Math.max(DEV_JSON_FLOOR, DEV_TOTAL_BUDGET - tight));
    assert.ok(effectiveJsonBudget(0, after) > effectiveJsonBudget(0, tight));
    assert.equal(shouldRebuildClutterForSmallerImage(tight, after, 0), true);
  });

  it("leaves the /dev 14 MB JSON path and the 4.9 MB path alone", () => {
    exportMode.setBigBudget(true);
    exportMode.setDevImportCaps(true);
    assert.equal(effectiveJsonBudget(0, 12000000), DEV_HOST_JSON_BUDGET);
    assert.equal(shouldRebuildClutterForSmallerImage(12000000, 3000000, 0), false);

    exportMode.setBigBudget(false);
    exportMode.setDevImportCaps(false);
    assert.equal(effectiveJsonBudget(0, 12000000), OPENINTENT_JSON_BUDGET);
    assert.equal(shouldRebuildClutterForSmallerImage(12000000, 3000000, 0), false);
  });

  it("rebuilds the zip with the smaller JPEG and keeps the packed JSON", () => {
    const oi = Buffer.from('{"openintent_version":"2.0.1","keep":true}');
    const credit = Buffer.from("credits\n");
    const big = Buffer.alloc(4000, 0x11);
    const small = Buffer.alloc(1200, 0x22);
    const zip = zipUnderLimit(
      [
        { name: "openIntent_Fort-Wilderness-xwide.json", data: oi },
        { name: "images/Fort-Wilderness-xwide.jpg", data: big },
        { name: "ATTRIBUTION.txt", data: credit },
      ],
      10e6
    );
    const built = {
      zip,
      imgName: "Fort-Wilderness-xwide.jpg",
      stats: { imageBytes: big.length, warnings: ["Tree canopy traced from USGS lidar."], openIntentJsonBytes: oi.length },
    };
    const note = "Map image was compressed so the zip can download.";
    const next = replaceZipImage(built, small, note);
    const files = unzipStore(next.zip);
    assert.deepEqual(files["openIntent_Fort-Wilderness-xwide.json"], oi);
    assert.deepEqual(files["ATTRIBUTION.txt"], credit);
    assert.deepEqual(files["images/Fort-Wilderness-xwide.jpg"], small);
    assert.equal(next.stats.imageBytes, small.length);
    assert.ok(next.stats.warnings.indexOf(note) >= 0);
    assert.ok(next.stats.warnings.indexOf("Tree canopy traced from USGS lidar.") >= 0);
    assert.equal(next.stats.openIntentJsonBytes, oi.length);
    assert.ok(next.zip.length < zip.length);
    // The original zip and stats stay as they were.
    assert.equal(built.stats.imageBytes, big.length);
    assert.deepEqual(unzipStore(built.zip)["images/Fort-Wilderness-xwide.jpg"], big);
  });

  it("has the background export swap the JPEG instead of re-detecting when the budget holds", () => {
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    const compressAt = clutter.indexOf("if (background && built.zip && !exportJobs.zipDownloadFits(built.zip.length)");
    const packingAt = clutter.indexOf('reportProgress({ stage: "Packing zip" })');
    assert.ok(compressAt > 0 && packingAt > compressAt);
    const slice = clutter.slice(compressAt, packingAt);
    assert.match(slice, /shouldRebuildClutterForSmallerImage/);
    assert.match(slice, /replaceZipImage\(built, imgBuf/);
    assert.match(slice, /reuseDetect: true/);
    assert.equal(slice.includes("await emitClutter(exportFeatures);"), false);
  });
});
