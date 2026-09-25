"use strict";

/**
 * Shared geographic frame for Esri World Imagery + Microsoft footprints +
 * HaminaClipboard meters.
 *
 * Esri export uses bboxSR=4326 and imageSR=4326. The JPEG’s *actual* extent
 * (from export?f=json) is the frame — not the rectangle the user drew.
 * World Imagery often pads north/south (~1/cos(lat)) so a geodesic-aspect
 * size= request still covers more latitude than asked. Mapping footprints
 * with the drawn bbox then stretches buildings off rooftops (Long Meadow).
 *
 * Clipboard meters use that same actual widthM × lengthM — never a second
 * auto-scale. After the Esri snap, lockIsotropicImagery keeps the Esri JPEG
 * content pixel grid (downscale only if over maxSide) and unifyFrameMpu sets
 * lengthM = imgH * (widthM/imgW) so Hamina's isotropic map meters match the
 * image aspect. Stretching the aerial to geodesic aspect shifted footprints
 * south of rooftops on Oak Creek.
 *
 * Two pixel conventions (unit-tested):
 *   OpenIntent / Y-up: (0,0) = SW, y increases north (oiconvert + Hamina OI)
 *   JPEG / Y-down:     (0,0) = NW, y increases south (image rows)
 * They sum to imgH. Clipboard uses image-space:
 *   x_clip = x_img * mpuX − widthM
 *   y_clip = −y_img * mpuY
 * which is identical to Y-up:
 *   x_clip = x_up * mpuX − widthM
 *   y_clip = y_up * mpuY − lengthM
 *
 * Origin (HaminaClipboard native after OpenIntent import — NE = 0,0):
 *   SW (west, south) → clipboard (−widthM, −lengthM)
 *   SE (east, south) → clipboard (0, −lengthM)
 *   NW (west, north) → clipboard (−widthM, 0)
 *   NE (east, north) → clipboard (0, 0)
 */

function metersPerDeg(lat) {
  const rad = (lat * Math.PI) / 180;
  return { lon: 111320 * Math.cos(rad), lat: 110540 };
}

/**
 * Production long side. An Oak Creek-scale box (~0.9–1.4 km) stays near a
 * 1000px JPEG. Callers on the dev host pass imageryMaxSide(true) instead.
 */
const IMAGERY_MAX_SIDE = 1040;
/**
 * Dev-host long side. 2048 would be ~1 m/px on a 2 km box, but a live Esri
 * export of a ~2.4 km square at 2048 took ~12s and at 1600 took ~10s.
 * 1600 still leaves a ~1.4 km campus at ~1 m/px (under the cap) and a large
 * box closer to 1 m/px than 1040. 1600² is under the 6 MP jpeg-js decode cap.
 */
const IMAGERY_MAX_SIDE_DEV = 1600;

function imageryMaxSide(devHost) {
  return devHost ? IMAGERY_MAX_SIDE_DEV : IMAGERY_MAX_SIDE;
}

function geoFrame(bbox, opts = {}) {
  const west = +bbox.west;
  const south = +bbox.south;
  const east = +bbox.east;
  const north = +bbox.north;
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error("bbox required");
  }
  if (east <= west || north <= south) throw new Error("bad bbox");

  const mpd = metersPerDeg((south + north) / 2);
  const widthM = (east - west) * mpd.lon;
  const lengthM = (north - south) * mpd.lat;
  const maxSpan = opts.maxSpanM ?? 2500;
  const minSpan = opts.minSpanM ?? 40;
  if (widthM > maxSpan || lengthM > maxSpan) {
    throw new Error("bbox too large (max 2.5 km)");
  }
  if (widthM < minSpan || lengthM < minSpan) {
    throw new Error("bbox too small");
  }

  const metersPerPx = opts.metersPerPx ?? 1.0;
  const maxSide = opts.maxSide ?? IMAGERY_MAX_SIDE;
  let imgW;
  let imgH;
  if (opts.imgW > 0 && opts.imgH > 0) {
    imgW = Math.round(+opts.imgW);
    imgH = Math.round(+opts.imgH);
  } else {
    imgW = Math.max(64, Math.round(widthM / metersPerPx));
    imgH = Math.max(64, Math.round(lengthM / metersPerPx));
    if (Math.max(imgW, imgH) > maxSide) {
      const k = maxSide / Math.max(imgW, imgH);
      imgW = Math.max(64, Math.round(imgW * k));
      imgH = Math.max(64, Math.round(imgH * k));
    }
  }

  const mpuX = widthM / imgW;
  const mpuY = lengthM / imgH;

  return {
    west,
    south,
    east,
    north,
    widthM,
    lengthM,
    mpd,
    imgW,
    imgH,
    mpuX,
    mpuY,
    mpu: mpuX,
    bboxSR: 4326,
    imageSR: 4326,
    origin: CLIPBOARD_ORIGIN,
  };
}

const CLIPBOARD_ORIGIN =
  "Clipboard meters share the imported JPEG’s actual widthM×lengthM (Esri export extent, not the drawn box). " +
  "HaminaClipboard origin after OpenIntent import: NE(east,north)=(0,0); SW=(-widthM,-lengthM). " +
  "JPEG pixels are Y-down from NW; OpenIntent pixels are Y-up from SW (y_up + y_img = imgH). " +
  "x_clip = x_img * mpuX - widthM; y_clip = -y_img * mpuY. " +
  "Import this zip in Hamina (Projects → Import → OpenIntent); OpenIntent attenuation_areas are the objects. " +
  "Google Earth screenshots as maps are an anti-pattern (Hamina auto-scale ≠ photo meters).";

function llToPx(lon, lat, frame) {
  const x = ((lon - frame.west) / (frame.east - frame.west)) * frame.imgW;
  const y = ((lat - frame.south) / (frame.north - frame.south)) * frame.imgH;
  return [x, y];
}

function pxToLl(x, y, frame) {
  const lon = frame.west + (x / frame.imgW) * (frame.east - frame.west);
  const lat = frame.south + (y / frame.imgH) * (frame.north - frame.south);
  return [lon, lat];
}

/** JPEG / SVG space: (0,0) = NW = top-left of the Esri JPEG, Y-down. */
function llToImagePx(lon, lat, frame) {
  const x = ((lon - frame.west) / (frame.east - frame.west)) * frame.imgW;
  const y = ((frame.north - lat) / (frame.north - frame.south)) * frame.imgH;
  return [x, y];
}

function imagePxToLl(x, y, frame) {
  const lon = frame.west + (x / frame.imgW) * (frame.east - frame.west);
  const lat = frame.north - (y / frame.imgH) * (frame.north - frame.south);
  return [lon, lat];
}

function yUpToImage(yFromSouthPx, frame) {
  return frame.imgH - yFromSouthPx;
}

function imageToYUp(yImg, frame) {
  return frame.imgH - yImg;
}

function pxToClipboard(xPx, yFromSouthPx, frame) {
  return [
    xPx * frame.mpuX - frame.widthM,
    yFromSouthPx * frame.mpuY - frame.lengthM,
  ];
}

function imagePxToClipboard(xImg, yImg, frame) {
  return [xImg * frame.mpuX - frame.widthM, -yImg * frame.mpuY];
}

function clipboardToPx(xM, yM, frame) {
  return [
    (xM + frame.widthM) / frame.mpuX,
    (yM + frame.lengthM) / frame.mpuY,
  ];
}

function llToClipboard(lon, lat, frame) {
  const [x, y] = llToPx(lon, lat, frame);
  return pxToClipboard(x, y, frame);
}

function clipboardToLl(xM, yM, frame) {
  const [x, y] = clipboardToPx(xM, yM, frame);
  return pxToLl(x, y, frame);
}

function cornerClipboard(frame) {
  return {
    sw: llToClipboard(frame.west, frame.south, frame),
    se: llToClipboard(frame.east, frame.south, frame),
    nw: llToClipboard(frame.west, frame.north, frame),
    ne: llToClipboard(frame.east, frame.north, frame),
  };
}

function publicFrame(frame) {
  const corners = cornerClipboard(frame);
  return {
    west: frame.west,
    south: frame.south,
    east: frame.east,
    north: frame.north,
    widthM: frame.widthM,
    lengthM: frame.lengthM,
    imgW: frame.imgW,
    imgH: frame.imgH,
    mpuX: frame.mpuX,
    mpuY: frame.mpuY,
    bboxSR: frame.bboxSR,
    imageSR: frame.imageSR,
    origin: frame.origin,
    clipboardCorners: {
      sw: corners.sw.map((n) => +n.toFixed(6)),
      se: corners.se.map((n) => +n.toFixed(6)),
      nw: corners.nw.map((n) => +n.toFixed(6)),
      ne: corners.ne.map((n) => +n.toFixed(6)),
    },
  };
}

function esriExportQuery(frame, f) {
  const bbox = `${frame.west},${frame.south},${frame.east},${frame.north}`;
  return (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${frame.imgW},${frame.imgH}&format=jpg&f=${f}`
  );
}

function esriImageryUrl(frame) {
  return esriExportQuery(frame, "image");
}

function esriImageryMetaUrl(frame) {
  return esriExportQuery(frame, "json");
}

/** Read JPEG SOF width/height without a full decode (no jpeg-js). */
function jpegSize(buf) {
  if (!buf || buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0xff) {
      i++;
      continue;
    }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      if (width > 0 && height > 0) return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function extentFromMeta(meta) {
  const ext = meta && meta.extent;
  if (!ext) return null;
  const sr = ext.spatialReference || {};
  const wkid = +sr.wkid || +sr.latestWkid;
  if (wkid && wkid !== 4326 && wkid !== 84) return null;
  const west = +ext.xmin;
  const south = +ext.ymin;
  const east = +ext.xmax;
  const north = +ext.ymax;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (east <= west || north <= south) return null;
  return { west, south, east, north };
}

/**
 * Geographic extent of an Esri World Imagery export with imageSR=4326.
 *
 * The service keeps the requested pixel size and expands whichever degree
 * axis is short so (east−west)/(north−south) = imgW/imgH, centered on the
 * request. On a meter-square Las Vegas draw that is a latitude pad of about
 * 1/cos φ (~23%). Longitude is unchanged. Projecting footprints with the
 * drawn box then scales Y about the site center: the Sphere stays on the
 * dome, and a roof 80–120 m south of it lands 49–73 ft south of the JPEG
 * (0 ft east). That is the octest-sphere2 “~50–80 ft” miss. It is not a
 * constant southeast translation — an east pre-shift would move the Sphere
 * with every other roof. export?f=json repeats this same extent; this
 * function is that extent when the JSON does not arrive.
 */
function esriContentExtent(bbox, imgW, imgH) {
  const west = +bbox.west;
  const south = +bbox.south;
  const east = +bbox.east;
  const north = +bbox.north;
  const lonSpan = east - west;
  const latSpan = north - south;
  if (!(imgW > 0) || !(imgH > 0) || !(lonSpan > 0) || !(latSpan > 0)) {
    return { west, south, east, north };
  }
  const target = imgW / imgH;
  const current = lonSpan / latSpan;
  if (Math.abs(current - target) <= Math.abs(target) * 1e-9) {
    return { west, south, east, north };
  }
  if (current > target) {
    const newLat = lonSpan / target;
    const mid = (south + north) / 2;
    return { west, east, south: mid - newLat / 2, north: mid + newLat / 2 };
  }
  const newLon = latSpan * target;
  const mid = (west + east) / 2;
  return { south, north, west: mid - newLon / 2, east: mid + newLon / 2 };
}

function requestSeed(opts, frame) {
  const seed = opts && opts.requestBbox;
  if (seed && [seed.west, seed.south, seed.east, seed.north].every(Number.isFinite)) return seed;
  return frame;
}

/**
 * Rebuild the frame from the JPEG Esri actually returned.
 * Footprints, trees, OpenIntent, and clipboard must all use this, not the drawn box.
 *
 * Esri often pads N/S while keeping the requested pixel size, so mpuX ≠ mpuY
 * after this snap. Call lockIsotropicImagery next to unify meters to the JPEG
 * pixel aspect (keep content pixels; do not stretch the aerial).
 *
 * When export?f=json has no extent, the frame is still the content grid
 * (esriContentExtent). Leaving the drawn box in place is the Sphere-site
 * shift: roofs scale away from the draw center on the padded JPEG.
 * opts.requestBbox is the rectangle sent to Esri, so a second snap does not
 * expand an extent that was already padded.
 */
function applyImageryMeta(frame, meta, jpegWH, opts) {
  const ext = extentFromMeta(meta);
  const wh = jpegWH && jpegWH.width > 0 && jpegWH.height > 0 ? jpegWH : null;
  const imgW = (wh && wh.width) || (meta && +meta.width) || frame.imgW;
  const imgH = (wh && wh.height) || (meta && +meta.height) || frame.imgH;
  if (!(imgW > 0 && imgH > 0)) return frame;
  const seed = requestSeed(opts, frame);
  const bbox = ext || esriContentExtent(seed, imgW, imgH);
  const padM = Math.max(frame.widthM, frame.lengthM, seed.widthM || 0, 2500) * 2.5;
  const size = { imgW, imgH, maxSpanM: padM, minSpanM: 1 };
  try {
    return geoFrame(bbox, size);
  } catch {
    return geoFrame(
      { west: seed.west, south: seed.south, east: seed.east, north: seed.north },
      size
    );
  }
}

/** Pixel aspect and meter aspect must match so Hamina’s isotropic map scale agrees with our meters. */
function aspectMismatch(frame, eps = 0.002) {
  if (!frame || !(frame.imgW > 0) || !(frame.imgH > 0) || !(frame.widthM > 0) || !(frame.lengthM > 0)) {
    return Infinity;
  }
  return Math.abs(frame.imgW / frame.imgH - frame.widthM / frame.lengthM);
}

function isAspectLocked(frame, eps = 0.002) {
  return aspectMismatch(frame, eps) <= eps;
}

/** Choose imgW×imgH with the geographic aspect, capped on the long side. */
function isotropicPixelSize(widthM, lengthM, maxSide) {
  const side = Math.max(64, Math.round(+maxSide || IMAGERY_MAX_SIDE));
  const aspect = widthM / lengthM;
  let imgW;
  let imgH;
  if (aspect >= 1) {
    imgW = side;
    imgH = Math.max(64, Math.round(side / aspect));
  } else {
    imgH = side;
    imgW = Math.max(64, Math.round(side * aspect));
  }
  return { imgW, imgH };
}

function sampleBilinear(src, sw, sh, x, y, c) {
  const x0 = Math.max(0, Math.min(sw - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(sh - 1, Math.floor(y)));
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i00 = (y0 * sw + x0) * 4 + c;
  const i10 = (y0 * sw + x1) * 4 + c;
  const i01 = (y1 * sw + x0) * 4 + c;
  const i11 = (y1 * sw + x1) * 4 + c;
  const v0 = src[i00] * (1 - fx) + src[i10] * fx;
  const v1 = src[i01] * (1 - fx) + src[i11] * fx;
  return v0 * (1 - fy) + v1 * fy;
}

/** Resample an RGBA buffer into dstW×dstH (bilinear). */
function resizeRgba(src, sw, sh, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = ((y + 0.5) * sh) / dstH - 0.5;
    for (let x = 0; x < dstW; x++) {
      const sx = ((x + 0.5) * sw) / dstW - 0.5;
      const o = (y * dstW + x) * 4;
      out[o] = Math.round(sampleBilinear(src, sw, sh, sx, sy, 0));
      out[o + 1] = Math.round(sampleBilinear(src, sw, sh, sx, sy, 1));
      out[o + 2] = Math.round(sampleBilinear(src, sw, sh, sx, sy, 2));
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Force a single mpu so OpenIntent triples, clipboard meters, and Hamina's
 * width-derived isotropic scale agree. lengthM becomes imgH*mpu (the meter
 * height Hamina will infer from the JPEG aspect). Geographic west/south/east/
 * north stay the Esri JPEG extent for lon/lat → pixel mapping onto the
 * **content** pixel grid — do not stretch the aerial to fit geodesic meters.
 */
/**
 * How far a roof moves if content-grid Y pixels are read on a geodesic-aspect
 * pixel grid (the stretch-after-project miss). Zero only when imgH already
 * matches geodesic meters per pixel — which the Esri 4326 JPEG does not.
 * lockIsotropicImagery keeps the content grid instead, so this number stays
 * large on Oak Creek and the export never applies it.
 */
function geodesicPixelMismatchPx(frame, lon, lat) {
  if (!frame || !(frame.imgW > 0) || !(frame.imgH > 0)) return 0;
  if (![lon, lat, frame.west, frame.south, frame.east, frame.north].every(Number.isFinite)) return 0;
  const span = frame.north - frame.south;
  if (!(span > 0)) return 0;
  const mpd = frame.mpd || metersPerDeg((frame.south + frame.north) / 2);
  const geoWid = (frame.east - frame.west) * mpd.lon;
  const geoLen = span * mpd.lat;
  if (!(geoWid > 0) || !(geoLen > 0)) return 0;
  const stretchedH = Math.max(1, Math.round(frame.imgW * (geoLen / geoWid)));
  const frac = (frame.north - lat) / span;
  const yContent = frac * frame.imgH;
  const yStretched = frac * stretchedH;
  return Math.abs(yStretched - yContent);
}

function unifyFrameMpu(frame) {
  if (!frame || !(frame.imgW > 0) || !(frame.imgH > 0) || !(frame.widthM > 0)) return frame;
  const mpu = frame.widthM / frame.imgW;
  const lengthM = mpu * frame.imgH;
  return Object.assign({}, frame, {
    lengthM,
    mpuX: mpu,
    mpuY: mpu,
    mpu,
  });
}

/**
 * Lock Hamina map meters to the Esri JPEG pixel aspect without distorting the
 * aerial. Stretching the JPEG to geodesic aspect (PR #20) made footprints sit
 * south/large of rooftops on Oak Creek — lon/lat was projected in a different
 * pixel space than the final image content. Keep the content grid; only
 * downscale when the long side exceeds maxSide (same aspect). Then unify mpu.
 */
function lockIsotropicImagery(frame, jpegBuf, opts = {}) {
  const maxSide = opts.maxSide != null ? opts.maxSide : IMAGERY_MAX_SIDE;
  if (!frame) return { frame, jpegBuf, resampled: false };
  if (!jpegBuf || jpegBuf.length < 100) {
    return { frame: unifyFrameMpu(frame), jpegBuf, resampled: false };
  }
  let raw;
  try {
    const jpeg = require("jpeg-js");
    raw = jpeg.decode(jpegBuf, { useTArray: true, maxResolutionInMP: 20, formatAsRGBA: true });
  } catch {
    return { frame: unifyFrameMpu(frame), jpegBuf, resampled: false };
  }
  if (!raw || !raw.data || !(raw.width > 0) || !(raw.height > 0)) {
    return { frame: unifyFrameMpu(frame), jpegBuf, resampled: false };
  }
  const longSide = Math.max(raw.width, raw.height);
  let imgW = raw.width;
  let imgH = raw.height;
  let outBuf = jpegBuf;
  let resampled = false;
  if (longSide > maxSide) {
    const k = maxSide / longSide;
    imgW = Math.max(64, Math.round(raw.width * k));
    imgH = Math.max(64, Math.round(raw.height * k));
    const rgba = resizeRgba(raw.data, raw.width, raw.height, imgW, imgH);
    try {
      const jpeg = require("jpeg-js");
      const enc = jpeg.encode(
        { data: rgba, width: imgW, height: imgH },
        opts.quality != null ? opts.quality : 85
      );
      outBuf = Buffer.from(enc.data);
      resampled = true;
    } catch {
      return { frame: unifyFrameMpu(frame), jpegBuf, resampled: false };
    }
  }
  const padM = Math.max(frame.widthM, frame.lengthM, 2500) * 2.5;
  const locked = unifyFrameMpu(
    geoFrame(
      { west: frame.west, south: frame.south, east: frame.east, north: frame.north },
      { imgW, imgH, maxSpanM: padM, minSpanM: 1 }
    )
  );
  return { frame: locked, jpegBuf: outBuf, resampled };
}

const FP_PAGE_SIZE = 500;
const FP_CAP = 2000;

/**
 * Esri World Imagery often pads N/S (~1/cos φ). Query footprints with that
 * extra latitude so rooftops on the snapped JPEG are not missing, then clip
 * to the actual image in the pipeline.
 */
function padFootprintBbox(frame) {
  const dLat = Math.abs(+frame.north - +frame.south) || 0;
  const pad = dLat * 0.25;
  return {
    west: +frame.west,
    south: +frame.south - pad,
    east: +frame.east,
    north: +frame.north + pad,
  };
}

function msFootprintsUrl(frame, recordCount = FP_PAGE_SIZE, resultOffset = 0) {
  const geometry = {
    xmin: frame.west,
    ymin: frame.south,
    xmax: frame.east,
    ymax: frame.north,
    spatialReference: { wkid: 4326 },
  };
  return (
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/MSBFP2/FeatureServer/0/query" +
    "?f=geojson&returnGeometry=true&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope" +
    `&inSR=4326&outSR=4326&outFields=*&orderByFields=OBJECTID` +
    `&resultRecordCount=${recordCount}&resultOffset=${resultOffset}` +
    `&geometry=${encodeURIComponent(JSON.stringify(geometry))}`
  );
}

function footprintAbort(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort|timeout/i.test(String(err.message || err));
}

async function readFootprintPage(frame, fetchFn, offset, want) {
  const url = msFootprintsUrl(frame, want, offset);
  const res = await fetchFn(url);
  const gj = await res.json();
  return gj && Array.isArray(gj.features) ? gj.features : [];
}

/**
 * Paginate MSBFP2 until the service is exhausted or FP_CAP (2000) features.
 * resultRecordCount alone (historically 300) truncates large campus/golf bboxes.
 * The first page is alone. Further pages run together so four dense pages
 * cannot add up to four timeouts. opts.budgetMs (default 7s) is the wall
 * clock for the whole query; a full first page and no time left returns
 * that page with partial set.
 */
async function fetchMsFootprints(frame, fetchFn, opts = {}) {
  const pageSize = opts.pageSize || FP_PAGE_SIZE;
  const cap = opts.cap || FP_CAP;
  const budgetMs = opts.budgetMs == null ? 7000 : opts.budgetMs;
  const queryFrame = opts.pad === false ? frame : padFootprintBbox(frame);
  const started = Date.now();
  const maxPages = Math.min(8, Math.max(1, Math.ceil(cap / pageSize)));
  const timeLeft = () => budgetMs - (Date.now() - started);
  const firstWant = Math.min(pageSize, cap);
  const first = await readFootprintPage(queryFrame, fetchFn, 0, firstWant);
  const features = first.slice();
  let pages = 1;
  let partial = false;
  if (first.length < firstWant || features.length >= cap || pages >= maxPages) {
    return packFootprints(features, cap, pages, false);
  }
  if (timeLeft() < 400) {
    return packFootprints(features, cap, pages, true);
  }
  const jobs = [];
  let offset = first.length;
  while (offset < cap && pages + jobs.length < maxPages && timeLeft() >= 400) {
    const want = Math.min(pageSize, cap - offset);
    const pageOffset = offset;
    jobs.push(
      readFootprintPage(queryFrame, fetchFn, pageOffset, want).then(
        (chunk) => ({ offset: pageOffset, chunk, want }),
        (err) => {
          if (footprintAbort(err)) return { offset: pageOffset, chunk: null, want, aborted: true };
          throw err;
        }
      )
    );
    offset += want;
  }
  const parts = await Promise.all(jobs);
  parts.sort((a, b) => a.offset - b.offset);
  for (const part of parts) {
    pages++;
    if (!part.chunk || part.aborted) {
      partial = true;
      break;
    }
    features.push.apply(features, part.chunk);
    if (part.chunk.length < part.want) break;
  }
  return packFootprints(features, cap, pages, partial);
}

function packFootprints(features, cap, pages, partial) {
  const kept = features.slice(0, cap);
  return {
    type: "FeatureCollection",
    features: kept,
    fetched: kept.length,
    pages,
    partial: !!partial,
  };
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let max = i;
    for (let r = i + 1; r < 3; r++) {
      if (Math.abs(m[r][i]) > Math.abs(m[max][i])) max = r;
    }
    [m[i], m[max]] = [m[max], m[i]];
    const piv = m[i][i];
    if (Math.abs(piv) < 1e-12) {
      throw new Error("control points are colinear / degenerate");
    }
    for (let c = i; c < 4; c++) m[i][c] /= piv;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

/**
 * Least-squares affine lon/lat → clipboard meters.
 * controlPoints: [{ lon, lat, xM, yM }, ...]  (3+)
 *
 * Escape hatch for legacy Hamina maps whose auto-scale does not match the
 * geographic bbox (e.g. a Google Earth screenshot). Do not use this on the
 * default Esri-zip path.
 */
function fitAffine(controlPoints) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 3) {
    throw new Error("calibration needs 3+ control points {lon,lat,xM,yM}");
  }
  const pts = controlPoints.map((p) => ({
    lon: +(p.lon ?? p.lng),
    lat: +p.lat,
    xM: +(p.xM ?? p.x),
    yM: +(p.yM ?? p.y),
  }));
  if (pts.some((p) => ![p.lon, p.lat, p.xM, p.yM].every(Number.isFinite))) {
    throw new Error("control points must be numeric lon,lat,xM,yM");
  }

  // Center lon/lat so the 3×3 normal matrix is well-conditioned on small bboxes.
  const lon0 = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;

  const ATA = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const ATx = [0, 0, 0];
  const ATy = [0, 0, 0];
  for (const p of pts) {
    const row = [p.lon - lon0, p.lat - lat0, 1];
    for (let i = 0; i < 3; i++) {
      ATx[i] += row[i] * p.xM;
      ATy[i] += row[i] * p.yM;
      for (let j = 0; j < 3; j++) ATA[i][j] += row[i] * row[j];
    }
  }
  const [a, b, c0] = solve3(ATA, ATx);
  const [d, e, f0] = solve3(ATA, ATy);
  const c = c0 - a * lon0 - b * lat0;
  const f = f0 - d * lon0 - e * lat0;
  return { a, b, c, d, e, f, n: pts.length };
}

function applyAffine(lon, lat, affine) {
  return [
    affine.a * lon + affine.b * lat + affine.c,
    affine.d * lon + affine.e * lat + affine.f,
  ];
}

module.exports = {
  CLIPBOARD_ORIGIN,
  IMAGERY_MAX_SIDE,
  IMAGERY_MAX_SIDE_DEV,
  imageryMaxSide,
  metersPerDeg,
  geoFrame,
  llToPx,
  pxToLl,
  llToImagePx,
  imagePxToLl,
  yUpToImage,
  imageToYUp,
  pxToClipboard,
  imagePxToClipboard,
  clipboardToPx,
  llToClipboard,
  clipboardToLl,
  cornerClipboard,
  publicFrame,
  esriExportQuery,
  esriImageryUrl,
  esriImageryMetaUrl,
  jpegSize,
  extentFromMeta,
  esriContentExtent,
  applyImageryMeta,
  aspectMismatch,
  isAspectLocked,
  isotropicPixelSize,
  resizeRgba,
  geodesicPixelMismatchPx,
  unifyFrameMpu,
  lockIsotropicImagery,
  FP_PAGE_SIZE,
  FP_CAP,
  padFootprintBbox,
  msFootprintsUrl,
  fetchMsFootprints,
  fitAffine,
  applyAffine,
};
