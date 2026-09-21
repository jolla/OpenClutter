"use strict";

const { llToImagePx, yUpToImage, cornerClipboard, CLIPBOARD_ORIGIN } = require("./geo-frame");

function esc(n) {
  return String(+n.toFixed(2));
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
      "If alignment-overlay.svg puts buildings on rooftops but Hamina does not, the bug is clipboard↔Hamina mapping (not MSBFP2 vs imagery).",
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

module.exports = { overlaySvg, frameLockJson };
