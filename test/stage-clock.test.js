"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const stageClock = require("../netlify/lib/stage-clock");

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = function (chunk, enc, cb) {
    chunks.push(String(chunk));
    if (typeof enc === "function") enc();
    else if (typeof cb === "function") cb();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stderr.write = orig;
    })
    .then((value) => ({ value, text: chunks.join("") }));
}

describe("prefix source timing logs", () => {
  it("logs start and done with duration and elapsed, and records the span", async () => {
    stageClock.enter(stageClock.createClock());
    const { value, text } = await captureStderr(async () => {
      const out = await stageClock.timeSource("lidar", async () => {
        await new Promise((r) => setTimeout(r, 40));
        return 7;
      });
      stageClock.logPrefixSummary("after-optional");
      return out;
    });
    assert.equal(value, 7);
    assert.match(text, /source start lidar elapsed 0\.0s/);
    assert.match(text, /source done lidar duration 0\.\ds elapsed 0\.\ds/);
    assert.match(text, /source summary after-optional elapsed 0\.\ds lidar 0\.\ds/);
    const snap = stageClock.snapshot();
    assert.ok(snap.lidarMs >= 30, "lidarMs " + snap.lidarMs);
    assert.ok(snap.totalMs >= snap.lidarMs);
  });

  it("still logs when no export clock is entered", async () => {
    // Leave any prior clock behind so this path matches a bare library call.
    const { AsyncLocalStorage } = require("node:async_hooks");
    const { value, text } = await captureStderr(async () => {
      return stageClock.timeSource("microsoft", async () => "ok");
    });
    assert.equal(value, "ok");
    assert.match(text, /source start microsoft elapsed 0\.0s/);
    assert.match(text, /source done microsoft duration 0\.0s elapsed 0\.0s/);
  });
});
