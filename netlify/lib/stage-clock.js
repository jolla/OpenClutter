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
  const substages = {};
  const names = Object.keys(spans);
  for (let i = 0; i < names.length; i++) {
    if (names[i].slice(0, 4) === "sub:") substages[names[i].slice(4)] = spans[names[i]] | 0;
  }
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
    usaStructuresMs: spans.usaStructures | 0,
    outdoorMs: spans.outdoor | 0,
    buildingDetailMs: spans.buildingDetail | 0,
    coreMs: spans.core | 0,
    optionalJoinMs: spans.optionalJoin | 0,
    imageryMetaMs: spans.imageryMeta | 0,
    nlcdCanopyMs: spans.nlcdCanopy | 0,
    aerialFetchMs: spans.aerialFetch | 0,
    aerialStitchMs: spans.aerialStitch | 0,
    treeDetectMs: spans.tree | 0,
    vehicleDetectMs: spans.vehicle | 0,
    jsonBuildMs: spans.jsonBuild | 0,
    zipMs: spans.zip | 0,
    totalMs: clock ? Date.now() - clock.t0 : 0,
    cached,
    areaM2: more.areaM2 > 0 ? Math.round(more.areaM2) : 0,
    substages,
  };
}

function elapsedSec(clock, t) {
  const t0 = clock && clock.t0 > 0 ? clock.t0 : t;
  return ((t - t0) / 1000).toFixed(1);
}

function logSubstage(event, name, extra) {
  let line = "substage " + event + " " + name;
  if (extra) line += " " + extra;
  process.stderr.write(line + "\n");
}

function logSource(event, name, extra) {
  let line = "source " + event + " " + name;
  if (extra) line += " " + extra;
  process.stderr.write(line + "\n");
}

/**
 * Prefix source fetch: logs start and done with duration and elapsed
 * time from export start, and records the span on the clock.
 */
async function timeSource(name, fn, extra) {
  const clock = als.getStore();
  const t0 = Date.now();
  const startExtra = "elapsed " + elapsedSec(clock, t0) + "s" + (extra ? " " + extra : "");
  logSource("start", name, startExtra);
  const endSpan = beginSpan(name);
  try {
    return await fn();
  } finally {
    endSpan();
    const now = Date.now();
    logSource(
      "done",
      name,
      "duration " + ((now - t0) / 1000).toFixed(1) + "s elapsed " + elapsedSec(clock, now) + "s"
    );
  }
}

function logPrefixSummary(label) {
  const clock = als.getStore();
  if (!clock) return;
  const names = Object.keys(clock.spans).filter((n) => n.slice(0, 4) !== "sub:");
  names.sort();
  const parts = names.map((n) => n + " " + ((clock.spans[n] || 0) / 1000).toFixed(1) + "s");
  const line =
    "source summary " +
    (label || "prefix") +
    " elapsed " +
    elapsedSec(clock, Date.now()) +
    "s" +
    (parts.length ? " " + parts.join(" ") : "");
  process.stderr.write(line + "\n");
}

function timeSubstageSync(name, fn, extra) {
  const t0 = Date.now();
  logSubstage("start", name, extra);
  const endSpan = beginSpan("sub:" + name);
  try {
    return fn();
  } finally {
    endSpan();
    logSubstage("done", name, "duration " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  }
}

async function timeSubstage(name, fn, extra) {
  const t0 = Date.now();
  logSubstage("start", name, extra);
  const endSpan = beginSpan("sub:" + name);
  try {
    return await fn();
  } finally {
    endSpan();
    logSubstage("done", name, "duration " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  }
}

module.exports = {
  createClock,
  enter,
  beginSpan,
  timeSpan,
  timeSpanSync,
  timeSubstage,
  timeSubstageSync,
  timeSource,
  logSource,
  logPrefixSummary,
  logSubstage,
  noteCache,
  snapshot,
};
