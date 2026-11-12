"use strict";

// Child process for a time-budgeted polygon-clipping boolean. The parent
// kills this process when the operation exceeds the ring's budget so a
// hang cannot stall Trees or a building floor split. Stdin is
// { op: "unionAll"|"union"|"intersection", args: ... }.
const path = require("path");
const polygonClipping = require(path.join(__dirname, "..", "..", "node_modules", "polygon-clipping"));

function unionAll(geoms) {
  if (!Array.isArray(geoms) || !geoms.length) return null;
  let list = geoms.slice();
  while (list.length > 1) {
    const next = [];
    for (let i = 0; i < list.length; i += 2) {
      if (i + 1 >= list.length) {
        next.push(list[i]);
        continue;
      }
      try {
        next.push(polygonClipping.union(list[i], list[i + 1]));
      } catch {
        next.push(list[i]);
        next.push(list[i + 1]);
      }
    }
    list = next;
  }
  return list[0] == null ? null : list[0];
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let out = null;
  try {
    const msg = JSON.parse(raw);
    const op = msg && msg.op;
    const args = msg && msg.args;
    if (op === "unionAll") out = unionAll(args);
    else if (op === "union") out = polygonClipping.union(...args);
    else if (op === "intersection") out = polygonClipping.intersection(args[0], args[1]);
  } catch {
    out = null;
  }
  process.stdout.write(JSON.stringify(out));
});
