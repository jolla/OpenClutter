"use strict";

// Child process for a time-budgeted polygon-clipping union. The parent
// kills this process when the boolean exceeds the stand's budget so a
// hang cannot stall Trees. Stdin is a JSON array of clip geoms.
const path = require("path");
const polygonClipping = require(path.join(__dirname, "..", "..", "node_modules", "polygon-clipping"));

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  const geoms = JSON.parse(raw);
  if (!Array.isArray(geoms) || !geoms.length) {
    process.stdout.write("null");
    return;
  }
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
  process.stdout.write(JSON.stringify(list[0] == null ? null : list[0]));
});
