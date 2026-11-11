"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

describe("search box auto-fill hooks", () => {
  it("fills from /api/reverse through guardedFetch and never sets status", () => {
    assert.match(src, /function scheduleAreaName\(/);
    assert.match(src, /async function fillAreaName\(/);
    assert.match(src, /OpenClutterNet\.guardedFetch\(/);
    assert.match(src, /\/api\/reverse\?/);
    const fill = src.slice(src.indexOf("async function fillAreaName"), src.indexOf("function closeSuggest"));
    assert.match(fill, /guardedFetch/);
    assert.doesNotMatch(fill, /setStatus\(/);
    assert.match(fill, /searchTyped/);
    assert.match(fill, /lastAutoName/);
  });

  it("resets the typed window on a new draw and debounces move and resize", () => {
    const apply = src.slice(src.indexOf("function applyExtent"), src.indexOf("function checkExportPost"));
    assert.match(apply, /scheduleAreaName\(true\)/);
    const resize = src.slice(src.indexOf("function paintResizedRect"), src.indexOf("function selectionBearing"));
    assert.match(resize, /scheduleAreaName\(false\)/);
    assert.match(src, /const delay = resetTyped \? 0 : 500/);
    assert.match(src, /function cancelAreaName\(/);
    const clear = src.slice(src.indexOf("function clearFinishedShape"), src.indexOf("function commitBox"));
    assert.match(clear, /cancelAreaName\(\)/);
  });

  it("treats typing, a suggestion pick, and submit as user-typed text", () => {
    assert.match(src, /searchInput\.addEventListener\("input", \(\) => \{\n  searchTyped = true;/);
    assert.match(src, /function pickSuggestion\(s\) \{\n  searchTyped = true;/);
    assert.match(src, /searchTyped = true;\n  runSearch\(/);
  });
});
