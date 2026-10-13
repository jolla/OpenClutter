"use strict";

/**
 * Timings for OPENCLUTTER_PROFILE=1. The export is unchanged when that
 * variable is unset or any other value. Workers inherit the env, so a
 * tile log includes the thread that ran it.
 */

const os = require("node:os");

function profileOn() {
  return process.env.OPENCLUTTER_PROFILE === "1";
}

const buckets = new Map();

function reset() {
  buckets.clear();
}

function add(name, ms) {
  if (!(ms >= 0)) return;
  let row = buckets.get(name);
  if (!row) {
    row = { n: 0, ms: 0, max: 0 };
    buckets.set(name, row);
  }
  row.n += 1;
  row.ms += ms;
  if (ms > row.max) row.max = ms;
}

function now() {
  return process.hrtime.bigint();
}

function msSince(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function line() {
  if (!buckets.size) return "";
  const parts = [];
  for (const [name, row] of buckets) {
    parts.push(
      name + " n=" + row.n + " ms=" + row.ms.toFixed(1) + " max=" + row.max.toFixed(1)
    );
  }
  parts.sort();
  return parts.join(" | ");
}

function cpuTimes() {
  const list = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i].times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, n: list.length };
}

function cpuUtil(before, after) {
  if (!before || !after) return 0;
  const idle = after.idle - before.idle;
  const total = after.total - before.total;
  if (!(total > 0)) return 0;
  const busy = 1 - idle / total;
  if (busy < 0) return 0;
  if (busy > 1) return 1;
  return busy;
}

function cpuUtilLine(before, after) {
  const util = cpuUtil(before, after);
  const n = after && after.n ? after.n : 0;
  return "cpuUtil " + (util * 100).toFixed(1) + "% of " + n + " cpus";
}

module.exports = {
  profileOn,
  reset,
  add,
  now,
  msSince,
  line,
  cpuTimes,
  cpuUtil,
  cpuUtilLine,
};
