"use strict";

// 1.3.93: a Netlify run whose function dies cannot write its own error.
// export-status fails it from its beat so the page stops waiting.
const test = require("node:test");
const assert = require("node:assert/strict");
const { stalledJobPatch, NETLIFY_SILENCE_MS, NETLIFY_LIMIT_MS, LEGACY_LIMIT_MS } = require("../netlify/lib/job-watchdog");
const stageClock = require("../netlify/lib/stage-clock");

const T = 1_800_000_000_000;

test("a live Netlify run is left alone", () => {
  const job = { state: "running", worker: "netlify", stage: "Fetching footprints", createdAt: T - 60000, netlifyStartedAt: T - 60000, netlifyBeatAt: T - 5000 };
  assert.equal(stalledJobPatch(job, T), null);
});

test("a Netlify run with no beat for two minutes fails with a clear error", () => {
  const job = { state: "running", worker: "netlify", stage: "Fetching footprints", createdAt: T - 300000, netlifyStartedAt: T - 300000, netlifyBeatAt: T - NETLIFY_SILENCE_MS - 1 };
  const p = stalledJobPatch(job, T);
  assert.equal(p.state, "error");
  assert.equal(p.stoppedReason, "heartbeat-stale");
  assert.match(p.error, /stopped during Fetching footprints\. Export again/);
});

test("a Netlify run past the 15 minute function clock fails even if beats look fresh", () => {
  const job = { state: "running", worker: "netlify", stage: "Trees", createdAt: T - NETLIFY_LIMIT_MS - 5000, netlifyStartedAt: T - NETLIFY_LIMIT_MS - 1, netlifyBeatAt: T - 1000 };
  assert.equal(stalledJobPatch(job, T).stoppedReason, "deadline");
});

test("a legacy run with no beat fails after the hard limit; terminal and waiting jobs never do", () => {
  assert.equal(stalledJobPatch({ state: "running", stage: "x", createdAt: T - LEGACY_LIMIT_MS - 1 }, T).stoppedReason, "export-deadline");
  assert.equal(stalledJobPatch({ state: "running", stage: "x", createdAt: T - LEGACY_LIMIT_MS + 1000 }, T), null);
  assert.equal(stalledJobPatch({ state: "queued", concurrencyWait: true, createdAt: T - LEGACY_LIMIT_MS * 2 }, T), null);
  assert.equal(stalledJobPatch({ state: "done", createdAt: T - LEGACY_LIMIT_MS * 2 }, T), null);
  assert.equal(stalledJobPatch({ state: "error", createdAt: T - LEGACY_LIMIT_MS * 2 }, T), null);
});

test("a Fly run with a fresh heartbeat is not failed by the Netlify silence rule", () => {
  const job = { state: "running", worker: "fly", stage: "Trees", createdAt: T - 300000, heartbeatAt: T - 2000 };
  assert.equal(stalledJobPatch(job, T), null);
});

test("openSpans names the stages still open on the last export clock", async () => {
  stageClock.enter();
  let release;
  const hold = new Promise((r) => (release = r));
  const p = stageClock.timeSpan("overture", () => hold);
  const open = stageClock.openSpans();
  assert.ok(open.some(([name]) => name === "overture"));
  release();
  await p;
  assert.ok(!stageClock.openSpans().some(([name]) => name === "overture"));
});
