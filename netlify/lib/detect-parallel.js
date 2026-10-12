"use strict";

/**
 * Run canopy tracing, foliage clipping, and vehicle scans on the CPU
 * pool. The grid and the aerial are split into row tiles, one batch
 * per os.cpus() worker. The main thread waits, so the export heartbeat
 * keeps firing.
 *
 * A tile edge can split one connected crown into the pieces on each
 * side of that edge. Rings are still the traced canopy cells. Nothing
 * is invented. The export cap is applied once to the combined list.
 */

const { threadCount, runOne, runTiles } = require("./cpu-pool");
const { polygonsFromCrowns, treePairsFromPoints } = require("./vegetation");
const { selectCrownsForExport } = require("./canopy-height");
const { coverClasses } = require("./canopy-fill");
const { materialForVegetation } = require("./materials");
const { llToPx, pxToLl } = require("./geo-frame");
const { ringKey } = require("./osm-tiles");
const {
  needsPitchImage,
  roofWantsDocks,
  carHitRows,
  finishCarLayer,
  decodePlate,
} = require("./vehicle-track");

function valuesOf(grid) {
  if (!grid || grid.values == null) return null;
  if (typeof grid.values === "string") return Buffer.from(grid.values, "base64");
  return grid.values;
}

function splitRows(total, count) {
  const h = total | 0;
  const n = Math.max(1, Math.min(count > 0 ? count : 1, h));
  const bands = [];
  let y = 0;
  const step = Math.floor(h / n);
  for (let i = 0; i < n; i++) {
    const y1 = i === n - 1 ? h : y + Math.max(1, step);
    if (y1 > y) bands.push({ y0: y, y1 });
    y = y1;
  }
  return bands;
}

function splitList(list, count) {
  const items = list || [];
  if (!items.length) return [];
  const n = Math.max(1, Math.min(count > 0 ? count : 1, items.length));
  const size = Math.ceil(items.length / n);
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function sliceGrid(grid, y0, y1) {
  const src = valuesOf(grid);
  const w = grid.width | 0;
  const fullH = grid.height | 0;
  const h = y1 - y0;
  const values = new Uint8Array(w * h);
  if (src) {
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * w;
      for (let x = 0; x < w; x++) values[y * w + x] = src[row + x] || 0;
    }
  }
  const span = +grid.north - +grid.south;
  return {
    west: +grid.west,
    east: +grid.east,
    north: +grid.north - (y0 / fullH) * span,
    south: +grid.north - (y1 / fullH) * span,
    width: w,
    height: h,
    values,
    nonzero: 1,
  };
}

function plainData(value) {
  if (!value || typeof value !== "object") return value || null;
  const out = Array.isArray(value) ? [] : {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof value[key] === "function") continue;
    out[key] = value[key];
  }
  return out;
}

function copyGrid(grid) {
  const src = valuesOf(grid);
  const w = grid.width | 0;
  const h = grid.height | 0;
  const values = new Uint8Array(w * h);
  if (src) {
    for (let i = 0; i < values.length && i < src.length; i++) values[i] = src[i] || 0;
  }
  return {
    west: +grid.west,
    south: +grid.south,
    east: +grid.east,
    north: +grid.north,
    width: w,
    height: h,
    values,
    nonzero: grid.nonzero | 0,
  };
}

function woodPolygons(woodRings, frame) {
  const polygons = [];
  const list = woodRings || [];
  for (let w = 0; w < list.length; w++) {
    const wood = list[w];
    const ll = wood && (wood.ringLonLat || wood.ring || wood);
    if (!ll || ll.length < 4) continue;
    const ringPx = [];
    for (let i = 0; i < ll.length; i++) {
      const p = llToPx(ll[i][0], ll[i][1], frame);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      ringPx.push(p);
    }
    if (ringPx.length >= 3) {
      const a = ringPx[0];
      const b = ringPx[ringPx.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) ringPx.push([a[0], a[1]]);
    }
    const heightM = wood && Number(wood.heightM) > 2 ? Number(wood.heightM) : 12;
    const material = materialForVegetation(heightM, "heavy");
    if (material && ringPx.length >= 4) polygons.push({ ringPx, material, kind: "canopy", shape: "polygon" });
  }
  return polygons;
}

function plainOpts(opts) {
  const src = opts || {};
  return {
    canopyHits: src.canopyHits || [],
    buildingRings: src.buildingRings || [],
    maskRings: src.maskRings || [],
    maskPolygons: src.maskPolygons || [],
    woodRings: src.woodRings || [],
    omitFoliage: src.omitFoliage === true,
    chmRequired: src.chmRequired === true,
    maxPolygons: src.maxPolygons,
    buildingBufferM: src.buildingBufferM,
  };
}

function centroidY(poly) {
  const ring = poly && poly.ringPx;
  if (!ring || !ring.length) return 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    y += ring[i][1];
    n++;
  }
  return n ? y / n : 0;
}

function tilePolygons(polygons, n) {
  const scored = (polygons || []).map((poly) => ({ poly, y: centroidY(poly) }));
  scored.sort((a, b) => a.y - b.y);
  const groups = [];
  const size = Math.max(1, Math.ceil(scored.length / Math.max(1, n)));
  for (let i = 0; i < scored.length; i += size) {
    const group = [];
    for (let k = i; k < i + size && k < scored.length; k++) group.push(scored[k].poly);
    if (group.length) groups.push(group);
  }
  return groups;
}

function mergeFoliage(parts, meta) {
  const oiAreas = [];
  const clipZones = [];
  const clipTypes = [];
  const materials = [];
  const overlayRings = [];
  const seen = new Set();
  let count = 0;
  let foliageLifted = 0;
  let polygons = 0;
  const treeAreas = [];
  const treeKinds = [];
  let droppedInvalid = 0;
  let sawTreeOi = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.oiAreas) oiAreas.push.apply(oiAreas, part.oiAreas);
    if (part.clipZones) clipZones.push.apply(clipZones, part.clipZones);
    if (part.overlayRings) overlayRings.push.apply(overlayRings, part.overlayRings);
    if (part.materials) materials.push.apply(materials, part.materials);
    count += part.count | 0;
    foliageLifted += part.foliageLifted | 0;
    polygons += part.polygons | 0;
    if (part.treeOi) {
      sawTreeOi = true;
      if (part.treeOi.areas) treeAreas.push.apply(treeAreas, part.treeOi.areas);
      if (part.treeOi.kinds) treeKinds.push.apply(treeKinds, part.treeOi.kinds);
      droppedInvalid += part.treeOi.droppedInvalid | 0;
    }
    const types = part.clipTypes || [];
    for (let t = 0; t < types.length; t++) {
      const type = types[t];
      if (!type || !type.id || seen.has(type.id)) continue;
      seen.add(type.id);
      clipTypes.push(type);
    }
  }
  return {
    oiAreas,
    clipZones,
    clipTypes,
    materials,
    count,
    foliageLifted,
    foliageGeometry: meta.foliageGeometry || "none",
    foliageCoarsened: !!meta.coarsened,
    foliageDropped: meta.dropped | 0,
    polygons,
    overlayPoints: [],
    overlayRings,
    treeOi: sawTreeOi ? { areas: treeAreas, kinds: treeKinds, droppedInvalid } : null,
  };
}

async function fillInWorker(grid, opts) {
  if (!opts || !opts.frame || !opts.image || !opts.image.data) return grid;
  const classes = grid ? coverClasses(grid, opts.worldcover) : null;
  const data = opts.image.data;
  const shared = new SharedArrayBuffer(data.byteLength);
  new Uint8Array(shared).set(data);
  const classCopy = classes ? Buffer.from(classes) : null;
  return runOne("fill-canopy", {
    grid: grid ? copyGrid(grid) : null,
    frame: opts.frame,
    width: opts.image.width,
    height: opts.image.height,
    buffer: shared,
    classes: classCopy,
    openRuns: opts.openRuns || [],
  });
}

async function treePairsParallel(treePoints, frame, buildingAabbs, affine, opts) {
  const grid = opts && opts.chmGrid;
  const threads = threadCount();
  if (!grid || !(grid.width > 1) || !(grid.height > 8)) {
    return runOne("tree-pairs", {
      treePoints,
      frame,
      buildingAabbs,
      affine,
      opts: plainOpts(opts),
      terrain: plainData(opts && opts.terrain),
      chmGrid: grid ? copyGrid(grid) : null,
    });
  }
  const bands = splitRows(grid.height, threads);
  const tilePayloads = [];
  for (let i = 0; i < bands.length; i++) {
    tilePayloads.push({
      grid: sliceGrid(grid, bands[i].y0, bands[i].y1),
      frame,
      buildingRings: opts.buildingRings || [],
      maskRings: opts.maskRings || [],
      maskPolygons: opts.maskPolygons || [],
      hits: opts.canopyHits || [],
    });
  }
  const traced = await runTiles("canopy-tile", tilePayloads);
  let crowns = [];
  for (let i = 0; i < traced.length; i++) {
    const part = traced[i] && traced[i].crowns;
    if (part && part.length) crowns = crowns.concat(part);
  }
  const max = opts.maxPolygons > 0 ? opts.maxPolygons | 0 : 720;
  const before = crowns.length;
  if (crowns.length > max) crowns = selectCrownsForExport(crowns, max);
  const meta = {
    coarsened: before > crowns.length,
    dropped: before > crowns.length ? before - crowns.length : 0,
    foliageGeometry: crowns.length ? "chm-contour" : "none",
  };
  let polygons = polygonsFromCrowns(crowns, frame);
  if (!(opts && opts.omitFoliage)) polygons = polygons.concat(woodPolygons(opts.woodRings, frame));
  if (!polygons.length) {
    return treePairsFromPoints(treePoints, frame, buildingAabbs, affine, Object.assign({}, opts, {
      preparedPolygons: [],
      foliageCoarsened: meta.coarsened,
      foliageDropped: meta.dropped,
      foliageGeometry: meta.foliageGeometry,
    }));
  }
  const groups = tilePolygons(polygons, threads);
  const terrain = plainData(opts.terrain);
  const chmGrid = copyGrid(grid);
  const assembled = await runTiles(
    "foliage-assemble",
    groups.map((group) => ({
      polygons: group,
      frame,
      affine,
      buildingRings: opts.buildingRings || [],
      maskRings: opts.maskRings || [],
      maskPolygons: opts.maskPolygons || [],
      buildingBufferM: opts.buildingBufferM,
      terrain,
      chmGrid,
    }))
  );
  const merged = mergeFoliage(assembled, meta);
  return merged;
}

function sharePlate(decoded) {
  if (!decoded || !decoded.data) return null;
  const shared = new SharedArrayBuffer(decoded.data.byteLength);
  new Uint8Array(shared).set(decoded.data);
  return { width: decoded.width, height: decoded.height, buffer: shared, data: new Uint8Array(shared) };
}

function pxRingToLonLat(ring, frame) {
  const out = [];
  for (let i = 0; i < ring.length; i++) out.push(pxToLl(ring[i][0], ring[i][1], frame));
  return out;
}

function pitchRingOf(feature) {
  if (feature && feature.pad && feature.pad.length >= 3) return feature.pad;
  return feature && feature.coords;
}

async function scanVehicles(features, frame, buildings, imgBuf) {
  const list = features || [];
  const scanned = { pitch: {}, cars: {}, boats: {}, homes: {}, semis: {}, docks: [], docksReady: false };
  let wantPlate = needsPitchImage(list);
  const dockRings = [];
  const holes = [];
  for (let b = 0; b < (buildings || []).length; b++) {
    const px = buildings[b] && buildings[b].ringPx;
    if (!px || px.length < 3) continue;
    const ll = pxRingToLonLat(px, frame);
    if (!ll || ll.length < 4) continue;
    const a = ll[0];
    const end = ll[ll.length - 1];
    if (a[0] !== end[0] || a[1] !== end[1]) ll.push([a[0], a[1]]);
    holes.push(ll);
    if (roofWantsDocks([px], frame)) dockRings.push(ll);
  }
  if (dockRings.length) wantPlate = true;
  for (let i = 0; i < list.length; i++) {
    const kind = list[i] && list[i].kind;
    if (kind === "car" || kind === "marina" || kind === "mobile-park" || kind === "truck-lot" || kind === "trailer-candidate") {
      wantPlate = true;
    }
  }
  if (!wantPlate || !imgBuf) return { scanned, plate: null };
  const decoded = await runOne("decode-plate", { jpeg: Buffer.from(imgBuf) });
  const shared = sharePlate(decoded);
  if (!shared) return { scanned, plate: null };
  const jobs = [];
  const carPlans = [];
  for (let i = 0; i < list.length; i++) {
    const feature = list[i];
    if (!feature) continue;
    const kind = feature.kind;
    if (kind === "rv" || kind === "trailer-candidate") {
      const ring = pitchRingOf(feature);
      if (ring && ring.length >= 3) {
        jobs.push({ op: "pitch", key: ringKey(ring), ring, frame, buffer: shared.buffer, width: shared.width, height: shared.height });
      }
    } else if (kind === "car" && feature.coords) {
      const plan = carHitRows(feature.coords, frame, shared);
      const key = ringKey(feature.coords);
      if (!plan) {
        scanned.cars[key] = [];
      } else {
        const chunks = splitList(plan.ys, threadCount());
        const start = jobs.length;
        for (let c = 0; c < chunks.length; c++) {
          jobs.push({
            op: "car-hits",
            key,
            ring: feature.coords,
            frame,
            buffer: shared.buffer,
            width: shared.width,
            height: shared.height,
            ys: chunks[c],
          });
        }
        carPlans.push({ key, plan, start, count: chunks.length });
      }
    } else if (kind === "marina" && feature.coords) {
      jobs.push({ op: "boats", key: ringKey(feature.coords), ring: feature.coords, frame, buffer: shared.buffer, width: shared.width, height: shared.height });
    } else if (kind === "mobile-park" && feature.coords) {
      jobs.push({ op: "homes", key: ringKey(feature.coords), ring: feature.coords, frame, buffer: shared.buffer, width: shared.width, height: shared.height });
    } else if (kind === "truck-lot" && feature.coords) {
      const lotHoles = [];
      for (let h = 0; h < list.length; h++) {
        if (list[h] && list[h].kind === "building-hole" && list[h].coords) lotHoles.push(list[h].coords);
      }
      jobs.push({
        op: "semis",
        key: ringKey(feature.coords),
        ring: feature.coords,
        frame,
        holes: lotHoles,
        buffer: shared.buffer,
        width: shared.width,
        height: shared.height,
      });
    }
  }
  if (dockRings.length) {
    jobs.push({
      op: "docks",
      rings: dockRings,
      holes,
      frame,
      buffer: shared.buffer,
      width: shared.width,
      height: shared.height,
    });
  }
  const results = jobs.length ? await runTiles("vehicle-job", jobs) : [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const value = results[i] && results[i].value;
    if (job.op === "pitch") scanned.pitch[job.key] = value == null ? null : value;
    else if (job.op === "boats") scanned.boats[job.key] = value || [];
    else if (job.op === "homes") scanned.homes[job.key] = value || [];
    else if (job.op === "semis") scanned.semis[job.key] = value || [];
    else if (job.op === "docks") {
      scanned.docks = value || [];
      scanned.docksReady = true;
    }
  }
  for (let i = 0; i < carPlans.length; i++) {
    const item = carPlans[i];
    const hits = [];
    for (let k = 0; k < item.count; k++) {
      const part = results[item.start + k];
      if (part && part.hits) hits.push.apply(hits, part.hits);
    }
    scanned.cars[item.key] = finishCarLayer(hits, frame, item.plan) || [];
  }
  return { scanned, plate: { width: shared.width, height: shared.height, buffer: shared.buffer } };
}

async function outdoorParallel(args) {
  const { planOutdoor } = require("./outdoor-clutter");
  const features = (args && args.features) || [];
  const frame = args && args.frame;
  let scanned = null;
  let plate = null;
  try {
    const ready = await scanVehicles(features, frame, args.buildings, args.imgBuf);
    scanned = ready.scanned;
    plate = ready.plate;
  } catch {
    scanned = null;
    plate = null;
  }
  if (!plate && args && args.imgBuf && needsPitchImage(features)) {
    const decoded = decodePlate(Buffer.from(args.imgBuf));
    if (decoded && decoded.data) {
      const shared = new SharedArrayBuffer(decoded.data.byteLength);
      new Uint8Array(shared).set(decoded.data);
      plate = { width: decoded.width, height: decoded.height, buffer: shared };
    }
  }
  try {
    const raw = await runOne("plan-outdoor", {
      features,
      frame,
      buildings: args.buildings || [],
      parkingRings: args.parkingRings || [],
      segmentCaps: args.segmentCaps,
      terrain: plainData(args.terrain),
      scanned,
      buffer: plate && plate.buffer,
      width: plate && plate.width,
      height: plate && plate.height,
    });
    if (typeof raw === "string") return JSON.parse(raw);
    return raw;
  } catch (err) {
    if (process.env.OPENCLUTTER_STAGE_LOG) {
      process.stderr.write("stage plan-outdoor-worker " + (err && err.message ? err.message : err) + "\n");
    }
    const { restoreElevation, demUnderFootprint } = require("./terrain");
    const terrain = args.terrain ? restoreElevation(plainData(args.terrain)) : null;
    return runOne("plan-outdoor", {
      features,
      frame,
      buildings: args.buildings || [],
      parkingRings: args.parkingRings || [],
      segmentCaps: args.segmentCaps,
      terrain: null,
      scanned,
      buffer: plate && plate.buffer,
      width: plate && plate.width,
      height: plate && plate.height,
      slopeFallback: true,
    }).then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw));
  }
}

module.exports = {
  threadCount,
  fillInWorker,
  treePairsParallel,
  outdoorParallel,
};
