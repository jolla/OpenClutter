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
const MAX_GROUPS_LARGE = 12;
const LARGE_GROUP_SIDE_M = 2500;
// Same bound as the Microsoft tile. A 10 km box can match tens of thousands
// of Overture roofs, and keeping all of them alongside that tile exhausts
// the background function before a zip is written.
const FOOTPRINT_KEEP = 4000;
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

function groupsForBbox(west, south, east, north, maxGroups) {
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
  const cap = maxGroups > 0 ? maxGroups | 0 : MAX_GROUPS;
  const ordered = orderGroups(hits, bbox);
  if (ordered.length <= cap) return ordered;
  const lon = (bbox.west + bbox.east) / 2;
  const lat = (bbox.south + bbox.north) / 2;
  const center = [];
  const rest = [];
  for (const g of ordered) {
    if (groupContainsPoint(g, lon, lat)) center.push(g);
    else rest.push(g);
  }
  rest.sort((a, b) => groupArea(a) - groupArea(b));
  return orderGroups(center.concat(rest).slice(0, cap), bbox);
}

function spanSideM(bbox) {
  const lat = (+bbox.south + +bbox.north) / 2;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const widthM = Math.abs(+bbox.east - +bbox.west) * mLon;
  const lengthM = Math.abs(+bbox.north - +bbox.south) * 110540;
  return Math.max(widthM, lengthM);
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
  // Roof fields describe a recorded shape. min_height is the bottom of a
  // floating volume, not the low side of a sloping roof, so it is not copied.
  const roofShape = typeof row.roof_shape === "string" ? row.roof_shape.trim() : "";
  if (roofShape) properties.roofShape = roofShape;
  if (row.roof_direction !== null && row.roof_direction !== undefined && row.roof_direction !== "") {
    const roofDir = Number(row.roof_direction);
    if (Number.isFinite(roofDir)) properties.roofDirection = roofDir;
  }
  const roofH = Number(row.roof_height);
  if (roofH > 0 && roofH < 400) properties.roofHeight = roofH;
  // class and subtype stay off this column list. A missing parquet field
  // fails the Vegas group. A footprint that already has class or subtype
  // "parking" is recolored as a parking structure instead.
  return { type: "Feature", properties, geometry };
}

function ringAreaAbs(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += +ring[j][0] * +ring[i][1] - +ring[i][0] * +ring[j][1];
  }
  return Math.abs(a);
}

function footprintScore(feature) {
  const geom = feature && feature.geometry;
  let area = 0;
  if (geom && geom.type === "Polygon" && geom.coordinates && geom.coordinates[0]) {
    area = ringAreaAbs(geom.coordinates[0]);
  } else if (geom && geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    for (let i = 0; i < polys.length; i++) {
      if (polys[i] && polys[i][0]) area += ringAreaAbs(polys[i][0]);
    }
  }
  const h = Number(feature && feature.properties && feature.properties.height);
  const height = h > 2 && h < 400 ? h : 0;
  return area * Math.max(1, height / 10);
}

function keepLargestFootprints(features, keep) {
  const n = keep | 0;
  if (!(n > 0) || features.length <= n) return features;
  const scored = new Array(features.length);
  for (let i = 0; i < features.length; i++) scored[i] = { f: features[i], s: footprintScore(features[i]) };
  scored.sort((a, b) => b.s - a.s);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = scored[i].f;
  return out;
}

function featuresFromRows(rows, bbox, keep) {
  const cap = keep > 0 ? keep | 0 : 0;
  const features = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const f = featureFromRow(list[i], bbox);
    if (!f) continue;
    features.push(f);
    if (cap && features.length >= cap * 2) {
      const kept = keepLargestFootprints(features, cap);
      features.length = 0;
      for (let k = 0; k < kept.length; k++) features.push(kept[k]);
    }
  }
  return cap ? keepLargestFootprints(features, cap) : features;
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
    columns: ["height", "num_floors", "bbox", "geometry", "is_underground", "roof_shape", "roof_direction", "roof_height"],
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
  const groupCap = spanSideM(bbox) > LARGE_GROUP_SIDE_M ? MAX_GROUPS_LARGE : MAX_GROUPS;
  const groups = groupsForBbox(bbox.west, bbox.south, bbox.east, bbox.north, groupCap);
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
      // not cancel a sibling that already parsed. A large draw reads a few
      // groups at a time and keeps the largest roofs, so the list cannot grow
      // to every building in the box.
      const large = spanSideM(bbox) > LARGE_GROUP_SIDE_M;
      const readOne = async (g) => {
        if (signal.aborted) return "abort";
        try {
          const rows = await readGroupRows(reader, source, g, rowFilter, signal);
          return featuresFromRows(rows, filterBox, large ? FOOTPRINT_KEEP : 0);
        } catch (e) {
          if (signal.aborted || isAbortError(e)) return "abort";
          throw e;
        }
      };
      const accept = (chunk) => {
        if (chunk === "abort") {
          partial = true;
          return;
        }
        for (let i = 0; i < chunk.length; i++) features.push(chunk[i]);
        if (large && features.length > FOOTPRINT_KEEP) {
          const kept = keepLargestFootprints(features, FOOTPRINT_KEEP);
          features.length = 0;
          for (let i = 0; i < kept.length; i++) features.push(kept[i]);
        }
        groupsRead++;
      };
      if (large) {
        let cursor = 0;
        const workers = Math.min(3, gs.length);
        const jobs = [];
        for (let w = 0; w < workers; w++) {
          jobs.push((async () => {
            while (!partial) {
              const i = cursor++;
              if (i >= gs.length) return;
              accept(await readOne(gs[i]));
            }
          })());
        }
        await Promise.all(jobs);
      } else {
        const results = await Promise.all(gs.map(readOne));
        for (let i = 0; i < results.length; i++) accept(results[i]);
      }
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
  MAX_GROUPS_LARGE,
  groupsForBbox,
  orderGroups,
  bboxRowFilter,
  featureFromRow,
  featuresFromRows,
  fetchOvertureFootprints,
};
