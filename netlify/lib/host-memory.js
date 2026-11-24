"use strict";

/**
 * Memory-limited hosts (1.3.93). A Netlify function has about 1 GB. The
 * Overture street read opened five themes with four row groups each at
 * once, about 1.7 GB even for a 300 m box, so the function was killed in
 * the footprint read and the job stayed running. On such a host the
 * parquet reads go one at a time and keep a small range cache. Fly and
 * the benches keep their concurrency.
 */
function functionMemoryMb() {
  const n = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lowMemoryHost() {
  const force = String(process.env.OPENCLUTTER_LOW_MEMORY || "");
  if (force === "1") return true;
  if (force === "0") return false;
  const mb = functionMemoryMb();
  return mb > 0 && mb <= 3072;
}

/** Parallel reads allowed: `normal` on a roomy host, 1 on a small one. */
function readConcurrency(normal) {
  return lowMemoryHost() ? 1 : normal;
}

module.exports = { functionMemoryMb, lowMemoryHost, readConcurrency };
