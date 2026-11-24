"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

describe("export zip place fields on the page", () => {
  it("sends a picked search result or reverse label with the export, not typed-only text", () => {
    assert.match(src, /function exportPlaceFields\(\)/);
    assert.match(src, /out\.pickedPlace = \{/);
    assert.match(src, /\.\.\.exportPlaceFields\(\)/);
    assert.match(src, /function pickSuggestion\(s\) \{\n  searchTyped = true;\n  searchInput\.value = s\.text \|\| s\.label;\n  lastPickedPlace = \{/);
    assert.match(src, /lastReversePlace = \{\n      name:/);
    assert.match(src, /boxContainsPoint\(bbox, lastPickedPlace\.lat, lastPickedPlace\.lon\)/);
  });

  it("downloads the zip under the server-supplied name", () => {
    assert.match(src, /downloadBlob\(shortBlob, data\.zipFilename \|\| "openintent\.zip"\)/);
    assert.match(src, /downloadJobZip\(queued\.jobId, data\.zipFilename\)/);
  });
});
