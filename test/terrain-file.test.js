"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

describe("terrain paste as a file (Copy terrain fallback)", () => {
  it("has a Terrain JSON link beside Download again", () => {
    assert.match(
      html,
      /<p id="redownload-row" class="hint" hidden><a id="redownload" href="#"><\/a><span id="terrain-file-sep" hidden> · <\/span><a id="terrain-file" href="#" hidden>Terrain JSON<\/a><\/p>/
    );
  });

  it("saves the same JSON Copy terrain puts on the clipboard", () => {
    const fn = app.slice(app.indexOf("function downloadTerrainFile()"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /new Blob\(\[terrainPasteJson\], \{ type: "application\/json" \}\)/);
    assert.match(app, /document\.getElementById\("terrain-file"\)\.addEventListener\("click"/);
  });

  it("names the file after the zip", () => {
    assert.match(app, /return \(base \|\| "openclutter"\) \+ "-terrain\.json";/);
  });

  it("points to the file when the clipboard refuses", () => {
    assert.match(app, /Could not copy terrain\. Allow clipboard access and try again, or use Terrain JSON\./);
  });

  it("shows the result before the zip download in a background export", () => {
    const start = app.indexOf("const data = await pollExport(queued.jobId);");
    assert.ok(start > 0);
    const block = app.slice(start, app.indexOf("return;", start));
    const shown = block.indexOf("showExportResult(data");
    const kept = block.indexOf("rememberExport(rec)");
    const zip = block.indexOf("await downloadJobZip(");
    assert.ok(shown > 0 && kept > shown && zip > kept, "terrain and job kept before the download");
  });

  it("does not put the terrain JSON in the zip", () => {
    const zipWriters = fs
      .readdirSync(path.join(root, "netlify", "lib"))
      .map((f) => fs.readFileSync(path.join(root, "netlify", "lib", f), "utf8"))
      .join("\n");
    assert.equal(/-terrain\.json/.test(zipWriters), false);
  });
});
