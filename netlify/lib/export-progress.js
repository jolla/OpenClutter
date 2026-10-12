"use strict";

/**
 * Stage weights for a background export. The shares follow the work, not a
 * clock: the aerial plate, the footprint read, terrain, buildings, canopy,
 * then the zip. A stage that the export skips is simply never written, and
 * the bar moves to the next stage that is.
 */

const STAGES = [
  { id: "map", label: "Fetching map", weight: 18, test: /^Fetching (aerial|map)\b/i },
  { id: "footprints", label: "Fetching footprints", weight: 16, test: /^Fetching footprints\b/i },
  { id: "terrain", label: "Terrain", weight: 14, test: /^(Reading terrain|Terrain)\b/i },
  { id: "buildings", label: "", weight: 20, test: /^Buildings\b/i },
  { id: "trees", label: "", weight: 26, test: /^Trees\b/i },
  { id: "zip", label: "Building zip", weight: 6, test: /^(Packing zip|Building zip)\b/i },
];

const WEIGHT_TOTAL = STAGES.reduce((sum, stage) => sum + stage.weight, 0);

function roundProgress(value) {
  return Math.round(value * 1000) / 1000;
}

function markStage(stage) {
  const name = String(stage || "");
  if (/^zip ready\b/i.test(name)) {
    return { label: "Zip ready", progress: 1, ceiling: 1 };
  }
  let at = 0;
  for (let i = 0; i < STAGES.length; i++) {
    const row = STAGES[i];
    if (row.test.test(name)) {
      const progress = at / WEIGHT_TOTAL;
      const ceiling = (at + row.weight) / WEIGHT_TOTAL;
      return {
        label: row.label || name,
        progress: roundProgress(progress),
        ceiling: roundProgress(ceiling),
      };
    }
    at += row.weight;
  }
  return { label: name || "Export is still working.", progress: 0, ceiling: roundProgress(STAGES[0].weight / WEIGHT_TOTAL) };
}

module.exports = {
  STAGES,
  WEIGHT_TOTAL,
  markStage,
};
