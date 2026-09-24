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

function groupContainsPoint(g, lon, lat) {
  return g.xmin <= lon && lon <= g.xmax && g.ymin <= lat && lat <= g.ymax;
}

/**
 * Row groups that cover the site center are read first. A Las Vegas Sphere
 * bbox overlaps a southern neighbor group (lower rowStart, ymax just south of
 * the building) and the group that actually contains the ring. Sorting by
 * rowStart reads the empty neighbor first; if the abort lands on the second
 * group the Sphere is gone.
 */
function orderGroups(groups, bbox) {
  const lon = (+bbox.west + +bbox.east) / 2;
  const lat = (+bbox.south + +bbox.north) / 2;
  return (groups || []).slice().sort((a, b) => {
    const ca = groupContainsPoint(a, lon, lat) ? 0 : 1;
    const cb = groupContainsPoint(b, lon, lat) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const aa = groupArea(a);
    const ab = groupArea(b);
    if (aa !== ab) return aa - ab;
    return a.rowStart - b.rowStart;
  });
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
  const bbox = { west: +west, south: +south, east: +east, north: +north };
  const ordered = orderGroups(hits, bbox);
  if (ordered.length <= MAX_GROUPS) return ordered;
  const lon = (bbox.west + bbox.east) / 2;
  const lat = (bbox.south + bbox.north) / 2;
  const center = [];
  const rest = [];
  for (const g of ordered) {
    if (groupContainsPoint(g, lon, lat)) center.push(g);
    else rest.push(g);
  }
  rest.sort((a, b) => groupArea(a) - groupArea(b));
  return orderGroups(center.concat(rest).slice(0, MAX_GROUPS), bbox);
}

/** Struct bbox overlap. Page stats skip GeoParquet pages that miss the site. */
function bboxRowFilter(bbox) {
  return {
    $and: [
      { "bbox.xmax": { $gte: +bbox.west } },
      { "bbox.xmin": { $lte: +bbox.east } },
      { "bbox.ymax": { $gte: +bbox.south } },
      { "bbox.ymin": { $lte: +bbox.north } },
    ],
  };
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort|timeout/i.test(String(err.message || err));
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

async function readGroupRows(reader, source, group, filter, signal) {
  const base = {
    file: source,
    compressors: reader.compressors,
    columns: ["height", "num_floors", "bbox", "geometry", "is_underground"],
    rowStart: group.rowStart,
    rowEnd: group.rowStart + group.rowCount,
  };
  try {
    return await reader.parquetReadObjects({ ...base, filter, usePageIndex: true });
  } catch (e) {
    if (signal.aborted || isAbortError(e)) throw e;
    return reader.parquetReadObjects(base);
  }
}

async function fetchOvertureFootprints(frame, opts) {
  const bbox = {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
  };
  const filterBox = opts && opts.filter ? opts.filter : bbox;
  const groups = groupsForBbox(bbox.west, bbox.south, bbox.east, bbox.north);
  if (!groups.length) return { features: [], rowGroups: 0, groupsRead: 0, release: RELEASE };
  const reader = (opts && opts.reader) || loadReader();
  const byFile = new Map();
  for (const g of groups) {
    if (!byFile.has(g.file)) byFile.set(g.file, []);
    byFile.get(g.file).push(g);
  }
  const features = [];
  let groupsRead = 0;
  let partial = false;
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
  const rowFilter = bboxRowFilter(filterBox);
  try {
    for (const [file, gs] of byFile) {
      if (signal.aborted) {
        partial = true;
        break;
      }
      const url = AZURE_PREFIX + file;
      const source = await reader.asyncBufferFromUrl({
        url,
        requestInit: { signal },
      });
      // Same-file row groups in parallel. A south-heavy Vegas box reads the
      // southern neighbor first; waiting for it to finish before the Sphere
      // group is how a late abort drops the dome. A group that aborts does
      // not cancel a sibling that already parsed.
      const results = await Promise.all(
        gs.map(async (g) => {
          if (signal.aborted) return "abort";
          try {
            const rows = await readGroupRows(reader, source, g, rowFilter, signal);
            const chunk = featuresFromRows(rows, filterBox);
            for (const f of chunk) features.push(f);
            groupsRead++;
            return "ok";
          } catch (e) {
            if (signal.aborted || isAbortError(e)) return "abort";
            throw e;
          }
        })
      );
      if (results.some((r) => r === "abort")) partial = true;
    }
  } catch (e) {
    if (features.length && (signal.aborted || isAbortError(e))) {
      return { features, rowGroups: groups.length, groupsRead, release: RELEASE, partial: true };
    }
    throw e;
  }
  if ((partial || signal.aborted) && features.length) {
    return { features, rowGroups: groups.length, groupsRead, release: RELEASE, partial: true };
  }
  if (signal.aborted || partial) throw failAborted();
  return { features, rowGroups: groups.length, groupsRead, release: RELEASE };
}

module.exports = {
  RELEASE,
  AZURE_PREFIX,
  GROUP_STRIDE,
  MAX_GROUPS,
  groupsForBbox,
  orderGroups,
  bboxRowFilter,
  featureFromRow,
  featuresFromRows,
  fetchOvertureFootprints,
};
