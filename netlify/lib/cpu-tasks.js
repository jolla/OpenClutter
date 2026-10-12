"use strict";

/**
 * Tasks the export pool runs off the main thread. Each task is a
 * pure call into the existing detectors. Geometry is only what those
 * detectors already trace.
 */

function plateFrom(payload) {
  if (!payload) return null;
  if (payload.plate && payload.plate.data) return payload.plate;
  const buffer = payload.buffer;
  const width = payload.width | 0;
  const height = payload.height | 0;
  if (!buffer || !(width > 1) || !(height > 1)) return null;
  return { width, height, data: new Uint8Array(buffer) };
}

function treePairsTask(payload) {
  const { treePairsFromPoints } = require("./vegetation");
  const { restoreElevation, demUnderFootprint } = require("./terrain");
  const { sampleChmGrid } = require("./canopy-height");
  const terrain = payload.terrain ? restoreElevation(payload.terrain) : null;
  const grid = payload.chmGrid || null;
  const opts = Object.assign({}, payload.opts, {
    chmGrid: grid,
    slopeTop: terrain ? demUnderFootprint(terrain) : null,
    heightSample: grid ? (lon, lat) => sampleChmGrid(grid, lon, lat) : null,
  });
  return treePairsFromPoints(payload.treePoints, payload.frame, payload.buildingAabbs, payload.affine, opts);
}

function treesToOiTask(payload) {
  const { treesToOi } = require("./pipeline");
  const frame = payload.frame || {};
  return treesToOi(payload.areas || [], frame.imgW, frame.imgH, frame.mpuX);
}

function spin(payload) {
  const ms = payload && payload.ms > 0 ? payload.ms : 200;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* Block this worker, not the export heartbeat. */
  }
  return { spun: ms };
}

function canopyTile(payload) {
  const { blockerFromRings } = require("./vegetation");
  const { crownsForExport } = require("./canopy-height");
  const frame = payload.frame;
  const ringBlock = blockerFromRings(frame, payload.buildingRings, payload.maskRings, payload.maskPolygons);
  const blocked = ringBlock ? (lon, lat) => ringBlock(lon, lat) : null;
  const packed = crownsForExport(payload.grid, {
    blocked,
    hits: payload.hits || [],
    maxPolygons: 1000000,
  });
  return { crowns: (packed && packed.crowns) || [] };
}

function foliageAssemble(payload) {
  const { assembleFoliage } = require("./vegetation");
  const { restoreElevation, demUnderFootprint } = require("./terrain");
  const { sampleChmGrid } = require("./canopy-height");
  const terrain = payload.terrain ? restoreElevation(payload.terrain) : null;
  const slopeTop = terrain ? demUnderFootprint(terrain) : null;
  const grid = payload.chmGrid;
  const opts = {
    buildingRings: payload.buildingRings,
    maskRings: payload.maskRings,
    maskPolygons: payload.maskPolygons,
    buildingBufferM: payload.buildingBufferM,
    skipWood: true,
    slopeTop,
    heightSample: grid ? (lon, lat) => sampleChmGrid(grid, lon, lat) : null,
  };
  const pack = assembleFoliage(payload.polygons, payload.frame, null, payload.affine, opts, {
    coarsened: false,
    foliageDropped: 0,
    foliageGeometry: payload.polygons && payload.polygons.length ? "chm-contour" : "none",
  });
  const { treesToOi } = require("./pipeline");
  const frame = payload.frame || {};
  pack.treeOi = treesToOi(pack.oiAreas, frame.imgW, frame.imgH, frame.mpuX);
  return pack;
}

function fillCanopy(payload) {
  const { fillCanopyGaps } = require("./canopy-fill");
  const image = plateFrom(payload);
  return fillCanopyGaps(payload.grid, {
    frame: payload.frame,
    image,
    classes: payload.classes,
    openRuns: payload.openRuns,
  });
}

function decodePlateTask(payload) {
  const { decodePlate } = require("./vehicle-track");
  const jpeg = payload && payload.jpeg ? Buffer.from(payload.jpeg) : null;
  const plate = decodePlate(jpeg);
  if (!plate || !plate.data) return null;
  return { width: plate.width, height: plate.height, data: Buffer.from(plate.data) };
}

function vehicleJob(payload) {
  const track = require("./vehicle-track");
  const plate = plateFrom(payload);
  const op = payload.op;
  if (op === "car-hits") return { hits: track.occupiedCarLayerWork(payload.ring, payload.frame, plate, payload.ys) };
  if (op === "pitch") return { value: track.pitchVehicle(payload.ring, payload.frame, plate) };
  if (op === "boats") return { value: track.boatsOnWaterWork(payload.ring, payload.frame, plate) };
  if (op === "homes") return { value: track.mobileHomesInRingWork(payload.ring, payload.frame, plate) };
  if (op === "semis") return { value: track.semisInLotWork(payload.ring, payload.frame, plate, payload.holes) };
  if (op === "docks") return { value: track.semisAtDocksWork(payload.rings, payload.frame, plate, payload.holes) };
  return { value: null };
}

function planOutdoorTask(payload) {
  const { planOutdoor } = require("./outdoor-clutter");
  const { restoreElevation, demUnderFootprint } = require("./terrain");
  const { outdoorToOi } = require("./pipeline");
  const terrain = payload.terrain ? restoreElevation(payload.terrain) : null;
  const slopeTop = terrain ? demUnderFootprint(terrain) : null;
  const plate = plateFrom(payload);
  const planned = planOutdoor({
    features: payload.features,
    frame: payload.frame,
    slopeTop,
    buildings: payload.buildings,
    parkingRings: payload.parkingRings,
    segmentCaps: payload.segmentCaps,
    vehiclePlate: plate,
    scanned: payload.scanned,
  });
  const frame = payload.frame || {};
  const converted = outdoorToOi(planned.items, frame.imgW, frame.imgH, frame.mpuX);
  return JSON.stringify({ planned, converted });
}

function runTask(task, payload) {
  if (task === "trees-to-oi") return treesToOiTask(payload);
  if (task === "spin") return spin(payload);
  if (task === "tree-pairs") return treePairsTask(payload);
  if (task === "canopy-tile") return canopyTile(payload);
  if (task === "foliage-assemble") return foliageAssemble(payload);
  if (task === "fill-canopy") return fillCanopy(payload);
  if (task === "decode-plate") return decodePlateTask(payload);
  if (task === "vehicle-job") return vehicleJob(payload);
  if (task === "plan-outdoor") return planOutdoorTask(payload);
  throw new Error("Unknown worker task.");
}

module.exports = { runTask };
