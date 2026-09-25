"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { version, userAgent } = require("../netlify/lib/version");
const { UA } = require("../netlify/functions/clutter");

const root = path.join(__dirname, "..");

describe("app version", () => {
  it("is 1.1.8 in package.json", () => {
    assert.equal(pkg.version, "1.1.8");
  });

  it("uses that version as the API user-agent", () => {
    assert.equal(version, pkg.version);
    assert.equal(userAgent, `openclutter/${pkg.version} (https://github.com/jolla/OpenClutter)`);
    assert.equal(UA, userAgent);
    const geocode = fs.readFileSync(path.join(root, "netlify/functions/geocode.js"), "utf8");
    const clutter = fs.readFileSync(path.join(root, "netlify/functions/clutter.js"), "utf8");
    assert.match(geocode, /require\("\.\.\/lib\/version"\)/);
    assert.match(clutter, /require\("\.\.\/lib\/version"\)/);
    assert.equal(geocode.includes("openclutter/0."), false);
    assert.equal(clutter.includes("openclutter/0."), false);
  });

  it("shows that version in the page from the package.json stamp", () => {
    const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
    const versionJs = fs.readFileSync(path.join(root, "public/version.js"), "utf8");
    assert.match(html, new RegExp(`<span id="app-version">v${pkg.version}</span>`));
    assert.match(html, /src="\/version\.js"/);
    assert.equal(versionJs.trim(), `window.OPENCLUTTER_VERSION = ${JSON.stringify(pkg.version)};`);
  });
});
