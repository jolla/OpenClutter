"use strict";

/**
 * Wall-clock spans for one export. Overlapping work on the same name
 * counts once, from the first start to the last finish. A later call
 * adds another span. The clock is empty until an export enters it.
 */

const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();

function createClock() {
  return {
    t0: Date.now(),
    spans: Object.create(null),
    open: Object.create(null),
    cached: Object.create(null),
  };
}

function enter(clock) {
  als.enterWith(clock || createClock());
  return als.getStore();
}

function beginSpan(name) {
  const clock = als.getStore();
  if (!clock || !name) return function () {};
  let slot = clock.open[name];
  if (!slot) {
    slot = { n: 0, t: 0 };
    clock.open[name] = slot;
  }
  if (slot.n === 0) slot.t = Date.now();
  slot.n += 1;
  let closed = false;
  return function endSpan() {
    if (closed) return;
    closed = true;
    slot.n -= 1;
    if (slot.n > 0) return;
    slot.n = 0;
    const ms = Date.now() - slot.t;
    clock.spans[name] = (clock.spans[name] || 0) + (ms > 0 ? ms : 0);
  };
}

function timeSpanSync(name, fn) {
  const end = beginSpan(name);
  try {
    return fn();
  } finally {
    end();
  }
}

async function timeSpan(name, fn) {
  const end = beginSpan(name);
  try {
    return await fn();
  } finally {
    end();
  }
}

function noteCache(source, hit) {
  const clock = als.getStore();
  if (!clock || !source) return;
  const slot = clock.cached[source] || { hits: 0, misses: 0 };
  if (hit) slot.hits += 1;
  else slot.misses += 1;
  clock.cached[source] = slot;
}

function snapshot(extra) {
  const clock = als.getStore();
  const spans = (clock && clock.spans) || {};
  const cached = [];
  if (clock && clock.cached) {
    const names = Object.keys(clock.cached);
    for (let i = 0; i < names.length; i++) {
      if (clock.cached[names[i]].hits > 0) cached.push(names[i]);
    }
  }
  cached.sort();
  const more = extra || {};
  return {
    geocodeMs: spans.geocode | 0,
    footprints: {
      osmMs: spans.osm | 0,
      overpassMs: spans.overpass | 0,
      overtureMs: spans.overture | 0,
      microsoftMs: spans.microsoft | 0,
    },
    demMs: spans.dem | 0,
    canopyMs: spans.canopy | 0,
    worldcoverMs: spans.worldcover | 0,
    lidarMs: spans.lidar | 0,
    aerialFetchMs: spans.aerialFetch | 0,
    aerialStitchMs: spans.aerialStitch | 0,
    treeDetectMs: spans.tree | 0,
    vehicleDetectMs: spans.vehicle | 0,
    jsonBuildMs: spans.jsonBuild | 0,
    zipMs: spans.zip | 0,
    totalMs: clock ? Date.now() - clock.t0 : 0,
    cached,
    areaM2: more.areaM2 > 0 ? Math.round(more.areaM2) : 0,
  };
}

module.exports = {
  createClock,
  enter,
  beginSpan,
  timeSpan,
  timeSpanSync,
  noteCache,
  snapshot,
};
