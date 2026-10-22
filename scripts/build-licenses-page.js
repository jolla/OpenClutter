"use strict";

/** Writes public/licenses.html from netlify/lib/data-credits.js. Run after editing credits. */
const fs = require("node:fs");
const path = require("node:path");
const { SOURCES, ODBL_NOTICE, ESRI_POWERED, ESRI_SOURCE } = require("../netlify/lib/data-credits");
const { NAIP, NATIONAL } = require("../netlify/lib/imagery-source");

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const link = (u) => `<a href="${esc(u)}" rel="noopener noreferrer">${esc(u.replace(/^https:\/\//, ""))}</a>`;

const rows = SOURCES.map(
  (s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.role)}</td><td>${esc(s.credit)}</td><td>${esc(s.license)}</td><td>${link(s.url)}</td></tr>`
).join("\n      ");
const imagery = [
  `<li><strong>Esri World Imagery</strong> (draw map, and the export image when Esri is the source): ${esc(ESRI_POWERED)}. ${esc(ESRI_SOURCE)}. Esri terms of use.</li>`,
  `<li><strong>${esc(NAIP.name)}</strong>: ${esc(NAIP.attribution)}. ${esc(NAIP.license)}.</li>`,
]
  .concat(NATIONAL.map((n) => `<li><strong>${esc(n.name)}</strong>: ${esc(n.attribution)}. ${esc(n.license)}.</li>`))
  .join("\n      ");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClutter data licenses</title>
  <style>
    body { margin: 0 auto; max-width: 1100px; padding: 24px; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0e1116; color: #e8eaed; }
    a { color: #58a6ff; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #30363d; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #161b22; }
  </style>
</head>
<body>
  <h1>Data licenses</h1>
  <p>OpenClutter's code is MIT licensed. The MIT license covers the code only. Map images, vectors, heights, and test fixtures keep the license of their source, listed here. Every export zip carries the same list in ATTRIBUTION.txt.</p>
  <h2>Open Database License</h2>
  <p>${esc(ODBL_NOTICE)}</p>
  <h2>Map images</h2>
  <ul>
      ${imagery}
  </ul>
  <p>Each zip names the image it shipped, with the capture date when the source publishes one.</p>
  <h2>Data sources</h2>
  <table>
    <thead><tr><th>Source</th><th>Used for</th><th>Credit</th><th>License</th><th>Terms</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <h2>Place search</h2>
  <p>Search results (c) OpenStreetMap contributors, via Photon (komoot) and Nominatim (OpenStreetMap Foundation), ODbL 1.0.</p>
  <h2>Software</h2>
  <p>Leaflet (BSD-2-Clause). <a href="https://github.com/jolla/OpenClutter">OpenClutter source</a> (MIT, code only).</p>
  <p><a href="/">Back to OpenClutter</a></p>
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, "..", "public", "licenses.html"), html);
console.log("wrote public/licenses.html");
