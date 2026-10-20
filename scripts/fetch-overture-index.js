"use strict";

/**
 * Rebuild netlify/lib/overture-rg-data.js for an Overture release.
 *
 * Overture removes old releases from Azure. When the pinned release is gone,
 * every Overture read is a 404 and roofs that only Overture carries (the Las
 * Vegas Sphere and other landmark rings) leave the export. This reads the
 * parquet footers (row-group bbox stats only, no rows) of every buildings
 * file in a release and packs the same index build-overture-index.js packs
 * from a DuckDB CSV.
 *
 *   node scripts/fetch-overture-index.js            newest release on Azure
 *   node scripts/fetch-overture-index.js 2026-09-23.1
 *
 * Then set RELEASE in netlify/lib/overture.js to the printed release.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pack } = require("./build-overture-index");

const CONTAINER = "https://overturemapswestus2.blob.core.windows.net/release";
const THEME = "theme=buildings/type=building/";

async function listXml(params) {
  const res = await fetch(CONTAINER + "?restype=container&comp=list&" + params);
  if (!res.ok) throw new Error("list " + res.status);
  return res.text();
}

async function releasesWithBuildings() {
  const xml = await listXml("delimiter=/");
  const names = [...xml.matchAll(/<Name>([^<]+)\/<\/Name>/g)].map((m) => m[1]).sort();
  const live = [];
  for (const r of names) {
    const files = await buildingFiles(r);
    if (files.length) live.push(r);
  }
  return live;
}

async function buildingFiles(release) {
  const out = [];
  let marker = "";
  for (;;) {
    const xml = await listXml(
      "prefix=" + encodeURIComponent(release + "/" + THEME) + (marker ? "&marker=" + encodeURIComponent(marker) : "")
    );
    for (const m of xml.matchAll(/<Name>([^<]+\.parquet)<\/Name>/g)) out.push(m[1].split("/").pop());
    const next = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml);
    if (!next || !next[1]) break;
    marker = next[1];
  }
  return out.sort();
}

function stat(rg, name, key) {
  const col = rg.columns.find((c) => c.meta_data.path_in_schema.join(".") === name);
  if (!col || !col.meta_data.statistics) throw new Error("no stats for " + name);
  const s = col.meta_data.statistics;
  const v = key === "min" ? (s.min_value !== undefined ? s.min_value : s.min) : s.max_value !== undefined ? s.max_value : s.max;
  return Number(v);
}

async function footerRows(release, file, hp) {
  const url = CONTAINER + "/" + release + "/" + THEME + file;
  for (let attempt = 0; ; attempt++) {
    try {
      const buf = await hp.asyncBufferFromUrl({ url });
      const meta = await hp.parquetMetadataAsync(buf);
      return meta.row_groups.map((rg, i) => [
        file,
        i,
        Number(rg.num_rows),
        stat(rg, "bbox.xmin", "min"),
        stat(rg, "bbox.xmax", "max"),
        stat(rg, "bbox.ymin", "min"),
        stat(rg, "bbox.ymax", "max"),
      ]);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

async function main() {
  const hp = await import("hyparquet");
  let release = process.argv[2];
  if (!release) {
    const live = await releasesWithBuildings();
    if (!live.length) throw new Error("no Overture release with buildings on Azure");
    release = live[live.length - 1];
  }
  const files = await buildingFiles(release);
  if (!files.length) throw new Error("release " + release + " has no buildings files");
  const rows = [];
  let cursor = 0;
  let done = 0;
  const work = async () => {
    while (cursor < files.length) {
      const f = files[cursor++];
      rows.push(...(await footerRows(release, f, hp)));
      done++;
      if (done % 64 === 0) console.error(done + "/" + files.length);
    }
  };
  await Promise.all(Array.from({ length: 16 }, work));
  const csv = ["file_name,row_group_id,nrows,xmin,xmax,ymin,ymax", ...rows.map((r) => r.join(","))].join("\n");
  const tmp = path.join(os.tmpdir(), "overture-rg-" + release + ".csv");
  fs.writeFileSync(tmp, csv);
  const out = path.join(__dirname, "..", "netlify", "lib", "overture-rg-data.js");
  console.log(JSON.stringify({ release, ...pack(tmp, out, release) }));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
