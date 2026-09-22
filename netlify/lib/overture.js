"use strict";

/**
 * Overture Maps buildings (release 2026-08-19.0), free Azure GeoParquet.
 *
 * The theme is ~277 GB across 512 files. A committed row-group bbox index
 * (parquet footer stats) selects the one or two groups that cover the export
 * bbox; hyparquet range-reads height, num_floors, and geometry for those
 * groups only. OSM ways are not fetched. Rings still go through the OpenIntent
 * validator in pipeline.js.
 */

const zlib = require("node:zlib");
const { FLOOR_HEIGHT_M } = require("./conflate");

const RELEASE = "2026-08-19.0";
const AZURE_PREFIX =
  "https://overturemapswestus2.blob.core.windows.net/release/" +
  RELEASE +
  "/theme=buildings/type=building/";
const GROUP_STRIDE = 26;
const MAX_GROUPS = 4;
const QUERY_PAD_DEG = 0.002;

let cached = null;

function parsedIndex() {
  if (cached) return cached;
  const b64 = require("./overture-rg-data");
  const buf = zlib.gunzipSync(Buffer.from(b64, "base64"));
  if (buf.toString("ascii", 0, 4) !== "OVR1") throw new Error("bad overture index");
  let o = 4;
  const version = buf.readUInt16LE(o);
  o += 2;
  if (version !== 1) throw new Error("overture index version " + version);
  const fileCount = buf.readUInt16LE(o);
  o += 2;
  const groupCount = buf.readUInt32LE(o);
  o += 4;
  const relLen = buf.readUInt16LE(o);
  o += 2;
  const release = buf.toString("utf8", o, o + relLen);
  o += relLen;
  const files = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) {
    const n = buf.readUInt16LE(o);
    o += 2;
    files[i] = buf.toString("utf8", o, o + n);
    o += n;
  }
  cached = { buf, files, groupStart: o, groupCount, release };
  return cached;
}

function groupArea(g) {
  return Math.max(0, g.xmax - g.xmin) * Math.max(0, g.ymax - g.ymin);
}

function groupsForBbox(west, south, east, north) {
  const idx = parsedIndex();
  const w = +west - QUERY_PAD_DEG;
  const s = +south - QUERY_PAD_DEG;
  const e = +east + QUERY_PAD_DEG;
  const n = +north + QUERY_PAD_DEG;
  const hits = [];
  const { buf, files, groupStart, groupCount } = idx;
  for (let i = 0; i < groupCount; i++) {
    const p = groupStart + i * GROUP_STRIDE;
    const xmin = buf.readFloatLE(p + 10);
    const ymin = buf.readFloatLE(p + 14);
    const xmax = buf.readFloatLE(p + 18);
    const ymax = buf.readFloatLE(p + 22);
    if (xmax < w || xmin > e || ymax < s || ymin > n) continue;
    hits.push({
      file: files[buf.readUInt16LE(p)],
      rowStart: buf.readUInt32LE(p + 2),
      rowCount: buf.readUInt32LE(p + 6),
      xmin,
      ymin,
      xmax,
      ymax,
    });
  }
  if (hits.length <= MAX_GROUPS) return hits;
  hits.sort((a, b) => groupArea(a) - groupArea(b));
  return hits.slice(0, MAX_GROUPS);
}

function asGeometry(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value.type !== "Polygon" && value.type !== "MultiPolygon") return null;
  if (!value.coordinates) return null;
  return value;
}

function featureFromRow(row, bbox) {
  if (!row) return null;
  const b = row.bbox;
  if (bbox && b) {
    if (b.xmax < bbox.west || b.xmin > bbox.east || b.ymax < bbox.south || b.ymin > bbox.north) return null;
  }
  if (row.is_underground === true) return null;
  const geometry = asGeometry(row.geometry);
  if (!geometry) return null;
  const measured = Number(row.height);
  const floors = Number(row.num_floors);
  const properties = { geomSource: "overture" };
  if (measured > 2 && measured < 400) {
    properties.height = measured;
    properties.heightSource = "overture";
  } else if (floors >= 1 && floors <= 60) {
    const est = floors * FLOOR_HEIGHT_M;
    if (est > 2 && est < 400) {
      properties.height = est;
      properties.heightSource = "overture-floors";
      properties.numFloors = floors;
    }
  }
  return { type: "Feature", properties, geometry };
}

function featuresFromRows(rows, bbox) {
  const features = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const f = featureFromRow(list[i], bbox);
    if (f) features.push(f);
  }
  return features;
}

function failAborted() {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "AbortError";
  return err;
}

function loadReader() {
  const hp = require("hyparquet");
  const comp = require("hyparquet-compressors");
  return {
    asyncBufferFromUrl: hp.asyncBufferFromUrl,
    parquetReadObjects: hp.parquetReadObjects,
    compressors: comp.compressors,
  };
}

async function fetchOvertureFootprints(frame, opts) {
  const bbox = {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
  };
  const groups = groupsForBbox(bbox.west, bbox.south, bbox.east, bbox.north);
  if (!groups.length) return { features: [], rowGroups: 0, release: RELEASE };
  const { asyncBufferFromUrl, parquetReadObjects, compressors } = loadReader();
  const byFile = new Map();
  for (const g of groups) {
    if (!byFile.has(g.file)) byFile.set(g.file, []);
    byFile.get(g.file).push(g);
  }
  const features = [];
  for (const [file, gs] of byFile) {
    const url = AZURE_PREFIX + file;
    const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
    if (signal.aborted) throw failAborted();
    const source = await asyncBufferFromUrl({
      url,
      requestInit: { signal },
    });
    gs.sort((a, b) => a.rowStart - b.rowStart);
    for (const g of gs) {
      if (signal.aborted) throw failAborted();
      const rows = await parquetReadObjects({
        file: source,
        compressors,
        columns: ["height", "num_floors", "bbox", "geometry", "is_underground"],
        rowStart: g.rowStart,
        rowEnd: g.rowStart + g.rowCount,
      });
      const chunk = featuresFromRows(rows, bbox);
      for (const f of chunk) features.push(f);
    }
  }
  return { features, rowGroups: groups.length, release: RELEASE };
}

module.exports = {
  RELEASE,
  AZURE_PREFIX,
  GROUP_STRIDE,
  MAX_GROUPS,
  groupsForBbox,
  featureFromRow,
  featuresFromRows,
  fetchOvertureFootprints,
};
