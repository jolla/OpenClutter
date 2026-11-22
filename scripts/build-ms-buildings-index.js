"use strict";

/**
 * Rebuild netlify/lib/ms-buildings-index.txt.gz from Microsoft's free
 * dataset-links.csv (Global ML Building Footprints, quadkey zoom 9).
 *
 *   node scripts/build-ms-buildings-index.js [dataset-links.csv] [out.gz]
 *
 * Default release URL (pinned, matches the committed US tiles):
 *   https://bfppub.z5.web.core.windows.net/2026-07-24/dataset-links.csv
 *
 * The compact file is one row per CSV line: quadkey, Location, part filename.
 * URLs are rebuilt at runtime from the pinned release. Border quadkeys can
 * appear more than once (one file per region); the loader keeps every URL.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const DEFAULT_RELEASE = "2026-07-24";
const DEFAULT_URL =
  "https://bfppub.z5.web.core.windows.net/" + DEFAULT_RELEASE + "/dataset-links.csv";
const DEFAULT_OUT = path.join(ROOT, "netlify/lib/ms-buildings-index.txt.gz");

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split(",");
  const locI = header.indexOf("Location");
  const qkI = header.indexOf("QuadKey");
  const urlI = header.indexOf("Url");
  if (locI < 0 || qkI < 0 || urlI < 0) {
    throw new Error("dataset-links.csv: expected Location,QuadKey,Url columns");
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Location and QuadKey have no commas. The URL is the first https:// field.
    const https = line.indexOf("https://");
    if (https < 0) continue;
    const left = line.slice(0, https).split(",");
    const location = left[locI] && left[locI].trim();
    const quadkey = left[qkI] && left[qkI].trim();
    const rest = line.slice(https);
    const comma = rest.indexOf(",");
    const url = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    const part = url.split("/").pop();
    if (!location || !quadkey || !part) continue;
    rows.push({ location, quadkey, part });
  }
  return rows;
}

async function main() {
  const src = process.argv[2];
  const dest = path.resolve(process.argv[3] || DEFAULT_OUT);
  let text;
  let sourceLabel;
  if (src && !/^https?:/i.test(src)) {
    text = fs.readFileSync(path.resolve(src), "utf8");
    sourceLabel = path.resolve(src);
  } else {
    const url = src || DEFAULT_URL;
    sourceLabel = url;
    const res = await fetch(url);
    if (!res.ok) throw new Error("dataset-links HTTP " + res.status + " " + url);
    text = await res.text();
  }
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("no rows in " + sourceLabel);
  const release = /\/(\d{4}-\d{2}-\d{2})\//.exec(sourceLabel);
  const tag = (release && release[1]) || DEFAULT_RELEASE;
  const lines = [
    "# Microsoft Global ML Building Footprints index",
    "# release " + tag,
    "# source " + sourceLabel,
  ];
  for (const row of rows) {
    lines.push(row.quadkey + "\t" + row.location + "\t" + row.part);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8"), { level: 9 }));
  console.log("wrote " + dest + " (" + rows.length + " rows, release " + tag + ")");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
