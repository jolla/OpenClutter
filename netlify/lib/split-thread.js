"use strict";

// Persistent worker thread for slope splits and sliver merges. It replaces
// one child process per stand. The parent waits on a shared flag with the
// same wall-clock budget and terminates this thread on a hang, so a stuck
// boolean still cannot stall Trees. Messages are structured clones (the
// same v8 serializer the child used), so coordinates stay bit-identical.
process.env.OPENCLUTTER_SPLIT_INPROCESS = "1";
process.env.OPENCLUTTER_MERGE_INPROCESS = "1";

const { parentPort, workerData } = require("worker_threads");

const flag = new Int32Array(workerData.sab);
const reply = workerData.port;
let terrainId = 0;
let terrainSnap = null;

function answer(msg) {
  try {
    reply.postMessage(msg);
  } catch (err) {
    reply.postMessage({ seq: msg.seq, error: String(err && err.message ? err.message : err) });
  }
  Atomics.store(flag, 0, msg.seq);
  Atomics.notify(flag, 0);
}

parentPort.on("message", (msg) => {
  const t0 = Date.now();
  try {
    if (msg.op === "split") {
      if (msg.terrain !== undefined) {
        terrainId = msg.terrainId;
        terrainSnap = msg.terrain;
      }
      if (terrainId !== msg.terrainId) {
        answer({ seq: msg.seq, error: "terrain-missing", ms: Date.now() - t0 });
        return;
      }
      const { splitRingByFloor1326 } = require("./terrain");
      const pieces = splitRingByFloor1326(terrainSnap, msg.ring, msg.opts || {});
      answer({ seq: msg.seq, pieces, ms: Date.now() - t0 });
    } else if (msg.op === "merge") {
      const { mergeSliversWork } = require("./vegetation");
      const seats = mergeSliversWork(msg.seats, msg.frame || {});
      answer({ seq: msg.seq, seats, ms: Date.now() - t0 });
    } else if (msg.op === "hang" && process.env.OPENCLUTTER_SPLIT_THREAD_TEST === "1") {
      // Test only: a stand that never returns.
      for (;;) {}
    } else {
      answer({ seq: msg.seq, error: "unknown op", ms: Date.now() - t0 });
    }
  } catch (err) {
    answer({ seq: msg.seq, error: String(err && err.message ? err.message : err), ms: Date.now() - t0 });
  }
});
