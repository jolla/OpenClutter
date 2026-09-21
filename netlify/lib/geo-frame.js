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
 * auto-scale.
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
  const maxSide = opts.maxSide ?? 1280;
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
 * Rebuild the frame from the JPEG Esri actually returned.
 * Footprints, trees, OpenIntent, and clipboard must all use this, not the drawn box.
 */
function applyImageryMeta(frame, meta, jpegWH) {
  const ext = extentFromMeta(meta);
  const wh = jpegWH && jpegWH.width > 0 && jpegWH.height > 0 ? jpegWH : null;
  const imgW = (wh && wh.width) || (meta && +meta.width) || frame.imgW;
  const imgH = (wh && wh.height) || (meta && +meta.height) || frame.imgH;
  if (!(imgW > 0 && imgH > 0)) return frame;
  const bbox = ext || {
    west: frame.west,
    south: frame.south,
    east: frame.east,
    north: frame.north,
  };
  const padM = Math.max(frame.widthM, frame.lengthM, 2500) * 2.5;
  try {
    return geoFrame(bbox, { imgW, imgH, maxSpanM: padM, minSpanM: 1 });
  } catch {
    return geoFrame(
      {
        west: frame.west,
        south: frame.south,
        east: frame.east,
        north: frame.north,
      },
      { imgW, imgH, maxSpanM: padM, minSpanM: 1 }
    );
  }
}

function msFootprintsUrl(frame, recordCount = 300) {
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
    `&inSR=4326&outSR=4326&outFields=*&resultRecordCount=${recordCount}` +
    `&geometry=${encodeURIComponent(JSON.stringify(geometry))}`
  );
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
  applyImageryMeta,
  msFootprintsUrl,
  fitAffine,
  applyAffine,
};
