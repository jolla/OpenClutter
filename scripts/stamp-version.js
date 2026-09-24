"use strict";

// Writes the browser-visible version from package.json.
// Netlify runs this before publish. Commit the result so the repo matches the deploy.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("unexpected package.json version: " + version);
  process.exit(1);
}

const versionJs = `window.OPENCLUTTER_VERSION = ${JSON.stringify(version)};\n`;
fs.writeFileSync(path.join(root, "public", "version.js"), versionJs);

const htmlPath = path.join(root, "public", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const next = html.replace(
  /(<span id="app-version">)v[^<]*(<\/span>)/,
  `$1v${version}$2`
);
if (!next.includes(`<span id="app-version">v${version}</span>`)) {
  console.error("index.html is missing #app-version");
  process.exit(1);
}
fs.writeFileSync(htmlPath, next);
console.log("stamped v" + version);
