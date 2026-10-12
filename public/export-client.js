/**
 * How the page treats an export response.
 *
 * The function returns the zip in the request that was sent. A 502, 504,
 * or 408 with no sentence is the gateway closing an empty first attempt
 * (a cold start). That click tries once more. The page says the first
 * export did not return a zip and that export is still working. If the
 * second attempt is also empty, the status is "The export did not return
 * a zip." A 502 that already carries a sentence is one try. The status
 * line leaves "Export is still working" once Export is idle. A 400 or
 * 413 is the request itself. The page does not call the draw too large.
 *
 * Browser + Node.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterExport = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WORKING_STATUS = "Export is still working.";
  const EMPTY_502_STATUS = "The export did not return a zip.";

  function quietServerMessage(message) {
    return /Aerial imagery timed out|stopped before a zip was ready|too large to finish/i.test(message);
  }

  function exportFailure(status, data) {
    const serverMessage = data && data.error ? String(data.error) : "";
    const is502 = status === 502;
    const gateway = status === 504 || status === 408 || is502;
    const blocked = status === 400 || status === 413;
    const recoverable = !blocked && !gateway;
    const gatewayStatus = status === 504 || status === 408;
    // An empty gateway body is the platform closing the first attempt.
    // A sentence from the function is already an answer, so it is not tried again.
    const emptyGateway = gateway && !serverMessage;
    let message = serverMessage;
    if ((is502 || gatewayStatus) && (!serverMessage || quietServerMessage(serverMessage))) message = EMPTY_502_STATUS;
    else if (blocked && !serverMessage) message = "Export failed (" + status + ").";
    else if (!is502 && !gatewayStatus && !blocked) message = serverMessage;
    return {
      message: message,
      retry: emptyGateway || recoverable,
      gateway: gateway,
      attempts: emptyGateway ? 2 : recoverable ? 3 : 1,
    };
  }

  function failureError(status, data) {
    const failure = exportFailure(status, data);
    const err = new Error(failure.message);
    err.noRetry = !failure.retry;
    err.attempts = failure.attempts;
    err.gateway = failure.gateway;
    return err;
  }

  /**
   * Status once Export is idle. Not the in-progress line, and not the two
   * sentences a slow aerial used to end on.
   */
  function idleStatus(err) {
    const message = err && err.message ? String(err.message) : "";
    if (!message || message === WORKING_STATUS) return "";
    if (/Aerial imagery timed out|stopped before a zip was ready|too large to finish/i.test(message)) return "";
    return message;
  }

  /**
   * Run the export until it returns or the failure says to stop.
   * A 502, 504, or 408 is one try. A later click is a new export.
   */
  async function runExportAttempts(attemptFn) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await attemptFn(attempt);
      } catch (e) {
        lastErr = e;
        if (e && e.noRetry) break;
        const allowed = e && e.attempts > 0 ? e.attempts : 3;
        if (attempt >= allowed) break;
      }
    }
    throw lastErr;
  }

  function pasteFloors(clip) {
    const raised = clip && clip.raisedFloorZones ? clip.raisedFloorZones.length : 0;
    const sloped = clip && clip.slopedFloors ? clip.slopedFloors.length : 0;
    return raised + sloped;
  }

  function terrainPasteLine(clip) {
    const floors = pasteFloors(clip);
    if (!(floors > 0)) return "";
    let bytes = 0;
    try {
      bytes = JSON.stringify(clip).length;
    } catch (err) {
      return "";
    }
    const kb = Math.max(0, Math.round(bytes / 1024));
    return "Terrain paste: " + floors + " floors, " + kb + " KB";
  }

  /**
   * Terrain on copies the sloped or raised mesh. GPS tie points are written
   * onto that mesh. A missing mesh does not become a GPS-only copy; the
   * status says why. Terrain off still copies the two GPS corners.
   */
  function chooseTerrainPaste(data, includeTerrain) {
    const terrainOn = includeTerrain !== false;
    const gps = data && data.gpsClipboard;
    const points = gps && Array.isArray(gps.tiePoints) ? gps.tiePoints : [];
    const clip = data && data.terrainClipboard;
    const floors = pasteFloors(clip);
    if (floors > 0) {
      if (points.length >= 2) clip.tiePoints = points.slice();
      return {
        json: JSON.stringify(clip),
        gpsOnly: false,
        status: (data && data.terrainStatus) || "",
      };
    }
    if (!terrainOn && points.length >= 2) {
      return { json: JSON.stringify(gps), gpsOnly: true, status: "Terrain off" };
    }
    const status =
      (data && data.terrainStatus) || (terrainOn ? "Terrain did not return. Export again." : "");
    return { json: "", gpsOnly: false, status: status };
  }

  const JSON_BUDGET_BYTES = 4900000;
  const M_TO_FT = 3.280839895;

  function finiteNum(value) {
    const n = +value;
    return Number.isFinite(n) ? n : null;
  }

  function formatFt(meters) {
    const ft = Math.round(meters * M_TO_FT);
    const sign = ft < 0 ? "-" : "";
    const abs = String(Math.abs(ft));
    return sign + abs.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " ft";
  }

  function formatMeters(meters) {
    return (Math.round(meters * 10) / 10).toFixed(1) + " m";
  }

  function elevPair(meters) {
    return formatMeters(meters) + " (" + formatFt(meters) + ")";
  }

  function formatBytes(bytes) {
    const n = +bytes;
    if (!(n > 0)) return "";
    if (n >= 100000) return (n / 1e6).toFixed(2) + " MB";
    return Math.max(1, Math.round(n / 1000)) + " KB";
  }

  function steepestGrade(clip) {
    const floors = clip && clip.slopedFloors;
    if (!Array.isArray(floors) || !floors.length) {
      const raised = clip && clip.raisedFloorZones;
      return Array.isArray(raised) && raised.length ? 0 : null;
    }
    let worst = 0;
    for (let i = 0; i < floors.length; i++) {
      const ring = floors[i] && floors[i].area && floors[i].area.coordinates && floors[i].area.coordinates[0];
      if (!ring || ring.length < 4) continue;
      const rise = +ring[2][2] - +ring[0][2];
      if (!(rise > 0)) continue;
      const run = Math.hypot(
        (ring[2][0] + ring[3][0]) / 2 - (ring[0][0] + ring[1][0]) / 2,
        (ring[2][1] + ring[3][1]) / 2 - (ring[0][1] + ring[1][1]) / 2
      );
      const grade = run > 0 ? rise / run : Infinity;
      if (grade > worst) worst = grade;
    }
    return Number.isFinite(worst) ? worst : null;
  }

  function formatGrade(grade) {
    if (!Number.isFinite(grade) || grade < 0) return "";
    const pct = Math.round(grade * 1000) / 10;
    if (pct === 0) return "0%";
    const deg = Math.round((Math.atan(grade) * 180) / Math.PI);
    const pctText = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
    return pctText + "% (" + deg + "°)";
  }

  function mapResolutionLine(data) {
    const warnings = data && Array.isArray(data.warnings) ? data.warnings : [];
    const mapLine = warnings.find((w) => /^Map (image|stepped) /.test(String(w)));
    if (mapLine) {
      const text = String(mapLine);
      const stepped = /stepped down to (\d+) px from (\d+) px/.exec(text);
      const mpp = /([\d.]+) m per pixel/.exec(text);
      const px = /(\d+) px/.exec(text);
      if (stepped) return "Map " + stepped[1] + " px, down from " + stepped[2];
      if (px && mpp) return "Map " + px[1] + " px, " + mpp[1] + " m per pixel";
      if (px) return "Map " + px[1] + " px";
    }
    const frame = data && data.frame;
    if (frame && (+frame.imgW > 0 || +frame.imgH > 0)) {
      const side = Math.max(+frame.imgW || 0, +frame.imgH || 0);
      let line = "Map " + side + " px";
      if (+frame.mpuX > 0) {
        const n = frame.mpuX >= 1 ? (+frame.mpuX).toFixed(1) : (+frame.mpuX).toFixed(2);
        line += ", " + n + " m per pixel";
      }
      return line;
    }
    return "";
  }

  /**
   * Compact rows for the closed Details block. Zeros stay off the list
   * except buildings, and trees when foliage is on. Terrain elevations are
   * absolute meters from the export stats. Clipboard z is meters above the
   * lowest sample, so it is only used for slope and piece count.
   */
  function exportSummaryLines(data, opts) {
    const options = opts || {};
    const stats = (data && data.stats) || {};
    const lines = [];
    const buildings = finiteNum(stats.buildings);
    const kept = finiteNum(stats.buildingsKept);
    lines.push("Buildings " + (buildings != null ? buildings : kept != null ? kept : 0));
    if (options.foliageOn) {
      const groups = finiteNum(stats.trees);
      const keptTrees = finiteNum(stats.treesKept);
      const total = groups != null ? groups : keptTrees != null ? keptTrees : 0;
      const stems = finiteNum(stats.discreteTrees) || 0;
      const stands = Math.max(0, total - stems);
      if (stems > 0 && stands > 0) lines.push("Trees " + stems + ", stands " + stands);
      else if (stands > 0) lines.push("Stands " + stands);
      else lines.push("Trees " + stems);
    }
    const bridges = (+stats.bridgeAreas || 0) + (+stats.guidewayAreas || 0);
    const counts = [
      ["RVs", stats.rvAreas],
      ["Trailers", stats.trailerAreas],
      ["Semis", stats.semiAreas],
      ["Boats", stats.boatAreas],
      ["Cars", stats.carAreas],
      ["Parking", stats.parkingAreas],
      ["Walls and fences", stats.wallAreas],
      ["Poles", stats.poleAreas],
      ["Water", stats.waterAreas],
      ["Bridges and rail", bridges],
    ];
    for (let i = 0; i < counts.length; i++) {
      if (+counts[i][1] > 0) lines.push(counts[i][0] + " " + (+counts[i][1]));
    }
    if (options.terrainOn === false) {
      lines.push("Terrain off");
    } else {
      const minM = finiteNum(stats.terrainMinM);
      const maxM = finiteNum(stats.terrainMaxM);
      let relief = finiteNum(stats.terrainReliefM);
      if (relief == null && minM != null && maxM != null) relief = Math.round((maxM - minM) * 10) / 10;
      if (minM != null) lines.push("Minimum " + elevPair(minM));
      if (maxM != null) lines.push("Maximum " + elevPair(maxM));
      if (relief != null) lines.push("Elevation change " + elevPair(relief));
      const fromClip = steepestGrade(data && data.terrainClipboard);
      const grade = fromClip != null ? fromClip : finiteNum(stats.terrainSteepest);
      const gradeText = formatGrade(grade);
      if (gradeText) lines.push("Steepest slope " + gradeText);
      const clip = data && data.terrainClipboard;
      let pieces = null;
      if (clip && (Array.isArray(clip.raisedFloorZones) || Array.isArray(clip.slopedFloors))) {
        pieces = pasteFloors(clip);
      } else if (finiteNum(stats.terrainRaised) != null || finiteNum(stats.terrainSloped) != null) {
        pieces = (+stats.terrainRaised || 0) + (+stats.terrainSloped || 0);
      }
      if (pieces != null) lines.push("Terrain pieces " + pieces);
    }
    const jsonBytes = +stats.openIntentJsonBytes || 0;
    const budget = +stats.jsonBudget > 0 ? +stats.jsonBudget : JSON_BUDGET_BYTES;
    const budgetText = (budget / 1e6).toFixed(2) + " MB";
    if (jsonBytes > 0) lines.push("OpenIntent " + formatBytes(jsonBytes) + " of " + budgetText);
    const mapLine = mapResolutionLine(data);
    if (mapLine) lines.push(mapLine);
    return lines;
  }

  return {
    WORKING_STATUS: WORKING_STATUS,
    EMPTY_502_STATUS: EMPTY_502_STATUS,
    exportFailure: exportFailure,
    failureError: failureError,
    idleStatus: idleStatus,
    runExportAttempts: runExportAttempts,
    pasteFloors: pasteFloors,
    terrainPasteLine: terrainPasteLine,
    chooseTerrainPaste: chooseTerrainPaste,
    exportSummaryLines: exportSummaryLines,
    steepestGrade: steepestGrade,
  };
});
