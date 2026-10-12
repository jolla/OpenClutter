"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { markStage, WEIGHT_TOTAL } = require("../netlify/lib/export-progress");

describe("export progress", () => {
  it("weights the real stages and names them for the panel", () => {
    assert.equal(WEIGHT_TOTAL, 100);
    const map = markStage("Fetching aerial");
    assert.equal(map.label, "Fetching map");
    assert.equal(map.progress, 0);
    assert.equal(map.ceiling, 0.14);
    assert.deepEqual(markStage("Fetching footprints"), {
      label: "Fetching footprints",
      progress: 0.14,
      ceiling: 0.26,
    });
    assert.deepEqual(markStage("Canopy height"), {
      label: "Canopy height",
      progress: 0.26,
      ceiling: 0.38,
    });
    assert.deepEqual(markStage("World cover"), {
      label: "World cover",
      progress: 0.38,
      ceiling: 0.46,
    });
    assert.deepEqual(markStage("Lidar heights"), {
      label: "Lidar heights",
      progress: 0.46,
      ceiling: 0.52,
    });
    assert.deepEqual(markStage("Reading terrain"), {
      label: "Terrain",
      progress: 0.52,
      ceiling: 0.64,
    });
    assert.deepEqual(markStage("Buildings 128"), {
      label: "Buildings 128",
      progress: 0.64,
      ceiling: 0.8,
    });
    assert.deepEqual(markStage("Trees 587"), {
      label: "Trees 587",
      progress: 0.8,
      ceiling: 0.94,
    });
    assert.deepEqual(markStage("Packing zip"), {
      label: "Building zip",
      progress: 0.94,
      ceiling: 1,
    });
    assert.deepEqual(markStage("Zip ready"), { label: "Zip ready", progress: 1, ceiling: 1 });
  });

  it("moves forward as the export writes each stage", () => {
    const order = [
      "Fetching aerial",
      "Fetching footprints",
      "Canopy height",
      "World cover",
      "Lidar heights",
      "Reading terrain",
      "Buildings 10",
      "Trees 4",
      "Packing zip",
    ];
    let prev = -1;
    for (let i = 0; i < order.length; i++) {
      const mark = markStage(order[i]);
      assert.ok(mark.progress >= prev);
      assert.ok(mark.ceiling > mark.progress);
      prev = mark.progress;
    }
  });

  it("shows a slim bar, the stage, and the elapsed time", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(html, /id="export-progress"/);
    assert.match(html, /id="export-stage"/);
    assert.match(html, /id="export-elapsed"/);
    assert.match(html, /role="progressbar"/);
    assert.match(app, /beginExportProgress/);
    assert.match(app, /showExportProgress\(data\)/);
    assert.match(app, /progressCeiling: 0\.14/);
    assert.match(app, /const ceiling = 15 \* 60 \* 1000/);
    assert.match(app, /Export timed out after 15 minutes\. Draw a smaller area and try again\./);
    assert.equal(app.includes("after 5 minutes"), false);
    assert.match(clutter, /reportProgress\(\{ stage: "Canopy height" \}\)|label: "Canopy height"/);
    assert.match(clutter, /label: "World cover"/);
    assert.match(clutter, /label: "Lidar heights"/);
    assert.match(app, /Math\.exp\(-dt \/ 25000\)/);
    const treesAt = clutter.indexOf('reportProgress({ stage: "Trees" })');
    const emitAt = clutter.indexOf("let built = emitClutter");
    assert.ok(treesAt > 0 && emitAt > treesAt);
    assert.equal(html.includes("\u2014"), false);
    assert.equal(app.includes("\u2014"), false);
  });
});
