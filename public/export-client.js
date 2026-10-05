/**
 * How the page treats an export response.
 *
 * The function returns the zip in the request that was sent, including when
 * the sharp aerial is slow. An empty 504 or 408 is not asked for again.
 * The status line leaves "Export is still working" once Export is idle.
 * A 400 or 413 is the request itself. The page does not call the draw too large.
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

  function exportFailure(status, data) {
    const gateway = status === 504 || status === 408;
    const blocked = status === 400 || status === 413;
    const serverMessage = data && data.error ? String(data.error) : "";
    const recoverable = !blocked && !gateway;
    return {
      message: serverMessage || (blocked ? "Export failed (" + status + ")." : ""),
      retry: recoverable,
      gateway: gateway,
      attempts: recoverable ? 3 : 1,
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
   * A gateway timeout is one try. Another miss can still be tried, and a
   * later zip is the export.
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

  return {
    WORKING_STATUS: WORKING_STATUS,
    exportFailure: exportFailure,
    failureError: failureError,
    idleStatus: idleStatus,
    runExportAttempts: runExportAttempts,
  };
});
