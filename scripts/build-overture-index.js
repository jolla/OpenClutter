"use strict";

/**
 * Pack Overture buildings row-group bboxes into netlify/lib/overture-rg-data.js.
 *
 * Input CSV columns: file_name,row_group_id,nrows,xmin,xmax,ymin,ymax
 * Produced from DuckDB parquet_metadata on
 * s3://overturemaps-us-west-2/release/2026-08-19.0/theme=buildings/type=building/*.parquet
 * (footer stats only). The runtime reader is netlify/lib/overture.js.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const RELEASE = "2026-08-19.0";

function pack(csvPath, outPath) {
  const text = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  const header = text[0].split(",");
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const byFile = new Map();
  for (let i = 1; i < text.length; i++) {
    const c = text[i].split(",");
    const base = c[col.file_name].split("/").pop();
    if (!byFile.has(base)) byFile.set(base, []);
    byFile.get(base).push({
      id: +c[col.row_group_id],
      n: +c[col.nrows],
      xmin: +c[col.xmin],
      xmax: +c[col.xmax],
      ymin: +c[col.ymin],
      ymax: +c[col.ymax],
    });
  }
  const files = [...byFile.keys()].sort();
  const groups = [];
  for (let fi = 0; fi < files.length; fi++) {
    const rows = byFile.get(files[fi]).sort((a, b) => a.id - b.id);
    let rowStart = 0;
    for (const g of rows) {
      groups.push({ fi, rowStart, rowCount: g.n, xmin: g.xmin, ymin: g.ymin, xmax: g.xmax, ymax: g.ymax });
      rowStart += g.n;
    }
  }
  const release = Buffer.from(RELEASE, "utf8");
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
  const gz = zlib.gzipSync(buf, { level: 9 });
  const b64 = gz.toString("base64");
  const js =
    '"use strict";\n' +
    "// Generated Overture buildings row-group index, release " +
    RELEASE +
    ". Do not edit.\n" +
    "module.exports = " +
    JSON.stringify(b64) +
    ";\n";
  fs.writeFileSync(outPath, js);
  return { files: files.length, groups: groups.length, gz: gz.length, js: js.length };
}

if (require.main === module) {
  const csv = process.argv[2];
  const out = process.argv[3] || path.join(__dirname, "..", "netlify", "lib", "overture-rg-data.js");
  if (!csv) {
    console.error("usage: node scripts/build-overture-index.js rg.csv [out.js]");
    process.exit(1);
  }
  console.log(pack(csv, out));
}

module.exports = { pack, RELEASE };
