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
    assert.ok(longSide <= 1040, String(longSide));
    assert.ok(longSide >= 900, String(longSide));
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
});
