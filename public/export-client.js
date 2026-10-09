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
  };
});
