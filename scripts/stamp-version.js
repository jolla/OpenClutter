"use strict";

// Writes the browser-visible release date and the internal version from
// package.json. Netlify runs this before publish. Commit the result so the
// repo matches the deploy.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const version = pkg.version;
const releaseDate = pkg.releaseDate;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("unexpected package.json version: " + version);
  process.exit(1);
}
if (!releaseDate || !/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(releaseDate)) {
  console.error("unexpected package.json releaseDate: " + releaseDate);
  process.exit(1);
}

const label = "Updated " + releaseDate;
const tip = "What's new · " + version;

const versionJs =
  `window.OPENCLUTTER_VERSION = ${JSON.stringify(version)};\n` +
  `window.OPENCLUTTER_RELEASE_DATE = ${JSON.stringify(releaseDate)};\n`;
fs.writeFileSync(path.join(root, "public", "version.js"), versionJs);

const htmlPath = path.join(root, "public", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const buttonRe = /<button type="button" id="app-version"[^>]*>[^<]*<\/button>/;
if (!buttonRe.test(html)) {
  console.error("index.html is missing #app-version");
  process.exit(1);
}
const button =
  `<button type="button" id="app-version" aria-expanded="false" aria-controls="whats-new" title="${tip}" aria-label="${tip}">${label}</button>`;
const next = html.replace(buttonRe, button);
if (!next.includes(`>${label}<`) || !next.includes(`title="${tip}"`)) {
  console.error("index.html is missing #app-version stamp");
  process.exit(1);
}
fs.writeFileSync(htmlPath, next);
console.log("stamped " + label + " (" + version + ")");
