"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jpeg = require("jpeg-js");
const { geoFrame, applyImageryMeta, lockIsotropicImagery, jpegSize, llToImagePx } = require("../netlify/lib/geo-frame");
const { conflateFootprints } = require("../netlify/lib/conflate");
const { featureExteriorRings } = require("../netlify/lib/pipeline");
const { rejectPavementFootprints, pavementEvidence, evidenceIsPavement } = require("../netlify/lib/pavement");
const { pointInRing } = require("./eval/score");

function loadOak() {
  const dir = path.join(__dirname, "fixtures/oak-creek-commercial");
  const bbox = JSON.parse(fs.readFileSync(path.join(dir, "bbox.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "imagery-meta.json"), "utf8"));
  const jpegBuf = fs.readFileSync(path.join(dir, "imagery.jpg"));
  const fp = JSON.parse(fs.readFileSync(path.join(dir, "footprints.geojson"), "utf8"));
  const ov = JSON.parse(fs.readFileSync(path.join(dir, "overture.geojson"), "utf8"));
  const locked = lockIsotropicImagery(applyImageryMeta(geoFrame(bbox), meta, jpegSize(jpegBuf)), jpegBuf);
  const raw = jpeg.decode(locked.jpegBuf, { useTArray: true, maxResolutionInMP: 20, formatAsRGBA: true });
  const merged = conflateFootprints(fp.features, ov.features, { replaceGeometry: true, rankHeight: true });
  return { frame: locked.frame, raw, features: merged.features };
}

function ringBox(ring, frame) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of ring) {
    const [x, y] = llToImagePx(lon, lat, frame);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

describe("pavement footprints", () => {
  it("drops Oak Creek rings that sit on asphalt and keeps bright roofs", () => {
    const { frame, raw, features } = loadOak();
    const before = rejectPavementFootprints(raw, frame, features);
    assert.ok(before.dropped >= 4, "dropped " + before.dropped);
    let parking = 0;
    let brightKept = 0;
    for (const f of features) {
      const rings = featureExteriorRings(f.geometry);
      for (const ring of rings) {
        const box = ringBox(ring, frame);
        const img = ring.map(([lon, lat]) => llToImagePx(lon, lat, frame));
        const e = pavementEvidence(raw, img, frame.mpuX);
        if (box.w > 120 && box.h > 65 && e.roofFrac < 0.1 && e.asphaltFrac > 0.5) {
          parking++;
          assert.equal(evidenceIsPavement(e), true, JSON.stringify(e));
        }
        if (e.roofFrac > 0.7 && e.areaM2 > 2000) brightKept++;
      }
    }
    assert.ok(parking >= 2, "parking-lot class rings " + parking);
    assert.ok(brightKept >= 3, "bright roofs " + brightKept);
    const again = rejectPavementFootprints(raw, frame, before.features);
    assert.equal(again.dropped, 0);
    const probes = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/roof-points.json"), "utf8")
    ).points;
    const lot = probes.find((p) => p.id === "usa-center-large");
    assert.equal(lot.role, "pavement");
    const covers = (list) =>
      list.some((f) => featureExteriorRings(f.geometry).some((ring) => pointInRing([lot.lon, lot.lat], ring)));
    assert.equal(covers(features), true, "stale lot outline is in the source");
    assert.equal(covers(before.features), false, "pavement rejector removes the lot");
    for (const f of again.features) {
      if (f.properties && f.properties.source === "imagery-roof") continue;
      const rings = featureExteriorRings(f.geometry);
      for (const ring of rings) {
        const img = ring.map(([lon, lat]) => llToImagePx(lon, lat, frame));
        assert.equal(evidenceIsPavement(pavementEvidence(raw, img, frame.mpuX)), false);
      }
    }
  });

  it("does not drop an imagery roof fill or a Long Meadow house", () => {
    const { frame, raw, features } = loadOak();
    const tagged = {
      type: "Feature",
      properties: { source: "imagery-roof", height: 8 },
      geometry: features[0].geometry,
    };
    const keptRoof = rejectPavementFootprints(raw, frame, [tagged]);
    assert.equal(keptRoof.dropped, 0);
    assert.equal(keptRoof.features.length, 1);
    assert.equal(keptRoof.features[0].properties.source, "imagery-roof");

    const dir = path.join(__dirname, "fixtures/long-meadow");
    const bbox = JSON.parse(fs.readFileSync(path.join(dir, "bbox.json"), "utf8"));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "imagery-meta.json"), "utf8"));
    const jpegBuf = fs.readFileSync(path.join(dir, "imagery.jpg"));
    const fp = JSON.parse(fs.readFileSync(path.join(dir, "footprints.geojson"), "utf8"));
    const locked = lockIsotropicImagery(applyImageryMeta(geoFrame(bbox), meta, jpegSize(jpegBuf)), jpegBuf);
    const houseRaw = jpeg.decode(locked.jpegBuf, { useTArray: true, maxResolutionInMP: 20, formatAsRGBA: true });
    const houses = rejectPavementFootprints(houseRaw, locked.frame, fp.features);
    assert.equal(houses.dropped, 0);
    assert.equal(houses.features.length, fp.features.length);
  });
});
