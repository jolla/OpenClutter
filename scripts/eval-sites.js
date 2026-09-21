#!/usr/bin/env node
"use strict";

/**
 * Autonomous site eval — no Hamina, no Jerry.
 *
 *   npm run eval                 cached fixtures, prefer-NLCD (CI gate)
 *   npm run eval -- --legacy     PR #8 RGB-when-NLCD-empty (expected FAIL)
 *   npm run eval -- --compare-legacy
 *   npm run eval -- --live       hit Esri + NLCD
 *   npm run eval -- --live --write-fixtures
 */

const { runEval, parseArgs, formatRow } = require("../test/eval/run");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = await runEval(args);
  let failed = 0;
  console.log("site                     policy                 gate  scores");
  for (const r of results) {
    console.log(formatRow(r.exportStats));
    if (r.exportStats.gate.failures.length) {
      for (const f of r.exportStats.gate.failures) console.log("  - " + f);
    }
    if (!args.compareLegacy && !r.gate.ok) failed++;
    if (args.compareLegacy && r.exportStats.rgbPolicy === "prefer-nlcd" && !r.gate.ok) failed++;
  }
  if (args.compareLegacy) {
    const legacyFail = results.filter((r) => r.exportStats.rgbPolicy === "force-rgb" && !r.gate.ok);
    const preferPass = results.filter((r) => r.exportStats.rgbPolicy === "prefer-nlcd" && r.gate.ok);
    console.log(
      `\nforce-rgb (old RGB carpet) failures ${legacyFail.length}/${results.filter((r) => r.exportStats.rgbPolicy === "force-rgb").length}; ` +
        `prefer-nlcd passes ${preferPass.length}/${results.filter((r) => r.exportStats.rgbPolicy === "prefer-nlcd").length}`
    );
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
