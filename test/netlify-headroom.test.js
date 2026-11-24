"use strict";

// 1.3.97: world cover on the 1 GB Netlify function. Roomy hosts (Fly,
// the benches) are unchanged: the heavy-source queue is off there.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

describe("world cover on a small host (1.3.97)", () => {
  it("does not wait in the heavy-source queue", () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    const lines = src.split("\n").filter((l) => /fetchWorldCoverImpl\(/.test(l));
    assert.ok(lines.length >= 1);
    for (const l of lines) assert.doesNotMatch(l, /oneHeavySource/);
  });
});
