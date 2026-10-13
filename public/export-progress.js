/**
 * Stage weights for a background export, and the percent the Export button shows.
 *
 * Shares follow measured time, not a clock. On Fly, Trees was about 90s of a
 * 115s job, so that stage is 78 of 100. Vehicle scans run in parallel inside
 * that same Trees window, so they share the slice instead of adding a second
 * one. The other stages keep their previous shares of the remaining 22.
 * A stage with no tile counts stays at the start of its slice. Trees moves
 * by tiles finished. Fetching aerial moves by tiles finished or by time
 * already spent inside that stage's weight. The button reaches 100 only
 * when the job state is done.
 *
 * Browser + Node.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterProgress = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STAGES = [
    { id: "map", label: "Fetching aerial", weight: 4, test: /^Fetching (aerial|map)\b/i },
    { id: "footprints", label: "Fetching footprints", weight: 3, test: /^Fetching footprints\b/i },
    { id: "canopy", label: "Canopy height", weight: 3, test: /^Canopy height\b/i },
    { id: "cover", label: "World cover", weight: 2, test: /^World cover\b/i },
    { id: "lidar", label: "Lidar heights", weight: 1, test: /^Lidar heights\b/i },
    { id: "terrain", label: "Terrain", weight: 3, test: /^(Reading terrain|Terrain)\b/i },
    { id: "buildings", label: "", weight: 4, test: /^Buildings\b/i },
    { id: "trees", label: "", weight: 78, test: /^Trees\b/i },
    { id: "zip", label: "Building zip", weight: 2, test: /^(Packing zip|Building zip)\b/i },
  ];

  const WEIGHT_TOTAL = STAGES.reduce((sum, stage) => sum + stage.weight, 0);
  const AERIAL_BUDGET_MS = 36000;

  function stageKey(stage) {
    const name = String(stage || "");
    if (/^zip ready\b/i.test(name)) return "ready";
    for (let i = 0; i < STAGES.length; i++) {
      if (STAGES[i].test.test(name)) return STAGES[i].id;
    }
    return name;
  }

  /**
   * Share of the aerial slice, 0 at the start. Tiles and elapsed both
   * count. The first bit of work is lifted so the button leaves 0, and
   * the slice still ends below the next stage.
   */
  function aerialFraction(job) {
    let frac = 0;
    const total = Number(job && job.tilesTotal);
    const done = Number(job && job.tilesDone);
    if (total > 0 && Number.isFinite(done) && done >= 0) {
      frac = Math.min(1, Math.max(0, done / total));
    }
    const elapsed = Number(job && job.aerialElapsedMs);
    const budget = Number(job && job.aerialBudgetMs) > 0 ? Number(job.aerialBudgetMs) : AERIAL_BUDGET_MS;
    if (elapsed > 0 && budget > 0) {
      frac = Math.max(frac, Math.min(0.92, elapsed / budget));
    }
    const bytesTotal = Number(job && job.bytesTotal);
    const bytesDone = Number(job && job.bytesDone);
    if (bytesTotal > 0 && Number.isFinite(bytesDone) && bytesDone >= 0) {
      frac = Math.max(frac, Math.min(1, bytesDone / bytesTotal));
    }
    if (!(frac > 0)) return 0;
    if (frac < 1) frac = Math.min(0.98, 0.25 + 0.75 * frac);
    return frac;
  }

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
    return {
      label: name || "Export is still working.",
      progress: 0,
      ceiling: roundProgress(STAGES[0].weight / WEIGHT_TOTAL),
    };
  }

  function withAerialElapsed(job, now) {
    const view = Object.assign({}, job || {});
    const stage = String(view.stage || view.heartbeatStage || "");
    if (!/^Fetching (aerial|map)\b/i.test(stage)) return view;
    if (view.aerialElapsedMs > 0) return view;
    const started = Number(view.aerialStartedAt || view.createdAt);
    const clock = now > 0 ? now : Date.now();
    if (started > 0) view.aerialElapsedMs = Math.max(0, clock - started);
    return view;
  }

  /**
   * 0 to 1 for the status payload. Aerial moves inside its weight from
   * tiles, bytes, or time already spent. Trees moves from tiles. The
   * value stays under 1 until the job state is done.
   */
  function liveFraction(job, now) {
    if (job && job.state === "done") return 1;
    const view = withAerialElapsed(job, now);
    const stage = String(view.stage || view.heartbeatStage || view.stageLabel || "");
    const mark = markStage(stage);
    let value = mark.progress;
    const total = Number(view.tilesTotal);
    const done = Number(view.tilesDone);
    const span = Math.max(0, mark.ceiling - mark.progress);
    if (/^Trees\b/i.test(stage) && total > 0 && Number.isFinite(done) && done >= 0) {
      const frac = Math.min(1, Math.max(0, done / total));
      value = mark.progress + span * frac;
    } else if (/^Fetching (aerial|map)\b/i.test(stage)) {
      value = mark.progress + span * aerialFraction(view);
    }
    if (!(value < 1)) value = 0.99;
    if (value < 0) value = 0;
    return value;
  }

  /**
   * Integer percent for the button. held is the last value shown, so a poll
   * that drops tile counts cannot move the bar backward. 100 is state done.
   */
  function exportPercent(job, held) {
    if (job && job.state === "done") return 100;
    const view = withAerialElapsed(job, 0);
    const stage = String((view && (view.stage || view.heartbeatStage || view.stageLabel)) || "");
    const mark = markStage(stage);
    let value = mark.progress;
    const total = Number(view && view.tilesTotal);
    const done = Number(view && view.tilesDone);
    const span = Math.max(0, mark.ceiling - mark.progress);
    if (/^Trees\b/i.test(stage) && total > 0 && Number.isFinite(done) && done >= 0) {
      const frac = Math.min(1, Math.max(0, done / total));
      value = mark.progress + span * frac;
    } else if (/^Fetching (aerial|map)\b/i.test(stage)) {
      value = mark.progress + span * aerialFraction(view);
    }
    if (!(value < 1)) value = 0.99;
    let pct = Math.floor(value * 100 + 1e-9);
    if (pct < 0) pct = 0;
    if (pct > 99) pct = 99;
    const prev = held == null || held === "" ? NaN : +held;
    if (Number.isFinite(prev) && prev > pct) pct = Math.min(99, Math.floor(prev));
    return pct;
  }

  return {
    STAGES: STAGES,
    WEIGHT_TOTAL: WEIGHT_TOTAL,
    markStage: markStage,
    stageKey: stageKey,
    exportPercent: exportPercent,
    liveFraction: liveFraction,
    withAerialElapsed: withAerialElapsed,
  };
});
