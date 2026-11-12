"use strict";

// Child process for mergeSlivers. The parent kills this process if a
// sliver union hangs, and ships the unmerged seats instead.
process.env.OPENCLUTTER_MERGE_INPROCESS = "1";

const v8 = require("v8");
const { mergeSliversWork } = require("./vegetation");

const chunks = [];
process.stdin.on("data", (chunk) => {
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  const t0 = Date.now();
  try {
    const msg = v8.deserialize(Buffer.concat(chunks));
    const seats = mergeSliversWork(msg.seats, msg.frame || {});
    process.stdout.write(v8.serialize({ seats, ms: Date.now() - t0 }));
  } catch (err) {
    process.stdout.write(
      v8.serialize({ error: String(err && err.message ? err.message : err), ms: Date.now() - t0 })
    );
    process.exitCode = 1;
  }
});
