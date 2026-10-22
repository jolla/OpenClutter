"use strict";

/**
 * Local-only Esri World Imagery crops for the Esri-calibrated detector tests,
 * written to test/fixtures-esri/ (gitignored, never committed). Crops that
 * were in the repo before v1.2.11 are read back from that commit so the
 * pixels match the calibration exactly; any other crop is exported from
 * Esri on the fixture's extent and pixel size.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { jpegSize } = require("../netlify/lib/geo-frame");

const ROOT = path.join(__dirname, "..");
const FIX = path.join(ROOT, "test", "fixtures");
const OUT = path.join(ROOT, "test", "fixtures-esri");
const LAST_ESRI_COMMIT = "fa07a9b";

function fromHistory(rel) {
  try {
    return execFileSync("git", ["show", LAST_ESRI_COMMIT + ":test/fixtures/" + rel], { cwd: ROOT, maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

async function fromEsri(rel, ext) {
  const naip = fs.readFileSync(path.join(FIX, rel));
  const { width, height } = jpegSize(naip);
  const url =
    "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?f=image&format=jpg" +
    `&bbox=${ext.west},${ext.south},${ext.east},${ext.north}&bboxSR=4326&imageSR=4326&size=${width},${height}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(rel + " HTTP " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const jobs = [];
  for (const id of JSON.parse(fs.readFileSync(path.join(FIX, "sites.json"), "utf8")).sites.map((s) => s.id)) {
    const meta = JSON.parse(fs.readFileSync(path.join(FIX, id, "imagery-meta.json"), "utf8"));
    const e = meta.extent;
    jobs.push([id + "/imagery.jpg", { west: e.xmin, south: e.ymin, east: e.xmax, north: e.ymax }]);
  }
  for (const s of JSON.parse(fs.readFileSync(path.join(FIX, "structure-sites", "sites.json"), "utf8"))) {
    jobs.push(["structure-sites/" + s.id + ".jpg", s.bbox]);
  }
  for (const [rel, ext] of jobs) {
    const buf = fromHistory(rel) || (await fromEsri(rel, ext));
    fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
    fs.writeFileSync(path.join(OUT, rel), buf);
    console.log(rel, buf.length);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
