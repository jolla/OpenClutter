"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");

describe("hamina preview", () => {
  it("draws an oblique view with a tall tree and a flat one", () => {
    const script = path.join(__dirname, "..", "scripts", "hamina_preview.py");
    const out = execFileSync("python3", [script, "--self-test"], { encoding: "utf8" });
    assert.match(out, /self-test ok/);
    assert.match(out, /"flatTrees": 1/);
    assert.match(out, /"floatingTrees": 0/);
  });
});
