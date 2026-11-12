"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

describe("search box speed hooks", () => {
  it("debounces suggestions, aborts a stale request, and caches hits", () => {
    assert.match(src, /function abortSuggest\(/);
    assert.match(src, /searchInput\.addEventListener\("input", \(\) => \{\n  abortSuggest\(\);/);
    assert.match(src, /new AbortController\(\)/);
    assert.match(src, /signal: ac\.signal/);
    assert.match(src, /err && err\.name === "AbortError"/);
    assert.match(src, /, 200\);/);
    assert.match(src, /readSearchCache\(suggestCache/);
    assert.match(src, /writeSearchCache\(suggestCache/);
    assert.match(src, /readSearchCache\(geocodeCache/);
    assert.match(src, /writeSearchCache\(geocodeCache/);
  });

  it("aborts a pending suggestion on Enter and never writes an empty list to the cache", () => {
    const run = src.slice(src.indexOf("async function runSearch"), src.indexOf("function pickSuggestion"));
    assert.match(run, /abortSuggest\(\)/);
    const write = src.slice(src.indexOf("function writeSearchCache"), src.indexOf("function abortSuggest"));
    assert.match(write, /if \(!list \|\| !list\.length\) return;/);
  });
});
