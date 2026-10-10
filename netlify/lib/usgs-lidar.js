"use strict";

/**
 * USGS 3DEP lidar for a dev-only export (?lidar=1).
 *
 * Points come from the public Entwine tiles on
 * s3://usgs-lidar-public (https://usgs.entwine.io). Each project is an EPT
 * octree of LAZ nodes. A draw reads classification 6 (building) and first
 * returns, binned to a few metres, and subtracts class-2 ground. That is the
 * nDSM. It sets a footprint height from the 90th percentile inside the ring,
 * and it adds a simplified polygon where building returns (or an nDSM over
 * 3 m that is not vegetation) cover more than 200 m² with no footprint.
 * High vegetation can update a tree height the same way.
 *
 * The background export cannot download a full 1 m cloud for a multi-km²
 * draw. Hierarchy counts pick the finest depth that stays inside the point,
 * byte, tile, and time caps. A finer grid would be a cached nDSM, not a
 * live read. Outside 3DEP the export continues and says so. Quebec open
 * lidar is not wired in.
 */

const { userAgent } = require("./version");

const HEIGHT_SOURCE = "usgs-lidar";
const EPT_BUCKET = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public";
const MERCATOR_R = 20037508.342789244;

/** Caps for one export. A Wynn-sized draw fits near 3 m; 1 m does not. */
const MAX_POINTS = 3600000;
const MAX_BYTES = 32 * 1024 * 1024;
const BYTES_PER_POINT = 8;
const MAX_TILES = 80;
const MAX_MS = 32000;
const MIN_SAMPLES = 6;
const MIN_ADDED_M2 = 200;
const NDSM_BUILDING_M = 3;
const CLASS6_MIN_M = 2;

let indexCache = null;

function loadIndex() {
  if (!indexCache) indexCache = require("./usgs-ept-index.json");
  return indexCache;
}

function projectYear(name) {
  const text = String(name || "");
  let best = 0;
  const years = text.match(/\d{4}/g);
  if (years) {
    for (let i = 0; i < years.length; i++) {
      const n = +years[i];
      if (n >= 2000 && n <= 2030 && n > best) best = n;
    }
  }
  const block = text.match(/[BD](\d{2})(?:_|\b)/);
  if (block) {
    const n = 2000 + +block[1];
    if (n >= 2000 && n <= 2030 && n > best) best = n;
  }
  return best;
}

function bboxArea(row) {
  return Math.max(0, row[3] - row[1]) * Math.max(0, row[4] - row[2]);
}

function centerOf(frame) {
  return [(+frame.west + +frame.east) / 2, (+frame.south + +frame.north) / 2];
}

/** Newest project whose published footprint contains the draw center, then the smallest. */
function rankProjects(frame, index) {
  const list = index || loadIndex();
  const c = centerOf(frame);
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (c[0] < row[1] || c[0] > row[3] || c[1] < row[2] || c[1] > row[4]) continue;
    hits.push(row);
  }
  hits.sort((a, b) => {
    const year = projectYear(b[0]) - projectYear(a[0]);
    if (year) return year;
    return bboxArea(a) - bboxArea(b);
  });
  return hits;
}

function inQuebec(frame) {
  const c = centerOf(frame);
  return c[0] >= -80 && c[0] <= -56.5 && c[1] >= 44.8 && c[1] <= 62.5;
}

function outsideNote(frame) {
  if (inQuebec(frame)) {
    return "USGS 3DEP lidar does not cover this draw, so building heights are unchanged. Quebec open lidar is not wired in yet.";
  }
  return "USGS 3DEP lidar does not cover this draw, so building heights are unchanged.";
}

function mercator(lon, lat) {
  const x = (lon * MERCATOR_R) / 180;
  const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * (MERCATOR_R / Math.PI);
  return [x, y];
}

function unmercator(x, y) {
  const lon = (x * 180) / MERCATOR_R;
  const lat = (Math.atan(Math.sinh((y * Math.PI) / MERCATOR_R)) * 180) / Math.PI;
  return [lon, lat];
}

function groundScale(lat) {
  return Math.cos((lat * Math.PI) / 180) || 1;
}

function km2Of(frame) {
  const lat = ((+frame.south) + (+frame.north)) / 2;
  const width = Math.abs(+frame.east - +frame.west) * 111.32 * Math.cos((lat * Math.PI) / 180);
  const height = Math.abs(+frame.north - +frame.south) * 110.54;
  return width * height;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi > lat === yj > lat) continue;
    const x = ((ring[j][0] - ring[i][0]) * (lat - yi)) / (yj - yi) + ring[i][0];
    if (lon < x) inside = !inside;
  }
  return inside;
}

function exteriorRings(feature) {
  const g = feature && feature.geometry;
  if (!g || !g.coordinates) return [];
  if (g.type === "Polygon") {
    const ring = g.coordinates[0];
    return ring && ring.length >= 4 ? [ring] : [];
  }
  if (g.type === "MultiPolygon") {
    const out = [];
    for (let i = 0; i < g.coordinates.length; i++) {
      const ring = g.coordinates[i] && g.coordinates[i][0];
      if (ring && ring.length >= 4) out.push(ring);
    }
    return out;
  }
  return [];
}

function percentile(values, p) {
  if (!values || !values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const i = Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))));
  return s[i];
}

function pushSample(arr, z, seen, cap) {
  if (arr.length < cap) {
    arr.push(z);
    return;
  }
  if (seen % 4 === 0) arr[seen % cap] = z;
}

function cellSizeM(spacing) {
  const s = spacing > 0 ? spacing : 2;
  return Math.max(2, Math.min(8, Math.round(s)));
}

function ingestPoint(grid, x, y, z, cls, ret, nret, maxX, maxY) {
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < grid.originX || x >= maxX || y < grid.originY || y >= maxY) return;
  if (cls === 7 || cls === 18) return;
  grid.counts[cls] = (grid.counts[cls] || 0) + 1;
  grid.kept++;
  const ix = Math.floor((x - grid.originX) / grid.cell);
  const iy = Math.floor((y - grid.originY) / grid.cell);
  const key = ix + "," + iy;
  let rec = grid.cells.get(key);
  if (!rec) {
    rec = emptyCell();
    rec.ix = ix;
    rec.iy = iy;
    grid.cells.set(key, rec);
  }
  rec.n++;
  if (cls === 2) {
    if (rec.g == null || z < rec.g) rec.g = z;
    return;
  }
  if (cls === 3 || cls === 4 || cls === 5 || nret >= 3) {
    rec.vc++;
    pushSample(rec.v, z, rec.vc, 12);
    return;
  }
  if (cls === 6) {
    rec.bc++;
    pushSample(rec.b, z, rec.bc, 16);
    return;
  }
  if ((cls === 0 || cls === 1) && ret <= 1 && nret <= 2) {
    rec.uc++;
    if (rec.uMin == null || z < rec.uMin) rec.uMin = z;
    if (rec.uMax == null || z > rec.uMax) rec.uMax = z;
    pushSample(rec.u, z, rec.uc, 12);
  }
}

function emptyCell() {
  return { g: null, b: [], bc: 0, u: [], uc: 0, uMin: null, uMax: null, v: [], vc: 0, n: 0 };
}

/**
 * Bin lon/lat points into a mercator grid.
 * cls 2 ground, 6 building, 3/4/5 vegetation, 0/1 single-return roof candidates.
 */
function gridFromPoints(points, frame, opts) {
  const opt = opts || {};
  const spacing = opt.spacingM > 0 ? opt.spacingM : 2;
  const cell = opt.cellM > 0 ? opt.cellM : cellSizeM(spacing);
  const southWest = mercator(+frame.west, +frame.south);
  const northEast = mercator(+frame.east, +frame.north);
  const originX = Math.min(southWest[0], northEast[0]);
  const originY = Math.min(southWest[1], northEast[1]);
  const maxX = Math.max(southWest[0], northEast[0]);
  const maxY = Math.max(southWest[1], northEast[1]);
  const grid = {
    originX,
    originY,
    cell,
    cellGroundM: cell * groundScale(((+frame.south) + (+frame.north)) / 2),
    spacingM: spacing,
    cells: new Map(),
    counts: {},
    kept: 0,
    frame,
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const xy = Number.isFinite(p.x) ? [p.x, p.y] : mercator(+p.lon, +p.lat);
    ingestPoint(grid, xy[0], xy[1], p.z, p.cls | 0, p.ret | 0, p.nret | 0, maxX, maxY);
  }
  return grid;
}

function cellCenter(grid, rec) {
  return unmercator(grid.originX + (rec.ix + 0.5) * grid.cell, grid.originY + (rec.iy + 0.5) * grid.cell);
}

function groundAt(grid, ix, iy) {
  const direct = grid.cells.get(ix + "," + iy);
  if (direct && direct.g != null) return direct.g;
  let best = null;
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const rec = grid.cells.get(ix + dx + "," + (iy + dy));
        if (!rec || rec.g == null) continue;
        if (best == null || rec.g < best) best = rec.g;
      }
    }
    if (best != null) return best;
  }
  return null;
}

function cellNdsM(grid, rec) {
  const g = groundAt(grid, rec.ix, rec.iy);
  if (g == null) return null;
  if (rec.bc >= 1 && rec.b.length) {
    const z = percentile(rec.b, 0.9);
    if (z == null) return null;
    const h = z - g;
    if (h >= CLASS6_MIN_M) return { h, z, kind: "class6" };
  }
  // No building class: a flat single-return patch is a roof. A cell whose
  // returns span more than 6 m is a crown or a wall, not a roof plane.
  if (rec.uc >= 3 && rec.u.length && rec.vc === 0 && rec.uMax != null && rec.uMax - rec.uMin <= 6) {
    const z = percentile(rec.u, 0.9);
    if (z == null) return null;
    const h = z - g;
    if (h > NDSM_BUILDING_M) return { h, z, kind: "ndsm" };
  }
  return null;
}

function coveredRings(features) {
  const rings = [];
  for (let i = 0; i < features.length; i++) {
    const list = exteriorRings(features[i]);
    for (let k = 0; k < list.length; k++) rings.push(list[k]);
  }
  return rings;
}

function ringCovers(rings, lon, lat) {
  for (let i = 0; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return true;
  }
  return false;
}

function samplesInside(grid, ring, field) {
  const zs = [];
  const grounds = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const xy = mercator(ring[i][0], ring[i][1]);
    if (xy[0] < minX) minX = xy[0];
    if (xy[1] < minY) minY = xy[1];
    if (xy[0] > maxX) maxX = xy[0];
    if (xy[1] > maxY) maxY = xy[1];
  }
  const x0 = Math.floor((minX - grid.originX) / grid.cell) - 3;
  const y0 = Math.floor((minY - grid.originY) / grid.cell) - 3;
  const x1 = Math.floor((maxX - grid.originX) / grid.cell) + 3;
  const y1 = Math.floor((maxY - grid.originY) / grid.cell) + 3;
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const rec = grid.cells.get(ix + "," + iy);
      if (!rec) continue;
      const c = cellCenter(grid, rec);
      const inside = pointInRing(c[0], c[1], ring);
      if (rec.g != null) grounds.push(rec.g);
      if (!inside) continue;
      const arr = rec[field];
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) zs.push(arr[k]);
    }
  }
  return { zs, grounds };
}

function heightForRing(grid, ring) {
  const building = samplesInside(grid, ring, "b");
  let zs = building.zs;
  let grounds = building.grounds;
  if (zs.length < MIN_SAMPLES) {
    const roof = samplesInside(grid, ring, "u");
    zs = roof.zs;
    if (roof.grounds.length > grounds.length) grounds = roof.grounds;
  }
  if (zs.length < MIN_SAMPLES || grounds.length < 2) return null;
  const top = percentile(zs, 0.9);
  const ground = percentile(grounds, 0.2);
  if (top == null || ground == null) return null;
  const h = Math.round((top - ground) * 10) / 10;
  if (h < CLASS6_MIN_M || h > 420) return null;
  return h;
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat = ring[0][1];
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const my = 110540;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * mx * ring[i][1] * my - ring[i][0] * mx * ring[j][1] * my;
  }
  return Math.abs(a) / 2;
}

function simplifyMeters(ring, meters) {
  const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  if (open.length < 4) return null;
  const lat = open[0][1];
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const my = 110540;
  const ox = open[0][0];
  const oy = open[0][1];
  const local = open.map((p) => [(p[0] - ox) * mx, (p[1] - oy) * my]);
  const tol = (meters > 0 ? meters : 1) ** 2;
  function dp(pts) {
    if (pts.length < 3) return pts;
    const a = pts[0];
    const b = pts[pts.length - 1];
    let maxD = 0;
    let maxI = 0;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const den = dx * dx + dy * dy || 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const t = ((pts[i][0] - a[0]) * dx + (pts[i][1] - a[1]) * dy) / den;
      const px = a[0] + t * dx;
      const py = a[1] + t * dy;
      const d = (pts[i][0] - px) ** 2 + (pts[i][1] - py) ** 2;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD <= tol) return [a, b];
    const left = dp(pts.slice(0, maxI + 1));
    const right = dp(pts.slice(maxI));
    return left.slice(0, -1).concat(right);
  }
  const out = dp(local);
  if (!out || out.length < 3) return null;
  const back = out.map((p) => [ox + p[0] / mx, oy + p[1] / my]);
  back.push(back[0]);
  return back;
}

function traceComponent(cells) {
  const set = new Set();
  for (let i = 0; i < cells.length; i++) set.add(cells[i].ix + "," + cells[i].iy);
  const has = (x, y) => set.has(x + "," + y);
  const next = new Map();
  function addEdge(x0, y0, x1, y1) {
    const k = x0 + "," + y0;
    let arr = next.get(k);
    if (!arr) {
      arr = [];
      next.set(k, arr);
    }
    arr.push(x1 + "," + y1);
  }
  for (let i = 0; i < cells.length; i++) {
    const x = cells[i].ix;
    const y = cells[i].iy;
    if (!has(x, y - 1)) addEdge(x, y, x + 1, y);
    if (!has(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
    if (!has(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
    if (!has(x - 1, y)) addEdge(x, y + 1, x, y);
  }
  const used = new Set();
  let best = null;
  let bestArea = 0;
  for (const [k, outs] of next) {
    for (let i = 0; i < outs.length; i++) {
      const startEdge = k + ">" + outs[i];
      if (used.has(startEdge)) continue;
      const loop = [];
      let cur = k;
      let guard = 0;
      const start = k;
      while (guard++ < cells.length * 8 + 8) {
        const parts = cur.split(",");
        loop.push([+parts[0], +parts[1]]);
        const step = next.get(cur);
        if (!step) break;
        let moved = null;
        for (let j = 0; j < step.length; j++) {
          const edge = cur + ">" + step[j];
          if (used.has(edge)) continue;
          used.add(edge);
          moved = step[j];
          break;
        }
        if (!moved) break;
        cur = moved;
        if (cur === start) break;
      }
      if (loop.length < 4) continue;
      let area = 0;
      for (let a = 0, b = loop.length - 1; a < loop.length; b = a++) {
        area += loop[b][0] * loop[a][1] - loop[a][0] * loop[b][1];
      }
      area = Math.abs(area) / 2;
      if (area > bestArea) {
        bestArea = area;
        best = loop;
      }
    }
  }
  return best;
}

function polygonForCells(grid, cells) {
  const loop = traceComponent(cells);
  if (!loop) return null;
  const ll = [];
  for (let i = 0; i < loop.length; i++) {
    ll.push(unmercator(grid.originX + loop[i][0] * grid.cell, grid.originY + loop[i][1] * grid.cell));
  }
  ll.push(ll[0]);
  const simple = simplifyMeters(ll, 1);
  if (!simple || simple.length < 4) return null;
  if (ringAreaM2(simple) < MIN_ADDED_M2) return null;
  return simple;
}

function componentHeight(grid, cells) {
  const zs = [];
  const grounds = [];
  for (let i = 0; i < cells.length; i++) {
    const rec = cells[i];
    const nd = cellNdsM(grid, rec);
    if (nd) zs.push(nd.z);
    const g = groundAt(grid, rec.ix, rec.iy);
    if (g != null) grounds.push(g);
  }
  if (zs.length < 3 || !grounds.length) return null;
  const h = Math.round((percentile(zs, 0.9) - percentile(grounds, 0.2)) * 10) / 10;
  if (h < NDSM_BUILDING_M || h > 420) return null;
  return h;
}

function missingFootprints(grid, rings) {
  const seeds = [];
  for (const rec of grid.cells.values()) {
    const nd = cellNdsM(grid, rec);
    if (!nd) continue;
    if (nd.kind === "class6" && nd.h < CLASS6_MIN_M) continue;
    if (nd.kind !== "class6" && nd.h <= NDSM_BUILDING_M) continue;
    const c = cellCenter(grid, rec);
    if (ringCovers(rings, c[0], c[1])) continue;
    seeds.push(rec);
  }
  const seen = new Set();
  const added = [];
  const cellArea = grid.cellGroundM * grid.cellGroundM;
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const sk = seed.ix + "," + seed.iy;
    if (seen.has(sk)) continue;
    const comp = [];
    const stack = [seed];
    seen.add(sk);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const nbs = [
        [cur.ix + 1, cur.iy],
        [cur.ix - 1, cur.iy],
        [cur.ix, cur.iy + 1],
        [cur.ix, cur.iy - 1],
      ];
      for (let k = 0; k < nbs.length; k++) {
        const key = nbs[k][0] + "," + nbs[k][1];
        if (seen.has(key)) continue;
        const nb = grid.cells.get(key);
        if (!nb) continue;
        const nd = cellNdsM(grid, nb);
        if (!nd) continue;
        if (nd.kind === "class6" ? nd.h < CLASS6_MIN_M : nd.h <= NDSM_BUILDING_M) continue;
        const c = cellCenter(grid, nb);
        if (ringCovers(rings, c[0], c[1])) continue;
        seen.add(key);
        stack.push(nb);
      }
    }
    if (comp.length * cellArea < MIN_ADDED_M2) continue;
    const ring = polygonForCells(grid, comp);
    const h = componentHeight(grid, comp);
    if (!ring || h == null) continue;
    added.push({
      type: "Feature",
      properties: {
        height: h,
        heightSource: HEIGHT_SOURCE,
        building: "yes",
        lidarAdded: true,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return added;
}

function applyLidarSample(features, trees, grid) {
  const source = Array.isArray(features) ? features : [];
  const rings = coveredRings(source);
  const next = [];
  let heights = 0;
  for (let i = 0; i < source.length; i++) {
    const feature = source[i];
    const list = exteriorRings(feature);
    let measured = null;
    for (let k = 0; k < list.length && measured == null; k++) measured = heightForRing(grid, list[k]);
    if (measured == null) {
      next.push(feature);
      continue;
    }
    // A coarse cell can miss a tower roof and report the podium. Do not
    // replace a tall height with less than half of it.
    const previous = Number(feature.properties && feature.properties.height) || 0;
    if (previous >= 45 && measured < previous * 0.45) {
      next.push(feature);
      continue;
    }
    heights++;
    next.push(
      Object.assign({}, feature, {
        properties: Object.assign({}, feature.properties, {
          height: measured,
          heightSource: HEIGHT_SOURCE,
        }),
      })
    );
  }
  const added = missingFootprints(grid, rings);
  for (let i = 0; i < added.length; i++) next.push(added[i]);
  const treeList = Array.isArray(trees) ? trees : [];
  const outTrees = [];
  let canopy = 0;
  for (let i = 0; i < treeList.length; i++) {
    const tree = Object.assign({}, treeList[i]);
    const lon = +tree.lon;
    const lat = +tree.lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      outTrees.push(tree);
      continue;
    }
    const xy = mercator(lon, lat);
    const ix = Math.floor((xy[0] - grid.originX) / grid.cell);
    const iy = Math.floor((xy[1] - grid.originY) / grid.cell);
    const rec = grid.cells.get(ix + "," + iy);
    if (!rec || rec.vc < 2) {
      outTrees.push(tree);
      continue;
    }
    const top = percentile(rec.v, 0.9);
    const g = groundAt(grid, ix, iy);
    if (top == null || g == null) {
      outTrees.push(tree);
      continue;
    }
    const h = Math.round((top - g) * 10) / 10;
    if (h < 2 || h > 70) {
      outTrees.push(tree);
      continue;
    }
    tree.heightM = h;
    tree.heightSource = HEIGHT_SOURCE;
    canopy++;
    outTrees.push(tree);
  }
  return { features: next, trees: outTrees, heights, added: added.length, canopy };
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function lidarNote(sample) {
  if (!sample) return "";
  if (sample.skipped) return sample.warning || outsideNote(sample.frame || {});
  const km = sample.km2 > 0 ? sample.km2 : 0;
  let line = "USGS lidar " + sample.project;
  if (sample.collected) line += " (collected " + sample.collected + ")";
  line +=
    ": " +
    sample.points +
    " points, " +
    mb(sample.bytes) +
    " MB, " +
    sample.spacingM.toFixed(1) +
    " m spacing, " +
    (sample.ms / 1000).toFixed(1) +
    " s.";
  if (km > 0) {
    line +=
      " " +
      (sample.points / km / 1e6).toFixed(2) +
      " million points/km², " +
      (sample.bytes / km / (1024 * 1024)).toFixed(1) +
      " MB/km².";
  }
  if (sample.heights) line += " Heights updated on " + sample.heights + " buildings.";
  if (sample.added) line += " " + sample.added + " footprints added from the cloud.";
  if (sample.canopy) line += " Canopy heights updated on " + sample.canopy + " trees.";
  if (sample.partial) line += " The read stopped early to stay inside the export budget.";
  if (sample.capped && sample.fullBytes > sample.bytes) {
    line +=
      " A " +
      sample.fullSpacingM.toFixed(1) +
      " m read of this draw is about " +
      mb(sample.fullBytes) +
      " MB (" +
      Math.round(sample.fullPoints / 1000) +
      "k points), past this export. A cached nDSM for the project would carry that finer grid.";
  }
  return line;
}

function depthForSpacing(bounds, span, minSpacing) {
  const sx = bounds[3] - bounds[0];
  let d = 0;
  while (d < 18) {
    const next = sx / 2 ** (d + 1) / span;
    if (next < minSpacing) break;
    d++;
  }
  return d;
}

function nodeBox(bounds, key) {
  const parts = key.split("-");
  const d = +parts[0];
  const x = +parts[1];
  const y = +parts[2];
  const z = +parts[3];
  const sx = (bounds[3] - bounds[0]) / 2 ** d;
  const sy = (bounds[4] - bounds[1]) / 2 ** d;
  const sz = (bounds[5] - bounds[2]) / 2 ** d;
  return [bounds[0] + x * sx, bounds[1] + y * sy, bounds[2] + z * sz, bounds[0] + (x + 1) * sx, bounds[1] + (y + 1) * sy, bounds[2] + (z + 1) * sz, d];
}

function overlapsXY(box, query) {
  return box[0] < query[2] && box[3] > query[0] && box[1] < query[3] && box[4] > query[1];
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { "user-agent": userAgent, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("http " + res.status);
  return res.json();
}

async function getBuf(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { "user-agent": userAgent, accept: "application/octet-stream" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("http " + res.status);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function readF64(mod, ptr, off) {
  const u = mod.HEAPU8;
  return Buffer.from(u.buffer, u.byteOffset + ptr + off, 8).readDoubleLE(0);
}

function gpsDay(gps) {
  if (!Number.isFinite(gps) || gps <= 0) return null;
  const epoch = Date.UTC(1980, 0, 6);
  const leap = 18;
  const candidates = [epoch + (gps + 1e9) * 1000 - leap * 1000, epoch + gps * 1000 - leap * 1000];
  for (let i = 0; i < candidates.length; i++) {
    const date = new Date(candidates[i]);
    const y = date.getUTCFullYear();
    if (y >= 2003 && y <= 2026) return date.toISOString().slice(0, 10);
  }
  return null;
}

let lazMod = null;
async function laz() {
  if (!lazMod) {
    const { createLazPerf } = require("laz-perf");
    lazMod = await createLazPerf();
  }
  return lazMod;
}

function decodeTile(mod, buf, onPoint, onGps) {
  const format = buf.readUInt8(104) & 63;
  const scale = [buf.readDoubleLE(131), buf.readDoubleLE(139), buf.readDoubleLE(147)];
  const off = [buf.readDoubleLE(155), buf.readDoubleLE(163), buf.readDoubleLE(171)];
  const laszip = new mod.LASZip();
  const dataPtr = mod._malloc(buf.length);
  mod.HEAPU8.set(buf, dataPtr);
  try {
    laszip.open(dataPtr, buf.length);
    const n = laszip.getCount();
    const plen = laszip.getPointLength();
    const pointPtr = mod._malloc(plen);
    const modern = format >= 6;
    const gpsOff = modern ? 22 : 20;
    const hasGps = format === 1 || format === 3 || format === 4 || format === 5 || modern;
    try {
      for (let i = 0; i < n; i++) {
        laszip.getPoint(pointPtr);
        const x = mod.HEAP32[pointPtr >> 2] * scale[0] + off[0];
        const y = mod.HEAP32[(pointPtr >> 2) + 1] * scale[1] + off[1];
        const z = mod.HEAP32[(pointPtr >> 2) + 2] * scale[2] + off[2];
        let cls;
        let ret;
        let nret;
        if (modern) {
          cls = mod.HEAPU8[pointPtr + 16];
          const flags = mod.HEAPU8[pointPtr + 14];
          ret = flags & 15;
          nret = (flags >> 4) & 15;
        } else {
          cls = mod.HEAPU8[pointPtr + 15] & 31;
          const flags = mod.HEAPU8[pointPtr + 14];
          ret = flags & 7;
          nret = (flags >> 3) & 7;
        }
        if (onGps && hasGps && i < 8) onGps(readF64(mod, pointPtr, gpsOff));
        onPoint(x, y, z, cls, ret, nret);
      }
    } finally {
      mod._free(pointPtr);
    }
    return n;
  } finally {
    laszip.delete();
    mod._free(dataPtr);
  }
}

function spreadTiles(tiles) {
  const coarse = [];
  const fine = [];
  let maxD = 0;
  for (let i = 0; i < tiles.length; i++) if (tiles[i].d > maxD) maxD = tiles[i].d;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].d < maxD) coarse.push(tiles[i]);
    else fine.push(tiles[i]);
  }
  fine.sort((a, b) => a.x - b.x || a.y - b.y);
  const stride = Math.max(1, Math.ceil(Math.sqrt(fine.length)));
  const ordered = coarse.slice();
  for (let phase = 0; phase < stride; phase++) {
    for (let i = phase; i < fine.length; i += stride) ordered.push(fine[i]);
  }
  return ordered;
}

async function readProject(name, frame, caps, fetchImpl) {
  const ept = await getJson(EPT_BUCKET + "/" + name + "/ept.json", fetchImpl);
  const bounds = ept.bounds;
  const span = ept.span || 128;
  if (!bounds || bounds.length < 6) throw new Error("ept bounds");
  const sw = mercator(+frame.west, +frame.south);
  const ne = mercator(+frame.east, +frame.north);
  const query = [Math.min(sw[0], ne[0]), Math.min(sw[1], ne[1]), Math.max(sw[0], ne[0]), Math.max(sw[1], ne[1])];
  const conform = ept.boundsConforming || bounds;
  const cx = (query[0] + query[2]) / 2;
  const cy = (query[1] + query[3]) / 2;
  if (cx < conform[0] || cx > conform[3] || cy < conform[1] || cy > conform[4]) return null;
  const fullDepth = depthForSpacing(bounds, span, 0.5);
  const base = EPT_BUCKET + "/" + name + "/ept-hierarchy/";
  const loaded = new Map();
  async function load(key) {
    if (loaded.has(key)) return;
    loaded.set(key, await getJson(base + key + ".json", fetchImpl));
  }
  await load("0-0-0-0");
  let grew = true;
  let guard = 0;
  while (grew && guard++ < 40) {
    grew = false;
    for (const data of loaded.values()) {
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (data[key] !== -1 || loaded.has(key)) continue;
        const d = +key.split("-")[0];
        if (d > fullDepth) continue;
        if (!overlapsXY(nodeBox(bounds, key), query)) continue;
        await load(key);
        grew = true;
      }
    }
  }
  const nodes = [];
  for (const data of loaded.values()) {
    const keys = Object.keys(data);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const count = data[key];
      if (!(count > 0)) continue;
      const box = nodeBox(bounds, key);
      if (box[6] > fullDepth) continue;
      if (!overlapsXY(box, query)) continue;
      nodes.push({ key, count, d: box[6], x: +key.split("-")[1], y: +key.split("-")[2] });
    }
  }
  if (!nodes.length) return null;
  const sx = bounds[3] - bounds[0];
  function cum(depth) {
    let points = 0;
    let tiles = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].d > depth) continue;
      points += nodes[i].count;
      tiles++;
    }
    return { points, tiles, bytes: points * BYTES_PER_POINT, spacing: sx / 2 ** depth / span };
  }
  let downloadDepth = 0;
  for (let d = 0; d <= fullDepth; d++) {
    const stat = cum(d);
    const fits = stat.tiles <= caps.maxTiles && stat.points <= caps.maxPoints && stat.bytes <= caps.maxBytes;
    if (!fits) break;
    downloadDepth = d;
    if (stat.spacing <= 1) break;
  }
  const full = cum(fullDepth);
  const chosen = nodes.filter((n) => n.d <= downloadDepth);
  return {
    name,
    ept,
    nodes: spreadTiles(chosen),
    spacingM: cum(downloadDepth).spacing,
    fullSpacingM: full.spacing,
    fullPoints: full.points,
    fullBytes: full.bytes,
    capped: downloadDepth < fullDepth && full.spacing < cum(downloadDepth).spacing,
  };
}

async function fetchUsgsLidar(frame, opts) {
  const opt = opts || {};
  const fetchImpl = opt.fetchImpl || fetch;
  const started = Date.now();
  const caps = {
    maxPoints: opt.maxPoints > 0 ? opt.maxPoints : MAX_POINTS,
    maxBytes: opt.maxBytes > 0 ? opt.maxBytes : MAX_BYTES,
    maxTiles: opt.maxTiles > 0 ? opt.maxTiles : MAX_TILES,
    maxMs: opt.maxMs > 0 ? opt.maxMs : MAX_MS,
  };
  const km2 = km2Of(frame);
  const ranked = rankProjects(frame, opt.index || null);
  if (!ranked.length) {
    return {
      skipped: "outside-3dep",
      warning: outsideNote(frame),
      km2,
      frame,
    };
  }
  let plan = null;
  const tried = [];
  const need = Math.max(5000, Math.min(80000, Math.round((km2 > 0 ? km2 : 0.1) * 40000)));
  for (let i = 0; i < ranked.length && i < 4; i++) {
    if (Date.now() - started > caps.maxMs) break;
    const name = ranked[i][0];
    tried.push(name);
    try {
      const candidate = await readProject(name, frame, caps, fetchImpl);
      if (!candidate || !candidate.nodes.length) continue;
      if (!plan || candidate.fullPoints > plan.fullPoints) plan = candidate;
      if (candidate.fullPoints >= need) break;
    } catch {
      // The next project in the draw may still have a cloud.
    }
  }
  if (!plan) {
    return {
      skipped: "no-points",
      warning: "USGS lidar has no points for this draw" + (tried.length ? " (" + tried.join(", ") + ")" : "") + ".",
      km2,
      tried,
      frame,
    };
  }
  const project = plan.name;
  const southWest = mercator(+frame.west, +frame.south);
  const northEast = mercator(+frame.east, +frame.north);
  const grid = gridFromPoints([], frame, { spacingM: plan.spacingM });
  let points = 0;
  let bytes = 0;
  let tiles = 0;
  let collected = null;
  let mod = null;
  try {
    mod = await laz();
  } catch {
    return {
      skipped: "decoder",
      warning: "USGS lidar omitted: the point decoder is not available. Building heights are unchanged.",
      km2,
      project,
      frame,
    };
  }
  const deadline = started + caps.maxMs;
  let partial = false;
  for (let i = 0; i < plan.nodes.length; i++) {
    if (Date.now() > deadline || bytes >= caps.maxBytes || points >= caps.maxPoints) {
      partial = i < plan.nodes.length;
      break;
    }
    const node = plan.nodes[i];
    let buf;
    try {
      buf = await getBuf(EPT_BUCKET + "/" + project + "/ept-data/" + node.key + ".laz", fetchImpl);
    } catch {
      continue;
    }
    bytes += buf.length;
    tiles++;
    try {
      points += decodeTile(
        mod,
        buf,
        (x, y, z, cls, ret, nret) => {
          ingestPoint(
            grid,
            x,
            y,
            z,
            cls,
            ret,
            nret,
            Math.max(southWest[0], northEast[0]),
            Math.max(southWest[1], northEast[1])
          );
        },
        (gps) => {
          const day = gpsDay(gps);
          if (day && (!collected || day < collected)) collected = day;
        }
      );
    } catch {
      // A bad tile does not fail the export.
    }
  }
  const ms = Date.now() - started;
  return {
    skipped: null,
    project,
    collected,
    spacingM: plan.spacingM,
    fullSpacingM: plan.fullSpacingM,
    fullPoints: plan.fullPoints,
    fullBytes: plan.fullBytes,
    capped: plan.capped,
    partial,
    points,
    bytes,
    tiles,
    ms,
    km2,
    counts: grid.counts,
    grid,
    tried,
    frame,
  };
}

module.exports = {
  HEIGHT_SOURCE,
  EPT_BUCKET,
  MAX_POINTS,
  MAX_BYTES,
  MAX_TILES,
  MAX_MS,
  projectYear,
  rankProjects,
  inQuebec,
  outsideNote,
  gridFromPoints,
  applyLidarSample,
  lidarNote,
  fetchUsgsLidar,
  gpsDay,
  mercator,
  km2Of,
};
