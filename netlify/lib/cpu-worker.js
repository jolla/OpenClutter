"use strict";

const { parentPort, threadId, workerData } = require("node:worker_threads");
const { runTask } = require("./cpu-tasks");
const profile = require("./profile-log");

const poolIndex = workerData && workerData.index != null ? workerData.index : threadId;

parentPort.on("message", (msg) => {
  if (!msg || msg.id == null) return;
  const startedAt = Date.now();
  const profiling = profile.profileOn();
  const cpu0 = profiling ? process.cpuUsage() : null;
  if (profiling) profile.reset();
  Promise.resolve()
    .then(() => {
      const mode = require("./export-mode");
      mode.setSiteTypes(msg.siteTypes !== false);
      mode.setShadowTrailers(msg.shadowTrailers === true);
      mode.setMergeTiles(msg.mergeTiles === true);
      return runTask(msg.task, msg.payload);
    })
    .then(
      (result) => {
        if (profiling) {
          const cpu = process.cpuUsage(cpu0);
          const tile = msg.payload && msg.payload.tileId != null ? msg.payload.tileId : msg.task;
          const phases = profile.line();
          console.log(
            "profile thread " +
              poolIndex +
              " tile " +
              tile +
              " wallMs " +
              (Date.now() - startedAt) +
              " cpuUserMs " +
              (cpu.user / 1000).toFixed(1) +
              " cpuSysMs " +
              (cpu.system / 1000).toFixed(1) +
              (phases ? " " + phases : "")
          );
        }
        parentPort.postMessage({
          id: msg.id,
          ok: true,
          result,
          threadId: poolIndex,
          startedAt,
          finishedAt: Date.now(),
        });
      },
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
