"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { markStage, exportPercent, WEIGHT_TOTAL } = require("../netlify/lib/export-progress");

describe("export progress", () => {
  it("weights the real stages and names them for the panel", () => {
    assert.equal(WEIGHT_TOTAL, 100);
    const map = markStage("Fetching aerial");
    assert.equal(map.label, "Fetching map");
    assert.equal(map.progress, 0);
    assert.equal(map.ceiling, 0.04);
    assert.deepEqual(markStage("Fetching footprints"), {
      label: "Fetching footprints",
      progress: 0.04,
      ceiling: 0.07,
    });
    assert.deepEqual(markStage("Canopy height"), {
      label: "Canopy height",
      progress: 0.07,
      ceiling: 0.1,
    });
    assert.deepEqual(markStage("World cover"), {
      label: "World cover",
      progress: 0.1,
      ceiling: 0.12,
    });
    assert.deepEqual(markStage("Lidar heights"), {
      label: "Lidar heights",
      progress: 0.12,
      ceiling: 0.13,
    });
    assert.deepEqual(markStage("Reading terrain"), {
      label: "Terrain",
      progress: 0.13,
      ceiling: 0.16,
    });
    assert.deepEqual(markStage("Buildings 128"), {
      label: "Buildings 128",
      progress: 0.16,
      ceiling: 0.2,
    });
    assert.deepEqual(markStage("Trees 587"), {
      label: "Trees 587",
      progress: 0.2,
      ceiling: 0.98,
    });
    assert.deepEqual(markStage("Packing zip"), {
      label: "Building zip",
      progress: 0.98,
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

  it("puts the percent on the Export button and the stage on the status line", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    assert.match(html, /id="export-fill"/);
    assert.match(html, /id="export-label">Export</);
    assert.equal(html.includes('id="export-progress"'), false);
    assert.match(app, /beginExportProgress/);
    assert.match(app, /showExportProgress\(data\)/);
    assert.match(app, /Exporting " \+ pct \+ "%"/);
    assert.match(app, /fill\.style\.width = pct \+ "%"/);
    assert.match(app, /setAttribute\("role", "progressbar"\)/);
    assert.match(app, /const ceiling = 15 \* 60 \* 1000/);
    assert.match(app, /Export timed out after 15 minutes\. Draw a smaller area and try again\./);
    assert.equal(app.includes("after 5 minutes"), false);
    assert.match(clutter, /reportProgress\(\{ stage: "Canopy height" \}\)|label: "Canopy height"/);
    assert.match(clutter, /label: "World cover"/);
    assert.match(clutter, /label: "Lidar heights"/);
    assert.equal(app.includes("Math.exp(-dt / 25000)"), false);
    const treesAt = clutter.indexOf('reportProgress({ stage: "Trees" })');
    const emitAt = clutter.indexOf("emitClutter(exportFeatures)");
    assert.ok(treesAt > 0 && emitAt > treesAt);
    assert.equal(html.includes("\u2014"), false);
    assert.equal(app.includes("\u2014"), false);
  });

  it("keeps the percent monotonic and saves 100 for a finished zip", () => {
    function row(stage, extra) {
      return Object.assign({ stage: stage, state: "running" }, extra || {});
    }
    const steps = [
      row("Fetching aerial"),
      row("Fetching footprints"),
      row("Canopy height"),
      row("World cover"),
      row("Lidar heights"),
      row("Reading terrain"),
      row("Buildings 10"),
      row("Trees", { tilesDone: 0, tilesTotal: 10 }),
      row("Trees", { tilesDone: 3, tilesTotal: 10 }),
      row("Trees"),
      row("Trees", { tilesDone: 10, tilesTotal: 10 }),
      row("Packing zip"),
      row("Zip ready", { state: "done" }),
    ];
    let held = 0;
    const seen = [];
    for (let i = 0; i < steps.length; i++) {
      held = exportPercent(steps[i], held);
      seen.push(held);
      if (i > 0) assert.ok(held >= seen[i - 1], seen.join(","));
    }
    assert.deepEqual(seen, [0, 4, 7, 10, 12, 13, 16, 20, 43, 43, 98, 98, 100]);
    assert.equal(exportPercent(row("Packing zip"), 0), 98);
    assert.equal(exportPercent(row("Zip ready"), 0), 99);
    assert.equal(exportPercent(row("Zip ready", { state: "done" }), 0), 100);
    assert.notEqual(exportPercent(row("Packing zip", { tilesDone: 10, tilesTotal: 10 }), 0), 100);

    const partial = exportPercent(row("Trees", { tilesDone: 4, tilesTotal: 8 }), 0);
    assert.equal(partial, 59);
    assert.ok(partial > exportPercent(row("Trees"), 0));
    assert.equal(exportPercent(row("Trees"), partial), partial);
    assert.equal(exportPercent(row("Trees", { tilesDone: 8, tilesTotal: 8 }), partial), 98);
  });
});
