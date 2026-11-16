"use strict";

/**
 * Pack Overture transportation and base row-group bboxes into
 * netlify/lib/overture-street-rg-data.js, same OVR1 layout as the buildings
 * index. Input is the JSON footer scans (files[].file, files[].groups).
 *
 *   node scripts/pack-overture-street-index.js /path/to/index-dir
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const RELEASE = require("../netlify/lib/overture").RELEASE;

const THEMES = [
  { key: "infrastructure", file: "index-base-infrastructure.json" },
  { key: "water", file: "index-base-water.json" },
  { key: "land_use", file: "index-base-land_use.json" },
  { key: "land", file: "index-base-land.json" },
  { key: "segment", file: "index-transportation-segment.json" },
];

function packTheme(json, releaseName) {
  const files = (json.files || []).map((f) => f.file);
  const groups = [];
  for (let fi = 0; fi < (json.files || []).length; fi++) {
    const rows = (json.files[fi].groups || []).slice().sort((a, b) => (a.i | 0) - (b.i | 0));
    let rowStart = 0;
    for (const g of rows) {
      const n = g.rowCount | 0;
      const start = g.rowStart != null ? g.rowStart | 0 : rowStart;
      groups.push({
        fi,
        rowStart: start,
        rowCount: n,
        xmin: +g.xmin,
        ymin: +g.ymin,
        xmax: +g.xmax,
        ymax: +g.ymax,
      });
      rowStart = start + n;
    }
  }
  const release = Buffer.from(releaseName, "utf8");
  const nameBufs = files.map((f) => Buffer.from(f, "utf8"));
  let size = 4 + 2 + 2 + 4 + 2 + release.length;
  for (const n of nameBufs) size += 2 + n.length;
  size += groups.length * 26;
  const buf = Buffer.alloc(size);
  let o = 0;
  buf.write("OVR1", o, "ascii");
  o += 4;
  buf.writeUInt16LE(1, o);
  o += 2;
  buf.writeUInt16LE(files.length, o);
  o += 2;
  buf.writeUInt32LE(groups.length, o);
  o += 4;
  buf.writeUInt16LE(release.length, o);
  o += 2;
  release.copy(buf, o);
  o += release.length;
  for (const n of nameBufs) {
    buf.writeUInt16LE(n.length, o);
    o += 2;
    n.copy(buf, o);
    o += n.length;
  }
  for (const g of groups) {
    buf.writeUInt16LE(g.fi, o);
    o += 2;
    buf.writeUInt32LE(g.rowStart, o);
    o += 4;
    buf.writeUInt32LE(g.rowCount, o);
    o += 4;
    buf.writeFloatLE(g.xmin, o);
    o += 4;
    buf.writeFloatLE(g.ymin, o);
    o += 4;
    buf.writeFloatLE(g.xmax, o);
    o += 4;
    buf.writeFloatLE(g.ymax, o);
    o += 4;
  }
  if (o !== size) throw new Error("pack size " + o + " != " + size);
  return { files: files.length, groups: groups.length, b64: zlib.gzipSync(buf, { level: 9 }).toString("base64") };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/pack-overture-street-index.js <index-dir>");
    process.exit(1);
  }
  const packed = { release: RELEASE };
  const stats = {};
  for (const t of THEMES) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, t.file), "utf8"));
    const got = packTheme(json, RELEASE);
    packed[t.key] = got.b64;
    stats[t.key] = { files: got.files, groups: got.groups, b64: got.b64.length };
  }
  const out = path.join(__dirname, "..", "netlify", "lib", "overture-street-rg-data.js");
  const js =
    '"use strict";\n' +
    "// Generated Overture transportation and base row-group index, release " +
    RELEASE +
    ". Do not edit.\n" +
    "module.exports = " +
    JSON.stringify(packed) +
    ";\n";
  fs.writeFileSync(out, js);
  console.log(JSON.stringify({ out, js: js.length, stats }, null, 2));
}

if (require.main === module) main();

module.exports = { packTheme, THEMES };
