"use strict";

const { parentPort, threadId, workerData } = require("node:worker_threads");
const { runTask } = require("./cpu-tasks");

const poolIndex = workerData && workerData.index != null ? workerData.index : threadId;

parentPort.on("message", (msg) => {
  if (!msg || msg.id == null) return;
  const startedAt = Date.now();
  Promise.resolve()
    .then(() => runTask(msg.task, msg.payload))
    .then(
      (result) =>
        parentPort.postMessage({
          id: msg.id,
          ok: true,
          result,
          threadId: poolIndex,
          startedAt,
          finishedAt: Date.now(),
        }),
      (err) =>
        parentPort.postMessage({
          id: msg.id,
          ok: false,
          error: err && err.message ? err.message : "worker failed",
          threadId: poolIndex,
          startedAt,
          finishedAt: Date.now(),
        })
    );
});
