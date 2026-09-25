"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  geoFrame,
  llToPx,
  pxToLl,
  llToImagePx,
  imagePxToClipboard,
  pxToClipboard,
  clipboardToPx,
  llToClipboard,
  clipboardToLl,
  cornerClipboard,
  fitAffine,
  applyAffine,
  esriImageryUrl,
  esriImageryMetaUrl,
  jpegSize,
  esriContentExtent,
  applyImageryMeta,
  lockIsotropicImagery,
  isAspectLocked,
  geodesicPixelMismatchPx,
  needsGroundMeterImage,
  geodesicSpans,
  metersPerDeg,
  IMAGERY_MAX_SIDE,
  IMAGERY_MAX_SIDE_DEV,
  imageryMaxSide,
  msFootprintsUrl,
  fetchMsFootprints,
  padFootprintBbox,
  FP_PAGE_SIZE,
  FP_CAP,
} = require("../netlify/lib/geo-frame");

/** Wynn Golf Course bbox from project notes (any-site math, this is the fixture). */
const WYNN = {
  west: -115.1735,
  south: 36.1205,
  east: -115.1488,
  north: 36.1355,
};

describe("shared geo frame", () => {
  it("map corners → documented clipboard coords", () => {
    const frame = geoFrame(WYNN);
    const c = cornerClipboard(frame);
    assert.ok(Math.abs(c.sw[0] + frame.widthM) < 1e-9);
    assert.ok(Math.abs(c.sw[1] + frame.lengthM) < 1e-9);
    assert.ok(Math.abs(c.se[0]) < 1e-9);
    assert.ok(Math.abs(c.se[1] + frame.lengthM) < 1e-9);
    assert.ok(Math.abs(c.nw[0] + frame.widthM) < 1e-9);
    assert.ok(Math.abs(c.nw[1]) < 1e-9);
    assert.ok(Math.abs(c.ne[0]) < 1e-9);
    assert.ok(Math.abs(c.ne[1]) < 1e-9);
  });

  it("caps Oak Creek commercial imagery near a 1000px long side", () => {
    const frame = geoFrame({
      west: -87.92259693145752,
      south: 42.89043196008693,
      east: -87.91184663772584,
      north: 42.90325386116256,
    });
    const longSide = Math.max(frame.imgW, frame.imgH);
    assert.equal(imageryMaxSide(false), IMAGERY_MAX_SIDE);
    assert.equal(IMAGERY_MAX_SIDE, 1040);
    assert.ok(longSide <= 1040, String(longSide));
    assert.ok(longSide >= 900, String(longSide));
  });

  it("keeps a campus near 1 m/px when the dev long side is 1600", () => {
    const oak = {
      west: -87.92259693145752,
      south: 42.89043196008693,
      east: -87.91184663772584,
      north: 42.90325386116256,
    };
    assert.equal(IMAGERY_MAX_SIDE_DEV, 1600);
    assert.equal(imageryMaxSide(true), 1600);
    // decodeImagery refuses above 6 MP. 1600² stays under that.
    assert.ok(IMAGERY_MAX_SIDE_DEV * IMAGERY_MAX_SIDE_DEV < 6e6);
    const prod = geoFrame(oak);
    const dev = geoFrame(oak, { maxSide: imageryMaxSide(true) });
    assert.ok(Math.max(prod.imgW, prod.imgH) <= 1040);
    const devSide = Math.max(dev.imgW, dev.imgH);
    assert.ok(devSide > 1040, String(devSide));
    assert.ok(devSide <= 1600, String(devSide));
    assert.ok(Math.abs(dev.mpuX - 1) < 0.02, String(dev.mpuX));
    assert.ok(Math.abs(dev.mpuY - 1) < 0.02, String(dev.mpuY));
    assert.ok(Math.abs(dev.imgW / dev.imgH - dev.widthM / dev.lengthM) < 0.02);
  });

  it("caps a large box at 1600 on the dev side and 1040 in production", () => {
    const prod = geoFrame(WYNN);
    const dev = geoFrame(WYNN, { maxSide: imageryMaxSide(true) });
    assert.equal(Math.max(prod.imgW, prod.imgH), 1040);
    assert.equal(Math.max(dev.imgW, dev.imgH), 1600);
    assert.ok(dev.mpuX < prod.mpuX);
    assert.ok(Math.abs(dev.imgW / dev.imgH - dev.widthM / dev.lengthM) < 0.02);
    assert.match(esriImageryUrl(dev), /size=1600,/);
    assert.match(esriImageryUrl(prod), /size=1040,/);
  });

  it("uses geographic aspect (not a square image)", () => {
    const frame = geoFrame(WYNN);
    const imgAspect = frame.imgW / frame.imgH;
    const meterAspect = frame.widthM / frame.lengthM;
    assert.ok(Math.abs(imgAspect - meterAspect) < 0.02);
    assert.notEqual(frame.imgW, frame.imgH);
  });

  it("Esri export URL uses the same bboxSR/imageSR and size as the frame", () => {
    const frame = geoFrame(WYNN);
    const url = esriImageryUrl(frame);
    assert.match(url, /bboxSR=4326/);
    assert.match(url, /imageSR=4326/);
    assert.match(url, new RegExp(`size=${frame.imgW},${frame.imgH}`));
    assert.match(
      url,
      new RegExp(`bbox=${frame.west},${frame.south},${frame.east},${frame.north}`)
    );
    const fp = msFootprintsUrl(frame);
    assert.match(fp, /MSBFP2/);
    assert.match(fp, /outFields=\*/);
    assert.match(fp, /orderByFields=OBJECTID/);
    assert.match(fp, /resultOffset=0/);
    assert.match(fp, /resultRecordCount=500/);
  });

  it("ll → px → clipboard → px → ll round-trip", () => {
    const frame = geoFrame(WYNN);
    const lon = -115.1638;
    const lat = 36.128;
    const [x, y] = llToPx(lon, lat, frame);
    const [lon2, lat2] = pxToLl(x, y, frame);
    assert.ok(Math.abs(lon2 - lon) < 1e-12);
    assert.ok(Math.abs(lat2 - lat) < 1e-12);

    const [cx, cy] = pxToClipboard(x, y, frame);
    const [x2, y2] = clipboardToPx(cx, cy, frame);
    assert.ok(Math.abs(x2 - x) < 1e-9);
    assert.ok(Math.abs(y2 - y) < 1e-9);

    const [cx2, cy2] = llToClipboard(lon, lat, frame);
    assert.ok(Math.abs(cx2 - cx) < 1e-9);
    assert.ok(Math.abs(cy2 - cy) < 1e-9);
    const [lon3, lat3] = clipboardToLl(cx2, cy2, frame);
    assert.ok(Math.abs(lon3 - lon) < 1e-12);
    assert.ok(Math.abs(lat3 - lat) < 1e-12);
  });

  it("pixel of west/south is (0,0) and east/north is (imgW, imgH)", () => {
    const frame = geoFrame(WYNN);
    const sw = llToPx(frame.west, frame.south, frame);
    const ne = llToPx(frame.east, frame.north, frame);
    assert.deepEqual(sw.map((n) => +n.toFixed(10)), [0, 0]);
    assert.ok(Math.abs(ne[0] - frame.imgW) < 1e-9);
    assert.ok(Math.abs(ne[1] - frame.imgH) < 1e-9);
  });

  it("rejects a mismatched scale as the GE-screenshot failure mode", () => {
    const frame = geoFrame(WYNN);
    const haminaGuessW = 795.833;
    const haminaGuessL = 447.656;
    const fakeMpu = haminaGuessW / frame.imgW;
    const [x, y] = llToPx(frame.west, frame.south, frame);
    const wrongSW = [x * fakeMpu - haminaGuessW, y * (haminaGuessL / frame.imgH) - haminaGuessL];
    const rightSW = llToClipboard(frame.west, frame.south, frame);
    // Same pixel origin, but clipboard meters disagree by the ~3× auto-scale.
    assert.ok(Math.abs(rightSW[0] / wrongSW[0] - frame.widthM / haminaGuessW) < 0.02);
    assert.ok(Math.abs(rightSW[0] - wrongSW[0]) > 1000);
  });
});

describe("calibration affine (legacy maps only)", () => {
  it("fits 3+ control points and maps them back", () => {
    const frame = geoFrame(WYNN);
    // Pretend a legacy Hamina map is ~1/3 the geographic size (the Wynn GE case).
    const scale = 795.833 / frame.widthM;
    const pts = [
      { lon: frame.west, lat: frame.south, xM: -795.833, yM: -447.656 },
      { lon: frame.east, lat: frame.south, xM: 0, yM: -447.656 },
      { lon: frame.east, lat: frame.north, xM: 0, yM: 0 },
      { lon: frame.west, lat: frame.north, xM: -795.833, yM: 0 },
    ];
    const aff = fitAffine(pts);
    const sw = applyAffine(frame.west, frame.south, aff);
    const ne = applyAffine(frame.east, frame.north, aff);
    assert.ok(Math.abs(sw[0] + 795.833) < 1e-4);
    assert.ok(Math.abs(sw[1] + 447.656) < 1e-4);
    assert.ok(Math.abs(ne[0]) < 1e-4);
    assert.ok(Math.abs(ne[1]) < 1e-4);
    // Midpoint should sit at half the legacy map, not the geographic clipboard.
    const mid = applyAffine((frame.west + frame.east) / 2, (frame.south + frame.north) / 2, aff);
    const geoMid = llToClipboard((frame.west + frame.east) / 2, (frame.south + frame.north) / 2, frame);
    assert.ok(Math.abs(mid[0] - -795.833 / 2) < 1e-4);
    assert.ok(Math.abs(geoMid[0] / mid[0] - 1 / scale) < 0.05);
  });

  it("throws with fewer than 3 points", () => {
    assert.throws(() => fitAffine([{ lon: 0, lat: 0, xM: 0, yM: 0 }]));
  });
});

/** Actual Esri World Imagery export?f=json for the 8121 S Long Meadow fixture. */
const LONG_MEADOW_DRAWN = {
  west: -87.8885,
  south: 42.8935,
  east: -87.8815,
  north: 42.9002,
};
const LONG_MEADOW_EXPORT = {
  width: 571,
  height: 741,
  extent: {
    xmin: -87.8885,
    ymin: 42.89230796847636,
    xmax: -87.8815,
    ymax: 42.901392031523635,
    spatialReference: { wkid: 4326, latestWkid: 4326 },
  },
};

function tinyJpeg(width, height) {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

describe("Hamina image vs OpenIntent pixel conventions", () => {
  it("Y-up + Y-down = imgH; clipboard from image px matches Y-up formula", () => {
    const frame = geoFrame(WYNN);
    const lon = (frame.west + frame.east) / 2;
    const lat = (frame.south + frame.north) / 2;
    const [xUp, yUp] = llToPx(lon, lat, frame);
    const [xImg, yImg] = llToImagePx(lon, lat, frame);
    assert.equal(xUp, xImg);
    assert.ok(Math.abs(yUp + yImg - frame.imgH) < 1e-9);
    const fromUp = pxToClipboard(xUp, yUp, frame);
    const fromImg = imagePxToClipboard(xImg, yImg, frame);
    assert.ok(Math.abs(fromUp[0] - fromImg[0]) < 1e-9);
    assert.ok(Math.abs(fromUp[1] - fromImg[1]) < 1e-9);
    assert.ok(Math.abs(fromImg[0] + frame.widthM / 2) < 1);
    assert.ok(Math.abs(fromImg[1] + frame.lengthM / 2) < 1);
  });

  it("meta URL is the same export as the JPEG, f=json", () => {
    const frame = geoFrame(WYNN);
    const img = esriImageryUrl(frame);
    const meta = esriImageryMetaUrl(frame);
    assert.match(img, /f=image/);
    assert.match(meta, /f=json/);
    assert.equal(img.replace("f=image", "f=json"), meta);
  });
});

describe("Esri export extent snap (Long Meadow rooftop lock)", () => {
  it("does not treat the drawn south edge as y=0 on the JPEG when Esri pads latitude", () => {
    const drawn = geoFrame(LONG_MEADOW_DRAWN);
    const [ , yDrawnSouth] = llToPx(-87.885, LONG_MEADOW_DRAWN.south, drawn);
    assert.ok(Math.abs(yDrawnSouth) < 1e-6, "drawn-bbox mapping puts user south at JPEG south");

    const live = applyImageryMeta(drawn, LONG_MEADOW_EXPORT, { width: 571, height: 741 });
    assert.equal(live.imgW, 571);
    assert.equal(live.imgH, 741);
    assert.ok(live.south < LONG_MEADOW_DRAWN.south);
    assert.ok(live.north > LONG_MEADOW_DRAWN.north);
    assert.ok(live.lengthM > drawn.lengthM + 200);

    const [, yUp] = llToPx(-87.885, LONG_MEADOW_DRAWN.south, live);
    const [, yImg] = llToImagePx(-87.885, LONG_MEADOW_DRAWN.south, live);
    assert.ok(yUp > 80, `user south must sit inset on the padded JPEG, got y_up=${yUp}`);
    assert.ok(yImg > 80 && yImg < live.imgH - 80);
    assert.ok(Math.abs(yUp + yImg - live.imgH) < 1e-6);

    const clipSouth = llToClipboard(-87.885, LONG_MEADOW_DRAWN.south, live);
    const clipNorth = llToClipboard(-87.885, LONG_MEADOW_DRAWN.north, live);
    assert.ok(clipSouth[1] < clipNorth[1]);
    assert.ok(clipSouth[1] > -live.lengthM + 50);
    assert.ok(clipNorth[1] < -50);
  });

  it("infers the Esri content extent when export metadata never arrives", () => {
    const drawn = geoFrame(LONG_MEADOW_DRAWN);
    const content = applyImageryMeta(drawn, null, { width: 571, height: 741 }, {
      requestBbox: LONG_MEADOW_DRAWN,
    });
    const live = applyImageryMeta(drawn, LONG_MEADOW_EXPORT, { width: 571, height: 741 });
    assert.ok(Math.abs(content.south - live.south) < 1e-9, content.south + " vs " + live.south);
    assert.ok(Math.abs(content.north - live.north) < 1e-9, content.north + " vs " + live.north);
    assert.equal(content.west, live.west);
    assert.equal(content.east, live.east);
    assert.equal(content.imgW, 571);
    assert.equal(content.imgH, 741);
    const direct = esriContentExtent(LONG_MEADOW_DRAWN, 571, 741);
    assert.ok(Math.abs(direct.south - live.south) < 1e-9);
    assert.ok(Math.abs(direct.north - live.north) < 1e-9);
  });

  it("reads JPEG SOF size without jpeg-js", () => {
    const buf = tinyJpeg(571, 741);
    assert.deepEqual(jpegSize(buf), { width: 571, height: 741 });
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  });
});

describe("isotropic aspect lock after Esri N/S pad", () => {
  it("unifies meters to the Esri JPEG pixel aspect without stretching content", () => {
    const fs = require("fs");
    const path = require("path");
    const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery.jpg"));
    const meta = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery-meta.json"), "utf8")
    );
    const bbox = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/bbox.json"), "utf8"));
    const drawn = geoFrame(bbox);
    const snapped = applyImageryMeta(drawn, meta, jpegSize(jpeg));
    assert.ok(!isAspectLocked(snapped) || Math.abs(snapped.mpuX - snapped.mpuY) > 0.01);
    const locked = lockIsotropicImagery(snapped, jpeg);
    assert.equal(isAspectLocked(locked.frame), true);
    assert.equal(locked.frame.mpuX, locked.frame.mpuY);
    assert.ok(Math.abs(locked.frame.lengthM - locked.frame.imgH * locked.frame.mpu) < 1e-9);
    // Content grid preserved (fixture long side 1046 → downscale to 1040) — never
    // stretch to geodesic aspect (that shoved footprints south of rooftops).
    const wh = jpegSize(locked.jpegBuf);
    assert.equal(wh.width, locked.frame.imgW);
    assert.equal(wh.height, locked.frame.imgH);
    assert.ok(Math.abs(wh.width / wh.height - snapped.imgW / snapped.imgH) < 0.01);
    // Known roof stays inside the locked frame in clipboard meters.
    const roof = { lon: -87.91482, lat: 42.89849 };
    const clip = llToClipboard(roof.lon, roof.lat, locked.frame);
    assert.ok(clip[0] > -locked.frame.widthM - 0.05 && clip[0] < 0.05);
    assert.ok(clip[1] > -locked.frame.lengthM - 0.05 && clip[1] < 0.05);
  });

  it("fixes Jerry's Oak Creek anisotropic frame without geodesic stretch", () => {
    // Repro numbers from Jerry's failing zip frame-lock.json.
    const anisotropic = geoFrame(
      {
        west: -87.9224467277527,
        south: 42.88805299761886,
        east: -87.91167497634889,
        north: 42.90352623167958,
      },
      { imgW: 724, imgH: 1040, maxSpanM: 10000, minSpanM: 1 }
    );
    assert.ok(Math.abs(anisotropic.imgW / anisotropic.imgH - 0.696) < 0.01);
    assert.ok(Math.abs(anisotropic.widthM / anisotropic.lengthM - 0.514) < 0.01);
    assert.equal(isAspectLocked(anisotropic), false);
    const fs = require("fs");
    const path = require("path");
    const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery.jpg"));
    const locked = lockIsotropicImagery(anisotropic, jpeg);
    assert.equal(isAspectLocked(locked.frame), true);
    assert.equal(locked.frame.mpuX, locked.frame.mpuY);
    // Meter length follows JPEG aspect (not geodesic) so Hamina paste stays on-map.
    const haminaLen = anisotropic.widthM * (locked.frame.imgH / locked.frame.imgW);
    assert.ok(Math.abs(locked.frame.lengthM - haminaLen) < 1e-6);
    assert.ok(locked.frame.lengthM < anisotropic.lengthM - 100);
  });

  it("Oak Creek content grid is not the geodesic pixel grid", () => {
    const fs = require("fs");
    const path = require("path");
    const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery.jpg"));
    const meta = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery-meta.json"), "utf8")
    );
    const bbox = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/bbox.json"), "utf8"));
    const roofs = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/roof-points.json"), "utf8"));
    const snapped = applyImageryMeta(geoFrame(bbox), meta, jpegSize(jpeg));
    const locked = lockIsotropicImagery(snapped, jpeg);
    const frame = locked.frame;
    const wh = jpegSize(locked.jpegBuf);
    assert.equal(wh.width, frame.imgW);
    assert.equal(wh.height, frame.imgH);
    // Reading content-grid Y on a geodesic-height image shifts the retail roof
    // by tens of pixels. The export must keep that mismatch from happening:
    // JPEG size is the content grid, so the shift is not applied.
    for (const p of roofs.points) {
      const miss = geodesicPixelMismatchPx(frame, p.lon, p.lat);
      assert.ok(miss > 40, p.id + " geodesic mismatch " + miss.toFixed(1));
      const [x, y] = llToImagePx(p.lon, p.lat, frame);
      assert.ok(x > 1 && x < frame.imgW - 1, p.id + " x");
      assert.ok(y > 1 && y < frame.imgH - 1, p.id + " y");
    }
  });

  it("keeps a JPEG between 1040 and 1600 px on the dev cap and still locks mpu", () => {
    const fs = require("fs");
    const path = require("path");
    const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery.jpg"));
    const meta = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery-meta.json"), "utf8")
    );
    const bbox = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/bbox.json"), "utf8"));
    const snapped = applyImageryMeta(geoFrame(bbox, { maxSide: IMAGERY_MAX_SIDE_DEV }), meta, jpegSize(jpeg));
    const locked = lockIsotropicImagery(snapped, jpeg, { maxSide: IMAGERY_MAX_SIDE_DEV });
    const wh = jpegSize(locked.jpegBuf);
    assert.equal(locked.resampled, false);
    assert.equal(wh.width, 877);
    assert.equal(wh.height, 1046);
    assert.equal(wh.width, locked.frame.imgW);
    assert.equal(wh.height, locked.frame.imgH);
    assert.equal(isAspectLocked(locked.frame), true);
    assert.equal(locked.frame.mpuX, locked.frame.mpuY);
    assert.ok(Math.abs(locked.frame.lengthM - locked.frame.imgH * locked.frame.mpu) < 1e-6);
    const roof = { lon: -87.91482, lat: 42.89849 };
    const clip = llToClipboard(roof.lon, roof.lat, locked.frame);
    assert.ok(clip[0] > -locked.frame.widthM - 0.05 && clip[0] < 0.05);
    assert.ok(clip[1] > -locked.frame.lengthM - 0.05 && clip[1] < 0.05);
  });

  it("downscales a JPEG past 1600 px without changing aspect or mpu", () => {
    const jpeg = require("jpeg-js");
    const w = 1610;
    const h = 900;
    const data = Buffer.alloc(w * h * 4, 140);
    const enc = jpeg.encode({ data, width: w, height: h }, 40);
    const frame = geoFrame(WYNN, { imgW: w, imgH: h, maxSpanM: 10000, minSpanM: 1 });
    const locked = lockIsotropicImagery(frame, Buffer.from(enc.data), { maxSide: IMAGERY_MAX_SIDE_DEV });
    assert.equal(locked.resampled, true);
    assert.equal(Math.max(locked.frame.imgW, locked.frame.imgH), 1600);
    assert.equal(isAspectLocked(locked.frame), true);
    assert.equal(locked.frame.mpuX, locked.frame.mpuY);
    assert.ok(Math.abs(locked.frame.lengthM - locked.frame.imgH * locked.frame.mpu) < 1e-6);
    const wh = jpegSize(locked.jpegBuf);
    assert.equal(wh.width, locked.frame.imgW);
    assert.equal(wh.height, locked.frame.imgH);
    assert.ok(Math.abs(wh.width / wh.height - w / h) < 0.02);
  });
});

/** Hamina town center. A ~0.9 km ground square, not a degree square. */
function haminaTownBox() {
  const lat = 60.5694;
  const lon = 27.1975;
  const mpd = metersPerDeg(lat);
  const halfE = 450 / mpd.lon;
  const halfN = 450 / mpd.lat;
  return {
    west: lon - halfE,
    south: lat - halfN,
    east: lon + halfE,
    north: lat + halfN,
    lat,
    lon,
    mpd,
  };
}

function quadrantJpeg(width, height) {
  const jpeg = require("jpeg-js");
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const north = y < height / 2;
    for (let x = 0; x < width; x++) {
      const east = x >= width / 2;
      const o = (y * width + x) * 4;
      // Y-down: row 0 is north. Saturated quadrants survive a JPEG round trip.
      if (north && !east) {
        data[o] = 220;
        data[o + 1] = 20;
        data[o + 2] = 20;
      } else if (north && east) {
        data[o] = 20;
        data[o + 1] = 200;
        data[o + 2] = 20;
      } else if (!north && !east) {
        data[o] = 20;
        data[o + 1] = 20;
        data[o + 2] = 220;
      } else {
        data[o] = 220;
        data[o + 1] = 220;
        data[o + 2] = 40;
      }
      data[o + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 90).data);
}

describe("Finland ground-meter image (Hamina scale)", () => {
  it("treats Finland as stretched plate carrée and leaves US sites on the content grid", () => {
    assert.equal(needsGroundMeterImage(60.5694), true);
    assert.equal(needsGroundMeterImage(59.8), true);
    assert.equal(needsGroundMeterImage(42.9), false);
    assert.equal(needsGroundMeterImage(44.91), false);
    assert.equal(needsGroundMeterImage(36.128), false);
    assert.ok(metersPerDeg(60.5694).lat / metersPerDeg(60.5694).lon > 1.9);
  });

  it("gives a Hamina town box equal east and north meters and a square building", () => {
    const box = haminaTownBox();
    const drawn = geoFrame(box, { maxSide: IMAGERY_MAX_SIDE_DEV });
    const content = esriContentExtent(box, drawn.imgW, drawn.imgH);
    const snapped = geoFrame(content, {
      imgW: drawn.imgW,
      imgH: drawn.imgH,
      maxSpanM: 10000,
      minSpanM: 1,
    });
    assert.equal(needsGroundMeterImage((snapped.south + snapped.north) / 2), true);
    const jpeg = quadrantJpeg(snapped.imgW, snapped.imgH);
    const plate = lockIsotropicImagery(snapped, jpeg, { maxSide: IMAGERY_MAX_SIDE_DEV });
    // Latitude selects the path. The plate-carrée scale bug is the pre-resample
    // frame, where unify would set lengthM from degree pixels.
    const spans = geodesicSpans(snapped);
    const plateLen = snapped.widthM * (snapped.imgH / snapped.imgW);
    assert.ok(spans.lengthM > plateLen * 1.7, "degree pixels compress N–S before the resample");

    const locked = plate;
    assert.equal(locked.groundMeters, true);
    assert.equal(locked.resampled, true);
    assert.equal(isAspectLocked(locked.frame), true);
    assert.equal(locked.frame.mpuX, locked.frame.mpuY);
    const wh = jpegSize(locked.jpegBuf);
    assert.equal(wh.width, locked.frame.imgW);
    assert.equal(wh.height, locked.frame.imgH);
    const geo = geodesicSpans(locked.frame);
    assert.ok(Math.abs(locked.frame.widthM - geo.widthM) / geo.widthM < 0.01);
    assert.ok(Math.abs(locked.frame.lengthM - geo.lengthM) / geo.lengthM < 0.01);

    const [lonE, latE] = [box.lon + 200 / box.mpd.lon, box.lat];
    const [lonN, latN] = [box.lon, box.lat + 200 / box.mpd.lat];
    const c0 = llToClipboard(box.lon, box.lat, locked.frame);
    const cE = llToClipboard(lonE, latE, locked.frame);
    const cN = llToClipboard(lonN, latN, locked.frame);
    const dE = Math.hypot(cE[0] - c0[0], cE[1] - c0[1]);
    const dN = Math.hypot(cN[0] - c0[0], cN[1] - c0[1]);
    assert.ok(Math.abs(dE - 200) / 200 < 0.01, "east " + dE);
    assert.ok(Math.abs(dN - 200) / 200 < 0.01, "north " + dN);
    assert.ok(Math.abs(dE - dN) / 200 < 0.01, "aspect " + dE + " vs " + dN);

    const jpegLib = require("jpeg-js");
    const raw = jpegLib.decode(locked.jpegBuf, { useTArray: true, formatAsRGBA: true });
    function sample(lon, lat) {
      const [x, y] = llToImagePx(lon, lat, locked.frame);
      const xi = Math.max(0, Math.min(raw.width - 1, Math.round(x)));
      const yi = Math.max(0, Math.min(raw.height - 1, Math.round(y)));
      const o = (yi * raw.width + xi) * 4;
      return [raw.data[o], raw.data[o + 1], raw.data[o + 2]];
    }
    const dLon = (locked.frame.east - locked.frame.west) * 0.25;
    const dLat = (locked.frame.north - locked.frame.south) * 0.25;
    const midLon = (locked.frame.west + locked.frame.east) / 2;
    const midLat = (locked.frame.south + locked.frame.north) / 2;
    const nw = sample(midLon - dLon, midLat + dLat);
    const se = sample(midLon + dLon, midLat - dLat);
    assert.ok(nw[0] > 160 && nw[1] < 80, "NW red " + nw);
    assert.ok(se[0] > 160 && se[1] > 160 && se[2] < 100, "SE yellow " + se);

    const { buildClutter } = require("../netlify/lib/pipeline");
    const side = 40;
    const dELon = side / box.mpd.lon;
    const dNLat = side / box.mpd.lat;
    const lon0 = box.lon - dELon / 2;
    const lat0 = box.lat - dNLat / 2;
    const built = buildClutter({
      frame: locked.frame,
      footprintsGeojson: {
        features: [
          {
            type: "Feature",
            properties: { height: 6 },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [lon0, lat0],
                [lon0 + dELon, lat0],
                [lon0 + dELon, lat0 + dNLat],
                [lon0, lat0 + dNLat],
                [lon0, lat0],
              ]],
            },
          },
        ],
      },
      name: "Hamina",
      imgBuf: locked.jpegBuf,
      includeFoliage: false,
    });
    const fp = built.openintent.floorplans[0];
    const meters = fp.dimensions.find((d) => d.unit === "meters");
    const pixels = fp.dimensions.find((d) => d.unit === "pixels");
    assert.ok(Math.abs(pixels.width / pixels.length - meters.width / meters.length) < 1e-9);
    assert.ok(Math.abs(meters.width - locked.frame.widthM) < 1e-6);
    assert.ok(Math.abs(meters.length - locked.frame.lengthM) < 1e-6);
    assert.equal(built.stats.buildings, 1);
    const coords = fp.attenuation_areas[0].area.coordinates;
    const xs = [];
    const ys = [];
    for (let i = 1; i < coords.length; i += 3) {
      xs.push(coords[i].coordinate_xyz.x);
      ys.push(coords[i].coordinate_xyz.y);
    }
    const wM = Math.max(...xs) - Math.min(...xs);
    const hM = Math.max(...ys) - Math.min(...ys);
    assert.ok(Math.abs(wM - side) / side < 0.02, "building east " + wM);
    assert.ok(Math.abs(hM - side) / side < 0.02, "building north " + hM);
  });

  it("does not geodesic-resample Oak Creek even when the JPEG decodes", () => {
    const fs = require("fs");
    const path = require("path");
    const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery.jpg"));
    const meta = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/imagery-meta.json"), "utf8")
    );
    const bbox = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/oak-creek-commercial/bbox.json"), "utf8"));
    const snapped = applyImageryMeta(geoFrame(bbox), meta, jpegSize(jpeg));
    assert.equal(needsGroundMeterImage((snapped.south + snapped.north) / 2), false);
    const locked = lockIsotropicImagery(snapped, jpeg);
    assert.equal(locked.groundMeters, false);
    assert.ok(Math.abs(locked.frame.imgW / locked.frame.imgH - snapped.imgW / snapped.imgH) < 0.01);
    const roof = { lon: -87.91482, lat: 42.89849 };
    assert.ok(geodesicPixelMismatchPx(locked.frame, roof.lon, roof.lat) > 40);
  });
});

describe("MSBFP2 pagination", () => {
  it("pads the footprint query latitude so Esri JPEG N/S pad is covered", () => {
    const frame = geoFrame(WYNN);
    const padded = padFootprintBbox(frame);
    assert.ok(padded.south < frame.south);
    assert.ok(padded.north > frame.north);
    assert.equal(padded.west, frame.west);
    assert.equal(padded.east, frame.east);
    const dLat = frame.north - frame.south;
    assert.ok(Math.abs((frame.south - padded.south) / dLat - 0.25) < 1e-9);
  });

  it("pages until exhausted and caps at FP_CAP", async () => {
    const frame = geoFrame(WYNN);
    const urls = [];
    const fetchFn = async (url) => {
      urls.push(url);
      const u = new URL(url);
      const offset = +u.searchParams.get("resultOffset") || 0;
      const want = +u.searchParams.get("resultRecordCount") || 0;
      const features = [];
      const remain = 80 - offset;
      const n = Math.max(0, Math.min(want, remain));
      for (let i = 0; i < n; i++) {
        features.push({ type: "Feature", id: offset + i, geometry: { type: "Polygon", coordinates: [] } });
      }
      return { ok: true, json: async () => ({ type: "FeatureCollection", features }) };
    };
    const gj = await fetchMsFootprints(frame, fetchFn, { pageSize: 30, cap: 200, pad: false });
    assert.equal(gj.features.length, 80);
    assert.equal(gj.fetched, 80);
    assert.ok(urls.length >= 3);
    assert.ok(urls[0].includes("resultOffset=0"));
    assert.ok(urls[1].includes("resultOffset=30"));
    assert.equal(FP_PAGE_SIZE, 500);
    assert.equal(FP_CAP, 2000);
  });

  it("does not start another page once the footprint budget is spent", async () => {
    const frame = geoFrame(WYNN);
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          features: Array.from({ length: 30 }, (_, i) => ({ type: "Feature", id: i })),
        }),
      };
    };
    const gj = await fetchMsFootprints(frame, fetchFn, { pageSize: 30, cap: 200, pad: false, budgetMs: 0 });
    assert.equal(calls, 1);
    assert.equal(gj.features.length, 30);
    assert.equal(gj.partial, true);
  });

  it("keeps the first page when a later page times out", async () => {
    const frame = geoFrame(WYNN);
    const fetchFn = async (url) => {
      const offset = +new URL(url).searchParams.get("resultOffset") || 0;
      if (offset > 0) {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
      }
      return {
        ok: true,
        json: async () => ({
          features: Array.from({ length: 30 }, (_, i) => ({ type: "Feature", id: i })),
        }),
      };
    };
    const gj = await fetchMsFootprints(frame, fetchFn, { pageSize: 30, cap: 90, pad: false, budgetMs: 7000 });
    assert.equal(gj.features.length, 30);
    assert.equal(gj.partial, true);
  });
});
