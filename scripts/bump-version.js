"use strict";

// Next build number: 1.2.1 -> 1.2.2. Dev and prod share one 1.2.x line, so
// the patch number moves; a minor or major change is set by hand.
// Updates package.json, package-lock.json, test/version.test.js, then stamps the page.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!m) {
  console.error("unexpected package.json version: " + pkg.version);
  process.exit(1);
}
const cur = pkg.version;
const next = process.argv[2] || `${m[1]}.${m[2]}.${+m[3] + 1}`;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error("bad version: " + next);
  process.exit(1);
}
function swap(file, from, to, count) {
  const p = path.join(root, file);
  let text = fs.readFileSync(p, "utf8");
  let n = 0;
  text = text.replace(from, (s) => (count && n >= count ? s : (n++, to(s))));
  fs.writeFileSync(p, text);
}
const esc = cur.replace(/\./g, "\\.");
swap("package.json", new RegExp(`"version": "${esc}"`), () => `"version": "${next}"`, 1);
swap("package-lock.json", new RegExp(`"version": "${esc}"`, "g"), () => `"version": "${next}"`, 2);
swap("test/version.test.js", new RegExp(esc, "g"), () => next);
require("./stamp-version.js");
console.log(cur + " -> " + next);
