"use strict";

// Child process for one 1.3.26 slope split. The parent kills this process
// if the stand exceeds the wall-clock budget, so a hang cannot stall Trees.
// Stdin and stdout are v8-serialized { terrain, ring, opts } / { pieces, ms }
// so coordinates stay bit-identical to in-process 1.3.26.
process.env.OPENCLUTTER_SPLIT_INPROCESS = "1";

const v8 = require("v8");
const { splitRingByFloor1326 } = require("./terrain");

const chunks = [];
process.stdin.on("data", (chunk) => {
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  const t0 = Date.now();
  try {
    const msg = v8.deserialize(Buffer.concat(chunks));
    const pieces = splitRingByFloor1326(msg.terrain, msg.ring, msg.opts || {});
    process.stdout.write(v8.serialize({ pieces, ms: Date.now() - t0 }));
  } catch (err) {
    process.stdout.write(
      v8.serialize({ error: String(err && err.message ? err.message : err), ms: Date.now() - t0 })
    );
    process.exitCode = 1;
  }
});
