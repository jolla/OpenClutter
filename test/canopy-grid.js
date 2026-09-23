"use strict";

/** Two-or-more NLCD cells so vegetation emits a canopy polygon, not a point crown. */
function canopyHitsGrid(frame, lon, lat, opts) {
  const cols = (opts && opts.cols) || 2;
  const rows = (opts && opts.rows) || 2;
  const pct = opts && opts.pct != null ? opts.pct : 70;
  const mid = frame ? (frame.south + frame.north) / 2 : lat;
  const cellLon = 30 / (111320 * Math.cos((mid * Math.PI) / 180));
  const cellLat = 30 / 110540;
  const hits = [];
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      hits.push({ lon: lon + ix * cellLon, lat: lat + iy * cellLat, pct });
    }
  }
  return hits;
}

module.exports = { canopyHitsGrid };
