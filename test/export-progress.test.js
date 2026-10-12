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
    assert.equal(map.ceiling, 0.18);
    assert.deepEqual(markStage("Fetching footprints"), {
      label: "Fetching footprints",
      progress: 0.18,
      ceiling: 0.34,
    });
    assert.deepEqual(markStage("Reading terrain"), {
      label: "Terrain",
      progress: 0.34,
      ceiling: 0.48,
    });
    assert.deepEqual(markStage("Buildings 128"), {
      label: "Buildings 128",
      progress: 0.48,
      ceiling: 0.68,
    });
    assert.deepEqual(markStage("Trees 587"), {
      label: "Trees 587",
      progress: 0.68,
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
    const order = ["Fetching aerial", "Fetching footprints", "Reading terrain", "Buildings 10", "Trees 4", "Packing zip"];
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
    assert.match(html, /id="export-progress"/);
    assert.match(html, /id="export-stage"/);
    assert.match(html, /id="export-elapsed"/);
    assert.match(html, /role="progressbar"/);
    assert.match(app, /beginExportProgress/);
    assert.match(app, /showExportProgress\(data\)/);
    assert.match(app, /progressCeiling: 0\.18/);
    assert.match(app, /Math\.exp\(-dt \/ 25000\)/);
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    const treesAt = clutter.indexOf('reportProgress({ stage: "Trees" })');
    const emitAt = clutter.indexOf("let built = emitClutter");
    assert.ok(treesAt > 0 && emitAt > treesAt);
    assert.equal(html.includes("\u2014"), false);
    assert.equal(app.includes("\u2014"), false);
  });
});
