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
        // Oak Creek's pasted hill is under the 20 m ski-hill note, but the
        // mesh is still pasted, so each distinct bottom is its own catalog
        // entry after the four gold materials.
        assert.ok(
          next.exportStats.compatibility.materials > 4,
          `expected lifted bottoms past the gold four, got ${next.exportStats.compatibility.materials}`
        );
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

  it("writes only the OpenIntent JSON and the aerial", () => {
    const site = loadSitesIndex()[0];
    const result = runLoaded(loadFixture(site), { rgbPolicy: T.RGB_POLICY_PREFER_NLCD });
    const { unzipStore } = require("../netlify/lib/zip-store");
    const files = unzipStore(result.built.zip);
    const names = Object.keys(files);
    assert.equal(names.length, 2);
    assert.ok(names.some((name) => name.startsWith("openIntent_") && name.endsWith(".json")));
    assert.ok(names.some((name) => name.startsWith("images/") && name.endsWith(".jpg")));
    assert.equal(result.built.stats.includeFoliage, false);
    assert.equal(result.built.stats.openclutterVersion, APP_VERSION);
    assert.ok(result.built.stats.attenuationAreasEmitted > 0);
    assert.match(result.built.alignment, /Include foliage is off by default/);
  });
});

describe("eval gate with Include foliage on", () => {
  it("emits canopy polygons only and keeps foliage overlap guards", () => {
    const { isVegetationOiName, isTrunkOiName } = require("../netlify/lib/materials");
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
      assert.equal(next.built.stats.foliageGeometry, "chm-contour", site.id);
      assert.ok(
        next.exportStats.openIntentTrees.emitted >= 8,
        `${site.id}: expected traced canopy outlines, got ${next.exportStats.openIntentTrees.emitted}`
      );
      const areas = next.built.openintent.floorplans[0].attenuation_areas;
      const veg = areas.filter((a) => isVegetationOiName(a.area_material && a.area_material.name));
      const trunks = areas.filter((a) => isTrunkOiName(a.area_material && a.area_material.name));
      assert.equal(veg.length + trunks.length, next.exportStats.openIntentTrees.emitted);
      assert.ok(veg.length >= 1, site.id);
      for (const trunk of trunks) {
        assert.equal(trunk.area_material.transparencyEnabled, true);
        assert.ok(trunk.area_material.top_height > 0);
      }
      const { unzipStore } = require("../netlify/lib/zip-store");
      const files = unzipStore(next.built.zip);
      assert.equal(files["alignment-overlay.svg"], undefined, site.id);
      assert.equal(
        areas.some((a) => a.area_material && a.area_material.name === "Tree Trunk"),
        false,
        site.id
      );
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
