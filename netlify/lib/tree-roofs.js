"use strict";

/**
 * Microsoft-traced outlines over trees (/dev, treeRoofs). The ML footprints
 * sometimes trace a tree crown or a creek bank as a roof (Shoal Creek in
 * Austin, feedback issue 5: 300 m2 at 24.6 m with no building returns under
 * it, only tree tops). An outline is left out only when both say trees: the
 * lidar has no building returns and more vegetation than unclassified
 * returns under it, and the current photo is mostly green inside it.
 */
const { returnsInside, treesNotRoof } = require("./usgs-lidar");
const { leafOnGreenSampler } = require("./leaf-on-photo");

const TREE_ROOF_SOURCES = { "ms-global": true };
const MIN_VEG_RETURNS = 40;
const MIN_GREEN_SHARE = 0.6;
// A shaded crown is green only at its lit edge; half the leaf-on reach.
const GREEN_REACH_M = 0.75;

function outerRings(feature) {
  const g = feature && feature.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates && g.coordinates[0] ? [g.coordinates[0]] : [];
  if (g.type === "MultiPolygon") return (g.coordinates || []).map((p) => p && p[0]).filter(Boolean);
  return [];
}

/**
 * features: GeoJSON building features (properties.geomSource names the outline source).
 * grid: the USGS lidar grid. photo: { data RGBA, width, height } matching the frame.
 * toPx(lon, lat): [x, y] Y-up pixels of the photo. mpp: metres per photo pixel.
 */
function dropTreeFootprints({ features, grid, photo, toPx, mpp }) {
  const list = Array.isArray(features) ? features : [];
  if (!grid || !photo || !photo.data || typeof toPx !== "function") return { features: list, dropped: [] };
  const greenShare = leafOnGreenSampler(
    { data: photo.data, width: photo.width, height: photo.height, have: new Uint8Array(photo.width * photo.height).fill(1) },
    mpp > 0 ? mpp : 0,
    GREEN_REACH_M
  );
  const kept = [];
  const dropped = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const props = (f && f.properties) || {};
    const rings = TREE_ROOF_SOURCES[props.geomSource] ? outerRings(f) : [];
    let trees = rings.length > 0;
    let lidar = null;
    let green = null;
    for (let k = 0; k < rings.length && trees; k++) {
      lidar = returnsInside(grid, rings[k]);
      if (!treesNotRoof(lidar) || lidar.vegetation < MIN_VEG_RETURNS) trees = false;
      if (!trees) break;
      green = greenShare(rings[k].map((p) => toPx(p[0], p[1])));
      if (green == null || green < MIN_GREEN_SHARE) trees = false;
    }
    if (trees) dropped.push({ index: i, ring: rings[0], lidar, green });
    else kept.push(f);
  }
  return { features: kept, dropped };
}

module.exports = { dropTreeFootprints, MIN_GREEN_SHARE, MIN_VEG_RETURNS };
