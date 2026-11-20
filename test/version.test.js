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
  it("is 1.3.48 in package.json", () => {
    assert.equal(pkg.version, "1.3.48");
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

  it("shows a release date on the page and keeps the version for support", () => {
    const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
    const versionJs = fs.readFileSync(path.join(root, "public/version.js"), "utf8");
    const date = pkg.releaseDate;
    assert.equal(typeof date, "string");
    assert.match(date, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    assert.match(html, new RegExp(`id="app-version"[^>]*>Updated ${date}<`));
    assert.match(html, new RegExp(`id="app-version"[^>]*title="What's new · ${pkg.version}"`));
    assert.match(html, new RegExp(`id="app-version"[^>]*aria-label="What's new · ${pkg.version}"`));
    assert.match(html, /<button type="button" id="app-version"/);
    assert.match(html, /id="whats-new"/);
    assert.match(html, /id="whats-new-title">What's new</);
    assert.match(html, />Nov 23, 2026</);
    assert.equal(/What's new in 1\./.test(html), false);
    assert.match(html, /Trees with rounded crowns and trunks, plus forest stands/);
    assert.match(html, /Larger, more detailed exports for big sites/);
    assert.equal(/\u2014/.test(html), false);
    assert.match(html, /src="\/version\.js"/);
    assert.equal(
      versionJs,
      `window.OPENCLUTTER_VERSION = ${JSON.stringify(pkg.version)};\nwindow.OPENCLUTTER_RELEASE_DATE = ${JSON.stringify(date)};\n`
    );
  });
});
