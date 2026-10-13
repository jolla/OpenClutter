"use strict";

const { describe, it, mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  formatExportElapsed,
  exportDoneLine,
  withExportDone,
  createExportClock,
} = require("../public/export-client");

afterEach(() => {
  mock.timers.reset();
});

describe("export elapsed timer", () => {
  it("formats the button clock and the finished line", () => {
    assert.equal(formatExportElapsed(0), "0:00");
    assert.equal(formatExportElapsed(42000), "0:42");
    assert.equal(formatExportElapsed(55000), "0:55");
    assert.equal(formatExportElapsed(125000), "2:05");
    assert.equal(exportDoneLine(55000), "Done in 0:55");
    assert.equal(/\u2014/.test(exportDoneLine(55000) + formatExportElapsed(42000)), false);
  });

  it("advances the timer label about once a second while the percent stays unchanged", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"] });
    const elapsed = { hidden: true, textContent: "" };
    const label = { textContent: "Export" };
    let percent = 42;
    const seen = [];
    const clock = createExportClock({
      onTick(text) {
        elapsed.hidden = false;
        elapsed.textContent = text;
        label.textContent = "Exporting " + percent + "%";
        seen.push({ elapsed: elapsed.textContent, percent: percent });
      },
    });
    assert.equal(elapsed.textContent, "0:00");
    assert.equal(label.textContent, "Exporting 42%");
    mock.timers.tick(1000);
    assert.equal(elapsed.textContent, "0:01");
    assert.equal(label.textContent, "Exporting 42%");
    assert.equal(seen[seen.length - 1].percent, 42);
    mock.timers.tick(1000);
    assert.equal(elapsed.textContent, "0:02");
    assert.equal(percent, 42);
    assert.equal(label.textContent, "Exporting 42%");
    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((row) => row.elapsed),
      ["0:00", "0:01", "0:02"]
    );
    assert.equal(clock.doneLine(), "Done in 0:02");
    clock.stop();
    mock.timers.tick(3000);
    assert.equal(seen.length, 3);
    assert.equal(elapsed.textContent, "0:02");
  });

  it("starts the finished summary with Done in 0:55 and keeps that line after Copy terrain", () => {
    const summary = withExportDone(
      ["Zip ready. 2 buildings.", "Buildings 2", "Import this zip in Hamina (Projects → Import → OpenIntent)."],
      55000
    );
    assert.equal(summary[0], "Done in 0:55");
    assert.equal(summary[1], "Zip ready. 2 buildings.");
    const summaryLine = summary[0];
    const details = summary.slice(1);
    const afterCopy = {
      summaryLine: summaryLine,
      details: details,
      note: "Copied. Paste terrain separately in Hamina.",
    };
    assert.equal(afterCopy.summaryLine, "Done in 0:55");
    assert.equal(afterCopy.details[0], "Zip ready. 2 buildings.");
    assert.equal(afterCopy.details.length, summary.length - 1);
    assert.equal(/\u2014/.test(summary.join("\n")), false);

    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const client = fs.readFileSync(path.join(__dirname, "../public/export-client.js"), "utf8");
    assert.match(html, /id="export-elapsed"/);
    assert.match(client, /every\(paint, 1000\)/);
    assert.match(app, /createExportClock\(\{\s*onTick: paintExportElapsedLabel/);
    assert.match(app, /withExportDone\(lines, doneMs\)/);
    const show = app.slice(app.indexOf("function showExportProgress"), app.indexOf("function beginExportProgress"));
    assert.equal(/getElementById\("export-elapsed"\)[^;]*textContent\s*=/.test(show), false);
    assert.match(show, /label\.textContent = "Exporting " \+ pct \+ "%"/);
    const copy = app.slice(app.indexOf("async function copyFinishedTerrain"), app.indexOf("function exportError"));
    assert.match(copy, /setCopyNote\("Copied\. Paste terrain separately in Hamina\."\)/);
    assert.equal(/setStatus\(/.test(copy), false);
    assert.equal(/status-line|status-body|status-more|withExportDone|export-elapsed/.test(copy), false);
  });
});
