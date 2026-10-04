/**
 * How the page treats an export response.
 *
 * The function has to return the zip before the gateway closes the request.
 * An empty 504 or 408 means that already happened. Asking for the same long
 * request again does not finish it, so it is not retried. When the export
 * stops, the status line leaves "Export is still working." A 400 or 413 is
 * the request itself. The page does not call the draw too large.
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
  const STOPPED_STATUS = "The export stopped before a zip was ready.";

  function exportFailure(status, data) {
    const gateway = status === 504 || status === 408;
    const blocked = status === 400 || status === 413;
    const serverMessage = data && data.error ? String(data.error) : "";
    const recoverable = !blocked && !gateway;
    return {
      message: serverMessage || (gateway ? STOPPED_STATUS : blocked ? "Export failed (" + status + ")." : ""),
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

  /** Status once Export is idle again. Never the in-progress line. */
  function idleStatus(err) {
    const message = err && err.message ? String(err.message) : "";
    if (!message || message === WORKING_STATUS) return STOPPED_STATUS;
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
    STOPPED_STATUS: STOPPED_STATUS,
    exportFailure: exportFailure,
    failureError: failureError,
    idleStatus: idleStatus,
    runExportAttempts: runExportAttempts,
  };
});
