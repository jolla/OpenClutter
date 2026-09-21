"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const T = require("../netlify/lib/tree-source");
const { loadSitesIndex, loadFixture, runLoaded } = require("./eval/run");

describe("eval gate (cached fixtures, no Hamina)", () => {
  it("fails the old RGB-carpet path on Oak Creek parking/lawn", () => {
    const site = loadSitesIndex().find((s) => s.id === "oak-creek-commercial");
    const loaded = loadFixture(site);
    const legacy = runLoaded(loaded, { rgbPolicy: T.RGB_POLICY_FORCE_RGB });
    assert.equal(legacy.exportStats.trees.treesSource, "imagery-rgb");
    assert.ok(
      legacy.exportStats.trees.pavementTreeFrac > 0.15,
      `expected RGB over-detect on pavement, got ${legacy.exportStats.trees.pavementTreeFrac}`
    );
    assert.equal(legacy.gate.ok, false);
    assert.ok(legacy.exportStats.gate.failures.some((f) => f.includes("pavementTreeFrac")));
  });

  it("passes prefer-nlcd on both fixtures with major MS roofs kept", () => {
    for (const site of loadSitesIndex()) {
      const loaded = loadFixture(site);
      const next = runLoaded(loaded, { rgbPolicy: T.RGB_POLICY_PREFER_NLCD });
      assert.equal(
        next.gate.ok,
        true,
        `${site.id}: ${next.exportStats.gate.failures.join("; ")}`
      );
      assert.equal(next.exportStats.trees.treesSource, "nlcd-canopy");
      assert.ok(next.exportStats.buildings.largeRoofKeepRate === 1 || next.exportStats.buildings.largeRoofs === 0);
      assert.equal(next.exportStats.buildings.missingLargeRoofs, 0);
      if (site.id === "oak-creek-commercial") {
        assert.ok(next.exportStats.coverage.buildingsKept >= 10, "Oak Creek commercial roofs");
        assert.ok(
          next.exportStats.buildings.eligibleFootprints >= 10,
          "major MS footprints present"
        );
      }
    }
  });

  it("writes alignment-overlay.svg and export-stats.json from the zip", () => {
    const site = loadSitesIndex()[0];
    const result = runLoaded(loadFixture(site), { rgbPolicy: T.RGB_POLICY_PREFER_NLCD });
    const { unzipStore } = require("../netlify/lib/zip-store");
    const files = unzipStore(result.built.zip);
    assert.ok(files["alignment-overlay.svg"]);
    assert.ok(files["export-stats.json"]);
    assert.ok(files["VERIFY.txt"]);
    assert.match(files["alignment-overlay.svg"].toString(), /<polygon |<circle /);
    assert.match(files["VERIFY.txt"].toString(), /^attenuation_areas: \d+$/m);
  });
});

describe("fixture files are secret-free", () => {
  it("bbox JSON has no tokens", () => {
    const raw = fs.readFileSync(path.join(__dirname, "fixtures", "sites.json"), "utf8");
    assert.ok(!/token|secret|password|api[_-]?key/i.test(raw));
  });
});
