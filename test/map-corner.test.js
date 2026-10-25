"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

describe("map corner under the panel", () => {
  it("creates the map without Leaflet's zoom buttons, which sat under the panel's rounded corner", () => {
    assert.match(app, /L\.map\("map", \{[^}]*zoomControl: false[^}]*\}\)/);
    assert.equal(/L\.control\.zoom\(/.test(app), false);
  });
});
