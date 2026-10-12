"use strict";

const { parentPort } = require("node:worker_threads");
const { runTask } = require("./cpu-tasks");

parentPort.on("message", (msg) => {
  if (!msg || msg.id == null) return;
  Promise.resolve()
    .then(() => runTask(msg.task, msg.payload))
    .then(
      (result) => parentPort.postMessage({ id: msg.id, ok: true, result }),
      (err) =>
        parentPort.postMessage({
          id: msg.id,
          ok: false,
          error: err && err.message ? err.message : "worker failed",
        })
    );
});
