"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const T = require("../netlify/lib/tree-source");
const { version: APP_VERSION } = require("../netlify/lib/version");
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
        // Pavement rejection removes the asphalt rings from the zip. Stacked
        // duplicates of one roof are one area now, so the count sits under the
        // old double-counted floor and still well above the MSBFP2-only export (48).
        assert.ok(
          next.exportStats.coverage.buildingsKept >= 68,
          `Oak Creek repro kept ${next.exportStats.coverage.buildingsKept}, MSBFP2-only export kept 48`
        );
        assert.ok(
          next.exportStats.buildings.eligibleFootprints >= 78,
          "major MS footprints present"
        );
        assert.ok(next.exportStats.buildings.roofProbes, "known white-roof probes");
        assert.equal(next.exportStats.buildings.roofProbes.missed.length, 0);
        assert.ok(next.exportStats.trees.roofTreeFrac <= 0.03);
        assert.ok(next.exportStats.heights.applicable);
        assert.ok(next.exportStats.heights.uniqueBuildingHeights >= 8);
        assert.ok(next.exportStats.heights.matchedFrac >= 0.9);
        assert.equal(next.exportStats.includeFoliage, false);
        assert.equal(next.exportStats.openIntentTrees.emitted, 0);
        assert.equal(next.exportStats.openIntentTrees.required, false);
        assert.equal(next.exportStats.compatibility.buildingsExact, true);
        assert.equal(next.exportStats.compatibility.customsOk, true);
        assert.equal(next.exportStats.compatibility.materials, 4);
        assert.equal(next.exportStats.compatibility.vegetationAreas, 0);
        assert.equal(next.exportStats.compatibility.stockOnly, true);
        assert.equal(next.exportStats.compatibility.consistent, true);
        assert.equal(next.built.stats.includeFoliage, false);
        assert.equal(next.built.stats.treesSource, "none");
        assert.equal(next.exportStats.imageryRecovery.hit, true);
        assert.ok(next.exportStats.contentGrid.ok, next.exportStats.contentGrid.drift.failures.join("; "));
        assert.ok(next.exportStats.contentGrid.geodesicMismatchPx > 40);
        assert.ok(
          next.exportStats.pavementFootprints.dropped >= 4,
          "pavement dropped " + next.exportStats.pavementFootprints.dropped
        );
        assert.equal(next.exportStats.pavementFootprints.kept, 0);
        assert.ok(next.exportStats.medians.kept >= 8);
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
    assert.match(files["alignment-overlay.svg"].toString(), /<polygon /);
    assert.equal(/<circle /.test(files["alignment-overlay.svg"].toString()), false);
    assert.match(files["VERIFY.txt"].toString(), /^attenuation_areas: \d+$/m);
    assert.match(files["VERIFY.txt"].toString(), /^includeFoliage: false$/m);
    assert.match(files["VERIFY.txt"].toString(), new RegExp(`^openclutter_version: ${APP_VERSION}$`, "m"));
    assert.match(files["README.txt"].toString(), /Include foliage is off by default/);
  });
});

describe("eval gate with Include foliage on", () => {
  it("emits canopy polygons only and keeps foliage overlap guards", () => {
    const { isVegetationOiName } = require("../netlify/lib/materials");
    for (const site of loadSitesIndex()) {
      const loaded = loadFixture(site);
      const next = runLoaded(loaded, { rgbPolicy: T.RGB_POLICY_PREFER_NLCD, includeFoliage: true });
      assert.equal(
        next.gate.ok,
        true,
        `${site.id}: ${next.exportStats.gate.failures.join("; ")}`
      );
      assert.equal(next.exportStats.includeFoliage, true);
      assert.ok(next.exportStats.openIntentTrees.emitted >= 1, site.id);
      assert.ok(next.exportStats.openIntentTrees.emitted <= 1200, site.id);
      assert.equal(next.built.stats.foliageGeometry, "chm-crown", site.id);
      assert.ok(
        next.exportStats.openIntentTrees.emitted >= 8,
        `${site.id}: expected individual CHM crowns, got ${next.exportStats.openIntentTrees.emitted}`
      );
      const areas = next.built.openintent.floorplans[0].attenuation_areas;
      const veg = areas.filter((a) => isVegetationOiName(a.area_material && a.area_material.name));
      assert.equal(veg.length, next.exportStats.openIntentTrees.emitted);
      assert.equal(
        next.built.clipboard.attenuatingZones.some(
          (z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("trunk") === 0
        ),
        false
      );
      const { unzipStore } = require("../netlify/lib/zip-store");
      const files = unzipStore(next.built.zip);
      const svg = files["alignment-overlay.svg"].toString();
      assert.match(svg, /<polygon /);
      assert.equal(/<circle /.test(svg), false, site.id + " overlay has tree-point circles");
      assert.ok(next.exportStats.foliageOverlap.overlapM2 <= 5, site.id);
      assert.ok(next.exportStats.foliageSelfOverlap.overlapM2 <= 80, site.id);
      if (site.id === "oak-creek-commercial") {
        assert.ok(next.exportStats.heights.uniqueFoliageHeights >= 4);
        assert.ok(next.exportStats.compatibility.vegetationAreas >= 1);
        assert.ok(next.exportStats.openIntentTrees.custom >= 1);
        assert.ok(next.exportStats.compatibility.materials > 4);
      }
    }
  });
});

describe("fixture files are secret-free", () => {
  it("bbox JSON has no tokens", () => {
    const raw = fs.readFileSync(path.join(__dirname, "fixtures", "sites.json"), "utf8");
    assert.ok(!/token|secret|password|api[_-]?key/i.test(raw));
  });
});
