"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  geoFrame,
  applyImageryMeta,
  lockIsotropicImagery,
  jpegSize,
  pxToClipboard,
  unifyFrameMpu,
  isAspectLocked,
} = require("../netlify/lib/geo-frame");
const { footprintsToClutter, buildClutter, oiPixelCoords } = require("../netlify/lib/pipeline");
const { scoreClipboardOverlayAlignment } = require("../netlify/lib/overlay");
const { OI_BUILDING_NAMES } = require("../netlify/lib/materials");

function squareFeature(lon0, lat0, lon1, lat1, props) {
  return {
    type: "Feature",
    properties: props || {},
    geometry: {
      type: "Polygon",
      coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]],
    },
  };
}

describe("clipboard ↔ alignment-overlay scale", () => {
  it("unifyFrameMpu forces a single mpu so lengthM = imgH * mpu", () => {
    const frame = geoFrame(
      {
        west: -87.9224467277527,
        south: 42.88805299761886,
        east: -87.91167497634889,
        north: 42.90352623167958,
      },
      { imgW: 724, imgH: 1040, maxSpanM: 10000, minSpanM: 1 }
    );
    assert.ok(Math.abs(frame.mpuX - frame.mpuY) > 0.01);
    const u = unifyFrameMpu(frame);
    assert.equal(u.mpuX, u.mpuY);
    assert.equal(u.mpu, u.mpuX);
    assert.ok(Math.abs(u.lengthM - u.imgH * u.mpu) < 1e-9);
    assert.equal(u.widthM, frame.widthM);
    assert.equal(u.west, frame.west);
    assert.equal(isAspectLocked(u), true);
  });

  it("clipboard building centroids sit on overlay rooftops (no south/scale>1)", () => {
    const frame = geoFrame({
      west: -87.92,
      south: 42.89,
      east: -87.91,
      north: 42.9,
      name: "Align",
    });
    const dLon = (frame.east - frame.west) * 0.08;
    const dLat = (frame.north - frame.south) * 0.08;
    const features = [
      squareFeature(
        frame.west + dLon * 2,
        frame.south + dLat * 2,
        frame.west + dLon * 3,
        frame.south + dLat * 3,
        { height: 8 }
      ),
      squareFeature(
        frame.west + dLon * 5,
        frame.south + dLat * 5,
        frame.west + dLon * 6.5,
        frame.south + dLat * 6.2,
        { height: 14 }
      ),
      squareFeature(
        frame.west + dLon * 3,
        frame.south + dLat * 7,
        frame.west + dLon * 4,
        frame.south + dLat * 8,
        { height: 5 }
      ),
    ];
    const fp = footprintsToClutter(features, frame, null);
    assert.ok(fp.overlayRings.length >= 3);
    const align = scoreClipboardOverlayAlignment(frame, fp.overlayRings, fp.clipZones);
    assert.equal(align.ok, true, align.failures.join("; "));
    assert.ok(align.meanScale <= 1.02, "scale " + align.meanScale);
    assert.ok(align.meanSouthShiftPx <= 2.5, "south " + align.meanSouthShiftPx);
    assert.ok(align.meanErrPx < 2, "err " + align.meanErrPx);
  });

  it("fails when OI meter/feet triples are misread as pixels (PR #20 spill mode)", () => {
    const frame = unifyFrameMpu(
      geoFrame({
        west: -87.92,
        south: 42.89,
        east: -87.91,
        north: 42.9,
      })
    );
    const dLon = (frame.east - frame.west) * 0.1;
    const dLat = (frame.north - frame.south) * 0.1;
    const lon0 = frame.west + dLon * 2;
    const lat0 = frame.south + dLat * 2;
    const fp = footprintsToClutter(
      [squareFeature(lon0, lat0, lon0 + dLon, lat0 + dLat, { height: 10 })],
      frame,
      null
    );
    assert.equal(fp.oiAreas.length, 1);
    const oiCoords = fp.oiAreas[0].area.coordinates;
    // Bug reproduction: treat every triple vertex as an image pixel, then clamp.
    const badZones = [
      {
        area: {
          coordinates: [
            oiCoords.slice(0, -3).map((c) => {
              const p = c.coordinate_xyz;
              const m = pxToClipboard(p.x, p.y, frame);
              return [
                Math.min(0, Math.max(-frame.widthM, m[0])),
                Math.min(0, Math.max(-frame.lengthM, m[1])),
              ];
            }),
          ],
        },
      },
    ];
    const bad = scoreClipboardOverlayAlignment(frame, fp.overlayRings, badZones, {
      maxMeanShiftPx: 2.5,
      maxScale: 1.02,
    });
    assert.equal(bad.ok, false, "mis-scaled clipboard must fail the overlay gate");
    assert.ok(
      bad.meanScale > 1.02 || bad.meanSouthShiftPx > 2.5,
      JSON.stringify({ scale: bad.meanScale, south: bad.meanSouthShiftPx, failures: bad.failures })
    );

    const good = scoreClipboardOverlayAlignment(frame, fp.overlayRings, fp.clipZones);
    assert.equal(good.ok, true, good.failures.join("; "));
    const pixels = oiPixelCoords(oiCoords);
    assert.ok(pixels.length >= 4);
    assert.equal(pixels.length * 3, oiCoords.length);
  });

  it("Oak Creek fixture: isotropic lock + clipboard on overlay rooftops", () => {
    const dir = path.join(__dirname, "fixtures/oak-creek-commercial");
    const bbox = JSON.parse(fs.readFileSync(path.join(dir, "bbox.json"), "utf8"));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "imagery-meta.json"), "utf8"));
    const jpeg = fs.readFileSync(path.join(dir, "imagery.jpg"));
    const footprints = JSON.parse(fs.readFileSync(path.join(dir, "footprints.geojson"), "utf8"));
    const drawn = geoFrame(bbox);
    const snapped = applyImageryMeta(drawn, meta, jpegSize(jpeg));
    const locked = lockIsotropicImagery(snapped, jpeg);
    assert.equal(isAspectLocked(locked.frame), true);
    assert.equal(locked.frame.mpuX, locked.frame.mpuY);
    assert.ok(Math.abs(locked.frame.lengthM - locked.frame.imgH * locked.frame.mpu) < 1e-6);

    const built = buildClutter({
      frame: locked.frame,
      footprintsGeojson: footprints,
      treePoints: [],
      name: "Oak Creek WI commercial",
      imgBuf: locked.jpegBuf,
    });
    assert.deepEqual(
      built.openintent.area_materials.map((m) => m.name),
      OI_BUILDING_NAMES
    );
    const meters = built.openintent.floorplans[0].dimensions.find((d) => d.unit === "meters");
    const px = built.openintent.floorplans[0].dimensions.find((d) => d.unit === "pixels");
    assert.ok(Math.abs(px.width / px.length - meters.width / meters.length) < 0.002);
    assert.equal(meters.width, locked.frame.widthM);
    assert.equal(meters.length, locked.frame.lengthM);

    const fp = footprintsToClutter(footprints.features, locked.frame, null);
    const bldgZones = built.clipboard.attenuatingZones.filter(
      (z) => z.typeId && String(z.typeId).indexOf("bldg") === 0
    );
    assert.equal(bldgZones.length, fp.overlayRings.length);
    const align = scoreClipboardOverlayAlignment(locked.frame, fp.overlayRings, bldgZones);
    assert.equal(align.ok, true, align.failures.join("; "));
    assert.ok(align.count >= 10, "pairs " + align.count);
    assert.ok(align.meanScale <= 1.02, "scale " + align.meanScale);
    assert.ok(align.meanSouthShiftPx <= 2.5, "south " + align.meanSouthShiftPx);
  });
});
