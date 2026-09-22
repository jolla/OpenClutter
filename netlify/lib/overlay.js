"use strict";

const {
  llToImagePx,
  yUpToImage,
  cornerClipboard,
  CLIPBOARD_ORIGIN,
  clipboardToPx,
} = require("./geo-frame");

function esc(n) {
  return String(+n.toFixed(2));
}

function ringCentroid(pts) {
  if (!pts || !pts.length) return null;
  const end =
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
      ? pts.length - 1
      : pts.length;
  if (end < 1) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < end; i++) {
    sx += pts[i][0];
    sy += pts[i][1];
  }
  return [sx / end, sy / end];
}

function meanRadius(pts, c) {
  if (!c || !pts || !pts.length) return 0;
  const end =
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
      ? pts.length - 1
      : pts.length;
  let s = 0;
  for (let i = 0; i < end; i++) s += Math.hypot(pts[i][0] - c[0], pts[i][1] - c[1]);
  return end ? s / end : 0;
}

/**
 * Clipboard building rings must sit on the same image-pixel rooftops as
 * alignment-overlay.svg. A scale>1 about Hamina's NE=(0,0) (e.g. treating OI
 * meter/feet triples as pixels) pushes footprints south/west and enlarges them.
 *
 * Returns mean centroid error in Y-up pixels, mean south shift (positive =
 * clipboard south of overlay), and mean radial scale (clip/overlay). Fail when
 * |meanDy| or mean south shift exceed maxMeanShiftPx, or scale > maxScale.
 */
function scoreClipboardOverlayAlignment(frame, overlayRingsYUp, clipZones, opts = {}) {
  const maxMeanShiftPx = opts.maxMeanShiftPx != null ? opts.maxMeanShiftPx : 2.5;
  const maxScale = opts.maxScale != null ? opts.maxScale : 1.02;
  const rings = overlayRingsYUp || [];
  const zones = (clipZones || []).slice(0, rings.length);
  const n = Math.min(rings.length, zones.length);
  const pairs = [];
  let sumDx = 0;
  let sumDy = 0;
  let sumScale = 0;
  let scaleN = 0;
  for (let i = 0; i < n; i++) {
    const overlay = rings[i];
    const ringM = zones[i] && zones[i].area && zones[i].area.coordinates && zones[i].area.coordinates[0];
    if (!overlay || !ringM || ringM.length < 3) continue;
    const clipYUp = ringM.map(([xM, yM]) => clipboardToPx(xM, yM, frame));
    const oc = ringCentroid(overlay);
    const cc = ringCentroid(clipYUp);
    if (!oc || !cc) continue;
    const dx = cc[0] - oc[0];
    const dy = cc[1] - oc[1];
    sumDx += dx;
    sumDy += dy;
    const rO = meanRadius(overlay, oc);
    const rC = meanRadius(clipYUp, cc);
    let scale = 1;
    if (rO > 1e-6) {
      scale = rC / rO;
      sumScale += scale;
      scaleN++;
    }
    pairs.push({ dx, dy, scale, southShiftPx: -dy });
  }
  const count = pairs.length;
  const meanDx = count ? sumDx / count : 0;
  const meanDy = count ? sumDy / count : 0;
  // Y-up: smaller y is south. meanDy < 0 ⇒ clipboard centroid south of overlay.
  const meanSouthShiftPx = -meanDy;
  const meanScale = scaleN ? sumScale / scaleN : 1;
  const meanErrPx = count
    ? pairs.reduce((s, p) => s + Math.hypot(p.dx, p.dy), 0) / count
    : 0;
  const failures = [];
  if (count < 1) failures.push("no building pairs for clipboard↔overlay check");
  if (Math.abs(meanDx) > maxMeanShiftPx) {
    failures.push("mean east shift " + meanDx.toFixed(2) + " px > " + maxMeanShiftPx);
  }
  if (meanSouthShiftPx > maxMeanShiftPx) {
    failures.push("systematic south shift " + meanSouthShiftPx.toFixed(2) + " px > " + maxMeanShiftPx);
  }
  if (meanScale > maxScale) {
    failures.push("clipboard scale " + meanScale.toFixed(4) + " > " + maxScale + " (NE-origin inflate)");
  }
  if (meanErrPx > maxMeanShiftPx * 1.5) {
    failures.push("mean centroid error " + meanErrPx.toFixed(2) + " px");
  }
  return {
    count,
    meanDx,
    meanDy,
    meanSouthShiftPx,
    meanScale,
    meanErrPx,
    ok: failures.length === 0,
    failures,
  };
}

function ringToSvgPoints(ringYUp, frame) {
  return ringYUp
    .map(([x, y]) => `${esc(x)},${esc(yUpToImage(y, frame))}`)
    .join(" ");
}

function overlaySvg({ frame, imgName, buildingRingsYUp, treePointsYUp }) {
  const w = frame.imgW;
  const h = frame.imgH;
  const bldg = (buildingRingsYUp || [])
    .map((ring) => {
      const pts = ringToSvgPoints(ring, frame);
      return `  <polygon points="${pts}" fill="none" stroke="#ff4d4f" stroke-width="1.2"/>`;
    })
    .join("\n");
  const trees = (treePointsYUp || [])
    .map(([x, y]) => {
      const yi = yUpToImage(y, frame);
      return `  <circle cx="${esc(x)}" cy="${esc(yi)}" r="3.2" fill="#3F7D2A" fill-opacity="0.7" stroke="#1b4332" stroke-width="0.6"/>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image href="images/${imgName}" xlink:href="images/${imgName}" width="${w}" height="${h}"/>
  <g id="buildings">
${bldg}
  </g>
  <g id="trees">
${trees}
  </g>
</svg>
`;
}

function frameLockJson(frame, imgName) {
  const corners = cornerClipboard(frame);
  const swI = llToImagePx(frame.west, frame.south, frame);
  const neI = llToImagePx(frame.east, frame.north, frame);
  return {
    note:
      "If alignment-overlay.svg puts buildings on rooftops but Hamina does not after OpenIntent import, the remaining bug is OpenIntent↔Hamina mapping (not MSBFP2 vs imagery). hamina-clipboard.json is a silent fallback for old Hamina builds.",
    origin: CLIPBOARD_ORIGIN,
    image: {
      name: "images/" + imgName,
      widthPx: frame.imgW,
      heightPx: frame.imgH,
      convention: "Y-down from NW (JPEG / SVG)",
      cornersPx: {
        nw: [0, 0],
        ne: [frame.imgW, 0],
        se: [frame.imgW, frame.imgH],
        sw: [0, frame.imgH],
      },
      drawnSouthOnImage: swI.map((n) => +n.toFixed(3)),
      drawnNorthOnImage: neI.map((n) => +n.toFixed(3)),
    },
    openintent: {
      convention: "Y-up from SW (oiconvert / Hamina OpenIntent importer)",
      cornersPx: {
        sw: [0, 0],
        se: [frame.imgW, 0],
        nw: [0, frame.imgH],
        ne: [frame.imgW, frame.imgH],
      },
      yRelation: "y_up + y_img = imgH",
    },
    clipboard: {
      convention: "HaminaClipboard native, origin NE=(0,0)",
      cornersM: {
        sw: corners.sw.map((n) => +n.toFixed(6)),
        se: corners.se.map((n) => +n.toFixed(6)),
        nw: corners.nw.map((n) => +n.toFixed(6)),
        ne: corners.ne.map((n) => +n.toFixed(6)),
      },
      fromImagePx: {
        x_clip: "x_img * mpuX - widthM",
        y_clip: "-y_img * mpuY",
      },
    },
    extent: {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
      widthM: frame.widthM,
      lengthM: frame.lengthM,
      mpuX: frame.mpuX,
      mpuY: frame.mpuY,
    },
  };
}

module.exports = {
  overlaySvg,
  frameLockJson,
  ringCentroid,
  scoreClipboardOverlayAlignment,
};
